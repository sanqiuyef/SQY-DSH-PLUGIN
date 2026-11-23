/**
 * dsh-skill-manager — i18n dictionary parity and key usage.
 *
 *   D:\nodejs\node.exe test\key-parity.mjs
 *
 * Three checks, all of them cheap and static:
 *  1. `zh` and `en` define exactly the same key set (dotted and dotless: `nav`,
 *     `title`, `subtitle` used to escape the old dotted-only check);
 *  2. every literal `t('key')` in the client has a dictionary entry — a typo
 *     here shows the raw key to the user, which no other test would catch;
 *  3. every dynamic prefix (`t('issue.' + code)`) has at least one entry, so a
 *     renamed family cannot silently degrade to raw keys.
 *
 * Unused entries are reported for information only: message keys travel as data
 * (`notify({ key: 'toast.saved' })`), so a static scan cannot prove them dead.
 */

import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
const zhStart = src.indexOf('const zh = {');
const enStart = src.indexOf('const en = {');
const tEnd = src.indexOf('function translate(');
if (zhStart < 0 || enStart < 0 || tEnd < 0) {
  console.error('key-parity: cannot locate the zh/en dictionaries in client/client.js');
  process.exit(1);
}
const zhBlock = src.slice(zhStart, enStart);
const enBlock = src.slice(enStart, tEnd);

/** Quoted entries: `'group.count': …` */
const quotedKey = /'([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_.-]+)+)'\s*:/g;
/** Bare identifier entries: `nav: …`, also when they follow a sibling on one line. */
const bareKey = /(?:^|[,{]\s*)([A-Za-z][A-Za-z0-9_]{1,40})\s*:(?!\/\/)/gm;

function collectKeys(block) {
  const keys = new Set();
  for (const match of block.matchAll(quotedKey)) keys.add(match[1]);
  for (const match of block.matchAll(bareKey)) keys.add(match[1]);
  return keys;
}

const zhKeys = collectKeys(zhBlock);
const enKeys = collectKeys(enBlock);

const zhOnly = [...zhKeys].filter((key) => !enKeys.has(key)).sort();
const enOnly = [...enKeys].filter((key) => !zhKeys.has(key)).sort();

/** Literal key arguments, excluding `t('prefix.' + value)`. */
const callSite = src.slice(tEnd);
const literalKeys = new Set();
for (const match of callSite.matchAll(/\bt\(\s*'([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_.-]+)*)'(?!\s*\+)/g)) {
  literalKeys.add(match[1]);
}
const missingInZh = [...literalKeys].filter((key) => !zhKeys.has(key)).sort();
const missingInEn = [...literalKeys].filter((key) => !enKeys.has(key)).sort();

/** Dynamic prefixes such as `t('issue.' + code)`. */
const prefixes = new Set();
for (const match of callSite.matchAll(/\bt\(\s*'([A-Za-z0-9_-]+\.)'\s*\+/g)) prefixes.add(match[1]);
const emptyPrefixes = [...prefixes].filter(
  (prefix) => ![...zhKeys].some((key) => key.startsWith(prefix)) || ![...enKeys].some((key) => key.startsWith(prefix)),
).sort();

/** Every quoted key-looking string anywhere: message keys travel as data
 * (`notify({ key: 'toast.saved' })`, `ERROR_KEYS`), so a `t()` scan alone would
 * report them as unused. */
const anyStringKey = new Set(
  [...src.matchAll(/'([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_.-]+)+)'/g)].map((match) => match[1]),
);
const usedByPrefix = (key) => [...prefixes].some((prefix) => key.startsWith(prefix));
const unused = [...zhKeys]
  .filter((key) => !literalKeys.has(key) && !anyStringKey.has(key) && !usedByPrefix(key))
  .sort();

console.log(`zh=${zhKeys.size} en=${enKeys.size} literal=${literalKeys.size} prefixes=${prefixes.size}`);
console.log(`zhOnly=${JSON.stringify(zhOnly)} enOnly=${JSON.stringify(enOnly)}`);
console.log(`missingInZh=${JSON.stringify(missingInZh)} missingInEn=${JSON.stringify(missingInEn)}`);
console.log(`emptyPrefixes=${JSON.stringify(emptyPrefixes)}`);
console.log(`unused dictionary keys (informational): ${JSON.stringify(unused)}`);

const failed =
  zhOnly.length > 0 ||
  enOnly.length > 0 ||
  missingInZh.length > 0 ||
  missingInEn.length > 0 ||
  emptyPrefixes.length > 0;
if (failed) process.exitCode = 1;
