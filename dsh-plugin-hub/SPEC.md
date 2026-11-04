# dsh-plugin-hub — 实现规范（V1）

DSH 版「插件中心」：把 **ZCode 格式的插件包**（skill / command / agent / hook / MCP / ui.surfaces）
安装、启用、并投影进 DSH 的会话运行时。作用域照 ZCode：**User（profile）+ Workspace（项目）**。

本文件是并行开发的唯一契约。改契约先改这里，并在提交说明里写清。

## 1. 范围

| 维度 | V1 做什么 | V1 不做什么（明确记录） |
|---|---|---|
| 来源 | 本地目录、Git/GitHub、zip 包（系统 tar 解压）、`marketplace.json` 索引（ZCode / Claude 形状；`{source:'url'}` 指向 `*.git` 时按克隆处理） | npm 源、pip 源 |
| 清单 | `.zcode-plugin/plugin.json`（首选）、根 `plugin.json`、`.claude-plugin/plugin.json`（Claude）；包内没有清单但市场条目自带清单语义时按条目合成 | 凭空生成缺字段的清单 |
| 相对路径基准 | 索引在根目录时按索引目录；索引在 `.claude-plugin/` / `.zcode-plugin/` 里时按仓库根（Claude 约定） | — |
| skill | 投影为 per-agent 技能 provider | — |
| command | 投影为 per-agent 斜杠命令，展开成 followup 提示词 | 参数补全、`!bash` 内联执行 |
| MCP | 复用 `@deepseek-ai/dsh-mcp-client`，按 Agent 挂载 | 独立 MCP 审批 |
| hook | PreToolUse / PostToolUse / UserPromptSubmit / SessionStart / SessionEnd / Stop | Notification / PreCompact / SubagentStop |
| agent | 只枚举、展示、写入 catalog 元数据 | 作为 DSH subagent provider 执行（V2） |
| lspServers | 只枚举、展示 | 启动语言服务器（V2） |
| ui.surfaces | 只枚举、展示「需 MCP Apps 宿主」 | 渲染 MCP Apps 页面（V2） |
| 作用域 | User（`data/plugin-hub/user.json`）+ Workspace（`<project>/.dsh/plugins.json`） | Local scope |
| 信任 | 项目配置 hash 信任门（同 dsh-mcp-manager） | 插件域独立审批 |

## 2. 目录与归属（不要跨目录改文件）

```
dsh-plugin-hub/
  package.json            Lead
  cordis.patch.yml        Lead
  README.md               Lead
  SPEC.md                 Lead
  icon.svg                Lead
  locale/en.json          Lead（插件清单展示元数据）
  lib/
    index.js              Lead   插件入口（routes + runtime 挂载）
    routes.js             Lead   /plugin-hub/api/*
    store.js              Lead   落盘：installed / user / workspace / market / trust（旧记录）
    scope.js              Lead   effective 合并（user+workspace）→ 投影输入
    trust.js              Lead   项目信任门（读分层状态，翻译成 required/trusted）
    project-trust.js      Lead   统一信任存储（三件套契约 §1：canonical 读写 + 旧记录只读回退）
    occupancy.js          Lead   MCP 重名占用表（三件套契约 §2：全局/项目 → 插件让位）
    security.js           Lead   HTTP 围栏（认证/方法/JSON/体积/脱敏）
    util.js               Lead   JSON 读写、原子写、锁、sha256、变量展开、日志
    manifest.js           adapters  清单解析与校验
    components.js         adapters  组件枚举（skills/commands/agents/hooks/mcp/ui）
    sources.js            adapters  目录/git/zip 物化到 cache
    market.js             adapters  marketplace.json 拉取与缓存
    projection/
      index.js            runtime  per-agent 编排（created/pre-step/disposed）
      skills.js           runtime  per-agent 技能 provider
      commands.js         runtime  per-agent 斜杠命令
      hooks.js            runtime  hook → DSH 事件桥
      mcp.js              runtime  per-agent dsh-mcp-client 挂载
  client/
    client.js             client   Web 客户端（settings.section + sidebar.panellist + main）
    selfcheck.mjs         client   静态自检
    render-smoke.mjs      client   渲染冒烟（最小 React 桩执行真实组件树）
  scripts/
    adapters-smoke.mjs    adapters
    runtime-smoke.mjs     runtime
    fixture/...           verify
    smoke.mjs             verify
```

## 3. 落盘形状（store.js）

根目录：`<profileDir>/data/plugin-hub/`，`profileDir` 用 mcp-manager 的 `profileDirOf` 规则
（`configEditor.documentPath` 的目录，否则 `$DSH_HOME|~/.dsh` + `profiles/$DSH_PROFILE|desktop`）。

```
installed.json     { version: 1, plugins: Record<pluginId, InstalledRecord> }
user.json          { version: 1, enabledPlugins: Record<id, boolean>, options: Record<id, Record<string, string|number|boolean>> }
marketplaces.json  { version: 1, marketplaces: Record<marketId, MarketplaceRecord> }
trusted.json       { version: 1, projects: Record<absoluteCwd, { hash: string, approvedAt: string }> }  // 旧记录，0.3.1 起只读
cache/<market>/<name>/<version>/...
data/<pluginId>/...          （当前未用，留给 V2 的 plugin data）
```

统一信任存储（三件套共用，`project-trust.js` 读写；锁固定为 `<store>.lock`）：

```
<profileDir>/data/project-trust/trusted.json
{ version: 1, projects: Record<normalizedCwd, {
    hash: string,                                   // 聚合 sha256（契约 §1.3）
    files: { mcp: string|null, plugins: string|null }, // 两份文件各自的字节 sha256
    approvedAt: string }> }
```

```
canonical = "dsh-project-trust/v1\n" + "mcp:" + (mcp ?? "-") + "\n" + "plugins:" + (plugins ?? "-")
hash      = sha256(canonical, utf8)
```

`plugins` 层 = canonical 命中 || 旧 hub 记录命中；`mcp` 层 = canonical 命中 || 旧 mcp-manager
记录命中（`data/mcp-manager/trusted-projects.json`，key = 原始绝对路径）。旧记录只读。

```ts
InstalledRecord = {
  id: string;            // `${name}@${marketplace}`
  name: string;
  version?: string;
  marketplace: string;   // 'local' | 'personal-plugins' | ...
  rootPath: string;      // cache 内绝对路径（当前版本的目录）
  source: SourceSpec;
  sha256: string;        // 目录内容指纹
  installedAt: string;   // ISO
  updatedAt: string;
}

SourceSpec =
  | { kind: 'directory'; path: string }
  | { kind: 'git'; url: string; ref?: string; path?: string }
  | { kind: 'archive'; url: string }
  | { kind: 'market'; marketplace: string; name: string }

MarketplaceRecord = {
  id: string;
  source:
    | { kind: 'directory'; path: string }
    | { kind: 'url'; url: string }
    | { kind: 'git'; url: string; ref?: string }
    | { kind: 'github'; repo: string; ref?: string };
  name?: string;
  description?: string;
  lastUpdated?: string;
  fetchedAt?: string;    // 最近一次成功抓取索引的时间（老记录回退到 lastUpdated）
  lastError?: string;    // 最近一次抓取失败的原因；失败不清空条目与 indexPath
  lastErrorAt?: string;
  pluginCount?: number;
  indexPath?: string;    // 本地缓存到的 marketplace.json
}
```

写文件一律 `writeJsonAtomic` + `withLock`；写前读最新，函数式 mutator。

缓存里一个插件按版本分桶保留：`cache/<market>/<name>/<version>/`。`installed.json` 只指向
当前版本；旧版本目录用于回滚（`GET /versions`、`POST /switch`），卸载时整桶清掉
（`POST /uninstall`），不留既不能回滚也不能清理的孤儿目录。

## 4. 模块契约

### lib/util.js

```js
export function expandVars(text, vars)                  // ${NAME} / ${user_config.KEY} 单遍替换
export function sha256Text(text)
export async function sha256Dir(rootPath)               // 稳定遍历（跳过 .git/node_modules），路径排序
export async function readJsonFile(path, fallback)
export async function writeJsonAtomic(path, value)
export async function withLock(lockPath, fn, { waitMs = 5000 })
export async function ensureDir(path)
export function resolveInside(root, relative)           // 词法防线：拒绝对路径与 ..
export function redact(text, values)
export function nowIso()
```

### lib/manifest.js

```js
export async function readManifest(rootPath)
// -> { ok: true, manifest, manifestPath, format: 'zcode' | 'root' }
//  | { ok: false, reason: 'missing' | 'invalid' | 'name', message, manifestPath? }

// manifest 校验：name 必须匹配 /^[a-z0-9][a-z0-9._-]{0,63}$/i；
// mcpServers 可为对象或字符串路径；未知字段保留不报错。
```

### lib/components.js

```js
export async function enumerateComponents(rootPath, manifest)
// -> {
//   groups: Array<{ kind: 'agent'|'command'|'skill'|'hook'|'mcp', items: Array<{name, description?}> }>,
//   skills: Array<{ name, description?, path, root }>,
//   commands: Array<{ name, description?, path, argumentHint? }>,
//   agents: Array<{ name, description?, path }>,
//   hooks: Array<{ event, matcher?, command, timeoutMs? }>,
//   mcpServers: Record<string, object>,   // 已做 ${...} 之外的形状校验，不展开变量
//   uiSurfaces: Array<{ id, title, icon?, server, resourceUri }>,
//   diagnostics: Array<{ code, message, path? }>
// }

export function skillRoots(rootPath, manifest)                  // 默认 skills/ + 声明路径，去重
export function markdownDirs(rootPath, manifest, kind)          // 'commands' | 'agents'
```

规则（对齐 ZCode）：
- 技能根自身含 `SKILL.md` → 根即一个技能；再扫一层子目录。
- **一律不跟随符号链接**（含 Windows junction）；拒绝 `..`/绝对路径。
- command/agent：默认目录 + manifest 声明目录，读 frontmatter 的 `name`/`description`（`argument-hint` 可选）。
- hooks：manifest `.hooks` 或 `hooks/hooks.json`；支持 Claude/ZCode 形状 `{EventName: [{matcher?, hooks: [{type:'command', command, timeout?}]}]}`。
- 组件枚举永不抛错，问题进 `diagnostics`。

### lib/sources.js

```js
export async function materialize({ source, destDir, log, signal })
// -> { rootPath, sha256 }
// directory: 递归复制（拒符号链接）到 destDir
// git:       `git clone --depth 1 [--branch ref] url destDir`（优先 ctx.subprocess，回退 child_process）
// archive:   下载到临时文件，`tar -xf` 解压（Windows bsdtar），找唯一顶层目录
// 失败抛 ApiError 兼容的错误：{ code, message }，code ∈ 'source-unreachable'|'source-invalid'|'source-empty'
export async function downloadTo(url, filePath, { signal } = {})
```

### lib/market.js

```js
export function parseMarketIndex(text, { indexPath })
// -> { name?, description?, plugins: Array<MarketEntry>, diagnostics }
// MarketEntry = { name, description?, version?, source: SourceSpec,
//                 displayName?, displayNameI18n?, descriptionI18n?, icon?, category?,
//                 keywords?, publisherType?: 'official'|'community', componentTypes?, author? }
// 兼容 ZCode marketplace.json：{ name, owner, plugins: [...] }；
// entry.source 可能是字符串（'./plugins/x'）或对象（{source:'github'|'git'|'url'|'file'|'directory', ...}）
// 商店元数据只做白名单透传 + 体积上限：icon 只收 http(s)/data:image，
// componentTypes 只收已知 kind，category 小写化，超长文本按前缀截断。

export async function readLocalIndex(record)            // 读 record.indexPath
export async function resolveMarketSource(entry, record) // MarketEntry -> SourceSpec（相对路径按索引目录解析）
```

### lib/scope.js

```js
export async function effectivePlugins(ctx, cwd)
// -> {
//   plugins: Array<{
//     id, name, version, rootPath, marketplace, manifest, components,
//     enabled, options, enabledSource: 'workspace'|'user'|'default',
//     projectRoot?: string,
//     trust: { required: boolean, trusted: boolean, hash?: string }
//   }>,
//   diagnostics: [...],
//   workspace: { path, exists, hash, trusted }
// }
// 优先级：workspace.enabledPlugins[id] ?? user.enabledPlugins[id] ?? true
// options：user 与 workspace 逐 key 深合并，workspace 覆盖
// 项目未信任时：plugins 仍返回，但 enabled 强制 false 且 trust.required=true
```

### lib/project-trust.js（三件套契约 §1）

```js
export async function trustStateFor(ctx, cwd, { files }?)
// -> { cwd, key, storePath, files: { mcp, plugins }, hash,
//      shared, mcp: 'trusted'|'untrusted'|'not-applicable',
//      plugins: 'trusted'|'untrusted'|'not-applicable',
//      source: 'shared'|'legacy'|'none', record, legacy: { mcp, plugins } }
export async function approveProject(ctx, cwd)   // 读-合并-原子写 canonical（锁 <store>.lock）
export function aggregateHash(mcp, plugins)      // 逐字节照契约 §1.3
export function fileHashOrNull(path)             // 字节 sha256
```

### lib/trust.js（项目信任门）

```js
export async function projectTrust(ctx, cwd, { workspace }?)
// -> { required, trusted, hash, reason?, layers: { mcp, plugins, shared, source }, files }
// trusted 取 plugins 层；没有任何声明时 required=false/trusted=true（保留旧行为）
export async function trustProject(ctx, cwd)
// -> { trusted: true, hash: 聚合 hash, layers }   写 canonical 存储
export async function trustView(ctx, cwd)          // -> { cwd, ...projectTrust }
```

### lib/occupancy.js（三件套契约 §2）

```js
export async function globalOccupancy(ctx)
// -> { names: Set<patchId 派生的 serverName>, tools: string[]（mcp__ 前缀，兜底） }
//    pluginManager.listPlugins()：moduleName === '@deepseek-ai/dsh-mcp-client'
//    && enabled !== false && patchId === `mcp-client-<name>`
export async function projectOccupancy(ctx, cwd)
// -> { names: Set<mcpServers - disabled>, layer, error }   // 仅 mcp 层已信任时计入
export async function collectOccupancy(ctx, cwd)           // -> { global, project }
export function shadowingSource(serverName, occupancy)     // -> 'global'|'project'|null
export function conflictsForPlugins(occupancy, plugins)    // dry-run：[{ pluginId, serverName, source }]
```

### lib/projection/index.js

```js
export function mountProjection(ctx, { resolveEffective })
// 依赖注入：resolveEffective(cwd) -> Promise<effectivePlugins 的返回形状>（由 index.js 注入 scope.effectivePlugins）
// 挂 agent/created、agent/pre-step、agent/disposed；返回 disposer
// 每次 sync：resolveEffective(cwd) → collectOccupancy(cwd) → 与上次签名比对 → reconcile
// 幂等：同一 agent 重复 sync 不重复挂载；cwd 变化、插件集合变化或 MCP 跳过名单变化时先卸再挂
export function projectionSnapshot()      // sessions[].conflicts 含本次让位记录
export function projectionConflicts(cwd)  // 按 cwd 去重的 [{ cwd, pluginId, serverName, source }]
export function projectionErrors(cwd)     // 最近一次 reconcile 的挂载失败（省略 cwd = 全部）
// -> Array<{ cwd, pluginId, kind: 'skills'|'commands'|'hooks'|'mcp', code, message, at, serverName? }>
// 同一 (cwd, 插件, 能力, 错误码) 只留最近一条；每轮 reconcile 开始时清空该 cwd 的旧记录。
```

投影规则：
- skills：`agent.ctx.plugin({name:'plugin-hub-skills', inject:['skills'], apply(ctx, cfg){...}}, { roots })`
  每个 enabled 插件的技能根都进同一个 provider 还是每插件一个？**每插件一个 provider**（名字含 pluginId，便于卸载与诊断），provider 名 `plugin-hub:<pluginId>`。
- commands：`agent.ctx.plugin({name:'plugin-hub-command-<id>', inject:['commands'], apply})`，
  handler 展开 `$ARGUMENTS` / `$1..$9` 后 `invocation.agent.followup({ content:[{type:'text',text}], source:{kind:'user'} })`，
  返回 `{ kind:'success', text: '…' }`。
- hooks：`agent.ctx.effect` 里注册 `tools/pre-execute` / `tools/post-execute` / `agent/pre-step` / `agent/turn-stopping`，
  spawn `command`（系统 shell）写入 stdin JSON，超时 kill；PreToolUse 退出码 2 → `{ kind:'deny', reason }`（按 DSH 契约字段）。
- MCP：`agent.ctx.plugin(mcpClientPlugin, { serverName, ...config })`，变量展开用 `ctx.workingDirectory.get(session)` 作为项目目录。
  挂载前先查占用表（`occupancy.js`）：与全局/项目同名 → 跳过并记 `{ pluginId, serverName, source }`；
  跳过名单进签名，占用一变就重新 reconcile。同一 Agent 内插件间同名仍按「后到跳过」。
- 子代理不继承（已知边界，写进 README）。

### lib/routes.js（HTTP，前缀 `/plugin-hub/api`）

| 方法 | 路径 | 体 | 返回 |
|---|---|---|---|
| GET | `/overview?cwd=` | — | `{ installed, marketplaces, user, workspace, effective, trust, mcpConflicts, projectionErrors }`；`trust.layers = { mcp, plugins, shared, source }`，`mcpConflicts` 按 cwd 去重，`projectionErrors` 是最近一次 reconcile 的挂载失败 |
| GET | `/components?id=` | — | 单个已安装插件的组件明细 |
| GET | `/versions?id=` | — | `{ id, currentVersion, versions: [{ version, rootPath, sha256, format, mtime, current }] }`；版本号以目录里的清单为准，当前版本排第一；清单 name 接受记录名或当前版本的清单 name（安装名可与包名不同） |
| POST | `/market/add` | `{ source, id? }` | `{ ...marketSummary, marketplace, entries, diagnostics, error }`；id 缺省时按 清单 name → 来源名 派生；失败时若来源已存在则写 `lastError` |
| POST | `/market/refresh` | `{ id }` | 刷新后的 marketplace + entries；成功写 `fetchedAt`/清空 `lastError`，失败写 `lastError` 并保留旧索引 |
| POST | `/market/remove` | `{ id }` | `{ ok: true }`；只删登记与本地缓存副本，目录来源不动用户文件 |
| POST | `/market/entries` | `{ id? }` | 传 id 时单市场；不传时聚合全部市场（`{ marketplace(s), entries, errors, diagnostics }`）；summary 含 `fetchedAt/ageSec/stale/lastError`，过期市场触发一次后台刷新（单飞去重） |
| POST | `/install` | `{ marketplace, name }` 或 `{ source, name? }` | InstalledRecord |
| POST | `/uninstall` | `{ id }` | `{ ok: true }`；删整个 `cache/<market>/<name>/` 桶（含历史版本） |
| POST | `/switch` | `{ id, version }` | 切到缓存里已有的版本：改 rootPath/version/sha256/updatedAt，保留 installedAt、format 与启用状态；未知版本 404 |
| POST | `/enable` | `{ id, enabled, scope, cwd? }` | 新的 effective 行 |
| POST | `/options` | `{ id, options, scope, cwd? }` | 新的 effective 行 |
| POST | `/trust` | `{ cwd }` | `{ trusted: true, hash: 聚合 hash, layers }`；写 canonical 存储（一次批准覆盖 MCP + 插件配置） |
| POST | `/reload` | — | `{ ok: true }`（失效 effective 缓存） |

市场缓存按**来源指纹**（sha1）落盘，与市场 id 解耦：`cache/.markets/<key>/`、`indexes/<key>.json`。
同一个 source 重复添加是幂等刷新；不同 source 撞 id 时自动加 `-2`/`-3`。
索引新鲜度：`fetchedAt` 超过 1 小时（`MARKET_TTL_SEC`）视为过期；`/market/entries` 只为
**directory / url** 来源排后台刷新（git/github 的刷新要替换 checkout，只由用户显式触发），
按 id 单飞，失败后按持久化的 `lastErrorAt` 退避 10 分钟（`MARKET_RETRY_COOLDOWN_MS`）。
刷新本身也由 `materialize` 在临时目录准备、成功后原子替换，不再先删 checkout；失败只写
`lastError`/`lastErrorAt`，不清空旧条目与 `indexPath`。
entry 视图（`entryView`）统一输出 `id=<name>@<marketplace>`、`installed`、`installedVersion`、
`updatable` 与上面列的展示元数据，客户端不需要自己拼身份。

所有 handler 先过 `security.js` 围栏；错误用 `{ error: { code, message } }`。

## 5. Client 契约

- 模块入口 `window.__ModuleLoader__.load({ id: 'dsh-plugin-hub', factory(require){...} })`。
- `inject = ['slots','locale']`；`ctx.locale.register(NS,{zh,en})`；`NS='plugin-hub'`。
- 槽位：
  - `settings.section` id `plugin-hub` order **34**，label「插件中心」
  - `sidebar.panellist` id `plugin-hub` order **34**（`main` 的 key 必须同为 `plugin-hub`）
  - `main` key `plugin-hub`
- 页面（对齐 ZCode 插件的两大功能，两个标签）：
  - **插件市场**：市场源 chips（全部/逐个，过期/抓取失败带标记）+ 添加/刷新/移除；搜索 + 分类筛选；
    卡片网格（头像/名称/描述/版本/组件类型/发布者/已安装/可更新）；条目详情抽屉可直接安装。
  - **插件管理**：已安装列表（头像/版本/来源徽标/组件摘要/运行失败红点/启停/详情/两步确认卸载）；
    从本地目录或 Git 安装；详情抽屉含版本历史（当前标记 + 两步确认切换）、组件树、诊断、`userConfig` 表单。
  - **添加插件市场**对话框：单输入框（GitHub `owner/repo`、Git URL、marketplace.json URL、本地目录），
    支持拖放与「选择目录」（可选 client 服务 `uiWorkspace.pickDirectory`，缺失时静默降级）。
- 每次操作后重新拉 overview；市场条目只在市场标签激活或市场集合变化时拉取。
- 只用真实存在的 `--dsw-*` token；自带 CSS 前缀 `.ph-`；不 import 任何 Harness Client 包。
- 数据全部走 `/plugin-hub/api/*`。

## 6. 安全

- 所有路由：`connection.requestRejection` → 方法白名单 → mutation 要求 `application/json` 且 ≤64KiB。
- 路径：`resolveInside` 词法防线 + 复制/扫描拒绝符号链接。
- 项目配置：未信任不生效；信任键 = 两份项目文件内容 hash 的聚合 sha256（一次批准覆盖 MCP 与插件配置）；编辑后需重新信任。
- MCP：全局 > 项目 > 插件，插件与全局/项目同名时不挂载（不产生两套工具）。
- 变量展开：`${user_config.X}` 只允许进 env/headers/args（与 ZCode 同侧），不进 command/url 之外的敏感位不做特殊处理（V1 仅提示）。
- 响应脱敏：`redact()` 覆盖 `sk-*`、`ghp_*`、`github_pat_*`、`*KEY/SECRET/TOKEN*=...`。

## 7. 代码规则

- 纯 ESM JavaScript（`type: module`），Node ≥20，**零运行时依赖**，不引入构建工具。
- `lib/` 单文件 ≤800 行；`client/client.js` 是模块加载器的**单入口** UI（无法拆分打包），
  按区块注释组织，当前约 2600 行。
- 无法自证的边界写中文注释说明原因（与 ZCode 仓库规则一致）。
- 不写 `console.log` 噪声；只在失败/降级处 `console.warn('[plugin-hub] …')`。
- 每个模块自带冒烟脚本，可用 `node scripts/xxx-smoke.mjs` 直接跑。

## 8. 验证

```bash
node scripts/adapters-smoke.mjs     # 适配器：fixture 清单/组件/市场/来源
node scripts/runtime-smoke.mjs      # 投影：假 agent ctx 记录挂载调用 + MCP 占用/让位（契约 §2）
node client/selfcheck.mjs           # 客户端静态检查（含 zh/en 键对齐）
node client/render-smoke.mjs        # 客户端渲染冒烟（React 桩执行 PanelPage，覆盖详情抽屉与诊断行）
node scripts/smoke.mjs              # 端到端：装 fixture 插件 → 生效 → 统一信任写读 → MCP 冲突 → 卸载
node scripts/claude-smoke.mjs       # Claude 插件兼容
```
