// Parse JavaScript and extract calls that reach the server, so we can link a
// front-end script to the PHP endpoint it talks to:
//   - fetch(url, { method, body })
//   - new XMLHttpRequest().open(method, url)
//   - jQuery:  $.ajax({url,method,data}), $.post(url,data), $.get(url), jQuery.ajax(...)
//   - wp.apiFetch({ path, method })  /  apiFetch({ path })
//
// Returns { calls, parseError } where each call is:
//   { kind, url, method, action, path, line, endpoint: 'ajax'|'rest'|'unknown' }
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export function analyzeJs(code) {
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
  } catch (e1) {
    try { ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', locations: true, allowReturnOutsideFunction: true }); }
    catch (e2) { return { calls: [], domRefs: [], formActions: [], parseError: String(e2.message || e2) }; }
  }

  const calls = [];
  const domRefs = [];        // { selector, ids:[], classes:[], via, line }
  const formActions = [];    // action strings discovered in FormData/params/data
  const line = (n) => (n.loc ? n.loc.start.line : 0);
  const addDom = (sel, via, ln) => { if (!sel) return; const t = parseSelector(sel); domRefs.push({ selector: sel, ids: t.ids, classes: t.classes, via, line: ln }); };

  walk.simple(ast, {
    CallExpression(node) {
      const callee = node.callee;
      const args = node.arguments || [];

      // fetch(url, opts)
      if (callee.type === 'Identifier' && callee.name === 'fetch') {
        const url = staticStr(args[0]);
        const { method, action } = readOpts(args[1]);
        calls.push(mk('fetch', url, method, action, line(node)));
        return;
      }

      // DOM finds: document.getElementById/querySelector/All/getElementsByClassName
      if (callee.type === 'MemberExpression' && callee.property) {
        const p = callee.property.name;
        if (p === 'getElementById') { const id = staticStr(args[0]); if (id) addDom('#' + id, 'getElementById', line(node)); }
        else if (p === 'getElementsByClassName') { const cl = staticStr(args[0]); if (cl) addDom('.' + cl, 'getElementsByClassName', line(node)); }
        else if (p === 'querySelector' || p === 'querySelectorAll') addDom(staticStr(args[0]), p, line(node));
        else if (p === 'find' || p === 'closest' || p === 'children' || p === 'siblings' || p === 'parents') addDom(staticStr(args[0]), 'jquery.' + p, line(node));
        // FormData/URLSearchParams .append('action', X) / .set('action', X)
        else if ((p === 'append' || p === 'set') && staticStr(args[0]) === 'action') { const v = staticStr(args[1]); if (v) formActions.push(v); }
      }

      // jQuery root selector:  $('#id') / jQuery('.cls')
      if (callee.type === 'Identifier' && (callee.name === '$' || callee.name === 'jQuery')) {
        const sel = staticStr(args[0]);
        if (sel && /^[#.\[]/.test(sel)) addDom(sel, 'jquery', line(node));
      }

      // member calls: $.ajax / $.post / $.get / jQuery.ajax / wp.apiFetch / apiFetch / xhr.open
      if (callee.type === 'MemberExpression' && callee.property) {
        const prop = callee.property.name;
        const obj = callee.object;
        const objName = obj && (obj.name || (obj.property && obj.property.name));

        // jQuery ajax family
        if ((objName === '$' || objName === 'jQuery') && ['ajax', 'post', 'get', 'getJSON'].includes(prop)) {
          if (prop === 'ajax') {
            const o = objArg(args[0]);
            calls.push(mk('jquery', o.url, o.method || 'POST', o.action, line(node)));
          } else {
            // $.post(url, data) - the 2nd argument IS the data object
            const url = staticStr(args[0]);
            const action = dataAction(args[1]) || readOpts(args[1]).action;
            calls.push(mk('jquery', url, prop === 'get' || prop === 'getJSON' ? 'GET' : 'POST', action, line(node)));
          }
          return;
        }

        // wp.apiFetch({ path, method }) or apiFetch(...)
        if (prop === 'apiFetch' || (callee.object && callee.object.name === 'wp' && prop === 'apiFetch')) {
          const o = objArg(args[0]);
          calls.push(mk('apiFetch', o.path || o.url, o.method || 'GET', null, line(node)));
          return;
        }

        // XMLHttpRequest .open(method, url) - the URL is often dynamic
        // (window.x.ajaxUrl); a literal HTTP method is what tells it apart from window.open().
        if (prop === 'open' && args.length >= 2) {
          const method = staticStr(args[0]);
          if (method && HTTP_METHODS.has(method.toUpperCase())) {
            calls.push(mk('xhr', staticStr(args[1]), method, null, line(node)));
          }
          return;
        }
      }

      // bare apiFetch(...)
      if (callee.type === 'Identifier' && callee.name === 'apiFetch') {
        const o = objArg(args[0]);
        calls.push(mk('apiFetch', o.path || o.url, o.method || 'GET', null, line(node)));
      }
    },
    // new URLSearchParams({ action: 'x' }) / new FormData-like objects
    NewExpression(node) {
      const c = node.callee && node.callee.name;
      if (c === 'URLSearchParams' || c === 'FormData') {
        const a = dataAction(node.arguments && node.arguments[0]);
        if (a) formActions.push(a);
      }
    },
    // obj.action = 'something'  (common when building ajax data)
    AssignmentExpression(node) {
      if (node.left && node.left.type === 'MemberExpression' && node.left.property
        && node.left.property.name === 'action') {
        const v = staticStr(node.right); if (v) formActions.push(v);
      }
    },
  });

  // AJAX fallback: a call we couldn't classify, but the script clearly posts an
  // `action` (FormData/params) - link it to that action anyway.
  if (formActions.length) {
    for (const c of calls) {
      if (c.endpoint === 'unknown' && (c.kind === 'fetch' || c.kind === 'jquery' || c.kind === 'xhr')) {
        c.action = formActions[0]; c.endpoint = 'ajax'; c.fallback = true;
      }
    }
  }

  return { calls, domRefs, formActions, parseError: null };
}

// Parse a CSS/jQuery selector into id + class tokens.
export function parseSelector(sel) {
  const ids = [], classes = [];
  const s = String(sel || '');
  let m;
  const idRe = /#([\w-]+)/g; while ((m = idRe.exec(s))) ids.push(m[1]);
  const clRe = /\.([\w-]+)/g; while ((m = clRe.exec(s))) classes.push(m[1]);
  return { ids, classes };
}

function mk(kind, url, method, action, line) {
  const c = { kind, url: url || null, method: (method || 'GET').toUpperCase(), action: action || null, line, endpoint: 'unknown', path: null };
  classify(c);
  return c;
}

function classify(c) {
  const u = c.url || '';
  if (c.action || /admin-ajax\.php/.test(u) || /\bajaxurl\b/.test(u)) {
    c.endpoint = 'ajax';
    if (!c.action) { const m = u.match(/[?&]action=([^&]+)/); if (m) c.action = decodeURIComponent(m[1]); }
    return;
  }
  // REST: wp-json path or apiFetch path
  let path = null;
  if (c.kind === 'apiFetch' && u) path = u;
  const wp = u.match(/wp-json\/(.+)$/);
  if (wp) path = wp[1];
  if (!path && c.kind === 'apiFetch') path = u;
  if (path) {
    c.endpoint = 'rest';
    c.path = normalizeRoute(path);
  }
}

export function normalizeRoute(p) {
  return String(p || '').replace(/^https?:\/\/[^/]+/, '').replace(/^\/?wp-json\//, '').replace(/^\/+/, '').replace(/\?.*$/, '').replace(/\/+$/, '');
}

// ---- static value extraction ----
function staticStr(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    return node.quasis.map((q, i) => q.value.cooked + (i < node.expressions.length ? '${…}' : '')).join('');
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = staticStr(node.left), r = staticStr(node.right);
    if (l != null || r != null) return (l || '${…}') + (r || '${…}');
  }
  if (node.type === 'Identifier') return node.name === 'ajaxurl' ? 'ajaxurl' : null;
  return null;
}

// Read an options object literal for { url, method, type, path, data:{action} }
function objArg(node) {
  const out = { url: null, method: null, path: null, action: null };
  if (!node || node.type !== 'ObjectExpression') { out.url = staticStr(node); return out; }
  for (const p of node.properties) {
    if (p.type !== 'Property' || !p.key) continue;
    const k = p.key.name || p.key.value;
    if (k === 'url') out.url = staticStr(p.value);
    else if (k === 'method' || k === 'type') out.method = staticStr(p.value);
    else if (k === 'path') out.path = staticStr(p.value);
    else if (k === 'data') out.action = dataAction(p.value);
  }
  return out;
}
function readOpts(node) {
  if (!node || node.type !== 'ObjectExpression') return { method: null, action: null };
  let method = null, action = null;
  for (const p of node.properties) {
    if (p.type !== 'Property' || !p.key) continue;
    const k = p.key.name || p.key.value;
    if (k === 'method' || k === 'type') method = staticStr(p.value);
    if (k === 'body' || k === 'data') action = dataAction(p.value);
  }
  return { method, action };
}
// Find an `action` field inside a data object / URLSearchParams / FormData-ish literal.
function dataAction(node) {
  if (!node) return null;
  if (node.type === 'ObjectExpression') {
    for (const p of node.properties) {
      if (p.type === 'Property' && (p.key.name === 'action' || p.key.value === 'action')) return staticStr(p.value);
    }
  }
  const s = staticStr(node);
  if (s) { const m = s.match(/action=([^&]+)/); if (m) return m[1]; }
  return null;
}
