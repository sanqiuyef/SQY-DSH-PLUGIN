/**
 * dsh-plugin-hub / projection — hook → DSH 事件桥。
 *
 * 只支持 SPEC 列出的 6 个 ZCode/Claude hook 事件（其余明确不支持，见 SPEC §1）：
 *
 *   PreToolUse        → tools/pre-execute   （退出码 2 = deny，其余非 0 = 告警后放行）
 *   PostToolUse       → tools/post-execute  （只观察，永远 next()）
 *   UserPromptSubmit  → agent/pre-step      （只观察，永远 next()）
 *   SessionStart      → agent/created       （serial，等它跑完再开步）
 *   SessionEnd        → agent/disposed      （emit，fire-and-forget）
 *   Stop              → agent/turn-stopping （serial，只观察）
 *
 * 三条不可让步的规则：
 *   1. **任何 hook 失败都不能阻断会话**：spawn 失败、超时、非 0 退出、流读取失败，
 *      全部 catch 后 `next()`（PreToolUse 的退出码 2 是唯一例外，那是显式拒绝）。
 *   2. hook 是在 Agent 的 ctx 上注册的，所以只对该 Agent 的调用生效（scope 过滤）。
 *   3. 子进程 stdin 写入 JSON payload、stdout/stderr 只读取首行用于诊断，不把整段
 *      输出塞进会话（避免 hook 的噪声污染上下文）。
 *
 * 执行器优先用 `ctx.subprocess`（宿主管理的进程，遵守沙箱/环境规则），没有该服务时
 * 回退 `node:child_process`。两条路径都通过系统 shell 解释命令字符串（与 ZCode 一致：
 * hook 的 `command` 是 shell 片段，不是 argv）。
 */

import { spawn as spawnChild } from 'node:child_process';

/** 支持的 hook 事件（规范化后的标准名）。 */
export const HOOK_EVENTS = Object.freeze(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop']);

/** 默认超时：60s（可被 hook 的 timeout/timeoutMs 覆盖）。 */
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

/** 超时后等待进程真正退出的额外宽限；超过就放弃读取，按失败处理。 */
const HARD_TIMEOUT_GRACE_MS = 5_000;

/** 单路输出最多保留的字符数（只需要首行诊断，不需要全量）。 */
const MAX_STREAM_CHARS = 64 * 1024;

/** terms 规范化表：去掉分隔符并小写后匹配。 */
const EVENT_ALIASES = Object.freeze({
  pretooluse: 'PreToolUse',
  posttooluse: 'PostToolUse',
  userpromptsubmit: 'UserPromptSubmit',
  sessionstart: 'SessionStart',
  sessionend: 'SessionEnd',
  stop: 'Stop',
});

/** 告警前缀统一（SPEC §7）。 */
function warn(message) {
  console.warn(`[plugin-hub] ${message}`);
}

/**
 * 把外部写法（`PreToolUse` / `pre-tool-use` / `pretooluse`）规范成标准事件名。
 *
 * @param {unknown} name
 * @returns {string | undefined} 标准名；不支持的事件返回 undefined
 */
export function normalizeHookEvent(name) {
  if (typeof name !== 'string') return undefined;
  return EVENT_ALIASES[name.replace(/[-_\s]/gu, '').toLowerCase()];
}

/**
 * 规范化超时。ZCode/Claude 的 `timeout` 单位是**秒**，而内部字段是 `timeoutMs`；
 * 两者都接受，优先 `timeoutMs`。非正数/非有限值退回默认 60s。
 *
 * @param {{ timeout?: unknown, timeoutMs?: unknown }} hook
 * @returns {number}
 */
export function hookTimeoutMs(hook) {
  const explicitMs = hook?.timeoutMs;
  if (typeof explicitMs === 'number' && Number.isFinite(explicitMs) && explicitMs > 0) {
    return Math.min(Math.trunc(explicitMs), 10 * 60_000);
  }
  const seconds = hook?.timeout;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.trunc(seconds * 1000), 10 * 60_000);
  }
  return DEFAULT_HOOK_TIMEOUT_MS;
}

/**
 * matcher 匹配工具名。
 *
 * 语义按 Claude Code：缺省/空串/`*` 匹配全部；`A|B` 是「多个精确名」；否则当正则用
 * （ZCode 生态里存在 `Edit.*`、`^Bash$` 这类写法）。正则写坏了就退化为子串匹配，
 * 不让一条坏 matcher 让整个 hook 静默失效。
 *
 * @param {unknown} matcher
 * @param {string} toolName
 * @returns {boolean}
 */
export function matchesTool(matcher, toolName) {
  const pattern = typeof matcher === 'string' ? matcher.trim() : '';
  if (pattern === '' || pattern === '*') return true;
  const name = typeof toolName === 'string' ? toolName : '';
  const alternatives = pattern.split('|').map((part) => part.trim()).filter((part) => part !== '');
  if (alternatives.length > 1 && alternatives.every((part) => /^[A-Za-z0-9_-]+$/u.test(part))) {
    return alternatives.includes(name);
  }
  try {
    return new RegExp(pattern, 'u').test(name);
  } catch {
    return name.includes(pattern);
  }
}

/**
 * 取首行（去空白、限长）—— deny 的 reason 只用 stderr 首行。
 *
 * @param {string} text
 * @returns {string}
 */
function firstLine(text) {
  const line = String(text ?? '').split(/\r?\n/u).find((entry) => entry.trim() !== '');
  if (line === undefined) return '';
  const trimmed = line.trim();
  return trimmed.length <= 400 ? trimmed : `${trimmed.slice(0, 400)}…`;
}

/**
 * 系统 shell 的 argv。hook 的 command 是 shell 片段，必须经过 shell 解释。
 *
 * @param {string} command
 * @returns {string[]}
 */
function shellArgv(command) {
  if (process.platform === 'win32') {
    const shell = typeof process.env.ComSpec === 'string' && process.env.ComSpec !== '' ? process.env.ComSpec : 'cmd.exe';
    return [shell, '/d', '/s', '/c', command];
  }
  return ['/bin/sh', '-c', command];
}

/**
 * 起一个子进程，返回统一的小接口：`{ stdout, stderr, done, terminate }`。
 *
 * @param {object} hostCtx - 宿主插件上下文（取 ctx.subprocess）
 * @param {string} command - shell 片段
 * @param {string} cwd
 * @param {string} payloadText - 写入 stdin 的 JSON
 * @returns {{ stdout: any, stderr: any, done: Promise<{ exitCode: number | null, error?: unknown }>, terminate: () => void }}
 */
function startProcess(hostCtx, command, cwd, payloadText) {
  const subprocess = hostCtx?.subprocess;
  if (subprocess !== undefined && subprocess !== null && typeof subprocess.spawn === 'function') {
    const handle = subprocess.spawn({
      argv: shellArgv(command),
      cwd,
      // stdin 直接给数据（SubprocessStdinMode 的 `{ data }`），避免管道写入的时序竞态。
      stdio: { stdin: { data: payloadText }, stdout: 'pipe', stderr: 'pipe' },
      graceMs: HARD_TIMEOUT_GRACE_MS,
    });
    return {
      stdout: handle.stdout,
      stderr: handle.stderr,
      done: Promise.resolve(handle.done).then(
        (outcome) => ({ exitCode: typeof outcome?.exitCode === 'number' ? outcome.exitCode : null }),
        (error) => ({ exitCode: null, error }),
      ),
      terminate: () => handle.terminate?.(),
    };
  }
  const child = spawnChild(command, {
    cwd,
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    child.stdin?.end(payloadText);
  } catch {
    /* 子进程可能立刻退出；写 stdin 失败不影响它的退出码判定 */
  }
  const done = new Promise((resolveDone) => {
    child.once('error', (error) => resolveDone({ exitCode: null, error }));
    child.once('close', (code) => resolveDone({ exitCode: typeof code === 'number' ? code : null }));
  });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    done,
    terminate: () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
    },
  };
}

/**
 * 收集一路流的内容（有上限）。流不可用/中断都返回已读到的部分，绝不抛错。
 *
 * @param {any} stream
 * @returns {Promise<string>}
 */
async function collectStream(stream) {
  if (stream === undefined || stream === null) return '';
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      chunks.push(text);
      size += text.length;
      if (size >= MAX_STREAM_CHARS) break;
    }
  } catch {
    /* 流被 kill 打断是超时路径的正常现象 */
  }
  return chunks.join('');
}

/**
 * 跑一条 hook。
 *
 * @param {object} hostCtx
 * @param {{ command: string, timeout?: unknown, timeoutMs?: unknown }} hook
 * @param {string} cwd
 * @param {object} payload - 写入 stdin 的 JSON 对象
 * @returns {Promise<{ ok: true, exitCode: number | null, stdout: string, stderr: string, timedOut: boolean }
 *   | { ok: false, reason: string }>}
 */
export async function runHook(hostCtx, hook, cwd, payload) {
  const command = typeof hook?.command === 'string' ? hook.command.trim() : '';
  if (command === '') return { ok: false, reason: 'hook has no command' };
  const timeoutMs = hookTimeoutMs(hook);
  const payloadText = `${JSON.stringify(payload)}\n`;
  let process_;
  try {
    process_ = startProcess(hostCtx, command, cwd, payloadText);
  } catch (error) {
    return { ok: false, reason: `cannot spawn hook: ${error?.message ?? error}` };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process_.terminate();
    } catch {
      /* 已经退出 */
    }
  }, timeoutMs);
  // 硬截止：即使 terminate 没让流关闭，也不让会话卡在这条 hook 上。
  let hardTimer;
  const hardDeadline = new Promise((resolveDeadline) => {
    hardTimer = setTimeout(() => resolveDeadline({ exitCode: null, hardTimeout: true }), timeoutMs + HARD_TIMEOUT_GRACE_MS);
    hardTimer.unref?.();
  });
  try {
    const [outcome, stdout, stderr] = await Promise.all([
      Promise.race([process_.done, hardDeadline]),
      collectStream(process_.stdout),
      collectStream(process_.stderr),
    ]);
    if (outcome?.error !== undefined) {
      return { ok: false, reason: `hook process failed: ${outcome.error?.message ?? outcome.error}` };
    }
    return { ok: true, exitCode: outcome?.exitCode ?? null, stdout, stderr, timedOut: timedOut || outcome?.hardTimeout === true };
  } catch (error) {
    return { ok: false, reason: `hook execution failed: ${error?.message ?? error}` };
  } finally {
    clearTimeout(timer);
    clearTimeout(hardTimer);
  }
}

/**
 * 从 effective 插件记录里收集 hook 清单（规范事件名 + 超时）。
 *
 * @param {object} plugin
 * @returns {Array<{ event: string, matcher?: string, command: string, timeoutMs?: number, timeout?: number }>}
 */
function collectHooks(plugin) {
  const items = plugin?.components?.hooks;
  if (!Array.isArray(items)) return [];
  const hooks = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    const event = normalizeHookEvent(item.event);
    if (event === undefined) {
      warn(`hooks: ${plugin?.id ?? '?'} declares unsupported event "${String(item.event)}"; skipped`);
      continue;
    }
    if (typeof item.command !== 'string' || item.command.trim() === '') {
      warn(`hooks: ${plugin?.id ?? '?'} ${event} hook has no command; skipped`);
      continue;
    }
    hooks.push({
      event,
      ...(typeof item.matcher === 'string' && item.matcher !== '' ? { matcher: item.matcher } : {}),
      command: item.command,
      ...(typeof item.timeoutMs === 'number' ? { timeoutMs: item.timeoutMs } : {}),
      ...(typeof item.timeout === 'number' ? { timeout: item.timeout } : {}),
    });
  }
  return hooks;
}

/**
 * 构造一个 hooks 插件对象（一个插件一个单元）。
 *
 * @param {object} plugin - effective 插件记录
 * @param {{ cwd: string, hostCtx: object }} context - `hostCtx` 用来取 ctx.subprocess
 * @returns {{ name: string, apply: Function } | null}
 */
export function createHooksUnit(plugin, context = {}) {
  const pluginId = typeof plugin?.id === 'string' ? plugin.id : '';
  if (pluginId === '') return null;
  const cwd = typeof context.cwd === 'string' ? context.cwd : process.cwd();
  const hostCtx = context.hostCtx;
  const hooks = collectHooks(plugin);
  if (hooks.length === 0) return null;
  const basePayload = { plugin_id: pluginId, cwd };

  /**
   * 依次跑一个事件下的全部 hook；返回「是否有显式 deny」。
   *
   * @param {Array<object>} selected
   * @param {object} payload
   * @param {{ toolName?: string }} [options]
   * @returns {Promise<{ denied: boolean, reason: string }>}
   */
  async function runAll(selected, payload, options = {}) {
    for (const hook of selected) {
      if (options.toolName !== undefined && !matchesTool(hook.matcher, options.toolName)) continue;
      let result;
      try {
        result = await runHook(hostCtx, hook, cwd, payload);
      } catch (error) {
        warn(`hooks: ${pluginId} ${hook.event} threw: ${error?.message ?? error}`);
        continue;
      }
      if (!result.ok) {
        warn(`hooks: ${pluginId} ${hook.event}: ${result.reason}`);
        continue;
      }
      if (result.timedOut) warn(`hooks: ${pluginId} ${hook.event} timed out after ${hookTimeoutMs(hook)}ms; ignored`);
      if (result.exitCode === 2 && hook.event === 'PreToolUse') {
        const reason = firstLine(result.stderr) || firstLine(result.stdout) || `blocked by the ${pluginId} plugin hook`;
        return { denied: true, reason };
      }
      if (result.exitCode !== null && result.exitCode !== 0 && !result.timedOut) {
        warn(`hooks: ${pluginId} ${hook.event} exited with ${result.exitCode}${firstLine(result.stderr) === '' ? '' : `: ${firstLine(result.stderr)}`}`);
      }
    }
    return { denied: false, reason: '' };
  }

  const byEvent = (event) => hooks.filter((hook) => hook.event === event);

  return {
    name: `plugin-hub:hooks:${pluginId}`,
    /**
     * @param {object} ctx - agent 的子上下文（方面于该 Agent 的 scope）
     */
    apply(ctx) {
      const sessionId = (payload) => String(payload?.agent?.id ?? '');

      if (byEvent('PreToolUse').length > 0) {
        ctx.on('tools/pre-execute', async (exec, next) => {
          try {
            const decision = await runAll(
              byEvent('PreToolUse'),
              {
                ...basePayload,
                hook_event_name: 'PreToolUse',
                session_id: String(exec?.agent?.id ?? ''),
                tool_name: typeof exec?.name === 'string' ? exec.name : '',
                tool_input: exec?.arguments ?? null,
              },
              { toolName: exec?.name },
            );
            if (decision.denied) return { kind: 'deny', reason: decision.reason };
          } catch (error) {
            warn(`hooks: ${pluginId} PreToolUse bridge failed: ${error?.message ?? error}`);
          }
          return next();
        });
      }

      if (byEvent('PostToolUse').length > 0) {
        ctx.on('tools/post-execute', async (exec, result, next) => {
          try {
            await runAll(byEvent('PostToolUse'), {
              ...basePayload,
              hook_event_name: 'PostToolUse',
              session_id: String(exec?.agent?.id ?? ''),
              tool_name: typeof exec?.name === 'string' ? exec.name : '',
              tool_input: exec?.arguments ?? null,
              tool_response: result?.value ?? null,
            }, { toolName: exec?.name });
          } catch (error) {
            warn(`hooks: ${pluginId} PostToolUse bridge failed: ${error?.message ?? error}`);
          }
          return next();
        });
      }

      if (byEvent('UserPromptSubmit').length > 0) {
        ctx.on('agent/pre-step', async (payload, next) => {
          try {
            await runAll(byEvent('UserPromptSubmit'), {
              ...basePayload,
              hook_event_name: 'UserPromptSubmit',
              session_id: sessionId(payload),
              turn: payload?.turn ?? null,
              step: payload?.step ?? null,
              prompt: Array.isArray(payload?.messages) ? payload.messages : [],
            });
          } catch (error) {
            warn(`hooks: ${pluginId} UserPromptSubmit bridge failed: ${error?.message ?? error}`);
          }
          return next();
        });
      }

      if (byEvent('SessionStart').length > 0) {
        ctx.on('agent/created', async (payload) => {
          try {
            await runAll(byEvent('SessionStart'), {
              ...basePayload,
              hook_event_name: 'SessionStart',
              session_id: sessionId(payload),
              source: payload?.source ?? null,
            });
          } catch (error) {
            warn(`hooks: ${pluginId} SessionStart bridge failed: ${error?.message ?? error}`);
          }
        });
      }

      if (byEvent('SessionEnd').length > 0) {
        ctx.on('agent/disposed', (payload) => {
          // disposed 是 emit：不能阻塞卸载，也不能让失败冒泡。
          void runAll(byEvent('SessionEnd'), {
            ...basePayload,
            hook_event_name: 'SessionEnd',
            session_id: sessionId(payload),
          }).catch((error) => {
            warn(`hooks: ${pluginId} SessionEnd bridge failed: ${error?.message ?? error}`);
          });
        });
      }

      if (byEvent('Stop').length > 0) {
        ctx.on('agent/turn-stopping', async (payload) => {
          try {
            await runAll(byEvent('Stop'), {
              ...basePayload,
              hook_event_name: 'Stop',
              session_id: sessionId(payload),
              turn: payload?.turn ?? null,
            });
          } catch (error) {
            warn(`hooks: ${pluginId} Stop bridge failed: ${error?.message ?? error}`);
          }
        });
      }
    },
  };
}

/**
 * 供诊断复用：规范化后的事件清单。
 *
 * @param {object} plugin
 * @returns {string[]}
 */
export function hookEventsOf(plugin) {
  return collectHooks(plugin).map((hook) => hook.event);
}
