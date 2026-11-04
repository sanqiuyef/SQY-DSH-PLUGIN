/**
 * dsh-mcp-manager — derived connection health for the server list.
 *
 * Why this module exists: the host publishes no MCP connection state through the
 * services this plugin injects. What it does publish is enough to *derive* one
 * honestly, as long as each input's meaning is respected:
 *
 *   - `enabled`         — the Loader's effective enablement (authoritative).
 *   - `fiberPhase`      — `apply()` resolved (`active`) or the fiber failed
 *                         (`failed`); `pending`/`loading`/`unloading` are transient.
 *   - `toolCount`       — the `mcp__<name>__*` namespace size. A server that has
 *                         finished connecting has registered its tools; one that
 *                         failed to connect has not. It is *not* liveness: a
 *                         connected server whose transport drops keeps its tools
 *                         until the client gives up.
 *   - `toolCountKnown`  — whether the host answered `ctx.tools.schemas()` at all.
 *                         An unavailable registry must not be read as "zero tools".
 *   - `diagnostic`      — the host's startup failure text, when the fiber failed.
 *
 * `fiberPhase: 'active'` alone is a trap: with the default
 * `failOnStartupError: false` a failed connection still ends up active. So the
 * derivation is:
 *
 *   disabled                              → stopped
 *   no live entry / no fiber               → stopped   (declared but not composed)
 *   fiber failed                           → failed    (reason `fiber-failed`)
 *   pending / loading / unloading          → connecting
 *   active, tool registry unavailable      → connecting (cannot be judged)
 *   active with tools                      → connected
 *   active, no tools, first ≤ graceMs      → connecting (still starting)
 *   active, no tools, beyond grace         → failed    (reason `no-tools`)
 *   active, no tools, *fresh* probe ok     → connected (a legal zero-tool server)
 *
 * A failed probe never turns a row with tools into failed: probes are
 * observations, the tool count is host state. It only corroborates `no-tools`.
 *
 * A successful probe is evidence about *one moment*, so it expires in two ways:
 *
 *   - it must be newer than the last time this row was seen with tools
 *     (`lastPositiveAt`), so a success captured before an edit or a reconnect
 *     cannot mask the failure that edit caused;
 *   - `probe.js` drops a cached probe whose target fingerprint no longer matches
 *     the row's command/url, so changing the definition invalidates it outright.
 *
 * `since` is when the current derived state began, not when the row was created:
 * the first observation of a state fixes it, and a state change resets it. The
 * map is keyed by the caller's stable row key and pruned on every list call, so a
 * long-running Host cannot accumulate rows.
 *
 * `reason` is a stable code (the page localizes it) and `detail` carries the host's
 * own diagnostic when there is one — never a translated sentence from here.
 */

/** How long an active fiber may have zero tools before it counts as failed. */
export const ACTIVE_GRACE_MS = 5000;

/** Longest host diagnostic kept in `detail`. */
const DETAIL_MAX_CHARS = 400;

/** Stable reason codes the browser half localizes. */
export const HEALTH_REASONS = Object.freeze([
  'disabled',
  'not-loaded',
  'fiber-failed',
  'registry-unavailable',
  'no-tools',
  'no-tools-probe-failed',
]);

/** key → { state, since, pendingSince, lastPositiveAt } (epoch ms). */
const observed = new Map();

/**
 * Derive one row's health.
 *
 * @param {{
 *   enabled?: boolean,
 *   fiberPhase?: string|null,
 *   toolCount?: number,
 *   toolCountKnown?: boolean,
 *   diagnostic?: string|null,
 *   lastProbe?: { ok?: boolean, at?: string }|null,
 * }} input
 * @param {{ key?: string, now?: number, graceMs?: number }} [options]
 * @returns {{
 *   state: 'connected'|'connecting'|'failed'|'stopped',
 *   since: string, reason: string|null, detail: string|null,
 * }}
 */
export function healthOf(input, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const graceMs = typeof options.graceMs === 'number' ? options.graceMs : ACTIVE_GRACE_MS;
  const key = typeof options.key === 'string' && options.key !== '' ? options.key : null;
  const previous = key === null ? undefined : observed.get(key);
  const enabled = input?.enabled === true;
  const phase = typeof input?.fiberPhase === 'string' ? input.fiberPhase : null;
  const toolCount = typeof input?.toolCount === 'number' ? input.toolCount : 0;
  const toolCountKnown = input?.toolCountKnown !== false;
  const diagnostic = typeof input?.diagnostic === 'string' && input.diagnostic !== '' ? input.diagnostic : null;
  const probeOk = input?.lastProbe?.ok === true;
  const probeFailed = input?.lastProbe?.ok === false;
  const probeAt = typeof input?.lastProbe?.at === 'string' ? Date.parse(input.lastProbe.at) : NaN;
  // A success only speaks for the current definition: it must postdate the last
  // observation of tools (see the module comment).
  const probeProvesEmpty =
    probeOk && isFinite(probeAt) && (previous === undefined || !isFinite(previous.lastPositiveAt) || probeAt >= previous.lastPositiveAt);
  const lastPositiveAt = toolCount > 0 ? now : previous?.lastPositiveAt;

  let state;
  let reason = null;
  let detail = null;
  let activeAndEmpty = false;

  if (!enabled) {
    state = 'stopped';
    reason = 'disabled';
  } else if (phase === null) {
    state = 'stopped';
    reason = 'not-loaded';
  } else if (phase === 'failed') {
    state = 'failed';
    reason = 'fiber-failed';
    detail = diagnostic === null ? null : truncate(diagnostic);
  } else if (phase === 'active') {
    if (!toolCountKnown) {
      // The host did not answer its own tool registry: "unknown" is the honest
      // answer, and it must not escalate into a red failure after the grace window.
      state = 'connecting';
      reason = 'registry-unavailable';
    } else if (toolCount > 0) {
      state = 'connected';
    } else if (probeProvesEmpty) {
      // A reachable server may legitimately expose no tools; a probe that postdates
      // the last tool sighting is the only evidence that separates that from
      // "never connected".
      state = 'connected';
    } else {
      activeAndEmpty = true;
      state = 'connecting';
    }
  } else {
    // pending / loading / unloading — a reload is in flight.
    state = 'connecting';
  }

  // Grace runs from the first observation of an active-but-empty fiber, not from
  // this call, so a refresh that arrives every second cannot postpone `failed`.
  const pendingSince = activeAndEmpty ? (previous?.pendingSince ?? now) : undefined;
  if (pendingSince !== undefined && now - pendingSince >= graceMs) {
    state = 'failed';
    reason = probeFailed ? 'no-tools-probe-failed' : 'no-tools';
  }

  const since = previous !== undefined && previous.state === state ? previous.since : now;
  if (key !== null) {
    // Keep `pendingSince` for as long as the row stays active-and-empty, including
    // after the grace window elapses: clearing it here would make every subsequent
    // list refresh restart the window and flap between connecting and failed.
    observed.set(key, {
      state,
      since,
      pendingSince: activeAndEmpty ? pendingSince : undefined,
      lastPositiveAt,
    });
  }
  return { state, since: new Date(since).toISOString(), reason, detail };
}

/** Truncate a host diagnostic without splitting a surrogate pair. */
function truncate(text) {
  const value = String(text);
  if (value.length <= DETAIL_MAX_CHARS) return value;
  return `${value.slice(0, DETAIL_MAX_CHARS - 1)}…`;
}

/**
 * Drop state for rows no longer present, so the map tracks the live list only.
 *
 * @param {Iterable<string>} keys
 */
export function pruneHealth(keys) {
  const live = new Set([...keys].filter((key) => typeof key === 'string'));
  for (const key of [...observed.keys()]) if (!live.has(key)) observed.delete(key);
}

/** Forget every observation (plugin disposal or tests). */
export function resetHealth() {
  observed.clear();
}

/** The map size — diagnostics and tests. */
export function healthEntryCount() {
  return observed.size;
}
