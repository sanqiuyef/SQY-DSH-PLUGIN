/**
 * dsh-plugin-hub — 共享工具（无业务语义）。
 *
 * 这里的每个函数都被 store/routes/projection 复用，所以只放"任何一层都需要"的东西：
 * 原子 JSON 读写、合作式文件锁、稳定目录指纹、路径逃逸防线、变量展开、日志脱敏。
 * 不 import 任何本项目其它模块，避免循环依赖。
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

/** ISO 时间戳，落盘统一用它，避免 Date 对象进 JSON。 */
export function nowIso() {
  return new Date().toISOString();
}

/** 文本 sha256（hex），用于信任 hash 与签名。 */
export function sha256Text(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

/** 对任意可 JSON 序列化的值取稳定 sha256（键排序），用于"配置没变就不重挂"。 */
export function stableHash(value) {
  return sha256Text(stableStringify(value));
}

/** 键排序的 JSON 序列化；undefined 字段忽略，保证同一语义只产生一种文本。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

/**
 * 递归目录指纹。
 *
 * 跳过 `.git` / `node_modules`：它们对"插件内容有没有变"没有语义，却会让指纹随
 * 一次 `npm install` 抖动。符号链接只记录链接文本、不跟随（同扫描侧的安全口径），
 * 这样链接改指向也会改变指纹。
 */
export async function sha256Dir(rootPath) {
  const hash = createHash('sha256');
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      const rel = relative(rootPath, full).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        hash.update(`L\0${rel}\0`);
        continue;
      }
      if (entry.isDirectory()) {
        hash.update(`D\0${rel}\0`);
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      hash.update(`F\0${rel}\0`);
      try {
        hash.update(await readFile(full));
      } catch {
        hash.update('unreadable');
      }
      hash.update('\0');
    }
  };
  if (typeof rootPath !== 'string' || rootPath === '') return '';
  await walk(rootPath);
  return hash.digest('hex');
}

/** 读 JSON；文件不存在或损坏都返回 fallback（调用方决定是否告警）。 */
export async function readJsonFile(path, fallback) {
  try {
    const text = await readFile(path, 'utf8');
    if (text.trim() === '') return fallback;
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 原子写 JSON。
 *
 * 先写同目录唯一临时文件再 rename：rename 在同一文件系统上是原子的，读者永远看不到
 * 半个文件。Windows 上目标被其它进程瞬时占用时会 EPERM/EBUSY，做有限次退避重试。
 */
export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, text, 'utf8');
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') break;
      await sleep(20 * (attempt + 1));
    }
  }
  await rm(temp, { force: true }).catch(() => {});
  throw lastError;
}

/** 确保目录存在（幂等）。 */
export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
  return path;
}

/** 简单睡眠，用于锁/重试退避。 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * 合作式文件锁：`<target>.lock` 用 O_EXCL 创建，内容写 pid。
 *
 * 只用于本插件自己的写入串行化（不追求跨宿主强一致）。持有者进程已退出时允许接管：
 * 读到的 pid 不存在才删锁，避免把活着的写入者挤掉。等待超时抛错，由调用方转成 409。
 */
export async function withLock(lockPath, operation, { waitMs = 5000 } = {}) {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + Math.max(0, waitMs);
  let handle;
  for (;;) {
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) {
        throw Object.assign(new Error(`timeout waiting for ${lockPath}`), { code: 'lock-timeout' });
      }
      const holder = await readFile(lockPath, 'utf8').catch(() => '');
      const pid = Number.parseInt(holder.trim(), 10);
      if (Number.isInteger(pid) && pid > 0 && !isProcessAlive(pid)) {
        await unlink(lockPath).catch(() => {});
      }
      await sleep(40 + Math.floor(Math.random() * 60));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

/** pid 存活探测：signal 0 不投递信号，ESRCH 表示进程不存在。 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 词法路径防线：把 `relative` 解析到 `root` 内部，越界返回 null。
 *
 * 只做纯字符串判断（不 stat），因此复制/扫描前就能挡住绝对路径与 `..` 穿越；
 * 符号链接逃逸由调用方在 stat 阶段另行拒绝（见 adapters 与 sources）。
 */
export function resolveInside(root, target) {
  if (typeof root !== 'string' || root === '') return null;
  if (typeof target !== 'string') return null;
  if (target.includes('\0')) return null;
  if (isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('\\\\')) return null;
  const resolvedRoot = normalize(root);
  const resolved = normalize(join(resolvedRoot, target));
  const rel = relative(resolvedRoot, resolved);
  if (rel === '') return resolved;
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return resolved;
}

/** 判断 `child` 是否在 `parent` 内（两侧都应是 normalize 后的绝对路径）。 */
export function isInside(parent, child) {
  const rel = relative(normalize(parent), normalize(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * `${NAME}` / `${user_config.KEY}` 单遍展开。
 *
 * 单遍是刻意的：展开结果里若再次出现 `${...}` 不再继续替换，避免插件配置借嵌套
 * 展开读到其它变量的值。未知变量按 `${NAME}` 原样保留，由调用方决定告警或跳过。
 */
export function expandVars(text, vars) {
  if (typeof text !== 'string' || text === '') return text;
  return text.replace(/\$\{([A-Za-z0-9_.:-]+)\}/g, (whole, name) => {
    if (vars && Object.prototype.hasOwnProperty.call(vars, name)) {
      const value = vars[name];
      return value === undefined || value === null ? whole : String(value);
    }
    return whole;
  });
}

/** 递归展开对象/数组里的字符串（MCP 配置里 env/args/url 都要展开）。 */
export function expandDeep(value, vars) {
  if (typeof value === 'string') return expandVars(value, vars);
  if (Array.isArray(value)) return value.map((item) => expandDeep(item, vars));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = expandDeep(item, vars);
    return out;
  }
  return value;
}

/** 查找字符串里引用的变量名（用于缺变量告警）。 */
export function referencedVars(value) {
  const found = new Set();
  const walk = (item) => {
    if (typeof item === 'string') {
      for (const match of item.matchAll(/\$\{([A-Za-z0-9_.:-]+)\}/g)) found.add(match[1]);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(walk);
      return;
    }
    if (item !== null && typeof item === 'object') Object.values(item).forEach(walk);
  };
  walk(value);
  return [...found];
}

/**
 * 响应脱敏：凭据形状 + 调用方给出的已知字面量。
 *
 * 规则刻意通用（不绑定本机某个 token），因为错误文本里出现什么无法预知；
 * 已知字面量先整体替换，长度 <4 的值不处理（否则会把正常文本打碎）。
 */
const REDACTION_PATTERNS = [
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***'],
  [/\bsk-[A-Za-z0-9_-]{10,}\b/g, '***'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '***'],
  [
    /((?:[A-Za-z0-9_.-]*(?:KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL)[A-Za-z0-9_.-]*)\s*[:=]\s*)("[^"]{4,}"|'[^']{4,}'|[^\s,;]{4,})/gi,
    '$1***',
  ],
];

export function redact(text, values = []) {
  let out = String(text ?? '');
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 4) continue;
    out = out.split(value).join('***');
  }
  for (const [pattern, replacement] of REDACTION_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** 统一日志前缀；只用于失败/降级，不写成功噪声。 */
export function warn(message) {
  console.warn(`[plugin-hub] ${message}`);
}

/** 文件是否存在（不跟随符号链接的普通文件/目录判定由调用方用 lstat 细化）。 */
export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** lstat 便捷封装；不存在返回 null 而不是抛错。 */
export async function lstatOrNull(path) {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

/** PATH 查找可执行文件（Windows 上试 .cmd/.exe），用于 git/tar 可用性诊断。 */
export async function findExecutable(name, env = process.env) {
  const pathValue = env.PATH ?? env.Path ?? '';
  const dirs = pathValue.split(delimiter).filter((item) => item !== '');
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, `${name}${suffix}`);
      try {
        const info = await stat(candidate);
        if (info.isFile()) return candidate;
      } catch {
        /* 继续找 */
      }
    }
  }
  return null;
}
