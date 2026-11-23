/**
 * dsh-skill-manager — read, save and create one SKILL.md.
 *
 * Safety rules that hold for every write here:
 *  - the root must be a root this panel resolved (never a caller-supplied path);
 *  - the entry name must be one ordinary path segment;
 *  - the resolved file must still sit inside that root;
 *  - a save must carry the hash it read, so a concurrent edit is refused, not
 *    overwritten;
 *  - the write is a temp file + rename in the same directory.
 */

import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { badRequest, conflict, exists, notFound, readOnly, tooLarge } from './errors.js';
import { analyzeContent, buildFrontmatter, detectEol, hasBom, rewriteInvocation, stripBom } from './parse.js';
import { rootById } from './roots.js';
import {
  assertInsideReal,
  buildSkill,
  contentHash,
  isInside,
  isSafeSegment,
  skillEntryPath,
  skillFilePath,
} from './scan.js';

/** Upper bound for one skill file (frontmatter + body). */
export const MAX_CONTENT_BYTES = 256 * 1024;

/** Upper bound for one skill name. The panel enforces the same limit. */
export const MAX_NAME_CHARS = 64;

/** Kebab-case skill name, identical to the host's grammar. */
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Default body of a newly created skill. */
const DEFAULT_BODY = [
  '',
  '## 何时使用',
  '',
  '- ',
  '',
  '## 步骤',
  '',
  '1. ',
  '',
].join('\n');

/** Resolve one root or fail with the contract's `not-found`. */
function requireRoot(roots, rootId) {
  const root = rootById(roots, rootId);
  if (root === undefined) throw notFound(`未知的技能根：${String(rootId)}`);
  return root;
}

/** Resolve one root that must accept writes. */
function requireWritableRoot(roots, rootId) {
  const root = requireRoot(roots, rootId);
  if (root.writable !== true) throw readOnly();
  if (root.exists !== true) throw notFound(`根目录不存在：${root.path}`);
  return root;
}

/** Resolve the instruction file of one known skill. */
function requireSkillPath(root, dirName, kind, state) {
  if (!isSafeSegment(dirName)) throw badRequest(`非法的技能名：${JSON.stringify(dirName)}`);
  if (kind !== 'directory' && kind !== 'file') throw badRequest(`不支持的技能类型：${String(kind)}`);
  const path = skillFilePath(root, dirName, kind, state === 'disabled' ? 'disabled' : 'enabled');
  if (!isInside(root.path, path)) throw badRequest('目标路径越出技能根');
  return path;
}

/** Read one skill with its parsed body. */
export async function readSkill({ roots, rootId, dirName, kind, state }) {
  const root = requireRoot(roots, rootId);
  const path = requireSkillPath(root, dirName, kind, state);
  let content;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw notFound(`技能文件不存在：${path}`);
    throw error;
  }
  const skill = await buildSkill(root, dirName, kind, state === 'disabled');
  const analysis = analyzeContent(content, { dirName, kind });
  const frontmatter = analysis.data === null ? null : analysis.data;
  return {
    skill,
    content,
    frontmatter,
    body: stripBom(analysis.body),
    eol: detectEol(content),
    hasBom: hasBom(content),
  };
}

/**
 * Save one skill file with optimistic concurrency.
 *
 * @param {{ roots: object[], rootId: string, dirName: string, kind: string, state?: string,
 *   expectedHash: string, content: string, stripBom?: boolean }} input
 */
export async function saveSkill({ roots, rootId, dirName, kind, state, expectedHash, content, stripBom: shouldStripBom }) {
  const root = requireWritableRoot(roots, rootId);
  if (typeof content !== 'string') throw badRequest('content 必须是字符串');
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw tooLarge(`内容超过 ${MAX_CONTENT_BYTES} 字节上限`);
  }
  const path = requireSkillPath(root, dirName, kind, state);

  let current;
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw notFound(`技能文件不存在：${path}`);
    throw error;
  }
  if (typeof expectedHash === 'string' && expectedHash !== '' && contentHash(current) !== expectedHash) {
    throw conflict('磁盘上的内容已变化（其他程序写入过），请重新载入后再保存。');
  }

  await assertInsideReal(root.path, path);
  const next = shouldStripBom === true && hasBom(content) ? stripBom(content) : content;
  await writeFileAtomic(path, next);
  const analysis = analyzeContent(next, { dirName, kind });
  return { ok: true, hash: contentHash(next), issues: analysis.issues };
}

/**
 * Rewrite one skill's invocation policy in place — the "soft disable" path.
 *
 * The host has two native keys and no native "off": `disable-model-invocation`
 * removes the skill from the catalog and the `skill` tool while keeping `/name`
 * working, and `user-invocable: false` removes it from `/name`. `_disabled/`
 * (lib/toggle.js) is still the hard disable — it moves the entry out of the
 * scanned surface entirely, which also breaks `/name` and changes the path on
 * disk. This route exists so an operator can pick the lighter state.
 *
 * Same write rules as {@link saveSkill}: the root must be writable, the entry
 * name one path segment, the target inside the root, the hash opt-in, and the
 * write atomic. The rewrite is verified by re-parsing it, so a frontmatter shape
 * this function cannot edit fails loudly instead of writing broken YAML.
 *
 * @param {{ roots: object[], rootId: string, dirName: string, kind: string, state?: string,
 *   expectedHash?: string, model: boolean, user: boolean }} input
 */
export async function setInvocation({ roots, rootId, dirName, kind, state, expectedHash, model, user }) {
  const root = requireWritableRoot(roots, rootId);
  if (typeof model !== 'boolean' || typeof user !== 'boolean') {
    throw badRequest('model 与 user 必须是布尔值');
  }
  // `user: false` hides the skill from `/name`; with `model: false` as well the
  // skill is unreachable from both surfaces. Both are legal host states.
  const path = requireSkillPath(root, dirName, kind, state);

  let current;
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') throw notFound(`技能文件不存在：${path}`);
    throw error;
  }
  if (typeof expectedHash === 'string' && expectedHash !== '' && contentHash(current) !== expectedHash) {
    throw conflict('磁盘上的内容已变化（其他程序写入过），请重新载入后再改调用策略。');
  }

  const rewritten = rewriteInvocation(current, { model, user });
  if (!rewritten.ok) throw badRequest(rewritten.reason);

  // Never write a shape the host would resolve differently from what was asked:
  // flow-style frontmatter or an unexpected structure fails here, not silently.
  const analysis = analyzeContent(rewritten.content, { dirName, kind });
  if (analysis.invocation.model !== model || analysis.invocation.user !== user) {
    throw badRequest('这份 frontmatter 的调用键无法安全改写（可能是行内式 YAML），请改用正文编辑器手动修改。');
  }

  await assertInsideReal(root.path, path);
  await writeFileAtomic(path, rewritten.content);
  return { ok: true, hash: contentHash(rewritten.content), invocation: analysis.invocation, issues: analysis.issues };
}

/** Persist with a same-directory temp file, then rename over the target. */
export async function writeFileAtomic(path, content) {
  const temp = join(dirname(path), `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    await writeFile(temp, content, 'utf8');
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * Create a skill: a directory bundle (`<root>/<name>/SKILL.md`) by default, or a
 * flat file (`<root>/<name>.md`) when `kind` is `'file'`. Both are host-native
 * shapes; the panel used to create only the directory form.
 *
 * The name is checked against every place the entry could already live — the
 * root and that root's `_disabled/` — so a created skill can never end up with a
 * twin parked in `_disabled/` (the host would only see one of them, and the
 * panel would show two rows with the same name).
 *
 * @param {{ roots: object[], rootId: string, name: string, description: string,
 *   whenToUse?: string, body?: string, invocation?: { model?: boolean, user?: boolean },
 *   kind?: 'directory' | 'file' }} input
 */
export async function createSkill({ roots, rootId, name, description, whenToUse, body, invocation, kind = 'directory' }) {
  const root = requireWritableRoot(roots, rootId);
  if (!isSafeSegment(name)) {
    throw badRequest('技能名必须是单个路径段（只能含小写字母、数字与连字符）');
  }
  if (!KEBAB.test(name)) {
    throw badRequest('技能名必须是 kebab-case（小写字母、数字、连字符）');
  }
  if (name.length > MAX_NAME_CHARS) {
    throw badRequest(`技能名不能超过 ${MAX_NAME_CHARS} 个字符`);
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw badRequest('description 必填：它会进入模型技能目录');
  }
  if (description.length > 1024) throw badRequest('description 不能超过 1024 字符');
  if (kind !== 'directory' && kind !== 'file') throw badRequest(`不支持的技能类型：${String(kind)}`);

  const dirPath = skillEntryPath(root, name, 'directory', 'enabled');
  const flatPath = skillEntryPath(root, name, 'file', 'enabled');
  const parkedDir = skillEntryPath(root, name, 'directory', 'disabled');
  const parkedFile = skillEntryPath(root, name, 'file', 'disabled');
  for (const candidate of [dirPath, flatPath, parkedDir, parkedFile]) {
    const info = await stat(candidate).catch((error) => {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
      throw error;
    });
    if (info !== undefined) {
      const parked = candidate === parkedDir || candidate === parkedFile;
      throw exists(parked ? `该名字已存在但处于停用状态：${candidate}（请先启用或删除它）` : `目标已存在：${candidate}`);
    }
  }

  const content = `${buildFrontmatter({ name, description: description.trim(), whenToUse, invocation })}${body === undefined || body === '' ? DEFAULT_BODY : body}`;

  if (kind === 'file') {
    await assertInsideReal(root.path, flatPath);
    try {
      await writeFileAtomic(flatPath, content);
    } catch (error) {
      throw new Error(`创建技能失败：${error?.message ?? String(error)}`);
    }
    const skill = await buildSkill(root, name, 'file', false);
    return { ok: true, skill };
  }

  const skillPath = join(dirPath, 'SKILL.md');
  await mkdir(dirPath, { recursive: true });
  await assertInsideReal(root.path, skillPath);
  try {
    await writeFileAtomic(skillPath, content);
  } catch (error) {
    throw new Error(`创建技能失败：${error?.message ?? String(error)}`);
  }
  const skill = await buildSkill(root, name, 'directory', false);
  return { ok: true, skill };
}
