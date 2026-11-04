# dsh-mcp-manager

**dsh-mcp-manager** is a plugin for **DeepSeek Harness (DSH)** that adds a **Settings → MCP Servers** page:
list, enable/disable, edit, add, remove, probe and import/export the profile's MCP servers without
hand-editing `cordis.patch.yml`. It installs into a DSH profile as a plugin bundle and registers the page
in the Settings sidebar. The same page is also reachable from a **MCP 管理** quick entry in the main
sidebar, under 自动化任务. Licensed under MIT.

DSH（DeepSeek Harness）桌面端插件：**设置 → MCP 服务器** 管理面板。
不用再手改 `cordis.patch.yml`，在设置页里看清单、启停、编辑、新增、删除、测连接、导入导出。
每行显示派生的连接状态（已连接 / 连接中 / 连接失败 / 未运行）并可**就地重连**；探测结果给出失败阶段、
修复建议与每个工具输入 schema 的体积。主页面侧边栏「自动化任务」下面还有一个「MCP 管理」快速入口，点开就是同一个面板。

- 目标宿主：**DSH 0.2.1-rc.2**（Electron 桌面版，profile=desktop）
- 依赖：`yaml`（读/写 profile 补丁）

## 它做什么

| 能力 | 走哪条官方通道 | 热生效 |
|---|---|---|
| 列出 profile 里所有 `@deepseek-ai/dsh-mcp-client` 服务器 + 工具数/启动相位/连接健康度 | `pluginManager.listPlugins()`、`ctx.tools.schemas()`（`health` 为派生量，见下文） | 只读 |
| 启用 / 停用（单条或按当前筛选批量） | `pluginManager.setPluginEnabled(entryId, enabled)` | ✅ |
| 就地重连（全局 Fiber `restart()` / 项目重新挂载） | Cordis Fiber `restart()`、`agent.ctx.plugin` | ✅（不写配置） |
| 编辑已有服务器（command/args/env/url/超时/…） | `configEditor.edit(entry, …)`（以**原始层** `inherited` 为基底，`!!js` 原样往返） | ✅（重连该服务器） |
| 连接测试 + 工具枚举 + 工具输入 schema 体积 | `ctx.subprocess.spawn` 手写 MCP stdio JSON-RPC（initialize → tools/list）；http 走 `fetch` | 即时 |
| 新增 / 删除服务器 | 改写 profile `cordis.patch.yml`（只动本插件管理块，锁 + 原子写 + 备份 + 写后校验回滚） | ✅（HMR 监听补丁文件） |
| 导入 / 导出 | 标准 `{"mcpServers":{…}}`（Claude/Cursor/ZCode 通用形状） | — |
| 诊断 | serverName 正则/重名、command 是否存在、`!!js process.env.X` 变量是否缺失、YAML 错误、探测失败阶段归因 | — |

**密钥策略**：面板永不回传密钥值，只显示「已设置（字面量 / `!!js process.env.X`）」；
推荐的持久化形态是 `!!js process.env.VAR`，密钥留在宿主进程环境里，不落进补丁文件。

## 全局 MCP 与项目级 MCP（0.2.0）

设置页与侧边栏面板顶部有作用域切换：

| 作用域 | 存放位置 | 生效范围 | 写入通道 |
|---|---|---|---|
| **全局** | profile `cordis.patch.yml` 里的 `mcp-client-*` 行 | 本 profile 的**所有**会话 | `pluginManager` / `configEditor` / 补丁改写（0.1.x 原有能力） |
| **项目** | `<project>/.dsh/mcp.json` | **只有工作目录是该项目的会话** | 原子写项目文件；Host 在 `agent/created` 与每次 `agent/pre-step` 把启用的服务器挂到该 Agent 上下文 |

项目文件形状与导入/导出一致，只多一个 manager 专用键：

```json
{
  "mcpServers": {
    "proj-tools": {
      "transport": "stdio",
      "command": "node",
      "args": ["scripts/project-mcp.mjs"],
      "env": { "TOKEN": "${env:PROJECT_TOKEN}" }
    }
  },
  "disabled": ["proj-tools"]
}
```

- **挂载方式**：`agent.ctx.plugin('@deepseek-ai/dsh-mcp-client', { serverName, …config })`。
  MCP 客户端把工具注册在**该 Agent 的注册作用域**里，所以项目服务器只对这个会话可见；
  与全局同名的条目不会挂载（全局优先，见「重名优先级」一节）。Agent 释放时自动卸载。
- **生效时机**：文件写入后，下一次模型请求前的 `agent/pre-step` 重新读取并重挂
  （先 `stat`，内容没变就直接跳过）。正在进行的步骤不会中途换工具集。
- **信任门**：仓库是外来输入，克隆不能等于授权执行命令。只有**当前文件内容**被本人批准过
  才会挂载；批准记录在统一存储 `<profileDir>/data/project-trust/trusted.json`（见下一节）。
  通过本页面做的增删改会自动批准新内容，而 `git pull` 或外部编辑会改变 hash，需要重新点「信任并启用」。
- **密钥**：项目文件可随仓库提交，因此支持 `${env:NAME}`（或粘贴的 `process.env.NAME`）引用宿主环境变量；
  面板只显示引用名，不回传值。引用的变量缺失会作为诊断警告列出。
- **停用**：不删除条目，只把名字写进 `disabled`，标准 `mcpServers` 保持可移植。

## 连接健康度、就地重连与探测详情（0.2.3）

### 连接健康度（`GET /servers` 每行 `health`）

宿主不公开 MCP socket 状态，所以这里的 `health` 是**派生量**，输入只有三个宿主事实：
`enabled`、`fiberPhase`、`mcp__<name>__*` 工具数（外加宿主自己的启动失败文案）：

| 观察 | 派生状态 | `reason` / `detail` |
|---|---|---|
| `enabled: false` | `stopped` | `disabled` |
| 无活跃 entry / `fiberPhase: null` | `stopped` | `not-loaded` |
| `fiberPhase: 'failed'` | `failed` | `fiber-failed` + 宿主 `diagnostic`（脱敏、截断 400 字符） |
| `pending` / `loading` / `unloading` | `connecting` | — |
| `active` 但 `ctx.tools.schemas()` 不可用 | `connecting` | `registry-unavailable`（不升级成 failed） |
| `active` 且工具数 > 0 | `connected` | — |
| `active`、0 工具、首次观察 ≤ 5s | `connecting` | — |
| `active`、0 工具、超过 5s | `failed` | `no-tools`；上次探测也失败时是 `no-tools-probe-failed` |
| `active`、0 工具、**新鲜**探测成功 | `connected` | —（合法的不暴露工具的服务器） |

`health.since` 是**当前状态起点**（状态不变则保持第一次观察的时间）。`reason` 是稳定代码（页面本地化），
`detail` 只承载宿主自己的启动文案。探测失败不会把「有工具」的行改成失败，只给「已激活但没工具」提供旁证。

**探测成功何时算数**：一条成功记录只说明**那一刻**。它要作为 `connected` 的证据，必须比本行
「最后一次看到工具」更新（`lastPositiveAt`）——否则一次编辑/重连前留下的成功记录会把刚坏掉的服务器
永久标成已连接。另外缓存里还存着探测目标的指纹（transport + command/args 或 url，不含 env/header），
行定义一改指纹就对不上，`lastProbe` 直接作废（`lib/probe.js` 的 `probeTargetFingerprint`）。

**边界**：这是派生状态，不是心跳。`connected` 表示「工具已注册」；连接中途断开时工具仍在，
直到 `dsh-mcp-client` 放弃重连才回到 `failed`。`fiberPhase: 'active'` 单独一项**不**代表连上
（`failOnStartupError` 默认 `false`，连接失败也会 active）。

### 就地重连（`POST /servers/reconnect`）

| 作用域 | 请求体 | 行为 |
|---|---|---|
| 全局 | `{ entryId }` 或 `{ patchId }` | 对 Loader entry 的 Fiber 调 `restart()`：dispose 后按当前配置重新 `apply`。**不写任何配置文件**，启用状态与补丁字节不变 |
| 项目 | `{ scope: 'project', cwd, serverName }` | 对该项目每个活跃会话卸载并重新 `syncAgent`；`remounted` 是受影响的会话数，`remountedServers` 是实际重挂的服务器名，`failed` 逐条列出挂载失败的服务器，`error` 是模块加载失败文案 |

- 停用行拒绝重连（409 `conflict`）；没有活跃 Fiber 的 entry（模块没加载）返回 409 `not-manageable`；
  未信任的项目返回 409 `conflict`（没批准就没有挂载，重连只会是空操作）。
- 宿主拒绝重启（例如上一代连接清理未完成）按 409 返回，不重试——这表示需要重启宿主。
- 有 HMR 时重启在 `hmr.runExclusive` 内执行，不会与 profile 重组交错。
- **项目重连会重挂该会话的全部项目服务器**：按 Agent 挂载没有逐服务器投影，`serverName` 只用于
  定位与校验；页面 toast 与按钮提示都写明了这一点。
- **重连立即生效**：正在进行的模型步骤会立刻失去该服务器的工具（全局）或该会话的项目工具（项目）。
  这是显式操作，按钮 title 会提示「会中断正在进行的调用」。

### 探测：阶段归因、修复提示与 schema 体积

`POST /probe` 的失败结果多了 `stage` 与 `hint`：

| `stage` | 含义 | 对应建议（`hint`） |
|---|---|---|
| `config` | 定义不完整（没有 command/url） | 先补配置 |
| `spawn` | 进程起不来 / 端点连不上（含 `ENOENT`/`EACCES` 等启动错误） | 检查 PATH、可执行位、工作目录；Windows 上 npx 等 `.cmd` 需要 shell；http 检查 URL、代理与 TLS |
| `initialize` | 进程/端点已接受请求，但 MCP 握手没完成（含 http 等待回复超时） | 可能不是 MCP 服务、协议版本不同，或启动即退出（看 stderr） |
| `tools-list` | 握手成功，列工具失败 | 服务可能不实现 tools/list |
| `ok` | 成功 | — |

成功结果里每个工具现在带：

- `schemaBytes` / `estimatedTokens`（≈ bytes/4，仅用于排序，不是计量）；
- `required` / `propertyCount`；
- `inputSchema`（有界：单 schema 32KB、单次响应合计 256KB；超限时降级为 type/required/属性名/枚举/default 并标 `schemaTruncated`，再超则整份省略并标 `schemaOmitted`）。

`lastProbe` 只缓存 `{name, description, schemaBytes, estimatedTokens, required, propertyCount}` 摘要，
完整 `inputSchema` 只出现在 `POST /probe` 的响应里——`GET /servers` 不会为一次列表刷新下发整个工具目录。

### 列表检索、筛选、排序与批量启停

- 搜索框（按 `/` 聚焦；输入框内不劫持）、筛选 chips（全部 / 已启用 / 已停用 / 有问题 / 未探测，
  项目作用域多一个「已跳过」）、排序（名称 / 工具数 / 上下文成本 / 最近探测）。
- 筛选偏好只存 `localStorage`（全局 `dsh-mcp-manager/list-prefs`、项目 `…:project` 两个键，
  互不影响），不影响任何配置。
- 批量启停 `POST /servers/toggle-batch`（`{ entryIds, enabled }`）按顺序逐条调用
  `pluginManager.setPluginEnabled`，返回逐行 `results`（含 `application` / `restartReason`）与
  `changed` / `failed` 计数；页面上的批量按钮只作用于当前筛选出的行，并把
  `restart-required` / `overridden` 的行单独提示，不会当成「已生效」。不走前端循环 N 次 POST，
  避免 N 次 HMR 重组互相打断。
- 全局作用域的重连/批量按钮按 `entryId` 寻址；项目作用域的重连按 `serverName` 寻址。

## 统一项目信任与重名优先级（0.2.2）

0.2.2 起，本插件的「项目信任」与「MCP 重名」口径与 dsh-plugin-hub / dsh-skill-manager 共用同一份契约
（`plugin-library/docs/plugin-suite-boundaries.md` §1、§2）。

### 统一信任存储（契约 §1）

| 项 | 值 |
|---|---|
| 权威文件 | `<profileDir>/data/project-trust/trusted.json` |
| 记录键 | 项目绝对路径规范化：反斜杠→`/`、去末尾`/`、Windows 转小写 |
| 覆盖范围 | 一次批准同时覆盖 `<cwd>/.dsh/mcp.json` 与 `<cwd>/.dsh/plugins.json` |
| 聚合 hash | `sha256("dsh-project-trust/v1\nmcp:" + (mcp ?? "-") + "\nplugins:" + (plugins ?? "-"), utf8)` |
| 锁文件 | 固定 `<store>.lock`（与其它两个插件互斥） |

- 判定：`mcp 层` = canonical 命中 **或** 旧 mcp-manager 记录命中；`插件层` = canonical 命中 **或** 旧 hub 记录命中。
  旧记录只读回退，点一次「信任」后整体升级为 canonical，此后任一份文件变化都要重新批准。
- 任一份文件不存在时，对应层显示「不适用」；只有一份文件时批准它即可。
- 写入是「读当前 → 只改自己这条 → 原子写回」，不会丢掉其它项目的记录；撤销删除 canonical 记录，
  并尽力删掉本插件自己的旧记录（不动 hub 的旧记录）。

### MCP 服务器重名优先级（契约 §2）

**全局（profile `mcp-client-*` 行）> 项目（受信任的 `.dsh/mcp.json`）> 插件（dsh-plugin-hub）**

- 全局名字来自 `pluginManager.listPlugins()`（`moduleName === '@deepseek-ai/dsh-mcp-client'` 且未被停用，
  `patchId` 形如 `mcp-client-<name>`），并用 `ctx.tools.schemas()` 的 `mcp__<name>__` 命名空间兜底。
- 项目里的服务器与全局同名 → **跳过挂载**（全局优先），每个名字只 `warn` 一次；
  `GET /project` 的 `problems` 给出「不会挂载（全局优先）」，payload 的 `skipped`、行上的 `skipped`
  标记与 `runtime[].skipped` 都列出被跳过的名字。
- 全局占用集合计入挂载签名：全局连接完成或停用后，下一次 `agent/pre-step` 会重新 reconcile。
- 前端信任横幅与作用域行按分层显示：`MCP: 已信任/未信任/不适用`、`插件: 已信任/未信任/不适用`。

验证：`node scripts/smoke.mjs` 的 Q 节覆盖聚合 hash 向量、canonical 读写、旧记录回退、项目服务器被全局同名跳过；
`node client/selfcheck.mjs` 覆盖中英文案字典与模块启动。

## 安装

宿主只对**真实目录**做 `@deepseek-ai/*` 模块拦截，所以请以 tarball 形式安装，不要直接拷贝源码目录：

```bash
git clone https://github.com/sanqiuyef/dsh-mcp-manager.git
cd dsh-mcp-manager
npm pack          # 生成 dsh-mcp-manager-<version>.tgz
```

再用 DSH 的插件管理器安装这个 tarball，任选一条：

- **Web GUI**：设置 → 插件 → 安装，选中刚生成的 `.tgz`；
- **宿主工具**：`plugin_manager({ action: 'install_bundle', target: '<abs>/dsh-mcp-manager-0.2.1.tgz' })`；
- **profile bundle 安装入口**：本包自带 `cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch`），
  经 bundle 方式安装后会自动挂载 host 路由与设置页；
- **不自己构建**：直接从本仓库的 **Releases** 页下载已打好的 `dsh-mcp-manager-<version>.tgz`，
  再按上面任一方式安装。

装好后：设置 → 左侧出现「**MCP 服务器**」（order 30），主页面侧边栏「自动化任务」下面出现「**MCP 管理**」。迭代流程：改源码 → 递增版本号 → 重新 `npm pack` → 重装 tarball。

## 测试

离线断言，不依赖运行中的宿主（需要 Node.js ≥ 20）：

```bash
node --check client/client.js   # 浏览器半区语法检查
node client/selfcheck.mjs       # 插件注册 / 本地化词典键集 / 导航装饰逻辑（假宿主）
node scripts/rendercheck.mjs    # 真实渲染：状态灯/健康文案/重连按钮/筛选/搜索/schema 详情（假 React 真执行组件）
node scripts/smoke.mjs          # YAML 渲染往返、探测（含 stage/schema 预算）、健康度派生、安全、导入导出
node scripts/probe-runtime.mjs  # 真起进程/真起 HTTP：stage 归因（ENOENT/超时/HTTP 错误）与 schema 透传
```

## 环境变量桥（0.1.3）

有些 MCP 行用 `!!js process.env.X` 引用凭据，但宿主进程环境可能拿不到（例如 DSH 由旧启动器拉起）。
插件在 `apply()` **最先**读 `<profile>/data/mcp-manager/secrets.json`，把**尚未设置**的键注入 `process.env`：

```json
{ "PLAYWRIGHT_MCP_EXTENSION_TOKEN": "…" }
```

- 只读该文件（插件不创建/不改）；键名须 `^[A-Za-z_][A-Za-z0-9_]*$`、值须非空字符串；非法项跳过并在诊断里列出；
- 已存在的环境变量不覆盖；坏 JSON/读失败只 warn，不阻塞插件；
- `GET /servers` 顶层与诊断快照 `backend.envBridge` 只回**键名与状态**，绝不回显值；
- Windows 上建议用 ACL 限制该文件仅当前用户可读写（`icacls secrets.json /inheritance:r /grant:r "<user>:(R,W)"`）。

## 设置导航图标（0.1.4，临时装饰）

设置面板左侧导航的图标由外壳写死：`@deepseek-ai/dsh-client-ui-settings-general` 的 `navIcon(id)` 只认
`account / models / agent-presets / plugins / archived-sessions`，**未知 id 一律兜底成齿轮**；而
`settings.section` 的注册参数只有 `id / order / label`，插件没地方声明图标。于是本页（id `mcp-manager`）
在导航里和「设置」入口共用一个齿轮——不符合实际情况。

为此 `client/client.js` 在 `apply()` 里加了一个**防御式装饰** effect（`installNavGlyph`）：设置面板出现时，
只认 `[data-shortcut-modal="settings"]` 内、`span.navLabel` 文案与本插件 zh/en `nav` 文案完全相等的那一行，
把兜底齿轮 `display:none`，并在其前插入本插件自己的 16×16「服务器机架」图形（`viewBox 0 0 16 16`、
`stroke-width 1.3`，与 DSH Medium 图标同规格）。DOM 结构不符合预期就什么都不做（保留原齿轮、不抛错）；
缺 `document` / `MutationObserver` / `createElementNS` 的环境直接返回空清理函数，一行 DOM 都不碰。
effect 清理器会删除插入的图形、恢复齿轮显示、断开 observer。

**为什么要有这段代码**：这不是插件的正常功能，而是对外壳「导航图标按 id 写死」这一实现的适配；
它只碰自己的那一行、可整体删除，并且不修改 DSH 安装目录或 `app.asar`。

**移除条件（重要）**：一旦 `settings.section` 的注册参数支持 `icon`，就应**整段删除**
`NAV_PANEL_SELECTOR` / `NAV_GLYPH_ATTR` / `NAV_GLYPH` / `navGlyphElement` / `decorateNavRow` /
`installNavGlyph` 这 6 个定义与 `apply()` 里那个 `settings-nav glyph` effect，改为在注册参数里声明 `icon`。

**验证范围**：`client/selfcheck.mjs` 只离线断言「只装饰自己那一行 + 清理能还原」的逻辑，
**不是视觉验证**；本仓库不含浏览器视觉快照。

## 主题 token 修正（0.1.5）

设置页原先引用了两个 DSH 主题里**并不存在**的变量——CSS 变量名写错不会报错，只会让 `var()` 在计算值阶段
失效，`color` / `font-family` 静默回退成继承值（错误态只剩文案、危险按钮与普通按钮同色）：

| 原引用 | 主题里的正确 token | 本页处数 |
|---|---|---|
| `--dsw-alias-label-error` | `--dsw-alias-state-error-primary`（浅色 `--dsw-static-red-600` / 深色 `--dsw-static-red-400`；宿主设置页自用同款） | 13 |
| `--dsw-font-mono` | `--ds-font-family-code`（主题的等宽栈） | 9 |

现已全部替换为宿主 token，未引入字面量兜底。本包 `client/client.js` 里的每个 `var(--…)` 都应存在于
宿主主题的 token 定义中；**升级 DSH 后请重新核对**（把 `var(--…)` 名字与所装 DSH 的主题 token 定义逐一比对，
出现未定义的名字即为回归）。

## 侧边栏快速入口（0.1.7）

除设置页外，主页面侧边栏「自动化任务」下面多一行 **MCP 管理**。实现只用宿主的两个公开槽位：

| 槽 | 注册 | 作用 |
|---|---|---|
| `sidebar.panellist` | `id: 'mcp-manager'`、`order: 30`、`label: () => t('panel.label')` | 侧边栏那一行（图标是装饰性 SVG，只收 `{ size, active }`；可访问名由宿主行提供） |
| `main` | `key: 'mcp-manager'`（与 panellist id 必须一致） | 点开后中栏渲染的面板 |

面板组件 `PanelPage` 只是页壳：`.mw-panel` 满高 + `.mw-panel-scroll` 滚动 + `.mw-panel-content`（960px、`clamp(24px,4vw,48px)` 边距）。内部直接复用设置页的 `Page`，两处入口不会分叉。宿主 `main` 槽不提供页壳，所以滚动与留白归本插件所有；宿主若将来统一提供，可整段删掉 `.mw-panel*`。

验证（2026-10-22，desktop profile 热装 0.1.7）：`cordis_inspect_query` 的 `Slots.listSubTree` 读回
`sidebar.panellist` occupants = `plugins(0) / schedules(10) / skill-manager(20) / mcp-manager(30)`、
`main` occupants 含 `mcp-manager` 且 `active: true`；桌面版窗口里点开该行，标题、工具栏、服务器列表与设置页一致。
离线侧由 `client/selfcheck.mjs` 断言三条注册（settings.section / sidebar.panellist / main）与中英文案。

## 结构

| 路径 | 说明 |
|---|---|
| `lib/index.js` | host 入口：`name` / `inject` / `apply`，注册 16 条 `/mcp-manager/api/*` 路由（10 条全局 + 6 条项目作用域） |
| `lib/health.js` | 连接健康度派生（`enabled` + `fiberPhase` + 工具数 + 宿主诊断，5s 启动宽限） |
| `lib/reconnect.js` | 全局行就地重连：Fiber `restart()`（不写配置），有 HMR 时在 `runExclusive` 内执行 |
| `lib/project.js` | 项目文件 `<project>/.dsh/mcp.json` 的读写、hash、原子写、`${env:NAME}` 解析；信任相关的旧导出保留为薄封装 |
| `lib/project-trust.js` | 统一项目信任存储（契约 §1）：聚合 hash、分层判定、canonical 读-合并-原子写、旧记录只读回退 |
| `lib/global-mcp.js` | 全局 MCP 占用集合（契约 §2）：`pluginManager` 行 + `tools.schemas()` 兜底，供项目作用域查重名 |
| `lib/project-runtime.js` | 按 Agent 挂载/卸载 `@deepseek-ai/dsh-mcp-client`（`agent/created`、`agent/pre-step`、`agent/disposed`），全局同名的条目跳过并记入 `skipped`；`remountProjectServer` 供「重连」使用 |
| `lib/project-api.js` | 项目作用域路由实现：视图（含 `trustLayers` / `skipped`）、信任、增删改、启停、探测目标解析 |
| `lib/servers.js` | 列表与配置读取（`configuration()` 的 inherited/override） |
| `lib/toggle.js` / `lib/edit.js` | 启停、编辑（原始层基底） |
| `lib/patch.js` | 管理块增删：`withFileLock` + `writeFileAtomic` + 备份 + 写后校验 |
| `lib/probe.js` | stdio / streamable-http 探测（8s 超时、可取消、脱敏；阶段归因 + 建议 + 有界 `inputSchema`） |
| `lib/transfer.js` | 导入/导出 |
| `lib/diagnostics.js` | 配置体检 |
| `lib/security.js` | `requestRejection`、POST/JSON/64KiB/no-store |
| `lib/env-bridge.js` | 环境变量桥：`<profile>/data/mcp-manager/secrets.json` → `process.env`（只补缺失键） |
| `client/client.js` | 浏览器设置页 + 侧边栏快速入口（`settings.section` / `sidebar.panellist` / `main`，手写 CJS，无构建） |
| `client/selfcheck.mjs` | 浏览器半区离线自检（假宿主） |
| `scripts/rendercheck.mjs` | 浏览器半区渲染自检：用假 React 真执行组件，断言状态灯、健康文案、重连按钮、筛选/搜索与 schema 详情 |
| `scripts/smoke.mjs` | host 半区离线断言（不依赖宿主），含项目作用域文件/统一信任/重名跳过、16 条路由、健康度派生与探测 schema 预算 |
| `scripts/probe-runtime.mjs` | 真实探测自检：自带 `ctx.subprocess` 适配器与本地 HTTP 服务，验证 stage 归因与 schema 透传 |
| `scripts/fixture-mcp.mjs` | 测试用最小 stdio MCP 服务器（只暴露 `ping`），用于真机验证 per-Agent 挂载；不打进 tarball |

源码注释里出现的 `contract §N` 指本插件 HTTP 契约的内部小节编号（无外部文档，路由表见 `lib/index.js`）。

## 已知限制

- 连接状态是**派生**的，不是 socket 心跳：`health` 由启用状态、Fiber 相位与工具命名空间推出
  （见「连接健康度」一节）。`fiberPhase: 'active'` 单独一项不代表连上；连接中途断开时工具仍在，
  直到客户端放弃重连才显示 `failed`。
- 重连只能重启已有 entry：全局行依赖 Cordis Fiber `restart()`，项目行依赖重新挂载；模块本身
  加载失败的 entry 没有 Fiber，只能改配置或重启宿主。
- **重连立即生效，会中断进行中的调用**：全局行 dispose 后重挂，正在跑的调用失败；项目行会重挂
  该会话的**全部**项目服务器。页面按钮 title 写明了这一点，不提供「等下一步再生效」的选项。
- 编辑任一服务器都会让该条目整实例重挂（子进程重启、工具短暂消失），页面会提示。
- 新增/删除没有官方运行时 API，只能改 profile 补丁；写坏的文件在**下次启动**时会让组合失败，
  因此写前备份、写后校验、失败自动回滚，且删除对非本插件管理的行降级为「停用」。
  新增成功时响应也带 `backupPath`（失败时同样在错误消息里给出），不必去猜时间戳文件名。
- 设置导航图标依赖外壳 DOM 结构（见上节），外壳改版后装饰会静默失效（功能不受影响）。
- **项目作用域只在下一个模型请求前生效**：正在执行的步骤不会中途替换工具集；文件改动在
  `agent/pre-step` 重读后挂载/卸载，因此页面上的「停用」对当前步骤同样有一步延迟。
- **子代理（subagent）实测不继承项目服务器**：父会话按 `agent/created` / `agent/pre-step` 正常挂载，
  但同目录的子代理首个请求没有拿到 `mcp__*` 项目工具（2026-10-22 实测）。需要子代理使用项目
  MCP 时，请在同一项目目录另开正式会话；这是宿主子代理生命周期与挂载点的边界，不是配置问题。
- **每个会话各起一套进程**：项目服务器按 Agent 作用域挂载，多个会话同时使用同一项目时会各起一个
  子进程（与宿主 MCP 客户端的隔离语义一致）。
- **全局优先**：项目服务器与全局 MCP 同名时**不会挂载**（契约 §2），页面上以「已跳过」标记。
  想同时保留两份请改名；这不会自动改项目文件。
- **信任记录的升级是显式的**：旧 `data/mcp-manager/trusted-projects.json` 仍然生效（只读），
  只有用户在页面上点过一次「信任并启用」才会整体升级为 `data/project-trust/trusted.json`；
  两个插件都会写这份文件，手工编辑它可能让另一边的判定一起变化。
- **只读仓库无法保存**：项目文件写入受文件系统权限约束，只读挂载会返回写入错误，页面会保留原列表。
- 不支持：云端同步、OAuth、官方 MCP 市场、workspace 作用域、工具浏览器/资源浏览、
  逐服务器工具延迟加载（`toolSearch`/defer）与工具调用账本。面板只给出 schema 体积与估算 token
  作为排序依据，不写宿主 Config 的未知字段（写错键会让整棵配置加载失败）。

## 卸载

`plugin_manager({ action: 'remove_bundle', target: 'dsh-mcp-manager' })`。
本插件通过管理块写入的服务器行会留在 profile 补丁里（可用外部编辑器手工清掉），这是刻意的：
卸载管理工具不应连带删除用户数据。

## License

MIT © 2026 sanqiuyef — 见 [LICENSE](./LICENSE)。
