/**
 * dsh-mcp-gateway — MCP 工具索引层（纯函数，供 tools.js 与 scripts/smoke.mjs 复用）。
 *
 * 数据源永远是宿主工具注册表的**实时投影** `ctx.tools.schemas(scope)`：
 * MCP 服务器的工具集随重连/热更新变化，本模块不缓存任何条目，避免缓存失效逻辑。
 *
 * 工具命名契约（`dsh-mcp-client/lib/index.js:96-110`）：
 *   `mcp__<serverName>__<rawName>`，serverName 允许 `[A-Za-z0-9_-]{1,32}`（可含 `_` / `-`），
 *   超出 64 字符或发生非法字符替换时追加 12 位 sha256。
 *
 * 解析规则（与任务约定一致，也是本模块唯一有歧义的地方）：
 *   - 第一个 `mcp__` 之后、**最后一个** `__` 之前 = server；
 *   - 最后一个 `__` 之后 = tool。
 * 因为 serverName 与 rawName 都可能含 `__`，任何规则都无法 100% 消歧；取「最后一个 `__`」
 * 使 `mcp__code-review-graph__list_commits`、`mcp__a_b__c`、`mcp__a__b__c` 都稳定解析，
 * 且与 mcp-client 的 `mcp__<serverName>__<rawName>` 拼接方向（server 在前）一致。
 *
 * 名字解析（`resolveMcpNames`）：模型从搜索结果里看到的常常是不带前缀的短名（`search_issues`），
 * 也可能写成 `server.tool`。只按「合法工具名里不可能出现的字符」（`.` 与空白；`_` 是合法字符，
 * 不能当分隔符）拆分，所以拆法唯一、不是猜测；拼回 `mcp__<server>__<tool>` 后必须真在目录里，
 * 拼不回就一个都不返回。同一串对上多条时全部返回，交给模型按描述挑。
 *
 * 目录（`catalog`）：按 server 聚合成「一台服务器一行」，是「这里能干什么」的入口，
 * 也是 P0-b 分级目录的 tier-3 文本来源。
 */

/** 模型面 MCP 工具名前缀（`mcp-client` 的命名契约）。 */
export const MCP_PREFIX = 'mcp__'

/** `mcp_search` 单条摘要的最大字符数（含省略号）。 */
export const MAX_SUMMARY_CHARS = 160

/** `mcp_search` 未指定 limit 时的默认条数。 */
export const DEFAULT_LIMIT = 20

/** `mcp_search` 允许的最大条数（与任务契约 1–50 对齐）。 */
export const MAX_LIMIT = 50

/** `mcp_search` 的 `select:` 前缀（精确取用形态）。 */
export const SELECT_PREFIX = 'select:'

/** 参数名命中的权重：低于 tool 名（6），高于描述（1）。 */
export const PARAM_WEIGHT = 2

/** `mcp_catalog` 每台服务器列出的工具名上限（超出用 `+N more` 表示）。 */
export const MAX_CATALOG_NAMES = 12

/**
 * 把 `mcp__<server>__<tool>` 解析成 `{ name, server, tool }`。
 *
 * @param {unknown} name - 候选工具名（外部输入，必须容忍非字符串）。
 * @returns {{ name: string, server: string, tool: string } | undefined}
 *   非 MCP 命名、缺少 server 或 tool 段时返回 undefined。
 */
export function parseMcpToolName(name) {
  if (typeof name !== 'string' || !name.startsWith(MCP_PREFIX)) return undefined
  const rest = name.slice(MCP_PREFIX.length)
  const split = rest.lastIndexOf('__')
  // split <= 0：没有分隔符（`mcp__codegraph`）或 server 为空（`mcp____x`）
  if (split <= 0) return undefined
  const server = rest.slice(0, split)
  const tool = rest.slice(split + 2)
  // tool 为空（`mcp__server__`）
  if (tool.length === 0) return undefined
  return { name, server, tool }
}

/**
 * 从宿主工具注册表收集当前可见的 MCP 工具。
 *
 * @param {{ tools?: { schemas?: (scope?: unknown) => unknown[] } }} ctx - Cordis 插件上下文。
 * @param {unknown} [scope] - 查看作用域（`exec.agent`）；省略 = 全局视图。
 * @returns {{ name: string, server: string, tool: string, description: string, parameters: object }[]}
 *   保持注册表顺序；非 `mcp__*` 工具与无法解析的名字被跳过。
 */
export function collectMcpTools(ctx, scope) {
  const schemas = ctx !== null && typeof ctx === 'object' && ctx.tools !== undefined && typeof ctx.tools.schemas === 'function'
    ? ctx.tools.schemas(scope)
    : []
  const collected = []
  for (const schema of Array.isArray(schemas) ? schemas : []) {
    const parsed = parseMcpToolName(schema?.name)
    if (parsed === undefined) continue
    collected.push({
      name: parsed.name,
      server: parsed.server,
      tool: parsed.tool,
      description: typeof schema.description === 'string' ? schema.description : '',
      parameters: isPlainObject(schema.parameters)
        ? schema.parameters
        : { type: 'object', properties: {} },
    })
  }
  return collected
}

/**
 * 英文按词、中文按 bigram 分词（小写、去重、保持首次出现顺序）。
 *
 * 为什么 bigram：中文没有空格，模型查询常是「读取 表格」「语音 转写」这类短语；
 * 单字命中噪声太大，bigram 既能命中中文描述又保留顺序信息。英文按 `[a-z0-9]+` 切分，
 * 因此 `code-review-graph`、`mcp__x__y` 这类带分隔符的标识符也能命中各自的词。
 *
 * @param {unknown} text - 待分词文本。
 * @returns {string[]} 去重后的 token（含中文 bigram）。
 */
export function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const tokens = []
  const seen = new Set()
  const push = (token) => {
    if (token.length === 0 || seen.has(token)) return
    seen.add(token)
    tokens.push(token)
  }
  let ascii = ''
  let cjk = ''
  const flushAscii = () => {
    // 单字符英文/数字 token 是纯噪声（'a' 会子串命中几乎任何词），不参与打分；
    // 中文单字保留，因为单字在中文里可能是有效词。
    if (ascii.length >= 2) push(ascii)
    ascii = ''
  }
  const flushCjk = () => {
    if (cjk.length === 1) push(cjk)
    else if (cjk.length > 1) for (let index = 0; index + 2 <= cjk.length; index++) push(cjk.slice(index, index + 2))
    cjk = ''
  }
  for (const ch of text.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) {
      flushCjk()
      ascii += ch
      continue
    }
    if (isCjk(ch)) {
      flushAscii()
      cjk += ch
      continue
    }
    flushAscii()
    flushCjk()
  }
  flushAscii()
  flushCjk()
  return tokens
}

/**
 * 单工具的匹配分（0 = 不相关）。
 *
 * 权重顺序：解析出的 tool 名 > server 名 > 完整工具名 > 参数名 > 描述；整串短语额外加成，
 * 让「excel 表格」这类查询优先命中 `create_excel_workbook` 而不是只描述里带一个词的噪声工具。
 * 参数名（如 `file_path`、`timeout`）参与索引，因为模型常用参数词搜索。
 *
 * @param {{ name: string, server: string, tool: string, description: string, parameters?: object }} tool - 索引条目。
 * @param {string[]} tokens - `tokenize()` 结果（小写）。
 * @param {string} query - 已去除首尾空格并小写的整串查询。
 * @returns {number} 非负整数分。
 */
export function scoreTool(tool, tokens, query) {
  if (tokens.length === 0) return 0
  const toolName = tool.tool.toLowerCase()
  const fullName = tool.name.toLowerCase()
  const serverName = tool.server.toLowerCase()
  const description = tool.description.toLowerCase()
  const parameters = parameterText(tool.parameters)
  let score = 0
  for (const token of tokens) {
    if (toolName.includes(token)) score += 6
    if (fullName.includes(token)) score += 3
    if (serverName.includes(token)) score += 4
    if (parameters.includes(token)) score += PARAM_WEIGHT
    if (description.includes(token)) score += 1
  }
  if (query.length >= 2) {
    if (toolName.includes(query)) score += 10
    else if (fullName.includes(query)) score += 6
    if (parameters.includes(query)) score += PARAM_WEIGHT
    if (description.includes(query)) score += 4
  }
  return score
}

/**
 * 生成 `mcp_search` 的 compact 结果。
 *
 * 三种形态：
 *   1. `select:<name>[,<name>...]` —— 精确取用：按请求顺序原样回报（同名只回一行），
 *      无法解析的名字去重后进 `missing`（不静默丢弃）；结果受 `MAX_LIMIT` 硬上限约束，
 *      `total` 始终是去重后的完整命中数；显式名字模式忽略 `limit` / `server`；
 *   2. 整条查询恰是某个工具名（全名 / 裸名 / `server.tool`）—— 确定性置顶，
 *      行上 `exact: true`，不参与分数浮动；
 *   3. 其他关键词 —— 原有子串打分排序。
 *
 * @param {Array} tools - `collectMcpTools()` 的输出。
 * @param {unknown} query - 模型给的查询词。
 * @param {{ server?: unknown, limit?: unknown }} [options] - server 精确过滤（不区分大小写）；limit 1–50。
 * @returns {{ results: { name: string, server: string, tool: string, summary: string, score: number, exact: boolean }[], total: number, missing?: string[] }}
 *   `total` = 截断到 limit 之前的命中总数；`missing` 只在 select 形态出现。
 */
export function search(tools, query, options = {}) {
  const catalogTools = Array.isArray(tools) ? tools : []

  const selected = parseSelectQuery(query)
  if (selected !== undefined) {
    if (selected.length === 0) return { results: [], total: 0, missing: [] }
    const resolved = resolveMcpNames(catalogTools, selected)
    const results = []
    const seen = new Set()
    for (const entry of resolved.entries) {
      for (const tool of entry.matches) {
        if (seen.has(tool.name)) continue
        seen.add(tool.name)
        results.push(toolRow(tool, 0, true))
      }
    }
    return {
      results: results.slice(0, MAX_LIMIT),
      total: results.length,
      missing: uniqueStrings(resolved.missing),
    }
  }

  const normalized = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (normalized.length === 0) return { results: [], total: 0 }
  const tokens = tokenize(normalized)
  const limit = clampLimit(options.limit)
  const serverFilter = typeof options.server === 'string' && options.server.trim() !== ''
    ? options.server.trim().toLowerCase()
    : undefined
  const pool = serverFilter === undefined
    ? catalogTools
    : catalogTools.filter((tool) => tool.server.toLowerCase() === serverFilter)

  // 整串查询恰是工具名 → 置顶（不参与分数浮动）
  const pinned = resolveMcpNames(pool, [normalized]).entries[0]?.matches ?? []
  const pinnedNames = new Set(pinned.map((tool) => tool.name))
  const scored = []
  for (const tool of pool) {
    if (pinnedNames.has(tool.name)) continue
    const score = scoreTool(tool, tokens, normalized)
    if (score <= 0) continue
    scored.push({ tool, score })
  }
  // 同分时按 name 升序，保证结果可复现（模型重试/回放看到同一顺序）
  scored.sort((left, right) => right.score - left.score || compareNames(left.tool.name, right.tool.name))
  const total = pinned.length + scored.length
  const results = [
    ...pinned.map((tool) => toolRow(tool, scoreTool(tool, tokens, normalized), true)),
    ...scored.map(({ tool, score }) => toolRow(tool, score, false)),
  ].slice(0, limit)
  return { results, total }
}

/**
 * 按精确工具名取完整描述 + 参数 schema（`mcp_describe`）。
 *
 * @param {Array} tools - `collectMcpTools()` 的输出。
 * @param {unknown} name - 模型给的工具名。
 * @returns {{ name: string, server: string, tool: string, description: string, parameters: object } | undefined}
 *   精确匹配失败返回 undefined（由调用方给出可自愈错误）。
 */
export function describe(tools, name) {
  if (typeof name !== 'string') return undefined
  const found = (Array.isArray(tools) ? tools : []).find((tool) => tool.name === name)
  if (found === undefined) return undefined
  return {
    name: found.name,
    server: found.server,
    tool: found.tool,
    description: found.description,
    parameters: found.parameters,
  }
}

/**
 * 解析 `select:<name>[,<name>...]` 形态的查询（`mcp_search` 的确定性取用入口）。
 *
 * 模型已经知道名字时，任何排序都是额外的不确定性，所以选择形态完全不参与打分。
 * 前缀不区分大小写，名字之间用逗号分隔。
 *
 * @param {unknown} query - 模型给的原始查询。
 * @returns {string[] | undefined} 名字列表（可能为空数组 = 写了 `select:` 却没给名字）；非该形态返回 undefined。
 */
export function parseSelectQuery(query) {
  if (typeof query !== 'string') return undefined
  const trimmed = query.trim()
  if (trimmed.length < SELECT_PREFIX.length) return undefined
  if (trimmed.slice(0, SELECT_PREFIX.length).toLowerCase() !== SELECT_PREFIX) return undefined
  return trimmed
    .slice(SELECT_PREFIX.length)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
}

/**
 * 把模型写的工具名解析成目录里的条目（`mcp_describe` / `select:` / 精确名置顶共用）。
 *
 * 接受三种写法，全部要求「解析结果真在目录里」：
 *   - 完整名：`mcp__github-local__search_issues`（或漏写前缀的 `github-local__search_issues`）；
 *   - 裸 tool 名：`search_issues`（同一名字在多台服务器都有时**全部返回**）；
 *   - 拼名：`github-local.search_issues` / `github-local search_issues` / `mcp.github-local.search_issues`
 *     （只按 `.` 与空白拆分，`_` 是合法工具名字符，不能当分隔符）。
 *
 * @param {Array} tools - `collectMcpTools()` 的输出。
 * @param {unknown} requested - 单个名字或名字数组。
 * @returns {{ entries: { request: string, matches: Array }[], missing: string[] }}
 *   `entries` 保持请求顺序（每条含该请求的全部命中），`missing` 收无法解析的请求原文。
 */
export function resolveMcpNames(tools, requested) {
  const catalogTools = Array.isArray(tools) ? tools : []
  const requests = normalizeNameRequests(requested)
  const entries = []
  const missing = []
  for (const request of requests) {
    const matches = resolveOneName(catalogTools, request)
    entries.push({ request, matches })
    if (matches.length === 0) missing.push(request)
  }
  return { entries, missing }
}

/**
 * 按 MCP 服务器聚合成目录（`mcp_catalog`）：一台服务器一行。
 *
 * 每条包含完整 `count`、最多 `MAX_CATALOG_NAMES` 个工具短名（`tools`）与同样截断的
 * 展示摘要（`summary`，超出部分写成 `+N more`）。按 server 名升序，保证可复现。
 *
 * @param {Array} tools - `collectMcpTools()` 的输出（非 `mcp__*` 条目已被过滤）。
 * @returns {{ servers: { server: string, count: number, tools: string[], summary: string }[], total: number }}
 */
export function catalog(tools) {
  const byServer = new Map()
  for (const tool of Array.isArray(tools) ? tools : []) {
    const names = byServer.get(tool.server)
    if (names === undefined) byServer.set(tool.server, [tool.tool])
    else names.push(tool.tool)
  }
  const servers = []
  for (const [server, names] of byServer) {
    servers.push({
      server,
      count: names.length,
      tools: names.slice(0, MAX_CATALOG_NAMES),
      summary: summarizeToolNames(names),
    })
  }
  servers.sort((left, right) => compareNames(left.server, right.server))
  return { servers, total: servers.reduce((sum, row) => sum + row.count, 0) }
}

/**
 * 把描述压成单行摘要，最多 `MAX_SUMMARY_CHARS` 个字符（含省略号）。
 *
 * @param {unknown} description - 工具描述。
 * @returns {string} 单行、已去多余空白的摘要。
 */
export function summarize(description) {
  const collapsed = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : ''
  const chars = Array.from(collapsed)
  if (chars.length <= MAX_SUMMARY_CHARS) return collapsed
  return chars.slice(0, MAX_SUMMARY_CHARS - 1).join('') + '…'
}

/**
 * 把 limit 约束到 1–`MAX_LIMIT`；未提供/非法数字走默认值。
 *
 * @param {unknown} value - 模型给的 limit。
 * @returns {number} 合法条数。
 */
export function clampLimit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LIMIT
  const truncated = Math.trunc(value)
  if (truncated < 1) return 1
  if (truncated > MAX_LIMIT) return MAX_LIMIT
  return truncated
}

/** 把单个名字或名字数组规整成非空字符串列表（保持顺序、忽略非字符串与非空校验失败项）。 */
function normalizeNameRequests(requested) {
  const raw = Array.isArray(requested) ? requested : [requested]
  const requests = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed.length > 0) requests.push(trimmed)
  }
  return requests
}

/**
 * 解析单个请求：完整名 → 拼名候选 → 裸 tool 名，逐级匹配、按目录顺序去重。
 * 任何一级都只做「相等」比较，不做前缀/模糊匹配，因此未命中就是未命中。
 */
function resolveOneName(tools, request) {
  const lower = request.toLowerCase()
  const matches = []
  const seen = new Set()
  const push = (tool) => {
    if (seen.has(tool.name)) return
    seen.add(tool.name)
    matches.push(tool)
  }
  for (const tool of tools) {
    if (tool.name.toLowerCase() === lower) push(tool)
  }
  for (const candidate of joinCandidates(request)) {
    const candidateLower = candidate.toLowerCase()
    for (const tool of tools) {
      if (tool.name.toLowerCase() === candidateLower) push(tool)
    }
  }
  for (const tool of tools) {
    if (tool.tool.toLowerCase() === lower) push(tool)
  }
  return matches
}

/** 生成「拼回 `mcp__<server>__<tool>`」的候选名（只按 `.` 与空白拆分）。 */
function joinCandidates(request) {
  const candidates = []
  if (!request.toLowerCase().startsWith(MCP_PREFIX)) candidates.push(MCP_PREFIX + request)
  const parts = request.split(/[.\s]+/).filter((part) => part.length > 0)
  if (parts.length >= 2) {
    candidates.push(MCP_PREFIX + parts.join('__'))
    // `mcp.server.tool`：第一段是前缀写法，去掉后再拼
    if (parts[0].toLowerCase() === 'mcp' && parts.length >= 3) {
      candidates.push(MCP_PREFIX + parts.slice(1).join('__'))
    }
  }
  return candidates
}

/** 参数名文本（顶层 properties + required），供打分做子串命中。 */
function parameterText(parameters) {
  if (!isPlainObject(parameters)) return ''
  const parts = []
  if (isPlainObject(parameters.properties)) {
    for (const key of Object.keys(parameters.properties)) parts.push(key.toLowerCase())
  }
  if (Array.isArray(parameters.required)) {
    for (const key of parameters.required) {
      if (typeof key === 'string') parts.push(key.toLowerCase())
    }
  }
  return parts.join(' ')
}

/** 一台服务器的展示摘要：短名用逗号拼接，超出 `MAX_CATALOG_NAMES` 时标注剩余数量。 */
function summarizeToolNames(names) {
  const shown = names.slice(0, MAX_CATALOG_NAMES)
  const more = names.length - shown.length
  const text = shown.join(', ')
  return more > 0 ? `${text} … (+${more} more)` : text
}

/** compact 结果行（`mcp_search` 的 canonical 形状）。`exact` 标记「按名字取到」而不靠分数哨兵。 */
function toolRow(tool, score, exact) {
  return {
    name: tool.name,
    server: tool.server,
    tool: tool.tool,
    summary: summarize(tool.description),
    score,
    exact,
  }
}

/** 去重并保持首次出现顺序（missing 报告用）。 */
function uniqueStrings(values) {
  const result = []
  const seen = new Set()
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/** 中文/日文/韩文字符判定（用于 bigram 分词）。 */
function isCjk(ch) {
  const codePoint = ch.codePointAt(0)
  return (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x3040 && codePoint <= 0x30ff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
}

/** 普通 JSON 对象判定（排除 null / 数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && Array.isArray(value) === false
}

/** 稳定的工具名比较（同分排序用）。 */
function compareNames(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}
