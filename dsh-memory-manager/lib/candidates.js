/**
 * dsh-memory-manager — the candidate area (P1).
 *
 * Dream consolidation and automatic extraction both produce *proposals*, never edits:
 * candidates land in `<memoryRoot>/candidates/<timestamp>.json` and only an explicit
 * adopt (the settings page, or a future tool) writes through the store. That boundary
 * is the whole point of the feature: an LLM can suggest a merge or a deletion, and the
 * user decides. Nothing in this module writes a memory file; `adopt` calls the same
 * `store.writeNote`/`updateNote`/`deleteNote` the tools use.
 */

import { readdir, readFile, rm, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { writeTextAtomic } from './store.js';
import { redactSecrets } from './redact.js';

/** Subdirectory under one memory root that holds candidate bundles. */
export const CANDIDATES_DIRECTORY = 'candidates';

/** How many candidate bundles are kept per root before the oldest are pruned. */
const CANDIDATES_KEEP = 20;

/** Encoded candidate actions and their store mapping. */
export const CANDIDATE_ACTIONS = Object.freeze(['create', 'update', 'delete']);

const VALID_TYPES = new Set(['env', 'user', 'feedback', 'project', 'reference']);

/** The directory that belongs to one scope's root. */
export function candidatesDirFor(store, { scope, projectKey }) {
  return join(store.dirFor(scope, projectKey), CANDIDATES_DIRECTORY);
}

/** A filesystem-safe bundle id: sortable ISO plus a short sequence when needed. */
function bundleStamp(now) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Normalize one model-proposed candidate. Unknown fields are dropped; a candidate that
 * cannot be applied safely is dropped with a reason rather than guessed at.
 *
 * @param {unknown} raw
 * @returns {{ action: string, name: string, description?: string, content?: string, type?: string, reason?: string } | null}
 */
export function normalizeCandidate(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : '';
  if (!CANDIDATE_ACTIONS.includes(action)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name === '') return null;
  const candidate = { action, name };
  if (typeof raw.description === 'string' && raw.description.trim() !== '') candidate.description = raw.description.trim();
  if (typeof raw.content === 'string' && raw.content.trim() !== '') candidate.content = raw.content;
  if (typeof raw.type === 'string' && VALID_TYPES.has(raw.type.trim().toLowerCase())) candidate.type = raw.type.trim().toLowerCase();
  if (typeof raw.reason === 'string' && raw.reason.trim() !== '') candidate.reason = raw.reason.trim().slice(0, 500);
  return candidate;
}

/** Extract and validate the candidate array from a model answer. */
export function normalizeCandidates(value, { limit = 30 } = {}) {
  const list = Array.isArray(value) ? value : value?.candidates;
  if (!Array.isArray(list)) return [];
  const candidates = [];
  for (const raw of list) {
    const candidate = normalizeCandidate(raw);
    if (candidate === null) continue;
    candidates.push(candidate);
    if (candidates.length >= limit) break;
  }
  return candidates;
}

/**
 * Mask secrets in one candidate's prose before it is written to a bundle.
 *
 * A candidate is model output derived from a transcript, so it can quote a credential
 * even though the prompt forbids it. Bundles are files like the memories are, so they go
 * through the same rule table; `redacted` keeps the count so adoption can tell the user
 * that a proposal was sanitised instead of masking silently.
 */
function sanitizeCandidate(candidate) {
  const description = candidate.description === undefined ? null : redactSecrets(candidate.description);
  const content = candidate.content === undefined ? null : redactSecrets(candidate.content);
  const count = (description?.count ?? 0) + (content?.count ?? 0);
  if (count === 0) return candidate;
  const sanitized = { ...candidate };
  if (description !== null) sanitized.description = description.text;
  if (content !== null) sanitized.content = content.text;
  sanitized.redacted = count;
  return sanitized;
}

/** Write one candidate bundle and return its id. */
export async function writeCandidateBundle(store, { scope, projectKey, source, candidates, now = new Date() }) {
  const dir = candidatesDirFor(store, { scope, projectKey });
  await mkdir(dir, { recursive: true });
  const base = `candidates-${bundleStamp(now)}`;
  let id = `${base}.json`;
  for (let suffix = 2; await fileExists(join(dir, id)); suffix += 1) id = `${base}-${suffix}.json`;
  const bundle = {
    version: 1,
    id,
    createdAt: now.toISOString(),
    source,
    scope,
    projectKey: projectKey ?? null,
    candidates: (Array.isArray(candidates) ? candidates : []).map(sanitizeCandidate),
  };
  await writeTextAtomic(join(dir, id), `${JSON.stringify(bundle, null, 2)}\n`);
  await pruneBundles(dir);
  return { id, bundle, path: join(dir, id) };
}

/** Whether a path exists (no throw). */
async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Keep the newest candidate bundles. */
async function pruneBundles(dir) {
  try {
    const names = (await readdir(dir)).filter((name) => name.startsWith('candidates-') && name.endsWith('.json')).sort();
    for (const name of names.slice(0, Math.max(0, names.length - CANDIDATES_KEEP))) {
      await rm(join(dir, name), { force: true });
    }
  } catch {
    /* pruning is best-effort */
  }
}

/** Read one bundle, or `null` when it is missing/unreadable/malformed. */
export async function readCandidateBundle(store, { scope, projectKey, id }) {
  if (typeof id !== 'string' || !/^candidates-[A-Za-z0-9_.-]+\.json$/.test(id)) return null;
  try {
    const text = await readFile(join(candidatesDirFor(store, { scope, projectKey }), id), 'utf8');
    const data = JSON.parse(text);
    if (data === null || typeof data !== 'object' || !Array.isArray(data.candidates)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * List candidate bundle summaries, newest first.
 * @returns {Promise<Array<{ id: string, createdAt: string, source: string, count: number }>>}
 */
export async function listCandidateBundles(store, { scope, projectKey }) {
  const dir = candidatesDirFor(store, { scope, projectKey });
  let names;
  try {
    names = (await readdir(dir)).filter((name) => name.startsWith('candidates-') && name.endsWith('.json')).sort().reverse();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const bundles = [];
  for (const id of names) {
    const bundle = await readCandidateBundle(store, { scope, projectKey, id });
    if (bundle === null) continue;
    bundles.push({
      id,
      createdAt: typeof bundle.createdAt === 'string' ? bundle.createdAt : null,
      source: typeof bundle.source === 'string' ? bundle.source : null,
      count: bundle.candidates.length,
    });
  }
  return bundles;
}

/** Rewrite a bundle after removing one candidate; delete the file when it is empty. */
async function removeCandidateAt(store, { scope, projectKey, bundle, index }) {
  const candidates = bundle.candidates.filter((_candidate, position) => position !== index);
  if (candidates.length === 0) {
    await rm(join(candidatesDirFor(store, { scope, projectKey }), bundle.id), { force: true });
    return { remaining: 0 };
  }
  const next = { ...bundle, candidates };
  await writeTextAtomic(join(candidatesDirFor(store, { scope, projectKey }), bundle.id), `${JSON.stringify(next, null, 2)}\n`);
  return { remaining: candidates.length };
}

/**
 * Apply one candidate through the same store methods the tools use.
 *
 * @returns {Promise<{ ok: true, action: string, name: string, remaining: number, redacted: number }>}
 */
export async function adoptCandidate(store, { scope, projectKey, id, index }) {
  const bundle = await readCandidateBundle(store, { scope, projectKey, id });
  if (bundle === null) {
    const error = new Error(`no candidate bundle ${JSON.stringify(id)} in the ${scope} scope`);
    error.code = 'not-found';
    throw error;
  }
  if (!Number.isInteger(index) || index < 0 || index >= bundle.candidates.length) {
    const error = new Error(`candidate index ${String(index)} is out of range (bundle has ${bundle.candidates.length})`);
    error.code = 'not-found';
    throw error;
  }
  const candidate = bundle.candidates[index];
  let applied = null;
  if (candidate.action === 'create') {
    applied = await store.writeNote({
      scope,
      projectKey,
      name: candidate.name,
      description: candidate.description ?? '',
      content: candidate.content ?? '',
      type: candidate.type ?? 'env',
      expect: 'absent',
    });
  } else if (candidate.action === 'update') {
    applied = await store.updateNote({ scope, projectKey, name: candidate.name, description: candidate.description, content: candidate.content, type: candidate.type });
  } else {
    const result = await store.deleteNote({ scope, projectKey, name: candidate.name });
    if (result.deleted !== true) {
      const error = new Error(`no memory named ${JSON.stringify(candidate.name)} exists in the ${scope} scope`);
      error.code = 'not-found';
      throw error;
    }
  }
  const { remaining } = await removeCandidateAt(store, { scope, projectKey, bundle, index });
  // The bundle was already sanitised when it was written; this carries that count (plus
  // any masking the final store write did) so adoption is never silently lossy.
  return { ok: true, action: candidate.action, name: candidate.name, remaining, redacted: (candidate.redacted ?? 0) + (applied?.redacted ?? 0) };
}

/**
 * Drop one candidate without touching memory files.
 * @returns {Promise<{ ok: true, remaining: number }>}
 */
export async function discardCandidate(store, { scope, projectKey, id, index }) {
  const bundle = await readCandidateBundle(store, { scope, projectKey, id });
  if (bundle === null) {
    const error = new Error(`no candidate bundle ${JSON.stringify(id)} in the ${scope} scope`);
    error.code = 'not-found';
    throw error;
  }
  if (!Number.isInteger(index) || index < 0 || index >= bundle.candidates.length) {
    const error = new Error(`candidate index ${String(index)} is out of range (bundle has ${bundle.candidates.length})`);
    error.code = 'not-found';
    throw error;
  }
  const { remaining } = await removeCandidateAt(store, { scope, projectKey, bundle, index });
  return { ok: true, remaining };
}
