/**
 * dsh-memory-manager — the markdown memory store.
 *
 * Files, not a database: the user keeps these notes readable by ZCode, Obsidian, and
 * a text editor, so the on-disk format is the contract (`global-memory/server.py`
 * compatibility):
 *
 *   <dir>/<name>.md   `---` frontmatter (`name`, `description`, `metadata.type`, optional
 *                     `metadata.aliases`) + body
 *   <dir>/MEMORY.md   `- [name](name.md) — description` rows
 *
 * Three defects of the original MCP server are fixed here because they cost real
 * memories: its index read-modify-write had no lock and was not atomic, its substring
 * match could drop the wrong index row, and a write could resurrect a stale index.
 * Every mutation therefore runs as:
 *
 *   mkdir → lock `<dir>/.memory` (shared `@deepseek-ai/dsh-atomic-write` lock, with an
 *   equivalent local fallback) → **re-read** the index inside the lock → rewrite it →
 *   write the note through a same-directory temp file + rename → release.
 *
 * `writeNote`/`updateNote` are also the dedupe boundary: they mask secrets through
 * `redact.js` before anything is formatted or indexed, and a write under a name that is
 * another note's alias updates that note instead of creating a second one.
 *
 * The digest cache (`digestFor`) is the other half: `systemPrompt.section.text` is
 * synchronous, so the prompt can only read an in-memory snapshot. Loading is
 * asynchronous and event-driven; a cache miss renders `''` and the next step sees the
 * loaded value.
 *
 * Nothing in this module is aware of the host: it takes roots and returns plain data,
 * which is what lets `scripts/smoke.mjs` exercise it against a temp directory instead
 * of the user's real memory folders.
 */

import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { KEY_HASH_LENGTH, isProjectKey, projectKeyOf, slugOf } from './project-key.js';
import { digestTokens, renderDigest, resolveLimits } from './digest.js';
import { redactNote, redactSecrets } from './redact.js';

/** The index file name (same as global-memory / ZCode). */
export const INDEX_NAME = 'MEMORY.md';

/** The memory categories, unchanged from global-memory. */
export const VALID_TYPES = Object.freeze(['env', 'user', 'feedback', 'project', 'reference']);

/** Human-readable category meanings, used in tool descriptions and errors. */
export const TYPE_DESCRIPTIONS = Object.freeze({
  env: 'machine/environment facts (hardware, versions, global paths)',
  user: 'user identity and preferences (role, habits, explicit requests)',
  feedback: 'working-style guidance the user gave, including the reason',
  project: 'cross-project ongoing work, goals, constraints (absolute dates)',
  reference: 'pointers to external resources (URLs, dashboards, tickets)',
});

/** Scopes a note can live in. */
export const SCOPES = Object.freeze(['project', 'global']);

/** Index files larger than this are reported (the live ZCode table has a 48 KB one). */
const INDEX_WARN_BYTES = 48 * 1024;

/** Longest memory name we accept, matching the "do not exceed" rule of the contract. */
const NAME_MAX_LENGTH = 120;

/** Windows device names that cannot be used as file names. */
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

/**
 * Resolve the two storage roots.
 *
 * Both live under DSH now (user decision, contract v0.2): the global store defaults to
 * `$DSH_HOME/memories/global`, never to ZCode's directory, so the two tools cannot
 * become two writers of one index. Explicit config wins, then the environment
 * (`GLOBAL_MEMORY_DIR` keeps the global-memory MCP's override convention; a new
 * `DSH_MEMORY_PROJECTS_DIR` covers projects), then the defaults.
 *
 * Neither directory is created here — a read of a missing root is an empty memory
 * store, not an error (`ensureRoots()` is the explicit create).
 *
 * @param {object} [config]
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [home]
 * @returns {{ globalDir: string, projectsDir: string, dshHome: string }}
 */
export function resolveRoots(config = {}, env = process.env, home = homedir()) {
  const first = (...values) => values.find((value) => typeof value === 'string' && value.trim() !== '');
  const dshHome = first(env.DSH_HOME, join(home, '.dsh'));
  const global = first(config?.memoryRoots?.global, config?.globalDir, env.GLOBAL_MEMORY_DIR, join(dshHome, 'memories', 'global'));
  const projects = first(config?.memoryRoots?.projects, config?.projectsDir, env.DSH_MEMORY_PROJECTS_DIR, join(dshHome, 'memories', 'projects'));
  return { globalDir: resolve(global), projectsDir: resolve(projects), dshHome: resolve(dshHome) };
}

/**
 * Clean a caller-supplied memory name into a file name.
 *
 * Mirrors `global-memory/server.py:_safe_name` (illegal characters become `-`, edge
 * dots/spaces are stripped, empty and `memory` are rejected) and adds the two cases it
 * missed: Windows device names and over-long names.
 *
 * @param {string} name
 * @returns {string}
 */
export function safeName(name) {
  if (typeof name !== 'string') throw new Error('memory name must be a string');
  let cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
    .replace(/^[. ]+|[. ]+$/g, '');
  if (cleaned === '') throw new Error(`invalid memory name: ${JSON.stringify(name)}`);
  if (cleaned.toLowerCase() === 'memory') throw new Error(`invalid memory name: ${JSON.stringify(name)} (the index file name is reserved)`);
  if (cleaned.length > NAME_MAX_LENGTH) {
    throw new Error(`invalid memory name: ${JSON.stringify(name)} is longer than ${NAME_MAX_LENGTH} characters`);
  }
  if (WINDOWS_RESERVED.test(cleaned)) {
    throw new Error(`invalid memory name: ${JSON.stringify(name)} is a reserved Windows device name`);
  }
  return cleaned;
}

/** Collapse a description into one line, as the index format requires. */
function cleanDescription(description) {
  return String(description ?? '').replace(/\r?\n+/g, ' ').trim();
}

/** Collapse a body to LF and trim trailing blank lines; leading blank lines are added back by the formatter. */
function cleanContent(content) {
  return String(content ?? '').replace(/\r\n/g, '\n').trim();
}

/**
 * Render a value as a YAML plain scalar when that is unambiguous, otherwise as a
 * double-quoted scalar.
 *
 * The existing ZCode reader is a line regex and does not understand escapes, so plain
 * output is preferred (that is what makes the notes readable by both tools). Values
 * containing `: ` or starting with a YAML indicator character cannot be plain, and
 * those fall back to quoted YAML — still valid YAML, and better than a note that
 * cannot be parsed at all.
 */
function yamlScalar(value) {
  const text = String(value ?? '');
  const unsafeStart = /^[\s\-?:,\[\]{}#&*!|>'"%@`]/;
  if (text === '' || unsafeStart.test(text) || /:\s/.test(text) || /\s#/.test(text) || /[\r\n]/.test(text)) {
    return JSON.stringify(text);
  }
  return text;
}

const ID_SAFE = /^[\p{Letter}\p{Number}_.-]+$/u;

/** Longest alias list accepted on one note (keeps the frontmatter and matches small). */
const ALIAS_MAX_COUNT = 8;

/**
 * Clean a caller-supplied alias list.
 *
 * An alias is a *match key*, not a file name: it never becomes a path, so it is not run
 * through `safeName`. It is trimmed, de-duplicated case-insensitively, capped, and the
 * note's own name is dropped (writing a name that equals itself is a no-op).
 *
 * @param {unknown} aliases
 * @param {string} [canonicalName]
 * @returns {string[]}
 */
function normalizeAliases(aliases, canonicalName = '') {
  const canonical = String(canonicalName ?? '').trim().toLowerCase();
  const result = [];
  for (const raw of Array.isArray(aliases) ? aliases : []) {
    if (typeof raw !== 'string') continue;
    const alias = raw.trim();
    if (alias === '' || alias.length > NAME_MAX_LENGTH) continue;
    if (alias.toLowerCase() === canonical) continue;
    if (result.some((value) => value.toLowerCase() === alias.toLowerCase())) continue;
    result.push(alias);
    if (result.length >= ALIAS_MAX_COUNT) break;
  }
  return result;
}

/** Whether any alias equals `name` (case-insensitive). */
function aliasesInclude(aliases, name) {
  if (!Array.isArray(aliases) || aliases.length === 0) return false;
  const lower = String(name ?? '').toLowerCase();
  return aliases.some((alias) => typeof alias === 'string' && alias.toLowerCase() === lower);
}

/** Render one note in the global-memory/ZCode format. */
export function formatNote({ name, description, type, content, aliases = [] }) {
  const aliasList = normalizeAliases(aliases, name);
  return (
    '---\n' +
    `name: ${yamlScalar(name)}\n` +
    `description: ${yamlScalar(cleanDescription(description))}\n` +
    'metadata:\n' +
    `  type: ${yamlScalar(type)}\n` +
    // `metadata.aliases` is additive: readers that do not know it (ZCode's line regex,
    // older global-memory) simply ignore the extra frontmatter key.
    (aliasList.length > 0 ? `  aliases: ${JSON.stringify(aliasList)}\n` : '') +
    '---\n\n' +
    `${cleanContent(content)}\n`
  );
}

/**
 * Parse one note tolerantly.
 *
 * A note with no frontmatter, a note with unparseable frontmatter, and a note written
 * by a future ZCode version must all still appear (with a diagnostic) rather than
 * disappear: a memory the model cannot see is a memory the user has lost.
 *
 * @param {string} text
 * @param {string} filename - `<name>.md`
 * @returns {{ name: string, description: string, type: string, content: string, aliases: string[], file: string, error: string|null }}
 */
export function parseNote(text, filename) {
  const file = String(filename ?? '');
  const fallback = file.replace(/\.md$/i, '');
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  const result = { name: fallback, description: '', type: 'project', content: raw, aliases: [], file, error: null };

  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (frontmatter === null) {
    if (raw.startsWith('---')) result.error = 'frontmatter opened but no closing "---" line was found';
    return result;
  }

  const body = raw.slice(frontmatter[0].length).replace(/^\r?\n/, '');
  result.content = body;

  let data = null;
  try {
    data = parseYaml(frontmatter[1]);
  } catch (error) {
    result.error = `frontmatter is not valid YAML (${error?.message ?? error}); read with the tolerant fallback`;
  }

  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    if (typeof data.name === 'string' && data.name.trim() !== '') result.name = data.name.trim();
    if (typeof data.description === 'string') result.description = cleanDescription(data.description);
    else if (typeof data.description === 'number') result.description = String(data.description);
    const metadata = data.metadata;
    if (metadata !== null && typeof metadata === 'object' && typeof metadata.type === 'string') {
      result.type = metadata.type.trim().toLowerCase();
    } else if (typeof data.type === 'string') {
      result.type = data.type.trim().toLowerCase();
    }
    const aliasSource =
      metadata !== null && typeof metadata === 'object' && metadata.aliases !== undefined ? metadata.aliases : data.aliases;
    if (Array.isArray(aliasSource)) result.aliases = normalizeAliases(aliasSource, result.name);
    else if (typeof aliasSource === 'string') result.aliases = normalizeAliases([aliasSource], result.name);
    return result;
  }

  // Tolerant line scan, same fields server.py recognises. Reached only when YAML
  // parsing failed (or the frontmatter was not a mapping).
  let inMeta = false;
  for (const line of frontmatter[1].split(/\r?\n/)) {
    if (/^metadata:\s*$/.test(line)) {
      inMeta = true;
      continue;
    }
    const match = /^\s*([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    if (match === null) continue;
    const [, key, value] = match;
    const cleaned = value.trim().replace(/^['"]|['"]$/g, '');
    if (key === 'type' && inMeta) result.type = cleaned.toLowerCase();
    else if (key === 'name' && !inMeta) result.name = cleaned || result.name;
    else if (key === 'description' && !inMeta) result.description = cleanDescription(cleaned);
    else if (key === 'aliases' && inMeta) {
      // `[a, b]` — the form `formatNote` writes, read without a YAML parser.
      const inner = value.trim().replace(/^\[|\]$/g, '');
      const parts = inner === '' ? [] : inner.split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, ''));
      result.aliases = normalizeAliases(parts, result.name);
    }
  }
  return result;
}

/** The file name a markdown link in the index points at, or `null` when the line is not an index row. */
export function indexLinkTarget(line) {
  // `[^)]+` deliberately allows `(` inside the target (a memory name may contain one)
  // while stopping at the first `)`, which is the link's closing delimiter.
  const match = /\[[^\]]*\]\(([^)]+)\)/.exec(String(line ?? ''));
  if (match === null) return null;
  return match[1].trim();
}

/**
 * Whether an index line addresses `name`.
 *
 * The comparison is the exact link target, never a substring of the row: the old
 * server's `](name.md)` substring test could not tell two rows apart, and an anchored
 * target comparison is also what keeps a note named `a` from matching `aa`.
 */
export function indexLineMatches(line, name) {
  return String(line ?? '').includes(`](${String(name)}.md)`);
}

/** `- [name](name.md) — description` */
export function indexLine(name, description) {
  return `- [${name}](${name}.md) — ${cleanDescription(description)}`;
}

// ------------------------------------------------------------ lock + atomic write

/**
 * Same rationale as the sibling managers: share the host's own lock/atomic-write
 * implementation when it resolves, otherwise run an equivalent local one and say so
 * once. The fallback mirrors the host contract exactly — `wx`-created `<file>.lock`
 * holding the pid, dead-holder takeover through a claim file, bounded backoff — so a
 * mix of host code and fallback code still serializes on the same file name.
 */
let atomicModule;
let warnedFallback = false;

async function loadAtomicWrite() {
  if (atomicModule !== undefined) return atomicModule;
  try {
    atomicModule = await import('@deepseek-ai/dsh-atomic-write');
  } catch (error) {
    atomicModule = null;
    if (!warnedFallback) {
      warnedFallback = true;
      console.warn(
        `[dsh-memory-manager] @deepseek-ai/dsh-atomic-write is not resolvable (${error?.message ?? error}); ` +
          'using the bundled lock/atomic-write fallback',
      );
    }
  }
  return atomicModule;
}

/** Which writer backend the diagnostics report. */
export async function atomicWriteBackend() {
  const module = await loadAtomicWrite();
  return typeof module?.withFileLock === 'function' && typeof module?.writeFileAtomic === 'function' ? 'used' : 'fallback';
}

const LOCK_RETRY_INITIAL_MS = 20;
const LOCK_RETRY_MAX_MS = 200;
const DEFAULT_LOCK_WAIT_MS = 5000;

const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function isLockContention(error, lockPath) {
  if (error?.code === 'EEXIST') return true;
  if (error?.code !== 'EPERM') return false;
  try {
    await readFile(lockPath, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function holderExited(record) {
  if (!/^\d+\n$/.test(record)) return false;
  const pid = Number(record.trim());
  if (pid === 0 || pid > 2147483647 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

async function readLockRecord(lockPath) {
  try {
    return await readFile(lockPath, 'utf8');
  } catch {
    return undefined;
  }
}

async function takeOverExitedLock(lockPath) {
  const record = await readLockRecord(lockPath);
  if (record === undefined || !holderExited(record)) return false;
  const claim = `${lockPath}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`;
  try {
    await writeFile(claim, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'EPERM') return false;
    throw error;
  }
  try {
    if ((await readLockRecord(lockPath)) !== record || !holderExited(record)) return false;
    try {
      await rm(lockPath, { force: true });
    } catch {
      return false;
    }
    return true;
  } finally {
    await rm(claim, { force: true }).catch(() => {});
  }
}

async function fallbackWithFileLock(filename, operation, options = {}) {
  const lockPath = `${filename}.lock`;
  const deadline = Date.now() + (options.waitMs ?? DEFAULT_LOCK_WAIT_MS);
  let delay = LOCK_RETRY_INITIAL_MS;
  let handle;
  for (;;) {
    try {
      handle = await open(lockPath, 'wx');
      break;
    } catch (error) {
      if (!(await isLockContention(error, lockPath))) throw error;
      if (await takeOverExitedLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for the memory writer lock at ${lockPath}`);
      await sleep(delay);
      delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS);
    }
  }
  try {
    await handle.writeFile(`${process.pid}\n`);
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
}

const WINDOWS_TRANSIENT_RENAME_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);

async function renameAtomicTemp(temp, target) {
  let delay = 20;
  for (let retries = 0; ; retries += 1) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !WINDOWS_TRANSIENT_RENAME_ERRORS.has(error?.code ?? '') || retries >= 8) throw error;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 200);
  }
}

async function fallbackWriteFileAtomic(filename, content, options = {}) {
  await mkdir(dirname(filename), { recursive: true });
  const temp = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, content, { mode: options.mode ?? 0o600, flag: 'wx' });
    await renameAtomicTemp(temp, filename);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Hold the directory's memory writer lock around `operation`.
 *
 * The lock lives beside the data as `<dir>/.memory.lock`, exactly as the contract
 * specifies; every writer in this plugin — note write, note delete, index rewrite —
 * goes through it, so two of them can never interleave their index read-modify-write.
 *
 * @param {string} dir - memory directory (global root or one project's `memory/`)
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 * @template T
 */
export async function withDirLock(dir, operation) {
  const lockTarget = join(dir, '.memory');
  const atomic = await loadAtomicWrite();
  if (typeof atomic?.withFileLock === 'function') return atomic.withFileLock(lockTarget, operation, { waitMs: DEFAULT_LOCK_WAIT_MS });
  return fallbackWithFileLock(lockTarget, operation);
}

/** Atomically replace a file (same-directory temp + rename). */
export async function writeTextAtomic(filename, content) {
  const atomic = await loadAtomicWrite();
  if (typeof atomic?.writeFileAtomic === 'function') {
    await atomic.writeFileAtomic(filename, content, { mode: 0o600 });
    return;
  }
  await fallbackWriteFileAtomic(filename, content, { mode: 0o600 });
}

// ------------------------------------------------------------------- scanning

/** Read one directory of notes; missing directory is `exists: false`, not an error. */
async function scanDirectory(dir, scope, key, now) {
  const problems = [];
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { scope, key, dir, exists: false, entries: [], problems, indexRows: null, indexSize: 0, loadedAt: now() };
    }
    problems.push({ level: 'error', scope, message: `cannot read memory directory ${dir}: ${error?.message ?? error}` });
    return { scope, key, dir, exists: true, entries: [], problems, indexRows: null, indexSize: 0, loadedAt: now() };
  }

  const files = names
    .filter((name) => name.toLowerCase().endsWith('.md') && name.toLowerCase() !== INDEX_NAME.toLowerCase())
    .sort();
  const entries = [];
  for (const file of files) {
    const path = join(dir, file);
    try {
      const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const note = parseNote(text, file);
      const stem = file.replace(/\.md$/i, '');
      if (note.error !== null) {
        problems.push({ level: 'warn', scope, name: note.name, message: `${file}: ${note.error}` });
      }
      if (note.name !== stem) {
        problems.push({ level: 'warn', scope, name: note.name, message: `${file}: frontmatter name "${note.name}" differs from its file name` });
      }
      if (!VALID_TYPES.includes(note.type)) {
        problems.push({ level: 'warn', scope, name: note.name, message: `${file}: unknown memory type "${note.type}"` });
      }
      entries.push({
        name: note.name,
        description: note.description,
        type: note.type,
        aliases: note.aliases,
        updatedAt: info.mtime.toISOString(),
        file,
        path,
        content: note.content,
        error: note.error,
      });
    } catch (error) {
      problems.push({ level: 'error', scope, name: file, message: `${file} could not be read: ${error?.message ?? error}` });
    }
  }

  let indexRows = null;
  let indexSize = 0;
  try {
    const text = await readFile(join(dir, INDEX_NAME), 'utf8');
    const rows = text.split(/\r?\n/);
    while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop();
    indexRows = rows.filter((line) => line.trim() !== '');
    indexSize = Buffer.byteLength(text);
    if (indexSize > INDEX_WARN_BYTES) {
      problems.push({ level: 'warn', scope, message: `${INDEX_NAME} is ${indexSize} bytes (>48 KB); descriptions should be shortened` });
    }
    const indexed = new Map();
    for (const line of indexRows) {
      const target = indexLinkTarget(line);
      if (target === null) {
        problems.push({ level: 'warn', scope, message: `unrecognised index row: ${line.slice(0, 80)}` });
        continue;
      }
      indexed.set(target.replace(/\.md$/i, ''), line);
    }
    const noteNames = new Set();
    for (const entry of entries) {
      noteNames.add(entry.name);
      noteNames.add(entry.file.replace(/\.md$/i, ''));
      const covered = indexed.has(entry.name) || indexed.has(entry.file.replace(/\.md$/i, ''));
      if (!covered) problems.push({ level: 'warn', scope, name: entry.name, message: `${entry.file} has no row in ${INDEX_NAME} (re-added on the next write)` });
    }
    for (const indexedName of indexed.keys()) {
      if (!noteNames.has(indexedName)) {
        problems.push({ level: 'warn', scope, name: indexedName, message: `${INDEX_NAME} lists "${indexedName}" but no such note exists` });
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      problems.push({ level: 'error', scope, message: `${INDEX_NAME} could not be read: ${error?.message ?? error}` });
    }
  }

  return { scope, key, dir, exists: true, entries, problems, indexRows, indexSize, loadedAt: now() };
}

/** A stable, sorted copy of index entries for display/search. */
function publicEntry(entry, scope) {
  return {
    name: entry.name,
    description: entry.description,
    type: entry.type,
    scope,
    updatedAt: entry.updatedAt,
    path: entry.path,
  };
}

// --------------------------------------------------------------- search scoring

/**
 * Tokenize for search, exactly like `global-memory/server.py:_tokens`.
 *
 * English/alphanumeric runs become words; CJK runs are concatenated into one string
 * and contributed together with every adjacent bigram. That is what makes a
 * multi-character Chinese query match without a tokenizer dependency.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenize(text) {
  const lower = String(text ?? '').toLowerCase();
  const chunks = lower.match(/[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) ?? [];
  const tokens = new Set();
  const zhParts = [];
  for (const chunk of chunks) {
    if (/^[a-z0-9]+$/.test(chunk)) tokens.add(chunk);
    else zhParts.push(chunk);
  }
  const zh = zhParts.join('');
  if (zh !== '') {
    tokens.add(zh);
    for (let index = 0; index + 1 < zh.length; index += 1) tokens.add(zh.slice(index, index + 2));
  }
  return tokens;
}

/**
 * Score one note, exactly like `server.py:_score`:
 * `4·name + 3·description + 1·body` per query token, plus `+3` when the whole query is
 * a substring of one of the three fields.
 *
 * Aliases score with the name (weight 4): an alias exists precisely so that the same
 * memory is found under the other names people use for it.
 *
 * @param {{name: string, description: string, content: string, aliases?: string[]}} note
 * @param {Set<string>} queryTokens
 * @param {string} full - trimmed, lowercased query
 * @returns {number}
 */
export function scoreNote(note, queryTokens, full) {
  const nameTokens = tokenize(note.name);
  const descriptionTokens = tokenize(note.description);
  const bodyTokens = tokenize(note.content);
  let aliasTokens = null;
  if (Array.isArray(note.aliases) && note.aliases.length > 0) {
    aliasTokens = new Set();
    for (const alias of note.aliases) for (const token of tokenize(alias)) aliasTokens.add(token);
  }
  let score = 0;
  for (const token of queryTokens) {
    if (nameTokens.has(token) || (aliasTokens !== null && aliasTokens.has(token))) score += 4;
    if (descriptionTokens.has(token)) score += 3;
    if (bodyTokens.has(token)) score += 1;
  }
  if (full !== '') {
    const lowerName = note.name.toLowerCase();
    const lowerDescription = (note.description ?? '').toLowerCase();
    const lowerContent = (note.content ?? '').toLowerCase();
    const aliasHit = Array.isArray(note.aliases) && note.aliases.some((alias) => String(alias).toLowerCase().includes(full));
    if (lowerName.includes(full) || lowerDescription.includes(full) || lowerContent.includes(full) || aliasHit) score += 3;
  }
  return score;
}

/** A short excerpt around the first query match, for search results. */
export function snippetOf(content, queryTokens, full, maxChars = 160) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return '';
  const lower = text.toLowerCase();
  const needles = [full, ...queryTokens].filter((value) => typeof value === 'string' && value.length > 0);
  let at = -1;
  for (const needle of needles) {
    const index = lower.indexOf(needle.toLowerCase());
    if (index >= 0 && (at < 0 || index < at)) at = index;
  }
  if (at < 0) return [...text].slice(0, maxChars).join('');
  const start = Math.max(0, at - Math.floor(maxChars / 3));
  const slice = [...text.slice(start)].slice(0, maxChars).join('');
  return start > 0 ? `…${slice}` : slice;
}

// ---------------------------------------------------------------------- store

/** A failure the HTTP layer maps to a specific status; the store stays transport-agnostic. */
function memoryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Locate one note's file in a directory the caller already holds the lock for.
 *
 * Resolution order matches `readNote`: exact `<name>.md`, then a case-insensitive file
 * match, then the parsed frontmatter name (a note renamed on disk keeps its identity),
 * then an alias. `rawName` is the caller's original name: an alias may contain
 * characters `safeName` rewrites, so both forms are matched.
 *
 * @param {string} dir
 * @param {string} safe - `safeName(rawName)`
 * @param {string} [rawName]
 * @returns {Promise<{ file: string, path: string, note: object } | null>}
 */
async function findNoteFileLocked(dir, safe, rawName = safe) {
  let files;
  try {
    files = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const lower = safe.toLowerCase();
  const rawLower = String(rawName ?? safe).toLowerCase();
  const aliasHit = (note) => aliasesInclude(note.aliases, lower) || aliasesInclude(note.aliases, rawLower);
  let target = files.includes(`${safe}.md`) ? `${safe}.md` : null;
  if (target === null) {
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.md') || file.toLowerCase() === INDEX_NAME.toLowerCase()) continue;
      if (file.replace(/\.md$/i, '').toLowerCase() === lower) {
        target = file;
        break;
      }
    }
  }
  if (target === null) {
    for (const file of files) {
      if (!file.toLowerCase().endsWith('.md') || file.toLowerCase() === INDEX_NAME.toLowerCase()) continue;
      try {
        const note = parseNote(await readFile(join(dir, file), 'utf8'), file);
        if (note.name.toLowerCase() === lower || aliasHit(note)) {
          target = file;
          break;
        }
      } catch {
        /* unreadable candidates cannot match */
      }
    }
  }
  if (target === null) return null;
  const path = join(dir, target);
  let note;
  try {
    note = parseNote(await readFile(path, 'utf8'), target);
  } catch (error) {
    // A file we can see but not read is still a real note: deleting it needs no content,
    // and editing it is refused by `updateNote` (its `error` is set). Throwing here would
    // turn a permission problem into "no such memory".
    note = {
      name: target.replace(/\.md$/i, ''),
      description: '',
      type: 'project',
      content: '',
      aliases: [],
      file: target,
      error: `could not be read (${error?.code ?? error?.message ?? error})`,
    };
  }
  return { file: target, path, note };
}

/**
 * Locate the note that owns `name` as an **alias** (case-insensitive), inside the lock.
 *
 * Only consulted when no note carries that name yet, so an exact file/name match always
 * wins: an alias can never shadow a real note. `null` when no note claims the alias.
 *
 * @returns {Promise<{ file: string, path: string, note: object } | null>}
 */
async function findNoteByAliasLocked(dir, name) {
  const raw = String(name ?? '');
  const rawLower = raw.toLowerCase();
  if (rawLower === '') return null;
  const safeLower = (() => {
    try {
      return safeName(raw).toLowerCase();
    } catch {
      return rawLower;
    }
  })();
  const matches = (aliases) => aliasesInclude(aliases, rawLower) || (safeLower !== rawLower && aliasesInclude(aliases, safeLower));
  let files;
  try {
    files = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  for (const file of files) {
    if (!file.toLowerCase().endsWith('.md') || file.toLowerCase() === INDEX_NAME.toLowerCase()) continue;
    if (file.replace(/\.md$/i, '').toLowerCase() === safeLower) continue;
    try {
      const note = parseNote(await readFile(join(dir, file), 'utf8'), file);
      if (note.name.toLowerCase() === rawLower || note.name.toLowerCase() === safeLower) continue;
      if (matches(note.aliases)) return { file, path: join(dir, file), note };
    } catch {
      /* an unreadable note cannot claim an alias */
    }
  }
  return null;
}

/**
 * Create a memory store over two roots.
 *
 * @param {{
 *   config?: object, roots?: {globalDir: string, projectsDir: string},
 *   env?: Record<string, string|undefined>, home?: string,
 *   now?: () => Date, logger?: {warn?: Function, info?: Function},
 * }} [options]
 */
export function createMemoryStore(options = {}) {
  const config = options.config ?? {};
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const roots = options.roots ?? resolveRoots(config, env, home);
  const limits = resolveLimits(config);
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? console;
  // Secret masking is on unless explicitly switched off (`redaction: false` or
  // `redaction: { enabled: false }`). It is a write-time transformation: the rule table
  // decides what a secret looks like, and the result is irreversible by design.
  const redactionConfig = config?.redaction;
  const redactionEnabled = redactionConfig === false ? false : redactionConfig?.enabled !== false;
  const redactText = (value) => (redactionEnabled ? redactSecrets(value) : { text: String(value ?? ''), count: 0, kinds: [] });
  const redactFields = (input) =>
    redactionEnabled
      ? redactNote(input)
      : {
          description: String(input?.description ?? ''),
          content: String(input?.content ?? ''),
          aliases: Array.isArray(input?.aliases) ? input.aliases.slice() : [],
          count: 0,
          kinds: [],
        };

  /** scopeKey → scan snapshot (entries + problems + index facts) */
  const cache = new Map();
  /** scopeKeys whose cache is stale and should be reloaded at the next turn boundary */
  const dirty = new Set();
  /** scopeKey → serialized refresh promise, so concurrent readers cannot interleave loads */
  const refreshing = new Map();

  const scopeKeyOf = (scope, projectKey) => {
    if (scope === 'global') return 'global';
    if (scope !== 'project') throw new Error(`unknown memory scope: ${JSON.stringify(scope)}`);
    if (typeof projectKey !== 'string' || projectKey === '') {
      throw new Error('a project memory scope requires a project key (the session working directory is unknown)');
    }
    return `project:${projectKey}`;
  };

  const dirForScopeKey = (scopeKey) => {
    if (scopeKey === 'global') return { scope: 'global', key: null, dir: roots.globalDir };
    const key = scopeKey.slice('project:'.length);
    return { scope: 'project', key, dir: join(roots.projectsDir, key, 'memory') };
  };

  const store = {
    roots,
    limits,
    /** Root directory for one scope. */
    dirFor(scope, projectKey) {
      return dirForScopeKey(scopeKeyOf(scope, projectKey)).dir;
    },
    /** Project directories are `<projectsDir>/<key>/memory`; this is the exposed path form. */
    projectDir(key) {
      return join(roots.projectsDir, key, 'memory');
    },

    /**
     * Create the two storage roots.
     *
     * A missing root is an empty store, not an error (reads already return empty state);
     * this is the explicit create the contract asks for, called once when the plugin
     * mounts so a fresh install has real directories to open in the file manager.
     */
    async ensureRoots() {
      await mkdir(roots.globalDir, { recursive: true });
      await mkdir(roots.projectsDir, { recursive: true });
      return { ...roots };
    },

    // ---------------------------------------------------------------- reads

    /**
     * Read one note from disk (always fresh — tools must see external edits).
     * @returns {Promise<{note: object, path: string, updatedAt: string, scope: string} | null>}
     */
    async readNote({ scope, projectKey, name }) {
      const safe = safeName(name);
      const directory = dirForScopeKey(scopeKeyOf(scope, projectKey));
      const path = join(directory.dir, `${safe}.md`);
      const tryRead = async (candidate) => {
        try {
          const [text, info] = await Promise.all([readFile(candidate, 'utf8'), stat(candidate)]);
          const note = parseNote(text, candidate.split(/[\\/]/).pop());
          return { note, path: candidate, updatedAt: info.mtime.toISOString(), scope: directory.scope };
        } catch (error) {
          if (error?.code === 'ENOENT') return null;
          throw error;
        }
      };
      const exact = await tryRead(path);
      if (exact !== null) return exact;
      let names;
      try {
        names = await readdir(directory.dir);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      const lower = safe.toLowerCase();
      const rawLower = String(name ?? '').toLowerCase();
      for (const file of names) {
        if (!file.toLowerCase().endsWith('.md') || file.toLowerCase() === INDEX_NAME.toLowerCase()) continue;
        const candidate = join(directory.dir, file);
        const hit = await tryRead(candidate);
        if (hit === null) continue;
        if (
          hit.note.name.toLowerCase() === lower ||
          file.replace(/\.md$/i, '').toLowerCase() === lower ||
          aliasesInclude(hit.note.aliases, lower) ||
          aliasesInclude(hit.note.aliases, rawLower)
        ) {
          return hit;
        }
      }
      return null;
    },

    /** Read every note in one scope (fresh scan). */
    async readScope(scope, projectKey) {
      const target = dirForScopeKey(scopeKeyOf(scope, projectKey));
      return scanDirectory(target.dir, target.scope, target.key, now);
    },

    /** Read both scopes that a request covers (`scope: all`). */
    async readScopes(scope, projectKey) {
      const targets = [];
      if (scope === 'global' || scope === 'all') targets.push({ scope: 'global', key: null });
      if ((scope === 'project' || scope === 'all') && typeof projectKey === 'string' && projectKey !== '') {
        targets.push({ scope: 'project', key: projectKey });
      }
      const scans = [];
      for (const target of targets) scans.push(await store.readScope(target.scope, target.key));
      return scans;
    },

    // --------------------------------------------------------------- writes

    /**
     * Create or replace one note and its index row under the directory lock.
     *
     * `expect` turns the write into a guarded create/update for callers that must not
     * race another writer: `'absent'` fails with `code: 'conflict'` when the note
     * appeared, `'present'` fails with `code: 'not-found'` when it disappeared. The
     * check and the write happen inside the same lock, so the answer is not stale.
     *
     * Two rules keep one fact in one note:
     *   - rewriting an existing note **keeps its aliases** (a plain rewrite must not
     *     silently drop names the note is also known by);
     *   - writing under another note's alias is a **metadata-only merge**: the alias is
     *     recorded on the owner and `viaAlias` names the request, but the owner's
     *     description/content/type are never overwritten by a differently-named write.
     *
     * @param {{ scope: string, projectKey?: string, name: string, description: string,
     *   content: string, type?: string, aliases?: string[], expect?: 'any'|'absent'|'present' }} input
     * @returns {Promise<{path: string, name: string, scope: string, type: string, created: boolean,
     *   updatedAt: string, aliases: string[], redacted: number, viaAlias: string|null}>}
     */
    async writeNote({ scope, projectKey, name, description, content, type = 'env', aliases = [], expect = 'any' }) {
      const directory = dirForScopeKey(scopeKeyOf(scope, projectKey));
      const safe = safeName(name);
      const memoryType = String(type).trim().toLowerCase();
      if (!VALID_TYPES.includes(memoryType)) {
        throw memoryError('bad-request', `invalid type ${JSON.stringify(type)}; use ${VALID_TYPES.join(' / ')} (${TYPE_DESCRIPTIONS[memoryType] ?? 'unknown category'})`);
      }
      // Redaction happens here — the single write entry for the tools, `POST /entry`, and
      // candidate adoption — and before anything is formatted, indexed, or written.
      const redaction = redactFields({ description, content, aliases });
      if (cleanDescription(redaction.description) === '') throw memoryError('bad-request', 'description is required (one-line summary used by search and the index)');
      if (cleanContent(redaction.content) === '') throw memoryError('bad-request', 'content is required');

      let path = join(directory.dir, `${safe}.md`);
      let writeName = safe;
      let created = false;
      let viaAlias = null;
      let storedAliases = normalizeAliases(redaction.aliases, safe);
      await mkdir(directory.dir, { recursive: true });
      await withDirLock(directory.dir, async () => {
        // Re-stat inside the lock: another writer may have created the note since the
        // caller's read, and `created` is part of the tool result.
        try {
          await stat(path);
          created = false;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          created = true;
        }
        if (created) {
          // No note carries this name yet. If it is somebody else's *alias*, the write
          // records the alias on that note instead of creating a second one — checked
          // inside the lock so two writers cannot both decide to create.
          const owner = await findNoteByAliasLocked(directory.dir, name);
          if (owner !== null) {
            if (expect === 'absent') {
              throw memoryError(
                'conflict',
                `a memory named ${JSON.stringify(safe)} already exists in the ${directory.scope} scope (as an alias of ${JSON.stringify(owner.note.name)})`,
              );
            }
            path = owner.path;
            created = false;
            writeName = owner.file.replace(/\.md$/i, '');
            viaAlias = String(name);
            const mergedAliases = normalizeAliases([...owner.note.aliases, ...redaction.aliases, safe], writeName);
            // Only the alias list may change here; the owner's body is not this caller's
            // to replace, and `redacted` is therefore 0 (nothing was stored).
            if (JSON.stringify(mergedAliases) !== JSON.stringify(normalizeAliases(owner.note.aliases, writeName))) {
              await writeTextAtomic(
                owner.path,
                formatNote({ name: writeName, description: owner.note.description, type: owner.note.type, content: owner.note.content, aliases: mergedAliases }),
              );
            }
            storedAliases = mergedAliases;
            return;
          }
        } else {
          // An existing note keeps the aliases it already had: a rewrite updates the
          // summary and body, never the other names it can be found under.
          try {
            const existing = parseNote(await readFile(path, 'utf8'), `${writeName}.md`);
            storedAliases = normalizeAliases([...existing.aliases, ...redaction.aliases], writeName);
          } catch {
            /* unreadable: keep the incoming list rather than failing the write */
          }
        }
        if (expect === 'absent' && created === false) {
          throw memoryError('conflict', `a memory named ${JSON.stringify(writeName)} already exists in the ${directory.scope} scope`);
        }
        if (expect === 'present' && created === true) {
          throw memoryError('not-found', `no memory named ${JSON.stringify(safe)} exists in the ${directory.scope} scope`);
        }
        await writeTextAtomic(path, formatNote({ name: writeName, description: redaction.description, type: memoryType, content: redaction.content, aliases: storedAliases }));
        await rewriteIndexLocked(directory.dir, [writeName, safe], cleanDescription(redaction.description));
      });

      const updatedAt = now().toISOString();
      await store.refresh(scope, projectKey).catch((error) => {
        logger?.warn?.(`[dsh-memory-manager] digest cache refresh after write failed: ${error?.message ?? error}`);
      });
      store.markDirty(scope, projectKey);
      return {
        path,
        name: writeName,
        scope: directory.scope,
        type: memoryType,
        created,
        updatedAt,
        aliases: storedAliases,
        redacted: viaAlias === null ? redaction.count : 0,
        viaAlias,
      };
    },

    /**
     * Update an existing note, merging the supplied fields over the note on disk.
     *
     * The read, merge, and write all happen under one directory lock, so an update
     * cannot resurrect a note deleted by another writer and cannot lose a concurrent
     * change to a field the caller did not send. A note whose frontmatter is corrupt is
     * refused (`bad-request`) rather than silently rewritten over the user's text —
     * that is the one case where merging would guess.
     *
     * Only the fields the caller *supplied* are redacted and rewritten: a
     * description-only edit leaves the stored body byte-for-byte untouched. An empty or
     * omitted `aliases` keeps the aliases already on disk (there is no clear-aliases
     * surface yet), so a partial update cannot silently drop them.
     *
     * @returns {Promise<{path: string, name: string, scope: string, type: string, created: false,
     *   updatedAt: string, aliases: string[], redacted: number}>}
     */
    async updateNote({ scope, projectKey, name, description, content, type, aliases }) {
      const directory = dirForScopeKey(scopeKeyOf(scope, projectKey));
      const safe = safeName(name);
      let result;
      await withDirLock(directory.dir, async () => {
        const hit = await findNoteFileLocked(directory.dir, safe, name);
        if (hit === null) throw memoryError('not-found', `no memory named ${JSON.stringify(safe)} exists in the ${directory.scope} scope`);
        if (hit.note.error !== null) {
          throw memoryError('bad-request', `the existing note ${hit.file} has invalid frontmatter (${hit.note.error}); fix it on disk before editing`);
        }
        const fileStem = hit.file.replace(/\.md$/i, '');
        const descriptionRedaction = description === undefined ? null : redactText(description);
        const contentRedaction = content === undefined ? null : redactText(content);
        const mergedDescription = descriptionRedaction === null ? hit.note.description : descriptionRedaction.text;
        const mergedContent = contentRedaction === null ? hit.note.content : contentRedaction.text;
        const mergedType = String(type ?? hit.note.type).trim().toLowerCase();
        if (!VALID_TYPES.includes(mergedType)) {
          throw memoryError('bad-request', `invalid type ${JSON.stringify(type ?? hit.note.type)}; use ${VALID_TYPES.join(' / ')}`);
        }
        const requestedAliases = Array.isArray(aliases) && aliases.length > 0 ? aliases : hit.note.aliases;
        let aliasRedactions = 0;
        const mergedAliases = normalizeAliases(requestedAliases, fileStem).map((alias) => {
          const redaction = redactText(alias);
          aliasRedactions += redaction.count;
          return redaction.text;
        });
        if (cleanDescription(mergedDescription) === '') throw memoryError('bad-request', 'description is required (one-line summary used by search and the index)');
        if (cleanContent(mergedContent) === '') throw memoryError('bad-request', 'content is required');
        await writeTextAtomic(
          hit.path,
          formatNote({ name: fileStem, description: mergedDescription, type: mergedType, content: mergedContent, aliases: mergedAliases }),
        );
        await rewriteIndexLocked(directory.dir, [fileStem], cleanDescription(mergedDescription));
        result = {
          path: hit.path,
          name: fileStem,
          scope: directory.scope,
          type: mergedType,
          created: false,
          updatedAt: now().toISOString(),
          aliases: mergedAliases,
          redacted: (descriptionRedaction?.count ?? 0) + (contentRedaction?.count ?? 0) + aliasRedactions,
        };
      });
      await store.refresh(scope, projectKey).catch((error) => {
        logger?.warn?.(`[dsh-memory-manager] digest cache refresh after update failed: ${error?.message ?? error}`);
      });
      store.markDirty(scope, projectKey);
      return result;
    },

    /**
     * Delete one note and its index row.
     *
     * Resolution is `findNoteFileLocked`'s: exact file, case-insensitive file stem,
     * frontmatter name, then alias — so the note the user names is the note that goes.
     * The result names the note that was actually deleted, which is what a delete by
     * alias has to report back (`viaAlias` keeps the request).
     *
     * @returns {Promise<{deleted: boolean, path: string|null, scope: string, name: string|null, viaAlias: string|null}>}
     */
    async deleteNote({ scope, projectKey, name }) {
      const directory = dirForScopeKey(scopeKeyOf(scope, projectKey));
      const safe = safeName(name);
      let removedPath = null;
      let removedName = null;
      try {
        await stat(directory.dir);
      } catch (error) {
        if (error?.code === 'ENOENT') return { deleted: false, path: null, scope: directory.scope, name: null, viaAlias: null };
        throw error;
      }
      await withDirLock(directory.dir, async () => {
        const hit = await findNoteFileLocked(directory.dir, safe, name);
        if (hit === null) return;
        removedPath = hit.path;
        removedName = hit.file.replace(/\.md$/i, '');
        await unlink(removedPath);
        await rewriteIndexLocked(directory.dir, [removedName, safe], null, { removeOnly: true });
      });

      if (removedPath !== null) {
        await store.refresh(scope, projectKey).catch((error) => {
          logger?.warn?.(`[dsh-memory-manager] digest cache refresh after delete failed: ${error?.message ?? error}`);
        });
        store.markDirty(scope, projectKey);
      }
      const viaAlias = removedName !== null && removedName.toLowerCase() !== safe.toLowerCase() ? String(name) : null;
      return { deleted: removedPath !== null, path: removedPath, scope: directory.scope, name: removedName, viaAlias };

      if (removedPath !== null) {
        await store.refresh(scope, projectKey).catch((error) => {
          logger?.warn?.(`[dsh-memory-manager] digest cache refresh after delete failed: ${error?.message ?? error}`);
        });
        store.markDirty(scope, projectKey);
      }
      return { deleted: removedPath !== null, path: removedPath, scope: directory.scope };
    },

    // -------------------------------------------------------------- queries

    /**
     * Keyword search over one or both scopes, with the global-memory scoring.
     * @returns {Promise<{hits: Array<object>, total: number}>}
     */
    async search({ query, scope = 'all', type, limit = 8, projectKey }) {
      const trimmed = String(query ?? '').trim();
      if (trimmed === '') throw new Error('query is required');
      if (scope === 'project' && (typeof projectKey !== 'string' || projectKey === '')) {
        throw new Error('scope=project requires a project context (the session working directory is unknown)');
      }
      const scans = await store.readScopes(scope, projectKey);
      const queryTokens = tokenize(trimmed);
      const full = trimmed.toLowerCase();
      const wantedType = typeof type === 'string' && type !== '' ? type.toLowerCase() : null;
      const hits = [];
      for (const scan of scans) {
        for (const note of scan.entries) {
          if (wantedType !== null && note.type !== wantedType) continue;
          const score = scoreNote(note, queryTokens, full);
          if (score <= 0) continue;
          hits.push({
            name: note.name,
            description: note.description,
            type: note.type,
            scope: scan.scope,
            score,
            snippet: snippetOf(note.content, queryTokens, full),
            path: note.path,
            updatedAt: note.updatedAt,
          });
        }
      }
      hits.sort((left, right) => right.score - left.score || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      const capped = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 8, 50));
      return { hits: hits.slice(0, capped), total: hits.length };
    },

    /**
     * Notes in one scope that look like the same fact as `{ name, description, content }`.
     *
     * This is the write-time dedupe hint: `memory_write` calls it before writing and
     * reports the result without blocking the write, so the model can decide to rewrite
     * one note instead of accumulating near-duplicates. Zero dependencies, zero model
     * calls — Jaccard overlap over the same CJK-bigram tokenizer `memory_search` uses.
     *
     * @param {{ scope: string, projectKey?: string, name?: string, description?: string,
     *   content?: string, limit?: number, threshold?: number }} input
     * @returns {Promise<Array<{name: string, description: string, scope: string, score: number}>>}
     */
    async similarNotes({ scope, projectKey, name, description, content, limit = 3, threshold = 0.3 }) {
      const queryTokens = tokenize(
        [name, description, String(content ?? '').slice(0, 600)]
          .filter((part) => typeof part === 'string' && part.trim() !== '')
          .join(' '),
      );
      if (queryTokens.size === 0) return [];
      const lowerName = String(name ?? '').trim().toLowerCase();
      const scan = await store.readScope(scope, projectKey);
      const hits = [];
      for (const entry of scan.entries) {
        if (entry.name.toLowerCase() === lowerName) continue;
        const tokens = tokenize([entry.name, entry.description, String(entry.content ?? '').slice(0, 600)].join(' '));
        if (tokens.size === 0) continue;
        let shared = 0;
        for (const token of queryTokens) if (tokens.has(token)) shared += 1;
        const union = queryTokens.size + tokens.size - shared;
        const score = union === 0 ? 0 : shared / union;
        if (score < threshold) continue;
        hits.push({ name: entry.name, description: entry.description, scope: scan.scope, score: Math.round(score * 100) / 100 });
      }
      hits.sort((left, right) => right.score - left.score || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      return hits.slice(0, Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 3, 10)));
    },

    /**
     * List index rows from disk, optionally filtered by type.
     * @returns {Promise<{entries: Array<object>, total: number}>}
     */
    async list({ scope = 'all', type, limit = 100, projectKey }) {
      if (scope === 'project' && (typeof projectKey !== 'string' || projectKey === '')) {
        throw new Error('scope=project requires a project context (the session working directory is unknown)');
      }
      const scans = await store.readScopes(scope, projectKey);
      const wantedType = typeof type === 'string' && type !== '' ? type.toLowerCase() : null;
      const entries = [];
      for (const scan of scans) {
        for (const note of scan.entries) {
          if (wantedType !== null && note.type !== wantedType) continue;
          entries.push(publicEntry(note, scan.scope));
        }
      }
      entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
      const capped = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 100, 500));
      return { entries: entries.slice(0, capped), total: entries.length };
    },

    /** Fresh list of both scopes for the HTTP layer (keeps `scope` on each row). */
    async listEntries({ scope = 'all', type, query, limit = 100, projectKey }) {
      if (typeof query === 'string' && query.trim() !== '') {
        const { hits, total } = await store.search({ query, scope, type, limit, projectKey });
        return {
          entries: hits.map((hit) => ({
            name: hit.name,
            description: hit.description,
            type: hit.type,
            scope: hit.scope,
            updatedAt: hit.updatedAt ?? null,
            path: hit.path ?? null,
            score: hit.score,
            snippet: hit.snippet,
          })),
          total,
        };
      }
      const { entries, total } = await store.list({ scope, type, limit, projectKey });
      return { entries, total };
    },

    // ------------------------------------------------------- digest cache

    /**
     * The synchronous digest for one project. Called by `systemPrompt.section.text`
     * on every model step, so it must never await or touch the filesystem.
     * @param {string|null} projectKey
     * @returns {string}
     */
    digestFor(projectKey) {
      const global = cache.get('global') ?? null;
      const project = typeof projectKey === 'string' && projectKey !== '' ? cache.get(`project:${projectKey}`) ?? null : null;
      if (global === null && project === null) return '';
      try {
        return renderDigest({ global, project, limits });
      } catch (error) {
        logger?.warn?.(`[dsh-memory-manager] digest rendering failed: ${error?.message ?? error}`);
        return '';
      }
    },

    /** The cached snapshot for one scope (or null). */
    snapshot(scope, projectKey) {
      try {
        return cache.get(scopeKeyOf(scope, projectKey)) ?? null;
      } catch {
        return null;
      }
    },

    /** Cache facts for `GET /digest`. */
    digestInfo(projectKey) {
      const global = cache.get('global') ?? null;
      const project = typeof projectKey === 'string' && projectKey !== '' ? cache.get(`project:${projectKey}`) ?? null : null;
      const digest = store.digestFor(projectKey);
      return {
        digest,
        tokenEstimate: digestTokens(digest),
        global: { count: global?.entries.length ?? 0, dir: roots.globalDir, ready: global !== null },
        project:
          project !== null
            ? { count: project.entries.length, key: projectKey, dir: project.dir, name: projectName(projectKey), ready: true }
            : null,
        ready: { global: global !== null, project: project !== null },
      };
    },

    /** Load one scope into the cache. */
    async refresh(scope, projectKey) {
      const scopeKey = scopeKeyOf(scope, projectKey);
      const previous = refreshing.get(scopeKey) ?? Promise.resolve();
      const task = previous.then(
        () => store.loadScopeKey(scopeKey),
        () => store.loadScopeKey(scopeKey),
      );
      const guard = task
        .catch(() => {})
        .finally(() => {
          if (refreshing.get(scopeKey) === guard) refreshing.delete(scopeKey);
        });
      refreshing.set(scopeKey, guard);
      return task;
    },

    /** Internal: scan one scopeKey into the cache. */
    async loadScopeKey(scopeKey) {
      const target = dirForScopeKey(scopeKey);
      const snapshot = await scanDirectory(target.dir, target.scope, target.key, now);
      cache.set(scopeKey, snapshot);
      dirty.delete(scopeKey);
      return snapshot;
    },

    /** Warm a scope only if it was never loaded. */
    async prefetch(scope, projectKey) {
      const scopeKey = scopeKeyOf(scope, projectKey);
      if (cache.has(scopeKey)) return cache.get(scopeKey);
      return store.refresh(scope, projectKey);
    },

    /** Warm the global scope plus the current project scope. */
    async prefetchFor(projectKey) {
      await Promise.all([store.prefetch('global'), typeof projectKey === 'string' && projectKey !== '' ? store.prefetch('project', projectKey) : Promise.resolve(null)]);
    },

    /** Mark one scope stale. */
    markDirty(scope, projectKey) {
      try {
        dirty.add(scopeKeyOf(scope, projectKey));
      } catch {
        /* an unresolvable scope has nothing to refresh */
      }
    },

    /** Mark every cached scope stale (external edits converge at the next turn boundary). */
    markAllCachedDirty() {
      for (const scopeKey of cache.keys()) dirty.add(scopeKey);
    },

    /** Reload every stale scope. Failures keep the previous cache and are logged. */
    async refreshDirty() {
      const keys = [...dirty];
      for (const scopeKey of keys) {
        try {
          await store.loadScopeKey(scopeKey);
        } catch (error) {
          logger?.warn?.(`[dsh-memory-manager] refreshing ${scopeKey} failed: ${error?.message ?? error}`);
        }
      }
      return keys.length;
    },

    /** Drop one project's cache (agent disposed). */
    forget(projectKey) {
      if (typeof projectKey !== 'string' || projectKey === '') return;
      const scopeKey = `project:${projectKey}`;
      cache.delete(scopeKey);
      dirty.delete(scopeKey);
    },

    // --------------------------------------------------------- diagnostics

    /**
     * Fresh consistency report for `GET /diagnostics`.
     * @param {{projectKey?: string|null}} [options]
     */
    async diagnostics({ projectKey = null } = {}) {
      const global = await scanDirectory(roots.globalDir, 'global', null, now);
      const project = typeof projectKey === 'string' && projectKey !== '' ? await scanDirectory(join(roots.projectsDir, projectKey, 'memory'), 'project', projectKey, now) : null;
      const projects = await store.listProjectDirs(projectKey);
      const globalLock = join(roots.globalDir, '.memory.lock');
      const projectLock = project !== null ? join(project.dir, '.memory.lock') : null;
      const problems = [...global.problems, ...(project?.problems ?? [])];
      const ok = problems.every((problem) => problem.level !== 'error');
      const writer = await atomicWriteBackend();
      return {
        ok,
        writer,
        generatedAt: now().toISOString(),
        paths: { globalDir: roots.globalDir, projectsDir: roots.projectsDir, currentProjectDir: project?.dir ?? null },
        lock: {
          path: globalLock,
          held: existsSync(globalLock) || (projectLock !== null && existsSync(projectLock)),
          projectPath: projectLock,
          projectHeld: projectLock !== null ? existsSync(projectLock) : false,
        },
        projects,
        project: project !== null ? { key: projectKey, dir: project.dir, name: projectName(projectKey), count: project.entries.length } : null,
        problems,
        scopes: [
          { scope: 'global', key: null, dir: global.dir, exists: global.exists, notes: global.entries.length, indexRows: global.indexRows?.length ?? null, indexSize: global.indexSize, problems: global.problems.length },
          ...(project !== null
            ? [{ scope: 'project', key: projectKey, dir: project.dir, exists: project.exists, notes: project.entries.length, indexRows: project.indexRows?.length ?? null, indexSize: project.indexSize, problems: project.problems.length }]
            : []),
        ],
      };
    },

    /** Project directories under `projectsDir`, annotated for the settings page's switcher. */
    async listProjectDirs(currentKey = null) {
      let entries;
      try {
        entries = await readdir(roots.projectsDir, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      const projects = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !isProjectKey(entry.name)) continue;
        const dir = join(roots.projectsDir, entry.name, 'memory');
        let count = 0;
        let updatedAt = null;
        let exists = false;
        try {
          const files = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.md') && name.toLowerCase() !== INDEX_NAME.toLowerCase());
          exists = true;
          count = files.length;
          for (const file of files) {
            const info = await stat(join(dir, file));
            if (updatedAt === null || info.mtime.toISOString() > updatedAt) updatedAt = info.mtime.toISOString();
          }
        } catch {
          /* a project directory without memory/ is listed with count 0 */
        }
        projects.push({
          key: entry.name,
          dir,
          name: projectName(entry.name),
          count,
          updatedAt,
          current: entry.name === currentKey,
          exists,
        });
      }
      projects.sort((left, right) => {
        const leftTime = left.updatedAt ?? '';
        const rightTime = right.updatedAt ?? '';
        if (leftTime !== rightTime) return leftTime < rightTime ? 1 : -1;
        return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
      });
      return projects;
    },

    /** A count-only summary used by `GET /digest` callers. */
    async countProject(projectKey) {
      try {
        const files = await readdir(join(roots.projectsDir, projectKey, 'memory'));
        return files.filter((name) => name.toLowerCase().endsWith('.md') && name.toLowerCase() !== INDEX_NAME.toLowerCase()).length;
      } catch {
        return 0;
      }
    },
  };

  return store;
}

/** The human name of a project key: the slug part, without the hash. */
export function projectName(projectKey) {
  if (typeof projectKey !== 'string' || projectKey === '') return null;
  const slug = projectKey.slice(0, Math.max(0, projectKey.length - KEY_HASH_LENGTH - 1));
  return slug === '' ? projectKey : slug;
}

/**
 * Rewrite `MEMORY.md` from a **fresh read taken inside the caller's lock**: keep every
 * row that is not one of the target names, drop trailing blank lines, append the new
 * row. This is the defect fix for server.py's unlocked read-modify-write.
 *
 * @param {string} dir
 * @param {string[]} names - note names whose index rows are replaced/removed
 * @param {string|null} description - the new description, or `null` to only remove
 * @param {{removeOnly?: boolean}} [options]
 */
async function rewriteIndexLocked(dir, names, description, options = {}) {
  const indexPath = join(dir, INDEX_NAME);
  let lines;
  try {
    lines = (await readFile(indexPath, 'utf8')).split(/\r?\n/);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    lines = [];
  }
  const targets = new Set(names);
  const kept = lines.filter((line) => ![...targets].some((name) => indexLineMatches(line, name)));
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  if (options.removeOnly !== true) kept.push(indexLine(names[0], description ?? ''));
  const text = kept.length > 0 ? `${kept.join('\n')}\n` : '';
  await writeTextAtomic(indexPath, text);
}

/** Re-exported so callers (and the smoke test) can derive keys without importing two modules. */
export { projectKeyOf, slugOf, isProjectKey };
