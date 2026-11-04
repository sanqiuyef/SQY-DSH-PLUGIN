/**
 * dsh-memory-manager — dream consolidation and turn extraction (P1).
 *
 * Both features ask the model to propose memory changes; neither writes memory. Their
 * only output is a candidate bundle (see `candidates.js`), which the settings page can
 * adopt one row at a time. That is a deliberate downgrade of ZCode's auto-memory write:
 * an LLM suggestion is cheap, a wrong memory is expensive.
 *
 * Dream is **manual** (a route the user triggers) and follows ZCode's four stages:
 * Orient (what is this project), Gather (read the current memories), Consolidate (merge
 * duplicates, remove contradicted notes, turn relative dates absolute), Prune-Index
 * (flag index rows that no longer earn their place). Extraction runs after a turn only
 * when `extract.enabled` is true, is throttled, and proposes at most a few facts.
 *
 * Index acceptance thresholds mirror the contract: an index over 200 lines, 25 KB, or a
 * single line over 150 characters is reported as a warning next to the candidates — the
 * user sees it while deciding, and no automatic rewrite happens.
 */

import { normalizeCandidates, writeCandidateBundle } from './candidates.js';
import { parseJsonLoose } from './llm.js';

/** The candidate JSON schema shared by both prompts (strict-output attempt). */
export const CANDIDATE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'delete'] },
          name: { type: 'string' },
          description: { type: 'string' },
          content: { type: 'string' },
          type: { type: 'string', enum: ['env', 'user', 'feedback', 'project', 'reference'] },
          reason: { type: 'string' },
        },
        required: ['action', 'name'],
      },
    },
  },
  required: ['candidates'],
});

/** Contract thresholds for the index health line. */
export const INDEX_LIMITS = Object.freeze({ lines: 200, bytes: 25 * 1024, lineChars: 150 });

/** How many characters of memory bodies are sent to the model (prompt budget). */
const PROMPT_BODY_CHARS = 24000;

/** Build the index-health facts shown with a candidate bundle. */
export function indexHealth(scan) {
  const rows = Array.isArray(scan?.indexRows) ? scan.indexRows : [];
  const bytes = typeof scan?.indexSize === 'number' ? scan.indexSize : 0;
  const maxLineChars = rows.reduce((longest, line) => Math.max(longest, [...String(line)].length), 0);
  const warnings = [];
  if (rows.length > INDEX_LIMITS.lines) warnings.push(`MEMORY.md has ${rows.length} rows (threshold ${INDEX_LIMITS.lines})`);
  if (bytes > INDEX_LIMITS.bytes) warnings.push(`MEMORY.md is ${bytes} bytes (threshold ${INDEX_LIMITS.bytes})`);
  if (maxLineChars > INDEX_LIMITS.lineChars) warnings.push(`the longest MEMORY.md row is ${maxLineChars} characters (threshold ${INDEX_LIMITS.lineChars})`);
  return { lines: rows.length, bytes, maxLineChars, warnings };
}

/** A compact rendering of the current memories for the prompt. */
function renderManifest(entries, budgetChars = PROMPT_BODY_CHARS) {
  const parts = [];
  let used = 0;
  for (const entry of entries) {
    const block = `### ${entry.name} (${entry.type})\ndescription: ${entry.description}\n---\n${entry.content}\n`;
    if (used + block.length > budgetChars) break;
    parts.push(block);
    used += block.length;
  }
  return { text: parts.join('\n'), omitted: entries.length - parts.length };
}

const DREAM_SYSTEM =
  'You consolidate a project memory store. You may only PROPOSE changes; a human will review each one. ' +
  'Never invent facts, never include credentials, and keep every description to one line (<=120 chars). ' +
  'Answer with JSON only: {"candidates": [...]}.';

/**
 * The four-stage dream prompt, adapted from ZCode's dream assets to DSH's file layout
 * (frontmatter + `MEMORY.md` index; there is no separate AGENTS.md memory workflow).
 */
export function buildDreamPrompt({ scope, entries, health }) {
  const manifest = renderManifest(entries);
  const prompt = [
    'You are the "dream" consolidation pass over a memory store. Work through four stages, but output only the final candidate list.',
    '',
    '1. ORIENT — what is this project/scope, what kinds of facts does it hold? Use the memories below; do not guess.',
    '2. GATHER — read every memory; note duplicates, contradictions, stale observations, and relative dates ("yesterday", "last week").',
    '3. CONSOLIDATE — propose, for each issue:',
    '   - create: a new merged memory (only when merging genuinely improves recall),',
    '   - update: rewrite one memory (merge duplicates into it, resolve contradictions, convert relative dates to absolute dates, tighten the description),',
    '   - delete: remove a memory that is plainly wrong, superseded, or duplicated elsewhere.',
    '4. PRUNE-INDEX — the index rows that no longer earn their place are covered by the delete/update actions; do not propose index-only edits.',
    '',
    `Memory scope: ${scope}. Index health: ${health.lines} rows, ${health.bytes} bytes, longest row ${health.maxLineChars} chars.`,
    `Index warnings: ${health.warnings.length === 0 ? 'none' : health.warnings.join('; ')}.`,
    '',
    'Rules:',
    '- Only propose changes you can justify from the text below; no new external facts.',
    '- Prefer update over create+delete when one note can be rewritten.',
    '- `content` is the FULL replacement body for create/update; `description` is one line.',
    '- A delete candidate needs only action/name and a reason.',
    '- If nothing should change, return {"candidates": []}.',
    '',
    `Existing memories (${entries.length}, ${manifest.omitted} omitted for prompt budget):`,
    manifest.text,
    '',
    'Return the JSON object now.',
  ].join('\n');
  return { system: DREAM_SYSTEM, prompt };
}

const EXTRACT_SYSTEM =
  'You extract durable memory candidates from a conversation. You only PROPOSE; a human decides. ' +
  'Answer with JSON only: {"candidates": [...]}.';

const EXTRACT_PROMPT_RULES = [
  'Propose only facts that will still matter in a later session and are not already captured.',
  'Do NOT propose: secrets/credentials/tokens, transient task state or progress, code that is already readable in the repository,',
  'tool outputs, session-specific instructions, anything the user asked not to keep, or duplicates of existing memories.',
  'Prefer project-scoped facts; global facts only when they apply across projects.',
  'Use absolute dates. Keep descriptions to one line (<=120 chars).',
  'At most 3 candidates. If nothing qualifies, return {"candidates": []}.',
].join(' ');

/** Build the turn-extraction prompt from the recent transcript. */
export function buildExtractPrompt({ scope, transcript, entries }) {
  const existing = entries
    .slice(0, 80)
    .map((entry) => `- ${entry.name} (${entry.type}): ${entry.description}`)
    .join('\n');
  const prompt = [
    'Recent conversation:',
    String(transcript ?? '').slice(-16000),
    '',
    `Existing ${scope} memories (do not duplicate):`,
    existing === '' ? '(none)' : existing,
    '',
    EXTRACT_PROMPT_RULES,
    '',
    'Return the JSON object now.',
  ].join('\n');
  return { system: EXTRACT_SYSTEM, prompt };
}

function unavailableError() {
  const error = new Error('the model is not available in this host, so memory proposals cannot be generated');
  error.code = 'llm-unavailable';
  return error;
}

/**
 * Run one dream consolidation and write the candidate bundle (never memory files).
 *
 * @returns {Promise<{ id: string, count: number, index: object }>}
 */
export async function runConsolidation({ store, scope, projectKey, invoke, now = new Date(), logger = console, onEvent = null }) {
  const startedAt = Date.now();
  const report = (event) => {
    try {
      onEvent?.(event);
    } catch {
      /* the audit sink must never fail a consolidation */
    }
  };
  try {
    const target = scope === 'project' ? projectKey : null;
    const scan = await store.readScope(scope, target);
    const health = indexHealth(scan);
    const { system, prompt } = buildDreamPrompt({ scope, entries: scan.entries, health });
    const answer = await invoke({ system, prompt, schema: CANDIDATE_SCHEMA, maxTokens: 4000 });
    if (answer?.ok !== true) {
      logger?.warn?.(`[dsh-memory-manager] dream consolidation could not run: ${answer?.error ?? 'model unavailable'}`);
      report({ type: 'dream', ok: false, reason: 'model-unavailable', error: String(answer?.error ?? 'model unavailable'), ms: Date.now() - startedAt });
      throw unavailableError();
    }
    const candidates = normalizeCandidates(parseJsonLoose(answer.text), { limit: 30 });
    const bundle = await writeCandidateBundle(store, { scope, projectKey: target, source: 'dream', candidates, now });
    report({ type: 'dream', ok: true, count: candidates.length, ms: Date.now() - startedAt });
    return { id: bundle.id, count: candidates.length, index: health };
  } catch (error) {
    // A scan, prompt build, or bundle write can fail too, not just the model call; those
    // failures used to leave no trace in the audit log.
    if (error?.code !== 'llm-unavailable') {
      report({ type: 'dream', ok: false, reason: 'error', error: String(error?.message ?? error), ms: Date.now() - startedAt });
    }
    throw error;
  }
}

/**
 * Run one extraction pass over a transcript and write the candidate bundle.
 * Returns `null` when there is nothing to send (empty transcript / model unavailable);
 * extraction is best-effort by contract, and every outcome is reported through
 * `onEvent` so the reason survives in the audit log.
 *
 * @returns {Promise<{ id: string, count: number } | null>}
 */
export async function runExtraction({ store, scope = 'project', projectKey, transcript, invoke, now = new Date(), logger = console, onEvent = null }) {
  const startedAt = Date.now();
  const report = (event) => {
    try {
      onEvent?.(event);
    } catch {
      /* the audit sink must never fail an extraction */
    }
  };
  const text = String(transcript ?? '').trim();
  if (text === '') {
    report({ type: 'extract', ok: false, reason: 'empty-transcript', ms: Date.now() - startedAt });
    return null;
  }
  const target = scope === 'project' ? projectKey : null;
  const scan = await store.readScope(scope, target).catch(() => null);
  const entries = scan?.entries ?? [];
  const { system, prompt } = buildExtractPrompt({ scope, transcript: text, entries });
  try {
    const answer = await invoke({ system, prompt, schema: CANDIDATE_SCHEMA, maxTokens: 2000 });
    if (answer?.ok !== true) {
      report({ type: 'extract', ok: false, reason: 'model-unavailable', error: String(answer?.error ?? 'model unavailable'), ms: Date.now() - startedAt });
      return null;
    }
    const candidates = normalizeCandidates(parseJsonLoose(answer.text), { limit: 3 });
    if (candidates.length === 0) {
      report({ type: 'extract', ok: false, reason: 'no-candidates', ms: Date.now() - startedAt });
      return null;
    }
    const bundle = await writeCandidateBundle(store, { scope, projectKey: target, source: 'extract', candidates, now });
    report({ type: 'extract', ok: true, count: candidates.length, ms: Date.now() - startedAt });
    return { id: bundle.id, count: candidates.length };
  } catch (error) {
    logger?.warn?.(`[dsh-memory-manager] extraction failed: ${error?.message ?? error}`);
    report({ type: 'extract', ok: false, reason: 'error', error: String(error?.message ?? error), ms: Date.now() - startedAt });
    return null;
  }
}
