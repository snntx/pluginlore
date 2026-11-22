// Learn tab content: turns the analysis into a plain-English walk through the
// plugin, in the order WordPress actually runs it. Deterministic, no guessing.
// Pure module (no DOM) so it can be unit-tested.
//
// Text may contain glossary tokens {{term|shown text}} which the UI turns into
// clickable definitions. Dynamic values are always escaped here.

export const GLOSSARY = {
  header: ['Plugin header', 'The comment block at the top of the main file ("Plugin Name: …"). WordPress reads it to list the plugin, then loads that file on every request once the plugin is active.'],
  hook: ['Hook', 'A named moment in WordPress ("init", "wp_head", "save_post"…). Plugins attach their own functions to hooks so WordPress calls them at that moment.'],
  action: ['Action', 'A hook that says "this just happened, do something". The attached function runs for its side effects (saving, printing, registering).'],
  filter: ['Filter', 'A hook that passes a value through attached functions so they can change it (e.g. edit the post content before it is shown) and must return it.'],
  priority: ['Priority', 'When several functions use the same hook, lower numbers run first. The default is 10.'],
  shortcode: ['Shortcode', 'A tag like [my_form] that authors type into content. WordPress swaps it for the HTML the plugin returns.'],
  enqueue: ['Enqueue', 'The proper way to add a JavaScript or CSS file to a page: WordPress prints the tag in the right place, once, with its dependencies.'],
  ajax: ['AJAX (admin-ajax.php)', 'A request sent by JavaScript in the browser without reloading the page. WordPress routes it to the plugin function registered for that "action".'],
  nopriv: ['nopriv', 'The "wp_ajax_nopriv_" prefix means the handler also accepts visitors who are not logged in. Anyone on the internet can call it.'],
  rest: ['REST route', 'A URL under /wp-json/ that answers with JSON. Its permission_callback decides who may use it.'],
  nonce: ['Nonce', 'A short-lived token put in forms and requests to prove the request came from your own site, not from a forged link (stops CSRF).'],
  capability: ['Capability', 'A permission such as "manage_options" or "edit_posts". current_user_can() checks it; it is what actually stops a Subscriber from doing admin things.'],
  option: ['Option', 'A named setting stored in the wp_options table (get_option / update_option).'],
  transient: ['Transient', 'An option with an expiry time, used as a cache.'],
  cpt: ['Custom post type', 'A new kind of content (like "Event" or "Product") stored alongside posts and pages.'],
  taxonomy: ['Taxonomy', 'A way to group content, like categories or tags.'],
  cron: ['WP-Cron', 'WordPress\'s scheduler. A scheduled job is a hook that WordPress fires later (hourly, daily…) on a normal page visit.'],
  activation: ['Activation hook', 'Code that runs once when someone clicks "Activate": usually creating tables, default settings or scheduled jobs.'],
  abspath: ['ABSPATH guard', 'The line "if (!defined(\'ABSPATH\')) exit;" stops a PHP file from doing anything when someone opens its URL directly.'],
  wpdb: ['$wpdb', 'WordPress\'s database object. $wpdb->prepare() keeps values safely separate from the SQL.'],
  escape: ['Escaping', 'Making data safe right before printing it (esc_html, esc_attr, esc_url), so it can\'t turn into HTML or script.'],
  sanitize: ['Sanitizing', 'Cleaning input when it arrives (sanitize_text_field, absint…), so only the expected kind of value is kept.'],
  metabox: ['Meta box', 'A panel on the post edit screen, often used to edit extra fields.'],
  block: ['Block', 'A Gutenberg editor block.'],
  textdomain: ['Text domain', 'The ID used to find translations for the plugin\'s text.'],
};

const SETUP = ['muplugins_loaded', 'plugins_loaded', 'setup_theme', 'after_setup_theme', 'init', 'widgets_init', 'wp_loaded', 'rest_api_init'];
const FRONT = ['parse_request', 'wp', 'template_redirect', 'wp_enqueue_scripts', 'wp_head', 'wp_body_open', 'the_content', 'the_title', 'the_excerpt',
  'body_class', 'template_include', 'pre_get_posts', 'wp_footer', 'login_enqueue_scripts', 'comment_form', 'widget_text', 'single_template', 'nav_menu_css_class'];
const ADMIN = ['admin_menu', 'network_admin_menu', 'admin_init', 'admin_enqueue_scripts', 'admin_notices', 'add_meta_boxes', 'save_post',
  'admin_head', 'admin_footer', 'admin_bar_menu', 'enqueue_block_editor_assets', 'edit_form_after_title', 'user_register', 'profile_update'];
const isAdminHook = (h) => ADMIN.includes(h) || /^(admin_|manage_|save_post_|plugin_action_links|network_admin_|edit_|add_meta_boxes_)/.test(h);
const ORDER = [...SETUP, ...FRONT, ...ADMIN];

export function hookPhase(hook, cronHooks = new Set()) {
  if (/^(wp_ajax_|admin_post_)/.test(hook)) return 'requests';
  if (cronHooks.has(hook)) return 'cron';
  if (SETUP.includes(hook)) return 'setup';
  if (isAdminHook(hook)) return 'admin';
  if (FRONT.includes(hook)) return 'front';
  return 'other';
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const code = (s) => `<code>${esc(s)}</code>`;
const t = (key, text) => `{{${key}|${text}}}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fileName = (id) => id.split('/').pop();

// ---------------------------------------------------------------- lessons
export function buildLessons(model) {
  const nodes = model.nodes;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const php = nodes.filter((n) => n.type === 'php');
  const fnIndex = new Map(); // name(lower) -> [{file, fn}]
  for (const n of php) for (const fn of n.fns || []) {
    const k = fn.name.toLowerCase();
    if (!fnIndex.has(k)) fnIndex.set(k, []);
    fnIndex.get(k).push({ file: n.id, fn });
  }
  const findFn = (cb, prefer) => {
    if (!cb || cb === '(closure)') return null;
    const hits = fnIndex.get(String(cb).split('::').pop().toLowerCase()) || [];
    return hits.find((h) => h.file === prefer) || hits[0] || null;
  };
  const describeCb = (cb, file, inline) => {
    if (inline) return `an inline function that ${lower(inline.summary)}`;
    const f = findFn(cb, file);
    if (!f) return cb ? `${code(cb + '()')}` : 'a function';
    return `${code((f.fn.cls ? f.fn.cls + '::' : '') + f.fn.name + '()')} in ${code(fileName(f.file))}, which ${lower(f.fn.summary)}`;
  };
  const cronHooks = new Set(php.flatMap((n) => n.wp.cron.map((c) => c.hook)));
  const mains = php.filter((n) => n.isMain);
  const chapters = [];

  // 1. Discovery + boot chain
  {
    const steps = [];
    const includes = new Map();
    for (const e of model.edges) if (e.type === 'include') {
      if (!includes.has(e.source)) includes.set(e.source, []);
      includes.get(e.source).push(e.target);
    }
    for (const main of mains) {
      const pkg = (model.meta.packages || []).find((p) => p.file === main.id);
      steps.push({
        title: `WordPress reads ${fileName(main.id)}`,
        text: `WordPress scans the plugins folder and finds the ${t('header', 'plugin header')} in ${code(main.id)}${pkg ? ` ("${esc(pkg.name)}"${pkg.version ? `, version ${esc(pkg.version)}` : ''})` : ''}. While the plugin is active, this file runs on <b>every</b> page load, admin screen and request.`,
        files: [main.id], ping: main.id,
      });
      // breadth-first: what the main file loads, level by level
      const seen = new Set([main.id]); let level = [main.id]; let depth = 0;
      while (level.length && depth < 5) {
        const next = [];
        for (const id of level) for (const t2 of includes.get(id) || []) if (!seen.has(t2)) { seen.add(t2); next.push(t2); }
        if (!next.length) break;
        depth++;
        steps.push({
          title: depth === 1 ? 'It loads its other files' : `Those load ${plural(next.length, 'more file', 'more files')}`,
          text: `${depth === 1 ? `${code(fileName(main.id))} pulls in` : 'Next come'} ${next.slice(0, 12).map((id) => code(fileName(id))).join(', ')}${next.length > 12 ? ` and ${next.length - 12} more` : ''}. ${depth === 1 ? 'Nothing runs yet: loading a file mostly defines functions and classes, and attaches them to hooks for later.' : ''}`,
          files: next,
        });
        level = next;
      }
    }
    if (!mains.length) {
      steps.push({ title: 'No plugin header found', text: `None of the files has a ${t('header', 'plugin header')}, so WordPress would not list this as a plugin. It may be a theme, a library, or part of a bigger plugin.`, files: [] });
    }
    chapters.push({ id: 'boot', title: 'How WordPress finds it', steps });
  }

  // 2. Lifecycle
  {
    const steps = [];
    for (const n of php) for (const ep of n.entryPoints) {
      if (ep.type !== 'activation' && ep.type !== 'deactivation') continue;
      const f = findFn(ep.callback, n.id);
      steps.push({
        title: ep.type === 'activation' ? 'When someone clicks Activate' : 'When someone clicks Deactivate',
        text: `The ${t('activation', ep.type === 'activation' ? 'activation hook' : 'deactivation hook')} runs ${describeCb(ep.callback, n.id)}.`,
        files: [n.id, f && f.file].filter(Boolean),
      });
    }
    const tables = php.flatMap((n) => n.wp.tables.map((x) => ({ ...x, file: n.id })));
    if (tables.length) steps.push({ title: 'It creates database tables', text: `${tables.map((x) => code(x.name)).join(', ')} (in ${[...new Set(tables.map((x) => code(fileName(x.file))))].join(', ')}). These stay in the database until removed.`, files: [...new Set(tables.map((x) => x.file))] });
    const uninstall = php.find((n) => n.label.toLowerCase() === 'uninstall.php');
    if (uninstall) steps.push({ title: 'When someone deletes it', text: `WordPress runs ${code('uninstall.php')} to clean up. ${uninstall.fns.length ? '' : uninstall.summary}`, files: [uninstall.id] });
    if (steps.length) chapters.push({ id: 'lifecycle', title: 'Switching it on and off', steps });
  }

  // hooks grouped by phase
  const hookSteps = { setup: [], front: [], admin: [], cron: [], other: [] };
  const allHooks = [];
  for (const n of php) for (const h of n.wp.hooks) allHooks.push({ ...h, file: n.id });
  allHooks.sort((a, b) => (ORDER.indexOf(a.hook) + 1 || 999) - (ORDER.indexOf(b.hook) + 1 || 999) || a.priority - b.priority);
  for (const h of allHooks) {
    const phase = hookPhase(h.hook, cronHooks);
    if (phase === 'requests') continue;
    const f = findFn(h.callback, h.file);
    hookSteps[phase].push({
      title: `On ${h.hook}`,
      text: `${h.kind === 'filter' ? `The ${code(h.hook)} ${t('filter', 'filter')}` : `When WordPress fires ${code(h.hook)} (an ${t('action', 'action')})`}${h.priority !== 10 ? ` at ${t('priority', 'priority')} ${h.priority}` : ''}, it calls ${describeCb(h.callback, h.file, h.inline)}.`,
      files: [h.file, f && f.file].filter((x, i, a) => x && a.indexOf(x) === i),
      ping: h.file,
    });
  }

  // 3. Setup
  {
    const steps = [...hookSteps.setup];
    const reg = (label, key, list, fmt) => {
      if (!list.length) return;
      steps.push({ title: label, text: fmt(list), files: [...new Set(list.map((x) => x.file))] });
    };
    const collect = (k) => php.flatMap((n) => n.wp[k].map((x) => ({ ...x, file: n.id })));
    reg('It adds new kinds of content', 'cpt', collect('postTypes'), (l) => `${t('cpt', 'Custom post types')}: ${l.map((x) => code(x.name)).join(', ')}.`);
    reg('It adds ways to group content', 'taxonomy', collect('taxonomies'), (l) => `${t('taxonomy', 'Taxonomies')}: ${l.map((x) => code(x.name)).join(', ')}.`);
    reg('It adds shortcodes', 'shortcode', collect('shortcodes'), (l) => `Authors can type ${l.map((x) => code(`[${x.tag}]`)).join(', ')} into content. Each ${t('shortcode', 'shortcode')} is replaced by the HTML its function returns.`);
    reg('It adds editor blocks', 'block', collect('blocks'), (l) => `${t('block', 'Blocks')}: ${l.map((x) => code(x.name)).join(', ')}.`);
    reg('It adds widgets', 'widget', collect('widgets'), (l) => `Widgets: ${l.map((x) => code(x.name)).join(', ')}.`);
    const domains = php.filter((n) => n.wp.textDomain).map((n) => ({ d: n.wp.textDomain, file: n.id }));
    if (domains.length) steps.push({ title: 'It can be translated', text: `It loads translations with the ${t('textdomain', 'text domain')} ${code(domains[0].d)}.`, files: domains.map((x) => x.file) });
    if (steps.length) chapters.push({ id: 'setup', title: 'Setting up on every request', intro: 'These run early on every request, before WordPress decides what page to show.', steps });
  }

  // 4. Front end
  {
    const steps = [...hookSteps.front];
    const front = model.edges.filter((e) => e.type === 'enqueue').map((e) => ({ from: e.source, to: e.target }));
    if (front.length) {
      const byFrom = new Map();
      for (const e of front) { if (!byFrom.has(e.from)) byFrom.set(e.from, []); byFrom.get(e.from).push(e.to); }
      for (const [from, list] of byFrom) steps.push({
        title: `${fileName(from)} adds files to the page`,
        text: `It ${t('enqueue', 'enqueues')} ${list.map((x) => code(fileName(x))).join(', ')}, so WordPress prints the right ${list.some((x) => byId.get(x)?.type === 'js') ? '<script>' : ''}${list.some((x) => byId.get(x)?.type === 'js') && list.some((x) => byId.get(x)?.type === 'css') ? ' and ' : ''}${list.some((x) => byId.get(x)?.type === 'css') ? '<link>' : ''} tags.`.replace('<script>', '&lt;script&gt;').replace('<link>', '&lt;link&gt;'),
        files: [from, ...list],
      });
    }
    for (const n of php) for (const sc of n.wp.shortcodes) {
      const f = findFn(sc.callback, n.id);
      if (f) steps.push({ title: `Showing [${sc.tag}]`, text: `Wherever ${code(`[${sc.tag}]`)} appears, WordPress calls ${describeCb(sc.callback, n.id)}.`, files: [n.id, f.file].filter((x, i, a) => a.indexOf(x) === i) });
    }
    for (const n of nodes.filter((x) => x.type === 'js' && x.domRefs && x.domRefs.length)) {
      const targets = model.edges.filter((e) => e.source === n.id && e.type === 'dom').map((e) => e.target);
      if (targets.length) steps.push({ title: `${fileName(n.id)} brings the page to life`, text: `In the browser it looks up ${n.domRefs.slice(0, 5).map((d) => code(d.selector)).join(', ')}, which ${targets.map((x) => code(fileName(x))).join(', ')} put${targets.length === 1 ? 's' : ''} on the page.`, files: [n.id, ...targets] });
    }
    if (steps.length) chapters.push({ id: 'front', title: 'What visitors see', intro: 'This happens when someone views a page on the site.', steps });
  }

  // 5. Admin
  {
    const steps = [...hookSteps.admin];
    for (const n of php) {
      for (const m of n.wp.menus) {
        const f = findFn(m.callback, n.id);
        steps.push({
          title: `Admin ${m.kind}: ${m.title}`,
          text: `It adds the admin ${m.kind} "${esc(m.title)}"${m.capability ? `, visible to users with the ${t('capability', 'capability')} ${code(m.capability)}` : ''}. The page is drawn by ${describeCb(m.callback, n.id)}.`,
          files: [n.id, f && f.file].filter((x, i, a) => x && a.indexOf(x) === i),
        });
      }
      for (const s of n.wp.settings) steps.push({ title: `Setting: ${s.name}`, text: `It registers the setting ${code(s.name)}${s.group ? ` in the group ${code(s.group)}` : ''}, stored as an ${t('option', 'option')}.`, files: [n.id] });
      for (const mb of n.wp.metaBoxes) steps.push({ title: `Meta box: ${mb.title || mb.id}`, text: `A ${t('metabox', 'meta box')} on the edit screen, drawn by ${describeCb(mb.callback, n.id)}.`, files: [n.id] });
    }
    if (steps.length) chapters.push({ id: 'admin', title: 'The admin area', intro: 'This only happens inside wp-admin.', steps });
  }

  // 6. Requests from the browser
  {
    const steps = [];
    const callers = (file, matcher) => model.edges.filter((e) => e.target === file && matcher(e)).map((e) => e.source);
    // one step per handler: a logged-in + logged-out pair with the same callback is one public endpoint
    const groups = new Map();
    for (const n of php) for (const ep of n.entryPoints) {
      if (ep.type !== 'ajax' && ep.type !== 'rest' && ep.type !== 'admin-post') continue;
      const action = ep.name.replace(/^(wp_ajax_|admin_post_)(nopriv_)?/, '');
      const key = `${n.id}|${ep.type}|${action}|${ep.callback}`;
      if (!groups.has(key)) groups.set(key, { n, ep, action, auths: new Set(), rows: [] });
      const g = groups.get(key);
      g.auths.add(ep.auth);
      const row = (n.access || []).find((a) => a.name === ep.name);
      if (row) g.rows.push(row);
    }
    const SEV = { high: 3, medium: 2, low: 1 };
    for (const { n, ep, action, auths, rows } of groups.values()) {
      const f = findFn(ep.callback, n.id);
      const isPublic = auths.has('unauth');
      const access = rows.sort((a, b) => (SEV[b.severity] || 0) - (SEV[a.severity] || 0))[0];
      let who;
      if (ep.type === 'rest') who = ep.permission === 'set' ? 'only to people its permission check allows' : 'to <b>anyone</b> (its permission check always says yes)';
      else if (isPublic && auths.has('auth')) who = `to <b>everyone</b>, logged in or not (${t('nopriv', 'nopriv')})`;
      else if (isPublic) who = `only to logged-out visitors (${t('nopriv', 'nopriv')})`;
      else who = 'to logged-in users';
      // REST handles its own nonce; its permission callback is the access check
      const checks = access && ep.type !== 'rest'
        ? ` ${access.cap ? `It checks a ${t('capability', 'capability')}.` : `It does <b>not</b> check a ${t('capability', 'capability')}.`} ${access.nonce ? `It checks a ${t('nonce', 'nonce')}.` : `It does <b>not</b> check a ${t('nonce', 'nonce')}.`}`
        : '';
      const fromJs = ep.type === 'rest'
        ? callers(n.id, (e) => e.type === 'rest-call')
        : callers(n.id, (e) => e.type === 'ajax' && e.action === action);
      const kind = ep.type === 'rest' ? t('rest', 'REST route') : ep.type === 'ajax' ? t('ajax', 'AJAX action') : 'form action';
      steps.push({
        title: ep.type === 'rest' ? `REST: /${ep.name}` : `${ep.type === 'ajax' ? 'AJAX' : 'Form'}: ${action}${isPublic ? ' (public)' : ''}`,
        text: `The ${kind} ${code(ep.type === 'rest' ? '/wp-json/' + ep.name : action)} is open ${who}. It runs ${describeCb(ep.callback, n.id)}.${checks}${fromJs.length ? ` In the browser, ${[...new Set(fromJs)].map((x) => code(fileName(x))).join(', ')} send${new Set(fromJs).size === 1 ? 's' : ''} this request.` : ''}`,
        files: [...new Set([n.id, f && f.file, ...fromJs].filter(Boolean))],
        ping: fromJs[0] || n.id,
        risk: access && ['high', 'medium'].includes(access.severity) ? access.severity : null,
      });
    }
    if (steps.length) chapters.push({ id: 'requests', title: 'Requests from the browser', intro: 'These run when JavaScript or a form sends a request straight to the site, without loading a normal page.', steps });
  }

  // 7. Background jobs
  {
    const steps = [...hookSteps.cron];
    for (const n of php) for (const c of n.wp.cron) if (!steps.some((s) => s.title.includes(c.hook))) {
      steps.push({ title: `Scheduled: ${c.hook}`, text: `${code(fileName(n.id))} schedules ${code(c.hook)} to run ${c.recurrence ? esc(c.recurrence === 'once' ? 'once' : c.recurrence) : 'later'} via ${t('cron', 'WP-Cron')}.`, files: [n.id] });
    }
    if (steps.length) chapters.push({ id: 'cron', title: 'Background jobs', steps });
  }

  // 8. Hooks offered to others
  {
    const fires = php.flatMap((n) => n.wp.fires.map((f) => ({ ...f, file: n.id })));
    if (fires.length) chapters.push({
      id: 'extend', title: 'Hooks it offers other developers', intro: 'Other plugins or themes can attach to these to change how this plugin behaves.',
      steps: fires.slice(0, 40).map((f) => ({ title: f.hook, text: `${code(fileName(f.file))} fires the ${f.kind === 'filter' ? t('filter', 'filter') : t('action', 'action')} ${code(f.hook)} (line ${f.line}).`, files: [f.file] })),
    });
  }

  // 9. Data
  {
    const steps = [];
    const optsW = [...new Set(php.flatMap((n) => n.wp.optionsWritten))];
    const optsR = [...new Set(php.flatMap((n) => n.wp.optionsRead))].filter((o) => !optsW.includes(o));
    if (optsW.length) steps.push({ title: 'Settings it saves', text: `${t('option', 'Options')} written: ${optsW.map(code).join(', ')}.`, files: php.filter((n) => n.wp.optionsWritten.length).map((n) => n.id) });
    if (optsR.length) steps.push({ title: 'Settings it reads', text: `${t('option', 'Options')} read: ${optsR.map(code).join(', ')}.`, files: php.filter((n) => n.wp.optionsRead.length).map((n) => n.id) });
    const dbFns = php.flatMap((n) => (n.fns || []).filter((f) => f.does.includes('db-write') || f.does.includes('db-read')).map((f) => ({ f, file: n.id })));
    if (dbFns.length) steps.push({ title: 'Direct database access', text: `${plural(dbFns.length, 'function talks', 'functions talk')} to the database through ${t('wpdb', '$wpdb')}: ${dbFns.slice(0, 8).map((x) => code(x.f.name + '()')).join(', ')}${dbFns.length > 8 ? '…' : ''}.`, files: [...new Set(dbFns.map((x) => x.file))] });
    if (steps.length) chapters.push({ id: 'data', title: 'Data it keeps', steps });
  }

  // Other hooks that don't fit a phase
  if (hookSteps.other.length) chapters.push({ id: 'other', title: 'Other hooks it uses', steps: hookSteps.other.slice(0, 40) });

  return { chapters, files: fileGuide(model) };
}

const ROLE_ORDER = ['main', 'loader', 'hooks', 'endpoint', 'admin', 'helpers', 'class', 'template', 'uninstall', 'theme', 'script', 'style', 'asset', 'other'];

export function fileGuide(model) {
  return [...model.nodes]
    .sort((a, b) => ROLE_ORDER.indexOf(a.role?.key) - ROLE_ORDER.indexOf(b.role?.key) || a.id.localeCompare(b.id))
    .map((n) => ({
      id: n.id, role: n.role, summary: n.summary,
      fns: (n.fns || []).map((f) => ({
        name: (f.cls ? `${f.cls}::` : '') + f.name, line: f.line, summary: f.summary, params: f.params || [],
        triggers: mergeTriggers(f.triggers), calledBy: f.calledBy,
      })),
    }));
}

// "handles X for anyone" + "handles X for logged-in users" -> one line
function mergeTriggers(list) {
  const out = [];
  for (const tr of list || []) {
    const m = tr.label.match(/^(handles the AJAX action "[^"]+") for (anyone|logged-in users)$/);
    if (m) {
      const prev = out.find((o) => o.base === m[1]);
      if (prev) { prev.label = `${m[1]} for everyone (logged in or not)`; continue; }
      out.push({ ...tr, base: m[1] });
    } else out.push(tr);
  }
  return out.map(({ base, ...r }) => r);
}

function lower(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, '') : ''; }
