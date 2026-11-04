# dsh-memory-manager

A native plugin for **DeepSeek Harness (DSH)** that gives the agent a durable,
file-based memory. It registers five `memory_*` tools, injects a digest of the newest
project notes into the system prompt, and ships a Settings page for browsing,
searching and curating them. Memories are plain Markdown with YAML frontmatter,
stored outside this repository under the DSH home, so they survive plugin upgrades
and stay readable by any editor. It installs into DSH as a bundle
(`cordis.patch.yml`) and is released under the MIT license.

DSH（DeepSeek Harness）桌面端原生插件：**记忆管理（全局 + 项目级）**。工具、注入、UI 全在插件里，不依赖 MCP。

- 目标宿主：**DSH ≥ 0.2.1-rc.2**（desktop profile，见 `package.json` 的 `engines`）
- 许可：MIT（见 [LICENSE](./LICENSE)）

## 它做什么

| 能力 | 说明 |
|---|---|
| 5 个工具 | `memory_write` / `memory_read` / `memory_search` / `memory_list` / `memory_delete` |
| 记忆注入 | `systemPrompt` section `memory:digest`：**当前项目索引按更新时间倒序**（≤24 条，每条 ≤120 字）+ 24 小时内更新的条目单独成「近期」带（≤6 条，独立预算）+ 一行全局条数；同步缓存、事件驱动刷新 |
| 写入去重 | `memory_write` 返回 `similar`（同作用域内近似条目，Jaccard 词法打分，零模型调用），同名重写即合并；`metadata.aliases` 支持别名——读、搜、删都认别名，按别名写入只在原条目上**记下别名**（`viaAlias`），不改写原正文 |
| 写入脱敏 | 密钥/令牌/私钥/连接串在**唯一写入口**（`store.writeNote`/`updateNote`）确定性打码，覆盖工具、设置页写条目、候选采纳、候选包落盘；只处理调用方本次提交的字段 |
| 运行审计 | 召回 / 梦整流 / 抽取每次运行追加一行到 `$DSH_HOME/memories/global/.events.jsonl`（计数、耗时、原因、名称，**不含正文**），有界轮转；`GET /events` 与设置页诊断区可查 |
| 作用域 | 全局 = 跨项目事实；项目级 = 按 **session cwd** 推导项目键 `<slug>-<sha256(路径)[0:16]>`（与 ZCode 的目录命名方案一致） |
| 设置页 | 设置 → 记忆：全局/项目 tab、列表、搜索、全文、诊断（含最近后台运行）、打开目录；新建 / 编辑 / 删除条目 |
| 安全 | 原子写 + 文件锁 + 写前重读；并发写不丢条目 |

可调项（插件 config，均可省略）：`digestMaxEntries`（默认 24）、`digestEntryChars`（120）、
`digestMaxTokens`（1200）、`digestRecentHours`（24）、`digestRecentMaxEntries`（6）、
`digestIncludeGlobal`（false）、`recall.enabled`（false）、`recall.selector`
（`auto` / `llm` / `lexical`，默认 `auto`：先问模型，**只有**模型不可用/调用失败才退回本地词法选择器；
模型成功给出空选择视为弃权，不再补词法命中）、`extract.enabled`（false）、`extract.minIntervalMs`、
`extract.transcriptMessages`、`redaction`（默认开，`false` 或 `{enabled:false}` 关闭写入脱敏）。


## 安装

从本仓库构建一个可安装的 tarball，再用 DSH 的插件管理器装进去：

```bash
npm pack        # 产出 dsh-memory-manager-<version>.tgz
```

把得到的 `.tgz` 交给 DSH 的插件管理器安装（`plugin_manager` 的 `install_bundle`，或在
「设置 → 插件」中选择该文件）。宿主需要**真实目录形态**的包，不要用 `link:` 之类的工作区链接。
安装后重载 / 重启 DSH，设置面板左侧会出现「记忆」一节。

也可以直接从本仓库的 **Releases** 页面下载已打好的 `dsh-memory-manager-<version>.tgz`，再按上面的方式安装。

运行要求：Node.js ≥ 20。运行时依赖只有 `yaml`；`@deepseek-ai/cordis` 由宿主提供（`peerDependencies`）。

**记忆数据不随包发布**：它写在 DSH home 下的 `memories/`（见下一节），既不在本仓库里，
也不在 tarball 里 —— 仓库与发布包都不含任何个人记忆内容。

## 存储

```
globalDir   = $DSH_HOME/memories/global     # 全局（跨项目）
  .events.jsonl                             # 后台运行审计（追加写、有界轮转；不是记忆）
projectsDir = $DSH_HOME/memories/projects   # 项目级
  <slug>-<hash16>/memory/{MEMORY.md, <name>.md}
```

`$DSH_HOME` 默认为 `~/.dsh`。两个根都可以覆盖：插件 config 的 `memoryRoots.{global,projects}`
（或 `globalDir` / `projectsDir`）、环境变量 `GLOBAL_MEMORY_DIR` / `DSH_MEMORY_PROJECTS_DIR`；
优先级是 config → 环境变量 → 默认值。默认只落在 DSH 自己的目录里，不会去写别的工具的记忆目录。

笔记格式（frontmatter `name` / `description` / `metadata.type` / 可选 `metadata.aliases` + 短正文）
与 ZCode、`global-memory` 的 Markdown 约定一致：任何文本编辑器都能直接读写；不认识
`metadata.aliases` 的读取方（ZCode 的行正则、旧版 `global-memory`）会直接忽略这一行。
`.events.jsonl` 不在记忆扫描范围内（扫描器只认 `*.md` 与 `MEMORY.md`），也不会被注入提示词。

## 结构

| 路径 | 说明 |
|---|---|
| `lib/index.js` | host 入口：name/inject/apply；工具注册 + systemPrompt section + HTTP 路由 + 事件接线 |
| `lib/store.js` | 存储层：解析/索引/原子写/文件锁/摘要缓存/别名/近似查重 |
| `lib/tools.js` | 5 个工具 |
| `lib/digest.js` | 提示词摘要渲染（倒序 + 近期带 + 预算） |
| `lib/redact.js` | 写入前确定性脱敏规则表 |
| `lib/events.js` | 有界运行审计（JSONL 追加 + 轮转 + 读取） |
| `lib/recall.js` | 可选召回：模型选择器 + 无模型词法选择器 |
| `lib/consolidate.js` | 梦整流 / 轮末抽取（只产出候选） |
| `lib/candidates.js` | 候选包读写与采纳 |
| `lib/llm.js` | 模型调用 seam + 宽容 JSON 解析 |
| `lib/project-key.js` | 项目键推导（`<slug>-<sha256(路径)[0:16]>`） |
| `lib/routes.js` | HTTP 路由（鉴权后：只读查询 + 写条目 / 候选 / 打开目录 / 审计） |
| `client/client.js` | 设置页（settings.section，手写 CJS，无构建） |
| `client/selfcheck.mjs` | 设置页脚本的自检（不依赖宿主） |
| `scripts/smoke.mjs` | 离线断言（不依赖宿主） |
| `cordis.patch.yml` | bundle 补丁：只插入本插件自己的一行宿主条目 |
| `LICENSE` | MIT 许可证全文 |

## 测试

两条离线命令，不需要宿主，也不读写真实记忆目录：

```bash
node client/selfcheck.mjs    # client 半侧：模块形态、导航装饰器的 DOM 行为与清理
node scripts/smoke.mjs       # host 半侧：项目键、笔记格式、存储、检索、摘要、路由、并发写
```

## 0.3.0：读得准、写干净

五项行为变化，都是“不动存储格式与主要契约”的增量：

1. **摘要按时间排序 + 近期带**。项目索引不再按名字排序截断，而是按 `updatedAt` 倒序；缓存加载时刻
   （`loadedAt`）前 24 小时更新的条目另成「近期更新」带，独立预算 ≤6 条。参照时间取快照而非墙钟，
   同一缓存多次渲染字节一致，不会每步改写系统提示词。相关 config：`digestRecentHours`、`digestRecentMaxEntries`。
2. **写入去重提示**。`memory_write` 写前用与 `memory_search` 相同的 CJK-bigram 打分算 Jaccard（阈值 0.3），
   把近似条目放进 `similar` 一并返回——只提示，不拦截。
3. **别名并条**。frontmatter 新增可选 `metadata.aliases`（旧读取方忽略）。读/搜/删都认别名；按别名写入
   只把别名记到原条目上并返回 `viaAlias`，**不覆盖**原条目正文；用原名重写时保留已有别名。
4. **写入脱敏**。唯一写入口按固定规则表打码（私钥块、JWT、`sk-`/`ghp_`/`AKIA`/`AIza`/`xox*`、`Bearer`、
   URL basic auth、含数字的 `key: value`），候选包落盘前也过一遍。只处理本次提交的字段，`redaction: false` 可关闭。
5. **运行审计**。召回/梦整流/抽取每次运行写一行 JSONL（计数、耗时、原因、名称，无正文），超过 256 KB 裁到
   最近 200 行；`GET /events` 与设置页诊断区可读。前提是相应功能已开启——关闭的功能不写日志。

## 设置导航图标（临时装饰，见 v0.2.1）

DSH 设置面板左侧导航的图标由外壳 `@deepseek-ai/dsh-client-ui-settings-general` 的 `navIcon(id)` 写死，
只认 `account / models / agent-presets / plugins / archived-sessions`，**未知 id 一律兜底成齿轮**；
而 `settings.section` 的注册参数只有 `id / order / label`，插件无法自带图标。于是本插件的「记忆」
一行显示成齿轮，与「设置」入口撞脸。

`client/client.js` 因此在面板出现时做一次**防御式装饰**：只匹配 `[data-shortcut-modal="settings"]` 内
`span.navLabel` 文案恰好等于本插件 nav 文案（zh/en）的那一行，把外壳的兜底 `<svg>` 用 `display:none`
隐藏，并在其前面插入本插件自己的 16×16 记录本图形（描边 1.3，与 DSH Medium 图标一致）。
DOM 结构不符预期就什么都不做（保留原齿轮、不抛错）；缺 `document` / `MutationObserver` / `createElementNS`
时直接返回空清理函数，一行 DOM 都不碰；`ctx.effect` 的清理函数会移除插入的图形、恢复齿轮显示并断开 observer。
不会修改 DSH 安装目录或 `app.asar`。

**移除条件**：一旦 DSH 给 `settings.section` 的注册参数加上 `icon`，就删除 `client.js` 里
`Settings-nav glyph` 整段代码（连同 `NAV_PANEL_SELECTOR` / `NAV_GLYPH_ATTR` / `NAV_GLYPH`
三个常量与 `apply()` 里那个 `settings-nav glyph` effect），改为在注册参数中声明 `icon`。

## 主题 token 修正（0.2.2）

设置页原先引用了两个 DSH 主题里**并不存在**的变量——CSS 变量名写错不会报错，只会让 `var()` 在计算值阶段
失效，`color` / `font-family` 静默回退成继承值（错误态只剩文案、危险按钮与普通按钮同色）：

| 原引用 | 主题里的正确 token | 本页处数 |
|---|---|---|
| `--dsw-alias-label-error` | `--dsw-alias-state-error-primary`（浅色 `--dsw-static-red-600` / 深色 `--dsw-static-red-400`；宿主设置页自用同款） | 12 |
| `--dsw-font-mono` | `--ds-font-family-code`（主题的等宽栈） | 7 |

现已全部替换为宿主 token，未引入字面量兜底。核对方式（可重复，升级 DSH 后请重跑）：把设置页里每个
`var(--…)` 与 DSH 客户端产物中**真实存在的 token 定义**逐一比对，出现未定义的名字即为失败。

## 已知限制

- 设置页与工具都是**单条目**操作：新建 / 更新 / 删除；没有批量整理、重命名或跨作用域移动。
- 不做隐式自动抽取：`extract.enabled` 打开后每轮最多触发一次，产出只进候选区，需在 UI 采纳
  （**候选区目前只有 HTTP 路由，设置页里还没有采纳面板**）。
- 检索没有 embedding：当前是与 `global-memory` 相同的纯打分检索；召回在无模型时退回同一套
  词法打分（`recall.selector: 'lexical'`/`auto`），不做语义匹配。
- 脱敏是**固定规则表**，不是完整 DLP：覆盖私钥块、JWT、常见厂商前缀、`Bearer`、URL basic auth，以及
  **含数字**的 `api_key/token/password: value`；纯占位符与不含数字的弱口令不会被识别（这是为减少误伤
  付出的代价），规则见 `lib/redact.js`。
- 打码**不可逆**，且只作用于经本插件写入的字段：外部编辑器直接写进笔记的密钥不会在读取时被改写，
  只有下一次提交该字段时才会。`redaction: false` 可整体关闭。
- 运行审计只记名称、计数、耗时、原因与错误码，不记正文；它不会进入提示词，也不作为记忆检索源。
  功能未开启时不写日志；抽取的节流跳过会记 `throttled`（每轮至多一行）。

## License

MIT © 2026 sanqiuyef — 全文见 [LICENSE](./LICENSE)。
