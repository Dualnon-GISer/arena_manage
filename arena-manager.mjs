#!/usr/bin/env node
/**
 * Arena 项目管理器
 *
 * 零第三方依赖的本地管理服务：
 *   扫描压缩包 -> 解压到 projects/<名称> -> pnpm 安装依赖 -> 启动 / 停止 Vite 开发服务器
 *
 * 依赖复用说明：
 *   - 默认使用 pnpm，所有项目共享 pnpm 全局 store（同盘硬链接，重复依赖不会二次下载/安装）
 *   - 若 pnpm 不存在，回退到 npm，并统一使用本目录下的 .cache/npm 作为共享缓存
 *
 * 仅监听 127.0.0.1，供本机访问。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const DATA_DIR = path.join(ROOT, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const STATE_FILE = path.join(DATA_DIR, 'projects.json');
const NPM_CACHE_DIR = path.join(ROOT, '.cache', 'npm');
// 空白 hooks 目录：在项目内执行 Git 时禁用仓库自带的 hooks，避免运行不可信脚本
const GIT_HOOKS_DIR = path.join(ROOT, '.cache', 'git-hooks-empty');
const HOST = '127.0.0.1';
const DEFAULT_MANAGER_PORT = Number(process.env.ARENA_MANAGER_PORT || 4600);
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const isWin = process.platform === 'win32';
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';

for (const dir of [PUBLIC_DIR, PROJECTS_DIR, DATA_DIR, LOG_DIR, GIT_HOOKS_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function exists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const names = isWin ? [`${cmd}.cmd`, `${cmd}.exe`, `${cmd}.bat`, cmd] : [cmd];
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (exists(full)) return full;
    }
  }
  return null;
}

function stripAnsi(text) {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readPackageJson(dir) {
  return readJson(path.join(dir, 'package.json'), null);
}

function sha(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function fileHash(file) {
  try {
    return sha(fs.readFileSync(file));
  } catch {
    return '-';
  }
}

function quoteCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/** 打开外部程序（浏览器 / 资源管理器）；必须处理 error 事件，否则 spawn 失败会拖垮整个服务 */
function spawnDetached(command, args) {
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', (err) => {
      console.error(`[启动] 无法运行 ${command}：${err.message}`);
    });
    child.unref();
  } catch (err) {
    console.error(`[启动] 无法运行 ${command}：${err.message}`);
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new HttpError(status, message);
};

/* ------------------------------------------------------------------ */
/* 工具链探测                                                          */
/* ------------------------------------------------------------------ */

const winTar = path.join(SYSTEM_ROOT, 'System32', 'tar.exe');
const tarPath = isWin && exists(winTar) ? winTar : isWin ? which('bsdtar') : which('unzip') ? null : which('tar');
const unzipPath = which('unzip');
const powershellPath = isWin
  ? which('powershell') || path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : null;
const pnpmPath = which('pnpm');
const npmPath = which('npm');
const gitPath = which('git');
const taskkillPath = path.join(SYSTEM_ROOT, 'System32', 'taskkill.exe');
const explorerPath = isWin ? path.join(SYSTEM_ROOT, 'explorer.exe') : null;
const cmdPath = isWin ? path.join(SYSTEM_ROOT, 'System32', 'cmd.exe') : null;

const extractor = tarPath
  ? { kind: isWin && tarPath === winTar ? 'bsdtar' : 'tar', path: tarPath }
  : unzipPath
    ? { kind: 'unzip', path: unzipPath }
    : powershellPath && exists(powershellPath)
      ? { kind: 'powershell', path: powershellPath }
      : null;

function captureSync(command) {
  try {
    const result = spawnSync(command, {
      shell: true,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    return (result.stdout || '').trim() || null;
  } catch {
    return null;
  }
}

const gitVersion = gitPath
  ? (captureSync(`${quoteCmd(gitPath)} --version`) || '').replace(/^git version\s*/i, '') || null
  : null;

const tools = {
  node: process.version,
  pnpmVersion: pnpmPath ? captureSync(`${quoteCmd(pnpmPath)} --version`) : null,
  npmVersion: !pnpmPath && npmPath ? captureSync(`${quoteCmd(npmPath)} --version`) : null,
  extractor: extractor?.kind || null,
  gitVersion,
};
const packageManager = pnpmPath ? 'pnpm' : npmPath ? 'npm' : null;
const packageManagerPath = pnpmPath || npmPath;

/* ------------------------------------------------------------------ */
/* 项目状态                                                            */
/* ------------------------------------------------------------------ */

/** @type {Map<string, any>} */
const projects = new Map();
/** id -> { child, stopping, exited } */
const runtime = new Map();
const logSubs = new Map();
const logSizes = new Map();
const fingerprintCache = new Map();
const allChildren = new Set();

function projectDir(project) {
  return path.resolve(ROOT, project.dir);
}

function logFile(id) {
  return path.join(LOG_DIR, `${id}.log`);
}

function saveState() {
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    projects: [...projects.values()].map((p) => ({
      id: p.id,
      name: p.name,
      dir: p.dir,
      archive: p.archive || null,
      port: p.port || null,
      createdAt: p.createdAt || null,
      depsHash: p.depsHash || null,
      installedAt: p.installedAt || null,
    })),
  };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error('[状态] 保存失败:', err.message);
  }
}

function loadState() {
  const data = readJson(STATE_FILE, null);
  if (!data || !Array.isArray(data.projects)) return;
  for (const raw of data.projects) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.dir !== 'string') continue;
    const dir = path.resolve(ROOT, raw.dir);
    if (!dir.startsWith(path.resolve(PROJECTS_DIR) + path.sep) || !isDir(dir)) continue;
    projects.set(raw.id, {
      id: raw.id,
      name: raw.name || raw.id,
      dir: raw.dir.replace(/\\/g, '/'),
      archive: raw.archive || null,
      port: Number(raw.port) || null,
      createdAt: raw.createdAt || null,
      depsHash: raw.depsHash || null,
      installedAt: raw.installedAt || null,
      status: 'stopped',
      busy: false,
      error: null,
      url: null,
      pid: null,
    });
  }
}

/** 采纳 projects 目录下手工放入的项目 */
function adoptProjects() {
  let changed = false;
  let entries = [];
  try {
    entries = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (projects.has(entry.name)) continue;
    const dir = path.join(PROJECTS_DIR, entry.name);
    if (!exists(path.join(dir, 'package.json'))) continue;
    const project = {
      id: entry.name,
      name: entry.name,
      dir: `projects/${entry.name}`,
      archive: null,
      port: null,
      createdAt: fs.statSync(dir).mtimeMs,
      depsHash: null,
      installedAt: null,
      status: 'stopped',
      busy: false,
      error: null,
      url: null,
      pid: null,
    };
    projects.set(project.id, project);
    changed = true;
  }
  if (changed) saveState();
}

function depsFingerprint(project) {
  const dir = projectDir(project);
  const files = ['package.json', 'package-lock.json', 'pnpm-lock.yaml'];
  const key = files
    .map((file) => {
      try {
        const stat = fs.statSync(path.join(dir, file));
        return `${file}:${stat.size}:${stat.mtimeMs}`;
      } catch {
        return `${file}:-`;
      }
    })
    .join('|');

  const cached = fingerprintCache.get(dir);
  if (cached && cached.key === key) return cached.hash;

  const parts = [`pm=${packageManager || 'none'}`];
  for (const file of files) parts.push(`${file}=${fileHash(path.join(dir, file))}`);
  const hash = sha(parts.join('|')).slice(0, 24);
  fingerprintCache.set(dir, { key, hash });
  return hash;
}

function depsInstalled(project) {
  if (!project.depsHash) return false;
  const dir = projectDir(project);
  if (!exists(path.join(dir, 'node_modules'))) return false;

  // pnpm 的依赖链接包含绝对路径，目录改名后链接可能失效；Vite 项目要确认 vite 仍可用
  const script = startScript(project);
  const usesVite = /^vite(\s|$|--)/i.test(script.command || '');
  if (usesVite && !viteEntry(project)) return false;

  try {
    return depsFingerprint(project) === project.depsHash;
  } catch {
    return false;
  }
}

function viteEntry(project) {
  const target = path.join(projectDir(project), 'node_modules', 'vite', 'bin', 'vite.js');
  return exists(target) ? target : null;
}

function startScript(project) {
  const pkg = readPackageJson(projectDir(project));
  const scripts = pkg?.scripts || {};
  for (const name of ['dev', 'start', 'serve']) {
    if (typeof scripts[name] === 'string' && scripts[name].trim()) {
      return { name, command: scripts[name].trim(), pkg };
    }
  }
  return { name: null, command: null, pkg };
}

function projectView(project) {
  const dir = projectDir(project);
  const script = startScript(project);
  const directVite = !!(viteEntry(project) && script.name && /^vite(\s|$|--)/i.test(script.command));
  return {
    id: project.id,
    name: project.name,
    dir: project.dir,
    archive: project.archive,
    port: project.port,
    createdAt: project.createdAt,
    installedAt: project.installedAt,
    depsInstalled: depsInstalled(project),
    hasNodeModules: exists(path.join(dir, 'node_modules')),
    hasVite: !!viteEntry(project),
    hasGit: exists(path.join(dir, '.git')),
    startScript: script.name,
    startMode: directVite ? 'vite' : 'script',
    status: project.status,
    busy: !!project.busy,
    url: project.url || null,
    error: project.error || null,
  };
}

function scanArchives() {
  let entries = [];
  try {
    entries = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  const archives = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.zip$/i.test(entry.name)) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(ROOT, entry.name));
    } catch {
      continue;
    }
    const imported = [...projects.values()].filter((p) => p.archive === entry.name).length;
    archives.push({
      file: entry.name,
      size: stat.size,
      mtime: stat.mtimeMs,
      imported,
    });
  }
  return archives.sort((a, b) => b.mtime - a.mtime);
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

function logHeader(id, title) {
  appendLog(id, `\n──────── ${title} · ${new Date().toLocaleString('zh-CN', { hour12: false })} ────────\n`);
}

function appendLog(id, chunk) {
  const text = stripAnsi(String(chunk))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  if (!text) return;

  const subs = logSubs.get(id);
  if (subs) {
    for (const res of subs) {
      try {
        res.write(`event: line\ndata: ${JSON.stringify({ t: Date.now(), text })}\n\n`);
      } catch {
        /* 忽略已关闭的连接 */
      }
    }
  }

  const file = logFile(id);
  let size = logSizes.get(id);
  if (size === undefined) {
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
  }
  if (size > MAX_LOG_BYTES) {
    try {
      fs.writeFileSync(file, `…日志超过 ${Math.round(MAX_LOG_BYTES / 1024 / 1024)} MB，已自动轮转…\n`);
    } catch {
      /* 忽略 */
    }
    size = 0;
    logSizes.set(id, 0);
  }
  try {
    fs.appendFileSync(file, text);
    logSizes.set(id, size + Buffer.byteLength(text));
  } catch {
    /* 日志写入失败不影响主流程 */
  }
}

function readLogTail(id, maxBytes = 200 * 1024) {
  const file = logFile(id);
  try {
    const stat = fs.statSync(file);
    if (!stat.size) return '';
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    let text = buffer.toString('utf8');
    if (start > 0) {
      const idx = text.indexOf('\n');
      if (idx >= 0) text = text.slice(idx + 1);
    }
    return text;
  } catch {
    return '';
  }
}

function sseLogs(req, res, id) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2500\n\n');

  const tail = readLogTail(id);
  const lines = tail ? tail.replace(/\n$/, '').split('\n') : [];
  res.write(`event: init\ndata: ${JSON.stringify({ lines })}\n\n`);

  let set = logSubs.get(id);
  if (!set) {
    set = new Set();
    logSubs.set(id, set);
  }
  set.add(res);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* 忽略 */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    set.delete(res);
    if (set.size === 0) logSubs.delete(id);
  });
}

/* ------------------------------------------------------------------ */
/* 进程管理                                                            */
/* ------------------------------------------------------------------ */

function trackChild(child) {
  allChildren.add(child);
  child.once('exit', () => allChildren.delete(child));
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (isWin) {
      execFile(taskkillPath, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* 忽略 */
        }
      }
      resolve();
    }
  });
}

function killTreeSync(pid) {
  if (!pid) return;
  try {
    spawnSync(taskkillPath, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    /* 忽略 */
  }
}

function runShell(command, { cwd, env = {}, onChunk, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    trackChild(child);

    const handle = (data) => {
      try {
        onChunk?.(data.toString());
      } catch {
        /* 忽略日志回调异常 */
      }
    };
    child.stdout.on('data', handle);
    child.stderr.on('data', handle);

    let timer = null;
    let timedOut = false;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutMs);
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) return reject(new Error('命令执行超时'));
      if (code === 0) return resolve({ code });
      reject(new Error(`命令退出（代码 ${code}${signal ? `，信号 ${signal}` : ''}）`));
    });
  });
}

let installChain = Promise.resolve();

/** 串行执行依赖安装，避免多个项目同时写 pnpm store 造成磁盘争用 */
function withInstallLock(task) {
  const run = installChain.then(task, task);
  installChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/* ------------------------------------------------------------------ */
/* 解压                                                                */
/* ------------------------------------------------------------------ */

async function listArchiveEntries(archive) {
  if (extractor?.kind === 'bsdtar' || extractor?.kind === 'tar') {
    const { stdout } = await execFileAsync(extractor.path, ['-tf', archive], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.split(/\r?\n/).filter(Boolean);
  }
  if (extractor?.kind === 'unzip') {
    const { stdout } = await execFileAsync(extractor.path, ['-Z1', archive], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.split(/\r?\n/).filter(Boolean);
  }
  if (extractor?.kind === 'powershell') {
    const script = [
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      '$z = [System.IO.Compression.ZipFile]::OpenRead($env:ZIP_FILE)',
      'try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }',
    ].join('; ');
    const { stdout } = await execFileAsync(
      extractor.path,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ZIP_FILE: archive },
      },
    );
    return stdout.split(/\r?\n/).filter(Boolean);
  }
  fail(500, '未找到可用的解压工具（需要 Windows 自带 tar / unzip / PowerShell）');
}

function validateEntries(entries) {
  if (!entries.length) fail(400, '压缩包为空');
  for (const raw of entries) {
    const entry = raw.replace(/\\/g, '/');
    if (!entry || entry === './') continue;
    if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry) || entry.split('/').includes('..')) {
      fail(400, `压缩包包含非法路径，已拒绝解压：${raw}`);
    }
  }
}

async function extractArchive(archive, destination) {
  if (extractor?.kind === 'bsdtar' || extractor?.kind === 'tar') {
    try {
      await execFileAsync(extractor.path, ['-xf', archive, '-C', destination], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (err) {
      const hasFiles = fs.readdirSync(destination).length > 0;
      // bsdtar 在 Windows 上可能因时间戳/权限警告返回 1，但文件已解出
      if (hasFiles && (err.code === 1 || err.code === '1')) return;
      throw new Error(`解压失败：${err.stderr?.trim() || err.message}`);
    }
    return;
  }
  if (extractor?.kind === 'unzip') {
    try {
      await execFileAsync(extractor.path, ['-q', archive, '-d', destination], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (err) {
      throw new Error(`解压失败：${err.stderr?.trim() || err.message}`);
    }
    return;
  }
  if (extractor?.kind === 'powershell') {
    const script =
      '$ErrorActionPreference="Stop"; Expand-Archive -LiteralPath $env:ZIP_FILE -DestinationPath $env:DEST_DIR -Force';
    try {
      await execFileAsync(extractor.path, ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ZIP_FILE: archive, DEST_DIR: destination },
      });
    } catch (err) {
      throw new Error(`解压失败：${err.stderr?.trim() || err.message}`);
    }
    return;
  }
  fail(500, '未找到可用的解压工具');
}

function detectProjectRoot(tempDir) {
  const entries = fs
    .readdirSync(tempDir, { withFileTypes: true })
    .filter((entry) => entry.name !== '__MACOSX' && entry.name !== '.DS_Store');
  if (entries.length === 1 && entries[0].isDirectory()) {
    const inner = path.join(tempDir, entries[0].name);
    if (exists(path.join(inner, 'package.json'))) return inner;
  }
  return tempDir;
}

/* ------------------------------------------------------------------ */
/* 导入 / 安装 / 启动 / 停止                                            */
/* ------------------------------------------------------------------ */

function sanitizeName(input) {
  let name = String(input || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\.\.+/g, '.')
    .replace(/[.\s]+$/g, '')
    .trim();
  if (!name) name = 'project';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`;
  return name.slice(0, 60);
}

function uniqueProjectName(base) {
  let name = base;
  let index = 2;
  const taken = (value) => {
    const lower = value.toLowerCase();
    if ([...projects.keys()].some((id) => id.toLowerCase() === lower)) return true;
    try {
      return fs.readdirSync(PROJECTS_DIR).some((entry) => entry.toLowerCase() === lower);
    } catch {
      return false;
    }
  };
  while (taken(name)) {
    name = `${base}-${index}`;
    index += 1;
  }
  return name;
}

async function importArchive(archiveName, displayName, autoStart = false) {
  const file = path.basename(String(archiveName || ''));
  if (!/\.zip$/i.test(file)) fail(400, '仅支持 .zip 压缩包');
  const archive = path.join(ROOT, file);
  if (path.dirname(path.resolve(archive)) !== path.resolve(ROOT)) fail(400, '非法压缩包路径');
  if (!exists(archive) || !fs.statSync(archive).isFile()) fail(404, `压缩包不存在：${file}`);

  const entries = await listArchiveEntries(archive);
  validateEntries(entries);

  const name = uniqueProjectName(sanitizeName(displayName || file.replace(/\.zip$/i, '')));
  const tempDir = path.join(PROJECTS_DIR, `.import-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  fs.mkdirSync(tempDir, { recursive: true });

  let finalDir;
  let moved = false;
  try {
    await extractArchive(archive, tempDir);
    const root = detectProjectRoot(tempDir);
    if (!exists(path.join(root, 'package.json'))) {
      fail(400, '压缩包内未找到 package.json，无法作为前端项目导入');
    }
    finalDir = path.join(PROJECTS_DIR, name);
    if (exists(finalDir)) fail(409, `目标目录已存在：${name}`);
    if (root === tempDir) {
      fs.renameSync(tempDir, finalDir);
      moved = true;
    } else {
      fs.renameSync(root, finalDir);
      moved = true;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (err) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
    if (moved && finalDir) {
      try {
        fs.rmSync(finalDir, { recursive: true, force: true });
      } catch {
        /* 忽略清理失败 */
      }
    }
    throw err;
  }

  const project = {
    id: name,
    name,
    dir: `projects/${name}`,
    archive: file,
    port: null,
    createdAt: Date.now(),
    depsHash: null,
    installedAt: null,
    status: 'installing',
    busy: false,
    error: null,
    url: null,
    pid: null,
  };
  projects.set(name, project);
  saveState();
  logHeader(name, `导入项目 ${name}（来源 ${file}）`);
  setImmediate(async () => {
    try {
      await autoInitGit(project);
      await installProject(project);
      if (autoStart && projects.has(project.id)) {
        appendLog(project.id, '▸ 依赖已就绪，按导入设置自动启动…\n');
        await startProject(project);
      }
    } catch {
      /* 错误已记录到项目状态与日志 */
    }
  });
  return project;
}

/* ------------------------------------------------------------------ */
/* 依赖安装                                                            */
/* ------------------------------------------------------------------ */

async function installProject(project) {
  if (project.busy) throw new HttpError(409, '项目正忙，请稍候再试');
  if (project.gitBusy) throw new HttpError(409, 'Git 操作正在进行，请稍候再试');
  project.busy = true;
  try {
    await installDeps(project);
  } finally {
    project.busy = false;
    saveState();
  }
}

async function installDeps(project) {
  if (!packageManagerPath) {
    project.status = 'error';
    project.error = '未找到 pnpm 或 npm，无法安装依赖';
    appendLog(project.id, `✖ ${project.error}\n`);
    saveState();
    throw new Error(project.error);
  }

  project.status = 'installing';
  project.error = null;
  saveState();
  logHeader(project.id, `安装依赖（${packageManager}）`);

  const dir = projectDir(project);
  const hadNodeModules = exists(path.join(dir, 'node_modules'));
  const requestedAt = Date.now();
  let installSeconds = 0;

  try {
    await withInstallLock(async () => {
      const waited = Date.now() - requestedAt;
      if (waited > 600) {
        appendLog(project.id, `▸ 等待前一个安装任务完成（${(waited / 1000).toFixed(1)}s）\n`);
      }
      const startedAt = Date.now();
      const env = { FORCE_COLOR: '0', NO_COLOR: '1' };
      const logger = (chunk) => appendLog(project.id, chunk);
      appendLog(
        project.id,
        hadNodeModules
          ? '▸ 检测到依赖需要更新，开始增量安装…\n'
          : '▸ 开始安装依赖（重复的包会从全局 store 直接复用）…\n',
      );

      if (packageManager === 'pnpm') {
        // 优先把压缩包自带的 npm lock 转换为 pnpm lock，保证版本精确一致
        if (
          !exists(path.join(dir, 'pnpm-lock.yaml')) &&
          exists(path.join(dir, 'package-lock.json'))
        ) {
          appendLog(project.id, '▸ pnpm import：沿用 package-lock.json 中的精确版本\n');
          try {
            await runShell(`${quoteCmd(packageManagerPath)} import`, {
              cwd: dir,
              env,
              onChunk: logger,
              timeoutMs: 180000,
            });
          } catch (err) {
            appendLog(project.id, `⚠ pnpm import 失败，改为直接解析安装：${err.message}\n`);
          }
        }
        await runShell(
          `${quoteCmd(packageManagerPath)} install --no-frozen-lockfile --prefer-offline --reporter=append-only --config.confirmModulesPurge=false`,
          { cwd: dir, env, onChunk: logger },
        );
      } else {
        await runShell(
          `${quoteCmd(packageManagerPath)} install --no-audit --no-fund --prefer-offline`,
          {
            cwd: dir,
            env: { ...env, npm_config_cache: NPM_CACHE_DIR, npm_config_update_notifier: 'false' },
            onChunk: logger,
          },
        );
      }

      if (!exists(path.join(dir, 'node_modules'))) {
        throw new Error('安装完成后仍未找到 node_modules 目录');
      }

      installSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    });
  } catch (err) {
    project.status = 'error';
    project.error = `依赖安装失败：${err.message}`;
    appendLog(project.id, `\n✖ ${project.error}\n`);
    saveState();
    throw err;
  }

  project.depsHash = depsFingerprint(project);
  project.installedAt = Date.now();
  project.status = 'stopped';
  project.error = null;
  saveState();

  const storeNote =
    packageManager === 'pnpm'
      ? '已写入 pnpm 全局 store，后续项目直接复用'
      : '已写入共享缓存，后续项目可直接复用';
  appendLog(
    project.id,
    `✔ 依赖就绪（${packageManager}，安装 ${installSeconds}s，${storeNote}）\n`,
  );
}

/* ------------------------------------------------------------------ */
/* 启动 / 停止                                                          */
/* ------------------------------------------------------------------ */

let managerPort = DEFAULT_MANAGER_PORT;

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, HOST);
  });
}

async function allocatePort(project) {
  const taken = new Set();
  for (const [id, entry] of runtime) {
    if (entry.exited) continue;
    const other = projects.get(id);
    if (other?.port) taken.add(other.port);
  }

  const candidates = [];
  if (project.port) candidates.push(project.port);
  for (let offset = 0; offset < 100; offset += 1) candidates.push(5173 + offset);

  const seen = new Set();
  for (const port of candidates) {
    if (seen.has(port) || port === managerPort || taken.has(port)) continue;
    seen.add(port);
    if (await isPortFree(port)) return port;
  }
  throw new Error('没有可用的本地端口（5173 起已全部被占用）');
}

function httpPing(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

async function waitUntil(fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(intervalMs);
  }
  return null;
}

function spawnDevServer(project, port, directVite, script) {
  const dir = projectDir(project);
  const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none' };

  if (directVite) {
    return spawn(
      process.execPath,
      [viteEntry(project), '--port', String(port), '--strictPort', '--host', HOST],
      { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  }

  return spawn(`${quoteCmd(packageManagerPath)} run ${script.name}`, {
    shell: true,
    cwd: dir,
    env: { ...env, PORT: String(port) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function startProject(project) {
  if (project.busy) throw new HttpError(409, '项目正忙，请稍候再试');
  const existing = runtime.get(project.id);
  if (existing && !existing.exited) throw new HttpError(409, '项目已经在运行');
  if (existing?.exited) runtime.delete(project.id);

  const dir = projectDir(project);
  if (!isDir(dir)) throw new HttpError(404, '项目目录不存在');

  project.busy = true;
  project.error = null;
  try {
    if (!depsInstalled(project)) {
      await installDeps(project);
    }

    const script = startScript(project);
    const directVite = !!(
      viteEntry(project) &&
      script.name &&
      /^vite(\s|$|--)/i.test(script.command)
    );
    if (!directVite && !script.name) {
      throw new Error('未在 package.json 中找到 dev / start / serve 脚本');
    }

    const port = await allocatePort(project);
    project.port = port;
    project.status = 'starting';
    project.url = null;
    saveState();
    logHeader(project.id, `启动开发服务器（端口 ${port}）`);

    const child = spawnDevServer(project, port, directVite, script);
    trackChild(child);
    const entry = { child, stopping: false, exited: null, detectedUrl: null };
    runtime.set(project.id, entry);
    project.pid = child.pid;

    const onData = (data) => {
      const text = data.toString();
      appendLog(project.id, text);
      if (!entry.detectedUrl) {
        const match = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+/i);
        if (match) entry.detectedUrl = match[0].replace('localhost', HOST);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      appendLog(project.id, `✖ 进程启动失败：${err.message}\n`);
    });

    child.on('exit', (code, signal) => {
      entry.exited = { code, signal };
      if (entry.stopping) return;
      if (runtime.get(project.id) !== entry) return;
      runtime.delete(project.id);
      project.url = null;
      project.pid = null;
      if (project.status === 'starting' || project.status === 'running') {
        project.status = code === 0 ? 'stopped' : 'error';
        if (code !== 0) project.error = `开发服务器意外退出（代码 ${code ?? '未知'}）`;
        appendLog(
          project.id,
          `\n✖ 开发服务器已退出${code !== 0 ? `（代码 ${code ?? '未知'}）` : ''}\n`,
        );
      }
      saveState();
    });

    if (directVite) {
      const url = `http://${HOST}:${port}/`;
      const outcome = await waitUntil(async () => {
        if (entry.exited) return 'exited';
        try {
          await httpPing(url, 1200);
          return 'ok';
        } catch {
          return false;
        }
      }, 45000, 350);

      if (outcome === 'exited') {
        throw new Error(project.error || '开发服务器启动失败，请查看日志');
      }
      if (!outcome) {
        await killTree(child.pid);
        throw new Error('启动超时（45 秒内未就绪），请查看日志');
      }
      project.url = url;
      project.status = 'running';
      project.error = null;
      appendLog(project.id, `✔ 服务已就绪：${url}\n`);
      saveState();
    } else {
      const spawnAt = Date.now();
      const outcome = await waitUntil(() => {
        if (entry.exited) return 'exited';
        if (entry.detectedUrl) return 'url';
        if (Date.now() - spawnAt > 9000) return 'alive';
        return false;
      }, 30000, 250);

      if (outcome === 'exited') {
        throw new Error(project.error || '开发服务器启动失败，请查看日志');
      }
      project.status = 'running';
      project.error = null;
      project.url = entry.detectedUrl
        ? entry.detectedUrl.replace(/\/?$/, '/')
        : null;
      appendLog(
        project.id,
        project.url
          ? `✔ 服务已就绪：${project.url}\n`
          : '✔ 进程已启动，但未识别到访问地址，请查看日志\n',
      );
      saveState();
    }
  } catch (err) {
    const entry = runtime.get(project.id);
    if (entry && !entry.exited) {
      entry.stopping = true;
      await killTree(entry.child.pid);
      runtime.delete(project.id);
    }
    project.status = 'error';
    project.error = err.message;
    project.url = null;
    project.pid = null;
    appendLog(project.id, `\n✖ ${err.message}\n`);
    saveState();
    throw err;
  } finally {
    project.busy = false;
    saveState();
  }
}

async function stopProject(project) {
  if (project.busy) throw new HttpError(409, '项目正在切换状态，无法停止');

  const entry = runtime.get(project.id);
  if (!entry || entry.exited) {
    runtime.delete(project.id);
    project.status = 'stopped';
    project.url = null;
    project.pid = null;
    saveState();
    return false;
  }

  project.busy = true;
  entry.stopping = true;
  project.status = 'stopping';
  saveState();
  logHeader(project.id, '停止开发服务器');

  try {
    await killTree(entry.child.pid);
    await waitUntil(() => entry.exited, 8000, 200);
    if (!entry.exited) {
      appendLog(project.id, '⚠ 进程未在 8 秒内退出，请稍后在任务管理器确认\n');
    }
    runtime.delete(project.id);
    project.status = 'stopped';
    project.error = null;
    project.url = null;
    project.pid = null;
    appendLog(project.id, '■ 服务已停止\n');
    saveState();
    return true;
  } finally {
    project.busy = false;
    saveState();
  }
}

async function deleteProject(project) {
  if (project.busy || project.gitBusy) throw new HttpError(409, '项目正忙，请稍候再试');
  if (runtime.has(project.id)) {
    await stopProject(project);
  }
  const dir = projectDir(project);
  const projectsRoot = path.resolve(PROJECTS_DIR);
  if (!dir.startsWith(projectsRoot + path.sep)) {
    throw new HttpError(400, '项目目录不在 projects 目录下，已拒绝删除');
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(logFile(project.id), { force: true });
  projects.delete(project.id);
  logSizes.delete(project.id);
  fingerprintCache.delete(dir);
  saveState();
}

async function renameProject(project, rawName) {
  if (project.busy || project.gitBusy) throw new HttpError(409, '项目正忙，请稍候再试');
  const raw = String(rawName || '').trim();
  if (!raw) throw new HttpError(400, '请输入新的项目名称');

  const name = sanitizeName(raw);
  if (name === project.name) return project;

  const lowered = name.toLowerCase();
  const mapConflict = [...projects.values()].some(
    (item) => item.id !== project.id && item.id.toLowerCase() === lowered,
  );
  const currentBase = path.basename(projectDir(project));
  let dirConflict = false;
  try {
    dirConflict = fs
      .readdirSync(PROJECTS_DIR)
      .some((entry) => entry.toLowerCase() === lowered && entry !== currentBase);
  } catch {
    /* 目录暂时不可读，交给后续 rename 报错 */
  }
  if (mapConflict || dirConflict) throw new HttpError(409, `名称已被占用：${name}`);

  // 运行中的项目必须先停掉，否则 Windows 无法重命名它的工作目录
  if (runtime.has(project.id)) {
    await stopProject(project);
  }
  if (project.busy) throw new HttpError(409, '项目正在切换状态，请稍后再试');

  project.busy = true;
  const oldId = project.id;
  const oldDir = projectDir(project);
  const newDir = path.join(PROJECTS_DIR, name);

  try {
    try {
      fs.renameSync(oldDir, newDir);
    } catch (err) {
      throw new HttpError(409, `重命名目录失败：${err.message}。请关闭正在占用该目录的程序后重试`);
    }

    const oldLog = logFile(oldId);
    const newLog = logFile(name);
    try {
      if (exists(oldLog)) fs.renameSync(oldLog, newLog);
    } catch {
      /* 日志改名失败不影响项目本身 */
    }

    projects.delete(oldId);
    project.id = name;
    project.name = name;
    project.dir = `projects/${name}`;
    projects.set(name, project);

    const subscribers = logSubs.get(oldId);
    if (subscribers) {
      logSubs.delete(oldId);
      logSubs.set(name, subscribers);
    }
    const logSize = logSizes.get(oldId);
    logSizes.delete(oldId);
    if (logSize !== undefined) logSizes.set(name, logSize);
    fingerprintCache.delete(oldDir);
    fingerprintCache.delete(newDir);

    saveState();
    appendLog(name, `▸ 项目已重命名：${oldId} → ${name}\n`);

    // 目录改名会让 pnpm 的绝对路径链接失效，需要在原地重新链接一次
    if (packageManager === 'pnpm' && exists(path.join(newDir, 'node_modules'))) {
      appendLog(name, '▸ 修复 pnpm 依赖链接（目录已改名，使用全局 store，很快）…\n');
      try {
        await runShell(
          `${quoteCmd(packageManagerPath)} install --no-frozen-lockfile --prefer-offline --reporter=append-only --config.confirmModulesPurge=false`,
          {
            cwd: newDir,
            env: { FORCE_COLOR: '0', NO_COLOR: '1' },
            onChunk: (chunk) => appendLog(name, chunk),
          },
        );
        fingerprintCache.delete(newDir);
        project.depsHash = depsFingerprint(project);
        project.installedAt = Date.now();
        appendLog(name, '✔ 依赖链接已修复\n');
      } catch (err) {
        project.status = 'error';
        project.error = '依赖链接修复失败，下次启动会自动重装依赖';
        appendLog(name, `⚠ ${project.error}：${err.message}\n`);
      }
    }

    saveState();
    return project;
  } finally {
    project.busy = false;
    saveState();
  }
}

function revealProject(project) {
  const dir = projectDir(project);
  if (!isDir(dir)) throw new HttpError(404, '项目目录不存在');
  if (isWin) {
    // 用绝对路径：精简过 PATH 的终端里可能找不到 explorer.exe
    spawnDetached(exists(explorerPath) ? explorerPath : 'explorer.exe', [dir]);
  } else if (process.platform === 'darwin') {
    spawnDetached('open', [dir]);
  } else {
    spawnDetached('xdg-open', [dir]);
  }
}

/* ------------------------------------------------------------------ */
/* Git 版本管理                                                        */
/* ------------------------------------------------------------------ */

const GIT_IDENTITY = { name: 'Arena Manager', email: 'arena-manager@localhost' };
const GIT_IGNORE_LINES = ['node_modules/', 'dist/', '.vite/', '*.local'];

function isGitRepo(project) {
  return exists(path.join(projectDir(project), '.git'));
}

function gitError(result) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
  return text.split(/\r?\n/).find(Boolean) || `退出代码 ${result.code}`;
}

function runGit(args, cwd, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (!gitPath) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '未找到 git' });
      return;
    }
    execFile(
      gitPath,
      [
        '-c',
        'core.quotepath=false',
        '-c',
        'core.fsmonitor=false',
        '-c',
        `core.hooksPath=${GIT_HOOKS_DIR}`,
        ...args,
      ],
      { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      },
    );
  });
}

/** 补上前端工程必须忽略的目录，避免把 node_modules 提交进仓库 */
function ensureGitignore(dir) {
  const file = path.join(dir, '.gitignore');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* 没有则新建 */
  }
  const lines = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const missing = GIT_IGNORE_LINES.filter(
    (line) => !lines.has(line) && !lines.has(line.replace(/\/$/, '')),
  );
  if (!missing.length) return false;

  let next = text;
  if (next && !next.endsWith('\n')) next += '\n';
  if (next) next += '\n# 由 Arena 项目管理器补充\n';
  next += `${missing.join('\n')}\n`;
  fs.writeFileSync(file, next);
  return true;
}

/** Git 未配置全局身份时，只给当前仓库设置一个本地身份，不改全局配置 */
async function ensureGitIdentity(dir) {
  const name = await runGit(['config', 'user.name'], dir);
  if (!name.stdout.trim()) await runGit(['config', 'user.name', GIT_IDENTITY.name], dir);
  const email = await runGit(['config', 'user.email'], dir);
  if (!email.stdout.trim()) await runGit(['config', 'user.email', GIT_IDENTITY.email], dir);
}

async function withGitLock(project, task) {
  if (project.gitBusy) throw new HttpError(409, 'Git 操作正在进行，请稍候');
  project.gitBusy = true;
  try {
    return await task();
  } finally {
    project.gitBusy = false;
  }
}

async function initGitRepo(project, { commitMessage = 'chore: 初始提交' } = {}) {
  if (!gitPath) throw new HttpError(500, '未检测到 git，请安装 Git for Windows 后重试');
  const dir = projectDir(project);
  if (!isDir(dir)) throw new HttpError(404, '项目目录不存在');

  let created = false;
  if (!isGitRepo(project)) {
    let result = await runGit(['init', '-b', 'main'], dir);
    if (!result.ok) {
      // 旧版 Git 不支持 -b
      result = await runGit(['init'], dir);
      if (!result.ok) throw new HttpError(500, `git init 失败：${gitError(result)}`);
    }
    created = true;
  }

  const ignoreAdded = ensureGitignore(dir);
  await ensureGitIdentity(dir);

  let committed = false;
  const head = await runGit(['rev-parse', '--verify', 'HEAD'], dir);
  if (!head.ok) {
    const status = await runGit(['status', '--porcelain'], dir);
    if (status.ok && status.stdout.trim()) {
      const staged = await runGit(['add', '-A'], dir);
      if (!staged.ok) throw new HttpError(500, `添加文件失败：${gitError(staged)}`);
      // --no-verify：不执行项目里可能存在的 hooks
      const result = await runGit(['commit', '--no-verify', '-m', commitMessage], dir);
      if (!result.ok) throw new HttpError(500, `创建初始提交失败：${gitError(result)}`);
      committed = true;
    }
  }
  return { created, ignoreAdded, committed };
}

function parseGitChanges(stdout) {
  const parts = stdout.split('\0');
  const changes = [];
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (!record || record.length < 3) continue;
    const code = record.slice(0, 2);
    let file = record.slice(3);
    if (code.includes('R') || code.includes('C')) {
      const from = parts[index + 1];
      if (from) file = `${file} ← ${from}`;
      index += 1;
    }
    changes.push({ code: code.trim() || '??', path: file });
  }
  return changes;
}

function parseGitLog(stdout) {
  const commits = [];
  // format: 每条提交以换行分隔，字段之间用 NUL 分隔
  for (const line of stdout.split(/\r?\n/)) {
    const [hash, subject, date] = line.split('\0');
    if (!hash) continue;
    commits.push({ hash, subject: subject || '', date: date || '' });
  }
  return commits;
}

async function gitInfo(project) {
  const info = {
    available: !!gitPath,
    version: gitVersion,
    repo: isGitRepo(project),
    branch: null,
    hasCommits: false,
    lastCommit: null,
    commits: [],
    changes: [],
    changeCount: 0,
  };
  if (!info.available || !info.repo) return info;

  const dir = projectDir(project);
  const branch = await runGit(['symbolic-ref', '--short', '-q', 'HEAD'], dir);
  info.branch = branch.ok ? branch.stdout.trim() : null;

  const head = await runGit(['rev-parse', '--verify', 'HEAD'], dir);
  info.hasCommits = head.ok;
  if (info.hasCommits) {
    const log = await runGit(['log', '-8', '--pretty=format:%h%x00%s%x00%cI'], dir);
    if (log.ok) {
      info.commits = parseGitLog(log.stdout);
      info.lastCommit = info.commits[0] || null;
    }
  }

  const status = await runGit(['status', '--porcelain=v1', '-z'], dir);
  if (status.ok) {
    info.changes = parseGitChanges(status.stdout);
    info.changeCount = info.changes.length;
  }
  return info;
}

async function commitGit(project, rawMessage) {
  if (!gitPath) throw new HttpError(500, '未检测到 git，请安装 Git for Windows 后重试');
  if (!isGitRepo(project)) throw new HttpError(409, '尚未初始化 Git 仓库');

  const dir = projectDir(project);
  const message =
    String(rawMessage || '').trim().slice(0, 500) ||
    `chore: 保存进度 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;

  await ensureGitIdentity(dir);
  const status = await runGit(['status', '--porcelain=v1', '-z'], dir);
  if (!status.ok) throw new HttpError(500, `读取 Git 状态失败：${gitError(status)}`);
  if (!status.stdout) return { committed: false, reason: 'clean', message };

  const staged = await runGit(['add', '-A'], dir);
  if (!staged.ok) throw new HttpError(500, `添加文件失败：${gitError(staged)}`);

  const result = await runGit(['commit', '--no-verify', '-m', message], dir);
  if (!result.ok) {
    const detail = `${result.stdout}\n${result.stderr}`;
    if (/nothing to commit|no changes added/i.test(detail)) {
      return { committed: false, reason: 'clean', message };
    }
    throw new HttpError(500, `提交失败：${gitError(result)}`);
  }
  return { committed: true, message };
}

/** 导入后自动建库；失败只记日志，不影响依赖安装与启动 */
async function autoInitGit(project) {
  if (!gitPath) {
    appendLog(project.id, '▸ 未检测到 git，跳过版本库初始化（安装 Git 后可手动初始化）\n');
    return;
  }
  if (isGitRepo(project)) {
    appendLog(project.id, '▸ 项目自带 Git 仓库，保留原有历史\n');
    return;
  }
  try {
    const result = await withGitLock(project, () =>
      initGitRepo(project, { commitMessage: 'chore: 初始提交（从压缩包导入）' }),
    );
    appendLog(
      project.id,
      result.committed
        ? '✔ 已初始化 Git 仓库（main 分支）并创建初始提交\n'
        : '✔ 已初始化 Git 仓库（main 分支，暂无可提交文件）\n',
    );
  } catch (err) {
    appendLog(project.id, `⚠ Git 初始化失败：${err.message}（不影响安装与启动）\n`);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(payload));
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function statePayload() {
  return {
    app: 'arena-manager',
    managerPort,
    root: ROOT,
    tools: { ...tools, packageManager },
    projects: [...projects.values()].map(projectView),
    archives: scanArchives(),
    now: Date.now(),
  };
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${HOST}`);
  const pathname = url.pathname;

  // 仅接受本机控制台发起的请求，防止 DNS rebinding 与跨站伪造
  const hostHeader = String(req.headers.host || '').toLowerCase();
  const allowedHosts = [`127.0.0.1:${managerPort}`, `localhost:${managerPort}`];
  if (!allowedHosts.includes(hostHeader)) fail(421, '非法的 Host 请求头');
  const origin = req.headers.origin;
  if (origin) {
    const allowedOrigins = [`http://127.0.0.1:${managerPort}`, `http://localhost:${managerPort}`];
    if (!allowedOrigins.includes(origin.toLowerCase())) fail(403, '已拒绝跨域请求');
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, statePayload());
    return;
  }

  if (req.method === 'POST' && pathname === '/api/rescan') {
    adoptProjects();
    sendJson(res, 200, statePayload());
    return;
  }

  if (req.method === 'POST' && pathname === '/api/import') {
    const body = await readBody(req);
    if (!body || !body.archive) fail(400, '缺少 archive 参数');
    const project = await importArchive(body.archive, body.name, !!body.autoStart);
    sendJson(res, 201, { project: projectView(project) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/stop-all') {
    const running = [...projects.values()].filter((p) => runtime.has(p.id));
    const results = [];
    for (const project of running) {
      try {
        results.push({ id: project.id, ok: await stopProject(project) });
      } catch (err) {
        results.push({ id: project.id, ok: false, error: err.message });
      }
    }
    sendJson(res, 200, { results, state: statePayload() });
    return;
  }

  const match = pathname.match(
    /^\/api\/projects\/([^/]+)(?:\/(logs\/stream|logs|start|stop|install|reveal|rename|git(?:\/init|\/commit)?))?$/,
  );
  if (match) {
    let id;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      fail(400, '非法的项目 ID');
    }
    const action = match[2] || null;
    const project = projects.get(id);
    if (!project) fail(404, '项目不存在');

    if (req.method === 'GET' && action === 'logs') {
      const text = readLogTail(id, 512 * 1024);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(text);
      return;
    }

    if (req.method === 'GET' && action === 'logs/stream') {
      sseLogs(req, res, id);
      return;
    }

    if (req.method === 'GET' && action === 'git') {
      sendJson(res, 200, await gitInfo(project));
      return;
    }

    if (req.method === 'POST' && action === 'git/init') {
      const result = await withGitLock(project, async () => {
        logHeader(project.id, 'Git 初始化');
        const init = await initGitRepo(project);
        appendLog(
          project.id,
          `✔ 已初始化 Git 仓库${init.committed ? '并创建初始提交' : '（暂无可提交文件）'}\n`,
        );
        return init;
      });
      sendJson(res, 200, { ...result, info: await gitInfo(project) });
      return;
    }

    if (req.method === 'POST' && action === 'git/commit') {
      const body = await readBody(req);
      const result = await withGitLock(project, async () => {
        const commit = await commitGit(project, body?.message);
        if (commit.committed) {
          logHeader(project.id, 'Git 提交');
          appendLog(project.id, `✔ 已提交所有更改：${commit.message}\n`);
        }
        return commit;
      });
      sendJson(res, 200, { ...result, info: await gitInfo(project) });
      return;
    }

    if (req.method === 'DELETE' && !action) {
      await deleteProject(project);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && action === 'start') {
      await startProject(project);
      sendJson(res, 200, { project: projectView(project) });
      return;
    }

    if (req.method === 'POST' && action === 'stop') {
      await stopProject(project);
      sendJson(res, 200, { project: projectView(project) });
      return;
    }

    if (req.method === 'POST' && action === 'rename') {
      const body = await readBody(req);
      const renamed = await renameProject(project, body?.name);
      sendJson(res, 200, { project: projectView(renamed), oldId: id });
      return;
    }

    if (req.method === 'POST' && action === 'install') {
      if (project.busy) fail(409, '项目正忙，请稍候');
      if (runtime.has(project.id)) fail(409, '请先停止项目再重装依赖');
      installProject(project).catch(() => {
        /* 错误已记录到项目状态与日志 */
      });
      sendJson(res, 202, { ok: true, queued: true });
      return;
    }

    if (req.method === 'POST' && action === 'reveal') {
      revealProject(project);
      sendJson(res, 200, { ok: true });
      return;
    }

    fail(405, '不支持的请求方法');
  }

  fail(404, '接口不存在');
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (!res.headersSent) {
      sendJson(res, status, { error: err.message || '服务器内部错误' });
    } else {
      try {
        res.end();
      } catch {
        /* 忽略 */
      }
    }
    if (status >= 500) console.error('[错误]', err);
  }
});

/* ------------------------------------------------------------------ */
/* 启动 / 退出                                                          */
/* ------------------------------------------------------------------ */

function listen(srv, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      srv.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      srv.off('error', onError);
      resolve();
    };
    srv.once('error', onError);
    srv.once('listening', onListening);
    srv.listen(port, HOST);
  });
}

/** 探测是否已经有管理器在运行，避免重复启动出第二个实例 */
function findRunningManager() {
  return new Promise((resolve) => {
    let index = 0;

    const next = () => {
      if (index >= 10) return resolve(null);
      const port = DEFAULT_MANAGER_PORT + index;
      index += 1;
      let done = false;

      const finishPort = (found) => {
        if (done) return;
        done = true;
        if (found) resolve(found);
        else next();
      };

      const req = http.get(
        `http://${HOST}:${port}/api/state`,
        { timeout: 500 },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
            if (body.length > 512 * 1024) req.destroy();
          });
          res.on('end', () => {
            try {
              const data = JSON.parse(body);
              if (data && data.app === 'arena-manager') {
                finishPort(`http://${HOST}:${port}/`);
                return;
              }
            } catch {
              /* 不是管理器，继续探测 */
            }
            finishPort(null);
          });
          res.on('error', () => finishPort(null));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        finishPort(null);
      });
      req.on('error', () => finishPort(null));
    };

    next();
  });
}

function openBrowser(url) {
  if (isWin) {
    spawnDetached(exists(cmdPath) ? cmdPath : 'cmd.exe', ['/d', '/s', '/c', 'start', '', url]);
  } else if (process.platform === 'darwin') {
    spawnDetached('open', [url]);
  } else {
    spawnDetached('xdg-open', [url]);
  }
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${signal}] 正在停止所有项目…`);
  for (const child of allChildren) killTreeSync(child.pid);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('exit', () => {
  for (const child of allChildren) killTreeSync(child.pid);
});

async function boot() {
  const existing = await findRunningManager();
  if (existing) {
    const wantsOpen = process.argv.includes('--open') || process.env.ARENA_OPEN === '1';
    console.log('');
    console.log(`  管理器已经在运行：${existing}`);
    console.log(
      wantsOpen ? '  无需重复启动，已为你打开现有控制台。' : '  无需重复启动，直接访问上面的地址即可。',
    );
    console.log('');
    if (wantsOpen) openBrowser(existing);
    return;
  }

  loadState();

  // 清理上次异常退出遗留的导入临时目录（仅清理超过 1 小时的）
  try {
    for (const entry of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('.import-')) continue;
      const target = path.join(PROJECTS_DIR, entry.name);
      try {
        if (Date.now() - fs.statSync(target).mtimeMs > 3600000) {
          fs.rmSync(target, { recursive: true, force: true });
        }
      } catch {
        /* 忽略单个目录清理失败 */
      }
    }
  } catch {
    /* 忽略扫描失败 */
  }

  adoptProjects();

  if (!extractor) console.warn('[提示] 未找到可用的解压工具，将无法导入压缩包');
  if (!packageManager) console.warn('[提示] 未找到 pnpm / npm，将无法安装依赖');
  if (!gitPath) console.warn('[提示] 未找到 git，导入时不会自动初始化版本库');

  let lastError = null;
  for (let offset = 0; offset < 10; offset += 1) {
    const port = DEFAULT_MANAGER_PORT + offset;
    try {
      await listen(server, port);
      managerPort = port;
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (err.code !== 'EADDRINUSE') break;
    }
  }
  if (lastError) throw lastError;

  const address = `http://${HOST}:${managerPort}/`;
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │  Arena 项目管理器                            │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log(`  控制台    ${address}`);
  console.log(
    `  安装器    ${packageManager ? `${packageManager}${tools.pnpmVersion ? ` ${tools.pnpmVersion}` : ''}` : '未找到'}`,
  );
  console.log(`  解压器    ${tools.extractor || '未找到'}`);
  console.log(`  版本库    ${gitVersion ? `git ${gitVersion}` : '未找到'}`);
  console.log('  退出      Ctrl+C（会同时停止所有已启动的项目）');
  console.log('');

  if (process.argv.includes('--open') || process.env.ARENA_OPEN === '1') {
    openBrowser(address);
  }
}

boot().catch((err) => {
  console.error('启动失败:', err.message || err);
  process.exit(1);
});