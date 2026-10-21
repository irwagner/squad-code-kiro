#!/usr/bin/env node
// One-shot build of index.html from src/ (no Python/Pillow, no dev server).
// Mirrors the build step in scripts/dev.mjs and build.py (index.html only; does NOT regenerate src/avatars.js).
//   node scripts/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const read = file => readFileSync(path.join(SRC, file), 'utf8');

const scripts = ['portraits.js', 'avatars.js', 'conventions.js', 'souls.js', 'vendor/three.min.js', 'city.js', 'app.js'].map(read).join('\n');
const html = read('shell.html')
  .replace('<!--STYLE-->', () => '<style>\n' + read('styles.css') + '\n</style>')
  .replace('<!--SCRIPTS-->', () => '<script>\n' + scripts + '\n</script>');
writeFileSync(path.join(ROOT, 'index.html'), html, 'utf8');
console.log(`index.html gerado (${Math.round(Buffer.byteLength(html) / 1024)} KB)`);
