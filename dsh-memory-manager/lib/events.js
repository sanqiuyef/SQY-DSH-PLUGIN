/**
 * dsh-memory-manager — bounded runtime audit log.
 *
 * The background features (selector recall, dream, turn extraction) are best-effort:
 * they run off the hot path and swallow their own failures. Until now that meant a
 * single `warn` line, so the user could not answer the two questions that matter —
 * "why was nothing recalled this turn?" and "did extraction run, and why did it die?".
 *
 * This module records those runs, and only them:
 *
 *   - one JSON-lines file, appended to, never rewritten except to bound its size;
 *   - fields limited to what the question needs: `at`, `type`, `ok`, `reason`, `mode`,
 *     counters (`count`, `bytes`, `ms`, `turn`), an error string, and the **names** of
 *     the memories involved. No note body, no prompt, no model answer, no session id;
 *   - never injected into a prompt (unlike the digest) — it is a diagnostic surface
 *     read by `GET /events` and the settings page's diagnostics block;
 *   - bounded twice: the file is rewritten with its newest `keep` lines once it exceeds
 *     `maxBytes` (through the same atomic write the memories use), and every read is
 *     capped at `maxRead` lines.
 *
 * The log lives beside the global memory root (`<globalDir>/.events.jsonl`), inside a
 * directory the plugin already owns, and is ignored by the memory scanner (that only
 * looks at `*.md` / `MEMORY.md`).
 */

import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { writeTextAtomic } from './store.js';

/** File name of the log, relative to the global memory root. */
export const EVENTS_FILE = '.events.jsonl';

/** Defaults: ~256 KB or 200 newest lines, whichever bound is hit first. */
export const DEFAULT_EVENTS = Object.freeze({ maxBytes: 256 * 1024, keep: 200, maxRead: 200 });

/** The only fields an event may carry. Anything else is dropped before it is written. */
const SCALAR_FIELDS = Object.freeze(['reason', 'mode', 'error']);
const INTEGER_FIELDS = Object.freeze(['count', 'bytes', 'ms', 'turn']);

/**
 * Reduce one event to the recorded shape.
 *
 * The allow-list is the privacy boundary: a caller cannot accidentally log a note body
 * by spreading a store entry into the event.
 *
 * @param {object} event
 * @param {Date} at
 * @returns {object}
 */
export function normalizeEvent(event, at = new Date()) {
  const record = { at: at.toISOString() };
  if (typeof event?.type === 'string' && event.type !== '') record.type = event.type.slice(0, 32);
  if (typeof event?.ok === 'boolean') record.ok = event.ok;
  for (const field of SCALAR_FIELDS) {
    const value = event?.[field];
    if (typeof value === 'string' && value !== '') record[field] = value.slice(0, field === 'error' ? 200 : 40);
  }
  for (const field of INTEGER_FIELDS) {
    const value = event?.[field];
    if (Number.isFinite(value)) record[field] = Math.trunc(value);
  }
  if (Array.isArray(event?.names)) {
    record.names = event.names
      .filter((name) => typeof name === 'string' && name !== '')
      .slice(0, 10)
      .map((name) => name.slice(0, 120));
  }
  return record;
}

/**
 * Create the audit log over one file.
 *
 * Every method swallows its own failure: an unwritable audit file must never fail a
 * turn, a recall, or a write. The single warning is emitted once per process.
 *
 * @param {{
 *   file: string,
 *   maxBytes?: number,
 *   keep?: number,
 *   maxRead?: number,
 *   now?: () => Date,
 *   logger?: { warn?: Function },
 * }} options
 */
export function createEventLog({ file, maxBytes = DEFAULT_EVENTS.maxBytes, keep = DEFAULT_EVENTS.keep, maxRead = DEFAULT_EVENTS.maxRead, now = () => new Date(), logger = null }) {
  let warned = false;
  const fail = (error) => {
    if (warned) return;
    warned = true;
    logger?.warn?.(`[dsh-memory-manager] the runtime audit log at ${file} is unavailable: ${error?.message ?? error}`);
  };

  /** Keep the newest `keep` lines once the file is over budget. */
  async function rotateIfNeeded() {
    let info;
    try {
      info = await stat(file);
    } catch {
      return;
    }
    if (info.size <= maxBytes) return;
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return;
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    const kept = lines.slice(Math.max(0, lines.length - Math.max(1, keep)));
    await writeTextAtomic(file, kept.length > 0 ? `${kept.join('\n')}\n` : '');
  }

  /**
   * Append one event. Returns the record as written, or `null` on failure.
   * @param {object} event
   */
  async function append(event) {
    try {
      const record = normalizeEvent(event, now());
      await mkdir(dirname(file), { recursive: true });
      await rotateIfNeeded();
      await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      return record;
    } catch (error) {
      fail(error);
      return null;
    }
  }

  /**
   * Read the newest events, newest first. Malformed lines are skipped.
   * @param {{ limit?: number }} [options]
   * @returns {Promise<Array<object>>}
   */
  async function read({ limit = 50 } = {}) {
    const cap = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 50, Math.max(1, maxRead)));
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      return [];
    }
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    const events = [];
    for (const line of lines.slice(-cap)) {
      try {
        const value = JSON.parse(line);
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) events.push(value);
      } catch {
        /* a torn or hand-edited line is not an event */
      }
    }
    return events.reverse();
  }

  return { path: file, append, read };
}
