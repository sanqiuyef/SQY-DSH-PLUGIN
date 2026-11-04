/**
 * dsh-tool-search-mode — ZCode-style tool search for DeepSeek Harness.
 *
 * Modes (settings page → 工具搜索):
 *   auto  — slim the model-visible tool catalog once it grows past `minTools`.
 *   local — always slim (unless nothing is deferrable).
 *   off   — send the full catalog.
 *
 * When active, the model sees the core tools, `tool_search`, `tool_call`, and a
 * name/description manifest of everything else. `tool_search` returns full
 * schemas on demand; searched tools are injected into later turns, and
 * `tool_call` can run one immediately. Execution always goes through the real
 * tool, so approvals, guards, hooks, and session events are unchanged.
 *
 * The mode is captured per session at its first prompt assembly, matching
 * ZCode's "new sessions or cold resume after restart" behavior; changing the
 * setting never rewrites a running session.
 *
 * @module dsh-tool-search-mode
 */

import { DEFAULT_CORE_TOOLS } from './catalog.js'
import { createEngine } from './engine.js'
import { registerBridgeTools } from './bridge.js'
import { registerRoutes } from './routes.js'
import { createSettingsStore, normalizeMode } from './settings.js'

/** Loader entry id, matching this bundle's `cordis.patch.yml`. */
export const name = 'tool-search-mode'

/** Host services this plugin needs; `webServer`/`connection` are optional at runtime. */
export const inject = ['tools']

function positiveInt(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

/**
 * Normalize the plugin config.
 * @param {object} [config]
 */
export function resolveConfig(config = {}) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const core = Array.isArray(source.core)
    ? source.core.filter(item => typeof item === 'string' && item.trim() !== '')
    : [...DEFAULT_CORE_TOOLS]
  return {
    mode: normalizeMode(source.mode, 'auto'),
    core,
    minTools: positiveInt(source.minTools, 12),
    maxWarmTools: positiveInt(source.maxWarmTools, 16),
    listingMaxTokens: positiveInt(source.listingMaxTokens, 4000),
    searchDefaultLimit: positiveInt(source.searchDefaultLimit, 5),
    searchMaxLimit: positiveInt(source.searchMaxLimit, 20),
  }
}

/**
 * Mount the plugin.
 * @param {object} ctx - Cordis plugin context.
 * @param {object} [config] - plain config from `cordis.patch.yml`.
 * @returns {ReturnType<typeof createEngine>}
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const settings = createSettingsStore({ initialMode: resolved.mode, logger: ctx.logger })
  const engine = createEngine({ ctx, config: resolved, settings })

  // Transform the settled assembly last so earlier listeners keep their turn.
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const settled = await next()
    return engine.assemble(settled, context?.scope, context?.toolSet)
  })

  const mount = function* mountPlugin() {
    yield registerBridgeTools(ctx, engine)
    yield registerRoutes(ctx, { settings, engine, config: resolved })
  }
  if (typeof ctx.effect === 'function') ctx.effect(mount, 'tool-search-mode: bridge + routes')
  else mount()

  try {
    ctx.logger?.info?.(`[dsh-tool-search-mode] mode=${settings.current()} core=${resolved.core.length} minTools=${resolved.minTools}`)
  } catch {
    /* logging must never block the plugin */
  }
  return engine
}
