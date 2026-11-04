/**
 * dsh-skill-manager — root scanning (one level deep, exactly like the host).
 *
 * Discovery reproduces `@deepseek-ai/dsh-skill-filesystem`:
 *   root/<name>/SKILL.md   → directory bundle
 *   root/<name>.md         → flat file
 * plus this plugin's parked directory `_disabled/` (a disabled skill keeps its
 * files and merely leaves the scanned surface) and `_trash/` (deleted skills).
 *
 * Nothing here writes: the scanner is the read side of the panel.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { analyzeContent, hasErrorIssue, mergeIssues, stripBom } from './parse.js';
import { DISABLED_DIR, RESERVED_ENTRIES, TRASH_DIR } from './roots.js';

/** Hard cap for the resource walk inside one skill directory. */
const RESOURCE_FILE_CAP = 2000;

/** Sha256 of a decoded string's UTF-8 bytes — the panel's optimistic-concurrency token. */
export function contentHash(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** Whether `candidate` is `root` itself or below it (case-insensitive on Windows). */
export function isInside(root, candidate) {
  const base = resolve(root);
  const target = resolve(candidate);
  const same = process.platform === 'win32' ? base.toLowerCase() === target.toLowerCase() : base === target;
  if (same) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return process.platform === 'win32'
    ? target.toLowerCase().startsWith(prefix.toLowerCase())
    : target.startsWith(prefix);
}

/** A skill entry name we are willing to touch: one ordinary path segment. */
export function isSafeSegment(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    !RESERVED_ENTRIES.has(name)
  );
}

/** Absolute path of a skill's instruction file. */
export function skillFilePath(root, dirName, kind, state) {
  const base = state === 'disabled' ? join(root.path, DISABLED_DIR) : root.path;
  return kind === 'directory' ? join(base, dirName, 'SKILL.md') : join(base, `${dirName}.md`);
}

/** Absolute path of the skill entry itself (its directory, or the flat file). */
export function skillEntryPath(root, dirName, kind, state) {
  const base = state === 'disabled' ? join(root.path, DISABLED_DIR) : root.path;
  return kind === 'directory' ? join(base, dirName) : join(base, `${dirName}.md`);
}

/** Directory used to park disabled skills of one root. */
export function disabledDirOf(root) {
  return join(root.path, DISABLED_DIR);
}

/** Directory used as the trash of one root. */
export function trashDirOf(root) {
  return join(root.path, TRASH_DIR);
}

/** `stat` that treats a missing path as `undefined`. */
async function statOrUndefined(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** Resolve a directory entry's kind, following symlinks/junctions. */
async function entryKind(entryPath, dirent) {
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  if (!dirent.isSymbolicLink()) return undefined;
  const info = await statOrUndefined(entryPath);
  if (info === undefined) return undefined;
  if (info.isDirectory()) return 'directory';
  if (info.isFile()) return 'file';
  return undefined;
}

/** Count files (and the conventional resource folders) inside one skill directory. */
async function countResources(dir, depth = 0) {
  const result = { files: 0, references: 0, scripts: 0, assets: 0 };
  if (depth > 3) return result;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (result.files >= RESOURCE_FILE_CAP) break;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await countResources(full, depth + 1);
      result.files += nested.files;
      if (depth === 0 && entry.name === 'references') result.references = nested.files;
      else if (depth === 0 && entry.name === 'scripts') result.scripts = nested.files;
      else if (depth === 0 && entry.name === 'assets') result.assets = nested.files;
      continue;
    }
    result.files += 1;
  }
  return result;
}

/**
 * Build one skill record from disk.
 *
 * @param {object} root - resolved root row
 * @param {string} dirName - entry name without `.md`
 * @param {'directory' | 'file'} kind
 * @param {boolean} disabled - whether the entry sits in `_disabled/`
 */
export async function buildSkill(root, dirName, kind, disabled) {
  const state = disabled ? 'disabled' : 'enabled';
  const path = skillFilePath(root, dirName, kind, state);
  const entryPath = skillEntryPath(root, dirName, kind, state);
  const issues = [];
  let raw = '';
  let size = 0;
  let mtimeMs = 0;

  try {
    const info = await stat(path);
    size = info.size;
    mtimeMs = info.mtimeMs;
    raw = await readFile(path, 'utf8');
  } catch (error) {
    issues.push({
      level: 'error',
      code: 'read-error',
      message: `读取失败：${error?.message ?? String(error)}`,
    });
  }

  const analysis = analyzeContent(raw, { dirName, kind });
  const merged = mergeIssues(analysis.issues, issues);
  const effectiveState = hasErrorIssue(merged) ? 'invalid' : state;
  const resources = kind === 'directory' ? await countResources(entryPath) : undefined;

  return {
    key: `${root.id}/${dirName}`,
    rootId: root.id,
    rootLabel: root.label,
    rootPath: root.path,
    source: root.source,
    rank: root.rank,
    writable: root.writable === true,
    dirName,
    kind,
    state: effectiveState,
    name: analysis.name,
    description: analysis.description,
    ...(analysis.whenToUse === undefined ? {} : { whenToUse: analysis.whenToUse }),
    invocation: analysis.invocation,
    path,
    bodyChars: stripBom(analysis.body).trim().length,
    size,
    mtimeMs,
    hash: contentHash(raw),
    issues: merged,
    shadowed: false,
    ...(resources === undefined ? {} : { resources }),
    ...(analysis.data === null ? {} : { meta: analysis.data }),
  };
}

/** Scan one root, appending root-level diagnostics. */
async function scanRoot(root, diagnostics) {
  const skills = [];
  let entries;
  try {
    entries = await readdir(root.path, { withFileTypes: true });
  } catch (error) {
    diagnostics.push({
      code: 'read-error',
      message: `根目录读取失败：${error?.message ?? String(error)}`,
      rootId: root.id,
      path: root.path,
    });
    return skills;
  }

  const seen = new Map();

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (RESERVED_ENTRIES.has(entry.name)) continue;
    if (entry.name === '.system' && root.skipSystem === true) continue;
    const entryPath = join(root.path, entry.name);
    let kind;
    try {
      kind = await entryKind(entryPath, entry);
    } catch {
      continue;
    }
    if (kind === undefined) continue;
    if (kind === 'file' && !entry.name.toLowerCase().endsWith('.md')) continue;
    const dirName = kind === 'file' ? entry.name.replace(/\.md$/i, '') : entry.name;
    if (!isSafeSegment(dirName)) continue;
    if (kind === 'directory') {
      const skillMd = await statOrUndefined(join(entryPath, 'SKILL.md'));
      if (skillMd === undefined || !skillMd.isFile()) continue;
    }
    const skill = await buildSkill(root, dirName, kind, false);
    skills.push(skill);
  }

  // Parked (disabled) entries are listed too: the panel's job is to make them
  // visible and reversible, not to hide them the way the model catalog does.
  const parked = join(root.path, DISABLED_DIR);
  let parkedEntries;
  try {
    parkedEntries = await readdir(parked, { withFileTypes: true });
  } catch {
    parkedEntries = [];
  }
  for (const entry of parkedEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = join(parked, entry.name);
    let kind;
    try {
      kind = await entryKind(entryPath, entry);
    } catch {
      continue;
    }
    if (kind === undefined) continue;
    if (kind === 'file' && !entry.name.toLowerCase().endsWith('.md')) continue;
    const dirName = kind === 'file' ? entry.name.replace(/\.md$/i, '') : entry.name;
    if (!isSafeSegment(dirName)) continue;
    if (kind === 'directory') {
      const skillMd = await statOrUndefined(join(entryPath, 'SKILL.md'));
      if (skillMd === undefined || !skillMd.isFile()) continue;
    }
    skills.push(await buildSkill(root, dirName, kind, true));
  }

  // Two entries of the same root resolving to one skill name: the host keeps the
  // first and silently ignores the rest, so report it here instead.
  for (const skill of skills) {
    if (skill.state === 'invalid') continue;
    const existing = seen.get(skill.name);
    if (existing === undefined) {
      seen.set(skill.name, skill);
      continue;
    }
    skill.shadowed = true;
    skill.shadowedBy = { rootId: root.id, rootLabel: root.label };
    skill.issues = mergeIssues(skill.issues, [
      {
        level: 'warn',
        code: 'duplicate-name',
        message: `同一根下已有同名技能 "${skill.name}"（${existing.dirName}），本条目不会被宿主采用。`,
      },
    ]);
  }

  return skills;
}

/**
 * Mark skills hidden by a higher-rank root with the same name.
 * Only enabled, valid skills participate: the host merges by resolved name.
 */
function applyShadowing(skills) {
  const winners = new Map();
  for (const skill of skills) {
    if (skill.state !== 'enabled') continue;
    const winner = winners.get(skill.name);
    if (winner === undefined) {
      winners.set(skill.name, skill);
      continue;
    }
    skill.shadowed = true;
    skill.shadowedBy = { rootId: winner.rootId, rootLabel: winner.rootLabel };
    skill.issues = mergeIssues(skill.issues, [
      {
        level: 'warn',
        code: 'shadowed',
        message: `与 ${winner.rootLabel} 的同名技能 "${skill.name}" 冲突：宿主按根优先级采用更高优先级的那份。`,
      },
    ]);
  }
}

/**
 * Scan every resolved root.
 *
 * @param {{ roots: object[] }} input
 * @returns {Promise<{ skills: object[], diagnostics: object[] }>}
 */
export async function scanAll({ roots }) {
  const diagnostics = [];
  const skills = [];
  for (const root of roots) {
    if (root.exists !== true) {
      diagnostics.push({
        code: 'root-missing',
        message: `根目录不存在：${root.path}`,
        rootId: root.id,
        path: root.path,
      });
      continue;
    }
    skills.push(...(await scanRoot(root, diagnostics)));
  }
  skills.sort((left, right) => {
    if (left.rank !== right.rank) return left.rank - right.rank;
    return left.name.localeCompare(right.name);
  });
  applyShadowing(skills);
  return { skills, diagnostics };
}

/** Find one skill record inside a fresh scan (used by the detail route). */
export async function findSkill({ roots, rootId, dirName, kind, state }) {
  const { skills, diagnostics } = await scanAll({ roots });
  const wantedState = state === 'disabled' ? 'disabled' : 'enabled';
  const skill = skills.find(
    (candidate) =>
      candidate.rootId === rootId &&
      candidate.dirName === dirName &&
      candidate.kind === kind &&
      (candidate.state === wantedState || candidate.state === 'invalid'),
  );
  return { skill, diagnostics, skills };
}

/** Relative path from a root, normalized to forward slashes for display. */
export function displayPathWithin(root, path) {
  try {
    return relative(root, path).split(sep).join('/');
  } catch {
    return path;
  }
}
