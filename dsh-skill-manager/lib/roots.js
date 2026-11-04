/**
 * dsh-skill-manager — skill roots.
 *
 * The root table mirrors the host provider `@deepseek-ai/dsh-skill-filesystem`
 * exactly (same rank order, same paths, same `.system` skip) so the panel never
 * claims a skill exists somewhere the host will not look.
 *
 * The one addition is the parked directory (`_disabled/`) and the trash
 * (`_trash/`): the host has no native disable flag, so "disabled" is a move out
 * of the scanned surface. Both are this plugin's convention, documented in
 * docs/api-contract.md.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** Rank order — identical to `dsh-skill-filesystem`. */
export const ROOT_RANK = {
  'project-dsh': 100,
  'project-agents': 200,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
  bundled: 600,
};

/** English fallback labels. The client localizes by `source`; these are last resort. */
export const ROOT_LABEL = {
  'project-dsh': 'Project skills (.dsh)',
  'project-agents': 'Project skills (.agents)',
  custom: 'Custom skills',
  'user-dsh': 'User skills (DSH)',
  'user-agents': 'User skills (agents)',
  bundled: 'Bundled skills',
};

/** Directory names the scanner never reports as skills. */
export const RESERVED_ENTRIES = new Set(['_disabled', '_trash']);

/** The parked directory used to disable a skill (this plugin's convention). */
export const DISABLED_DIR = '_disabled';

/** Where "delete" puts a skill instead of removing it (this plugin's convention). */
export const TRASH_DIR = '_trash';

/** Resolve the harness home: explicit config, then `DSH_HOME`, then `~/.dsh`. */
export function resolveDshHome(configured) {
  const value = firstNonEmpty(configured, process.env.DSH_HOME);
  return resolve(value ?? join(homedir(), '.dsh'));
}

/** Resolve the shared agents home: explicit config, then `DSH_AGENTS_HOME`, then `~/.agents`. */
export function resolveAgentsHome(configured) {
  const value = firstNonEmpty(configured, process.env.DSH_AGENTS_HOME);
  return resolve(value ?? join(homedir(), '.agents'));
}

/** First non-empty trimmed string. */
export function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * Nearest ancestor containing `.git` (a directory or a worktree's `.git` file).
 * Falls back to the given cwd when no marker exists, like the host does.
 */
export function findProjectRoot(cwd) {
  const start = resolve(cwd);
  let current = start;
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/** Normalize `customSkillDirs`: absolute paths kept, relative ones resolved against cwd. */
export function normalizeCustomDirs(value, cwd) {
  if (!Array.isArray(value)) return [];
  const base = resolve(cwd);
  const dirs = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') continue;
    const raw = item.trim();
    const dir = isAbsolute(raw) ? resolve(raw) : resolve(base, raw);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/**
 * Build the root list for one cwd.
 *
 * @param {{ options?: object, cwd: string }} input
 * @returns {{ cwd: string, projectRoot: string, dshHome: string, agentsHome: string, roots: object[] }}
 */
export function resolveRoots({ options = {}, cwd }) {
  const effectiveCwd = resolve(firstNonEmpty(cwd) ?? process.cwd());
  const projectRoot = findProjectRoot(effectiveCwd);
  const dshHome = resolveDshHome(options.dshHome);
  const agentsHome = resolveAgentsHome(options.agentsHome);
  const bundledSkillDir = firstNonEmpty(options.bundledSkillDir, process.env.DSH_BUNDLED_SKILL_DIR);

  const rows = [
    { id: 'project-dsh', source: 'project-dsh', path: join(projectRoot, '.dsh', 'skills'), kind: 'project' },
    { id: 'project-agents', source: 'project-agents', path: join(projectRoot, '.agents', 'skills'), kind: 'project' },
    ...normalizeCustomDirs(options.customSkillDirs, effectiveCwd).map((path, index) => ({
      id: `custom:${index}`,
      source: 'custom',
      path,
      kind: 'custom',
    })),
    { id: 'user-dsh', source: 'user-dsh', path: join(dshHome, 'skills'), kind: 'user', skipSystem: true },
    { id: 'user-agents', source: 'user-agents', path: join(agentsHome, 'skills'), kind: 'user' },
    ...(bundledSkillDir === undefined
      ? []
      : [{ id: 'bundled', source: 'bundled', path: resolve(bundledSkillDir), kind: 'bundled' }]),
  ];

  const roots = rows.map((row) => ({
    id: row.id,
    label: ROOT_LABEL[row.source] ?? row.source,
    source: row.source,
    rank: ROOT_RANK[row.source],
    kind: row.kind,
    path: row.path,
    exists: existsSync(row.path),
    writable: row.kind !== 'bundled',
    skipSystem: row.skipSystem === true,
  }));

  return { cwd: effectiveCwd, projectRoot, dshHome, agentsHome, roots };
}

/** Find a root by id inside a resolved root list. */
export function rootById(roots, rootId) {
  return roots.find((root) => root.id === rootId);
}
