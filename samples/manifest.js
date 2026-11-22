// Built-in tutorial plugins. Each one is a small, deliberately-constructed
// plugin that exercises one Pluginlore scenario. web/build.js zips each folder
// into web/dist/samples/<dir>.zip; test/samples.test.js proves every sample
// actually triggers the scenario it claims to, and that every mission can be
// completed.
//
//   dir        folder under samples/ (zipped as-is, like a real plugin download)
//   compare    optional second folder (version comparison)
//   trace      optional runtime-trace JSON to import after loading
//   settings   options the sample needs (vulnScan asks for the disclaimer first)
//   tab        tab to open once loaded;  focus: node to select
//   missions   [{ text, when }] — `when` is matched against UI events and the
//              mission ticks itself off when the user does it:
//
//   event            payload fields you can match on
//   ---------------  ----------------------------------------------
//   select           id (file), observed (bool, runtime trace)
//   tab              name
//   ping             id (start file)
//   access-row       name, type
//   finding-row      file, kind, symbol
//   findings-kinds   only (the single kind shown, or null)
//   edge-filter      type, on
//   dim              on
//   package-filter   count (packages visible)
//   diff-item        section ('regressions'|'endpoints-added'|'fixes'|'findings-added'|'files-added'), name, file
//   conflict-loc     name, file
//   untested         name
//   view             mode ('web' | 'flow')
//
// Every key in `when` other than `event` must equal the payload's value.

export const MISSION_EVENTS = [
  'select', 'tab', 'ping', 'access-row', 'finding-row', 'findings-kinds', 'edge-filter',
  'dim', 'package-filter', 'diff-item', 'conflict-loc', 'untested', 'view',
];

export function missionMatches(when, event, payload) {
  if (!when || when.event !== event) return false;
  return Object.keys(when).every((k) => k === 'event' || payload[k] === when[k]);
}

export const SAMPLES = [
  {
    id: 'leaky-contact-form',
    title: 'Leaky Contact Form',
    tagline: 'Four request handlers. Three of them are broken.',
    tags: ['Access control', 'SQL injection', 'XSS'],
    color: '#e0433f',
    dir: 'leaky-contact-form',
    settings: { vulnScan: true },
    tab: 'access',
    missions: [
      { text: 'In Access, click the handler that lets any Subscriber delete messages.',
        when: { event: 'access-row', name: 'wp_ajax_lcf_delete' } },
      { text: 'Click the REST route anyone on the internet can use to delete posts.',
        when: { event: 'access-row', type: 'rest' } },
      { text: 'Click the handler that is done right: both checks present.',
        when: { event: 'access-row', name: 'wp_ajax_lcf_export' } },
      { text: 'Open Findings and click the SQL injection.',
        when: { event: 'finding-row', kind: 'vuln', symbol: '$wpdb->query' } },
    ],
  },
  {
    id: 'tangled-shop',
    title: 'Tangled Shop',
    tagline: 'Front-end JavaScript calling PHP four different ways.',
    tags: ['JS to AJAX', 'JS to REST', 'DOM links'],
    color: '#c9a227',
    dir: 'tangled-shop',
    settings: { vulnScan: false },
    tab: 'graph',
    focus: 'assets/cart.js',
    missions: [
      { text: 'cart.js is selected. Press Ping signal and watch it cross from JS into PHP.',
        when: { event: 'ping', id: 'assets/cart.js' } },
      { text: 'Follow the teal dash-dot line from cart.js: click the PHP file that renders the #ts-add button.',
        when: { event: 'select', id: 'includes/render.php' } },
      { text: 'Click wishlist.js. Its legacy fallback hides the AJAX action inside FormData.',
        when: { event: 'select', id: 'assets/wishlist.js' } },
      { text: 'Click tangled-shop.php: the dotted lines leaving it are enqueued assets.',
        when: { event: 'select', id: 'tangled-shop.php' } },
    ],
  },
  {
    id: 'class-zoo',
    title: 'Class Zoo',
    tagline: 'Interfaces, traits, inheritance and an unlocked side door.',
    tags: ['OOP map', 'Orphans', 'Direct access'],
    color: '#9b59e8',
    dir: 'class-zoo',
    settings: { vulnScan: false },
    tab: 'graph',
    missions: [
      { text: 'Purple dashed lines are inheritance. Click class-parrot.php to see which methods it overrides.',
        when: { event: 'select', id: 'src/class-parrot.php' } },
      { text: 'One file is never included by anything. Find and click the orphan (dashed ring).',
        when: { event: 'select', id: 'src/old-aviary.php' } },
      { text: 'Click feeding-times.php: no ABSPATH guard, and it reads $_GET.',
        when: { event: 'select', id: 'feeding-times.php' } },
      { text: 'Uncheck "Includes / requires" under Threads to see only the class structure.',
        when: { event: 'edge-filter', type: 'include', on: false } },
      { text: 'Switch the graph to Flow: the load order now reads left to right.',
        when: { event: 'view', mode: 'flow' } },
    ],
  },
  {
    id: 'slowpoke-gallery',
    title: 'Slowpoke Gallery',
    tagline: 'A gallery that queries the database once per image.',
    tags: ['Performance', 'N+1 queries'],
    color: '#e8940c',
    dir: 'slowpoke-gallery',
    settings: { vulnScan: false },
    tab: 'findings',
    missions: [
      { text: 'Use the chips to show only Performance findings.',
        when: { event: 'findings-kinds', only: 'perf' } },
      { text: 'Click the slowest call inside the loop: the external HTTP request.',
        when: { event: 'finding-row', kind: 'perf', symbol: 'wp_remote_get' } },
      { text: 'Click the query that loads every attachment on the site.',
        when: { event: 'finding-row', kind: 'perf', symbol: 'posts_per_page' } },
    ],
  },
  {
    id: 'version-drama',
    title: 'Version Drama',
    tagline: 'Version 1.5.0 fixes a bug, and quietly adds two new ones.',
    tags: ['Version diff', 'Regressions', 'Silent fixes'],
    color: '#3150f5',
    dir: 'version-drama-1.4.0',
    compare: 'version-drama-1.5.0',
    settings: { vulnScan: true },
    tab: 'changes',
    missions: [
      { text: 'Under Access regressions, click the handler whose capability check was removed.',
        when: { event: 'diff-item', section: 'regressions', name: 'wp_ajax_vd_save_settings' } },
      { text: 'A brand-new endpoint appeared. Click it under New entry points.',
        when: { event: 'diff-item', section: 'endpoints-added', name: 'vd/v1/webhook' } },
      { text: 'Click the bug that was patched without a changelog entry.',
        when: { event: 'diff-item', section: 'fixes', file: 'includes/export.php' } },
      { text: 'Back on the Graph, click the brand-new file (marked +).',
        when: { event: 'select', id: 'includes/webhook.php' } },
    ],
  },
  {
    id: 'crowded-site',
    title: 'Crowded Site',
    tagline: 'Two plugins and a theme that cannot all be active at once.',
    tags: ['Whole-site scan', 'Fatal clashes'],
    color: '#0ea5a5',
    dir: 'crowded-site',
    settings: { vulnScan: false },
    tab: 'conflicts',
    missions: [
      { text: 'Click where the theme redeclares site_breadcrumbs(): that crashes the site.',
        when: { event: 'conflict-loc', name: 'site_breadcrumbs', file: 'gamma-theme/functions.php' } },
      { text: 'Beta Forms declares it too. Click its copy and see why it is safe.',
        when: { event: 'conflict-loc', name: 'site_breadcrumbs', file: 'beta-forms/beta-forms.php' } },
      { text: 'Use the Packages filter on the left to show a single package.',
        when: { event: 'package-filter', count: 1 } },
    ],
  },
  {
    id: 'leaky-trace',
    title: 'Runtime Replay',
    tagline: 'Leaky Contact Form plus a recorded browsing session.',
    tags: ['Runtime trace', 'Coverage'],
    color: '#2f8f5b',
    dir: 'leaky-contact-form',
    trace: 'leaky-contact-form.trace.json',
    settings: { vulnScan: true },
    tab: 'runtime',
    missions: [
      { text: 'Click the delete handler the recorded session never touched.',
        when: { event: 'untested', name: 'wp_ajax_lcf_delete' } },
      { text: 'Tick "Fade files that never loaded" in the Runtime trace panel.',
        when: { event: 'dim', on: true } },
      { text: 'On the Graph, click a file with a green pip (it really loaded).',
        when: { event: 'select', observed: true } },
    ],
  },
  {
    id: 'tidy-newsletter',
    title: 'Tidy Newsletter',
    tagline: 'The well-behaved one, for comparison.',
    tags: ['Good example', 'Capability + nonce'],
    color: '#5b564a',
    dir: 'tidy-newsletter',
    settings: { vulnScan: true },
    tab: 'access',
    missions: [
      { text: 'Click the admin-only remove handler: capability and nonce are both checked.',
        when: { event: 'access-row', name: 'wp_ajax_tn_remove' } },
      { text: 'Click the public signup. It is flagged medium because anyone can write to the list: intended here, but worth confirming.',
        when: { event: 'access-row', name: 'wp_ajax_nopriv_tn_subscribe' } },
    ],
  },
];
