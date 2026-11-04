/**
 * dsh-tool-search-mode — the two bridge tools.
 *
 * `tool_search` returns the full schemas of matched deferred tools and marks
 * them as loaded for the session; `tool_call` runs one deferred tool in the
 * same turn through `ctx.tools.execute`, so approvals, guards, hooks, and
 * session events all reference the real tool name, never the bridge.
 *
 * Both return a JSON string; failures are reported as `{ ok: false, error }`
 * instead of throwing, so the model can correct itself without a failed turn.
 */

import { BRIDGE_TOOL_NAMES } from './catalog.js'

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Normalize the rc.5 batch result and the older single-result shape. */
function outcomeOf(executed, callId) {
  if (executed === null || typeof executed !== 'object') return undefined
  if (Array.isArray(executed.results)) {
    const item = executed.results.find(candidate => candidate && candidate.callId === callId)
    return item && typeof item === 'object' && 'result' in item ? item.result : undefined
  }
  return executed
}

/**
 * Register both bridge tools.
 * @param {object} ctx - plugin context (needs `tools`).
 * @param {ReturnType<import('./engine.js').createEngine>} engine
 * @returns {() => void} combined disposer
 */
export function registerBridgeTools(ctx, engine) {
  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'tool_search',
    description:
      'Search the deferred tool catalog and load tool schemas on demand. '
      + 'Only core tools are in the tool list; every other tool is deferred to save context. '
      + 'Query forms: space-separated keywords matched against names and descriptions (e.g. "github issue"); '
      + 'select:name1,name2 to load exact tools by name. Regular expressions are not supported. '
      + 'Matches are returned with their full parameter schema and become directly callable on the next turn; '
      + 'use tool_call to run one immediately.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords, or select:<name>[,<name>...] for exact tool names.' },
        max_results: { type: 'integer', description: 'Maximum matches to return (default 5, max 20).' },
      },
      required: ['query'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const query = typeof args?.query === 'string' ? args.query : ''
      const limit = Number.isFinite(args?.max_results) ? Math.trunc(args.max_results) : undefined
      try {
        const outcome = engine.search(query, limit, exec?.agent, exec?.toolSet)
        engine.warmTools(exec?.agent, outcome.matches.map(tool => tool.name))
        const payload = {
          matches: outcome.matches.map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
          total_deferred_tools: outcome.totalDeferred,
        }
        if (outcome.matches.length === 0) {
          payload.hint =
            'No matching deferred tools found. Try broader keywords, correct the spelling, or use select:<exact-name>. '
            + 'Tools already loaded are in your tool list and need no search.'
        }
        return JSON.stringify(payload)
      } catch (error) {
        return JSON.stringify({ error: errorMessage(error) })
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'tool_call',
    description:
      'Invoke a deferred tool by name with its arguments, in the same turn. '
      + 'Runs the real tool: approvals, guards, and events use the real tool name. '
      + 'Prefer calling a tool directly after tool_search has loaded it; use tool_call only when you need to run it immediately.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Exact tool name returned by tool_search.' },
        input: { type: 'object', additionalProperties: true, description: 'Arguments matching the tool schema.' },
      },
      required: ['name', 'input'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const name = typeof args?.name === 'string' ? args.name : ''
      const input = args?.input !== null && typeof args?.input === 'object' ? args.input : {}
      if (name === '') return JSON.stringify({ ok: false, error: 'name is required' })
      if (BRIDGE_TOOL_NAMES.includes(name) || name === 'run_code') {
        return JSON.stringify({ ok: false, error: `tool "${name}" cannot be called through tool_call` })
      }
      try {
        const definition = typeof ctx.tools.get === 'function'
          ? ctx.tools.get(name, exec?.agent, exec?.toolSet)
          : undefined
        if (definition === undefined) {
          return JSON.stringify({ ok: false, error: `unknown or unavailable tool "${name}"` })
        }
        const callId = `${String(exec?.callId ?? 'tool-call')}:tool:${name}`
        const call = { type: 'tool-call', id: callId, name, arguments: JSON.stringify(input) }
        // rc.5 takes the batch shape; the extra single-call fields keep the
        // older public dispatcher working without a runtime version check.
        const request = {
          calls: [call],
          signal: exec.signal,
          maxParallelToolCalls: 1,
          callId,
          name,
          arguments: input,
          ...(exec?.agent === undefined ? {} : { agent: exec.agent }),
          ...(exec?.toolSet === undefined ? {} : { toolSet: exec.toolSet }),
        }
        const executed = await ctx.tools.execute(request)
        const result = outcomeOf(executed, callId)
        engine.warmTools(exec?.agent, [name])
        if (result === undefined) return JSON.stringify({ ok: false, error: 'tool call returned no result' })
        if (result.isError === true) {
          const detail = result.error?.message !== undefined ? String(result.error.message) : 'tool call failed'
          return JSON.stringify({ ok: false, error: detail })
        }
        return JSON.stringify({ ok: true, value: result.value })
      } catch (error) {
        return JSON.stringify({ ok: false, error: errorMessage(error) })
      }
    },
  }))

  return () => { for (const dispose of disposers) dispose() }
}
