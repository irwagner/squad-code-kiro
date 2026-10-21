// Validate every .kiro/agents/*.json preset with `kiro-cli agent validate`.
// Cross-platform (resolves kiro-cli[.exe] on PATH or via SQUAD_KIRO_BIN). Exit 0 if all valid.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(__dirname, '..', '.kiro', 'agents');
const BIN = process.env.SQUAD_KIRO_BIN || 'kiro-cli';

function listPresets() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json')).map(f => path.join(AGENTS_DIR, f));
}

function validate(file) {
  const r = spawnSync(BIN, ['agent', 'validate', '--path', file], { encoding: 'utf8' });
  if (r.error) return { ok: false, msg: r.error.code === 'ENOENT' ? 'kiro-cli não encontrado (defina SQUAD_KIRO_BIN)' : r.error.message };
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  return { ok: r.status === 0, msg: out };
}

const files = listPresets();
if (!files.length) { console.log('Nenhum preset em .kiro/agents/.'); process.exit(0); }

let failed = 0;
for (const f of files) {
  const { ok, msg } = validate(f);
  const name = path.basename(f);
  if (ok) console.log(`OK   ${name}`);
  else { failed++; console.error(`FAIL ${name}${msg ? ': ' + msg : ''}`); }
}
console.log(`\n${files.length - failed}/${files.length} agentes válidos.`);
process.exit(failed ? 1 : 0);
