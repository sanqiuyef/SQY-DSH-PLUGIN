/**
 * dsh-tool-search-mode — offline smoke test.
 *
 * No host packages and no real DSH profile: the plugin's pure helpers, settings
 * store, assembly transform, bridge tools, and HTTP route are exercised against
 * small fakes. Run with `node scripts/smoke.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BRIDGE_TOOL_NAMES,
  MANIFEST_CONTEXT,
  estimateTokens,
  groupOf,
  oneLine,
  parseSelect,
  renderManifest,
  searchCatalog,
  splitCatalog,
} from '../lib/catalog.js'
import { createEngine } from '../lib/engine.js'
import { createSettingsStore, normalizeMode } from '../lib/settings.js'
import { apply, resolveConfig } from '../lib/index.js'

let checks = 0
async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`ok ${checks} - ${name}`)
}

const TEST_HOME = mkdtempSync(join(tmpdir(), 'tsm-smoke-'))
process.on('exit', () => { try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* best effort */ } })

function tool(name, description = `${name} tool`, parameters = { type: 'object', properties: {} }) {
  return { name, description, parameters }
}

const CATALOG = [
  tool('read', 'Read a file'),
  tool('write', 'Write a file'),
  tool('tool_search', 'Search deferred tools'),
  tool('tool_call', 'Call a deferred tool'),
  tool('web_fetch', 'Fetch and extract content from a URL'),
  tool('web_search', 'Search the web for current information'),
  tool('mcp__github__issue_read', 'Read a GitHub issue'),
  tool('mcp__github__issue_write', 'Create or update a GitHub issue'),
  tool('schedule_create', 'Create a scheduled prompt'),
]

/* ---------------------------------------------------------------- catalog */

await check('estimateTokens handles empty and text', () => {
  assert.equal(estimateTokens(''), 0)
  assert.ok(estimateTokens('x'.repeat(300)) >= 100)
})

await check('oneLine collapses and truncates', () => {
  assert.equal(oneLine('a\n  b\tc'), 'a b c')
  assert.equal(oneLine('x'.repeat(200), 10).length, 10)
})

await check('parseSelect recognizes select: and rejects keywords', () => {
  assert.deepEqual(parseSelect('select:read, write'), ['read', 'write'])
  assert.deepEqual(parseSelect('SELECT:read'), ['read'])
  assert.equal(parseSelect('read write'), null)
  assert.equal(parseSelect('select:'), null)
})

await check('splitCatalog keeps eager names and defers the rest', () => {
  const { eager, deferred } = splitCatalog(CATALOG, new Set(['read', 'tool_search', 'tool_call']))
  assert.deepEqual(eager.map(item => item.name), ['read', 'tool_search', 'tool_call'])
  assert.equal(deferred.length, CATALOG.length - 3)
})

await check('groupOf separates MCP servers from other tools', () => {
  assert.equal(groupOf('mcp__github__issue_read'), 'MCP · github')
  assert.equal(groupOf('schedule_create'), 'Other')
})

await check('renderManifest falls back from full to names to counts', () => {
  const deferred = CATALOG.filter(item => !['read', 'tool_search', 'tool_call'].includes(item.name))
  const full = renderManifest(deferred, { maxTokens: 4000 })
  assert.ok(full.includes('MCP · github'))
  assert.ok(full.includes('mcp__github__issue_read — Read a GitHub issue'))
  const names = renderManifest(deferred, { maxTokens: 150 })
  assert.ok(names.includes('- mcp__github__issue_read'))
  assert.ok(!names.includes('— Read a GitHub issue'))
  const counts = renderManifest(deferred, { maxTokens: 1 })
  assert.ok(counts.includes('- MCP · github: 2 tools'))
  assert.equal(renderManifest([]), '')
})

await check('searchCatalog ranks exact names first and honors select', () => {
  const deferred = CATALOG.filter(item => !['read', 'tool_search', 'tool_call'].includes(item.name))
  const exact = searchCatalog('web_fetch', deferred)
  assert.equal(exact.matches[0].name, 'web_fetch')
  const selected = searchCatalog('select:mcp__github__issue_write,web_search', deferred)
  assert.deepEqual(selected.matches.map(item => item.name), ['mcp__github__issue_write', 'web_search'])
  const keyword = searchCatalog('github issue', deferred, { limit: 1 })
  assert.equal(keyword.matches.length, 1)
  assert.equal(keyword.matches[0].name, 'mcp__github__issue_read')
  const empty = searchCatalog('', deferred)
  assert.equal(empty.matches.length, 0)
  assert.equal(empty.totalDeferred, deferred.length)
})

/* --------------------------------------------------------------- settings */

await check('normalizeMode accepts the three modes only', () => {
  assert.equal(normalizeMode('AUTO'), 'auto')
  assert.equal(normalizeMode('local'), 'local')
  assert.equal(normalizeMode('off'), 'off')
  assert.equal(normalizeMode('nope', 'local'), 'local')
})

await check('settings store round-trips through the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsm-settings-'))
  try {
    const store = createSettingsStore({ dshHome: dir, initialMode: 'auto' })
    assert.equal(store.current(), 'auto')
    assert.equal(store.source(), 'config')
    assert.equal(store.set('local'), 'local')
    assert.equal(store.current(), 'local')
    const raw = JSON.parse(readFileSync(join(dir, 'data', 'dsh-tool-search-mode', 'settings.json'), 'utf8'))
    assert.equal(raw.mode, 'local')
    const reopened = createSettingsStore({ dshHome: dir, initialMode: 'off' })
    assert.equal(reopened.current(), 'local')
    assert.equal(reopened.source(), 'file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ----------------------------------------------------------------- engine */

function fakeCtx(catalog) {
  const registered = new Map()
  const listeners = new Map()
  const routes = []
  const executed = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on(event, handler) { listeners.set(event, handler) },
    effect(fn) { const iterator = fn(); let step = iterator.next(); while (step.done !== true) step = iterator.next() },
    tools: {
      schemas() { return catalog },
      get(name) { return catalog.find(item => item.name === name) },
      register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name) },
      async execute(input) {
        const call = Array.isArray(input.calls) ? input.calls[0] : { id: input.callId, name: input.name }
        executed.push(call)
        return { results: [{ callId: call.id, result: { isError: false, value: { ran: call.name, args: call.arguments } } }] }
      },
    },
    webServer: { register(route) { routes.push(route); return () => {} } },
    connection: { requestRejection() { return undefined } },
  }
  return { ctx, registered, listeners, routes, executed }
}

const agent = (id) => ({ session: { id } })

function assemblyOf(catalog) {
  return { tools: catalog.map(item => ({ ...item })), sections: [], contexts: [], variables: {} }
}

await check('local mode replaces the table with core + bridge and a manifest', () => {
  const { ctx } = fakeCtx(CATALOG)
  const settings = createSettingsStore({ dshHome: TEST_HOME, initialMode: 'local' })
  const engine = createEngine({ ctx, config: resolveConfig({ mode: 'local', core: ['read', 'write'] }), settings })
  const result = engine.assemble(assemblyOf(CATALOG), agent('s1'), undefined)
  assert.deepEqual(result.tools.map(item => item.name), ['read', 'write', 'tool_search', 'tool_call'])
  const manifest = result.contexts.find(item => item.name === MANIFEST_CONTEXT)
  assert.ok(manifest && manifest.text.includes('Deferred tool catalog'))
  assert.ok(manifest.text.includes('web_fetch'))
})

await check('off mode keeps the full table and drops a stale manifest', () => {
  const { ctx } = fakeCtx(CATALOG)
  const settings = createSettingsStore({ dshHome: TEST_HOME, initialMode: 'off' })
  const engine = createEngine({ ctx, config: resolveConfig({ mode: 'off' }), settings })
  const input = assemblyOf(CATALOG)
  input.contexts.push({ name: MANIFEST_CONTEXT, text: 'stale' })
  const result = engine.assemble(input, agent('s2'), undefined)
  assert.equal(result.tools.length, CATALOG.length - BRIDGE_TOOL_NAMES.length)
  assert.equal(result.tools.some(item => BRIDGE_TOOL_NAMES.includes(item.name)), false)
  assert.equal(result.contexts.some(item => item.name === MANIFEST_CONTEXT), false)
})

await check('auto mode stays off below minTools and activates above it', () => {
  const { ctx } = fakeCtx(CATALOG)
  const settings = createSettingsStore({ dshHome: TEST_HOME, initialMode: 'auto' })
  const small = createEngine({ ctx, config: resolveConfig({ mode: 'auto', core: ['read'], minTools: 20 }), settings })
  const inactive = small.assemble(assemblyOf(CATALOG), agent('s3'), undefined)
  assert.equal(inactive.tools.length, CATALOG.length - BRIDGE_TOOL_NAMES.length)
  assert.equal(inactive.tools.some(item => BRIDGE_TOOL_NAMES.includes(item.name)), false)
  const large = createEngine({ ctx, config: resolveConfig({ mode: 'auto', core: ['read'], minTools: 3 }), settings })
  assert.ok(large.assemble(assemblyOf(CATALOG), agent('s4'), undefined).tools.length < CATALOG.length)
})

await check('a session captures its mode; new sessions read the current setting', () => {
  const { ctx } = fakeCtx(CATALOG)
  const settings = createSettingsStore({ dshHome: TEST_HOME, initialMode: 'local' })
  const engine = createEngine({ ctx, config: resolveConfig({ mode: 'local', core: ['read'] }), settings })
  assert.ok(engine.assemble(assemblyOf(CATALOG), agent('s5'), undefined).tools.length < CATALOG.length)
  settings.set('off')
  assert.ok(engine.assemble(assemblyOf(CATALOG), agent('s5'), undefined).tools.length < CATALOG.length)
  assert.equal(engine.assemble(assemblyOf(CATALOG), agent('s6'), undefined).tools.length, CATALOG.length - BRIDGE_TOOL_NAMES.length)
})

await check('search excludes eager tools and warm tools re-enter the table', () => {
  const { ctx } = fakeCtx(CATALOG)
  const settings = createSettingsStore({ dshHome: TEST_HOME, initialMode: 'local' })
  const engine = createEngine({ ctx, config: resolveConfig({ mode: 'local', core: ['read'], maxWarmTools: 2 }), settings })
  const scope = agent('s7')
  engine.assemble(assemblyOf(CATALOG), scope, undefined)
  const outcome = engine.search('web', 3, scope, undefined)
  assert.deepEqual(outcome.matches.map(item => item.name).sort(), ['web_fetch', 'web_search'])
  engine.warmTools(scope, outcome.matches.map(item => item.name))
  const warmed = engine.assemble(assemblyOf(CATALOG), scope, undefined)
  assert.ok(warmed.tools.some(item => item.name === 'web_fetch'))
  assert.ok(warmed.tools.some(item => item.name === 'web_search'))
})

await check('PTC-only and tool-less assemblies are left alone', () => {
  const { ctx } = fakeCtx(CATALOG)
  const settings = createSettingsStore({ dshHome: TEST_HOME, initialMode: 'local' })
  const engine = createEngine({ ctx, config: resolveConfig({ mode: 'local' }), settings })
  const ptc = { tools: [tool('run_code')], sections: [], contexts: [], variables: {} }
  assert.equal(engine.assemble(ptc, agent('s8'), undefined).tools.length, 1)
  const empty = { tools: [], sections: [], contexts: [], variables: {} }
  assert.equal(engine.assemble(empty, agent('s9'), undefined).tools.length, 0)
})

/* ------------------------------------------------------------ apply + tools */

await check('apply registers the listener, both bridge tools, and the state route', () => {
  const { ctx, registered, listeners, routes } = fakeCtx(CATALOG)
  apply(ctx, { mode: 'local', core: ['read'] })
  assert.equal(typeof listeners.get('system-prompt/assemble'), 'function')
  assert.deepEqual([...registered.keys()].sort(), [...BRIDGE_TOOL_NAMES].sort())
  assert.equal(routes[0].path, '/tool-search-mode/api/state')
})

await check('the assembly listener transforms the settled assembly', async () => {
  const { ctx, listeners } = fakeCtx(CATALOG)
  apply(ctx, { mode: 'local', core: ['read'] })
  const listener = listeners.get('system-prompt/assemble')
  const assembly = assemblyOf(CATALOG)
  const result = await listener(assembly, { scope: agent('s10') }, async () => assembly)
  assert.ok(result.tools.length < CATALOG.length)
  assert.ok(result.contexts.some(item => item.name === MANIFEST_CONTEXT))
})

await check('tool_search returns schemas and warms the session', async () => {
  const { ctx, registered } = fakeCtx(CATALOG)
  apply(ctx, { mode: 'local', core: ['read'] })
  const search = registered.get('tool_search')
  const exec = { agent: agent('s11'), callId: 'c1', signal: new AbortController().signal }
  const payload = JSON.parse(await search.execute({ query: 'select:web_fetch' }, exec))
  assert.equal(payload.matches.length, 1)
  assert.equal(payload.matches[0].name, 'web_fetch')
  assert.ok(payload.matches[0].parameters)
  assert.equal(payload.total_deferred_tools > 0, true)
})

await check('tool_call runs the real tool through ctx.tools.execute', async () => {
  const { ctx, registered, executed } = fakeCtx(CATALOG)
  apply(ctx, { mode: 'local', core: ['read'] })
  const call = registered.get('tool_call')
  const exec = { agent: agent('s12'), callId: 'c2', signal: new AbortController().signal }
  const payload = JSON.parse(await call.execute({ name: 'web_fetch', input: { url: 'https://example.com' } }, exec))
  assert.equal(payload.ok, true)
  assert.equal(payload.value.ran, 'web_fetch')
  assert.equal(executed.length, 1)
  assert.equal(executed[0].name, 'web_fetch')
})

await check('tool_call rejects bridge names and unknown tools', async () => {
  const { ctx, registered } = fakeCtx(CATALOG)
  apply(ctx, { mode: 'local', core: ['read'] })
  const call = registered.get('tool_call')
  const exec = { agent: agent('s13'), callId: 'c3', signal: new AbortController().signal }
  assert.equal(JSON.parse(await call.execute({ name: 'tool_search', input: {} }, exec)).ok, false)
  assert.equal(JSON.parse(await call.execute({ name: 'missing', input: {} }, exec)).ok, false)
})

await check('POST /state validates and persists a mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsm-route-'))
  try {
    const { ctx, routes } = fakeCtx(CATALOG)
    const settings = createSettingsStore({ dshHome: dir, initialMode: 'auto' })
    const engine = createEngine({ ctx, config: resolveConfig({ mode: 'auto' }), settings })
    const { registerRoutes } = await import('../lib/routes.js')
    registerRoutes(ctx, { settings, engine, config: resolveConfig({ mode: 'auto' }) })
    const route = routes[0]
    const response = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(text) { this.body = text ?? '' },
    }
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      on(event, handler) {
        if (event === 'data') handler(Buffer.from(JSON.stringify({ mode: 'local' })))
        if (event === 'end') handler()
        return this
      },
    }
    await route.handler(request, response)
    assert.equal(response.status, 200)
    assert.equal(JSON.parse(response.body).mode, 'local')
    assert.equal(settings.current(), 'local')
    const bad = { ...request, on(event, handler) {
      if (event === 'data') handler(Buffer.from(JSON.stringify({ mode: 'nope' })))
      if (event === 'end') handler()
      return this
    } }
    const badResponse = { status: 0, body: '', writeHead(status) { this.status = status }, end(text) { this.body = text ?? '' } }
    await route.handler(bad, badResponse)
    assert.equal(badResponse.status, 400)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n${checks} checks passed`)
