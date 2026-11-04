/**
 * dsh-skill-manager — 浏览器半侧（设置里的「技能」页，ZCode 风格自有绘制）。
 *
 * 载体约束：单文件 IIFE、无构建、无 JSX、无 ESM、无第三方依赖、无网络资源。
 * 视觉与交互的唯一权威是 docs/ui-spec.md；数据契约的唯一权威是 docs/api-contract.md。
 *
 * 本文件依赖的本宿主事实（对照 DSH 0.2.1-rc.2 源码核验）：
 *  - `window.__ModuleLoader__.load({ id, factory })`，factory 返回 `{ inject, apply }`。
 *  - `ctx.slots.inject('settings.section', () => ctx.slots.register(options, Comp))`；
 *    `options.locale` 让框架给组件绑定 `t`，`settings.section` 的宿主 props 只有 `{ close }`。
 *  - `ctx.locale.register(ns, { zh, en })` 返回 disposer（交给 ctx.effect 管理）；
 *    `t(key, vars)` 自带 `{name}` 插值，缺 key 时回退 en、再回退 key 本身 → 两套字典 key 必须完全一致。
 *  - 设置外壳已把 section 渲染进 `.options{padding:0 24px 24px}` 的滚动容器，
 *    所以这里只补纵向节奏、不再加左右内边距（否则会出现 48px 双倍槽）。
 *
 * 数据只走契约 §3 的 13 条同源路由：
 *   GET  /skill-manager/api/overview
 *   GET  /skill-manager/api/skill
 *   GET  /skill-manager/api/usage
 *   GET  /skill-manager/api/market
 *   POST /skill-manager/api/skill/save
 *   POST /skill-manager/api/skill/create
 *   POST /skill-manager/api/skill/toggle
 *   POST /skill-manager/api/skill/delete
 *   POST /skill-manager/api/skill/invocation
 *   POST /skill-manager/api/skill/batch
 *   POST /skill-manager/api/skill/import
 *   POST /skill-manager/api/open
 *   POST /skill-manager/api/market/install
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-manager',
  factory(require) {
    'use strict'
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useMemo = React.useMemo
    const useRef = React.useRef
    const useCallback = React.useCallback
    const PLUGIN_ID = 'dsh-skill-manager'
    const NS = 'skillManager'
    const API_BASE = '/skill-manager/api'
    const STYLE_ID = PLUGIN_ID + '/styles'
    /** 契约 §3.3：请求体上限 256 KiB（前端只提前提示，真正的判定在 Host）。 */
    const MAX_CONTENT_BYTES = 256 * 1024
    /** 契约 §3.4：name 必须 kebab-case、单路径段。 */
    const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
    const NAME_MAX = 64
    const DESCRIPTION_SOFT_MAX = 200
    /** 契约 §7 的 issue code 全集；不在表内的 code 回退 Host 的 message。 */
    const ISSUE_CODES = ['bom', 'no-frontmatter', 'yaml-invalid', 'name-missing', 'name-invalid', 'name-mismatch',
      'description-missing', 'description-long', 'invocation-invalid', 'unknown-key',
      'duplicate-name', 'shadowed', 'shadowed-by-plugin', 'root-missing', 'read-error', 'skill-md-missing']
    /** 契约 §4 的错误码 → 文案 key（其余走通用分支）。 */
    const ERROR_KEYS = {
      'bad-request': 'err.bad-request', 'forbidden': 'err.forbidden', 'read-only': 'err.read-only',
      'not-found': 'err.not-found', 'method-not-allowed': 'err.method-not-allowed',
      'conflict': 'err.conflict', 'exists': 'err.exists', 'too-large': 'err.too-large', 'unsupported-media': 'err.unsupported-media',
      'internal': 'err.internal',
    }

    /* ------------------------------------------------------------------ *
     * 文案（zh / en 两套，key 集合必须完全一致）
     * ------------------------------------------------------------------ */
    const zh = {
      nav: '技能', title: '技能', subtitle: '直接管理磁盘上的 SKILL.md：用户 / 项目 / 自定义 / 内置。',
      'panel.label': '技能管理', 'panel.a11y': '技能管理面板',
      'head.refresh': '刷新', 'head.refreshing': '刷新中…', 'head.create': '新建',
      'head.openDir': '打开目录', 'head.opening': '打开中…',
      'head.openDirTitle': '在文件管理器中打开当前作用域的技能根',
      'tabs.local': '本机技能', 'tabs.market': '市场',
      'scope.all': '全部', 'scope.user': '用户', 'scope.project': '项目', 'scope.bundled': '内置',
      'search.placeholder': '搜索技能…', 'search.clear': '清除搜索',
      'status.label': '状态筛选', 'status.all': '全部状态', 'status.enabled': '仅启用',
      'status.disabled': '仅停用', 'status.invalid': '仅异常', 'status.shadowed': '被遮蔽',
      'status.unused': '从未使用',
      'scope.label': '作用域筛选',
      'ov.total': '{count} 个技能', 'ov.enabled': '{count} 启用', 'ov.disabled': '{count} 停用',
      'ov.invalid': '{count} 异常', 'ov.sources': '来源 {count}',
      'ov.market': '市场 {repos} 仓库 · {skills} 技能',
      'group.expand': '展开分组', 'group.collapse': '收起分组',
      'group.openRoot': '在文件管理器中打开该根目录', 'group.disabledTitle': '已停用',
      'group.disabledHint': '_disabled', 'group.invalidTitle': '异常', 'group.count': '{count}',
      'row.noDescription': '没有 description', 'row.badgeInvalid': '异常', 'row.badgeShadowed': '被遮蔽',
      'row.badgeReadonly': '只读', 'row.shadowedTitle': '被「{root}」的同名技能遮蔽',
      'row.badgePluginShadowed': '插件同名',
      'row.pluginShadowedTitle': '与插件中心提供的同名技能「{name}」（{provider}）冲突：插件技能 rank 350，优先于 user/bundled 技能，宿主不会采用本条目',
      'pluginShadow.banner': '有 {count} 个技能与插件中心提供的同名技能冲突：插件技能 rank 350，介于 custom 300 与 user-dsh 400 之间，宿主不会采用这些条目；项目 / custom 本地技能仍优先。',
      'row.switchOn': '已启用，点击停用', 'row.switchOff': '已停用，点击启用',
      'row.switchBlocked': '异常技能无法启停，请先修好 frontmatter',
      'row.readonlySwitch': '内置技能只读，无法启停',
      'state.enabled': '已启用', 'state.disabled': '已停用', 'state.invalid': '异常',
      'kind.directory': '目录', 'kind.file': '单文件',
      'meta.source': '来源根', 'meta.kind': '类型', 'meta.size': '大小', 'meta.mtime': '修改时间',
      'meta.bodyChars': '正文长度', 'meta.resources': '资源', 'meta.path': '路径',
      'meta.resourcesValue': '{files} 文件 · {references} 引用 · {scripts} 脚本 · {assets} 其它',
      'meta.chars': '{count} 字',
      'inv.title': '调用策略', 'inv.model': '模型可调用',
      'inv.modelHint': '关闭后写入 disable-model-invocation: true，模型不会自动调用该技能。',
      'inv.user': '用户可调用',
      'inv.userHint': '关闭后写入 user-invocable: false，用户无法通过 / 命令调用。',
      'inv.unavailable': '没有块式 frontmatter（缺失或行内式），无法在这里编辑调用策略。',
      'inv.dirtyHint': '改动先落到下方正文，随「保存」一起写入，不单独发请求。',
      'issues.title': '诊断', 'issues.none': '前端校验通过', 'issues.line': '第 {line} 行',
      'issue.bom': '文件以 UTF-8 BOM 开头，宿主会丢弃该技能',
      'issue.no-frontmatter': '缺少 --- frontmatter 块',
      'issue.yaml-invalid': 'YAML 解析失败',
      'issue.name-missing': '缺少 name',
      'issue.name-invalid': 'name 不是 kebab-case',
      'issue.name-mismatch': 'name 与目录名不一致',
      'issue.description-missing': '缺少 description',
      'issue.description-long': 'description 超过 1024 字符',
      'issue.invocation-invalid': '调用键不是合法布尔值',
      'issue.unknown-key': 'frontmatter 有未知顶层键',
      'issue.duplicate-name': '同根重复的同名技能（先到先得）',
      'issue.shadowed': '被更高优先级的同名技能遮蔽',
      'issue.shadowed-by-plugin': '被插件中心提供的同名技能遮蔽（rank 350）',
      'issue.root-missing': '技能根目录不存在',
      'issue.read-error': '文件读取失败',
      'issue.skill-md-missing': '目录里没有 SKILL.md',
      'body.title': 'SKILL.md', 'body.lines': '{count} 行', 'body.bytes': '{count} 字节',
      'body.reset': '恢复', 'body.placeholder': 'SKILL.md 内容…',
      'body.conflict': '磁盘上的内容已被其他程序修改。重新载入会丢弃当前编辑；直接保存会被拒绝。',
      'body.reload': '重新载入', 'body.loading': '正在读取文件…',
      'act.save': '保存', 'act.saving': '保存中…', 'act.close': '关闭', 'act.cancel': '取消',
      'act.enable': '启用', 'act.disable': '停用', 'act.delete': '删除', 'act.deleting': '删除中…',
      'act.retry': '重试', 'act.open': '打开', 'act.clear': '清除筛选',
      'del.title': '删除技能', 'del.body': '「{name}」会被移入 {path} 下的 _trash/（回收站），内容不会被删除。',
      'del.confirm': '确认删除',
      'create.title': '新建技能', 'create.name': '名称（kebab-case）', 'create.namePlaceholder': 'my-skill',
      'create.nameHint': '小写字母与数字，用连字符分隔。',
      'create.nameInvalid': '只能用小写字母、数字与连字符，且不能以连字符开头或结尾。',
      'create.description': '描述', 'create.descriptionPlaceholder': '一句话说明这个技能做什么。',
      'create.descriptionCounter': '{count}/200',
      'create.descriptionLong': '描述较长，建议控制在 200 字以内。',
      'create.whenToUse': '何时使用（可选）', 'create.whenToUsePlaceholder': '当用户……时使用。',
      'create.root': '目标根', 'create.rootMissing': '（未创建）',
      'create.rootHint': '只能在可写的根下创建。', 'create.body': '正文',
      'create.bodyHint': 'frontmatter 由名称、描述、何时使用自动生成，正文原样写入。',
      'create.bodyDefault': '## 用法\n\n- 说明这个技能在什么情况下使用、按什么步骤执行。\n',
      'create.submit': '创建', 'create.creating': '创建中…', 'create.noRoot': '没有可写的技能根，无法新建。',
      'market.search': '搜索市场技能…',
      'market.summary': '{repos} 个仓库 · {skills} 个技能 · 已安装 {installed}',
      'market.summarySearch': '命中 {matching} 个技能 · {repos} 个仓库 · 已安装 {installed}',
      'market.summaryBrowse': '{repos} 个仓库 · {skills} 个技能',
      'market.browseHint': '浏览模式每个仓库显示 8 个代表技能，搜索可查看全部。',
      'market.install': '安装', 'market.installing': '安装中…', 'market.installed': '已安装',
      'market.update': '更新', 'market.hasUpdate': '市场有更新', 'market.upToDate': '已是最新',
      'market.nameTaken': '同名已存在', 'market.nameTakenHint': '这个根里已经有一个同名技能，但不是从本市场条目安装的；直接安装会失败。',
      'market.missingHint': '账本里记着安装过，但目标路径已不存在，可以重新安装。',
      'market.target': '安装到：{label} · {path}', 'market.emptyTitle': '市场不可用',
      'market.emptyDesc': '没有找到市场克隆目录：{path}。本插件只读取本机克隆，不联网。',
      'market.noResults': '没有匹配的市场技能', 'market.repoCount': '{count} 个技能',
      'market.truncated': '结果已截断，用搜索缩小范围。',
      'market.issue': '市场侧 frontmatter 不合法：{reason}', 'market.openTarget': '打开安装目标目录',
      'market.noTarget': '没有可写的安装目标目录。',
      'err.title': '加载失败', 'err.retry': '重试', 'err.dismiss': '关闭提示', 'err.unknown': '未知错误',
      'err.unreachable': '无法连接到宿主', 'err.routeMissing': '宿主没有响应这个接口（插件可能未加载）',
      'err.aborted': '请求已取消', 'err.http': '请求失败（HTTP {status}）', 'err.withDetail': '{base}：{detail}',
      'err.bad-request': '参数不合法', 'err.forbidden': '请求来源校验失败', 'err.read-only': '目标目录只读',
      'err.not-found': '没找到该技能', 'err.method-not-allowed': '方法不允许',
      'err.conflict': '磁盘内容已被其他程序修改', 'err.exists': '目标已存在',
      'err.too-large': '内容超过 256 KiB', 'err.unsupported-media': '请求体必须是 JSON',
      'err.internal': '宿主内部错误',
      'toast.saved': '已保存', 'toast.savedErrors': '已保存，但仍有 {count} 个 error 级问题，宿主会丢弃该技能',
      'toast.created': '已创建「{name}」', 'toast.deleted': '已移入回收站',
      'toast.enabled': '已启用「{name}」', 'toast.disabled': '已停用「{name}」',
      'toast.installed': '已安装「{name}」', 'toast.opened': '已在文件管理器中打开',
      'toast.dismiss': '关闭通知',
      'empty.title': '还没有任何技能', 'empty.desc': '在这里新建技能，或把技能目录放进用户技能目录。',
      'empty.create': '新建技能', 'emptyFiltered.title': '没有匹配的技能',
      'emptyFiltered.desc': '换个关键字，或清除筛选条件。',
      'loading.skills': '正在读取技能…', 'loading.market': '正在读取市场…',
      'a11y.close': '关闭', 'a11y.search': '搜索技能', 'a11y.switch': '启用开关：{name}',
      'a11y.row': '打开「{name}」的详情', 'a11y.detail': '技能详情', 'a11y.detailClose': '关闭技能详情',
      'a11y.refresh': '刷新技能列表', 'a11y.create': '新建技能', 'a11y.openRoot': '打开根目录',
      'a11y.marketInstall': '安装「{name}」',
      'rootKind.project': '项目技能', 'rootKind.user': '用户技能', 'rootKind.custom': '自定义技能',
      'rootKind.bundled': '内置技能',
      /* 三态调用策略（#1）：行内菜单把「软禁用」做成一次点击 */
      'inv.menuTitle': '调用策略', 'inv.menuLabel': '调用策略：{name}',
      'inv.menuDefault': '默认', 'inv.menuDefaultHint': '模型可调用，/ 命令也可调用',
      'inv.menuManual': '仅手动', 'inv.menuManualHint': '写 disable-model-invocation：模型看不到，/ 命令仍可调用',
      'inv.menuOff': '都不可调用', 'inv.menuOffHint': '模型与 / 命令都不可用；文件仍留在原路径',
      'inv.badgeManual': '仅手动', 'inv.badgeOff': '不可调用', 'inv.badgeModelOnly': '仅模型',
      'inv.updated': '「{name}」的调用策略已更新',
      /* 调用账本（#2）：7/30/90 天次数与最后使用 */
      'usage.label': '调用统计', 'usage.never': '从未使用', 'usage.short': '7 天 {count} 次',
      'usage.neverHint': '90 天内没有任何调用记录',
      'usage.lastUsed': '最后使用：{time}', 'usage.metaValue': '7 天 {d7} · 30 天 {d30} · 90 天 {d90}',
      'usage.unavailable': '宿主没有会话查询服务，无法统计调用次数',
      'usage.truncated': '会话太多，只统计了最近 {scanned} 个',
      'usage.hint': '{scanned} 个会话 · 90 天内',
      'meta.usage': '调用次数', 'meta.lastUsed': '最后使用',
      'sort.label': '排序方式', 'sort.name': '按名称', 'sort.usage': '按调用次数',
      'sort.lastUsed': '按最后使用',
      /* 工作区切换器（#5）：项目级技能根跟随所选目录 */
      'ws.label': '工作区', 'ws.current': '当前会话', 'ws.custom': '输入路径…',
      'ws.title': '技能作用域：{path}',
      'ws.dialogTitle': '指定工作区目录', 'ws.dialogConfirm': '应用',
      'ws.dialogHint': '项目级技能根按该目录向上找最近的 .git 计算；用户级技能根不受影响。',
      'ws.needAbsolute': '请填绝对路径（如 D:\\work\\project）。相对路径会按宿主进程目录解析，~ 也不会展开。',
      'ws.placeholder': 'D:\\工作\\项目',
      /* 批量处理（#4） */
      'batch.enter': '批量处理', 'batch.exit': '退出批量', 'batch.selected': '已选 {count} 项',
      'batch.enable': '启用', 'batch.disable': '停用', 'batch.delete': '删除',
      'batch.clear': '清除选择', 'batch.selectAll': '全选可见', 'batch.selectRow': '选择「{name}」',
      'batch.confirmTitle': '删除 {count} 个技能',
      'batch.confirmBody': '这些技能会被移入各自根目录下的 _trash/（回收站），内容不会被删除。',
      'batch.done': '已处理 {ok} 项', 'batch.doneFailed': '已处理 {ok} 项，{failed} 项失败',
      'batch.empty': '没有可处理的条目（只读、异常、以及已在目标状态的技能会被跳过）',
      /* 导入本地技能包（#6） */
      'import.title': '导入技能', 'import.source': '来源路径（文件夹或 .md）',
      'import.sourceHint': '目录自己带 SKILL.md 就按整包导入；否则递归发现其中的技能并拍平到技能根第一层。',
      'import.placeholder': 'D:\\path\\to\\skill 或 D:\\path\\to\\pack',
      'import.dropHint': '也可以把文件夹拖进这个对话框；拿不到绝对路径时请手输。',
      'import.root': '导入到', 'import.submit': '导入', 'import.importing': '导入中…',
      'import.done': '已导入 {count} 个技能', 'import.donePartial': '已导入 {count} 个，跳过 {skipped} 个',
      'import.noneImported': '没有导入任何技能',
      'import.importedTitle': '已导入', 'import.skippedTitle': '跳过',
      'import.reason': '{reason}：{detail}',
      'import.reason.exists': '目标根已有同名技能', 'import.reason.invalid': 'frontmatter 不合法',
      'import.reason.no-skill': '这里没有找到 SKILL.md',
      'import.reason.unsafe-name': '技能名不能作为目录名', 'import.reason.read-error': '读取失败',
      'import.reason.copy-failed': '复制失败', 'import.reason.too-many': '技能数量超过上限',
      'import.reason.unsupported': '不支持这种来源',
    }
    const en = {
      nav: 'Skills', title: 'Skills', subtitle: 'Manage SKILL.md files on disk: user, project, custom and bundled.',
      'panel.label': 'Skill manager', 'panel.a11y': 'Skill manager panel',
      'head.refresh': 'Refresh', 'head.refreshing': 'Refreshing…', 'head.create': 'New',
      'head.openDir': 'Open folder', 'head.opening': 'Opening…',
      'head.openDirTitle': 'Open the skill root for the current scope in the file manager',
      'tabs.local': 'Local skills', 'tabs.market': 'Market',
      'scope.all': 'All', 'scope.user': 'User', 'scope.project': 'Project', 'scope.bundled': 'Bundled',
      'search.placeholder': 'Search skills…', 'search.clear': 'Clear search',
      'status.label': 'Filter by status', 'status.all': 'All statuses', 'status.enabled': 'Enabled only',
      'status.disabled': 'Disabled only', 'status.invalid': 'With errors', 'status.shadowed': 'Shadowed',
      'status.unused': 'Never used',
      'scope.label': 'Filter by scope',
      'ov.total': '{count} skills', 'ov.enabled': '{count} enabled', 'ov.disabled': '{count} disabled',
      'ov.invalid': '{count} with errors', 'ov.sources': '{count} sources',
      'ov.market': 'Market {repos} repos · {skills} skills',
      'group.expand': 'Expand group', 'group.collapse': 'Collapse group',
      'group.openRoot': 'Open this root in the file manager', 'group.disabledTitle': 'Disabled',
      'group.disabledHint': '_disabled', 'group.invalidTitle': 'With errors', 'group.count': '{count}',
      'row.noDescription': 'No description', 'row.badgeInvalid': 'Invalid', 'row.badgeShadowed': 'Shadowed',
      'row.badgeReadonly': 'Read-only', 'row.shadowedTitle': 'Shadowed by a skill of the same name in “{root}”',
      'row.badgePluginShadowed': 'Plugin duplicate',
      'row.pluginShadowedTitle': 'A plugin skill named “{name}” ({provider}) wins: plugin skills rank 350, ahead of user/bundled skills, so the host will not use this entry',
      'pluginShadow.banner': '{count} skills collide with same-named skills from plugin-hub. Plugin skills rank 350 — between custom 300 and user-dsh 400 — so the host will not use these entries. Project and custom local skills still win.',
      'row.switchOn': 'Enabled. Click to disable', 'row.switchOff': 'Disabled. Click to enable',
      'row.switchBlocked': 'An invalid skill cannot be toggled; fix its frontmatter first',
      'row.readonlySwitch': 'Bundled skills are read-only',
      'state.enabled': 'Enabled', 'state.disabled': 'Disabled', 'state.invalid': 'Invalid',
      'kind.directory': 'Directory', 'kind.file': 'Single file',
      'meta.source': 'Root', 'meta.kind': 'Type', 'meta.size': 'Size', 'meta.mtime': 'Modified',
      'meta.bodyChars': 'Body length', 'meta.resources': 'Resources', 'meta.path': 'Path',
      'meta.resourcesValue': '{files} files · {references} references · {scripts} scripts · {assets} others',
      'meta.chars': '{count} chars',
      'inv.title': 'Invocation', 'inv.model': 'Model-invocable',
      'inv.modelHint': 'Turning this off writes disable-model-invocation: true, so the model will not call it automatically.',
      'inv.user': 'User-invocable',
      'inv.userHint': 'Turning this off writes user-invocable: false, so / commands cannot invoke it.',
      'inv.unavailable': 'No block-style frontmatter (missing or inline), so invocation cannot be edited here.',
      'inv.dirtyHint': 'Edits land in the content below and are written with “Save” — no separate request.',
      'issues.title': 'Diagnostics', 'issues.none': 'Front-end validation passed', 'issues.line': 'line {line}',
      'issue.bom': 'The file starts with a UTF-8 BOM, so the host drops this skill',
      'issue.no-frontmatter': 'Missing the --- frontmatter block',
      'issue.yaml-invalid': 'YAML failed to parse',
      'issue.name-missing': 'Missing name',
      'issue.name-invalid': 'name is not kebab-case',
      'issue.name-mismatch': 'name does not match the folder name',
      'issue.description-missing': 'Missing description',
      'issue.description-long': 'description is longer than 1024 characters',
      'issue.invocation-invalid': 'An invocation key is not a valid boolean',
      'issue.unknown-key': 'frontmatter has unknown top-level keys',
      'issue.duplicate-name': 'Duplicate name in the same root (first one wins)',
      'issue.shadowed': 'Shadowed by a same-named skill of higher priority',
      'issue.shadowed-by-plugin': 'Shadowed by a same-named plugin-hub skill (rank 350)',
      'issue.root-missing': 'The skill root does not exist',
      'issue.read-error': 'The file could not be read',
      'issue.skill-md-missing': 'The folder has no SKILL.md',
      'body.title': 'SKILL.md', 'body.lines': '{count} lines', 'body.bytes': '{count} bytes',
      'body.reset': 'Revert', 'body.placeholder': 'SKILL.md content…',
      'body.conflict': 'Another program changed this file on disk. Reloading discards your edits; saving will be rejected.',
      'body.reload': 'Reload', 'body.loading': 'Reading the file…',
      'act.save': 'Save', 'act.saving': 'Saving…', 'act.close': 'Close', 'act.cancel': 'Cancel',
      'act.enable': 'Enable', 'act.disable': 'Disable', 'act.delete': 'Delete', 'act.deleting': 'Deleting…',
      'act.retry': 'Retry', 'act.open': 'Open', 'act.clear': 'Clear filters',
      'del.title': 'Delete skill', 'del.body': '“{name}” will be moved into {path}\\_trash\\ (recoverable). Nothing is erased.',
      'del.confirm': 'Delete',
      'create.title': 'New skill', 'create.name': 'Name (kebab-case)', 'create.namePlaceholder': 'my-skill',
      'create.nameHint': 'Lowercase letters and digits, separated by hyphens.',
      'create.nameInvalid': 'Use only lowercase letters, digits and hyphens, and do not start or end with one.',
      'create.description': 'Description', 'create.descriptionPlaceholder': 'One sentence about what this skill does.',
      'create.descriptionCounter': '{count}/200',
      'create.descriptionLong': 'This is long; 200 characters or fewer reads better.',
      'create.whenToUse': 'When to use (optional)', 'create.whenToUsePlaceholder': 'Use this when the user…',
      'create.root': 'Target root', 'create.rootMissing': ' (not created)',
      'create.rootHint': 'Only writable roots can receive a new skill.', 'create.body': 'Content',
      'create.bodyHint': 'frontmatter is generated from name, description and when-to-use; the content is written as-is.',
      'create.bodyDefault': '## Usage\n\n- Describe when this skill applies and the steps it should follow.\n',
      'create.submit': 'Create', 'create.creating': 'Creating…',
      'create.noRoot': 'No writable skill root, so nothing can be created.',
      'market.search': 'Search market skills…',
      'market.summary': '{repos} repos · {skills} skills · {installed} installed',
      'market.summarySearch': '{matching} matches · {repos} repos · {installed} installed',
      'market.summaryBrowse': '{repos} repos · {skills} skills',
      'market.browseHint': 'Browsing shows 8 representative skills per repo; search to see everything.',
      'market.install': 'Install', 'market.installing': 'Installing…', 'market.installed': 'Installed',
      'market.update': 'Update', 'market.hasUpdate': 'Update available', 'market.upToDate': 'Up to date',
      'market.nameTaken': 'Name taken', 'market.nameTakenHint': 'This root already has a skill with that name, but it did not come from this market entry; installing would fail.',
      'market.missingHint': 'The ledger recorded an install, but the target path no longer exists; reinstalling is safe.',
      'market.target': 'Install into: {label} · {path}', 'market.emptyTitle': 'Market unavailable',
      'market.emptyDesc': 'No market clone was found at {path}. This plugin reads the local clone only; it never goes online.',
      'market.noResults': 'No matching market skills', 'market.repoCount': '{count} skills',
      'market.truncated': 'Results are truncated. Narrow them down with a search.',
      'market.issue': 'Invalid frontmatter on the market side: {reason}',
      'market.openTarget': 'Open the install target', 'market.noTarget': 'No writable install target.',
      'err.title': 'Could not load', 'err.retry': 'Retry', 'err.dismiss': 'Dismiss', 'err.unknown': 'Unknown error',
      'err.unreachable': 'The host is unreachable',
      'err.routeMissing': 'The host does not serve this route (plugin not loaded?)',
      'err.aborted': 'The request was cancelled', 'err.http': 'Request failed (HTTP {status})',
      'err.withDetail': '{base}: {detail}',
      'err.bad-request': 'Invalid parameters', 'err.forbidden': 'Origin check failed',
      'err.read-only': 'The target folder is read-only', 'err.not-found': 'That skill was not found',
      'err.method-not-allowed': 'Method not allowed', 'err.conflict': 'The file on disk changed',
      'err.exists': 'The target already exists', 'err.too-large': 'The content exceeds 256 KiB',
      'err.unsupported-media': 'The body must be JSON', 'err.internal': 'Host internal error',
      'toast.saved': 'Saved',
      'toast.savedErrors': 'Saved, but {count} error-level issues remain; the host will drop this skill',
      'toast.created': 'Created “{name}”', 'toast.deleted': 'Moved to the trash',
      'toast.enabled': 'Enabled “{name}”', 'toast.disabled': 'Disabled “{name}”',
      'toast.installed': 'Installed “{name}”', 'toast.opened': 'Opened in the file manager',
      'toast.dismiss': 'Dismiss notification',
      'empty.title': 'No skills yet',
      'empty.desc': 'Create one here, or drop a skill folder into the user skills directory.',
      'empty.create': 'New skill', 'emptyFiltered.title': 'No matching skills',
      'emptyFiltered.desc': 'Try another keyword, or clear the filters.',
      'loading.skills': 'Reading skills…', 'loading.market': 'Reading the market…',
      'a11y.close': 'Close', 'a11y.search': 'Search skills', 'a11y.switch': 'Enable switch: {name}',
      'a11y.row': 'Open details for “{name}”', 'a11y.detail': 'Skill details',
      'a11y.detailClose': 'Close skill details', 'a11y.refresh': 'Refresh the skill list',
      'a11y.create': 'New skill', 'a11y.openRoot': 'Open root folder',
      'a11y.marketInstall': 'Install “{name}”',
      'rootKind.project': 'Project skills', 'rootKind.user': 'User skills',
      'rootKind.custom': 'Custom skills', 'rootKind.bundled': 'Bundled skills',
      /* Three-state invocation (#1) */
      'inv.menuTitle': 'Invocation', 'inv.menuLabel': 'Invocation: {name}',
      'inv.menuDefault': 'Default', 'inv.menuDefaultHint': 'The model can call it, and / commands work',
      'inv.menuManual': 'Manual only', 'inv.menuManualHint': 'Writes disable-model-invocation: the model cannot see it, / commands still work',
      'inv.menuOff': 'Not invocable', 'inv.menuOffHint': 'Neither the model nor / commands can use it; the file stays where it is',
      'inv.badgeManual': 'Manual only', 'inv.badgeOff': 'Not invocable', 'inv.badgeModelOnly': 'Model only',
      'inv.updated': 'Invocation updated for “{name}”',
      /* Call ledger (#2) */
      'usage.label': 'Call usage', 'usage.never': 'Never used', 'usage.short': '{count} in 7d',
      'usage.neverHint': 'No calls recorded in the last 90 days',
      'usage.lastUsed': 'Last used: {time}', 'usage.metaValue': '7d {d7} · 30d {d30} · 90d {d90}',
      'usage.unavailable': 'The host has no session query service, so call counts are unavailable',
      'usage.truncated': 'Too many sessions; counted the newest {scanned}',
      'usage.hint': '{scanned} sessions · within 90 days',
      'meta.usage': 'Calls', 'meta.lastUsed': 'Last used',
      'sort.label': 'Sort by', 'sort.name': 'Name', 'sort.usage': 'Call count',
      'sort.lastUsed': 'Last used',
      /* Workspace switcher (#5) */
      'ws.label': 'Workspace', 'ws.current': 'Current session', 'ws.custom': 'Enter a path…',
      'ws.title': 'Skill scope: {path}',
      'ws.dialogTitle': 'Workspace folder', 'ws.dialogConfirm': 'Apply',
      'ws.dialogHint': 'Project skill roots are resolved from this folder upward to the nearest .git; user roots are unaffected.',
      'ws.needAbsolute': 'Enter an absolute path (e.g. D:\\work\\project). A relative path resolves against the host process directory and ~ is not expanded.',
      'ws.placeholder': 'D:\\work\\project',
      /* Batch (#4) */
      'batch.enter': 'Select', 'batch.exit': 'Exit selection', 'batch.selected': '{count} selected',
      'batch.enable': 'Enable', 'batch.disable': 'Disable', 'batch.delete': 'Delete',
      'batch.clear': 'Clear selection', 'batch.selectAll': 'Select visible', 'batch.selectRow': 'Select “{name}”',
      'batch.confirmTitle': 'Delete {count} skills',
      'batch.confirmBody': 'These skills move into their root’s _trash/ (recoverable). Nothing is erased.',
      'batch.done': 'Handled {ok} items', 'batch.doneFailed': 'Handled {ok} items, {failed} failed',
      'batch.empty': 'Nothing to process (read-only, invalid, and already-in-state skills are skipped)',
      /* Local package import (#6) */
      'import.title': 'Import skills', 'import.source': 'Source path (folder or .md)',
      'import.sourceHint': 'A folder that already holds SKILL.md is imported as one skill; otherwise skills found inside are flattened into the first level of the root.',
      'import.placeholder': 'D:\\path\\to\\skill or D:\\path\\to\\pack',
      'import.dropHint': 'You can also drop a folder onto this dialog; type the path when no absolute path is available.',
      'import.root': 'Import into', 'import.submit': 'Import', 'import.importing': 'Importing…',
      'import.done': 'Imported {count} skills', 'import.donePartial': 'Imported {count}, skipped {skipped}',
      'import.noneImported': 'Nothing was imported',
      'import.importedTitle': 'Imported', 'import.skippedTitle': 'Skipped',
      'import.reason': '{reason}: {detail}',
      'import.reason.exists': 'the target root already has that name', 'import.reason.invalid': 'invalid frontmatter',
      'import.reason.no-skill': 'no SKILL.md was found',
      'import.reason.unsafe-name': 'the skill name cannot be a folder name', 'import.reason.read-error': 'the file could not be read',
      'import.reason.copy-failed': 'the copy failed', 'import.reason.too-many': 'too many skills in one import',
      'import.reason.unsupported': 'this source is not supported',
    }

    /* ------------------------------------------------------------------ *
     * 通用工具
     * ------------------------------------------------------------------ */

    /** 与宿主 locale 同构的最小插值实现，供 props.t 缺失时兜底。 */
    function translate(dict) {
      return function (key, vars) {
        const raw = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key
        if (!vars) return String(raw)
        return String(raw).replace(/\{(\w+)\}/g, function (match, name) {
          return vars[name] == null ? match : String(vars[name])
        })
      }
    }
    const fallbackT = translate(zh)
    function cx() {
      const out = []
      for (let i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i])
      return out.join(' ')
    }
    function isObj(value) { return !!value && typeof value === 'object' && !Array.isArray(value) }
    function asArray(value) { return Array.isArray(value) ? value : [] }
    function str(value) { return typeof value === 'string' ? value : value == null ? '' : String(value) }
    function num(value, fallback) {
      const parsed = Number(value)
      return isFinite(parsed) ? parsed : fallback
    }
    function formatBytes(size) {
      const value = Number(size)
      if (!isFinite(value) || value < 0) return '—'
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / 1024 / 1024).toFixed(1) + ' MB'
    }
    function formatTime(ms) {
      const value = Number(ms)
      if (!isFinite(value) || value <= 0) return '—'
      try { return new Date(value).toLocaleString() } catch (error) { return '—' }
    }

    /**
     * 根类型只从 rootId/source 前缀推断：Host 的 root.label 是英文（"User skills (DSH)"），
     * 直接用会在中文界面漏出英文，所以界面标签一律走 t('rootKind.'+kind)。
     */
    function rootKindOf(rootId, source) {
      const id = str(rootId).toLowerCase()
      const src = str(source).toLowerCase()
      if (id === 'bundled' || src === 'bundled') return 'bundled'
      if (id.indexOf('custom') === 0 || src === 'custom') return 'custom'
      if (id.indexOf('project') === 0 || src.indexOf('project') === 0) return 'project'
      if (id.indexOf('user') === 0 || src.indexOf('user') === 0) return 'user'
      return ''
    }

    /** 根标签：有已知 kind 用本地化文案，否则回退 Host 的 label/id（未来可能出现新根）。 */
    function rootLabel(t, kind, fallback) {
      return kind ? t('rootKind.' + kind) : (str(fallback) || '—')
    }

    // `baseName` 目前没有调用点：目标根那行改成「类别名 + 完整路径」，不再需要短名。
    // 保留函数是因为市场/根展示以后可能再用到路径尾段；若确无需要可整段删除。
    function baseName(filePath) {
      const parts = str(filePath).split(/[\\/]+/).filter(function (part) { return part.length > 0 })
      return parts.length ? parts[parts.length - 1] : ''
    }

    /** 字节数（不是字符数）：正文上限按字节算，UTF-8 中文占 3 字节。 */
    function byteLength(text) {
      const value = String(text == null ? '' : text)
      try {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length
      } catch (error) { /* 没有 TextEncoder 时退回粗估 */ }
      return value.length * 2
    }
    function withQuery(path, params) {
      const pairs = []
      Object.keys(params || {}).forEach(function (key) {
        const value = params[key]
        if (value === undefined || value === null || value === '') return
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      })
      return pairs.length ? path + '?' + pairs.join('&') : path
    }

    /* ------------------------------------------------------------------ *
     * 工作区选择（#5）：记住上次选的目录，空串表示跟随当前会话
     * ------------------------------------------------------------------ */
    const WS_STORAGE_KEY = PLUGIN_ID + '.workspace'
    const WS_RECENT_MAX = 5

    /** 读回上次的工作区选择；localStorage 不可用时当作「跟随当前会话」。 */
    function readWorkspaceState() {
      const empty = { current: '', recent: [] }
      try {
        if (typeof localStorage === 'undefined') return empty
        const raw = localStorage.getItem(WS_STORAGE_KEY)
        if (!raw) return empty
        const parsed = JSON.parse(raw)
        if (!isObj(parsed)) return empty
        // 旧版本可能存过相对路径；Host 会把它按进程目录解析，宁可不认。
        const stored = str(parsed.current)
        const current = looksLikeAbsolutePath(stored) ? stored : ''
        const recent = asArray(parsed.recent)
          .map(function (item) { return str(item) })
          .filter(function (item) { return item !== '' && item !== current && looksLikeAbsolutePath(item) })
        return { current: current, recent: recent.slice(0, WS_RECENT_MAX) }
      } catch (error) {
        return empty
      }
    }

    /** 持久化工作区选择；写失败只影响「记住上次」，不阻塞操作。 */
    function writeWorkspaceState(state) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(WS_STORAGE_KEY, JSON.stringify({ current: str(state.current), recent: asArray(state.recent) }))
      } catch (error) { /* 隐私模式等场景忽略 */ }
    }

    /** 记住一个目录：当前的进 recent 头，重复项去重。 */
    function rememberWorkspace(state, next) {
      const path = str(next).trim()
      if (path === '' || !looksLikeAbsolutePath(path)) return { current: '', recent: state.recent }
      const recent = [path].concat(state.recent.filter(function (item) { return item !== path })).slice(0, WS_RECENT_MAX)
      return { current: path, recent: recent }
    }

    /** 目录短名：取尾段，空路径返回空串（调用方决定回退文案）。 */
    function shortPath(path) {
      return baseName(path)
    }

    /* ------------------------------------------------------------------ *
     * HTTP（仅同源）
     * ------------------------------------------------------------------ */
    function ApiError(code, message, status) {
      this.name = 'ApiError'
      this.code = code || 'unknown'
      this.message = message || this.code
      this.status = status
    }
    ApiError.prototype = Object.create(Error.prototype)
    ApiError.prototype.constructor = ApiError
    function isAbortError(error) {
      return !!error && (error.name === 'AbortError' || error.code === 'aborted' || error.code === 'cancelled')
    }
    async function apiRequest(path, options) {
      const opts = options || {}
      const method = opts.method || 'GET'
      const init = { method: method, credentials: 'same-origin', headers: {} }
      if (method !== 'GET' && method !== 'HEAD') {
        init.headers['content-type'] = 'application/json'
        if (opts.body !== undefined) init.body = JSON.stringify(opts.body)
      }
      let timer = null
      if (opts.timeoutMs && !opts.signal && typeof AbortController !== 'undefined') {
        const controller = new AbortController()
        init.signal = controller.signal
        timer = setTimeout(function () { controller.abort() }, opts.timeoutMs)
      } else if (opts.signal) {
        init.signal = opts.signal
      }
      let response
      try {
        response = await fetch(API_BASE + path, init)
      } catch (error) {
        if (timer) clearTimeout(timer)
        if (isAbortError(error)) throw new ApiError('aborted', 'request aborted')
        throw new ApiError('unreachable', error && error.message ? error.message : 'network error')
      }
      if (timer) clearTimeout(timer)
      let contentType = ''
      try {
        contentType = response.headers && response.headers.get ? response.headers.get('content-type') || '' : ''
      } catch (error) { contentType = '' }
      let payload = null
      let parsed = false
      let raw = ''
      if (contentType.indexOf('application/json') >= 0) {
        try { payload = await response.json(); parsed = true } catch (error) { parsed = false }
      } else {
        try { raw = await response.text() } catch (error) { raw = '' }
        if (raw) {
          try { payload = JSON.parse(raw); parsed = true } catch (error) { parsed = false }
        }
      }
      if (!response.ok) {
        const errorObject = parsed && isObj(payload) && isObj(payload.error) ? payload.error : null
        const code = errorObject && errorObject.code ? str(errorObject.code) : 'http-' + response.status
        const message = errorObject && errorObject.message ? str(errorObject.message) : raw ? raw.slice(0, 400) : ''
        throw new ApiError(code, message, response.status)
      }
      if (!parsed || payload === null) {
        throw new ApiError(contentType.indexOf('application/json') >= 0 ? 'invalid-response' : 'route-missing')
      }
      return payload
    }

    /** 契约 §4：按 code 翻译，message 只作兜底原文。 */
    function describeError(t, error) {
      if (!error) return t('err.unknown')
      const code = str(error.code) || 'unknown'
      if (code === 'unreachable') return t('err.unreachable')
      if (code === 'route-missing' || code === 'invalid-response') return t('err.routeMissing')
      if (code === 'aborted') return t('err.aborted')
      if (code === 'http-401' || code === 'http-403') return t('err.forbidden')
      const detail = error.message && error.message !== code ? String(error.message) : ''
      const key = ERROR_KEYS[code]
      if (key) return detail ? t('err.withDetail', { base: t(key), detail: detail }) : t(key)
      if (code.indexOf('http-') === 0) {
        const status = str(error.status || code.slice(5))
        return detail
          ? t('err.withDetail', { base: t('err.http', { status: status }), detail: detail })
          : t('err.http', { status: status })
      }
      return detail || t('err.unknown')
    }

    /** 契约 §7：已知 code 用本地文案，未知 code 回退 Host 的 message。 */
    function issueText(t, issue) {
      const code = str(issue && issue.code)
      if (ISSUE_CODES.indexOf(code) >= 0) return t('issue.' + code)
      return str(issue && issue.message) || code
    }

    /* ------------------------------------------------------------------ *
     * 响应归一化（Host 字段缺失不致白屏）
     * ------------------------------------------------------------------ */
    function normalizeIssue(raw) {
      if (!isObj(raw)) return null
      const code = str(raw.code)
      if (!code) return null
      const line = num(raw.line, 0)
      return { level: raw.level === 'error' ? 'error' : 'warn', code: code, message: str(raw.message), line: line > 0 ? line : 0 }
    }
    function normalizeRoot(raw) {
      if (!isObj(raw)) return null
      const id = str(raw.id)
      if (!id) return null
      const kind = raw.kind === 'project' || raw.kind === 'user' || raw.kind === 'custom' || raw.kind === 'bundled'
        ? raw.kind
        : rootKindOf(id, raw.source) || 'custom'
      return {
        id: id, label: str(raw.label), source: str(raw.source), kind: kind,
        rank: num(raw.rank, 900), path: str(raw.path), exists: raw.exists !== false,
        writable: raw.writable === true, skillCount: num(raw.skillCount, 0),
      }
    }
    function normalizeSkill(raw, rootById) {
      if (!isObj(raw)) return null
      const rootId = str(raw.rootId)
      const dirName = str(raw.dirName)
      if (!rootId || !dirName) return null
      const root = rootById ? rootById[rootId] : null
      const invocation = isObj(raw.invocation) ? raw.invocation : {}
      const resources = isObj(raw.resources) ? raw.resources : null
      const shadowedBy = isObj(raw.shadowedBy) ? raw.shadowedBy : null
      const shadowedByPlugin = isObj(raw.shadowedByPlugin) ? raw.shadowedByPlugin : null
      const issues = []
      asArray(raw.issues).forEach(function (item) {
        const issue = normalizeIssue(item)
        if (issue) issues.push(issue)
      })
      return {
        key: str(raw.key) || rootId + '/' + dirName,
        rootId: rootId,
        rootLabel: str(raw.rootLabel) || (root ? root.label : ''),
        rootPath: str(raw.rootPath) || (root ? root.path : ''),
        // 行/抽屉要用本地化根名，这里把推断结果随 skill 一起带上（不信任英文 rootLabel）。
        rootKind: (root && root.kind) || rootKindOf(rootId, raw.source) || '',
        source: str(raw.source) || (root ? root.source : ''),
        rank: num(raw.rank, root ? root.rank : 900),
        // 根声明只读时行级 writable 一律视为只读（bundled 兜底）。
        writable: raw.writable === true || (raw.writable !== false && !!root && root.writable === true),
        dirName: dirName,
        kind: raw.kind === 'file' ? 'file' : 'directory',
        state: raw.state === 'disabled' || raw.state === 'invalid' ? raw.state : 'enabled',
        name: str(raw.name) || dirName,
        description: str(raw.description),
        whenToUse: str(raw.whenToUse),
        invocation: { model: invocation.model !== false, user: invocation.user !== false },
        path: str(raw.path),
        bodyChars: num(raw.bodyChars, 0),
        size: num(raw.size, 0),
        mtimeMs: num(raw.mtimeMs, 0),
        hash: str(raw.hash),
        issues: issues,
        shadowed: raw.shadowed === true,
        shadowedBy: shadowedBy ? { rootId: str(shadowedBy.rootId), rootLabel: str(shadowedBy.rootLabel) } : null,
        // 插件同名遮蔽：只保留 provider（Host 明确不覆盖已有 shadowedBy）。
        shadowedByPlugin: shadowedByPlugin && str(shadowedByPlugin.provider)
          ? { provider: str(shadowedByPlugin.provider) }
          : null,
        resources: resources
          ? { files: num(resources.files, 0), references: num(resources.references, 0), scripts: num(resources.scripts, 0), assets: num(resources.assets, 0) }
          : null,
      }
    }
    function normalizeOverview(raw) {
      const source = isObj(raw) ? raw : {}
      const roots = []
      asArray(source.roots).forEach(function (item) {
        const root = normalizeRoot(item)
        if (root) roots.push(root)
      })
      roots.sort(function (a, b) { return a.rank - b.rank })
      const rootById = {}
      roots.forEach(function (root) { rootById[root.id] = root })
      const skills = []
      asArray(source.skills).forEach(function (item) {
        const skill = normalizeSkill(item, rootById)
        if (skill) skills.push(skill)
      })
      // counts 由 skills 现算：行内乐观切换后计数必须与列表同源，避免两份事实。
      const counts = { total: skills.length, enabled: 0, disabled: 0, invalid: 0, shadowed: 0, shadowedByPlugin: 0 }
      skills.forEach(function (skill) {
        if (skill.state === 'invalid') counts.invalid += 1
        else if (skill.state === 'disabled') counts.disabled += 1
        else counts.enabled += 1
        if (skill.shadowed) counts.shadowed += 1
        if (skill.shadowedByPlugin) counts.shadowedByPlugin += 1
      })
      const diagnostics = []
      asArray(source.diagnostics).forEach(function (item) {
        if (!isObj(item)) return
        diagnostics.push({
          code: str(item.code), message: str(item.message), rootId: str(item.rootId),
          name: str(item.name), path: str(item.path),
        })
      })
      const marketRaw = isObj(source.market) ? source.market : null
      const pluginRaw = isObj(source.pluginSkills) ? source.pluginSkills : null
      return {
        cwd: str(source.cwd), projectRoot: str(source.projectRoot),
        dshHome: str(source.dshHome), agentsHome: str(source.agentsHome),
        roots: roots, skills: skills, counts: counts, diagnostics: diagnostics,
        market: marketRaw
          ? {
              available: marketRaw.available === true, path: str(marketRaw.path),
              repos: num(marketRaw.repos, 0), skills: num(marketRaw.skills, 0),
              installed: num(marketRaw.installed, 0),
              lastSyncAt: str(marketRaw.lastSyncAt),
            }
          : null,
        // 插件技能视图：服务不可用时 available=false，页面照常跑，只是没有同名标记。
        pluginSkills: pluginRaw
          ? {
              available: pluginRaw.available === true,
              count: num(pluginRaw.count, 0),
              providers: asArray(pluginRaw.providers).map(function (item) { return str(item) }).filter(function (item) { return item !== '' }),
              error: str(pluginRaw.error),
            }
          : { available: false, count: 0, providers: [], error: '' },
        scannedAt: num(source.scannedAt, 0),
      }
    }
    function normalizeDetail(raw) {
      const source = isObj(raw) ? raw : {}
      return {
        skill: normalizeSkill(source.skill, null),
        content: str(source.content),
        frontmatter: isObj(source.frontmatter) ? source.frontmatter : null,
        body: str(source.body),
        eol: source.eol === 'crlf' ? 'crlf' : 'lf',
        hasBom: source.hasBom === true,
      }
    }
    function normalizeMarket(raw) {
      const source = isObj(raw) ? raw : {}
      const counts = isObj(source.counts) ? source.counts : {}
      const repos = []
      asArray(source.repos).forEach(function (item) {
        if (!isObj(item)) return
        const skills = []
        asArray(item.skills).forEach(function (entry) {
          if (!isObj(entry)) return
          skills.push({
            folder: str(entry.folder), name: str(entry.name) || str(entry.folder),
            description: str(entry.description), path: str(entry.path),
            installed: entry.installed === true,
            // 手工同名技能 ≠ 已安装：账本按 repo+folder 精确匹配，名字撞车单独标。
            nameTaken: entry.nameTaken === true,
            installedAt: str(entry.installedAt), installedPath: str(entry.installedPath),
            updateAvailable: str(entry.updateAvailable),
            issue: str(entry.issue),
          })
        })
        // total = 该仓库命中总数（浏览模式下只返回 perRepo 条代表技能，不能拿 skills.length 当总数）。
        repos.push({ repo: str(item.repo), label: str(item.label) || str(item.repo), total: num(item.total, skills.length), skills: skills })
      })
      return {
        available: source.available === true, path: str(source.path), lastSyncAt: str(source.lastSyncAt),
        counts: {
          repos: num(counts.repos, repos.length), skills: num(counts.skills, 0),
          installed: num(counts.installed, 0),
          // 契约 §3.8：totalSkills = 市场索引规模（6440 量级），skills 只是本次返回条数。
          totalSkills: num(counts.totalSkills, num(counts.skills, 0)),
          matching: num(counts.matching, num(counts.totalSkills, num(counts.skills, 0))),
        },
        truncated: source.truncated === true,
        repos: repos,
      }
    }
    /** 调用账本（#2）：服务不可用时 available=false，列表照常跑，只是不显示次数。 */
    function normalizeUsage(raw) {
      const source = isObj(raw) ? raw : {}
      const sessions = isObj(source.sessions) ? source.sessions : {}
      const list = []
      asArray(source.skills).forEach(function (item) {
        if (!isObj(item)) return
        const name = str(item.name)
        if (!name) return
        list.push({
          name: name, d7: num(item.d7, 0), d30: num(item.d30, 0), d90: num(item.d90, 0),
          modelCalls: num(item.modelCalls, 0), userCalls: num(item.userCalls, 0),
          lastUsedAt: num(item.lastUsedAt, 0),
        })
      })
      return {
        available: source.available === true,
        error: str(source.error),
        rangeDays: num(source.rangeDays, 90),
        sessions: {
          total: num(sessions.total, 0), scanned: num(sessions.scanned, 0),
          skipped: num(sessions.skipped, 0), truncated: sessions.truncated === true,
        },
        list: list,
      }
    }

    /* ------------------------------------------------------------------ *
     * 图标（纯内联 SVG，stroke 1.5，currentColor，16px 基线）
     * ------------------------------------------------------------------ */
    function svg(children, props) {
      const p = props || {}
      return h('svg', {
        width: p.size || 16, height: p.size || 16, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false', className: p.className,
      }, children)
    }
    function IconSearch(p) { return svg([h('circle', { key: 'c', cx: 11, cy: 11, r: 7 }), h('path', { key: 'p', d: 'M20 20l-3.7-3.7' })], p) }
    function IconClose(p) { return svg([h('path', { key: 'p', d: 'M6 6l12 12M18 6L6 18' })], p) }
    function IconRefresh(p) { return svg([h('path', { key: 'a', d: 'M20 11a8 8 0 1 0-2.3 5.7' }), h('path', { key: 'b', d: 'M20 5v6h-6' })], p) }
    function IconPlus(p) { return svg([h('path', { key: 'p', d: 'M12 5v14M5 12h14' })], p) }
    function IconFolder(p) { return svg([h('path', { key: 'p', d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h9A1.5 1.5 0 0 1 21 10v7.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z' })], p) }
    function IconChevron(p) { return svg([h('path', { key: 'p', d: p.dir === 'right' ? 'M9.5 6l6 6-6 6' : 'M6 9.5l6 6 6-6' })], p) }
    function IconWarn(p) { return svg([h('path', { key: 'a', d: 'M12 4.5l8 14H4z' }), h('path', { key: 'b', d: 'M12 10v4M12 16.6v.4' })], p) }
    function IconCheck(p) { return svg([h('path', { key: 'p', d: 'M5 12.5l4.5 4.5L19 7.5' })], p) }
    function IconTrash(p) {
      return svg([h('path', { key: 'a', d: 'M4 7h16' }), h('path', { key: 'b', d: 'M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7' }),
        h('path', { key: 'c', d: 'M6.5 7l.8 11.2A1.8 1.8 0 0 0 9.1 20h5.8a1.8 1.8 0 0 0 1.8-1.8L17.5 7' })], p)
    }
    function IconExternal(p) {
      return svg([h('path', { key: 'a', d: 'M14 5h5v5' }), h('path', { key: 'b', d: 'M19 5l-7.5 7.5' }),
        h('path', { key: 'c', d: 'M18 15v3.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H9' })], p)
    }
    function IconFilter(p) { return svg([h('path', { key: 'p', d: 'M4 6h16l-6.2 7.4V19l-3.6-2v-3.6z' })], p) }
    /** 排序字形：长短条 + 下箭头。 */
    function IconSort(p) {
      return svg([h('path', { key: 'a', d: 'M4 7h10' }), h('path', { key: 'b', d: 'M4 12h7' }),
        h('path', { key: 'c', d: 'M4 17h4' }), h('path', { key: 'd', d: 'M18 7v10' }),
        h('path', { key: 'e', d: 'M15.5 14.5L18 17l2.5-2.5' })], p)
    }
    /** 导入字形：箭头落进托盘（与「打开目录」的文件夹字形区分开）。 */
    function IconImport(p) {
      return svg([h('path', { key: 'a', d: 'M12 4v9.5' }), h('path', { key: 'b', d: 'M8.3 10L12 13.7 15.7 10' }),
        h('path', { key: 'c', d: 'M4.5 15.5v2.8A1.7 1.7 0 0 0 6.2 20h11.6a1.7 1.7 0 0 0 1.7-1.7v-2.8' })], p)
    }
    /** 技能字形：书页 + 星火，呼应「技能」而非通用文件。 */
    function IconSparkle(p) {
      return svg([h('path', { key: 'a', d: 'M6.5 4.5h8L18 8v11.5H6.5z' }), h('path', { key: 'b', d: 'M14 4.5V8h4' }),
        h('path', { key: 'c', d: 'M12 11l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1L9 14l2.1-.9z' })], p)
    }
    /**
     * 技能卡片 + 星火（列表行左侧的底片图形）。
     * 与设置导航字形 NAV_GLYPH、包图标 icon.svg 同一形象：一个技能＝一张卡片 + 一点星火。
     */
    function IconSkillMark(p) {
      return svg([
        h('rect', { key: 'a', x: 3.6, y: 6.6, width: 11.2, height: 14.1, rx: 2.6 }),
        h('path', { key: 'b', d: 'M6.9 11.4h5.1M6.9 15.3h3.3' }),
        h('path', {
          key: 'c',
          d: 'M19.2 4.2c.48 2.13 1.32 2.97 3.45 3.45-2.13.48-2.97 1.32-3.45 3.45-.48-2.13-1.32-2.97-3.45-3.45 2.13-.48 2.97-1.32 3.45-3.45z',
        }),
      ], p)
    }

    /* ------------------------------------------------------------------ *
     * Settings-nav glyph
     *
     * DSH's settings shell picks its nav glyph by section id and falls back to
     * the generic settings gear for ids it does not know
     * (`dsh-client-ui-settings-general`: `navIcon(id)`), and
     * `settings.section` exposes no `icon` option — so this page would render a
     * second gear right beside the Settings row's own gear. Until the harness
     * ships an icon option, this decorator swaps that fallback glyph for this
     * plugin's own artwork (a card + sparkle, the same mark as icon.svg).
     *
     * Deliberately defensive: an unexpected panel shape leaves the shipped gear
     * untouched, a missing DOM keeps the plugin bootable, and the effect
     * disposer restores the original nodes. Delete it — together with
     * NAV_PANEL_SELECTOR / NAV_GLYPH_ATTR / NAV_GLYPH — once
     * `settings.section` accepts an icon.
     * ------------------------------------------------------------------ */

    const NAV_PANEL_SELECTOR = '[data-shortcut-modal="settings"]'
    const NAV_GLYPH_ATTR = 'data-' + PLUGIN_ID + '-nav-glyph'

    /** 16×16 / stroke 1.3，与 DSH Medium 图标同参数：卡片 + 两条文本线 + 右上星火（不压卡片边）。 */
    const NAV_GLYPH = [
      ['rect', { x: 2.4, y: 4.4, width: 7.5, height: 9.4, rx: 1.7 }],
      ['path', { d: 'M4.6 7.6h3.4' }],
      ['path', { d: 'M4.6 10.2h2.2' }],
      ['path', { d: 'M12.8 2.8c.32 1.42.88 1.98 2.3 2.3-1.42.32-1.98.88-2.3 2.3-.32-1.42-.88-1.98-2.3-2.3 1.42-.32 1.98-.88 2.3-2.3z' }],
    ]

    /**
     * 侧边栏「技能管理」入口的图标。宿主 `sidebar.panellist` 只给 `{ size, active }`，
     * 行本身负责选中态与可访问名，所以这里只画同一形象（卡片 + 星火）的装饰性 SVG。
     */
    function IconPanelMark(p) {
      const size = (p && p.size) || 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      }, NAV_GLYPH.map(function (spec, index) {
        return h(spec[0], Object.assign({ key: index }, spec[1]))
      }))
    }

    function navGlyphElement(doc) {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.3')      // == ICON_MEDIUM_STROKE
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('focusable', 'false')
      svg.setAttribute(NAV_GLYPH_ATTR, '1')
      NAV_GLYPH.forEach(function (spec) {
        const node = doc.createElementNS('http://www.w3.org/2000/svg', spec[0])
        Object.keys(spec[1]).forEach(function (name) {
          node.setAttribute(name, String(spec[1][name]))
        })
        svg.appendChild(node)
      })
      return svg
    }

    /**
     * Hide the fallback gear of this plugin's own settings-nav row and put our
     * glyph in its place. Returns how many rows are decorated; a row that is
     * already ours is only re-asserted when the shell re-rendered its gear, so
     * the mutation observer stays quiet.
     */
    function decorateNavRow(doc, labels) {
      const panel = doc.querySelector(NAV_PANEL_SELECTOR)
      if (!panel) return 0
      const rows = panel.querySelectorAll('nav button')
      let decorated = 0
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]
        const mine = row.querySelector('svg[' + NAV_GLYPH_ATTR + ']')
        // Shipped row: [svg gear, span label]. Decorated row: [our svg, svg
        // gear, span label] — React keeps its own gear node, we only hide it.
        let gear
        let label
        if (mine && row.children.length === 3) {
          gear = row.children[1]
          label = row.children[2]
        } else if (row.children.length === 2) {
          gear = row.children[0]
          label = row.children[1]
        } else {
          continue
        }
        if (String(gear.tagName).toLowerCase() !== 'svg') continue
        if (!mine && labels.indexOf(String(label.textContent).trim()) < 0) continue
        if (!mine) {
          const glyph = navGlyphElement(doc)
          glyph.setAttribute('class', gear.getAttribute('class') || '')
          row.insertBefore(glyph, gear)
          row.setAttribute(NAV_GLYPH_ATTR, '1')
        }
        if (gear.style.display !== 'none') gear.style.display = 'none'
        decorated += 1
      }
      return decorated
    }

    /**
     * Keep this plugin's nav glyph in place while the settings panel lives.
     * Returns a disposer that restores the shipped gear and removes our nodes.
     */
    function installNavGlyph(labels) {
      if (typeof document === 'undefined' || !document.body) return function () {}
      if (typeof MutationObserver === 'undefined') return function () {}
      if (typeof document.createElementNS !== 'function') return function () {}
      const doc = document
      const run = function () {
        try {
          decorateNavRow(doc, labels)
        } catch (error) {
          /* A presentation nicety must never break the settings shell. */
        }
      }
      run()
      const observer = new MutationObserver(run)
      // childList over the whole tree costs one attribute query per mutation
      // batch and is the only way to notice the portaled panel appearing.
      observer.observe(doc.body, { childList: true, subtree: true })
      return function dispose() {
        observer.disconnect()
        const marked = doc.querySelectorAll('[' + NAV_GLYPH_ATTR + ']')
        for (let i = 0; i < marked.length; i += 1) {
          const row = marked[i]
          if (String(row.tagName).toLowerCase() !== 'button') continue
          const glyph = row.querySelector('svg[' + NAV_GLYPH_ATTR + ']')
          if (glyph && glyph.parentNode) glyph.parentNode.removeChild(glyph)
          const gear = row.children[0]
          if (gear && gear.style && gear.style.display === 'none') gear.style.display = ''
          row.removeAttribute(NAV_GLYPH_ATTR)
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * 浮层通用行为：Esc 关闭 / Tab 循环 / 焦点进入与归还
     * ------------------------------------------------------------------ */
    const FOCUSABLE =
      'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

    /**
     * 回调放在 ref 里，effect 只在挂载/卸载时跑一次：
     * 否则父组件每次渲染换掉 onClose 身份，就会反复抢焦点。
     */
    function useDialogChrome(panelRef, onClose, canClose) {
      const handlers = useRef({ onClose: onClose, canClose: canClose })
      handlers.current = { onClose: onClose, canClose: canClose }
      useEffect(function () {
        if (typeof document === 'undefined') return undefined
        const panel = panelRef.current
        const previous = document.activeElement
        function focusables() {
          if (!panel) return []
          const nodes = panel.querySelectorAll(FOCUSABLE)
          return Array.prototype.filter.call(nodes, function (node) {
            return node.offsetParent !== null || node === document.activeElement
          })
        }
        function onKeyDown(event) {
          if (event.key === 'Escape') {
            event.stopPropagation()
            if (handlers.current.canClose()) {
              event.preventDefault()
              handlers.current.onClose()
            }
            return
          }
          if (event.key !== 'Tab') return
          const list = focusables()
          if (!list.length) return
          const first = list[0]
          const last = list[list.length - 1]
          const active = document.activeElement
          if (list.indexOf(active) < 0) { event.preventDefault(); first.focus(); return }
          if (event.shiftKey && active === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', onKeyDown, true)
        // 有 data-autofocus 的元素优先（新建对话框落在名称输入框），否则第一个可聚焦元素。
        const auto = panel && panel.querySelector ? panel.querySelector('[data-autofocus]') : null
        const target = auto || focusables()[0] || panel
        if (target && typeof target.focus === 'function') {
          try { target.focus() } catch (error) { /* 焦点失败不影响可用性 */ }
        }
        return function () {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous && typeof previous.focus === 'function') {
            try { previous.focus() } catch (error) { /* 触发元素可能已被卸载 */ }
          }
        }
      }, [])
    }

    /* ------------------------------------------------------------------ *
     * 基础控件
     * ------------------------------------------------------------------ */
    function Btn(props) {
      return h('button', {
        type: 'button',
        className: cx('sm-btn', props.variant ? 'sm-btn-' + props.variant : null, props.size === 'sm' && 'sm-btn-sm', props.className),
        disabled: props.disabled === true || props.busy === true,
        title: props.title,
        'aria-label': props['aria-label'],
        'aria-busy': props.busy ? 'true' : undefined,
        onClick: props.onClick,
      },
        props.busy ? h('span', { key: 'spin', className: 'sm-spinner', 'aria-hidden': 'true' }) : null,
        props.icon && !props.busy ? h(props.icon, { key: 'icon', size: props.size === 'sm' ? 14 : 15 }) : null,
        props.children != null ? h('span', { key: 'label', className: 'sm-btn-label' }, props.children) : null,
      )
    }
    function IconBtn(props) {
      return h('button', {
        type: 'button',
        className: cx('sm-icon-btn', props.className),
        disabled: props.disabled === true,
        title: props.label,
        'aria-label': props.label,
        'aria-expanded': props.expanded === undefined ? undefined : props.expanded ? 'true' : 'false',
        onClick: props.onClick,
      }, h(props.icon, { size: props.size || 15 }))
    }

    /** role="switch"；点击不冒泡，避免顺带打开详情抽屉（ui-spec §3.2）。 */
    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        title: props.title,
        className: cx('sm-switch', props.checked && 'sm-switch-on', props.small && 'sm-switch-sm'),
        disabled: props.disabled === true,
        onClick: function (event) {
          event.stopPropagation()
          if (props.disabled) return
          if (props.onChange) props.onChange(!props.checked)
        },
      }, h('span', { className: 'sm-switch-knob' }))
    }
    function Badge(props) {
      return h('span', { className: cx('sm-badge', 'sm-badge-' + (props.tone || 'neutral')), title: props.title },
        props.dot ? h('span', { key: 'dot', className: 'sm-badge-dot', 'aria-hidden': 'true' }) : null,
        props.children)
    }
    function Segmented(props) {
      return h('div', { className: 'sm-seg', role: 'tablist', 'aria-label': props.label },
        asArray(props.items).map(function (item) {
          const active = item.value === props.value
          return h('button', {
            key: item.value, type: 'button', role: 'tab',
            'aria-selected': active ? 'true' : 'false',
            className: cx('sm-seg-item', active && 'sm-seg-item-active'),
            onClick: function () { props.onChange(item.value) },
          }, item.label)
        }))
    }
    function SearchField(props) {
      return h('div', { className: cx('sm-search', props.className) },
        h(IconSearch, { size: 14, className: 'sm-search-icon' }),
        h('input', {
          ref: props.inputRef, className: 'sm-search-input', type: 'search',
          value: props.value, placeholder: props.placeholder, 'aria-label': props.label,
          spellCheck: false, autoComplete: 'off',
          onChange: function (event) { props.onChange(event.target.value) },
          onKeyDown: props.onKeyDown,
        }),
        props.value
          ? h('button', {
              type: 'button', className: 'sm-search-clear', 'aria-label': props.clearLabel,
              title: props.clearLabel,
              onClick: function () {
                props.onChange('')
                if (props.onClearFocus && props.inputRef && props.inputRef.current) props.inputRef.current.focus()
              },
            }, h(IconClose, { size: 12 }))
          : null)
    }

    /** 自绘下拉菜单（ui-spec §3.1 明确禁止原生 select）。 */
    function StatusMenu(props) {
      const [open, setOpen] = useState(false)
      const wrapRef = useRef(null)
      useEffect(function () {
        if (!open || typeof document === 'undefined') return undefined
        function onDocDown(event) {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false)
        }
        function onKey(event) { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDocDown, true)
        document.addEventListener('keydown', onKey, true)
        return function () {
          document.removeEventListener('mousedown', onDocDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])
      let current = props.items[0]
      props.items.forEach(function (item) { if (item.value === props.value) current = item })
      const Icon = props.icon || IconFilter
      return h('div', { className: cx('sm-menu-wrap', props.className), ref: wrapRef },
        h('button', {
          type: 'button',
          className: cx('sm-menu-trigger', open && 'sm-menu-trigger-open'),
          'aria-haspopup': 'true', 'aria-expanded': open ? 'true' : 'false',
          'aria-label': props.label, title: props.title || props.label,
          onClick: function () { setOpen(!open) },
        },
          h(Icon, { size: 14 }),
          h('span', { className: 'sm-menu-trigger-label' }, current ? current.label : ''),
          h(IconChevron, { size: 12 })),
        open
          ? h('div', { className: cx('sm-menu', props.wide && 'sm-menu-wide'), role: 'menu', 'aria-label': props.label },
              props.items.map(function (item) {
                const active = item.value === props.value
                return h('button', {
                  key: item.value, type: 'button', role: 'menuitemradio',
                  'aria-checked': active ? 'true' : 'false',
                  className: cx('sm-menu-item', active && 'sm-menu-item-active'),
                  onClick: function () { setOpen(false); props.onChange(item.value) },
                },
                  h('span', { className: 'sm-menu-check', 'aria-hidden': 'true' }, active ? h(IconCheck, { size: 13 }) : null),
                  h('span', { className: 'sm-menu-label' }, item.label))
              }))
          : null)
    }

    /**
     * 极小的行内菜单（#1 三态调用策略）：触发器就是原来那枚调用徽章。
     *
     * 点击必须 stopPropagation —— 整行点击会打开详情抽屉，行内菜单不能顺带触发它。
     * 菜单项带第二行说明：三个状态之间的差别（模型能不能看到、/ 命令还能不能用）不写清楚
     * 就只能靠试。
     */
    function MiniMenu(props) {
      const [open, setOpen] = useState(false)
      const wrapRef = useRef(null)
      useEffect(function () {
        if (!open || typeof document === 'undefined') return undefined
        function onDocDown(event) {
          if (wrapRef.current && !wrapRef.current.contains(event.target)) setOpen(false)
        }
        function onKey(event) { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDocDown, true)
        document.addEventListener('keydown', onKey, true)
        return function () {
          document.removeEventListener('mousedown', onDocDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])
      return h('span', { className: 'sm-mini', ref: wrapRef },
        h('button', {
          type: 'button',
          className: cx('sm-mini-trigger', props.tone && 'sm-mini-trigger-' + props.tone, !props.text && 'sm-mini-trigger-plain'),
          'aria-haspopup': 'true', 'aria-expanded': open ? 'true' : 'false',
          'aria-label': props.label, title: props.title,
          onClick: function (event) { event.stopPropagation(); setOpen(!open) },
        },
          // 默认档不写文字（ui-spec §3.2）：一列都刻着「默认」只会稀释真正的信息，
          // 这里留一个小箭头作为可点的提示。
          props.text ? h('span', { className: 'sm-mini-text' }, props.text) : null,
          h(IconChevron, { size: 10 })),
        open
          ? h('div', { className: 'sm-menu sm-menu-wide', role: 'menu', 'aria-label': props.label },
              asArray(props.items).map(function (item) {
                const active = item.value === props.value
                return h('button', {
                  key: item.value, type: 'button', role: 'menuitemradio',
                  'aria-checked': active ? 'true' : 'false',
                  className: cx('sm-menu-item', active && 'sm-menu-item-active'),
                  onClick: function (event) {
                    event.stopPropagation()
                    setOpen(false)
                    props.onChange(item.value)
                  },
                },
                  h('span', { className: 'sm-menu-check', 'aria-hidden': 'true' }, active ? h(IconCheck, { size: 13 }) : null),
                  h('span', { className: 'sm-menu-col' },
                    h('span', { className: 'sm-menu-label' }, item.label),
                    item.hint ? h('span', { className: 'sm-menu-hint' }, item.hint) : null))
              }))
          : null)
    }
    function EmptyState(props) {
      return h('div', { className: cx('sm-empty', props.error && 'sm-empty-error') },
        props.icon ? h(props.icon, { size: 22, className: 'sm-empty-icon' }) : null,
        h('div', { className: 'sm-empty-title' }, props.title),
        props.desc ? h('div', { className: 'sm-empty-desc' }, props.desc) : null,
        props.actions ? h('div', { className: 'sm-empty-actions' }, props.actions) : null)
    }
    function Skeleton(props) {
      return h('div', { className: 'sm-skeleton', 'aria-hidden': 'true' },
        h('div', { className: 'sm-skeleton-row' }),
        h('div', { className: 'sm-skeleton-row' }),
        h('div', { className: 'sm-skeleton-row' }),
        props.label ? h('div', { className: 'sm-skeleton-label' }, props.label) : null)
    }
    function Toasts(props) {
      const list = asArray(props.toasts)
      if (!list.length) return null
      return h('div', { className: 'sm-toasts', role: 'status', 'aria-live': 'polite' },
        list.map(function (item) {
          const text = item.error ? describeError(props.t, item.error) : props.t(item.key, item.vars)
          return h('div', { key: item.id, className: cx('sm-toast', 'sm-toast-' + (item.tone || 'info')) },
            h('span', { className: 'sm-toast-icon', 'aria-hidden': 'true' },
              item.tone === 'success' ? h(IconCheck, { size: 13 })
                : item.tone === 'error' ? h(IconWarn, { size: 13 })
                  : h(IconSparkle, { size: 13 })),
            h('span', { className: 'sm-toast-text' }, text),
            h('button', {
              type: 'button', className: 'sm-toast-close',
              'aria-label': props.t('toast.dismiss'), title: props.t('toast.dismiss'),
              onClick: function () { props.onDismiss(item.id) },
            }, h(IconClose, { size: 12 })))
        }))
    }
    function ConfirmDialog(props) {
      const t = props.t
      const panelRef = useRef(null)
      useDialogChrome(panelRef, props.onCancel, function () { return !props.busy })
      return h('div', {
        className: 'sm-mask sm-mask-center',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget && !props.busy) props.onCancel()
        },
      },
        h('div', {
          className: 'sm-modal sm-modal-narrow', role: 'alertdialog', 'aria-modal': 'true',
          'aria-label': props.title, ref: panelRef,
          onMouseDown: function (event) { event.stopPropagation() },
        },
          h('div', { className: 'sm-modal-head' }, h('h3', { className: 'sm-modal-title' }, props.title)),
          h('div', { className: 'sm-modal-body' }, h('p', { className: 'sm-modal-text' }, props.body)),
          h('div', { className: 'sm-modal-foot' },
            h(Btn, { onClick: props.onCancel, disabled: props.busy }, t('act.cancel')),
            h(Btn, { variant: 'danger', busy: props.busy, onClick: props.onConfirm }, props.confirmLabel))))
    }

    /* ------------------------------------------------------------------ *
     * 列表
     * ------------------------------------------------------------------ */
    function invocationText(t, skill) {
      // 默认（模型可调用 + 用户可调用）不画标签：每一行都写一遍「模型可调用」只会稀释
      // 真正需要注意的信息。只有偏离默认的组合才值得占位。
      if (skill.invocation.model && skill.invocation.user) return ''
      if (skill.invocation.model) return t('inv.badgeModelOnly')
      return skill.invocation.user ? t('inv.badgeManual') : t('inv.badgeOff')
    }
    /** 三态菜单当前落在哪一档（默认 / 仅手动 / 都不可调用）。 */
    function invocationMode(skill) {
      if (skill.invocation.model && skill.invocation.user) return 'default'
      if (!skill.invocation.model && skill.invocation.user) return 'manual'
      if (!skill.invocation.model && !skill.invocation.user) return 'off'
      return 'modelOnly'
    }
    /** 该档对应的宿主取值（契约 §3.10）。 */
    const INVOCATION_MODES = {
      default: { model: true, user: true },
      manual: { model: false, user: true },
      off: { model: false, user: false },
    }
    function SkillRow(props) {
      const t = props.t
      const skill = props.skill
      const invalid = skill.state === 'invalid'
      let firstError = null
      skill.issues.forEach(function (issue) { if (!firstError && issue.level === 'error') firstError = issue })
      // 被遮蔽的根同样只信 rootId：shadowedBy 只有 rootId + 英文 rootLabel。
      const shadowBy = skill.shadowed ? skill.shadowedBy : null
      const shadowTitle = shadowBy
        ? t('row.shadowedTitle', { root: rootLabel(t, rootKindOf(shadowBy.rootId, ''), shadowBy.rootLabel) })
        : t('row.badgeShadowed')
      // 只读（bundled）行隐藏开关；异常行显示但禁用并给出原因（ui-spec §3.2）。
      let toggle = null
      if (skill.writable && !props.selectMode) {
        toggle = h(Switch, {
          checked: skill.state !== 'disabled',
          disabled: invalid || props.busy,
          label: t('a11y.switch', { name: skill.name }),
          title: invalid ? t('row.switchBlocked') : skill.state === 'disabled' ? t('row.switchOff') : t('row.switchOn'),
          small: true,
          onChange: function (next) { props.onToggle(skill, next) },
        })
      }
      // 调用策略：可写的正常技能给三态菜单（写盘只改两个键，不搬目录）；
      // 只读 / 异常 / 批量模式下退回纯文本徽章。
      const invText = invocationText(t, skill)
      let invocationControl = invText ? h('span', { className: 'sm-row-inv' }, invText) : null
      if (skill.writable && !invalid && !props.selectMode && typeof props.onInvocation === 'function') {
        const mode = invocationMode(skill)
        invocationControl = h(MiniMenu, {
          // 默认档只留箭头（invText 为空），不写「默认」二字。
          text: invText,
          tone: mode === 'default' ? '' : (mode === 'modelOnly' ? 'ok' : 'warn'),
          value: mode,
          label: t('inv.menuLabel', { name: skill.name }),
          title: t('inv.menuTitle'),
          items: [
            { value: 'default', label: t('inv.menuDefault'), hint: t('inv.menuDefaultHint') },
            { value: 'manual', label: t('inv.menuManual'), hint: t('inv.menuManualHint') },
            { value: 'off', label: t('inv.menuOff'), hint: t('inv.menuOffHint') },
          ],
          onChange: function (next) { props.onInvocation(skill, next) },
        })
      }
      // 调用账本：没统计到就是「从未使用」，这正是要清理的那批。
      let usageBadge = null
      if (props.usageAvailable) {
        const row = props.usage
        if (row === undefined) {
          usageBadge = h(Badge, { tone: 'warn', title: t('usage.neverHint') }, t('usage.never'))
        } else {
          const detail = [t('usage.metaValue', { d7: row.d7, d30: row.d30, d90: row.d90 }),
            row.lastUsedAt > 0 ? t('usage.lastUsed', { time: formatTime(row.lastUsedAt) }) : ''].filter(Boolean).join(' · ')
          usageBadge = h('span', { className: 'sm-row-usage', title: detail }, t('usage.short', { count: row.d7 }))
        }
      }
      const selectable = props.selectMode === true
      return h('div', {
        className: cx('sm-row', invalid && 'sm-row-invalid', selectable && 'sm-row-select', props.selected && 'sm-row-picked'),
        'data-skill-key': skill.key,
        // 整行可点（ui-spec §3.2）；键盘与读屏走内层 button，开关自己 stopPropagation。
        // 批量模式下整行点击改为勾选，不打开抽屉。
        onClick: function () { selectable ? props.onSelect(skill) : props.onOpen(skill) },
      },
        selectable
          ? h('input', {
              type: 'checkbox', className: 'sm-check', checked: props.selected === true,
              'aria-label': t('batch.selectRow', { name: skill.name }),
              onChange: function (event) { event.stopPropagation(); props.onSelect(skill) },
              onClick: function (event) { event.stopPropagation() },
            })
          : null,
        h('span', { className: 'sm-glyph', 'aria-hidden': 'true' }, h(IconSkillMark, { size: 17 })),
        h('button', {
          type: 'button',
          className: 'sm-row-main',
          'aria-label': t('a11y.row', { name: skill.name }),
          ref: function (node) { props.registerRow(skill.key, node) },
          // 鼠标点击统一由行容器处理（冒泡上来即可），这里只负责键盘打开与上下移动焦点。
          onKeyDown: function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              selectable ? props.onSelect(skill) : props.onOpen(skill)
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              props.onMove(skill.key, event.key === 'ArrowDown' ? 1 : -1)
            }
          },
        },
          h('span', { className: 'sm-row-title' },
            h('span', { className: 'sm-row-name' }, skill.name),
            invalid ? h(Badge, { tone: 'error' }, t('row.badgeInvalid')) : null,
            skill.shadowed ? h(Badge, { tone: 'warn', title: shadowTitle }, t('row.badgeShadowed')) : null,
            skill.shadowedByPlugin
              ? h(Badge, {
                  tone: 'warn',
                  title: t('row.pluginShadowedTitle', {
                    name: skill.name,
                    provider: skill.shadowedByPlugin.provider,
                  }),
                }, t('row.badgePluginShadowed'))
              : null,
            !skill.writable ? h(Badge, { tone: 'neutral' }, t('row.badgeReadonly')) : null),
          h('span', { className: 'sm-row-desc' }, skill.description || t('row.noDescription')),
          invalid && firstError ? h('span', { className: 'sm-row-error' }, issueText(t, firstError)) : null),
        h('span', { className: 'sm-row-actions' },
          usageBadge,
          props.showRoot ? h('span', { className: 'sm-row-source' }, rootLabel(t, skill.rootKind, skill.rootLabel)) : null,
          invocationControl,
          toggle))
    }
    function GroupHeader(props) {
      const t = props.t
      return h('div', { className: 'sm-group-head' },
        h('button', {
          type: 'button', className: 'sm-group-toggle',
          'aria-expanded': props.collapsed ? 'false' : 'true',
          'aria-label': props.collapsed ? t('group.expand') : t('group.collapse'),
          title: props.collapsed ? t('group.expand') : t('group.collapse'),
          onClick: props.onToggle,
        },
          h(IconChevron, { size: 13, dir: props.collapsed ? 'right' : 'down' }),
          h('span', { className: 'sm-group-title' }, props.title),
          props.subtitle ? h('span', { className: 'sm-group-sub' }, props.subtitle) : null,
          h('span', { className: 'sm-group-count' }, t('group.count', { count: props.count }))),
        props.onOpenRoot
          ? h(IconBtn, { icon: IconFolder, label: t('a11y.openRoot'), size: 14, onClick: props.onOpenRoot })
          : null)
    }

    /* ------------------------------------------------------------------ *
     * frontmatter 文本编辑（调用策略开关改的是正文，不单独走写接口）
     * ------------------------------------------------------------------ */
    function splitFrontmatter(content) {
      const text = String(content == null ? '' : content)
      const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
      const lines = text.split(/\r\n|\n/)
      if (!lines.length) return null
      if (lines[0].replace(/^\uFEFF/, '').trim() !== '---') return null
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
          // 行内式 YAML（frontmatter 是一个 {...} / [...]）无法按「顶层 key: value」编辑：
          // 硬插一个块式键会让整段变成非法 YAML，所以标记 flow 后由调用方放弃编辑。
          let flow = false
          for (let k = 1; k < i; k++) {
            if (/^\s*[\[{]/.test(lines[k])) { flow = true; break }
          }
          return { lines: lines, close: i, eol: eol, flow: flow, hasBom: lines[0].charAt(0) === '\uFEFF' }
        }
      }
      return null
    }
    function truthyYaml(text) {
      return /^(true|yes|on|1)$/i.test(String(text).trim().replace(/^["']|["']$/g, ''))
    }

    /** 从正文读出调用策略；没有 frontmatter 或不是块式 YAML 时返回 null（开关改为提示不可编辑）。 */
    function readInvocation(content) {
      const fm = splitFrontmatter(content)
      if (!fm || fm.flow) return null
      const state = { model: true, user: true }
      for (let i = 1; i < fm.close; i++) {
        const line = fm.lines[i]
        if (/^\s/.test(line)) continue
        const match = /^(disable-model-invocation|user-invocable)\s*:\s*(.*)$/.exec(line)
        if (!match) continue
        const value = truthyYaml(match[2])
        if (match[1] === 'disable-model-invocation') state.model = !value
        else state.user = value
      }
      return state
    }

    /** 写回调用键：允许时写 false（保留键，语义显式），不允许时写契约 §3.4 的取值。 */
    function setInvocation(content, flag, allowed) {
      const fm = splitFrontmatter(content)
      if (!fm || fm.flow) return content
      const key = flag === 'model' ? 'disable-model-invocation' : 'user-invocable'
      const value = flag === 'model' ? (allowed ? 'false' : 'true') : allowed ? 'true' : 'false'
      const lines = fm.lines.slice()
      let found = -1
      for (let i = 1; i < fm.close; i++) {
        if (/^\s/.test(lines[i])) continue
        const match = /^(disable-model-invocation|user-invocable)\s*:/.exec(lines[i])
        if (match && match[1] === key) { found = i; break }
      }
      if (found >= 0) lines[found] = key + ': ' + value
      // 插在结束的 --- 之前，保持 frontmatter 结构不被打散。
      else lines.splice(fm.close, 0, key + ': ' + value)
      return lines.join(fm.eol)
    }

    /* ------------------------------------------------------------------ *
     * 详情抽屉
     * ------------------------------------------------------------------ */
    function DetailDrawer(props) {
      const t = props.t
      const initial = props.skill
      const cwd = str(props.cwd)
      const [load, setLoad] = useState({ phase: 'loading', data: null, error: null })
      const [draft, setDraft] = useState('')
      const [base, setBase] = useState('')
      const [hash, setHash] = useState(initial.hash)
      const [issues, setIssues] = useState(initial.issues)
      const [conflict, setConflict] = useState(false)
      const [saving, setSaving] = useState(false)
      const [toggling, setToggling] = useState(false)
      const [deleting, setDeleting] = useState(false)
      const [confirming, setConfirming] = useState(false)
      const [reloadTick, setReloadTick] = useState(0)
      const panelRef = useRef(null)
      // 契约 §3.2 的 state 只有 enabled|disabled；invalid 技能实际落在启用区，按 enabled 读。
      const stateParam = initial.state === 'disabled' ? 'disabled' : 'enabled'
      useEffect(function () {
        let cancelled = false
        setLoad({ phase: 'loading', data: null, error: null })
        setConflict(false)
        apiRequest(withQuery('/skill', {
          rootId: initial.rootId, dirName: initial.dirName, kind: initial.kind, state: stateParam,
          ...(cwd ? { cwd: cwd } : {}),
        }), { timeoutMs: 20000 })
          .then(function (raw) {
            if (cancelled) return
            const detail = normalizeDetail(raw)
            setLoad({ phase: 'ready', data: detail, error: null })
            setBase(detail.content)
            setDraft(detail.content)
            setHash((detail.skill && detail.skill.hash) || initial.hash)
            setIssues((detail.skill && detail.skill.issues) || initial.issues)
          })
          .catch(function (error) {
            if (!cancelled) setLoad({ phase: 'error', data: null, error: error })
          })
        return function () { cancelled = true }
        // 只随技能身份或显式重载变化；其它 props 变化不应重置草稿。
      }, [initial.key, reloadTick])
      const busy = saving || deleting || toggling
      // 二次确认开着时，Esc / 点遮罩只关闭确认，不能连带关掉抽屉。
      useDialogChrome(panelRef, function () { props.onClose() }, function () { return !busy && !confirming })
      const ready = load.phase === 'ready'
      const detail = load.data
      const invocation = ready ? readInvocation(draft) : null
      const dirty = ready && draft !== base
      const draftBytes = byteLength(draft)
      const overLimit = draftBytes > MAX_CONTENT_BYTES
      function applyDraft(next) {
        setDraft(next)
        if (conflict) setConflict(false)
      }
      async function save() {
        if (!ready || !dirty || saving) return
        setSaving(true)
        try {
          const result = await apiRequest('/skill/save', {
            method: 'POST',
            timeoutMs: 30000,
            body: {
              rootId: initial.rootId, dirName: initial.dirName, kind: initial.kind,
              state: stateParam, hash: hash, content: draft,
              ...(cwd ? { cwd: cwd } : {}),
            },
          })
          const nextIssues = []
          asArray(result && result.issues).forEach(function (item) {
            const issue = normalizeIssue(item)
            if (issue) nextIssues.push(issue)
          })
          setHash(str(result && result.hash) || hash)
          setBase(draft)
          setIssues(nextIssues)
          setConflict(false)
          const errors = nextIssues.filter(function (issue) { return issue.level === 'error' }).length
          // 解析失败仍允许保存，但必须显著提示「宿主会丢弃该技能」（ui-spec §3.3）。
          if (errors > 0) props.notify({ tone: 'error', key: 'toast.savedErrors', vars: { count: errors } })
          else props.notify({ tone: 'success', key: 'toast.saved' })
          props.onChanged()
        } catch (error) {
          // 绝不覆盖别人的编辑：409 只提示重新载入（重载会丢草稿，文案已写明）。
          if (error && error.code === 'conflict') setConflict(true)
          props.notify({ tone: 'error', error: error })
        } finally {
          setSaving(false)
        }
      }
      async function toggleEnabled() {
        if (busy) return
        setToggling(true)
        const next = initial.state !== 'enabled'
        try {
          await apiRequest('/skill/toggle', {
            method: 'POST',
            timeoutMs: 20000,
            body: { rootId: initial.rootId, dirName: initial.dirName, kind: initial.kind, enabled: next, ...(cwd ? { cwd: cwd } : {}) },
          })
          props.notify({ tone: 'success', key: next ? 'toast.enabled' : 'toast.disabled', vars: { name: initial.name } })
          props.onChanged()
          props.onClose()
        } catch (error) {
          props.notify({ tone: 'error', error: error })
        } finally {
          setToggling(false)
        }
      }
      async function remove() {
        if (busy) return
        setDeleting(true)
        try {
          await apiRequest('/skill/delete', {
            method: 'POST',
            timeoutMs: 20000,
            body: { rootId: initial.rootId, dirName: initial.dirName, kind: initial.kind, ...(cwd ? { cwd: cwd } : {}) },
          })
          setConfirming(false)
          props.notify({ tone: 'success', key: 'toast.deleted' })
          props.onChanged()
          props.onClose()
        } catch (error) {
          props.notify({ tone: 'error', error: error })
        } finally {
          setDeleting(false)
        }
      }
      function openPath() {
        if (!initial.path) return
        apiRequest('/open', {
          method: 'POST',
          timeoutMs: 15000,
          body: { rootId: initial.rootId, dirName: initial.dirName, kind: initial.kind, ...(cwd ? { cwd: cwd } : {}) },
        })
          .then(function () { props.notify({ tone: 'success', key: 'toast.opened' }) })
          .catch(function (error) { props.notify({ tone: 'error', error: error }) })
      }
      const metaRows = []
      function metaCell(label, value) {
        metaRows.push(h('div', { className: 'sm-meta-cell', key: label },
          h('span', { className: 'sm-meta-label' }, label),
          h('span', { className: 'sm-meta-value' }, value)))
      }
      if (ready && detail && detail.skill) {
        const skill = detail.skill
        metaCell(t('meta.source'), rootLabel(t, skill.rootKind, skill.rootLabel || skill.rootPath))
        metaCell(t('meta.kind'), t('kind.' + skill.kind))
        metaCell(t('meta.size'), formatBytes(skill.size))
        metaCell(t('meta.mtime'), formatTime(skill.mtimeMs))
        metaCell(t('meta.bodyChars'), t('meta.chars', { count: skill.bodyChars }))
        // 调用账本：服务不可用时不占位（空行比「—」更容易被误读成「0 次」）。
        if (props.usageAvailable) {
          const row = props.usage
          metaCell(t('meta.usage'), row === undefined
            ? t('usage.never')
            : t('usage.metaValue', { d7: row.d7, d30: row.d30, d90: row.d90 }))
          metaCell(t('meta.lastUsed'), row === undefined || row.lastUsedAt <= 0 ? '—' : formatTime(row.lastUsedAt))
        }
        if (skill.resources) {
          metaCell(t('meta.resources'), t('meta.resourcesValue', {
            files: skill.resources.files, references: skill.resources.references,
            scripts: skill.resources.scripts, assets: skill.resources.assets,
          }))
        }
      }
      const issueList = issues.length
        ? h('ul', { className: 'sm-issues' },
            issues.map(function (issue, index) {
              return h('li', { key: issue.code + '-' + index, className: 'sm-issue sm-issue-' + issue.level },
                h('span', { className: 'sm-issue-icon', 'aria-hidden': 'true' },
                  issue.level === 'error' ? h(IconWarn, { size: 13 }) : h(IconSparkle, { size: 13 })),
                h('span', { className: 'sm-issue-text' },
                  issueText(t, issue),
                  issue.line > 0
                    ? h('span', { className: 'sm-issue-line' }, t('issues.line', { line: issue.line }))
                    : null))
            }))
        : h('div', { className: 'sm-issue sm-issue-ok' }, h(IconCheck, { size: 13 }), t('issues.none'))
      let body = null
      if (load.phase === 'error') {
        body = h(EmptyState, {
          error: true, icon: IconWarn, title: t('err.title'), desc: describeError(t, load.error),
          actions: h(Btn, { icon: IconRefresh, onClick: function () { setReloadTick(reloadTick + 1) } }, t('act.retry')),
        })
      } else if (load.phase === 'loading') {
        body = h(Skeleton, { label: t('body.loading') })
      } else {
        body = [
          h('section', { className: 'sm-section', key: 'meta' },
            h('div', { className: 'sm-meta-grid' }, metaRows)),
          h('section', { className: 'sm-section', key: 'inv' },
            h('div', { className: 'sm-section-title' }, t('inv.title')),
            invocation
              ? h('div', { className: 'sm-inv-list' },
                  h('div', { className: 'sm-inv-row' },
                    h('div', { className: 'sm-inv-text' },
                      h('div', { className: 'sm-inv-label' }, t('inv.model')),
                      h('div', { className: 'sm-inv-hint' }, t('inv.modelHint'))),
                    h(Switch, {
                      checked: invocation.model, small: true, label: t('inv.model'),
                      onChange: function (next) { applyDraft(setInvocation(draft, 'model', next)) },
                    })),
                  h('div', { className: 'sm-inv-row' },
                    h('div', { className: 'sm-inv-text' },
                      h('div', { className: 'sm-inv-label' }, t('inv.user')),
                      h('div', { className: 'sm-inv-hint' }, t('inv.userHint'))),
                    h(Switch, {
                      checked: invocation.user, small: true, label: t('inv.user'),
                      onChange: function (next) { applyDraft(setInvocation(draft, 'user', next)) },
                    })),
                  h('div', { className: 'sm-inv-foot' }, t('inv.dirtyHint')))
              : h('div', { className: 'sm-inv-hint' }, t('inv.unavailable'))),
          h('section', { className: 'sm-section', key: 'issues' },
            h('div', { className: 'sm-section-title' }, t('issues.title')), issueList),
          h('section', { className: 'sm-section', key: 'body' },
            h('div', { className: 'sm-editor-head' },
              h('span', { className: 'sm-section-title' }, t('body.title')),
              h('span', { className: 'sm-editor-stat' }, t('body.lines', { count: draft.split(/\r\n|\n/).length })),
              h('span', { className: 'sm-editor-stat' }, t('body.bytes', { count: draftBytes })),
              h('span', { className: 'sm-editor-spacer' }),
              h(Btn, {
                size: 'sm', variant: 'ghost', disabled: !dirty,
                onClick: function () { applyDraft(base) },
              }, t('body.reset'))),
            conflict
              ? h('div', { className: 'sm-conflict' },
                  h(IconWarn, { size: 14 }),
                  h('span', { className: 'sm-conflict-text' }, t('body.conflict')),
                  h(Btn, { size: 'sm', onClick: function () { setReloadTick(reloadTick + 1) } }, t('body.reload')))
              : null,
            overLimit ? h('div', { className: 'sm-field-error' }, t('err.too-large')) : null,
            h('textarea', {
              className: 'sm-editor', value: draft, spellCheck: false,
              placeholder: t('body.placeholder'), 'aria-label': t('body.title'),
              onChange: function (event) { applyDraft(event.target.value) },
            })),
        ]
      }
      return h('div', {
        className: 'sm-mask',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget && !busy && !confirming) props.onClose()
        },
      },
        h('aside', {
          className: 'sm-drawer', role: 'dialog', 'aria-modal': 'true',
          'aria-label': initial.name, ref: panelRef,
          onMouseDown: function (event) { event.stopPropagation() },
        },
          h('header', { className: 'sm-drawer-head' },
            h('div', { className: 'sm-drawer-head-text' },
              h('div', { className: 'sm-drawer-title-row' },
                h('h2', { className: 'sm-drawer-title' }, initial.name),
                h(Badge, {
                  tone: initial.state === 'enabled' ? 'success' : initial.state === 'disabled' ? 'idle' : 'error',
                  dot: true,
                }, t('state.' + initial.state)),
                initial.shadowed ? h(Badge, { tone: 'warn' }, t('row.badgeShadowed')) : null),
              h('button', {
                type: 'button', className: 'sm-path', title: t('act.open'), onClick: openPath,
              },
                h('span', { className: 'sm-path-text' }, initial.path || initial.dirName),
                h(IconExternal, { size: 12 }))),
            h(IconBtn, { icon: IconClose, label: t('a11y.detailClose'), onClick: props.onClose, disabled: busy })),
          h('div', { className: 'sm-drawer-body' }, body),
          h('footer', { className: 'sm-drawer-foot' },
            h('div', { className: 'sm-foot-left' },
              initial.writable
                ? h(Btn, {
                    size: 'sm', busy: toggling, disabled: busy || initial.state === 'invalid',
                    onClick: toggleEnabled,
                  }, initial.state === 'enabled' ? t('act.disable') : t('act.enable'))
                : null,
              initial.writable
                ? h(Btn, {
                    size: 'sm', variant: 'danger', icon: IconTrash, disabled: busy,
                    onClick: function () { setConfirming(true) },
                  }, t('act.delete'))
                : null),
            h('div', { className: 'sm-foot-right' },
              h(Btn, { onClick: props.onClose, disabled: saving }, t('act.close')),
              h(Btn, {
                variant: 'primary', busy: saving,
                disabled: !dirty || conflict || overLimit,
                onClick: save,
              }, t('act.save')))),
          confirming
            ? h(ConfirmDialog, {
                t: t,
                title: t('del.title'),
                body: t('del.body', { name: initial.name, path: initial.rootPath || initial.dirName }),
                confirmLabel: t('del.confirm'),
                busy: deleting,
                onCancel: function () { setConfirming(false) },
                onConfirm: remove,
              })
            : null))
    }

    /* ------------------------------------------------------------------ *
     * 新建对话框
     * ------------------------------------------------------------------ */
    function CreateDialog(props) {
      const t = props.t
      const writableRoots = props.roots.filter(function (root) { return root.writable })
      const cwd = str(props.cwd)
      const [name, setName] = useState('')
      const [description, setDescription] = useState('')
      const [whenToUse, setWhenToUse] = useState('')
      const [rootId, setRootId] = useState(props.defaultRootId || (writableRoots[0] ? writableRoots[0].id : ''))
      const [body, setBody] = useState(t('create.bodyDefault'))
      const [submitting, setSubmitting] = useState(false)
      const [failure, setFailure] = useState(null)
      const panelRef = useRef(null)
      useDialogChrome(panelRef, function () { props.onClose() }, function () { return !submitting })
      const nameBad = name.length > 0 && (!KEBAB.test(name) || name.length > NAME_MAX)
      const canSubmit = !submitting && KEBAB.test(name) && description.trim().length > 0 && !!rootId
      const tooLong = description.length > DESCRIPTION_SOFT_MAX
      async function submit() {
        if (!canSubmit) return
        setSubmitting(true)
        setFailure(null)
        try {
          const payload = { rootId: rootId, name: name, description: description.trim(), body: body }
          if (whenToUse.trim()) payload.whenToUse = whenToUse.trim()
          if (cwd) payload.cwd = cwd
          const result = await apiRequest('/skill/create', { method: 'POST', timeoutMs: 30000, body: payload })
          props.onCreated(result && result.skill ? result.skill : null)
        } catch (error) {
          setFailure(error)
        } finally {
          setSubmitting(false)
        }
      }
      const fields = writableRoots.length === 0
        ? h('p', { className: 'sm-modal-text' }, t('create.noRoot'))
        : [
            h('div', { className: 'sm-field', key: 'name' },
              h('label', { className: 'sm-field-label', htmlFor: 'sm-create-name' }, t('create.name')),
              h('input', {
                id: 'sm-create-name', className: cx('sm-input', nameBad && 'sm-input-invalid'),
                'data-autofocus': '',
                value: name, placeholder: t('create.namePlaceholder'), spellCheck: false,
                autoComplete: 'off', 'aria-invalid': nameBad ? 'true' : 'false',
                onChange: function (event) { setName(event.target.value.trim().toLowerCase()) },
              }),
              h('div', { className: 'sm-field-hint' }, nameBad ? t('create.nameInvalid') : t('create.nameHint'))),
            h('div', { className: 'sm-field', key: 'desc' },
              h('label', { className: 'sm-field-label', htmlFor: 'sm-create-desc' }, t('create.description')),
              h('textarea', {
                id: 'sm-create-desc', className: 'sm-input sm-textarea sm-textarea-sm',
                value: description, rows: 2, spellCheck: false,
                placeholder: t('create.descriptionPlaceholder'),
                'aria-invalid': tooLong ? 'true' : 'false',
                onChange: function (event) { setDescription(event.target.value) },
              }),
              h('div', { className: cx('sm-field-hint', tooLong && 'sm-field-warn') },
                tooLong ? t('create.descriptionLong') : t('create.descriptionCounter', { count: description.length }))),
            h('div', { className: 'sm-field', key: 'when' },
              h('label', { className: 'sm-field-label', htmlFor: 'sm-create-when' }, t('create.whenToUse')),
              h('input', {
                id: 'sm-create-when', className: 'sm-input', value: whenToUse,
                placeholder: t('create.whenToUsePlaceholder'), spellCheck: false,
                onChange: function (event) { setWhenToUse(event.target.value) },
              })),
            h('div', { className: 'sm-field', key: 'root' },
              h('label', { className: 'sm-field-label', htmlFor: 'sm-create-root' }, t('create.root')),
              h('select', {
                id: 'sm-create-root', className: 'sm-input sm-select', value: rootId,
                onChange: function (event) { setRootId(event.target.value) },
              },
                writableRoots.map(function (root) {
                  const label = rootLabel(t, root.kind, root.label) + (root.exists ? '' : t('create.rootMissing'))
                  return h('option', { key: root.id, value: root.id }, label + ' · ' + root.path)
                })),
              h('div', { className: 'sm-field-hint' }, t('create.rootHint'))),
            h('div', { className: 'sm-field', key: 'body' },
              h('label', { className: 'sm-field-label', htmlFor: 'sm-create-body' }, t('create.body')),
              h('textarea', {
                id: 'sm-create-body', className: 'sm-input sm-textarea sm-mono',
                value: body, rows: 8, spellCheck: false,
                onChange: function (event) { setBody(event.target.value) },
              }),
              h('div', { className: 'sm-field-hint' }, t('create.bodyHint'))),
          ]
      return h('div', {
        className: 'sm-mask sm-mask-center',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget && !submitting) props.onClose()
        },
      },
        h('div', {
          className: 'sm-modal', role: 'dialog', 'aria-modal': 'true',
          'aria-label': t('create.title'), ref: panelRef,
          onMouseDown: function (event) { event.stopPropagation() },
        },
          h('div', { className: 'sm-modal-head' },
            h('h3', { className: 'sm-modal-title' }, t('create.title')),
            h(IconBtn, { icon: IconClose, label: t('a11y.close'), onClick: props.onClose, disabled: submitting })),
          h('div', { className: 'sm-modal-body' },
            fields,
            failure ? h('div', { className: 'sm-field-error' }, describeError(t, failure)) : null),
          h('div', { className: 'sm-modal-foot' },
            h(Btn, { onClick: props.onClose, disabled: submitting }, t('act.cancel')),
            h(Btn, { variant: 'primary', busy: submitting, disabled: !canSubmit, onClick: submit }, t('create.submit')))))
    }

    /* ------------------------------------------------------------------ *
     * 工作区目录（#5）：手输路径的兜底入口
     * ------------------------------------------------------------------ */
    /**
     * Whether a path is absolute enough to hand to the Host.
     *
     * The Host resolves `cwd` with `path.resolve`, which resolves a relative path
     * against the **host process** cwd and never expands `~` — silently pointing
     * the panel at an unrelated directory. Reject those shapes here instead.
     */
    function looksLikeAbsolutePath(value) {
      const text = str(value).trim()
      if (text === '') return false
      return /^[A-Za-z]:[\\/]/.test(text) || /^[\\/]/.test(text) || /^file:\/\//i.test(text)
    }
    function PathDialog(props) {
      const t = props.t
      const [value, setValue] = useState(str(props.initial))
      const panelRef = useRef(null)
      useDialogChrome(panelRef, function () { props.onClose() }, function () { return true })
      // 粘贴常见带引号的路径时去掉外层引号，避免把引号当路径的一部分。
      const trimmed = value.trim().replace(/^"(.*)"$/, '$1').trim()
      const invalid = trimmed !== '' && !looksLikeAbsolutePath(trimmed)
      function submit() {
        if (trimmed === '' || invalid) return
        props.onApply(trimmed)
        props.onClose()
      }
      return h('div', {
        className: 'sm-mask sm-mask-center',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget) props.onClose()
        },
      },
        h('div', {
          className: 'sm-modal sm-modal-narrow', role: 'dialog', 'aria-modal': 'true',
          'aria-label': t('ws.dialogTitle'), ref: panelRef,
          onMouseDown: function (event) { event.stopPropagation() },
        },
          h('div', { className: 'sm-modal-head' },
            h('h3', { className: 'sm-modal-title' }, t('ws.dialogTitle')),
            h(IconBtn, { icon: IconClose, label: t('a11y.close'), onClick: props.onClose })),
          h('div', { className: 'sm-modal-body' },
            h('div', { className: 'sm-field' },
              h('label', { className: 'sm-field-label', htmlFor: 'sm-ws-path' }, t('ws.label')),
              h('input', {
                id: 'sm-ws-path', className: cx('sm-input sm-mono', invalid && 'sm-input-invalid'),
                'data-autofocus': '', 'aria-invalid': invalid ? 'true' : 'false',
                value: value, placeholder: t('ws.placeholder'), spellCheck: false, autoComplete: 'off',
                onChange: function (event) { setValue(event.target.value) },
                onKeyDown: function (event) { if (event.key === 'Enter') submit() },
              }),
              h('div', { className: 'sm-field-hint' }, t('ws.dialogHint')),
              invalid ? h('div', { className: 'sm-field-error' }, t('ws.needAbsolute')) : null)),
          h('div', { className: 'sm-modal-foot' },
            h(Btn, { onClick: props.onClose }, t('act.cancel')),
            h(Btn, { variant: 'primary', disabled: trimmed === '' || invalid, onClick: submit }, t('ws.dialogConfirm')))))
    }

    /* ------------------------------------------------------------------ *
     * 导入本地技能包（#6）
     * ------------------------------------------------------------------ */
    /** 从一次拖放里取出可能的目录/文件路径（Electron 给 `file.path`，浏览器只给 URI）。 */
    function droppedPath(dataTransfer) {
      if (!dataTransfer) return ''
      let raw = ''
      const file = dataTransfer.files && dataTransfer.files.length ? dataTransfer.files[0] : null
      if (file && typeof file.path === 'string' && file.path !== '') raw = file.path
      if (raw === '' && typeof dataTransfer.getData === 'function') {
        raw = str(dataTransfer.getData('text/uri-list')) || str(dataTransfer.getData('text/plain'))
      }
      raw = raw.split(/\r?\n/)[0].trim()
      if (/^file:\/\//i.test(raw)) {
        try {
          raw = decodeURIComponent(raw.replace(/^file:\/\/\/?/i, ''))
          if (/^\/[A-Za-z]:/.test(raw)) raw = raw.slice(1)
        } catch (error) { /* 保留原串，交给 Host 报错 */ }
      }
      return raw
    }
    function ImportDialog(props) {
      const t = props.t
      const writableRoots = props.roots.filter(function (root) { return root.writable })
      const [source, setSource] = useState('')
      const [rootId, setRootId] = useState(props.defaultRootId || (writableRoots[0] ? writableRoots[0].id : ''))
      const [busy, setBusy] = useState(false)
      const [result, setResult] = useState(null)
      const [failure, setFailure] = useState(null)
      const [dropping, setDropping] = useState(false)
      const panelRef = useRef(null)
      useDialogChrome(panelRef, function () { props.onClose() }, function () { return !busy })
      const trimmed = source.trim()
      const canSubmit = !busy && trimmed !== '' && !!rootId
      async function submit() {
        if (!canSubmit) return
        setBusy(true)
        setFailure(null)
        setResult(null)
        try {
          const body = { path: trimmed, rootId: rootId }
          const cwd = str(props.cwd)
          if (cwd) body.cwd = cwd
          const value = await apiRequest('/skill/import', { method: 'POST', timeoutMs: 120000, body: body })
          const imported = asArray(value && value.imported)
          const skipped = asArray(value && value.skipped)
          setResult({ imported: imported, skipped: skipped })
          if (imported.length > 0) props.onImported(imported.length, skipped.length)
        } catch (error) {
          setFailure(error)
        } finally {
          setBusy(false)
        }
      }
      const importedList = result === null ? null : h('div', { className: 'sm-field', key: 'imported' },
        h('div', { className: 'sm-field-label' }, t('import.importedTitle')),
        result.imported.length === 0
          ? h('div', { className: 'sm-field-hint' }, t('import.noneImported'))
          : h('ul', { className: 'sm-import-list' }, result.imported.map(function (item, index) {
              return h('li', { key: 'ok-' + index, className: 'sm-import-item' },
                h(IconCheck, { size: 12 }),
                h('code', { className: 'sm-import-name' }, str(item.name)),
                h('span', { className: 'sm-import-target' }, str(item.targetPath)))
            })))
      const skippedList = result === null || result.skipped.length === 0 ? null : h('div', { className: 'sm-field', key: 'skipped' },
        h('div', { className: 'sm-field-label' }, t('import.skippedTitle')),
        h('ul', { className: 'sm-import-list' }, result.skipped.map(function (item, index) {
          const code = str(item.code) || 'unsupported'
          const reason = t('import.reason.' + code)
          return h('li', { key: 'skip-' + index, className: 'sm-import-item sm-import-item-warn' },
            h(IconWarn, { size: 12 }),
            h('span', { className: 'sm-import-body' },
              h('code', { className: 'sm-import-name' }, str(item.name) || baseName(str(item.source))),
              h('span', { className: 'sm-import-reason' },
                t('import.reason', { reason: reason, detail: str(item.message) }))),
            code === 'invalid' && item.issue
              ? h(Badge, { tone: 'warn' }, issueText(t, { code: str(item.issue), message: str(item.message) }))
              : null)
        })))
      return h('div', {
        className: 'sm-mask sm-mask-center',
        onMouseDown: function (event) {
          if (event.target === event.currentTarget && !busy) props.onClose()
        },
      },
        h('div', {
          className: cx('sm-modal', dropping && 'sm-modal-drop'), role: 'dialog', 'aria-modal': 'true',
          'aria-label': t('import.title'), ref: panelRef,
          onMouseDown: function (event) { event.stopPropagation() },
          onDragOver: function (event) { event.preventDefault(); if (!dropping) setDropping(true) },
          onDragLeave: function () { setDropping(false) },
          onDrop: function (event) {
            event.preventDefault()
            setDropping(false)
            const next = droppedPath(event.dataTransfer)
            if (next !== '') setSource(next)
          },
        },
          h('div', { className: 'sm-modal-head' },
            h('h3', { className: 'sm-modal-title' }, t('import.title')),
            h(IconBtn, { icon: IconClose, label: t('a11y.close'), onClick: props.onClose, disabled: busy })),
          h('div', { className: 'sm-modal-body' },
            writableRoots.length === 0
              ? h('p', { className: 'sm-modal-text' }, t('create.noRoot'))
              : [
                  h('div', { className: 'sm-field', key: 'src' },
                    h('label', { className: 'sm-field-label', htmlFor: 'sm-import-src' }, t('import.source')),
                    h('input', {
                      id: 'sm-import-src', className: 'sm-input sm-mono', 'data-autofocus': '',
                      value: source, placeholder: t('import.placeholder'), spellCheck: false, autoComplete: 'off',
                      onChange: function (event) { setSource(event.target.value) },
                    }),
                    h('div', { className: 'sm-field-hint' }, t('import.sourceHint')),
                    h('div', { className: 'sm-field-hint' }, t('import.dropHint'))),
                  h('div', { className: 'sm-field', key: 'root' },
                    h('label', { className: 'sm-field-label', htmlFor: 'sm-import-root' }, t('import.root')),
                    h('select', {
                      id: 'sm-import-root', className: 'sm-input sm-select', value: rootId,
                      onChange: function (event) { setRootId(event.target.value) },
                    },
                      writableRoots.map(function (root) {
                        const label = rootLabel(t, root.kind, root.label) + (root.exists ? '' : t('create.rootMissing'))
                        return h('option', { key: root.id, value: root.id }, label + ' · ' + root.path)
                      })),
                    h('div', { className: 'sm-field-hint' }, t('create.rootHint'))),
                  importedList,
                  skippedList,
                ],
            failure ? h('div', { className: 'sm-field-error' }, describeError(t, failure)) : null),
          h('div', { className: 'sm-modal-foot' },
            h(Btn, { onClick: props.onClose, disabled: busy }, result === null ? t('act.cancel') : t('act.close')),
            h(Btn, { variant: 'primary', busy: busy, disabled: !canSubmit, onClick: submit },
              busy ? t('import.importing') : t('import.submit')))))
    }

    /* ------------------------------------------------------------------ *
     * 批量操作条（#4）
     * ------------------------------------------------------------------ */
    function BatchBar(props) {
      const t = props.t
      const count = num(props.count, 0)
      // 「全选可见」必须能在 0 选中时点（那是批量流程的起点），所以它只看 busy；
      // 清除与三个动作才要求已有选择。
      const noSelection = count === 0
      const actionDisabled = props.busy || noSelection
      return h('div', { className: 'sm-batchbar', role: 'region', 'aria-label': t('batch.enter') },
        h('span', { className: 'sm-batch-count' }, t('batch.selected', { count: count })),
        h(Btn, { size: 'sm', variant: 'ghost', disabled: props.busy, onClick: props.onSelectAll }, t('batch.selectAll')),
        h(Btn, { size: 'sm', variant: 'ghost', disabled: actionDisabled, onClick: props.onClear }, t('batch.clear')),
        h('span', { className: 'sm-batch-spacer' }),
        h(Btn, {
          size: 'sm', busy: props.busyAction === 'enable', disabled: actionDisabled,
          onClick: function () { props.onRun('enable') },
        }, t('batch.enable')),
        h(Btn, {
          size: 'sm', busy: props.busyAction === 'disable', disabled: actionDisabled,
          onClick: function () { props.onRun('disable') },
        }, t('batch.disable')),
        h(Btn, {
          size: 'sm', variant: 'danger', busy: props.busyAction === 'delete', disabled: actionDisabled,
          onClick: function () { props.onRun('delete') },
        }, t('batch.delete')),
        h(Btn, { size: 'sm', variant: 'ghost', disabled: props.busy, onClick: props.onExit }, t('batch.exit')))
    }

    /* ------------------------------------------------------------------ *
     * 市场标签页
     * ------------------------------------------------------------------ */
    function MarketView(props) {
      const t = props.t
      const state = props.market
      const [query, setQuery] = useState(props.initialQuery || '')
      const [expanded, setExpanded] = useState({})
      const sentQuery = useRef(props.initialQuery || '')
      const data = state.data

      // 服务端搜索：市场有 6440 个技能，浏览模式每仓库只回 perRepo 条，
      // 所以在已加载切片里本地过滤永远搜不到大多数技能 —— 必须回源（契约 §3.8）。
      useEffect(function () {
        const next = query.trim()
        if (next === sentQuery.current) return undefined
        const timer = setTimeout(function () {
          sentQuery.current = next
          props.onSearch(next)
        }, 200)
        return function () { clearTimeout(timer) }
      }, [query])

      const repos = useMemo(function () {
        if (!data) return []
        const needle = query.trim().toLowerCase()
        const out = []
        data.repos.forEach(function (repo) {
          const skills = repo.skills.filter(function (skill) {
            if (!needle) return true
            return skill.name.toLowerCase().indexOf(needle) >= 0 ||
              skill.description.toLowerCase().indexOf(needle) >= 0 ||
              skill.folder.toLowerCase().indexOf(needle) >= 0 ||
              repo.label.toLowerCase().indexOf(needle) >= 0 ||
              repo.repo.toLowerCase().indexOf(needle) >= 0
          })
          if (!skills.length) return
          out.push({ repo: repo.repo, label: repo.label, total: repo.total || skills.length, skills: skills })
        })
        return out
      }, [data, query])
      if (state.phase === 'loading' && !data) return h(Skeleton, { label: t('loading.market') })
      if (state.phase === 'error' && !data) {
        return h(EmptyState, {
          error: true, icon: IconWarn, title: t('err.title'), desc: describeError(t, state.error),
          actions: h(Btn, { icon: IconRefresh, onClick: props.onReload }, t('err.retry')),
        })
      }
      if (!data) return null
      if (!data.available) {
        return h(EmptyState, {
          error: true, icon: IconFolder, title: t('market.emptyTitle'),
          desc: t('market.emptyDesc', { path: data.path || '—' }),
          actions: props.targetRoot
            ? h(Btn, { icon: IconFolder, onClick: props.onOpenTarget }, t('market.openTarget'))
            : null,
        })
      }
      // 摘要里的技能数用索引规模（totalSkills），不是本次返回条数。
      const totalSkills = data.counts.totalSkills || data.counts.skills || 0
      const installed = data.counts.installed || 0
      const totalRepos = data.counts.repos || data.repos.length
      const targetRoot = props.targetRoot
      // 目标根只写本地化类别名；完整路径单独一行给出，避免「用户技能 · skills · C:\…\skills」的重复。
      const targetLabel = targetRoot ? rootLabel(t, targetRoot.kind, targetRoot.label) : ''
      return h('div', { className: 'sm-market', 'aria-busy': state.phase === 'loading' ? 'true' : undefined },
        h('div', { className: 'sm-market-head' },
          h(SearchField, {
            value: query, placeholder: t('market.search'), label: t('a11y.search'),
            clearLabel: t('search.clear'), onChange: setQuery,
          }),
          h('span', { className: 'sm-market-summary' },
            // 两种模式的口径不同：浏览报索引规模，搜索报命中数。
            // 「已安装 N」只在搜索时给出——它统计的是本次结果里的已安装数。
            query.trim()
              ? t('market.summarySearch', { matching: data.counts.matching || totalSkills, repos: totalRepos, installed: installed })
              : t('market.summaryBrowse', { repos: totalRepos, skills: totalSkills }))),
        data.truncated
          ? h('div', { className: 'sm-market-hint' },
              query.trim() ? t('market.truncated') : t('market.browseHint'))
          : null,
        targetRoot
          ? h('div', { className: 'sm-market-target' },
              t('market.target', { label: targetLabel, path: targetRoot.path }))
          : h('div', { className: 'sm-market-target' }, t('market.noTarget')),
        repos.length === 0
          ? h(EmptyState, { icon: IconSearch, title: t('market.noResults') })
          : repos.map(function (repo) {
              // 有搜索词时只自动展开命中的仓库（ui-spec §3.5），否则默认折叠。
              const open = query.trim() ? true : expanded[repo.repo] === true
              return h('section', { className: 'sm-repo', key: repo.repo },
                h('div', { className: 'sm-group-head' },
                  h('button', {
                    type: 'button', className: 'sm-group-toggle',
                    'aria-expanded': open ? 'true' : 'false',
                    'aria-label': open ? t('group.collapse') : t('group.expand'),
                    onClick: function () {
                      const next = Object.assign({}, expanded)
                      next[repo.repo] = !open
                      setExpanded(next)
                    },
                  },
                    h(IconChevron, { size: 13, dir: open ? 'down' : 'right' }),
                    h('span', { className: 'sm-group-title' }, repo.label || repo.repo),
                    h('span', { className: 'sm-group-count' }, t('group.count', { count: repo.total })))),
                open
                  ? h('div', { className: 'sm-group-body' },
                      repo.skills.map(function (skill) {
                        const key = repo.repo + '/' + skill.folder
                        const busy = props.installing[key] === true
                        const needsUpdate = skill.installed && skill.updateAvailable === 'different'
                        const gone = skill.installed && skill.updateAvailable === 'missing'
                        let action = null
                        if (busy) {
                          action = h(Btn, { size: 'sm', busy: true, disabled: true }, t('market.installing'))
                        } else if (needsUpdate || gone) {
                          // 更新/重装会走 overwrite：旧版本进 _trash/，绝不原地覆盖。
                          action = h(Btn, {
                            size: 'sm', disabled: !targetRoot,
                            title: gone ? t('market.missingHint') : t('market.hasUpdate'),
                            'aria-label': t('a11y.marketInstall', { name: skill.name }),
                            onClick: function () { props.onInstall(repo.repo, skill, true) },
                          }, t('market.update'))
                        } else if (skill.installed) {
                          action = h(Badge, { tone: 'success', dot: true, title: t('market.upToDate') }, t('market.installed'))
                        } else if (skill.nameTaken) {
                          action = h(Badge, { tone: 'warn', title: t('market.nameTakenHint') }, t('market.nameTaken'))
                        } else {
                          action = h(Btn, {
                            size: 'sm', disabled: !targetRoot,
                            'aria-label': t('a11y.marketInstall', { name: skill.name }),
                            onClick: function () { props.onInstall(repo.repo, skill, false) },
                          }, t('market.install'))
                        }
                        return h('div', { className: 'sm-mrow', key: key },
                          h('div', { className: 'sm-mrow-main' },
                            h('div', { className: 'sm-mrow-title' },
                              h('span', { className: 'sm-mrow-name' }, skill.name),
                              needsUpdate && !busy ? h(Badge, { tone: 'warn', title: t('market.hasUpdate') }, t('market.hasUpdate')) : null,
                              skill.issue
                                ? h(Badge, { tone: 'warn', title: t('market.issue', { reason: skill.issue }) }, t('row.badgeInvalid'))
                                : null),
                            h('div', { className: 'sm-mrow-desc' }, skill.description || t('row.noDescription'))),
                          action)
                      }))
                  : null)
            }))
    }

    /* ------------------------------------------------------------------ *
     * 页面
     * ------------------------------------------------------------------ */
    function computeDefaultRootId(roots) {
      let preferred = ''
      let writable = ''
      roots.forEach(function (root) {
        if (root.id === 'user-dsh' && root.writable) preferred = root.id
        if (!writable && root.writable) writable = root.id
      })
      return preferred || writable
    }
    function openRootId(roots, scope) {
      const kind = scope === 'project' ? 'project' : scope === 'bundled' ? 'bundled' : scope === 'user' ? 'user' : ''
      if (kind) {
        const found = roots.filter(function (root) { return root.kind === kind })
        if (found.length) return found[0].id
      }
      return computeDefaultRootId(roots) || (roots.length ? roots[0].id : '')
    }

    /** 状态筛选；「从未使用」只在调用账本可用时出现。分段控件另有 全部/用户/项目/内置 四档（ui-spec §3.1）。 */
    const STATUS_VALUES = ['all', 'enabled', 'disabled', 'invalid', 'shadowed', 'unused']
    /** 排序方式（#2）：名称 / 7 天调用次数 / 最后使用时间。 */
    const SORT_VALUES = ['name', 'usage', 'lastUsed']
    function Page(props) {
      const t0 = typeof props.t === 'function' ? props.t : fallbackT
      const t = useCallback(function (key, vars) { return t0(key, vars) }, [t0])
      const [overview, setOverview] = useState({ phase: 'loading', data: null, error: null })
      const [lastError, setLastError] = useState(null)
      const [errorDismissed, setErrorDismissed] = useState(true)
      const [tab, setTab] = useState('local')
      const [scope, setScope] = useState('all')
      const [status, setStatus] = useState('all')
      const [sort, setSort] = useState('name')
      const [queryInput, setQueryInput] = useState('')
      const [query, setQuery] = useState('')
      const [refreshBusy, setRefreshBusy] = useState(false)
      const [openBusy, setOpenBusy] = useState(false)
      const [collapsed, setCollapsed] = useState({})
      const [selected, setSelected] = useState(null)
      const [creating, setCreating] = useState(false)
      const [importing, setImporting] = useState(false)
      const [market, setMarket] = useState({ phase: 'idle', data: null, error: null })
      const [installing, setInstalling] = useState({})
      const [togglingKey, setTogglingKey] = useState('')
      // 账本与工作区（#2 / #5）
      const [usage, setUsage] = useState({ phase: 'idle', data: null, error: null })
      const [workspace, setWorkspace] = useState(readWorkspaceState)
      const [pathDialog, setPathDialog] = useState(false)
      // 批量（#4）
      const [selectMode, setSelectMode] = useState(false)
      const [picked, setPicked] = useState({})
      const [batchBusy, setBatchBusy] = useState('')
      const [batchConfirm, setBatchConfirm] = useState(false)
      const [toasts, setToasts] = useState([])
      const mounted = useRef(true)
      const toastSeq = useRef(0)
      const toastTimers = useRef([])
      const searchRef = useRef(null)
      const rowRefs = useRef({})
      const orderedKeys = useRef([])
      const wd = workspace.current
      /** 所有请求都带上所选工作区；空串 = 跟随当前会话（Host 的 defaultCwd）。 */
      const cwdParams = useCallback(function () { return wd ? { cwd: wd } : {} }, [wd])
      useEffect(function () {
        mounted.current = true
        return function () {
          mounted.current = false
          toastTimers.current.forEach(function (timer) { clearTimeout(timer) })
          toastTimers.current = []
        }
      }, [])
      function notify(spec) {
        toastSeq.current += 1
        const item = Object.assign({ id: toastSeq.current, tone: 'info' }, spec)
        // 最多同时留 3 条，避免连续操作把屏幕堆满。
        setToasts(function (list) { return list.slice(-2).concat([item]) })
        const timer = setTimeout(function () {
          toastTimers.current = toastTimers.current.filter(function (entry) { return entry !== timer })
          setToasts(function (list) {
            return list.filter(function (entry) { return entry.id !== item.id })
          })
        }, 3500)
        toastTimers.current.push(timer)
      }
      const loadOverview = useCallback(function (blocking) {
        if (blocking) {
          setOverview(function (previous) { return { phase: 'loading', data: previous.data, error: null } })
        } else {
          setRefreshBusy(true)
        }
        return apiRequest(withQuery('/overview', cwdParams()), { timeoutMs: 20000 })
          .then(function (raw) {
            if (!mounted.current) return null
            const data = normalizeOverview(raw)
            setOverview({ phase: 'ready', data: data, error: null })
            setLastError(null)
            return data
          })
          .catch(function (error) {
            if (!mounted.current) return null
            // 保留上次成功数据：失败只加顶部错误条，不清空列表（契约 §5）。
            setOverview(function (previous) {
              return { phase: previous.data ? 'ready' : 'error', data: previous.data, error: error }
            })
            setLastError(error)
            setErrorDismissed(false)
            return null
          })
          .then(function (value) {
            if (mounted.current) setRefreshBusy(false)
            return value
          })
      }, [cwdParams])
      /**
       * 调用账本：懒加载（Host 要读会话历史），失败只降级为「不显示次数」，
       * 绝不把技能列表带崩。
       */
      const loadUsage = useCallback(function () {
        setUsage(function (previous) { return { phase: 'loading', data: previous.data, error: null } })
        return apiRequest('/usage', { timeoutMs: 30000 })
          .then(function (raw) {
            if (!mounted.current) return null
            const data = normalizeUsage(raw)
            setUsage({ phase: 'ready', data: data, error: null })
            return data
          })
          .catch(function (error) {
            if (!mounted.current) return null
            setUsage(function (previous) { return { phase: previous.data ? 'ready' : 'error', data: previous.data, error: error } })
            return null
          })
      }, [])
      const marketQueryRef = useRef('')
      const loadMarket = useCallback(function (query) {
        // 不传 query = 沿用上次搜索词（安装后刷新、切标签都保持当前搜索结果）。
        const next = typeof query === 'string' ? query : marketQueryRef.current
        marketQueryRef.current = next
        setMarket(function (previous) { return { phase: 'loading', data: previous.data, error: null } })
        return apiRequest(withQuery('/market', { limit: 500, query: next, ...cwdParams() }), { timeoutMs: 30000 })
          .then(function (raw) {
            if (!mounted.current) return null
            const data = normalizeMarket(raw)
            setMarket({ phase: 'ready', data: data, error: null })
            return data
          })
          .catch(function (error) {
            if (!mounted.current) return null
            setMarket(function (previous) {
              return { phase: previous.data ? 'ready' : 'error', data: previous.data, error: error }
            })
            return null
          })
      }, [cwdParams])
      // 切工作区 = 重载：overview/market 都按新 cwd 重新解析项目级技能根。
      useEffect(function () {
        setMarket(function (previous) { return { phase: 'idle', data: null, error: null } })
        setPicked({})
      }, [wd])
      useEffect(function () { void loadOverview(true) }, [loadOverview])
      // 账本按需加载：本地标签且概览就绪时请求一次。失败停在 error，由「刷新」重试——
      // 把 error 也放进触发条件会让失败的接口无限重试。
      useEffect(function () {
        if (tab !== 'local') return undefined
        if (overview.phase !== 'ready') return undefined
        if (usage.phase !== 'idle') return undefined
        void loadUsage()
        return undefined
      }, [tab, overview.phase, usage.phase, loadUsage])
      // 市场按需加载：只有切到市场标签时才请求，避免每次进设置页都扫一遍市场目录。
      useEffect(function () {
        if (tab === 'market' && market.phase === 'idle') void loadMarket()
      }, [tab, market.phase, loadMarket])
      // 搜索防抖 150ms（ui-spec §3.1）。
      useEffect(function () {
        const next = queryInput.trim()
        if (next === query) return undefined
        const timer = setTimeout(function () { setQuery(next) }, 150)
        return function () { clearTimeout(timer) }
      }, [queryInput, query])
      // '/' 聚焦搜索（输入态下不抢键）。
      useEffect(function () {
        if (typeof document === 'undefined') return undefined
        function onKeyDown(event) {
          if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
          const target = event.target
          const tag = target && target.tagName ? String(target.tagName).toLowerCase() : ''
          if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return
          if (!searchRef.current) return
          event.preventDefault()
          searchRef.current.focus()
        }
        document.addEventListener('keydown', onKeyDown)
        return function () { document.removeEventListener('keydown', onKeyDown) }
      }, [])
      const data = overview.data
      const roots = data ? data.roots : []
      const skills = data ? data.skills : []
      const counts = data ? data.counts : { total: 0, enabled: 0, disabled: 0, invalid: 0, shadowed: 0, shadowedByPlugin: 0 }
      const rootKindById = useMemo(function () {
        const map = {}
        roots.forEach(function (root) { map[root.id] = root.kind })
        return map
      }, [roots])
      // 账本索引：按技能名查（宿主按 name 建索引，同名条目共享同一份调用记录）。
      const usageAvailable = !!(usage.data && usage.data.available)
      const usageIndex = useMemo(function () {
        const map = {}
        if (usage.data) {
          usage.data.list.forEach(function (row) { if (map[row.name] === undefined) map[row.name] = row })
        }
        return map
      }, [usage.data])
      const visibleSkills = useMemo(function () {
        const needle = query.trim().toLowerCase()
        return skills.filter(function (skill) {
          if (scope !== 'all') {
            const kind = rootKindById[skill.rootId] || ''
            if (kind !== scope) return false
          }
          if (status === 'shadowed') {
            if (!skill.shadowed) return false
          } else if (status === 'unused') {
            // 只统计得到的条目才算「从未使用」；账本不可用时该筛选退化为不过滤。
            if (usageAvailable && usageIndex[skill.name] !== undefined) return false
          } else if (status !== 'all' && skill.state !== status) {
            return false
          }
          if (!needle) return true
          return skill.name.toLowerCase().indexOf(needle) >= 0 ||
            skill.description.toLowerCase().indexOf(needle) >= 0 ||
            (skill.whenToUse || '').toLowerCase().indexOf(needle) >= 0 ||
            skill.dirName.toLowerCase().indexOf(needle) >= 0
        })
      }, [skills, scope, status, query, rootKindById, usageAvailable, usageIndex])
      // 排序（#2）：默认按名称；按调用次数/最后使用把「死技能」顶到最前面。
      const sortSkills = useMemo(function () {
        if (!usageAvailable || sort === 'name') {
          return function (a, b) { return a.name.localeCompare(b.name) }
        }
        if (sort === 'usage') {
          return function (a, b) {
            const left = usageIndex[a.name]
            const right = usageIndex[b.name]
            const leftCount = left ? left.d90 : -1
            const rightCount = right ? right.d90 : -1
            return leftCount - rightCount || a.name.localeCompare(b.name)
          }
        }
        return function (a, b) {
          const left = usageIndex[a.name]
          const right = usageIndex[b.name]
          const leftAt = left ? left.lastUsedAt : 0
          const rightAt = right ? right.lastUsedAt : 0
          return leftAt - rightAt || a.name.localeCompare(b.name)
        }
      }, [sort, usageAvailable, usageIndex])
      // 分组顺序：按根（rank 升序）→ 已停用 → 异常（异常永远最后，先看到问题）。
      const groups = useMemo(function () {
        const byRoot = {}
        const disabled = []
        const invalid = []
        visibleSkills.forEach(function (skill) {
          if (skill.state === 'invalid') invalid.push(skill)
          else if (skill.state === 'disabled') disabled.push(skill)
          else {
            if (!byRoot[skill.rootId]) byRoot[skill.rootId] = []
            byRoot[skill.rootId].push(skill)
          }
        })
        const sortByName = sortSkills
        const out = []
        roots.forEach(function (root) {
          const list = byRoot[root.id]
          if (!list || !list.length) return
          out.push({
            id: 'root:' + root.id, kind: 'root', rootId: root.id,
            title: rootLabel(t, root.kind, root.label),
            subtitle: root.path, skills: list.slice().sort(sortByName),
          })
        })
        // overview 里可能没有根的记录（Host 兜底），这些技能仍然要显示。
        Object.keys(byRoot).forEach(function (rootId) {
          const known = roots.some(function (root) { return root.id === rootId })
          if (known) return
          const list = byRoot[rootId]
          out.push({
            id: 'root:' + rootId, kind: 'root', rootId: rootId,
            title: rootLabel(t, list[0].rootKind, list[0].rootLabel || rootId), subtitle: list[0].rootPath,
            skills: list.slice().sort(sortByName),
          })
        })
        if (disabled.length) {
          out.push({
            id: 'disabled', kind: 'disabled', title: t('group.disabledTitle'),
            subtitle: t('group.disabledHint'), skills: disabled.slice().sort(sortByName),
          })
        }
        if (invalid.length) {
          out.push({
            id: 'invalid', kind: 'invalid', title: t('group.invalidTitle'),
            subtitle: '', skills: invalid.slice().sort(sortByName),
          })
        }
        return out
      }, [visibleSkills, roots, t, sortSkills])
      orderedKeys.current = []
      groups.forEach(function (group) {
        if (collapsed[group.id]) return
        group.skills.forEach(function (skill) { orderedKeys.current.push(skill.key) })
      })
      function registerRow(key, node) {
        if (node) rowRefs.current[key] = node
        else delete rowRefs.current[key]
      }
      function moveRow(key, delta) {
        const list = orderedKeys.current
        const index = list.indexOf(key)
        if (index < 0) return
        const node = rowRefs.current[list[index + delta]]
        if (node && typeof node.focus === 'function') node.focus()
      }
      /** 局部更新一条技能并同步 counts（计数必须与列表同源，避免两份事实）。 */
      function patchSkill(key, patch) {
        setOverview(function (previous) {
          if (!previous.data) return previous
          const nextSkills = previous.data.skills.map(function (skill) {
            return skill.key === key ? Object.assign({}, skill, patch) : skill
          })
          const nextCounts = { total: nextSkills.length, enabled: 0, disabled: 0, invalid: 0, shadowed: 0, shadowedByPlugin: 0 }
          nextSkills.forEach(function (skill) {
            if (skill.state === 'invalid') nextCounts.invalid += 1
            else if (skill.state === 'disabled') nextCounts.disabled += 1
            else nextCounts.enabled += 1
            if (skill.shadowed) nextCounts.shadowed += 1
            if (skill.shadowedByPlugin) nextCounts.shadowedByPlugin += 1
          })
          return {
            phase: previous.phase, error: previous.error,
            data: Object.assign({}, previous.data, { skills: nextSkills, counts: nextCounts }),
          }
        })
      }
      function patchSkillState(key, nextState) {
        patchSkill(key, { state: nextState })
      }
      async function onToggle(skill, next) {
        if (togglingKey) return
        const previousState = skill.state
        setTogglingKey(skill.key)
        // 乐观更新：失败时用 previousState 精确回滚，不整表重拉。
        patchSkillState(skill.key, next ? 'enabled' : 'disabled')
        try {
          await apiRequest('/skill/toggle', {
            method: 'POST', timeoutMs: 20000,
            body: { rootId: skill.rootId, dirName: skill.dirName, kind: skill.kind, enabled: next, ...cwdParams() },
          })
          notify({ tone: 'success', key: next ? 'toast.enabled' : 'toast.disabled', vars: { name: skill.name } })
        } catch (error) {
          patchSkillState(skill.key, previousState)
          notify({ tone: 'error', error: error })
        } finally {
          setTogglingKey('')
        }
      }
      /**
       * 三态调用策略（#1）：只改 frontmatter 的两个键，不移动目录。
       *
       * 带 overview 里的 hash 做乐观并发：磁盘被别人改过就 409，不覆盖；
       * 成功后只回写这一条的 invocation 与 hash，不整表重拉。
       */
      async function onInvocation(skill, mode) {
        const next = INVOCATION_MODES[mode]
        if (!next) return
        if (skill.invocation.model === next.model && skill.invocation.user === next.user) return
        try {
          const result = await apiRequest('/skill/invocation', {
            method: 'POST', timeoutMs: 20000,
            body: {
              rootId: skill.rootId, dirName: skill.dirName, kind: skill.kind,
              state: skill.state === 'disabled' ? 'disabled' : 'enabled',
              hash: skill.hash, model: next.model, user: next.user,
              ...cwdParams(),
            },
          })
          const invocation = isObj(result && result.invocation) ? result.invocation : next
          patchSkill(skill.key, {
            invocation: { model: invocation.model !== false, user: invocation.user !== false },
            hash: str(result && result.hash) || skill.hash,
          })
          notify({ tone: 'success', key: 'inv.updated', vars: { name: skill.name } })
        } catch (error) {
          notify({ tone: 'error', error: error })
        }
      }
      function openRoot(rootId) {
        if (!rootId) return
        setOpenBusy(true)
        apiRequest('/open', { method: 'POST', timeoutMs: 15000, body: { rootId: rootId, ...cwdParams() } })
          .then(function () { notify({ tone: 'success', key: 'toast.opened' }) })
          .catch(function (error) { notify({ tone: 'error', error: error }) })
          .then(function () { if (mounted.current) setOpenBusy(false) })
      }
      async function install(repoName, skill, overwrite) {
        const key = repoName + '/' + skill.folder
        setInstalling(function (previous) { return Object.assign({}, previous, { [key]: true }) })
        try {
          const result = await apiRequest('/market/install', {
            method: 'POST', timeoutMs: 60000,
            body: {
              repo: repoName, folder: skill.folder,
              rootId: computeDefaultRootId(roots) || 'user-dsh',
              // 更新/重装走 overwrite：旧版本进 _trash/，绝不原地覆盖。
              overwrite: overwrite === true,
              ...cwdParams(),
            },
          })
          notify({ tone: 'success', key: 'toast.installed', vars: { name: str(result && result.name) || skill.name } })
          void loadMarket()
          void loadOverview(false)
        } catch (error) {
          notify({ tone: 'error', error: error })
        } finally {
          setInstalling(function (previous) {
            const next = Object.assign({}, previous)
            delete next[key]
            return next
          })
        }
      }
      /* ---------------- 批量（#4）：勾选 → 一次写多条，逐条返回 ---------------- */
      const selectableSkills = useMemo(function () {
        return visibleSkills.filter(function (skill) { return skill.writable && skill.state !== 'invalid' })
      }, [visibleSkills])
      const pickedSkills = useMemo(function () {
        return skills.filter(function (skill) { return picked[skill.key] === true })
      }, [skills, picked])
      function togglePick(skill) {
        if (!skill.writable || skill.state === 'invalid') return
        setPicked(function (previous) {
          const next = Object.assign({}, previous)
          if (next[skill.key]) delete next[skill.key]
          else next[skill.key] = true
          return next
        })
      }
      function exitSelect() {
        setSelectMode(false)
        setPicked({})
        setBatchConfirm(false)
      }
      async function runBatch(action) {
        if (batchBusy !== '') return
        const candidates = pickedSkills.filter(function (skill) { return skill.writable && skill.state !== 'invalid' })
        // 已经在目标状态的条目不要再发：Host 的 setSkillEnabled 是「从对侧搬过来」，
        // 对本来就在目标状态的条目返回 not-found，逐条报错只会制造噪音。
        const items = (action === 'delete'
          ? candidates
          : candidates.filter(function (skill) {
              return action === 'enable' ? skill.state !== 'enabled' : skill.state !== 'disabled'
            })).map(function (skill) { return { rootId: skill.rootId, dirName: skill.dirName, kind: skill.kind } })
        if (items.length === 0) {
          notify({ tone: 'info', key: 'batch.empty' })
          return
        }
        setBatchBusy(action)
        try {
          const result = await apiRequest('/skill/batch', {
            method: 'POST', timeoutMs: 120000,
            body: { action: action, items: items, ...cwdParams() },
          })
          const counts = isObj(result && result.counts) ? result.counts : { ok: items.length, failed: 0 }
          if (num(counts.failed, 0) > 0) {
            notify({ tone: 'error', key: 'batch.doneFailed', vars: { ok: num(counts.ok, 0), failed: num(counts.failed, 0) } })
          } else {
            notify({ tone: 'success', key: 'batch.done', vars: { ok: num(counts.ok, 0) } })
          }
          setPicked({})
          setBatchConfirm(false)
          await loadOverview(false)
        } catch (error) {
          notify({ tone: 'error', error: error })
        } finally {
          setBatchBusy('')
        }
      }
      /* ---------------- 工作区（#5） ---------------- */
      function applyWorkspace(path) {
        const next = rememberWorkspace(workspace, path)
        setWorkspace(next)
        writeWorkspaceState(next)
      }
      function onCreated(rawSkill) {
        // 用当前 roots 做映射：返回的 Skill 若缺 writable/rootLabel，抽屉会误判只读。
        const rootById = {}
        roots.forEach(function (root) { rootById[root.id] = root })
        const created = normalizeSkill(rawSkill, rootById)
        setCreating(false)
        void loadOverview(false).then(function () {
          if (!mounted.current) return
          if (created) {
            setSelected(created)
            notify({ tone: 'success', key: 'toast.created', vars: { name: created.name } })
          }
        })
      }
      let targetRoot = null
      const defaultRootId = computeDefaultRootId(roots)
      roots.forEach(function (root) { if (root.id === defaultRootId) targetRoot = root })
      // 「从未使用」只在账本可用时出现——不可用时它会把所有技能都标成从未使用。
      const statusItems = STATUS_VALUES
        .filter(function (value) { return value !== 'unused' || usageAvailable })
        .map(function (value) {
          return { value: value, label: t('status.' + value) }
        })
      const sortItems = SORT_VALUES.map(function (value) {
        return { value: value, label: t('sort.' + value) }
      })
      // 工作区菜单：跟随当前会话 + 最近用过的目录 + 手输。当前目录即使不在 recent 里
      // 也必须占一项 —— 否则触发器找不到匹配项，标签会退回「当前会话」而请求仍带着旧 cwd。
      const workspaceItems = [{ value: '', label: t('ws.current') }]
        .concat(workspace.recent.map(function (path) {
          return { value: path, label: shortPath(path) || path }
        }))
        .concat(wd && workspace.recent.indexOf(wd) < 0 ? [{ value: wd, label: shortPath(wd) || wd }] : [])
        .concat([{ value: '__custom__', label: t('ws.custom') }])
      const effectiveCwd = wd || (data ? data.cwd : '')
      const workspaceLabel = wd ? (shortPath(wd) || wd) : t('ws.current')
      const hasFilters = scope !== 'all' || status !== 'all' || query.trim().length > 0
      const showErrorBanner = !!lastError && !errorDismissed
      const firstLoad = overview.phase === 'loading' && !data
      const hardError = overview.phase === 'error' && !data
      const canCreate = !!data && roots.filter(function (root) { return root.writable }).length > 0
      const header = h('header', { className: 'sm-head', key: 'head' },
        h('div', { className: 'sm-head-text' },
          h('h1', { className: 'sm-title' }, t('title')),
          h('p', { className: 'sm-sub' }, t('subtitle'))),
        h('div', { className: 'sm-head-actions' },
          h(Btn, {
            icon: IconRefresh, busy: refreshBusy, 'aria-label': t('a11y.refresh'),
            onClick: function () {
              void loadOverview(false)
              // 账本有 60s 服务端缓存，刷新时一起重取即可（不会重复扫历史）。
              if (usage.phase !== 'loading') void loadUsage()
              if (tab === 'market') void loadMarket()
            },
          }, refreshBusy ? t('head.refreshing') : t('head.refresh')),
          h(Btn, {
            icon: IconPlus, disabled: !canCreate, 'aria-label': t('a11y.create'),
            onClick: function () { setCreating(true) },
          }, t('head.create')),
          h(Btn, {
            icon: IconImport, disabled: !canCreate, 'aria-label': t('import.title'),
            onClick: function () { setImporting(true) },
          }, t('import.title')),
          h(Btn, {
            icon: IconFolder, busy: openBusy, title: t('head.openDirTitle'), disabled: !data,
            onClick: function () { openRoot(openRootId(roots, scope)) },
          }, openBusy ? t('head.opening') : t('head.openDir'))))
      const tabs = h('div', { className: 'sm-tabs', role: 'tablist', 'aria-label': t('title'), key: 'tabs' },
        ['local', 'market'].map(function (value) {
          const active = tab === value
          return h('button', {
            key: value, type: 'button', role: 'tab',
            'aria-selected': active ? 'true' : 'false',
            className: cx('sm-tab', active && 'sm-tab-active'),
            onClick: function () { setTab(value) },
          }, t('tabs.' + value))
        }))
      let content = null
      if (tab === 'market') {
        content = h(MarketView, {
          key: 'market', t: t, market: market, installing: installing, targetRoot: targetRoot,
          onReload: loadMarket, onInstall: install, onSearch: loadMarket,
          initialQuery: marketQueryRef.current,
          onOpenTarget: function () { openRoot(computeDefaultRootId(roots)) },
        })
      } else {
        const ov = h('div', { className: 'sm-ov', key: 'ov' },
          h('span', { className: 'sm-ov-item' }, h('span', { className: 'sm-ov-dot' }), t('ov.total', { count: counts.total })),
          h('span', { className: 'sm-ov-item' }, h('span', { className: 'sm-ov-dot sm-ov-dot-ok' }), t('ov.enabled', { count: counts.enabled })),
          h('span', { className: 'sm-ov-item' }, h('span', { className: 'sm-ov-dot sm-ov-dot-idle' }), t('ov.disabled', { count: counts.disabled })),
          h('span', { className: 'sm-ov-item' }, h('span', { className: 'sm-ov-dot sm-ov-dot-err' }), t('ov.invalid', { count: counts.invalid })),
          h('span', { className: 'sm-ov-item sm-ov-extra' },
            t('ov.sources', { count: roots.filter(function (root) { return (root.skillCount || 0) > 0 }).length })),
          data && data.market
            ? h('span', { className: 'sm-ov-item sm-ov-extra' },
                t('ov.market', { repos: data.market.repos, skills: data.market.skills }))
            : null,
          // 账本状态如实显示：能统计就报会话数，不能统计就说清原因（而不是静默少一列）。
          usageAvailable
            ? h('span', {
                className: 'sm-ov-item sm-ov-extra', 'aria-label': t('usage.label'),
                title: usage.data.sessions.truncated
                  ? t('usage.truncated', { scanned: usage.data.sessions.scanned })
                  : t('usage.label'),
              }, t('usage.hint', { scanned: usage.data.sessions.scanned }))
            : (usage.phase === 'ready'
                ? h('span', { className: 'sm-ov-item sm-ov-extra', title: t('usage.unavailable') },
                    t('usage.label') + ' —')
                : null))
        const toolbar = h('div', { className: 'sm-toolbar', key: 'toolbar' },
          h(Segmented, {
            value: scope, label: t('scope.label'),
            items: [
              { value: 'all', label: t('scope.all') },
              { value: 'user', label: t('scope.user') },
              { value: 'project', label: t('scope.project') },
              { value: 'bundled', label: t('scope.bundled') },
            ],
            onChange: setScope,
          }),
          h(SearchField, {
            value: queryInput, inputRef: searchRef, placeholder: t('search.placeholder'),
            label: t('a11y.search'), clearLabel: t('search.clear'),
            onChange: setQueryInput, onClearFocus: true,
          }),
          h(StatusMenu, { value: status, items: statusItems, label: t('status.label'), onChange: setStatus }),
          // 排序只在账本可用时有意义；没有次数就只剩名称一种顺序。
          usageAvailable
            ? h(StatusMenu, {
                value: sort, items: sortItems, label: t('sort.label'), icon: IconSort, onChange: setSort,
              })
            : null,
          h(StatusMenu, {
            value: wd, items: workspaceItems, label: t('ws.label'), icon: IconFolder,
            title: wd ? t('ws.title', { path: wd }) : t('ws.current'),
            onChange: function (value) {
              if (value === '__custom__') { setPathDialog(true); return }
              applyWorkspace(value)
            },
          }),
          h(Btn, {
            size: 'sm', variant: selectMode ? 'primary' : 'ghost', disabled: !data,
            'aria-pressed': selectMode ? 'true' : 'false',
            onClick: function () { selectMode ? exitSelect() : setSelectMode(true) },
          }, selectMode ? t('batch.exit') : t('batch.enter')))
        const banner = showErrorBanner
          ? h('div', { className: 'sm-banner', key: 'banner', role: 'alert' },
              h(IconWarn, { size: 14 }),
              h('span', { className: 'sm-banner-text' }, describeError(t, lastError)),
              h(IconBtn, {
                icon: IconClose, label: t('err.dismiss'), size: 13,
                onClick: function () { setErrorDismissed(true) },
              }))
          : null
        // 插件同名说明条：只在有冲突时出现，不需要关闭（数字随列表刷新自然消失）。
        const pluginBanner = counts.shadowedByPlugin > 0
          ? h('div', { className: 'sm-banner sm-banner-warn', key: 'plugin-shadow' },
              h(IconWarn, { size: 14 }),
              h('span', { className: 'sm-banner-text' }, t('pluginShadow.banner', { count: counts.shadowedByPlugin })))
          : null
        let list = null
        if (firstLoad) {
          list = h(Skeleton, { key: 'skeleton', label: t('loading.skills') })
        } else if (hardError) {
          list = h(EmptyState, {
            key: 'error', error: true, icon: IconWarn, title: t('err.title'),
            desc: describeError(t, overview.error),
            actions: h(Btn, { icon: IconRefresh, onClick: function () { void loadOverview(true) } }, t('err.retry')),
          })
        } else if (!data) {
          list = null
        } else if (groups.length === 0) {
          list = hasFilters
            ? h(EmptyState, {
                key: 'empty-filtered', icon: IconSearch,
                title: t('emptyFiltered.title'), desc: t('emptyFiltered.desc'),
                actions: h(Btn, {
                  onClick: function () {
                    setScope('all'); setStatus('all'); setQueryInput(''); setQuery('')
                  },
                }, t('act.clear')),
              })
            : h(EmptyState, {
                key: 'empty', icon: IconSparkle, title: t('empty.title'), desc: t('empty.desc'),
                actions: h(Btn, {
                  variant: 'primary', icon: IconPlus,
                  onClick: function () { setCreating(true) },
                }, t('empty.create')),
              })
        } else {
          list = h('div', { className: 'sm-list', key: 'list' },
            groups.map(function (group) {
              const isCollapsed = collapsed[group.id] === true
              return h('section', { className: 'sm-group', key: group.id },
                h(GroupHeader, {
                  t: t, title: group.title, subtitle: group.subtitle,
                  count: group.skills.length, collapsed: isCollapsed,
                  onToggle: function () {
                    setCollapsed(function (previous) {
                      return Object.assign({}, previous, { [group.id]: !isCollapsed })
                    })
                  },
                  onOpenRoot: group.rootId ? function () { openRoot(group.rootId) } : null,
                }),
                isCollapsed
                  ? null
                  : h('div', { className: 'sm-group-body' },
                      group.skills.map(function (skill) {
                        return h(SkillRow, {
                          key: skill.key, t: t, skill: skill,
                          busy: togglingKey === skill.key,
                          showRoot: group.kind !== 'root',
                          registerRow: registerRow, onMove: moveRow,
                          onOpen: function (target) { setSelected(target) },
                          onToggle: onToggle,
                          onInvocation: onInvocation,
                          usage: usageIndex[skill.name],
                          usageAvailable: usageAvailable,
                          selectMode: selectMode,
                          selected: picked[skill.key] === true,
                          onSelect: togglePick,
                        })
                      })))
            }))
        }
        const batchBar = selectMode
          ? h(BatchBar, {
              key: 'batchbar', t: t, count: pickedSkills.length,
              busy: batchBusy !== '', busyAction: batchBusy,
              onSelectAll: function () {
                setPicked(function () {
                  const next = {}
                  selectableSkills.forEach(function (skill) { next[skill.key] = true })
                  return next
                })
              },
              onClear: function () { setPicked({}) },
              onRun: function (action) {
                if (action === 'delete') { setBatchConfirm(true); return }
                void runBatch(action)
              },
              onExit: exitSelect,
            })
          : null
        content = [ov, toolbar, banner, pluginBanner, list, batchBar]
      }
      return h('div', { className: 'sm-page' },
        header,
        tabs,
        content,
        selected
          ? h(DetailDrawer, {
              key: 'drawer-' + selected.key, t: t, skill: selected, notify: notify, cwd: wd,
              usage: usageIndex[selected.name], usageAvailable: usageAvailable,
              onClose: function () { setSelected(null) },
              onChanged: function () { void loadOverview(false) },
            })
          : null,
        creating
          ? h(CreateDialog, {
              t: t, roots: roots, defaultRootId: defaultRootId, cwd: wd,
              onClose: function () { setCreating(false) },
              onCreated: onCreated,
            })
          : null,
        importing
          ? h(ImportDialog, {
              t: t, roots: roots, defaultRootId: defaultRootId, cwd: wd,
              onClose: function () { setImporting(false) },
              onImported: function (count, skipped) {
                if (count > 0 && skipped > 0) {
                  notify({ tone: 'success', key: 'import.donePartial', vars: { count: count, skipped: skipped } })
                } else if (count > 0) {
                  notify({ tone: 'success', key: 'import.done', vars: { count: count } })
                } else {
                  notify({ tone: 'error', key: 'import.noneImported' })
                }
                void loadOverview(false)
              },
            })
          : null,
        pathDialog
          ? h(PathDialog, {
              t: t, initial: wd,
              onClose: function () { setPathDialog(false) },
              onApply: applyWorkspace,
            })
          : null,
        batchConfirm
          ? h(ConfirmDialog, {
              t: t,
              title: t('batch.confirmTitle', { count: pickedSkills.length }),
              body: t('batch.confirmBody'),
              confirmLabel: t('batch.delete'),
              busy: batchBusy === 'delete',
              onCancel: function () { setBatchConfirm(false) },
              onConfirm: function () { void runBatch('delete') },
            })
          : null,
        h(Toasts, {
          t: t, toasts: toasts,
          onDismiss: function (id) {
            setToasts(function (list) {
              return list.filter(function (entry) { return entry.id !== id })
            })
          },
        }))
    }

    /**
     * 主面板载体：侧边栏「技能管理」入口对应的 `main` 槽。
     *
     * 宿主只把本组件铺满中栏（flex 列 + overflow:hidden），滚动、内容列宽与
     * 顶部留白都由占位方自己负责 —— 这里按 shipped 面板（插件 / 自动化任务）的
     * 口径补齐，然后把同一个 `Page` 放进去，避免两套 UI 分叉。
     */
    function PanelPage(props) {
      const t0 = typeof props.t === 'function' ? props.t : fallbackT
      return h('section', {
        className: 'sm-panel',
        'aria-label': t0('panel.a11y'),
        'data-testid': 'skill-manager-panel',
      },
        h('div', { className: 'sm-panel-scroll' },
          h('div', { className: 'sm-panel-content' },
            h(Page, props))))
    }

    /* ------------------------------------------------------------------ *
     * 样式：只使用 ui-spec §1.1 列出的 token，其它层级用 color-mix 派生。
     * 阴影与遮罩允许 #000 透明叠加（ui-spec §3.4 明示），不写死明暗两套色。
     * ------------------------------------------------------------------ */
    const CSS = `
/* 明暗自适应的抬升面：实测 light 下 layer-1/2 与 bg-base 同为 #fff、dark 下 bg-overlay 是 #61666b，
   直接用会让浅色无层级、深色浮层正文不可读；这里仍只做 token + color-mix 派生，不写明暗分支。 */
.sm-page{display:flex;flex-direction:column;gap:12px;max-width:1040px;margin:0 auto;padding:16px 0 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;--sm-surface-1:color-mix(in oklab,var(--dsw-alias-label-primary) 3%,var(--dsw-alias-bg-base));--sm-surface-2:color-mix(in oklab,var(--dsw-alias-label-primary) 6%,var(--dsw-alias-bg-base))}.sm-page *{box-sizing:border-box}
.sm-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap}.sm-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.sm-title{margin:0;font-size:16px;line-height:24px;font-weight:600}.sm-sub{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.sm-head-actions{display:flex;align-items:center;gap:8px;flex:none}.sm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;font-weight:500;cursor:pointer;white-space:nowrap;max-width:100%}
.sm-btn:hover:not(:disabled){background:color-mix(in oklab,var(--dsw-alias-label-primary) 6%,transparent)}.sm-btn:disabled{opacity:.45;cursor:default}
.sm-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base)}.sm-btn-primary:hover:not(:disabled){background:color-mix(in oklab,var(--dsw-alias-brand-primary) 88%,var(--dsw-alias-label-secondary))}
.sm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in oklab,var(--dsw-alias-state-error-primary) 45%,transparent)}.sm-btn-danger:hover:not(:disabled){background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 10%,transparent)}
.sm-btn-ghost{border-color:transparent}.sm-btn-sm{height:26px;padding:0 10px;font-size:11px}
.sm-btn-label{min-width:0;overflow:hidden;text-overflow:ellipsis}.sm-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;flex:none;border-radius:8px;border:.5px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sm-icon-btn:hover:not(:disabled){background:color-mix(in oklab,var(--dsw-alias-label-primary) 6%,transparent);color:var(--dsw-alias-label-primary)}.sm-icon-btn:disabled{opacity:.4;cursor:default}
.sm-btn:focus-visible,.sm-icon-btn:focus-visible,.sm-seg-item:focus-visible,.sm-menu-trigger:focus-visible,.sm-menu-item:focus-visible,.sm-tab:focus-visible,.sm-group-toggle:focus-visible,.sm-row-main:focus-visible,.sm-path:focus-visible,.sm-switch:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in oklab,var(--dsw-alias-brand-primary) 40%,transparent)}.sm-spinner{display:inline-block;width:12px;height:12px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sm-spin .8s linear infinite;flex:none}
.sm-tabs{display:flex;align-items:flex-end;gap:20px;border-bottom:.5px solid var(--dsw-alias-border-l1)}.sm-tab{appearance:none;border:none;background:transparent;padding:0 0 8px;margin-bottom:-.5px;font:inherit;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;border-bottom:2px solid transparent;border-radius:4px 4px 0 0}
.sm-tab:hover{color:var(--dsw-alias-label-primary)}.sm-tab-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:500}
.sm-ov{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:8px 10px;background:var(--dsw-specific-sidebar-fill);border-top:.5px solid var(--dsw-alias-border-l1);border-bottom:.5px solid var(--dsw-alias-border-l1);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}.sm-ov-item{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.sm-ov-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-secondary);flex:none}.sm-ov-dot-ok{background:var(--dsw-alias-state-success-primary)}
.sm-ov-dot-idle{background:var(--dsw-alias-state-idle-primary)}.sm-ov-dot-err{background:var(--dsw-alias-state-error-primary)}
.sm-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.sm-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;background:color-mix(in oklab,var(--dsw-alias-label-primary) 5%,transparent);flex:none}
.sm-seg-item{appearance:none;border:.5px solid transparent;background:transparent;border-radius:6px;padding:3px 10px;font:inherit;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}.sm-seg-item:hover:not(.sm-seg-item-active){background:color-mix(in oklab,var(--dsw-alias-label-primary) 6%,transparent)}
.sm-seg-item-active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-weight:500}.sm-search{display:flex;align-items:center;gap:6px;height:30px;padding:0 8px;min-width:200px;flex:1 1 220px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--sm-surface-1);color:var(--dsw-alias-label-secondary)}
.sm-search:focus-within{border-color:color-mix(in oklab,var(--dsw-alias-brand-primary) 55%,transparent);box-shadow:0 0 0 2px color-mix(in oklab,var(--dsw-alias-brand-primary) 22%,transparent)}.sm-search-icon{flex:none}
.sm-search-input{flex:1;min-width:0;height:100%;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px}.sm-search-input::placeholder{color:color-mix(in oklab,var(--dsw-alias-label-secondary) 75%,transparent)}
.sm-search-input::-webkit-search-cancel-button{display:none}.sm-search-clear{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;flex:none;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sm-search-clear:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 10%,transparent);color:var(--dsw-alias-label-primary)}.sm-menu-wrap{position:relative;flex:none}
.sm-menu-trigger{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;cursor:pointer;white-space:nowrap}.sm-menu-trigger:hover,.sm-menu-trigger-open{background:color-mix(in oklab,var(--dsw-alias-label-primary) 6%,transparent)}
.sm-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:20;min-width:160px;padding:4px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--sm-surface-2);box-shadow:0 12px 32px color-mix(in oklab,#000 18%,transparent);display:flex;flex-direction:column;gap:2px}.sm-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:5px 8px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}
.sm-menu-item:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 8%,transparent)}.sm-menu-item-active{font-weight:500}
.sm-menu-check{display:inline-flex;width:14px;flex:none;color:var(--dsw-alias-brand-primary)}.sm-menu-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-banner{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;border:.5px solid color-mix(in oklab,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.sm-banner-text{flex:1;min-width:0;overflow-wrap:anywhere}
.sm-banner .sm-icon-btn{color:inherit}.sm-banner-warn{border-color:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 40%,transparent);background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 8%,transparent);color:var(--dsw-alias-state-warn-primary)}.sm-list{display:flex;flex-direction:column;gap:16px}
.sm-group{display:flex;flex-direction:column;gap:6px}.sm-group-head{display:flex;align-items:center;gap:6px;min-width:0}
.sm-group-toggle{display:flex;align-items:center;gap:6px;min-width:0;flex:1;padding:2px 0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;text-align:left;border-radius:6px}.sm-group-toggle:hover .sm-group-title{color:var(--dsw-alias-label-primary)}
.sm-group-title{font-size:12px;line-height:18px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);white-space:nowrap}.sm-group-sub{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;color:color-mix(in oklab,var(--dsw-alias-label-secondary) 80%,transparent)}
.sm-group-count{margin-left:auto;padding-left:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);flex:none}.sm-group-body{display:flex;flex-direction:column;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--sm-surface-1);overflow:hidden}
.sm-row{display:flex;align-items:center;gap:12px;padding:10px 12px}.sm-row+.sm-row,.sm-mrow+.sm-mrow{border-top:.5px solid var(--dsw-alias-border-l1)}
.sm-row:hover,.sm-mrow:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 4%,transparent)}.sm-row-invalid{background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 5%,transparent)}
.sm-glyph{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;border-radius:8px;background:color-mix(in oklab,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-label-secondary)}.sm-row-main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;padding:0;border:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:6px}
.sm-row-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}.sm-row-name{font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sm-row-desc,.sm-mrow-desc{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.sm-row-error{font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.sm-row-actions{display:flex;align-items:center;gap:10px;flex:none}.sm-row-source,.sm-row-inv{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.sm-badge{display:inline-flex;align-items:center;gap:4px;padding:0 6px;height:16px;border-radius:6px;border:.5px solid transparent;font-size:11px;line-height:14px;font-weight:500;white-space:nowrap;flex:none}.sm-badge-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.sm-badge-success{color:var(--dsw-alias-state-success-primary);background:color-mix(in oklab,var(--dsw-alias-state-success-primary) 12%,transparent)}.sm-badge-idle{color:var(--dsw-alias-label-secondary);background:color-mix(in oklab,var(--dsw-alias-state-idle-primary) 20%,transparent)}
.sm-badge-idle .sm-badge-dot{background:var(--dsw-alias-state-idle-primary)}.sm-badge-error{color:var(--dsw-alias-state-error-primary);background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 12%,transparent)}
.sm-badge-warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 14%,transparent)}.sm-badge-neutral{color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2)}
.sm-switch{position:relative;display:inline-flex;align-items:center;width:34px;height:20px;flex:none;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-state-idle-primary);cursor:pointer;transition:background-color .15s}.sm-switch-sm{width:30px;height:18px}
.sm-switch-on{background:var(--dsw-alias-brand-primary)}.sm-switch:disabled{opacity:.45;cursor:default}
.sm-switch-knob{position:absolute;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s}.sm-switch-sm .sm-switch-knob{width:14px;height:14px}
.sm-switch-on .sm-switch-knob{transform:translateX(14px)}.sm-switch-sm.sm-switch-on .sm-switch-knob{transform:translateX(12px)}
.sm-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:28px 20px;border:.5px dashed var(--dsw-alias-border-l2);border-radius:12px;text-align:center}.sm-empty-error{border-style:solid;border-color:color-mix(in oklab,var(--dsw-alias-state-error-primary) 35%,transparent)}
.sm-empty-icon{color:var(--dsw-alias-label-secondary)}.sm-empty-error .sm-empty-icon{color:var(--dsw-alias-state-error-primary)}
.sm-empty-title{font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}.sm-empty-desc{max-width:520px;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.sm-empty-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px}.sm-skeleton{display:flex;flex-direction:column;gap:8px}
.sm-skeleton-row{height:44px;border-radius:10px;background:color-mix(in oklab,var(--dsw-alias-label-primary) 7%,transparent);animation:sm-shimmer 1.6s ease-in-out infinite}.sm-skeleton-label{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.sm-mask{position:fixed;inset:0;z-index:1100;display:flex;justify-content:flex-end;background:color-mix(in oklab,#000 30%,transparent);animation:sm-fade .18s ease-out}.sm-mask-center{align-items:center;justify-content:center;padding:24px;z-index:1200}
.sm-drawer{display:flex;flex-direction:column;width:min(560px,100%);height:100%;min-height:0;background:var(--sm-surface-2);border-left:.5px solid var(--dsw-alias-border-l2);box-shadow:-18px 0 48px color-mix(in oklab,#000 18%,transparent);animation:sm-slide .18s ease-out}.sm-drawer:focus,.sm-editor:focus,.sm-input:focus{outline:none}
.sm-drawer-head{display:flex;align-items:flex-start;gap:12px;padding:16px 20px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none}.sm-drawer-head-text{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.sm-drawer-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}.sm-drawer-title{margin:0;font-size:16px;line-height:24px;font-weight:600;overflow-wrap:anywhere}
.sm-path{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;cursor:pointer;text-align:left;border-radius:4px}.sm-path:hover{color:var(--dsw-alias-label-primary);text-decoration:underline;text-underline-offset:2px}
.sm-path-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr}.sm-drawer-body{flex:1;min-height:0;overflow-y:auto;padding:4px 20px 16px;display:flex;flex-direction:column;gap:16px}
.sm-drawer-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 20px;border-top:.5px solid var(--dsw-alias-border-l1);flex:none}.sm-foot-left{display:flex;align-items:center;gap:8px}
.sm-foot-right{display:flex;align-items:center;gap:8px;margin-left:auto}.sm-section{display:flex;flex-direction:column;gap:8px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l1)}
.sm-section:first-child{padding-top:8px;border-top:none}.sm-section-title{font-size:12px;line-height:18px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary)}
.sm-meta-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 16px}.sm-meta-cell{display:flex;flex-direction:column;gap:1px;min-width:0}
.sm-meta-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}.sm-meta-value{font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.sm-inv-list{display:flex;flex-direction:column;gap:10px}.sm-inv-row{display:flex;align-items:center;gap:12px}
.sm-inv-text{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}.sm-inv-label{font-size:12.5px;line-height:19px;font-weight:500;color:var(--dsw-alias-label-primary)}
.sm-inv-hint,.sm-inv-foot{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.sm-issues{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.sm-issue{display:flex;align-items:flex-start;gap:6px;font-size:12px;line-height:18px;overflow-wrap:anywhere}.sm-issue-icon{display:inline-flex;margin-top:2px;flex:none}
.sm-issue-text{min-width:0}.sm-issue-line{margin-left:6px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-secondary)}
.sm-issue-error{color:var(--dsw-alias-state-error-primary)}.sm-issue-warn{color:var(--dsw-alias-state-warn-primary)}
.sm-issue-ok{align-items:center;gap:6px;color:var(--dsw-alias-state-success-primary)}.sm-editor-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.sm-editor-stat{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}.sm-editor-spacer{flex:1}
.sm-conflict{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;border:.5px solid color-mix(in oklab,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}.sm-conflict-text{flex:1;min-width:0;overflow-wrap:anywhere}
.sm-editor{width:100%;min-height:320px;max-height:60vh;padding:10px 12px;resize:vertical;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--sm-surface-1);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;tab-size:2}.sm-modal{display:flex;flex-direction:column;width:min(480px,100%);max-height:calc(100vh - 48px);border-radius:12px;border:.5px solid var(--dsw-alias-border-l2);background:var(--sm-surface-2);box-shadow:0 24px 64px color-mix(in oklab,#000 24%,transparent)}
.sm-modal-narrow{width:min(400px,100%)}.sm-modal-head{display:flex;align-items:center;gap:8px;padding:16px 20px 8px;flex:none}
.sm-modal-title{margin:0;flex:1;min-width:0;font-size:16px;line-height:24px;font-weight:600}.sm-modal-body{display:flex;flex-direction:column;padding:0 20px;overflow-y:auto;min-height:0}
.sm-modal-text{margin:0 0 8px;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.sm-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px 16px;flex:none}
.sm-field{display:flex;flex-direction:column;gap:4px;padding:8px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}.sm-field:last-of-type{border-bottom:none}
.sm-field-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary)}.sm-field-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.sm-field-warn{color:var(--dsw-alias-state-warn-primary)}.sm-field-error{margin:4px 0;font-size:11px;line-height:16px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.sm-input{width:100%;height:30px;padding:0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--sm-surface-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px}.sm-input:focus{border-color:color-mix(in oklab,var(--dsw-alias-brand-primary) 55%,transparent);box-shadow:0 0 0 2px color-mix(in oklab,var(--dsw-alias-brand-primary) 22%,transparent)}
.sm-input-invalid{border-color:color-mix(in oklab,var(--dsw-alias-state-error-primary) 55%,transparent)}.sm-input-warn{border-color:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 55%,transparent)}
.sm-textarea{height:auto;min-height:64px;padding:8px 10px;resize:vertical;line-height:18px}.sm-textarea-sm{min-height:52px}
.sm-mono,.sm-textarea.sm-mono{font-family:var(--ds-font-family-code,ui-monospace,monospace)}.sm-select{appearance:none;padding-right:24px;cursor:pointer}
.sm-market{display:flex;flex-direction:column;gap:12px}.sm-market-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.sm-market-summary{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.sm-market-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.sm-market-target{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,monospace);overflow-wrap:anywhere}
.sm-repo{display:flex;flex-direction:column;gap:6px}.sm-mrow{display:flex;align-items:center;gap:12px;padding:10px 12px}
.sm-mrow-main{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}.sm-mrow-title{display:flex;align-items:center;gap:6px;min-width:0}
.sm-mrow-name{font-size:14px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sm-toasts{position:fixed;right:20px;bottom:20px;z-index:1300;display:flex;flex-direction:column;gap:8px;max-width:min(420px,calc(100vw - 40px));pointer-events:none}
.sm-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2);background:var(--sm-surface-2);box-shadow:0 12px 32px color-mix(in oklab,#000 18%,transparent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);animation:sm-fade .15s ease-out}.sm-toast-icon{flex:none;margin-top:2px;color:var(--dsw-alias-label-secondary)}
.sm-toast-success .sm-toast-icon{color:var(--dsw-alias-state-success-primary)}.sm-toast-error .sm-toast-icon{color:var(--dsw-alias-state-error-primary)}
.sm-toast-text{flex:1;min-width:0;overflow-wrap:anywhere}.sm-toast-close{display:inline-flex;flex:none;margin-top:1px;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.sm-toast-close:hover{color:var(--dsw-alias-label-primary)}@keyframes sm-spin{to{transform:rotate(360deg)}}
@keyframes sm-fade{from{opacity:0}to{opacity:1}}@keyframes sm-slide{from{transform:translateX(24px);opacity:.6}to{transform:translateX(0);opacity:1}}
@keyframes sm-shimmer{0%,100%{opacity:.55}50%{opacity:.95}}@media (prefers-reduced-motion:reduce){.sm-spinner,.sm-skeleton-row,.sm-mask,.sm-drawer,.sm-toast{animation:none}.sm-switch,.sm-switch-knob{transition:none}}
@media (max-width:640px){.sm-head-actions{flex:1 1 100%}.sm-ov-extra{display:none}.sm-search{flex:1 1 100%}.sm-seg{width:100%}.sm-seg-item{flex:1}.sm-drawer{width:100%}.sm-meta-grid{grid-template-columns:minmax(0,1fr)}.sm-row-source,.sm-row-inv{display:none}.sm-mask-center{padding:12px}}
/* 主面板（侧边栏「技能管理」入口）：main 槽只给满高容器，滚动与内容列宽由这里补。 */
.sm-panel{display:flex;width:100%;min-width:0;height:100%;min-height:0;background:var(--dsw-alias-bg-base);overflow:hidden}
.sm-panel-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}
.sm-panel-content{max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 40px}
.sm-panel .sm-page{max-width:none;margin:0;padding:28px 0 24px}
[data-platform=darwin] .sm-panel .sm-page{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.sm-panel .sm-title{font-size:20px;line-height:28px;font-weight:500}
/* 行内三态调用菜单（#1）：触发器就是原来那枚调用徽章，菜单项带第二行说明。 */
.sm-mini{position:relative;display:inline-flex;flex:none}
.sm-mini-trigger{display:inline-flex;align-items:center;gap:3px;max-width:170px;padding:1px 5px;border:.5px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:14px;cursor:pointer;white-space:nowrap}
.sm-mini-trigger:hover{background:color-mix(in oklab,var(--dsw-alias-label-primary) 8%,transparent);color:var(--dsw-alias-label-primary)}
.sm-mini-trigger-warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 12%,transparent)}
.sm-mini-trigger-warn:hover{background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 20%,transparent);color:var(--dsw-alias-state-warn-primary)}
.sm-mini-trigger-ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in oklab,var(--dsw-alias-state-success-primary) 12%,transparent)}
.sm-mini-trigger-ok:hover{background:color-mix(in oklab,var(--dsw-alias-state-success-primary) 20%,transparent);color:var(--dsw-alias-state-success-primary)}
.sm-mini-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in oklab,var(--dsw-alias-brand-primary) 40%,transparent)}
.sm-mini-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
.sm-mini .sm-menu{left:auto;right:0;top:calc(100% + 4px);z-index:30}
.sm-menu-wide{min-width:250px}
.sm-menu-col{display:flex;flex-direction:column;gap:1px;min-width:0;text-align:left}
.sm-menu-hint{font-size:11px;line-height:15px;color:var(--dsw-alias-label-secondary);white-space:normal}
/* 调用账本徽章（#2）。 */
.sm-row-usage{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap;font-variant-numeric:tabular-nums}
/* 批量选择（#4）。 */
.sm-check{width:14px;height:14px;flex:none;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}
.sm-row-select{cursor:pointer}.sm-row-picked{background:color-mix(in oklab,var(--dsw-alias-brand-primary) 8%,transparent)}
.sm-batchbar{position:sticky;bottom:0;z-index:15;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2);background:var(--sm-surface-2);box-shadow:0 -6px 20px color-mix(in oklab,#000 12%,transparent)}
.sm-batch-count{font-size:12px;line-height:18px;font-weight:500;white-space:nowrap}.sm-batch-spacer{flex:1}
/* 导入结果（#6）。 */
.sm-modal-drop{border-color:color-mix(in oklab,var(--dsw-alias-brand-primary) 55%,transparent);box-shadow:0 0 0 2px color-mix(in oklab,var(--dsw-alias-brand-primary) 22%,transparent)}
.sm-import-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;max-height:220px;overflow-y:auto}
.sm-import-item{display:flex;align-items:flex-start;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.sm-import-item-warn{color:var(--dsw-alias-state-warn-primary)}
.sm-import-name{font-family:var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-primary);flex:none}
.sm-import-target{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10.5px}
.sm-import-body{display:flex;flex-direction:column;gap:1px;min-width:0}.sm-import-reason{color:inherit}
`
    function ensureStyles() {
      if (typeof document === 'undefined') return function () {}
      const existing = document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')
      if (existing) return function () {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      if (document.head) document.head.appendChild(tag)
      // 卸载时不移除：HMR 重载复用同一个 style（上面已去重），
      // 若旧 disposer 删掉它，重载后的页面会无样式。
      return function () {}
    }

    /* ------------------------------------------------------------------ *
     * 插件面（factory 本身零副作用）
     * ------------------------------------------------------------------ */
    const inject = ['slots', 'locale']
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      }, PLUGIN_ID + ': dictionaries')
      ctx.effect(function () {
        return ensureStyles()
      }, PLUGIN_ID + ': styles')
      ctx.effect(function () {
        return installNavGlyph([zh.nav, en.nav])
      }, PLUGIN_ID + ': settings-nav glyph')
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'skill-manager',
            order: 32,
            label: function () { return t('nav') },
            locale: NS,
          },
          Page,
        )
      })
      // 侧边栏「自动化任务」下面的快速入口：一行 panellist 图标 + 同 key 的 main 面板。
      // 宿主按 panellist 的 id 切主面板，所以两处 key 必须一致（'skill-manager'）。
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'skill-manager',
            order: 20,
            label: function () { return t('panel.label') },
            locale: NS,
          },
          IconPanelMark,
        )
      })
      ctx.slots.inject('main', function () {
        return ctx.slots.register(
          {
            name: 'main',
            key: 'skill-manager',
            locale: NS,
          },
          PanelPage,
        )
      })
    }
    return { inject: inject, apply: apply }
  },
})