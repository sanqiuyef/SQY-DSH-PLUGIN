/**
 * dsh-memory-manager — a minimal model-invocation seam for the P1 features.
 *
 * The optional capabilities (selector recall, dream consolidation, extraction) all ask
 * the current model for strict JSON. The host's `ctx.llm` is a streaming API with a
 * prepared-call object; this module hides that behind one `invoke()` function so:
 *
 *   - every feature gets the same timeout/cancellation/parse behaviour;
 *   - the whole feature set can be exercised offline with a fake `ctx.llm`;
 *   - nothing here imports a host package statically (a bundle may not resolve
 *     `@deepseek-ai/dsh-llm`), so the model is reached through the service object only.
 *
 * Strict JSON schema support is attempted first when a feature has a schema. The host
 * does not publish that capability, so a failed strict attempt falls back to a plain
 * completion whose answer must be parsed tolerantly by the caller. Both paths return
 * text; no feature ever evaluates JS from the model.
 */

/** Extract text from one stream chunk without assuming a single wire shape. */
function chunkText(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (chunk === null || typeof chunk !== 'object') return '';
  if (typeof chunk.text === 'string') return chunk.text;
  if (typeof chunk.delta === 'string') return chunk.delta;
  if (chunk.delta !== null && typeof chunk.delta === 'object' && typeof chunk.delta.text === 'string') return chunk.delta.text;
  if (Array.isArray(chunk.content)) {
    return chunk.content
      .map((block) => (block !== null && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
      .join('');
  }
  return '';
}

/** The default model selection, when the composition exposes it. */
async function modelSelection(ctx) {
  try {
    const service = ctx?.agentDefaultModel ?? (typeof ctx?.get === 'function' ? ctx.get('agentDefaultModel') : undefined);
    if (service === undefined || service === null || typeof service.currentSelection !== 'function') return null;
    const selection = await service.currentSelection();
    return selection !== null && typeof selection === 'object' ? selection : null;
  } catch {
    return null;
  }
}

/**
 * Create the invocation function used by the P1 features.
 *
 * Returns `{ ok: false, error }` instead of throwing for every host-side failure:
 * the callers are background or best-effort by contract, and a failed model call must
 * never take down a turn or a route.
 *
 * @param {object} ctx - plugin context (may carry `llm` and `agentDefaultModel`)
 * @param {{ maxTokens?: number, timeoutMs?: number }} [defaults]
 */
export function createLlmInvoker(ctx, defaults = {}) {
  const maxTokens = Number.isFinite(defaults.maxTokens) ? defaults.maxTokens : 2000;
  const timeoutMs = Number.isFinite(defaults.timeoutMs) ? defaults.timeoutMs : 30000;

  return async function invoke({ system, prompt, schema = null, signal = null, maxTokens: requestTokens } = {}) {
    const llm = ctx?.llm;
    if (llm === undefined || llm === null || typeof llm.prepareCall !== 'function' || typeof llm.stream !== 'function') {
      return { ok: false, error: 'llm-unavailable' };
    }
    const selection = await modelSelection(ctx);
    const callTokens = Number.isFinite(requestTokens) ? requestTokens : maxTokens;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const composedSignal = signal === null || signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]);
    try {
      const call = await llm.prepareCall(
        {
          ...(selection?.provider === undefined ? {} : { provider: selection.provider }),
          ...(selection?.model === undefined ? {} : { model: selection.model }),
          maxTokens: callTokens,
        },
        composedSignal,
        (controls) => controls,
      );
      const baseOptions = {
        ...(call?.config !== null && typeof call?.config === 'object' ? call.config : {}),
        messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt ?? '') }] }],
        ...(system === undefined || system === null ? {} : { system }),
        signal: composedSignal,
      };
      const attempts = schema === null ? [false] : [true, false];
      let lastError = null;
      for (const strict of attempts) {
        try {
          const options = strict ? { ...baseOptions, responseJsonSchema: schema } : baseOptions;
          let text = '';
          for await (const chunk of llm.stream(options)) text += chunkText(chunk);
          return { ok: true, text, strict };
        } catch (error) {
          lastError = error;
        }
      }
      return { ok: false, error: String(lastError?.message ?? lastError ?? 'llm-call-failed') };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Parse a JSON object/array from a model answer that may be fenced or prefixed.
 *
 * Models that do not support structured output still tend to emit JSON; this accepts
 * ```json fences, leading prose, and trailing prose by scanning for the first balanced
 * object/array. It never executes anything and returns `null` on failure.
 *
 * @param {string} text
 * @returns {unknown|null}
 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string') return null;
  let source = text.trim();
  if (source === '') return null;
  // Strip a fenced block when present.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(source);
  if (fence !== null) source = fence[1].trim();
  try {
    return JSON.parse(source);
  } catch {
    /* fall through to a balanced-scan */
  }
  for (let start = 0; start < source.length; start += 1) {
    const opener = source[start];
    if (opener !== '{' && opener !== '[') continue;
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === opener) depth += 1;
      else if (char === closer) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}
