'use strict';
// Test the API key pool store methods against a throwaway database.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-keys-test-'));
const store = db.openStore(dir);

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); }

// Empty to start
assert(store.apiKeyCount() === 0, 'starts empty');
assert(store.nextApiKey() === null, 'no key when empty');

// Add keys
const k1 = store.addApiKey('AAAAkey1secret1111', 'Conta 1');
const k2 = store.addApiKey('BBBBkey2secret2222', 'Conta 2');
const k3 = store.addApiKey('CCCCkey3secret3333', 'Conta 3');
assert(store.apiKeyCount() === 3, 'three keys added');
assert(k1.preview === 'AAAA…1111', 'key masked in view, got ' + k1.preview);
assert(!('api_key' in k1) && !('key' in k1), 'raw key not exposed in view');

// next = first active by pos
let n = store.nextApiKey();
assert(n && n.id === k1.id, 'next picks first by pos');

// Exhaust k1 -> next should be k2
store.setApiKeyStatus(k1.id, 'exhausted', 'quota limit reached');
n = store.nextApiKey();
assert(n && n.id === k2.id, 'after exhausting k1, next is k2, got ' + (n && n.id));

// Cooldown k2 in the future -> next should skip to k3
const future = new Date(Date.now() + 60000).toISOString();
store.setApiKeyStatus(k2.id, 'active', 'rate limited', future);
n = store.nextApiKey();
assert(n && n.id === k3.id, 'cooldown skips k2 -> k3, got ' + (n && n.id));

// Mark usage
store.markApiKeyOk(k3.id, 1.2345);
store.markApiKeyFail(k3.id, 'some error');
const view = store.listApiKeys().find(x => x.id === k3.id);
assert(view.runsOk === 1 && view.runsFailed === 1, 'usage counters updated');
assert(view.creditsUsed === 1.2345, 'credits accumulated, got ' + view.creditsUsed);

// Reorder
store.reorderApiKeys([k3.id, k2.id, k1.id]);
const ordered = store.listApiKeys().map(x => x.id);
assert(ordered[0] === k3.id, 'reorder applied, got ' + JSON.stringify(ordered));

// Reactivate k1 (clear exhausted) and ensure it can be picked after reorder (k3 first but failed? still active)
store.setApiKeyStatus(k1.id, 'active', null, null);
// k3 is active (pos 0), so it should be next again
n = store.nextApiKey();
assert(n && n.id === k3.id, 'after reorder next is k3');

// Remove
store.removeApiKey(k2.id);
assert(store.apiKeyCount() === 2, 'removed one key');

// Invalid key rejected
let threw = false;
try { store.addApiKey('short'); } catch { threw = true; }
assert(threw, 'rejects too-short key');

store.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(process.exitCode ? '\nSOME KEY-POOL TESTS FAILED' : '\nALL KEY-POOL TESTS PASSED');
