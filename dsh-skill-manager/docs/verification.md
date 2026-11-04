# 验证记录与方法

本文件记录**怎么验证**这个插件，以及验证时实测到的宿主事实。它不替代 `README.md`（用户向）与 `docs/api-contract.md`（接口契约）。

## 1. 宿主基线

| 项 | 值 |
|---|---|
| DSH 桌面版 | `0.2.1-rc.2` |
| Cordis | `4.0.5` |
| 宿主 web server | `@deepseek-ai/dsh-host-webserver`（`webServer.register({ kind:'exact', path, handler })`） |
| 浏览器信任 | `connection.requestRejection`：`GET /?token=…` 换签名 cookie；`Sec-Fetch-Site: cross-site` 与跨 Origin 被 403 |
| 技能发现 | `@deepseek-ai/dsh-skill-filesystem`：只扫根目录直接子项，BOM / 非法调用键会让宿主**静默丢弃**该技能 |

## 2. 离线验证（不需要宿主）

```powershell
cd plugin-library\dsh-skill-manager
D:\nodejs\node.exe test\smoke.mjs        # 扫描 / lint / 启停 / 回收站 / 保存冲突 / 创建 / 三态调用 / 导入 / 市场账本 / 调用账本
D:\nodejs\node.exe test\routes-smoke.mjs # 13 条路由：状态码、错误信封、同源门、认证栅栏、disposer
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
  - 导航图标（0.1.5）：`nav button` 行的子元素从 `[svg, span]` 变成 `[svg(glyph), svg(display:none), span]`，其余 5 行导航未被改动；放大到 8× 检查后字形为「卡片 + 星火」，stroke 1.3 与 DSH Medium 图标一致
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
- [ ] 键盘：`/` 聚焦搜索、Esc 关最上层、抽屉 Tab 不逃逸

## 7. 主页面快速入口（0.1.6）

实现方式：`sidebar.panellist`（id `skill-manager`，order 20，图标 = 卡片 + 星火）+ 同 key 的 `main` 面板；两个槽都用 `ctx.slots.inject` 注册，`main` 组件 `PanelPage` 只补页壳（滚动 / 960px 内容列 / 28px 顶距），内部复用设置页的 `Page`。

已验证（2026-10-22，desktop profile 热装 0.1.6）：

- `cordis_inspect_query`（client `Slots.listSubTree`）读回 live 注册：
  - `sidebar.panellist` occupants：`plugins(0) / schedules(10) / skill-manager(20) / mcp-manager(30)`，全部 `active: true`
  - `main` occupants 增加 `skill-manager`、`mcp-manager`，key 与 panellist id 一致
- 桌面版窗口截图：侧边栏「自动化任务」下面出现「技能管理」「MCP 管理」两行，图标与设置导航同形（见 `docs/screenshots/sidebar-entry.png`）
- 同一套 `PanelPage` 写法在 MCP 管理面板上点开实测：标题 20px、内容列居中、工具栏与列表行正常，说明页壳口径可用；技能面板未再逐项点开（面板外壳与 MCP 完全相同，差异只在内部 `Page`，而 `Page` 本身在设置页已验证）

待补：在隔离 profile 里点开「技能管理」逐项过 §6 的页面检查清单（宿主 `main` 槽不提供页壳，属于插件自绘区域，宿主升级后需复验）。

