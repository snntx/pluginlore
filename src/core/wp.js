// WordPress-specific understanding, used by the Learn tab. Everything here is
// deterministic: it reads the code's structure, it does not guess or generate.
//
//   collectWpCall(rec, node, name)  -> records registrations made by a call
//   functionFacts(fnNode)           -> what a function does, as tags
//   summarizeFunction(facts)        -> a plain-English sentence from those tags
//   fileRole(rec)                   -> what kind of file this is

import { walk, callName, literalString, lineOf, nameOf } from './walk.js';

const S = (v) => {
  const s = literalString(v);
  return s == null ? null : s;
};
const num = (v) => (v && v.kind === 'number' ? Number(v.value) : null);

export function emptyWp() {
  return {
    hooks: [],        // { kind: 'action'|'filter', hook, callback, priority, line, inline? }
    fires: [],        // { kind, hook, line }  extension points this file offers
    shortcodes: [],   // { tag, callback, line }
    postTypes: [],    // { name, line }
    taxonomies: [],   // { name, line }
    menus: [],        // { kind, title, slug, capability, callback, line }
    settings: [],     // { group, name, line }
    optionsRead: [],  // names
    optionsWritten: [],
    metaBoxes: [],    // { id, title, callback, line }
    blocks: [],       // { name, line }
    widgets: [],      // { name, line }
    cron: [],         // { hook, recurrence, line }
    tables: [],       // { name, line }
    textDomain: null,
  };
}

const MENU_FUNCS = {
  add_menu_page: 'menu', add_submenu_page: 'submenu', add_options_page: 'settings page',
  add_management_page: 'tools page', add_theme_page: 'appearance page', add_users_page: 'users page',
  add_dashboard_page: 'dashboard page', add_posts_page: 'posts page', add_media_page: 'media page',
  add_pages_page: 'pages page', add_comments_page: 'comments page', add_plugins_page: 'plugins page',
};

const callbackOf = (arg) => {
  if (!arg) return null;
  if (arg.kind === 'closure' || arg.kind === 'arrowfunc') return '(closure)';
  const s = S(arg);
  if (s) return s;
  if (arg.kind === 'array' && arg.items && arg.items.length === 2) {
    const m = S(arg.items[1].value || arg.items[1]);
    if (m) return m;
  }
  return null;
};
const pushUnique = (arr, v) => { if (v && !arr.includes(v)) arr.push(v); };

export function collectWpCall(rec, node, name) {
  const wp = rec.wp;
  const a = node.arguments || [];
  const line = lineOf(node);
  switch (name) {
    case 'add_action': case 'add_filter': {
      const hook = S(a[0]);
      const entry = { kind: name === 'add_action' ? 'action' : 'filter', hook: hook || '(dynamic hook)', callback: callbackOf(a[1]), priority: num(a[2]) ?? 10, line };
      if (a[1] && (a[1].kind === 'closure' || a[1].kind === 'arrowfunc')) {
        const f = functionFacts(a[1]);
        entry.inline = { does: f.does, summary: summarizeFunction(f) };
      }
      wp.hooks.push(entry);
      break;
    }
    case 'do_action': case 'do_action_ref_array': case 'apply_filters': case 'apply_filters_ref_array': {
      const hook = S(a[0]);
      if (hook) wp.fires.push({ kind: name.startsWith('do_') ? 'action' : 'filter', hook, line });
      break;
    }
    case 'add_shortcode': wp.shortcodes.push({ tag: S(a[0]) || '(dynamic)', callback: callbackOf(a[1]), line }); break;
    case 'register_post_type': wp.postTypes.push({ name: S(a[0]) || '(dynamic)', line }); break;
    case 'register_taxonomy': wp.taxonomies.push({ name: S(a[0]) || '(dynamic)', line }); break;
    case 'register_setting': wp.settings.push({ group: S(a[0]), name: S(a[1]) || '(dynamic)', line }); break;
    case 'get_option': case 'get_site_option': pushUnique(wp.optionsRead, S(a[0])); break;
    case 'update_option': case 'add_option': case 'delete_option': case 'update_site_option':
      pushUnique(wp.optionsWritten, S(a[0])); break;
    case 'add_meta_box': wp.metaBoxes.push({ id: S(a[0]), title: S(a[1]), callback: callbackOf(a[2]), line }); break;
    case 'register_block_type': case 'register_block_type_from_metadata': wp.blocks.push({ name: S(a[0]) || '(from block.json)', line }); break;
    case 'register_widget': wp.widgets.push({ name: S(a[0]) || nameOf(a[0] && a[0].what) || '(dynamic)', line }); break;
    case 'wp_schedule_event': wp.cron.push({ hook: S(a[2]) || '(dynamic)', recurrence: S(a[1]), line }); break;
    case 'wp_schedule_single_event': wp.cron.push({ hook: S(a[1]) || '(dynamic)', recurrence: 'once', line }); break;
    case 'load_plugin_textdomain': case 'load_theme_textdomain': wp.textDomain = S(a[0]) || wp.textDomain; break;
    default:
      if (MENU_FUNCS[name]) {
        const sub = name === 'add_submenu_page';
        const o = sub ? 1 : 0; // add_submenu_page has the parent slug first
        wp.menus.push({
          kind: MENU_FUNCS[name], title: S(a[o + 1]) || S(a[o]) || '(dynamic)', slug: S(a[o + 3]),
          capability: S(a[o + 2]), callback: callbackOf(a[o + 4]), parent: sub ? S(a[0]) : null, line,
        });
      }
  }
}

// CREATE TABLE statements anywhere in the file's text (usually inside dbDelta()).
export function scanTables(rec, content) {
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([{}$\w>\-.]+)/gi;
  let m;
  while ((m = re.exec(content))) {
    const name = m[1].replace(/^\{?\$wpdb->prefix\}?\.?/, '{prefix}').replace(/^\$table(_name)?$/, '(a prefixed table)');
    const line = content.slice(0, m.index).split('\n').length;
    if (!rec.wp.tables.some((t) => t.name === name)) rec.wp.tables.push({ name, line });
  }
}

// ---------------------------------------------------------------- functions

const FACT_CALLS = {
  'checks-cap': ['current_user_can', 'user_can', 'is_super_admin'],
  'checks-login': ['is_user_logged_in'],
  'checks-nonce': ['check_ajax_referer', 'wp_verify_nonce', 'check_admin_referer'],
  'sanitizes': ['sanitize_text_field', 'sanitize_email', 'sanitize_key', 'sanitize_title', 'absint', 'intval', 'wp_kses', 'wp_kses_post', 'sanitize_file_name', 'sanitize_textarea_field', 'wp_unslash'],
  'escapes': ['esc_html', 'esc_attr', 'esc_url', 'esc_js', 'esc_textarea', 'esc_html__', 'esc_attr__', 'esc_html_e', 'esc_attr_e'],
  'options-read': ['get_option', 'get_site_option', 'get_transient', 'get_theme_mod'],
  'options-write': ['update_option', 'add_option', 'delete_option', 'set_transient', 'delete_transient', 'set_theme_mod', 'update_site_option'],
  'meta-read': ['get_post_meta', 'get_user_meta', 'get_term_meta', 'get_comment_meta', 'get_field'],
  'meta-write': ['update_post_meta', 'add_post_meta', 'delete_post_meta', 'update_user_meta', 'delete_user_meta', 'update_term_meta', 'update_field'],
  'queries-posts': ['get_posts', 'get_pages', 'get_terms', 'get_users', 'get_comments', 'wp_get_post_terms', 'get_the_terms'],
  'writes-posts': ['wp_insert_post', 'wp_update_post', 'wp_delete_post', 'wp_trash_post', 'wp_insert_user', 'wp_update_user', 'wp_delete_user', 'wp_insert_term', 'wp_set_object_terms'],
  'sends-json': ['wp_send_json', 'wp_send_json_success', 'wp_send_json_error'],
  'redirects': ['wp_redirect', 'wp_safe_redirect'],
  'sends-mail': ['wp_mail'],
  'remote-request': ['wp_remote_get', 'wp_remote_post', 'wp_remote_request', 'wp_safe_remote_get', 'wp_safe_remote_post', 'curl_exec', 'file_get_contents'],
  'enqueues': ['wp_enqueue_script', 'wp_enqueue_style', 'wp_register_script', 'wp_register_style', 'wp_localize_script', 'wp_add_inline_script'],
  'registers-hooks': ['add_action', 'add_filter', 'add_shortcode'],
  'registers-rest': ['register_rest_route'],
  'buffers-output': ['ob_start', 'ob_get_clean', 'ob_get_contents'],
  'registers-content': ['register_post_type', 'register_taxonomy', 'register_block_type', 'register_widget', 'register_setting', 'add_menu_page', 'add_submenu_page', 'add_options_page', 'add_meta_box'],
  'fires-hooks': ['do_action', 'apply_filters', 'do_action_ref_array', 'apply_filters_ref_array'],
  'stops': ['wp_die', 'die', 'exit'],
  'writes-files': ['file_put_contents', 'fwrite', 'move_uploaded_file', 'wp_handle_upload', 'unlink', 'copy', 'rename', 'mkdir'],
  'schedules': ['wp_schedule_event', 'wp_schedule_single_event', 'wp_clear_scheduled_hook', 'wp_unschedule_event'],
  'creates-tables': ['dbDelta'],
  'translates': ['__', '_e', '_x', '_n', 'esc_html__', 'esc_attr__', 'esc_html_e', 'esc_attr_e'],
};
const CALL_TO_FACT = new Map();
for (const [fact, names] of Object.entries(FACT_CALLS)) for (const n of names) {
  if (!CALL_TO_FACT.has(n)) CALL_TO_FACT.set(n, []);
  CALL_TO_FACT.get(n).push(fact);
}
const WPDB_READ = new Set(['get_results', 'get_var', 'get_row', 'get_col']);
const WPDB_WRITE = new Set(['insert', 'update', 'delete', 'replace', 'query']);
const INPUT_VARS = new Set(['_GET', '_POST', '_REQUEST', '_COOKIE', '_FILES', '_SERVER']);
const QUERY_CLASSES = new Set(['WP_Query', 'WP_User_Query', 'WP_Term_Query', 'WP_Comment_Query']);

export function functionFacts(fnNode) {
  const does = new Set();
  const calls = [];
  const inputs = new Set();
  const request = {}; // { POST: ['name', …], GET: [...] }
  walk(fnNode.body || fnNode, (n) => {
    switch (n.kind) {
      case 'variable':
        if (typeof n.name === 'string' && INPUT_VARS.has(n.name)) { does.add('reads-input'); inputs.add('$' + n.name); }
        break;
      case 'offsetlookup': {
        const v = n.what;
        if (v && v.kind === 'variable' && ['_POST', '_GET', '_REQUEST', '_COOKIE'].includes(v.name)) {
          const k = literalString(n.offset);
          const src = v.name.slice(1);
          if (k) { request[src] = request[src] || []; if (!request[src].includes(k)) request[src].push(k); }
        }
        break;
      }
      case 'echo': case 'print': case 'inline': does.add('outputs-html'); break;
      case 'return': {
        let html = false;
        walk(n.expr, (x) => { if ((x.kind === 'string' || x.kind === 'encapsed') && /<[a-z]/i.test(String(x.value && x.value.map ? x.value.map((v) => v.value || '').join('') : x.value))) html = true; });
        if (html) does.add('returns-html');
        break;
      }
      case 'exit': does.add('stops'); break;
      case 'include': does.add('loads-file'); break;
      case 'new': if (QUERY_CLASSES.has(nameOf(n.what))) does.add('queries-posts'); break;
      case 'call': {
        const name = callName(n);
        if (!name) break;
        for (const f of CALL_TO_FACT.get(name) || []) does.add(f);
        if (name.startsWith('->')) {
          const m = name.slice(2);
          const target = n.what && n.what.what;
          if (target && target.kind === 'variable' && target.name === 'wpdb') {
            if (WPDB_READ.has(m)) does.add('db-read');
            if (WPDB_WRITE.has(m)) does.add('db-write');
          }
        }
        calls.push(name.replace(/^->/, ''));
        break;
      }
    }
  });
  // ob_start() ... ob_get_clean(): the HTML is captured and returned, not printed
  if (does.has('buffers-output') && does.has('outputs-html')) { does.delete('outputs-html'); does.add('returns-html'); }
  does.delete('buffers-output');
  return { does: [...does], calls: [...new Set(calls)], inputs: [...inputs], request };
}

// Ordered so the sentence reads like the function runs: guards, input,
// reading, writing, side effects, then the response.
const PHRASES = [
  ['checks-nonce', 'checks the security nonce'],
  ['checks-cap', 'checks the user is allowed (capability)'],
  ['checks-login', 'checks the user is logged in'],
  ['reads-input', 'reads request input'],
  ['sanitizes', 'cleans that input'],
  ['options-read', 'reads saved settings or cached data'],
  ['meta-read', 'reads post/user meta'],
  ['queries-posts', 'queries posts or users'],
  ['db-read', 'reads the database directly'],
  ['options-write', 'saves settings or cached data'],
  ['meta-write', 'saves post/user meta'],
  ['writes-posts', 'creates, changes or deletes posts/users'],
  ['db-write', 'writes to the database directly'],
  ['creates-tables', 'creates database tables'],
  ['writes-files', 'writes files'],
  ['remote-request', 'calls an external URL'],
  ['sends-mail', 'sends email'],
  ['schedules', 'schedules a background job'],
  ['registers-content', 'registers WordPress content or admin screens'],
  ['registers-rest', 'registers REST API routes'],
  ['registers-hooks', 'hooks more code into WordPress'],
  ['enqueues', 'loads scripts/styles'],
  ['loads-file', 'loads another file'],
  ['fires-hooks', 'lets other code hook in'],
  ['escapes', 'escapes its output'],
  ['outputs-html', 'prints HTML'],
  ['returns-html', 'returns HTML'],
  ['sends-json', 'replies with JSON'],
  ['redirects', 'redirects the browser'],
];

export function summarizeFunction(facts) {
  const has = new Set(facts.does);
  const parts = PHRASES.filter(([k]) => has.has(k)).map(([, p]) => p);
  // "stops" only matters if it isn't just the end of a JSON reply
  if (has.has('stops') && !has.has('sends-json')) parts.push('stops the request');
  if (!parts.length) return facts.calls.length ? 'Works things out and returns a value (no side effects detected).' : 'Returns a value.';
  const s = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')}, then ${parts[parts.length - 1]}`;
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

// ---------------------------------------------------------------- files

export function fileRole(rec, isMain) {
  if (rec.type === 'js') return { key: 'script', label: 'Browser script' };
  if (rec.type === 'css') return { key: 'style', label: 'Stylesheet' };
  if (rec.type !== 'php') return { key: 'asset', label: 'Asset' };
  const base = rec.label.toLowerCase();
  const w = rec.wp;
  if (isMain) return { key: 'main', label: 'Main plugin file' };
  if (base === 'uninstall.php') return { key: 'uninstall', label: 'Uninstall script' };
  if (base === 'functions.php') return { key: 'theme', label: 'Theme functions file' };
  if (rec.entryPoints.some((e) => e.type === 'ajax' || e.type === 'rest' || e.type === 'admin-post')) return { key: 'endpoint', label: 'Request handlers' };
  if (w.menus.length || w.settings.length || w.metaBoxes.length) return { key: 'admin', label: 'Admin screen' };
  if (rec.classes.length && !rec.functions.length && !w.hooks.length) return { key: 'class', label: rec.classes[0].kind === 'interface' ? 'Interface' : rec.classes[0].kind === 'trait' ? 'Trait' : 'Class' };
  if (rec.includes.length >= 3 && rec.functions.length <= 1 && !w.hooks.length) return { key: 'loader', label: 'Loader' };
  if (rec.topLevelOutput && !rec.functions.length) return { key: 'template', label: 'Template' };
  if (w.hooks.length || w.shortcodes.length) return { key: 'hooks', label: 'Wires into WordPress' };
  if (rec.functions.length) return { key: 'helpers', label: 'Helper functions' };
  return { key: 'other', label: 'PHP file' };
}

export function summarizeFile(rec, ctx) {
  const w = rec.wp, bits = [];
  if (rec.type === 'js') {
    const calls = rec.jsCalls.filter((c) => c.endpoint !== 'unknown').length;
    bits.push(calls ? `Runs in the visitor's browser and talks to the server ${calls} way${calls === 1 ? '' : 's'}.` : 'Runs in the visitor\'s browser.');
    if (rec.domRefs.length) bits.push(`Works with ${rec.domRefs.length} element${rec.domRefs.length === 1 ? '' : 's'} on the page.`);
    if (ctx.enqueuedBy.length) bits.push(`Loaded by ${ctx.enqueuedBy.join(', ')}.`);
    return bits.join(' ');
  }
  if (rec.type !== 'php') return ctx.enqueuedBy.length ? `Loaded by ${ctx.enqueuedBy.join(', ')}.` : 'Not loaded by any PHP file that was found.';
  if (ctx.isMain) bits.push('WordPress reads its header and loads this file first.');
  const cls = rec.classes.filter((c) => c.name !== '(anon)');
  if (cls.length) bits.push(`Defines ${cls.map((c) => `${c.kind === 'class' ? 'class' : c.kind} ${c.name}${c.extends ? ` (extends ${c.extends})` : ''}`).join(', ')}.`);
  if (rec.functions.length) bits.push(`Has ${rec.functions.length} function${rec.functions.length === 1 ? '' : 's'}.`);
  const reg = [];
  const n = (arr, one, many) => (arr.length ? `${arr.length} ${arr.length === 1 ? one : many}` : null);
  const handlers = rec.entryPoints.filter((e) => e.type === 'ajax' || e.type === 'rest' || e.type === 'admin-post');
  for (const x of [
    n(handlers, 'request handler', 'request handlers'), n(w.shortcodes, 'shortcode', 'shortcodes'),
    n(w.postTypes, 'post type', 'post types'), n(w.taxonomies, 'taxonomy', 'taxonomies'),
    n(w.menus, 'admin page', 'admin pages'), n(w.settings, 'setting', 'settings'), n(w.metaBoxes, 'meta box', 'meta boxes'),
    n(w.blocks, 'block', 'blocks'), n(w.widgets, 'widget', 'widgets'), n(w.cron, 'scheduled job', 'scheduled jobs'),
    n(w.hooks.filter((h) => !/^(wp_ajax_|admin_post_)/.test(h.hook)), 'hook', 'hooks'),
  ]) if (x) reg.push(x);
  if (reg.length) bits.push(`Registers ${reg.join(', ')}.`);
  if (rec.enqueues.length) bits.push(`Loads ${rec.enqueues.length} script/style file${rec.enqueues.length === 1 ? '' : 's'}.`);
  if (w.tables.length) bits.push(`Creates database table${w.tables.length === 1 ? '' : 's'} ${w.tables.map((t) => t.name).join(', ')}.`);
  if (ctx.loadedBy.length) bits.push(`Loaded by ${ctx.loadedBy.join(', ')}.`);
  else if (!ctx.isMain && !handlers.length) bits.push('Nothing in the package loads it directly.');
  if (rec.directAccess) bits.push('It can be opened directly in a browser (no ABSPATH guard).');
  return bits.join(' ') || 'A PHP file with no top-level behaviour detected.';
}

// ---------------------------------------------------------------- parameters
// What each argument of a function is, and a sensible value to send. Read from
// the type hint, the default, how the body uses it, and what triggers it.

const USE_HINTS = [
  [['absint', 'intval', 'floatval', 'range'], 'number'],
  [['get_post', 'get_post_meta', 'update_post_meta', 'delete_post_meta', 'get_permalink', 'get_the_title', 'wp_delete_post', 'get_post_type', 'get_post_status', 'wp_trash_post', 'get_the_post_thumbnail'], 'post ID'],
  [['get_userdata', 'get_user_meta', 'update_user_meta', 'user_can', 'get_user_by'], 'user ID'],
  [['get_term', 'get_term_meta', 'get_term_link'], 'term ID'],
  [['sanitize_email', 'is_email'], 'email'],
  [['esc_url', 'esc_url_raw', 'wp_http_validate_url', 'wp_remote_get', 'wp_remote_post', 'wp_safe_redirect', 'wp_redirect'], 'URL'],
  [['wp_verify_nonce', 'check_ajax_referer'], 'nonce'],
  [['json_decode'], 'JSON text'],
  [['strtotime', 'date_create'], 'date'],
  [['sanitize_text_field', 'esc_html', 'esc_attr', 'trim', 'strtolower', 'strtoupper', 'sanitize_title', 'wp_strip_all_tags', 'strlen', 'str_replace'], 'text'],
  [['count', 'in_array', 'array_map', 'array_filter', 'array_keys', 'array_merge', 'implode', 'wp_list_pluck'], 'list'],
];
const USE_MAP = new Map();
for (const [names, kind] of USE_HINTS) for (const n of names) USE_MAP.set(n, kind);
const TYPE_KIND = {
  int: 'number', float: 'number', string: 'text', bool: 'yes/no', array: 'list', iterable: 'list',
  WP_REST_Request: 'REST request', WP_Post: 'post object', WP_User: 'user object', WP_Term: 'term object',
  WP_Query: 'query object', WP_Error: 'error object', callable: 'function',
};
const KNOWN_HOOK_ARGS = {
  the_content: ['the post\'s HTML'], the_title: ['the title text', 'post ID'], the_excerpt: ['the excerpt text'],
  save_post: ['post ID', 'post object', 'yes/no'], wp_insert_post: ['post ID', 'post object', 'yes/no'],
  body_class: ['list'], post_class: ['list'], 'manage_posts_columns': ['list'], wp_head: [], init: [], admin_menu: [],
  admin_init: [], wp_enqueue_scripts: [], admin_enqueue_scripts: ['the admin page slug'], plugins_loaded: [],
  user_register: ['user ID'], profile_update: ['user ID'], template_include: ['the template file path'],
  pre_get_posts: ['query object'], wp_login: ['the username', 'user object'],
};
const EXAMPLES = {
  number: 1, 'post ID': 1, 'user ID': 1, 'term ID': 1, email: 'test@example.com', URL: 'https://example.com',
  nonce: '(from wp_create_nonce)', 'JSON text': '{"id": 1}', date: '2026-01-01', text: 'Hello', 'yes/no': true,
  list: [], 'REST request': {}, 'post object': '(a post)', 'user object': '(a user)',
};

function kindFromName(name) {
  const n = name.toLowerCase();
  if (/^post_?id$|^pid$/.test(n)) return { kind: 'post ID', hint: 'a post ID, going by its name' };
  if (/^user_?id$|^uid$/.test(n)) return { kind: 'user ID', hint: 'a user ID, going by its name' };
  if (/(^|_)id$|^(count|num|number|qty|quantity|limit|page|per_page|offset|amount|price|total)$/.test(n)) return { kind: 'number', hint: 'a number (an ID or amount), going by its name' };
  if (/email/.test(n)) return { kind: 'email', hint: 'an email address, going by its name' };
  if (/url|link|href/.test(n)) return { kind: 'URL', hint: 'a web address, going by its name' };
  if (/nonce/.test(n)) return { kind: 'nonce', hint: 'a security token from wp_create_nonce()' };
  if (/^(is|has|can|should|enable|force)_?/.test(n)) return { kind: 'yes/no', hint: 'true or false, going by its name' };
  if (/name|title|slug|label|text|message|content|key|type|status/.test(n)) return { kind: 'text', hint: 'some text, going by its name' };
  return null;
}

export function paramFacts(fnNode, triggers = []) {
  const params = (fnNode.arguments || []).filter((p) => p.kind === 'parameter');
  if (!params.length) return [];
  const body = fnNode.body || fnNode;
  const shortcode = triggers.find((t) => t.kind === 'shortcode');
  const rest = triggers.find((t) => t.kind === 'rest');
  const hookName = (triggers.find((t) => t.kind === 'action' || t.kind === 'filter') || {}).label?.match(/"([^"]+)"/)?.[1];
  const isFilter = triggers.some((t) => t.kind === 'filter');

  // shortcode_atts( array( 'id' => 0, ... ), $atts ) tells us the attribute names
  let scKeys = [];
  walk(body, (n) => {
    if (n.kind === 'call' && callName(n) === 'shortcode_atts' && n.arguments && n.arguments[0] && n.arguments[0].kind === 'array') {
      scKeys = n.arguments[0].items.map((it) => literalString(it && it.key)).filter(Boolean);
    }
  });

  return params.map((p, i) => {
    const name = typeof p.name === 'string' ? p.name : nameOf(p.name) || `arg${i + 1}`;
    const typeName = p.type ? nameOf(p.type) || (p.type.name) : null;
    const usage = usageOf(body, name);
    let kind = (typeName && TYPE_KIND[typeName.replace(/^\\/, '')]) || usage.kind || null;
    let hint;
    let scExample;
    if (shortcode && i === 0) {
      kind = 'shortcode attributes';
      hint = scKeys.length ? `the shortcode's attributes: ${scKeys.join(', ')}` : 'the shortcode\'s attributes (key => value)';
    } else if (shortcode && i === 1) { kind = 'text'; hint = 'the text between [tag] and [/tag], if any'; scExample = ''; }
    else if (shortcode && i === 2) {
      kind = 'text'; hint = 'the shortcode\'s own name';
      scExample = (shortcode.label.match(/\[([^\]]+)\]/) || [])[1] || '';
    }
    else if (rest && i === 0) {
      kind = 'REST request';
      hint = usage.params.length ? `the REST request; it reads ${usage.params.map((x) => `"${x}"`).join(', ')}` : 'the REST request object';
    } else if (hookName && KNOWN_HOOK_ARGS[hookName] && KNOWN_HOOK_ARGS[hookName][i]) {
      const k = KNOWN_HOOK_ARGS[hookName][i];
      kind = kind || (EXAMPLES[k] !== undefined ? k : 'text');
      hint = `WordPress passes ${k} (from "${hookName}")`;
    } else if (isFilter && i === 0) {
      hint = 'the value being filtered; the function must return it (changed or not)';
    }
    // Last resort: the parameter's name is a decent clue ($id, $email, $url, $count…)
    if (!hint && !kind && !usage.keys.length && !usage.methods.length) {
      const guess = kindFromName(name);
      if (guess) { kind = guess.kind; hint = guess.hint; }
    }
    if (!hint) {
      if (usage.keys.length) { kind = 'array'; hint = `an array with keys ${usage.keys.map((k) => `"${k}"`).join(', ')}`; }
      else if (usage.methods.length) hint = `an object it calls ->${usage.methods.join('(), ->')}() on`;
      else if (kind) hint = `${/^[aeiou]/i.test(kind) ? 'an' : 'a'} ${kind}`;
      else hint = 'not enough clues to say; any value';
    }
    let example = kind === 'array' ? Object.fromEntries(usage.keys.map((k) => [k, ''])) :
      kind === 'shortcode attributes' ? Object.fromEntries(scKeys.map((k) => [k, ''])) :
      kind === 'REST request' ? Object.fromEntries(usage.params.map((k) => [k, ''])) :
      EXAMPLES[kind] !== undefined ? EXAMPLES[kind] : '';
    const dflt = p.value ? literalRepr(p.value) : null;
    return {
      name: '$' + name, type: typeName || null, kind: kind || 'any', hint,
      optional: !!p.value || !!p.variadic, default: dflt, byRef: !!p.byref, variadic: !!p.variadic,
      example: scExample !== undefined ? scExample : dflt != null && dflt !== 'null' ? dflt : example,
    };
  });
}

function usageOf(body, name) {
  const out = { kind: null, keys: [], methods: [], params: [] };
  const isVar = (n) => n && n.kind === 'variable' && n.name === name;
  walk(body, (n) => {
    if (n.kind === 'call') {
      const fn = callName(n);
      (n.arguments || []).forEach((a) => {
        if (isVar(a) && USE_MAP.has(fn) && !out.kind) out.kind = USE_MAP.get(fn);
      });
      // $request->get_param('x') / $obj->method()
      if (n.what && n.what.kind === 'propertylookup' && isVar(n.what.what)) {
        const m = n.what.offset && n.what.offset.name;
        if (m && !out.methods.includes(m)) out.methods.push(m);
        if ((m === 'get_param' || m === 'get_json_params') && n.arguments && n.arguments[0]) {
          const k = literalString(n.arguments[0]); if (k && !out.params.includes(k)) out.params.push(k);
        }
      }
    }
    if (n.kind === 'cast' && isVar(n.expr)) {
      out.kind = out.kind || ({ int: 'number', float: 'number', bool: 'yes/no', array: 'list', string: 'text' }[n.type] || null);
    }
    if (n.kind === 'foreach' && isVar(n.source)) out.kind = out.kind || 'list';
    if (n.kind === 'offsetlookup' && isVar(n.what)) {
      const k = literalString(n.offset);
      if (k && !out.keys.includes(k)) out.keys.push(k);
      // $request['id'] on a REST request counts as a param too
      if (k && !out.params.includes(k)) out.params.push(k);
    }
  });
  return out;
}

function literalRepr(v) {
  if (!v) return null;
  if (v.kind === 'string') return JSON.stringify(v.value);
  if (v.kind === 'number') return String(v.value);
  if (v.kind === 'boolean') return v.value ? 'true' : 'false';
  if (v.kind === 'nullkeyword') return 'null';
  if (v.kind === 'array') return v.items && v.items.length ? '[…]' : '[]';
  if (v.kind === 'name' || v.kind === 'constref') return nameOf(v.name || v) || null;
  return '…';
}
