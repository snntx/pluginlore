import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

// Read a fixture directory into the [{path, content}] shape the analyzer takes.
export function loadFixture(name) {
  const base = join(FIXTURES, name);
  const out = [];
  (function walk(dir) {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (!n.endsWith('.zip')) out.push({ path: relative(base, p).split('\\').join('/'), content: readFileSync(p, 'utf8') });
    }
  })(base);
  return out;
}
