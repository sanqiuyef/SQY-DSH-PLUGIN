/**
 * dsh-memory-manager — the five model-facing memory tools.
 *
 * Names, arguments, and the scoring behind `memory_search` are kept aligned with the
 * `global-memory` MCP server the user already knows, so the model's habits transfer
 * unchanged. The difference is that these are registered on the host's own tool
 * registry (`ctx.tools.register`) rather than reached over MCP, and they run against
 * the same markdown files (see `store.js`).
 *
 * Registration contract (`dsh-tools/lib/index.js:2974`):
 *   - `parameters` is a **standard JSON Schema** in the host's supported subset
 *     (`type/oneOf/properties/required/additionalProperties/items/enum/const` plus
 *     annotations — no `minimum`, `pattern`, `minLength`, ...);
 *   - `output.schema` and `output.render` are mandatory, and `output.schema` must be
 *     in the same subset;
 *   - `execute(args, exec)` returns a value matching `output.schema`.
 *
 * Failures are thrown: the host's tool pipeline turns a thrown error into a
 * materialized error result the model can see and react to. That is the single
 * mechanism for both "self-healable" errors (bad name, missing memory) and
 * environment errors (lock timeout, disk failure), which is why the error messages
 * are written for the model, not for a log.
 *
 * Every write refreshes the digest cache in the same call, so the next model step
 * sees the new memory; a write also marks its scope dirty so the turn boundary
 * re-reads the disk and picks up anything another writer did meanwhile.
 */

import { TYPE_DESCRIPTIONS, VALID_TYPES } from './store.js';
import { projectKeyForCwd } from './workspace.js';
import { markMemoryRead } from './recall.js';

const TYPE_ENUM = [...VALID_TYPES];

const SCOPE_PROJECT = ['project', 'global'];
const SCOPE_READ = ['project', 'global', 'auto'];
const SCOPE_ANY = ['project', 'global', 'all'];

const POLICY =
  'Project memory is the default; use scope=global only for important cross-project facts. ' +
  'Search before writing to avoid duplicates, and keep descriptions to one line.';

/**
 * The agent's project key, or `null` when the call has no project context.
 *
 * Workspace-aware: a resolved Workspace id is preferred over the path hash, which is
 * why this is asynchronous. Tools are async, so that is free here.
 */
async function projectKeyOfExec(ctx, exec, { required = false } = {}) {
  const agent = exec?.agent;
  if (agent === undefined || agent === null) {
    if (required) throw new Error('this memory tool needs an agent session to resolve the project directory; pass scope=global to use the global store');
    return null;
  }
  let cwd;
  try {
    cwd = ctx.workingDirectory.get(agent.session);
  } catch {
    cwd = null;
  }
  if (typeof cwd !== 'string' || cwd === '') {
    if (required) throw new Error('the agent session has no working directory, so project memory cannot be resolved; pass scope=global');
    return null;
  }
  return projectKeyForCwd(ctx, cwd);
}

/** Reject an unknown type before it reaches the store (schema enum usually already did). */
function assertType(type) {
  if (type === undefined || type === null || type === '') return null;
  const normalized = String(type).toLowerCase();
  if (!VALID_TYPES.includes(normalized)) {
    throw new Error(`invalid type ${JSON.stringify(type)}; use ${VALID_TYPES.join(' / ')} (${Object.entries(TYPE_DESCRIPTIONS).map(([name, text]) => `${name}: ${text}`).join('; ')})`);
  }
  return normalized;
}

const text = (textContent) => [{ type: 'text', text: textContent }];

/**
 * Register all five tools. Returns the registry disposers (one per tool).
 *
 * @param {object} ctx - plugin context (needs `tools`, `workingDirectory`)
 * @param {ReturnType<import('./store.js').createMemoryStore>} store
 * @returns {Array<() => void>}
 */
export function registerTools(ctx, store) {
  const disposers = [];
  const register = (definition) => disposers.push(ctx.tools.register(definition));

  // 1) memory_write ---------------------------------------------------------
  register({
    name: 'memory_write',
    description:
      'Write or replace ONE memory note (frontmatter name/description/metadata.type + short body), then update the search index. ' +
      'Same name in the same scope replaces the note. ' +
      'The result lists similar existing notes (`similar`): if one of them is the same fact, rewrite it with its own name instead. ' +
      'Secrets (keys, tokens, passwords) are masked before the note is stored. ' +
      POLICY,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Stable short id, kebab-case or Chinese; becomes the file name.' },
        description: { type: 'string', description: 'One-line summary used by the index and search (<=120 chars recommended).' },
        content: { type: 'string', description: 'Body: the conclusion first, then why/how to apply it. Use absolute dates.' },
        type: { type: 'string', enum: TYPE_ENUM, description: 'Memory category.' },
        scope: { type: 'string', enum: SCOPE_PROJECT, description: 'Where to store; default project.' },
        aliases: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Other names this memory is known by. A later write under an alias records it here instead of creating a duplicate; it does not overwrite this note, so use the note name to update the text.',
        },
      },
      required: ['name', 'description', 'content'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          name: { type: 'string' },
          scope: { type: 'string' },
          path: { type: 'string' },
          created: { type: 'boolean' },
          aliases: { type: 'array', items: { type: 'string' } },
          redacted: { type: 'integer' },
          viaAlias: { type: 'string' },
          similar: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                scope: { type: 'string' },
                score: { type: 'number' },
              },
              required: ['name', 'description', 'scope', 'score'],
            },
          },
        },
        required: ['ok', 'name', 'scope', 'path', 'created', 'aliases', 'redacted', 'viaAlias', 'similar'],
      },
      render: (_args, value) => {
        const lines = [`${value.created ? 'Created' : 'Updated'} ${value.scope} memory "${value.name}" (${value.path}).`];
        if (typeof value.viaAlias === 'string' && value.viaAlias !== '') {
          // Writing under an alias records the alias but never overwrites the owner's
          // body; say so instead of pretending the new content was stored.
          lines.push(
            `"${value.viaAlias}" is an alias of "${value.name}": the alias was recorded and the note's existing text was left untouched. ` +
              `Call memory_write with name "${value.name}" to rewrite it.`,
          );
        }
        if (Array.isArray(value.aliases) && value.aliases.length > 0) lines.push(`Aliases: ${value.aliases.join(', ')}.`);
        if (value.redacted > 0) lines.push(`Masked ${value.redacted} secret(s) before storing; the note holds a [REDACTED:…] marker instead.`);
        if (Array.isArray(value.similar) && value.similar.length > 0) {
          lines.push(
            `Similar existing memories: ${value.similar.map((hit) => `${hit.name} (${hit.score})`).join(', ')}. ` +
              'If one of them is the same fact, call memory_write with that name to merge instead of keeping both.',
          );
        }
        return text(lines.join('\n'));
      },
    },
    async execute(args, exec) {
      const scope = args?.scope ?? 'project';
      if (!SCOPE_PROJECT.includes(scope)) throw new Error(`invalid scope ${JSON.stringify(scope)}; use project or global`);
      const type = assertType(args?.type) ?? 'env';
      const projectKey = scope === 'project' ? await projectKeyOfExec(ctx, exec, { required: true }) : null;
      // Best-effort: a failed similarity scan must never block the write.
      const similar = await store
        .similarNotes({ scope, projectKey, name: args?.name, description: args?.description, content: args?.content })
        .catch(() => []);
      const result = await store.writeNote({
        scope,
        projectKey,
        name: args?.name,
        description: args?.description,
        content: args?.content,
        type,
        aliases: args?.aliases,
      });
      return {
        ok: true,
        name: result.name,
        scope: result.scope,
        path: result.path,
        created: result.created,
        aliases: result.aliases ?? [],
        redacted: typeof result.redacted === 'number' ? result.redacted : 0,
        viaAlias: typeof result.viaAlias === 'string' ? result.viaAlias : '',
        similar,
      };
    },
  });

  // 2) memory_read ----------------------------------------------------------
  register({
    name: 'memory_read',
    description:
      'Read one memory note full text by name. scope=auto (default) tries the current project first, then the global store; ' +
      'names are matched case-insensitively. Call this after memory_search finds a relevant name.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'The memory name to read.' },
        scope: { type: 'string', enum: SCOPE_READ, description: 'auto (default) = project then global.' },
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          type: { type: 'string' },
          content: { type: 'string' },
          updatedAt: { type: 'string' },
        },
        required: ['name', 'description', 'type', 'content', 'updatedAt'],
      },
      render: (_args, value) => text(`${value.name} [${value.type}] (${value.updatedAt})\n${value.content}`),
    },
    async execute(args, exec) {
      const scope = args?.scope ?? 'auto';
      if (!SCOPE_READ.includes(scope)) throw new Error(`invalid scope ${JSON.stringify(scope)}; use auto, project, or global`);
      const projectKey = await projectKeyOfExec(ctx, exec, { required: scope === 'project' });
      const readOne = async (target) => store.readNote({ scope: target, projectKey, name: args?.name });
      let hit = null;
      if (scope === 'project') hit = await readOne('project');
      else if (scope === 'global') hit = await readOne('global');
      else {
        if (projectKey !== null) hit = await readOne('project');
        if (hit === null) hit = await readOne('global');
      }
      if (hit === null) throw new Error(`memory not found: ${JSON.stringify(args?.name)}. Try memory_search or memory_list.`);
      // Feeds the recall dedupe: a note the model just read is never worth recalling.
      markMemoryRead(hit.note.name);
      return {
        name: hit.note.name,
        description: hit.note.description,
        type: hit.note.type,
        content: hit.note.content,
        updatedAt: hit.updatedAt,
      };
    },
  });

  // 3) memory_search --------------------------------------------------------
  register({
    name: 'memory_search',
    description:
      'Keyword search over the current project and the global store (CJK-aware: bigrams; name x4 > description x3 > body x1, ' +
      'plus a whole-query substring bonus). Returns ranked rows plus a snippet — call memory_read for the full text. ' +
      'This is the intended first step whenever a question might already be answered by memory.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords; Chinese and English are both supported.' },
        type: { type: 'string', enum: TYPE_ENUM, description: 'Restrict to one memory category.' },
        scope: { type: 'string', enum: SCOPE_ANY, description: 'all (default) covers project + global.' },
        limit: { type: 'integer', description: 'Maximum results; default 8, max 50.' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                type: { type: 'string' },
                scope: { type: 'string' },
                score: { type: 'integer' },
                snippet: { type: 'string' },
              },
              required: ['name', 'description', 'type', 'scope', 'score', 'snippet'],
            },
          },
          total: { type: 'integer' },
        },
        required: ['results', 'total'],
      },
      render: (_args, value) =>
        value.total === 0
          ? text('No matching memory. Try memory_list to browse, or write the fact with memory_write if it is missing.')
          : text(
              `Matched ${value.total}:\n` +
                value.results
                  .map((hit) => `[${hit.scope}/${hit.type}] ${hit.name} — ${hit.description} (score ${hit.score})\n  ${hit.snippet}`)
                  .join('\n'),
            ),
    },
    async execute(args, exec) {
      const scope = args?.scope ?? 'all';
      if (!SCOPE_ANY.includes(scope)) throw new Error(`invalid scope ${JSON.stringify(scope)}; use all, project, or global`);
      const projectKey = await projectKeyOfExec(ctx, exec, { required: scope === 'project' });
      const type = assertType(args?.type);
      const result = await store.search({
        query: args?.query,
        scope,
        type: type ?? undefined,
        limit: args?.limit,
        projectKey,
      });
      // Project the hit fields the output schema declares; the store's rows also carry
      // path/updatedAt for the HTTP layer, which must not leak into the model result.
      return {
        results: result.hits.map((hit) => ({
          name: hit.name,
          description: hit.description,
          type: hit.type,
          scope: hit.scope,
          score: hit.score,
          snippet: hit.snippet,
        })),
        total: result.total,
      };
    },
  });

  // 4) memory_list ----------------------------------------------------------
  register({
    name: 'memory_list',
    description:
      'List memory index rows (name/type/description/updatedAt) for the current project and/or the global store, newest-first by name. ' +
      'Use it to browse when search finds nothing; it does not read note bodies.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        type: { type: 'string', enum: TYPE_ENUM, description: 'Restrict to one memory category.' },
        scope: { type: 'string', enum: SCOPE_ANY, description: 'all (default) covers project + global.' },
        limit: { type: 'integer', description: 'Maximum rows; default 100, max 500.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                type: { type: 'string' },
                updatedAt: { type: 'string' },
              },
              required: ['name', 'description', 'type', 'updatedAt'],
            },
          },
          total: { type: 'integer' },
        },
        required: ['entries', 'total'],
      },
      render: (_args, value) =>
        value.total === 0
          ? text('(no memories)')
          : text(`Total ${value.total}:\n` + value.entries.map((entry) => `[${entry.type}] ${entry.name} — ${entry.description}`).join('\n')),
    },
    async execute(args, exec) {
      const scope = args?.scope ?? 'all';
      if (!SCOPE_ANY.includes(scope)) throw new Error(`invalid scope ${JSON.stringify(scope)}; use all, project, or global`);
      const projectKey = await projectKeyOfExec(ctx, exec, { required: scope === 'project' });
      const type = assertType(args?.type);
      const result = await store.list({ scope, type: type ?? undefined, limit: args?.limit, projectKey });
      return {
        entries: result.entries.map(({ name, description, type: entryType, updatedAt }) => ({ name, description, type: entryType, updatedAt })),
        total: result.total,
      };
    },
  });

  // 5) memory_delete --------------------------------------------------------
  register({
    name: 'memory_delete',
    description:
      'Delete one memory note by name or alias, including its index row. Irreversible. scope=auto (default) tries the current ' +
      'project first, then the global store. The result names the note that was actually deleted, which may differ from the ' +
      'request when an alias was used. Prefer this only for notes the user asked to remove or that are plainly wrong.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'The memory name (or one of its aliases) to delete.' },
        scope: { type: 'string', enum: SCOPE_READ, description: 'auto (default) = project then global.' },
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          removed: { type: 'boolean' },
          name: { type: 'string' },
          viaAlias: { type: 'string' },
        },
        required: ['ok', 'removed', 'name', 'viaAlias'],
      },
      render: (args, value) =>
        text(
          value.removed
            ? `Deleted memory "${value.name}"${typeof value.viaAlias === 'string' && value.viaAlias !== '' ? ` (requested as "${value.viaAlias}")` : ''}.`
            : `Memory "${args?.name}" was not found.`,
        ),
    },
    async execute(args, exec) {
      const scope = args?.scope ?? 'auto';
      if (!SCOPE_READ.includes(scope)) throw new Error(`invalid scope ${JSON.stringify(scope)}; use auto, project, or global`);
      const projectKey = await projectKeyOfExec(ctx, exec, { required: scope === 'project' });
      const tryRemove = async (target) => store.deleteNote({ scope: target, projectKey, name: args?.name });
      let result = { deleted: false };
      if (scope === 'project') result = await tryRemove('project');
      else if (scope === 'global') result = await tryRemove('global');
      else {
        if (projectKey !== null) result = await tryRemove('project');
        if (!result.deleted) result = await tryRemove('global');
      }
      if (!result.deleted) throw new Error(`memory not found: ${JSON.stringify(args?.name)}; nothing was deleted. Try memory_list.`);
      return {
        ok: true,
        removed: true,
        name: typeof result.name === 'string' ? result.name : String(args?.name ?? ''),
        viaAlias: typeof result.viaAlias === 'string' ? result.viaAlias : '',
      };
    },
  });

  return disposers;
}
