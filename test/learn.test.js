import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLES } from '../samples/manifest.js';
import { packSample } from '../samples/pack.js';
import { ingestZip } from '../src/core/ingest.js';
import { analyze } from '../src/core/analyze.js';
import { buildLessons, GLOSSARY, hookPhase } from '../web/src/learn.js';

const load = (dir) => analyze(ingestZip(packSample(dir)).files, { vulnScan: true });
const plain = (html) => html.replace(/<[^>]+>/g, '').replace(/\{\{[^|]+\|([^}]+)\}\}/g, '$1');

test('every practice plugin produces a valid Learn walkthrough', () => {
  const dirs = new Set(SAMPLES.flatMap((s) => [s.dir, s.compare].filter(Boolean)));
  for (const dir of dirs) {
    const m = load(dir);
    const ids = new Set(m.nodes.map((n) => n.id));
    const { chapters, files } = buildLessons(m);
    assert.ok(chapters.length >= 1, `${dir}: no chapters`);
    for (const c of chapters) for (const s of c.steps) {
      for (const f of s.files) assert.ok(ids.has(f), `${dir}: step "${s.title}" points at missing file ${f}`);
      if (s.ping) assert.ok(ids.has(s.ping), `${dir}: bad ping start ${s.ping}`);
      for (const [, key] of s.text.matchAll(/\{\{([^|]+)\|/g)) assert.ok(GLOSSARY[key], `${dir}: unknown glossary term ${key}`);
      assert.ok(!/<(script|img|iframe)/i.test(s.text), `${dir}: unescaped markup in "${s.title}"`);
    }
    assert.equal(files.length, m.nodes.length, `${dir}: file guide must cover every file`);
  }
});

test('Learn tells the request story in plain English (Tangled Shop)', () => {
  const { chapters } = buildLessons(load('tangled-shop'));
  const req = chapters.find((c) => c.id === 'requests');
  const ajax = req.steps.find((s) => s.title.startsWith('AJAX: ts_add_to_cart'));
  assert.match(plain(ajax.text), /open to everyone, logged in or not/);
  assert.match(plain(ajax.text), /In the browser, cart\.js, wishlist\.js send this request/);
  assert.equal(req.steps.filter((s) => s.title.includes('ts_add_to_cart')).length, 1, 'public + logged-in pair is one step');
  const front = chapters.find((c) => c.id === 'front');
  assert.ok(front.steps.some((s) => /#ts-add/.test(plain(s.text)) && /render\.php puts on the page/.test(plain(s.text))));
});

test('function summaries and triggers', () => {
  const m = load('leaky-contact-form');
  const fn = (name) => m.nodes.flatMap((n) => n.fns).find((f) => f.name === name);
  assert.equal(fn('lcf_export').summary, 'Checks the security nonce, checks the user is allowed (capability), saves settings or cached data, then replies with JSON.');
  assert.ok(fn('lcf_render_form').triggers.some((t) => t.label === 'draws the [leaky_form] shortcode'));
  assert.equal(fn('lcf_render_form').summary, 'Returns HTML.');
  assert.ok(fn('delete').calledBy.some((c) => c.name === 'lcf_delete'), 'LCF_Messages::delete is called by lcf_delete');
  const main = m.nodes.find((n) => n.id === 'leaky-contact-form.php');
  assert.equal(main.role.key, 'main');
});

test('WordPress registrations are collected', () => {
  const zoo = load('class-zoo');
  const main = zoo.nodes.find((n) => n.id === 'class-zoo.php');
  assert.deepEqual(main.wp.hooks.map((h) => [h.hook, h.callback, h.priority]), [['init', 'zoo_register', 10]]);
  const helpers = zoo.nodes.find((n) => n.id === 'src/helpers.php');
  assert.deepEqual(helpers.wp.postTypes.map((p) => p.name), ['zoo_animal']);
  const iface = zoo.nodes.find((n) => n.id === 'src/interface-animal.php');
  assert.match(iface.fns[0].summary, /Only declared here/);
});

test('hook phases follow the WordPress request order', () => {
  assert.equal(hookPhase('init'), 'setup');
  assert.equal(hookPhase('wp_enqueue_scripts'), 'front');
  assert.equal(hookPhase('admin_menu'), 'admin');
  assert.equal(hookPhase('manage_posts_columns'), 'admin');
  assert.equal(hookPhase('wp_ajax_x'), 'requests');
  assert.equal(hookPhase('my_job', new Set(['my_job'])), 'cron');
  assert.equal(hookPhase('woocommerce_init'), 'other');
});

test('function parameters come with a hint and an example value', async () => {
  const m = analyze([{ path: 'p.php', content: `<?php
/** Plugin Name: T */
add_shortcode('box', 'box_render');
function box_render($atts) { $a = shortcode_atts(array('id' => 0, 'title' => ''), $atts); return '<b>' . esc_html($a['title']) . '</b>'; }
function util(int $n, $email, $opts = array()) { sanitize_email($email); return $opts['mode']; }` }]);
  const fn = (n) => m.nodes[0].fns.find((f) => f.name === n);
  assert.match(fn('box_render').params[0].hint, /attributes: id, title/);
  const [n, email, opts] = fn('util').params;
  assert.equal(n.kind, 'number');
  assert.equal(email.example, 'test@example.com');
  assert.equal(opts.optional, true);
});

test('functions list the request keys they read', () => {
  const m = load('leaky-contact-form');
  const submit = m.nodes.flatMap((n) => n.fns).find((f) => f.name === 'lcf_submit');
  assert.deepEqual(submit.request, { POST: ['name'] });
});

test('parameter names give a hint when the code gives none', () => {
  const m = load('leaky-contact-form');
  const del = m.nodes.flatMap((n) => n.fns).find((f) => f.cls === 'LCF_Messages' && f.name === 'delete');
  assert.equal(del.params[0].kind, 'number');
  assert.equal(del.params[0].example, 1);
});
