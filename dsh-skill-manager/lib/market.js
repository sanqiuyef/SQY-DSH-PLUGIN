/**
 * dsh-skill-manager — the local skills market.
 *
 * This is the clone the workspace already keeps on disk
 * (`<dshHome>/skills-management/market`), not a network store: the panel reads
 * `<market>/skills/<repo>/<folder>/SKILL.md` and installs a folder by copying it
 * into a user skill root. Nothing is fetched, nothing is synced — the market's
 * own updater stays the only writer of the clone.
 *
 * "Installed" is a ledger, not a name match. `<market>/../install-state.json`
 * records one entry per install: the exact `{repo, folder}` it came from, the
 * target root and path, the install time, and the sha256 of every installed
 * file. A hand-written skill that happens to share a name is therefore reported
 * as "name taken", not "installed", and the market's own copy moving on is
 * reported as an update instead of being invisible.
 *
 * This clone holds thousands of skills (6k+ on the reference machine), so the
 * index is parsed with bounded concurrency and cached for a few minutes:
 * a serial pass costs ~45 s, the concurrent cached path ~1.3 s once, then ~0 ms.
 */

import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { badRequest, exists, notFound, readOnly } from './errors.js';
import { analyzeContent } from './parse.js';
import { isInside, isSafeSegment } from './scan.js';

/** How long a parsed market index stays warm. */
const INDEX_TTL_MS = 5 * 60 * 1000;

/** How long the cheap overview counters stay warm. */
const SUMMARY_TTL_MS = 60 * 1000;

/** Parallel SKILL.md reads while building the index. */
const PARSE_CONCURRENCY = 32;

/** Version of the install ledger file below. */
export const INSTALL_STATE_VERSION = 1;

/** Files hashed per installed entry when checking for updates. */
const HASH_FILE_CAP = 200;

/** Files above this size are recorded as "unknown" instead of being hashed. */
const HASH_FILE_MAX_BYTES = 1024 * 1024;

/** marketDir → { at, skills: Array<{repo, folder, name, description, path, issue}> } */
const indexCache = new Map();

/** marketDir → { at, value } */
const summaryCache = new Map();

/** `${sourcePath}|${targetPath}` → { at, status } for the update check. */
const updateCache = new Map();

/** Drop both caches (used by tests and after an install). */
export function clearMarketCache() {
  indexCache.clear();
  summaryCache.clear();
  updateCache.clear();
}

/** Default market location relative to the DSH home. */
export function defaultMarketDir(dshHome) {
  return join(dshHome, 'skills-management', 'market');
}

/** `stat` with ENOENT folded into `undefined`. */
async function statOrUndefined(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Path comparison key: resolved, trimmed, case-insensitive on Windows. */
function pathKey(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  let path = resolve(value);
  if (path.length > 1 && (path.endsWith('/') || path.endsWith('\\'))) path = path.slice(0, -1);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

/** Ledger key: the target root plus the installed entry name. */
function installKey(rootPath, name) {
  return `${pathKey(rootPath)}\u0000${name}`;
}

/** Where the install ledger lives: beside the market clone, like `skills-market-sync.json`. */
export function installStatePath(marketDir) {
  return join(resolve(marketDir), '..', 'install-state.json');
}

/**
 * Read the install ledger. A missing or malformed file reads as an empty ledger:
 * the ledger is bookkeeping, never load-bearing for an install.
 *
 * @param {string} marketDir
 * @returns {Promise<{ version: number, path: string, installed: Record<string, object> }>}
 */
export async function readInstallState(marketDir) {
  const path = installStatePath(marketDir);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    const installed = parsed?.installed;
    if (installed !== null && typeof installed === 'object' && !Array.isArray(installed)) {
      return { version: INSTALL_STATE_VERSION, path, installed };
    }
  } catch {
    /* the ledger appears on the first install */
  }
  return { version: INSTALL_STATE_VERSION, path, installed: {} };
}

/** Write the ledger with a temp file + rename so a crash never leaves half JSON. */
async function writeInstallState(marketDir, installed) {
  const path = installStatePath(marketDir);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify({ version: INSTALL_STATE_VERSION, installed }, null, 2)}\n`;
  try {
    await writeFile(temp, body, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return path;
}

/** Sha256 of one file, or `undefined` when it is too large or unreadable. */
async function hashFile(path) {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > HASH_FILE_MAX_BYTES) return undefined;
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * Hash a skill entry into `{ relativePath: sha256 }`.
 *
 * Keys use forward slashes so a ledger written on one platform still compares on
 * another. Files above {@link HASH_FILE_MAX_BYTES} and files past the cap are
 * skipped, which makes the comparison report `unknown` rather than a false
 * "different".
 *
 * @param {string} entryPath - a skill directory or one `.md` file
 * @returns {Promise<{ files: Record<string, string>, complete: boolean }>}
 */
async function hashTree(entryPath) {
  const files = {};
  let complete = true;
  let count = 0;
  async function walk(dir, prefix, depth) {
    if (depth > 4 || count >= HASH_FILE_CAP) {
      complete = false;
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (count >= HASH_FILE_CAP) {
        complete = false;
        return;
      }
      const full = join(dir, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(full, rel, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const hash = await hashFile(full);
      count += 1;
      if (hash === undefined) complete = false;
      else files[rel] = hash;
    }
  }

  const info = await statOrUndefined(entryPath);
  if (info === undefined) return { files, complete: false };
  if (info.isFile()) {
    const hash = await hashFile(entryPath);
    if (hash === undefined) return { files, complete: false };
    files[basename(entryPath)] = hash;
    return { files, complete };
  }
  await walk(entryPath, '', 0);
  return { files, complete };
}

/**
 * Normalize the file map of a one-file entry.
 *
 * A flat `.md` skill is installed as `<frontmatter name>.md` while the market
 * copy keeps its own file name, so the same bytes land under two different
 * keys. Comparing by content only (one top-level file) keeps an identical copy
 * from reporting "different" forever.
 *
 * @param {Record<string, string>} files
 * @returns {Record<string, string>}
 */
function normalizeEntryFiles(files) {
  const keys = Object.keys(files);
  if (keys.length === 1 && !keys[0].includes('/')) return { '<entry>': files[keys[0]] };
  return files;
}

/**
 * Compare the market's copy of one entry against the recorded install.
 *
 * @param {string} sourcePath - the market-side folder or `.md`
 * @param {object} record - one ledger entry
 * @returns {Promise<'current' | 'different' | 'missing' | 'unknown'>}
 */
async function compareInstall(sourcePath, record) {
  if ((await statOrUndefined(record?.targetPath)) === undefined) return 'missing';
  if (record?.complete === false) return 'unknown';
  const recordedRaw = record?.files;
  if (recordedRaw === null || typeof recordedRaw !== 'object' || Object.keys(recordedRaw).length === 0) return 'unknown';
  const { files, complete } = await hashTree(sourcePath);
  if (Object.keys(files).length === 0) return 'missing';
  // A sampled (incomplete) hash cannot prove equality — say "unknown", never
  // "different", or a skill with one large file would look stale forever.
  if (!complete) return 'unknown';
  const recorded = normalizeEntryFiles(recordedRaw);
  const current = normalizeEntryFiles(files);
  const keys = Object.keys(current);
  if (keys.length !== Object.keys(recorded).length) return 'different';
  for (const key of keys) {
    if (recorded[key] !== current[key]) return 'different';
  }
  return 'current';
}

/**
 * Record one successful install in the ledger. A failure here must never fail
 * the install: the copy already happened, and the ledger is a convenience.
 *
 * @param {{ marketDir: string, repo: string, folder: string, name: string, root: object, targetPath: string }} input
 * @returns {Promise<boolean>} whether the ledger was written
 */
export async function recordInstall({ marketDir, repo, folder, name, root, targetPath }) {
  try {
    const state = await readInstallState(marketDir);
    const { files, complete } = await hashTree(targetPath);
    state.installed[installKey(root.path, name)] = {
      repo,
      folder,
      name,
      rootId: root.id,
      rootPath: resolve(root.path),
      targetPath: resolve(targetPath),
      installedAt: new Date().toISOString(),
      files: normalizeEntryFiles(files),
      // A sampled snapshot cannot prove equality later; carrying the flag keeps
      // compareInstall honest instead of guessing "different".
      complete,
    };
    await writeInstallState(marketDir, state.installed);
    clearMarketCache();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ledger entries narrowed to the roots this request resolved.
 *
 * The ledger is shared by every workspace (it lives beside the market clone), so
 * an install recorded for root A must not surface as "installed" while the panel
 * is pointed at root B: clicking "update" there would move B's same-named local
 * skill into `_trash/`.
 *
 * @param {Record<string, object>} installed
 * @param {string[]} [rootPaths] - absolute roots of the current request; omitted = no narrowing
 * @returns {object[]}
 */
function scopedInstallRecords(installed, rootPaths) {
  const allowed = Array.isArray(rootPaths) && rootPaths.length > 0
    ? new Set(rootPaths.map((path) => pathKey(path)))
    : undefined;
  const records = [];
  for (const record of Object.values(installed ?? {})) {
    if (record === null || typeof record !== 'object') continue;
    if (typeof record.repo !== 'string' || typeof record.folder !== 'string') continue;
    if (allowed !== undefined && !allowed.has(pathKey(record.rootPath))) continue;
    records.push(record);
  }
  return records;
}

/**
 * Index the ledger by `{repo, folder}` so the market view can match exactly.
 *
 * @param {object[]} records
 * @returns {Map<string, object[]>}
 */
function indexInstallState(records) {
  const bySource = new Map();
  for (const record of records) {
    const key = `${record.repo}\u0000${record.folder}`;
    const list = bySource.get(key);
    if (list === undefined) bySource.set(key, [record]);
    else list.push(record);
  }
  return bySource;
}

/** Last sync time of the market clone (marker file, else none). */
async function marketSyncTime(marketDir) {
  const marker = join(marketDir, '..', 'skills-market-sync.json');
  try {
    const parsed = JSON.parse(await readFile(marker, 'utf8'));
    if (typeof parsed?.lastSyncAt === 'string') return parsed.lastSyncAt;
  } catch {
    /* the marker is optional */
  }
  return undefined;
}

/** Parse one candidate market entry; `undefined` when it is not a skill. */
async function readMarketCandidate(candidate) {
  const { repo, folder, path, kind } = candidate;
  try {
    if (kind === 'directory') {
      const skillPath = join(path, 'SKILL.md');
      if ((await statOrUndefined(skillPath)) === undefined) return undefined;
      const raw = await readFile(skillPath, 'utf8');
      const analysis = analyzeContent(raw, { dirName: folder, kind: 'directory' });
      return {
        repo,
        folder,
        name: analysis.name,
        description: analysis.description,
        path,
        ...(analysis.ok ? {} : { issue: '市场条目的 frontmatter 不合法（宿主不会加载）' }),
      };
    }
    const raw = await readFile(path, 'utf8');
    const dirName = folder.replace(/\.md$/i, '');
    const analysis = analyzeContent(raw, { dirName, kind: 'file' });
    return {
      repo,
      folder,
      name: analysis.name,
      description: analysis.description,
      path,
      ...(analysis.ok ? {} : { issue: '市场条目的 frontmatter 不合法（宿主不会加载）' }),
    };
  } catch (error) {
    return { repo, folder, name: folder.replace(/\.md$/i, ''), description: '', path, issue: `读取失败：${error?.message ?? String(error)}` };
  }
}

/**
 * Build (or reuse) the parsed market index.
 *
 * @param {string} marketDir
 * @returns {Promise<Array<object>>} flat skill records carrying `repo`
 */
export async function marketIndex(marketDir) {
  const dir = resolve(marketDir);
  const cached = indexCache.get(dir);
  if (cached !== undefined && Date.now() - cached.at < INDEX_TTL_MS) return cached.skills;

  const root = join(dir, 'skills');
  if ((await statOrUndefined(root)) === undefined) {
    indexCache.set(dir, { at: Date.now(), skills: [] });
    return [];
  }

  let repoEntries;
  try {
    repoEntries = await readdir(root, { withFileTypes: true });
  } catch {
    repoEntries = [];
  }

  const candidates = [];
  for (const repoEntry of repoEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!repoEntry.isDirectory() || repoEntry.name.startsWith('.')) continue;
    const repoPath = join(root, repoEntry.name);
    let folders;
    try {
      folders = await readdir(repoPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const folderEntry of folders.sort((left, right) => left.name.localeCompare(right.name))) {
      if (folderEntry.name.startsWith('.')) continue;
      const isDirectory = folderEntry.isDirectory();
      const isMarkdown = folderEntry.isFile() && folderEntry.name.toLowerCase().endsWith('.md');
      if (!isDirectory && !isMarkdown) continue;
      if (!isSafeSegment(folderEntry.name.replace(/\.md$/i, ''))) continue;
      candidates.push({
        repo: repoEntry.name,
        folder: folderEntry.name,
        path: join(repoPath, folderEntry.name),
        kind: isDirectory ? 'directory' : 'file',
      });
    }
  }

  const parsed = await mapLimit(candidates, PARSE_CONCURRENCY, readMarketCandidate);
  const skills = parsed.filter((entry) => entry !== undefined);
  indexCache.set(dir, { at: Date.now(), skills });
  return skills;
}

/**
 * Cheap market counters for the overview payload: folder counts without parsing.
 *
 * @param {{ marketDir: string, installedNames?: Iterable<string>, installState?: object }} input
 */
export async function marketSummary({ marketDir, installedNames = [], installState, rootPaths }) {
  const dir = resolve(marketDir);
  const cached = summaryCache.get(dir);
  const fresh = cached !== undefined && Date.now() - cached.at < SUMMARY_TTL_MS;
  let value = fresh ? cached.value : undefined;

  if (value === undefined) {
    const root = join(dir, 'skills');
    if ((await statOrUndefined(root)) === undefined) {
      value = { available: false, path: dir, repos: 0, skills: 0 };
    } else {
      let repoEntries;
      try {
        repoEntries = await readdir(root, { withFileTypes: true });
      } catch {
        repoEntries = [];
      }
      let repos = 0;
      let skills = 0;
      for (const repoEntry of repoEntries) {
        if (!repoEntry.isDirectory() || repoEntry.name.startsWith('.')) continue;
        repos += 1;
        let folders;
        try {
          folders = await readdir(join(root, repoEntry.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const folderEntry of folders) {
          if (folderEntry.name.startsWith('.')) continue;
          if (folderEntry.isDirectory()) {
            if ((await statOrUndefined(join(root, repoEntry.name, folderEntry.name, 'SKILL.md'))) !== undefined) skills += 1;
          } else if (folderEntry.name.toLowerCase().endsWith('.md')) {
            skills += 1;
          }
        }
      }
      const syncAt = await marketSyncTime(dir);
      value = { available: true, path: dir, repos, skills, ...(syncAt === undefined ? {} : { lastSyncAt: syncAt }) };
      summaryCache.set(dir, { at: Date.now(), value });
    }
  }

  // With a ledger the number means "installed by this panel into a root of this
  // request", not "a personal root happens to hold the same name"; without one,
  // keep the old count.
  const installed = installState === undefined || installState === null
    ? new Set(installedNames).size
    : scopedInstallRecords(installState.installed, rootPaths).length;
  return { ...value, installed };
}

/**
 * One market entry as the client sees it: exact provenance instead of a name guess.
 *
 * @param {object} entry - one index record
 * @param {{ bySource: Map<string, object[]>, takenNames: Set<string> }} context
 */
async function marketEntryView(entry, context) {
  const records = context.bySource.get(`${entry.repo}\u0000${entry.folder}`);
  const record = records === undefined ? undefined : records[records.length - 1];

  let update;
  if (record !== undefined) {
    const cacheKey = `${entry.path}\u0000${record.targetPath}`;
    const cached = updateCache.get(cacheKey);
    if (cached !== undefined && Date.now() - cached.at < SUMMARY_TTL_MS) {
      update = cached.status;
    } else {
      update = await compareInstall(entry.path, record);
      updateCache.set(cacheKey, { at: Date.now(), status: update });
    }
  }

  return {
    folder: entry.folder,
    name: entry.name,
    description: entry.description,
    path: entry.path,
    installed: record !== undefined,
    // A personal-root skill of the same name that this market entry did not
    // install: installing would be a 409, so say so instead of offering it.
    ...(record === undefined && context.takenNames.has(entry.name) ? { nameTaken: true } : {}),
    ...(record === undefined ? {} : {
      installedAt: record.installedAt,
      installedPath: record.targetPath,
      updateAvailable: update,
    }),
    ...(entry.issue === undefined ? {} : { issue: entry.issue }),
  };
}

/**
 * Filter the index into the market view the client renders.
 *
 * Browsing and searching want different shapes. With no query every repo is
 * returned with a handful of representative skills (the clone holds thousands,
 * so a flat dump would show three repos and hide the other forty-four). A query
 * searches the whole index and returns up to `limit` matches, grouped by repo.
 *
 * @param {{ marketDir: string, installedNames?: Iterable<string>, installState?: object,
 *   rootPaths?: string[], query?: string, limit?: number, perRepo?: number }} input
 */
export async function scanMarket({ marketDir, installedNames = [], installState, rootPaths, query = '', limit = 500, perRepo }) {
  const dir = resolve(marketDir);
  const available = (await statOrUndefined(join(dir, 'skills'))) !== undefined;
  if (!available) {
    return { available: false, path: dir, repos: [], counts: { repos: 0, skills: 0, installed: 0, totalSkills: 0, matching: 0 }, truncated: false };
  }

  const takenNames = new Set(installedNames);
  const bySource = indexInstallState(scopedInstallRecords(installState?.installed, rootPaths));
  const needle = String(query ?? '').trim().toLowerCase();
  const max = Math.max(1, Math.min(500, Number.isFinite(limit) ? Math.trunc(limit) : 500));
  const perRepoLimit = Math.max(
    1,
    Math.min(100, Number.isFinite(perRepo) ? Math.trunc(perRepo) : needle === '' ? 8 : 50),
  );

  const all = await marketIndex(dir);
  const filtered = needle === ''
    ? all
    : all.filter((entry) => `${entry.name} ${entry.description} ${entry.repo} ${entry.folder}`.toLowerCase().includes(needle));

  const byRepo = new Map();
  for (const entry of filtered) {
    const list = byRepo.get(entry.repo);
    if (list === undefined) byRepo.set(entry.repo, [entry]);
    else list.push(entry);
  }

  const context = { bySource, takenNames };
  const repos = [];
  let shown = 0;
  let installedShown = 0;
  for (const [repo, entries] of byRepo) {
    if (shown >= max) break;
    const take = Math.min(perRepoLimit, entries.length, max - shown);
    const skills = await Promise.all(entries.slice(0, take).map((entry) => marketEntryView(entry, context)));
    for (const skill of skills) if (skill.installed) installedShown += 1;
    repos.push({
      repo,
      label: repo,
      total: entries.length,
      skills,
    });
    shown += take;
  }

  return {
    available: true,
    path: dir,
    ...(await marketSyncTime(dir).then((value) => (value === undefined ? {} : { lastSyncAt: value }))),
    repos,
    counts: {
      repos: byRepo.size,
      skills: shown,
      installed: installedShown,
      totalSkills: all.length,
      matching: filtered.length,
    },
    truncated: filtered.length > shown,
  };
}

/**
 * Install one market skill into a writable root by copying its folder.
 *
 * @param {{ marketDir: string, repo: string, folder: string, root: object, overwrite?: boolean }} input
 */
export async function installFromMarket({ marketDir, repo, folder, root, overwrite = false }) {
  const dir = resolve(marketDir);
  if (!isSafeSegment(repo)) throw badRequest(`非法的仓库名：${JSON.stringify(repo)}`);
  if (!isSafeSegment(folder.replace(/\.md$/i, ''))) throw badRequest(`非法的技能目录名：${JSON.stringify(folder)}`);
  if (root === undefined) throw notFound('未知的目标技能根');
  if (root.writable !== true) throw readOnly();
  if (root.exists !== true) throw notFound(`根目录不存在：${root.path}`);

  const source = join(dir, 'skills', repo, folder);
  if (!isInside(join(dir, 'skills'), source)) throw badRequest('市场路径越出市场根');
  const sourceInfo = await statOrUndefined(source);
  if (sourceInfo === undefined) throw notFound(`市场条目不存在：${repo}/${folder}`);

  const index = await marketIndex(dir);
  const record = index.find((entry) => entry.repo === repo && entry.folder === folder);
  if (record === undefined) throw notFound(`市场条目缺少可解析的 SKILL.md：${repo}/${folder}`);
  const name = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.name) ? record.name : folder.replace(/\.md$/i, '');

  const targetDir = join(root.path, name);
  const targetFile = join(root.path, `${name}.md`);
  let existingPath;
  if ((await statOrUndefined(targetDir)) !== undefined) existingPath = targetDir;
  else if ((await statOrUndefined(targetFile)) !== undefined) existingPath = targetFile;

  let replaced = false;
  if (existingPath !== undefined) {
    if (overwrite !== true) throw exists(`用户技能根已存在同名技能：${name}`);
    // Overwrite still never deletes: the previous version is parked in `_trash/`.
    await mkdir(join(root.path, '_trash'), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = join(root.path, '_trash', `${name}@${stamp}`);
    await rename(existingPath, backup);
    replaced = true;
  }

  const stamp = `${process.pid}-${Date.now()}`;
  let targetPath;
  if (sourceInfo.isDirectory()) {
    const staging = join(root.path, `.install-${name}-${stamp}`);
    try {
      await cp(source, staging, { recursive: true, force: true });
      await rename(staging, targetDir);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    targetPath = targetDir;
  } else {
    const text = await readFile(source, 'utf8');
    await writeFile(targetFile, text, 'utf8');
    targetPath = targetFile;
  }

  clearMarketCache();
  // The copy is what matters; the ledger only powers "installed / has update".
  const recorded = await recordInstall({ marketDir: dir, repo, folder, name, root, targetPath });
  return { ok: true, name, targetPath, replaced, recorded };
}
