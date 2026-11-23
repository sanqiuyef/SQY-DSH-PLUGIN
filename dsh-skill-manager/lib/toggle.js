/**
 * dsh-skill-manager — enable/disable and delete, both implemented as moves.
 *
 * The host has no native "disabled" flag for a skill: frontmatter only controls
 * invocation surfaces. Its discovery rule is deliberately narrow — a root
 * contributes only its direct `<name>/SKILL.md` or `<name>.md` entries — so
 * moving the entry out of the root removes it from the catalog while keeping
 * every file intact, and moving it back restores it. `_disabled/` is this
 * plugin's convention, not a host feature.
 *
 * "Delete" is a move into `_trash/` for the same reason: a skill directory is
 * user work, so nothing here ever removes content.
 */

import { mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { badRequest, exists, notFound, readOnly } from './errors.js';
import { DISABLED_DIR, TRASH_DIR, rootById } from './roots.js';
import { assertInsideReal, isInside, isSafeSegment, skillEntryPath } from './scan.js';

/** Resolve one writable root or answer with the contract's error. */
function requireWritableRoot(roots, rootId) {
  const root = rootById(roots, rootId);
  if (root === undefined) throw notFound(`未知的技能根：${String(rootId)}`);
  if (root.writable !== true) throw readOnly();
  if (root.exists !== true) throw notFound(`根目录不存在：${root.path}`);
  return root;
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

/**
 * Move one skill between its root and that root's `_disabled/` parking directory.
 *
 * @param {{ roots: object[], rootId: string, dirName: string, kind: 'directory'|'file', enabled: boolean }} input
 */
export async function setSkillEnabled({ roots, rootId, dirName, kind, enabled }) {
  const root = requireWritableRoot(roots, rootId);
  if (!isSafeSegment(dirName)) throw badRequest(`非法的技能名：${JSON.stringify(dirName)}`);
  if (kind !== 'directory' && kind !== 'file') throw badRequest(`不支持的技能类型：${String(kind)}`);

  const fromState = enabled ? 'disabled' : 'enabled';
  const toState = enabled ? 'enabled' : 'disabled';
  const from = skillEntryPath(root, dirName, kind, fromState);
  const to = skillEntryPath(root, dirName, kind, toState);
  if (!isInside(root.path, from) || !isInside(root.path, to)) throw badRequest('目标路径越出技能根');

  const source = await statOrUndefined(from);
  if (source === undefined) {
    throw notFound(enabled ? `_disabled/ 中没有该技能：${dirName}` : `技能不存在：${dirName}`);
  }
  if (await statOrUndefined(to)) {
    throw exists(`目标已存在，未做移动：${to}`);
  }

  if (!enabled) await mkdir(join(root.path, DISABLED_DIR), { recursive: true });
  await assertInsideReal(root.path, from);
  await assertInsideReal(root.path, to);
  await rename(from, to);
  return { ok: true, state: enabled ? 'enabled' : 'disabled', path: to };
}

/** `yyyyMMddTHHmmss` used in trash directory names. */
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
 * Move one skill into the root's `_trash/` (never deletes).
 *
 * @param {{ roots: object[], rootId: string, dirName: string, kind: 'directory'|'file' }} input
 */
export async function trashSkill({ roots, rootId, dirName, kind }) {
  const root = requireWritableRoot(roots, rootId);
  if (!isSafeSegment(dirName)) throw badRequest(`非法的技能名：${JSON.stringify(dirName)}`);
  if (kind !== 'directory' && kind !== 'file') throw badRequest(`不支持的技能类型：${String(kind)}`);

  const source = skillEntryPath(root, dirName, kind, 'enabled');
  if (!isInside(root.path, source)) throw badRequest('目标路径越出技能根');
  if ((await statOrUndefined(source)) === undefined) {
    // A parked skill is deletable too: look in `_disabled/` before failing.
    const parked = skillEntryPath(root, dirName, kind, 'disabled');
    if (!isInside(root.path, parked)) throw badRequest('目标路径越出技能根');
    if ((await statOrUndefined(parked)) === undefined) throw notFound(`技能不存在：${dirName}`);
    return moveToTrash(root, parked, dirName, kind);
  }
  return moveToTrash(root, source, dirName, kind);
}

/** Move `source` under `_trash/<name>@<timestamp>[-n]`, keeping the entry kind. */
async function moveToTrash(root, source, dirName, kind) {
  const trash = join(root.path, TRASH_DIR);
  await mkdir(trash, { recursive: true });
  const base = `${dirName}@${timestamp()}`;
  let target = join(trash, kind === 'file' ? `${base}.md` : base);
  let counter = 1;
  while (await statOrUndefined(target)) {
    counter += 1;
    target = join(trash, kind === 'file' ? `${base}-${counter}.md` : `${base}-${counter}`);
    if (counter > 50) throw exists('回收站命名冲突过多，请手动整理 _trash/');
  }
  if (!isInside(root.path, target)) throw badRequest('回收站路径越出技能根');
  await assertInsideReal(root.path, source);
  await assertInsideReal(root.path, target);
  await rename(source, target);
  return { ok: true, trashed: target };
}
