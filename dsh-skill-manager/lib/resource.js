/**
 * dsh-skill-manager — 技能目录里的资源文件（references/、scripts/、assets/ …）。
 *
 * 面板能编辑 SKILL.md，但技能的体积与风险主要在资源目录里：`scripts/` 下的一个 `.ps1`
 * 就是宿主将来会执行的代码，`references/` 下的一篇长文才是技能真正的知识。这组函数把资源
 * 目录做成「列表 + 单文件文本读 + 单文件文本写」，边界固定为技能条目目录之内：
 *  - 只处理 `kind: 'directory'` 的条目；单文件技能没有资源目录，一律给空列表；
 *  - `file` 必须是相对路径、`/` 分隔，拒绝绝对路径、`..` 段、空段与反斜杠；
 *  - 拼出的绝对路径必须仍在条目目录内（`isInside` 复核）；
 *  - 读上限 256 KiB，含 NUL 字节判为二进制；两者都不返回内容，也不给 hash；
 *  - 写只覆盖**已存在**的文本文件（新建资源文件不在本接口范围内），且是原子写：
 *    同目录临时文件 + rename（复用 `lib/skill-file.js` 的 `writeFileAtomic`）。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { badRequest, conflict, notFound, readOnly, tooLarge } from './errors.js';
import { rootById } from './roots.js';
import { contentHash, assertInsideReal, isInside, isSafeSegment, skillEntryPath, skillFilePath } from './scan.js';
import { writeFileAtomic } from './skill-file.js';

/** 递归深度上限：技能目录的直接子项算第 1 层。 */
const MAX_DEPTH = 4;

/** 一次列表最多返回的条目数（目录条目也计数）。 */
const MAX_ENTRIES = 500;

/** 单个资源文件的文本上限：读与写同口径。 */
export const MAX_RESOURCE_BYTES = 256 * 1024;

/** 永远不列出的条目：版本库、依赖、本插件自己的回收站/停放区、宿主的系统目录。 */
const SKIP_ENTRIES = new Set(['.git', 'node_modules', '_trash', '_disabled', '.system']);

/** `stat` 遇 ENOENT/ENOTDIR 归为 `undefined`（与 `lib/toggle.js` 同款）。 */
async function statOrUndefined(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/**
 * 解析一个技能条目，返回它所在的根与条目绝对路径。
 *
 * 校验顺序与其它写模块一致：未知根 / 根不存在 → 404，条目名或类型非法 → 400，拼出的路径
 * 必须仍在根内。只读根在这里不拦（读 bundled 技能的资源是合法需求），写路径自己再查
 * `writable`。
 *
 * @param {object[]} roots - 本次请求解析出的根表
 * @param {string} rootId - 根 id
 * @param {string} dirName - 技能条目的目录名（单文件技能为不含 `.md` 的名字）
 * @param {'directory' | 'file'} kind - 条目类型
 * @param {string} [state] - `enabled` / `disabled`
 * @returns {{ root: object, entryPath: string, state: 'enabled' | 'disabled' }}
 *   根行、条目绝对路径、归一化后的状态
 */
function requireEntry(roots, rootId, dirName, kind, state) {
  const root = rootById(roots, rootId);
  if (root === undefined) throw notFound(`未知的技能根：${String(rootId)}`);
  if (root.exists !== true) throw notFound(`根目录不存在：${root.path}`);
  if (!isSafeSegment(dirName)) throw badRequest(`非法的技能名：${JSON.stringify(dirName)}`);
  if (kind !== 'directory' && kind !== 'file') throw badRequest(`不支持的技能类型：${String(kind)}`);
  const effectiveState = state === 'disabled' ? 'disabled' : 'enabled';
  const entryPath = skillEntryPath(root, dirName, kind, effectiveState);
  if (!isInside(root.path, entryPath)) throw badRequest('目标路径越出技能根');
  return { root, entryPath, state: effectiveState };
}

/**
 * 把调用方给的相对路径解析成条目目录内的绝对路径。
 *
 * 拒绝：非字符串/空串、反斜杠（统一要求 `/`）、绝对路径、空段/`.`/`..` 段、以及解析后
 * 越出条目目录的路径。
 *
 * @param {string} entryPath - 技能条目目录的绝对路径
 * @param {string} file - `/` 分隔的相对路径
 * @returns {string} 条目目录内的绝对路径
 */
function resolveResourcePath(entryPath, file) {
  if (typeof file !== 'string' || file.trim() === '') throw badRequest('"file" 必须是非空相对路径');
  if (file.includes('\\')) throw badRequest('"file" 必须用 / 分隔（不接受反斜杠）');
  if (isAbsolute(file) || file.startsWith('/')) throw badRequest('"file" 必须是相对技能目录的路径');
  const segments = file.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw badRequest(`非法的资源文件路径：${JSON.stringify(file)}`);
  }
  const target = resolve(entryPath, ...segments);
  if (!isInside(entryPath, target)) throw badRequest('资源文件路径越出技能目录');
  return target;
}

/**
 * 目录里是否存在一个会被列出的子项——用于判断「深度上限」是否漏掉了内容。
 *
 * @param {string} dir - 待检查目录的绝对路径
 * @returns {Promise<boolean>} 是否有可见子项
 */
async function hasVisibleChild(dir) {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return dirents.some((dirent) => !SKIP_ENTRIES.has(dirent.name) && !dirent.name.startsWith('.'));
}

/**
 * 递归列出一层目录的条目（目录自身不计入）。
 *
 * 排序为文件名升序，`relativePath` 一律 `/` 分隔；目录条目也算一条，`size` 记 0（目录没有
 * 可读的文件大小，给个稳定的 0 比给平台相关的 stat 值更好用）。深度上限与条数上限通过共享
 * 的 `budget` 表达，任一命中都把 `truncated` 置真。
 *
 * @param {string} dir - 当前目录的绝对路径
 * @param {string} prefix - 相对的目录前缀（根层为空串，不含结尾分隔符）
 * @param {number} depth - 当前条目的深度（1 = 技能目录的直接子项）
 * @param {{ count: number, truncated: boolean }} budget - 跨递归共享的计数与截断标记
 * @param {Array<{ relativePath: string, size: number, mtimeMs: number, kind: 'directory' | 'file' }>} output - 结果数组
 * @returns {Promise<void>}
 */
async function walkResources(dir, prefix, depth, budget, output) {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    // 读不动的子目录按空处理：一个坏目录不该打断整棵树。
    return;
  }

  for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
    if (SKIP_ENTRIES.has(dirent.name) || dirent.name.startsWith('.')) continue;
    const full = join(dir, dirent.name);
    const info = await statOrUndefined(full);
    if (info === undefined) continue;
    const kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : undefined;
    if (kind === undefined) continue;

    if (budget.count >= MAX_ENTRIES) {
      budget.truncated = true;
      return;
    }

    const relativePath = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
    budget.count += 1;
    output.push({ relativePath, size: kind === 'directory' ? 0 : info.size, mtimeMs: info.mtimeMs, kind });

    if (kind !== 'directory') continue;
    if (depth >= MAX_DEPTH) {
      if (await hasVisibleChild(full)) budget.truncated = true;
      continue;
    }
    await walkResources(full, relativePath, depth + 1, budget, output);
  }
}

/**
 * 列出技能目录里的资源文件。
 *
 * 单文件技能没有资源目录，`kind !== 'directory'` 时直接返回 `entries: []`；技能文件本身
 * 缺失仍然是 404（条目不在磁盘上，列出来的树没有意义）。
 *
 * @param {{ roots: object[], rootId: string, dirName: string, kind: 'directory' | 'file', state?: string }} input
 * @returns {Promise<{
 *   ok: true,
 *   entryPath: string,
 *   entries: Array<{ relativePath: string, size: number, mtimeMs: number, kind: 'directory' | 'file' }>,
 *   truncated: boolean,
 * }>} `truncated` 表示深度或条数上限截掉了内容
 */
export async function listSkillFiles({ roots, rootId, dirName, kind, state }) {
  const entry = requireEntry(roots, rootId, dirName, kind, state);
  const skillPath = skillFilePath(entry.root, dirName, kind, entry.state);
  const skillInfo = await statOrUndefined(skillPath);
  if (skillInfo === undefined || !skillInfo.isFile()) throw notFound(`技能文件不存在：${skillPath}`);

  if (kind !== 'directory') return { ok: true, entryPath: entry.entryPath, entries: [], truncated: false };

  const output = [];
  const budget = { count: 0, truncated: false };
  await walkResources(entry.entryPath, '', 1, budget, output);
  return { ok: true, entryPath: entry.entryPath, entries: output, truncated: budget.truncated };
}

/**
 * 读技能目录里的一个资源文件。
 *
 * 文本（≤ 256 KiB 且不含 NUL 字节）返回 `content` 与 `hash`；超限或二进制只返回元数据，
 * 不返回 `content`，也不返回 `hash`（`hash` 是 UTF-8 文本的乐观并发令牌，对二进制没有意义）。
 *
 * @param {{ roots: object[], rootId: string, dirName: string, kind: 'directory' | 'file', state?: string, file: string }} input
 * @returns {Promise<{
 *   ok: true,
 *   file: string,
 *   size: number,
 *   mtimeMs: number,
 *   encoding: 'utf8' | 'binary' | 'too-large',
 *   hash?: string,
 *   content?: string,
 * }>} `file` 原样回显请求里的相对路径
 */
export async function readSkillFile({ roots, rootId, dirName, kind, state, file }) {
  const entry = requireEntry(roots, rootId, dirName, kind, state);
  if (kind !== 'directory') throw badRequest('单文件技能没有资源目录');
  const target = resolveResourcePath(entry.entryPath, file);
  await assertInsideReal(entry.root.path, target);

  const info = await statOrUndefined(target);
  if (info === undefined) throw notFound(`资源文件不存在：${file}`);
  if (!info.isFile()) throw badRequest(`不是普通文件：${file}`);
  if (info.size > MAX_RESOURCE_BYTES) {
    return { ok: true, file, size: info.size, mtimeMs: info.mtimeMs, encoding: 'too-large' };
  }

  let buffer;
  try {
    buffer = await readFile(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw notFound(`资源文件不存在：${file}`);
    throw error;
  }
  // stat 与 read 之间文件可能变大：按实际读到的字节数再判一次上限。
  if (buffer.length > MAX_RESOURCE_BYTES) {
    return { ok: true, file, size: buffer.length, mtimeMs: info.mtimeMs, encoding: 'too-large' };
  }
  if (buffer.includes(0)) {
    return { ok: true, file, size: buffer.length, mtimeMs: info.mtimeMs, encoding: 'binary' };
  }

  const text = buffer.toString('utf8');
  return {
    ok: true,
    file,
    size: buffer.length,
    mtimeMs: info.mtimeMs,
    encoding: 'utf8',
    hash: contentHash(text),
    content: text,
  };
}

/**
 * 写技能目录里的一个资源文件（只覆盖已存在的文本文件）。
 *
 * 新建资源文件暂不支持：技能目录的条目集合由技能自己决定，面板只改已有内容。给
 * `expectedHash` 时先比对磁盘当前的 hash，不一致按 409 拒绝，避免覆盖别的编辑器的写入。
 *
 * @param {{ roots: object[], rootId: string, dirName: string, kind: 'directory' | 'file',
 *   state?: string, file: string, content: string, expectedHash?: string }} input
 * @returns {Promise<{ ok: true, file: string, hash: string, size: number }>}
 *   `hash` 为写入内容的 sha256，`size` 为 UTF-8 字节数
 */
export async function writeSkillFile({ roots, rootId, dirName, kind, state, file, content, expectedHash }) {
  const entry = requireEntry(roots, rootId, dirName, kind, state);
  if (entry.root.writable !== true) throw readOnly();
  if (kind !== 'directory') throw badRequest('单文件技能没有资源目录，不能写入资源文件');
  if (typeof content !== 'string') throw badRequest('content 必须是字符串');
  const size = Buffer.byteLength(content, 'utf8');
  if (size > MAX_RESOURCE_BYTES) throw tooLarge(`内容超过 ${MAX_RESOURCE_BYTES} 字节上限`);

  const target = resolveResourcePath(entry.entryPath, file);
  await assertInsideReal(entry.root.path, target);
  const info = await statOrUndefined(target);
  if (info === undefined) throw notFound(`资源文件不存在（暂不支持新建）：${file}`);
  if (!info.isFile()) throw badRequest(`不是普通文件：${file}`);

  let current;
  try {
    current = await readFile(target);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw notFound(`资源文件不存在：${file}`);
    throw error;
  }
  if (current.includes(0)) throw badRequest(`目标含 NUL 字节，按二进制文件处理，不能用文本方式写入：${file}`);
  if (typeof expectedHash === 'string' && expectedHash !== '' && contentHash(current.toString('utf8')) !== expectedHash) {
    throw conflict('磁盘上的内容已变化（其他程序写入过），请重新载入后再保存。');
  }

  await writeFileAtomic(target, content);
  return { ok: true, file, hash: contentHash(content), size };
}
