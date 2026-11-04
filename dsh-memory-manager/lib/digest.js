/**
 * dsh-memory-manager — the prompt digest.
 *
 * The digest is injected as a `systemPrompt` section, whose `text` runs synchronously
 * on every model step. Two consequences shape this module:
 *
 *   - rendering is a pure function of already-cached entry lists, so it costs
 *     nothing per step and never performs I/O;
 *   - its output must be **stable**: any change appends a new system message to the
 *     session history (and breaks prefix caching). Everything here is deterministic
 *     — entries are ordered explicitly and truncation is a function of the data, not
 *     of the clock — so the same cache renders the same bytes.
 *
 * Budgets (contract v0.2):
 *   - **by default the global index is not injected at all** (user decision): the
 *     digest carries the project index plus one line naming the global note count, so
 *     the prompt cannot grow with the global store;
 *   - `digestIncludeGlobal: true` restores the v0.1 shape: the global index injected
 *     whole, capped at `digestMaxTokens` estimated tokens;
 *   - the project index is ordered **newest-updated first** and contributes at most
 *     `digestMaxEntries` rows, each description cut to `digestEntryChars` characters;
 *   - entries updated within `digestRecentHours` of the cache's `loadedAt` are lifted
 *     into a separate "recent" band with its own budget (`digestRecentMaxEntries`), so
 *     "what changed yesterday" can never be crowded out by an alphabetical prefix;
 *   - anything omitted is named ("还有 N 条，用 memory_search 检索") rather than
 *     silently dropped, so the model knows the digest is a summary.
 */

/** Defaults from the contract; every one is configurable. */
export const DEFAULT_LIMITS = Object.freeze({
  digestMaxTokens: 1200,
  digestMaxEntries: 24,
  digestEntryChars: 120,
  digestGlobalRecent: 12,
  // The recent band: notes touched inside this window (measured against the cache's
  // load time, never against the wall clock) get their own small budget so the newest
  // facts stay in the prompt even when the project has more notes than `digestMaxEntries`.
  digestRecentHours: 24,
  digestRecentMaxEntries: 6,
  // The user's decision: global memory is NOT injected by default. The digest only
  // carries the project index plus one line naming the global count, so the prompt
  // cannot grow with the global store. `digestIncludeGlobal: true` restores the
  // original behaviour (whole global index, token-capped).
  digestIncludeGlobal: false,
  digestIncludeProject: true,
});

/** Narrow a raw config object to the digest limits, ignoring junk. */
export function resolveLimits(config = {}) {
  const limits = { ...DEFAULT_LIMITS };
  const number = (key, min, max) => {
    const value = config?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) limits[key] = value;
  };
  number('digestMaxTokens', 1, 32000);
  number('digestMaxEntries', 1, 500);
  number('digestEntryChars', 1, 2000);
  number('digestGlobalRecent', 1, 500);
  number('digestRecentHours', 1, 8760);
  number('digestRecentMaxEntries', 1, 100);
  if (typeof config?.digestIncludeGlobal === 'boolean') limits.digestIncludeGlobal = config.digestIncludeGlobal;
  if (typeof config?.digestIncludeProject === 'boolean') limits.digestIncludeProject = config.digestIncludeProject;
  return limits;
}

/**
 * Estimate tokens for a memory digest.
 *
 * Deliberately conservative and dependency-free: a CJK code point counts as one
 * token, everything else as a quarter. It is used to *enforce a budget*, so
 * over-estimating costs a few entries while under-estimating would blow the prompt.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const CJK = /[\u2E80-\u2FFF\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;
  let units = 0;
  for (const char of String(text ?? '')) units += CJK.test(char) ? 1 : 0.25;
  return Math.ceil(units);
}

/** Cut a string to `max` code points, marking the cut. */
export function truncateChars(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...value];
  if (chars.length <= max) return value;
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/**
 * Render one scope block with both caps (entries and estimated tokens) applied.
 *
 * @param {string} title - the block heading, already describing the real cap
 * @param {Array<{name: string, description: string}>} entries
 * @param {{ maxEntries: number, entryChars: number, maxTokens?: number }} caps
 * @returns {{ text: string, shown: number } | null} null when nothing fits
 */
function renderBlock(title, entries, caps) {
  const lines = [];
  let tokens = estimateTokens(title);
  let shown = 0;
  for (const entry of entries) {
    if (caps.maxEntries !== undefined && shown >= caps.maxEntries) break;
    const line = `- ${entry.name} — ${truncateChars(entry.description, caps.entryChars)}`;
    const lineTokens = estimateTokens(line);
    if (caps.maxTokens !== undefined && tokens + lineTokens > caps.maxTokens) break;
    lines.push(line);
    tokens += lineTokens;
    shown += 1;
  }
  if (shown === 0) return null;
  const omitted = entries.length - shown;
  const body = [title, ...lines].join('\n');
  return {
    text: omitted > 0 ? `${body}\n（还有 ${omitted} 条，用 memory_search 检索）` : body,
    shown,
  };
}

/** Newest first, then by name — deterministic even when two notes share a timestamp. */
function byRecency(left, right) {
  const leftTime = typeof left.updatedAt === 'string' ? left.updatedAt : '';
  const rightTime = typeof right.updatedAt === 'string' ? right.updatedAt : '';
  if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

/**
 * The cut-off of the recent band, or `null` when the snapshot carries no load time.
 *
 * The reference is the snapshot's `loadedAt` — the moment the cache was filled — not
 * the wall clock: `systemPrompt.section.text` re-renders on every model step, and a
 * band that slid with the clock would rewrite the prompt (and break prefix caching)
 * on every step even when no memory changed. The cache is frozen until the next
 * refresh, so the band is too.
 *
 * `loadScopeKey` stores a `Date` here while hand-built snapshots tend to use an ISO
 * string, so both (and an epoch number) are accepted.
 */
function recentSinceOf(snapshot, limits) {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  const raw = snapshot.loadedAt;
  const loadedAt = raw instanceof Date ? raw.getTime() : typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(loadedAt)) return null;
  return loadedAt - limits.digestRecentHours * 3600000;
}

/** Whether the note was updated at or after `sinceMs` (a missing date is never recent). */
function isRecent(entry, sinceMs) {
  if (sinceMs === null) return false;
  const time = Date.parse(typeof entry.updatedAt === 'string' ? entry.updatedAt : '');
  return !Number.isNaN(time) && time >= sinceMs;
}

/**
 * Split the project index into the recent band and the remainder, both newest-first.
 *
 * The band is capped at `digestRecentMaxEntries`; anything recent beyond that cap stays
 * at the head of the remainder rather than disappearing, so the "还有 N 条" count of the
 * main block remains the whole truth.
 *
 * @returns {{ recent: Array<object>, rest: Array<object> }}
 */
function splitRecent(entries, sinceMs, limits) {
  if (sinceMs === null) return { recent: [], rest: [...entries].sort(byRecency) };
  const recentAll = entries.filter((entry) => isRecent(entry, sinceMs)).sort(byRecency);
  if (recentAll.length === 0) return { recent: [], rest: [...entries].sort(byRecency) };
  const recent = recentAll.slice(0, limits.digestRecentMaxEntries);
  const recentNames = new Set(recent.map((entry) => entry.name));
  const rest = entries.filter((entry) => !recentNames.has(entry.name)).sort(byRecency);
  return { recent, rest };
}

/**
 * Render the digest from cached scope snapshots.
 *
 * Default shape (user decision, contract v0.2): the **project** index only, newest
 * first, capped at `digestMaxEntries` rows of `digestEntryChars` characters, plus one
 * line
 *
 *   全局记忆 N 条，用 memory_search 检索。
 *
 * where N is the global note count — never a global entry. Notes updated inside the
 * recent window are rendered as their own band above the project list, measured against
 * the snapshot's `loadedAt`. `digestIncludeGlobal: true` restores the v0.1 shape (the
 * whole global index, capped by `digestMaxTokens`), which is kept as an option rather
 * than deleted.
 *
 * @param {{
 *   global: { entries: Array<object>, loadedAt?: Date|string|number } | null,
 *   project: { entries: Array<object>, loadedAt?: Date|string|number } | null,
 *   limits?: object,
 * }} input
 * @returns {string} `''` when there is nothing useful to inject
 */
export function renderDigest({ global = null, project = null, limits = DEFAULT_LIMITS } = {}) {
  const includeGlobalBlock = limits.digestIncludeGlobal === true && global !== null;
  const includeProject = limits.digestIncludeProject !== false && project !== null;
  const globalCount = global !== null ? global.entries.length : null;
  const projectCount = project !== null ? project.entries.length : null;
  const globalEntries = includeGlobalBlock ? [...global.entries].sort(byRecency) : [];
  const { recent, rest } = includeProject
    ? splitRecent(project.entries, recentSinceOf(project, limits), limits)
    : { recent: [], rest: [] };

  const hasGlobalHint = !includeGlobalBlock && globalCount !== null && globalCount > 0;
  if (globalEntries.length === 0 && recent.length === 0 && rest.length === 0) {
    // Nothing to inject except the fact that global memory exists. A session with no
    // project notes still benefits from knowing where to look.
    if (!hasGlobalHint) return '';
    return `## 记忆（全局 ${globalCount} 条；用 memory_search 检索）\n\n全局记忆 ${globalCount} 条，用 memory_search 检索。`;
  }

  const counts = includeGlobalBlock
    ? project !== null
      ? `全局 ${globalCount} 条 / 项目 ${projectCount} 条`
      : `全局 ${globalCount} 条`
    : project !== null
      ? `项目 ${projectCount} 条`
      : `全局 ${globalCount} 条`;
  const parts = [`## 记忆（${counts}；用 memory_search 检索）`];

  if (recent.length > 0) {
    const block = renderBlock(`近期更新（最近 ${limits.digestRecentHours} 小时内）：`, recent, {
      maxEntries: limits.digestRecentMaxEntries,
      entryChars: limits.digestEntryChars,
    });
    if (block !== null) parts.push(block.text);
  }
  if (rest.length > 0) {
    const title =
      recent.length > 0
        ? `项目（其余，按更新时间，前 ${Math.min(rest.length, limits.digestMaxEntries)} 条）：`
        : `项目（当前项目，按更新时间，前 ${Math.min(rest.length, limits.digestMaxEntries)} 条）：`;
    const block = renderBlock(title, rest, {
      maxEntries: limits.digestMaxEntries,
      entryChars: limits.digestEntryChars,
    });
    if (block !== null) parts.push(block.text);
  }
  if (includeGlobalBlock && globalEntries.length > 0) {
    const block = renderBlock(
      `全局（最近 ${Math.min(globalEntries.length, limits.digestGlobalRecent)} 条）：`,
      globalEntries.slice(0, limits.digestGlobalRecent),
      { maxEntries: limits.digestGlobalRecent, entryChars: limits.digestEntryChars, maxTokens: limits.digestMaxTokens },
    );
    if (block !== null) parts.push(block.text);
  } else if (!includeGlobalBlock && global !== null) {
    // The count line is the only global memory content in the prompt by default.
    parts.push(`全局记忆 ${globalCount} 条，用 memory_search 检索。`);
  }

  return parts.join('\n\n');
}

/**
 * The digest's token estimate, reported by `GET /digest` and diagnostics.
 * @param {string} text
 */
export function digestTokens(text) {
  return estimateTokens(text);
}
