/**
 * 客户端静态自检（不需要浏览器）。
 *
 * 只验证"装上去会不会立刻坏"的硬约束：模块外壳、槽位注册、inject 白名单、
 * 文案字典对齐、禁用 API、语法可解析。真正的渲染效果需要真机页面验证。
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

// 1 ------------------------------------------------------------------ 模块外壳
check('module loader shell', /window\.__ModuleLoader__\.load\(\{/.test(source));
check('module id', /id:\s*'dsh-plugin-hub'/.test(source));
check('factory signature', /factory\s*\(require\)\s*\{/.test(source));
check('react via require', /require\('react'\)/.test(source));

// 2 -------------------------------------------------------------------- 槽位
for (const slot of ['settings.section', 'sidebar.panellist', 'main']) {
  check(`slot ${slot}`, source.includes(`ctx.slots.inject('${slot}'`) && source.includes(`name: '${slot}'`));
}
const panellistId = /name:\s*'sidebar\.panellist'[\s\S]{0,200}?id:\s*'([^']+)'/.exec(source)?.[1] ?? '';
const mainKey = /name:\s*'main'[\s\S]{0,160}?key:\s*'([^']+)'/.exec(source)?.[1] ?? '';
check('panellist id === main key === plugin-hub', panellistId === 'plugin-hub' && mainKey === 'plugin-hub', `${panellistId} / ${mainKey}`);
check('settings order present', /name:\s*'settings\.section'[\s\S]{0,200}?order:\s*34/.test(source));

// 3 ---------------------------------------------------------------- 依赖白名单
const injectBlock = /const inject = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
const injectNames = injectBlock
  .split(',')
  .map((item) => item.trim().replace(/['"]/g, ''))
  .filter(Boolean);
check('inject only slots/locale', injectNames.length === 2 && injectNames.includes('slots') && injectNames.includes('locale'), injectNames.join(','));
check('no harness client package import', !/require\('@deepseek-ai\//.test(source));
check('no dynamic import of harness packages', !/from\s+'@deepseek-ai\//.test(source));

// 4 -------------------------------------------------------------- 禁用 API/日志
check('no alert()', !/\balert\s*\(/.test(source));
check('no console.log', !/console\.log\s*\(/.test(source));
check('no document.body append', !/document\.body\.(append|insert)/.test(source));
check('no window.zcode', !/window\.zcode/.test(source));

// 5 ---------------------------------------------------------------- 文案字典
const zhKeys = extractKeys(source, 'zh');
const enKeys = extractKeys(source, 'en');
check('locale dictionaries present', zhKeys.size > 20 && enKeys.size > 20, `${zhKeys.size}/${enKeys.size}`);
const missingEn = [...zhKeys].filter((key) => !enKeys.has(key));
const missingZh = [...enKeys].filter((key) => !zhKeys.has(key));
check('zh/en keys match', missingEn.length === 0 && missingZh.length === 0, `missing en:${missingEn.join(',') || '-'} missing zh:${missingZh.join(',') || '-'}`);

// 6 ---------------------------------------------------------------- 语法可解析
let syntaxOk = true;
try {
  new vm.Script(source, { filename: 'client.js' });
} catch (error) {
  syntaxOk = false;
  console.log(`      syntax error: ${error.message}`);
}
check('syntax parses', syntaxOk);

// 7 --------------------------------------------------------------- 路由覆盖
// `/overview` 经过 withCwd() 拼接，所以这里按"字符串出现"而不是 callApi 直接实参判断。
const used = new Set([...source.matchAll(/callApi\(\s*[`'"]([^`'"?]+)/g)].map((match) => match[1]));
for (const route of ['/overview', '/current-workspace', '/components', '/market/add', '/market/refresh', '/market/entries', '/install', '/uninstall', '/versions', '/switch', '/enable', '/trust']) {
  check(`calls ${route}`, used.has(route) || source.includes(`'${route}'`));
}

const failed = results.filter((item) => !item.ok);
console.log(`${'-'.repeat(72)}\n${results.length} cases: ${results.length - failed.length} passed, ${failed.length} failed`);
console.log(failed.length === 0 ? 'ALL PASS' : 'FAILED');

// ------------------------------------------------------------------ helpers

/** 从 `const zh = { ... };` 块里抽顶层 key（支持 'a.b': / a: 两种写法）。 */
function extractKeys(text, name) {
  const start = text.indexOf(`const ${name} = {`);
  if (start < 0) return new Set();
  const end = text.indexOf('\n    };', start);
  const block = text.slice(start, end < 0 ? undefined : end);
  const keys = new Set();
  for (const line of block.split('\n')) {
    const match = /^\s+(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/.exec(line);
    if (match !== null) keys.add(match[1] ?? match[2] ?? match[3]);
  }
  return keys;
}
