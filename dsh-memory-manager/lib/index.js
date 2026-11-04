import { join } from 'node:path';

import { createMemoryStore } from './store.js';
import { projectKeyOf } from './project-key.js';
import { resolveWorkspaceId } from './workspace.js';
import { registerTools } from './tools.js';
import { registerRoutes } from './routes.js';
import { createLlmInvoker } from './llm.js';
import { createRecallEngine } from './recall.js';
import { runExtraction } from './consolidate.js';
import { EVENTS_FILE, createEventLog } from './events.js';

/** Loader entry id, matching this bundle's `cordis.patch.yml`. */
export const name = 'memory-manager';

/** Host services this plugin needs. All of them must exist for the plugin to mount. */
export const inject = ['systemPrompt', 'tools', 'webServer', 'connection', 'workingDirectory'];

/** Narrow the extraction config (`extract.enabled` is false by default). */
export function resolveExtractConfig(config = {}) {
  const source = config?.extract !== null && typeof config?.extract === 'object' ? config.extract : {};
  const number = (key, fallback, min, max) => {
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? Math.trunc(value) : fallback;
  };
  return {
    enabled: source.enabled === true,
    minIntervalMs: number('minIntervalMs', 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    transcriptMessages: number('transcriptMessages', 20, 1, 100),
    maxChars: number('maxChars', 16000, 1000, 100000),
  };
}

/** Plain text of a user/assistant message event payload. */
function messageText(message) {
  if (message === null || message === undefined) return '';
  if (typeof message === 'string') return message;
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
      .filter((text) => text !== '')
      .join('\n');
  }
  return '';
}

/**
 * Default mid-conversation injection: append a `system/message` event.
 *
 * `@deepseek-ai/dsh-llm` is imported lazily because a profile bundle may not resolve
 * host packages; when it cannot be reached the feature degrades to "no injection"
 * (logged once) instead of failing the turn. Tests substitute `hostOptions.injectReminder`.
 */
function defaultReminderInjector(warn) {
  let warned = false;
  return async (agent, text) => {
    try {
      const host = await import('@deepseek-ai/dsh-llm');
      const createSystemMessage = host.createSystemMessage;
      if (typeof createSystemMessage !== 'function') return false;
      const session = agent.session;
      const header = session?.header ?? {};
      const turn = typeof header.turn === 'number' ? header.turn : 0;
      const step = typeof header.step === 'number' ? header.step : 0;
      session.append('system/message', { turn, step, message: createSystemMessage(text) });
      return true;
    } catch (error) {
      if (!warned) {
        warned = true;
        warn(`[dsh-memory-manager] recall reminder injection unavailable: ${error?.message ?? error}`);
      }
      return false;
    }
  };
}

/**
 * Mount the plugin.
 *
 * @param {object} ctx - Cordis plugin context
 * @param {object} [config] - plain object (roots, digest limits, recall/extract flags)
 * @param {{ injectReminder?: Function, now?: () => Date }} [hostOptions] - test seams
 */
export function apply(ctx, config = {}, hostOptions = {}) {
  const store = createMemoryStore({ config });
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message);
    } catch {
      /* logging must never be the reason a memory operation fails */
    }
  };
  const logger = { warn };
  const invoke = createLlmInvoker(ctx);
  // Bounded, append-only audit of the background runs (recall / dream / extract).
  // It sits beside the global memory root and is never injected into a prompt.
  const events = createEventLog({ file: join(store.roots.globalDir, EVENTS_FILE), logger });
  const recordEvent = (event) => {
    void events.append(event);
  };
  const recall = createRecallEngine({ store, invoke, config, logger, onEvent: recordEvent });
  const extract = resolveExtractConfig(config);
  const injectReminder = typeof hostOptions.injectReminder === 'function' ? hostOptions.injectReminder : defaultReminderInjector(warn);

  /**
   * Session → project key. The prompt path is synchronous, while the Workspace
   * resolution is asynchronous, so the async paths (agent creation, directory change)
   * write the resolved key here and the prompt path reads it. Until a key is resolved
   * the path hash is the stable fallback — the same rule as before, and it only
   * differs from the Workspace-based key when a Workspace actually owns the directory.
   */
  const sessionKeys = new Map();

  const sessionCwd = (session) => {
    try {
      const cwd = ctx.workingDirectory?.get?.(session);
      return typeof cwd === 'string' && cwd !== '' ? cwd : null;
    } catch {
      return null;
    }
  };

  /** Synchronous key for the prompt path. */
  const promptKey = (session) => {
    if (session === undefined || session === null) return null;
    const cached = sessionKeys.get(session);
    if (typeof cached === 'string') return cached;
    const cwd = sessionCwd(session);
    if (cwd === null) return null;
    try {
      return projectKeyOf(cwd);
    } catch {
      return null;
    }
  };

  /** Asynchronous Workspace-first key for tools, routes and event handlers. */
  const resolveSessionKey = async (session) => {
    const cwd = sessionCwd(session);
    if (cwd === null) return null;
    return projectKeyOf(cwd, await resolveWorkspaceId(ctx, cwd));
  };

  ctx.effect(() => {
    const disposers = [];
    try {
      disposers.push(...registerTools(ctx, store));
      disposers.push(...registerRoutes(ctx, store, { invoke, now: hostOptions.now, logger, events }));
      disposers.push(
        ctx.systemPrompt.section({
          name: 'memory:digest',
          order: 150,
          interpolate: false,
          text: (context) => {
            try {
              return store.digestFor(promptKey(context?.agent?.session));
            } catch (error) {
              warn(`[dsh-memory-manager] digest section failed: ${error?.message ?? error}`);
              return '';
            }
          },
        }),
      );
    } catch (error) {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose?.();
        } catch {
          /* best-effort rollback of a partially mounted surface */
        }
      }
      throw error;
    }

    // A fresh install has no roots yet; creating them is what makes the settings page's
    // "open directory" work before the first memory is written.
    void store.ensureRoots().catch((error) => {
      warn(`[dsh-memory-manager] creating the memory roots failed: ${error?.message ?? error}`);
    });
    // First model step should already know the global count.
    void store.prefetch('global').catch((error) => {
      warn(`[dsh-memory-manager] warming global memory failed: ${error?.message ?? error}`);
    });

    return () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose?.();
        } catch {
          /* one failing disposer must not keep the others mounted */
        }
      }
    };
  }, 'memory-manager: tools, prompt section, routes');

  // `agent/created` is a serial listener: it must not delay agent creation, so the
  // loads are started and not awaited. A reload (not just a cache miss) is intentional:
  // a new session should see memory written by another process since the last session.
  ctx.on('agent/created', ({ agent } = {}) => {
    if (agent === undefined || agent === null) return;
    const session = agent.session;
    void (async () => {
      const key = await resolveSessionKey(session);
      if (key !== null) sessionKeys.set(session, key);
      const loads = [store.refresh('global', null)];
      if (key !== null) loads.push(store.refresh('project', key));
      await Promise.all(loads);
    })().catch((error) => {
      warn(`[dsh-memory-manager] warming memory for a new agent failed: ${error?.message ?? error}`);
    });
  });

  // A session can `cd` mid-life. The prompt section derives its project key from the
  // session, so the new project's digest is loaded here rather than on the synchronous
  // prompt path (which cannot do I/O).
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'working-directory/change') return;
    const cwd = event?.data?.cwd;
    if (typeof cwd !== 'string' || cwd === '') return;
    void (async () => {
      const key = projectKeyOf(cwd, await resolveWorkspaceId(ctx, cwd));
      sessionKeys.set(session, key);
      await store.refresh('project', key);
    })().catch((error) => {
      warn(`[dsh-memory-manager] loading memory after a directory change failed: ${error?.message ?? error}`);
    });
  });

  ctx.on('agent/disposed', ({ agent } = {}) => {
    if (agent === undefined || agent === null) return;
    const session = agent.session;
    const key = sessionKeys.get(session) ?? promptKey(session);
    sessionKeys.delete(session);
    if (key !== null) store.forget(key);
    transcripts.delete(session);
    sessionQueries.delete(session);
    recall.forget(sessionIdOf(session));
    lastExtractAt.delete(sessionIdOf(session));
  });

  // ------------------------------------------------------------- P1 recall/extract
  // Both features are off by default; the listeners below are cheap no-ops until the
  // config opts in. Neither one ever blocks a turn: prefetch and extraction are started
  // and forgotten, with every failure swallowed.
  const sessionQueries = new Map();
  const transcripts = new Map();
  const lastExtractAt = new Map();

  const sessionIdOf = (session) => String(session?.id ?? '');

  const agentOf = (session) => {
    try {
      const registry = ctx.agents ?? (typeof ctx.get === 'function' ? ctx.get('agents') : undefined);
      return registry !== undefined && registry !== null && typeof registry.get === 'function' ? registry.get(session.id) : undefined;
    } catch {
      return undefined;
    }
  };

  const appendTranscript = (session, role, text) => {
    if (typeof text !== 'string' || text.trim() === '') return;
    let list = transcripts.get(session);
    if (list === undefined) {
      list = [];
      transcripts.set(session, list);
    }
    list.push({ role, text });
    if (list.length > 40) list.splice(0, list.length - 40);
  };

  const maybeRecall = async (session) => {
    if (recall.enabled !== true) return;
    const startedAt = Date.now();
    const agent = agentOf(session);
    if (agent === undefined || agent === null) {
      recordEvent({ type: 'recall', ok: false, reason: 'no-agent' });
      return;
    }
    const sessionId = sessionIdOf(session);
    if (sessionId === '') {
      recordEvent({ type: 'recall', ok: false, reason: 'no-session' });
      return;
    }
    const query = sessionQueries.get(session) ?? '';
    if (query.trim() === '') {
      recordEvent({ type: 'recall', ok: false, reason: 'no-query', ms: Date.now() - startedAt });
      return;
    }
    const marker = recall.beginTurn(sessionId);
    const projectKey = await resolveSessionKey(session);
    const result = await recall.prefetch({ sessionId, projectKey, query });
    if (result === null || !recall.isCurrentTurn(sessionId, marker)) return;
    await injectReminder(agent, result.text);
  };

  const maybeExtract = async (session) => {
    if (extract.enabled !== true) return;
    const sessionId = sessionIdOf(session);
    if (sessionId === '') return;
    const nowMs = (typeof hostOptions.now === 'function' ? hostOptions.now() : new Date()).getTime();
    const previous = lastExtractAt.get(sessionId) ?? 0;
    // Both early exits are recorded: with extraction on, "nothing happened this turn" is
    // the question the audit log exists to answer.
    if (nowMs - previous < extract.minIntervalMs) {
      recordEvent({ type: 'extract', ok: false, reason: 'throttled' });
      return;
    }
    const list = transcripts.get(session) ?? [];
    if (list.length === 0) {
      recordEvent({ type: 'extract', ok: false, reason: 'no-transcript' });
      return;
    }
    const transcript = list
      .slice(-extract.transcriptMessages)
      .map((message) => `${message.role}: ${message.text}`)
      .join('\n')
      .slice(0, extract.maxChars);
    lastExtractAt.set(sessionId, nowMs);
    const projectKey = await resolveSessionKey(session);
    void runExtraction({
      store,
      scope: projectKey === null ? 'global' : 'project',
      projectKey,
      transcript,
      invoke,
      logger,
      onEvent: recordEvent,
    }).catch((error) => {
      warn(`[dsh-memory-manager] extraction failed: ${error?.message ?? error}`);
    });
  };

  ctx.on('session/event', (session, event) => {
    const type = event?.type;
    if (type === 'user/message') {
      const text = messageText(event?.data);
      sessionQueries.set(session, text);
      appendTranscript(session, 'user', text);
      return;
    }
    if (type === 'assistant/message') {
      appendTranscript(session, 'assistant', messageText(event?.data?.message ?? event?.data));
      return;
    }
    if (type === 'turn/start') {
      void maybeRecall(session).catch((error) => warn(`[dsh-memory-manager] recall failed: ${error?.message ?? error}`));
      return;
    }
    if (type === 'turn/end') {
      void maybeExtract(session).catch((error) => warn(`[dsh-memory-manager] extraction failed: ${error?.message ?? error}`));
    }
  });

  // Turn boundary: converge anything this plugin marked dirty. Returning immediately
  // keeps the serial listener from extending the turn; the next assemble picks up the
  // new cache, and an unchanged cache renders identical text (no prompt churn).
  ctx.on('agent/turn-stopping', () => {
    void store.refreshDirty().catch((error) => {
      warn(`[dsh-memory-manager] refreshing dirty memory scopes failed: ${error?.message ?? error}`);
    });
  });
}

export default { name, inject, apply };