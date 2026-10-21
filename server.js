#!/usr/bin/env node
'use strict';
/*
 * SQUAD/CODE bridge: serves index.html, spawns headless Claude Code (`claude -p`) and keeps the app's data in SQLite (db.js).
 * Only dependency: better-sqlite3 (`npm install`). Binds to 127.0.0.1 only and requires a per-start token on every API call.
 *
 *   node server.js [--port 4317]
 *
 * Environment:
 *   SQUAD_PORT        port (default 4317)
 *   SQUAD_CLAUDE_BIN  claude executable to use when the UI does not set one (default: "claude")
 *   SQUAD_HOME        overrides the home dir used for ~/.claude/settings.json (tests)
 *   SQUAD_PROJECTS_DIR root of the per-project folders (default: ./projects next to this file)
 *   SQUAD_DATA_DIR    folder of the SQLite database, squad.db (default: ./data next to this file)
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const kiroEngine = require('./kiro-engine.js');

const ROOT = __dirname;
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : process.env.SQUAD_PORT) || 4317;
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const HOME = process.env.SQUAD_HOME || os.homedir();
const DEFAULT_BIN = process.env.SQUAD_KIRO_BIN || process.env.SQUAD_CLAUDE_BIN || 'kiro-cli';
const IS_WIN = process.platform === 'win32';
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-code-'));
// Every project runs in its own folder under PROJECTS_DIR (created on the first run).
const PROJECTS_DIR = path.resolve(process.env.SQUAD_PROJECTS_DIR || path.join(ROOT, 'projects'));
const FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)$/;
try { fs.mkdirSync(PROJECTS_DIR, { recursive: true }); } catch {} // otherwise the first project run creates it
// The app's data (workspace, versions, operation rooms, chats, run history) lives in DATA_DIR/squad.db (db.js).
// It is opened at start only when it exists (or a data/workspace.json from the file version waits to be imported); otherwise the
// page asks the person to create it (POST /api/setup) and nothing is written to disk before that.
const DATA_DIR = path.resolve(process.env.SQUAD_DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'squad.db');
const LEGACY_FILE = path.join(DATA_DIR, 'workspace.json');
const MAX_WORKSPACE = 64 * 1024 * 1024;
const dbModule = require('./db.js');
if (dbModule.driverError) { console.error(`SQUAD/CODE: ${dbModule.driverError}`); process.exit(1); }
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) console.warn(`SQUAD/CODE pede o Node 22 ou mais novo (este é o ${process.version}). Atualize se algo falhar.`);
let store = null;
function openDb() {
  store = dbModule.openStore(DATA_DIR);
  if (store.migration?.imported) console.log(`Workspace migrado de data/workspace.json para ${store.file} (${store.migration.versions} versões antigas). Os arquivos JSON foram para ${path.join(DATA_DIR, 'legacy-json')}.`);
  if (store.migration?.warning) console.warn(store.migration.warning);
  if (store.migration?.error) console.warn(store.migration.error);
  return store;
}
// No database, or one without a workspace yet: the page shows "Nenhum banco de dados encontrado" before anything else.
const setupNeeded = () => !store || !store.readWorkspace(false).exists;
function needStore() {
  if (!store) throw Object.assign(new Error('Nenhum banco de dados ainda. Crie um na tela inicial do SQUAD/CODE.'), { status: 503 });
  return store;
}

const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_]*(\([^()\r\n"]{0,200}\))?$|^mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_*-]+)?$/;
const MODEL_RE = /^[A-Za-z0-9._\-\[\]]{1,80}$/;
const MAX_EVENTS = 5000;
const MAX_BODY = 2 * 1024 * 1024;

const runs = new Map();
let maxConcurrent = 2;
let creditBudget = 0;      // 0 = sem limite. Teto de créditos da sessão, verificado antes de iniciar uma execução.
let sessionCredits = 0;    // créditos gastos desde que o bridge subiu (soma das execuções concluídas).
const versionCache = new Map();

/* ---------- helpers ---------- */
function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}
function fail(res, status, message) { json(res, status, { ok: false, error: message }); }

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('Corpo da requisição muito grande.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON inválido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function allowedHost(value) {
  if (!value) return false;
  return value === `${HOST}:${PORT}` || value === `localhost:${PORT}`;
}
function allowedOrigin(origin) {
  if (!origin) return true; // same-origin GET/navigation, curl
  return origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
}
function tokenOk(req, url) {
  const given = req.headers['x-squad-token'] || url.searchParams.get('token') || '';
  const a = Buffer.from(String(given)); const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Resolve an executable name to a full path (Windows needs to know .exe vs .cmd). */
function resolveBin(bin) {
  return new Promise(resolve => {
    if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) return resolve(fs.existsSync(bin) ? path.resolve(bin) : null);
    execFile(IS_WIN ? 'where' : 'which', [bin], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const lines = String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const pick = IS_WIN ? (lines.find(l => /\.(exe|cmd|bat)$/i.test(l)) || lines[0]) : lines[0];
      resolve(pick || null);
    });
  });
}

/** Expand Windows 8.3 short names (C:\USER~1) that Claude Code's path safety checks reject. */
const longPath = p => { try { return fs.realpathSync.native(p); } catch { return p; } };

/* Claude Code loads CLAUDE.md from every folder above the cwd: project runs skip this app's own instructions.
 * Absolute patterns plus a `**`-anchored variant (last two segments of ROOT), in case the drive letter does not match. */
const APP_MEMORY_EXCLUDES = (() => {
  const root = longPath(ROOT).replace(/\\/g, '/'), tail = root.split('/').filter(Boolean).slice(-2).join('/');
  const files = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude/CLAUDE.md', '.claude/rules/**'];
  return [...files.map(f => `${root}/${f}`), ...files.map(f => `**/${tail}/${f}`)];
})();

/* Each project folder is its own git repository (git init before its first run, when git is installed). Otherwise Claude Code, which
 * takes the enclosing repository as the project (git status, .claude/settings.json outside Windows), and the agents' git commands
 * would work on whatever repository holds PROJECTS_DIR, such as this app's clone. GIT_CEILING_DIRECTORIES (startRun) covers the rest. */
const gitCeiling = () => [longPath(PROJECTS_DIR), process.env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(path.delimiter);
let gitMissing = false;
function ensureProjectRepo(dir) {
  if (gitMissing || fs.existsSync(path.join(dir, '.git'))) return Promise.resolve();
  return new Promise(resolve => {
    execFile('git', ['init', '-q'], { cwd: dir, windowsHide: true, timeout: 15000, env: { ...process.env, GIT_CEILING_DIRECTORIES: gitCeiling() } }, err => {
      if (err?.code === 'ENOENT') { gitMissing = true; console.warn('git não encontrado: as pastas dos projetos ficam sem repositório próprio. Instale o Git para isolá-las.'); }
      else if (err) console.warn(`git init em ${dir} falhou: ${err.message}`);
      resolve();
    });
  });
}

/** Commit the project's working tree after a successful step (opt-in). Uses a per-command local identity so it never touches global
 *  git config; "nothing to commit" counts as success; never rejects — a failed commit must not fail the run. */
function autoCommit(dir, message) {
  if (gitMissing) return Promise.resolve({ ok: false, error: 'git indisponível' });
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: gitCeiling() };
  const gitRun = args => new Promise(resolve => execFile('git', args, { cwd: dir, windowsHide: true, timeout: 20000, env }, (err, stdout, stderr) => resolve({ err, out: String(stdout || '') + String(stderr || '') })));
  return gitRun(['add', '-A']).then(a => {
    if (a.err) return { ok: false, error: a.err.message };
    return gitRun(['-c', 'user.name=squad-code-kiro', '-c', 'user.email=squad-code-kiro@local', 'commit', '-m', String(message || 'etapa').slice(0, 500)]).then(c => {
      const nothing = /nothing to commit|working tree clean|nada (a|para) (submeter|comitar|commitar)/i.test(c.out);
      return { ok: !c.err || nothing, nothing, error: c.err && !nothing ? c.out.slice(-300) : null };
    });
  }).catch(e => ({ ok: false, error: e.message }));
}

/** Set up an isolated git worktree + branch (squad/<id>) for a run, so parallel steps don't collide. Returns
 *  {projectDir, dir, branch} or null on any failure (caller falls back to the project folder). Creates an empty initial commit
 *  if the repo has none (worktree add needs a base commit). */
async function setupWorktree(projectDir, id) {
  if (gitMissing) return null;
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: gitCeiling() };
  const gitRun = args => new Promise(resolve => execFile('git', args, { cwd: projectDir, windowsHide: true, timeout: 20000, env }, (err, out, serr) => resolve({ err, out: String(out || '') + String(serr || '') })));
  try {
    const head = await gitRun(['rev-parse', '--verify', '-q', 'HEAD']);
    if (head.err) await gitRun(['-c', 'user.name=squad-code-kiro', '-c', 'user.email=squad-code-kiro@local', 'commit', '--allow-empty', '-q', '-m', 'init']);
    const short = String(id).slice(0, 8);
    const branch = `squad/${short}`;
    const dir = path.join(PROJECTS_DIR, '.worktrees', `${path.basename(projectDir)}-${short}`);
    const add = await gitRun(['worktree', 'add', '-b', branch, dir]);
    if (add.err) { console.warn(`git worktree add falhou: ${add.out.slice(-200)}`); return null; }
    return { projectDir, dir, branch };
  } catch (e) { console.warn(`setupWorktree: ${e.message}`); return null; }
}

/** Remove a run's worktree (the branch and its commits persist). Never rejects. */
function removeWorktree(projectDir, dir) {
  if (gitMissing || !dir) return Promise.resolve();
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: gitCeiling() };
  return new Promise(resolve => execFile('git', ['worktree', 'remove', '--force', dir], { cwd: projectDir, windowsHide: true, timeout: 20000, env }, () => resolve()));
}

const SQUAD_BRANCH_RE = /^squad\/[A-Za-z0-9._-]{1,60}$/;
/** List the squad/<id> branches of a project repo (the per-run worktree branches). */
function listBranches(dir) {
  if (gitMissing) return Promise.resolve([]);
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: gitCeiling() };
  return new Promise(resolve => execFile('git', ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(contents:subject)%09%(committerdate:iso8601)', 'refs/heads/squad/'], { cwd: dir, windowsHide: true, timeout: 15000, env }, (err, out) => {
    if (err) return resolve([]);
    resolve(String(out || '').split(/\r?\n/).filter(Boolean).map(l => { const [branch, subject, date] = l.split('\t'); return { branch, subject: subject || '', date: date || '' }; }));
  }));
}
/** Merge a squad/<id> branch into the project's current branch; aborts cleanly on conflict. */
function mergeBranch(dir, branch) {
  if (gitMissing) return Promise.resolve({ ok: false, error: 'git indisponível' });
  if (!SQUAD_BRANCH_RE.test(branch)) return Promise.resolve({ ok: false, error: 'branch inválido' });
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: gitCeiling() };
  const g = args => new Promise(res => execFile('git', args, { cwd: dir, windowsHide: true, timeout: 20000, env }, (err, out, serr) => res({ err, out: String(out || '') + String(serr || '') })));
  return g(['-c', 'user.name=squad-code-kiro', '-c', 'user.email=squad-code-kiro@local', 'merge', '--no-ff', '-m', `merge ${branch}`, branch]).then(m => {
    if (!m.err) return { ok: true };
    return g(['merge', '--abort']).then(() => ({ ok: false, conflict: /conflict|conflito/i.test(m.out), error: m.out.slice(-300) }));
  });
}
/** Delete a squad/<id> branch (force). */
function deleteBranch(dir, branch) {
  if (gitMissing) return Promise.resolve({ ok: false, error: 'git indisponível' });
  if (!SQUAD_BRANCH_RE.test(branch)) return Promise.resolve({ ok: false, error: 'branch inválido' });
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: gitCeiling() };
  return new Promise(res => execFile('git', ['branch', '-D', branch], { cwd: dir, windowsHide: true, timeout: 15000, env }, (err, out, serr) => res({ ok: !err, error: err ? (String(serr || '') + String(out || '')).slice(-300) : null })));
}

/** Unified diff a squad/<id> branch introduces vs the project's current HEAD (capped for the UI). */
function branchDiff(dir, branch) {
  if (gitMissing) return Promise.resolve({ ok: false, error: 'git indisponível' });
  if (!SQUAD_BRANCH_RE.test(branch)) return Promise.resolve({ ok: false, error: 'branch inválido' });
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: gitCeiling() };
  return new Promise(res => execFile('git', ['diff', `HEAD...${branch}`], { cwd: dir, windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024, env }, (err, out, serr) => {
    if (err) return res({ ok: false, error: (String(serr || '') + String(out || '')).slice(-300) });
    res({ ok: true, patch: String(out || '').slice(0, 60000) });
  }));
}

/** Folder of a project under PROJECTS_DIR; the name is a plain slug, so it cannot leave the root. */
function projectDir(name) {
  const folder = String(name || '').trim();
  if (!FOLDER_RE.test(folder) || RESERVED_RE.test(folder)) throw new Error(`Pasta de projeto inválida: ${folder.slice(0, 80)}`);
  return path.join(longPath(PROJECTS_DIR), folder);
}

const cmdQuote = s => /^[A-Za-z0-9_\-.:\\/=@,+]+$/.test(s) ? s : `"${String(s).replace(/"/g, '""')}"`;

/** Spawn an executable; .cmd/.bat on Windows must go through cmd.exe. Args are simple tokens only. */
function spawnBin(resolved, args, opts) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...args].map(cmdQuote).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  }
  if (/\.(mjs|cjs|js)$/i.test(resolved)) return spawn(process.execPath, [resolved, ...args], opts);
  return spawn(resolved, args, opts);
}

async function claudeVersion(bin) {
  const resolved = await resolveBin(bin);
  if (!resolved) return { resolved: null, version: null, error: `Executável "${bin}" não encontrado no PATH.` };
  if (versionCache.has(resolved)) return versionCache.get(resolved);
  const info = await new Promise(resolve => {
    const child = spawnBin(resolved, ['--version'], { windowsHide: true });
    let out = ''; let err = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ resolved, version: null, error: e.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ resolved, version: out.trim().split(/\r?\n/)[0] || 'desconhecida', error: null });
      else resolve({ resolved, version: null, error: (err || out).trim().slice(0, 500) || `exit ${code}` });
    });
  });
  if (info.version) versionCache.set(resolved, info);
  return info;
}

// List the models the installed Kiro CLI reports (`kiro-cli chat --list-models --format json`). Cached for 5 min. Used by GET
// /api/models so the UI model picker reflects exactly what this CLI offers (names, credit multipliers, default).
let modelsCache = { at: 0, bin: null, data: null };
async function kiroModels(bin) {
  const resolved = await resolveBin(bin);
  if (!resolved) return { models: [], default: null, error: `Executável "${bin}" não encontrado no PATH.` };
  if (modelsCache.data && modelsCache.bin === resolved && Date.now() - modelsCache.at < 300000) return modelsCache.data;
  const data = await new Promise(resolve => {
    const child = spawnBin(resolved, ['chat', '--list-models', '--format', 'json'], { windowsHide: true });
    let out = ''; let err = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ models: [], default: null, error: e.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ models: [], default: null, error: (err || out).trim().slice(0, 500) || `exit ${code}` });
      try {
        const parsed = JSON.parse(out);
        const models = Array.isArray(parsed.models) ? parsed.models.map(m => ({
          id: String(m.model_id || m.model_name || ''),
          name: String(m.model_name || m.model_id || ''),
          description: typeof m.description === 'string' ? m.description.slice(0, 300) : '',
          rate: typeof m.rate_multiplier === 'number' ? m.rate_multiplier : null,
          context: typeof m.context_window_tokens === 'number' ? m.context_window_tokens : null,
        })).filter(m => m.id) : [];
        resolve({ models, default: parsed.default_model || null, error: null });
      } catch (e) { resolve({ models: [], default: null, error: 'Falha ao ler a lista de modelos: ' + e.message }); }
    });
  });
  if (data.models.length) modelsCache = { at: Date.now(), bin: resolved, data };
  return data;
}

// List MCP servers configured for the Kiro CLI (`kiro-cli mcp list`, text output). Used by GET /api/mcp for the settings panel.
async function kiroMcpList(bin) {
  const resolved = await resolveBin(bin);
  if (!resolved) return { text: '', error: `Executável "${bin}" não encontrado no PATH.` };
  return new Promise(resolve => {
    const child = spawnBin(resolved, ['mcp', 'list'], { windowsHide: true });
    let out = ''; let err = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ text: '', error: e.message }); });
    child.on('close', code => { clearTimeout(timer); const text = String(out + err).slice(0, 20000); resolve({ text, error: code === 0 ? null : (String(err || '').trim().slice(0, 500) || `exit ${code}`) }); });
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
}

/* ---------- runs ---------- */
function activeCount() { return [...runs.values()].filter(r => r.status === 'running').length; }

function pushEvent(run, event) {
  run.events.push(event);
  if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of run.clients) res.write(line);
  persistEvent(run, event);
}

/* Run history (db.js): events go to the database in small batches. Partial text deltas are not kept (the console never shows
   them) and long tool outputs are cut; the exit event is always kept, past MAX_EVENTS too. */
function persistEvent(run, event) {
  if (!run.persist || event.type === 'stream_event') return;
  if (run.saved >= MAX_EVENTS && event.type !== 'exit') return;
  run.saved++;
  run.pending.push({ seq: run.saved, type: String(event.type || ''), data: JSON.stringify(storedEvent(event)) });
  if (event.type === 'exit') flushRun(run);
  else if (!run.flushTimer) run.flushTimer = setTimeout(() => flushRun(run), 200);
}
function flushRun(run) {
  clearTimeout(run.flushTimer); run.flushTimer = null;
  const batch = run.pending ? run.pending.splice(0) : [];
  if (!batch.length || !run.persist || !store) return;
  try { store.appendRunEvents(run.id, batch); }
  catch (e) { run.persist = false; console.warn(`Histórico da execução ${run.id} não gravado: ${e.message}`); }
}
function storedEvent(event) {
  if (event.type !== 'user' || !Array.isArray(event.message?.content)) return event;
  const cut = v => typeof v === 'string' && v.length > 4000 ? v.slice(0, 4000) + '…' : v;
  const block = b => b?.type !== 'tool_result' ? b : { ...b, content: Array.isArray(b.content) ? b.content.map(x => x?.type === 'text' ? { ...x, text: cut(x.text) } : x) : cut(b.content) };
  return { ...event, message: { ...event.message, content: event.message.content.map(block) } };
}

function validateRunOptions(o = {}) {
  const out = {};
  out.claudePath = typeof o.claudePath === 'string' && o.claudePath.trim() ? o.claudePath.trim() : DEFAULT_BIN;
  if (typeof o.project === 'string' && o.project.trim()) {
    const dir = projectDir(o.project);
    fs.mkdirSync(dir, { recursive: true });
    out.cwd = longPath(dir); out.projectRun = true;
  } else if (typeof o.cwd === 'string' && o.cwd.trim()) {
    // Explicit folder (tests, direct API use). Never an implicit one: process.cwd() is usually this app's own folder.
    const cwd = path.resolve(o.cwd.trim());
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Diretório de trabalho inexistente: ${cwd}`);
    out.cwd = longPath(cwd);
  } else throw new Error('Execução sem pasta de projeto: informe a pasta da operação (opção "project", em projects/).');
  if (o.model) { if (!MODEL_RE.test(o.model)) throw new Error('Modelo inválido.'); out.model = o.model; }
  if (o.permissionMode) { if (!PERMISSION_MODES.includes(o.permissionMode)) throw new Error('Modo de permissão inválido.'); out.permissionMode = o.permissionMode; }
  if (o.effort) { if (!EFFORTS.includes(o.effort)) throw new Error('Nível de esforço inválido.'); out.effort = o.effort; }
  if (o.maxBudgetUsd !== undefined && o.maxBudgetUsd !== '' && o.maxBudgetUsd !== null) {
    const n = Number(o.maxBudgetUsd); if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new Error('Orçamento máximo inválido.'); out.maxBudgetUsd = String(n);
  }
  const tools = list => (Array.isArray(list) ? list : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 60);
  out.allowedTools = tools(o.allowedTools); out.disallowedTools = tools(o.disallowedTools);
  for (const t of [...out.allowedTools, ...out.disallowedTools]) if (!TOOL_RE.test(t)) throw new Error(`Ferramenta inválida: ${t}`);
  // Optional hard restriction of the built-in tool set (maps to --tools). null = Claude Code defaults.
  out.tools = Array.isArray(o.tools) ? tools(o.tools) : null;
  if (out.tools) for (const t of out.tools) if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(t)) throw new Error(`Ferramenta inválida: ${t}`);
  out.addDirs = (Array.isArray(o.addDirs) ? o.addDirs : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 10).map(d => path.resolve(d));
  out.addDirs = out.addDirs.map(d => fs.existsSync(d) ? longPath(d) : d);
  for (const d of out.addDirs) if (!fs.existsSync(d)) throw new Error(`Diretório adicional inexistente: ${d}`);
  // Streams text deltas as `stream_event` lines (chat bubbles grow while the model writes).
  out.partial = o.partial === true;
  // Squad colleagues the agent may call with the Agent tool (--agents file) and their text in the stream (--forward-subagent-text).
  out.agents = validateAgents(o.agents);
  out.forwardSubagents = o.forwardSubagents === true;
  const timeout = Number(o.timeoutSec); out.timeoutSec = Number.isFinite(timeout) && timeout >= 10 && timeout <= 7200 ? timeout : 900;

  // Kiro engine options: map the UI's fields to the kiro-cli flags. `agent` selects a native Kiro agent (.kiro/agents/<name>).
  // `trustTools` (optional array) restricts trust; omitted => trust-all (headless squad execution needs tools without prompts).
  out.autoCommit = o.autoCommit === true;
  out.worktree = o.worktree === true;
  out.kiro = kiroEngine.validateKiroOptions({
    agent: typeof o.agent === 'string' && o.agent.trim() ? o.agent.trim() : undefined,
    model: o.model || undefined,
    effort: o.effort || undefined,
    agentEngine: o.agentEngine || undefined,
    mode: o.mode || undefined,
    cloud: o.cloud === true,
    repo: o.repo || undefined,
    requireMcpStartup: o.requireMcpStartup === true,
    resumeId: o.resumeId || undefined,
    trustTools: Array.isArray(o.trustTools) ? o.trustTools : undefined,
    trustAll: o.trustAll,
  });
  return out;
}

/** CLI-defined subagents: whitelisted fields only, bounded sizes. null = none. */
function validateAgents(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Agentes inválidos.');
  const entries = Object.entries(value);
  if (entries.length > 20) throw new Error('Até 20 agentes por execução.');
  const out = {};
  for (const [key, def] of entries) {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(key)) throw new Error(`Identificador de agente inválido: ${key.slice(0, 60)}`);
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error(`Definição inválida do agente ${key}.`);
    const description = typeof def.description === 'string' ? def.description.trim() : '';
    if (!description || description.length > 1000) throw new Error(`Descrição inválida do agente ${key}.`);
    const agent = { description, prompt: typeof def.prompt === 'string' ? def.prompt.slice(0, 60000) : '' };
    if (def.tools !== undefined) {
      if (!Array.isArray(def.tools) || def.tools.length > 30 || !def.tools.every(t => typeof t === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(t))) throw new Error(`Ferramentas inválidas do agente ${key}.`);
      agent.tools = def.tools;
    }
    if (def.model) { if (!MODEL_RE.test(def.model)) throw new Error(`Modelo inválido do agente ${key}.`); agent.model = def.model; }
    if (def.effort) { if (!EFFORTS.includes(def.effort)) throw new Error(`Esforço inválido do agente ${key}.`); agent.effort = def.effort; }
    out[key] = agent;
  }
  if (JSON.stringify(out).length > 400000) throw new Error('Definição dos agentes muito grande.');
  return entries.length ? out : null;
}

async function startRun(body) {
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) throw new Error('Prompt vazio.');
  if (prompt.length > 400000) throw new Error('Prompt muito grande.');
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.slice(0, 100000) : '';
  const opts = validateRunOptions(body.options);
  if (activeCount() >= maxConcurrent) throw Object.assign(new Error(`Limite de ${maxConcurrent} execuções simultâneas atingido.`), { status: 429 });
  if (creditBudget > 0 && sessionCredits >= creditBudget) throw Object.assign(new Error(`Orçamento de créditos da sessão atingido (${round4(sessionCredits)} de ${creditBudget}). Ajuste nas configurações ou reinicie o bridge.`), { status: 429 });
  const resolved = await resolveBin(opts.claudePath);
  if (!resolved) throw new Error(`Kiro CLI não encontrado ("${opts.claudePath}"). Ajuste o caminho nas configurações ou instale o kiro-cli.`);
  // Guard against stale/invalid model ids (e.g. Claude-era 'sonnet'/'opus'): kiro-cli exits 1 on an unknown --model.
  // Map an alias to the newest catalog id that mentions it; otherwise drop it so kiro uses its default ('auto').
  if (opts.kiro && opts.kiro.model) {
    try {
      const mc = await kiroModels(resolved);
      const ids = (mc.models || []).map(m => m.id);
      const picked = kiroEngine.pickModel(opts.kiro.model, ids);
      if (picked !== opts.kiro.model) {
        console.warn(`Modelo "${opts.kiro.model}" não está no catálogo do kiro-cli; usando ${picked || 'o padrão (auto)'}.`);
        opts.kiro.model = picked || undefined;
      }
    } catch { /* if the catalog can't be read, leave the model as-is */ }
  }
  const id = crypto.randomUUID();
  let worktree = null;
  if (opts.projectRun) {
    await ensureProjectRepo(opts.cwd);
    if (opts.worktree) { worktree = await setupWorktree(opts.cwd, id); if (worktree) opts.cwd = worktree.dir; }
  }
  // Kiro CLI takes the prompt as a positional argument. A system prompt (if any) is prepended to the prompt text, since Kiro has
  // no --append-system-prompt-file. We keep it bounded.
  const fullPrompt = systemPrompt.trim() ? `${systemPrompt.trim()}\n\n---\n\n${prompt}` : prompt;
  const kiroArgs = kiroEngine.buildKiroArgs(opts.kiro, fullPrompt);
  // Public arg view: hide the (possibly large) prompt so the console shows the command, not the whole text.
  const publicArgs = kiroArgs.map((a, i) => i === kiroArgs.length - 1 ? '<prompt>' : a);

  const run = {
    id, status: 'running', startedAt: new Date().toISOString(), endedAt: null, label: String(body.label || '').slice(0, 200),
    cwd: opts.cwd, args: publicArgs, child: null, events: [], clients: new Set(),
    result: null, timer: null, cancelled: false, timedOut: false,
    meta: dbModule.runMeta(body.meta), project: typeof body.options?.project === 'string' ? body.options.project.slice(0, 80) : '',
    persist: !!store, saved: 0, pending: [], flushTimer: null,
    // Rotation bookkeeping.
    keyAttempts: [], credits: 0, worktree,
  };
  runs.set(id, run);
  if (run.persist) try { store.insertRun(run); } catch (e) { run.persist = false; console.warn(`Histórico da execução ${id} não gravado: ${e.message}`); }
  pushEvent(run, { type: 'bridge', subtype: 'spawned', pid: null, cwd: opts.cwd, args: run.args, at: run.startedAt });

  // Overall timeout spans all key-rotation attempts.
  run.timer = setTimeout(() => { run.timedOut = true; pushEvent(run, { type: 'bridge', subtype: 'timeout', timeoutSec: opts.timeoutSec }); killTree(run.child); }, opts.timeoutSec * 1000);

  // Drive the rotation loop asynchronously; return the run immediately so the HTTP response (runId) goes out at once.
  runWithRotation(run, resolved, kiroArgs, opts).catch(err => {
    // Defensive: a bug in the loop should still close the run.
    finalizeRun(run, { code: null, stderrTail: err.message || 'erro interno no bridge', converter: null });
  });
  return run;
}

/* Count of keys in the pool (0 when no store yet). With no keys, we run once relying on the CLI's own auth (saved login). */
function poolSize() { try { return store ? store.apiKeyCount() : 0; } catch { return 0; } }

/**
 * Run one step, rotating KIRO_API_KEY across the pool when a run fails from quota/auth. Each attempt is a fresh kiro-cli process.
 * The ACP converter is re-created per attempt, but credits and events accumulate on the run.
 */
async function runWithRotation(run, resolved, kiroArgs, opts) {
  const maxAttempts = Math.max(1, poolSize()); // at least one attempt (CLI's own auth when the pool is empty)
  let lastStderr = '', lastCode = null, lastConverter = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (run.cancelled || run.timedOut) break;
    // Pick a key from the pool (null => rely on the CLI's saved auth).
    const picked = store ? store.nextApiKey() : null;
    if (store && poolSize() > 0 && !picked) {
      // Pool exists but every key is exhausted / cooling down.
      lastStderr = 'Todas as chaves de API do pool estão esgotadas ou em espera. Adicione outra chave ou reative uma em Configurações.';
      pushEvent(run, { type: 'bridge', subtype: 'keys-exhausted', message: lastStderr });
      break;
    }
    if (picked) pushEvent(run, { type: 'bridge', subtype: 'key', keyId: picked.id, label: picked.label || '', attempt: attempt + 1 });

    const attemptResult = await spawnKiroAttempt(run, resolved, kiroArgs, opts, picked);
    lastStderr = attemptResult.stderrTail; lastCode = attemptResult.code; lastConverter = attemptResult.converter;
    const summary = attemptResult.converter ? attemptResult.converter.summary() : null;
    const credits = summary ? summary.credits || 0 : 0;

    if (attemptResult.ok) {
      if (picked) { try { store.markApiKeyOk(picked.id, credits); } catch {} }
      run.credits += credits;
      if ((opts.autoCommit || opts.worktree) && opts.projectRun && !run.cancelled && !run.timedOut) {
        try { const c = await autoCommit(opts.cwd, `[squad] ${run.label || 'etapa'}`); pushEvent(run, { type: 'bridge', subtype: 'commit', ok: !!c.ok, nothing: !!c.nothing, branch: run.worktree ? run.worktree.branch : null, error: c.error || null }); } catch {}
      }
      return finalizeRun(run, attemptResult);
    }

    // Failed attempt. Decide whether to rotate.
    const kind = run.cancelled || run.timedOut ? 'other' : kiroEngine.classifyFailure(attemptResult.stderrTail, attemptResult.code);
    if (picked) {
      try {
        if (kind === 'exhausted') store.setApiKeyStatus(picked.id, 'exhausted', attemptResult.stderrTail.slice(-300));
        else if (kind === 'auth') store.setApiKeyStatus(picked.id, 'invalid', attemptResult.stderrTail.slice(-300));
        store.markApiKeyFail(picked.id, attemptResult.stderrTail.slice(-300));
      } catch {}
    }
    run.credits += credits;

    const canRotate = picked && kiroEngine.shouldRotate(kind) && !run.cancelled && !run.timedOut && attempt + 1 < maxAttempts;
    if (canRotate) {
      pushEvent(run, { type: 'bridge', subtype: 'rotate', from: picked.id, reason: kind });
      continue; // try next key
    }
    break; // not key-related, or no more keys
  }

  return finalizeRun(run, { code: lastCode, stderrTail: lastStderr, converter: lastConverter });
}

/**
 * Spawn a single kiro-cli attempt. Resolves with { ok, code, stderrTail, converter } once the child closes.
 * Streams ACP events through the converter into the run's event stream (adapting them to the Claude-style contract the UI reads).
 */
function spawnKiroAttempt(run, resolved, kiroArgs, opts, picked) {
  return new Promise(resolveAttempt => {
    const converter = kiroEngine.makeAcpConverter();
    // Env for the attempt. When a key is picked, set KIRO_API_KEY for this child only. The CLI uses the API key only when no saved
    // login exists; the operator should `kiro-cli logout` first for the pool to take effect (documented in the UI/README).
    const env = { ...process.env, SQUAD_CODE_ENTRYPOINT: 'squad-code-bridge' };
    if (picked) env.KIRO_API_KEY = picked.key;
    if (opts.projectRun) env.GIT_CEILING_DIRECTORIES = gitCeiling();

    const child = spawnBin(resolved, kiroArgs, {
      cwd: opts.cwd, windowsHide: true, detached: !IS_WIN, env,
      stdio: ['ignore', 'pipe', 'pipe'], // prompt is a CLI arg, so stdin is unused
    });
    run.child = child;
    // Update the spawned pid now that we have it.
    pushEvent(run, { type: 'bridge', subtype: 'pid', pid: child.pid });

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let acp; try { acp = JSON.parse(line); } catch { pushEvent(run, { type: 'raw', text: line.slice(0, 4000) }); continue; }
        for (const evt of converter(acp)) { if (evt.type === 'result') run.result = evt; pushEvent(run, evt); }
      }
    });
    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-4000); pushEvent(run, { type: 'stderr', text: chunk.slice(0, 4000) }); });
    child.on('error', err => { stderrTail += err.message; });
    child.on('close', code => {
      if (buffer.trim()) { try { for (const evt of converter(JSON.parse(buffer))) { if (evt.type === 'result') run.result = evt; pushEvent(run, evt); } } catch { pushEvent(run, { type: 'raw', text: buffer.slice(0, 4000) }); } }
      const summary = converter.summary();
      const ok = !run.cancelled && !run.timedOut && code === 0 && !summary.isError;
      resolveAttempt({ ok, code, stderrTail, converter });
    });
  });
}

/** Build and push the final `exit` event and close the run. Mirrors the original bridge's exit contract (plus credits). */
function finalizeRun(run, { code, stderrTail, converter }) {
  if (run.endedAt) return run; // already finalized
  clearTimeout(run.timer);
  const summary = converter ? converter.summary() : {};
  sessionCredits = round4(sessionCredits + (run.credits || summary.credits || 0));
  const isError = run.cancelled || run.timedOut || code !== 0 || !!summary.isError;
  run.status = run.cancelled ? 'cancelled' : run.timedOut ? 'timeout' : isError ? 'error' : 'done';
  run.endedAt = new Date().toISOString();
  const exit = {
    type: 'exit', status: run.status, code, isError,
    result: typeof summary.finalText === 'string' ? summary.finalText : '',
    // Kiro bills in credits. costUsd stays null (the UI tolerates it); credits carries the real cost.
    costUsd: null, credits: round4(run.credits || summary.credits || 0),
    durationMs: summary.durationMs ?? null, numTurns: summary.numTurns ?? null, sessionId: summary.sessionId ?? null,
    error: isError ? (run.cancelled ? 'Execução cancelada pelo operador.' : run.timedOut ? 'Tempo limite excedido.' : (summary.errorText || String(stderrTail || '').trim().slice(-1500) || kiroEngine.describeExit(code))) : null,
  };
  pushEvent(run, exit);
  if (run.persist) try { store.finishRun(run, exit); } catch (e) { console.warn(`Histórico da execução ${run.id} não finalizado: ${e.message}`); }
  for (const res of run.clients) res.end();
  run.clients.clear();
  run.child = null;
  if (run.worktree) removeWorktree(run.worktree.projectDir, run.worktree.dir).catch(() => {});
  setTimeout(() => runs.delete(run.id), 30 * 60 * 1000).unref();
  return run;
}

function round4(n) { return typeof n === 'number' && isFinite(n) ? Math.round(n * 10000) / 10000 : (Number(n) || 0); }

function runSummary(r) {
  return { id: r.id, status: r.status, label: r.label, ...r.meta, project: r.project, startedAt: r.startedAt, endedAt: r.endedAt, cwd: r.cwd, events: r.events.length };
}

/* ---------- settings.json ---------- */
// A project folder (`project`) may not exist yet: it is created by its first run or by the first save here.
function settingsPath(scope, cwd, project) {
  if (scope === 'user') return path.join(HOME, '.claude', 'settings.json');
  if (scope === 'project' || scope === 'local') {
    let base;
    if (project && project.trim()) base = projectDir(project);
    else {
      base = cwd && cwd.trim() ? path.resolve(cwd.trim()) : process.cwd();
      if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) throw new Error(`Diretório do projeto inexistente: ${base}`);
    }
    return path.join(base, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json');
  }
  throw new Error('Escopo inválido. Use user, project ou local.');
}

async function readSettings(scope, cwd, project) {
  const file = settingsPath(scope, cwd, project);
  try { const text = await fsp.readFile(file, 'utf8'); return { ok: true, scope, path: file, exists: true, text }; }
  catch (e) { if (e.code === 'ENOENT') return { ok: true, scope, path: file, exists: false, text: '{\n}\n' }; throw e; }
}

async function writeSettings(scope, cwd, project, text) {
  if (typeof text !== 'string') throw new Error('Conteúdo ausente.');
  let parsed; try { parsed = JSON.parse(text); } catch (e) { throw new Error('JSON inválido: ' + e.message); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json deve ser um objeto JSON.');
  const file = settingsPath(scope, cwd, project);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) { backup = file + '.bak'; await fsp.copyFile(file, backup); }
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
  return { ok: true, scope, path: file, backup };
}

/* ---------- page data tags ---------- */
// The page boots from these (no request, no flash of the browser copy): JSON with every `<` escaped.
const jsonTag = (id, data) => `<script type="application/json" id="${id}">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
// `setup`: no database or no workspace in it yet, so the page asks how to start (POST /api/setup) before anything else.
function workspaceTag() {
  let info;
  try { info = store ? store.readWorkspace() : { rev: '', savedAt: '', workspace: null }; } catch (e) { info = { rev: '', savedAt: '', workspace: null, error: e.message }; }
  return jsonTag('squad-disk', { rev: info.rev, savedAt: info.savedAt, path: store?.file || DB_FILE, workspace: info.workspace, error: info.error || '', setup: !info.error && !info.workspace && setupNeeded() });
}
// Operation rooms (the last 200 messages of each project) and chats; orphans are swept first.
function memoryTag() {
  if (!store) return jsonTag('squad-memory', { rooms: {}, chats: {} });
  try { store.sweep(); return jsonTag('squad-memory', { rooms: store.loadRooms(200), chats: store.loadChats() }); }
  catch (e) { console.warn(`Sala e conversas não carregadas: ${e.message}`); return jsonTag('squad-memory', { rooms: {}, chats: {} }); }
}

/* ---------- http ---------- */
async function serveIndex(res) {
  const file = path.join(ROOT, 'index.html');
  let html;
  try { html = await fsp.readFile(file, 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    // index.html is built from src/; a clone without it gets the way to build it instead of a bare error.
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end('<!doctype html><meta charset="utf-8"><title>SQUAD/CODE</title><body style="font:15px/1.7 system-ui,sans-serif;background:#05080a;color:#d8e1e5;padding:48px;max-width:640px">'
      + '<h1 style="font-weight:500">index.html não encontrado</h1><p>A interface é gerada a partir de <code>src/</code>. Na pasta do SQUAD/CODE, rode <code>npm run dev</code> (gera e inicia o bridge) ou <code>python build.py</code> e recarregue esta página.</p></body>');
  }
  const tags = workspaceTag() + '\n' + memoryTag(); // a function replacement: the data may contain `$&` and similar patterns
  html = html.replace('<head>', () => `<head>\n<meta name="squad-bridge-token" content="${TOKEN}">\n${tags}`);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(html);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (!allowedHost(req.headers.host)) return fail(res, 421, 'Host não permitido.');
  if (!allowedOrigin(req.headers.origin)) return fail(res, 403, 'Origem não permitida.');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveIndex(res);
  if (!url.pathname.startsWith('/api/')) return fail(res, 404, 'Não encontrado.');
  if (!tokenOk(req, url)) return fail(res, 401, 'Token do bridge inválido. Recarregue a página servida pelo bridge.');

  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const bin = url.searchParams.get('claudePath') || url.searchParams.get('kiroPath') || DEFAULT_BIN;
      const info = await claudeVersion(bin);
      let keys = 0; try { keys = store ? store.apiKeyCount() : 0; } catch {}
      // Legacy field names (claudeVersion/claudePath/claudeError) kept for UI compatibility; mirrored under kiro* names too.
      return json(res, 200, {
        ok: true, bridge: 'squad-code', engine: 'kiro-cli',
        claudeVersion: info.version, claudePath: info.resolved, claudeError: info.error,
        kiroVersion: info.version, kiroPath: info.resolved, kiroError: info.error,
        apiKeys: keys,
        defaultCwd: process.cwd(), projectsDir: longPath(PROJECTS_DIR), home: HOME, platform: process.platform,
        activeRuns: activeCount(), maxConcurrent, sessionCredits: round4(sessionCredits), creditBudget, dbReady: !setupNeeded(), dbPath: store?.file || DB_FILE,
      });
    }
    // Live model list from the installed Kiro CLI, so the UI model picker always matches what this CLI offers.
    if (req.method === 'GET' && url.pathname === '/api/models') {
      const bin = url.searchParams.get('kiroPath') || url.searchParams.get('claudePath') || DEFAULT_BIN;
      const info = await kiroModels(bin);
      return json(res, 200, { ok: !info.error, ...info });
    }
    // Configured MCP servers (kiro-cli mcp list) for the settings MCP panel.
    if (req.method === 'GET' && url.pathname === '/api/mcp') {
      const bin = url.searchParams.get('kiroPath') || url.searchParams.get('claudePath') || DEFAULT_BIN;
      const info = await kiroMcpList(bin);
      return json(res, 200, { ok: !info.error, ...info });
    }
    // Usage/cost scorecard aggregated from the persisted run history (credits).
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      return json(res, 200, { ok: true, stats: store ? store.statsSummary() : null });
    }
    // Lexical search over the run history (FTS5 memory).
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const query = url.searchParams.get('q') || '';
      const limit = Number(url.searchParams.get('limit')) || 20;
      return json(res, 200, { ok: true, results: store ? store.searchRuns(query, limit) : [] });
    }
    // Worktree branches (squad/<id>) of a project repo: list, merge into the main tree, or delete.
    if (req.method === 'GET' && url.pathname === '/api/branches') {
      let dir; try { dir = projectDir(url.searchParams.get('project') || ''); } catch (e) { return fail(res, 400, e.message); }
      if (!fs.existsSync(path.join(dir, '.git'))) return json(res, 200, { ok: true, branches: [] });
      return json(res, 200, { ok: true, branches: await listBranches(dir) });
    }
    if (req.method === 'GET' && url.pathname === '/api/branches/diff') {
      let dir; try { dir = projectDir(url.searchParams.get('project') || ''); } catch (e) { return fail(res, 400, e.message); }
      const r = await branchDiff(dir, String(url.searchParams.get('branch') || ''));
      return json(res, r.ok ? 200 : 409, { ok: !!r.ok, ...r });
    }
    if (req.method === 'POST' && (url.pathname === '/api/branches/merge' || url.pathname === '/api/branches/delete')) {
      const body = await readBody(req);
      let dir; try { dir = projectDir(body.project); } catch (e) { return fail(res, 400, e.message); }
      const r = url.pathname.endsWith('/merge') ? await mergeBranch(dir, String(body.branch || '')) : await deleteBranch(dir, String(body.branch || ''));
      return json(res, r.ok ? 200 : 409, { ok: !!r.ok, ...r });
    }
    // First start: the page creates the database with the workspace the person chose (from scratch, the example, a backup or the
    // browser's copy). Validated before anything is written; refused once a workspace exists.
    if (req.method === 'POST' && url.pathname === '/api/setup') {
      const body = await readBody(req, MAX_WORKSPACE);
      if (!setupNeeded()) return json(res, 409, { ok: false, conflict: true, path: store.file, error: 'Já existe um banco de dados com um workspace. Recarregue a página.' });
      dbModule.checkWorkspace(body);
      if (!store) openDb();
      const saved = store.syncWorkspace(body, '', false);
      console.log(`Banco de dados criado: ${store.file}`);
      return json(res, 201, saved);
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      const n = Number(body.concurrency);
      if (Number.isInteger(n) && n >= 1 && n <= 8) maxConcurrent = n;
      const cb = Number(body.creditBudget);
      if (Number.isFinite(cb) && cb >= 0 && cb <= 1000000) creditBudget = cb;
      return json(res, 200, { ok: true, maxConcurrent, creditBudget });
    }
    /* ---------- API key pool (KIRO_API_KEY rotation) ---------- */
    if (url.pathname === '/api/keys') {
      if (req.method === 'GET') return json(res, 200, { ok: true, keys: store ? store.listApiKeys() : [], count: store ? store.apiKeyCount() : 0 });
      if (req.method === 'POST') {
        const body = await readBody(req);
        const added = needStore().addApiKey(body.key, body.label || '');
        return json(res, 201, { ok: true, key: added });
      }
    }
    if (parts[1] === 'keys' && parts[2] && !parts[3]) {
      const id = Number(parts[2]);
      if (!Number.isInteger(id)) return fail(res, 400, 'Id de chave inválido.');
      if (req.method === 'DELETE') return json(res, 200, needStore().removeApiKey(id));
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const body = await readBody(req);
        let view;
        if (typeof body.label === 'string') view = needStore().setApiKeyLabel(id, body.label);
        if (typeof body.status === 'string') view = needStore().setApiKeyStatus(id, body.status, body.error || null, body.cooldownUntil || null);
        return json(res, 200, { ok: true, key: view || needStore().listApiKeys().find(k => k.id === id) || null });
      }
    }
    if (url.pathname === '/api/keys/reorder' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, { ok: true, keys: needStore().reorderApiKeys(Array.isArray(body.ids) ? body.ids : []) });
    }
    if (url.pathname === '/api/runs' && req.method === 'GET') {
      // The history comes from the database; runs still in memory report their current status.
      if (!store) return json(res, 200, { ok: true, runs: [] });
      const list = store.listRuns({ projectId: url.searchParams.get('projectId') || '', limit: url.searchParams.get('limit') });
      return json(res, 200, { ok: true, runs: list.map(r => runs.has(r.id) ? { ...r, status: runs.get(r.id).status } : r) });
    }
    if (url.pathname === '/api/runs' && req.method === 'POST') {
      const run = await startRun(await readBody(req));
      return json(res, 201, { ok: true, runId: run.id, args: run.args, cwd: run.cwd });
    }
    if (parts[1] === 'runs' && parts[2]) {
      const run = runs.get(parts[2]);
      if (!run) {
        // Older runs (and those from before a restart) are replayed from the history.
        const saved = store?.getRun(parts[2]);
        if (!saved) return fail(res, 404, 'Execução não encontrada.');
        if (req.method === 'GET' && parts[3] === 'events') {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
          res.write(': connected\n\n');
          for (const evt of store.runEvents(parts[2])) res.write(`data: ${JSON.stringify(evt)}\n\n`);
          return res.end();
        }
        if (req.method === 'POST' && parts[3] === 'cancel') return json(res, 200, { ok: true, status: saved.run.status });
        if (req.method === 'GET' && !parts[3]) return json(res, 200, { ok: true, ...saved });
        return fail(res, 404, 'Rota não encontrada.');
      }
      if (req.method === 'GET' && parts[3] === 'events') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        for (const evt of run.events) res.write(`data: ${JSON.stringify(evt)}\n\n`);
        if (run.status !== 'running') return res.end();
        run.clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(ping); run.clients.delete(res); });
        return;
      }
      if (req.method === 'POST' && parts[3] === 'cancel') {
        if (run.status === 'running') { run.cancelled = true; pushEvent(run, { type: 'bridge', subtype: 'cancel' }); killTree(run.child); }
        return json(res, 200, { ok: true, status: run.status });
      }
      if (req.method === 'GET' && !parts[3]) return json(res, 200, { ok: true, run: runSummary(run), result: run.result });
    }
    if (url.pathname === '/api/workspace') {
      // ?meta=1: a tab checking whether the saved workspace moved on, without the workspace itself.
      if (req.method === 'GET') {
        const withWorkspace = url.searchParams.get('meta') !== '1';
        if (!store) return json(res, 200, { ok: true, exists: false, rev: '', savedAt: '', path: DB_FILE, ...(withWorkspace ? { workspace: null } : {}) });
        return json(res, 200, { ok: true, ...store.readWorkspace(withWorkspace) });
      }
      if (req.method === 'PUT') {
        // The first workspace only comes through /api/setup, chosen by the person.
        if (setupNeeded()) return fail(res, 503, 'Nenhum banco de dados ainda. Crie um na tela inicial do SQUAD/CODE.');
        const saved = store.syncWorkspace(await readBody(req, MAX_WORKSPACE), url.searchParams.get('base') || '', url.searchParams.get('force') === '1');
        return json(res, saved.conflict ? 409 : 200, saved);
      }
    }
    // A browser copy that lost to the saved version (or a stale page's last state) becomes a version, never discarded.
    if (url.pathname === '/api/workspace/backups' && req.method === 'POST') return json(res, 201, { ok: true, id: needStore().backupWorkspace(await readBody(req, MAX_WORKSPACE)) });
    if (url.pathname === '/api/workspace/snapshots' && req.method === 'GET') return json(res, 200, { ok: true, snapshots: needStore().listSnapshots() });
    if (parts[1] === 'workspace' && parts[2] === 'snapshots' && parts[3] && !parts[4] && req.method === 'GET') {
      const workspace = needStore().getSnapshot(parts[3]);
      return workspace ? json(res, 200, { ok: true, workspace }) : fail(res, 404, 'Versão não encontrada.');
    }
    // Operation room: incremental {seq, upserts, removes}; also sent with sendBeacon (?token=) when the page closes.
    if (parts[1] === 'rooms' && parts[2] && !parts[3] && req.method === 'POST') return json(res, 200, needStore().saveRoom(decodeURIComponent(parts[2]), await readBody(req, MAX_WORKSPACE)));
    if (parts[1] === 'chats' && parts[2] && parts[3] && !parts[4]) {
      const key = decodeURIComponent(parts[3]);
      if (req.method === 'PUT' || req.method === 'POST') return json(res, 200, needStore().saveChat(parts[2], key, await readBody(req, MAX_WORKSPACE)));
      if (req.method === 'DELETE') return json(res, 200, needStore().deleteChat(parts[2], key));
    }
    if (url.pathname === '/api/claude/settings') {
      const scope = url.searchParams.get('scope') || 'user';
      const cwd = url.searchParams.get('cwd') || '', project = url.searchParams.get('project') || '';
      if (req.method === 'GET') return json(res, 200, await readSettings(scope, cwd, project));
      if (req.method === 'PUT') { const body = await readBody(req); return json(res, 200, await writeSettings(scope, cwd, project, body.text)); }
    }
    return fail(res, 404, 'Rota não encontrada.');
  } catch (err) {
    return fail(res, err.status || 400, err.message || 'Erro no bridge.');
  }
}

const server = http.createServer((req, res) => { handle(req, res).catch(err => { try { fail(res, 500, err.message); } catch {} }); });

function shutdown() {
  for (const run of runs.values()) { if (run.child) { run.cancelled = true; killTree(run.child); } flushRun(run); }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  server.close();
  // Runs still open are marked interrupted at the next start.
  setTimeout(() => { try { store?.close(); } catch {} process.exit(0); }, 300).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// A port in use (usually another SQUAD/CODE already open) ends here, before the database is touched.
server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`SQUAD/CODE: a porta ${PORT} já está em uso (outro SQUAD/CODE aberto?). Feche-o ou use outra porta: npm start -- --port ${PORT + 1}`);
  else console.error(`SQUAD/CODE: não foi possível abrir o servidor em ${HOST}:${PORT}. ${err.message}`);
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // The database opens only once the port is ours: a second instance never marks the first one's live runs as interrupted.
  if (fs.existsSync(DB_FILE) || fs.existsSync(LEGACY_FILE)) {
    try { openDb(); }
    catch (e) { console.error(`SQUAD/CODE: não foi possível abrir o banco em ${DATA_DIR}.\n${e.message}`); try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {} process.exit(1); }
  }
  const url = `http://${HOST}:${PORT}`;
  console.log(`SQUAD/CODE bridge ativo em ${url}`);
  console.log(`Pasta dos projetos: ${PROJECTS_DIR}`);
  if (store) console.log(`Banco de dados: ${store.file}`);
  else console.log(`Banco de dados: nenhum em ${DATA_DIR}. Abra ${url} para criar um.`);
  if (store?.interrupted) console.log(`${store.interrupted} execução(ões) interrompida(s) na última sessão marcada(s) no histórico.`);
  if (store) { try { const n = store.apiKeyCount(); if (n) console.log(`Pool de API keys: ${n} chave(s) carregada(s).`); } catch {} }
  if (process.env.SQUAD_PRINT_TOKEN) console.log(`TOKEN=${TOKEN}`);
  claudeVersion(DEFAULT_BIN).then(info => {
    if (info.version) console.log(`Kiro CLI ${info.version} (${info.resolved})`);
    else console.warn(`Kiro CLI não encontrado (${DEFAULT_BIN}): ${info.error}\n  Instale o kiro-cli, faça login (ou use o pool de API keys) e reinicie, ou aponte SQUAD_KIRO_BIN para o executável.\n  Sem ele o app abre, mas as execuções ficam só na simulação.`);
  }, () => {});
});

module.exports = { server };
