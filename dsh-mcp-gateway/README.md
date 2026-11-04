# dsh-mcp-gateway

DSH（DeepSeek Harness）原生插件：**MCP 工具网关 / 渐进式披露**。
当前 profile 有 11 台启用 MCP 服务器、188 个 `mcp__<server>__<tool>` 工具全量进上下文（约 3.5–4.5 万 token schema）；
本插件先提供**检索层**，再逐步把原始工具收起，改成「搜索 → 描述 → 调用」三件套。

设计依据：[docs/mcp-manager/tool-loading.md](../../docs/mcp-manager/tool-loading.md)（核验 + 三方案对比 + 骨架）。

## 路线

| 阶段 | 内容 |
|---|---|
| **P0-a（当前）** | 注册 `mcp_catalog` / `mcp_search` / `mcp_describe` 三个元工具，**不隐藏任何原有工具**（零回归）；用于验证模型是否会主动检索、命中率与结果体积 |
| P0-b | 增加 `mcp_call`（经 `ctx.tools.execute` 嵌套派发），灰度开启隐藏：在 `system-prompt/assemble` 里过滤 `mcp__*`（**不用** `restrict`，它与 MCP 热增删不兼容，见文档 §6.1） |
| P1 | 按任务/服务器的子集策略、结果渲染（图片/资源退化治理）、搜索排序优化 |

## 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `mcp_catalog` | 无 | `{servers:[{server, count, tools, summary}], total}`：一台服务器一行（每行最多列 12 个工具短名，其余计为 `+N more`），是「这里能干什么」的最便宜入口 |
| `mcp_search` | `{query, server?, limit?}` | `{results:[{name, server, tool, summary, score}], total, missing?}`：只回名字+一行摘要，省 token |
| `mcp_describe` | `{name?, names?}` | 单个 `name` 唯一命中 → 0.1.0 原形状 `{name, server, tool, description, parameters}`；`names` 批量或裸名歧义 → `{tools:[...], missing}`（两种形状用 `oneOf` 声明） |

- **名字解析**：`mcp_describe` 与 `select:` 都接受三种写法——完整名 `mcp__github-local__search_issues`、裸 tool 名 `search_issues`、拼名 `github-local.search_issues`（`.`/空格分隔，也接受 `mcp.github-local.search_issues`）。只按工具名里不可能出现的字符拆分（`_` 不算分隔符），拼回后必须真在目录里；同一串对上多台服务器时全部返回，交给模型按描述挑。
- **批量描述**：`mcp_describe({ names: [...] })` 一次取多个工具的 schema，按请求顺序回报，解析不到的名字进 `missing`（不静默丢弃）。
- **精确取用**：`mcp_search({ query: "select:<name>[,<name>...]" })` 不排序、按请求顺序返回，同名去重、结果受 `MAX_LIMIT`(50) 硬上限约束（`total` 报告去重后的完整命中数）；整条查询恰是某个工具名（全名/裸名/拼名）时也会确定性置顶，行上 `exact: true` 标记（不靠分数哨兵，关键词分数无上界）。
- **参数名进索引**：`mcp_search` 会把工具参数名（顶层 properties + required）纳入匹配，模型用 `file_path`、`timeout`、`title` 这类参数词也能搜到。
- 数据来源：`ctx.tools.schemas()` 里 `mcp__*` 前缀的工具（实时读取，无需缓存失效逻辑）。
- 只读元工具，无副作用；不触碰任何 MCP 服务器配置。
- 工具名不含 `mcp__` 前缀，避免与 MCP 工具命名空间冲突；`run_code` 为宿主保留名。

## 安装

```powershell
D:\nodejs\npm.cmd pack --pack-destination ..\..\migration\dist
# plugin_manager install_bundle <tgz>
```

## 结构

| 路径 | 说明 |
|---|---|
| `lib/index.js` | host 入口：name/inject/apply，注册三个工具 |
| `lib/indexer.js` | 从 `ctx.tools.schemas()` 建立 MCP 工具索引；打分检索、名字解析（裸名/拼名）、按服务器目录 |
| `lib/tools.js` | `mcp_catalog` / `mcp_search` / `mcp_describe` 定义（含 output.schema/render） |
| `scripts/smoke.mjs` | 离线断言 |
