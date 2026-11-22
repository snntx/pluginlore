// Multi-package ("whole site") support: detect each plugin/theme in an archive
// and find declarations that would collide when they are active together.

// Detect plugin / theme headers. Returns [{ dir, name, version, kind, file }].
export function detectPackages(files) {
  const out = [];
  const seen = new Set();
  for (const f of files) {
    const segs = f.path.split('/');
    if (segs.length > 2) continue; // headers live in the package root
    const dir = segs.length === 2 ? segs[0] : '';
    const head = (f.content || '').slice(0, 8000);
    let m;
    if (/\.php$/i.test(f.path) && (m = head.match(/^[ \t\/*#@]*Plugin Name:\s*(.+)$/im))) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      out.push({ dir, name: m[1].trim(), version: headerValue(head, 'Version'), kind: 'plugin', file: f.path });
    } else if (/(^|\/)style\.css$/i.test(f.path) && (m = head.match(/Theme Name:\s*(.+)$/im))) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      out.push({ dir, name: m[1].trim(), version: headerValue(head, 'Version'), kind: 'theme', file: f.path });
    }
  }
  return out;
}

function headerValue(head, key) {
  const m = head.match(new RegExp('^[ \\t\\/*#@]*' + key + ':\\s*(.+)$', 'im'));
  return m ? m[1].trim() : null;
}

// Which package a file belongs to (by its top-level directory).
export function packageOf(path, packages) {
  if (packages.length < 2) return packages[0] ? packages[0].dir : '';
  const top = path.split('/')[0];
  return packages.some((p) => p.dir === top) ? top : '(other)';
}

// Find duplicate global function / class declarations. Declarations wrapped in
// `if (!function_exists(...))` (or class_exists) are "guarded" and safe.
export function findConflicts(nodes) {
  const byName = new Map(); // kind:qualifiedLower -> [{file,line,package,guarded,name}]
  for (const n of nodes) {
    if (n.type !== 'php') continue;
    for (const f of n.functions) {
      if (!f.global) continue;
      add(byName, 'function:' + f.qualified.toLowerCase(), { kind: 'function', name: f.qualified, file: n.id, line: f.line, package: n.package, guarded: f.guarded });
    }
    for (const c of n.classes) {
      if (!c.qualified || c.name === '(anon)') continue;
      add(byName, 'class:' + c.qualified.toLowerCase(), { kind: c.kind, name: c.qualified, file: n.id, line: c.line, package: n.package, guarded: c.guarded });
    }
  }
  const conflicts = [];
  for (const [, locs] of byName) {
    const files = new Set(locs.map((l) => l.file));
    if (files.size < 2) continue;
    const unguarded = locs.filter((l) => !l.guarded);
    const packages = new Set(locs.map((l) => l.package));
    const crossPackage = packages.size > 1;
    const severity = unguarded.length >= 2 ? 'high' : 'low';
    const label = locs[0].name + (locs[0].kind === 'function' ? '()' : '');
    conflicts.push({
      kind: locs[0].kind,
      name: locs[0].name,
      locations: locs,
      crossPackage,
      severity,
      message: unguarded.length >= 2
        ? `${locs[0].kind} ${label} is declared in ${files.size} files${crossPackage ? ' across different packages' : ''}. If both load, PHP stops with a fatal "Cannot redeclare" error.`
        : `${locs[0].kind} ${label} is declared in ${files.size} files, but guarded by *_exists() so only one is used.`,
    });
  }
  conflicts.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
  return conflicts;
}

function add(map, key, val) { if (!map.has(key)) map.set(key, []); map.get(key).push(val); }
