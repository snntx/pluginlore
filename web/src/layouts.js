// Graph layouts, kept free of DOM/canvas code so they can be unit-tested.
//
//   webLayout   force-directed "web", clustered by folder/package, with real
//               box-shaped collision (icon + label) so nothing overlaps, and
//               unconnected files tidied into a grid underneath.
//   flowLayout  layered left-to-right flow chart: entry points first, then
//               what they load, then what that calls.
//
// Both take a `measure(text) -> px` function so label widths are real.

export const FLOW_SKIP = new Set(['dom']); // associations, not flow: never used for layering

export function nodeRadius(n) {
  return 6 + Math.min(14, Math.sqrt(n.loc || 1) * 0.5) + (n.vuln ? 2 : 0);
}

const TYPE_ORDER = { php: 0, js: 1, css: 2, html: 3, json: 4, other: 5 };
const REACH_ORDER = { 'unauth-entry': 0, rest: 1, 'auth-entry': 2, entry: 3, internal: 4, asset: 5, orphan: 6 };

// Folder (or package, on whole-site scans) a file is grouped with.
export function groupKey(n) {
  if (n.package) return n.package;
  const i = n.id.indexOf('/');
  return i === -1 ? '' : n.id.slice(0, i);
}

function degrees(nodes, edges) {
  const d = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (d.has(e.source)) d.set(e.source, d.get(e.source) + 1);
    if (d.has(e.target)) d.set(e.target, d.get(e.target) + 1);
  }
  return d;
}

// Files with no relationship at all (they would otherwise float around).
export function isolatedIds(nodes, edges) {
  const d = degrees(nodes, edges);
  return new Set(nodes.filter((n) => d.get(n.id) === 0).map((n) => n.id));
}

const looseSort = (a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.id.localeCompare(b.id);

// Lay `items` out in rows inside a band starting at (cx - width/2, top).
function gridBand(items, { cx, top, cellW, cellH, maxCols, set }) {
  if (!items.length) return top;
  const cols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt(items.length * 2.2))));
  const rows = Math.ceil(items.length / cols);
  const x0 = cx - ((cols - 1) * cellW) / 2;
  items.forEach((n, i) => set(n, x0 + (i % cols) * cellW, top + Math.floor(i / cols) * cellH));
  return top + rows * cellH;
}

// ---------------------------------------------------------------- web
export function webLayout(nodes, edges, { measure = (s) => s.length * 6.5, iterations } = {}) {
  if (!nodes.length) return { looseTop: null };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = edges.filter((e) => e.source !== e.target && byId.has(e.source) && byId.has(e.target));
  const iso = isolatedIds(nodes, links);

  for (const n of nodes) {
    n._r = nodeRadius(n);
    n._w = Math.max(2 * n._r + 12, measure(n.label) + 12); // icon or label, whichever is wider
    n._h = 2 * n._r + 30;                                   // icon + ring + label line
  }
  const live = nodes.filter((n) => !iso.has(n.id));
  const loose = nodes.filter((n) => iso.has(n.id)).sort(looseSort);

  // Seed: groups on a spiral, members on a small spiral around their group centre.
  const groups = new Map();
  for (const n of live) { const g = groupKey(n); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(n); }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const GOLD = 2.399963;
  ordered.forEach(([, members], gi) => {
    const R = gi === 0 ? 0 : 160 * Math.sqrt(gi) + Math.sqrt(live.length) * 12;
    const gx = Math.cos(gi * GOLD) * R, gy = Math.sin(gi * GOLD) * R;
    members.forEach((n, i) => {
      const r = 28 * Math.sqrt(i);
      n.wx = gx + Math.cos(i * GOLD) * r; n.wy = gy + Math.sin(i * GOLD) * r;
    });
  });

  const N = live.length;
  const iters = iterations || (N <= 120 ? 320 : N <= 400 ? 220 : 140);
  const K_SPRING = 120, K_REP = 7000, CUTOFF = 280;
  const linkList = links.filter((e) => !iso.has(e.source) && !iso.has(e.target))
    .map((e) => [byId.get(e.source), byId.get(e.target)]);

  // Gravity weakens as graphs/folders grow, so big clusters don't get squeezed.
  const centerPull = 0.004 * Math.min(1, 10 / Math.sqrt(N || 1));
  const groupPull = new Map([...groups].map(([g, m]) => [g, 0.03 / Math.max(1, Math.sqrt(m.length / 15))]));
  for (let it = 0; it < iters; it++) {
    const cool = 1 - it / iters;
    for (const n of live) { n._fx = -n.wx * centerPull; n._fy = -n.wy * centerPull; } // weak pull to centre

    // short-range repulsion via a spatial grid (keeps big plugins fast)
    const grid = buildGrid(live, CUTOFF);
    for (const a of live) {
      forNeighbours(grid, a, CUTOFF, (b) => {
        if (b === a) return;
        const dx = a.wx - b.wx, dy = a.wy - b.wy;
        const d2 = dx * dx + dy * dy || 0.01;
        if (d2 > CUTOFF * CUTOFF) return;
        const f = K_REP / d2, d = Math.sqrt(d2);
        a._fx += (dx / d) * f; a._fy += (dy / d) * f;
      });
    }
    // springs
    for (const [s, t] of linkList) {
      const dx = t.wx - s.wx, dy = t.wy - s.wy, d = Math.hypot(dx, dy) || 0.01;
      const f = (d - K_SPRING) * 0.04, ux = dx / d, uy = dy / d;
      s._fx += ux * f; s._fy += uy * f; t._fx -= ux * f; t._fy -= uy * f;
    }
    // folder gravity: files of one folder settle together
    if (groups.size > 1) {
      const c = new Map();
      for (const n of live) { const g = groupKey(n); const v = c.get(g) || { x: 0, y: 0, k: 0 }; v.x += n.wx; v.y += n.wy; v.k++; c.set(g, v); }
      for (const n of live) {
        const g = groupKey(n), v = c.get(g), k = groupPull.get(g);
        n._fx += (v.x / v.k - n.wx) * k; n._fy += (v.y / v.k - n.wy) * k;
      }
    }
    const cap = 26 * cool + 2;
    for (const n of live) {
      if (n.pinned) continue;
      n.wx += Math.max(-cap, Math.min(cap, n._fx));
      n.wy += Math.max(-cap, Math.min(cap, n._fy));
    }
    if (it > iters * 0.35) separateBoxes(live, 1);
  }
  makeRoom(live);
  separateBoxes(live, 1500); // stops early once nothing overlaps

  // Unconnected files: a tidy grid under the web.
  let looseTop = null;
  if (loose.length) {
    const b = bounds(live.length ? live : loose, 'wx', 'wy');
    const cellW = Math.max(...loose.map((n) => n._w)) + 10;
    const cellH = Math.max(...loose.map((n) => n._h)) + 6;
    looseTop = (live.length ? b.maxY : 0) + 110;
    gridBand(loose, {
      cx: live.length ? (b.minX + b.maxX) / 2 : 0, top: looseTop, cellW, cellH,
      maxCols: Math.max(4, Math.floor(Math.max(900, b.maxX - b.minX) / cellW)),
      set: (n, x, y) => { n.wx = x; n.wy = y; },
    });
  }
  return { looseTop, isolated: iso };
}

function buildGrid(items, cell) {
  const g = new Map();
  for (const n of items) {
    const k = `${Math.floor(n.wx / cell)},${Math.floor(n.wy / cell)}`;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(n);
  }
  g.cell = cell;
  return g;
}
function forNeighbours(g, n, cell, fn) {
  const cx = Math.floor(n.wx / cell), cy = Math.floor(n.wy / cell);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const list = g.get(`${cx + i},${cy + j}`);
    if (list) for (const m of list) fn(m);
  }
}

// If the files need more room than the layout covers, spread positions out
// around the centre (keeps the shape, just less crowded) before separating.
function makeRoom(items, slack = 2.4) {
  if (items.length < 2) return;
  const need = items.reduce((t, n) => t + (n._w + 8) * (n._h + 8), 0) * slack;
  const b = bounds(items, 'wx', 'wy');
  const have = Math.max(1, (b.maxX - b.minX) * (b.maxY - b.minY));
  if (have >= need) return;
  const k = Math.sqrt(need / have);
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  for (const n of items) { n.wx = cx + (n.wx - cx) * k; n.wy = cy + (n.wy - cy) * k; }
}

// Axis-aligned box collision: push overlapping boxes apart along the axis
// that needs the smaller move (slightly over-corrected so crowds settle fast).
export function separateBoxes(items, passes, gap = 8) {
  const maxDim = Math.max(...items.map((n) => Math.max(n._w, n._h))) + gap;
  for (let p = 0; p < passes; p++) {
    let moved = false;
    const grid = buildGrid(items, maxDim);
    for (const a of items) {
      forNeighbours(grid, a, maxDim, (b) => {
        if (b.id <= a.id) return; // each pair once
        const ox = (a._w + b._w) / 2 + gap - Math.abs(a.wx - b.wx);
        const oy = (a._h + b._h) / 2 + gap - Math.abs(a.wy - b.wy);
        if (ox <= 0 || oy <= 0) return;
        moved = true;
        const aw = a.pinned ? 0 : b.pinned ? 1.1 : 0.55, bw = a.pinned ? 1.1 : b.pinned ? 0 : 0.55;
        if (ox < oy) {
          const dir = a.wx < b.wx ? -1 : a.wx > b.wx ? 1 : (a.id < b.id ? -1 : 1);
          a.wx += dir * ox * aw; b.wx -= dir * ox * bw;
        } else {
          const dir = a.wy < b.wy ? -1 : a.wy > b.wy ? 1 : (a.id < b.id ? -1 : 1);
          a.wy += dir * oy * aw; b.wy -= dir * oy * bw;
        }
      });
    }
    if (!moved) break;
  }
}

function bounds(items, kx, ky) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of items) {
    minX = Math.min(minX, n[kx]); maxX = Math.max(maxX, n[kx]);
    minY = Math.min(minY, n[ky]); maxY = Math.max(maxY, n[ky]);
  }
  return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------- flow
export const FLOW = { CARD_H: 30, ROW: 38, GAP_X: 72, GAP_SUB: 26, MAX_ROWS: 16, COMP_GAP: 64, MIN_W: 110, MAX_W: 300 };

export function flowLayout(nodes, edges, { measure = (s) => s.length * 7 } = {}) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Bigger plugins get more air between rows/columns so links stay readable.
  const tier = nodes.length > 400 ? 2 : nodes.length > 120 ? 1 : 0;
  const SP = {
    ROW: [FLOW.ROW, 46, 54][tier], GAP_X: [FLOW.GAP_X, 120, 170][tier], GAP_SUB: [FLOW.GAP_SUB, 46, 70][tier],
    COMP_GAP: [FLOW.COMP_GAP, 96, 130][tier], MAX_ROWS: [FLOW.MAX_ROWS, 18, 22][tier],
  };
  for (const n of nodes) {
    // +10% because the worker may measure with a fallback font slightly narrower than the real one
    n.fw = Math.max(FLOW.MIN_W, Math.min(FLOW.MAX_W, Math.ceil(measure(n.label) * 1.1) + 54));
    n.fh = FLOW.CARD_H;
  }

  // Directed links used for layering (deduplicated, no self-loops, no DOM associations).
  const out = new Map(nodes.map((n) => [n.id, []]));
  const inn = new Map(nodes.map((n) => [n.id, []]));
  const seen = new Set();
  for (const e of edges) {
    if (FLOW_SKIP.has(e.type) || e.source === e.target || !byId.has(e.source) || !byId.has(e.target)) continue;
    const k = `${e.source}>${e.target}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.get(e.source).push(e.target);
    inn.get(e.target).push(e.source);
  }
  const linked = nodes.filter((n) => out.get(n.id).length || inn.get(n.id).length);
  const loose = nodes.filter((n) => !out.get(n.id).length && !inn.get(n.id).length).sort(looseSort);

  // Weakly connected components, biggest first.
  const comp = new Map();
  const comps = [];
  for (const n of linked) {
    if (comp.has(n.id)) continue;
    const members = [];
    const stack = [n.id];
    comp.set(n.id, comps.length);
    while (stack.length) {
      const id = stack.pop();
      members.push(byId.get(id));
      for (const m of [...out.get(id), ...inn.get(id)]) if (!comp.has(m)) { comp.set(m, comps.length); stack.push(m); }
    }
    comps.push(members);
  }
  comps.sort((a, b) => b.length - a.length);

  // The main plugin file always starts the chart; then public entry points.
  const rootRank = (n) => (n.isMain ? -1e6 : 0) + (REACH_ORDER[n.reach] ?? 9) * 1000 - out.get(n.id).length;
  const backEdges = new Set();
  let y0 = 0;
  for (const members of comps) {
    const ids = new Set(members.map((n) => n.id));
    // Roots: nothing points at them; public entry points come first.
    // Links INTO the main file (helpers calling functions it defines) must not
    // push it rightwards: treat them as back links.
    for (const n of members) if (n.isMain) for (const s2 of inn.get(n.id)) if (ids.has(s2)) backEdges.add(`${s2}>${n.id}`);
    let roots = members.filter((n) => n.isMain || inn.get(n.id).every((s) => !ids.has(s)));
    if (!roots.length) roots = [members.reduce((a, b) => (rootRank(a) <= rootRank(b) ? a : b))];
    roots.sort((a, b) => rootRank(a) - rootRank(b) || a.id.localeCompare(b.id));

    // Iterative DFS: discovery order + back edges (cycles) + reverse postorder.
    const state = new Map(); const post = []; const disc = [];
    const visit = (start) => {
      const stack = [[start, 0]];
      state.set(start, 1); disc.push(start);
      while (stack.length) {
        const top = stack[stack.length - 1];
        const succ = out.get(top[0]);
        if (top[1] < succ.length) {
          const t = succ[top[1]++];
          if (!ids.has(t)) continue;
          const st = state.get(t);
          if (st === 1) backEdges.add(`${top[0]}>${t}`);
          else if (!st) { state.set(t, 1); disc.push(t); stack.push([t, 0]); }
        } else { state.set(top[0], 2); post.push(top[0]); stack.pop(); }
      }
    };
    for (const r of roots) if (!state.get(r.id)) visit(r.id);
    for (const n of members) if (!state.get(n.id)) visit(n.id);

    // Longest-path layering over forward edges.
    const layer = new Map();
    for (const id of post.slice().reverse()) {
      let L = 0;
      for (const s of inn.get(id)) if (ids.has(s) && !backEdges.has(`${s}>${id}`) && layer.has(s)) L = Math.max(L, layer.get(s) + 1);
      layer.set(id, L);
    }
    const nLayers = Math.max(...layer.values()) + 1;
    const cols = Array.from({ length: nLayers }, () => []);
    const discIdx = new Map(disc.map((id, i) => [id, i]));
    for (const n of members) cols[layer.get(n.id)].push(n);
    for (const c of cols) c.sort((a, b) => discIdx.get(a.id) - discIdx.get(b.id));

    // Crossing reduction: barycentre sweeps (down via predecessors, up via successors).
    const pos = () => { const p = new Map(); for (const c of cols) c.forEach((n, i) => p.set(n.id, i - (c.length - 1) / 2)); return p; };
    for (let sweep = 0; sweep < 8; sweep++) {
      const down = sweep % 2 === 0;
      const range = down ? [...cols.keys()].slice(1) : [...cols.keys()].reverse().slice(1);
      for (const L of range) {
        const p = pos();
        const bc = new Map();
        for (const n of cols[L]) {
          const nb = (down ? inn.get(n.id) : out.get(n.id)).filter((m) => ids.has(m) && p.has(m) && layer.get(m) !== L);
          bc.set(n.id, nb.length ? nb.reduce((t, m) => t + p.get(m), 0) / nb.length : p.get(n.id));
        }
        cols[L].sort((a, b) => bc.get(a.id) - bc.get(b.id));
      }
    }

    // The main plugin file goes to the very top of the first column.
    cols[0].sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0));

    // Coordinates: one column per layer. Very tall layers wrap into side-by-side
    // sub-columns (order kept), so the chart stays wide-and-short, not a tower.
    const slots = cols.map((c) => {
      if (c.length <= SP.MAX_ROWS) return [c];
      const k = Math.ceil(c.length / SP.MAX_ROWS), per = Math.ceil(c.length / k);
      return Array.from({ length: k }, (_, i) => c.slice(i * per, (i + 1) * per));
    });
    const tallest = Math.max(...slots.flat().map((c) => c.length));
    let x = 0;
    slots.forEach((subs, L) => {
      subs.forEach((c, si) => {
        const colW = Math.max(...c.map((n) => n.fw));
        const cx = x + colW / 2;
        const offset = ((tallest - c.length) * SP.ROW) / 2;
        c.forEach((n, i) => { n.fx = cx; n.fy = y0 + offset + i * SP.ROW; n.layer = L; });
        x += colW + (si < subs.length - 1 ? SP.GAP_SUB : SP.GAP_X);
      });
    });
    y0 += tallest * SP.ROW + SP.COMP_GAP;
  }

  // Unconnected files: a grid under the chart.
  let looseTop = null;
  if (loose.length) {
    looseTop = y0 + (comps.length ? 24 : 0);
    const cellW = Math.max(...loose.map((n) => n.fw)) + 16;
    const linkedB = linked.length ? bounds(linked, 'fx', 'fy') : { minX: 0, maxX: 900 };
    gridBand(loose, {
      cx: (linkedB.minX + linkedB.maxX) / 2, top: looseTop, cellW, cellH: SP.ROW,
      maxCols: Math.max(3, Math.floor(Math.max(900, linkedB.maxX - linkedB.minX + 200) / cellW)),
      set: (n, xx, yy) => { n.fx = xx; n.fy = yy; n.layer = -1; },
    });
  }
  return { looseTop, backEdges, components: comps.length };
}
