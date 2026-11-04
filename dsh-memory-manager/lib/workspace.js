/**
 * dsh-memory-manager — optional Workspace awareness for project keys.
 *
 * The contract prefers a Workspace id over a path hash: one Workspace keeps one
 * memory directory even when its directory is reached through a different spelling,
 * and an unregistered directory with the same path gets a different key. The registry
 * is an optional service (`inject` stays as the task specifies), so everything here
 * degrades to "no workspace" instead of failing: `resolveByPath` rejects for a missing
 * path, returns `undefined` for an existing unowned directory, and returns the
 * authoritative entity (`{ id, path, title, ... }`) for an owned one.
 *
 * The registry call is asynchronous (`realpath` + lookup), so only async paths may use
 * it. The synchronous prompt path reads a session-key cache that these async paths fill;
 * before it is filled, the path hash is the stable fallback.
 */

import { projectKeyOf } from './project-key.js';

/**
 * The registry service, when this composition has one.
 *
 * **Never read `ctx.workspaceRegistry` directly.** This plugin deliberately does not
 * `inject` the service (it is optional), and Cordis proxies non-injected services in a
 * way that *throws* on property access (`cannot get property "…" without inject`).
 * `ctx.get(name)` is the supported optional-service read, and it is wrapped because a
 * context that does not implement `get` at all (a test double, a reduced context) must
 * degrade to "no workspace", not fail a tool call.
 */
export function workspaceRegistryOf(ctx) {
  try {
    if (typeof ctx?.get !== 'function') return undefined;
    return ctx.get('workspaceRegistry');
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Workspace id owning `cwd`, or `null` when there is none.
 *
 * Accepts both shapes a caller can see: the authoritative entity (`id`) and the Remote
 * projection (`workspaceId`).
 *
 * @param {object} ctx
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
export async function resolveWorkspaceId(ctx, cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  try {
    const registry = workspaceRegistryOf(ctx);
    if (registry === undefined || registry === null || typeof registry.resolveByPath !== 'function') return null;
    const workspace = await registry.resolveByPath(cwd);
    if (workspace === undefined || workspace === null) return null;
    if (typeof workspace === 'string') return workspace === '' ? null : workspace;
    const id = workspace.workspaceId ?? workspace.id;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    // A missing path (realpath failure), an unavailable registry, and a registry call
    // that fails all mean the same thing here: no Workspace identity, fall back to the
    // path hash.
    return null;
  }
}

/** Workspace-aware project key for an async caller (tools, routes, events). */
export async function projectKeyForCwd(ctx, cwd) {
  return projectKeyOf(cwd, await resolveWorkspaceId(ctx, cwd));
}

/** The synchronous path-hash key used on the prompt path until resolution lands. */
export function projectKeyFallback(cwd) {
  return projectKeyOf(cwd);
}
