/**
 * dsh-mcp-gateway — host 半入口（P0-a 搜索版）。
 *
 * 定位：MCP 工具的「渐进式披露」第一层。当前 profile 有 11 台启用 MCP 服务器、188 个
 * `mcp__<server>__<tool>` 工具全量进上下文（schema 粗估 3.5–4.5 万 token）；本插件只增加
 * 三个只读元工具 `mcp_catalog` / `mcp_search` / `mcp_describe`，**不隐藏、不替换、不启用/停用
 * 任何现有工具**（零回归，装错最坏情况只是多三个工具）。
 *
 * 数据源：每次执行时实时读 `ctx.tools.schemas(scope)`（见 lib/indexer.js），
 * 因此 MCP 服务器的热增删（重连、`tools/list` 变更）无需任何缓存失效逻辑。
 *
 * 注册方式：裸 ToolDefinition + 标准 JSON Schema（不用 `defineTool`，原因见 lib/tools.js 头注释）。
 * `ctx.effect` 拥有三个 `register()` disposer，插件 HMR 卸载/重挂时精确回收。
 *
 * 设计依据：docs/mcp-manager/tool-loading.md §5（P0-a）/§6（骨架与验收）。
 */

import { collectMcpTools } from './indexer.js'
import { createCatalogTool, createDescribeTool, createSearchTool } from './tools.js'

/** Cordis 插件名（与 cordis.patch.yml 的 `name: 'dsh-mcp-gateway'` 包名不同，这里是条目 name）。 */
export const name = 'mcp-gateway'

/** 依赖的服务：只读工具注册表即可。 */
export const inject = ['tools']

/**
 * 注册三个元工具。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文（宿主平面）。
 */
export function apply(ctx) {
  /** 每次执行实时取当前作用域可见的 MCP 工具（`exec.agent` 由宿主注入）。 */
  const getTools = (exec) => collectMcpTools(ctx, exec?.agent)

  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(createSearchTool(getTools)),
      ctx.tools.register(createDescribeTool(getTools)),
      ctx.tools.register(createCatalogTool(getTools)),
    ]

    // ------------------------------------------------------------------
    // P0-b 预留位（本版本**刻意不实现**，保持 P0-a 零回归）：
    //
    //   1) 隐藏原始工具 —— 在 `system-prompt/assemble` waterfall 里过滤
    //      `assembly.tools` 中 `name.startsWith('mcp__')` 的条目：
    //        ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    //          const result = await next()
    //          return config.hideOriginals === true
    //            ? { ...result, tools: result.tools.filter((tool) => !tool.name.startsWith(MCP_PREFIX)) }
    //            : result
    //        })
    //      注意：这是「只改模型可见面」，注册表与执行可见性不变；不要用 restrict（需 agent
    //      scope、只认确切名字、注册时校验已知性，对 MCP 热增删不安全）。详见文档 §3.2/§6.1。
    //
    //   2) 注册 `mcp_call` —— 用公开的 `ctx.tools.execute()` 嵌套派发：
    //        const callId = `${String(exec.callId)}:gw:${++callSeq}`
    //        const schema = ctx.tools.get(args.tool, exec.agent)
    //        const result = await ctx.tools.execute({
    //          callId, rootCallId: exec.rootCallId, name: args.tool, schema,
    //          arguments: args.arguments ?? {}, parent: exec.token, signal: exec.signal,
    //          ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    //        })
    //      与 PTC 桥内部派发同构（dsh-tools/lib/index.js:1362-1377），走完整 pre-policy→guards
    //      →dispatch→post-policy，审批不旁路。**该用法属需实机验证项**（文档 §7-1）。
    //
    //   3) 灰度开关 `hideOriginals`（默认 false）与防绕过 guard：
    //        ctx.tools.guard((exec) => exec.parent === undefined && exec.name.startsWith('mcp__')
    //          ? 'Call MCP tools through mcp_call({ tool, arguments })' : undefined)
    //
    //   4) 结果渲染治理：图片/资源链接从内层 content 搬运到 `finalizeContent`
    //      （当前 mcp_call 未实现时会退化为文本 JSON，文档 §7-3）。
    // ------------------------------------------------------------------

    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose?.()
        } catch {
          // 一个失败不能连累另一个工具被回收
        }
      }
    }
  }, 'mcp-gateway: meta tools')
}

export default { name, inject, apply }
