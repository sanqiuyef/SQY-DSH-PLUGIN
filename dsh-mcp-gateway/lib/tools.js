/**
 * dsh-mcp-gateway — 三个只读元工具的注册定义（P0-a）。
 *
 * 为什么用「裸 ToolDefinition + 标准 JSON Schema」而不是 `defineTool`：
 *   1. 本插件不依赖 `@deepseek-ai/dsh-tools`（package.json 只声明 cordis peer），
 *      宿主 `ToolRuntime.register()` 接受裸定义，并只强制校验 `output { schema, render }`
 *      （`app.asar/@deepseek-ai/dsh-tools/lib/index.js:2974-2983`）；
 *   2. `defineTool` 的 `parameters` / `output.schema` 是另一套 author DSL（编译为 JSON Schema，
 *      `dsh-tools/lib/index.js:792-811,838-871`），而任务契约要求直接写标准 JSON Schema；
 *   3. 裸定义不做参数自动校验，因此三个工具都在 `execute` 里显式校验（缺参/类型错 → 抛错，
 *      宿主会把抛错 materialize 成普通 isError 工具结果，不结束回合）。
 *
 * P0-a 边界：**只读、无副作用、不隐藏任何原始工具、不注册 mcp_call**。
 * P0-b 的隐藏/派发预留说明见 lib/index.js 末尾注释。
 */

import {
  DEFAULT_LIMIT,
  MAX_CATALOG_NAMES,
  MAX_LIMIT,
  catalog,
  clampLimit,
  parseSelectQuery,
  resolveMcpNames,
  search,
} from './indexer.js'

/** `mcp_search` 的模型面参数 schema（标准 JSON Schema）。 */
const SEARCH_PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Keywords describing the capability you need, English or Chinese. Example: "github pull request", "excel 表格", "语音 转写". Use "select:<name>[,<name>...]" (e.g. "select:mcp__github-local__search_issues") when you already know the exact tool name(s).',
    },
    server: {
      type: 'string',
      description: 'Optional MCP serverName to restrict the search, e.g. "github-local" or "code-review-graph". Ignored by select: queries.',
    },
    limit: {
      type: 'number',
      description: `Optional maximum number of results (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT}). Ignored by select: queries.`,
    },
  },
  required: ['query'],
  additionalProperties: false,
}

/** `mcp_search` 的 canonical 输出 schema：只回名字 + 一行摘要，省 token。 */
const SEARCH_OUTPUT = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact tool name, e.g. mcp__github-local__search_issues.' },
          server: { type: 'string' },
          tool: { type: 'string', description: 'Tool name without the server namespace.' },
          summary: { type: 'string', description: 'One-line description, at most 160 characters.' },
          score: { type: 'number', description: 'Relevance score for keyword matches (unbounded, higher is better). 0 for select: rows.' },
          exact: { type: 'boolean', description: 'true when the row was requested by exact name (select: or the whole query is a tool name); score is not meaningful for these rows.' },
        },
        required: ['name', 'server', 'tool', 'summary', 'score', 'exact'],
        additionalProperties: false,
      },
    },
    total: { type: 'number', description: 'Total matches before truncating to `limit`.' },
    missing: {
      type: 'array',
      items: { type: 'string' },
      description: 'select: only — requested names that are not in the catalog (nothing is dropped silently).',
    },
  },
  required: ['results', 'total'],
  additionalProperties: false,
}

/** `mcp_describe` 的模型面参数 schema：单个 `name` 或批量 `names`。 */
const DESCRIBE_PARAMETERS = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: 'Tool name. Accepts the exact name returned by mcp_search ("mcp__github-local__search_issues"), a bare tool name ("search_issues"), or "server.tool" ("github-local.search_issues").',
    },
    names: {
      type: 'array',
      items: { type: 'string' },
      description: 'Describe several tools in one call. Uses the same accepted forms as `name`; unresolved names are returned in `missing`.',
    },
  },
  required: [],
  additionalProperties: false,
}

/** `mcp_describe` 单个工具的 canonical 形状（0.1.0 兼容：只传 `name` 且唯一命中时原样返回）。 */
const DESCRIBE_SINGLE_OUTPUT = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    server: { type: 'string' },
    tool: { type: 'string' },
    description: { type: 'string' },
    parameters: { type: 'object', additionalProperties: true, description: 'Complete JSON parameter schema of the tool.' },
  },
  required: ['name', 'server', 'tool', 'description', 'parameters'],
  additionalProperties: false,
}

/**
 * `mcp_describe` 的 canonical 输出 schema：两种形状用 oneOf 表达。
 * 单工具（旧形状）保证 0.1.0 的调用方/提示词不改也能读 `.parameters`；
 * `names` 批量或裸名歧义时返回 `{ tools, missing }`。
 */
const DESCRIBE_OUTPUT = {
  oneOf: [
    DESCRIBE_SINGLE_OUTPUT,
    {
      type: 'object',
      properties: {
        tools: { type: 'array', items: DESCRIBE_SINGLE_OUTPUT, description: 'Described tools in request order (one per resolved name).' },
        missing: { type: 'array', items: { type: 'string' }, description: 'Requested names that did not resolve (they are reported, not dropped).' },
      },
      required: ['tools', 'missing'],
      additionalProperties: false,
    },
  ],
}

/** `mcp_catalog` 的模型面参数 schema：零参数。 */
const CATALOG_PARAMETERS = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
}

/** `mcp_catalog` 的 canonical 输出 schema：一台服务器一行。 */
const CATALOG_OUTPUT = {
  type: 'object',
  properties: {
    servers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'MCP serverName as it appears in mcp__<server>__<tool>.' },
          count: { type: 'number', description: 'Number of tools this server provides.' },
          tools: { type: 'array', items: { type: 'string' }, description: `Up to ${MAX_CATALOG_NAMES} tool names without the namespace.` },
          summary: { type: 'string', description: 'One-line summary built from the tool names; omitted names are counted as "+N more".' },
        },
        required: ['server', 'count', 'tools', 'summary'],
        additionalProperties: false,
      },
    },
    total: { type: 'number', description: 'Total MCP tools across all servers.' },
  },
  required: ['servers', 'total'],
  additionalProperties: false,
}

/**
 * 构造 `mcp_search` 定义。
 *
 * @param {(exec: { agent?: unknown }) => Array} getTools - 每次执行时实时取当前可见 MCP 工具。
 * @returns {object} 可交给 `ctx.tools.register()` 的 ToolDefinition。
 */
export function createSearchTool(getTools) {
  return {
    name: 'mcp_search',
    description: [
      'Search the MCP tool catalog of this deployment (external servers such as github-local, mcp-office-writer, playwright, codegraph, obsidian-cli, lancedb-search).',
      'Call it when the task may need an external capability: it returns compact matches (exact tool name, server, one-line summary, score) WITHOUT spending tokens on every parameter schema.',
      'Query may be keywords, or "select:<exact name>[,<exact name>...]" to fetch known tools without ranking.',
      'Read-only: it never invokes an MCP tool. Workflow: mcp_catalog for the server overview, mcp_search -> mcp_describe for the parameter schema -> call that MCP tool by its exact name.',
    ].join(' '),
    parameters: SEARCH_PARAMETERS,
    output: {
      schema: SEARCH_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderSearchText(value) }],
    },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const query = requireNonEmptyString(args, 'query', 'mcp_search')
      const select = parseSelectQuery(query)
      if (select !== undefined && select.length === 0) {
        throw new Error('mcp_search: "select:" needs at least one tool name, e.g. "select:mcp__github-local__search_issues".')
      }
      const server = optionalString(args, 'server', 'mcp_search')
      const limit = optionalLimit(args, 'limit', 'mcp_search')
      return search(getTools(exec), query, { server, limit })
    },
  }
}

/**
 * 构造 `mcp_describe` 定义。
 *
 * @param {(exec: { agent?: unknown }) => Array} getTools - 每次执行时实时取当前可见 MCP 工具。
 * @returns {object} 可交给 `ctx.tools.register()` 的 ToolDefinition。
 */
export function createDescribeTool(getTools) {
  return {
    name: 'mcp_describe',
    description: [
      'Return the full description and JSON parameter schema of one or more MCP tools.',
      'Accepts the exact name returned by mcp_search ("mcp__github-local__search_issues"), a bare tool name ("search_issues"), or "server.tool" ("github-local.search_issues"); pass `names` to describe several at once.',
      'A single `name` that resolves to one tool returns its schema directly; `names` (or an ambiguous bare name) returns { tools, missing }.',
      'Call it before invoking an MCP tool whose arguments you do not know. Read-only: it describes tools, it does not call them.',
      'If none of the names resolve it returns a self-healing error telling you to run mcp_search again.',
    ].join(' '),
    parameters: DESCRIBE_PARAMETERS,
    output: {
      schema: DESCRIBE_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderDescribeText(value) }],
    },
    isConcurrencySafe: () => true,
    execute(args, exec) {
      const requests = requestedNames(args, 'mcp_describe')
      const { entries, missing } = resolveMcpNames(getTools(exec), requests)
      const tools = []
      const seen = new Set()
      for (const entry of entries) {
        for (const tool of entry.matches) {
          if (seen.has(tool.name)) continue
          seen.add(tool.name)
          tools.push({
            name: tool.name,
            server: tool.server,
            tool: tool.tool,
            description: tool.description,
            parameters: tool.parameters,
          })
        }
      }
      if (tools.length === 0) {
        // 可自愈错误：说明没调用任何工具，并给出下一步动作。
        throw new Error(
          `mcp_describe: no MCP tool named ${requests.map((name) => `"${name}"`).join(', ')}. Nothing was called. `
          + 'Call mcp_search({ query }) to find the exact name (bare names like "search_issues" and "server.tool" also work), '
          + 'or mcp_catalog() to browse the servers. MCP tool names look like mcp__<server>__<tool>.',
        )
      }
      // 契约兼容：只传 `name` 且唯一命中时返回 0.1.0 的单对象形状；
      // `names` 批量（即使只有 1 个）或裸名歧义时返回 { tools, missing }。
      const onlySingleName = args?.names === undefined || args?.names === null
      if (onlySingleName && tools.length === 1) return tools[0]
      return { tools, missing: uniqueStrings(missing) }
    },
  }
}

/**
 * 构造 `mcp_catalog` 定义（零参数：一台服务器一行的可发现性入口）。
 *
 * @param {(exec: { agent?: unknown }) => Array} getTools - 每次执行时实时取当前可见 MCP 工具。
 * @returns {object} 可交给 `ctx.tools.register()` 的 ToolDefinition。
 */
export function createCatalogTool(getTools) {
  return {
    name: 'mcp_catalog',
    description: [
      'List every MCP server available in this deployment with a one-line summary of the tools it provides.',
      'Call it first when you do not know which external capability exists: it is the cheapest overview (one line per server) and far smaller than browsing tool schemas.',
      'Read-only. Follow up with mcp_search({ query }) to find specific tools, or mcp_search({ query: "select:<exact name>" }) to pull one.',
    ].join(' '),
    parameters: CATALOG_PARAMETERS,
    output: {
      schema: CATALOG_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderCatalogText(value) }],
    },
    isConcurrencySafe: () => true,
    execute(_args, exec) {
      return catalog(getTools(exec))
    },
  }
}

/**
 * `mcp_search` 的文本渲染（ContentBlock[]）。
 * 用纯文本而非结构化卡片：元工具的价值是省 token，渲染也保持单段紧凑文本。
 *
 * @param {{ results: Array, total: number, missing?: string[] }} value - canonical 结果。
 * @returns {string} 渲染文本。
 */
export function renderSearchText(value) {
  const results = Array.isArray(value?.results) ? value.results : []
  const missing = Array.isArray(value?.missing) ? value.missing : []
  const total = typeof value?.total === 'number' ? value.total : results.length
  if (results.length === 0 && missing.length === 0) {
    return 'mcp_search: no match. Try fewer/different keywords (English and Chinese both work), or drop the `server` filter. mcp_catalog() lists every server.'
  }
  if (results.length === 0) {
    return `mcp_search: no MCP tool matched ${missing.map((name) => `"${name}"`).join(', ')}. Nothing was called. Use mcp_catalog() or mcp_search({ query }) to find valid names.`
  }
  const lines = [`mcp_search: ${results.length} of ${total} match(es)`]
  for (const [index, row] of results.entries()) {
    const tag = row.exact === true ? 'exact-name' : `score=${row.score}`
    lines.push(`${index + 1}. ${row.name}  [server=${row.server} tool=${row.tool} ${tag}]`)
    lines.push(`   ${row.summary}`)
  }
  if (missing.length > 0) lines.push(`not found: ${missing.join(', ')}`)
  lines.push('')
  lines.push('Next: mcp_describe({ name }) for the full parameter schema, then call the MCP tool by its exact name.')
  return lines.join('\n')
}

/**
 * `mcp_describe` 的文本渲染：每个工具完整参数 JSON Schema 原样输出。
 * 同时接受 0.1.0 的单对象形状与 `{ tools, missing }` 批量形状。
 *
 * @param {{ name?: string, server?: string, tool?: string, description?: string, parameters?: object, tools?: Array, missing?: string[] }} value
 * @returns {string} 渲染文本。
 */
export function renderDescribeText(value) {
  const tools = Array.isArray(value?.tools)
    ? value.tools
    : (value?.name !== undefined ? [value] : [])
  const missing = Array.isArray(value?.missing) ? value.missing : []
  const lines = []
  if (tools.length === 0) lines.push('mcp_describe: no MCP tool matched.')
  for (const [index, tool] of tools.entries()) {
    if (index > 0) lines.push('')
    const description = typeof tool?.description === 'string' && tool.description.length > 0
      ? tool.description
      : '(no description provided by the MCP server)'
    lines.push(`mcp_describe: ${tool?.name}`)
    lines.push(`server: ${tool?.server}   tool: ${tool?.tool}`)
    lines.push('')
    lines.push(description)
    lines.push('')
    lines.push('parameters (JSON Schema):')
    lines.push(JSON.stringify(tool?.parameters ?? { type: 'object', properties: {} }, null, 2))
  }
  if (missing.length > 0) {
    lines.push('')
    lines.push(`not found: ${missing.join(', ')}. Run mcp_search({ query }) to find the exact name.`)
  }
  return lines.join('\n')
}

/**
 * `mcp_catalog` 的文本渲染：标题行 + 每台服务器一行。
 *
 * @param {{ servers: Array<{ server: string, count: number, tools: string[], summary: string }>, total: number }} value
 * @returns {string} 渲染文本。
 */
export function renderCatalogText(value) {
  const servers = Array.isArray(value?.servers) ? value.servers : []
  const total = typeof value?.total === 'number'
    ? value.total
    : servers.reduce((sum, row) => sum + (typeof row?.count === 'number' ? row.count : 0), 0)
  if (servers.length === 0) {
    return 'mcp_catalog: no MCP servers are registered in this deployment right now. Use the native tools instead.'
  }
  const lines = [`mcp_catalog: ${servers.length} server(s), ${total} MCP tool(s)`]
  for (const row of servers) {
    lines.push(`- ${row.server} (${row.count} tool${row.count === 1 ? '' : 's'}): ${row.summary}`)
  }
  lines.push('')
  lines.push('Next: mcp_search({ query }) to find matching tools (add server:"<name>" to narrow); mcp_describe({ name }) for a tool\'s parameter schema.')
  return lines.join('\n')
}

/** 必填非空字符串参数校验（抛错 → 宿主 materialize 为 isError 结果）。 */
function requireNonEmptyString(args, key, toolName) {
  const value = args?.[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${toolName}: "${key}" is required and must be a non-empty string.`)
  }
  return value.trim()
}

/** 可选字符串参数校验；空串视为未提供。 */
function optionalString(args, key, toolName) {
  const value = args?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${toolName}: "${key}" must be a string when provided.`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 可选 limit 校验 + 约束到 1–50。 */
function optionalLimit(args, key, toolName) {
  const value = args?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${toolName}: "${key}" must be a finite number when provided.`)
  }
  return clampLimit(value)
}

/** `mcp_describe` 的名字参数：`name` 与 `names` 合并，至少一个非空。 */
function requestedNames(args, toolName) {
  const requests = []
  const single = args?.name
  if (single !== undefined && single !== null) {
    if (typeof single !== 'string') throw new Error(`${toolName}: "name" must be a string when provided.`)
    if (single.trim() !== '') requests.push(single.trim())
  }
  const many = args?.names
  if (many !== undefined && many !== null) {
    if (!Array.isArray(many)) throw new Error(`${toolName}: "names" must be an array of strings when provided.`)
    for (const item of many) {
      if (typeof item !== 'string') throw new Error(`${toolName}: "names" must contain only strings.`)
      if (item.trim() !== '') requests.push(item.trim())
    }
  }
  if (requests.length === 0) {
    throw new Error(`${toolName}: pass "name" or "names" with at least one non-empty tool name; both were empty.`)
  }
  return requests
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
