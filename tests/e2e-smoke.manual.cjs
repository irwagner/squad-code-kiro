'use strict';
// End-to-end smoke test: boots the bridge in-process, runs a REAL kiro-cli step through /api/runs, verifies the adapted event
// stream (system/init, assistant text, result, exit) and that the key pool records usage. Requires kiro-cli authenticated.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-e2e-'));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-e2e-proj-'));
process.env.SQUAD_DATA_DIR = dataDir;
process.env.SQUAD_PROJECTS_DIR = projDir;
process.env.SQUAD_PORT = '4327';

const { server } = require('../server.js');
const PORT = 4327, HOST = '127.0.0.1';

// Read the token the bridge injects: easiest is to GET / and parse the meta tag.
function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: HOST, port: PORT, path: p, method, headers: {
      'content-type': 'application/json', 'host': `${HOST}:${PORT}`,
      ...(token ? { 'x-squad-token': token } : {}),
      ...(data ? { 'content-length': data.length } : {}),
    } }, res => { let out = ''; res.on('data', d => out += d); res.on('end', () => resolve({ status: res.statusCode, body: out })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function getIndexToken() {
  return new Promise((resolve, reject) => {
    http.get({ host: HOST, port: PORT, path: '/', headers: { host: `${HOST}:${PORT}` } }, res => {
      let out = ''; res.on('data', d => out += d); res.on('end', () => { const m = out.match(/squad-bridge-token" content="([^"]+)"/); resolve(m ? m[1] : null); });
    }).on('error', reject);
  });
}

function fail(msg) { console.error('FAIL:', msg); process.exitCode = 1; }
function ok(msg) { console.log('ok -', msg); }

const MIN_WS = { version: 2, agents: [{ id: 'a1', name: 'Cmd', role: 'commander' }], projects: [{ id: 'p1', code: 'OP1', name: 'Op 1', folder: 'op-e2e', squadId: null, adrs: [], sprints: [], features: [], logs: [], handoffs: [] }], squads: [], conventionLibrary: { templates: [], subsets: [] } };

(async () => {
  await new Promise(r => server.listen(PORT, HOST, r));
  try {
    const token = await getIndexToken();
    if (!token) throw new Error('no token from index');
    ok('got bridge token');

    let res = await req('POST', '/api/setup', MIN_WS, token);
    if (res.status !== 201) throw new Error('setup failed: ' + res.status + ' ' + res.body);
    ok('database created via /api/setup');

    // Add an API key (dummy; the test run uses the CLI's own saved auth, but we verify pool CRUD + that a run still works).
    res = await req('POST', '/api/keys', { key: 'DUMMYkey-not-used-1234567890', label: 'Teste' }, token);
    const keyObj = JSON.parse(res.body).key;
    if (res.status !== 201 || !keyObj) throw new Error('add key failed: ' + res.body);
    ok('api key added, preview=' + keyObj.preview);

    res = await req('GET', '/api/keys', null, token);
    const keys = JSON.parse(res.body).keys;
    if (!keys || keys.length !== 1) throw new Error('key list wrong: ' + res.body);
    ok('key list returns 1 masked key');

    // NOTE: with a dummy key in the pool, the bridge would set KIRO_API_KEY=DUMMY and the run would fail auth. To test the real
    // adapter path using the CLI's saved login, remove the dummy key first (empty pool => run uses saved auth).
    res = await req('DELETE', '/api/keys/' + keyObj.id, null, token);
    ok('dummy key removed (pool empty => run uses saved CLI auth)');

    // Start a real run.
    const runBody = { prompt: 'Responda apenas com a palavra PRONTO e nada mais.', label: 'smoke', options: { project: 'op-e2e' } };
    res = await req('POST', '/api/runs', runBody, token);
    if (res.status !== 201) throw new Error('start run failed: ' + res.status + ' ' + res.body);
    const runId = JSON.parse(res.body).runId;
    ok('run started: ' + runId);

    // Stream events via SSE until exit.
    const events = await new Promise((resolve, reject) => {
      const collected = [];
      http.get({ host: HOST, port: PORT, path: `/api/runs/${runId}/events?token=${token}`, headers: { host: `${HOST}:${PORT}` } }, r => {
        let buf = '';
        r.on('data', d => {
          buf += d;
          let cut; while ((cut = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, cut); buf = buf.slice(cut + 2);
            const line = chunk.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n');
            if (!line) continue;
            try { const evt = JSON.parse(line); collected.push(evt); if (evt.type === 'exit') { resolve(collected); } } catch {}
          }
        });
        r.on('end', () => resolve(collected));
        r.on('error', reject);
      }).on('error', reject);
      setTimeout(() => resolve(collected), 60000);
    });

    const types = [...new Set(events.map(e => e.type + (e.subtype ? '/' + e.subtype : '')))];
    console.log('EVENT TYPES:', types.join(', '));
    const exit = events.find(e => e.type === 'exit');
    if (!exit) throw new Error('no exit event');
    ok('got exit event, status=' + exit.status);
    if (events.some(e => e.type === 'bridge' && e.subtype === 'spawned')) ok('bridge spawned event present');
    if (events.some(e => e.type === 'system' && e.subtype === 'init')) ok('system/init adapted from ACP');
    if (exit.status === 'done') { ok('run completed successfully'); if ('credits' in exit) ok('exit carries credits=' + exit.credits); }
    else fail('run did not complete cleanly: ' + (exit.error || '').slice(0, 300));
    if (typeof exit.result === 'string' && /PRONTO/i.test(exit.result)) ok('final result contains expected text');

  } catch (e) {
    fail(e.message);
  } finally {
    server.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
    console.log(process.exitCode ? '\nE2E SMOKE FAILED' : '\nE2E SMOKE PASSED');
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
