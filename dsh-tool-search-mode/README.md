# dsh-tool-search-mode

ZCode 式**工具搜索**的 DSH 插件：把模型可见的工具目录收缩为「核心工具 + 延迟目录清单」，其余工具通过 `tool_search` 按需加载。上下文占用可从数万 token 降到几千。

DSH（DeepSeek Harness）原生插件，纯 JavaScript（ESM）+ 手写设置页，无构建步骤，MIT。

## 它解决什么

MCP 服务器和插件一多，每轮请求都会把全部工具的 JSON Schema 塞进上下文。本插件在 `system-prompt/assemble` 里替换模型可见的工具表：

- **核心工具**始终可见（文件、Shell、Skill、Ask、Todo 等，可配置）；
- **其余工具**只以「名称 + 一句话描述」的清单出现（按 MCP server 分组，超预算自动降级为纯名称或分组计数）；
- 模型调用 `tool_search` 时返回匹配工具的**完整 schema**，并把它们加入本会话的已加载集合——下一轮起直接可见；
- 需要同一轮立即执行时用 `tool_call`，它通过 `ctx.tools.execute` 运行**真实工具**，审批、guard、hook 与会话事件都记在真实工具名下。

## 三种模式

设置 → 工具搜索：

| 模式 | 行为 |
|---|---|
| 自动 | 工具目录超过 `minTools`（默认 12）时启用本地搜索，否则发送完整目录 |
| 本地 | 总是启用（没有可延迟工具时自然退化为完整目录） |
| 关闭 | 发送完整工具目录（隐藏两个桥接工具） |

模式在**会话第一次组装提示词时快照**：改设置只影响新建会话（或重启后冷恢复的会话），当前会话保持原值——与 ZCode 的生效时机一致。

## 安装

插件尚未发布到 npm（`dsh-tool-search-mode` 只是本仓库的包名），用 git 来源或本地 tarball 安装：

```bash
# 本地打包
npm pack --pack-destination ..\..\migration\dist
# 然后在 DSH 插件页选择 tgz，或：
# plugin_manager({ action: "install_bundle", target: "<绝对路径>.tgz" })
```

市场安装走聚合仓库的索引（`https://cdn.jsdelivr.net/gh/sanqiuyef/SQY-DSH-PLUGIN@main/index.json`），条目路径 `dsh-tool-search-mode`。

desktop profile 不要用 `dsh plugin` CLI 管理（会被拒绝），用侧栏「插件」页或 `plugin_manager`。

## 配置

静态配置写在 profile 的 `cordis.patch.yml`（改完重启宿主）：

```yaml
- id: tool-search-mode
  name: 'dsh-tool-search-mode'
  config:
    mode: auto            # auto | local | off（设置页会覆盖为持久值）
    minTools: 12          # auto 模式的启用阈值
    core: [read, write, edit, apply_patch, glob, grep, bash, pwsh, skill, todo_write, ask_user_question, working_directory]
    maxWarmTools: 16      # 每会话已加载集合的 LRU 上限
    listingMaxTokens: 4000
    searchDefaultLimit: 5
    searchMaxLimit: 20
```

设置页把模式写到 `$DSH_HOME/data/dsh-tool-search-mode/settings.json`；文件优先于 `config.mode`，删掉文件即回到配置默认值。

## 与 ZCode 的差异

- ZCode 的 Native 模式走 Anthropic `defer_loading` + `tool_reference`；DSH 当前桌面端接的是 OpenAI 兼容网关（opencode-go），没有可用的原生 ToolSearch，所以本插件只实现 **Local**（本地搜索按需加载）。
- 搜索是确定性的关键词打分（精确名 > 名称子串 > 名称分词 > 描述分词）+ `select:a,b` 精确选择，不依赖外部 rerank 模型。
- ZCode 在 compact 后把已发现工具提升为常驻；本插件用每会话 LRU「已加载集合」达到同样效果，并在每次组装时重新计算，不写会话历史。

## 兼容性

- 目标宿主：DSH ≥ 0.2.1-rc.2，实测 rc.5。
- rc.5 的 `system-prompt/assemble` 瀑布收到含 `tools` 的完整 assembly，返回值生效；0.2.2-alpha 线改为瀑布后再追加宿主工具表，那里本插件自动退化为「关闭」（不破坏宿主行为）。
- 与社区插件 `dsh-tool-search`（Letter2025）不要同时启用：两者都注册 `tool_search` / `tool_call`，会重名冲突。

## 测试

```bash
node scripts/smoke.mjs      # 纯逻辑 + 假 ctx：目录拆分、搜索、清单、模式快照、桥接工具、路由
node client/selfcheck.mjs   # 设置页注册契约与三选项渲染
```

两个套件都不依赖宿主包，也不读写真实 `~/.dsh`。

## 设计参考

- ZCode 的 ToolSearch 设计（`apps/zcode-cli/docs/design/v2/tool/19-tool-search.md`）：模式语义、常驻工具名单、`select:` 语法、会话级生效时机。
- 社区插件 [`Letter2025/dsh-tool-search`](https://github.com/Letter2025/dsh-tool-search)（MIT）：验证了 DSH 的 `system-prompt/assemble` 替换点、桥接工具经 `ctx.tools.execute` 执行真实工具的路径。本插件为独立实现，未复制其源码。

## License

MIT © 2026 sanqiuyef
