import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { analyze } from '../src/core/analyze.js';
import { analyzeJs } from '../src/core/js-analyze.js';
import { simulate } from '../src/core/simulate.js';
import { diffModels, orderModels, compareVersions } from '../src/core/diff.js';
import { toSarif } from '../src/core/sarif.js';
import { parseTrace, matchTrace } from '../src/core/trace.js';
import { ingestZip } from '../src/core/ingest.js';
import { loadFixture } from './helpers.js';

const v1 = () => analyze(loadFixture('sample-plugin'), { phpTarget: '8.1', vulnScan: true });
const v2 = () => analyze(loadFixture('sample-plugin-v2'), { phpTarget: '8.1', vulnScan: true });
const byName = (model, name) => model.access.find((a) => a.name === name);

test('access audit flags handlers that write without checks', () => {
  const m = v1();
  const nopriv = byName(m, 'wp_ajax_nopriv_sample_save');
  const auth = byName(m, 'wp_ajax_sample_save');
  assert.equal(nopriv.severity, 'high');
  assert.match(nopriv.message, /no nonce check/);
  assert.equal(auth.severity, 'high');
  assert.equal(auth.sharedWith, 'wp_ajax_nopriv_sample_save', 'logged-in copy judged like its public sibling');
  assert.deepEqual(auth.writes, ['$wpdb->query()']);
  assert.equal(byName(m, 'sample/v1/item').severity, 'ok'); // public but read-only
});

test('access audit accepts handlers that check capability + nonce', () => {
  const m = v2();
  assert.equal(byName(m, 'wp_ajax_sample_save').severity, 'ok');
  assert.equal(byName(m, 'wp_ajax_nopriv_sample_save').severity, 'ok'); // cap check rejects anonymous callers
  const exp = byName(m, 'wp_ajax_nopriv_sample_export');
  assert.equal(exp.severity, 'high');
  assert.deepEqual(exp.writes, ['update_option()']);
});

test('access findings are gated by the vulnerability scan', () => {
  const m = analyze(loadFixture('sample-plugin'), { vulnScan: false });
  assert.equal(m.access.length, 3, 'facts are still computed');
  assert.equal(m.nodes.flatMap((n) => n.issues).filter((i) => i.kind === 'access' || i.kind === 'vuln').length, 0);
});

test('closure callbacks and REST permission closures are audited', () => {
  const files = [{ path: 'p.php', content: `<?php
    add_action('wp_ajax_x', function () { update_option('a', 1); });
    register_rest_route('ns/v1', '/w', array('methods' => 'POST',
      'callback' => function () { wp_delete_post(1); },
      'permission_callback' => function () { return true; }));` }];
  const m = analyze(files, { vulnScan: true });
  assert.equal(byName(m, 'wp_ajax_x').severity, 'high');
  const rest = byName(m, 'ns/v1/w');
  assert.equal(rest.permission, 'open');
  assert.equal(rest.severity, 'high');
});

test('version diff orders by Version header and spots fixes + regressions', () => {
  const { oldModel, newModel, swapped } = orderModels(v2(), v1());
  assert.equal(swapped, true);
  const d = diffModels(oldModel, newModel);
  assert.equal(d.from.version, '1.0.0');
  assert.equal(d.to.version, '1.1.0');
  assert.deepEqual(d.endpoints.added.map((e) => e.name), ['wp_ajax_nopriv_sample_export']);
  assert.ok(d.access.regressions.some((r) => r.name === 'wp_ajax_nopriv_sample_export'));
  assert.ok(d.possibleFixes.some((f) => /SQL injection/.test(f.message)), 'patched SQLi shows as a possible silent fix');
  assert.deepEqual(d.files.removed, ['direct.php']);
  assert.equal(d.nodeStatus['sample-plugin.php'], 'changed');
});

test('compareVersions handles mixed version strings', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.0.0-beta', '1.0.1'), -1);
});

test('whole-site scan detects packages, fatal duplicates and performance hints', () => {
  const m = analyze(loadFixture('site'), { vulnScan: false });
  assert.equal(m.meta.packageType, 'wordpress-site');
  assert.deepEqual(m.meta.packages.map((p) => p.dir).sort(), ['plugin-a', 'plugin-b']);
  const fn = m.conflicts.find((c) => c.name === 'helper_format');
  assert.equal(fn.severity, 'high');
  assert.equal(fn.crossPackage, true);
  const cls = m.conflicts.find((c) => c.name === 'Shared_Logger');
  assert.equal(cls.severity, 'low', 'class_exists() guard makes it safe');
  const perf = m.nodes.flatMap((n) => n.issues).filter((i) => i.kind === 'perf');
  assert.equal(perf.length, 3);
  assert.ok(perf.some((p) => /get_results/.test(p.message)));
  assert.ok(perf.some((p) => /WP_Query/.test(p.message)));
  assert.ok(perf.some((p) => /posts_per_page/.test(p.message)));
});

test('namespaced functions with the same short name do not conflict', () => {
  const files = [
    { path: 'a.php', content: '<?php namespace A; function run() {}' },
    { path: 'b.php', content: '<?php namespace B; function run() {}' },
  ];
  assert.equal(analyze(files).conflicts.length, 0);
});

test('SARIF output is well-formed and covers every finding', () => {
  const m = v1();
  const s = toSarif(m, { pathPrefix: 'wp-content/plugins/sample-plugin' });
  assert.equal(s.version, '2.1.0');
  const results = s.runs[0].results;
  assert.equal(results.length, m.nodes.reduce((t, n) => t + n.issues.length, 0));
  assert.ok(results.every((r) => r.locations[0].physicalLocation.artifactLocation.uri.startsWith('wp-content/plugins/sample-plugin/')));
  const ids = new Set(results.map((r) => r.ruleId));
  for (const r of s.runs[0].tool.driver.rules) assert.ok(ids.has(r.id));
  assert.ok(s.runs[0].tool.driver.rules.some((r) => r.properties['security-severity']));
});

test('JS analysis: DOM refs, AJAX fallbacks via FormData', () => {
  const { calls, domRefs, formActions } = analyzeJs(`
    const fd = new FormData(); fd.append('action', 'my_save');
    fetch(window.myObj.ajax_url, { method: 'POST', body: fd });
    document.getElementById('panel'); jQuery('.row .cell'); $(el).find('#inner');`);
  assert.deepEqual(formActions, ['my_save']);
  assert.equal(calls[0].endpoint, 'ajax');
  assert.equal(calls[0].action, 'my_save');
  assert.equal(calls[0].fallback, true);
  assert.deepEqual(domRefs.map((d) => d.selector), ['#panel', '.row .cell', '#inner']);
});

test('JS → PHP links: ajax, rest, enqueue and DOM edges', () => {
  const types = new Set(v1().edges.map((e) => e.type));
  for (const t of ['ajax', 'rest-call', 'enqueue', 'dom', 'include', 'extends']) assert.ok(types.has(t), `missing ${t} edge`);
});

test('simulation reports BFS levels for the wave animation', () => {
  const m = v1();
  const sim = simulate(m, 'js/app.js');
  assert.equal(sim.levels['js/app.js'], 0);
  assert.equal(sim.levels['sample-plugin.php'], 1);
  assert.equal(sim.levels['includes/class-base.php'], 2);
  assert.ok(sim.maxLevel >= 2);
});

test('runtime trace matches files and entry points by path suffix', () => {
  const m = v1();
  const trace = parseTrace(JSON.stringify({
    tool: 'pluginlore-trace', version: 1, requests: [
      { kind: 'ajax', target: 'sample_save', logged_in: false, files: ['sample-plugin/sample-plugin.php', 'sample-plugin/includes/class-base.php', 'other-plugin/x.php'] },
      { kind: 'rest', target: '/sample/v1/item', logged_in: false, files: ['sample-plugin/sample-plugin.php'] },
    ],
  }));
  const t = matchTrace(m, trace);
  assert.equal(t.observed['sample-plugin.php'], 2);
  assert.equal(t.observed['includes/class-base.php'], 1);
  assert.equal(t.unmatchedFiles, 1);
  assert.equal(t.entryHits['ajax|wp_ajax_nopriv_sample_save'], 1);
  assert.equal(t.entryHits['rest|sample/v1/item'], 1);
  assert.ok(t.neverLoaded.includes('includes/class-handler.php'));
  assert.throws(() => parseTrace('{"tool":"other"}'), /not a Pluginlore Trace/);
});

test('ingest refuses path traversal and strips the wrapping folder', () => {
  const zip = zipSync({
    'my-plugin/main.php': strToU8('<?php echo 1;'),
    'my-plugin/inc/a.php': strToU8('<?php'),
    '../evil.php': strToU8('<?php'),
  });
  const { files, skipped } = ingestZip(zip);
  assert.ok(skipped.some((s) => s.name === '../evil.php' && s.reason === 'unsafe path'));
  assert.deepEqual(files.map((f) => f.path).sort(), ['inc/a.php', 'main.php']);
});

test('ingest enforces the total uncompressed size cap (zip-bomb guard)', () => {
  const big = new Uint8Array(2 * 1024 * 1024); // 2 MB of zeros compresses to almost nothing
  const zip = zipSync({ 'a.txt': big, 'b.txt': big, 'c.txt': big });
  const { files, warnings } = ingestZip(zip, { maxTotalBytes: 3 * 1024 * 1024 });
  assert.ok(files.length < 3);
  assert.ok(warnings.some((w) => /zip bomb/.test(w)));
});

test('ingest ignores macOS metadata and OS clutter, and still strips the root folder', () => {
  const zip = zipSync({
    'my-plugin/main.php': strToU8('<?php echo 1;'),
    'my-plugin/inc/a.php': strToU8('<?php'),
    'my-plugin/._main.php': new Uint8Array([0, 5, 22, 7, 0, 2, 0, 0]),
    '__MACOSX/my-plugin/._main.php': new Uint8Array([0, 5, 22, 7]),
    'my-plugin/.DS_Store': new Uint8Array([0, 0, 0, 1]),
    'my-plugin/node_modules/x/index.js': strToU8('module.exports=1'),
  });
  const { files, ignored } = ingestZip(zip);
  assert.deepEqual(files.map((f) => f.path).sort(), ['inc/a.php', 'main.php']);
  assert.equal(ignored.total, 4);
  assert.equal(ignored.byReason['macOS metadata'], 2);
});

test('binary files with a code extension are not turned into nodes', () => {
  const m = analyze([{ path: 'a.php', content: '<?php echo 1;' }, { path: 'b.php', content: '', binary: true }]);
  assert.deepEqual(m.nodes.map((n) => n.id), ['a.php']);
});

test('includes and enqueues that climb with ../ still resolve', () => {
  const m = analyze([
    { path: 'modules/a.php', content: "<?php require_once __DIR__ . '/../inc/helpers.php'; wp_enqueue_script('a', plugins_url('../assets/a.js', __FILE__));" },
    { path: 'inc/helpers.php', content: '<?php function h() {}' },
    { path: 'assets/a.js', content: 'window.a = 1;' },
  ]);
  const has = (s, t, type) => m.edges.some((e) => e.source === s && e.target === t && e.type === type);
  assert.ok(has('modules/a.php', 'inc/helpers.php', 'include'));
  assert.ok(has('modules/a.php', 'assets/a.js', 'enqueue'));
});
