# dsh-plugin-hub

**DSH 插件中心**：把 **ZCode 格式**的插件包装进 DeepSeek Harness，并把包里的
**技能（skill）/ 斜杠命令（command）/ 钩子（hook）/ MCP 服务器** 投影到使用它的会话里。
作用域照 ZCode 做**两级**：全局（User）+ 项目（Workspace）。

DSH 自带的「插件」页管理的是 **Cordis bundle**（改宿主本身的代码），本插件管理的是
**给 Agent 用的能力包**——这是两根不同的轴：

| | DSH bundle（自带插件页） | ZCode 插件（本插件） |
|---|---|---|
| 装的是什么 | 改宿主的代码插件 | 技能/命令/钩子/MCP 的能力包 |
| 作用域 | profile（该 profile 全部会话） | User + Workspace（项目覆盖全局） |
| 分发 | 无商店，`install_bundle` | `marketplace.json` 目录，可 Git/本地/URL |
| 典型来源 | npm / 本地包 | `zcode-plugins-official`、个人 Git 仓库 |

## 安装

在本仓库外（任意会话）用 DSH 的插件管理器安装本目录：

```text
plugin_manager  action=install_bundle  target=<绝对路径>\dsh-plugin-hub
```

安装后：

- **设置 → 插件中心**（order 34）
- **主页面侧边栏 → 插件中心**（order 34，点开是同一个面板）

## 两个功能页

设置 →「插件中心」与侧边栏「插件中心」是同一个页面，顶部两个标签：

| 标签 | 做什么 |
|---|---|
| **插件市场** | 添加 / 刷新 / 移除市场源；搜索、按分类筛选；卡片网格展示图标/名称/描述/版本/组件类型/发布者；一键安装，已安装的标出可更新版本；点卡片看详情再安装；索引超过 1 小时的市场标「过期」，上次抓取失败标「抓取失败」 |
| **插件管理** | 已安装列表（启停开关、来源徽标、组件摘要、运行失败标记、详情、两步确认卸载）；从本地目录 / Git 直接安装；详情抽屉里有版本历史（可回滚）、组件树、诊断（含运行期挂载失败）和 `userConfig` 配置表单 |

「添加插件市场」是单输入框对话框（与 ZCode 一致）：`owner/repo`、Git URL、
`marketplace.json` 地址、本地目录都能直接粘；支持把文件/文件夹拖进对话框，
也能用「选择目录」调宿主目录选择器。市场 id 不用手填——按清单 `name` 自动派生。

## 用起来

1. **添加市场**（可选）：本地目录、Git URL、GitHub `owner/repo`、或直接给索引 URL。
   兼容 ZCode/Claude 的 `marketplace.json`（`{ name, owner, plugins: [...] }`），
   并透传商店元数据：`displayName(_i18n)`、`description(_i18n)`、`icon`、`category`、
   `keywords`、`publisherType`、`componentTypes`、`author`。
2. **浏览 / 安装**：安装产物落在 `<profile>/data/plugin-hub/cache/<market>/<name>/<version>/`。
   同一插件装过多个版本时，旧版本目录保留；插件详情里可以看版本历史并**切回旧版本**，
   卸载则删掉整个 `<market>/<name>/` 目录（不留下既不能回滚也不能清理的孤儿目录）。
3. **启用**：默认在全局启用；切到「项目」作用域可以按项目覆盖（写 `<project>/.dsh/plugins.json`）。
4. 新会话（或 cold resume）读到新配置后生效；**正在跑的会话不会热插拔**。

装上之后如果某类能力没出现，先看插件详情的「诊断」区：技能/命令/钩子/MCP 的挂载异常
会归因到具体插件与能力类型（同时作为管理页的红色徽标），不必去翻宿主日志。

市场索引在每次添加/刷新时抓取；超过 1 小时的市场在被浏览时会**后台静默刷新一次**
（本地目录与索引 URL 来源；git/github 刷新要替换 checkout，只在你点「刷新」时执行）。
同一市场同时只有一个刷新在跑，自动刷新失败后 10 分钟内不再重试。抓取失败不会清空旧条目，
只在市场 chip 与标题上标出「抓取失败」和原因，旧索引照常可以浏览和安装。

## 作用域与优先级（照 ZCode）

```text
User       <profile>/data/plugin-hub/user.json      enabledPlugins / options
Workspace  <project>/.dsh/plugins.json              enabledPlugins / options / dirs

enabled = workspace[id] ?? user[id] ?? true          # 缺 key 表示继承；显式 false 有效
options = { ...user[id], ...workspace[id] }          # 逐 key 覆盖
```

包本体、安装记录、缓存、市场目录**永远属于 Host 用户级**；项目只能"引用已安装的包"，
或用 `plugins.dirs` 指向仓库内的插件根（只在该项目会话生效，不进全局列表）。

**信任门**：项目配置可随仓库提交，因此首次生效需要点一次「信任」。0.3.1 起信任存进
**三件套共用**的 `<profile>/data/project-trust/trusted.json`：一次批准同时覆盖本项目的
`.dsh/plugins.json` 与 `.dsh/mcp.json`（聚合 hash = 两份文件字节 sha256 的固定拼接），
所以在 dsh-mcp-manager 里点过的「信任」这里同样生效；任意一份文件变化（`git pull`、
手工编辑）都要重新信任。旧的两份单插件记录仍然**只读**兼容。未信任时**整层忽略**，
全局配置照常生效。信任横幅会按层显示 `MCP: 已信任/未信任/不适用`，其中「不适用」=
对应的文件不存在，只有一份文件时批准它即可。

## 组件投影对照

| ZCode 组件 | DSH 里变成什么 | V1 状态 |
|---|---|---|
| `skills/` | per-agent 技能 provider（`/` 菜单可调、按需加载正文） | ✅ |
| `commands/*.md` | per-agent 斜杠命令，展开 `$ARGUMENTS` 后作为下一轮提示词 | ✅ |
| `hooks` | `PreToolUse`/`PostToolUse`/`UserPromptSubmit`/`SessionStart`/`SessionEnd`/`Stop` 映射到 DSH 事件 | ✅（其余事件忽略） |
| `mcpServers` / `.mcp.json` | 复用 `@deepseek-ai/dsh-mcp-client`，按 Agent 挂载（工具名 `mcp__<server>__<tool>`） | ✅ |
| `agents/*.md` | 只枚举、展示、进 catalog | ⚠️ 元数据（V2 接 subagent provider） |
| `ui.surfaces` | 只枚举、展示「需 MCP Apps 宿主」 | ⚠️ 不渲染（DSH 无 MCP Apps 宿主） |

变量展开：`${ZCODE_PLUGIN_ROOT}`、`${ZCODE_PLUGIN_DATA}`、`${ZCODE_PROJECT_DIR}`、
`${CLAUDE_PLUGIN_ROOT}`、`${user_config.KEY}`。单遍展开，未知变量原样保留。

## 数据与接口

```text
<profile>/data/plugin-hub/
  installed.json     安装记录（id/name/version/rootPath/source/sha256/时间）
  user.json          全局 enabledPlugins / options
  marketplaces.json  市场来源与索引状态（lastUpdated / fetchedAt / lastError / lastErrorAt）
  trusted.json       旧版项目信任（0.3.1 起只读兼容；新写入见下）
  cache/             插件包（按 <market>/<name>/<version> 分桶保留，可回滚）与市场 checkout
  indexes/           远端索引缓存

<profile>/data/project-trust/trusted.json
  三件套共用的项目信任（version 1，projects[<规范化绝对路径>] =
  { hash: 聚合 sha256, files: { mcp, plugins }, approvedAt }）
```

HTTP（同源，先鉴权后读体）：

```text
GET  /plugin-hub/api/overview?cwd=     总量视图（安装/市场/作用域/生效摘要/信任分层/MCP 冲突/运行期挂载失败）
GET  /plugin-hub/api/components?id=    单个插件组件明细
GET  /plugin-hub/api/versions?id=      缓存里保留的版本（当前版本标记 + rootPath/sha256/mtime）
POST /plugin-hub/api/market/add        添加市场（只给 source；id 自动派生，可显式覆盖）
POST /plugin-hub/api/market/refresh    刷新市场（成功清空 lastError，失败写 lastError 并保留旧索引）
POST /plugin-hub/api/market/remove     移除市场（只删登记与本地缓存副本）
POST /plugin-hub/api/market/entries    市场条目；不传 id 时聚合全部市场；summary 带 fetchedAt/ageSec/stale/lastError
POST /plugin-hub/api/install           安装（marketplace+name 或 source）
POST /plugin-hub/api/uninstall         卸载（删整个 <market>/<name> 目录，含历史版本）
POST /plugin-hub/api/switch            切回缓存里的另一个版本（保留安装时间与启用状态）
POST /plugin-hub/api/enable            启用/停用（user 或 workspace，null=恢复继承）
POST /plugin-hub/api/options           写插件配置项
POST /plugin-hub/api/trust            信任当前项目（写共用的 canonical 存储，一次覆盖 MCP + 插件配置）
POST /plugin-hub/api/reload            强制失效生效缓存
```

市场缓存按**来源指纹**落盘（`cache/.markets/<sha1>/`、`indexes/<sha1>.json`），与市场 id 解耦：
同一个来源重复添加是幂等刷新，改 id 不需要搬目录。

## 安全

- 所有路由先过 `connection.requestRejection`（宿主鉴权 + Host/Origin 围栏），mutation 只收
  `application/json` 且 ≤64 KiB。
- 路径：词法防线拒绝对路径与 `..`；复制/扫描**不跟随符号链接**（含 Windows junction）。
- 项目配置未信任不生效；信任绑定两份文件的内容 hash（一次批准覆盖 MCP 与插件配置）。
- 响应统一脱敏（`sk-*`、`ghp_*`、`github_pat_*`、`*KEY/SECRET/TOKEN=...`）。
- hook 命令由你启用插件的动作授权执行；失败只告警，不阻断会话。

## MCP 重名优先级

**全局（dsh-mcp-manager / profile 补丁里的 mcp-client 行）> 项目（受信任的
`.dsh/mcp.json`）> 插件（本插件）**。插件里的 server 与全局或项目同名时**不挂载**：

- 投影层跳过并记一条冲突（`{ pluginId, serverName, source }`），其余 server 照常挂；
- 插件管理页出现橙色横幅（数量 + 可展开明细），插件详情抽屉的诊断区也列出这一行；
- `GET /overview` 的 `mcpConflicts` 同时给出「运行时真的跳过过」与「按当前生效插件
  dry-run」两路结果，按 cwd 去重，所以还没开过会话也能看到冲突。

占用集合算进投影签名：全局服务器晚连接、项目文件变化或信任状态翻转都会改变跳过名单，
下一次 `agent/pre-step` 自动重新 reconcile（先卸后挂，不重复挂载）。同一 Agent 内两个
插件声明同名 server 仍是「后到跳过」——插件之间没有优先级，建议作者用带前缀的 server 名。
判定口径与 dsh-mcp-manager 完全一致（同一份契约 §2）。

## 已知限制

- **子代理不继承**项目/插件挂载：宿主子代理生命周期与挂载点决定的边界，不是配置 bug。
- 插件里的 `agents/` 与 `ui.surfaces` 目前只做枚举展示（`agents` 走 V2 的 subagent provider，
  `ui.surfaces` 需要 DSH 有 MCP Apps 宿主）。
- 热更新：配置写入立即落盘、下次会话生效；正在跑的会话保持切换时的能力集合。包内容变了
  （内容指纹进签名）会在下一次 `agent/pre-step` 重挂；`/plugin-hub/api/reload` 可强制失效生效缓存。
- MCP server 重名：与全局/项目同名时插件版本让位（见上节）；插件之间同名按「后到跳过」
  （不改名，因为改名会改变模型看到的工具名）。
- 只认 ZCode 与 Claude 两种清单（`.zcode-plugin/plugin.json`、根 `plugin.json`、`.claude-plugin/plugin.json`）。
  Claude 官方目录里有一批条目把清单写在 `marketplace.json`（`strict:false` 的语言服务器插件，
  包里没有 plugin.json），安装时按条目合成清单并写进包内 `.claude-plugin/plugin.json`，记录里标
  `format: synthesized`。
- `lspServers`（Claude 的语言服务器声明）只枚举展示，不启动语言服务器（V2）。
- hook 只支持 6 个事件；`Notification` / `PreCompact` / `SubagentStop` 只记诊断不执行。
- 市场条目的 `sha` 目前按 `ref` 处理（浅克隆 `--branch`），固定 commit sha 需要后续支持。

## 开发与验证

```bash
node scripts/adapters-smoke.mjs    # 适配器 26 条（清单/组件/来源/市场/符号链接拒绝）
node scripts/runtime-smoke.mjs     # 投影 104 条（幂等/重挂/清理/deny/命令展开/技能读盘/MCP 变量/占用与让位/旧信任回退/运行期错误可见）
node client/selfcheck.mjs          # 客户端 31 条静态检查（槽位/白名单/字典/语法/路由覆盖）
node client/render-smoke.mjs       # 客户端 6 条渲染冒烟（React 桩执行 PanelPage，覆盖详情抽屉与诊断行）
node scripts/smoke.mjs             # 路由端到端 70+ 条（git 可用时 76 条；安装/生效/信任门/版本回滚/索引新鲜度/卸载/MCP 冲突）
node scripts/claude-smoke.mjs      # Claude 插件兼容 21 条（.claude-plugin 清单/git url 源/lsp/端到端）
```

界面改样式后另跑工作区脚本 `node ../../scripts/lint-theme-tokens.mjs --file client/client.js`：
`var(--dsw-*)` 写错不会报错、只会静默回退，必须机械核对 token 名（本版修掉了 5 个旧错名）。

真机验收：装进 profile 后新开一个会话，设置页出现「插件中心」，安装 fixture 插件后
该会话的 `/` 菜单出现 `echo` / `summarize` 技能与 `greet` 命令，`mcp__fixture__echo` 可调用。

## 许可

MIT。图标为本仓库原创 SVG。
