/**
 * dsh-memory-manager — project key derivation.
 *
 * A project memory directory is keyed by the Session's effective working directory,
 * using the ZCode naming scheme so that DSH and ZCode agree on one directory per
 * project:
 *
 *   projectKey(cwd) = slug(basename(cwd)) + '-' + sha256(normalize(cwd))[0:16]
 *
 * `normalize` is the part that matters: lowercased drive letter, backslash
 * separators, no trailing separator, Unicode NFC, whole string lowercased. That is
 * what makes `C:\work\MyProject` and `c:\work\myproject` — the same directory
 * on Windows — produce one key instead of two.
 *
 * The six cases pinned in `scripts/smoke.mjs`; a change here would silently orphan
 * every existing project memory directory, so they stay pinned.
 */

import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

/** Number of hex characters of the path hash ZCode keeps. */
export const KEY_HASH_LENGTH = 16;

/** Longest slug observed in the live ZCode directory table is 48; ZCode truncates at 50. */
export const SLUG_MAX_LENGTH = 50;

/** Fallback slug for a filesystem root or a name that sanitizes to nothing. */
const FALLBACK_SLUG = 'project';

/**
 * Canonicalize a working directory for key derivation.
 *
 * Windows is the only platform this scheme is defined for, but the function is total:
 * separators are unified, so the same rule produces a stable key elsewhere rather
 * than throwing. Lowercasing the whole string is what makes `MyProject` and `myproject`
 * — one directory on Windows — produce one key.
 *
 * @param {string} cwd - absolute working directory
 * @returns {string}
 */
export function normalizeForKeys(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new Error('a working directory is required to derive a project key');
  }
  let path = resolve(cwd).replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
  if (/^[A-Za-z]:/.test(path)) path = path[0].toLowerCase() + path.slice(1);
  return path.normalize('NFC').toLowerCase();
}

/**
 * The string hashed for a working directory.
 *
 * A Workspace is the preferred identity: when the caller can resolve one for the
 * directory (through the optional-service accessor `ctx.get('workspaceRegistry')` and
 * its `resolveByPath`), the hash input is `workspace:<id>`, so the same directory keeps
 * one key even if it is reached through a different spelling and it stays distinct
 * from an unregistered directory with the same path. Without a workspace the canonical
 * path is hashed, which is the ZCode scheme and the fallback the contract requires.
 *
 * @param {string} cwd - absolute working directory
 * @param {string} [workspaceId] - a resolved Workspace id, when available
 * @returns {string}
 */
export function keyHashInput(cwd, workspaceId) {
  if (typeof workspaceId === 'string' && workspaceId.trim() !== '') return `workspace:${workspaceId.trim()}`;
  return normalizeForKeys(cwd);
}

/**
 * The directory-name prefix: the basename, lowercased, with characters outside the
 * sets ZCode keeps replaced by a single hyphen.
 *
 * Underscores survive (the live table contains `mcp_servers-<hash>`), and so do
 * letters and digits in any script — Chinese project names keep their Chinese slug.
 * `.` is kept because it is harmless in a directory name and dropping it would
 * collide `a.b` with `a-b`.
 *
 * @param {string} cwd
 * @returns {string}
 */
export function slugOf(cwd) {
  const base = basename(resolve(cwd)).normalize('NFC').toLowerCase();
  const slug = base
    .replace(/[^\p{Letter}\p{Number}_.-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  return slug === '' ? FALLBACK_SLUG : slug;
}

/**
 * The project key: directory-name-safe, stable for one working directory, and
 * distinct per Workspace when one is supplied.
 *
 * @param {string} cwd
 * @param {string} [workspaceId]
 * @returns {string}
 */
export function projectKeyOf(cwd, workspaceId) {
  const hash = createHash('sha256').update(keyHashInput(cwd, workspaceId), 'utf8').digest('hex').slice(0, KEY_HASH_LENGTH);
  return `${slugOf(cwd)}-${hash}`;
}

/**
 * Accepts a key supplied by an HTTP caller. A caller may pass `cwd` instead (which is
 * safer than inventing a key), but a raw key is only honoured when it has the exact
 * shape this module produces — it becomes a directory name, so a loose pattern would
 * be a path-traversal surface.
 */
export const PROJECT_KEY_PATTERN = /^[\p{Letter}\p{Number}_.-]{1,50}-[0-9a-f]{16}$/u;

/** Whether `value` is one of this module's project keys. */
export function isProjectKey(value) {
  return typeof value === 'string' && PROJECT_KEY_PATTERN.test(value);
}
