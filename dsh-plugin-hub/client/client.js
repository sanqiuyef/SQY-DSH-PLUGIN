/**
 * dsh-plugin-hub — Web 客户端（设置页「插件中心」+ 侧边栏面板）。
 *
 * 对齐 ZCode 插件的两大功能，一个页面两件事：
 *   1. 插件市场：添加/刷新/移除市场源，按分类与关键词浏览条目，一键安装；
 *   2. 插件管理：已安装插件的启停、详情（组件/诊断/选项）、卸载。
 *
 * 约定（与 dsh-mcp-manager 一致）：
 *   - `window.__ModuleLoader__.load({ id, factory(require) })`，React 通过 require('react') 取；
 *   - 槽位 `settings.section`、`sidebar.panellist` + `main`（后两者的 id/key 必须都是 plugin-hub）；
 *   - CSS 只注入一次（data-plugin-css 去重），只用真实存在的 `--dsw-*` 主题 token
 *     （错名不会报错、只会静默回退，改样式后跑 scripts/lint-theme-tokens.mjs）；
 *   - 不 import 任何 Harness Client 包，不写 document.body，不用浏览器原生弹窗。
 *
 * 所有请求失败都收敛成一条内联错误；单个组件抛错会黑掉整个槽位，因此渲染对空数据/缺字段必须容错。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-hub',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const NS = 'plugin-hub';
    const API = '/plugin-hub/api';
    const STYLE_ID = 'plugin-hub';

    // ------------------------------------------------------------------ locale

    const zh = {
      nav: '插件中心',
      'panel.label': '插件中心',
      title: '插件中心',
      subtitle: '像 ZCode 一样管理插件：在市场里发现并安装，在插件管理里启停、配置和卸载。',
      'bridge.title': '常规插件 → DSH 的过渡层',
      'bridge.body':
        '除 pi 与 DSH 外，其他 Agent / Harness 大多没有真正的插件化体系，扩展基本是「MCP 服务器 + 技能 + 钩子」的常规组合（有的还带斜杠命令）。这里先把这种常规插件装进来、投影成本会话可用的能力；以后需要更深集成时，再改写成原生 DSH bundle。',
      'bridge.flow.mcp': 'MCP 服务器',
      'bridge.flow.skill': '技能',
      'bridge.flow.hook': '钩子',
      'bridge.flow.bridge': '安装 · 投影',
      'bridge.flow.target': 'DSH 会话',
      'bridge.note': '识别 ZCode / Claude 插件清单；项目作用域首次生效前需要信任。',
      'bridge.expand': '展开说明',
      'bridge.collapse': '收起说明',
      'scope.user': '全局',
      'scope.workspace': '项目',
      'scope.hint': '打开一个会话后即可使用项目作用域。',
      'scope.projectPath': '项目',
      'tab.manage': '插件管理',
      'tab.market': '插件市场',
      'manage.title': '已安装',
      'manage.count': '共 {n} 个',
      'manage.empty': '还没有安装插件。',
      'manage.emptyHint': '去插件市场挑一个，或从本地目录 / Git 安装。',
      'manage.enable': '启用',
      'manage.inherit': '恢复继承',
      'manage.source.workspace': '项目覆盖',
      'manage.source.user': '全局设置',
      'manage.source.default': '默认启用',
      'manage.detail': '详情',
      'manage.uninstall': '卸载',
      'manage.confirmUninstall': '确认卸载',
      'manage.missing': '包缺失',
      'manage.runtimeFailed': '运行失败 {n}',
      'market.title': '插件市场',
      'market.subtitle': '添加 GitHub 仓库、Git URL、marketplace.json 地址或本地目录作为市场源。',
      'market.empty': '还没有添加插件市场。',
      'market.emptyHint': '添加 ZCode 官方、Claude 官方或你自己的市场源，就能在这里浏览并安装插件。',
      'market.add': '添加插件市场',
      'market.addTitle': '添加插件市场',
      'market.addPlaceholder': 'GitHub 仓库、Git URL、文件或目录',
      'market.addHint': '支持 owner/repo、Git 地址、marketplace.json 地址、本地目录。',
      'market.dropHint': '拖入文件或文件夹，或选择目录。',
      'market.chooseDirectory': '选择目录',
      'market.refresh': '刷新',
      'market.refreshAll': '刷新全部',
      'market.remove': '移除',
      'market.confirmRemove': '确认移除',
      'market.updatedAt': '更新于 {time}',
      'market.count': '{n} 个插件',
      'market.all': '全部',
      'market.search': '搜索插件',
      'market.searchEmpty': '没有匹配的插件',
      'market.entriesEmpty': '这个市场还没有条目，先刷新一次。',
      'market.loading': '正在读取市场索引…',
      'market.installed': '已安装',
      'market.install': '安装',
      'market.installing': '安装中…',
      'market.update': '更新',
      'market.sourceDirectory': '本地目录',
      'market.sourceGit': 'Git 仓库',
      'market.sourceUrl': '索引地址',
      'market.indexError': '索引读取失败',
      'market.diagnostics': '{n} 条条目被忽略',
      'market.staleShort': '过期',
      'market.failedShort': '抓取失败',
      'market.staleTitle': '索引超过 1 小时未刷新，浏览时会自动在后台更新。',
      'market.lastErrorLabel': '上次抓取失败：{message}',
      'install.title': '从本地或 Git 安装',
      'install.hint': '直接填插件根目录（含 plugin.json）或 Git 仓库地址。',
      'install.placeholder': '插件目录绝对路径，或 Git 仓库 URL',
      'install.button': '安装',
      'install.chooseDirectory': '选择目录',
      'detail.title': '插件详情',
      'detail.close': '关闭',
      'detail.manifest': '清单',
      'detail.components': '组件',
      'detail.diagnostics': '诊断',
      'detail.noDiagnostics': '没有诊断问题。',
      'detail.runtimeRow': '{kind} 挂载失败：{message}',
      'detail.uiNote': '该插件声明了交互面板，但 DSH 目前没有 MCP Apps 宿主，暂不渲染。',
      'detail.options': '配置项',
      'detail.optionsHint': '这些值会作为 ${user_config.KEY} 展开到插件的 MCP 服务器里。',
      'detail.saveOptions': '保存配置',
      'detail.savedOptions': '配置已保存',
      'detail.publisher': '发布者',
      'detail.category': '类别',
      'detail.keywords': '关键词',
      'detail.source': '来源',
      'detail.version': '版本',
      'detail.format': '格式',
      'detail.homepage': '主页',
      'detail.license': '许可证',
      'detail.componentsPending': '安装后会自动识别该插件的组件。',
      'detail.versions': '版本历史',
      'detail.currentVersion': '当前',
      'detail.switchVersion': '切换',
      'detail.confirmSwitch': '确认切换',
      'detail.noVersions': '缓存里没有其它版本。',
      'notice.switched': '已切换版本',
      'detail.installHere': '安装该插件',
      'detail.openMarket': '所属市场',
      'detail.description': '描述',
      'format.zcode': 'ZCode 插件',
      'format.root': 'ZCode 插件',
      'format.claude': 'Claude 插件',
      'format.synthesized': '市场条目',
      'kind.agent': '子代理',
      'kind.command': '命令',
      'kind.skill': '技能',
      'kind.hook': '钩子',
      'kind.mcp': 'MCP',
      'kind.lsp': 'LSP',
      'kind.ui': '界面',
      'publisher.official': '官方',
      'publisher.community': '社区',
      'category.developer-tools': '开发者工具',
      'category.productivity': '生产力',
      'category.utilities': '实用工具',
      'category.legal': '法律',
      'category.finance': '金融',
      'category.template': '模板',
      'category.other': '其他',
      'category.uncategorized': '未分类',
      'category.security': '安全',
      'category.design': '设计',
      'category.development': '开发',
      'category.database': '数据库',
      'category.location': '位置',
      'category.monitoring': '监控',
      'category.migration': '迁移',
      'category.deployment': '部署',
      'category.automation': '自动化',
      'category.learning': '学习',
      'category.testing': '测试',
      'category.math': '数学',
      'category.ai': 'AI',
      'category.data': '数据',
      'category.media': '媒体',
      'category.docs': '文档',
      'category.tools': '工具',
      'category.game': '游戏',
      'category.3d': '3D',
      'category.writing': '写作',
      'category.research': '研究',
      'category.communication': '沟通',
      'category.search': '搜索',
      'category.files': '文件',
      'category.infrastructure': '基础设施',
      'category.analytics': '分析',
      'trust.title': '项目配置未信任',
      'trust.body': '一次批准同时覆盖本项目的 MCP 与插件配置；批准之前项目覆盖不会生效（全局设置照常生效）。',
      'trust.layers': 'MCP：{mcp} · 插件：{plugins}',
      'trust.state.trusted': '已信任',
      'trust.state.untrusted': '未信任',
      'trust.state.notApplicable': '不适用',
      'trust.button': '信任并启用',
      'mcp.conflict.title': 'MCP 服务器重名，插件的同名条目已让位',
      'mcp.conflict.body':
        '优先级为全局 > 项目 > 插件：全局或已信任项目里已有同名 MCP 服务器时，插件里的同名 server 不挂载（同一套工具不该出现两份）。',
      'mcp.conflict.count': '{n} 处',
      'mcp.conflict.expand': '展开明细',
      'mcp.conflict.collapse': '收起明细',
      'mcp.conflict.row': '{plugin} 的 {server} 让位于{source}',
      'mcp.conflict.source.global': '全局 MCP',
      'mcp.conflict.source.project': '项目 MCP',
      'error.prefix': '操作失败：',
      'notice.saved': '已保存',
      'notice.installed': '已安装',
      'notice.uninstalled': '已卸载',
      'notice.trusted': '已信任',
      'notice.refreshed': '已刷新',
      'notice.marketAdded': '市场已添加',
      'notice.marketRemoved': '市场已移除',
      'nav.glyph': '插件中心',
      'common.loading': '加载中…',
      'common.retry': '重试',
      'common.cancel': '取消',
      'common.close': '关闭',
      'common.version': '版本',
      'common.marketplace': '来源',
      'common.save': '保存',
      'common.back': '返回',
    };

    const en = {
      nav: 'Plugin Hub',
      'panel.label': 'Plugin Hub',
      title: 'Plugin Hub',
      subtitle: 'A ZCode-style plugin center: discover and install from marketplaces, then enable, configure, and remove them.',
      'bridge.title': 'Conventional plugins → DSH bridge',
      'bridge.body':
        'Outside pi and DSH, most agents and harnesses have no real plugin system — extensions are usually a conventional mix of MCP servers, skills, and hooks (some also ship slash commands). Install that form here and project it into the current session; rewrite it as a native DSH bundle when you need deeper integration.',
      'bridge.flow.mcp': 'MCP server',
      'bridge.flow.skill': 'Skills',
      'bridge.flow.hook': 'Hooks',
      'bridge.flow.bridge': 'install · project',
      'bridge.flow.target': 'DSH session',
      'bridge.note': 'Reads ZCode / Claude plugin manifests; project scope needs trust before it takes effect.',
      'bridge.expand': 'Show details',
      'bridge.collapse': 'Hide details',
      'scope.user': 'Global',
      'scope.workspace': 'Project',
      'scope.hint': 'Open a session to use project scope.',
      'scope.projectPath': 'Project',
      'tab.manage': 'Plugins',
      'tab.market': 'Marketplaces',
      'manage.title': 'Installed',
      'manage.count': '{n} installed',
      'manage.empty': 'No plugins installed yet.',
      'manage.emptyHint': 'Pick one from the marketplaces, or install from a local directory or Git.',
      'manage.enable': 'Enabled',
      'manage.inherit': 'Restore inheritance',
      'manage.source.workspace': 'project override',
      'manage.source.user': 'global setting',
      'manage.source.default': 'enabled by default',
      'manage.detail': 'Details',
      'manage.uninstall': 'Uninstall',
      'manage.confirmUninstall': 'Confirm uninstall',
      'manage.missing': 'package missing',
      'manage.runtimeFailed': '{n} runtime errors',
      'market.title': 'Marketplaces',
      'market.subtitle': 'Add a GitHub repository, a Git URL, a marketplace.json URL, or a local directory as a marketplace source.',
      'market.empty': 'No marketplaces yet.',
      'market.emptyHint': 'Add the official ZCode market, the official Claude market, or your own source to browse and install plugins here.',
      'market.add': 'Add marketplace',
      'market.addTitle': 'Add marketplace',
      'market.addPlaceholder': 'GitHub repository, Git URL, file or directory',
      'market.addHint': 'Accepts owner/repo, a Git URL, a marketplace.json URL, or a local directory.',
      'market.dropHint': 'Drop a file or folder, or choose a directory.',
      'market.chooseDirectory': 'Choose directory',
      'market.refresh': 'Refresh',
      'market.refreshAll': 'Refresh all',
      'market.remove': 'Remove',
      'market.confirmRemove': 'Confirm remove',
      'market.updatedAt': 'Updated {time}',
      'market.count': '{n} plugins',
      'market.all': 'All',
      'market.search': 'Search plugins',
      'market.searchEmpty': 'No matching plugins',
      'market.entriesEmpty': 'This marketplace has no entries yet; refresh it first.',
      'market.loading': 'Reading the marketplace index…',
      'market.installed': 'Installed',
      'market.install': 'Install',
      'market.installing': 'Installing…',
      'market.update': 'Update',
      'market.sourceDirectory': 'Local directory',
      'market.sourceGit': 'Git repository',
      'market.sourceUrl': 'Index URL',
      'market.indexError': 'Index read failed',
      'market.diagnostics': '{n} entries ignored',
      'market.staleShort': 'stale',
      'market.failedShort': 'fetch failed',
      'market.staleTitle': 'The index is over an hour old; it refreshes in the background when you browse.',
      'market.lastErrorLabel': 'Last fetch failed: {message}',
      'install.title': 'Install from directory or Git',
      'install.hint': 'Point at a plugin root that contains plugin.json, or a Git repository URL.',
      'install.placeholder': 'Absolute plugin directory, or Git repository URL',
      'install.button': 'Install',
      'install.chooseDirectory': 'Choose directory',
      'detail.title': 'Plugin details',
      'detail.close': 'Close',
      'detail.manifest': 'Manifest',
      'detail.components': 'Components',
      'detail.diagnostics': 'Diagnostics',
      'detail.noDiagnostics': 'No diagnostics.',
      'detail.runtimeRow': '{kind} mount failed: {message}',
      'detail.uiNote': 'This plugin declares an interactive panel, but DSH has no MCP Apps host yet, so it is not rendered.',
      'detail.options': 'Options',
      'detail.optionsHint': 'These values expand into ${user_config.KEY} inside the plugin MCP servers.',
      'detail.saveOptions': 'Save options',
      'detail.savedOptions': 'Options saved',
      'detail.publisher': 'Publisher',
      'detail.category': 'Category',
      'detail.keywords': 'Keywords',
      'detail.source': 'Source',
      'detail.version': 'Version',
      'detail.format': 'Format',
      'detail.homepage': 'Homepage',
      'detail.license': 'License',
      'detail.componentsPending': 'Components are detected after installation.',
      'detail.versions': 'Version history',
      'detail.currentVersion': 'Current',
      'detail.switchVersion': 'Switch',
      'detail.confirmSwitch': 'Confirm switch',
      'detail.noVersions': 'No other cached versions.',
      'notice.switched': 'Version switched',
      'detail.installHere': 'Install this plugin',
      'detail.openMarket': 'Marketplace',
      'detail.description': 'Description',
      'format.zcode': 'ZCode plugin',
      'format.root': 'ZCode plugin',
      'format.claude': 'Claude plugin',
      'format.synthesized': 'Marketplace entry',
      'kind.agent': 'Subagents',
      'kind.command': 'Commands',
      'kind.skill': 'Skills',
      'kind.hook': 'Hooks',
      'kind.mcp': 'MCP',
      'kind.lsp': 'LSP',
      'kind.ui': 'UI',
      'publisher.official': 'Official',
      'publisher.community': 'Community',
      'category.developer-tools': 'Developer tools',
      'category.productivity': 'Productivity',
      'category.utilities': 'Utilities',
      'category.legal': 'Legal',
      'category.finance': 'Finance',
      'category.template': 'Templates',
      'category.other': 'Other',
      'category.uncategorized': 'Uncategorized',
      'category.security': 'Security',
      'category.design': 'Design',
      'category.development': 'Development',
      'category.database': 'Database',
      'category.location': 'Location',
      'category.monitoring': 'Monitoring',
      'category.migration': 'Migration',
      'category.deployment': 'Deployment',
      'category.automation': 'Automation',
      'category.learning': 'Learning',
      'category.testing': 'Testing',
      'category.math': 'Math',
      'category.ai': 'AI',
      'category.data': 'Data',
      'category.media': 'Media',
      'category.docs': 'Docs',
      'category.tools': 'Tools',
      'category.game': 'Games',
      'category.3d': '3D',
      'category.writing': 'Writing',
      'category.research': 'Research',
      'category.communication': 'Communication',
      'category.search': 'Search',
      'category.files': 'Files',
      'category.infrastructure': 'Infrastructure',
      'category.analytics': 'Analytics',
      'trust.title': 'Project config not trusted',
      'trust.body':
        'One approval covers this project’s MCP and plugin config together; project overrides stay inactive until you approve (global settings keep working).',
      'trust.layers': 'MCP: {mcp} · Plugins: {plugins}',
      'trust.state.trusted': 'trusted',
      'trust.state.untrusted': 'not trusted',
      'trust.state.notApplicable': 'not applicable',
      'trust.button': 'Trust and enable',
      'mcp.conflict.title': 'MCP server name clash — the plugin entry yields',
      'mcp.conflict.body':
        'Priority is global > project > plugin: when a global or trusted project MCP server already uses the name, the plugin server is not mounted (one tool set must not exist twice).',
      'mcp.conflict.count': '{n} name clashes',
      'mcp.conflict.expand': 'Show details',
      'mcp.conflict.collapse': 'Hide details',
      'mcp.conflict.row': '{plugin}’s {server} yields to {source}',
      'mcp.conflict.source.global': 'the global MCP server',
      'mcp.conflict.source.project': 'the project MCP server',
      'error.prefix': 'Failed: ',
      'notice.saved': 'Saved',
      'notice.installed': 'Installed',
      'notice.uninstalled': 'Uninstalled',
      'notice.trusted': 'Trusted',
      'notice.refreshed': 'Refreshed',
      'notice.marketAdded': 'Marketplace added',
      'notice.marketRemoved': 'Marketplace removed',
      'nav.glyph': 'Plugin Hub',
      'common.loading': 'Loading…',
      'common.retry': 'Retry',
      'common.cancel': 'Cancel',
      'common.close': 'Close',
      'common.version': 'Version',
      'common.marketplace': 'Source',
      'common.save': 'Save',
      'common.back': 'Back',
    };

    // -------------------------------------------------------------------- css

    const CSS = `
.ph-page{position:relative;display:flex;flex-direction:column;width:100%;min-width:0;height:100%;min-height:0;background:var(--dsw-alias-bg-base);overflow:hidden;color:var(--dsw-alias-label-primary)}
.ph-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.ph-content{max-width:1040px;margin:0 auto;padding:0 clamp(18px,3.6vw,40px) 56px}
.ph-header{padding:26px 0 4px}
.ph-head-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.ph-title{font-size:21px;line-height:30px;font-weight:600;color:var(--dsw-alias-label-primary);margin:0}
.ph-subtitle{margin:6px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);max-width:620px}
.ph-tabs{display:flex;gap:2px;margin-top:18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ph-tab{position:relative;appearance:none;background:transparent;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;font:inherit;font-size:13px;line-height:20px;padding:8px 12px 10px;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.ph-tab:hover{color:var(--dsw-alias-label-primary)}
.ph-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px;border-radius:var(--dsw-radius-sm)}
.ph-tab[data-active='true']{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.ph-tab-count{font-size:11px;line-height:16px;min-width:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);text-align:center}
.ph-section{padding:18px 0 4px}
.ph-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.ph-section-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ph-muted{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.ph-seg{display:inline-flex;padding:2px;gap:2px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.ph-seg button{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;padding:3px 12px;border-radius:var(--dsw-radius-sm);cursor:pointer;white-space:nowrap}
.ph-seg button[data-active='true']{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-shadow-lv1)}
.ph-seg button:disabled{opacity:.45;cursor:not-allowed}
.ph-btn{appearance:none;font:inherit;font-size:12px;line-height:26px;padding:0 11px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
.ph-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.ph-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ph-btn[data-variant='primary']{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.ph-btn[data-variant='primary']:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
.ph-btn[data-variant='ghost']{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.ph-btn[data-variant='ghost']:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ph-btn[data-variant='danger']{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in oklab,var(--dsw-alias-state-error-primary) 42%,transparent)}
.ph-btn:disabled{opacity:.5;cursor:not-allowed}
.ph-iconbtn{appearance:none;width:26px;height:26px;flex:none;border-radius:var(--dsw-radius-sm);border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:grid;place-items:center;font:inherit;font-size:14px;line-height:1}
.ph-iconbtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ph-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:16px 0 0}
.ph-search{flex:1;min-width:200px;display:flex;align-items:center;gap:8px}
.ph-input{font:inherit;font-size:13px;line-height:32px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);min-width:0;width:100%;box-sizing:border-box}
.ph-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ph-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in oklab,var(--dsw-alias-brand-primary) 18%,transparent)}
.ph-chips{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:10px 0 0}
.ph-chips[data-scroll='true']{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:thin;padding-bottom:4px}
.ph-chip{appearance:none;font:inherit;font-size:12px;line-height:24px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.ph-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ph-chip[data-active='true']{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:color-mix(in oklab,var(--dsw-alias-brand-primary) 10%,transparent)}
.ph-chip-count{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ph-tag{font-size:11px;line-height:18px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
.ph-tag[data-tone='brand']{color:var(--dsw-alias-brand-primary);background:color-mix(in oklab,var(--dsw-alias-brand-primary) 12%,transparent)}
.ph-tag[data-tone='success']{color:var(--dsw-alias-state-success-primary);background:color-mix(in oklab,var(--dsw-alias-state-success-primary) 12%,transparent)}
.ph-tag[data-tone='warn']{color:var(--dsw-alias-state-warn-primary);background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 12%,transparent)}
.ph-tag[data-tone='danger']{color:var(--dsw-alias-state-error-primary);background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 12%,transparent)}
.ph-card{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ph-row{display:flex;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ph-row:last-child{border-bottom:0}
.ph-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.ph-row-name{font-size:13px;line-height:19px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ph-row-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ph-row-actions{display:flex;align-items:center;gap:8px;flex:none}
.ph-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px;margin-top:12px}
.ph-group-head{margin:18px 0 0;font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.01em}
.ph-group-head:first-child{margin-top:12px}
.ph-entry{display:flex;gap:12px;align-items:flex-start;padding:12px;border-radius:var(--dsw-radius-lg);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);cursor:pointer;text-align:left;font:inherit;color:inherit;width:100%;box-sizing:border-box;min-width:0}
.ph-entry:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.ph-entry:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ph-entry-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.ph-entry-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.ph-entry-name{font-size:13px;line-height:19px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.ph-entry-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ph-entry-meta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ph-entry-action{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.ph-avatar{width:38px;height:38px;flex:none;border-radius:10px;display:grid;place-items:center;font-size:15px;font-weight:600;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);text-transform:uppercase}
.ph-avatar img{width:100%;height:100%;object-fit:cover;display:block}
.ph-avatar[data-size='sm']{width:32px;height:32px;font-size:13px;border-radius:8px}
.ph-empty{padding:34px 16px;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:12px}
.ph-empty-title{font-weight:600;color:var(--dsw-alias-label-primary)}
.ph-banner{margin:12px 0 0;padding:10px 12px;border-radius:var(--dsw-radius-md);border:1px solid color-mix(in oklab,var(--dsw-alias-state-warn-primary) 45%,transparent);background:color-mix(in oklab,var(--dsw-alias-state-warn-primary) 8%,transparent);display:flex;gap:12px;align-items:flex-start;justify-content:space-between}
.ph-banner-text{font-size:12px;line-height:19px;color:var(--dsw-alias-label-primary)}
.ph-banner-col{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.ph-banner-list{margin-top:6px;display:flex;flex-direction:column;gap:2px}
.ph-banner-row{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.ph-banner-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.ph-bridge{margin:14px 0 0;padding:11px 13px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:linear-gradient(180deg,color-mix(in oklab,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1))}
.ph-bridge-head{display:flex;align-items:flex-start;gap:10px;min-width:0}
.ph-bridge-mark{width:28px;height:28px;flex:none;border-radius:8px;display:grid;place-items:center;background:color-mix(in oklab,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-size:15px;line-height:1}
.ph-bridge-copy{flex:1;min-width:0}
.ph-bridge-title{font-size:13px;line-height:19px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ph-bridge-body{margin-top:3px;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.ph-bridge-extra{margin-top:9px}
.ph-bridge-flow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ph-flow-pill{font-size:11px;line-height:20px;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ph-flow-pill[data-tone='brand']{border-color:color-mix(in oklab,var(--dsw-alias-brand-primary) 40%,transparent);background:color-mix(in oklab,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-brand-primary)}
.ph-flow-arrow{font-size:11px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.ph-bridge-note{margin-top:6px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.ph-error{margin:10px 0 0;padding:8px 12px;border-radius:var(--dsw-radius-md);font-size:12px;line-height:19px;color:var(--dsw-alias-state-error-primary);border:1px solid color-mix(in oklab,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in oklab,var(--dsw-alias-state-error-primary) 6%,transparent);word-break:break-word}
.ph-notice{margin:10px 0 0;font-size:12px;line-height:19px;color:var(--dsw-alias-state-success-primary)}
.ph-warn{font-size:12px;line-height:19px;color:var(--dsw-alias-state-warn-primary)}
.ph-mask{position:absolute;inset:0;z-index:60;background:var(--dsw-alias-bg-mask-1,color-mix(in oklab,#000 32%,transparent));display:flex;align-items:flex-start;justify-content:center;padding:clamp(40px,14vh,160px) 16px 16px}
.ph-modal{width:min(460px,100%);max-height:80vh;display:flex;flex-direction:column;border-radius:var(--dsw-radius-lg);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-shadow-lv3);overflow:hidden}
.ph-modal[data-drag='true']{border-color:var(--dsw-alias-brand-primary);background:color-mix(in oklab,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-overlay))}
.ph-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px 10px}
.ph-modal-title{font-size:14px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ph-modal-body{padding:0 16px 4px;display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto}
.ph-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px 16px;flex-wrap:wrap}
.ph-modal-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.ph-drawer-mask{position:absolute;inset:0;z-index:55;background:color-mix(in oklab,#000 24%,transparent)}
.ph-drawer{position:absolute;top:0;right:0;bottom:0;z-index:56;width:min(480px,94vw);background:var(--dsw-alias-bg-overlay);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv3);display:flex;flex-direction:column}
.ph-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ph-drawer-title{font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ph-drawer-body{flex:1;min-height:0;overflow:auto;padding:14px 16px 28px}
.ph-group{margin-bottom:18px}
.ph-group-title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:6px}
.ph-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.ph-field-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);font-weight:500}
.ph-field-hint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.ph-item{display:flex;gap:8px;align-items:baseline;padding:4px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);min-width:0}
.ph-item code{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all;font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Consolas,monospace)}
.ph-kv{display:grid;grid-template-columns:88px 1fr;gap:6px 10px;font-size:12px;line-height:18px}
.ph-kv dt{color:var(--dsw-alias-label-tertiary)}
.ph-kv dd{margin:0;color:var(--dsw-alias-label-primary);min-width:0;word-break:break-word}
.ph-link{color:var(--dsw-alias-button-primary-fill);text-decoration:none;word-break:break-all}
.ph-link:hover{text-decoration:underline}
.ph-diag{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);padding:3px 0}
.ph-diag[data-tone='warn']{color:var(--dsw-alias-state-warn-primary)}
.ph-diag[data-tone='danger']{color:var(--dsw-alias-state-error-primary)}
.ph-switch{position:relative;width:36px;height:20px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;flex:none;padding:0}
.ph-skeleton{height:56px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-skeleton,var(--dsw-alias-bg-layer-2));opacity:.6;margin-top:10px}
@media (max-width:720px){
  .ph-row{flex-wrap:wrap}
  .ph-row-actions{width:100%;justify-content:flex-end}
  .ph-drawer{width:100vw}
  .ph-grid{grid-template-columns:1fr}
}
`;

    function ensureStyles() {
      if (typeof document === 'undefined') return function () {};
      const existing = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
      if (existing !== null) {
        // 重载后新模块实例会命中上一次注入的标签：**覆写内容**而不是提前返回。
        // 提前返回会让页面继续用旧版 CSS（旧 token/旧类名），表现为"布局还在、样式全丢"，
        // 只有整页刷新才恢复——这种"代码明明改了却不生效"最难查。
        existing.textContent = CSS;
        return function () {};
      }
      const tag = document.createElement('style');
      tag.dataset.plugin = STYLE_ID;
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      if (document.head !== null) document.head.appendChild(tag);
      // 不删：HMR 重挂后新模块实例的去重查询会命中它，删掉会让重载后的 UI 裸奔。
      return function () {};
    }

    // ------------------------------------------------------------------- api

    async function callApi(path, { method = 'GET', body } = {}) {
      const init = { method, headers: {}, credentials: 'same-origin' };
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const response = await fetch(`${API}${path}`, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const message = payload?.error?.message ?? `${response.status} ${response.statusText}`;
        const error = new Error(message);
        error.code = payload?.error?.code ?? 'http-error';
        throw error;
      }
      return payload;
    }

    function withCwd(path, cwd) {
      if (!cwd) return path;
      return `${path}${path.includes('?') ? '&' : '?'}cwd=${encodeURIComponent(cwd)}`;
    }

    /** Host 客户端服务（可选）：目录选择器只用来填输入框，缺了也不影响手动输入。 */
    let clientCtx = null;
    function readClientService(name) {
      try {
        const get = clientCtx?.get;
        return typeof get === 'function' ? get.call(clientCtx, name) ?? null : null;
      } catch {
        return null;
      }
    }

    // -------------------------------------------------------- presentation

    const KIND_ORDER = ['skill', 'command', 'agent', 'hook', 'mcp', 'lsp', 'ui'];
    const HUES = [212, 168, 28, 318, 96, 258, 349, 188, 44, 288];

    /** 稳定色相：同一个插件名在任何会话里都是同一个色，避免"随机换色"。 */
    function hueOf(text) {
      let hash = 0;
      const value = String(text ?? '');
      for (let index = 0; index < value.length; index += 1) {
        hash = (hash * 31 + value.charCodeAt(index)) % 100000;
      }
      return HUES[hash % HUES.length];
    }

    function initialOf(name) {
      const text = String(name ?? '').trim();
      if (text === '') return '?';
      const plain = text.replace(/^@/, '');
      return plain.slice(0, 1);
    }

    /** 多语言字段：优先中文，其次英文，最后取第一个非空值。 */
    function pickLocalized(map) {
      if (map === null || typeof map !== 'object') return null;
      const keys = ['zh-CN', 'zh', 'en', 'en-US'];
      for (const key of keys) {
        const value = map[key];
        if (typeof value === 'string' && value.trim() !== '') return value;
      }
      for (const value of Object.values(map)) {
        if (typeof value === 'string' && value.trim() !== '') return value;
      }
      return null;
    }

    function entryTitle(entry) {
      return pickLocalized(entry?.displayNameI18n) ?? entry?.displayName ?? entry?.name ?? '';
    }

    function entryDescription(entry) {
      return pickLocalized(entry?.descriptionI18n) ?? entry?.description ?? '';
    }

    function formatTime(value) {
      if (typeof value !== 'string' || value === '') return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      return date.toLocaleString();
    }

    function sourceLabel(t, source) {
      if (source === null || typeof source !== 'object') return String(source ?? '');
      if (source.kind === 'github') return `github:${source.repo}`;
      if (source.kind === 'git') return source.url;
      if (source.kind === 'url') return source.url;
      if (source.kind === 'directory') return source.path;
      return t('market.sourceDirectory');
    }

    function kindLabel(t, kind) {
      return t(`kind.${kind}`, kind);
    }

    /** 运行期错误里的能力名是投影单元名（skills/commands/hooks/mcp），展示用单数 key。 */
    function runtimeKindLabel(t, kind) {
      const singular = { skills: 'skill', commands: 'command', hooks: 'hook', mcp: 'mcp' }[kind];
      return kindLabel(t, singular ?? kind);
    }

    function categoryLabel(t, category) {
      if (typeof category !== 'string' || category === '') return t('category.uncategorized');
      return t(`category.${category}`, category);
    }

    /** 清单格式徽标：Claude 插件与 ZCode 插件在卡片上需要一个一眼可辨的区分。 */
    function formatLabel(t, format) {
      if (typeof format !== 'string' || format === '') return null;
      return t(`format.${format}`, format);
    }

    function shortPath(path) {
      const parts = String(path ?? '').split(/[\\/]+/).filter(Boolean);
      if (parts.length <= 3) return String(path ?? '');
      return `…/${parts.slice(-2).join('/')}`;
    }

    /** 「刷新」按钮要刷哪些市场：选中单个就刷那个，选「全部」或选中项已消失就刷全部。 */
    function marketplaceSelections(marketplaces, selected) {
      if (selected !== 'all' && marketplaces.some((market) => market.id === selected)) return [selected];
      return marketplaces.map((market) => market.id);
    }

    // ------------------------------------------------------------- components

    function Segmented({ value, options, onChange, disabled }) {
      return h(
        'div',
        { className: 'ph-seg', role: 'tablist' },
        options.map((option) =>
          h(
            'button',
            {
              key: option.value,
              type: 'button',
              role: 'tab',
              'data-active': String(option.value === value),
              'aria-selected': option.value === value,
              disabled: disabled === true,
              onClick: () => onChange(option.value),
            },
            option.label,
          ),
        ),
      );
    }

    function Switch({ checked, onChange, disabled, label }) {
      return h(
        'button',
        {
          type: 'button',
          className: 'ph-switch',
          role: 'switch',
          'aria-checked': checked === true,
          'aria-label': label,
          'data-on': String(checked === true),
          disabled: disabled === true,
          onClick: () => onChange(!checked),
          style:
            checked === true
              ? { background: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' }
              : undefined,
        },
        h('span', {
          'aria-hidden': true,
          style: {
            position: 'absolute',
            top: 2,
            left: checked === true ? 18 : 2,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: 'var(--dsw-shadow-lv1)',
            transition: 'left .12s ease',
          },
        }),
      );
    }

    function ErrorBar({ error }) {
      if (!error) return null;
      return h('div', { className: 'ph-error', role: 'alert' }, error);
    }

    /**
     * 「常规插件 → DSH」过渡说明卡。
     *
     * 当前插件生态里只有 pi / DSH 这类 harness 有真正的插件体系，其他 Agent 的扩展
     * 基本是 MCP 服务器 + 技能 + 钩子的常规组合；本卡把这层定位直接写在页面上，
     * 避免用户把"插件中心"误解成又一个 bundle 商店。折叠状态记在 localStorage，
     * 读写失败（隐私模式/沙箱）只降级为"每次展开"，不影响渲染。
     */
    function BridgeCard({ t }) {
      const [expanded, setExpanded] = useState(() => {
        try {
          return window.localStorage.getItem('plugin-hub:bridge-collapsed') !== '1';
        } catch {
          return true;
        }
      });
      const toggle = () => {
        setExpanded((current) => {
          const next = !current;
          try {
            window.localStorage.setItem('plugin-hub:bridge-collapsed', next ? '0' : '1');
          } catch {
            // 忽略：拿不到存储时只丢失折叠记忆。
          }
          return next;
        });
      };
      return h(
        'div',
        { className: 'ph-bridge', 'data-expanded': String(expanded) },
        h(
          'div',
          { className: 'ph-bridge-head' },
          h('div', { className: 'ph-bridge-mark', 'aria-hidden': true }, '⇄'),
          h(
            'div',
            { className: 'ph-bridge-copy' },
            h('div', { className: 'ph-bridge-title' }, t('bridge.title')),
            expanded ? h('div', { className: 'ph-bridge-body' }, t('bridge.body')) : null,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'ph-btn',
              'data-variant': 'ghost',
              'aria-expanded': expanded,
              onClick: toggle,
            },
            expanded ? t('bridge.collapse') : t('bridge.expand'),
          ),
        ),
        expanded
          ? h(
              'div',
              { className: 'ph-bridge-extra' },
              h(
                'div',
                { className: 'ph-bridge-flow' },
                h('span', { className: 'ph-flow-pill' }, t('bridge.flow.mcp')),
                h('span', { className: 'ph-flow-arrow', 'aria-hidden': true }, '+'),
                h('span', { className: 'ph-flow-pill' }, t('bridge.flow.skill')),
                h('span', { className: 'ph-flow-arrow', 'aria-hidden': true }, '+'),
                h('span', { className: 'ph-flow-pill' }, t('bridge.flow.hook')),
                h('span', { className: 'ph-flow-arrow', 'aria-hidden': true }, '→'),
                h('span', { className: 'ph-flow-pill', 'data-tone': 'brand' }, t('bridge.flow.bridge')),
                h('span', { className: 'ph-flow-arrow', 'aria-hidden': true }, '→'),
                h('span', { className: 'ph-flow-pill', 'data-tone': 'brand' }, t('bridge.flow.target')),
              ),
              h('div', { className: 'ph-bridge-note' }, t('bridge.note')),
            )
          : null,
      );
    }

    /** 信任分层状态文案（契约 §1.6：trusted / untrusted / not-applicable）。 */
    function layerStateLabel(t, state) {
      if (state === 'trusted') return t('trust.state.trusted');
      if (state === 'untrusted') return t('trust.state.untrusted');
      return t('trust.state.notApplicable');
    }

    /** 冲突里「让位给谁」的来源文案。 */
    function conflictSourceLabel(t, source) {
      return source === 'project' ? t('mcp.conflict.source.project') : t('mcp.conflict.source.global');
    }

    /**
     * MCP 重名冲突横幅（插件管理页）。
     *
     * 只显示数量与一句话解释，明细按需展开——冲突通常只有一两条，常驻明细会把
     * 已安装列表挤下去。数据来自 overview.mcpConflicts（投影运行时 + dry-run 合并）。
     */
    function McpConflictBanner({ t, conflicts }) {
      const [expanded, setExpanded] = useState(false);
      if (!Array.isArray(conflicts) || conflicts.length === 0) return null;
      return h(
        'div',
        { className: 'ph-banner', role: 'status' },
        h(
          'div',
          { className: 'ph-banner-col' },
          h('div', { className: 'ph-banner-text', style: { fontWeight: 600 } }, t('mcp.conflict.title')),
          h('div', { className: 'ph-banner-text' }, t('mcp.conflict.body')),
          h('div', { className: 'ph-muted' }, t('mcp.conflict.count').replace('{n}', String(conflicts.length))),
          expanded
            ? h(
                'div',
                { className: 'ph-banner-list' },
                conflicts.map((item, index) =>
                  h(
                    'div',
                    { className: 'ph-banner-row', key: `${item.pluginId}:${item.serverName}:${item.source}:${index}` },
                    t('mcp.conflict.row')
                      .replace('{plugin}', item.pluginId)
                      .replace('{server}', item.serverName)
                      .replace('{source}', conflictSourceLabel(t, item.source)),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'ph-banner-actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'ph-btn',
              'data-variant': 'ghost',
              'aria-expanded': expanded,
              onClick: () => setExpanded((current) => !current),
            },
            expanded ? t('mcp.conflict.collapse') : t('mcp.conflict.expand'),
          ),
        ),
      );
    }

    function Avatar({ name, icon, size }) {
      const [broken, setBroken] = useState(false);
      const hue = hueOf(name);
      const showIcon = typeof icon === 'string' && icon !== '' && !broken;
      return h(
        'span',
        {
          className: 'ph-avatar',
          'data-size': size,
          'aria-hidden': true,
          style: {
            background: `color-mix(in oklab, hsl(${hue} 62% 52%) 16%, var(--dsw-alias-bg-layer-2))`,
            borderColor: `color-mix(in oklab, hsl(${hue} 62% 52%) 32%, transparent)`,
            color: `hsl(${hue} 58% 46%)`,
          },
        },
        showIcon
          ? h('img', { src: icon, alt: '', loading: 'lazy', onError: () => setBroken(true) })
          : initialOf(name),
      );
    }

    /** 数据加载：overview + 可选的市场条目。 */
    function useHub(cwd) {
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [loading, setLoading] = useState(true);
      const [notice, setNotice] = useState(null);
      const timer = useRef(null);

      const load = useCallback(async () => {
        setLoading(true);
        try {
          const next = await callApi(withCwd('/overview', cwd));
          setData(next);
          setError(null);
        } catch (loadError) {
          setError(String(loadError.message ?? loadError));
        } finally {
          setLoading(false);
        }
      }, [cwd]);

      useEffect(() => {
        load();
      }, [load]);

      const notify = useCallback((text) => {
        setNotice(text);
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setNotice(null), 2600);
      }, []);

      useEffect(
        () => () => {
          if (timer.current !== null) clearTimeout(timer.current);
        },
        [],
      );

      return { data, error, loading, reload: load, setError, notice, notify };
    }

    function useCwd() {
      const [cwd, setCwd] = useState(null);
      useEffect(() => {
        let alive = true;
        callApi('/current-workspace')
          .then((value) => {
            if (alive) setCwd(typeof value?.cwd === 'string' && value.cwd !== '' ? value.cwd : null);
          })
          .catch(() => {
            if (alive) setCwd(null);
          });
        return () => {
          alive = false;
        };
      }, []);
      return cwd;
    }

    // ------------------------------------------------------------------ pages

    function HubBody({ variant, t }) {
      const cwd = useCwd();
      const [scope, setScope] = useState('user');
      const [tab, setTab] = useState('manage');
      const tabTouched = useRef(false);
      const tabDecided = useRef(false);
      const [busy, setBusy] = useState(null);
      const [confirmId, setConfirmId] = useState(null);
      const [selectedMarket, setSelectedMarket] = useState('all');
      const [query, setQuery] = useState('');
      const [category, setCategory] = useState('all');
      const [entries, setEntries] = useState([]);
      const [entryErrors, setEntryErrors] = useState([]);
      const [entryDiagnostics, setEntryDiagnostics] = useState([]);
      const [entryLoading, setEntryLoading] = useState(false);
      const [entryError, setEntryError] = useState(null);
      const [addOpen, setAddOpen] = useState(false);
      const [installForm, setInstallForm] = useState('');
      const [drawer, setDrawer] = useState(null);
      const { data, error, loading, reload, setError, notice, notify } = useHub(scope === 'workspace' ? cwd : null);

      const installed = data?.installed ?? [];
      const marketplaces = data?.marketplaces ?? [];
      const workspaceTrust = data?.trust ?? null;
      // 插件 MCP 与全局/项目重名的条目（overview.mcpConflicts）：管理页横幅 + 详情诊断行。
      const mcpConflicts = Array.isArray(data?.mcpConflicts) ? data.mcpConflicts : [];
      // 运行期挂载失败（overview.projectionErrors）：每插件每能力最近一条。
      const runtimeErrors = Array.isArray(data?.projectionErrors) ? data.projectionErrors : [];
      const effectiveById = useMemo(() => {
        const map = new Map();
        for (const item of data?.effective?.plugins ?? []) map.set(item.id, item);
        return map;
      }, [data]);

      // 首次拿到数据后决定落在哪个标签：装过插件先看管理，空环境先看市场。
      // 只在第一次生效：安装/卸载会改变 installed 数量，但用户已经看到页面了，
      // 不应该因为"现在有插件了"就突然把市场标签切走。
      useEffect(() => {
        if (data === null || tabTouched.current || tabDecided.current) return;
        tabDecided.current = true;
        setTab(installed.length > 0 ? 'manage' : 'market');
      }, [data, installed.length]);

      const run = useCallback(
        async (key, operation, successText) => {
          setBusy(key);
          setError(null);
          try {
            await operation();
            if (successText) notify(successText);
            return true;
          } catch (runError) {
            setError(`${t('error.prefix')}${runError.message ?? runError}`);
            return false;
          } finally {
            setBusy(null);
          }
        },
        [notify, setError, t],
      );

      const loadEntries = useCallback(
        async (marketId) => {
          setEntryLoading(true);
          setEntryError(null);
          try {
            const body = marketId === 'all' ? {} : { id: marketId };
            const payload = await callApi('/market/entries', { method: 'POST', body });
            setEntries(Array.isArray(payload?.entries) ? payload.entries : []);
            setEntryErrors(Array.isArray(payload?.errors) ? payload.errors : []);
            setEntryDiagnostics(Array.isArray(payload?.diagnostics) ? payload.diagnostics : []);
            if (typeof payload?.error === 'string' && payload.error !== '') setEntryError(payload.error);
          } catch (entriesError) {
            setEntries([]);
            setEntryErrors([]);
            setEntryDiagnostics([]);
            setEntryError(String(entriesError.message ?? entriesError));
          } finally {
            setEntryLoading(false);
          }
        },
        [],
      );

      // 市场标签激活 / 切换市场 / 市场数量变化时重新拉条目。
      useEffect(() => {
        if (tab !== 'market') return;
        if (marketplaces.length === 0) {
          setEntries([]);
          return;
        }
        loadEntries(selectedMarket);
      }, [tab, selectedMarket, marketplaces.length, loadEntries]);

      const refreshAll = useCallback(async () => {
        const ids = marketplaceSelections(marketplaces, selectedMarket);
        const failures = [];
        for (const id of ids) {
          try {
            await callApi('/market/refresh', { method: 'POST', body: { id } });
          } catch (refreshError) {
            failures.push(`${id}: ${refreshError.message ?? refreshError}`);
          }
        }
        await reload();
        await loadEntries(selectedMarket);
        if (failures.length > 0) throw new Error(failures.join('；'));
      }, [loadEntries, marketplaces, reload, selectedMarket]);

      const enable = (plugin, nextEnabled) => {
        const body = { id: plugin.id, enabled: nextEnabled, scope };
        if (scope === 'workspace') body.cwd = cwd;
        return run(
          `enable:${plugin.id}`,
          async () => {
            await callApi('/enable', { method: 'POST', body });
            await reload();
          },
          t('notice.saved'),
        );
      };

      const inherit = (plugin) =>
        run(
          `inherit:${plugin.id}`,
          async () => {
            await callApi('/enable', { method: 'POST', body: { id: plugin.id, enabled: null, scope: 'workspace', cwd } });
            await reload();
          },
          t('notice.saved'),
        );

      const uninstall = (plugin) =>
        run(
          `uninstall:${plugin.id}`,
          async () => {
            await callApi('/uninstall', { method: 'POST', body: { id: plugin.id } });
            await reload();
            if (tab === 'market') await loadEntries(selectedMarket);
          },
          t('notice.uninstalled'),
        );

      const trust = () =>
        run(
          'trust',
          async () => {
            await callApi('/trust', { method: 'POST', body: { cwd } });
            await reload();
          },
          t('notice.trusted'),
        );

      const removeMarket = (market) =>
        run(
          `remove:${market.id}`,
          async () => {
            await callApi('/market/remove', { method: 'POST', body: { id: market.id } });
            if (selectedMarket === market.id) setSelectedMarket('all');
            setConfirmId(null);
            await reload();
            await loadEntries(selectedMarket === market.id ? 'all' : selectedMarket);
          },
          t('notice.marketRemoved'),
        );

      const installFromMarket = (entry) =>
        run(
          `install:${entry.id}`,
          async () => {
            await callApi('/install', { method: 'POST', body: { marketplace: entry.marketplace, name: entry.name } });
            await reload();
            await loadEntries(selectedMarket);
          },
          t('notice.installed'),
        );

      const installFromPath = () =>
        run(
          'install:path',
          async () => {
            const value = installForm.trim();
            if (value === '') throw new Error('a directory or Git URL is required');
            await callApi('/install', { method: 'POST', body: { source: installSourceOf(value) } });
            setInstallForm('');
            await reload();
          },
          t('notice.installed'),
        );

      const saveOptions = (pluginId, options, scopeId) =>
        run(
          `options:${pluginId}`,
          async () => {
            const body = { id: pluginId, options, scope: scopeId };
            if (scopeId === 'workspace') body.cwd = cwd;
            await callApi('/options', { method: 'POST', body });
            await reload();
          },
          t('detail.savedOptions'),
        );

      /** 切回缓存里的另一个版本：服务端只改安装记录，投影层下一次 pre-step 自动重挂。 */
      const switchVersion = (pluginId, version) =>
        run(
          `switch:${pluginId}`,
          async () => {
            await callApi('/switch', { method: 'POST', body: { id: pluginId, version } });
            await reload();
            if (tab === 'market') await loadEntries(selectedMarket);
          },
          t('notice.switched'),
        );

      const header = h(
        'div',
        { className: 'ph-header' },
        h(
          'div',
          { className: 'ph-head-row' },
          h(
            'div',
            { style: { minWidth: 0 } },
            h('h1', { className: 'ph-title' }, t('title')),
            h('p', { className: 'ph-subtitle' }, t('subtitle')),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h(Segmented, {
              value: scope,
              disabled: loading,
              options: [
                { value: 'user', label: t('scope.user') },
                { value: 'workspace', label: t('scope.workspace') },
              ],
              onChange: (next) => {
                if (next === 'workspace' && !cwd) {
                  notify(t('scope.hint'));
                  return;
                }
                setScope(next);
              },
            }),
            scope === 'workspace' && cwd
              ? h('span', { className: 'ph-muted', title: cwd }, `${t('scope.projectPath')}: ${shortPath(cwd)}`)
              : null,
          ),
        ),
        workspaceTrust && workspaceTrust.required && !workspaceTrust.trusted
          ? h(
              'div',
              { className: 'ph-banner', role: 'status' },
              h(
                'div',
                { className: 'ph-banner-col' },
                h('div', { className: 'ph-banner-text', style: { fontWeight: 600 } }, t('trust.title')),
                h('div', { className: 'ph-banner-text' }, t('trust.body')),
                workspaceTrust.layers
                  ? h(
                      'div',
                      { className: 'ph-banner-text' },
                      t('trust.layers')
                        .replace('{mcp}', layerStateLabel(t, workspaceTrust.layers.mcp))
                        .replace('{plugins}', layerStateLabel(t, workspaceTrust.layers.plugins)),
                    )
                  : null,
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ph-btn',
                  'data-variant': 'primary',
                  disabled: busy === 'trust' || !cwd,
                  onClick: trust,
                },
                t('trust.button'),
              ),
            )
          : null,
        h(ErrorBar, { error }),
        notice ? h('div', { className: 'ph-notice', role: 'status' }, notice) : null,
        h(BridgeCard, { t }),
        h(
          'div',
          { className: 'ph-tabs', role: 'tablist' },
          tabButton('manage', t('tab.manage'), installed.length),
          tabButton('market', t('tab.market'), marketplaces.length),
        ),
      );

      function tabButton(id, label, count) {
        return h(
          'button',
          {
            type: 'button',
            className: 'ph-tab',
            role: 'tab',
            'aria-selected': tab === id,
            'data-active': String(tab === id),
            onClick: () => {
              tabTouched.current = true;
              setTab(id);
            },
          },
          label,
          count > 0 ? h('span', { className: 'ph-tab-count' }, String(count)) : null,
        );
      }

      // ----------------------------------------------------------- manage tab

      function renderInstalledRow(plugin) {
        const effective = effectiveById.get(plugin.id) ?? null;
        const enabled = effective ? effective.enabled === true : true;
        const source = effective?.enabledSource ?? 'default';
        const counts = effective?.components ?? [];
        const summary = counts
          .filter((item) => item.count > 0)
          .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))
          .map((item) => `${kindLabel(t, item.kind)} ${item.count}`)
          .join(' · ');
        const rowBusy = busy !== null && busy.endsWith(`:${plugin.id}`);
        const pluginRuntimeErrors = runtimeErrors.filter((item) => item?.pluginId === plugin.id);
        return h(
          'div',
          { className: 'ph-row', key: plugin.id },
          h(Avatar, { name: plugin.name, size: 'sm' }),
          h(
            'div',
            { className: 'ph-row-main' },
            h(
              'div',
              { className: 'ph-row-name' },
              plugin.name,
              h('span', { className: 'ph-tag' }, `v${plugin.version ?? '0.0.0'}`),
              source === 'workspace'
                ? h('span', { className: 'ph-tag', 'data-tone': 'brand' }, t('manage.source.workspace'))
                : null,
              source === 'user' && scope === 'workspace' ? h('span', { className: 'ph-tag' }, t('manage.source.user')) : null,
              effective === null ? h('span', { className: 'ph-tag', 'data-tone': 'warn' }, t('manage.missing')) : null,
              // 运行期挂载失败：不是"包缺失"，而是包在但某一类能力没挂上（红点 + 悬停明细）。
              pluginRuntimeErrors.length > 0
                ? h(
                    'span',
                    {
                      className: 'ph-tag',
                      'data-tone': 'danger',
                      title: pluginRuntimeErrors
                        .map((item) => `${item.kind}${item.serverName ? `/${item.serverName}` : ''} @ ${item.cwd}: ${item.message}`)
                        .join('\n'),
                    },
                    t('manage.runtimeFailed').replace('{n}', String(pluginRuntimeErrors.length)),
                  )
                : null,
            ),
            h(
              'div',
              { className: 'ph-row-meta' },
              h('span', null, `${t('common.marketplace')}: ${plugin.marketplace}`),
              summary ? h('span', null, summary) : null,
            ),
          ),
          h(
            'div',
            { className: 'ph-row-actions' },
            scope === 'workspace'
              ? h(
                  'button',
                  { type: 'button', className: 'ph-btn', disabled: rowBusy, onClick: () => inherit(plugin) },
                  t('manage.inherit'),
                )
              : null,
            h(Switch, {
              checked: enabled,
              disabled:
                rowBusy ||
                (scope === 'workspace' && (!cwd || (workspaceTrust && workspaceTrust.required && !workspaceTrust.trusted))),
              label: t('manage.enable'),
              onChange: (next) => enable(plugin, next),
            }),
            h(
              'button',
              {
                type: 'button',
                className: 'ph-btn',
                disabled: rowBusy,
                onClick: () => setDrawer({ kind: 'installed', id: plugin.id }),
              },
              t('manage.detail'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'ph-btn',
                'data-variant': confirmId === plugin.id ? 'danger' : undefined,
                disabled: rowBusy,
                onClick: () => {
                  if (confirmId === plugin.id) {
                    setConfirmId(null);
                    uninstall(plugin);
                  } else {
                    setConfirmId(plugin.id);
                  }
                },
              },
              confirmId === plugin.id ? t('manage.confirmUninstall') : t('manage.uninstall'),
            ),
          ),
        );
      }

      const manageTab = h(
        'div',
        null,
        h(McpConflictBanner, { t, conflicts: mcpConflicts }),
        h(
          'section',
          { className: 'ph-section' },
          h(
            'div',
            { className: 'ph-section-head' },
            h('span', { className: 'ph-section-title' }, t('manage.title')),
            h('span', { className: 'ph-muted' }, t('manage.count').replace('{n}', String(installed.length))),
          ),
          h(
            'div',
            { className: 'ph-card' },
            loading && installed.length === 0
              ? h('div', { className: 'ph-empty' }, t('common.loading'))
              : installed.length === 0
                ? h(
                    'div',
                    { className: 'ph-empty' },
                    h('div', { className: 'ph-empty-title' }, t('manage.empty')),
                    h('div', null, t('manage.emptyHint')),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'ph-btn',
                        'data-variant': 'primary',
                        onClick: () => {
                          tabTouched.current = true;
                          setTab('market');
                        },
                      },
                      t('tab.market'),
                    ),
                  )
                : installed.map((plugin) => renderInstalledRow(plugin)),
          ),
        ),
        h(
          'section',
          { className: 'ph-section' },
          h('div', { className: 'ph-section-head' }, h('span', { className: 'ph-section-title' }, t('install.title'))),
          h(
            'div',
            { className: 'ph-card', style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
            h(
              'div',
              { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h('input', {
                className: 'ph-input',
                style: { flex: 1, minWidth: 220 },
                placeholder: t('install.placeholder'),
                value: installForm,
                onChange: (event) => setInstallForm(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && busy !== 'install:path') installFromPath();
                },
              }),
              chooseDirectoryButton(t, (path) => setInstallForm(path), busy === 'install:path', t('install.chooseDirectory')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ph-btn',
                  'data-variant': 'primary',
                  disabled: busy === 'install:path' || installForm.trim() === '',
                  onClick: installFromPath,
                },
                busy === 'install:path' ? t('common.loading') : t('install.button'),
              ),
            ),
            h('div', { className: 'ph-muted' }, t('install.hint')),
          ),
        ),
      );

      // ----------------------------------------------------------- market tab

      const selected = marketplaces.find((market) => market.id === selectedMarket) ?? null;
      // 「全部」徽标是跨市场总数：选中单个市场时 entries 只有那一个市场的条目，
      // 直接拿 entries.length 会显示成该市场的数量，和「全部」的语义不符。
      const allCount =
        selected === null
          ? entries.length
          : marketplaces.reduce((sum, market) => sum + (Number(market.pluginCount) || 0), 0);
      const visibleEntries = entries.filter((entry) => {
        if (category !== 'all' && (entry.category ?? '') !== category) return false;
        const text = query.trim().toLowerCase();
        if (text === '') return true;
        const haystack = [entry.name, entryTitle(entry), entryDescription(entry), entry.category, ...(entry.keywords ?? [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(text);
      });
      const categories = useMemo(() => {
        const found = [];
        for (const entry of entries) {
          const value = typeof entry.category === 'string' && entry.category !== '' ? entry.category : 'uncategorized';
          if (!found.includes(value)) found.push(value);
        }
        return found;
      }, [entries]);

      /**
       * 未选分类时按类别分组（与 ZCode 商店一致）：50 条官方插件平铺太难找，
       * 分类标题能把"金融 / 开发者工具 / 生产力"这些段落立起来。选了具体分类就只留一个网格。
       */
      const entryGroups = useMemo(() => {
        const ordered = [...visibleEntries].sort((left, right) => {
          const leftTitle = entryTitle(left);
          const rightTitle = entryTitle(right);
          return leftTitle.localeCompare(rightTitle, 'zh-Hans-CN');
        });
        if (category !== 'all' || categories.length <= 1) return [{ key: 'flat', items: ordered }];
        const groups = [];
        for (const entry of ordered) {
          const key = typeof entry.category === 'string' && entry.category !== '' ? entry.category : 'uncategorized';
          let group = groups.find((item) => item.key === key);
          if (group === undefined) {
            group = { key, items: [] };
            groups.push(group);
          }
          group.items.push(entry);
        }
        // 分类顺序跟随 categories（catalog 里出现的顺序），"未分类" 永远垫底。
        groups.sort((left, right) => {
          if (left.key === 'uncategorized') return 1;
          if (right.key === 'uncategorized') return -1;
          return categories.indexOf(left.key) - categories.indexOf(right.key);
        });
        return groups;
      }, [visibleEntries, category, categories]);

      const marketHeaderExtra =
        selected === null
          ? h(
              'button',
              {
                type: 'button',
                className: 'ph-btn',
                disabled: busy === 'refresh:all' || marketplaces.length === 0,
                onClick: () =>
                  run('refresh:all', refreshAll, t('notice.refreshed')),
              },
              busy === 'refresh:all' ? t('common.loading') : t('market.refreshAll'),
            )
          : h(
              'div',
              { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ph-btn',
                  disabled: busy === `refresh:${selected.id}`,
                  onClick: () =>
                    run(
                      `refresh:${selected.id}`,
                      async () => {
                        await callApi('/market/refresh', { method: 'POST', body: { id: selected.id } });
                        await reload();
                        await loadEntries(selected.id);
                      },
                      t('notice.refreshed'),
                    ),
                },
                busy === `refresh:${selected.id}` ? t('common.loading') : t('market.refresh'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ph-btn',
                  'data-variant': confirmId === selected.id ? 'danger' : undefined,
                  disabled: busy === `remove:${selected.id}`,
                  onClick: () => {
                    if (confirmId === selected.id) removeMarket(selected);
                    else setConfirmId(selected.id);
                  },
                },
                confirmId === selected.id ? t('market.confirmRemove') : t('market.remove'),
              ),
            );

      const marketTab = h(
        'div',
        null,
        h(
          'div',
          { className: 'ph-toolbar' },
          h(
            'div',
            { className: 'ph-search' },
            h('input', {
              className: 'ph-input',
              placeholder: t('market.search'),
              value: query,
              onChange: (event) => setQuery(event.target.value),
              'aria-label': t('market.search'),
            }),
          ),
          h(
            'button',
            { type: 'button', className: 'ph-btn', 'data-variant': 'primary', onClick: () => setAddOpen(true) },
            `+ ${t('market.add')}`,
          ),
        ),
        marketplaces.length === 0
          ? h(
              'div',
              { className: 'ph-empty' },
              h('div', { className: 'ph-empty-title' }, t('market.empty')),
              h('div', null, t('market.emptyHint')),
              h(
                'button',
                { type: 'button', className: 'ph-btn', 'data-variant': 'primary', onClick: () => setAddOpen(true) },
                `+ ${t('market.add')}`,
              ),
            )
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'ph-chips', role: 'tablist' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ph-chip',
                    'data-active': String(selectedMarket === 'all'),
                    onClick: () => {
                      setSelectedMarket('all');
                      setCategory('all');
                    },
                  },
                  t('market.all'),
                  h('span', { className: 'ph-chip-count' }, String(allCount)),
                ),
                marketplaces.map((market) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ph-chip',
                      key: market.id,
                      'data-active': String(selectedMarket === market.id),
                      title: sourceLabel(t, market.source),
                      onClick: () => {
                        setSelectedMarket(market.id);
                        setCategory('all');
                      },
                    },
                    market.name ?? market.id,
                    h('span', { className: 'ph-chip-count' }, String(market.pluginCount ?? 0)),
                    // 过期/上次抓取失败：chip 上给一个小标记，悬停看完整错误。
                    market.lastError
                      ? h('span', { className: 'ph-tag', 'data-tone': 'warn', title: market.lastError }, t('market.failedShort'))
                      : market.stale === true
                        ? h('span', { className: 'ph-tag', title: t('market.staleTitle') }, t('market.staleShort'))
                        : null,
                  ),
                ),
              ),
              h(
                'div',
                { className: 'ph-section-head', style: { marginTop: 12 } },
                h(
                  'div',
                  { style: { minWidth: 0 } },
                  h('div', { className: 'ph-section-title' }, selected === null ? t('market.title') : selected.name ?? selected.id),
                  h(
                    'div',
                    { className: 'ph-muted' },
                    selected === null
                      ? t('market.subtitle')
                      : [
                          sourceLabel(t, selected.source),
                          selected.lastUpdated
                            ? t('market.updatedAt').replace('{time}', formatTime(selected.lastUpdated))
                            : null,
                          selected.lastError
                            ? t('market.lastErrorLabel').replace('{message}', selected.lastError)
                            : selected.stale === true
                              ? t('market.staleShort')
                              : null,
                        ]
                          .filter(Boolean)
                          .join(' · '),
                  ),
                ),
                marketHeaderExtra,
              ),
              entryErrors.length > 0
                ? entryErrors.map((item) =>
                    h(
                      'div',
                      { className: 'ph-error', key: item.marketplace },
                      `${item.marketplace} — ${t('market.indexError')}: ${item.message}`,
                    ),
                  )
                : null,
              entryError !== null ? h(ErrorBar, { error: `${t('error.prefix')}${entryError}` }) : null,
              entryDiagnostics.length > 0
                ? h(
                    'div',
                    { className: 'ph-warn', style: { marginTop: 8 } },
                    t('market.diagnostics').replace('{n}', String(entryDiagnostics.length)),
                  )
                : null,
              entryLoading && entries.length === 0
                ? h('div', { className: 'ph-skeleton' })
                : entries.length === 0
                  ? entryError !== null
                    ? null
                    : h('div', { className: 'ph-empty' }, t('market.entriesEmpty'))
                  : h(
                      React.Fragment,
                      null,
                      categories.length > 1
                        ? h(
                            'div',
                            { className: 'ph-chips', 'data-scroll': 'true', role: 'tablist' },
                            categoryChip('all', t('market.all')),
                            categories.map((item) => categoryChip(item, categoryLabel(t, item))),
                          )
                        : null,
                      visibleEntries.length === 0
                        ? h('div', { className: 'ph-empty' }, t('market.searchEmpty'))
                        : entryGroups.map((group) =>
                            h(
                              'div',
                              { key: group.key },
                              group.key === 'flat'
                                ? null
                                : h('div', { className: 'ph-group-head' }, categoryLabel(t, group.key)),
                              h(
                                'div',
                                { className: 'ph-grid' },
                                group.items.map((entry) => renderEntry(entry)),
                              ),
                            ),
                          ),
                    ),
            ),
      );

      function categoryChip(value, label) {
        return h(
          'button',
          {
            type: 'button',
            className: 'ph-chip',
            key: `category:${value}`,
            'data-active': String(category === value),
            onClick: () => setCategory(value),
          },
          label,
        );
      }

      function renderEntry(entry) {
        const busyKey = `install:${entry.id}`;
        const installing = busy === busyKey;
        return h(
          'div',
          {
            className: 'ph-entry',
            key: `${entry.marketplace}:${entry.name}`,
            role: 'button',
            tabIndex: 0,
            onClick: () => setDrawer({ kind: 'market', entry }),
            onKeyDown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setDrawer({ kind: 'market', entry });
              }
            },
          },
          h(Avatar, { name: entry.name, icon: entry.icon }),
          h(
            'div',
            { className: 'ph-entry-body' },
            h(
              'div',
              { className: 'ph-entry-head' },
              h('span', { className: 'ph-entry-name', title: entryTitle(entry) }, entryTitle(entry)),
              entry.version ? h('span', { className: 'ph-tag' }, `v${entry.version}`) : null,
              entry.publisherType === 'official'
                ? h('span', { className: 'ph-tag', 'data-tone': 'brand' }, t('publisher.official'))
                : entry.publisherType === 'community'
                  ? h('span', { className: 'ph-tag' }, t('publisher.community'))
                  : null,
              entry.installed && entry.updatable
                ? h('span', { className: 'ph-tag', 'data-tone': 'success' }, `${t('market.update')} → v${entry.version}`)
                : null,
            ),
            entryDescription(entry) ? h('div', { className: 'ph-entry-desc' }, entryDescription(entry)) : null,
            h(
              'div',
              { className: 'ph-entry-meta' },
              (entry.componentTypes ?? []).map((kind) =>
                h('span', { className: 'ph-tag', key: `kind:${kind}` }, kindLabel(t, kind)),
              ),
              entry.author ? h('span', { title: t('detail.publisher') }, entry.author) : null,
              selected === null ? h('span', null, entry.marketplace) : null,
              entry.category ? h('span', null, categoryLabel(t, entry.category)) : null,
            ),
          ),
          h(
            'div',
            { className: 'ph-entry-action' },
            entry.installed
              ? h(
                  React.Fragment,
                  null,
                  h('span', { className: 'ph-tag', 'data-tone': 'success' }, t('market.installed')),
                  entry.updatable
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'ph-btn',
                          'data-variant': 'primary',
                          disabled: installing || busy !== null,
                          onClick: (event) => {
                            event.stopPropagation();
                            installFromMarket(entry);
                          },
                        },
                        installing ? t('market.installing') : t('market.update'),
                      )
                    : null,
                )
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'ph-btn',
                    'data-variant': 'primary',
                    disabled: installing || busy !== null,
                    onClick: (event) => {
                      event.stopPropagation();
                      installFromMarket(entry);
                    },
                  },
                  installing ? t('market.installing') : t('market.install'),
                ),
          ),
        );
      }

      const body = h(
        'div',
        { className: 'ph-scroll' },
        h('div', { className: 'ph-content' }, header, tab === 'manage' ? manageTab : marketTab),
      );

      return h(
        'div',
        { className: variant === 'panel' ? 'ph-page ph-panel' : 'ph-page' },
        body,
        addOpen
          ? h(AddMarketplaceDialog, {
              t,
              onClose: () => setAddOpen(false),
              onAdded: async (marketId) => {
                setAddOpen(false);
                setSelectedMarket(marketId);
                await reload();
                await loadEntries(marketId);
                notify(t('notice.marketAdded'));
              },
            })
          : null,
        drawer !== null
          ? h(PluginDrawer, {
              t,
              state: drawer,
              scope,
              cwd,
              conflicts: mcpConflicts,
              runtimeErrors,
              installedById: new Map(installed.map((item) => [item.id, item])),
              effectiveById,
              busy,
              onClose: () => setDrawer(null),
              onInstall: async (entry) => {
                if (await installFromMarket(entry)) setDrawer(null);
              },
              onSaveOptions: (pluginId, options, scopeId) => saveOptions(pluginId, options, scopeId),
              onSwitchVersion: (pluginId, version) => switchVersion(pluginId, version),
            })
          : null,
      );
    }

    // ---------------------------------------------------------------- dialog

    /** 添加插件市场：单输入框 + 拖放 + 目录选择，与 ZCode 的对话框同一套收口方式。 */
    function AddMarketplaceDialog({ t, onClose, onAdded }) {
      const [source, setSource] = useState('');
      const [error, setLocalError] = useState(null);
      const [adding, setAdding] = useState(false);
      const [drag, setDrag] = useState(false);
      const inputRef = useRef(null);

      useEffect(() => {
        if (inputRef.current !== null) inputRef.current.focus();
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose]);

      const submit = async () => {
        const value = source.trim();
        if (value === '' || adding) return;
        setAdding(true);
        setLocalError(null);
        try {
          const payload = await callApi('/market/add', { method: 'POST', body: { source: value } });
          await onAdded(payload?.marketplace?.id ?? 'all');
        } catch (addError) {
          setLocalError(String(addError.message ?? addError));
        } finally {
          setAdding(false);
        }
      };

      const choose = async () => {
        const picked = await pickDirectory();
        if (typeof picked === 'string' && picked !== '') setSource(picked);
      };

      return h(
        React.Fragment,
        null,
        h(
          'div',
          {
            className: 'ph-mask',
            onClick: (event) => {
              if (event.target === event.currentTarget) onClose();
            },
          },
          h(
            'div',
            {
              className: 'ph-modal',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': t('market.addTitle'),
              'data-drag': String(drag),
              onClick: (event) => event.stopPropagation(),
              onDragOver: (event) => {
                event.preventDefault();
                setDrag(true);
              },
              onDragLeave: (event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setDrag(false);
              },
              onDrop: (event) => {
                event.preventDefault();
                setDrag(false);
                const path = droppedPath(event);
                if (path !== null) setSource(path);
              },
            },
            h(
              'div',
              { className: 'ph-modal-head' },
              h('span', { className: 'ph-modal-title' }, t('market.addTitle')),
              h('button', { type: 'button', className: 'ph-iconbtn', 'aria-label': t('common.close'), onClick: onClose }, '×'),
            ),
            h(
              'div',
              { className: 'ph-modal-body' },
              h('input', {
                ref: inputRef,
                className: 'ph-input',
                placeholder: t('market.addPlaceholder'),
                value: source,
                onChange: (event) => setSource(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && !event.nativeEvent?.isComposing) submit();
                },
              }),
              h('div', { className: 'ph-modal-hint' }, t('market.addHint')),
              h('div', { className: 'ph-modal-hint' }, t('market.dropHint')),
              error !== null ? h(ErrorBar, { error }) : null,
            ),
            h(
              'div',
              { className: 'ph-modal-foot' },
              h('button', { type: 'button', className: 'ph-btn', onClick: choose }, t('market.chooseDirectory')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ph-btn',
                  'data-variant': 'primary',
                  disabled: adding || source.trim() === '',
                  onClick: submit,
                },
                adding ? t('common.loading') : `+ ${t('market.add')}`,
              ),
            ),
          ),
        ),
      );
    }

    /** 目录选择：走宿主 client 服务；Web 端没有该服务时按钮点击给不出路径，属预期降级。 */
    async function pickDirectory() {
      const service = readClientService('uiWorkspace');
      if (service === null || typeof service.pickDirectory !== 'function') return null;
      try {
        const value = await service.pickDirectory();
        return typeof value === 'string' ? value : null;
      } catch {
        return null;
      }
    }

    function droppedPath(event) {
      const transfer = event?.dataTransfer;
      if (transfer === null || transfer === undefined) return null;
      const file = transfer.files?.[0];
      if (file !== undefined && file !== null) {
        if (typeof file.path === 'string' && file.path !== '') return file.path;
        if (typeof file.name === 'string' && file.name !== '') return file.name;
      }
      try {
        const text = transfer.getData('text/plain');
        if (typeof text === 'string' && text.trim() !== '') return text.trim();
      } catch {
        /* 某些环境禁止读 dataTransfer */
      }
      return null;
    }

    function chooseDirectoryButton(t, apply, disabled, label) {
      return h(
        'button',
        {
          type: 'button',
          className: 'ph-btn',
          disabled: disabled === true,
          onClick: async () => {
            const picked = await pickDirectory();
            if (typeof picked === 'string' && picked !== '') apply(picked);
          },
        },
        label ?? t('market.chooseDirectory'),
      );
    }

    /** 把一行文本变成 /install 接受的 source：Git / 归档 / 目录。 */
    function installSourceOf(value) {
      const text = value.trim();
      if (/^(gh|github):/i.test(text)) {
        return { kind: 'git', url: `https://github.com/${text.replace(/^(gh|github):/i, '')}.git` };
      }
      if (/^git@[^\s:]+:.+$/i.test(text)) return { kind: 'git', url: text };
      if (/^https?:\/\//i.test(text)) {
        if (/github\.com\/[^/]+\/[^/]+$/i.test(text) || /\.git$/i.test(text)) return { kind: 'git', url: text };
        return { kind: 'archive', url: text };
      }
      if (/^[^\s/\\]+(\/[^\s/\\]+)+$/.test(text) && !/^[A-Za-z]:/.test(text)) {
        return { kind: 'git', url: `https://github.com/${text}.git` };
      }
      return { kind: 'directory', path: text };
    }

    // ---------------------------------------------------------------- drawer

    function PluginDrawer({ t, state, scope, cwd, conflicts, runtimeErrors, installedById, effectiveById, busy, onClose, onInstall, onSaveOptions, onSwitchVersion }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose]);

      return h(
        React.Fragment,
        null,
        h('div', { className: 'ph-drawer-mask', onClick: onClose }),
        h(
          'aside',
          { className: 'ph-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('detail.title') },
          state.kind === 'installed'
            ? h(InstalledDetail, {
                t,
                id: state.id,
                scope,
                cwd,
                conflicts: Array.isArray(conflicts) ? conflicts.filter((item) => item?.pluginId === state.id) : [],
                runtimeErrors: (Array.isArray(runtimeErrors) ? runtimeErrors : []).filter((item) => item?.pluginId === state.id),
                record: installedById.get(state.id) ?? null,
                effective: effectiveById.get(state.id) ?? null,
                busy,
                onClose,
                onSaveOptions,
                onSwitchVersion,
              })
            : h(MarketDetail, { t, entry: state.entry, busy, onClose, onInstall }),
        ),
      );
    }

    function MarketDetail({ t, entry, busy, onClose, onInstall }) {
      const installing = busy === `install:${entry.id}`;
      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'ph-drawer-head' },
          h('span', { className: 'ph-drawer-title' }, entryTitle(entry)),
          h('button', { type: 'button', className: 'ph-btn', onClick: onClose }, t('detail.close')),
        ),
        h(
          'div',
          { className: 'ph-drawer-body' },
          h(
            'div',
            { className: 'ph-group', style: { display: 'flex', gap: 12, alignItems: 'center' } },
            h(Avatar, { name: entry.name, icon: entry.icon }),
            h(
              'div',
              { style: { minWidth: 0, display: 'flex', gap: 6, flexWrap: 'wrap' } },
              entry.version ? h('span', { className: 'ph-tag' }, `v${entry.version}`) : null,
              entry.publisherType === 'official'
                ? h('span', { className: 'ph-tag', 'data-tone': 'brand' }, t('publisher.official'))
                : entry.publisherType === 'community'
                  ? h('span', { className: 'ph-tag' }, t('publisher.community'))
                  : null,
              entry.installed
                ? h('span', { className: 'ph-tag', 'data-tone': 'success' }, t('market.installed'))
                : null,
              formatLabel(t, entry.format)
                ? h('span', { className: 'ph-tag' }, formatLabel(t, entry.format))
                : null,
            ),
          ),
          entryDescription(entry)
            ? h(
                'div',
                { className: 'ph-group' },
                h('div', { className: 'ph-group-title' }, t('detail.description')),
                h('div', { style: { fontSize: 12, lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' } }, entryDescription(entry)),
              )
            : null,
          h(
            'div',
            { className: 'ph-group' },
            h('div', { className: 'ph-group-title' }, t('detail.manifest')),
            h(
              'dl',
              { className: 'ph-kv' },
              h('dt', null, t('detail.openMarket')),
              h('dd', null, entry.marketplace),
              h('dt', null, t('detail.category')),
              h('dd', null, entry.category ? categoryLabel(t, entry.category) : t('category.uncategorized')),
              entry.author ? h('dt', null, t('detail.publisher')) : null,
              entry.author ? h('dd', null, entry.author) : null,
              formatLabel(t, entry.format) ? h('dt', null, t('detail.format')) : null,
              formatLabel(t, entry.format) ? h('dd', null, formatLabel(t, entry.format)) : null,
              entry.homepage
                ? h('dt', null, t('detail.homepage'))
                : null,
              entry.homepage
                ? h('dd', null, h('a', { className: 'ph-link', href: entry.homepage, target: '_blank', rel: 'noreferrer noopener' }, entry.homepage))
                : null,
              entry.license ? h('dt', null, t('detail.license')) : null,
              entry.license ? h('dd', null, entry.license) : null,
              h('dt', null, t('detail.source')),
              h('dd', null, h('code', null, sourceLabel(t, entry.source))),
            ),
          ),
          (entry.componentTypes ?? []).length > 0
            ? h(
                'div',
                { className: 'ph-group' },
                h('div', { className: 'ph-group-title' }, t('detail.components')),
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  entry.componentTypes.map((kind) => h('span', { className: 'ph-tag', key: kind }, kindLabel(t, kind))),
                ),
              )
            : h(
                'div',
                { className: 'ph-group' },
                h('div', { className: 'ph-group-title' }, t('detail.components')),
                h('div', { className: 'ph-muted' }, t('detail.componentsPending')),
              ),
          (entry.keywords ?? []).length > 0
            ? h(
                'div',
                { className: 'ph-group' },
                h('div', { className: 'ph-group-title' }, t('detail.keywords')),
                h(
                  'div',
                  { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  entry.keywords.map((keyword) => h('span', { className: 'ph-tag', key: keyword }, keyword)),
                ),
              )
            : null,
          h(
            'div',
            { className: 'ph-group' },
            h(
              'button',
              {
                type: 'button',
                className: 'ph-btn',
                'data-variant': 'primary',
                disabled: installing || (entry.installed && !entry.updatable),
                onClick: () => onInstall(entry),
              },
              entry.installed && !entry.updatable
                ? t('market.installed')
                : installing
                  ? t('market.installing')
                  : entry.installed
                    ? t('market.update')
                    : t('detail.installHere'),
            ),
          ),
        ),
      );
    }

    function InstalledDetail({ t, id, scope, cwd, record, effective, conflicts, runtimeErrors, busy, onClose, onSaveOptions, onSwitchVersion }) {
      const [state, setState] = useState({ loading: true, data: null, error: null });
      const [values, setValues] = useState({});
      const [versions, setVersions] = useState({ loading: true, items: [], error: null });
      const [pendingVersion, setPendingVersion] = useState(null);

      // 版本列表跟着安装记录的版本走：切换成功后父组件 reload 会换掉 record.version，
      // 这里重新拉一次，当前标记才会移动。
      useEffect(() => {
        let alive = true;
        setVersions((current) => ({ ...current, loading: true }));
        callApi(`/versions?id=${encodeURIComponent(id)}`)
          .then((value) => {
            if (!alive) return;
            setVersions({
              loading: false,
              error: null,
              items: Array.isArray(value?.versions) ? value.versions : [],
            });
            setPendingVersion(null);
          })
          .catch((error) => {
            if (alive) setVersions({ loading: false, items: [], error: String(error.message ?? error) });
          });
        return () => {
          alive = false;
        };
      }, [id, record?.version]);

      useEffect(() => {
        let alive = true;
        callApi(`/components?id=${encodeURIComponent(id)}`)
          .then((value) => {
            if (!alive) return;
            setState({ loading: false, data: value, error: null });
            const current = effective?.options ?? {};
            const next = {};
            const schema = value?.manifest?.userConfig;
            if (schema !== null && typeof schema === 'object') {
              for (const key of Object.keys(schema)) {
                next[key] = current[key] === undefined || current[key] === null ? '' : String(current[key]);
              }
            }
            setValues(next);
          })
          .catch((error) => {
            if (alive) setState({ loading: false, data: null, error: String(error.message ?? error) });
          });
        return () => {
          alive = false;
        };
      }, [id, effective]);

      const manifest = state.data?.manifest ?? null;
      const components = state.data?.components ?? {};
      const groups = components.groups ?? [];
      const uiSurfaces = components.uiSurfaces ?? [];
      const diagnostics = components.diagnostics ?? [];
      // 该插件被全局/项目同名 MCP 顶掉的 server（overview.mcpConflicts 已按插件过滤）。
      const mcpConflictRows = Array.isArray(conflicts) ? conflicts : [];
      // 该插件在最近一次 reconcile 里挂载失败的能力（overview.projectionErrors 已按插件过滤）。
      const runtimeErrorRows = Array.isArray(runtimeErrors) ? runtimeErrors : [];
      const schema = manifest?.userConfig;
      const optionKeys = schema !== null && typeof schema === 'object' ? Object.keys(schema) : [];
      const saving = busy === `options:${id}`;
      const switching = busy === `switch:${id}`;

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'ph-drawer-head' },
          h('span', { className: 'ph-drawer-title' }, manifest?.name ?? record?.name ?? id),
          h('button', { type: 'button', className: 'ph-btn', onClick: onClose }, t('detail.close')),
        ),
        h(
          'div',
          { className: 'ph-drawer-body' },
          state.loading ? h('div', { className: 'ph-muted' }, t('common.loading')) : null,
          state.error !== null ? h(ErrorBar, { error: state.error }) : null,
          manifest
            ? h(
                'div',
                { className: 'ph-group' },
                h('div', { className: 'ph-group-title' }, t('detail.manifest')),
                h(
                  'dl',
                  { className: 'ph-kv' },
                  h('dt', null, t('detail.version')),
                  h('dd', null, manifest.version ?? '0.0.0'),
                  formatLabel(t, state.data?.format) ? h('dt', null, t('detail.format')) : null,
                  formatLabel(t, state.data?.format) ? h('dd', null, formatLabel(t, state.data?.format)) : null,
                  h('dt', null, t('detail.openMarket')),
                  h('dd', null, record?.marketplace ?? 'local'),
                  state.data?.manifestPath ? h('dt', null, t('detail.source')) : null,
                  state.data?.manifestPath ? h('dd', null, h('code', null, state.data.manifestPath)) : null,
                ),
                manifest.description
                  ? h(
                      'div',
                      { style: { marginTop: 6, fontSize: 12, lineHeight: '19px', color: 'var(--dsw-alias-label-secondary)' } },
                      manifest.description,
                    )
                  : null,
              )
            : null,
          h(
            'div',
            { className: 'ph-group' },
            h('div', { className: 'ph-group-title' }, t('detail.versions')),
            versions.error !== null
              ? h(ErrorBar, { error: versions.error })
              : versions.loading
                ? h('div', { className: 'ph-muted' }, t('common.loading'))
                : versions.items.length === 0
                  ? h('div', { className: 'ph-muted' }, t('detail.noVersions'))
                  : versions.items.map((item) =>
                      h(
                        'div',
                        {
                          className: 'ph-item',
                          key: item.rootPath,
                          style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
                        },
                        h('span', null, `v${item.version}`),
                        item.current
                          ? h('span', { className: 'ph-tag', 'data-tone': 'success' }, t('detail.currentVersion'))
                          : null,
                        typeof item.mtime === 'string' && item.mtime !== ''
                          ? h('span', { className: 'ph-muted', style: { fontSize: 11 } }, formatTime(item.mtime))
                          : null,
                        item.current
                          ? null
                          : h(
                              'button',
                              {
                                type: 'button',
                                className: 'ph-btn',
                                'data-variant': pendingVersion === item.version ? 'danger' : undefined,
                                disabled: switching || busy !== null,
                                onClick: () => {
                                  if (pendingVersion === item.version) {
                                    setPendingVersion(null);
                                    onSwitchVersion(id, item.version);
                                  } else {
                                    setPendingVersion(item.version);
                                  }
                                },
                              },
                              pendingVersion === item.version ? t('detail.confirmSwitch') : t('detail.switchVersion'),
                            ),
                      ),
                    ),
          ),
          groups.length > 0
            ? h(
                'div',
                { className: 'ph-group' },
                h('div', { className: 'ph-group-title' }, t('detail.components')),
                groups.map((group) =>
                  h(
                    'div',
                    { key: group.kind, style: { marginBottom: 10 } },
                    h('div', { className: 'ph-item', style: { fontWeight: 600 } }, `${kindLabel(t, group.kind)} (${group.items.length})`),
                    group.items.map((item) =>
                      h(
                        'div',
                        { className: 'ph-item', key: `${group.kind}:${item.name}`, style: { paddingLeft: 12 } },
                        item.name,
                        item.description ? h('code', null, item.description) : null,
                      ),
                    ),
                  ),
                ),
              )
            : null,
          uiSurfaces.length > 0
            ? h(
                'div',
                { className: 'ph-group' },
                h('div', { className: 'ph-group-title' }, kindLabel(t, 'ui')),
                uiSurfaces.map((surface) =>
                  h(
                    'div',
                    { className: 'ph-item', key: surface.id },
                    typeof surface.title === 'string' ? surface.title : pickLocalized(surface.title) ?? surface.id,
                    h('code', null, surface.resourceUri),
                  ),
                ),
                h('div', { className: 'ph-warn' }, t('detail.uiNote')),
              )
            : null,
          optionKeys.length > 0
            ? h(
                'div',
                { className: 'ph-group' },
                h('div', { className: 'ph-group-title' }, t('detail.options')),
                h('div', { className: 'ph-field-hint', style: { marginBottom: 8 } }, t('detail.optionsHint')),
                optionKeys.map((key) => {
                  const field = schema[key] ?? {};
                  return h(
                    'label',
                    { className: 'ph-field', key },
                    h('span', { className: 'ph-field-label' }, field.title ?? key),
                    h('input', {
                      className: 'ph-input',
                      type: field.type === 'number' ? 'number' : 'text',
                      value: values[key] ?? '',
                      placeholder: typeof field.default === 'string' ? field.default : '',
                      onChange: (event) => setValues({ ...values, [key]: event.target.value }),
                    }),
                    field.description ? h('span', { className: 'ph-field-hint' }, field.description) : null,
                  );
                }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'ph-btn',
                    'data-variant': 'primary',
                    disabled: saving,
                    onClick: () => {
                      const payload = {};
                      for (const key of optionKeys) {
                        const raw = values[key] ?? '';
                        if (raw === '') continue;
                        const field = schema[key] ?? {};
                        payload[key] = field.type === 'number' ? Number(raw) : raw;
                      }
                      onSaveOptions(id, payload, scope === 'workspace' ? 'workspace' : 'user');
                    },
                  },
                  saving ? t('common.loading') : t('detail.saveOptions'),
                ),
              )
            : null,
          h(
            'div',
            { className: 'ph-group' },
            h('div', { className: 'ph-group-title' }, t('detail.diagnostics')),
            diagnostics.length === 0 && mcpConflictRows.length === 0 && runtimeErrorRows.length === 0
              ? h('div', { className: 'ph-diag' }, t('detail.noDiagnostics'))
              : [
                  // 运行期失败排在最前：这才是「技能怎么没出现」的直接答案。
                  ...runtimeErrorRows.map((item, index) =>
                    h(
                      'div',
                      { className: 'ph-diag', 'data-tone': 'danger', key: `runtime:${item.kind}:${index}` },
                      t('detail.runtimeRow')
                        .replace('{kind}', runtimeKindLabel(t, item.kind))
                        .replace(
                          '{message}',
                          `${item.serverName ? `${item.serverName}: ` : ''}${item.message}${
                            typeof item.cwd === 'string' && item.cwd !== '' ? ` · ${shortPath(item.cwd)}` : ''
                          }`,
                        ),
                    ),
                  ),
                  ...diagnostics.map((item, index) =>
                    h('div', { className: 'ph-diag', key: `${item.code}:${index}` }, `${item.code}: ${item.message}`),
                  ),
                  // MCP 重名让位（契约 §2）：不是错误，是优先级结果，所以用 warn 色而非 error。
                  ...mcpConflictRows.map((item, index) =>
                    h(
                      'div',
                      { className: 'ph-diag', 'data-tone': 'warn', key: `mcp-conflict:${item.serverName}:${index}` },
                      t('mcp.conflict.row')
                        .replace('{plugin}', id)
                        .replace('{server}', item.serverName)
                        .replace('{source}', conflictSourceLabel(t, item.source)),
                    ),
                  ),
                ],
          ),
          scope === 'workspace' && cwd
            ? h('div', { className: 'ph-muted' }, `${t('scope.projectPath')}: ${shortPath(cwd)}`)
            : null,
        ),
      );
    }

    // ------------------------------------------------------------------ faces

    function Page() {
      const { t } = useLocale();
      return h(HubBody, { variant: 'settings', t });
    }

    function PanelPage() {
      const { t } = useLocale();
      return h(HubBody, { variant: 'panel', t });
    }

    function IconPanelMark() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M8 1.5 9.6 5.1 13.5 5.6 10.7 8.2 11.4 12 8 10.2 4.6 12 5.3 8.2 2.5 5.6 6.4 5.1Z',
          fill: 'currentColor',
        }),
      );
    }

    /** 语言：优先 ctx.locale 的绑定函数，取不到时退回中文表。 */
    let localeFace = null;
    function useLocale() {
      const t = useCallback((key, fallback) => {
        const table = localeFace === null ? zh : localeFace();
        return table[key] ?? fallback ?? key;
      }, []);
      return { t };
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      clientCtx = ctx;
      const bind = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : null;
      const translate = (key, fallback) => {
        if (bind !== null) {
          const value = bind(key);
          if (typeof value === 'string' && value !== '' && value !== key) return value;
        }
        return zh[key] ?? fallback ?? key;
      };
      localeFace = () => ({ ...zh, ...(ctx.locale?.dictionary?.(NS) ?? {}) });

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${STYLE_ID}: dictionaries`);
      ctx.effect(() => ensureStyles(), `${STYLE_ID}: styles`);

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'plugin-hub',
            order: 34,
            label: () => translate('nav'),
            locale: NS,
          },
          Page,
        ),
      );

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'plugin-hub',
            order: 34,
            label: () => translate('panel.label'),
            locale: NS,
          },
          IconPanelMark,
        ),
      );

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: 'plugin-hub',
            locale: NS,
          },
          PanelPage,
        ),
      );
    }

    return { inject, apply };
  },
});
