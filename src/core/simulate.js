// Static "packet tracer" — given the analysis model and a starting file,
// follow flow edges (include / call / hook) to show where a signal could go.
// This is a STATIC over-approximation of possible paths, not a runtime trace.

const FLOW_TYPES = new Set(['include', 'call', 'hook', 'ajax', 'rest-call', 'enqueue']);

export function simulate(model, startId, opts = {}) {
  const disabled = new Set(opts.disabled || []); // excluded node ids
  const maxDepth = opts.maxDepth || 25;
  const maxPaths = opts.maxPaths || 400;
  const flowTypes = opts.flowTypes ? new Set(opts.flowTypes) : FLOW_TYPES;

  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const out = new Map(); // id -> [{ to, type, ...}]
  for (const e of model.edges) {
    if (!flowTypes.has(e.type)) continue;
    if (disabled.has(e.source) || disabled.has(e.target)) continue;
    if (!out.has(e.source)) out.set(e.source, []);
    out.get(e.source).push(e);
  }

  if (disabled.has(startId) || !nodeById.has(startId)) {
    return { start: startId, paths: [], visited: [], endpoints: [], outputs: [], sinks: [], truncated: false };
  }

  const paths = [];
  const visitedGlobal = new Set();
  const endpoints = new Set();
  let truncated = false;

  // DFS collecting simple paths (no repeated node within a path).
  const stack = [{ id: startId, path: [startId], onPath: new Set([startId]) }];
  while (stack.length) {
    const cur = stack.pop();
    visitedGlobal.add(cur.id);
    const edges = out.get(cur.id) || [];
    const nexts = edges.filter((e) => !cur.onPath.has(e.target));

    if (cur.path.length >= maxDepth || nexts.length === 0) {
      paths.push(cur.path.slice());
      if (nexts.length === 0) endpoints.add(cur.id); // true deadend along this path
      if (paths.length >= maxPaths) { truncated = true; break; }
      continue;
    }
    for (const e of nexts) {
      const onPath = new Set(cur.onPath); onPath.add(e.target);
      stack.push({ id: e.target, path: [...cur.path, e.target], onPath, via: e });
    }
  }

  // Collect outputs/sinks encountered across all visited nodes.
  const outputs = [], sinks = [];
  for (const id of visitedGlobal) {
    const n = nodeById.get(id);
    if (!n) continue;
    if (n.outputs.length) outputs.push({ id, count: n.outputs.length, kinds: [...new Set(n.outputs.map((o) => o.type))] });
    for (const i of n.issues) if (i.kind === 'vuln') sinks.push({ id, ...i });
  }

  // BFS levels (hops from start) for wave-by-wave animation.
  const level = new Map([[startId, 0]]);
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    const L = level.get(id);
    for (const e of (out.get(id) || [])) {
      if (!level.has(e.target)) { level.set(e.target, L + 1); queue.push(e.target); }
    }
  }
  const edgesUsed = [...new Set(paths.flatMap((p) => p.slice(1).map((t, i) => `${p[i]}->${t}`)))];
  let maxLevel = 0; for (const v of level.values()) maxLevel = Math.max(maxLevel, v);

  return {
    start: startId,
    paths,
    visited: [...visitedGlobal],
    endpoints: [...endpoints],
    outputs,
    sinks,
    truncated,
    edgesUsed,
    levels: Object.fromEntries(level),
    maxLevel,
  };
}

// Expected inputs for a node, derived from its entry points + superglobal reads.
export function expectedInputs(node) {
  const inputs = [];
  for (const ep of node.entryPoints || []) {
    if (ep.type === 'ajax') {
      inputs.push({ transport: 'POST admin-ajax.php', params: { action: ep.name.replace(/^wp_ajax_(nopriv_)?/, '') }, auth: ep.auth, note: 'May require a valid nonce.' });
    } else if (ep.type === 'admin-post') {
      inputs.push({ transport: 'POST admin-post.php', params: { action: ep.name.replace(/^admin_post_(nopriv_)?/, '') }, auth: ep.auth });
    } else if (ep.type === 'rest') {
      inputs.push({ transport: 'REST', route: ep.name, auth: ep.auth, permission: ep.permission });
    } else if (ep.type === 'shortcode') {
      inputs.push({ transport: 'shortcode', tag: ep.name, auth: 'rendered-content' });
    } else {
      inputs.push({ transport: ep.type, name: ep.name, auth: ep.auth });
    }
  }
  if (node.readsSuperglobalTopLevel && node.directAccess) {
    inputs.push({ transport: 'direct HTTP', note: 'File reads request input at top level with no ABSPATH guard — may be directly reachable.', auth: 'unauth' });
  }
  return inputs;
}
