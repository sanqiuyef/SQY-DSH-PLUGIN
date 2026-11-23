/**
 * dsh-skill-manager — 回收站：浏览、还原、永久清理。
 *
 * 「删除」在本插件里始终是移动（`lib/toggle.js` 把条目移进 `<root>/_trash/`），所以回收站
 * 是内容还在、但已经离开扫盘面的地方。条目命名规则由 `lib/toggle.js` 产生，这里只读它、
 * 不重新定义：
 *   目录条目 `<name>@yyyyMMddTHHmmss`，同名冲突加 `-2` / `-3`；
 *   单文件条目 `<name>@yyyyMMddTHHmmss.md`，冲突 `-2.md`。
 * 反解只用一条正则（见 {@link parseTrashToken}），不匹配的条目一律跳过：`_trash/` 也可能
 * 被用户手动塞进别的东西，不是本插件产生的条目不能被当成回收站条目展示，更不能被
 * 「清空回收站」顺手删掉。
 *
 * 三个导出里只有 {@link purgeTrash} 会真正删除内容，且目标一律先拼成 `_trash/<token>`
 * 再用 `isInside` 复核：删除范围只到某个根 `_trash/` 的直接子项，`_trash/` 目录本身保留。
 */

import { readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { badRequest, exists, notFound, readOnly } from './errors.js';
import { rootById } from './roots.js';
import { isInside, assertInsideReal, isSafeSegment, skillEntryPath, trashDirOf } from './scan.js';

/** 回收站条目名：`<原名>@<yyyyMMddTHHmmss>[-序号][.md]`（`lib/toggle.js` 产生）。 */
const TRASH_TOKEN = /^(.+)@(\d{8}T\d{6})(?:-(\d+))?(\.md)?$/;

/** 命名冲突后的重试上限，与 `lib/toggle.js` 同值。 */
const MAX_NAME_RETRY = 50;

/** `stat` 遇 ENOENT/ENOTDIR 归为 `undefined`（与 `lib/market.js` / `lib/toggle.js` 同款）。 */
async function statOrUndefined(path) {
  try {
    return await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/**
 * 解析一个回收站条目名。
 *
 * 只有完全符合本插件命名规则的条目才算数：`name` 去掉时间戳与序号后必须是一个普通路径段，
 * 否则返回 `undefined`，调用方跳过它。
 *
 * @param {string} token - `_trash/` 下的直接子项名
 * @returns {{ name: string, kind: 'directory' | 'file' } | undefined}
 *   原名与条目类型；不是本插件产生的名字返回 `undefined`
 */
function parseTrashToken(token) {
  if (typeof token !== 'string') return undefined;
  const match = TRASH_TOKEN.exec(token);
  if (match === null) return undefined;
  const [, name, , , extension] = match;
  if (!isSafeSegment(name)) return undefined;
  return { name, kind: extension === '.md' ? 'file' : 'directory' };
}

/** `yyyyMMddTHHmmss` 本地时间戳，与 `lib/toggle.js` 的命名规则逐字一致。 */
function timestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

/**
 * 为一个条目拼出 `_trash/` 下不冲突的新名字。
 *
 * 加序号逻辑与 `lib/toggle.js` 的 `moveToTrash` 相同：第一次冲突就用 `-2`，然后 `-3`…
 *
 * @param {string} trash - 该根 `_trash/` 的绝对路径
 * @param {string} name - 原始条目名（不含时间戳与扩展名）
 * @param {'directory' | 'file'} kind - 条目类型（决定是否带 `.md`）
 * @returns {Promise<string>} 不冲突的目标绝对路径
 */
async function freeTrashPath(trash, name, kind) {
  const base = `${name}@${timestamp()}`;
  let target = join(trash, kind === 'file' ? `${base}.md` : base);
  let counter = 1;
  while (await statOrUndefined(target)) {
    counter += 1;
    target = join(trash, kind === 'file' ? `${base}-${counter}.md` : `${base}-${counter}`);
    if (counter > MAX_NAME_RETRY) throw exists('回收站命名冲突过多，请手动整理 _trash/');
  }
  return target;
}

/** 取一个已解析的根；未知 rootId 按契约报 404。 */
function requireRoot(roots, rootId) {
  const root = rootById(roots, rootId);
  if (root === undefined) throw notFound(`未知的技能根：${String(rootId)}`);
  return root;
}

/** 取一个可写且存在的根：还原与清理都只发生在可写根上。 */
function requireWritableRoot(roots, rootId) {
  const root = requireRoot(roots, rootId);
  if (root.writable !== true) throw readOnly();
  if (root.exists !== true) throw notFound(`根目录不存在：${root.path}`);
  return root;
}

/**
 * 读一个根的 `_trash/`，按 mtime 倒序列出本插件产生的条目。
 *
 * @param {object} root - 已解析的根行
 * @returns {Promise<Array<{ token: string, name: string, kind: 'directory' | 'file', path: string, size: number, mtimeMs: number }>>}
 */
async function listRootTrash(root) {
  const trash = trashDirOf(root);
  let dirents;
  try {
    dirents = await readdir(trash, { withFileTypes: true });
  } catch {
    // 没有 `_trash/`（或读不动）＝ 回收站为空，不打扰调用方。
    return [];
  }

  const entries = [];
  for (const dirent of dirents) {
    const parsed = parseTrashToken(dirent.name);
    if (parsed === undefined) continue;
    const path = join(trash, dirent.name);
    const info = await statOrUndefined(path);
    if (info === undefined) continue;
    entries.push({
      token: dirent.name,
      name: parsed.name,
      kind: parsed.kind,
      path,
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
  }
  entries.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return entries;
}

/**
 * 列出回收站条目。
 *
 * 省略 `rootId` 时只列可写根（bundled 根不会收到 `_trash/`，也不该有）；显式给了 `rootId`
 * 也照列，但只读根的 `entries` 恒为空——本插件不会在只读根上建回收站，行照出、`writable`
 * 字段交给前端判断要不要渲染这个分区。根目录不存在同样不算错误，给空 `entries`。
 *
 * @param {{ roots: object[], rootId?: string }} input - 本次请求解析出的根表与可选根 id
 * @returns {Promise<{
 *   roots: Array<{
 *     rootId: string,
 *     rootPath: string,
 *     writable: boolean,
 *     entries: Array<{ token: string, name: string, kind: 'directory' | 'file', path: string, size: number, mtimeMs: number }>,
 *   }>,
 *   counts: { total: number },
 * }>} 每个根一行，`entries` 按 mtime 倒序
 */
export async function listTrash({ roots, rootId }) {
  const selected = rootId === undefined || rootId === null || rootId === ''
    ? roots.filter((root) => root.writable === true)
    : [requireRoot(roots, rootId)];

  const rows = [];
  let total = 0;
  for (const root of selected) {
    // 只读根不会被本插件写入 `_trash/`：即使目录里真有东西也不列，避免把别的程序放的
    // 内容冒充成「可还原的删除条目」。
    const entries = root.exists === true && root.writable === true ? await listRootTrash(root) : [];
    total += entries.length;
    rows.push({ rootId: root.id, rootPath: root.path, writable: root.writable === true, entries });
  }
  return { roots: rows, counts: { total } };
}

/**
 * 把一个已存在的目标移进 `_trash/`，为还原让位（overwrite 路径）。
 *
 * @param {object} root - 已解析的可写根
 * @param {string} target - 根目录下已存在的条目绝对路径
 * @param {string} name - 该条目的原始条目名
 * @param {'directory' | 'file'} kind - 条目类型
 * @returns {Promise<string>} 入库后的绝对路径
 */
async function parkExisting(root, target, name, kind) {
  const trash = trashDirOf(root);
  const backup = await freeTrashPath(trash, name, kind);
  if (!isInside(root.path, backup)) throw badRequest('回收站路径越出技能根');
  await rename(target, backup);
  return backup;
}

/**
 * 把一条回收站条目还原回根目录。
 *
 * 还原目标严格按 token 里的原名与类型重建：目录回 `<root>/<name>`，单文件回
 * `<root>/<name>.md`，并且必须仍在根目录内。目标已存在时只有 `overwrite: true` 才继续，
 * 且旧目标先移进 `_trash/`（带新时间戳），仍然不删除任何内容。
 *
 * @param {{ roots: object[], rootId: string, token: string, overwrite?: boolean }} input
 * @returns {Promise<{ ok: true, restored: string, state: 'enabled' }>} `restored` 为还原后的绝对路径
 */
export async function restoreTrash({ roots, rootId, token, overwrite }) {
  const root = requireWritableRoot(roots, rootId);
  const parsed = parseTrashToken(token);
  if (parsed === undefined) throw badRequest(`非法的回收站条目：${JSON.stringify(token)}`);

  const trash = trashDirOf(root);
  const source = join(trash, token);
  if (!isInside(trash, source)) throw badRequest('回收站路径越出技能根');
  if ((await statOrUndefined(source)) === undefined) throw notFound(`回收站中没有该条目：${token}`);

  const target = skillEntryPath(root, parsed.name, parsed.kind, 'enabled');
  if (!isInside(root.path, target)) throw badRequest('目标路径越出技能根');

  const existing = await statOrUndefined(target);
  if (existing !== undefined) {
    if (overwrite !== true) throw exists(`目标已存在，未做还原：${target}`);
    await parkExisting(root, target, parsed.name, parsed.kind);
  }

  await assertInsideReal(root.path, source);
  await assertInsideReal(root.path, target);
  await rename(source, target);
  return { ok: true, restored: target, state: 'enabled' };
}

/**
 * 永久删除回收站条目——这是本插件唯一真正删除内容的入口。
 *
 * 两条路径共用同一组硬约束：条目名必须是 `_trash/` 的直接子项、必须符合本插件的命名规则、
 * 拼出的绝对路径必须仍在 `_trash/` 内。`rm` 只作用于这一条路径；`_trash/` 目录本身永远保留，
 * 里面不是本插件产生的条目（手动放的杂项）一律不碰。
 *
 * @param {{ roots: object[], rootId: string, token?: string, all?: boolean, confirm?: boolean }} input
 *   `all: true` 时清空整个回收站，必须同时给 `confirm: true`
 * @returns {Promise<{ ok: true, removed: string[] }>} `removed` 为被删除条目的绝对路径
 */
export async function purgeTrash({ roots, rootId, token, all, confirm }) {
  const root = requireWritableRoot(roots, rootId);
  const trash = trashDirOf(root);

  if (all === true) {
    if (confirm !== true) throw badRequest('清空回收站需要 confirm: true');
    let dirents;
    try {
      dirents = await readdir(trash, { withFileTypes: true });
    } catch {
      return { ok: true, removed: [] };
    }

    const removed = [];
    for (const dirent of dirents.sort((left, right) => left.name.localeCompare(right.name))) {
      if (parseTrashToken(dirent.name) === undefined) continue;
      const target = join(trash, dirent.name);
      if (!isInside(trash, target)) continue;
      await rm(target, { recursive: true, force: true });
      removed.push(target);
    }
    return { ok: true, removed };
  }

  if (typeof token !== 'string' || token === '') {
    throw badRequest('需要 token；清空整个回收站请用 all: true 并同时给 confirm: true');
  }
  if (parseTrashToken(token) === undefined) throw badRequest(`非法的回收站条目：${JSON.stringify(token)}`);

  const target = join(trash, token);
  if (!isInside(trash, target)) throw badRequest('回收站路径越出技能根');
  if ((await statOrUndefined(target)) === undefined) throw notFound(`回收站中没有该条目：${token}`);

  await assertInsideReal(root.path, target);
  await rm(target, { recursive: true, force: true });
  return { ok: true, removed: [target] };
}
