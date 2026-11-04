#!/usr/bin/env node
/**
 * 客户端渲染冒烟（无需浏览器、无 React 依赖）。
 *
 * `selfcheck.mjs` 只做语法解析与字符串检查，抓不到「函数体里引用了兄弟作用域的变量」
 * 这类 ReferenceError——`PluginDrawer` 曾经就这样在黑掉整个槽位前通过了自检。
 * 这里用最小 React 桩把 `main` 槽位的 PanelPage 真的执行一遍：打开已安装插件详情
 * （强制 drawer 状态）、注入一条运行期错误，断言管理页徽标与诊断行都渲染出来。
 *
 * 两个 useState 的初始值靠**源码行号**识别（`useHub` 的 data、`HubBody` 的 drawer），
 * 行号从当前源码正则计算，不硬编码；组件重构导致匹配不到时脚本会直接失败而不是静默跳过。
 *
 * 用法：node client/render-smoke.mjs   （退出码 0 且最后打印 ALL PASS）
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, 'client.js'), 'utf8');

const results = [];
const check = (label, ok, extra = '') => {
  results.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ` :: ${extra}` : ''}`);
  if (!ok) process.exitCode = 1;
};

/** 从源码里定位一个 useState 声明的行号；找不到直接失败。 */
function lineOf(pattern, name) {
  const lines = source.split('\n');
  const index = lines.findIndex((line) => pattern.test(line));
  if (index < 0) throw new Error(`cannot locate ${name} in client.js`);
  return index + 1;
}

const dataLine = lineOf(/const \[data, setData\] = useState\(null\);/, 'useHub data state');
const drawerLine = lineOf(/const \[drawer, setDrawer\] = useState\(null\);/, 'HubBody drawer state');

const overview = {
  hubRoot: 'C:/profile/data/plugin-hub',
  installed: [
    {
      id: 'demo@local',
      name: 'demo',
      version: '1.0.0',
      marketplace: 'local',
      rootPath: 'C:/profile/data/plugin-hub/cache/local/demo/1.0.0',
    },
  ],
  marketplaces: [],
  user: { enabledPlugins: { 'demo@local': true }, options: {} },
  workspace: null,
  trust: null,
  mcpConflicts: [],
  projectionErrors: [
    {
      cwd: 'C:/projects/demo-app',
      pluginId: 'demo@local',
      kind: 'skills',
      code: 'mount-failed',
      message: 'provider exploded',
      at: '2026-01-01T00:00:00.000Z',
    },
  ],
  effective: {
    plugins: [
      {
        id: 'demo@local',
        enabled: true,
        enabledSource: 'user',
        components: [{ kind: 'skill', count: 1 }],
        options: {},
      },
    ],
  },
};

const openDrawer = { kind: 'installed', id: 'demo@local' };
const noop = () => {};

/** 栈帧里是否来自 client.js 的指定行（vm.Script 的 filename 是 client.js，行号与源码一致）。 */
function fromLine(line) {
  const stack = new Error().stack ?? '';
  return stack.split('\n').some((row) => row.includes(`client.js:${line}:`));
}

const texts = [];
const React = {
  Fragment: 'Fragment',
  createElement(type, props, ...children) {
    const next = { ...(props ?? {}) };
    if (children.length > 0) next.children = children.length === 1 ? children[0] : children;
    return { type, props: next };
  },
  useState(initial) {
    if (fromLine(dataLine)) return [overview, noop];
    if (fromLine(drawerLine)) return [openDrawer, noop];
    return [typeof initial === 'function' ? initial() : initial, noop];
  },
  useEffect() {},
  useRef(value) {
    return { current: value };
  },
  useMemo(factory) {
    return factory();
  },
  useCallback(fn) {
    return fn;
  },
};

const slots = new Map();
const collected = [];
const ctx = {
  effect(factory) {
    if (typeof factory === 'function') {
      const dispose = factory();
      if (typeof dispose === 'function') collected.push(dispose);
    }
  },
  locale: { register() {} },
  slots: {
    inject(_name, register) {
      register();
      return noop;
    },
    register(definition, component) {
      slots.set(definition.name, component);
      return noop;
    },
  },
  logger: { warn() {} },
};

const sandbox = {
  window: {
    __ModuleLoader__: {
      load(module) {
        sandbox.module = module.factory((name) => {
          if (name === 'react') return React;
          throw new Error(`unexpected require("${name}")`);
        });
      },
    },
  },
  console,
  setTimeout,
  clearTimeout,
};

try {
  vm.createContext(sandbox);
  new vm.Script(source, { filename: 'client.js' }).runInContext(sandbox);
  check('module factory loads', sandbox.module !== undefined && typeof sandbox.module.apply === 'function');
  sandbox.module.apply(ctx);
  check('main slot registered', slots.has('main'));

  const PanelPage = slots.get('main');
  function render(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return;
    if (typeof node === 'string' || typeof node === 'number') {
      texts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) render(child);
      return;
    }
    if (typeof node !== 'object') return;
    if (typeof node.type === 'function') {
      render(node.type(node.props ?? {}));
      return;
    }
    const children = node.props?.children;
    if (Array.isArray(children)) for (const child of children) render(child);
    else if (children !== undefined) render(children);
  }
  render(React.createElement(PanelPage, {}));

  const text = texts.join(' ');
  check('install row renders', text.includes('demo') && text.includes('v1.0.0'));
  check('runtime failure badge renders', text.includes('运行失败 1'), text.slice(0, 120));
  check('installed drawer opens', text.includes('版本历史'));
  check('runtime failure diagnostic renders', text.includes('挂载失败') && text.includes('provider exploded'));
} catch (error) {
  check('render does not throw', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '));
}

const failed = results.filter((item) => !item.ok);
console.log(`${'-'.repeat(72)}\n${results.length} cases: ${results.length - failed.length} passed, ${failed.length} failed`);
console.log(failed.length === 0 ? 'ALL PASS' : 'FAILED');
if (failed.length > 0) process.exitCode = 1;
