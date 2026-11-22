// Every tutorial plugin must actually demonstrate the scenario it advertises.
// Samples are packed and ingested exactly as the browser receives them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SAMPLES, MISSION_EVENTS, missionMatches } from '../samples/manifest.js';
import { packSample, SAMPLES_DIR, sampleDirs } from '../samples/pack.js';
import { ingestZip } from '../src/core/ingest.js';
import { analyze } from '../src/core/analyze.js';
import { simulate } from '../src/core/simulate.js';
import { diffModels, orderModels } from '../src/core/diff.js';
import { parseTrace, matchTrace } from '../src/core/trace.js';

const load = (dir, opts = {}) => analyze(ingestZip(packSample(dir)).files, { vulnScan: true, ...opts });
const row = (m, name) => {
  const r = m.access.find((a) => a.name === name);
  assert.ok(r, `no access row for ${name}`);
  return r;
};
const edge = (m, source, type, target) => m.edges.some((e) => e.source === source && e.type === type && e.target === target);
const issues = (m, kind) => m.nodes.flatMap((n) => n.issues.map((i) => ({ file: n.id, ...i }))).filter((i) => !kind || i.kind === kind);

test('manifest is consistent with the samples folder', () => {
  const dirs = new Set(sampleDirs());
  for (const s of SAMPLES) {
    assert.ok(dirs.has(s.dir), `${s.id}: missing folder ${s.dir}`);
    if (s.compare) assert.ok(dirs.has(s.compare), `${s.id}: missing folder ${s.compare}`);
    if (s.trace) assert.ok(existsSync(join(SAMPLES_DIR, s.trace)), `${s.id}: missing trace ${s.trace}`);
    assert.ok(s.missions.length >= 2, `${s.id}: needs missions`);
  }
  assert.equal(new Set(SAMPLES.map((s) => s.id)).size, SAMPLES.length, 'ids are unique');
});

// Each mission's `when` rule must point at something that really exists in that
// sample's analysis, otherwise the mission could never tick itself off.
test('every mission is achievable', () => {
  for (const s of SAMPLES) {
    const settings = { vulnScan: !!s.settings.vulnScan };
    let model = load(s.dir, settings);
    let diff = null;
    if (s.compare) {
      const o = orderModels(model, load(s.compare, settings));
      model = o.newModel; diff = diffModels(o.oldModel, o.newModel);
    }
    const trace = s.trace ? matchTrace(model, parseTrace(readFileSync(join(SAMPLES_DIR, s.trace), 'utf8'))) : null;
    const ids = new Set(model.nodes.map((n) => n.id));
    const allIssues = issues(model);

    for (const m of s.missions) {
      const w = m.when;
      const where = `${s.id}: "${m.text.slice(0, 50)}…"`;
      assert.ok(w && MISSION_EVENTS.includes(w.event), `${where} has an unknown event`);
      let ok;
      switch (w.event) {
        case 'select': ok = w.observed ? trace && Object.keys(trace.observed).length > 0 : ids.has(w.id); break;
        case 'ping': ok = ids.has(w.id); break;
        case 'tab': ok = ['graph', 'access', 'findings', 'conflicts', 'changes', 'runtime'].includes(w.name); break;
        case 'access-row': ok = model.access.some((a) => missionMatches(w, 'access-row', { name: a.name, type: a.type })); break;
        case 'finding-row': ok = allIssues.some((i) => missionMatches(w, 'finding-row', { file: i.file, kind: i.kind, symbol: i.symbol })); break;
        case 'findings-kinds': ok = allIssues.some((i) => i.kind === w.only); break;
        case 'edge-filter': ok = model.edges.some((e) => e.type === w.type); break;
        case 'dim': ok = !!trace; break;
        case 'view': ok = ['web', 'flow'].includes(w.mode); break;
        case 'package-filter': ok = model.meta.packages.length > w.count; break;
        case 'conflict-loc': ok = model.conflicts.some((c) => c.locations.some((l) => missionMatches(w, 'conflict-loc', { name: c.name, file: l.file }))); break;
        case 'untested': ok = !!trace && model.access.some((a) => a.name === w.name && !trace.entryHits[`${a.type}|${a.name}`]); break;
        case 'diff-item': {
          const items = {
            regressions: diff.access.regressions.map((r) => ({ name: r.name, file: r.file })),
            'endpoints-added': diff.endpoints.added.map((e) => ({ name: e.name, file: e.file })),
            fixes: diff.possibleFixes.map((f) => ({ name: f.message.split(':')[0], file: f.file })),
            'files-added': diff.files.added.map((f) => ({ name: f, file: f })),
          }[w.section] || [];
          ok = items.some((it) => missionMatches(w, 'diff-item', { section: w.section, ...it }));
          break;
        }
      }
      assert.ok(ok, `${where} can never be completed (${JSON.stringify(w)})`);
    }
  }
});

test('Leaky Contact Form: three broken handlers, one correct', () => {
  const m = load('leaky-contact-form');
  assert.equal(row(m, 'wp_ajax_nopriv_lcf_submit').severity, 'high');
  assert.equal(row(m, 'wp_ajax_lcf_submit').severity, 'high');
  const del = row(m, 'wp_ajax_lcf_delete');
  assert.equal(del.severity, 'high');
  assert.match(del.message, /Missing capability check/);
  assert.ok(del.nonce, 'it does have a nonce, which is the lesson');
  assert.ok(del.writes.includes('$wpdb->delete()'), 'write found by following LCF_Messages::delete()');
  assert.equal(row(m, 'wp_ajax_lcf_export').severity, 'ok');
  const rest = m.access.find((a) => a.type === 'rest');
  assert.equal(rest.permission, 'open');
  assert.equal(rest.severity, 'high');
  const vulns = issues(m, 'vuln').map((i) => i.cwe);
  assert.ok(vulns.includes('CWE-89'), 'SQL injection');
  assert.ok(vulns.includes('CWE-79'), 'XSS');
});

test('Tangled Shop: JS reaches PHP via AJAX, REST, FormData fallback and DOM', () => {
  const m = load('tangled-shop', { vulnScan: false });
  assert.ok(edge(m, 'assets/cart.js', 'ajax', 'includes/cart.php'), '$.post action');
  assert.ok(edge(m, 'assets/wishlist.js', 'rest-call', 'includes/cart.php'), 'fetch REST');
  assert.ok(edge(m, 'assets/cart.js', 'dom', 'includes/render.php'), '#ts-add rendered by render.php');
  assert.ok(edge(m, 'assets/wishlist.js', 'dom', 'includes/render.php'), '.ts-wish rendered by render.php');
  assert.equal(m.edges.filter((e) => e.type === 'enqueue').length, 3);
  const wl = m.nodes.find((n) => n.id === 'assets/wishlist.js');
  assert.ok(wl.jsCalls.some((c) => c.kind === 'xhr' && c.fallback && c.action === 'ts_add_to_cart'), 'FormData fallback');
  assert.equal(row(m, 'wp_ajax_nopriv_ts_add_to_cart').severity, 'medium');
  assert.equal(m.access.find((a) => a.type === 'rest').severity, 'ok');
  const sim = simulate(m, 'assets/cart.js');
  assert.ok(sim.visited.includes('includes/cart.php'), 'signal crosses JS → PHP');
});

test('Class Zoo: inheritance, overrides, traits, orphan, direct access', () => {
  const m = load('class-zoo');
  const parrot = m.edges.find((e) => e.type === 'extends' && e.child === 'Zoo_Parrot');
  assert.deepEqual(parrot.overrides.sort(), ['describe', 'speak']);
  assert.ok(m.edges.some((e) => e.type === 'extends' && e.child === 'Zoo_Lion'));
  assert.ok(m.edges.some((e) => e.type === 'implements' && e.iface === 'Zoo_Animal'));
  assert.equal(m.edges.filter((e) => e.type === 'use-trait').length, 2);
  assert.ok(edge(m, 'class-zoo.php', 'hook', 'src/helpers.php'), 'init hook → helpers');
  assert.ok(edge(m, 'class-zoo.php', 'call', 'src/helpers.php'), 'zoo_log() call');
  assert.equal(m.nodes.find((n) => n.id === 'src/old-aviary.php').reachability, 'orphan');
  const feed = m.nodes.find((n) => n.id === 'feeding-times.php');
  assert.equal(feed.directAccess, true);
  assert.ok(feed.issues.some((i) => i.cwe === 'CWE-79'));
});

test('Slowpoke Gallery: N+1 queries, HTTP in a loop, unbounded queries', () => {
  const perf = issues(load('slowpoke-gallery', { vulnScan: false }), 'perf');
  const has = (re) => perf.some((p) => re.test(p.message));
  assert.ok(has(/\$wpdb->get_var/));
  assert.ok(has(/new WP_Query/));
  assert.ok(perf.some((p) => p.symbol === 'wp_remote_get' && p.severity === 'high'));
  assert.ok(has(/'posts_per_page' => -1/));
  assert.ok(has(/'number' => -1/));
  assert.ok(has(/get_posts\(\) runs once per iteration/));
});

test('Version Drama: one silent fix, one removed check, one new public endpoint', () => {
  const { oldModel, newModel } = orderModels(load('version-drama-1.5.0'), load('version-drama-1.4.0'));
  assert.equal(oldModel.meta.packageVersion, '1.4.0');
  const d = diffModels(oldModel, newModel);
  assert.ok(d.access.regressions.some((r) => r.name === 'wp_ajax_vd_save_settings' && /Removed capability check/.test(r.change)));
  assert.ok(d.endpoints.added.some((e) => e.name === 'vd/v1/webhook'));
  assert.ok(d.access.regressions.some((r) => r.name === 'vd/v1/webhook'));
  assert.ok(d.possibleFixes.some((f) => f.file === 'includes/export.php' && /SQL injection/.test(f.message)));
  assert.deepEqual(d.files.added, ['includes/webhook.php']);
  assert.deepEqual(d.files.removed, ['includes/legacy-import.php']);
});

test('Crowded Site: three packages, two fatal clashes, one safe guard', () => {
  const m = load('crowded-site', { vulnScan: false });
  assert.equal(m.meta.packageType, 'wordpress-site');
  assert.deepEqual(m.meta.packages.map((p) => p.kind).sort(), ['plugin', 'plugin', 'theme']);
  const c = (name) => m.conflicts.find((x) => x.name === name);
  assert.equal(c('site_breadcrumbs').severity, 'high');
  assert.ok(c('site_breadcrumbs').locations.some((l) => l.package === 'beta-forms' && l.guarded));
  assert.equal(c('format_phone').severity, 'high');
  assert.equal(c('Site_Cache').severity, 'low');
});

test('Runtime Replay: trace matches and exposes untested handlers', () => {
  const m = load('leaky-contact-form');
  const t = matchTrace(m, parseTrace(readFileSync(join(SAMPLES_DIR, 'leaky-contact-form.trace.json'), 'utf8')));
  assert.equal(t.matchedRequests, 5);
  assert.equal(t.unmatchedFiles, 1, 'akismet is outside this package');
  assert.equal(t.entryHits['ajax|wp_ajax_nopriv_lcf_submit'], 2);
  assert.equal(t.entryHits['ajax|wp_ajax_lcf_export'], 1);
  assert.ok(!t.entryHits['ajax|wp_ajax_lcf_delete'], 'delete was never exercised');
  assert.equal(t.coverage, 1);
});

test('Tidy Newsletter: no high-risk handlers, public signup flagged for review', () => {
  const m = load('tidy-newsletter');
  assert.ok(!m.access.some((a) => a.severity === 'high'), JSON.stringify(m.access.map((a) => [a.name, a.severity])));
  assert.equal(row(m, 'wp_ajax_tn_remove').severity, 'ok');
  assert.equal(row(m, 'wp_ajax_nopriv_tn_subscribe').severity, 'medium');
  assert.equal(row(m, 'wp_ajax_tn_subscribe').sharedWith, 'wp_ajax_nopriv_tn_subscribe');
  assert.equal(m.access.find((a) => a.type === 'rest').severity, 'ok');
  assert.equal(issues(m, 'vuln').length, 0);
  const js = m.nodes.find((n) => n.id === 'assets/signup.js');
  assert.ok(js.jsCalls.some((c) => c.action === 'tn_subscribe'), 'URLSearchParams action');
});
