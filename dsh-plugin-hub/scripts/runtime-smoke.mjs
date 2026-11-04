#!/usr/bin/env node
/**
 * dsh-plugin-hub —— 投影层冒烟测试（假 ctx / 假 Agent，全部记录挂载调用）。
 *
 * 覆盖 Lead 指定的 7 条，外加 3 条本次实现里风险最高的补充：
 *   1. 一次 sync 只挂一次；同签名二次 sync 不重复挂载
 *   2. cwd 变化 → 先卸后挂，旧 fiber 的 disposer 被调用
 *   3. agent/disposed → 全清
 *   4. resolveEffective 抛错 → 不崩、warn、下次还能重试
 *   5. hook PreToolUse 退出码 2 → deny；退出码 0 → next()
 *   6. command handler 收到展开后的 `$ARGUMENTS` / `$1`
 *   7. skills provider 的 list/get 对临时目录返回正确 candidate 与 content
 *   8. skills 路径围栏：插件根外的绝对路径必须被拒绝
 *   9. skills 内容不缓存：改文件后 list() 立刻看到新描述
 *  10. MCP 变量展开 + 缺失 user_config 时跳过该 server
 *  11. 全局占用表：patchId 派生 / 停用与异类行排除 / tools 前缀兜底（契约 §2）
 *  12. 项目占用表：只在 mcp 层已信任时计入，disabled 条目不占名
 *  13. 投影让位：插件 server 与全局/项目同名 → 跳过并记录；占用变化触发重新 reconcile
 *  14. 旧信任记录只读回退 → 点一次「信任」升级为 canonical（契约 §1.4）
 *
 * 用法：node scripts/runtime-smoke.mjs   （退出码 0 且最后打印 ALL PASS）
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { collectOccupancy, globalOccupancy, projectOccupancy, shadowingSource } from '../lib/occupancy.js';
import { aggregateHash, approveProject, canonicalTrustText, trustStateFor } from '../lib/project-trust.js';
import { mountProjection, projectionConflicts, projectionErrors, projectionSnapshot } from '../lib/projection/index.js';

/* ------------------------------------------------------------------ *
 * 测试脚手架
 * ------------------------------------------------------------------ */

const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => {
  warnings.push(args.map((arg) => String(arg)).join(' '));
};

let checks = 0;
function ok(label, condition, detail) {
  assert.ok(condition, detail === undefined ? label : `${label} (${detail})`);
  checks += 1;
  realWarn(`ok - ${label}`);
}

function equal(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  checks += 1;
  realWarn(`ok - ${label}`);
}

/** 宿主 ctx 的假实现：事件总线 + loader + workingDirectory（subprocess 可选注入）。 */
function createHostContext() {
  const listeners = new Map();
  // 可选宿主服务（pluginManager / tools …）：occupancy 用它读全局占用，缺了也要能跑。
  const services = new Map();
  return {
    listeners,
    services,
    subprocess: undefined,
    get(name) {
      return services.get(name);
    },
    loader: {
      import: async () => ({
        default: { name: '@deepseek-ai/dsh-mcp-client', inject: ['tools'], apply() {} },
      }),
    },
    workingDirectory: {
      get(session) {
        return session?.cwd;
      },
    },
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) ?? [];
        const index = current.indexOf(listener);
        if (index >= 0) current.splice(index, 1);
      };
    },
    /** 发送一个非 waterfall 事件。 */
    async emit(event, payload) {
      for (const listener of [...(listeners.get(event) ?? [])]) await listener(payload);
    },
    /** 发送一个 waterfall 事件；返回最后一个 decide 的值。 */
    async waterfall(event, payload) {
      const list = [...(listeners.get(event) ?? [])];
      const fallback = event === 'tools/pre-execute' ? { kind: 'allow' } : { kind: 'enter', messages: [] };
      let index = 0;
      const next = async () => (index >= list.length ? fallback : list[index++](payload, next));
      return next();
    },
  };
}

/**
 * 假 Agent：`ctx.plugin(obj, cfg)` 会真的调用 obj.apply（在按 fiber 隔离的子 ctx 上），
 * 并像 Cordis 一样在 fiber.dispose() 时回收该 fiber 内注册的 provider/command/listener。
 */
function createFakeAgent(sessionId, initialCwd) {
  const record = {
    mounted: [],
    providers: [],
    commands: new Map(),
    listeners: new Map(),
    followups: [],
  };

  function childContextFor(fiber) {
    const ctx = {
      skills: {
        registerProvider(create) {
          const entry = { create, disposed: false, provider: undefined };
          record.providers.push(entry);
          fiber.disposers.push(() => {
            entry.disposed = true;
          });
          return () => {
            entry.disposed = true;
          };
        },
      },
      commands: {
        register(definition) {
          record.commands.set(definition.name, definition);
          fiber.disposers.push(() => record.commands.delete(definition.name));
          return () => record.commands.delete(definition.name);
        },
      },
      on(event, listener) {
        const list = record.listeners.get(event) ?? [];
        list.push(listener);
        record.listeners.set(event, list);
        const off = () => {
          const index = list.indexOf(listener);
          if (index >= 0) list.splice(index, 1);
        };
        fiber.disposers.push(off);
        return off;
      },
      get(name) {
        return ctx[name];
      },
      effect(factory) {
        if (typeof factory !== 'function') return () => {};
        const disposer = factory();
        return typeof disposer === 'function' ? disposer : () => {};
      },
      logger: { warn() {}, info() {}, error() {} },
      subprocess: undefined,
    };
    return ctx;
  }

  const agent = {
    id: sessionId,
    session: { id: sessionId, cwd: initialCwd },
    followup(message) {
      record.followups.push(message);
    },
    ctx: {
      plugin(pluginObject, config) {
        const fiber = { name: pluginObject?.name ?? '(anonymous)', config, disposed: false, disposers: [] };
        pluginObject.apply?.(childContextFor(fiber), config);
        fiber.dispose = () => {
          if (fiber.disposed) return;
          fiber.disposed = true;
          for (const dispose of fiber.disposers.splice(0)) dispose();
        };
        record.mounted.push(fiber);
        return fiber;
      },
    },
  };
  return { agent, record };
}

/** 在假 Agent 侧触发一个 waterfall（hook 监听就注册在那里）。 */
async function agentWaterfall(record, event, ...args) {
  const list = [...(record.listeners.get(event) ?? [])];
  const fallback = event === 'tools/pre-execute' ? { kind: 'allow' } : { kind: 'accept' };
  let index = 0;
  const next = async () => (index >= list.length ? fallback : list[index++](...args, next));
  return next();
}

/** 假 subprocess 服务：按队列返回预设的退出码与输出。 */
function createFakeSubprocess(outcomes) {
  const calls = [];
  return {
    calls,
    spawn(spec) {
      calls.push(spec);
      const outcome = outcomes.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
      return {
        stdin: undefined,
        stdout: Readable.from([Buffer.from(outcome.stdout ?? '', 'utf8')]),
        stderr: Readable.from([Buffer.from(outcome.stderr ?? '', 'utf8')]),
        done: Promise.resolve({ exitCode: outcome.exitCode, signal: null }),
        terminate() {},
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * fixture：一个 ZCode 形状的插件目录
 * ------------------------------------------------------------------ */

async function writeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'plugin-hub-projection-'));
  const pluginRoot = join(root, 'zotero-personal');
  const skillPath = join(pluginRoot, 'skills', 'zotero', 'SKILL.md');
  const skillDir = join(pluginRoot, 'skills', 'zotero');
  const askPath = join(pluginRoot, 'commands', 'ask.md');
  const plainPath = join(pluginRoot, 'commands', 'plain.md');
  await mkdir(skillDir, { recursive: true });
  await mkdir(join(pluginRoot, 'commands'), { recursive: true });
  await writeFile(
    skillPath,
    ['---', 'name: zotero', 'description: Search the local Zotero library', 'whenToUse: when the user asks about references', '---', '', '# Zotero', '', 'Body text.'].join('\n'),
    'utf8',
  );
  await writeFile(
    askPath,
    ['---', 'description: Ask the zotero plugin', 'argument-hint: <question>', '---', 'Answer this using the library: $ARGUMENTS', 'For the term $1.'].join('\n'),
    'utf8',
  );
  await writeFile(plainPath, 'Do the thing without any placeholder.', 'utf8');
  return { root, pluginRoot, skillPath, skillDir, askPath, plainPath };
}

/**
 * effective 结果的 fixture（形状对齐 SPEC §4 scope.effectivePlugins）。
 */
function effectiveFor(pluginRoot, { hooks = [], mcpServers = {}, options = {}, skills } = {}) {
  return {
    plugins: [
      {
        id: 'zotero-personal',
        name: 'zotero-personal',
        version: '1.0.0',
        rootPath: pluginRoot,
        marketplace: 'local',
        enabled: true,
        enabledSource: 'user',
        options,
        components: {
          skills:
            skills ??
            [{ name: 'zotero', description: 'Search the local Zotero library', path: join(pluginRoot, 'skills', 'zotero', 'SKILL.md'), root: join(pluginRoot, 'skills', 'zotero') }],
          commands: [
            { name: 'ask', description: 'Ask the zotero plugin', path: join(pluginRoot, 'commands', 'ask.md'), argumentHint: '<question>' },
            { name: 'plain', description: 'A command without placeholders', path: join(pluginRoot, 'commands', 'plain.md') },
          ],
          agents: [],
          hooks,
          mcpServers,
          uiSurfaces: [],
          diagnostics: [],
        },
      },
    ],
    diagnostics: [],
    workspace: { path: join(pluginRoot, '..'), exists: true, hash: 'fixture', trusted: true },
  };
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

async function run() {
  const fixture = await writeFixture();
  const projectA = join(fixture.root, 'project-a');
  const projectB = join(fixture.root, 'project-b');
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });

  /* --- 1. 幂等：同签名二次 sync 不重复挂载 ------------------------- */
  {
    const host = createHostContext();
    const { agent, record } = createFakeAgent('session-1', projectA);
    let resolveCalls = 0;
    const dispose = mountProjection(host, {
      resolveEffective: async () => {
        resolveCalls += 1;
        return effectiveFor(fixture.pluginRoot);
      },
    });
    await host.emit('agent/created', { agent, source: 'test' });
    equal(record.mounted.length, 2, 'T1 created 挂载 2 个单元（此 fixture 无 hook）');
    const unitNames = record.mounted.map((fiber) => fiber.name).sort();
    equal(unitNames, ['plugin-hub:commands:zotero-personal', 'plugin-hub:skills:zotero-personal'], 'T1 单元名带 pluginId');

    await host.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal });
    equal(record.mounted.length, 2, 'T1 同签名 pre-step 不重复挂载');
    equal(resolveCalls, 2, 'T1 每步都会重新解析 effective（用于发现变化）');
    ok('T1 快照记录 1 个会话', projectionSnapshot().sessions.length === 1);

    /* --- 2. cwd 变化 → 先卸后挂 --------------------------------- */
    agent.session.cwd = projectB;
    await host.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal });
    equal(record.mounted.length, 4, 'T2 cwd 变化后重新挂载 2 个单元');
    ok('T2 旧 fiber 全部被 dispose', record.mounted.slice(0, 2).every((fiber) => fiber.disposed === true));
    ok('T2 新 fiber 全部存活', record.mounted.slice(2).every((fiber) => fiber.disposed === false));
    ok('T2 旧 skills provider 已注销', record.providers.filter((entry) => entry.disposed === true).length === 1);
    ok('T2 快照里的 cwd 已更新', projectionSnapshot().sessions[0].cwd === projectB);

    /* --- 3. agent/disposed → 全清 ------------------------------- */
    await host.emit('agent/disposed', { agent });
    ok('T3 全部 fiber 已 dispose', record.mounted.every((fiber) => fiber.disposed === true));
    equal(projectionSnapshot().sessions.length, 0, 'T3 快照清空');
    equal(record.commands.size, 0, 'T3 命令定义全部注销');
    equal(record.listeners.size === 0 || [...record.listeners.values()].every((list) => list.length === 0), true, 'T3 事件监听全部摘除');
    dispose();
  }

  /* --- 4. resolveEffective 抛错：不崩、warn、可重试 -------------- */
  {
    const host = createHostContext();
    const { agent, record } = createFakeAgent('session-2', projectA);
    let attempt = 0;
    const dispose = mountProjection(host, {
      resolveEffective: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('boom: workspace file is unreadable');
        return effectiveFor(fixture.pluginRoot);
      },
    });
    const before = warnings.length;
    await host.emit('agent/created', { agent, source: 'test' }); // 不抛
    equal(record.mounted.length, 0, 'T4 解析失败时什么都不挂');
    ok(
      'T4 解析失败只告警',
      warnings.slice(before).some((line) => line.includes('resolveEffective failed') && line.includes('boom')),
    );
    await host.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal });
    equal(record.mounted.length, 2, 'T4 下一次 sync 自动重试成功');
    dispose();
  }

  /* --- 5. hook：退出码 2 → deny；退出码 0 → next() -------------- */
  {
    const host = createHostContext();
    const { agent, record } = createFakeAgent('session-3', projectA);
    const outcomes = [
      { exitCode: 2, stdout: '', stderr: 'blocked: writes are disabled by the plugin\nsecond line ignored' },
      { exitCode: 0, stdout: 'fine', stderr: '' },
    ];
    host.subprocess = createFakeSubprocess(outcomes);
    const hooks = [{ event: 'PreToolUse', command: 'node guard.mjs', timeout: 5, matcher: 'write_file|edit_file' }];
    const dispose = mountProjection(host, { resolveEffective: async () => effectiveFor(fixture.pluginRoot, { hooks }) });
    await host.emit('agent/created', { agent, source: 'test' });

    const exec = { name: 'write_file', arguments: { path: 'a.txt' }, agent: { id: 'session-3' } };
    const denied = await agentWaterfall(record, 'tools/pre-execute', exec);
    equal(denied, { kind: 'deny', reason: 'blocked: writes are disabled by the plugin' }, 'T5 退出码 2 → deny（reason 取 stderr 首行）');

    const allowed = await agentWaterfall(record, 'tools/pre-execute', { ...exec, name: 'read_file' });
    equal(allowed, { kind: 'allow' }, 'T5 退出码 0 → next() 放行');

    const spec = host.subprocess.calls[0];
    ok('T5 hook 通过 ctx.subprocess 执行', Array.isArray(spec?.argv) && spec.argv.some((part) => String(part).includes('guard.mjs')));
    ok(
      'T5 stdin 收到 JSON payload',
      typeof spec?.stdio?.stdin?.data === 'string' && spec.stdio.stdin.data.includes('"hook_event_name":"PreToolUse"') && spec.stdio.stdin.data.includes('"tool_name":"write_file"'),
    );
    equal(spec?.stdio?.stdin?.data !== undefined && spec?.cwd, projectA, 'T5 hook 以会话 cwd 为工作目录');

    // 真实 child_process 回退路径（不注入 ctx.subprocess 时）。
    const script = join(fixture.root, 'exit2.mjs');
    await writeFile(script, 'process.exit(2);\n', 'utf8');
    host.subprocess = undefined;
    const realHooks = [{ event: 'PreToolUse', command: `"${process.execPath}" "${script}"` }];
    const realHost = createHostContext();
    const realAgent = createFakeAgent('session-3b', projectA);
    const disposeReal = mountProjection(realHost, { resolveEffective: async () => effectiveFor(fixture.pluginRoot, { hooks: realHooks }) });
    await realHost.emit('agent/created', { agent: realAgent.agent, source: 'test' });
    const realDenied = await agentWaterfall(realAgent.record, 'tools/pre-execute', exec);
    equal(realDenied.kind, 'deny', 'T5 无 ctx.subprocess 时回退 node:child_process（退出码 2 → deny）');
    disposeReal();
    dispose();
  }

  /* --- 6. command handler 展开 $ARGUMENTS / $1 ------------------ */
  {
    const host = createHostContext();
    const { agent, record } = createFakeAgent('session-4', projectA);
    const dispose = mountProjection(host, { resolveEffective: async () => effectiveFor(fixture.pluginRoot) });
    await host.emit('agent/created', { agent, source: 'test' });

    const ask = record.commands.get('ask');
    ok('T6 命令已注册', ask !== undefined);
    equal(ask.input, { hint: '<question>' }, 'T6 argumentHint 映射为 input.hint');
    const result = await ask.handler({ agent, rawInput: 'quantum dots', signal: new AbortController().signal, commandId: 'cmd-1' });
    equal(result.kind, 'success', 'T6 handler 返回 success');
    equal(record.followups.length, 1, 'T6 产生一条 followup');
    const message = record.followups[0];
    const text = message.content[0].text;
    ok('T6 $ARGUMENTS 被替换', text.includes('Answer this using the library: quantum dots'), text);
    ok('T6 $1 被替换', text.includes('For the term quantum.'), text);
    equal(message.source, { kind: 'user' }, 'T6 followup source 为 user');
    ok('T6 followup 是完整 UserMessage（含 id/role）', typeof message.id === 'string' && message.id.length > 0 && message.role === 'user');

    const plain = record.commands.get('plain');
    await plain.handler({ agent, rawInput: 'and then stop', signal: new AbortController().signal, commandId: 'cmd-2' });
    const plainText = record.followups[1].content[0].text;
    equal(plainText, 'Do the thing without any placeholder.\n\nand then stop', 'T6 无占位符时把原始输入追加到末尾');
    dispose();
  }

  /* --- 7/9. skills provider：list/get + 内容不缓存 ---------------- */
  {
    const host = createHostContext();
    const { agent, record } = createFakeAgent('session-5', projectA);
    const dispose = mountProjection(host, { resolveEffective: async () => effectiveFor(fixture.pluginRoot) });
    await host.emit('agent/created', { agent, source: 'test' });

    const entry = record.providers.find((item) => item.disposed === false);
    ok('T7 注册了一个 skills provider', entry !== undefined);
    const provider = entry.create({ signal: new AbortController().signal, invalidate() {} });
    equal(provider.name, 'plugin-hub:zotero-personal', 'T7 provider 名带 pluginId');

    const candidates = await provider.list({ cwd: projectA });
    equal(Array.isArray(candidates) ? candidates.length : candidates.candidates.length, 1, 'T7 list 返回 1 个 candidate');
    const candidate = Array.isArray(candidates) ? candidates[0] : candidates.candidates[0];
    equal(candidate.name, 'zotero', 'T7 candidate.name');
    equal(candidate.provider, 'plugin-hub:zotero-personal', 'T7 candidate.provider 与 provider 名一致（服务端会校验）');
    equal(candidate.source, 'plugin-hub', 'T7 candidate.source');
    ok('T7 candidate.description 非空', typeof candidate.description === 'string' && candidate.description.length > 0);
    equal(candidate.invocation, { modelInvocable: true, userInvocable: true }, 'T7 candidate.invocation 默认策略');
    ok('T7 candidate.rank 是有限数', typeof candidate.rank === 'number' && Number.isFinite(candidate.rank));
    equal(candidate.path, fixture.skillPath, 'T7 candidate.path 来自 effective 的绝对路径');

    const definition = await provider.get(candidate, {});
    ok('T7 get 返回完整正文', typeof definition.content === 'string' && definition.content.includes('# Zotero') && definition.content.includes('Body text.'));
    equal(definition.resourceBase, { kind: 'directory', path: fixture.skillDir }, 'T7 resourceBase 指向技能目录');

    // 内容不缓存：直接改盘后 list() 必须立刻看到新描述。
    await writeFile(
      fixture.skillPath,
      ['---', 'name: zotero', 'description: Search Zotero (edited on disk)', '---', '', '# Zotero', '', 'Edited body.'].join('\n'),
      'utf8',
    );
    const refreshed = await provider.list({ cwd: projectA });
    const refreshedCandidate = Array.isArray(refreshed) ? refreshed[0] : refreshed.candidates[0];
    equal(refreshedCandidate.description, 'Search Zotero (edited on disk)', 'T9 list 每次重新读盘（不缓存内容）');
    const refreshedDefinition = await provider.get(refreshedCandidate, {});
    ok('T9 get 也重新读盘', refreshedDefinition.content.includes('Edited body.'));
    dispose();
  }

  /* --- 8. skills 路径围栏：插件根外的路径必须拒绝 ----------------- */
  {
    const host = createHostContext();
    const { agent, record } = createFakeAgent('session-6', projectA);
    const outside = join(fixture.root, 'outside', 'SKILL.md');
    await mkdir(join(fixture.root, 'outside'), { recursive: true });
    await writeFile(outside, ['---', 'name: outside', 'description: should never be loaded', '---', '', 'secret'].join('\n'), 'utf8');
    const skills = [{ name: 'outside', description: 'should never be loaded', path: outside, root: join(fixture.root, 'outside') }];
    const dispose = mountProjection(host, { resolveEffective: async () => effectiveFor(fixture.pluginRoot, { skills }) });
    await host.emit('agent/created', { agent, source: 'test' });
    const entry = record.providers.find((item) => item.disposed === false);
    const provider = entry.create({ signal: new AbortController().signal, invalidate() {} });
    const candidates = await provider.list({ cwd: projectA });
    const rows = Array.isArray(candidates) ? candidates : candidates.candidates;
    equal(rows.length, 0, 'T8 插件根外的技能被拒绝（词法围栏）');
    ok(
      'T8 拒绝时给出告警',
      warnings.some((line) => line.includes('outside the plugin root')),
    );
    dispose();
  }

  /* --- 10. MCP：变量展开 + 缺失 user_config 跳过 ------------------ */
  {
    const host = createHostContext();
    const { agent, record } = createFakeAgent('session-7', projectA);
    const mcpServers = {
      'zotero-bridge': {
        command: 'node',
        args: ['${ZCODE_PLUGIN_ROOT}/bin/server.js', '--data', '${ZCODE_PLUGIN_DATA}', '--project', '${ZCODE_PROJECT_DIR}'],
        env: { TOKEN: '${user_config.token}' },
      },
      leaky: {
        command: 'node',
        args: ['server.js'],
        env: { API_KEY: '${user_config.apiKey}' },
      },
    };
    const dispose = mountProjection(host, {
      resolveEffective: async () => effectiveFor(fixture.pluginRoot, { mcpServers, options: { token: 'abc123' } }),
    });
    await host.emit('agent/created', { agent, source: 'test' });

    const mounted = record.mounted.find((fiber) => fiber.config?.serverName === 'zotero-bridge');
    ok('T10 MCP server 已挂载', mounted !== undefined);
    equal(mounted.config.transport, 'stdio', 'T10 默认 transport 推断为 stdio');
    equal(mounted.config.args[0], `${fixture.pluginRoot}/bin/server.js`, 'T10 ${ZCODE_PLUGIN_ROOT} 展开');
    equal(mounted.config.args[4], projectA, 'T10 ${ZCODE_PROJECT_DIR} 展开为会话 cwd');
    ok('T10 ${ZCODE_PLUGIN_DATA} 展开到 plugin-hub 数据目录', mounted.config.args[2].includes('plugin-hub') && mounted.config.args[2].includes('zotero-personal'));
    equal(mounted.config.env.TOKEN, 'abc123', 'T10 ${user_config.token} 取自该插件 options');
    ok(
      'T10 缺失 user_config 的 server 被跳过',
      record.mounted.every((fiber) => fiber.config?.serverName !== 'leaky'),
    );
    ok(
      'T10 缺失 user_config 时给出告警',
      warnings.some((line) => line.includes('user_config.apiKey') && line.includes('skipped')),
    );
    dispose();
  }

  /* --- 11. 全局占用表：patchId / 停用 / 异类行 / tools 兜底 -------- */
  const previousEnv = { home: process.env.DSH_HOME, profile: process.env.DSH_PROFILE };
  const homeDir = join(fixture.root, 'home');
  process.env.DSH_HOME = homeDir;
  process.env.DSH_PROFILE = 'runtime-smoke';
  {
    const host = createHostContext();
    host.services.set('pluginManager', {
      listPlugins: async () => [
        { moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, patchId: 'mcp-client-alpha' },
        { moduleName: '@deepseek-ai/dsh-mcp-client', enabled: false, patchId: 'mcp-client-beta' },
        { moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, patchId: 'other-alpha' },
        { moduleName: 'some-other-plugin', enabled: true, patchId: 'mcp-client-gamma' },
        'not-an-object',
      ],
    });
    // 手写 patch 行没有 patchId，只能靠工具名兜底；工具名不切分，按候选名做前缀匹配。
    host.services.set('tools', { schemas: () => [{ name: 'mcp__delta__search' }, { name: 'read_file' }] });

    const occupancy = await globalOccupancy(host);
    equal([...occupancy.names].sort(), ['alpha'], 'T11 patchId 前缀派生全局名（停用行/异类行不算）');
    equal(occupancy.tools, ['mcp__delta__search'], 'T11 只收 mcp__ 前缀的工具名');
    equal(shadowingSource('alpha', { global: occupancy, project: { names: new Set() } }), 'global', 'T11 patchId 命中 → global');
    equal(shadowingSource('delta', { global: occupancy, project: { names: new Set() } }), 'global', 'T11 tools 前缀兜底 → global');
    equal(shadowingSource('beta', { global: occupancy, project: { names: new Set() } }), null, 'T11 停用的全局行不占名');
    equal(shadowingSource('deltaX', { global: occupancy, project: { names: new Set() } }), null, 'T11 前缀必须带命名空间分隔（不误伤 deltaX）');

    // 服务缺失 = 空占用，不抛错（重名优先级不能拦住正常挂载）。
    const empty = await collectOccupancy(createHostContext(), projectA);
    equal([...empty.global.names], [], 'T11 没有 pluginManager 时退化为空集合');
    equal(empty.global.tools, [], 'T11 没有 tools 服务时退化为空集合');
  }

  /* --- 12. 项目占用表：只在 mcp 层已信任时计入 -------------------- */
  {
    // 契约 §1.3 的测试向量：两份文件都不存在时的 canonical 文本与聚合 hash 必须逐字节一致。
    equal(canonicalTrustText(null, null), 'dsh-project-trust/v1\nmcp:-\nplugins:-', 'T12 canonical 文本照契约 §1.3');
    equal(
      aggregateHash(null, null),
      '63ec3eb212c5b2dd706c7b5faeece6476df07d5666b82583fb140723ad70049f',
      'T12 空项目的聚合 hash 命中契约测试向量',
    );

    const host = createHostContext();
    const projectC = join(fixture.root, 'project-c');
    await mkdir(join(projectC, '.dsh'), { recursive: true });
    await writeFile(
      join(projectC, '.dsh', 'mcp.json'),
      `${JSON.stringify(
        {
          mcpServers: {
            alpha: { command: 'node', args: ['alpha.mjs'] },
            skim: { command: 'node', args: ['skim.mjs'] },
            off: { command: 'node', args: ['off.mjs'] },
            'bad name': { command: 'node', args: ['bad.mjs'] },
          },
          disabled: ['off'],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const before = await projectOccupancy(host, projectC);
    equal(before.layer, 'untrusted', 'T12 未信任时 mcp 层标记 untrusted');
    equal([...before.names], [], 'T12 未信任的项目服务器一个都不占名');

    const written = await approveProject(host, projectC);
    ok(
      'T12 统一信任写入 canonical 存储（<profileDir>/data/project-trust/trusted.json）',
      written.storePath.replaceAll('\\', '/').endsWith('/data/project-trust/trusted.json'),
      written.storePath,
    );
    const store = JSON.parse(await readFile(written.storePath, 'utf8'));
    equal(store.version, 1, 'T12 canonical 存储 version=1');
    const stored = store.projects[written.key] ?? null;
    ok('T12 canonical 记录的 key 是规范化 cwd', stored !== null && typeof stored.hash === 'string', written.key);
    equal(stored.files.mcp, written.files.mcp, 'T12 记录 mcp 文件 hash');
    equal(stored.files.plugins, null, 'T12 只有 mcp.json 时 plugins hash 为 null');

    const after = await trustStateFor(host, projectC);
    equal(after.mcp, 'trusted', 'T12 批准后 mcp 层 trusted');
    equal(after.plugins, 'not-applicable', 'T12 没有 plugins.json → plugins 层 not-applicable');
    equal(after.shared, true, 'T12 记录命中 canonical（shared）');
    equal(after.source, 'shared', 'T12 来源标记 shared');
    equal(after.hash, written.hash, 'T12 聚合 hash 与写入值一致');

    const occupied = await projectOccupancy(host, projectC);
    equal([...occupied.names].sort(), ['alpha', 'skim'], 'T12 已信任后计入 mcpServers 减 disabled（非法名忽略）');
    equal(occupied.layer, 'trusted', 'T12 占用表带上 mcp 层状态');

    // 文件内容一变（等同 git pull），聚合 hash 不再命中：占用立即清空。
    await writeFile(join(projectC, '.dsh', 'mcp.json'), '{"mcpServers":{"alpha":{"command":"node"}}}\n', 'utf8');
    const drifted = await projectOccupancy(host, projectC);
    equal(drifted.layer, 'untrusted', 'T12 内容变化后 mcp 层回到 untrusted');
    equal([...drifted.names], [], 'T12 内容变化后不再占用任何名字');
  }

  /* --- 13. 投影让位：与全局/项目同名 → 跳过并记录 ----------------- */
  {
    const host = createHostContext();
    const projectD = join(fixture.root, 'project-d');
    await mkdir(projectD, { recursive: true });
    const rows = [{ moduleName: '@deepseek-ai/dsh-mcp-client', enabled: true, patchId: 'mcp-client-alpha' }];
    host.services.set('pluginManager', { listPlugins: async () => rows });
    const { agent, record } = createFakeAgent('session-8', projectD);
    const mcpServers = {
      alpha: { command: 'node', args: ['from-plugin-alpha.mjs'] },
      'kept-bridge': { command: 'node', args: ['kept.mjs'] },
    };
    const dispose = mountProjection(host, {
      resolveEffective: async () => effectiveFor(fixture.pluginRoot, { mcpServers }),
    });
    await host.emit('agent/created', { agent, source: 'test' });

    const mountedNames = () => record.mounted.filter((fiber) => fiber.config?.serverName !== undefined).map((fiber) => fiber.config.serverName);
    // 只看当前存活的那批（重挂后旧 fiber 已 dispose，仍留在 record.mounted 里）。
    const liveNames = () =>
      record.mounted.filter((fiber) => fiber.disposed === false && fiber.config?.serverName !== undefined).map((fiber) => fiber.config.serverName);
    equal(mountedNames(), ['kept-bridge'], 'T13 与全局同名的插件 server 被跳过，其余照挂');
    const first = projectionSnapshot().sessions[0];
    equal(first.conflicts, [{ pluginId: 'zotero-personal', serverName: 'alpha', source: 'global' }], 'T13 冲突写进投影快照');
    equal(
      projectionConflicts(projectD),
      [{ cwd: projectD, pluginId: 'zotero-personal', serverName: 'alpha', source: 'global' }],
      'T13 projectionConflicts 带 cwd 返回',
    );

    // 全局服务器消失 → 跳过名单变化 → 下一次 pre-step 重新 reconcile，alpha 应被挂上。
    rows.length = 0;
    await host.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal });
    equal(liveNames(), ['alpha', 'kept-bridge'], 'T13 占用变化触发重挂，原被跳过的 server 挂上');
    equal(projectionConflicts(projectD).length, 0, 'T13 不再有全局冲突');

    // 项目信任出现 → 项目里的同名 server 成为占用源，插件再次让位（source=project）。
    await mkdir(join(projectD, '.dsh'), { recursive: true });
    await writeFile(join(projectD, '.dsh', 'mcp.json'), '{"mcpServers":{"alpha":{"command":"node","args":["p.mjs"]}}}\n', 'utf8');
    await approveProject(host, projectD);
    const mountedBefore = record.mounted.length;
    await host.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 3, signal: new AbortController().signal });
    ok('T13 项目信任变化触发重挂', record.mounted.length > mountedBefore);
    equal(liveNames(), ['kept-bridge'], 'T13 项目同名 server 让插件版本再次跳过');
    equal(
      projectionConflicts(projectD),
      [{ cwd: projectD, pluginId: 'zotero-personal', serverName: 'alpha', source: 'project' }],
      'T13 冲突来源标记 project',
    );
    dispose();
  }

  /* --- 14. 旧信任记录只读回退（契约 §1.4） ------------------------ */
  {
    const host = createHostContext();
    const projectE = join(fixture.root, 'project-e');
    const slash = (value) => {
      const text = value.replaceAll('\\', '/').replace(/\/+$/u, '');
      return process.platform === 'win32' ? text.toLowerCase() : text;
    };
    const hashOf = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
    await mkdir(join(projectE, '.dsh'), { recursive: true });
    const mcpPath = join(projectE, '.dsh', 'mcp.json');
    const pluginsPath = join(projectE, '.dsh', 'plugins.json');
    await writeFile(mcpPath, '{"mcpServers":{"legacy-srv":{"command":"node"}}}\n', 'utf8');
    await writeFile(pluginsPath, '{"enabledPlugins":{"legacy@local":false}}\n', 'utf8');

    const profileRoot = join(homeDir, 'profiles', 'runtime-smoke');
    const legacyHub = join(profileRoot, 'data', 'plugin-hub', 'trusted.json');
    const legacyMcp = join(profileRoot, 'data', 'mcp-manager', 'trusted-projects.json');
    await mkdir(join(legacyHub, '..'), { recursive: true });
    await mkdir(join(legacyMcp, '..'), { recursive: true });
    await writeFile(
      legacyHub,
      `${JSON.stringify({ version: 1, projects: { [slash(projectE)]: { hash: await hashOf(pluginsPath), approvedAt: '2026-01-01T00:00:00.000Z' } } }, null, 2)}\n`,
      'utf8',
    );
    // 旧 mcp-manager 记录的 key 是原始绝对路径。
    await writeFile(
      legacyMcp,
      `${JSON.stringify({ version: 1, projects: { [projectE]: { hash: await hashOf(mcpPath), at: '2026-01-01T00:00:00.000Z' } } }, null, 2)}\n`,
      'utf8',
    );

    const legacy = await trustStateFor(host, projectE);
    equal(legacy.plugins, 'trusted', 'T14 旧 hub 记录命中 → plugins 层 trusted');
    equal(legacy.mcp, 'trusted', 'T14 旧 mcp-manager 记录命中 → mcp 层 trusted');
    equal(legacy.shared, false, 'T14 旧的单插件记录不算 canonical 命中');
    equal(legacy.source, 'legacy', 'T14 来源标记 legacy');
    equal([...(await projectOccupancy(host, projectE)).names], ['legacy-srv'], 'T14 旧记录命中时项目 MCP 照常占名');

    // 点一次「信任」整体升级：之后以 canonical 为准，旧记录不再参与判定（只读保留）。
    await approveProject(host, projectE);
    const upgraded = await trustStateFor(host, projectE);
    equal(upgraded.shared, true, 'T14 批准后升级为 canonical（shared）');
    equal(upgraded.source, 'shared', 'T14 来源切换到 shared');
    const stored = JSON.parse(await readFile(upgraded.storePath, 'utf8'));
    ok('T14 升级保留其它项目记录', Object.keys(stored.projects).length >= 2, String(Object.keys(stored.projects).length));
  }

  /* --- 15. 投影失败可见：挂载异常进入 projectionErrors -------------- */
  {
    const host = createHostContext();
    const projectF = join(fixture.root, 'project-f');
    await mkdir(projectF, { recursive: true });
    const { agent, record } = createFakeAgent('session-err', projectF);
    const originalPlugin = agent.ctx.plugin;
    agent.ctx.plugin = (pluginObject, config) => {
      if (pluginObject?.name === 'plugin-hub:skills:zotero-personal') throw new Error('provider exploded');
      return originalPlugin(pluginObject, config);
    };
    const dispose = mountProjection(host, { resolveEffective: async () => effectiveFor(fixture.pluginRoot) });
    await host.emit('agent/created', { agent, source: 'test' });

    const errors = projectionErrors(projectF);
    equal(errors.length, 1, 'T15 失败挂载记一条运行期错误');
    equal(
      { pluginId: errors[0].pluginId, kind: errors[0].kind, code: errors[0].code },
      { pluginId: 'zotero-personal', kind: 'skills', code: 'mount-failed' },
      'T15 错误归因到插件与能力类型',
    );
    ok(
      'T15 错误带消息与时间',
      errors[0].message.includes('provider exploded') && typeof errors[0].at === 'string' && errors[0].at !== '',
    );
    ok('T15 其它能力照常挂载', record.mounted.some((fiber) => fiber.name === 'plugin-hub:commands:zotero-personal'));

    // 修好后换 cwd 触发一次 reconcile：新 cwd 成功挂载，不应带着旧错误。
    agent.ctx.plugin = originalPlugin;
    agent.session.cwd = projectB;
    await host.waterfall('agent/pre-step', { agent, messages: [], turn: 1, step: 2, signal: new AbortController().signal });
    equal(projectionErrors(projectB).length, 0, 'T15 重新 reconcile 成功后清掉该 cwd 的错误');
    equal(projectionErrors(projectF).length, 1, 'T15 旧 cwd 的最近一次错误保留（诊断用）');
    dispose();
  }

  process.env.DSH_HOME = previousEnv.home;
  process.env.DSH_PROFILE = previousEnv.profile;
  if (previousEnv.home === undefined) delete process.env.DSH_HOME;
  if (previousEnv.profile === undefined) delete process.env.DSH_PROFILE;

  await rm(fixture.root, { recursive: true, force: true });
  console.warn = realWarn;
  realWarn(`ALL PASS (${checks} checks, ${warnings.length} warnings captured)`);
}

run().catch((error) => {
  console.warn = realWarn;
  realWarn('SMOKE FAILED:');
  realWarn(error?.stack ?? error);
  process.exitCode = 1;
});
