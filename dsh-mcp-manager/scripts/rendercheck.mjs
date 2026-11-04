#!/usr/bin/env node
/**
 * dsh-mcp-manager — browser-half render check (offline).
 *
 * `client/selfcheck.mjs` never renders a component, so it cannot catch a broken
 * row, filter bar or schema view. This file runs `client/client.js` in a Node `vm`
 * with a small React stub that actually invokes function components and walks the
 * returned tree, then asserts what the page would print.
 *
 * Covered here:
 *   - the health label, its relative time and its localized reason per state;
 *   - the status dot data attribute, including `idle` (enabled but not composed);
 *   - the reconnect button's disabled/enabled state per row;
 *   - the tool schema view (required/optional, enum, default) and its cost label;
 *   - the probe stage + hint;
 *   - search, filter chips with counts, batch buttons and the empty-result hint;
 *   - the project filter bar and its skipped chip.
 *
 * Usage:  node scripts/rendercheck.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client', 'client.js'), 'utf8');

let failures = 0;
const check = (label, condition, detail = '') => {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

/* -------------------------------------------------------------- React stub */

const presets = {};
let activePreset = null;
let hookIndex = 0;

function createElement(type, props) {
  const children = Array.prototype.slice.call(arguments, 2);
  const next = Object.assign({}, props || {});
  // React keeps a configured `children` prop when no positional children are given.
  if (children.length > 0) next.children = children.length === 1 ? children[0] : children;
  return { type, props: next };
}

const React = {
  createElement,
  Fragment: Symbol.for('react.fragment'),
  useState(initial) {
    const preset = activePreset && hookIndex < activePreset.length ? activePreset[hookIndex] : undefined;
    hookIndex += 1;
    return [preset !== undefined ? preset : typeof initial === 'function' ? initial() : initial, function noop() {}];
  },
  useEffect() {},
  useLayoutEffect() {},
  useMemo(factory) {
    return factory();
  },
  useCallback(fn) {
    return fn;
  },
  useRef(value) {
    return { current: value };
  },
  useReducer(reducer, initial) {
    return [typeof initial === 'function' ? initial() : initial, function noop() {}];
  },
  memo(fn) {
    return fn;
  },
  createContext(defaultValue) {
    return { Provider: null, Consumer: null, defaultValue };
  },
  forwardRef(fn) {
    return fn;
  },
};

function render(node) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === 'string' || typeof node === 'number') return { text: String(node) };
  if (Array.isArray(node)) return { children: node.map(render) };
  if (typeof node.type === 'function') {
    const savedPreset = activePreset;
    const savedIndex = hookIndex;
    activePreset = presets[node.type.name] || null;
    hookIndex = 0;
    let out;
    try {
      out = node.type(node.props);
    } finally {
      activePreset = savedPreset;
      hookIndex = savedIndex;
    }
    return render(out);
  }
  return { tag: node.type, props: node.props || {}, children: render((node.props || {}).children) };
}

function collect(tree, out) {
  if (tree === null || tree === undefined) return out;
  if (Array.isArray(tree)) {
    for (const item of tree) collect(item, out);
    return out;
  }
  if (tree.text !== undefined) out.push(tree.text);
  if (tree.props) {
    for (const key of ['aria-label', 'title', 'placeholder', 'data-status']) {
      if (typeof tree.props[key] === 'string') out.push(tree.props[key]);
    }
  }
  collect(tree.children, out);
  return out;
}

const textOf = (tree) => collect(tree, []).join(' \n ');

/** Every host element in the tree, so a check can look at one attribute. */
function elementsOf(tree, out = []) {
  if (tree === null || tree === undefined) return out;
  if (Array.isArray(tree)) {
    for (const item of tree) elementsOf(item, out);
    return out;
  }
  if (tree.props) out.push(tree);
  if (tree.children) elementsOf(tree.children, out);
  return out;
}

/* ------------------------------------------------------------- sandbox boot */

const dictionaries = new Map();
const listeners = new Set();
const locale = {
  register(namespace, bag) {
    dictionaries.set(namespace, Object.assign({}, bag));
    listeners.forEach((fn) => fn());
    return () => dictionaries.delete(namespace);
  },
  bind(namespace) {
    return function t(key, vars) {
      const bag = dictionaries.get(namespace) || {};
      const raw = Object.prototype.hasOwnProperty.call(bag.zh || {}, key) ? bag.zh[key] : key;
      if (!vars) return String(raw);
      return String(raw).replace(/\{(\w+)\}/g, (match, name) => (vars[name] == null ? match : String(vars[name])));
    };
  },
  getSnapshot() {
    return { active: 'zh', revision: dictionaries.size, locales: [] };
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const registrations = [];
const storage = new Map();
const sandbox = {
  console,
  setTimeout() {
    return 0;
  },
  clearTimeout() {},
  localStorage: {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  },
  fetch() {
    return Promise.reject(new Error('network disabled'));
  },
  AbortController: class {
    constructor() {
      this.signal = { aborted: false };
    }
    abort() {}
  },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  window: {
    __ModuleLoader__: {
      load(definition) {
        sandbox.__definition = definition;
      },
    },
  },
};

const context = vm.createContext(sandbox);
new vm.Script(source, { filename: 'client.js' }).runInContext(context);
const exported = sandbox.__definition.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require ' + name);
});

exported.apply({
  effect(fn) {
    return fn();
  },
  slots: {
    inject(name, callback) {
      return callback();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
  locale,
});

const t = locale.bind('mcpManager');
const page = registrations.find((entry) => entry.options.name === 'settings.section').component;

/* ------------------------------------------------------------------ fixtures */

const now = new Date().toISOString();

function server(overrides) {
  return Object.assign(
    {
      entryId: 'include:mcp-client-alpha',
      patchId: 'mcp-client-alpha',
      serverName: 'alpha',
      transport: 'stdio',
      target: 'python -m alpha',
      command: 'python -m alpha',
      args: [],
      cwd: '',
      url: '',
      envKeys: [],
      headerKeys: [],
      toolCallTimeoutMs: null,
      enabled: true,
      fiberPhase: 'active',
      toolCount: 2,
      toolCountKnown: true,
      managed: true,
      source: 'managed',
      lastProbe: null,
      health: { state: 'connected', since: now, reason: null, detail: null },
    },
    overrides,
  );
}

const alpha = server({
  lastProbe: {
    ok: true,
    at: now,
    durationMs: 12,
    toolCount: 1,
    stage: 'ok',
    hint: null,
    tools: [
      {
        name: 'search',
        description: 'Search things',
        schemaBytes: 1200,
        estimatedTokens: 300,
        required: ['q'],
        propertyCount: 2,
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string', enum: ['a', 'b'] }, limit: { type: 'number', default: 3 } },
          required: ['q'],
        },
        schemaTruncated: false,
        schemaOmitted: false,
      },
    ],
  },
});

const beta = server({
  entryId: 'include:mcp-client-beta',
  patchId: 'mcp-client-beta',
  serverName: 'beta',
  target: 'python -m beta',
  command: 'python -m beta',
  toolCount: 0,
  health: { state: 'failed', since: now, reason: 'no-tools-probe-failed', detail: null },
  lastProbe: {
    ok: false,
    at: now,
    durationMs: 8000,
    toolCount: 0,
    stage: 'initialize',
    hint: 'The process started but the MCP handshake failed.',
    error: 'the probe timed out after 8000 ms',
    tools: [],
  },
});

const gamma = server({
  entryId: 'include:mcp-client-gamma',
  patchId: 'mcp-client-gamma',
  serverName: 'gamma',
  target: 'python -m gamma',
  command: 'python -m gamma',
  enabled: false,
  toolCount: 0,
  health: { state: 'stopped', since: now, reason: 'disabled', detail: null },
  lastProbe: null,
});

// Enabled, but this profile does not compose it: the dot must not claim "unknown".
const delta = server({
  entryId: null,
  patchId: 'mcp-client-delta',
  serverName: 'delta',
  target: 'python -m delta',
  command: 'python -m delta',
  toolCount: 0,
  fiberPhase: null,
  health: { state: 'stopped', since: now, reason: 'not-loaded', detail: null },
  lastProbe: null,
});

const globalModel = {
  status: 'ready',
  error: null,
  data: {
    servers: [alpha, beta, gamma, delta],
    patch: { path: 'C:/profile/cordis.patch.yml', ok: true, error: null },
    problems: [],
    totals: { servers: 4, enabled: 3, active: 2, tools: 2 },
  },
};

const basePrefs = { query: '', filter: 'all', sort: 'name' };

function pagePresets(overrides) {
  const list = new Array(13).fill(undefined);
  list[0] = globalModel;
  list[1] = {};
  list[2] = {};
  list[3] = { 'include:mcp-client-alpha': true, 'include:mcp-client-beta': true };
  list[4] = false;
  list[5] = null;
  list[6] = null;
  list[7] = false;
  list[8] = false;
  list[9] = 'global';
  list[10] = [];
  list[11] = basePrefs;
  list[12] = false;
  return Object.assign(list, overrides || {});
}

function renderPage(overrides) {
  presets.Page = pagePresets(overrides);
  const tree = render(createElement(page, { t }));
  return { tree, text: textOf(tree), elements: elementsOf(tree) };
}

/* ---------------------------------------------------------------- assertions */

console.log('# dsh-mcp-manager client render check');

{
  const { text, elements } = renderPage();
  check('connected row says connected', text.includes('已连接'));
  check('failed row says connection failed', text.includes('连接失败'));
  check('disabled row says not running', text.includes('未运行'));
  check(
    'a failed row shows its localized reason',
    text.includes('已激活但未注册任何工具，上次探测也失败'),
    '',
  );
  check('an enabled-but-unloaded row explains itself', text.includes('已声明，但未组合进当前 profile'));
  check(
    'the status dot distinguishes idle from unknown',
    elements.some((node) => node.props?.['data-status'] === 'idle') &&
      elements.some((node) => node.props?.title === '已启用，但当前 profile 未加载该条目'),
  );
  check('tool schema cost is rendered', text.includes('schema 1.2 KB · 约 300 tokens'));
  check('required and optional properties are labelled', text.includes('必填') && text.includes('可选'));
  check('enum values are rendered', text.includes('enum: a | b'));
  check('defaults are rendered', text.includes('default: 3'));
  check('probe stage is rendered', text.includes('握手阶段'));
  check('probe hint is rendered', text.includes('The process started but the MCP handshake failed.'));
  check('filter chips carry counts', text.includes('全部 (4)') && text.includes('已启用 (3)') && text.includes('已停用 (1)'));
  check(
    'batch buttons target the addressable visible rows',
    text.includes('启用 1 台') && text.includes('停用 2 台'),
    'delta has no entryId, so it is excluded from both counts',
  );
  check(
    'reconnect is offered per row and blocked when disabled',
    elements.some((node) => node.props?.['aria-label'] === '重连') && text.includes('请先启用该服务器'),
  );
  check('the reconnect button says it interrupts a running call', text.includes('会中断它正在进行的调用'));
}

{
  const { text } = renderPage({ 11: Object.assign({}, basePrefs, { filter: 'error' }) });
  check('the error filter hides healthy rows', !text.includes('python -m alpha') && text.includes('python -m beta'));
  check('the filter still shows the problem row', text.includes('连接失败'));
}

{
  const { text } = renderPage({ 11: Object.assign({}, basePrefs, { query: 'gamma' }) });
  check('search narrows the list', text.includes('python -m gamma') && !text.includes('python -m alpha'));
}

{
  const { text } = renderPage({ 11: Object.assign({}, basePrefs, { query: 'zzz' }) });
  check('an empty result explains itself', text.includes('没有符合当前筛选的服务器'));
  check('an empty result offers a reset', text.includes('清除筛选'));
}

/* ------------------------------------------------------------ project scope */

const projectRow = server({
  entryId: null,
  patchId: null,
  serverName: 'demo',
  target: 'python -m demo',
  command: 'python -m demo',
  source: 'project',
  fiberPhase: null,
  toolCount: 0,
  health: null,
  skipped: true,
  lastProbe: null,
});

presets.Page = pagePresets({ 9: 'project' });
presets.ProjectScope = [
  {
    status: 'ready',
    error: null,
    data: {
      scope: 'project',
      cwd: 'C:/work/demo',
      path: 'C:/work/demo/.dsh/mcp.json',
      exists: true,
      trusted: true,
      hash: 'abc',
      trustLayers: { mcp: 'trusted', plugins: 'not-applicable', shared: true, source: 'shared' },
      skipped: ['demo'],
      servers: [projectRow],
      problems: [],
      runtime: [{ sessionId: 's1', cwd: 'C:/work/demo', servers: [], skipped: ['demo'] }],
    },
  },
  {},
  {},
  false,
  null,
  null,
  [],
  basePrefs,
];

const projectText = textOf(render(createElement(page, { t })));
check('project scope renders its own filter bar with a skipped chip', projectText.includes('已跳过 (1)'));
check('the skipped project row is marked', projectText.includes('与全局同名'));
check('the project reconnect button explains the scope of its effect', projectText.includes('重新挂载该会话的全部项目服务器'));

/* ------------------------------------------------- stored view preferences */

// Both scopes must keep their own view: a project-only filter ('skipped') is not
// valid for the global list and must never blank it.
storage.set('dsh-mcp-manager/list-prefs', JSON.stringify({ query: '', filter: 'error', sort: 'name' }));
storage.set('dsh-mcp-manager/list-prefs:project', JSON.stringify({ query: '', filter: 'skipped', sort: 'name' }));

{
  const { text } = renderPage({ 11: undefined });
  check('stored global preferences apply', text.includes('python -m beta') && !text.includes('python -m alpha'));
}

{
  presets.Page = pagePresets({ 9: 'project', 11: undefined });
  presets.ProjectScope[7] = undefined;
  const storedProjectText = textOf(render(createElement(page, { t })));
  check(
    'the project scope reads its own key, not the global one',
    storedProjectText.includes('与全局同名') && !storedProjectText.includes('没有符合当前筛选的服务器'),
  );
}

console.log('');
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;