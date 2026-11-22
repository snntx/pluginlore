// Generic recursive walker for php-parser ASTs.
// Calls visitor(node, parent) for every node that has a `.kind`.
// Return `false` from the visitor to skip descending into that node.

export function walk(node, visitor, parent = null) {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) walk(item, visitor, parent);
    return;
  }

  if (typeof node.kind === 'string') {
    const descend = visitor(node, parent);
    if (descend === false) return;
  }

  for (const key of Object.keys(node)) {
    // Skip metadata / back-references that would cause loops or noise.
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    const value = node[key];
    if (value && typeof value === 'object') walk(value, visitor, node);
  }
}

// Resolve the textual name of a call target (function or static method).
export function callName(node) {
  if (!node || node.kind !== 'call') return null;
  const what = node.what;
  if (!what) return null;
  if (what.kind === 'name') return what.name;
  if (what.kind === 'staticlookup') {
    const cls = nameOf(what.what);
    const method = what.offset && what.offset.name;
    return cls && method ? `${cls}::${method}` : method || null;
  }
  if (what.kind === 'propertylookup') {
    // $obj->method() — we only know the method name, not the class.
    return what.offset && what.offset.name ? `->${what.offset.name}` : null;
  }
  return null;
}

export function nameOf(node) {
  if (!node) return null;
  if (typeof node === 'string') return node;
  if (node.kind === 'name') return node.name;
  if (node.kind === 'identifier') return node.name;
  if (typeof node.name === 'string') return node.name;
  return null;
}

// Extract a literal string value from a node, or null if not a plain string.
export function literalString(node) {
  if (!node) return null;
  if (node.kind === 'string') return node.value;
  if (node.kind === 'encapsed') {
    // "foo{$bar}" — build a best-effort template with placeholders.
    return node.value.map((p) => (p.kind === 'string' ? p.value : '${…}')).join('');
  }
  return null;
}

export function lineOf(node) {
  return (node && node.loc && node.loc.start && node.loc.start.line) || 0;
}
