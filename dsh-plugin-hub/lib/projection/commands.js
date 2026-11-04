/**
 * dsh-plugin-hub / projection — per-Agent slash commands.
 *
 * 每个已启用插件 → agent.ctx 上一个 commands 插件单元；每个 command 一个
 * `commands.register()` 定义。挂到 agent.ctx 后定义只在该 Agent 的 command 层可见
 * （commands 服务：scoped 定义 shadow 全局同名定义）。
 *
 * 执行语义（SPEC §4）：
 *   handler 读命令文件正文 → 展开 `$ARGUMENTS` / `$1..$9` → 用
 *   `invocation.agent.followup(...)` 把展开后的提示词送进下一轮 → 返回 success 文本。
 *
 * 与 SPEC 的一处必要偏差（真实 API 要求，已核对 @deepseek-ai/dsh-llm 的类型）：
 *   `Agent.followup(input)` 收的是完整 `UserMessage`，即 `{ id, role, content, source }`。
 *   只给 `{ content, source }` 会被会话 inbox 当成 id 为 undefined 的消息（去重/持久化
 *   都会出问题）。所以这里用 `node:crypto` 的 randomUUID 自建等价消息 —— 这是
 *   `createUserMessage()` 的全部行为，且不必引入 @deepseek-ai/dsh-llm 依赖。
 *
 * 命令名**不加插件前缀**（用户明确要求 `/zotero` 而不是 `/zotero-personal:zotero`）；
 * 同一 Agent 内重名的处理交给挂载方提供的 `claimName()`：后到的跳过并告警。
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { parseFrontmatter } from './skills.js';

/** 与 commands 服务的 COMMAND_NAME 保持一致，避免 register() 抛错打断整批挂载。 */
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u;

/** 展开后单条 followup 的文本上限；超出截断并标注，避免把巨型文件塞进上下文。 */
const MAX_PROMPT_CHARS = 256 * 1024;

/** 告警前缀统一（SPEC §7）。 */
function warn(message) {
  console.warn(`[plugin-hub] ${message}`);
}

/**
 * 构造一条 user 角色消息（等价于 llm 包的 createUserMessage）。
 *
 * @param {string} text
 * @returns {{ id: string, role: 'user', content: Array<{ type: 'text', text: string }>, source: { kind: 'user' } }}
 */
export function createUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

/**
 * 展开命令模板。
 *
 * 规则（对齐 ZCode / Claude Code 的斜杠命令）：
 *   - `$ARGUMENTS` → 完整原始输入（已 trim）；
 *   - `$1`..`$9` → 输入按空白切分后的第 N 段，缺失替换为空串；
 *   - 模板里没有任何占位符时，把原始输入追加到末尾（保留作者写的段落结构）。
 *
 * 用单次 `replace` + 回调完成替换：如果先展开 `$1` 再展开 `$ARGUMENTS`，参数值里
 * 恰好含 `$2` 时会被二次替换，单遍扫描可以避免这种注入式改写。
 *
 * @param {string} template - 命令文件正文（已去 frontmatter）
 * @param {string} rawInput - 用户在 `/name` 后输入的原始文本
 * @returns {string}
 */
export function expandArguments(template, rawInput) {
  const input = typeof rawInput === 'string' ? rawInput.trim() : '';
  const tokens = input === '' ? [] : input.split(/\s+/u);
  let substituted = false;
  const expanded = String(template ?? '').replace(/\$(?:(\d)|ARGUMENTS)/gu, (_match, digit) => {
    substituted = true;
    if (digit === undefined) return input;
    return tokens[Number.parseInt(digit, 10) - 1] ?? '';
  });
  if (substituted) return expanded;
  if (input === '') return expanded;
  const separator = expanded.endsWith('\n') ? '\n' : '\n\n';
  return `${expanded}${separator}${input}`;
}

/**
 * 读命令文件并渲染成最终提示词。命令正文每次调用都重新读：用户改文件后不需要
 * 重新挂载就能生效（frontmatter 只用来跳过，不参与渲染）。
 *
 * @param {string} filePath
 * @param {string} rawInput
 * @returns {Promise<string>}
 */
async function renderCommandPrompt(filePath, rawInput) {
  const raw = await readFile(filePath, 'utf8');
  const parsed = parseFrontmatter(raw);
  const body = (parsed === undefined ? raw : parsed.body).trim();
  const text = expandArguments(body, rawInput);
  if (text.length <= MAX_PROMPT_CHARS) return text;
  return `${text.slice(0, MAX_PROMPT_CHARS)}\n\n[plugin-hub: command prompt truncated at ${MAX_PROMPT_CHARS} characters]`;
}

/**
 * 从 effective 插件记录里收集命令入口（只做形状过滤）。
 *
 * @param {object} plugin
 * @returns {Array<{ name: string, description: string, path: string, hint?: string }>}
 */
function collectCommandEntries(plugin) {
  const items = plugin?.components?.commands;
  if (!Array.isArray(items)) return [];
  const entries = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    if (typeof item.path !== 'string' || item.path === '') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (name === '') continue;
    const description = typeof item.description === 'string' ? item.description.trim() : '';
    const hint = typeof item.argumentHint === 'string' ? item.argumentHint.trim() : '';
    entries.push({
      name,
      description,
      path: item.path,
      ...(hint === '' ? {} : { hint }),
    });
  }
  return entries;
}

/**
 * 规范命令名：先按原样校验；不合法时尝试小写（`Review.md` → `review`），
 * 仍然不合法就返回 undefined 由调用方跳过 —— 静默改名会让用户找不到命令，
 * 所以改名必须伴随一次 warn（调用方负责）。
 *
 * @param {string} name
 * @returns {{ name: string, renamed: boolean } | undefined}
 */
function normalizeCommandName(name) {
  if (COMMAND_NAME.test(name)) return { name, renamed: false };
  const lowered = name.toLowerCase();
  if (COMMAND_NAME.test(lowered)) return { name: lowered, renamed: true };
  return undefined;
}

/**
 * 构造一个 commands 插件对象（一个插件一个单元）。
 *
 * @param {object} plugin - effective 插件记录
 * @param {{ cwd: string, claimName?: (name: string) => boolean }} context
 *   `claimName` 由挂载方提供，用于同一 Agent 内跨插件去重（返回 false 表示已被占用）。
 * @returns {{ name: string, inject: string[], apply: Function } | null}
 */
export function createCommandsUnit(plugin, context = {}) {
  const pluginId = typeof plugin?.id === 'string' ? plugin.id : '';
  if (pluginId === '') return null;
  const claimName = typeof context.claimName === 'function' ? context.claimName : () => true;
  const entries = [];
  for (const entry of collectCommandEntries(plugin)) {
    const normalized = normalizeCommandName(entry.name);
    if (normalized === undefined) {
      warn(`commands: ${pluginId} declares "${entry.name}", which is not a valid command name; skipped`);
      continue;
    }
    if (normalized.renamed) warn(`commands: ${pluginId} command "${entry.name}" registered as "${normalized.name}"`);
    if (!claimName(normalized.name)) {
      warn(`commands: ${pluginId} command "${normalized.name}" is already registered for this agent; skipped`);
      continue;
    }
    entries.push({ ...entry, name: normalized.name });
  }
  if (entries.length === 0) return null;

  return {
    name: `plugin-hub:commands:${pluginId}`,
    inject: ['commands'],
    /**
     * @param {object} ctx - 注入 commands 的子上下文
     */
    apply(ctx) {
      for (const entry of entries) {
        const description = entry.description === '' ? `Plugin command from ${pluginId}` : entry.description;
        ctx.commands.register({
          name: entry.name,
          description,
          ...(entry.hint === undefined ? {} : { input: { hint: entry.hint } }),
          /**
           * @param {{ agent: object, rawInput: string, signal: AbortSignal, commandId: string }} invocation
           * @returns {Promise<{ kind: 'success', text?: string } | { kind: 'error', text: string }>}
           */
          async handler(invocation) {
            let text;
            try {
              text = await renderCommandPrompt(entry.path, invocation?.rawInput);
            } catch (error) {
              return { kind: 'error', text: `/${entry.name}: cannot read ${entry.path}: ${error?.message ?? error}` };
            }
            const agent = invocation?.agent;
            if (agent === null || typeof agent !== 'object' || typeof agent.followup !== 'function') {
              return { kind: 'error', text: `/${entry.name}: the receiving agent cannot accept a follow-up message` };
            }
            try {
              agent.followup(createUserMessage(text));
            } catch (error) {
              return { kind: 'error', text: `/${entry.name}: cannot queue the expanded prompt: ${error?.message ?? error}` };
            }
            return { kind: 'success', text: `/${entry.name}: prompt expanded and queued` };
          },
        });
      }
    },
  };
}

/**
 * 供诊断复用：命令名清单。
 *
 * @param {object} plugin
 * @returns {string[]}
 */
export function commandNamesOf(plugin) {
  return collectCommandEntries(plugin).map((entry) => entry.name);
}
