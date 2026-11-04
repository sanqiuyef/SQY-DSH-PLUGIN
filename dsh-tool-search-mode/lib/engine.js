/**
 * dsh-tool-search-mode — the assembly transform and per-session state.
 *
 * On DSH 0.2.1-rc.5 the `system-prompt/assemble` waterfall receives the full
 * assembly (including `tools`) and its return value is authoritative, so this
 * engine can replace the model-visible tool table while the step's
 * `ResolvedToolSet` keeps every tool executable. On newer alpha builds the host
 * appends the tool table after the waterfall; there the transform is a no-op
 * (the host's table wins) and the plugin degrades to "off".
 *
 * Session semantics match ZCode's setting: the mode is captured when a session
 * first assembles a prompt, and later settings changes apply to new sessions
 * (or a cold resume after restart), not to the running one.
 */

import {
  BRIDGE_TOOL_NAMES,
  MANIFEST_CONTEXT,
  renderManifest,
  searchCatalog,
  splitCatalog,
} from './catalog.js'

/** The agent behind a scope key, when the runtime supplied one. */
export function agentOf(scope) {
  if (scope === undefined || scope === null || typeof scope !== 'object') return undefined
  return scope.session !== undefined ? scope : undefined
}

  /** Replace or append the manifest context without duplicating it. */
  function withManifestContext(assembly, text) {
    const contexts = Array.isArray(assembly.contexts) ? assembly.contexts : []
    const next = contexts.filter(context => context?.name !== MANIFEST_CONTEXT)
    if (text !== '') next.push({ name: MANIFEST_CONTEXT, text })
    return { ...assembly, contexts: next }
  }

  /** Hide the bridge tools while search is inactive (off / below threshold / nothing deferred). */
  function withoutBridgeTools(assembly) {
    if (!Array.isArray(assembly.tools)) return assembly
    return { ...assembly, tools: assembly.tools.filter(tool => !BRIDGE_TOOL_NAMES.includes(tool?.name)) }
  }

/**
 * Create the engine.
 * @param {{
 *   ctx: object,
 *   config: {core: readonly string[], minTools: number, maxWarmTools: number, listingMaxTokens: number, searchDefaultLimit: number, searchMaxLimit: number},
 *   settings: ReturnType<import('./settings.js').createSettingsStore>,
 * }} options
 */
export function createEngine({ ctx, config, settings }) {
  /** session id → captured mode */
  const sessionModes = new Map()
  /** session id → Map(tool name → last-use sequence) */
  const warm = new Map()
  let warmSeq = 0

  function sessionIdOf(agent) {
    const id = agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  /** The mode this agent's session was captured with. */
  function modeFor(agent) {
    const id = sessionIdOf(agent)
    if (id === undefined) return settings.current()
    let mode = sessionModes.get(id)
    if (mode === undefined) {
      mode = settings.current()
      sessionModes.set(id, mode)
    }
    return mode
  }

  function warmNamesFor(agent) {
    const id = sessionIdOf(agent)
    if (id === undefined) return []
    return [...(warm.get(id)?.keys() ?? [])]
  }

  /**
   * Add tools to the session's warm set, LRU-bounded.
   * @param {object|undefined} agent
   * @param {readonly string[]} names
   */
  function warmTools(agent, names) {
    const id = sessionIdOf(agent)
    if (id === undefined || !Array.isArray(names) || names.length === 0) return
    let set = warm.get(id)
    if (set === undefined) {
      set = new Map()
      warm.set(id, set)
    }
    for (const name of names) {
      if (typeof name !== 'string' || name === '') continue
      set.delete(name)
      set.set(name, ++warmSeq)
    }
    while (set.size > config.maxWarmTools) {
      const oldest = set.keys().next()
      if (oldest.done === true) break
      set.delete(oldest.value)
    }
  }

  /** Eager names for one catalog: core + bridge + warm, intersected with it. */
  function eagerNames(agent, tools) {
    const present = new Set(tools.map(tool => tool.name))
    const names = new Set()
    for (const name of config.core) if (present.has(name)) names.add(name)
    for (const name of BRIDGE_TOOL_NAMES) names.add(name)
    for (const name of warmNamesFor(agent)) if (present.has(name)) names.add(name)
    return names
  }

  /**
   * Transform one settled assembly.
   * @param {object} assembly - PromptAssembly/PromptPresentation from the waterfall.
   * @param {object|undefined} scope - the calling agent.
   * @param {object|undefined} toolSet - step admission (unused here; kept for parity).
   * @returns {object} the assembly to hand back to the host.
   */
  function assemble(assembly, scope, toolSet) {
    void toolSet
    if (assembly === null || typeof assembly !== 'object') return assembly
    // The alpha line appends the host's own tool table after this waterfall;
    // without a table there is nothing authoritative to replace.
    if (!Array.isArray(assembly.tools) || assembly.tools.length === 0) return assembly
    const agent = agentOf(scope)
    const mode = modeFor(agent)
    if (mode === 'off') return withManifestContext(withoutBridgeTools(assembly), '')
    // A strict PTC scope collapses the table to the `run_code` transport.
    if (assembly.tools.length === 1 && assembly.tools[0]?.name === 'run_code') return assembly
    if (mode === 'auto' && assembly.tools.length < config.minTools) return withManifestContext(withoutBridgeTools(assembly), '')
    const eager = eagerNames(agent, assembly.tools)
    const { eager: eagerTools, deferred } = splitCatalog(assembly.tools, eager)
    if (deferred.length === 0) return withManifestContext(withoutBridgeTools(assembly), '')
    // The bridge is registered before any assembly, so it is normally part of the
    // catalog; append a minimal schema if another layer hid it.
    const present = new Set(eagerTools.map(tool => tool.name))
    for (const name of BRIDGE_TOOL_NAMES) {
      if (!present.has(name)) {
        eagerTools.push({ name, description: `${name} bridge`, parameters: { type: 'object', properties: {} } })
      }
    }
    const manifest = renderManifest(deferred, { maxTokens: config.listingMaxTokens })
    return withManifestContext({ ...assembly, tools: eagerTools }, manifest)
  }

  /**
   * Search the deferred part of the current catalog.
   * @param {string} query
   * @param {number|undefined} limit
   * @param {object|undefined} agent
   * @param {object|undefined} toolSet
   */
  function search(query, limit, agent, toolSet) {
    let tools
    try {
      tools = ctx.tools.schemas(agent, toolSet)
    } catch {
      tools = ctx.tools.schemas(agent)
    }
    const list = Array.isArray(tools) ? tools : []
    const eager = eagerNames(agent, list)
    const { deferred } = splitCatalog(list, eager)
    return searchCatalog(query, deferred, {
      limit: limit ?? config.searchDefaultLimit,
      maxLimit: config.searchMaxLimit,
    })
  }

  /** A compact stats view for the settings page. */
  function stats() {
    let tools = []
    try {
      tools = ctx.tools.schemas()
    } catch {
      tools = []
    }
    const list = Array.isArray(tools) ? tools : []
    const eager = eagerNames(undefined, list)
    const { deferred } = splitCatalog(list, eager)
    return {
      catalogSize: list.length,
      deferredSize: deferred.length,
      core: [...config.core],
      warmSessions: warm.size,
      capturedSessions: sessionModes.size,
    }
  }

  return {
    assemble,
    search,
    warmTools,
    warmNamesFor,
    modeFor,
    stats,
    /** Test seam: forget captured sessions and warm sets. */
    reset: () => { sessionModes.clear(); warm.clear(); warmSeq = 0 },
  }
}
