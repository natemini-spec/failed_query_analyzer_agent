#!/usr/bin/env node
'use strict';

// 로컬 전용 컨트롤 패널: Redash API Key 입력, Claude Code 로그인, 파이프라인 실행을
// 브라우저 UI로 감싼다. 절대 localhost 외부에는 열지 않는다 (보안 모델: 운영자 개인
// 키/인증은 각자 컴퓨터에만 남아야 함 — 공유 호스팅 서버로 만들면 안 됨).
//
// 사용법:
//   node scripts/control_panel.js
//   node scripts/control_panel.js --port 4173

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const { computeDefaultRange } = require('./lib/date_range');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const ENV_PATH = path.join(ROOT, '.env');
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), '.npm-global', 'bin', 'claude');
const NODE_BIN = process.execPath;
const HOST = '127.0.0.1'; // 절대 0.0.0.0으로 바꾸지 않는다 — 로컬 전용

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; } else { args[key] = true; }
    }
  }
  return args;
}

function parseEnvFile(envPath) {
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function upsertEnvVar(envPath, key, value) {
  let lines = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf8').split('\n');
  } else if (fs.existsSync(envPath + '.example')) {
    lines = fs.readFileSync(envPath + '.example', 'utf8').split('\n');
  }
  let found = false;
  lines = lines.map((line) => {
    if (line.trim().startsWith(`${key}=`)) { found = true; return `${key}=${value}`; }
    return line;
  });
  if (!found) lines.push(`${key}=${value}`);
  fs.writeFileSync(envPath, lines.join('\n').replace(/\n{3,}/g, '\n\n'), 'utf8');
}

function maskKey(v) {
  if (!v) return '';
  if (v.length <= 6) return '••••';
  return v.slice(0, 3) + '••••' + v.slice(-3);
}

function getClaudeAuthStatus() {
  try {
    const out = execFileSync(CLAUDE_BIN, ['auth', 'status'], { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(out);
  } catch (err) {
    return { loggedIn: false, error: err.message };
  }
}

function listDashboards() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith('dashboard_') && f.endsWith('.html'))
    .map((f) => ({ file: f, mtime: fs.statSync(path.join(DATA_DIR, f)).mtimeMs, range: f.replace(/^dashboard_/, '').replace(/\.html$/, '') }))
    .sort((a, b) => b.mtime - a.mtime);
}

// ---- 실행 중인 작업(잡) 관리: SSE로 로그 스트리밍 ----
const jobs = new Map();
let activeJobId = null;

function startJob(id, cmd, args) {
  const child = spawn(cmd, args, { cwd: ROOT, env: process.env });
  const job = { child, buffer: [], subscribers: new Set(), done: false, exitCode: null };
  jobs.set(id, job);
  activeJobId = id;

  const emit = (text) => {
    job.buffer.push(text);
    for (const res of job.subscribers) res.write(`data: ${JSON.stringify(text)}\n\n`);
  };
  child.stdout.on('data', (d) => emit(d.toString()));
  child.stderr.on('data', (d) => emit(d.toString()));
  child.on('close', (code) => {
    job.done = true;
    job.exitCode = code;
    if (activeJobId === id) activeJobId = null;
    for (const res of job.subscribers) {
      res.write(`event: done\ndata: ${code}\n\n`);
      res.end();
    }
  });
  child.on('error', (err) => emit(`[control-panel] 프로세스 실행 오류: ${err.message}\n`));
  return job;
}

function streamJob(req, res, id) {
  const job = jobs.get(id);
  if (!job) { res.writeHead(404); res.end('job not found'); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const line of job.buffer) res.write(`data: ${JSON.stringify(line)}\n\n`);
  if (job.done) {
    res.write(`event: done\ndata: ${job.exitCode}\n\n`);
    res.end();
    return;
  }
  job.subscribers.add(res);
  req.on('close', () => job.subscribers.delete(res));
}

// ---- HTTP 서버 ----
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const PAGE = require('./lib/control_panel_page');

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}`);

  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    const env = parseEnvFile(ENV_PATH);
    sendJson(res, 200, {
      redashConfigured: !!env.REDASH_API_KEY,
      redashKeyMasked: maskKey(env.REDASH_API_KEY),
      claudeAuth: getClaudeAuthStatus(),
      claudeBinExists: fs.existsSync(CLAUDE_BIN),
      dashboards: listDashboards(),
      running: !!activeJobId,
      activeJobId,
      nextRange: computeDefaultRange(new Date()),
    });
    return;
  }

  if (url.pathname === '/api/env' && req.method === 'POST') {
    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'invalid json' }); }
    if (!parsed.apiKey || typeof parsed.apiKey !== 'string') return sendJson(res, 400, { error: 'apiKey required' });
    upsertEnvVar(ENV_PATH, 'REDASH_API_KEY', parsed.apiKey.trim());
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/claude-login' && req.method === 'POST') {
    if (activeJobId) return sendJson(res, 409, { error: '다른 작업이 실행 중입니다.' });
    const id = `login-${Date.now()}`;
    startJob(id, CLAUDE_BIN, ['auth', 'login']);
    sendJson(res, 200, { jobId: id });
    return;
  }

  if (url.pathname === '/api/run-pipeline' && req.method === 'POST') {
    if (activeJobId) return sendJson(res, 409, { error: '다른 작업이 실행 중입니다.' });
    const body = await readBody(req);
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch { /* ignore */ }
    const id = `pipeline-${Date.now()}`;
    const args = [path.join(ROOT, 'scripts', 'run_weekly_pipeline.js')];
    if (parsed.asOf) { args.push('--asOf', parsed.asOf); }
    startJob(id, NODE_BIN, args);
    sendJson(res, 200, { jobId: id });
    return;
  }

  if (url.pathname === '/api/cancel' && req.method === 'POST') {
    if (!activeJobId) return sendJson(res, 400, { error: '실행 중인 작업이 없습니다.' });
    const job = jobs.get(activeJobId);
    job.child.kill();
    sendJson(res, 200, { ok: true });
    return;
  }

  const streamMatch = url.pathname.match(/^\/api\/stream\/(.+)$/);
  if (streamMatch && req.method === 'GET') {
    streamJob(req, res, decodeURIComponent(streamMatch[1]));
    return;
  }

  const dataMatch = url.pathname.match(/^\/data\/([A-Za-z0-9_.-]+)$/);
  if (dataMatch && req.method === 'GET') {
    const filePath = path.join(DATA_DIR, dataMatch[1]);
    if (!filePath.startsWith(DATA_DIR) || !fs.existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = { '.html': 'text/html; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end('not found');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = args.port ? parseInt(args.port, 10) : 4173;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error('[control-panel] 오류:', err);
      sendJson(res, 500, { error: err.message });
    });
  });

  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}`;
    console.log(`[control-panel] ${url} 에서 실행 중 (로컬 전용, 외부에서 접근 불가)`);
    try {
      execFileSync('open', [url]);
    } catch {
      console.log('[control-panel] 브라우저에서 위 주소를 직접 열어주세요.');
    }
  });
}

main();
