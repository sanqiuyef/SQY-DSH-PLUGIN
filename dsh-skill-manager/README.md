# dsh-skill-manager · 技能管理

**dsh-skill-manager** 是 **DeepSeek Harness（DSH）** 的一个插件：在设置里开出一个技能管理页，直接管理磁盘上的全部技能（`SKILL.md`）——看清单、启停、看诊断、内联编辑、新建、删除到回收站、浏览与恢复回收站、编辑技能目录里的资源文件、搜索正文，以及从本机技能市场克隆安装或卸载；同时把宿主自己可见的技能目录拉进来对照，让「模型能看到、但磁盘上没有」的技能不再隐身在面板之外。除了设置页，主页面侧边栏「自动化任务」下面还有一个**技能管理**快速入口，点开就是同一个页面。

- 包名 `dsh-skill-manager`，版本 `0.3.1`，许可 MIT
- 目标宿主：**DSH 0.2.1-rc.2**（`package.json` 的 `engines.dsh: ">=0.2.1-rc.2"`）
- 运行时依赖只有 `yaml`；`@deepseek-ai/cordis` 由宿主提供（`peerDependencies`）

## 界面

设置 → 技能（自有绘制，非宿主默认表单）：

| 浅色 · 列表 | 浅色 · 详情抽屉 |
|---|---|
| ![列表](docs/screenshots/light-list.png) | ![详情](docs/screenshots/light-drawer.png) |

| 浅色 · 新建 | 深色 · 市场 |
|---|---|
| ![新建](docs/screenshots/light-create.png) | ![市场](docs/screenshots/dark-market.png) |

设置导航里的图标也是自有绘制（宿主只为未知 section 兜底齿轮，插件替换本行字形）：

![导航图标](docs/screenshots/nav-glyph.png)

主页面侧边栏的快速入口（`sidebar.panellist` + `main` 双槽注册，排在「自动化任务」之后）：

![侧边栏入口](docs/screenshots/sidebar-entry.png)


## 1. 定位（与宿主的关系）

一句话：**技能文件的旁挂管理器**——技能数据始终留在各技能根的磁盘目录里，插件只是在同一个文件系统上读写它们，并把这套扫描与校验结果做成可操作的设置页。

与宿主的三条关系：

1. **同口径扫描**：技能根的 rank 顺序、frontmatter 解析、issue 判定都对齐宿主 `@deepseek-ai/dsh-skill-filesystem` 的同一张 rank 表（见 §4），所以面板里的「启用 / 停用 / 异常 / 被遮蔽」与宿主实际加载结果一致，不前移也不后移。
2. **不接管加载**：插件不注册技能、不改宿主源码、不往 profile 里塞技能；它只通过自己的同源路由 `/skill-manager/api/*` 读写磁盘，宿主原有的技能发现链路完全不变。
3. **补齐宿主没有的前端操作**：宿主只提供技能加载，没有"停用"开关、没有编辑页、没有回收站。本插件用 `_disabled/` 与 `_trash/` 两个目录约定把这几件事补上（见 §6），并保证**任何操作都不是 `rm -rf` 用户目录**。

包构成（`dsh.bundle.patch` 挂载）：`lib/` 为 host 半侧（路由 + 扫描 + 文件操作），`client/client.js` 为浏览器半侧（`settings.section` 设置页 + `sidebar.panellist` / `main` 主页面板，无构建、无 JSX），`cordis.patch.yml` 只插入本插件自己的一行宿主条目。

## 2. 功能清单

| 能力 | 行为 |
|---|---|
| 清单 | `overview` 一次拉全量：按技能根分组，列出启用 / 停用 / 异常；带来源根、调用策略（模型可调用 / 用户可调用）、正文长度、大小、修改时间、被遮蔽标记 |
| 插件同名提示 | 读取当前 live Agent 的宿主 `skills` 快照，把 provider 为 `plugin-hub:<pluginId>` 的技能与扫盘结果按 name 对照：rank 350 的插件技能胜出时，行上标「插件同名」并在列表上方显示说明横幅；宿主没有该服务时静默降级（`pluginSkills.available=false`），不影响其余扫描 |
| 启停 | 行内开关，**移动**而非改标志：`<root>/<name>` ⇄ `<root>/_disabled/<name>`；乐观更新，失败回滚 + toast |
| 三态调用策略（软禁用） | 行内徽章即菜单：默认 / 仅手动（写 `disable-model-invocation: true`，模型看不到但 `/name` 仍可用）/ 都不可调用。**只改 frontmatter 的两个键**，注释、键序、正文与换行逐字节保留，条目留在原路径；带 hash 并发保护，改不成就 400 而不是写坏 YAML |
| 批量处理 | 选择模式勾选多条（只读与异常自动跳过），底部操作条批量启用 / 停用 / 删除 / 写调用策略；串行执行、逐条返回结果，单条失败不影响其余，失败条目名与原因会进 toast |
| 诊断 | 每个技能带 issue 列表，三档展示：`error`（宿主会丢弃）、`warn`（宿主会忽略的 frontmatter 键、同根重名、被遮蔽）、`info`（描述超过 500 字符、正文超过 8192 字符、`name` 与条目名不一致）。校验口径对齐宿主：宿主只读 `name` / `description` / `whenToUse` / `metadata` / `disable-model-invocation` / `user-invocable`，其余键（含 Claude Code 的 `allowed-tools`）一律告警 |
| 查看与编辑 SKILL.md | 详情抽屉展示完整原文与元信息；保存前重算 frontmatter 并回传 issues；写盘用"同目录临时文件 + rename"，保留原 EOL（CRLF 文件写回 CRLF），可选去 BOM，内容上限 256 KiB |
| 保存冲突 | 保存必须带读取时的 `hash`（缺 hash 直接 400）；磁盘内容被别人改过 → `409 conflict`，**绝不覆盖**，前端给「重新载入」 |
| 新建 | 名称（kebab-case、单路径段、≤64 字符）+ 描述（必填）+ 可选「何时使用」/ 正文 / 调用策略 / 形态（目录或单文件）；只在可写根创建；`_disabled/` 里已有同名条目时 409 并提示先启用或删除 |
| 调用账本 | 从宿主会话历史统计 7/30/90 天调用次数与最后使用时间（只认 `tool/call` 的 `skill` 工具与 `/name` 的 `skill-invocation` source）；可按「从未使用」筛选、按调用次数排序，详情里也有次数。走 `ctx.sessionQuery`，有墙钟预算与会话上限，服务缺失时只隐藏次数 |
| 工作区切换 | 工具栏可切「当前会话 / 最近目录 / 手输路径」，所有请求回传 `cwd`，项目级技能根按该目录重新解析；选择记在 localStorage |
| 导入本地技能包 | 选一个文件夹或 `.md`：目录自己有 `SKILL.md` 就整包导入，否则递归发现并拍平到技能根第一层；不合法 / 重名逐条跳过并说明原因，先落 `.import-<name>-<ts>` 再 rename；包里的 README / CHANGELOG / LICENSE 等说明文档直接忽略，不产生「缺少 frontmatter」噪音 |
| 删除到回收站 | 移入 `<root>/_trash/<name>@<时间戳>/`，同名自动加序号；**不删除任何内容**，同时清掉该技能在安装账本里的记录 |
| 本地市场安装 | 读本机技能市场克隆，按仓库分组、可搜索；「安装」= 复制目录（含 `references/` `scripts/` `assets/`）到可写根（默认 `user-dsh`），同名默认不覆盖，先复制到 `.install-<name>-<ts>` 再 rename，不留半成品 |
| 安装来源账本 | 安装时写 `<marketDir>/../install-state.json`（repo/folder/目标根/时间/逐文件 sha256）。「已安装」按 `repo+folder` **且**目标根属于当前工作区精确匹配，不按名字猜：手写同名技能标「同名已存在」，市场侧改动后标「有更新」并可一键重装（旧版进 `_trash/`）。哈希采样不完整（>200 文件 / 单文件 >1 MiB / 目录更深）时给 `unknown`，不会谎报「有更新」 |
| 打开目录 | 用系统文件管理器打开扫描过的根或其直接子项（Windows 走 `explorer.exe`）；目标不存在时返回 404，不再"假成功" |
| 内置技能 | `bundled` 根只读：页面标「只读」，隐藏开关，危险操作禁用 |
| 宿主技能对照 | 读宿主 `ctx.skills.snapshot()` 的**胜出者**（含 `source` / `provider` / `path`）与 `complete`：列表末尾多一个「宿主提供」只读分组，列出「模型能看到、磁盘根里没有」的技能（preset / bundled provider），并在宿主本次发现不完整时明确标注 |
| 回收站 | 浏览 `<root>/_trash/`、按时间倒序列出条目、单条**恢复**或**永久删除**、一键清空；恢复时目标已存在可覆盖（旧目标再次进回收站）；永久删除是插件里唯一真正删内容的入口，必须二次确认 |
| 资源文件 | 详情抽屉的「文件」页：列出技能目录里的 `references/` `scripts/` `assets/` 等全部子文件，文本文件可读可改（带 hash 并发保护，409 提示重新载入）；二进制与超过 256 KiB 的文件只展示说明；只读根禁用保存 |
| 正文搜索 | 工具栏「正文」开关：扫描每个 `SKILL.md` 正文，列出命中技能与前 2 条命中行的行号与片段，点结果直接打开详情；单文件上限 512 KiB，最多 200 条 |
| 市场卸载 | 市场条目「卸载」：把装进来的技能移入 `_trash/` 并删除安装账本记录，卸载后市场不再显示「已安装 / 有更新」 |
| 单文件技能 | 新建时可选择生成 `<root>/<name>.md`（宿主原生的单文件形态），与目录技能并列管理 |
| 批量三态 | 批量操作条除启用 / 停用 / 删除外，还能批量写「模型不可调用」「都不可调用」 |
| 自定义技能根 | 「自定义根」对话框：运行时添加 / 移除是立即可见的（参与后续扫描）；「保存到 profile」把列表写进 profile 补丁的托管块，重载插件后持久。写入前备份到 `<profileDir>/data/skill-manager/`，落盘前用 YAML 重新解析校验，profile 里已有手写 `- id: skill-manager` 条目时拒绝接管（409） |
| 技能包导出 | 详情抽屉「导出…」：把技能打成 `.zip` / `.tgz` / `.tar.gz`（调用系统 tar，不新增 npm 依赖），只读技能也允许导出 |
| 压缩包导入 | 导入对话框接受 `.zip` / `.tgz`：Host 先解压到临时目录再按同一套规则发现与拍平，结束后清理；含 `../`、绝对路径或符号链接条目的包整包拒绝（400），一个文件都不落盘 |
| 侧边栏快速入口 | 主页面侧边栏「自动化任务」下方新增「技能管理」一行（图标为卡片 + 星火，与设置导航同形），点击切换到同一套页面的主面板视图；面板自带滚动容器与 960px 内容列，设置页入口保持不变 |

页面交互细节（分组折叠、搜索防抖、状态过滤、抽屉焦点陷阱、深色模式只走主题 token、<640px 单列）见 [`docs/ui-spec.md`](./docs/ui-spec.md)；接口字段与错误码见 [`docs/api-contract.md`](./docs/api-contract.md)（v3.1 契约，v1/v2/v3 字段全部保留）。

## 3. 安装

宿主只对**真实目录形态**的包做 `@deepseek-ai/*` 解析，所以必须打成 tarball 安装，**不要用 `link:`** 或直接拷贝源码目录。

在本工作区的插件目录里打包（产物落到工作区的 `migration/dist/`）：

```powershell
cd plugin-library\dsh-skill-manager
npm pack --pack-destination ..\..\migration\dist
# 产出：..\..\migration\dist\dsh-skill-manager-0.3.1.tgz
```

再用宿主插件管理器装这个 tgz，任选一条：

- **宿主工具**：`plugin_manager({ action: "install_bundle", target: "<abs-path>\\migration\\dist\\dsh-skill-manager-0.3.1.tgz" })`
- **Web GUI**：设置 → 插件 → 安装，选中刚生成的 `.tgz`
- 安装后重载 / 重启 DSH；设置左侧出现「技能」（`settings.section`，由本包 `cordis.patch.yml` 自动挂载），主页面侧边栏「自动化任务」下面出现「技能管理」

迭代流程：改源码 → **递增版本号** → 重新 `npm pack` → 重装 tarball（包管理器按 tarball 内容做缓存，同版本号重打不一定生效）。

运行要求：Node.js ≥ 20。`migration/dist` 目录不存在时先建：`New-Item -ItemType Directory -Force ..\..\migration\dist`。

## 4. 技能根优先级表

顺序即优先级（rank 越小越优先）；**同名技能先到先得**，低 rank 的同名项标为 `shadowed`（仍展示，不隐藏）。

插件中心（dsh-plugin-hub）提供的技能不落在磁盘根里，而是通过宿主 `skills` 服务暴露，
provider 形如 `plugin-hub:<pluginId>`，固定 rank **350**（介于 custom 300 与 user-dsh 400）：

| rank | rootId | 路径 | kind | 可写 |
|---:|---|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` | project | ✅ |
| 150 | `project-zcode` | `<projectRoot>/.zcode/skills` | project | ✅ |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` | project | ✅ |
| 300 | `custom:<n>` | 插件 Config `customSkillDirs` 里的每个目录 | custom | ✅ |
| 350 | `plugin-hub:<pluginId>` | 宿主 `skills` 服务（不在本插件扫描面） | — | ❌ 只读 |
| 400 | `user-dsh` | `<dshHome>/skills`（跳过 `.system` 子目录） | user | ✅ |
| 450 | `user-zcode` | `<zcodeHome>/skills`（默认 `~/.zcode/skills`） | user | ✅ |
| 500 | `user-agents` | `<agentsHome>/skills` | user | ✅ |
| 600 | `bundled` | Config `bundledSkillDir`（配置了才有） | bundled | ❌ 只读 |

`.zcode` 与 `.agents` 是成对的根、`.zcode` 排在前，和 ZCode 自己的解析顺序一致（见 ZCode 源码 `adapters/src/skills/roots.ts`）。本机 `~/.dsh/skills` 与 `~/.zcode/skills` 内容重叠时，`user-dsh`（400）胜出、ZCode 那份显示为「被遮蔽」——这不是重复条目，而是提示你两份副本只生效一份；想只留 ZCode 原版就把 `~/.dsh/skills` 里的同名目录删掉。

补充约定：

- `projectRoot` = 从请求 `cwd` 向上找最近含 `.git` 的祖先；找不到就用 `cwd` 本身。
- 页面不传 `cwd` 时，Host 用**当前活跃会话的生效目录**（取最新 live agent 的 `workingDirectory.get(session)`）推导项目根，所以「项目技能」跟着你当前会话走；没有会话时回退宿主默认目录。
- 发现规则与宿主一致：只扫根目录的**直接子项**——`<name>/SKILL.md`（目录技能）或 `<name>.md`（单文件技能），**不递归**。
- 根不存在时不报错：仍出现在 `roots[]` 里，页面显示为「未创建」。
- **上表不是全部**：宿主还可能通过 provider 提供磁盘根以外的技能（preset 打包技能、`bundled` provider、插件中心等），它们不进 `roots[]`，也不可写。`overview.hostOnly` 用一个 `ctx.skills.snapshot()` 快照把这些「宿主可见、磁盘没有」的技能列成只读分组；`hostSkills.complete === false` 表示宿主本次发现不完整（某根读失败等），此时列表可能少于模型实际可见。

## 5. 配置项

配置写在 profile 补丁里 `skill-manager` 那一行的 `config:`（本插件**没有**声明 Cordis `Config` schema，因此不会在设置页生成表单；好处是这些键保持普通字段，改完重载插件即生效）：

```yaml
- insert:
    - id: skill-manager
      name: 'dsh-skill-manager'
      config:
        customSkillDirs:
          - 'D:/my-skills'
        marketDir: 'D:/my-skills-market'
```

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `customSkillDirs` | `string[]` | `[]`（不扫描自定义根） | 额外的技能根，按数组顺序对应 rank 300 起的 `custom:<n>`；可写 |
| `marketDir` | `string` | `~/.dsh/skills-management/market` | 本机技能市场克隆的根目录；不存在时市场视图显示空状态 |
| `dshHome` | `string` | `%DSH_HOME%`，无则 `~/.dsh` | 用户级 DSH 目录；`user-dsh` 根 = `<dshHome>/skills` |
| `zcodeHome` | `string` | `%ZCODE_HOME%`，无则 `~/.zcode` | 用户级 ZCode 目录；`user-zcode` 根 = `<zcodeHome>/skills` |
| `agentsHome` | `string` | `%DSH_AGENTS_HOME%`，无则 `~/.agents` | 用户级 agents 目录；`user-agents` 根 = `<agentsHome>/skills` |
| `bundledSkillDir` | `string` | 未设置（不出现 `bundled` 根） | 随包分发/内置只读技能目录；设了就按 rank 600 只读扫描 |

> 不加配置时全部走默认值：本机 `~/.dsh/skills` 实际是指向 `~/.zcode/skills` 的 junction，插件按真实路径扫描，不做额外解析。

## 6. 已知限制

- **宿主没有原生停用开关**：本插件的「停用」是把条目移进 `<root>/_disabled/`。宿主只扫根目录的直接子项，因此移进去的技能对宿主不可见——这就是停用效果的来源，但**目录位置变了**，外部脚本若硬编码原路径需要自行适配。需要「模型看不到但 `/name` 仍可用」时改用三态调用策略（写 `disable-model-invocation`），路径不变。
- **删除先到回收站**：删除去向是 `<root>/_trash/<name>@<timestamp>/`。回收站视图可以**恢复**或**永久删除**；永久删除是插件里唯一真正删内容的入口，且不可恢复。恢复时若目标已存在，可以先把现有目标再移进回收站（同样可恢复）再覆盖。
- **`bundled` 只读**：`bundled` 根下不能启停、编辑、新建、删除、安装，接口返回 `403 read-only`。
- **市场只读本机克隆**：不联网、不拉取、不做远端同步。市场目录内容由你在 DSH 之外的克隆/同步流程维护；插件只负责把克隆里的技能目录复制进技能根。安装会记一条账本（`install-state.json`，与 `skills-market-sync.json` 同目录），因此能显示「有更新」并按需重装，但**不会自动更新**；卸载会移入 `_trash/` 并清掉账本记录。
- **调用账本受会话历史限制**：只统计最近 90 天、最多 250 个会话，且有 6s 墙钟预算；超出时返回 `sessions.truncated=true`，数字偏小而不是报错。会话历史本身需要宿主挂载 `sessionQuery` 服务，否则账本整块降级（页面照常可用）。
- **设置导航图标走宿主正式槽位**：`settings.section.icon` 是宿主提供的槽（`{kind:'list', scope:'root', inline:true}`，按 section id 过滤后渲染，缺省回退 `navIcon(id)` 的齿轮）。插件注册 `id: 'skill-manager'`、`order: 21` 的 16×16 / stroke 1.3「卡片 + 星火」；老宿主没有该槽时注册被 `try/catch` 吞掉，退回齿轮而不是报错。不再有 DOM 手术或全文档观察器。
- **主面板是第二处挂载点**：宿主 `main` 槽只给一个满高容器（flex 列 + `overflow:hidden`），滚动、960px 内容列和顶部留白都由插件的 `.sm-panel*` 负责；`sidebar.panellist` 只传 `{ size, active }`，图标是纯装饰，可访问名由宿主行提供。宿主要是将来为主面板提供统一页壳，可以整段删掉 `.sm-panel` / `.sm-panel-scroll` / `.sm-panel-content` 这层包裹。
- **同名技能不合并**：按 rank 先到先得，被遮蔽项仍在列表里并标 `shadowed`，不会自动消除。
- **磁盘根以外的技能只读**：插件中心（`plugin-hub:*`）、preset 打包技能、`bundled` provider 提供的技能都不落磁盘根，只能在「宿主提供」分组里看到名称 / 描述 / 来源，**不能**启停、编辑、删除。宿主 `snapshot()` 返回的是合并后的胜出者，所以面板给出的是「谁赢了」，不是完整的两份冲突清单。当前没有 live Agent 或宿主 `skills` 服务不可用时 `hostSkills.available=false`，分组整体隐藏，列表照常展示。
- **没有重命名 / 跨根移动**：支持单条目与批量（勾选多条）的启停、删除、新建、导入、安装、卸载，以及批量写调用策略；重命名与跨根搬移还没做。
- **资源文件只能改已有文件**：`references/` `scripts/` `assets/` 里的文件可读、可覆盖保存（带 hash 冲突保护），但面板里不能新建或删除文件；二进制与超过 256 KiB 的文件只展示说明。
- **压缩包导入依赖系统 `tar`**：用 Windows 10+ / macOS / Linux 自带的 bsdtar（零新增依赖）。系统没有 `tar` 时导入压缩包会返回 500 并说明原因；文件夹与 `.md` 导入不受影响。
- **自定义根的持久化要重载**：运行时列表立即生效但只活在这个进程里；写进 profile 的托管块需要重载插件（或重启宿主）才按新配置扫描。profile 里已有手写 `- id: skill-manager` 条目时插件不会接管，需要手动把 `customSkillDirs` 挪进托管块或直接改配置。
- **扫描不递归**：深层嵌套的技能目录不会被发现；单文件技能只认根目录下的 `<name>.md`。
- **正文搜索是每次全盘扫描**：重新读所有 `SKILL.md`（单文件上限 512 KiB，超限只匹配元数据），技能很多时有明显 I/O 开销，没有索引缓存。

## 7. 验证方式

完整的验证方法（含隔离 profile 起 web host、主题 token 实测值、页面检查清单）见 [`docs/verification.md`](./docs/verification.md)。最短路径：

```powershell
cd plugin-library\dsh-skill-manager
D:\nodejs\node.exe test\smoke.mjs         # 45 条：扫描 / lint / 启停 / 保存冲突 / 创建 / 导入 / 市场账本 / 调用账本 / 回收站 / 资源文件 / 正文搜索 / 宿主快照 / 压缩包 / 自定义根
D:\nodejs\node.exe test\routes-smoke.mjs  # 41 条：23 条路由的状态码、错误信封、同源门、认证栅栏、disposer、插件同名标注与降级、三态调用/批量/导入/调用账本/回收站/资源文件/搜索/卸载
D:\nodejs\node.exe test\key-parity.mjs    # zh/en 字典 key 集合一致 + 代码里用到的 key 必须存在
D:\nodejs\node.exe --check client\client.js
```

### 7.1 静态自检（不需要宿主）

```powershell
# 两个语言包必须是合法 JSON（UTF-8 无 BOM）
node -e "JSON.parse(require('fs').readFileSync('plugin-library/dsh-skill-manager/locale/en.json','utf8'))"
node -e "JSON.parse(require('fs').readFileSync('plugin-library/dsh-skill-manager/locale/zh.json','utf8'))"

# 浏览器半侧单文件语法（client/client.js 存在时）
node --check plugin-library/dsh-skill-manager/client/client.js
```

### 7.2 host 扫描 / 启停 / 保存冲突

在已登录的 DSH Web 页面里打开 DevTools 控制台（同源 `fetch` 才会过 `Origin` / `Sec-Fetch-Site` 校验）：

```js
const q = (p, init) => fetch('/skill-manager/api/' + p, { credentials: 'same-origin', ...init }).then(r => r.json())

// 1) 扫描：roots 顺序应为 100 → 200 → 300 → 400 → 500 → 600；counts 四项之和=skills.length
await q('overview?cwd=' + encodeURIComponent(location.href && '<你的项目绝对路径>'))

// 2) 启停往返：state 变 disabled 后，磁盘上应出现 <root>/_disabled/<dirName>；再切回应回到原位
await q('skill/toggle', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rootId: '<rootId>', dirName: '<dirName>', kind: 'directory', enabled: false }) })

// 3) 保存冲突：用旧的 hash 提交 → 期望 409 conflict（HTTP 状态与 error.code 同时体现）
await q('skill/save', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rootId: '<rootId>', dirName: '<dirName>', kind: 'directory', state: 'enabled', hash: 'stale-hash', content: '---\nname: x\ndescription: y\n---\n' }) })

// 4) 删除去向：期望 trashed 落在 <root>/_trash/<name>@<yyyyMMddTHHmmss>/
await q('skill/delete', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ rootId: '<rootId>', dirName: '<dirName>', kind: 'directory' }) })

// 5) 市场：available 为 false 时是路径问题（marketDir 不存在），不是接口错误
await q('market?query=&limit=200')
```

### 7.3 页面人工检查清单

- [ ] 设置左侧出现「技能」，点开后列表按 项目 → 用户 → 自定义 → 内置 → 已停用 → 异常 分组，空分组不渲染
- [ ] 主页面侧边栏「自动化任务」下方出现「技能管理」与「MCP 管理」两行；点「技能管理」主面板渲染同一套列表/工具栏，内容可滚动，切回会话后入口仍在
- [ ] 概览条计数与列表条数一致；搜索（name / description / whenToUse / 目录名）与状态过滤生效
- [ ] 行内开关乐观切换，故意拔掉网络后切换会回滚并弹错误 toast，列表不白屏
- [ ] 点行打开详情抽屉：路径可点打开目录、诊断分级正确、正文可编辑、dirty 时「保存」才可用
- [ ] 外部编辑器改同一文件后保存 → 出现 409 冲突红条 + 「重新载入」，磁盘内容未被覆盖
- [ ] 新建：非 kebab-case 名称即时报错；只在可写根下可建；建成后自动定位到该技能
- [ ] 删除：二次确认后条目消失，磁盘上出现在 `_trash/`，没有内容被真删
- [ ] `bundled` 行显示「只读」，开关隐藏，详情里启停/删除/保存全部禁用
- [ ] 市场标签页：目录缺失时整块空状态并给出路径；已安装技能显示「已安装」；安装后用户技能根出现同名目录
- [ ] 深色模式 / 窄屏（<640px）下布局正常，无硬编码色值造成的可读性问题
- [ ] 键盘：`/` 聚焦搜索、Esc 关闭最上层浮层、抽屉内 Tab 焦点不逃逸

## 8. 许可证

MIT。技能内容与市场克隆归各自作者所有，不在本包许可范围内。
