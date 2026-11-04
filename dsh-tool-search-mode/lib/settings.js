/**
 * dsh-tool-search-mode — mode settings persistence.
 *
 * The settings page and the host share one small JSON file under the DSH home:
 * `$DSH_HOME/data/dsh-tool-search-mode/settings.json`.
 *
 * The host keeps an in-memory copy after the first read, so the per-assembly
 * path never touches the disk. The settings page is the only writer; writes are
 * atomic (same-directory temp file + rename) so a crash cannot leave a partial
 * document behind.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Accepted modes, in settings-page order. */
export const MODES = Object.freeze(['auto', 'local', 'off'])

/**
 * Normalize a mode value.
 * @param {unknown} value
 * @param {'auto'|'local'|'off'} [fallback]
 * @returns {'auto'|'local'|'off'}
 */
export function normalizeMode(value, fallback = 'auto') {
  const mode = String(value ?? '').trim().toLowerCase()
  return MODES.includes(mode) ? mode : fallback
}

/**
 * Resolve the DSH home exactly like the host does.
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured !== '' ? configured : join(home, '.dsh')
}

/**
 * Create the mode store.
 * @param {{dshHome?: string, initialMode?: string, logger?: {warn?: Function}}} [options]
 */
export function createSettingsStore(options = {}) {
  const dshHome = options.dshHome ?? resolveDshHome()
  const file = join(dshHome, 'data', 'dsh-tool-search-mode', 'settings.json')
  const initial = normalizeMode(options.initialMode, 'auto')
  const warn = typeof options.logger?.warn === 'function' ? options.logger.warn : () => {}
  let state = { mode: initial, source: 'config' }
  let loaded = false

  function load() {
    loaded = true
    try {
      if (!existsSync(file)) return
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      state = { mode: normalizeMode(parsed?.mode, initial), source: 'file' }
    } catch (error) {
      warn(`[dsh-tool-search-mode] could not read ${file}: ${error?.message ?? error}; using ${initial}`)
    }
  }

  /** The effective mode. */
  function current() {
    if (!loaded) load()
    return state.mode
  }

  /**
   * Persist one mode and update the in-memory copy.
   * @param {unknown} mode
   * @returns {'auto'|'local'|'off'}
   */
  function set(mode) {
    if (!loaded) load()
    const next = normalizeMode(mode, state.mode)
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temp, `${JSON.stringify({ version: 1, mode: next }, null, 2)}\n`, 'utf8')
    try {
      renameSync(temp, file)
    } catch (error) {
      try { rmSync(temp, { force: true }) } catch { /* best effort */ }
      throw error
    }
    state = { mode: next, source: 'file' }
    return next
  }

  return {
    /** Absolute path of the settings document. */
    path: file,
    /** Where the current value came from: `config`, `file`, or `default`. */
    source: () => state.source,
    current,
    set,
    /** Re-read the file (used by tests). */
    reload: () => { loaded = false; load() },
  }
}
