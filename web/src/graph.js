// Canvas graph renderer with two views of the same model:
//   web  - clustered force layout (file icons, labels that never collide)
//   flow - layered left-to-right flow chart (labelled cards, curved links)
// Positions come from layouts.js (computed in the worker when possible).
// Shared: pan/zoom/drag, selection focus, filters, diff badges, runtime pips,
// and the one-shot "ping" wave.

import { webLayout, flowLayout, isolatedIds, nodeRadius, groupKey, FLOW } from './layouts.js';

const REACH_COLOR = {
  'unauth-entry': '#e0433f',
  'rest': '#3150f5',
  'auth-entry': '#e8940c',
  'entry': '#5b564a',
  'internal': '#a39b8a',
  'orphan': '#c8bfa9',
  'asset': '#7d8fb8',
};
const PUBLIC = new Set(['unauth-entry', 'rest', 'auth-entry', 'entry']);
const DASH = { solid: [], dashed: [7, 5], dotted: [2, 5], dashdot: [9, 5, 2, 5] };
const SIGNAL = '#1d9a5f';

// File-type colours + short labels (familiar brand hues).
const TYPE = {
  php:  { color: '#777BB4', label: 'php' },
  js:   { color: '#c9a227', label: 'js' },
  css:  { color: '#2965f1', label: 'css' },
  html: { color: '#e34f26', label: 'html' },
  json: { color: '#6b6963', label: 'json' },
  other:{ color: '#9a958c', label: '' },
};
const LABEL_PX = 11;   // web-view label size (screen px)
const CARD_PX = 12;    // flow-view card text size (world px)

export class GraphView {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = opts.onSelect || (() => {});
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.tx = 0; this.ty = 0; this.scale = 1;
    this.mode = 'web';
    this.nodes = []; this.edges = []; this.nodeById = new Map();
    this.edgeTypes = null;            // null = every relationship type
    this.reachTypes = new Set(Object.keys(REACH_COLOR));
    this.disabled = new Set();
    this.diffStatus = {};
    this.observed = null;
    this.dimUnobserved = false;
    this.packages = null;
    this.hideIsolated = true;         // unconnected files are tucked away by default
    this.focusSelection = true;       // selecting a file dims everything unrelated
    this.isolated = new Set();
    this.keep = new Set();            // isolated but important (public / has findings): never hidden
    this.selected = null;
    this.highlight = null;          // Set of ids lit by a Learn step (null = none)
    this.hover = null;
    this.search = '';
    this.sim = null; this.simEdges = new Set(); this.simNodes = new Set(); this.simLevels = {};
    this.insets = { right: 0, bottom: 0 };
    this.cssColors = readCssColors();
    this._widths = new Map();
    this._raf = null; this._needsDraw = true; this._anim = null;
    this._bind();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._loop();
  }

  // ---------- model ----------
  setModel(model) {
    this.nodes = model.nodes.map((n) => ({
      id: n.id, label: n.label, reach: n.reachability, loc: n.loc, type: n.type || 'other',
      package: n.package || '',
      issues: n.issues.length,
      vuln: n.issues.filter((x) => x.kind === 'vuln' || (x.kind === 'access' && x.severity === 'high')).length,
      direct: n.directAccess, data: n, pinned: false, isMain: !!n.isMain,
    }));
    this.nodeById = new Map(this.nodes.map((n) => [n.id, n]));
    this.edges = model.edges.map((e) => ({ ...e, s: this.nodeById.get(e.source), t: this.nodeById.get(e.target) }))
      .filter((e) => e.s && e.t && e.s !== e.t);

    // neighbours (for selection focus) and isolation (for tidying)
    this.adj = new Map(this.nodes.map((n) => [n.id, new Set()]));
    for (const e of this.edges) { this.adj.get(e.source).add(e.target); this.adj.get(e.target).add(e.source); }
    this.isolated = isolatedIds(this.nodes, this.edges);
    this.keep = new Set(this.nodes.filter((n) => this.isolated.has(n.id) && (n.issues || PUBLIC.has(n.reach))).map((n) => n.id));

    // positions: precomputed by the worker when available, else computed here
    const L = model.layout;
    if (L && L.web && L.flow) {
      for (const n of this.nodes) {
        const w = L.web[n.id] || [0, 0], f = L.flow[n.id] || [0, 0, FLOW.MIN_W, 0];
        n.wx = w[0]; n.wy = w[1]; n.fx = f[0]; n.fy = f[1]; n.fw = f[2]; n.layer = f[3]; n.fh = FLOW.CARD_H;
      }
      this.webMeta = { looseTop: L.webLooseTop };
      this.flowMeta = { looseTop: L.flowLooseTop, backEdges: new Set(L.backEdges || []) };
    } else {
      this.webMeta = webLayout(this.nodes, this.edges, { measure: (s) => this._measure(s, LABEL_PX) });
      this.flowMeta = flowLayout(this.nodes, this.edges, { measure: (s) => this._measure(s, CARD_PX) });
      for (const n of this.nodes) n.fh = FLOW.CARD_H;
    }
    for (const n of this.nodes) { n.r = nodeRadius(n); this._place(n, this.mode); }
    this._anim = null;
    this.fit();
  }

  // ---------- view mode ----------
  setMode(mode) {
    if (mode === this.mode || !this.nodes.length) { this.mode = mode; this._needsDraw = true; return; }
    const from = new Map(this.nodes.map((n) => [n.id, [n.x, n.y]]));
    const fromView = { tx: this.tx, ty: this.ty, scale: this.scale };
    this.mode = mode;
    for (const n of this.nodes) this._place(n, mode);
    this.fit();
    const toView = { tx: this.tx, ty: this.ty, scale: this.scale };
    const to = new Map(this.nodes.map((n) => [n.id, [n.x, n.y]]));
    // morph: glide every file from its old spot to its new one
    for (const n of this.nodes) { [n.x, n.y] = from.get(n.id); }
    Object.assign(this, fromView);
    this._anim = { t0: performance.now(), ms: 520, from, to, fromView, toView };
    this._needsDraw = true;
  }
  _place(n, mode) { if (mode === 'flow') { n.x = n.fx; n.y = n.fy; } else { n.x = n.wx; n.y = n.wy; } }

  setFilters({ edgeTypes, reachTypes }) {
    if (edgeTypes) this.edgeTypes = edgeTypes;
    if (reachTypes) this.reachTypes = reachTypes;
    this._needsDraw = true;
  }
  setHideIsolated(v) { this.hideIsolated = v; this.fit(); }
  hiddenIsolatedCount() { return [...this.isolated].filter((id) => !this.keep.has(id)).length; }
  setFocusSelection(v) { this.focusSelection = v; this._needsDraw = true; }
  setDisabled(set) { this.disabled = set; this._needsDraw = true; }
  setDiffStatus(map) { this.diffStatus = map || {}; this._needsDraw = true; }
  setObserved(map, dimUnobserved = false) { this.observed = map; this.dimUnobserved = dimUnobserved; this._needsDraw = true; }
  setPackages(set) { this.packages = set; this._needsDraw = true; }
  setSearch(q) { this.search = (q || '').toLowerCase(); this._needsDraw = true; }
  select(id) { this.selected = id; this.highlight = null; this._needsDraw = true; }
  // Light up a group of files (a Learn step) and frame them.
  setHighlight(ids) {
    this.highlight = ids && ids.length ? new Set(ids) : null;
    if (this.highlight) { this.selected = null; this.fitTo([...this.highlight]); }
    this._needsDraw = true;
  }
  fitTo(ids) {
    const keep = new Set(ids);
    const list = this.nodes.filter((n) => keep.has(n.id));
    if (!list.length) return;
    // make sure hidden-but-relevant files show up
    for (const n of list) if (this.isolated.has(n.id)) this.keep.add(n.id);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of list) {
      const hw = this.mode === 'flow' ? n.fw / 2 : n.r + 40, hh = this.mode === 'flow' ? n.fh / 2 : n.r + 22;
      minX = Math.min(minX, n.x - hw); maxX = Math.max(maxX, n.x + hw);
      minY = Math.min(minY, n.y - hh); maxY = Math.max(maxY, n.y + hh);
    }
    const ins = this.insets || { right: 0 };
    const w = this.canvas.clientWidth - ins.right, h = this.canvas.clientHeight;
    const s = Math.max(0.25, Math.min(1.4, Math.min((w - 140) / Math.max(1, maxX - minX), (h - 160) / Math.max(1, maxY - minY))));
    this._anim = null;
    this.scale = s;
    this.tx = w / 2 - ((minX + maxX) / 2) * s;
    this.ty = 28 + h / 2 - ((minY + maxY) / 2) * s;
    this._needsDraw = true;
  }
  refreshColors() { this.cssColors = readCssColors(); this._widths.clear(); this._needsDraw = true; }

  // PNG snapshot of the current view (for reports), on a solid background.
  snapshot(bg = '#ffffff') {
    const c = document.createElement('canvas');
    c.width = this.canvas.width; c.height = this.canvas.height;
    const x = c.getContext('2d');
    x.fillStyle = bg; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(this.canvas, 0, 0);
    return c.toDataURL('image/png');
  }

  // ---------- simulation ----------
  setSimulation(sim) {
    this.sim = sim;
    this.simNodes = new Set(sim ? sim.visited : []);
    this.simEdges = new Set(sim ? sim.edgesUsed : []);
    this.simLevels = (sim && sim.levels) || {};
    this._simT0 = performance.now();
    this._simDone = false;
    this._fadeT0 = null;
    this._stagger = 620;   // ms between levels
    this._travel = 560;    // ms a packet takes to cross a link
    this._simDuration = (sim ? sim.maxLevel : 0) * this._stagger + this._travel + 300;
    this._needsDraw = true;
  }
  clearSimulation() {
    this.sim = null; this.simNodes = new Set(); this.simEdges = new Set(); this.simLevels = {};
    this._simDone = false; this._fadeT0 = null; this._needsDraw = true;
  }
  simDuration() { return this._simDuration || 0; }
  fadeOutSimulation(ms = 450) {
    if (!this.sim) return;
    this._fadeT0 = performance.now(); this._fadeMs = ms; this._needsDraw = true;
  }

  // ---------- visibility ----------
  _visibleNode(n) {
    if (!this.reachTypes.has(n.reach)) return false;
    if (this.packages && !this.packages.has(n.package)) return false;
    if (this.hideIsolated && this.isolated.has(n.id) && !this.keep.has(n.id)
      && this.selected !== n.id && !(this.search && n.label.toLowerCase().includes(this.search))) return false;
    return true;
  }
  _visibleEdge(e) {
    if (this.edgeTypes && !this.edgeTypes.has(e.type)) return false;
    return this._visibleNode(e.s) && this._visibleNode(e.t);
  }
  _nodeActive(n) { return !this.disabled.has(n.id); }
  // While a file is selected, everything not directly connected to it recedes.
  _focusSet() {
    if (this.highlight && this.highlight.size) return this.highlight;
    if (!this.focusSelection || !this.selected || !this.adj || !this.adj.has(this.selected)) return null;
    const s = new Set(this.adj.get(this.selected)); s.add(this.selected);
    return s;
  }

  // ---------- transforms ----------
  _toScreen(x, y) { return [x * this.scale + this.tx, y * this.scale + this.ty]; }
  _toWorld(px, py) { return [(px - this.tx) / this.scale, (py - this.ty) / this.scale]; }
  // fit({ overview: true }) always shows everything. Plain fit() does too in the
  // web view; in the flow view it opens at a readable zoom from the top-left
  // (where the entry points are) if the whole chart would be too small to read.
  fit({ overview = false } = {}) {
    const vis = this.nodes.filter((n) => this._visibleNode(n));
    if (!vis.length) { this._needsDraw = true; return; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of vis) {
      const hw = this.mode === 'flow' ? n.fw / 2 : n.r + 30, hh = this.mode === 'flow' ? n.fh / 2 : n.r + 20;
      minX = Math.min(minX, n.x - hw); maxX = Math.max(maxX, n.x + hw);
      minY = Math.min(minY, n.y - hh); maxY = Math.max(maxY, n.y + hh);
    }
    const ins = this.insets || { right: 0, bottom: 0 };
    const w = this.canvas.clientWidth - ins.right, h = this.canvas.clientHeight - ins.bottom;
    const pad = 48, top = 56; // leave room for the toolbar
    const sx = (w - pad * 2) / Math.max(1, maxX - minX);
    const sy = (h - pad - top) / Math.max(1, maxY - minY);
    let s = Math.max(0.08, Math.min(this.mode === 'flow' ? 1.3 : 2, Math.min(sx, sy)));
    // A flow chart is read, not glanced at: if it can't fit at a readable size,
    // start at the top at a readable zoom and let the wheel scroll down.
    const READABLE = 0.85;
    const read = this.mode === 'flow' && !overview && s < READABLE;
    if (read) s = READABLE;
    this.scale = s;
    this.tx = read ? pad - minX * s : w / 2 - ((minX + maxX) / 2) * s;
    this.ty = read ? top - minY * s : top + (h - top) / 2 - ((minY + maxY) / 2) * s;
    this._needsDraw = true;
  }

  // Zoom by `factor` keeping the point under (px, py) still.
  zoomAt(px, py, factor) {
    this._anim = null;
    const [wx, wy] = this._toWorld(px, py);
    this.scale = Math.max(0.06, Math.min(4, this.scale * factor));
    const [nx, ny] = this._toScreen(wx, wy);
    this.tx += px - nx; this.ty += py - ny;
    this._needsDraw = true;
  }
  zoomBy(factor) { this.zoomAt((this.canvas.clientWidth - this.insets.right) / 2, this.canvas.clientHeight / 2, factor); }

  focus(id) {
    const n = this.nodeById.get(id); if (!n) return;
    this._anim = null;
    this.scale = Math.max(this.scale, this.mode === 'flow' ? 0.9 : 1);
    this.tx = (this.canvas.clientWidth - this.insets.right) / 2 - n.x * this.scale;
    this.ty = this.canvas.clientHeight / 2 - n.y * this.scale;
    this.selected = id; this.highlight = null; this._needsDraw = true;
  }

  _measure(text, px) {
    const key = `${px}|${text}`;
    let w = this._widths.get(key);
    if (w == null) {
      this.ctx.save();
      this.ctx.font = `${px}px ${fontFamily()}`;
      w = this.ctx.measureText(text).width;
      this.ctx.restore();
      this._widths.set(key, w);
    }
    return w;
  }

  // ---------- loop ----------
  _resize() {
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = r.width * this.dpr; this.canvas.height = r.height * this.dpr;
    this._needsDraw = true;
  }
  _loop() {
    const tick = (now) => {
      if (this._anim) this._stepAnim(now);
      if (this._needsDraw || this._anim || (this.sim && (!this._simDone || this._fadeT0 != null))) this._draw();
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }
  _stepAnim(now) {
    const a = this._anim;
    const t = Math.min(1, (now - a.t0) / a.ms);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // ease in-out cubic
    for (const n of this.nodes) {
      const f = a.from.get(n.id), g = a.to.get(n.id);
      n.x = f[0] + (g[0] - f[0]) * e; n.y = f[1] + (g[1] - f[1]) * e;
    }
    this.tx = a.fromView.tx + (a.toView.tx - a.fromView.tx) * e;
    this.ty = a.fromView.ty + (a.toView.ty - a.fromView.ty) * e;
    this.scale = a.fromView.scale + (a.toView.scale - a.fromView.scale) * e;
    if (t >= 1) this._anim = null;
  }
  _simElapsed() { return performance.now() - this._simT0; }

  // ---------- drawing ----------
  _draw() {
    this._needsDraw = false;
    const ctx = this.ctx, c = this.cssColors;
    ctx.save();
    ctx.scale(this.dpr, this.dpr);
    ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    ctx.translate(this.tx, this.ty); ctx.scale(this.scale, this.scale);

    const simActive = !!this.sim;
    const elapsed = simActive ? this._simElapsed() : 0;
    if (simActive && !this._simDone && elapsed > this._simDuration) this._simDone = true;
    const sa = !simActive ? 0 : this._fadeT0 == null ? 1 : Math.max(0, 1 - (performance.now() - this._fadeT0) / this._fadeMs);
    const focus = simActive ? null : this._focusSet();
    const flow = this.mode === 'flow';
    const ctxInfo = { simActive, elapsed, sa, focus, flow };

    if (!flow) this._drawGroupCaptions(ctx);
    this._drawLooseCaption(ctx);

    // links
    for (const e of this.edges) {
      if (!this._visibleEdge(e)) continue;
      this._drawEdge(ctx, e, ctxInfo);
    }
    ctx.setLineDash([]);
    if (simActive && this._fadeT0 == null) this._drawPackets(ctx, elapsed);

    // files
    const labels = [];
    for (const n of this.nodes) {
      if (!this._visibleNode(n)) continue;
      const lvl = this.simLevels[n.id];
      const reachedNode = simActive && this.simNodes.has(n.id) && lvl != null && elapsed >= lvl * this._stagger;
      const unobserved = this.observed && this.dimUnobserved && n.type === 'php' && !this.observed[n.id];
      const simDim = simActive && !reachedNode;
      const outOfFocus = focus && !focus.has(n.id);
      let alpha = !this._nodeActive(n) ? 0.15 : unobserved ? 0.3 : simDim ? 1 - 0.7 * sa : 1;
      if (outOfFocus) alpha = Math.min(alpha, 0.16);
      const matched = this.search && n.label.toLowerCase().includes(this.search);
      if (flow) this._drawCard(ctx, n, alpha, matched);
      else {
        this._drawWebNode(ctx, n, alpha, matched);
        labels.push({ n, alpha, prio: this._labelPriority(n, matched, focus, reachedNode) });
      }
    }
    if (!flow) this._drawWebLabels(ctx, labels);
    ctx.restore();
  }

  _drawEdge(ctx, e, { simActive, elapsed, sa, focus, flow }) {
    const faded = this.disabled.has(e.source) || this.disabled.has(e.target);
    const offFocus = focus && (this.highlight && this.highlight.size
      ? !(focus.has(e.source) && focus.has(e.target))
      : !(e.source === this.selected || e.target === this.selected));
    const inSim = this.simEdges.has(`${e.source}->${e.target}`);
    const srcLevel = this.simLevels[e.source];
    const reached = inSim && srcLevel != null && elapsed >= srcLevel * this._stagger;
    const g = this._geom(e);
    const base = this.edges.length > 600 ? 0.22 : this.edges.length > 200 ? 0.38 : flow ? 0.55 : 0.5; // quieter when crowded
    let alpha = faded ? 0.1 : offFocus ? 0.05 : base - Math.min(base - 0.08, 0.38) * sa;
    if (focus && !offFocus) alpha = 0.95;
    ctx.setLineDash((DASH[e.style] || []).map((d) => d / Math.max(this.scale, 0.4)));
    ctx.lineWidth = (focus && !offFocus ? 1.8 : 1.15) / this.scale;
    ctx.strokeStyle = withAlpha(e.color, alpha);
    this._strokeGeom(ctx, g);
    if (reached && !faded && sa > 0) {
      ctx.setLineDash([]);
      ctx.lineWidth = 2.8 / this.scale;
      ctx.strokeStyle = withAlpha(SIGNAL, sa);
      this._strokeGeom(ctx, g);
    }
    if (!faded && !offFocus && sa < 0.5) this._arrowAt(ctx, g, withAlpha(e.color, Math.min(1, alpha + 0.15)));
  }

  // Link geometry: straight (web) or a smooth S-curve between card sides (flow).
  _geom(e) {
    const s = e.s, t = e.t;
    if (this.mode !== 'flow') {
      const dx = t.x - s.x, dy = t.y - s.y, d = Math.hypot(dx, dy) || 1;
      const rs = s.r + 3, rt = t.r + 5;
      return { line: true, x0: s.x + (dx / d) * rs, y0: s.y + (dy / d) * rs, x3: t.x - (dx / d) * rt, y3: t.y - (dy / d) * rt };
    }
    const forward = t.x - t.fw / 2 > s.x + s.fw / 2 + 4;
    if (forward) {
      const x0 = s.x + s.fw / 2, y0 = s.y, x3 = t.x - t.fw / 2 - 3, y3 = t.y;
      const k = Math.max(30, (x3 - x0) * 0.5);
      return { x0, y0, x1: x0 + k, y1: y0, x2: x3 - k, y2: y3, x3, y3 };
    }
    // backwards / same column: loop out under the cards
    const x0 = s.x, y0 = s.y + s.fh / 2, x3 = t.x, y3 = t.y + t.fh / 2 + 3;
    const drop = 26 + Math.abs(x3 - x0) * 0.12 + Math.abs(y3 - y0) * 0.1;
    return { back: true, x0, y0, x1: x0, y1: Math.max(y0, y3) + drop, x2: x3, y2: Math.max(y0, y3) + drop, x3, y3 };
  }
  _strokeGeom(ctx, g) {
    ctx.beginPath(); ctx.moveTo(g.x0, g.y0);
    if (g.line) ctx.lineTo(g.x3, g.y3); else ctx.bezierCurveTo(g.x1, g.y1, g.x2, g.y2, g.x3, g.y3);
    ctx.stroke();
  }
  _pointAt(g, t) {
    if (g.line) return [g.x0 + (g.x3 - g.x0) * t, g.y0 + (g.y3 - g.y0) * t];
    const u = 1 - t;
    return [
      u * u * u * g.x0 + 3 * u * u * t * g.x1 + 3 * u * t * t * g.x2 + t * t * t * g.x3,
      u * u * u * g.y0 + 3 * u * u * t * g.y1 + 3 * u * t * t * g.y2 + t * t * t * g.y3,
    ];
  }
  _arrowAt(ctx, g, color) {
    const [ax, ay] = this._pointAt(g, 1), [bx, by] = this._pointAt(g, 0.96);
    const d = Math.hypot(ax - bx, ay - by) || 1, ux = (ax - bx) / d, uy = (ay - by) / d;
    const size = 6 / Math.max(this.scale, 0.35);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - ux * size - uy * size * 0.55, ay - uy * size + ux * size * 0.55);
    ctx.lineTo(ax - ux * size + uy * size * 0.55, ay - uy * size - ux * size * 0.55);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
  }

  // Each link's packet crosses once, during its source level's time window.
  _drawPackets(ctx, elapsed) {
    for (const e of this.edges) {
      if (!this.simEdges.has(`${e.source}->${e.target}`) || !this._visibleEdge(e)) continue;
      const srcLevel = this.simLevels[e.source];
      if (srcLevel == null) continue;
      const frac = (elapsed - srcLevel * this._stagger) / this._travel;
      if (frac < 0 || frac > 1) continue;
      const [x, y] = this._pointAt(this._geom(e), frac);
      ctx.beginPath(); ctx.arc(x, y, 8 / this.scale, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(SIGNAL, 0.22); ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, 4 / this.scale, 0, Math.PI * 2);
      ctx.fillStyle = SIGNAL; ctx.fill();
    }
  }

  // ----- web view pieces -----
  _drawWebNode(ctx, n, alpha, matched) {
    const c = this.cssColors, r = n.r;
    if (n.isMain) { // the plugin's main file: marker-yellow halo, always
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 11 / this.scale, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha('#ffd23f', 0.55 * Math.max(alpha, 0.5)); ctx.fill();
      ctx.lineWidth = 1.6 / this.scale; ctx.strokeStyle = withAlpha(hexOf(c.text), 0.7 * Math.max(alpha, 0.5)); ctx.stroke();
      this._mainTag(ctx, n.x, n.y - r - 15 / this.scale);
    }
    const ty = TYPE[n.type] || TYPE.other;
    const reach = REACH_COLOR[n.reach] || '#999';
    const active = this._nodeActive(n);
    this._drawFileIcon(ctx, n.x, n.y, r, ty, alpha, active);
    ctx.beginPath(); ctx.arc(n.x, n.y, r + 4 / this.scale, 0, Math.PI * 2);
    ctx.lineWidth = (PUBLIC.has(n.reach) ? 2.4 : 1.4) / this.scale;
    ctx.setLineDash(n.reach === 'orphan' ? [3 / this.scale, 3 / this.scale] : []);
    ctx.strokeStyle = withAlpha(reach, alpha * (PUBLIC.has(n.reach) ? 0.95 : 0.55));
    ctx.stroke(); ctx.setLineDash([]);
    this._badges(ctx, n, n.x + r * 0.8, n.y - r * 0.8, n.x - r * 0.85, n.y - r * 0.85, n.x + r * 0.85, n.y + r * 0.85, alpha);
    if (this.selected === n.id || matched || this.hover === n.id) {
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 8 / this.scale, 0, Math.PI * 2);
      ctx.lineWidth = 2.2 / this.scale;
      ctx.strokeStyle = this.selected === n.id ? c.accent : matched ? c.ok : c.textMuted;
      ctx.stroke();
    }
  }

  _labelPriority(n, matched, focus, reached) {
    if (this.selected === n.id) return 1e6;
    if (this.hover === n.id) return 9e5;
    if (matched) return 8e5;
    if (n.isMain) return 8.5e5;
    let p = 0;
    if (focus && focus.has(n.id)) p += 5e5;
    if (reached) p += 3e5;
    if (PUBLIC.has(n.reach)) p += 2e4;
    p += n.issues * 500 + (this.adj.get(n.id)?.size || 0) * 100 + Math.min(n.loc || 0, 2000) / 20;
    return p;
  }

  // Labels are placed most-important-first and skipped if they'd collide with
  // another label or another file's icon, so text never piles up. Zoom in to
  // reveal more. Selected / hovered / searched labels always show.
  _drawWebLabels(ctx, items) {
    const c = this.cssColors;
    const CELL = 90;
    const grid = new Map();
    const add = (b) => {
      for (let gx = Math.floor(b[0] / CELL); gx <= Math.floor(b[2] / CELL); gx++) {
        for (let gy = Math.floor(b[1] / CELL); gy <= Math.floor(b[3] / CELL); gy++) {
          const k = `${gx},${gy}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(b);
        }
      }
    };
    const collides = (b) => {
      for (let gx = Math.floor(b[0] / CELL); gx <= Math.floor(b[2] / CELL); gx++) {
        for (let gy = Math.floor(b[1] / CELL); gy <= Math.floor(b[3] / CELL); gy++) {
          for (const o of grid.get(`${gx},${gy}`) || []) {
            if (o[4] === b[4]) continue; // a file's own icon doesn't block its label
            if (b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]) return true;
          }
        }
      }
      return false;
    };
    for (const { n } of items) { // icons are obstacles: [x0, y0, x1, y1, owner]
      const [sx, sy] = this._toScreen(n.x, n.y), rr = (n.r + 4) * this.scale;
      add([sx - rr, sy - rr, sx + rr, sy + rr, n.id]);
    }
    items.sort((a, b) => b.prio - a.prio);
    const minPrio = this.scale < 0.3 ? 5e5 : this.scale < 0.45 ? 2e4 : 0;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = `${LABEL_PX}px ${fontFamily()}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const { n, alpha, prio } of items) {
      if (prio < minPrio) continue;
      const [sx, sy] = this._toScreen(n.x, n.y);
      const w = this._measure(n.label, LABEL_PX);
      const top = sy + (n.r + 6) * this.scale;
      const box = [sx - w / 2 - 3, top - 1, sx + w / 2 + 3, top + LABEL_PX + 3, n.id];
      if (prio < 8e5 && collides(box)) continue;
      add(box);
      if (this.selected === n.id || this.hover === n.id) {
        ctx.fillStyle = hexOf(c.surface);
        ctx.fillRect(box[0] - 1, box[1] - 1, box[2] - box[0] + 2, box[3] - box[1] + 2);
      }
      ctx.fillStyle = withAlpha(hexOf(c.text), Math.max(alpha, 0.3));
      ctx.fillText(n.label, sx, top);
    }
    ctx.restore();
  }

  // Faint folder names over each cluster (web view), so the web reads as "areas".
  _drawGroupCaptions(ctx) {
    const groups = new Map();
    for (const n of this.nodes) {
      if (!this._visibleNode(n)) continue;
      const g = groupKey(n);
      const b = groups.get(g) || { minX: Infinity, maxX: -Infinity, minY: Infinity, k: 0 };
      b.minX = Math.min(b.minX, n.x); b.maxX = Math.max(b.maxX, n.x); b.minY = Math.min(b.minY, n.y - n.r); b.k++;
      groups.set(g, b);
    }
    if (groups.size < 2 || this.scale < 0.18) return;
    // Only caption folders whose area is clearly their own (mixed folders would
    // stack captions on top of each other, which is worse than no caption).
    for (const b of groups.values()) { b.maxY = -Infinity; }
    for (const n of this.nodes) {
      if (!this._visibleNode(n)) continue;
      const b = groups.get(groupKey(n)); b.maxY = Math.max(b.maxY, n.y + n.r);
    }
    const list = [...groups.entries()];
    const overlapShare = (a, b) => {
      const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
      const iy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
      const area = Math.max(1, (a.maxX - a.minX) * (a.maxY - a.minY));
      return (ix * iy) / area;
    };
    for (const [g, b] of list) b.clear = list.every(([h, o]) => h === g || overlapShare(b, o) < 0.25);
    const c = this.cssColors;
    ctx.save();
    ctx.font = `700 ${11 / this.scale}px ${fontFamily()}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = withAlpha(hexOf(c.textMuted), 0.7);
    for (const [g, b] of groups) {
      if (b.k < 2 || !b.clear) continue;
      ctx.fillText(`${g || 'root'}/`.toUpperCase(), (b.minX + b.maxX) / 2, b.minY - 30 / this.scale);
    }
    ctx.restore();
  }

  _drawLooseCaption(ctx) {
    const meta = this.mode === 'flow' ? this.flowMeta : this.webMeta;
    if (!meta || meta.looseTop == null || this._anim) return;
    const shown = this.nodes.filter((n) => this.isolated.has(n.id) && this._visibleNode(n));
    if (!shown.length) return;
    const minX = Math.min(...shown.map((n) => n.x - (this.mode === 'flow' ? n.fw / 2 : n.r)));
    const c = this.cssColors;
    ctx.save();
    ctx.font = `700 ${11 / this.scale}px ${fontFamily()}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = withAlpha(hexOf(c.textMuted), 0.8);
    const y = Math.min(...shown.map((n) => n.y)) - (this.mode === 'flow' ? FLOW.CARD_H / 2 + 10 : 34);
    ctx.fillText('NOT CONNECTED TO ANYTHING', minX, y);
    ctx.restore();
  }

  // ----- flow view pieces -----
  _drawCard(ctx, n, alpha, matched) {
    const c = this.cssColors;
    const ty = TYPE[n.type] || TYPE.other;
    const reach = REACH_COLOR[n.reach] || '#999';
    const x = n.x - n.fw / 2, y = n.y - n.fh / 2, w = n.fw, h = n.fh, rad = 7;
    const sel = this.selected === n.id;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (sel) { // hard offset shadow, like the rest of the UI
      roundRect(ctx, x + 3 / this.scale, y + 3 / this.scale, w, h, rad);
      ctx.fillStyle = hexOf(c.text); ctx.fill();
    }
    roundRect(ctx, x, y, w, h, rad);
    ctx.fillStyle = n.isMain ? '#fff0b3' : hexOf(c.surface); ctx.fill();
    ctx.lineWidth = (sel ? 2.2 : n.isMain ? 2.4 : PUBLIC.has(n.reach) ? 1.8 : 1.1) / this.scale;
    ctx.strokeStyle = sel ? c.accent : matched ? c.ok : n.isMain ? '#1c1a15' : PUBLIC.has(n.reach) ? reach : withAlpha(hexOf(c.text), 0.35);
    ctx.setLineDash(n.reach === 'orphan' ? [4 / this.scale, 3 / this.scale] : []);
    ctx.stroke(); ctx.setLineDash([]);
    // type stripe
    ctx.save(); roundRect(ctx, x, y, w, h, rad); ctx.clip();
    ctx.fillStyle = ty.color; ctx.fillRect(x, y, 5, h);
    ctx.restore();
    // text (hidden when too small to read)
    if (CARD_PX * this.scale >= 5.5) {
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      ctx.font = `700 9px ${fontFamily()}`;
      ctx.fillStyle = ty.color;
      ctx.fillText((ty.label || '').toUpperCase(), x + 11, n.y + 0.5);
      ctx.font = `${n.isMain ? '700 ' : ''}${CARD_PX}px ${fontFamily()}`;
      ctx.fillStyle = n.isMain ? '#1c1a15' : hexOf(c.text);
      ctx.fillText(ellipsize(ctx, n.label, w - 46), x + 38, n.y + 0.5);
    } else {
      ctx.fillStyle = withAlpha(hexOf(c.text), 0.25);
      ctx.fillRect(x + 12, n.y - 2, w * 0.55, 4);
    }
    ctx.restore();
    if (n.isMain) this._mainTag(ctx, x + 22, y - 8 / Math.max(this.scale, 0.6));
    this._badges(ctx, n, x + w - 2, y + 2, x + 2, y + 2, x + w - 2, y + h - 2, alpha);
  }

  // Small "MAIN" sticker: constant screen size, so it reads at any zoom.
  _mainTag(ctx, cx, cy) {
    const s = 1 / this.scale, w = 34 * s, h = 13 * s;
    ctx.save();
    roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 4 * s);
    ctx.fillStyle = '#1c1a15'; ctx.fill();
    ctx.fillStyle = '#ffd23f';
    ctx.font = `800 ${8.5 * s}px ${fontFamily()}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('MAIN', cx, cy + 0.5 * s);
    ctx.restore();
  }

  // finding dot (top-right), diff badge (top-left), runtime pip (bottom-right)
  _badges(ctx, n, vx, vy, dx, dy, ox, oy, alpha) {
    const c = this.cssColors;
    if (!this._nodeActive(n) || alpha < 0.2) return;
    if (n.vuln) {
      ctx.beginPath(); ctx.arc(vx, vy, 3.8 / this.scale, 0, Math.PI * 2);
      ctx.fillStyle = c.danger; ctx.fill();
      ctx.lineWidth = 1.2 / this.scale; ctx.strokeStyle = hexOf(c.surface); ctx.stroke();
    }
    const ds = this.diffStatus[n.id];
    if (ds) {
      const br = 6.5 / this.scale;
      ctx.beginPath(); ctx.arc(dx, dy, br, 0, Math.PI * 2);
      ctx.fillStyle = ds === 'added' ? '#2f8f5b' : '#c9821a'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.6 / this.scale; ctx.beginPath();
      const s = br * 0.5;
      if (ds === 'added') { ctx.moveTo(dx - s, dy); ctx.lineTo(dx + s, dy); ctx.moveTo(dx, dy - s); ctx.lineTo(dx, dy + s); }
      else { ctx.moveTo(dx - s, dy + s * 0.3); ctx.quadraticCurveTo(dx - s / 2, dy - s * 0.7, dx, dy); ctx.quadraticCurveTo(dx + s / 2, dy + s * 0.7, dx + s, dy - s * 0.3); }
      ctx.stroke();
    }
    if (this.observed && this.observed[n.id]) {
      ctx.beginPath(); ctx.arc(ox, oy, 4.2 / this.scale, 0, Math.PI * 2);
      ctx.fillStyle = '#2f8f5b'; ctx.fill();
      ctx.lineWidth = 1.2 / this.scale; ctx.strokeStyle = hexOf(c.surface); ctx.stroke();
    }
  }

  // Small "file card" glyph (document with a folded corner) + type label.
  _drawFileIcon(ctx, x, y, r, ty, alpha, active) {
    const w = r * 1.5, h = r * 1.9;
    const left = x - w / 2, top = y - h / 2, fold = r * 0.6;
    ctx.beginPath();
    ctx.moveTo(left, top); ctx.lineTo(left + w - fold, top); ctx.lineTo(left + w, top + fold);
    ctx.lineTo(left + w, top + h); ctx.lineTo(left, top + h); ctx.closePath();
    ctx.fillStyle = withAlpha(ty.color, active ? alpha * 0.22 : 0.1); ctx.fill();
    ctx.lineWidth = 1.6 / this.scale; ctx.strokeStyle = withAlpha(ty.color, alpha); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(left + w - fold, top); ctx.lineTo(left + w - fold, top + fold); ctx.lineTo(left + w, top + fold);
    ctx.strokeStyle = withAlpha(ty.color, alpha * 0.8); ctx.stroke();
    if (ty.label && this.scale > 0.7) {
      ctx.fillStyle = withAlpha(ty.color, alpha);
      ctx.font = `700 ${Math.min(h * 0.42, r * 0.95)}px ${fontFamily()}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(ty.label, x, y + fold * 0.3);
      ctx.textBaseline = 'alphabetic';
    }
  }

  // ---------- interaction ----------
  _nodeAt(px, py) {
    const [wx, wy] = this._toWorld(px, py);
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (!this._visibleNode(n)) continue;
      if (this.mode === 'flow') {
        if (Math.abs(wx - n.x) <= n.fw / 2 && Math.abs(wy - n.y) <= n.fh / 2) return n;
      } else {
        const r = n.r + 5 / this.scale;
        if ((n.x - wx) ** 2 + (n.y - wy) ** 2 <= r * r) return n;
      }
    }
    return null;
  }
  _bind() {
    const cv = this.canvas;
    let dragNode = null, panning = false, lastX = 0, lastY = 0, moved = false;
    cv.addEventListener('pointerdown', (ev) => {
      cv.setPointerCapture(ev.pointerId);
      this._anim = null;
      lastX = ev.offsetX; lastY = ev.offsetY; moved = false;
      const n = this._nodeAt(ev.offsetX, ev.offsetY);
      if (n) dragNode = n; else panning = true;
    });
    cv.addEventListener('pointermove', (ev) => {
      const dx = ev.offsetX - lastX, dy = ev.offsetY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (dragNode && moved) {
        dragNode.pinned = true;
        dragNode.x += dx / this.scale; dragNode.y += dy / this.scale;
        if (this.mode === 'flow') { dragNode.fx = dragNode.x; dragNode.fy = dragNode.y; }
        else { dragNode.wx = dragNode.x; dragNode.wy = dragNode.y; }
        this._needsDraw = true;
      } else if (panning) { this.tx += dx; this.ty += dy; this._needsDraw = true; }
      else if (!dragNode) {
        const h = this._nodeAt(ev.offsetX, ev.offsetY);
        const id = h ? h.id : null;
        if (id !== this.hover) { this.hover = id; cv.style.cursor = id ? 'pointer' : 'grab'; this._needsDraw = true; }
      }
      lastX = ev.offsetX; lastY = ev.offsetY;
    });
    const up = () => {
      if (dragNode && !moved) { this.selected = dragNode.id; this.highlight = null; this.onSelect(dragNode.data); this._needsDraw = true; }
      else if (!dragNode && !moved && panning) { this.selected = null; this.highlight = null; this.onSelect(null); this._needsDraw = true; }
      dragNode = null; panning = false;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { if (this.hover) { this.hover = null; this._needsDraw = true; } });
    cv.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this._anim = null;
      const zoom = ev.ctrlKey || ev.metaKey || this.mode !== 'flow';
      if (!zoom) { // flow view: wheel / two-finger scroll pans like a page
        this.tx -= ev.shiftKey ? ev.deltaY : ev.deltaX;
        this.ty -= ev.shiftKey ? 0 : ev.deltaY;
        this._needsDraw = true;
        return;
      }
      this.zoomAt(ev.offsetX, ev.offsetY, Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0018)));
    }, { passive: false });
  }
}

// ---------- helpers ----------
function fontFamily() { return getComputedStyle(document.body).fontFamily; }
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function ellipsize(ctx, text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid; else hi = mid - 1; }
  return text.slice(0, lo) + '…';
}
function readCssColors() {
  const s = getComputedStyle(document.documentElement);
  const get = (v, d) => (s.getPropertyValue(v).trim() || d);
  return {
    text: get('--text', '#1c1a15'), textMuted: get('--text-muted', '#6a6355'),
    accent: get('--accent', '#3150f5'), danger: get('--danger', '#e0433f'),
    ok: get('--ok', '#1d9a5f'), border: get('--border', '#d9d0bd'),
    surface: get('--surface', '#fffcf5'),
  };
}
function hexOf(v) { return v && v.startsWith('#') ? v : '#888888'; }
function withAlpha(hex, a) {
  const h = (hex || '#888').replace('#', '');
  const n = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const r = parseInt(n.slice(0, 2), 16), g = parseInt(n.slice(2, 4), 16), b = parseInt(n.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}

export { REACH_COLOR, PUBLIC, DASH };
