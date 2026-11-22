// Zip a sample folder exactly like a real plugin download (the folder name is
// the archive root). Shared by web/build.js and the test suite so tests see
// precisely what the browser sees.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

export const SAMPLES_DIR = dirname(fileURLToPath(import.meta.url));

export function packSample(dir) {
  const root = join(SAMPLES_DIR, dir);
  const entries = {};
  (function walk(d) {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else entries[`${dir}/${relative(root, p).split('\\').join('/')}`] = readFileSync(p);
    }
  })(root);
  return zipSync(entries, { level: 9 });
}

export function sampleDirs() {
  return readdirSync(SAMPLES_DIR).filter((n) => statSync(join(SAMPLES_DIR, n)).isDirectory());
}
