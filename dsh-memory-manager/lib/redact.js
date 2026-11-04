/**
 * dsh-memory-manager — deterministic secret masking at the write entry.
 *
 * A memory is written for later sessions and is then re-injected into the prompt (the
 * digest) and into recall reminders. A credential that lands in a note therefore leaks
 * twice: once when it is written, and again every time the note is read back. Until now
 * the only protection was one sentence in the extraction prompt ("do not propose
 * secrets/credentials/tokens"), which is advice to a model — not a guarantee.
 *
 * This module is that guarantee, and it is deliberately mechanical:
 *
 *   - a fixed rule table (`REDACTION_RULES`), no model, no entropy heuristics, no deps;
 *   - applied inside `store.writeNote` / `store.updateNote`, which is the single write
 *     entry for all three writers (the `memory_*` tools, `POST /entry`, and candidate
 *     adoption), so no path can bypass it;
 *   - applied **before** the note is formatted, hashed, truncated, or written, and
 *     before the index row is derived from the description;
 *   - idempotent: the replacement text (`[REDACTED:<kind>]`) matches no rule, so writing
 *     the same note again does not keep changing it.
 *
 * The trade-off is explicit: a rule that fires on innocent prose mangles a user's note,
 * and masking is irreversible. The patterns are therefore anchored on token shapes
 * (prefix + length) or on an explicit `name: value` / `name=value` assignment whose
 * value contains a digit, never on bare high-entropy strings or bare words. That keeps
 * `token: GITHUB_TOKEN` and `secret: handshake` intact; the cost is that a weak
 * digit-free password (`password: changeme`) is not recognised. Every rule can be
 * inspected and removed in one place, and masking can be switched off entirely with
 * `redaction: false` in the plugin config.
 */

/**
 * The rule table. `kind` becomes the marker; `pattern` is global and must not use `$`
 * replacement semantics — `replace` builds its replacement literally.
 *
 * @type {ReadonlyArray<{ kind: string, pattern: RegExp, replace: (match: string, ...groups: string[]) => string }>}
 */
export const REDACTION_RULES = Object.freeze([
  {
    // PEM blocks, the one multi-line secret shape.
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => '[REDACTED:private-key]',
  },
  {
    // JWT: three base64url segments, the first one always starts with `eyJ` (`{"`).
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: () => '[REDACTED:jwt]',
  },
  {
    // OpenAI-style keys (`sk-…`, `sk-proj-…`).
    kind: 'api-key',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replace: () => '[REDACTED:api-key]',
  },
  {
    // GitHub tokens (classic, fine-grained, app, refresh) — underscores included so the
    // obvious placeholders people paste in tests are caught too.
    kind: 'api-key',
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{16,}/g,
    replace: () => '[REDACTED:api-key]',
  },
  {
    // AWS access key id.
    kind: 'api-key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => '[REDACTED:api-key]',
  },
  {
    // Google API key.
    kind: 'api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{30,}/g,
    replace: () => '[REDACTED:api-key]',
  },
  {
    // Slack tokens.
    kind: 'api-key',
    pattern: /\bxox[abposre]-[A-Za-z0-9-]{10,}/g,
    replace: () => '[REDACTED:api-key]',
  },
  {
    // An Authorization header copied into a note.
    kind: 'bearer',
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]{12,}=*/g,
    replace: () => '[REDACTED:bearer]',
  },
  {
    // URL basic auth: scheme://user:password@host — the whole userinfo is dropped, the
    // scheme and host are kept so the note still reads as a URL.
    kind: 'basic-auth',
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    replace: (_match, scheme) => `${scheme}[REDACTED:basic-auth]@`,
  },
  {
    // `api_key = "…"`, `token: …`, `password=…`, `client_secret: …` in prose or config.
    // Requires an explicit assignment plus a value of ≥8 characters that contains a
    // digit, so "token: GITHUB_TOKEN" / "secret: handshake" (names, not secrets) stay
    // readable; a digit-free password is the documented false negative.
    kind: 'credential',
    pattern:
      /\b(api[_-]?key|access[_-]?key(?:[_-]?id)?|secret(?:[_-]?key)?|client[_-]?secret|password|passwd|token)\b(\s*[:=]\s*)(["'`]?)(?=[A-Za-z0-9\-._~+/=]*\d)[A-Za-z0-9\-._~+/=]{8,}/gi,
    replace: (match, name, separator, quote) => `${name}${separator}${quote}[REDACTED:credential]`,
  },
]);

/**
 * Mask every secret-shaped substring in `text`.
 *
 * @param {unknown} text
 * @returns {{ text: string, count: number, kinds: string[] }}
 *   `count` is the number of replacements (not of rules that fired); `kinds` are the
 *   distinct markers used, for reporting "已脱敏 N 处".
 */
export function redactSecrets(text) {
  let value = typeof text === 'string' ? text : text === null || text === undefined ? '' : String(text);
  let count = 0;
  const kinds = [];
  for (const rule of REDACTION_RULES) {
    value = value.replace(rule.pattern, (...args) => {
      // `String.replace` passes (match, ...groups, offset, whole) — the last two are not
      // capture groups, so they are dropped before the rule builds its replacement.
      const groups = args.slice(1, -2);
      const replaced = rule.replace(args[0], ...groups);
      if (replaced !== args[0]) {
        count += 1;
        if (!kinds.includes(rule.kind)) kinds.push(rule.kind);
      }
      return replaced;
    });
  }
  return { text: value, count, kinds };
}

/**
 * Redact a whole note's user-visible fields. The description matters as much as the
 * body: it is what the index row and the prompt digest carry.
 *
 * @param {{ description?: unknown, content?: unknown, aliases?: string[] }} note
 * @returns {{ description: string, content: string, aliases: string[], count: number, kinds: string[] }}
 */
export function redactNote({ description, content, aliases = [] } = {}) {
  const descriptionRedaction = redactSecrets(description);
  const contentRedaction = redactSecrets(content);
  const cleanedAliases = [];
  let aliasCount = 0;
  const kinds = [...new Set([...descriptionRedaction.kinds, ...contentRedaction.kinds])];
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const redaction = redactSecrets(alias);
    aliasCount += redaction.count;
    for (const kind of redaction.kinds) if (!kinds.includes(kind)) kinds.push(kind);
    if (redaction.text.trim() !== '') cleanedAliases.push(redaction.text.trim());
  }
  return {
    description: descriptionRedaction.text,
    content: contentRedaction.text,
    aliases: cleanedAliases,
    count: descriptionRedaction.count + contentRedaction.count + aliasCount,
    kinds,
  };
}
