// Runtime trace overlay. The "Pluginlore Trace" companion plugin records, per
// real request on a local test site, which plugin/theme files PHP loaded. Here
// we match those paths to graph nodes so the static "could flow here" picture
// can be checked against "did load here".

export function parseTrace(text) {
  let data;
  try { data = typeof text === 'string' ? JSON.parse(text) : text; }
  catch { throw new Error('Not valid JSON.'); }
  if (!data || data.tool !== 'pluginlore-trace' || !Array.isArray(data.requests)) {
    throw new Error('This is not a Pluginlore Trace export.');
  }
  return data;
}

export function matchTrace(model, trace) {
  // Node ids are relative to the uploaded archive's root; trace paths are
  // relative to wp-content/plugins (or the themes root). Match by path suffix,
  // preferring the longest id that fits.
  const ids = model.nodes.map((n) => n.id).sort((a, b) => b.length - a.length);
  const cache = new Map();
  const resolve = (p) => {
    if (cache.has(p)) return cache.get(p);
    const norm = String(p).replace(/\\/g, '/').replace(/^\/+/, '');
    const hit = ids.find((id) => norm === id || norm.endsWith('/' + id)) || null;
    cache.set(p, hit);
    return hit;
  };

  const observed = {};      // nodeId -> number of requests that loaded it
  const byRequest = new Map(); // "kind target" -> { kind, target, count, files:Set }
  const entryHits = {};     // "type|name" -> count
  let unmatched = 0, matchedRequests = 0;

  const eps = [];
  for (const n of model.nodes) for (const ep of n.entryPoints) eps.push(ep);

  for (const r of trace.requests) {
    const files = new Set();
    for (const p of r.files || []) {
      const id = resolve(p);
      if (id) files.add(id); else unmatched++;
    }
    if (!files.size) continue;
    matchedRequests++;
    for (const id of files) observed[id] = (observed[id] || 0) + 1;

    const key = `${r.kind} ${r.target || ''}`;
    if (!byRequest.has(key)) byRequest.set(key, { kind: r.kind, target: r.target || '', count: 0, files: new Set() });
    const agg = byRequest.get(key);
    agg.count++;
    for (const id of files) agg.files.add(id);

    // Which statically-detected entry point did this request hit?
    for (const ep of eps) {
      const hit =
        (r.kind === 'ajax' && ep.type === 'ajax' && ep.name.replace(/^wp_ajax_(nopriv_)?/, '') === r.target && (ep.name.includes('nopriv') ? !r.logged_in : !!r.logged_in)) ||
        (r.kind === 'admin-post' && ep.type === 'admin-post' && ep.name.replace(/^admin_post_(nopriv_)?/, '') === r.target) ||
        (r.kind === 'rest' && ep.type === 'rest' && routeMatches(ep.name, r.target));
      if (hit) { const k = `${ep.type}|${ep.name}`; entryHits[k] = (entryHits[k] || 0) + 1; }
    }
  }

  const requests = [...byRequest.values()]
    .map((x) => ({ ...x, files: [...x.files] }))
    .sort((a, b) => b.count - a.count);

  const phpNodes = model.nodes.filter((n) => n.type === 'php');
  return {
    observed,
    entryHits,
    requests,
    totalRequests: trace.requests.length,
    matchedRequests,
    unmatchedFiles: unmatched,
    coverage: phpNodes.length ? Object.keys(observed).filter((id) => phpNodes.some((n) => n.id === id)).length / phpNodes.length : 0,
    neverLoaded: phpNodes.filter((n) => !observed[n.id]).map((n) => n.id),
  };
}

function routeMatches(registered, hit) {
  const clean = (s) => String(s || '').replace(/^\/+|\/+$/g, '');
  const reg = clean(registered), got = clean(hit);
  if (reg === got) return true;
  // Turn WP route regex like (?P<id>\d+) into a wildcard segment; escape the rest.
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = '^' + reg.split(/\(\?P<[^>]+>[^)]*\)/).map(escapeRe).join('[^/]+') + '$';
  try { return new RegExp(pattern).test(got); } catch { return false; }
}
