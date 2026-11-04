/**
 * dsh-tool-search-mode — pure catalog helpers.
 *
 * The model-visible tool table is split into an eager set (core tools, bridge
 * tools, and tools already loaded in this session) and a deferred set. The
 * deferred set is only listed by name/description in a runtime-context
 * manifest; its full schemas are returned by `tool_search` on demand.
 *
 * Everything here is pure so `scripts/smoke.mjs` can exercise it without a
 * host. Tool schemas use the DSH `ToolSchema` shape: `{ name, description,
 * parameters, deferLoading? }`.
 */

/** Bridge tools registered by this plugin and always kept eager. */
export const BRIDGE_TOOL_NAMES = Object.freeze(['tool_search', 'tool_call'])

/** Runtime-context name carrying the deferred catalog manifest. */
export const MANIFEST_CONTEXT = 'tool-search-mode:catalog'

/**
 * Default always-eager tools: the same essentials ZCode keeps loaded
 * (file/shell/skill/ask/todo). Everything else — web, MCP, jobs, team,
 * schedule, session search, goal, lsp — is deferred.
 */
export const DEFAULT_CORE_TOOLS = Object.freeze([
  'read',
  'write',
  'edit',
  'apply_patch',
  'glob',
  'grep',
  'bash',
  'pwsh',
  'skill',
  'todo_write',
  'ask_user_question',
  'working_directory',
])

/** Rough token estimate that works for mixed Chinese/English text. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? '').length / 3)
}

/** Collapse whitespace and cap one description line. */
export function oneLine(value, max = 100) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Lowercase, trim, and dedupe query tokens. */
export function tokenize(query) {
  const seen = new Set()
  const tokens = []
  for (const token of String(query ?? '').toLowerCase().split(/\s+/)) {
    const value = token.trim()
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    tokens.push(value)
  }
  return tokens
}

/**
 * Parse a `select:` query into exact tool names.
 * @param {string} query
 * @returns {string[] | null} names, or null when this is a keyword query.
 */
export function parseSelect(query) {
  const text = String(query ?? '').trim()
  if (!/^select:/i.test(text)) return null
  const names = text
    .slice('select:'.length)
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '')
  return names.length > 0 ? names : null
}

/**
 * Split a catalog into eager and deferred entries.
 * @param {readonly object[]} tools - model-visible schemas.
 * @param {ReadonlySet<string>} eagerNames - core + bridge + warmed names.
 * @returns {{eager: object[], deferred: object[]}}
 */
export function splitCatalog(tools, eagerNames) {
  const eager = []
  const deferred = []
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string') continue
    if (eagerNames.has(tool.name)) eager.push(tool)
    else deferred.push(tool)
  }
  return { eager, deferred }
}

/** The manifest group of one tool: `MCP · <server>` or `Other`. */
export function groupOf(name) {
  const match = /^mcp__([^_].*?)__/.exec(name)
  return match === null ? 'Other' : `MCP · ${match[1]}`
}

/** Group deferred tools by their manifest group, preserving catalog order. */
export function groupTools(deferred) {
  const groups = new Map()
  for (const tool of deferred) {
    const group = groupOf(tool.name)
    const list = groups.get(group)
    if (list === undefined) groups.set(group, [tool])
    else list.push(tool)
  }
  return groups
}

function fullListing(groups) {
  const blocks = []
  for (const [group, tools] of groups) {
    blocks.push(`### ${group} (${tools.length})`)
    for (const tool of tools) blocks.push(`- ${tool.name} — ${oneLine(tool.description)}`)
    blocks.push('')
  }
  return blocks.join('\n').trim()
}

function namesListing(groups) {
  const blocks = []
  for (const [group, tools] of groups) {
    blocks.push(`### ${group} (${tools.length})`)
    blocks.push(tools.map(tool => `- ${tool.name}`).join('\n'))
    blocks.push('')
  }
  return blocks.join('\n').trim()
}

function summaryListing(groups) {
  const lines = []
  for (const [group, tools] of groups) lines.push(`- ${group}: ${tools.length} tools`)
  return lines.join('\n')
}

const MANIFEST_HEADER =
  'Deferred tool catalog — these tools are NOT in your tool list. '
  + 'Call tool_search to load one (its full schema is returned), then call it directly on the next turn '
  + 'or immediately via tool_call. Use select:<name>[,<name>...] for exact names, or space-separated keywords.'

/**
 * Render the deferred catalog manifest under a token budget.
 * Tiers: full (name — description) → names only → group counts.
 * @param {readonly object[]} deferred
 * @param {{maxTokens?: number}} [options]
 * @returns {string} manifest text, or '' when nothing is deferred.
 */
export function renderManifest(deferred, options = {}) {
  if (!Array.isArray(deferred) || deferred.length === 0) return ''
  const maxTokens = Number.isFinite(options.maxTokens) && options.maxTokens > 0 ? options.maxTokens : 4000
  const groups = groupTools(deferred)
  const candidates = [fullListing(groups), namesListing(groups), summaryListing(groups)]
  for (const body of candidates) {
    const text = `${MANIFEST_HEADER}\n\n${body}`
    if (estimateTokens(text) <= maxTokens) return text
  }
  return `${MANIFEST_HEADER}\n\n${candidates[candidates.length - 1]}`
}

/**
 * Score one tool against a keyword query.
 * Exact name > name substring > name tokens > description tokens.
 */
export function scoreTool(tool, query, tokens) {
  const name = tool.name.toLowerCase()
  const description = String(tool.description ?? '').toLowerCase()
  let score = 0
  if (name === query) score += 1000
  else if (name.includes(query)) score += 300
  for (const token of tokens) {
    if (name === token) score += 200
    else if (name.includes(token)) score += 60
    if (description.includes(token)) score += 12
  }
  return score
}

/**
 * Search the deferred catalog.
 * @param {string} query - keywords or `select:a,b`.
 * @param {readonly object[]} deferred
 * @param {{limit?: number, maxLimit?: number}} [options]
 * @returns {{matches: object[], totalDeferred: number}}
 */
export function searchCatalog(query, deferred, options = {}) {
  const list = Array.isArray(deferred) ? deferred.filter(tool => tool && typeof tool.name === 'string') : []
  const maxLimit = Number.isFinite(options.maxLimit) && options.maxLimit > 0 ? Math.trunc(options.maxLimit) : 20
  const requested = Number.isFinite(options.limit) && options.limit > 0 ? Math.trunc(options.limit) : 5
  const limit = Math.min(requested, maxLimit)
  const selected = parseSelect(query)
  if (selected !== null) {
    const byName = new Map(list.map(tool => [tool.name.toLowerCase(), tool]))
    const matches = []
    for (const name of selected) {
      const tool = byName.get(name.toLowerCase())
      if (tool !== undefined && !matches.includes(tool)) matches.push(tool)
    }
    return { matches, totalDeferred: list.length }
  }
  const tokens = tokenize(query)
  if (tokens.length === 0) return { matches: [], totalDeferred: list.length }
  const normalized = String(query).trim().toLowerCase()
  const scored = list
    .map(tool => ({ tool, score: scoreTool(tool, normalized, tokens) }))
    .filter(hit => hit.score > 0)
    .sort((left, right) => right.score - left.score || (left.tool.name < right.tool.name ? -1 : left.tool.name > right.tool.name ? 1 : 0))
  return { matches: scored.slice(0, limit).map(hit => hit.tool), totalDeferred: list.length }
}
