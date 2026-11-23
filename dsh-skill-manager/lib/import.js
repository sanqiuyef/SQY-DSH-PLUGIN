/**
 * dsh-skill-manager — 导入本地技能包（文件夹 / 单文件 .md；不做 zip）。
 *
 * 面板原来只有两条输入路径：新建空白技能、从本机市场克隆安装。别人直接给的一个
 * 技能目录没有任何入口，只能手抄。这里按 dsh-skill-mcp-panel 的识别规则补上：
 *
 *  1. 选中范围自己就有 `SKILL.md` → 整包当成一个技能（保留 references/scripts/assets）；
 *  2. 否则递归发现其中的技能条目并**拍平**到目标技能根的第一层（宿主只扫一层）；
 *  3. 宿主会丢弃的（frontmatter 有 error 级问题）与重名的逐条跳过并说明原因，
 *     其余照常导入 —— 单条失败不影响其余，不做事务。
 *
 * 只读源、只写目标根：源文件不移动、不删除、不改写。复制先落到
 * `.import-<name>-<ts>` 再 rename（与 `market.js` 的安装同一套 staging 模式），
 * 半成品不会留在技能根里。
 */

import { cp, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';

import { badRequest, notFound, readOnly } from './errors.js';
import { analyzeContent } from './parse.js';
import { isInside, isSafeSegment } from './scan.js';

/** 一次导入最多处理多少个技能。 */
export const MAX_IMPORT_ITEMS = 200;

/** 递归发现技能的深度上限（防止误选整个盘符）。 */
const MAX_DEPTH = 4;

/** 递归时永不进入的目录名。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg', '_trash', '_disabled', '.system']);

/**
 * 技能包里的说明文档不是技能。递归发现时如果把它们当候选，每一个都会以
 * 「缺少 frontmatter」被跳过，导入一个包会刷出一串无关噪音。
 */
const INERT_MARKDOWN = /^(readme|changelog|changes|history|license|licence|copying|contributing|code_of_conduct|security|agents|claude)(\.md|\.markdown)?$/i;

/** `stat` with ENOENT folded into `undefined`. */
async function statOrUndefined(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** Whether `dir` holds a regular `SKILL.md`. */
async function hasSkillFile(dir) {
  const info = await statOrUndefined(join(dir, 'SKILL.md'));
  return info !== undefined && info.isFile();
}

/**
 * Discover skill candidates under one selected path.
 *
 * @param {string} entryPath
 * @param {boolean} isDirectory
 * @returns {Promise<{ candidates: Array<{ path: string, kind: 'directory' | 'file' }>, tooMany: boolean }>}
 */
async function discover(entryPath, isDirectory) {
  if (!isDirectory) {
    return /\.md$/i.test(entryPath)
      ? { candidates: [{ path: entryPath, kind: 'file' }], tooMany: false }
      : { candidates: [], tooMany: false };
  }
  // A selected folder that is already a skill bundle stays one skill; this is
  // what makes "import this skill folder" do the obvious thing.
  if (await hasSkillFile(entryPath)) return { candidates: [{ path: entryPath, kind: 'directory' }], tooMany: false };

  const candidates = [];
  let tooMany = false;
  async function walk(dir, depth) {
    if (depth > MAX_DEPTH || tooMany) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (tooMany) return;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (await hasSkillFile(full)) {
          candidates.push({ path: full, kind: 'directory' });
          if (candidates.length > MAX_IMPORT_ITEMS) tooMany = true;
          continue;
        }
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      if (INERT_MARKDOWN.test(entry.name)) continue;
      // A flat `.md` inside a discovery folder is only a skill when its
      // frontmatter says so; `analyzeContent` decides that per candidate.
      candidates.push({ path: full, kind: 'file' });
      if (candidates.length > MAX_IMPORT_ITEMS) tooMany = true;
    }
  }
  await walk(entryPath, 0);
  return { candidates: candidates.slice(0, MAX_IMPORT_ITEMS), tooMany };
}

/** Copy one candidate into the root through a staging name, then rename. */
async function copyCandidate({ root, candidate, name, stamp }) {
  const staging = join(root.path, `.import-${name}-${stamp}`);
  const target = candidate.kind === 'directory' ? join(root.path, name) : join(root.path, `${name}.md`);
  try {
    await cp(candidate.path, staging, { recursive: true, force: true });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return target;
}

/**
 * Import one folder or `.md` into a writable skill root.
 *
 * @param {{ root: object, sourcePath: string, cwd?: string }} input
 * @returns {Promise<{
 *   ok: true,
 *   source: string,
 *   imported: Array<{ name: string, kind: 'directory' | 'file', targetPath: string }>,
 *   skipped: Array<{ source: string, name?: string, code: string, message: string, issue?: string }>,
 * }>}
 */
export async function importSkillPackage({ root, sourcePath, cwd }) {
  if (root === undefined) throw notFound('未知的目标技能根');
  if (root.writable !== true) throw readOnly();
  if (root.exists !== true) throw notFound(`根目录不存在：${root.path}`);
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') throw badRequest('请给出要导入的文件夹或 .md 路径');

  const raw = sourcePath.trim().replace(/^"(.*)"$/, '$1');
  const base = typeof cwd === 'string' && cwd.trim() !== '' ? resolve(cwd) : process.cwd();
  const source = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
  const info = await statOrUndefined(source);
  if (info === undefined) throw notFound(`来源不存在：${source}`);
  // Two recursion traps, both cheap to rule out: a source already inside the
  // root is that root's own entry, and a root inside the source would be copied
  // into itself through the staging directory.
  if (isInside(root.path, source)) {
    throw badRequest('来源已在目标技能根内；请直接在这个根里管理该条目（或先复制到根外再导入）。');
  }
  if (isInside(source, root.path)) {
    throw badRequest('目标技能根在来源目录里，复制会递归；请换一个目标根。');
  }

  const { candidates, tooMany } = await discover(source, info.isDirectory());
  const imported = [];
  const skipped = [];
  const stamp = `${process.pid}-${Date.now()}`;

  if (candidates.length === 0) {
    return {
      ok: true,
      source,
      imported,
      skipped: [{ source, code: 'no-skill', message: '这里没有找到任何 SKILL.md（顶层目录必须直接含 SKILL.md，或把技能放在下面几层）。' }],
    };
  }

  for (const candidate of candidates) {
    const instructionPath = candidate.kind === 'directory' ? join(candidate.path, 'SKILL.md') : candidate.path;
    let text;
    try {
      text = await readFile(instructionPath, 'utf8');
    } catch (error) {
      skipped.push({ source: candidate.path, code: 'read-error', message: `读取失败：${error?.message ?? String(error)}` });
      continue;
    }
    const fallbackName = candidate.kind === 'directory'
      ? basename(candidate.path)
      : basename(candidate.path).replace(/\.md$/i, '');
    const analysis = analyzeContent(text, { dirName: fallbackName, kind: candidate.kind });
    const firstError = analysis.issues.find((entry) => entry.level === 'error');
    if (firstError !== undefined) {
      // The host drops such a skill silently, so importing it would only add
      // noise to the list. Say why instead.
      skipped.push({
        source: candidate.path,
        name: fallbackName,
        code: 'invalid',
        message: firstError.message,
        issue: firstError.code,
      });
      continue;
    }

    const name = analysis.name;
    if (!isSafeSegment(name) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      skipped.push({ source: candidate.path, name: fallbackName, code: 'unsafe-name', message: `技能名 "${name}" 不能作为目录名使用。` });
      continue;
    }
    const targetDir = join(root.path, name);
    const targetFile = join(root.path, `${name}.md`);
    if ((await statOrUndefined(targetDir)) !== undefined || (await statOrUndefined(targetFile)) !== undefined) {
      skipped.push({ source: candidate.path, name, code: 'exists', message: `目标根里已有同名技能：${name}` });
      continue;
    }
    if (!isInside(root.path, targetDir) || !isInside(root.path, targetFile)) {
      skipped.push({ source: candidate.path, name, code: 'unsafe-name', message: '目标路径越出技能根。' });
      continue;
    }

    try {
      const targetPath = await copyCandidate({ root, candidate, name, stamp });
      imported.push({ name, kind: candidate.kind, targetPath });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        skipped.push({ source: candidate.path, name, code: 'exists', message: `目标已存在：${name}` });
        continue;
      }
      skipped.push({ source: candidate.path, name, code: 'copy-failed', message: `复制失败：${error?.message ?? String(error)}` });
    }
  }

  if (tooMany) {
    skipped.push({
      source,
      code: 'too-many',
      message: `来源里的技能超过 ${MAX_IMPORT_ITEMS} 个，只处理了前 ${MAX_IMPORT_ITEMS} 个；请分目录导入。`,
    });
  }

  return { ok: true, source, imported, skipped };
}
