import Parser from 'php-parser';
import { analyzeJs, normalizeRoute } from './js-analyze.js';
import { walk, callName, nameOf, literalString, lineOf } from './walk.js';
import { PHP_DEPRECATED, PHP_DEPRECATED_CONSTANTS, cmpVersion } from './php-deprecated.js';
import {
  TAINT_SOURCES, SINKS, WP_METHOD_SINKS, NONCE_FUNCS, SANITIZERS,
} from './vuln-rules.js';
import { bodyFacts, verdict } from './access.js';
import { detectPackages, packageOf, findConflicts } from './site.js';
import { emptyWp, collectWpCall, scanTables, functionFacts, summarizeFunction, fileRole, summarizeFile, paramFacts } from './wp.js';

const SANITIZER_SET = SANITIZERS;

const engine = new Parser.Engine({
  parser: { extractDoc: false, suppressErrors: true, php7: true },
  ast: { withPositions: true },
  lexer: { short_tags: true },
});

import { EDGE_STYLE } from './styles.js';
export { EDGE_STYLE };

const REACH_RANK = {
  'unauth-entry': 5, 'rest': 4, 'auth-entry': 3, 'entry': 2, 'internal': 1, 'orphan': 0, 'asset': 1,
};

// Calls that are expensive when repeated inside a loop (N+1 patterns).
const PERF_LOOP_CALLS = {
  get_posts: 'Post query', get_pages: 'Post query', get_users: 'User query', get_terms: 'Term query',
  get_comments: 'Comment query', wp_get_post_terms: 'Term query', get_the_terms: 'Term query',
  wp_remote_get: 'HTTP request', wp_remote_post: 'HTTP request', wp_remote_request: 'HTTP request',
  wp_safe_remote_get: 'HTTP request', wp_safe_remote_post: 'HTTP request', curl_exec: 'HTTP request',
  file_get_contents: 'File/HTTP read',
};
const PERF_LOOP_WPDB = new Set(['get_results', 'get_var', 'get_row', 'get_col', 'query']);
const PERF_QUERY_CLASSES = new Set(['WP_Query', 'WP_User_Query', 'WP_Term_Query', 'WP_Comment_Query']);
const UNBOUNDED_KEYS = new Set(['posts_per_page', 'numberposts', 'number']);
const EXISTS_GUARDS = new Set(['function_exists', 'class_exists', 'interface_exists', 'trait_exists', 'defined']);

function fileType(path) {
  if (/\.(php|phtml|inc)$/i.test(path)) return 'php';
  if (/\.(js|mjs|cjs|jsx|ts)$/i.test(path)) return 'js';
  if (/\.css$/i.test(path)) return 'css';
  if (/\.html?$/i.test(path)) return 'html';
  if (/\.json$/i.test(path)) return 'json';
  return 'other';
}

// Small, fast content hash (FNV-1a) - used by version diff to spot changed files.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

function newFileRecord(path, content) {
  return {
    id: path,
    path,
    label: path.split('/').pop(),
    type: fileType(path),
    dir: path.includes('/') ? path.replace(/\/[^/]*$/, '') : '',
    package: '',
    hash: hash(content || ''),
    loc: content ? content.split('\n').length : 0,
    bytes: content ? content.length : 0,
    parseError: null,
    classes: [],      // { name, qualified, extends, implements:[], traits:[], methods:[], kind, guarded, line }
    functions: [],    // { name, qualified, global, guarded, line }
    includes: [],     // { suffix, raw, line, dynamic }
    calls: [],        // { name, line }
    entryPoints: [],  // { type, name, callback, line, auth, permission? }
    access: [],       // access-control audit rows for handlers registered in this file
    wp: emptyWp(),    // WordPress registrations made in this file (Learn tab)
    fns: [],          // per-function facts + plain-English summary (Learn tab)
    role: null,       // { key, label } what kind of file this is
    summary: '',      // one-paragraph description of the file
    enqueues: [],     // { suffix, handle, kind:'script'|'style', line }  (PHP)
    jsCalls: [],      // { kind, url, method, action, path, endpoint, line } (JS)
    domRefs: [],      // { selector, ids, classes, via, line }  (JS)
    domProvides: null,// 'id:x' / 'class:y' tokens the file's markup renders (PHP/HTML)
    guarded: false,   // has ABSPATH/WPINC guard
    readsSuperglobalTopLevel: false,
    verifiesNonce: false,
    issues: [],       // { kind:'deprecated'|'vuln'|'access'|'perf'|'conflict', severity, message, line, symbol, cwe? }
    outputs: [],      // { type, line }
    reachability: 'internal',
    directAccess: false,
    deadend: false,
  };
}

// Pull the trailing static path portion out of an include argument so we can
// match it against known files even when the path is built dynamically.
function extractIncludeSuffix(arg) {
  const lit = literalString(arg);
  if (lit != null) return { suffix: cleanSuffix(lit), dynamic: /\$\{…\}/.test(lit), raw: lit };
  if (arg && arg.kind === 'bin' && arg.type === '.') {
    const right = literalString(arg.right);
    if (right != null) return { suffix: cleanSuffix(right), dynamic: true, raw: '… . ' + right };
  }
  return { suffix: null, dynamic: true, raw: null };
}

// Asset src for enqueues: handles string/concat and URL-builder calls like
// plugins_url('js/app.js', __FILE__) / plugin_dir_url(__FILE__) . 'js/app.js'.
function extractAssetSuffix(arg) {
  if (!arg) return null;
  const direct = extractIncludeSuffix(arg);
  if (direct.suffix) return direct.suffix;
  if (arg.kind === 'call') {
    const fn = arg.what && arg.what.name;
    if (fn === 'plugins_url' || fn === 'plugin_dir_url' || fn === 'get_stylesheet_directory_uri' || fn === 'get_template_directory_uri') {
      const s = literalString((arg.arguments || [])[0]);
      if (s) return cleanSuffix(s);
    }
  }
  return null;
}

function cleanSuffix(s) {
  let out = s.replace(/\\/g, '/');
  const ph = out.lastIndexOf('${…}');
  if (ph !== -1) out = out.slice(ph + 4);
  // '../assets/x.js' or '/./inc/x.php': match on the part after any relative hops
  const up = out.lastIndexOf('../');
  if (up !== -1) out = out.slice(up + 3);
  out = out.replace(/(^|\/)\.\//g, '$1');
  return out.replace(/^\/+/, '');
}

export function analyze(files, options = {}) {
  const phpTarget = options.phpTarget || null; // deprecations only when explicitly requested (CLI --php)
  const vulnScan = options.vulnScan !== false;

  const nodes = new Map();        // id -> record
  const symbolTable = new Map();  // className(lower) -> fileId
  const funcTable = new Map();    // funcName(lower) -> fileId
  const classDecls = new Map();   // className(lower) -> {record, cls}
  const locals = new Map();       // fileId -> { fnNodes, closureCbs }  (AST refs, never exported)

  const packages = detectPackages(files);
  const siteMode = packages.length >= 2;

  // Binary files that merely carry a code extension are never parsed or drawn.
  const text = files.filter((f) => !f.binary);
  const phpFiles = text.filter((f) => /\.(php|phtml|inc)$/i.test(f.path));
  const jsFiles = text.filter((f) => /\.(js|mjs|cjs|jsx)$/i.test(f.path) && !/\.min\.js$/i.test(f.path));
  const assetFiles = text.filter((f) => /\.(css|html?)$/i.test(f.path) || /\.min\.js$/i.test(f.path));

  // Progress reporting (the web worker forwards these to the loading screen).
  const progress = options.onProgress || (() => {});
  const parseTotal = phpFiles.length + jsFiles.length;
  let parsed = 0;

  // ---------- Pass 1: parse + collect per-file facts ----------
  for (const f of phpFiles) {
    progress({ phase: 'parse', i: ++parsed, n: parseTotal, file: f.path });
    const rec = newFileRecord(f.path, f.content);
    rec.package = packageOf(f.path, packages);
    nodes.set(rec.id, rec);
    let ast;
    try {
      ast = engine.parseCode(f.content, f.path);
    } catch (e) {
      rec.parseError = String((e && e.message) || e);
      continue;
    }
    const local = { fnNodes: [], closureCbs: new Map() };
    locals.set(rec.id, local);
    visit(ast, { depth: 0, taint: new Set(), loop: 0, ns: '', cls: null, cond: false }, rec, { phpTarget, vulnScan, local });
    rec.domProvides = scanDomProvides(f.content);
    scanTables(rec, f.content);
    for (const c of rec.classes) {
      symbolTable.set(c.name.toLowerCase(), rec.id);
      classDecls.set(c.name.toLowerCase(), { record: rec, cls: c });
    }
    for (const fn of rec.functions) funcTable.set(fn.name.toLowerCase(), rec.id);
  }

  for (const f of jsFiles) {
    progress({ phase: 'parse', i: ++parsed, n: parseTotal, file: f.path });
    const rec = newFileRecord(f.path, f.content);
    rec.package = packageOf(f.path, packages);
    rec.reachability = 'asset';
    const { calls, domRefs, parseError } = analyzeJs(f.content);
    rec.jsCalls = calls;
    rec.domRefs = domRefs;
    rec.parseError = parseError;
    nodes.set(rec.id, rec);
  }
  for (const f of assetFiles) {
    const rec = newFileRecord(f.path, f.content);
    rec.package = packageOf(f.path, packages);
    rec.reachability = 'asset';
    if (/\.html?$/i.test(f.path)) rec.domProvides = scanDomProvides(f.content);
    nodes.set(rec.id, rec);
  }

  // ---------- Access-control audit (needs every file's function bodies) ----------
  progress({ phase: 'audit' });
  const fnIndex = new Map(); // name(lower) -> [{ fileId, node }]
  for (const [fileId, local] of locals) {
    for (const fn of local.fnNodes) {
      if (!fnIndex.has(fn.key)) fnIndex.set(fn.key, []);
      fnIndex.get(fn.key).push({ fileId, node: fn.node });
    }
  }
  const resolveIn = (fromId) => (name) => {
    if (!name) return null;
    const key = String(name).replace(/^->/, '').split('::').pop().toLowerCase();
    const hits = fnIndex.get(key);
    if (!hits) return null;
    return (hits.find((h) => h.fileId === fromId) || hits[0]).node;
  };
  const locate = (fromId, name) => {
    const key = String(name || '').replace(/^->/, '').split('::').pop().toLowerCase();
    const hits = fnIndex.get(key);
    if (!hits) return null;
    return hits.find((h) => h.fileId === fromId) || hits[0];
  };

  const accessRows = [];
  for (const rec of nodes.values()) {
    const local = locals.get(rec.id);
    for (const ep of rec.entryPoints) {
      if (ep.type !== 'ajax' && ep.type !== 'admin-post' && ep.type !== 'rest') continue;
      let node = null, handlerFile = null;
      if (local && local.closureCbs.has(ep)) { node = local.closureCbs.get(ep); handlerFile = rec.id; }
      else if (ep.callback) {
        const hit = locate(rec.id, ep.callback);
        if (hit) { node = hit.node; handlerFile = hit.fileId; }
      }
      const facts = node ? bodyFacts(node, resolveIn(handlerFile)) : { cap: false, login: false, nonce: false, writes: new Set(), helpers: [] };
      const row = {
        file: rec.id, line: ep.line, type: ep.type, name: ep.name, auth: ep.auth,
        callback: ep.callback, permission: ep.permission || null,
        resolved: !!node, handlerFile,
        cap: facts.cap, login: facts.login, nonce: facts.nonce,
        writes: [...facts.writes], helpers: facts.helpers,
      };
      Object.assign(row, verdict(row));
      row._rec = rec;
      accessRows.push(row);
    }
  }
  // A handler registered for BOTH logged-out (nopriv) and logged-in users is
  // public by design: judge the logged-in copy like its public sibling instead
  // of demanding a capability check, and report the issue once.
  const actionKey = (r) => `${r.type}:${r.name.replace(/^(wp_ajax_|admin_post_)(nopriv_)?/, '')}`;
  const publicSibling = new Map();
  for (const r of accessRows) if (r.type !== 'rest' && r.auth === 'unauth') publicSibling.set(actionKey(r), r);
  for (const r of accessRows) {
    const sib = r.type !== 'rest' && r.auth === 'auth' ? publicSibling.get(actionKey(r)) : null;
    if (sib && sib.callback === r.callback) {
      r.severity = sib.severity; r.cwe = sib.cwe; r.sharedWith = sib.name;
      r.message = `Same handler is also open to logged-out users (${sib.name}). ${sib.message}`;
    }
    const rec = r._rec; delete r._rec;
    rec.access.push(r);
    if (vulnScan && !r.sharedWith && ['high', 'medium', 'low'].includes(r.severity)) {
      rec.issues.push({
        kind: 'access', severity: r.severity, cwe: r.cwe,
        message: `${r.name}: ${r.message}`, line: r.line, symbol: r.callback || r.name,
        confidence: 'medium',
      });
    }
  }

  // ---------- Pass 2: build edges ----------
  progress({ phase: 'link' });
  const edges = [];
  const edgeKey = new Set();
  const addEdge = (source, target, type, extra = {}) => {
    if (!source || !target || source === target) return;
    const k = `${source}|${target}|${type}`;
    if (edgeKey.has(k)) return;
    edgeKey.add(k);
    edges.push({ source, target, type, ...EDGE_STYLE[type], ...extra });
  };

  const allPaths = [...nodes.keys()];
  const includedBy = new Map();

  const ajaxIndex = new Map();
  const restIndex = new Map();
  for (const rec of nodes.values()) {
    for (const ep of rec.entryPoints) {
      if (ep.type === 'ajax') push(ajaxIndex, ep.name.replace(/^wp_ajax_(nopriv_)?/, ''), rec.id);
      else if (ep.type === 'admin-post') push(ajaxIndex, ep.name.replace(/^admin_post_(nopriv_)?/, ''), rec.id);
      else if (ep.type === 'rest') push(restIndex, normalizeRoute(ep.name), rec.id);
    }
  }

  for (const rec of nodes.values()) {
    for (const inc of rec.includes) {
      if (!inc.suffix) continue;
      const target = resolveInclude(rec, inc.suffix, allPaths);
      if (target) {
        addEdge(rec.id, target, 'include', { resolved: true, dynamic: inc.dynamic, line: inc.line });
        if (!includedBy.has(target)) includedBy.set(target, []);
        includedBy.get(target).push(rec.id);
      }
    }
    for (const c of rec.classes) {
      if (c.extends) {
        const t = symbolTable.get(c.extends.toLowerCase());
        const overrides = t ? findOverrides(c, classDecls.get(c.extends.toLowerCase())) : [];
        addEdge(rec.id, t, 'extends', { overrides, child: c.name, parent: c.extends });
      }
      for (const i of c.implements) addEdge(rec.id, symbolTable.get(i.toLowerCase()), 'implements', { child: c.name, iface: i });
      for (const tr of c.traits) addEdge(rec.id, symbolTable.get(tr.toLowerCase()), 'use-trait', { child: c.name, trait: tr });
    }
    const seenCall = new Set();
    for (const call of rec.calls) {
      if (!call.name || call.name.startsWith('->') || call.name.includes('::')) continue;
      const t = funcTable.get(call.name.toLowerCase());
      if (t && t !== rec.id && !seenCall.has(t)) { seenCall.add(t); addEdge(rec.id, t, 'call', { fn: call.name }); }
    }
    for (const ep of rec.entryPoints) {
      if (ep.callback && ep.callback !== '(closure)') {
        const hit = locate(rec.id, ep.callback);
        const t = (hit && hit.fileId) || funcTable.get(ep.callback.toLowerCase()) || symbolTable.get(ep.callback.toLowerCase());
        if (t) addEdge(rec.id, t, 'hook', { hook: ep.name, callback: ep.callback });
      }
    }
    for (const eq of rec.enqueues) {
      if (!eq.suffix) continue;
      const target = resolveInclude(rec, eq.suffix, allPaths);
      if (target) addEdge(rec.id, target, 'enqueue', { handle: eq.handle, assetKind: eq.kind, line: eq.line });
    }
    for (const jc of rec.jsCalls) {
      if (jc.endpoint === 'ajax' && jc.action) {
        for (const t of (ajaxIndex.get(jc.action) || [])) addEdge(rec.id, t, 'ajax', { action: jc.action, method: jc.method, line: jc.line, fallback: jc.fallback });
      } else if (jc.endpoint === 'rest' && jc.path) {
        for (const t of matchRoute(restIndex, jc.path)) addEdge(rec.id, t, 'rest-call', { route: jc.path, method: jc.method, line: jc.line });
      }
    }
    if (rec.domRefs.length) {
      const seen = new Set();
      for (const dref of rec.domRefs) {
        const tokens = [...dref.ids.map((x) => 'id:' + x), ...dref.classes.map((x) => 'class:' + x)];
        for (const tok of tokens) {
          for (const other of nodes.values()) {
            if (other.id === rec.id || !other.domProvides || !other.domProvides.has(tok)) continue;
            const k = rec.id + '|' + other.id;
            if (seen.has(k)) continue; seen.add(k);
            addEdge(rec.id, other.id, 'dom', { token: tok.replace('id:', '#').replace('class:', '.') });
          }
        }
      }
    }
  }

  // ---------- Pass 3: reachability + deadends ----------
  const hasOutgoing = new Set(edges.map((e) => e.source));
  for (const rec of nodes.values()) {
    if (rec.type !== 'php') { rec.reachability = 'asset'; continue; }
    rec.reachability = classifyReachability(rec, includedBy.get(rec.id));
    rec.directAccess = !rec.guarded && rec.readsSuperglobalTopLevel;
    if (rec.directAccess && REACH_RANK[rec.reachability] < REACH_RANK['unauth-entry']) rec.reachability = 'unauth-entry';
    rec.deadend = !hasOutgoing.has(rec.id) && rec.outputs.length === 0;
  }

  // ---------- Conflicts (duplicate declarations) ----------
  const nodeList = [...nodes.values()];
  const conflicts = findConflicts(nodeList);
  for (const c of conflicts) {
    if (c.severity !== 'high') continue;
    for (const loc of c.locations) {
      const rec = nodes.get(loc.file);
      if (rec) rec.issues.push({ kind: 'conflict', severity: 'high', message: c.message, line: loc.line, symbol: c.name });
    }
  }

  // ---------- Learn: what every function and file does ----------
  describeEverything(nodes, locals, edges, includedBy, packages);

  // Sets don't survive JSON; export DOM tokens as arrays.
  for (const rec of nodeList) if (rec.domProvides) rec.domProvides = [...rec.domProvides];

  const single = !siteMode && packages[0];
  for (const p of packages) p.fileCount = nodeList.filter((n) => n.package === p.dir).length;

  return {
    meta: {
      tool: 'pluginlore',
      version: '0.2.0',
      scannedAt: new Date().toISOString(),
      phpTarget,
      vulnScan,
      packageType: siteMode ? 'wordpress-site' : detectPackageType(files),
      packageName: single ? single.name : null,
      packageVersion: single ? single.version : null,
      packages,
      fileCount: phpFiles.length,
      jsCount: jsFiles.length,
      assetCount: assetFiles.length,
      totalFiles: files.length,
      parseErrors: nodeList.filter((n) => n.parseError).length,
    },
    nodes: nodeList,
    edges,
    access: accessRows,
    conflicts,
    stats: buildStats(nodeList, edges, accessRows, conflicts),
  };
}

// ---------- fact collection for one file ----------
// Manual recursive descent with an explicit context:
//   depth  0 == top level (outside any function/method/closure)
//   taint  local variables holding attacker-controlled data (per function)
//   loop   how many loops we're inside (for N+1 performance hints)
//   ns     current namespace;  cls  current class;  cond  inside an *_exists() guard
function visit(node, ctx, rec, opts) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const item of node) visit(item, ctx, rec, opts); return; }
  if (typeof node.kind !== 'string') {
    for (const k of Object.keys(node)) {
      if (k === 'loc') continue;
      const v = node[k];
      if (v && typeof v === 'object') visit(v, ctx, rec, opts);
    }
    return;
  }

  const { phpTarget, vulnScan, local } = opts;
  let child = ctx;
  const fresh = () => ({ ...ctx, depth: ctx.depth + 1, taint: new Set(), loop: 0 });

  switch (node.kind) {
    case 'namespace':
      child = { ...ctx, ns: typeof node.name === 'string' ? node.name : nameOf(node.name) || '' };
      break;

    case 'if':
      if (containsExistsGuard(node.test)) child = { ...ctx, cond: true };
      break;

    case 'function': {
      const name = nameOf(node.name) || '(anon)';
      rec.functions.push({
        name, qualified: ctx.ns ? `${ctx.ns}\\${name}` : name,
        global: true, guarded: ctx.cond, line: lineOf(node),
      });
      local.fnNodes.push({ key: name.toLowerCase(), node });
      child = fresh();
      break;
    }
    case 'method': {
      const name = nameOf(node.name);
      if (name) local.fnNodes.push({ key: name.toLowerCase(), node, cls: ctx.cls });
      child = fresh();
      break;
    }
    case 'closure':
    case 'arrowfunc':
      child = fresh();
      break;

    case 'for': case 'foreach': case 'while': case 'do':
      child = { ...ctx, loop: ctx.loop + 1 };
      break;

    case 'assign': {
      if (node.left && node.left.kind === 'variable' && typeof node.left.name === 'string') {
        const name = node.left.name;
        if (taintState(node.right, ctx.taint).tainted) ctx.taint.add(name);
        else if (node.operator === '=') ctx.taint.delete(name);
      }
      break;
    }

    case 'class': case 'interface': case 'trait': {
      const name = nameOf(node.name) || '(anon)';
      const c = {
        name,
        qualified: ctx.ns ? `${ctx.ns}\\${name}` : name,
        extends: node.extends ? nameOf(node.extends) : null,
        implements: (node.implements || []).map(nameOf).filter(Boolean),
        traits: [], methods: [], kind: node.kind, guarded: ctx.cond, line: lineOf(node),
      };
      for (const b of node.body || []) {
        if (b.kind === 'method') c.methods.push(nameOf(b.name));
        if (b.kind === 'traituse') for (const t of (b.traits || [])) { const n = nameOf(t); if (n) c.traits.push(n); }
      }
      rec.classes.push(c);
      child = { ...ctx, cls: name };
      break;
    }

    case 'variable': {
      const vn = '$' + (typeof node.name === 'string' ? node.name : '');
      if (TAINT_SOURCES.has(vn) && ctx.depth === 0) rec.readsSuperglobalTopLevel = true;
      break;
    }

    case 'include':
      rec.includes.push({ ...extractIncludeSuffix(node.target), line: lineOf(node) });
      break;

    case 'echo': case 'print':
      rec.outputs.push({ type: node.kind, line: lineOf(node) });
      if (ctx.depth === 0) rec.topLevelOutput = true;
      if (vulnScan) flagOutputXss(rec, node, ctx.taint);
      break;
    case 'inline':
      if (ctx.depth === 0 && String(node.value || '').trim()) rec.topLevelOutput = true; // raw HTML outside <?php
      break;
    case 'return':
      if (ctx.depth > 0) rec.outputs.push({ type: 'return', line: lineOf(node) });
      break;

    case 'call': {
      const name = callName(node);
      if (name) {
        rec.calls.push({ name, line: lineOf(node) });
        handleKnownCall(rec, node, name, opts, ctx);
        if (ctx.loop > 0) flagLoopCall(rec, node, name);
      }
      break;
    }

    case 'new': {
      const cls = nameOf(node.what);
      if (ctx.loop > 0 && cls && PERF_QUERY_CLASSES.has(cls.replace(/^\\/, ''))) {
        rec.issues.push({ kind: 'perf', severity: 'medium', message: `new ${cls} inside a loop: one database query per iteration (N+1). Query once before the loop.`, line: lineOf(node), symbol: cls });
      }
      break;
    }

    case 'entry': {
      const key = literalString(node.key);
      if (key && UNBOUNDED_KEYS.has(key) && isMinusOne(node.value)) {
        rec.issues.push({ kind: 'perf', severity: 'low', message: `Unbounded query ('${key}' => -1) loads every matching row. Paginate or set a limit.`, line: lineOf(node), symbol: key });
      }
      break;
    }

    case 'name': {
      const n = nameOf(node);
      if (n === 'ABSPATH' || n === 'WPINC') rec.guarded = true;
      const d = PHP_DEPRECATED_CONSTANTS[n];
      if (phpTarget && d && d.deprecated && cmpVersion(phpTarget, d.deprecated) >= 0) rec.issues.push(depIssue(n, d, lineOf(node), 'constant'));
      break;
    }
  }

  for (const k of Object.keys(node)) {
    if (k === 'loc') continue;
    const v = node[k];
    if (v && typeof v === 'object') visit(v, child, rec, opts);
  }
}

function containsExistsGuard(test) {
  let found = false;
  walk(test, (n) => { if (n.kind === 'call' && EXISTS_GUARDS.has(callName(n))) found = true; });
  return found;
}

function isMinusOne(v) {
  if (!v) return false;
  if (v.kind === 'number') return String(v.value) === '-1';
  if (v.kind === 'unary' && v.type === '-' && v.what && v.what.kind === 'number') return String(v.what.value) === '1';
  return false;
}

function flagLoopCall(rec, node, name) {
  if (PERF_LOOP_CALLS[name]) {
    rec.issues.push({ kind: 'perf', severity: name.includes('remote') || name === 'curl_exec' ? 'high' : 'medium', message: `${PERF_LOOP_CALLS[name]} inside a loop: ${name}() runs once per iteration. Batch it or move it out of the loop.`, line: lineOf(node), symbol: name });
    return;
  }
  if (name.startsWith('->') && PERF_LOOP_WPDB.has(name.slice(2))) {
    const target = node.what && node.what.what;
    if (target && target.kind === 'variable' && target.name === 'wpdb') {
      rec.issues.push({ kind: 'perf', severity: 'medium', message: `Database query inside a loop: $wpdb->${name.slice(2)}() runs once per iteration (N+1). Fetch everything in one query.`, line: lineOf(node), symbol: '$wpdb' + name });
    }
  }
}

function depIssue(symbol, d, line, kind) {
  const parts = [`${symbol}${kind === 'constant' ? '' : '()'} is deprecated as of PHP ${d.deprecated}`];
  if (d.removed) parts.push(`removed in ${d.removed}`);
  if (d.replacement) parts.push(`use ${d.replacement}`);
  return { kind: 'deprecated', severity: d.removed ? 'high' : 'medium', message: parts.join('; '), line, symbol };
}

function handleKnownCall(rec, node, name, opts, ctx) {
  const { phpTarget, vulnScan } = opts;
  const d = PHP_DEPRECATED[name];
  if (phpTarget && d && d.deprecated && cmpVersion(phpTarget, d.deprecated) >= 0) rec.issues.push(depIssue(name, d, lineOf(node), 'function'));

  if (NONCE_FUNCS.has(name)) rec.verifiesNonce = true;

  if (name === 'wp_enqueue_script' || name === 'wp_register_script' || name === 'wp_enqueue_style' || name === 'wp_register_style') {
    const a = node.arguments || [];
    const suffix = extractAssetSuffix(a[1]);
    if (suffix) rec.enqueues.push({ suffix, handle: literalString(a[0]) || '', kind: name.includes('style') ? 'style' : 'script', line: lineOf(node) });
  }

  detectEntryPoint(rec, node, name, opts.local);
  collectWpCall(rec, node, name);

  if (!vulnScan) return;

  const sink = SINKS[name];
  if (sink) {
    const tainted = argIsTainted(node.arguments || [], sink.arg, ctx.taint);
    if (tainted) {
      rec.issues.push({
        kind: 'vuln', severity: sinkSeverity(sink), cwe: sink.cwe,
        message: `${sink.kind}: untrusted input reaches ${name}(). ${sink.note}`,
        line: lineOf(node), symbol: name, confidence: tainted.confidence,
      });
    }
  }

  if (name.startsWith('->')) {
    const m = name.slice(2);
    if (WP_METHOD_SINKS[m]) {
      const args = node.arguments || [];
      if (argIsTainted(args, 'any', ctx.taint) && !usesPrepare(args)) {
        const s = WP_METHOD_SINKS[m];
        rec.issues.push({
          kind: 'vuln', severity: 'high', cwe: s.cwe,
          message: `${s.kind}: query built from input without prepare(). ${s.note}`,
          line: lineOf(node), symbol: `$wpdb->${m}`, confidence: 'medium',
        });
      }
    }
  }
}

function sinkSeverity(sink) {
  if (/eval|Command|inclusion|object injection/i.test(sink.kind)) return 'critical';
  if (/SQL|write|delete|SSRF/i.test(sink.kind)) return 'high';
  return 'medium';
}

function argIsTainted(args, argIndex, taint) {
  const toCheck = argIndex === 'any' ? args : (args[argIndex] != null ? [args[argIndex]] : []);
  for (const a of toCheck) {
    const r = taintState(a, taint);
    if (r.tainted) return { confidence: r.sanitized ? 'low' : 'medium' };
  }
  return null;
}

function taintState(node, taint) {
  let tainted = false, sanitized = false;
  walk(node, (n) => {
    if (n.kind === 'variable') {
      const bare = typeof n.name === 'string' ? n.name : '';
      if (TAINT_SOURCES.has('$' + bare)) tainted = true;
      if (taint && taint.has(bare)) tainted = true;
    }
    if (n.kind === 'call') {
      const nm = callName(n);
      if (nm && (nm === 'filter_input' || nm === 'filter_var')) tainted = true;
      if (nm && SANITIZER_SET.has(nm)) sanitized = true;
    }
  });
  return { tainted, sanitized };
}

function usesPrepare(args) {
  let prep = false;
  for (const a of args) walk(a, (n) => {
    if (n.kind === 'call') { const nm = callName(n); if (nm === 'prepare' || nm === '->prepare') prep = true; }
  });
  return prep;
}

function flagOutputXss(rec, node, taint) {
  const exprs = node.expressions || (node.expression ? [node.expression] : []);
  for (const e of exprs) {
    const r = taintState(e, taint);
    if (r.tainted && !r.sanitized) {
      rec.issues.push({
        kind: 'vuln', severity: 'medium', cwe: 'CWE-79',
        message: 'Reflected XSS: untrusted input echoed without escaping. Use esc_html()/htmlspecialchars().',
        line: lineOf(node), symbol: node.kind, confidence: 'low',
      });
    }
  }
}

// ---------- entry point detection ----------
const isFn = (n) => n && (n.kind === 'closure' || n.kind === 'arrowfunc');

function detectEntryPoint(rec, node, name, local) {
  const args = node.arguments || [];
  const first = literalString(args[0]);

  if (name === 'add_action' || name === 'add_filter') {
    if (!first) return;
    let type, auth;
    if (first.startsWith('wp_ajax_nopriv_')) { type = 'ajax'; auth = 'unauth'; }
    else if (first.startsWith('wp_ajax_')) { type = 'ajax'; auth = 'auth'; }
    else if (first.startsWith('admin_post_nopriv_')) { type = 'admin-post'; auth = 'unauth'; }
    else if (first.startsWith('admin_post_')) { type = 'admin-post'; auth = 'auth'; }
    else if (['init', 'template_redirect', 'wp', 'parse_request', 'wp_loaded'].includes(first)) { type = 'front-hook'; auth = 'unauth'; }
    else return;
    const ep = { type, name: first, callback: isFn(args[1]) ? '(closure)' : callbackName(args[1]), line: lineOf(node), auth };
    rec.entryPoints.push(ep);
    if (isFn(args[1]) && local) local.closureCbs.set(ep, args[1]);
  } else if (name === 'register_rest_route') {
    const r = restArgs(args[2]);
    const ep = {
      type: 'rest', name: (literalString(args[0]) || '') + (literalString(args[1]) || ''),
      callback: r.callback.node ? '(closure)' : r.callback.name, line: lineOf(node),
      auth: r.permission === 'set' ? 'auth' : 'unauth',
      permission: r.permission,
    };
    rec.entryPoints.push(ep);
    if (r.callback.node && local) local.closureCbs.set(ep, r.callback.node);
  } else if (name === 'add_shortcode') {
    rec.entryPoints.push({ type: 'shortcode', name: first, callback: isFn(args[1]) ? '(closure)' : callbackName(args[1]), line: lineOf(node), auth: 'unauth' });
  } else if (name === 'register_activation_hook' || name === 'register_deactivation_hook') {
    rec.entryPoints.push({ type: name.replace('register_', '').replace('_hook', ''), name: first || rec.path, callback: callbackName(args[1]), line: lineOf(node), auth: 'auth' });
  }
}

function callbackName(arg) {
  if (!arg) return null;
  const s = literalString(arg);
  if (s) return s;
  if (arg.kind === 'array' && arg.items && arg.items.length === 2) {
    const m = literalString(arg.items[1].value || arg.items[1]);
    if (m) return m;
  }
  return null;
}

// Read register_rest_route()'s args: callback + permission_callback.
// permission: 'none' (missing) | 'open' (always true) | 'set' (some check)
function restArgs(argsNode) {
  const out = { callback: { name: null, node: null }, permission: 'none' };
  if (!argsNode) return out;
  walk(argsNode, (n) => {
    if (n.kind !== 'entry') return;
    const key = nameOf(n.key) || literalString(n.key);
    if (key === 'callback') {
      if (isFn(n.value)) out.callback.node = n.value;
      else out.callback.name = callbackName(n.value);
    } else if (key === 'permission_callback') {
      const s = literalString(n.value);
      if (s === '__return_true') out.permission = 'open';
      else if (isFn(n.value) && returnsOnlyTrue(n.value)) out.permission = 'open';
      else out.permission = 'set';
    }
  });
  return out;
}

function returnsOnlyTrue(fn) {
  if (fn.kind === 'arrowfunc') return isTrue(fn.body);
  const body = (fn.body && fn.body.children) || [];
  return body.length === 1 && body[0].kind === 'return' && isTrue(body[0].expr);
}
const isTrue = (n) => n && n.kind === 'boolean' && n.value === true;

// ---------- include resolution ----------
function resolveInclude(rec, suffix, allPaths) {
  const want = suffix.replace(/^\/+/, '');
  if (!want) return null;
  const candidates = allPaths.filter((p) => p === want || p.endsWith('/' + want));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const aSame = a.startsWith(rec.dir) ? 0 : 1;
    const bSame = b.startsWith(rec.dir) ? 0 : 1;
    if (aSame !== bSame) return aSame - bSame;
    return a.length - b.length;
  });
  return candidates[0];
}

function push(map, key, val) { if (!map.has(key)) map.set(key, []); map.get(key).push(val); }

// DOM id/class tokens a file's markup renders (id="x" / class="a b").
function scanDomProvides(content) {
  const set = new Set();
  if (!content) return set;
  let m;
  const idRe = /\bid\s*=\s*["']([\w-]+)["']/g;
  while ((m = idRe.exec(content))) set.add('id:' + m[1]);
  const clRe = /\bclass\s*=\s*["']([^"']+)["']/g;
  while ((m = clRe.exec(content))) for (const c of m[1].split(/\s+/)) if (/^[\w-]+$/.test(c)) set.add('class:' + c);
  return set;
}

// Match a JS route against registered REST routes (regex segments compared on prefix).
function matchRoute(restIndex, route) {
  if (restIndex.has(route)) return restIndex.get(route);
  const hits = [];
  for (const [reg, ids] of restIndex) {
    const base = reg.split('(')[0].replace(/\/+$/, '');
    if (base && (route === base || route.startsWith(base + '/') || base.startsWith(route))) hits.push(...ids);
  }
  return hits;
}

function findOverrides(childCls, parentEntry) {
  if (!parentEntry) return [];
  const parentMethods = new Set((parentEntry.cls.methods || []).map((m) => (m || '').toLowerCase()));
  return (childCls.methods || []).filter((m) => parentMethods.has((m || '').toLowerCase()));
}

function classifyReachability(rec, includers) {
  let best = 'internal';
  for (const ep of rec.entryPoints) {
    let r;
    if (ep.type === 'rest') r = 'rest';
    else if (ep.auth === 'unauth') r = 'unauth-entry';
    else r = 'auth-entry';
    if (REACH_RANK[r] > REACH_RANK[best]) best = r;
  }
  if (best !== 'internal') return best;
  if (!includers || includers.length === 0) {
    // Only output at the file's top level makes it a runnable script; a class
    // file whose methods merely `return` something is dead code if unreferenced.
    return rec.topLevelOutput || rec.readsSuperglobalTopLevel ? 'entry' : 'orphan';
  }
  return 'internal';
}

function detectPackageType(files) {
  for (const f of files) {
    if (/\.php$/i.test(f.path) && /^(?:[\s\S]{0,4000})Plugin Name:\s*\S/im.test(f.content || '')) return 'wordpress-plugin';
  }
  const style = files.find((f) => /(^|\/)style\.css$/i.test(f.path));
  if (style && /Theme Name:\s*\S/i.test(style.content || '')) return 'wordpress-theme';
  if (files.some((f) => /(^|\/)composer\.json$/i.test(f.path))) return 'composer-package';
  return 'generic-php';
}

function buildStats(nodes, edges, access, conflicts) {
  const byReach = {};
  const byKind = { vuln: 0, access: 0, deprecated: 0, perf: 0, conflict: 0 };
  let deadends = 0, directAccess = 0, parseErrors = 0;
  for (const n of nodes) {
    byReach[n.reachability] = (byReach[n.reachability] || 0) + 1;
    for (const i of n.issues) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
    if (n.deadend) deadends++;
    if (n.directAccess) directAccess++;
    if (n.parseError) parseErrors++;
  }
  const byEdge = {};
  for (const e of edges) byEdge[e.type] = (byEdge[e.type] || 0) + 1;
  const accessBySeverity = {};
  for (const a of access) accessBySeverity[a.severity] = (accessBySeverity[a.severity] || 0) + 1;
  return {
    byReach, byEdge, byKind,
    vuln: byKind.vuln, deprecated: byKind.deprecated, perf: byKind.perf,
    access: access.length, accessBySeverity,
    conflicts: conflicts.length, conflictsHigh: conflicts.filter((c) => c.severity === 'high').length,
    deadends, directAccess, parseErrors, edges: edges.length,
  };
}

// Fill rec.fns / rec.role / rec.summary for the Learn tab.
function describeEverything(nodes, locals, edges, includedBy, packages) {
  const mainFiles = new Set(packages.filter((p) => p.kind === 'plugin').map((p) => p.file));
  // what triggers a function: hooks, shortcodes, admin pages, request handlers, cron
  const triggers = new Map();
  const addTrigger = (cb, t) => {
    if (!cb || cb === '(closure)') return;
    const k = cb.toLowerCase();
    if (!triggers.has(k)) triggers.set(k, []);
    triggers.get(k).push(t);
  };
  const cronHooks = new Set();
  for (const rec of nodes.values()) for (const c of rec.wp.cron) cronHooks.add(c.hook);
  for (const rec of nodes.values()) {
    const w = rec.wp;
    for (const h of w.hooks) {
      if (/^(wp_ajax_|admin_post_)/.test(h.hook)) continue; // described below as request handlers
      addTrigger(h.callback, cronHooks.has(h.hook)
        ? { kind: 'cron', label: `runs as the scheduled job "${h.hook}"`, file: rec.id }
        : { kind: h.kind, label: `runs on the "${h.hook}" ${h.kind}${h.priority !== 10 ? ` (priority ${h.priority})` : ''}`, file: rec.id });
    }
    for (const sc of w.shortcodes) addTrigger(sc.callback, { kind: 'shortcode', label: `draws the [${sc.tag}] shortcode`, file: rec.id });
    for (const m of w.menus) addTrigger(m.callback, { kind: 'admin', label: `draws the admin ${m.kind} "${m.title}"`, file: rec.id });
    for (const mb of w.metaBoxes) addTrigger(mb.callback, { kind: 'admin', label: `draws the "${mb.title || mb.id}" meta box`, file: rec.id });
    for (const ep of rec.entryPoints) {
      if (ep.type === 'ajax') addTrigger(ep.callback, { kind: 'ajax', label: `handles the AJAX action "${ep.name.replace(/^wp_ajax_(nopriv_)?/, '')}" for ${ep.auth === 'unauth' ? 'anyone' : 'logged-in users'}`, file: rec.id });
      else if (ep.type === 'admin-post') addTrigger(ep.callback, { kind: 'ajax', label: `handles the form action "${ep.name.replace(/^admin_post_(nopriv_)?/, '')}"`, file: rec.id });
      else if (ep.type === 'rest') addTrigger(ep.callback, { kind: 'rest', label: `answers the REST route /${ep.name.replace(/^\/+/, '')}`, file: rec.id });
      else if (ep.type === 'activation' || ep.type === 'deactivation') addTrigger(ep.callback, { kind: 'lifecycle', label: `runs when the plugin is ${ep.type === 'activation' ? 'activated' : 'deactivated'}`, file: rec.id });
    }
  }

  // describe every named function / method
  const byName = new Map();
  for (const [fileId, local] of locals) {
    const rec = nodes.get(fileId);
    rec.fns = local.fnNodes.map(({ node, cls }) => {
      const name = nameOf(node.name) || '(anon)';
      const facts = functionFacts(node);
      const fn = {
        name, cls: cls || null, line: lineOf(node),
        endLine: (node.loc && node.loc.end && node.loc.end.line) || lineOf(node),
        does: facts.does, calls: facts.calls, inputs: facts.inputs, request: facts.request,
        summary: node.body ? summarizeFunction(facts) : 'Only declared here (no body): the classes that use it fill in what it does.',
        triggers: triggers.get(name.toLowerCase()) || [],
        params: paramFacts(node, triggers.get(name.toLowerCase()) || []),
        calledBy: [],
      };
      const k = name.toLowerCase();
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push({ fileId, fn });
      return fn;
    });
  }
  for (const [fileId, local] of locals) {
    for (const fn of nodes.get(fileId).fns) {
      for (const c of fn.calls) {
        const k = c.split('::').pop().toLowerCase();
        for (const t of byName.get(k) || []) {
          if (t.fn === fn) continue;
          const who = fn.cls ? `${fn.cls}::${fn.name}` : fn.name;
          if (!t.fn.calledBy.some((x) => x.name === who)) t.fn.calledBy.push({ name: who, file: fileId });
        }
      }
    }
    void local;
  }

  // file roles + summaries
  const enqueuedBy = new Map();
  for (const e of edges) if (e.type === 'enqueue') {
    if (!enqueuedBy.has(e.target)) enqueuedBy.set(e.target, []);
    enqueuedBy.get(e.target).push(e.source.split('/').pop());
  }
  for (const rec of nodes.values()) {
    const isMain = mainFiles.has(rec.id) || (!mainFiles.size && rec.type === 'php' && !rec.dir && rec.wp.hooks.length > 0 && !(includedBy.get(rec.id) || []).length);
    rec.isMain = isMain;
    rec.role = fileRole(rec, isMain);
    rec.summary = summarizeFile(rec, {
      isMain,
      loadedBy: [...new Set((includedBy.get(rec.id) || []).map((x) => x.split('/').pop()))],
      enqueuedBy: [...new Set(enqueuedBy.get(rec.id) || [])],
    });
  }
}
