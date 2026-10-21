'use strict';
// Live concurrency proof: boots the bridge in-process and fires TWO real kiro-cli runs at once,
// confirming the bridge executes them concurrently (activeRuns reaches 2) and both complete.
// Requires kiro-cli authenticated. Consumes a small amount of credits.
const os = require('node:os'), fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-lc-'));
const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-lc-proj-'));
process.env.SQUAD_DATA_DIR = dataDir; process.env.SQUAD_PROJECTS_DIR = projDir; process.env.SQUAD_PORT = '4328';
const { server } = require('../server.js');
const PORT = 4328, HOST = '127.0.0.1';
function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = http.request({ host: HOST, port: PORT, path: p, method, headers: {
      'content-type': 'application/json', 'host': `${HOST}:${PORT}`,
      ...(token ? { 'x-squad-token': token } : {}), ...(data ? { 'content-length': data.length } : {}),
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
const MIN_WS = { version: 2, agents: [{ id: 'a1', name: 'Cmd', role: 'commander' }], projects: [{ id: 'p1', code: 'OP1', name: 'Op 1', folder: 'op-lc', squadId: null, adrs: [], sprints: [], features: [], logs: [], handoffs: [] }], squads: [], conventionLibrary: { templates: [], subsets: [] } };
(async () => {
  await new Promise(r => server.listen(PORT, HOST, r));
  let maxActive = 0;
  try {
    const token = await getIndexToken();
    if (!token) throw new Error('no token');
    let res = await req('POST', '/api/setup', MIN_WS, token);
    if (res.status !== 201) throw new Error('setup failed: ' + res.status + ' ' + res.body);
    console.log('ok - bridge up, db created');
    res = await req('POST', '/api/config', { concurrency: 2 }, token);
    console.log('ok - concurrency set:', res.body);
    const t0 = Date.now();
    const body = n => ({ prompt: `Responda apenas com a palavra PRONTO${n} e nada mais.`, label: 'conc' + n, options: { project: 'op-lc' } });
    const [r1, r2] = await Promise.all([req('POST', '/api/runs', body(1), token), req('POST', '/api/runs', body(2), token)]);
    if (r1.status !== 201 || r2.status !== 201) throw new Error('start failed: ' + r1.status + '/' + r2.status + ' ' + r1.body + ' ' + r2.body);
    const id1 = JSON.parse(r1.body).runId, id2 = JSON.parse(r2.body).runId;
    console.log('ok - 2 runs POSTed together:', id1.slice(0, 8), id2.slice(0, 8));
    for (let i = 0; i < 160; i++) {
      const h = await req('GET', '/api/health', null, token);
      const a = Number(JSON.parse(h.body).activeRuns || 0);
      maxActive = Math.max(maxActive, a);
      if (a === 0 && i > 3) break;
      await new Promise(r => setTimeout(r, 400));
    }
    const g1 = JSON.parse((await req('GET', '/api/runs/' + id1, null, token)).body);
    const g2 = JSON.parse((await req('GET', '/api/runs/' + id2, null, token)).body);
    const s1 = g1.run && g1.run.status, s2 = g2.run && g2.run.status;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`maxActiveRuns=${maxActive} statuses=${s1}/${s2} elapsed=${elapsed}s`);
    if (maxActive >= 2) console.log('ok - LIVE CONCURRENCY CONFIRMED: 2 real kiro-cli runs active at the same time');
    else { console.error('FAIL: never observed 2 active at once (maxActive=' + maxActive + ')'); process.exitCode = 1; }
    if (s1 === 'done' && s2 === 'done') console.log('ok - both runs completed cleanly');
    else { console.error('FAIL: run statuses ' + s1 + '/' + s2); process.exitCode = 1; }
  } catch (e) { console.error('FAIL:', e.message); process.exitCode = 1; }
  finally {
    server.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
    console.log(process.exitCode ? '\nLIVE CONC FAILED' : '\nLIVE CONC PASSED');
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
