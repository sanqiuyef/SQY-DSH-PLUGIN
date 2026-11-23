# dsh-skill-manager — Host/Client API 契约（v3.1）

本文件是 Host 半侧（`lib/`）与浏览器半侧（`client/client.js`）之间**唯一的接口约定**。
任何一侧改动字段名/路径，都必须先改本文件并同步另一侧。

- 插件包名：`dsh-skill-manager`
- 路由前缀：`/skill-manager/api`（同源，`fetch(..., { credentials: 'same-origin' })`）
- 响应：`application/json; charset=utf-8`，`cache-control: no-store`
- 错误信封：`{ "error": { "code": string, "message": string } }`，HTTP 状态码同步携带语义
- 写操作：仅 `POST`，`content-type: application/json`，body ≤ 512 KiB（内容本身仍 ≤ 256 KiB，见 §3.3）
- v2 新增 4 条路由（§3.10–§3.13），字段只增不改，但有两处**语义**变化必须知道：
  1. `overview.market.installed` 从「个人根同名的技能数」变为「本次请求的可写根里的安装账本条目数」；
  2. `market.repos[].skills[].installed` 从「按 name 匹配个人根」变为「按 `{repo, folder}` + 目标根精确匹配账本」，
     同名但来源不同的条目改标 `nameTaken`。
  另外新增可选入参 `cwd` 对所有路由生效（§5）。

## 1. 技能根（roots）

Host 按与宿主 `dsh-skill-filesystem` **相同的 rank 表**扫描（顺序即优先级）：

| rank | rootId | source | 路径 | kind | 可写 |
|---:|---|---|---|---|---|
| 100 | `project-dsh` | `project-dsh` | `<projectRoot>/.dsh/skills` | project | ✅ |
| 150 | `project-zcode` | `project-zcode` | `<projectRoot>/.zcode/skills` | project | ✅ |
| 200 | `project-agents` | `project-agents` | `<projectRoot>/.agents/skills` | project | ✅ |
| 300 | `custom:<n>` | `custom` | 来自插件 Config `customSkillDirs` | custom | ✅ |
| 400 | `user-dsh` | `user-dsh` | `<dshHome>/skills`（跳过 `.system` 子目录） | user | ✅ |
| 450 | `user-zcode` | `user-zcode` | `<zcodeHome>/skills`（默认 `~/.zcode/skills`） | user | ✅ |
| 500 | `user-agents` | `user-agents` | `<agentsHome>/skills` | user | ✅ |
| 600 | `bundled` | `bundled` | Config `bundledSkillDir`（若配置） | bundled | ❌ 只读 |

`.zcode` 与 `.agents` 成对出现、`.zcode` 排在前，与 ZCode 自己的根顺序一致（`apps/zcode-cli/packages/adapters/src/skills/roots.ts`）；`user-zcode` 排在 `user-dsh` 之后，所以 `~/.dsh/skills` 里的副本仍然胜出，ZCode 那份标 `shadowed` 而不是静默重复。

- `projectRoot`＝从请求 `cwd` 向上找最近含 `.git` 的祖先；找不到则用 `cwd` 本身。
- 无 `cwd` 时，Host 取**当前活跃会话的生效目录**（`workingDirectory.get(session)`，取最新一个 live agent），再回退 `workingDirectory.defaultDirectory`，最后回退进程 cwd。设置面板不传 `cwd` 也能对上"我当前在哪个项目"。
- `dshHome` 默认 `%DSH_HOME%` 或 `~/.dsh`；`agentsHome` 默认 `%DSH_AGENTS_HOME%` 或 `~/.agents`；`zcodeHome` 默认 `%ZCODE_HOME%` 或 `~/.zcode`。允许 Config 覆盖。
- 一个根可能不存在（`exists: false`）：仍要出现在 `roots[]` 里，前端展示为"未创建"。
- 发现规则与宿主一致：只扫描根目录的**直接子项**——`<name>/SKILL.md`（目录技能）或 `<name>.md`（单文件技能），不递归。
- 停用位：`<root>/_disabled/<name>/` 或 `<root>/_disabled/<name>.md`（本插件约定，宿主没有原生停用）。
- 回收站：`<root>/_trash/<name>@<ISO时间戳>/`（删除＝移动，绝不 rm -rf 用户目录）。
- 插件中心（dsh-plugin-hub）的技能**不在**上表（它们不落磁盘根），而是通过宿主 `skills`
  服务暴露，provider 为 `plugin-hub:<pluginId>`，固定 rank **350**（介于 custom 300 与
  `user-dsh` 400）。`overview` 只读取它们用于同名对照，见 §2 的 `shadowedByPlugin`。

## 2. 技能对象（skill）

```ts
interface SkillIssue {
  level: 'error' | 'warn'
  code: string        // 见 §7
  message: string     // 面向人的中文/英文说明由前端按 code 翻译，message 为兜底原文
  line?: number       // frontmatter 行号（可选）
}

interface Skill {
  key: string                 // `${rootId}/${dirName}`，前端 React key
  rootId: string
  rootLabel: string           // 根的人类可读短名，如 "用户技能" / "项目技能" / "市场"
  rootPath: string
  source: string              // project-dsh | project-agents | custom | user-dsh | user-agents | bundled
  rank: number
  writable: boolean
  dirName: string             // 磁盘上的条目名（不含 .md）
  kind: 'directory' | 'file'
  state: 'enabled' | 'disabled' | 'invalid'
  name: string                // frontmatter name（invalid 时尽量回退 dirName）
  description: string
  whenToUse?: string
  invocation: { model: boolean, user: boolean }
  path: string                // SKILL.md 或 <name>.md 绝对路径
  bodyChars: number           // 正文（frontmatter 之后）字符数
  size: number                // 字节
  mtimeMs: number
  hash: string                // 内容 sha256（保存冲突检测用）
  issues: SkillIssue[]
  shadowed: boolean           // 同名技能被更高 rank 的根遮蔽
  shadowedBy?: { rootId: string, rootLabel: string }
  shadowedByPlugin?: { provider: string } // 同名插件技能（rank 350）胜出；不覆盖 shadowedBy
  resources?: { files: number, references: number, scripts: number, assets: number } // 仅目录技能
  meta?: Record<string, unknown>   // frontmatter 的额外顶层键
}
```

`state` 判定：`invalid`（存在 error 级 issue）> `disabled`（位于 `_disabled/`）> `enabled`。

## 3. 接口

### 3.1 `GET /skill-manager/api/overview?cwd=<abs>`

```ts
interface Overview {
  cwd: string
  projectRoot: string
  dshHome: string
  agentsHome: string
  roots: Array<{
    id: string; label: string; source: string; rank: number; kind: 'project'|'user'|'custom'|'bundled'
    path: string; exists: boolean; writable: boolean; skillCount: number
  }>
  skills: Skill[]                       // 已启用 + 已停用 + 异常，全部
  counts: {
    total: number; enabled: number; disabled: number; invalid: number
    shadowed: number                      // 被同根 / 更高 rank 根遮蔽
    shadowedByPlugin: number              // 被同名插件技能（rank 350）遮蔽
  }
  diagnostics: Array<{ code: string; message: string; rootId?: string; name?: string; path?: string }>
  market: { available: boolean; path: string; repos: number; skills: number; installed: number; lastSyncAt?: string } | null
  pluginSkills: {                       // 当前 live Agent 可见的插件技能（只读视图）
    available: boolean                  // Agent / skills 服务不可用时 false，不阻塞其余字段
    count: number
    providers: string[]                 // 去重排序的 provider（如 ["plugin-hub:demo"]）
    error?: string                      // available=false 时的降级原因
  }
  scannedAt: number
}
```

`market.installed` 是**安装账本**在**本次请求的可写根**里的条目数（§3.9），不是「个人根里有几个同名技能」；
没有账本文件时为 0。`market` 读取失败时降级为
`{ available: false, path, repos: 0, skills: 0, installed: 0, error }`，字段保持齐全。

`shadowedByPlugin` 只标在 **enabled 且 rank > 350** 的扫盘条目上（即 `user-dsh` 400、
`user-agents` 500、`bundled` 600）：project 100/200 与 custom 300 本地技能仍优先，不标。
插件技能由 `listPluginSkills()` 通过 `agent.ctx.get('skills').list({ scope: agent, cwd })`
读取，只保留 provider 以 `plugin-hub:` 开头的条目；任何异常都降级为
`{ available: false, count: 0, providers: [], error }`，绝不抛错阻塞 `overview`。

### 3.2 `GET /skill-manager/api/skill?rootId=&dirName=&kind=&state=`

```ts
interface SkillDetail {
  skill: Skill
  content: string        // 完整 SKILL.md（含 frontmatter）
  frontmatter: Record<string, unknown> | null
  body: string           // frontmatter 之后的正文
  eol: 'lf' | 'crlf'
  hasBom: boolean
}
```

`kind` ∈ `directory|file`，`state` ∈ `enabled|disabled`。命中失败 404 `not-found`。
返回的 `skill` 与 `overview` 同口径：被插件同名遮蔽时也带 `shadowedByPlugin`。

### 3.3 `POST /skill-manager/api/skill/save`

```ts
// 请求
{ rootId, dirName, kind, state, hash, content }
// 成功 200
{ ok: true, hash: string, issues: SkillIssue[] }
```

- `hash` 必须是读取时的值；与服务端当前内容 hash 不一致 → **409 `conflict`**（绝不覆盖别人的编辑）。
- 保存前重算 frontmatter：解析失败仍允许保存，但返回 `issues` 里带 `error`，前端需显著提示"宿主会丢弃该技能"。
- 内容上限 256 KiB，超限 413 `too-large`。
- 写入使用"同目录临时文件 + rename"，保留原 EOL；`stripBom: true` 时去掉 BOM。

### 3.4 `POST /skill-manager/api/skill/create`

```ts
// 请求
{ rootId, name, description, whenToUse?, body?, invocation?: { model?: boolean, user?: boolean },
  kind?: 'directory' | 'file' }
// 成功 200
{ ok: true, skill: Skill }
```

- `name` 必须 kebab-case、单路径段、≤64 字符；目标根内（**含 `_disabled/`**）重名 → 409 `exists`。
- 只在**可写**根下创建；bundled → 403 `read-only`。
- `kind` 省略时生成目录技能 `<root>/<name>/SKILL.md`；`kind: 'file'` 生成单文件技能 `<root>/<name>.md`。
- frontmatter 含 `name` / `description` /（可选）`whenToUse`；`invocation` 为 false 时写 `disable-model-invocation: true` / `user-invocable: false`。

### 3.5 `POST /skill-manager/api/skill/toggle`

```ts
{ rootId, dirName, kind, enabled: boolean }
// 成功 200
{ ok: true, state: 'enabled' | 'disabled' }
```

- 移动而非改标志：`_disabled/` 双向；目标已存在 → 409 `exists`。
- 根只读 → 403 `read-only`。

### 3.6 `POST /skill-manager/api/skill/delete`

```ts
{ rootId, dirName, kind }
// 成功 200
{ ok: true, trashed: string }   // 移入的绝对路径
```

移入 `<root>/_trash/<dirName>@<yyyyMMddTHHmmss>/`；同名冲突自动加序号。**不删除任何内容**。

### 3.7 `POST /skill-manager/api/open`

```ts
{ rootId, dirName?, kind?, state? }   // 不给 dirName → 打开该根目录
// 成功 200
{ ok: true, opened: string }
```

用系统文件管理器打开（Windows `explorer.exe`）。仅允许打开**扫描过的根**或其**直接子项**；`state` 决定停用技能去 `_disabled/` 下找。目标不存在 → 404 `not-found`（不再静默成功）。

### 3.8 `GET /skill-manager/api/market?query=&limit=&perRepo=`

读取本机 skills 市场克隆（默认 `~/.dsh/skills-management/market`，Config `marketDir` 可覆盖）。
市场层级：`<marketDir>/skills/<repo>/<folder>/SKILL.md`（或 `<folder>.md`）。

**浏览 vs 搜索**：本机克隆实测 47 仓库 / 6440 技能。无 `query` 时返回**全部仓库**，每个仓库最多 `perRepo`（默认 8）个代表技能，附 `total` 表示该仓库总技能数；有 `query` 时全库子串匹配（name/description/repo/folder），按仓库分组，每仓库最多 50 个，总量封顶 `limit`（默认 500，最大 500）。

```ts
interface MarketView {
  available: boolean
  path: string
  lastSyncAt?: string
  counts: {
    repos: number        // 命中仓库数
    skills: number       // 本次返回的技能条数
    installed: number    // 本次返回里已安装的数量
    totalSkills: number  // 市场总技能数（索引规模）
    matching: number     // 命中查询的总数（无 query 时 = totalSkills）
  }
  truncated: boolean     // matching > skills
  repos: Array<{
    repo: string
    label: string
    total: number        // 该仓库命中数
    skills: Array<{
      folder: string
      name: string
      description: string
      path: string
      installed: boolean        // 账本里有「这个 repo+folder」的安装记录（精确匹配）
      nameTaken?: boolean       // 目标根里有同名技能但不是本市场条目装的 → 直接装会 409
      installedAt?: string      // 账本记录（ISO）
      installedPath?: string    // 账本记录的目标绝对路径
      updateAvailable?: 'current' | 'different' | 'missing' | 'unknown'
      issue?: string     // 市场侧 frontmatter 不合法时的原因
    }>
  }>
}
```

`installed` **不按名字猜**：只有 `install-state.json`（§3.9）里存在同 `{repo, folder}` **且
`rootPath` 属于本次请求解析出的可写根**的记录才算——账本跨工作区共享，在 A 工作区装的条目
不能在 B 工作区的视图里冒充「已安装」（否则「更新」会把 B 里的同名本地技能移进 `_trash/`）。
同名但来源不同（手写技能、另一个仓库的同名技能、别的工作区装的）标 `nameTaken`。

`updateAvailable` 只对已安装条目计算（其余为 `undefined`）：把市场源目录的逐文件
sha256 与安装时记录的比较 ——

| 值 | 含义 |
|---|---|
| `current` | 逐文件哈希一致（单文件条目按内容比较，不看文件名） |
| `different` | 市场侧内容与安装时不同 |
| `missing` | 账本记的目标路径已不存在，或市场侧已读不到文件 |
| `unknown` | 无法判定：账本没存文件哈希、记录标记 `complete: false`、或本次采样不完整（>200 文件 / 单文件 >1 MiB / 目录深度 >4） |

`unknown` 绝不当作 `different`：证明了不等才叫「有更新」。

索引首次构建约 1.2s（并发解析 + 5 分钟缓存），之后搜索为毫秒级。

### 3.9 `POST /skill-manager/api/market/install`

```ts
// 请求
{ repo, folder, rootId?: string, overwrite?: boolean }
// 成功 200
{ ok: true, name: string, targetPath: string, replaced: boolean, recorded: boolean }
```

- `rootId` 默认 `user-dsh`；必须是可写根。
- 目标同名已存在且 `overwrite !== true` → 409 `exists`。
- `overwrite: true` **只覆盖本面板装的那份**：账本里同根同名记录的 `targetPath` 必须等于磁盘上现有条目，否则 409 `conflict`（`{error:{code:'conflict',message:'目标不是本面板安装的，未覆盖'}}`）——避免「更新」把用户手写的同名技能静默移进 `_trash/`。
- 复制目录（含 references/scripts/assets）；先复制到 `<root>/.install-<name>-<ts>` 再 rename，避免半成品。
- 安装后**不**自动启用/停用任何状态（新拷贝即启用）。
- 成功后写**安装账本** `<marketDir>/../install-state.json`（与 `skills-market-sync.json` 同目录）：

```ts
{
  version: 1,
  installed: {
    "<rootPath>\u0000<name>": {
      repo: string, folder: string, name: string,
      rootId: string, rootPath: string, targetPath: string,
      installedAt: string,                       // ISO
      files: Record<string, string>,             // 相对路径 → sha256（超限/超采样文件省略）
      complete: boolean                          // files 是否为完整快照；false 时更新检测给 unknown
    }
  }
}
```

  单文件条目的 `files` 键固定为 `<entry>`（安装后会重命名为 frontmatter name，文件名不可比）。
  账本写失败**不影响**安装结果（`recorded: false`），它只服务于「已安装 / 有更新」的展示。
- 更新/重装同样走 `overwrite: true`：旧版本移入 `_trash/`，不原地覆盖。
  **注意**：若某同名本地技能不是账本记录的那份（例如装完后手工删掉目标又重建），
  「更新」仍会把它移入 `_trash/`；操作可恢复，但不会询问。

### 3.10 `POST /skill-manager/api/skill/invocation`

软禁用：只改 frontmatter 的两个调用键，**不移动目录**。

```ts
// 请求
{ rootId, dirName, kind, state?, hash?, model: boolean, user: boolean }
// 成功 200
{ ok: true, hash: string, invocation: { model: boolean, user: boolean }, issues: SkillIssue[] }
```

- 语义：`model: false` → `disable-model-invocation: true`（模型目录与 `skill` 工具看不到，
  `/name` 仍可用）；`user: false` → `user-invocable: false`（`/name` 不可用）。
  两者都 false 等于「软关闭」：文件仍在原路径，但两个入口都不再可见。
- 改写是**外科手术式**的：只动这两行的**值**（缺失且需要时才插入）。键序、其余行、
  行尾空白与行内 `# 注释` 都保留（`user-invocable: false  # 只给 /deploy` → 改值后注释仍在）。
  重复键不做归一：`yaml` 本身拒绝重复顶层键，这类文件在宿主编译期就不成立，路由按
  「无法安全改写」处理（400），不会替你删键。
- 无法安全改写时 400 `bad-request`：没有 frontmatter、带 BOM、行内式 YAML、
  或被 `yaml` 判为非法（含重复键）
  （改写后重解析得到的调用策略必须与请求一致，否则不写盘）。
- `hash` 可选；给了就必须与磁盘一致，否则 409 `conflict`。
- 只读根 → 403 `read-only`，未知技能 → 404 `not-found`。
- 与 §3.5 的关系：`toggle` 是**硬停用**（搬进 `_disabled/`，`/name` 也失效、路径变化）；
  本路由是**软禁用**（路径不变，可选择只对模型隐藏）。

### 3.11 `GET /skill-manager/api/usage`

技能调用账本：从宿主会话历史统计 7/30/90 天调用次数与最后使用时间。

```ts
{
  available: boolean          // 宿主没有 sessionQuery 服务时 false（其余字段照常给出）
  error?: string
  rangeDays: 90
  windows: [7, 30, 90]
  generatedAt: number
  sessions: { total: number, scanned: number, skipped: number, truncated: boolean }
  skills: Array<{
    name: string
    d7: number; d30: number; d90: number   // 调用次数
    modelCalls: number; userCalls: number   // 模型 `skill` 工具 / 用户 `/name`
    lastUsedAt: number                      // epoch ms，0 表示没有记录
  }>
}
```

- 只认两种事件：`tool/call` 且 `data.name === 'skill'`（`arguments` 是原始 JSON 串，解析失败即跳过）、
  `user/message` 且 `data.source.kind === 'skill-invocation'`。不读消息正文。
- 走公开服务 `ctx.sessionQuery`（`listSessions` / `readSession`），不自己解压会话文件。
- fork 子会话从父会话继承的事件前缀（`inheritedEventCount`）不计：那些调用已经在祖先会话里
  数过一次，重复计会让「常用技能」虚高。
- 只统计最近 90 天内已创建的会话，最多读 250 个，单次 6s 墙钟预算；结果缓存 60s。
  预算在**会话之间**检查——`readSession` 不可中断，单个超大会话仍可能超出，故 `truncated`
  只表示「没读完全部候选会话」，不保证耗时上限。
- **不阻塞** `overview`：任何异常都返回 `available: false` + `error`。
- 客户端按 `name` 关联到技能行；没有记录 = 「从未使用」。

### 3.12 `POST /skill-manager/api/skill/batch`

批量启停/删除，**串行**执行并逐条返回；单条失败不影响其余（不做事务）。

```ts
// 请求
{
  action: 'enable' | 'disable' | 'delete' | 'invocation'
  model?: boolean            // action === 'invocation' 时必填
  user?: boolean             // action === 'invocation' 时必填
  items: Array<{ rootId: string, dirName: string, kind?: 'directory' | 'file', state?: 'enabled' | 'disabled' }>   // 1..200 条
}
// 成功 200
{
  ok: true, action,
  results: Array<
    | { ok: true, rootId, dirName, kind, state?: 'enabled' | 'disabled', trashed?: string,
        ledgerRemoved?: boolean, invocation?: { model: boolean, user: boolean } }
    | { ok: false, rootId, dirName, kind, error: { code: string, message: string } }
  >,
  counts: { total: number, ok: number, failed: number }
}
```

- `action` 非法或 `items` 为空/超过 200 条 → 400 `bad-request`（整请求拒绝）。
- `action: 'invocation'` 对每条写同一组 `model` / `user`（三态批量），走 §3.10 的同一套改写与保护。
- `action: 'delete'` 成功后同时清理安装账本（`ledgerRemoved`），与 §8.5 同语义。
- 单条错误码复用 §4（`not-found`、`exists`、`read-only`、`bad-request`…），放在 `results[i].error`。
- 语义等同逐条调用 §3.5 / §3.6：删除仍是移入 `_trash/`。

### 3.13 `POST /skill-manager/api/skill/import`

导入本机文件夹或单个 `.md`（**不做 zip**）。

```ts
// 请求
{ path: string, rootId?: string }        // 相对路径按请求 cwd 解析；rootId 默认 user-dsh
// 成功 200
{
  ok: true,
  source: string,                        // 解析后的绝对路径
  imported: Array<{ name: string, kind: 'directory' | 'file', targetPath: string }>,
  skipped: Array<{ source: string, name?: string, code: string, message: string, issue?: string }>
}
```

- 识别规则：选中的目录**自己**有 `SKILL.md` → 整包当一个技能（含 references/scripts/assets）；
  否则递归发现其中的技能并**拍平**到目标根第一层（深度上限 4、数量上限 200）。
- 逐条跳过并说明：`invalid`（frontmatter 有 error 级问题，附 `issue` code）、
  `exists`（目标根重名）、`unsafe-name`、`read-error`、`copy-failed`、`no-skill`、`too-many`。
- 只读源、只写目标根；复制先落 `.import-<name>-<ts>` 再 rename。
- 来源不在目标根内；来源是目标根的父目录时 400（复制会递归）。

## 4. 错误码

| HTTP | code | 含义 |
|---:|---|---|
| 400 | `bad-request` | 参数缺失/非法 |
| 403 | `forbidden` | 同源校验失败 |
| 403 | `read-only` | 目标根只读（bundled） |
| 404 | `not-found` | 技能/根不存在 |
| 405 | `method-not-allowed` | 方法不允许 |
| 409 | `conflict` | 保存时 hash 不一致 |
| 409 | `exists` | 目标已存在 |
| 413 | `too-large` | 内容超限 |
| 415 | `unsupported-media` | 非 JSON body |
| 500 | `internal` | 其它 |

前端按 `code` 翻译文案，`message` 只作兜底原文展示。

## 5. 前端数据约定

- 前端只用 `overview` 渲染列表（一次拉全量，本机技能数 < 数百，无需分页）。
- 行内状态切换：乐观更新 + 失败回滚 + toast。
- `hash` 只从 API 拿，前端不计算。
- 任何 4xx/5xx 都不得让页面白屏；保留上次成功数据 + 顶部错误条。
- `cwd` 是可选参数：所有读写路由都接受，前端「工作区」选择器把它回传；不传时 Host
  按当前活跃会话推导（§1）。
- `usage` 单独懒加载（Host 要读会话历史），失败只隐藏次数，不影响列表。

## 6. 宿主挂载约定

```js
export const name = 'skill-manager'
export const inject = ['webServer', 'connection', 'workingDirectory']
export function apply(ctx, config) { /* ctx.effect(() => registerRoutes(ctx, config)) */ }
```

- 每条路由先过 `ctx.connection.requestRejection(request)`（fail closed）。
- 变更类（POST）额外校验 `Origin`/`Sec-Fetch-Site` 同源。
- 所有文件操作必须字符串前缀校验落在已知根内（`resolve` 后比较），拒绝符号链接逃逸（对目标做 `realpath` 后再校验）。
- 路由注册返回 disposer，随 `ctx.effect` 拆卸。
- `sessionQuery` **不在** `inject` 里：`GET /usage` 用 `ctx.get('sessionQuery')` 惰性取，
  老宿主没有该服务时账本降级为 `available:false`，插件照常挂载。

## 7. issue code 表（host 产出，client 翻译）

| code | level | 含义 |
|---|---|---|
| `bom` | error | 文件以 UTF-8 BOM 开头，宿主会丢弃 |
| `no-frontmatter` | error | 缺少 `---` frontmatter 块 |
| `yaml-invalid` | error | YAML 解析失败（带 line） |
| `name-missing` | error | 缺少 `name` |
| `name-invalid` | error | `name` 非 kebab-case |
| `name-mismatch` | info | `name` 与条目名不一致（宿主不校验一致性，仅提示易读性） |
| `description-missing` | error | 缺少 `description` |
| `description-long` | info | description > 500 字符（宿主模型目录按 500 字符截断） |
| `body-long` | info | 正文 > 8192 字符（宿主单次工具结果会被 spill/prune，且每次调用都全量重注入） |
| `invocation-invalid` | error | 调用键不是合法布尔 |
| `unknown-key` | warn | frontmatter 有宿主不读取的顶层键（宿主只读 name / description / whenToUse / metadata / disable-model-invocation / user-invocable） |
| `duplicate-name` | warn | 同根重名（先到先得） |
| `shadowed` | warn | 被更高 rank 根的同名技能遮蔽 |
| `shadowed-by-plugin` | warn | 被同名插件技能（provider `plugin-hub:*`，rank 350）遮蔽 |
| `root-missing` | warn | 根目录不存在 |
| `read-error` | error | 文件读取失败 |

`level: 'info'` 是 v3 新增的第三档：不进「异常」，不影响启停，只在诊断区以中性色列出。前端必须按三档渲染（error 红 / warn 黄 / info 灰），且 `counts` 只统计 error 级的 invalid。

## 8. v3 增补

v3 在 v2 之上只增不改（`pluginSkills`、`invocation`、`toggle` 等全部保留），新增 5 条路由与 3 处语义修正：

1. `overview` 增加 `hostSkills` 与 `hostOnly`：面板第一次能回答「宿主实际可见、但磁盘上没有」的技能（§8.1）。
2. 新增宿主技能快照路由 `GET /host-skills`（§8.1）。
3. 新增回收站路由 `GET /trash` / `POST /trash/restore` / `POST /trash/purge`（§8.2）。
4. 新增技能资源文件路由 `GET /skill/files` / `GET /skill/file` / `POST /skill/file`（§8.3）。
5. 新增正文搜索路由 `GET /search`（§8.4）。
6. 新增市场卸载 `POST /market/uninstall`（§8.5）。
7. 语义修正：`skill/create` 支持 `kind: 'file'`（§3.4）；`skill/batch` 支持 `action: 'invocation'`（§3.12）；`skill/save` 的 `hash` 由可选改为**必填**（§3.3）；`overview.market.installed` 不再回退为「同名技能数」（§3.1）。

### 8.1 宿主可见技能（hostSkills / hostOnly）

`GET /skill-manager/api/host-skills?cwd=<abs>`

```ts
interface HostSkillsView {
  available: boolean        // 宿主 skills 服务或 live Agent 不可用时 false
  complete: boolean         // snapshot().complete；false = 宿主本次发现不完整
  error?: string
  count: number
  providers: string[]       // 去重排序，如 ["filesystem", "plugin-hub:demo"]
  skills: Array<{
    name: string
    description: string
    whenToUse?: string
    source: string          // 宿主 SkillSource（project-dsh / user-dsh / bundled / custom / runtime / 任意字符串）
    provider: string
    path?: string
    modelInvocable: boolean
    userInvocable: boolean
    pluginId?: string       // provider 以 `plugin-hub:` 开头时给出后半段
  }>
}
```

读取顺序：有 live Agent 时走 `agent.ctx.get('skills') ?? ctx.get('skills')` 的 `snapshot({ scope: agent, cwd })`（退化为 `list()` 时 `complete: true`）；任何异常 → `available: false`，绝不抛错。

`overview` 增加两个字段：

```ts
hostSkills: { available, complete, count, providers, error? }    // 明细走 /host-skills
hostOnly: Array<{                                                 // 宿主可见、磁盘扫不到
  name, description, whenToUse?, source, provider, path?,
  modelInvocable, userInvocable, pluginId?
}>
```

`hostOnly` 的判定：按 `name` 与本次扫盘结果（含停用条目）取差集。它们**只读**：没有 rootId，不能启停/编辑，前端只能展示来源与「由 xx 提供」。
`pluginSkills`（v2 字段）继续保留，语义不变：只统计 provider 为 `plugin-hub:*` 的条目，用于同名遮蔽标注。

### 8.2 回收站

`GET /skill-manager/api/trash?cwd=<abs>&rootId=<optional>`

```ts
interface TrashView {
  roots: Array<{
    rootId: string
    rootPath: string
    writable: boolean
    entries: Array<{
      token: string        // _trash 下的条目名，形如 "alpha@20260101T120000-2" 或 "alpha@20260101T120000.md"
      name: string         // 去掉时间戳与序号后的原始条目名（不含 .md）
      kind: 'directory' | 'file'
      path: string         // 绝对路径
      size: number
      mtimeMs: number
    }>
  }>
  counts: { total: number }
}
```

`POST /skill-manager/api/trash/restore`
```ts
// 请求
{ rootId, token, cwd?, overwrite?: boolean }
// 成功 200
{ ok: true, restored: string, state: 'enabled' }
```
- 目标位置按 token 里的原名与 kind 还原到 `<root>/<name>`（目录）或 `<root>/<name>.md`。
- 目标已存在且 `overwrite !== true` → 409 `exists`；`overwrite: true` 时先把现有条目移进 `_trash/`（带新时间戳），再还原。
- `_disabled/` 里的条目**不在回收站视图**里（那是停用，不是删除）。
- 只读根 → 403 `read-only`；token 非法/不存在 → 400 / 404。

`POST /skill-manager/api/trash/purge`
```ts
// 请求：单个 token，或整根清空
{ rootId, token, cwd? } | { rootId, all: true, confirm: true, cwd? }
// 成功 200
{ ok: true, removed: string[] }
```
- 这是插件里**唯一会真正删除内容**的接口，且只删 `<root>/_trash/` 下的条目。
- `all: true` 必须同时给 `confirm: true`，否则 400；`token` 必须匹配 `_trash` 直接子项且 `isSafeSegment`，越界 400。
- 单个 token 支持目录与 `.md` 文件；`all` 清空后 `_trash/` 目录保留。

### 8.3 技能资源文件

技能目录（`kind: 'directory'`）里的 `references/`、`scripts/`、`assets/` 等文件。单文件技能（`kind: 'file'`）只有自身，本组路由对它返回 `entries: []`。

`GET /skill-manager/api/skill/files?rootId=&dirName=&kind=&state=&cwd=`

```ts
{ ok: true, entryPath: string, entries: Array<{ relativePath: string, size: number, mtimeMs: number, kind: 'directory' | 'file' }>,
  truncated: boolean }
```
- 递归深度 ≤ 4，条数上限 500，跳过 `.git` / `node_modules` / `_trash` / `_disabled` / `.system`。
- `relativePath` 一律用 `/` 分隔；不返回绝对路径。

`GET /skill-manager/api/skill/file?rootId=&dirName=&kind=&state=&file=<relativePath>&cwd=`

```ts
{ ok: true, file: string, size: number, mtimeMs: number, hash: string,
  encoding: 'utf8' | 'binary' | 'too-large', content?: string }
```
- 文本 ≤ 256 KiB 返回 `content`；超限 `encoding: 'too-large'` 且不带内容；含 NUL 字节判为 `binary`。
- `file` 必须是技能目录内的相对路径：拒绝绝对路径、`..` 段、空段。

`POST /skill-manager/api/skill/file`

```ts
// 请求
{ rootId, dirName, kind, state?, file, content: string, hash?: string, cwd? }
// 成功 200
{ ok: true, file: string, hash: string, size: number }
```
- 只允许写**已存在**文件（新建文件走 `skill/create` 的正文，资源文件暂不支持新建）。
- 给了 `hash` 就必须与磁盘一致，否则 409 `conflict`。
- 只读根 → 403；内容 > 256 KiB → 413；路径越界/非法 → 400；不存在 → 404。
- 写入原子（同目录临时文件 + rename），保留原 EOL 由调用方负责。

### 8.4 正文搜索

`GET /skill-manager/api/search?q=<string>&cwd=&limit=&rootId=`

```ts
{
  q: string
  matched: number                 // 命中的技能数
  truncated: boolean              // 命中数 > 返回数
  results: Array<{
    key: string                   // 与 Skill.key 同口径
    rootId: string; dirName: string; kind: 'directory' | 'file'; state: string
    name: string; description: string
    hits: Array<{ line: number, text: string }>   // 正文命中的行（最多 3 条）；仅 name/description 命中时为空
  }>
}
```
- 大小写不敏感子串匹配：`name` / `description` / `whenToUse` / 正文。
- `q` 少于 2 个字符 → 400；`limit` 默认 50、最大 200；单文件上限 512 KiB，超限跳过正文只匹配元数据。
- 只搜**已启用与已停用**条目，不搜 `_trash/`。

### 8.5 市场卸载

`POST /skill-manager/api/market/uninstall`

```ts
// 请求：按账本来源，或按目标根里的条目名
{ rootId, repo: string, folder: string, cwd? } | { rootId, name: string, cwd? }
// 成功 200
{ ok: true, name: string, trashed: string, ledgerRemoved: boolean }
```
- 按 `{repo, folder}`：只作用于账本里 `rootPath` 等于该根、且 `{repo, folder}` 匹配的记录。
- 按 `name`：直接针对该根下的同名条目（可卸载不是本面板安装的技能）。
- 卸载 = 移入 `_trash/`（复用 §3.6 的命名规则），并从安装账本删除对应记录；账本写失败不影响卸载结果（`ledgerRemoved: false`）。
- 目标不存在 → 404；只读根 → 403。

### 8.6 自定义技能根（v3.1）

运行时列表（进程内，立即参与后续扫描）与 profile 持久化（`cordis.patch.yml` 里 `- id: skill-manager` 的 `config.customSkillDirs`，重载插件后生效）是两份状态。

`GET /skill-manager/api/roots/custom`

```ts
{
  profilePath: string          // profile 补丁文件绝对路径（configEditor 不可用时按 $DSH_HOME/$DSH_PROFILE 推导）
  writable: boolean            // 能否写持久化块（目录/文件可写、托管块未被手写行占用）
  persisted: string[]          // profile 里已保存的 dirs
  runtime: string[]            // 本次进程内临时添加的 dirs
  dirs: Array<{ path: string, exists: boolean, source: 'config' | 'runtime' }>
  error?: string               // 读取/解析 profile 失败时给出，其余字段仍返回
}
```

`POST /skill-manager/api/roots/custom`

```ts
// 请求
{ dirs: string[], persist?: boolean }
// 成功 200
{ ok: true, runtime: string[], persisted?: boolean, path?: string, backupPath?: string, requiresReload?: boolean }
```
- `dirs` 是**完整的运行时列表**（前端负责增删后的结果），不是增量；相对路径按请求 `cwd` 解析，去重、去空、拒绝非字符串。
- `persist: true` 时把同一份列表写进 profile 补丁的托管块：
  ```
  # >>> dsh-skill-manager custom roots >>>
  - id: skill-manager
    config:
      customSkillDirs:
        - 'D:/my-skills'
  # <<< dsh-skill-manager custom roots <<<
  ```
  写入前备份到 `<profileDir>/data/skill-manager/backup-<ts>.yml`，写入后用 YAML 重新解析校验，失败则回滚并 500。`requiresReload: true` 表示需要重载插件才按新配置扫描。
- profile 里已存在**手写的** `- id: skill-manager` 顶层条目（无托管标记）→ 409 `conflict`，不碰用户的内容。

### 8.7 技能包导出（v3.1）

`POST /skill-manager/api/skill/export`

```ts
// 请求
{ rootId, dirName, kind, state?, targetPath, cwd? }
// 成功 200
{ ok: true, path: string, files: number }
```
- `targetPath` 必须以 `.zip` / `.tgz` / `.tar.gz` 结尾；父目录必须已存在。
- 目录技能打包整棵目录（含 `references/` `scripts/` `assets/`），单文件技能打包该 `.md`。
- 用系统 `tar`（Windows 10+ / macOS / Linux 均自带 bsdtar，支持按扩展名自动压缩），**不新增 npm 依赖**；`tar` 不可用时 500 并说明。
- 目标已存在 → 409 `exists`。
- 导出只读根也允许（读操作）。

### 8.8 压缩包导入（v3.1）

`POST /skill-manager/api/skill/import` 的 `path` 可以是 `.zip` / `.tar` / `.tar.gz` / `.tgz`：

- Host 先把压缩包解压到 `<tmp>/skill-manager-import-<ts>/`，再按 §3.13 的规则发现技能，结束后删除临时目录。
- 解压项必须留在临时目录内（拒绝 `../` 与绝对路径条目），越界即整包拒绝（400 `bad-request`）。
- 响应沿用 §3.13，额外带 `archive: true`。
- 源压缩包本身不被修改。
