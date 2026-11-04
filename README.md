# SQY-DSH-PLUGIN

自研 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件集合：五个插件各占一个子目录，均以 Cordis bundle 插件包形态发布（`dsh.bundle.patch` + 宿主半 `apply`），MIT 许可。

## 插件一览

| 插件 | 版本 | 能力 |
|---|---|---|
| [dsh-mcp-manager](dsh-mcp-manager/) | 0.2.3 | 设置 → MCP 服务器：清单 / 启停 / 编辑 / 新增 / 删除（含手写行）/ 连接健康度派生 / 就地重连 / 探测阶段归因 + 修复建议 / 导入导出 + 环境变量桥 |
| [dsh-memory-manager](dsh-memory-manager/) | 0.3.0 | 记忆管理：全局 + 项目级 `memory_*` 工具、`memory:digest` 注入（时间倒序 + 近期带）、写去重提示、别名并条、写入脱敏、运行审计、设置页增删改 |
| [dsh-mcp-gateway](dsh-mcp-gateway/) | 0.2.0 | MCP 工具渐进披露：`mcp_catalog` / `mcp_search` / `mcp_describe`（裸名/拼名解析、批量、参数名检索、`select:` 精确取用；不隐藏原有工具） |
| [dsh-skill-manager](dsh-skill-manager/) | 0.1.7 | 设置 → 技能：根扫描 / `_disabled` 启停 / 三态调用策略（软禁用）/ 批量操作 / 调用账本 / 本地技能包导入 / 安装来源账本 / 插件同名提示 |
| [dsh-plugin-hub](dsh-plugin-hub/) | 0.3.1 | 插件中心：插件市场 + 插件管理双标签；ZCode 格式能力包的 skills / commands / hooks / MCP 按 Agent 投影；版本历史与回滚 / 故障诊断 / 项目信任门 / MCP 重名冲突让位 |

每个插件目录自带 `README.md`（功能、配置面、安装、已知限制、验证方式）。

## 安装

要求：DSH **0.2.1-rc.1 及以上**（桌面端 0.2.1-rc.5 实测）。

### 作为插件市场索引（推荐）

DSH 的「插件 → 发现 → 索引源」添加以下 **JSON 索引 URL**（不是仓库网页地址）：

- GitHub Pages：`https://sanqiuyef.github.io/SQY-DSH-PLUGIN/index.json`
- jsDelivr 镜像：`https://cdn.jsdelivr.net/gh/sanqiuyef/SQY-DSH-PLUGIN@main/index.json`

索引为 format-1 市场格式，版本来源是 git 提交（`source: git` + 精确 commit），安装时会固定到该提交。

### 从源码打包安装

```powershell
# 1) 克隆并打包（每个目录独立打包）
git clone https://github.com/sanqiuyef/SQY-DSH-PLUGIN
cd SQY-DSH-PLUGIN\dsh-mcp-manager
D:\nodejs\npm.cmd pack --pack-destination .\dist

# 2) 安装
#   桌面端：插件管理页导入 tgz（desktop profile 仅由 GUI 管理）
#   其他 profile：dsh plugin --profile <name> add <tgz 路径>
#   或会话内：plugin_manager({ action: "install_bundle", target: "<tgz 绝对路径>" })
```

技能 / MCP 等能力的生效范围与信任规则见各插件 README。

## 跨插件约定

- **共享项目信任**：`dsh-mcp-manager` 与 `dsh-plugin-hub` 使用同一份 `<profileDir>/data/project-trust/trusted.json`（canonical `dsh-project-trust/v1`，MCP + 插件配置双文件聚合 hash），一次批准同时覆盖插件配置与项目级 MCP。两个插件的 `lib/project-trust.js` 必须保持同版。
- **MCP 重名优先级**：全局（profile 补丁 / dsh-mcp-manager）> 项目（受信任的 `.dsh/mcp.json`）> 插件（dsh-plugin-hub）；后两者冲突时让位并在管理页标明。

## 开发

每个插件均为纯 JavaScript（ESM）+ 手写客户端模块，无构建步骤；离线验证：

```powershell
D:\nodejs\node.exe dsh-mcp-manager\scripts\smoke.mjs
D:\nodejs\node.exe dsh-memory-manager\scripts\smoke.mjs
D:\nodejs\node.exe dsh-mcp-gateway\scripts\smoke.mjs
D:\nodejs\node.exe dsh-skill-manager\test\smoke.mjs
D:\nodejs\node.exe dsh-plugin-hub\scripts\smoke.mjs
```

## 许可

[MIT](LICENSE) © 2026 sanqiuyef
