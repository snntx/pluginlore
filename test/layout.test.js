// The graph must stay readable: no overlapping files in either view, flow
// arrows run left-to-right, entry points start the chart, big plugins stay fast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webLayout, flowLayout, FLOW } from '../web/src/layouts.js';
import { packSample } from '../samples/pack.js';
import { ingestZip } from '../src/core/ingest.js';
import { analyze } from '../src/core/analyze.js';

const measure = (s) => s.length * 6.6;
const toNodes = (m) => m.nodes.map((n) => ({
  id: n.id, label: n.label, loc: n.loc, type: n.type, reach: n.reachability, package: n.package, isMain: !!n.isMain,
  vuln: n.issues.some((i) => i.kind === 'vuln'),
}));
const sample = (dir) => analyze(ingestZip(packSample(dir)).files, { vulnScan: true });

function overlaps(items, kx, ky, kw, kh) {
  const bad = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (Math.abs(a[kx] - b[kx]) < (a[kw] + b[kw]) / 2 - 0.5 && Math.abs(a[ky] - b[ky]) < (a[kh] + b[kh]) / 2 - 0.5) bad.push([a.id, b.id]);
  }
  return bad;
}

for (const dir of ['tangled-shop', 'class-zoo', 'crowded-site', 'leaky-contact-form', 'slowpoke-gallery']) {
  test(`web view: no two files overlap (${dir})`, () => {
    const m = sample(dir);
    const nodes = toNodes(m);
    webLayout(nodes, m.edges, { measure });
    assert.deepEqual(overlaps(nodes, 'wx', 'wy', '_w', '_h'), []);
  });

  test(`flow view: no overlaps, arrows point right (${dir})`, () => {
    const m = sample(dir);
    const nodes = toNodes(m);
    const { backEdges } = flowLayout(nodes, m.edges, { measure });
    for (const n of nodes) n.fh = FLOW.CARD_H;
    assert.deepEqual(overlaps(nodes, 'fx', 'fy', 'fw', 'fh'), []);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const e of m.edges) {
      if (e.type === 'dom' || e.source === e.target || backEdges.has(`${e.source}>${e.target}`)) continue;
      assert.ok(byId.get(e.target).layer > byId.get(e.source).layer, `${e.source} -> ${e.target} should point right`);
    }
  });
}

test('flow view: public entry points sit in the first column', () => {
  const m = sample('leaky-contact-form');
  const nodes = toNodes(m);
  flowLayout(nodes, m.edges, { measure });
  const entry = nodes.find((n) => n.id === 'leaky-contact-form.php');
  assert.equal(entry.layer, 0);
});

test('large plugin: 600 files lay out quickly without overlaps', () => {
  // synthetic plugin: 600 files in 12 folders, sparse includes/calls
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const nodes = Array.from({ length: 600 }, (_, i) => ({
    id: `dir${i % 12}/file-${i}.php`, label: `file-${i}.php`, loc: 20 + Math.floor(rnd() * 400),
    type: 'php', reach: i % 40 === 0 ? 'unauth-entry' : 'internal',
  }));
  const edges = [];
  for (let i = 1; i < 600; i++) if (rnd() < 0.8) edges.push({ source: nodes[Math.floor(rnd() * i)].id, target: nodes[i].id, type: rnd() < 0.7 ? 'include' : 'call' });
  const t0 = performance.now();
  webLayout(nodes, edges, { measure });
  const tWeb = performance.now() - t0;
  const t1 = performance.now();
  flowLayout(nodes, edges, { measure });
  const tFlow = performance.now() - t1;
  assert.ok(tWeb < 4000, `web layout took ${Math.round(tWeb)}ms`);
  assert.ok(tFlow < 1000, `flow layout took ${Math.round(tFlow)}ms`);
  const webBad = overlaps(nodes, 'wx', 'wy', '_w', '_h').length;
  assert.ok(webBad <= 3, `${webBad} overlapping pairs in web view`);
  for (const n of nodes) n.fh = FLOW.CARD_H;
  assert.deepEqual(overlaps(nodes, 'fx', 'fy', 'fw', 'fh'), []);
});

test('flow view: the main plugin file starts the chart even when others call into it', () => {
  const nodes = [
    { id: 'main.php', label: 'main.php', loc: 10, type: 'php', reach: 'unauth-entry', isMain: true },
    { id: 'a.php', label: 'a.php', loc: 10, type: 'php', reach: 'internal' },
    { id: 'b.php', label: 'b.php', loc: 10, type: 'php', reach: 'internal' },
  ];
  const edges = [
    { source: 'main.php', target: 'a.php', type: 'include' },
    { source: 'a.php', target: 'main.php', type: 'call' }, // a.php uses a helper defined in main.php
    { source: 'b.php', target: 'main.php', type: 'call' },
  ];
  flowLayout(nodes, edges, { measure });
  assert.equal(nodes[0].layer, 0);
  assert.ok(nodes[0].fx < nodes[1].fx);
});
