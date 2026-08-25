#!/usr/bin/env node
/**
 * Builds the self-contained Beez x Elite Marcom deck.
 *
 * Reads deck/src/presentation.src.html, replaces every {{asset:<file>}} token
 * with a base64 data URI built from deck/assets/<file>, and writes
 * presentation.html at the repository root.
 *
 *   node deck/build.mjs
 *
 * Every asset is referenced exactly once in the source, so swapping a logo or
 * a photo is a one-line change in deck/assets plus a rebuild.
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRC = join(here, 'src', 'presentation.src.html');
const OUT = join(root, 'presentation.html');
const ASSETS = join(here, 'assets');

const MIME = {
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

let src = readFileSync(SRC, 'utf8');
const used = new Map();

src = src.replace(/\{\{asset:([A-Za-z0-9._-]+)\}\}/g, (_m, name) => {
  const file = join(ASSETS, name);
  if (!existsSync(file)) throw new Error(`missing asset: deck/assets/${name}`);
  const mime = MIME[extname(name)];
  if (!mime) throw new Error(`unknown asset type: ${name}`);
  used.set(name, (used.get(name) || 0) + 1);
  const b64 = readFileSync(file).toString('base64');
  return `data:${mime};base64,${b64}`;
});

const leftover = src.match(/\{\{asset:[^}]*\}\}/);
if (leftover) throw new Error(`unresolved asset token: ${leftover[0]}`);

writeFileSync(OUT, src);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`built presentation.html  ${kb(statSync(OUT).size)}`);
for (const [name, count] of used) {
  const flag = count > 1 ? `  <-- inlined ${count}x` : '';
  console.log(`  ${name.padEnd(26)} ${kb(statSync(join(ASSETS, name)).size).padStart(10)}${flag}`);
}
