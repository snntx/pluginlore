// Runs ingestion, analysis and graph layout off the main thread so the UI stays
// responsive, streaming progress (phase + current file) to the loading screen.
import { ingestZip } from '../../src/core/ingest.js';
import { analyze } from '../../src/core/analyze.js';
import { webLayout, flowLayout } from './layouts.js';

// Text measuring for label-aware layout (OffscreenCanvas where available).
const mctx = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1).getContext('2d') : null;
const measure = (px) => (s) => {
  if (!mctx) return s.length * px * 0.6;
  mctx.font = `${px}px "Bricolage Grotesque Variable", system-ui, sans-serif`;
  return mctx.measureText(s).width;
};

function layoutFor(model) {
  const nodes = model.nodes.map((n) => ({
    id: n.id, label: n.label, loc: n.loc, type: n.type, reach: n.reachability, package: n.package, isMain: !!n.isMain,
    vuln: n.issues.some((x) => x.kind === 'vuln' || (x.kind === 'access' && x.severity === 'high')),
  }));
  const edges = model.edges.map((e) => ({ source: e.source, target: e.target, type: e.type }));
  const web = webLayout(nodes, edges, { measure: measure(11) });
  const flow = flowLayout(nodes, edges, { measure: measure(12) });
  const r = (v) => Math.round(v * 10) / 10;
  return {
    web: Object.fromEntries(nodes.map((n) => [n.id, [r(n.wx), r(n.wy)]])),
    flow: Object.fromEntries(nodes.map((n) => [n.id, [r(n.fx), r(n.fy), Math.round(n.fw), n.layer]])),
    webLooseTop: web.looseTop, flowLooseTop: flow.looseTop, backEdges: [...flow.backEdges],
  };
}

self.onmessage = (e) => {
  const { id, zip, phpTarget, vulnScan } = e.data;
  const send = (p) => self.postMessage({ id, progress: p });
  try {
    const t0 = performance.now();
    const { files, skipped, warnings, root, ignored } = ingestZip(new Uint8Array(zip), { onProgress: send });
    if (!files.some((f) => f.parse)) {
      self.postMessage({ id, error: 'No PHP or JS files found in this archive.' });
      return;
    }
    const strip = (p) => (root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p);
    const model = analyze(files, { phpTarget, vulnScan, onProgress: (p) => send(p.file ? { ...p, file: strip(p.file) } : p) });
    send({ phase: 'layout' });
    model.layout = layoutFor(model);
    send({ phase: 'finish' });
    model.meta.root = root;
    model.meta.skipped = skipped;
    model.meta.ignored = ignored;
    model.meta.warnings = warnings;
    model.meta.elapsedMs = Math.round(performance.now() - t0);
    self.postMessage({ id, model });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.stack) || err) });
  }
};
