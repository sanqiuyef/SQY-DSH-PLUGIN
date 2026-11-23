# 验证记录与方法

本文件记录**怎么验证**这个插件，以及验证时实测到的宿主事实。它不替代 `README.md`（用户向）与 `docs/api-contract.md`（接口契约）。

## 1. 宿主基线

| 项 | 值 |
|---|---|
| DSH 桌面版 | `0.2.1-rc.5`（本机安装版 `resources/app.asar` 直接核验） |
| Cordis | `4.0.5` |
| 宿主 web server | `@deepseek-ai/dsh-host-webserver`（`webServer.register({ kind:'exact', path, handler })`） |
| 浏览器信任 | `connection.requestRejection`：`GET /?token=…` 换签名 cookie；`Sec-Fetch-Site: cross-site` 与跨 Origin 被 403 |
| 技能发现 | `@deepseek-ai/dsh-skill-filesystem`：只扫根目录直接子项，BOM / 非法调用键会让宿主**静默丢弃**该技能；rc.5 与仓库 master 线的 skills 相关源码逐字节一致（`app.asar` 内 `src/*.ts` 对比），`settings.section.icon` 槽在 rc.5 已存在 |

## 2. 离线验证（不需要宿主）

```powershell
cd plugin-library\dsh-skill-manager
D:\nodejs\node.exe test\smoke.mjs        # 45 条：扫描 / lint / 启停 / 保存冲突 / 创建 / 导入 / 市场账本 / 调用账本 / 回收站 / 资源文件 / 正文搜索 / 宿主快照
D:\nodejs\node.exe test\routes-smoke.mjs # 41 条：23 条路由的状态码、错误信封、同源门、认证栅栏、disposer
D:\nodejs\node.exe test\key-parity.mjs   # zh/en 字典 key 集合一致（388:388）
```

两个脚本都用临时目录做 fixture，跑完自动清理；`smoke.mjs` 末尾还会只读地过一遍本机真实技能根。

## 3. 真机验证（隔离 profile，不碰用户的 desktop profile）

桌面版独占 `desktop` profile，CLI 会拒绝（`profile "desktop" is managed exclusively by the Electron application`）。用桌面版自带 CLI（Electron 以 node 方式运行 asar 内的 `bin.js`）建一个一次性 profile：

```powershell
$env:ELECTRON_RUN_AS_NODE="1"
$exe = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$bin = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"

# 1) 一次性 profile：bundles 里加本插件
#    %USERPROFILE%\.dsh\profiles\skm-verify\package.json
#    { "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-skill-manager"] } } }

# 2) 装 tarball
& $exe $bin plugin --profile skm-verify add migration\dist\dsh-skill-manager-0.1.x.tgz

# 3) 起 web（打印带 token 的 URL）
& $exe $bin --profile skm-verify --no-open --port 0
# → dsh web: http://127.0.0.1:PORT/?token=…

# 4) 浏览器打开该 URL（cookie 只认这个 authority），进 设置 → 技能
# 5) 结束后：kill 进程 + 删除 profiles\skm-verify
```

该 profile 与本插件无关的库一律不装，验证完即删，不污染 `desktop`。

## 4. 主题 token 实测（2026-10-22，`getComputedStyle(document.body)`）

| token | light | dark |
|---|---|---|
| `--dsw-alias-bg-base` | `#fff` | `#151517` |
| `--dsw-alias-bg-layer-1` | `#fff` | `#232324` |
| `--dsw-alias-bg-layer-2` | `#fff` | `#2c2c2e` |
| `--dsw-alias-bg-overlay` | `#e9ecf2` | `#61666b` |
| `--dsw-alias-brand-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-primary` | `#0f1115` | `#f9fafb` |
| `--dsw-alias-label-secondary` | `#61666b` | `#cfd3d6` |
| `--dsw-alias-state-idle-primary` | `#d4d4d4` | `#545557` |
| `--dsw-specific-sidebar-fill` | `#f9fafb` | `#1b1b1c` |

结论：**浅色下 layer-1/2 与页面同色**，**深色下 bg-overlay 是亮灰**。所以浮层与输入面不能用 `bg-overlay` 直取，而是用 `color-mix(in oklab, label-primary N%, bg-base)` 派生 `--sm-surface-1/2`（4%/6%），才能同时满足两种主题的可读层级。

## 5. 已核验结论

- `plugin_manager install_bundle` → `application: applied`，`warnings: []`（0.1.0 与 0.1.3，宿主 desktop profile）。
- 真机 `GET /skill-manager/api/overview` → 200，扫出本机 6 个用户技能，`counts` 与 `skills` 一致；`market` 摘要 47 仓库 / 6440 技能。
- `GET /skill-manager/api/market?limit=3` → 200，返回解析后的仓库与技能，`counts.totalSkills = 6440`。
- 市场索引冷启动 ≈ 1.2 s（32 并发解析 + 5 分钟缓存），暖查询 ≈ 20 ms；串行实现曾需 ≈ 46 s，已废弃。
- 隔离 profile 的浏览器端到端（0.1.3）：
  - 设置导航出现「技能」，列表按「自定义技能 / 用户技能」分组，组标题、来源、新建选项全部为中文（不再漏 Host 的英文 label）
  - 导航图标（0.1.5 的 DOM 装饰方案已在 0.2.0 移除，改用宿主 `settings.section.icon` 槽；rc.5 的 `app.asar` 里该槽定义为 `{kind:'list', scope:'root', inline:true}`，`SettingsRoot` 用 `renderSlot('settings.section.icon', {size:16, active}, {only: row.id, fallback: navIcon(row.id)})` 渲染；离线 smoke 已确认注册项为 `["settings.section.icon","skill-manager", …]`，真机待复验）
  - 行内开关：`demo-skill` 关→开，`_disabled/` 往返成功，计数与「已停用」分组同步
  - 新建：模态创建 `ui-made` 成功 → 抽屉自动打开 → 该技能**立即出现在运行中 Agent 的技能目录**（宿主 watcher 生效）
  - 保存：编辑器改内容 → `已保存` → 磁盘同步；保存按钮在无改动时禁用
  - 删除：二次确认 → `已移入回收站` → 磁盘出现 `<root>/_trash/ui-made@20261022T115120/SKILL.md`
  - 市场：浏览 47 仓库（每仓库 8 条代表技能）；搜索 `obsidian` 走服务端（4 仓库 / 13 命中）；`market/install` 到自定义根成功，重复安装返回 409 `exists`
  - 深色 / 浅色两套主题下抽屉、模态、菜单正文对比正常；控制台无本插件报错（仅旧端口 connection refused 噪音）
  - 测试产生的 `ui-made` 与 `_trash` 残留已手动清理，用户技能根恢复为原始 6 项


## 6. 页面检查

> 每次发布前按此表在隔离 profile 的 web host 里逐项过一遍（浅色 + 深色 / 1040px + 390px）。

- [ ] 设置左侧出现「技能」，顺序在「Agent 预设」之后，**图标是自己的卡片+星火（不是齿轮）**
- [ ] 主页面侧边栏「自动化任务」下方出现「技能管理」；点开后 main 面板渲染同一套页面，滚动与 960px 内容列正常；切回会话后入口仍在
- [ ] 列表按 根（rank 升序）→ 已停用 → 异常 分组；空分组不渲染
- [ ] 概览条四项与列表条数一致；组标题是中文（不是 Host 的英文 label）
- [ ] 搜索（name/description/whenToUse/目录名）与状态/作用域筛选生效
- [ ] 行内开关乐观切换、失败回滚 + toast；恶劣网络下列表不白屏
- [ ] 详情抽屉：路径可点开目录、诊断分级、调用策略开关改 frontmatter、正文可编辑
- [ ] 外部改文件后保存 → 409 冲突红条 + 「重新载入」，磁盘未被覆盖
- [ ] 新建：非 kebab 名即时报错；建成后自动打开抽屉（可启停/删除，不是只读）
- [ ] 删除：二次确认 → 条目消失，磁盘出现 `_trash/<name>@<时间戳>/`
- [ ] 市场：搜索走服务端（能搜到不在首屏切片里的技能）；已安装显示徽章；安装后用户根出现目录
- [ ] 深色：抽屉/模态/菜单正文对比正常；浅色：列表卡片与输入框有可辨层级
- [ ] 键盘：`/` 聚焦搜索（浮层打开时不抢焦点）、Esc 关最上层、抽屉 Tab 不逃逸
- [ ] 未保存草稿时 Esc / 点遮罩 / 点关闭弹「丢弃修改？」确认；保存中/删除中直接拦截
- [ ] 保存后抽屉头徽章与启停按钮立即跟随新状态（不用关掉重开）
- [ ] 只读（bundled）技能：正文不可编辑、保存禁用、显示「内置技能只读」
- [ ] BOM 文件：工具条出现「保存时去除 BOM」勾选，保存后文件头不再是 BOM
- [ ] CRLF 文件编辑保存后仍是 CRLF
- [ ] 列表上方出现诊断条（根不存在时），可关闭
- [ ] 「宿主提供」分组列出磁盘根以外的技能（如 dsh-doc / office），只读、无开关
- [ ] 回收站面板：恢复、单条永久删除（二次确认）、清空（二次确认）都生效
- [ ] 详情「文件」页：references 里的 md 可读可改；二进制只显示说明
- [ ] 正文搜索开关：搜到正文里的词，点结果打开详情
- [ ] 市场「卸载」：确认后条目进 `_trash/`，市场不再显示「已安装」
- [ ] 批量条含「模型不可调用 / 都不可调用」，失败条目名进 toast

## 8. v0.2.0 变更（代码已验，真机待复验）

本版把评估报告里的问题一次修完，改动分四组：

1. **宿主对照**：`overview.hostOnly` / `hostSkills` + `GET /host-skills`。离线用桩服务验证了 `snapshot()` 的 `complete` 透传、`plugin-hub:*` 的 `pluginId` 解析、以及 `hostOnly` 按 name 取差集；真机上应能看到 dsh-doc / office* 这类 preset 技能出现在「宿主提供」分组里。
2. **回收站闭环**：`GET /trash`、`POST /trash/restore`、`POST /trash/purge`（唯一真删入口，`all` 必须带 `confirm`），token 解析只认本插件命名规则，非本插件条目一律不动。
3. **资源文件与搜索**：`GET /skill/files`、`GET|POST /skill/file`（同一路径按 method 分派）、`GET /search`（正文命中带行号，`q` 至少 2 字符）。
4. **修正**：`/open` 校验目标存在并接受 `state`；`skill/save` 的 `hash` 改为必填；body 上限 512 KiB；`market.installed` 不再回退为同名技能数；删除/卸载销账；`create` 支持单文件形态、`_disabled/` 同名检查、64 字符上限；导入忽略 README 等说明文档；lint 口径对齐宿主（只认 6 个键，`description-long` 500 / 正文 8192 改为 `info`）；所有写操作补 `realpath` 校验。

离线验证：`smoke.mjs` 45 条、`routes-smoke.mjs` 41 条、`key-parity.mjs` 388:388 全绿；Windows junction 逃逸用例在无开发者模式的机器上按 SKIP 处理。

## 9. v0.3.0 变更（代码已验，真机待复验）

补上评估里「刻意没做」的三类，并修掉两条架构风险：

1. **自定义技能根 UI**：`GET|POST /roots/custom`。运行时列表立即参与扫描；`persist: true` 写 profile 补丁的托管块（`# >>> dsh-skill-manager custom roots >>>`），写前备份到 `<profileDir>/data/skill-manager/`、写后用 `yaml` 重新解析校验、顶层是 flow 空序列（`[]`）时先剥离再追加、手写 `- id: skill-manager` 条目一律 409 不接管。
2. **技能包导出与压缩包导入**：`POST /skill/export`（系统 `tar -a`，按扩展名产出 zip/tgz）、`POST /skill/import` 识别 `.zip/.tar/.tar.gz/.tgz`（解压到 `mkdtemp` 临时目录后走同一套发现规则）。压缩包在**解压前**用 `tar -tf` 校验成员名（`..` / 绝对路径 / 盘符），解压后再做 realpath 复核与符号链接拒绝——两条路径都是 400 且不留半个文件。
3. **架构风险收敛**：
   - rank 表副本：新增 `applyHostShadowing`，用宿主 `snapshot()` 胜出者的 `path` 与本地 `path` 直接比较，命中即标 `shadowedByHost`（不再只靠本地 rank 推断）。
   - `_disabled/` 依赖宿主只扫一层：新增 `findDisabledLeaks`，用「同名 + description 相同」确认宿主确实看到了停用条目，`overview.diagnostics` 给 `disabled-visible`。
   - 账本 overwrite：`market/install` 的 `overwrite: true` 现在要求账本记录的 `targetPath` 与磁盘条目一致，否则 409——不再可能把用户手写的同名技能静默移进 `_trash/`。
   - live Agent 依赖：`listHostSkills` 在没有 live Agent 时退到 `ctx.get('skills')` 的全局层，而不是直接降级。
   - 仍保留的取舍：仍用 `node:fs` 而非 `ctx.fs`（改造成本高于收益，见 README「已知限制」）。

离线验证：`smoke.mjs` 45 条（新增压缩包往返/越界、运行时根规范化与去重、宿主胜出者校验、停用泄漏）、`routes-smoke.mjs` 41 条（新增 `/roots/custom` 读写成块、`/skill/export` 409/400、导出→删除→从压缩包导入的完整回路）、`key-parity.mjs` 388:388 全绿。

## 7. 主页面快速入口（0.1.6）

实现方式：`sidebar.panellist`（id `skill-manager`，order 20，图标 = 卡片 + 星火）+ 同 key 的 `main` 面板；两个槽都用 `ctx.slots.inject` 注册，`main` 组件 `PanelPage` 只补页壳（滚动 / 960px 内容列 / 28px 顶距），内部复用设置页的 `Page`。

已验证（2026-10-22，desktop profile 热装 0.1.6）：

- `cordis_inspect_query`（client `Slots.listSubTree`）读回 live 注册：
  - `sidebar.panellist` occupants：`plugins(0) / schedules(10) / skill-manager(20) / mcp-manager(30)`，全部 `active: true`
  - `main` occupants 增加 `skill-manager`、`mcp-manager`，key 与 panellist id 一致
- 桌面版窗口截图：侧边栏「自动化任务」下面出现「技能管理」「MCP 管理」两行，图标与设置导航同形（见 `docs/screenshots/sidebar-entry.png`）
- 同一套 `PanelPage` 写法在 MCP 管理面板上点开实测：标题 20px、内容列居中、工具栏与列表行正常，说明页壳口径可用；技能面板未再逐项点开（面板外壳与 MCP 完全相同，差异只在内部 `Page`，而 `Page` 本身在设置页已验证）

待补：在隔离 profile 里点开「技能管理」逐项过 §6 的页面检查清单（宿主 `main` 槽不提供页壳，属于插件自绘区域，宿主升级后需复验）。

