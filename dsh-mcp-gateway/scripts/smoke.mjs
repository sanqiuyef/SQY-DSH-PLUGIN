/**
 * dsh-mcp-gateway — 离线自检（不连接宿主、不读 asar、不碰 profile）。
 *
 * 用法：D:\nodejs\node.exe scripts/smoke.mjs   （退出码 0 = 全绿）
 *
 * 覆盖：
 *   A. `parseMcpToolName` 解析规则（server 含 `-` / `_` / 双下划线，非法命名）
 *   B. 分词（英文按词、中文 bigram、去重）与摘要截断（≤160，含省略号）
 *   C. `collectMcpTools`：只取 `mcp__*`、非 MCP/保留名被跳过、缺省 schema 兜底
 *   D. 打分与排序：字段权重、参数名进索引、整串短语加成、同分按 name 升序、0 分过滤
 *   E. `search`：默认/越界 limit、server 过滤、total 语义、空查询、无命中、
 *      `select:` 精确取用、整串名字确定性置顶
 *   F. `describe` 与 `resolveMcpNames`：精确名、裸名、点号/空格拼名、歧义多命中、拼不回
 *   G. 三个 ToolDefinition：名称、标准 JSON Schema 子集、required、output.render、并发安全
 *   H. `execute`：返回结构、摘要长度、describe 批量/可自愈错误、参数校验
 *   I. `apply(fakeCtx)`：注册 3 个工具、不注册 mcp_call、不监听 system-prompt/assemble（P0-a 不隐藏）、
 *      ctx.effect 清理后全部注销
 *   J. `mcp_catalog`：按服务器分组、计数、摘要截断、空目录、非 mcp__ 过滤
 */

import assert from 'node:assert/strict'

import {
  DEFAULT_LIMIT,
  MAX_CATALOG_NAMES,
  MAX_LIMIT,
  MAX_SUMMARY_CHARS,
  MCP_PREFIX,
  catalog,
  clampLimit,
  collectMcpTools,
  describe,
  parseMcpToolName,
  parseSelectQuery,
  resolveMcpNames,
  scoreTool,
  search,
  summarize,
  tokenize,
} from '../lib/indexer.js'
import {
  createCatalogTool,
  createDescribeTool,
  createSearchTool,
  renderCatalogText,
  renderDescribeText,
  renderSearchText,
} from '../lib/tools.js'
import { apply, inject, name as pluginName } from '../lib/index.js'

// ---------------------------------------------------------------------------
// 测试脚手架：一条断言计 1 条，失败立刻抛出并打印所在 section。
// ---------------------------------------------------------------------------
let checks = 0
let sections = 0
let section = ''
const failures = []

function begin(title) {
  section = title
  process.stdout.write(`\n${title}\n`)
}

/** 计 1 条断言并执行（condition 为真即通过）。 */
function ok(condition, message) {
  checks++
  if (!condition) throw new Error(`${section}: ${message}`)
}

/** 计 1 条断言并做严格深比较。 */
function eq(actual, expected, message) {
  checks++
  assert.deepEqual(actual, expected, `${section}: ${message}`)
}

/** 计 1 条断言：函数必须抛错且信息匹配。 */
function throws(fn, pattern, message) {
  checks++
  assert.throws(fn, pattern, `${section}: ${message}`)
}

/** 包一个 section，捕获失败但保留后续 section 继续跑。 */
function run(title, fn) {
  sections++
  begin(title)
  try {
    fn()
    process.stdout.write('  ✓ ok\n')
  } catch (error) {
    process.stdout.write(`  ✗ ${error.message}\n`)
    failures.push(error.message)
  }
}

// ---------------------------------------------------------------------------
// 固定测试数据（模拟 11 台服务器里的几台，含带 `-` / `_` 的 server 名）
// ---------------------------------------------------------------------------
const LONG_DESCRIPTION = 'Create a Word document from markdown. '.repeat(12).trim() // > 160 chars

const SCHEMAS = [
  {
    name: 'mcp__github-local__search_issues',
    description: 'Search GitHub issues by keyword across repositories. GitHub issue search.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'mcp__github-local__create_issue',
    description: 'Create a GitHub issue in a repository.',
    parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
  },
  {
    name: 'mcp__code-review-graph__list_commits',
    description: 'List commits from the review graph.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mcp__a_b__c',
    description: 'Fixture tool on a serverName containing an underscore.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mcp__mcp-office-writer__create_word_document',
    description: LONG_DESCRIPTION,
    parameters: { type: 'object', properties: { markdown: { type: 'string' } }, required: ['markdown'], additionalProperties: false },
  },
  {
    name: 'mcp__mcp-office-writer__create_excel_workbook',
    description: 'Create an Excel workbook. 创建 Excel 工作簿并写入表格数据。',
    parameters: { type: 'object', properties: { sheets: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['sheets'], additionalProperties: false },
  },
  { name: 'read_file', description: 'Not an MCP tool.' },
  { name: 'run_code', description: 'Reserved PTC transport, not an MCP tool.' },
]

/** 同一个裸 tool 名出现在两台服务器上（歧义解析用）。 */
const AMBIGUOUS_SCHEMAS = [
  { name: 'mcp__github-local__get', description: 'Read one GitHub object.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'mcp__gitlab__get', description: 'Read one GitLab object.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'mcp__github-local__get_issue', description: 'Read one GitHub issue.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
]

// ---------------------------------------------------------------------------
// A. 名称解析：第一个 `mcp__` 之后、最后一个 `__` 之前 = server
// ---------------------------------------------------------------------------
run('A. parseMcpToolName', () => {
  eq(parseMcpToolName('mcp__github-local__search_issues'), { name: 'mcp__github-local__search_issues', server: 'github-local', tool: 'search_issues' }, 'hyphen serverName')
  eq(parseMcpToolName('mcp__a_b__c'), { name: 'mcp__a_b__c', server: 'a_b', tool: 'c' }, 'underscore serverName')
  eq(parseMcpToolName('mcp__code-review-graph__list_commits'), { name: 'mcp__code-review-graph__list_commits', server: 'code-review-graph', tool: 'list_commits' }, 'hyphenated server with long tool name')
  // 双下划线歧义：按「最后一个 __」切，server 保留内部 `__`
  eq(parseMcpToolName('mcp__a__b__c'), { name: 'mcp__a__b__c', server: 'a__b', tool: 'c' }, 'ambiguous double underscore takes the LAST separator')
  // tool 自身带 `__` 时，同样按最后一个 `__` 切（文档化行为）
  eq(parseMcpToolName('mcp__srv__tool__part'), { name: 'mcp__srv__tool__part', server: 'srv__tool', tool: 'part' }, 'tool containing __ documented behavior')
  ok(parseMcpToolName('mcp__codegraph') === undefined, 'server without a tool separator is invalid')
  ok(parseMcpToolName('mcp__srv__') === undefined, 'empty tool name is invalid')
  ok(parseMcpToolName('mcp____x') === undefined, 'empty server name is invalid')
  ok(parseMcpToolName('read_file') === undefined, 'non-mcp name is invalid')
  ok(parseMcpToolName('') === undefined, 'empty name is invalid')
  ok(parseMcpToolName(undefined) === undefined, 'non-string is invalid')
  ok(parseMcpToolName(null) === undefined, 'null is invalid')
  ok(parseMcpToolName('mcp__srv__t').server === 'srv', 'MCP_PREFIX constant matches parser')
  ok(MCP_PREFIX === 'mcp__', 'prefix constant')
})

// ---------------------------------------------------------------------------
// B. 分词与摘要
// ---------------------------------------------------------------------------
run('B. tokenize / summarize', () => {
  eq(tokenize('GitHub Issue Search'), ['github', 'issue', 'search'], 'english words lowercased')
  eq(tokenize('读取 Excel 表格'), ['读取', 'excel', '表格'], 'cjk bigrams + english token')
  eq(tokenize('语音 转写'), ['语音', '转写'], 'cjk bigrams per run')
  eq(tokenize('单个'), ['单个'], 'two-char cjk run yields one bigram')
  eq(tokenize('字'), ['字'], 'single cjk char yields itself')
  eq(tokenize('github github github'), ['github'], 'deduplicated')
  eq(tokenize('mcp__a_b__c'), ['mcp'], 'separators split identifiers; single-letter tokens dropped')
  eq(tokenize('mcp__ab_cd'), ['mcp', 'ab', 'cd'], 'multi-letter segments survive splitting')
  eq(tokenize('a b 1'), [], 'single-character ascii tokens are noise and dropped')
  eq(tokenize(''), [], 'empty text')
  eq(tokenize(null), [], 'non-string text')

  eq(summarize('  a   b\n c  '), 'a b c', 'whitespace collapsed')
  eq(summarize('short'), 'short', 'short description untouched')
  eq(Array.from(summarize(LONG_DESCRIPTION)).length, MAX_SUMMARY_CHARS, 'long description truncated to MAX_SUMMARY_CHARS')
  ok(summarize(LONG_DESCRIPTION).endsWith('…'), 'truncated summary ends with an ellipsis')
  eq(Array.from(summarize('中'.repeat(200))).length, MAX_SUMMARY_CHARS, 'cjk truncation counts code points')
  eq(summarize(undefined), '', 'undefined description becomes empty string')
})

// ---------------------------------------------------------------------------
// C. 收集
// ---------------------------------------------------------------------------
run('C. collectMcpTools', () => {
  const fakeCtx = { tools: { schemas: () => SCHEMAS } }
  const tools = collectMcpTools(fakeCtx)
  eq(tools.length, 6, 'only mcp__* entries are collected (non-mcp / run_code skipped)')
  eq(tools[0], {
    name: 'mcp__github-local__search_issues',
    server: 'github-local',
    tool: 'search_issues',
    description: 'Search GitHub issues by keyword across repositories. GitHub issue search.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  }, 'entry keeps live description and parameter schema')
  eq(tools.find((tool) => tool.name === 'mcp__a_b__c').server, 'a_b', 'underscore serverName parsed')
  eq(tools.find((tool) => tool.name === 'mcp__code-review-graph__list_commits').server, 'code-review-graph', 'hyphen serverName parsed')
  eq(collectMcpTools({ tools: { schemas: () => [{ name: 'mcp__x__y' }] } })[0].parameters, { type: 'object', properties: {} }, 'missing parameters fall back to an open object schema')
  eq(collectMcpTools({ tools: { schemas: () => [{ name: 'mcp__x__y', description: 42 }] } })[0].description, '', 'non-string description falls back to empty')
  eq(collectMcpTools({ tools: { schemas: () => [] } }), [], 'empty registry')
  eq(collectMcpTools({}), [], 'ctx without tools service yields empty index')
  eq(collectMcpTools({ tools: { schemas: () => SCHEMAS } }, { agent: {} }).length, 6, 'scope argument is passed through to schemas()')
})

// ---------------------------------------------------------------------------
// D. 打分
// ---------------------------------------------------------------------------
run('D. scoreTool', () => {
  const tools = collectMcpTools({ tools: { schemas: () => SCHEMAS } })
  const github = tools.find((tool) => tool.name === 'mcp__github-local__create_issue')
  const review = tools.find((tool) => tool.name === 'mcp__code-review-graph__list_commits')
  const tokens = tokenize('github')
  ok(scoreTool(github, tokens, 'github') > scoreTool(review, tokens, 'github'), 'github scores higher for a github tool')
  eq(scoreTool(review, tokenize('zzz-no-hit'), 'zzz-no-hit'), 0, 'unrelated query scores 0')
  eq(scoreTool(github, [], 'github'), 0, 'no tokens scores 0')
  // tool 名命中 (6) + 完整名命中 (3) + server 命中 (4) + 整串各加成
  ok(scoreTool(github, ['create'], 'create') > scoreTool(github, ['repository'], 'repository'), 'tool-name hit outranks description-only hit')
  // 参数名进索引：'title' 只出现在 create_issue 的参数 schema 里（描述与名字都没有）
  ok(scoreTool(github, tokenize('title'), 'title') > 0, 'parameter names are indexed')
  ok(scoreTool(github, tokenize('title'), 'title') > scoreTool(review, tokenize('title'), 'title'), 'parameter hit outranks an unrelated tool')
  eq(scoreTool(github, tokenize('zzz-no-hit'), 'zzz-no-hit'), 0, 'parameter indexing does not match unrelated tokens')
  eq(scoreTool({ name: 'mcp__s__t', server: 's', tool: 't', description: '' }, tokenize('title'), 'title'), 0, 'tools without parameters score 0 for param-only queries')
})

// ---------------------------------------------------------------------------
// E. 检索
// ---------------------------------------------------------------------------
run('E. search', () => {
  const all = collectMcpTools({ tools: { schemas: () => SCHEMAS } })

  const github = search(all, 'github')
  eq(github.total, 2, 'two github tools match')
  eq(github.results.map((row) => row.name).sort(), ['mcp__github-local__create_issue', 'mcp__github-local__search_issues'], 'github matches only github tools')
  eq(Object.keys(github.results[0]).sort(), ['exact', 'name', 'score', 'server', 'summary', 'tool'], 'compact row shape')
  ok(Array.from(github.results[0].summary).length <= MAX_SUMMARY_CHARS, 'summary respects the 160-char cap')

  const longRow = search(all, 'markdown').results[0]
  ok(Array.from(longRow.summary).length === MAX_SUMMARY_CHARS && longRow.summary.endsWith('…'), 'long MCP description truncated in search output')

  const limited = search(all, 'github', { limit: 1 })
  eq(limited.results.length, 1, 'limit truncates results')
  eq(limited.total, 2, 'total counts matches before truncation')

  const filtered = search(all, 'github', { server: 'code-review-graph' })
  eq(filtered.total, 0, 'server filter excludes other servers')
  const filteredOk = search(all, 'commits', { server: 'code-review-graph' })
  eq(filteredOk.total, 1, 'server filter keeps its own server')
  eq(search(all, 'github', { server: '  ' }).total, 2, 'blank server filter is ignored')

  eq(search(all, 'excel').results[0].name, 'mcp__mcp-office-writer__create_excel_workbook', 'english query hits excel tool')
  eq(search(all, '表格').results[0].name, 'mcp__mcp-office-writer__create_excel_workbook', 'cjk bigram query hits cjk description')

  eq(search(all, ''), { results: [], total: 0 }, 'empty query returns no results')
  eq(search(all, '   '), { results: [], total: 0 }, 'whitespace query returns no results')
  eq(search(all, 'xyzzyplugh'), { results: [], total: 0 }, 'no match returns empty result set')
  eq(search([], 'github'), { results: [], total: 0 }, 'empty catalog')

  // 同分排序：两条描述完全相同、工具名都不含查询词 → 按 name 升序
  const tieTools = [
    { name: 'mcp__zzz__alpha', server: 'zzz', tool: 'alpha', description: 'tie fixture', parameters: {} },
    { name: 'mcp__aaa__beta', server: 'aaa', tool: 'beta', description: 'tie fixture', parameters: {} },
  ]
  eq(search(tieTools, 'tie', { limit: 5 }).results.map((row) => row.name), ['mcp__aaa__beta', 'mcp__zzz__alpha'], 'equal scores sort by name ascending')

  eq(clampLimit(undefined), DEFAULT_LIMIT, 'default limit')
  eq(clampLimit(0), 1, 'limit floor is 1')
  eq(clampLimit(60), MAX_LIMIT, 'limit ceiling is 50')
  eq(clampLimit(3.9), 3, 'limit truncated')
  eq(clampLimit(Number.NaN), DEFAULT_LIMIT, 'NaN falls back to default')
  eq(clampLimit('7'), DEFAULT_LIMIT, 'non-number falls back to default')

  // 参数名进索引：'title' 只在 create_issue 的参数里
  eq(search(all, 'title').results[0].name, 'mcp__github-local__create_issue', 'parameter-only keyword still finds the tool')

  // 整串查询恰是工具名 → 确定性置顶（不参与分数浮动）
  const exactFull = search(all, 'mcp__a_b__c')
  eq(exactFull.results[0].name, 'mcp__a_b__c', 'exact full name is pinned first')
  eq(exactFull.results[0].exact, true, 'pinned row is marked exact')
  const exactBare = search(all, 'list_commits')
  eq(exactBare.results[0].name, 'mcp__code-review-graph__list_commits', 'bare tool name is pinned first')
  eq(exactBare.results[0].exact, true, 'bare-name pin is marked exact')
  eq(search(all, 'github-local.search_issues').results[0].name, 'mcp__github-local__search_issues', 'dotted exact name is pinned first')
  eq(search(all, 'excel').results[0].exact, false, 'keyword matches are not marked exact')
  // 回归：分数没有上界，exact 不能靠固定分数哨兵判断
  const hugeTokens = Array.from({ length: 300 }, (_, index) => `k${index}`)
  const hugeTool = { name: 'mcp__s__huge', server: 's', tool: `huge_${hugeTokens.join('_')}`, description: '', parameters: {} }
  const hugeQuery = hugeTokens.join(' ')
  ok(scoreTool(hugeTool, tokenize(hugeQuery), hugeQuery) > 1000, 'keyword scores are unbounded above 1000')
  const hugeHit = search([hugeTool], hugeQuery).results[0]
  eq(hugeHit.exact, false, 'a >1000 keyword score is not mislabelled as exact')
  ok(hugeHit.score > 1000, 'score is reported as-is (no sentinel clamp)')

  // select: 精确取用（按请求顺序回报，不存在的名字进 missing 而不是静默丢弃）
  eq(parseSelectQuery('SELECT:mcp__a_b__c, mcp__github-local__search_issues'), ['mcp__a_b__c', 'mcp__github-local__search_issues'], 'select: is case-insensitive and comma separated')
  eq(parseSelectQuery('github issue'), undefined, 'plain query is not a select query')
  eq(parseSelectQuery(42), undefined, 'non-string query is not a select query')
  const selected = search(all, 'select:mcp__github-local__search_issues, mcp__a_b__c')
  eq(selected.results.map((row) => row.name), ['mcp__github-local__search_issues', 'mcp__a_b__c'], 'select preserves request order')
  eq(selected.total, 2, 'select total counts resolved rows')
  eq(selected.missing, [], 'select without misses has an empty missing list')
  eq(selected.results.every((row) => row.exact === true), true, 'select rows are marked exact')
  eq(selected.results.every((row) => row.score === 0), true, 'select rows carry score 0 (ranking is not used)')
  const selectedMiss = search(all, 'select:mcp__a_b__c,nope, mcp__zzz__missing')
  eq(selectedMiss.results.map((row) => row.name), ['mcp__a_b__c'], 'select keeps the hits it resolved')
  eq(selectedMiss.missing, ['nope', 'mcp__zzz__missing'], 'select reports every unresolved name')
  const duplicated = search(all, 'select:mcp__a_b__c, mcp__a_b__c, nope, nope')
  eq(duplicated.results.map((row) => row.name), ['mcp__a_b__c'], 'select dedupes repeated names')
  eq(duplicated.missing, ['nope'], 'select dedupes repeated missing names')
  eq(duplicated.total, 1, 'select total counts unique resolved tools')
  const bulk = Array.from({ length: MAX_LIMIT + 5 }, (_, index) => ({ name: `mcp__bulk__t${index}`, server: 'bulk', tool: `t${index}`, description: '', parameters: {} }))
  const bulkSelected = search(bulk, `select:${bulk.map((tool) => tool.name).join(',')}`)
  eq(bulkSelected.results.length, MAX_LIMIT, 'select results are capped at MAX_LIMIT')
  eq(bulkSelected.total, MAX_LIMIT + 5, 'select total still reports every unique resolved tool')
  eq(search(all, 'select:').results, [], 'empty select matches nothing')
  eq(search(all, 'select:', { limit: 1 }).missing, [], 'empty select reports no missing names')
  eq(search(all, 'select:mcp__a_b__c,mcp__github-local__search_issues', { limit: 1 }).results.length, 2, 'select ignores limit (explicit names win)')
  eq(search(all, 'select:mcp__a_b__c', { server: 'github-local' }).results.length, 1, 'select ignores the server filter')
})

// ---------------------------------------------------------------------------
// F. 描述
// ---------------------------------------------------------------------------
run('F. describe', () => {
  const all = collectMcpTools({ tools: { schemas: () => SCHEMAS } })
  const hit = describe(all, 'mcp__github-local__search_issues')
  eq(hit.name, 'mcp__github-local__search_issues', 'exact name')
  eq(hit.server, 'github-local', 'server parsed')
  eq(hit.tool, 'search_issues', 'tool parsed')
  eq(hit.parameters, SCHEMAS[0].parameters, 'full parameter schema returned verbatim')
  ok(hit.description.includes('GitHub issues'), 'description returned')
  eq(describe(all, 'mcp__github-local__nope'), undefined, 'unknown name')
  eq(describe(all, 'read_file'), undefined, 'non-mcp name is not describable')
  eq(describe(all, 42), undefined, 'non-string name')

  // 名字解析：裸名 / 点号 / 空格 / 缺前缀，全部要求拼回后真在目录里
  const resolvedBare = resolveMcpNames(all, 'search_issues')
  eq(resolvedBare.entries.length, 1, 'one request yields one entry')
  eq(resolvedBare.entries[0].request, 'search_issues', 'entry keeps the request text')
  eq(resolvedBare.entries[0].matches.map((tool) => tool.name), ['mcp__github-local__search_issues'], 'bare tool name resolves')
  eq(resolvedBare.missing, [], 'resolved request is not missing')
  eq(resolveMcpNames(all, 'github-local.search_issues').entries[0].matches.map((tool) => tool.name), ['mcp__github-local__search_issues'], 'server.tool resolves')
  eq(resolveMcpNames(all, 'github-local search_issues').entries[0].matches.map((tool) => tool.name), ['mcp__github-local__search_issues'], 'server<space>tool resolves')
  eq(resolveMcpNames(all, 'github-local__search_issues').entries[0].matches.map((tool) => tool.name), ['mcp__github-local__search_issues'], 'name without the mcp__ prefix resolves')
  eq(resolveMcpNames(all, 'mcp.github-local.search_issues').entries[0].matches.map((tool) => tool.name), ['mcp__github-local__search_issues'], 'mcp.server.tool resolves')
  eq(resolveMcpNames(all, 'a_b.c').entries[0].matches.map((tool) => tool.name), ['mcp__a_b__c'], 'underscore server names survive the dotted form')
  eq(resolveMcpNames(all, 'search_issue').entries[0].matches, [], 'no fuzzy/prefix guessing: a near miss returns nothing')
  eq(resolveMcpNames(all, 'nope.nope').missing, ['nope.nope'], 'unresolvable joined name is reported as missing')
  eq(resolveMcpNames(all, 'mcp__github-local').missing, ['mcp__github-local'], 'server-only name is not a tool')
  eq(resolveMcpNames(all, ['mcp__a_b__c', 'nope', 'mcp__github-local__search_issues']).missing, ['nope'], 'batch keeps request order and reports misses')
  eq(resolveMcpNames(all, [' mcp__a_b__c ', '', '   ']).entries.length, 1, 'blank requests are dropped')

  // 歧义：同一裸名在两台服务器 → 全部返回，交给模型按描述挑
  const ambiguous = collectMcpTools({ tools: { schemas: () => AMBIGUOUS_SCHEMAS } })
  eq(resolveMcpNames(ambiguous, 'get').entries[0].matches.map((tool) => tool.name), ['mcp__github-local__get', 'mcp__gitlab__get'], 'a bare name shared by two servers returns both')
  eq(resolveMcpNames(ambiguous, 'gitlab.get').entries[0].matches.map((tool) => tool.name), ['mcp__gitlab__get'], 'the dotted form disambiguates by server')
  eq(resolveMcpNames(ambiguous, 'get').missing, [], 'ambiguous matches are not missing')
})

// ---------------------------------------------------------------------------
// G. ToolDefinition 结构（宿主 register() 会校验 output {schema, render}）
// ---------------------------------------------------------------------------
const ALLOWED_SCHEMA_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null']
const ONE_OF_SIBLING_KEYS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

/**
 * 模拟 dsh-tools 的 enforced JSON Schema 子集校验（结构级，规则对齐
 * `dsh-tools/lib/types/json-schema.js`：oneOf >= 2 个分支、不能与 type/约束关键字并存）。
 */
function assertSupportedSubset(schema, path = '$') {
  checks++
  assert.equal(typeof schema, 'object', `${path} must be an object`)
  assert.ok(schema !== null && Array.isArray(schema) === false, `${path} must not be an array`)
  for (const key of Object.keys(schema)) assert.ok(ALLOWED_SCHEMA_KEYS.has(key), `${path}.${key} is not in the enforced subset`)
  assert.ok(!(schema.type !== undefined && schema.oneOf !== undefined), `${path} cannot declare both type and oneOf`)
  assert.ok(schema.type !== undefined || schema.oneOf !== undefined || ONE_OF_SIBLING_KEYS.every((key) => schema[key] === undefined), `${path} constraint keywords require type or oneOf`)
  if (schema.type !== undefined) assert.ok([...SCALAR_TYPES, 'object', 'array'].includes(schema.type), `${path}.type must be a single supported type`)
  if (schema.oneOf !== undefined) {
    assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length >= 2, `${path}.oneOf must be an array of at least two schemas`)
    for (const key of ONE_OF_SIBLING_KEYS) assert.ok(schema[key] === undefined, `${path}.${key} is not supported beside oneOf`)
    for (const [index, child] of schema.oneOf.entries()) assertSupportedSubset(child, `${path}.oneOf[${index}]`)
  }
  if (schema.properties !== undefined) {
    assert.ok(typeof schema.properties === 'object' && schema.properties !== null && Array.isArray(schema.properties) === false, `${path}.properties must be an object of schemas`)
    for (const [childKey, child] of Object.entries(schema.properties)) assertSupportedSubset(child, `${path}.properties.${childKey}`)
  }
  if (schema.items !== undefined) assertSupportedSubset(schema.items, `${path}.items`)
  if (schema.required !== undefined) {
    assert.ok(Array.isArray(schema.required), `${path}.required must be an array`)
    for (const requiredName of schema.required) assert.ok(Object.hasOwn(schema.properties ?? {}, requiredName), `${path}.required names "${requiredName}" which is not declared`)
  }
  if (schema.additionalProperties !== undefined) assert.equal(typeof schema.additionalProperties, 'boolean', `${path}.additionalProperties must be boolean`)
}

run('G. ToolDefinition shape', () => {
  const fakeCtx = { tools: { schemas: () => SCHEMAS } }
  const getTools = (exec) => collectMcpTools(fakeCtx, exec?.agent)
  const searchTool = createSearchTool(getTools)
  const describeTool = createDescribeTool(getTools)
  const catalogTool = createCatalogTool(getTools)

  eq(searchTool.name, 'mcp_search', 'search name')
  eq(describeTool.name, 'mcp_describe', 'describe name')
  eq(catalogTool.name, 'mcp_catalog', 'catalog name')
  ok(searchTool.name !== 'run_code' && describeTool.name !== 'run_code' && catalogTool.name !== 'run_code', 'reserved PTC transport name is untouched')
  ok([searchTool, describeTool, catalogTool].every((tool) => !tool.name.startsWith(MCP_PREFIX)), 'meta tool names do not collide with the MCP namespace')

  for (const definition of [searchTool, describeTool, catalogTool]) {
    eq(typeof definition.description, 'string', `${definition.name} has a description`)
    ok(definition.description.length > 80, `${definition.name} description explains when to call it`)
    eq(typeof definition.execute, 'function', `${definition.name} has execute`)
    eq(typeof definition.isConcurrencySafe, 'function', `${definition.name} is concurrency-safe (read-only)`)
    eq(definition.isConcurrencySafe({}), true, `${definition.name} reports parallel-safe`)
    eq(typeof definition.output, 'object', `${definition.name} has output`)
    eq(typeof definition.output.render, 'function', `${definition.name} has output.render`)
    eq(typeof definition.output.schema, 'object', `${definition.name} has output.schema`)
    assertSupportedSubset(definition.output.schema, `${definition.name}.output.schema`)
    assertSupportedSubset(definition.parameters, `${definition.name}.parameters`)
    eq(definition.parameters.type, 'object', `${definition.name} parameters are an object schema`)
    eq(definition.parameters.additionalProperties, false, `${definition.name} rejects undeclared arguments`)
  }

  eq(searchTool.parameters.required, ['query'], 'search requires query')
  eq(Object.keys(searchTool.parameters.properties).sort(), ['limit', 'query', 'server'], 'search parameter set')
  eq(describeTool.parameters.required, [], 'describe does not require a fixed key (name or names)')
  eq(Object.keys(describeTool.parameters.properties), ['name', 'names'], 'describe parameter set')
  eq(describeTool.parameters.properties.names.type, 'array', 'describe names is an array parameter')
  eq(Array.isArray(describeTool.output.schema.oneOf), true, 'describe output keeps both shapes via oneOf')
  eq(describeTool.output.schema.oneOf[0].required, ['name', 'server', 'tool', 'description', 'parameters'], 'single-tool output keeps the 0.1.0 required set')
  eq(describeTool.output.schema.oneOf[1].required, ['tools', 'missing'], 'batch output uses the envelope shape')
  eq(catalogTool.parameters.required, [], 'catalog requires no arguments')
  eq(Object.keys(catalogTool.parameters.properties), [], 'catalog parameter set is empty')
  const renderedSearch = searchTool.output.render({ query: 'x' }, { results: [], total: 0 })
  ok(Array.isArray(renderedSearch) && renderedSearch.every((block) => block.type === 'text' && typeof block.text === 'string'), 'search render returns text content blocks')
  ok(renderedSearch[0].text.includes('mcp_search'), 'search render names the tool')
  const renderedSingle = describeTool.output.render({ name: 'x' }, { name: 'x', server: 's', tool: 't', description: 'd', parameters: { type: 'object' } })
  ok(renderedSingle[0].text.includes('mcp_describe') && renderedSingle[0].text.includes('"type": "object"'), 'describe render accepts the 0.1.0 single-object shape')
  const renderedDescribe = describeTool.output.render({ names: ['x'] }, { tools: [{ name: 'x', server: 's', tool: 't', description: 'd', parameters: { type: 'object' } }], missing: [] })
  ok(renderedDescribe[0].text.includes('mcp_describe') && renderedDescribe[0].text.includes('"type": "object"'), 'describe render includes the parameter schema')
  ok(renderSearchText({ results: [], total: 0 }).includes('no match'), 'empty search render is self-healing')
  ok(renderSearchText({ results: [], total: 0, missing: ['nope'] }).includes('no MCP tool matched "nope"'), 'all-missing select render is self-healing')
  ok(renderDescribeText({ tools: [{ name: 'n', server: 's', tool: 't', description: '', parameters: {} }], missing: [] }).includes('(no description'), 'missing description is labelled')
  ok(renderDescribeText({ tools: [], missing: ['nope'] }).includes('not found: nope'), 'describe render reports unresolved names')
  ok(renderCatalogText({ servers: [], total: 0 }).includes('no MCP servers'), 'empty catalog render is self-healing')
})

// ---------------------------------------------------------------------------
// H. execute 行为
// ---------------------------------------------------------------------------
run('H. execute', () => {
  const fakeCtx = { tools: { schemas: () => SCHEMAS } }
  const getTools = (exec) => collectMcpTools(fakeCtx, exec?.agent)
  const exec = { agent: undefined }
  const searchTool = createSearchTool(getTools)
  const describeTool = createDescribeTool(getTools)

  const found = searchTool.execute({ query: 'github' }, exec)
  eq(found.total, 2, 'search total')
  eq(found.results.length, 2, 'search results')
  ok(found.results.some((row) => row.name === 'mcp__github-local__search_issues'), 'exact name returned for mcp_describe/call')
  eq(typeof found.results[0].score, 'number', 'score is numeric')

  const described = describeTool.execute({ name: 'mcp__github-local__search_issues' }, exec)
  eq(Object.keys(described).sort(), ['description', 'name', 'parameters', 'server', 'tool'], 'single name keeps the 0.1.0 object shape')
  eq(described.name, 'mcp__github-local__search_issues', 'describe keeps the exact name')
  eq(described.parameters.required, ['query'], 'describe returns the live parameter schema')
  eq(described.server, 'github-local', 'single-object shape keeps server')

  const byBare = describeTool.execute({ name: 'search_issues' }, exec)
  eq(byBare.name, 'mcp__github-local__search_issues', 'describe accepts the bare tool name')
  const byDotted = describeTool.execute({ name: 'github-local.create_issue' }, exec)
  eq(byDotted.name, 'mcp__github-local__create_issue', 'describe accepts server.tool')

  const batchOne = describeTool.execute({ names: ['search_issues'] }, exec)
  eq(Array.isArray(batchOne.tools), true, 'names always returns the envelope, even for a single tool')
  const batch = describeTool.execute({ names: ['mcp__a_b__c', 'nope', 'mcp__github-local__search_issues'] }, exec)
  eq(batch.tools.map((tool) => tool.name), ['mcp__a_b__c', 'mcp__github-local__search_issues'], 'describe batch keeps request order')
  eq(batch.missing, ['nope'], 'describe batch reports missing names instead of dropping them')
  const dedupedBatch = describeTool.execute({ names: ['nope', 'nope', 'mcp__a_b__c'] }, exec)
  eq(dedupedBatch.missing, ['nope'], 'describe dedupes repeated missing names')
  const merged = describeTool.execute({ name: 'mcp__a_b__c', names: ['mcp__a_b__c', 'mcp__github-local__search_issues'] }, exec)
  eq(merged.tools.map((tool) => tool.name), ['mcp__a_b__c', 'mcp__github-local__search_issues'], 'name and names merge without duplicates')

  const ambiguousDescribe = createDescribeTool((innerExec) => collectMcpTools({ tools: { schemas: () => AMBIGUOUS_SCHEMAS } }, innerExec?.agent))
  const twoHits = ambiguousDescribe.execute({ name: 'get' }, exec)
  eq(twoHits.tools.map((tool) => tool.name), ['mcp__github-local__get', 'mcp__gitlab__get'], 'an ambiguous bare name describes every match')

  throws(() => describeTool.execute({ name: 'mcp__github-local__missing' }, exec), /mcp_search/, 'missing tool error points at mcp_search')
  throws(() => describeTool.execute({ name: 'mcp__github-local__missing' }, exec), /no MCP tool named/, 'missing tool error names the tool')
  throws(() => describeTool.execute({}, exec), /"name" or "names"/, 'describe requires at least one name')
  throws(() => describeTool.execute({ names: [] }, exec), /"name" or "names"/, 'describe rejects an empty names list')
  throws(() => describeTool.execute({ names: [42] }, exec), /must contain only strings/, 'describe rejects non-string names')
  throws(() => describeTool.execute({ name: 42 }, exec), /"name" must be a string/, 'describe rejects a non-string name')

  throws(() => searchTool.execute({}, exec), /"query" is required/, 'missing query rejected')
  throws(() => searchTool.execute({ query: '   ' }, exec), /"query" is required/, 'blank query rejected')
  throws(() => searchTool.execute({ query: 42 }, exec), /"query" is required/, 'non-string query rejected')
  throws(() => searchTool.execute({ query: 'select:' }, exec), /needs at least one tool name/, 'empty select rejected with a self-healing error')
  throws(() => searchTool.execute({ query: 'x', limit: 'ten' }, exec), /"limit" must be a finite number/, 'non-numeric limit rejected')
  throws(() => searchTool.execute({ query: 'x', server: 42 }, exec), /"server" must be a string/, 'non-string server rejected')
  eq(searchTool.execute({ query: 'x', server: '' }, exec).total, 0, 'blank server behaves as omitted')
  eq(searchTool.execute({ query: 'commits', limit: 0 }, exec).results.length, 1, 'limit 0 clamps to 1 (single match)')
  eq(searchTool.execute({ query: 'select:mcp__a_b__c,nope' }, exec).missing, ['nope'], 'select reports misses through execute')
})

// ---------------------------------------------------------------------------
// I. apply(fakeCtx)：P0-a 零回归契约
// ---------------------------------------------------------------------------
run('I. apply()', () => {
  const registered = []
  const listeners = []
  const effects = []
  const fakeCtx = {
    tools: {
      schemas: () => SCHEMAS,
      register(definition) {
        ok(definition?.output !== undefined && typeof definition.output.render === 'function', 'host-visible definition carries output.render')
        ok(registered.every((existing) => existing.name !== definition.name), 'no duplicate registration')
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    on(eventName, listener) {
      listeners.push({ eventName, listener })
      return () => {}
    },
    effect(fn, label) {
      effects.push({ label, dispose: fn() })
      return () => {}
    },
  }

  eq(pluginName, 'mcp-gateway', 'cordis plugin name')
  eq(inject, ['tools'], 'declared dependency')
  apply(fakeCtx)

  eq(registered.map((definition) => definition.name), ['mcp_search', 'mcp_describe', 'mcp_catalog'], 'registers exactly the three P0-a meta tools')
  eq(registered.some((definition) => definition.name === 'mcp_call'), false, 'P0-a must NOT register mcp_call')
  eq(listeners.length, 0, 'P0-a must NOT listen to system-prompt/assemble (no hiding)')
  eq(effects.length, 1, 'one ctx.effect owns all registrations')
  ok(effects[0].label.includes('mcp-gateway'), 'effect has a labelled owner')

  // 通过注册出来的定义真实执行一次（用 fake ctx 的 schemas）
  const searchDef = registered.find((definition) => definition.name === 'mcp_search')
  const searchResult = searchDef.execute({ query: 'github' }, { agent: undefined })
  eq(searchResult.total, 2, 'registered search tool executes against the live registry')
  const describeDef = registered.find((definition) => definition.name === 'mcp_describe')
  eq(describeDef.execute({ name: 'mcp__a_b__c' }, { agent: undefined }).server, 'a_b', 'registered describe tool executes (0.1.0 single-object shape)')
  const catalogDef = registered.find((definition) => definition.name === 'mcp_catalog')
  const catalogResult = catalogDef.execute({}, { agent: undefined })
  eq(catalogResult.total, 6, 'registered catalog tool executes against the live registry')

  effects[0].dispose()
  eq(registered.length, 0, 'effect cleanup unregisters all tools (HMR safe)')
})

// ---------------------------------------------------------------------------
// J. mcp_catalog：一台服务器一行
// ---------------------------------------------------------------------------
run('J. catalog', () => {
  const all = collectMcpTools({ tools: { schemas: () => SCHEMAS } })
  const grouped = catalog(all)
  eq(grouped.total, 6, 'total counts every MCP tool')
  eq(grouped.servers.map((row) => row.server), ['a_b', 'code-review-graph', 'github-local', 'mcp-office-writer'], 'servers are sorted by name')
  eq(grouped.servers.find((row) => row.server === 'github-local').count, 2, 'per-server count')
  eq(grouped.servers.find((row) => row.server === 'github-local').tools, ['search_issues', 'create_issue'], 'per-server tool names without the namespace')
  eq(grouped.servers.find((row) => row.server === 'github-local').summary, 'search_issues, create_issue', 'summary joins the short names')
  eq(catalog([]), { servers: [], total: 0 }, 'empty catalog')
  eq(catalog(collectMcpTools({ tools: { schemas: () => [{ name: 'read_file' }, { name: 'run_code' }] } })), { servers: [], total: 0 }, 'catalog only sees mcp__* tools')
  eq(catalog([{ name: 'mcp__x__y', server: 'x', tool: 'y', description: '', parameters: {} }]).servers[0].summary, 'y', 'single-tool server summary')

  const many = Array.from({ length: MAX_CATALOG_NAMES + 3 }, (_, index) => ({
    name: `mcp__big__tool_${index}`,
    server: 'big',
    tool: `tool_${index}`,
    description: '',
    parameters: {},
  }))
  const big = catalog(many).servers[0]
  eq(big.count, MAX_CATALOG_NAMES + 3, 'count is never truncated')
  eq(big.tools.length, MAX_CATALOG_NAMES, 'tool name list is capped')
  ok(big.summary.endsWith('(+3 more)'), 'summary reports how many names were omitted')

  const fakeCtx = { tools: { schemas: () => SCHEMAS } }
  const getTools = (exec) => collectMcpTools(fakeCtx, exec?.agent)
  const catalogTool = createCatalogTool(getTools)
  const value = catalogTool.execute({}, { agent: undefined })
  eq(value.total, 6, 'catalog tool reads the live registry')
  eq(value.servers.length, 4, 'catalog tool groups by server')
  const text = renderCatalogText(value)
  ok(text.includes('mcp_catalog: 4 server(s), 6 MCP tool(s)'), 'catalog render headline')
  ok(text.includes('- github-local (2 tools): search_issues, create_issue'), 'catalog render writes one line per server')
})

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const total = checks
if (failures.length > 0) {
  process.stdout.write(`\nsmoke FAILED: ${failures.length} section(s), ${total} assertion(s) executed\n`)
  for (const failure of failures) process.stdout.write(`  - ${failure}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`\nsmoke OK: ${total} assertions across ${sections} sections\n`)
}
