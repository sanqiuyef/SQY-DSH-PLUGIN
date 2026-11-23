# dsh-skill-manager — UI 设计规范（ZCode 风格）

> 目标：设置里开出一个**自有绘制**的技能管理页，视觉与交互对齐本机 ZCode 的技能面板（`ZCode/packages/ui/src/settings/SkillsSection.tsx` + `ZCode/DESIGN.md`），而不是 DSH 默认表单。
> 实现载体：`client/client.js`（无构建、无 JSX，`window.__ModuleLoader__.load` 工厂函数 + `React.createElement`）。

## 0. 必读参考（写代码前）

| 文件 | 用途 |
|---|---|
| `ZCode/DESIGN.md` | ZCode 设计系统（颜色语义、字号、间距、圆角、组件规则） |
| `ZCode/packages/ui/src/settings/SkillsSection.tsx` | 技能面板的信息架构与交互（列表/搜索/详情/启停/诊断） |
| `plugin-library/dsh-memory-manager/client/client.js` | **本宿主版本的可用写法**：ModuleLoader 工厂、locale 注册、slots 注册、apiRequest、Drawer/Modal/Toast、`ensureStyles` |
| `plugin-library/dsh-skill-manager/docs/api-contract.md` | 数据契约（唯一接口来源） |

## 1. 视觉语言（从 ZCode 提炼，非照搬 DOM）

**性格**：平静、紧凑、工具感；靠层级与留白区分信息，不靠装饰和渐变。
**禁止**：大圆角卡片堆叠、品牌色大面积填充、花哨阴影、渐变按钮、图库插画。

### 1.1 颜色 —— 只用 DSH 主题 token

DSH 当前只暴露这些别名 token（运行时真实存在，`client/Theme.listTokens` 已核验）：

```
--dsw-alias-bg-base          页面底
--dsw-alias-bg-layer-1       一级抬升面（卡片/行悬浮容器）
--dsw-alias-bg-layer-2       二级嵌套面（输入框、代码块、抽屉）
--dsw-alias-bg-overlay       浮层（模态/抽屉/菜单）
--dsw-alias-border-l1        最弱分隔（hairline）
--dsw-alias-border-l2        次强边框
--dsw-alias-brand-primary    品牌强调（只用于：激活点、开关开启、主按钮、焦点环）
--dsw-alias-label-primary    主文字
--dsw-alias-label-secondary  次级文字（描述、元信息）
--dsw-alias-state-error-primary / -success-primary / -warn-primary / -idle-primary
--dsw-specific-sidebar-fill  侧栏底色
```

其它层级一律用 `color-mix(in oklab, var(--dsw-alias-…) N%, transparent)` 派生，**不要**引用未列出的 token（如 `--dsw-alias-label-tertiary`、`--dsw-elevation-prominent`，本宿主没有）。深色模式由 token 自动适配，不得写死明暗两套色值。

语义映射（必须遵守）：
- 启用 = success；停用 = idle；异常 = error；被遮蔽/提醒 = warn；品牌色**只**用于交互态。
- 状态永远"色 + 文案"同时出现，不允许仅靠颜色表达。

### 1.2 字号 / 行高（对齐 ZCode `text-ui-*`）

| 角色 | 尺寸 | 字重 | 颜色 |
|---|---|---|---|
| 页面标题 | 16px / 24px | 600 | label-primary |
| 页面副标题 | 13px / 20px | 400 | label-secondary |
| 区块/分组标题 | 12px / 18px | 600，letter-spacing .02em | label-secondary |
| 行标题（技能名） | 14px / 20px | 500 | label-primary |
| 行描述 | 12.5px / 19px，最多 2 行截断 | 400 | label-secondary |
| 徽章/计数 | 11px / 16px | 500 | 语义色或 secondary |
| 等宽（路径/正文） | 12px / 18px | 400 | `var(--ds-font-family-code, ui-monospace, …)` |

### 1.3 间距 / 圆角 / 描边

- 间距只用 4 的倍数：4 / 8 / 12 / 16 / 20 / 24。
- 圆角：容器 12px、控件 8px、徽章 6px、开关全圆。**不要** 16px+ 的大圆角卡片。
- 分隔线 `0.5px solid var(--dsw-alias-border-l1)`；卡片边框用 `--dsw-alias-border-l2`。
- 行内边距 `10px 12px`，行间距 2px（列表密集但可读）。
- 页面内容列 `max-width: 1040px; margin: 0 auto; padding: 20px 24px 32px`。

### 1.4 图标

- 一律内联 SVG（stroke 1.5，`currentColor`，`size-4`=16px 为基线），**不引入图标库、不加载网络资源**。
- 每个技能行左侧一个 32×32 的"技能字形"底片：圆角 8px，背景 `color-mix(in oklab, var(--dsw-alias-brand-primary) 12%, transparent)`，内含 16px 字形（书页/星火一类自定义形状）。

## 2. 页面结构

```
┌ 头部 ────────────────────────────────────────────────────────────────┐
│ 技能                                        [ 刷新 ] [ 新建 ] [ 打开目录 ] │
│ 直接管理磁盘上的 SKILL.md：用户 / 项目 / 自定义 / 内置                    │
├ 概览条（hairline 上下各一条）─────────────────────────────────────────┤
│ ● 12 个技能   ● 9 启用   ● 2 停用   ● 1 异常     来源 4   市场 47 仓库     │
├ 工具栏 ──────────────────────────────────────────────────────────────┤
│ [ 全部 | 用户 | 项目 | 内置 ]   [⌕ 搜索技能…            ]   [ 状态 ▾ ]      │
├ 列表 ────────────────────────────────────────────────────────────────┤
│ 用户技能 · ~/.dsh/skills · 6                              (分组标题)      │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ [◈] obsidian                    用户  模型可调用             [◉]  │ │
│ │     Work with Obsidian vaults…（最多 2 行）                       │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ …                                                                      │
│ 已停用 · _disabled · 2                                                 │
│ 异常 · 1                                                               │
└──────────────────────────────────────────────────────────────────────┘
```

- 分组顺序：项目技能 → 用户技能 → 自定义 → 内置 → 已停用 → 异常（空分组不渲染；异常组永远排最后，便于先看到问题）。
- 分组标题右侧显示数量；整组可折叠（点击标题切换，默认展开，折叠状态存内存即可）。

### 2.1 主面板模式（侧边栏快速入口）

同一个页面有两处挂载点：设置里的 `settings.section`，以及主页面侧边栏「自动化任务」下面的 `sidebar.panellist` 行 + 同名 `main` 面板。两处渲染同一个 `Page`，只有外框不同：

```
┌ 侧边栏（宿主）────────────────┐   ┌ main 面板（本插件 .sm-panel）─────────────┐
│ 插件                          │   │ ┌ .sm-panel-scroll ─────────────────────┐ │
│ 自动化任务                     │   │ │      （960px 内容列，28px 顶距）       │ │
│ 技能管理      ← order 20      │   │ │ 技能                    [刷新][新建]   │ │
│ MCP 管理      ← order 30      │   │ │ 直接管理磁盘上的 SKILL.md…             │ │
└───────────────────────────────┘   │ │ 概览条 / 工具栏 / 列表 / 抽屉 …        │ │
                                    │ └───────────────────────────────────────┘ │
```

- 宿主只负责：侧边栏那一行的按钮外壳、选中态、可访问名；`main` 槽给一个满高 flex 容器（`overflow:hidden`）。滚动容器、内容列宽、顶部留白全部由 `.sm-panel` / `.sm-panel-scroll` / `.sm-panel-content` 自己负责。
- 面板内容列 `max-width: 960px; margin: 0 auto; padding: 0 clamp(24px, 4vw, 48px) 40px`，页面顶部留白 28px（macOS 叠加 `--dsh-frame-top-clearance`），标题在面板里升到 20px / 28px / 500。
- 侧边栏图标由 `sidebar.panellist` 占位组件绘制，只收到 `{ size, active }`：16×16 viewBox、stroke 1.3、`currentColor`，与设置导航字形同一形象（卡片 + 星火）；不画选中态，不加可访问名。
- 未选中面板时主栏仍是会话；切回会话不会移除侧边栏入口。

## 3. 交互

### 3.1 工具栏

- 分段控件（segmented）四个作用域过滤项：全部 / 用户 / 项目 / 内置；选中项背景 `bg-layer-2` + 边框，未选中透明，hover 用 6% 前景叠加。
- 搜索框：左侧放大镜，右侧 `⌘K` 样式的清除按钮（有值才出现），输入防抖 150ms，匹配 name / description / whenToUse / dirName（大小写不敏感）。
- 状态下拉（自绘菜单，非原生 `<select>`）：全部状态 / 仅启用 / 仅停用 / 仅异常 / 被遮蔽 / 从未使用（最后一档只在调用账本可用时出现）。
- 排序下拉（账本可用时才出现，图标为长短条）：按名称 / 按调用次数 / 按最后使用；后两者把「死技能」排到最前。
- 工作区下拉（图标为文件夹）：当前会话 / 最近用过的目录（最多 5 个）/ 输入路径…；选中后所有请求带上 `cwd`，项目级技能根按该目录重新解析。空串 = 跟随当前会话。选择记在 `localStorage` 的 `dsh-skill-manager.workspace`。
- 批量按钮：进入/退出选择模式（进入后为 primary 实心）。

### 3.2 行

- 整行可点 → 打开右侧详情抽屉；选择模式下整行点击改为勾选，左侧出现复选框。
- 右侧开关：点击**不**冒泡打开抽屉；乐观切换 → 调 `skill/toggle` → 失败回滚 + error toast。
- 调用策略徽章即菜单触发器（可写、非异常、非选择模式）：默认档不显示文字，悬停/点击展开三档菜单（默认 / 仅手动 / 都不可调用），每档带一行说明；选中即写盘（`skill/invocation`，不搬目录，带 hash 并发保护），成功只回写这一条。只读或异常行走纯文本徽章。
- 调用账本徽章：账本可用时显示「7 天 N 次」，hover 的 title 给 7/30/90 天与最后使用时间；没有记录则显示 warn 徽章「从未使用」。
- `invalid` 行：名称旁一个 11px error 徽章（`异常`），描述下方一行红色小字说明第一条 error issue；开关禁用并给 title 提示。
- `shadowed` 行：warn 徽章 `被遮蔽`，hover 用 title 显示"被 <rootLabel> 的同名技能遮蔽"。
- 被插件同名胜出的行（`shadowedByPlugin`）：名称旁再加一个 warn 徽章 `插件同名`，title 说明 provider 与 rank 350；它与 `被遮蔽` 可以并存（插件遮蔽不覆盖同根/更高根信息）。
- bundled 行：显示 `只读` 徽章，开关隐藏，详情里危险操作全部禁用。

### 3.2.1 批量操作条

- 选择模式下页面底部贴一条 `position: sticky` 的操作条（`sm-batchbar`）：已选 N 项 / 全选可见 / 清除选择 / 启用 / 停用 / 删除 / 退出批量。
- 只读与异常条目不可勾选，也不进请求；「全选可见」只覆盖当前筛选结果里可写的条目。
- 删除前弹二次确认（复用 `ConfirmDialog`），文案写明移入 `_trash/`、内容不删除。
- 结果：`{ok, failed}` 分别给 success / error toast；成功后清空选择并刷新列表。逐条失败不影响其余。


### 3.3 详情抽屉

- 右侧抽屉，`width: min(560px, 100%)`，全高，左阴影，`bg-overlay`，从右滑入 180ms（`prefers-reduced-motion` 时不动画）。
- 结构：
  1. 头部：技能名（16/600）+ 状态徽章 + 关闭 ×；下一行等宽路径（可点 → `skill/open`）。
  2. 元信息网格（两列 label/value）：来源根 / 类型（目录/单文件）/ 大小 / 修改时间 / 正文长度/ 调用次数（账本可用时：7/30/90 天）/ 最后使用。
  3. 调用策略：两行开关（模型可调用 / 用户可调用），改动**写入 frontmatter 文本**（不做即时保存，交给正文编辑器统一保存，避免两条写入路径）。
  4. 诊断：有 issue 时列出（图标 + 文案 + 行号），error 红 / warn 黄；无 issue 时一行 green「前端校验通过」。
  5. 正文：等宽 `<textarea>`（min-height 320px，可 resize 垂直），顶部一行工具（行数 / 字节数 / 「恢复」）。
  6. 底部固定操作条：左「停用/启用」+「删除」（destructive outline，二次确认），右「保存」（primary，dirty 时启用）+「关闭」。
- 保存：`skill/save`，成功后刷新 overview + toast；`409 conflict` 时在正文上方显示红条「磁盘内容已被其他程序修改」并给「重新载入」按钮。
- 抽屉是 `role="dialog" aria-modal="true"`，Esc 关闭，焦点陷阱（Tab 循环），关闭后焦点回到触发行。

### 3.4 新建技能（模态）

- 居中模态 480px，`bg-overlay`，圆角 12px，`box-shadow: 0 24px 64px color-mix(in oklab, #000 24%, transparent)`。
- 字段：名称（kebab，实时校验 + 错误文案）、描述（必填，≤200 字计数）、何时使用（可选）、目标根（可写根下拉，默认 `user-dsh`）、正文（等宽，预填模板）。
- 底部：取消 / 创建（primary，校验不过禁用）。
- 创建成功：关闭 → 刷新 → 自动展开该技能详情（按返回的 key 定位）。

### 3.4.1 导入技能（模态）

- 同尺寸模态，字段：来源路径（等宽输入，必填）、导入到（可写根下拉）。
- 支持把文件夹拖进模态：`file.path`（Electron）优先，否则读 `text/uri-list` / `text/plain` 并去掉 `file://` 前缀；拿不到绝对路径时提示手输。
- 结果区两段：已导入（green 勾 + 名称 + 目标路径）、跳过（warn 图标 + 名称 + 原因，`invalid` 再附 issue 徽章）。原因按 `import.reason.<code>` 本地化。
- 底部：取消/关闭 + 导入（primary，busy 时 spinner）；导入成功后 toast 给 `已导入 N 个，跳过 M 个`。


### 3.5 市场（第二个标签）

头部下方加一层标签：`本机技能` / `市场`（自绘 tab，active 用下划线 2px brand + 主文字，不用胶囊填充）。

- 市场视图：顶部搜索 + 「47 个仓库 · 320 个技能 · 已安装 6」摘要；按仓库分组（可折叠，默认折叠，仅展开搜索结果命中的组）。
- 市场行：名称 + 描述（2 行）+ 右侧动作：未安装 →「安装」按钮（ghost outline）；已安装且市场一致 → `已安装` 徽章；已安装且市场有新版本（`updateAvailable === 'different'`）或目标已丢失（`'missing'`）→「更新」按钮（重新安装走 `overwrite`，旧版本进 `_trash/`）并另挂一个 warn 徽章 `市场有更新`；同名但不是本市场条目装的（`nameTaken`）→ warn 徽章 `同名已存在`（title 说明直接安装会 409）。
- 安装中：按钮转 spinner，行不可重复点；成功后行变「已安装」+ toast（带「打开详情」不做，保持简单）。
- 目标根提示：一行小字「安装到：用户技能 · ~/.dsh/skills」。
- 市场不可用（目录不存在）：整块空状态 + 说明路径 + 「打开市场目录」按钮（若目录存在）。

### 3.6 反馈

- Toast 右下角，3.5s 自动消失，可手动关；层级高于抽屉。
- 全局错误：列表上方一条 error 横幅（可关闭），保留上次数据。
- 插件同名说明条：`counts.shadowedByPlugin > 0` 时在列表上方再显示一条 warn 横幅（`.sm-banner-warn`），说明插件技能 rank 350 介于 custom 300 与 user-dsh 400 之间、宿主不会采用冲突条目、项目/custom 本地技能仍优先；不提供关闭按钮，数量归零即消失。
- 加载：首次 `loading` 显示 3 行 44px 高的骨架（shimmer 用 `@keyframes` 位移，`prefers-reduced-motion` 关闭）；刷新（有数据）显示头部按钮转圈，不清空列表。

## 4. 本地化

- 客户端字典：`zh` / `en` 两套**同 key**，`ctx.locale.register('skillManager', { zh, en })`；`t = ctx.locale.bind('skillManager')`。
- 所有可见文案走 `t('…')`，禁止硬编码中英文。数字/计数用插值函数（`{count}` 替换）。
- 导航标签：`label: () => t('nav')` → zh「技能」/ en「Skills」。
- 导航图标：宿主提供 `settings.section.icon` 槽（`{kind:'list', scope:'root', inline:true}`，按 section id 过滤渲染，缺省回退 `navIcon(id)` 的齿轮）。插件注册 `id: 'skill-manager'`、`order: 21` 的「卡片 + 星火」16×16 / stroke 1.3 组件；老宿主没有该槽时 `try/catch` 静默退回齿轮，不做 DOM 手术、不挂文档观察器。
- 要求：英文文案不得长到撑破行（行长按 2 倍中文预留）。

## 5. 无障碍与细节

- 开关用 `role="switch" aria-checked`；分段控件用 `role="tablist"`/`aria-selected`；抽屉焦点陷阱；所有图标按钮有 `aria-label` + `title`。
- 键盘：`/` 聚焦搜索框，Esc 关闭最上层浮层，↑/↓ 在列表中移动焦点，Enter 打开详情。
- 深色模式只靠 token，不写 `@media (prefers-color-scheme)` 分支。
- 移动宽度（<640px）：隐藏概览条次要项，工具栏换行，抽屉全宽，元信息网格变单列。

## 6. 代码约束

- 单文件 `client/client.js`，IIFE 工厂，**无 ESM import、无 JSX、无构建**；React 从 `require('react')` 取。
- 样式：模块顶部一个 `CSS` 常量字符串，`data-plugin-css="dsh-skill-manager/styles"` 注入 `<head>`（去重，参考 memory-manager `ensureStyles`）。
- 所有 class 前缀 `sm-`（skill manager），避免与宿主/其它插件冲突。
- 组件拆分：`Page`（容器 + 数据）、`Toolbar`、`SkillRow`、`GroupHeader`、`HostOnlyGroup`、`SearchResults`、`DetailDrawer`、`SkillFilePage`、`CreateDialog`、`ImportDialog`、`TrashDialog`、`PathDialog`、`BatchBar`、`MarketView`、`StatusMenu`、`MiniMenu`、`Switch`、`Badge`、`Toast`、`EmptyState`。
- 数据层：`useOverview(cwd)`（含刷新/乐观更新），统一 `apiRequest`；错误统一 `ApiError`。
- 不得读取其它插件的 DOM / 样式；不得替换 app 根节点。
- 结束时自检：`node --check client/client.js`（语法）+ 单文件 ≤ 4600 行（v0.2.0 加入回收站、资源文件、正文搜索、宿主对照后实测 4522 行；继续增长时优先把独立浮层拆成同目录的第二文件，而不是压行）。

## 7. v0.2.0 增补的交互

以下界面元素在 v0.2.0 加入，遵守前六节的全部约束（只用主题 token、文案走 `t()`、`sm-` 前缀类名、模态/抽屉沿用现有组件）。

### 7.1 工具栏新增

- **回收站**按钮（`IconTrash`，右侧带计数徽章，计数来自懒加载的 `GET /trash`）：打开回收站面板。
- **正文**开关（小号切换，紧邻搜索框）：开启后搜索改为调 `GET /search`，在列表上方插入「正文命中 N 条」分组，不改动主列表；关闭或清空查询时移除。

### 7.2 列表新增分组

- **宿主提供**（永远排在「异常」之后）：来自 `overview.hostOnly` 的只读技能，行显示 name / description / 来源（`provider`，插件技能显示「插件 · <pluginId>」），右侧徽章「宿主提供」，**整行不可点击、无开关**。分组标题下一行小字说明「来自宿主 provider（preset / bundled），不落磁盘根」。`hostSkills.complete === false` 时标题旁加 warn 徽章「宿主发现不完整」。
- **诊断条**（列表上方，错误条之下）：渲染 `overview.diagnostics`，每条 message + 来源根；可关闭，本会话不再出现；空列表时同样渲染。

### 7.3 详情抽屉新增「文件」页

- 抽屉头部下方加标签：`SKILL.md` / `文件`（仅 `kind === 'directory'` 显示后者）。
- 文件页左列（或上方）是目录树列表（`relativePath`、大小），选中文本文件后在下方显示等宽 textarea 与「保存」；`binary` / `too-large` 只显示说明、不给编辑器；只读根禁用保存。保存失败 409 时给「重新载入」。
- 异步加载态用现有骨架；加载失败给错误条，不清空正文页。

### 7.4 回收站面板

- 与 `CreateDialog` 同风格的模态（宽 560px），按根分组列出条目（名称、时间、大小）。
- 每条右侧「恢复」「删除」；删除与底部「清空回收站」都必须二次确认，文案写明**不可恢复**；恢复时目标已存在则询问是否覆盖（`overwrite: true`，旧目标再进回收站）。
- 空状态「回收站是空的」；只读根不显示删除按钮。

### 7.5 市场卸载与批量三态

- 市场行在 `installed` 时增加 ghost-danger「卸载」按钮（`overwrite` 更新按钮旁边），二次确认文案写明移入 `_trash/`、可恢复。
- 批量条在启用 / 停用 / 删除之后增加「模型不可调用」「都不可调用」两项，走 `action: 'invocation'`；失败详情与现有批量一致（前 3 条进 toast）。

### 7.6 工作区显示

- 工作区下拉的 tooltip 或下方小字显示 `overview.cwd` 与 `overview.projectRoot`（不同时才显示），用于诊断「路径写错导致列表为空」。

### 7.7 v0.3.0 增补

- **自定义根对话框**（header「自定义根」按钮）：`GET /roots/custom` 打开即读；分「profile 已保存」与「本次临时」两段，每条带移除，`exists:false` 给 warn「目录不存在」；底部输入 + 添加（回车可用，支持相对路径）；「仅本次生效」与「保存到 profile」两个提交；persist 成功显示 `path` / `backupPath`（等宽可复制）与「重载插件后生效」，409 时把 `error.message` 内联显示；`writable:false` 时禁用保存并在 title 说明。
- **导出对话框**（详情抽屉底部「导出…」，只读技能也可用）：输入目标路径，本地校验扩展名 `.zip` / `.tgz` / `.tar.gz`，成功 toast 带 `path` 与文件数，409 提示目标已存在。
- **导入对话框**：文案改为「文件夹 / .md / .zip / .tgz」，拖放压缩包同样只取路径字符串。
- **遮蔽徽章优先级**：同一行只出一个遮蔽徽章，`shadowedByHost` > `shadowedByPlugin` > `shadowed`；`shadowedByHost` 的 title 带胜出者的 provider 与 path。
- **`disabled-visible` 诊断**：停用约定失效（宿主能看到 `_disabled/` 里的技能）时，诊断条里该条用 **error 色**徽章，其余诊断保持 warn。
