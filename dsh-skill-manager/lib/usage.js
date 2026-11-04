/**
 * dsh-skill-manager — 技能调用账本（只读，7/30/90 天）。
 *
 * 面板本来能回答「有哪些技能、正文多长」，答不了「哪些技能从来没用过」。技能一多，
 * 真正的问题就变成 ROI：删哪一个、留哪一个。这个模块只从宿主会话历史里数调用次数。
 *
 * 读的是公开服务 `ctx.sessionQuery`（`@deepseek-ai/dsh-session-query`），不自己解压
 * `session.v4.jsonl.zstd`：本包运行时依赖只有 `yaml`，扫盘解压要新增依赖，而服务已把
 * live / 持久化两条来源统一好了。
 *
 * 只认两种事件，且只读事件元数据：
 *  - `tool/call` 且 `data.name === 'skill'`：模型侧加载技能，`arguments` 是原始 JSON 串，
 *    里面只有 `name`；解析失败就跳过（不猜）；
 *  - `user/message` 且 `data.source.kind === 'skill-invocation'`：用户用 `/name` 手动调用。
 *    这是宿主在注入边界写的 source（`packages/skill/skill/src/index.ts`），比在正文里
 *    找 `/name` 可靠。
 *
 * 三条硬约束：
 *  1. 不抛错：服务缺失/异常一律返回 `available: false`，绝不阻塞 `overview`；
 *  2. 有预算：`readSession` 会完整回放并校验整条日志，所以只读最近 90 天内最新的
 *     若干会话，并在墙钟预算用尽时停下（`truncated: true` 如实上报）；
 *  3. 只统计次数与最后使用时间，不读消息正文，不落盘。
 */

/** 一次统计结果的复用窗口：账本用于运营判断，不需要秒级新鲜。 */
const USAGE_TTL_MS = 60 * 1000;

/** 历史深度：三个窗口都在这段区间内统计。 */
export const USAGE_RANGE_DAYS = 90;

/** 统计窗口（天），与契约 §3.10 的字段名一一对应。 */
export const USAGE_WINDOWS = [7, 30, 90];

/** 最多读取多少个会话。 */
const MAX_SESSIONS = 250;

/** 单次统计的墙钟预算（毫秒）。 */
const DEFAULT_BUDGET_MS = 6000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One cached result per service instance. Keying on the service (not just the
 * knobs) keeps a second query service — a test double, or a remounted host —
 * from reading another service's ledger.
 */
let cache = new WeakMap();

/** Drop the usage cache (used after a bulk change and by tests). */
export function clearUsageCache() {
  cache = new WeakMap();
}

/** Degraded result: the ledger is unavailable but the panel keeps working. */
function unavailable(error) {
  return {
    available: false,
    error,
    rangeDays: USAGE_RANGE_DAYS,
    windows: [...USAGE_WINDOWS],
    generatedAt: Date.now(),
    sessions: { total: 0, scanned: 0, skipped: 0, truncated: false },
    skills: [],
  };
}

/**
 * Read one skill use out of a session event.
 *
 * @param {{ type?: string, data?: object }} event
 * @returns {{ name: string, source: 'model' | 'user' } | undefined}
 */
export function skillUseOf(event) {
  if (event === null || typeof event !== 'object') return undefined;
  const data = event.data;
  if (data === null || typeof data !== 'object') return undefined;

  if (event.type === 'tool/call') {
    // The host registers the model-facing loader as the `skill` tool
    // (`packages/skill/tool-skill`); any other tool name is not a skill use.
    if (data.name !== 'skill' || typeof data.arguments !== 'string') return undefined;
    let args;
    try {
      args = JSON.parse(data.arguments);
    } catch {
      return undefined;
    }
    const name = args?.name;
    return typeof name === 'string' && name !== '' ? { name, source: 'model' } : undefined;
  }

  if (event.type === 'user/message') {
    const source = data.source;
    if (source === null || typeof source !== 'object') return undefined;
    if (source.kind !== 'skill-invocation') return undefined;
    return typeof source.name === 'string' && source.name !== '' ? { name: source.name, source: 'user' } : undefined;
  }

  return undefined;
}

/** One row of the ledger. */
function blankRow(name) {
  return { name, d7: 0, d30: 0, d90: 0, modelCalls: 0, userCalls: 0, lastUsedAt: 0 };
}

/**
 * Fold one use into the ledger.
 *
 * @param {Map<string, object>} rows
 * @param {{ name: string, source: 'model' | 'user' }} use
 * @param {number} time - event time in epoch milliseconds
 * @param {number} now
 */
function recordUse(rows, use, time, now) {
  let row = rows.get(use.name);
  if (row === undefined) {
    row = blankRow(use.name);
    rows.set(use.name, row);
  }
  if (use.source === 'model') row.modelCalls += 1;
  else row.userCalls += 1;
  if (time > row.lastUsedAt) row.lastUsedAt = time;

  const age = now - time;
  if (age > USAGE_RANGE_DAYS * DAY_MS) return;
  row.d90 += 1;
  if (age <= 30 * DAY_MS) row.d30 += 1;
  if (age <= 7 * DAY_MS) row.d7 += 1;
}

/**
 * Count skill uses over the last {@link USAGE_RANGE_DAYS} days.
 *
 * @param {{ sessionQuery?: object, budgetMs?: number, maxSessions?: number }} input
 * @returns {Promise<{
 *   available: boolean,
 *   error?: string,
 *   rangeDays: number,
 *   windows: number[],
 *   generatedAt: number,
 *   sessions: { total: number, scanned: number, skipped: number, truncated: boolean },
 *   skills: Array<{ name: string, d7: number, d30: number, d90: number, modelCalls: number, userCalls: number, lastUsedAt: number }>,
 * }>}
 */
export async function collectUsage({ sessionQuery, budgetMs = DEFAULT_BUDGET_MS, maxSessions = MAX_SESSIONS } = {}) {
  if (
    sessionQuery === null ||
    typeof sessionQuery !== 'object' ||
    typeof sessionQuery.listSessions !== 'function' ||
    typeof sessionQuery.readSession !== 'function'
  ) {
    return unavailable('宿主 sessionQuery 服务不可用');
  }

  const cacheKey = `${budgetMs}|${maxSessions}`;
  let perService = cache.get(sessionQuery);
  if (perService === undefined) {
    perService = new Map();
    cache.set(sessionQuery, perService);
  }
  const cached = perService.get(cacheKey);
  if (cached !== undefined && Date.now() - cached.at < USAGE_TTL_MS) return cached.value;

  const now = Date.now();
  const since = now - USAGE_RANGE_DAYS * DAY_MS;

  let records;
  try {
    records = await sessionQuery.listSessions();
  } catch (error) {
    return unavailable(`读取会话列表失败：${error?.message ?? String(error)}`);
  }
  if (!Array.isArray(records)) return unavailable('宿主 sessionQuery.listSessions 返回了非数组结果');

  const recent = records
    .filter((record) => {
      const createdAt = record?.header?.createdAt;
      return typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt >= since;
    })
    .sort((left, right) => right.header.createdAt - left.header.createdAt);

  const picked = recent.slice(0, Math.max(1, maxSessions));
  const rows = new Map();
  let scanned = 0;
  let skipped = 0;
  const startedAt = Date.now();

  for (const record of picked) {
    const id = record?.header?.id;
    if (typeof id !== 'string' || id === '') {
      skipped += 1;
      continue;
    }
    // `readSession` replays and validates the whole log and cannot be
    // interrupted, so the budget is checked between sessions: one huge session
    // can still overrun it, which is why `sessions.truncated` stays optimistic.
    if (Date.now() - startedAt > budgetMs) break;
    let snapshot;
    try {
      snapshot = await sessionQuery.readSession(id);
    } catch {
      skipped += 1;
      continue;
    }
    const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
    // A fork child starts with its parent's event prefix; those calls were
    // already counted in the ancestor session, so skip the inherited events
    // instead of double counting them.
    const inherited = typeof snapshot?.inheritedEventCount === 'number' && Number.isFinite(snapshot.inheritedEventCount)
      ? Math.min(Math.max(snapshot.inheritedEventCount, 0), events.length)
      : 0;
    for (let index = inherited; index < events.length; index += 1) {
      const event = events[index];
      const use = skillUseOf(event);
      if (use === undefined) continue;
      const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0;
      if (time === 0) continue;
      recordUse(rows, use, time, now);
    }
    scanned += 1;
  }

  const skills = [...rows.values()].sort((left, right) => right.d90 - left.d90 || left.name.localeCompare(right.name));
  const value = {
    available: true,
    rangeDays: USAGE_RANGE_DAYS,
    windows: [...USAGE_WINDOWS],
    generatedAt: now,
    sessions: {
      total: recent.length,
      scanned,
      skipped,
      truncated: recent.length > picked.length || scanned + skipped < picked.length,
    },
    skills,
  };
  perService.set(cacheKey, { at: Date.now(), value });
  return value;
}