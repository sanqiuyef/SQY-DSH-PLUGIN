import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8');
const zhStart = src.indexOf('const zh = {');
const enStart = src.indexOf('const en = {');
const tEnd = src.indexOf('function translate(');
const zh = src.slice(zhStart, enStart);
const en = src.slice(enStart, tEnd);

/** Every quoted `'ns.key':` entry, wherever it sits on the line. */
const keys = (block) => [...block.matchAll(/'([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_.-]+)+)'\s*:/g)].map((m) => m[1]);

const zk = [...new Set(keys(zh))];
const ek = [...new Set(keys(en))];
const zhOnly = zk.filter((k) => !ek.includes(k));
const enOnly = ek.filter((k) => !zk.includes(k));
console.log(`zh=${zk.length} en=${ek.length} zhOnly=${JSON.stringify(zhOnly)} enOnly=${JSON.stringify(enOnly)}`);
if (zhOnly.length || enOnly.length) process.exitCode = 1;
