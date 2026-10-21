'use strict';
// Deterministic FTS5 run-memory test (no API cost): insert + finish a run, then search its text.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-search-test-'));
const store = db.openStore(dir);
function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); }

const run = { id: 'r1', status: 'running', label: 'etapa de teste', meta: { kind: 'step', projectId: 'p1', agentId: 'a1', featureId: 'f1' }, project: 'op-x', cwd: '/x', startedAt: new Date().toISOString(), args: ['chat'] };
store.insertRun(run);
run.status = 'done'; run.endedAt = new Date().toISOString();
store.finishRun(run, { type: 'exit', status: 'done', result: 'A entrega menciona a palavra XYZZYMELON e detalhes do backend.', credits: 0.05, costUsd: null, durationMs: 1000, sessionId: 'S1' });

const hits = store.searchRuns('XYZZYMELON');
assert(hits.length === 1 && hits[0].id === 'r1', 'encontra o run pela palavra do resultado, got ' + JSON.stringify(hits));
assert(hits[0] && hits[0].agentId === 'a1' && hits[0].featureId === 'f1', 'retorna metadados (agentId/featureId)');
assert(hits[0] && /XYZZYMELON/.test(hits[0].snippet || ''), 'snippet contém o termo, got ' + (hits[0] && hits[0].snippet));

const byLabel = store.searchRuns('etapa');
assert(byLabel.length === 1, 'busca também no label');

const none = store.searchRuns('PALAVRAINEXISTENTE987');
assert(none.length === 0, 'termo ausente não retorna nada');

// re-finish (upsert) must not duplicate
store.finishRun(run, { type: 'exit', status: 'done', result: 'XYZZYMELON de novo', credits: 0.05, costUsd: null, durationMs: 1, sessionId: 'S1' });
assert(store.searchRuns('XYZZYMELON').length === 1, 're-indexar o mesmo run não duplica');

store.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(process.exitCode ? '\nSEARCH TEST FAILED' : '\nALL SEARCH TESTS PASSED');
