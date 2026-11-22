import { GraphView, REACH_COLOR, DASH } from './graph.js';
import { EDGE_STYLE } from '../../src/core/styles.js';
import { simulate, expectedInputs } from '../../src/core/simulate.js';
import { generateProbes } from '../../src/core/probes.js';
import { diffModels, orderModels } from '../../src/core/diff.js';
import { parseTrace, matchTrace } from '../../src/core/trace.js';
import { buildReport } from './report.js';
import { Loader } from './loader.js';
import { startTour } from './tour.js';
import { SAMPLES, missionMatches } from '../../samples/manifest.js';
import { buildLessons, GLOSSARY } from './learn.js';
import * as wporg from './wporg.js';
import { extractFiles } from '../../src/core/ingest.js';
import { stepChunks } from './harness.js';

// Build-time gate (web/build.js injects this). Also the site owner's master switch.
const VULN_ENABLED = typeof __VULN_ENABLED__ !== 'undefined' ? __VULN_ENABLED__ : true;


const REACH_LABEL = {
  'unauth-entry': 'Public · unauthenticated',
  'rest': 'Public · REST API',
  'auth-entry': 'Public · requires login',
  'entry': 'Runnable entry',
  'internal': 'Internal only',
  'orphan': 'Orphan / unused',
  'asset': 'Front-end asset (JS/CSS)',
};
const EDGE_LABEL = {
  include: 'Includes / requires', extends: 'Class inheritance', implements: 'Implements interface',
  'use-trait': 'Uses trait', call: 'Function call', hook: 'Hook → callback',
  ajax: 'JS → AJAX endpoint', 'rest-call': 'JS → REST endpoint', enqueue: 'Enqueues asset',
  dom: 'JS ↔ DOM element',
};
const KIND_LABEL = { vuln: 'Vulnerability', access: 'Access control', perf: 'Performance', conflict: 'Duplicate' };
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4, ok: 5 };

const $ = (id) => document.getElementById(id);

const state = {
  primary: null,        // { buffer, name }
  compare: null,        // { buffer, name }
  primaryModel: null,
  compareModel: null,
  model: null,          // the model shown in the graph (newer one when comparing)
  diff: null,
  traceRaw: null,
  trace: null,
  tab: 'learn',
  findingKinds: new Set(['vuln', 'access', 'perf', 'conflict']),
  gen: 0,
  sample: null,         // the practice plugin currently loaded (if any)
  afterLoad: null,      // one-shot callback after the next model renders
  pendingSample: null,  // sample waiting on the security-scan disclaimer
};
let view = null;
let loader = null;
let tour = null;
let disabled = new Set();
let currentNodeId = null;
let simActive = false;

function init() {
  view = new GraphView($('graph'), { onSelect: (n) => showInspector(n) });
  view.mode = store.get('sl-view') === 'web' ? 'web' : 'flow'; // Flow is the default
  syncViewToggle();
  $('viewToggle').querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => setViewMode(b.dataset.view)));
  $('hideIsoToggle').onchange = () => { view.setHideIsolated($('hideIsoToggle').checked); };
  $('focusToggle').onchange = () => view.setFocusSelection($('focusToggle').checked);
  loader = new Loader($('loader'));
  // canvas labels use the web font: redraw once it has arrived
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => view.refreshColors());

  // practice plugins + tour
  renderGallery($('heroGallery'));
  renderGallery($('galleryGrid'));
  $('samplesBtn').onclick = openGallery;
  $('railSamples').onclick = openGallery;
  $('galleryClose').onclick = () => $('galleryModal').classList.add('hidden');
  $('galleryModal').addEventListener('click', (e) => { if (e.target === $('galleryModal')) $('galleryModal').classList.add('hidden'); });
  $('heroPick').onclick = () => $('fileInput').click();
  $('tourBtn').onclick = runTour;
  $('heroTour').onclick = runTour;
  $('wporgBtn').onclick = openWporg;
  $('runClose').onclick = () => $('runModal').classList.add('hidden');
  $('runGo').onclick = runNow;
  $('runReset').onclick = () => { if (runner) runner.reset(); setRunStatus('Sandbox reset. It starts fresh on the next run.'); };
  $('heroWporg').onclick = openWporg;
  $('wporgClose').onclick = () => $('wporgModal').classList.add('hidden');
  $('wporgModal').addEventListener('click', (e) => { if (e.target === $('wporgModal')) $('wporgModal').classList.add('hidden'); });
  $('wporgQuery').oninput = () => { clearTimeout(wp.timer); wp.timer = setTimeout(runWporgSearch, 320); };
  $('wporgQuery').onkeydown = (e) => { if (e.key === 'Enter') { clearTimeout(wp.timer); runWporgSearch(); } };
  $('wporgModal').querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => {
    wp.kind = b.dataset.kind;
    $('wporgModal').querySelectorAll('[data-kind]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    runWporgSearch();
  }));
  document.addEventListener('click', (e) => {
    const term = e.target.closest && e.target.closest('.term');
    if (term) { e.stopPropagation(); showTerm(term); return; }
    if (!e.target.closest || !e.target.closest('.term-pop')) hideTerm();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    hideTerm();
    ['galleryModal', 'reportModal', 'wporgModal', 'runModal'].forEach((id) => $(id).classList.add('hidden'));
    if (simActive && !tour) stopSim();
  });
  // Deep links from the landing page: #practice opens the practice plugins, #wporg the directory search
  const hash = location.hash;
  if (hash.includes('practice')) setTimeout(openGallery, 50);
  else if (hash.includes('wporg')) setTimeout(openWporg, 50);
  if (!store.get('sl-tour-done') && !hash.includes('notour') && !hash.includes('practice') && !hash.includes('wporg')) setTimeout(runTour, 700);

  // theme
  const saved = store.get('sl-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('themeBtn').onclick = () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    store.set('sl-theme', next);
    view.refreshColors();
  };

  // primary package
  wireDrop($('dropzone'), $('fileInput'), (f) => loadPrimary(f));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && f.name.toLowerCase().endsWith('.zip')) loadPrimary(f);
  });

  // compare
  wireDrop($('compareDrop'), $('compareInput'), (f) => loadCompare(f));

  // runtime trace
  $('traceBtn').onclick = () => $('traceInput').click();
  $('traceInput').onchange = (e) => { const f = e.target.files[0]; if (f) loadTrace(f); e.target.value = ''; };
  $('dimToggle').onchange = () => {
    view.setObserved(state.trace ? state.trace.observed : null, $('dimToggle').checked);
    emit('dim', { on: $('dimToggle').checked });
  };

  // options
  if (!VULN_ENABLED) $('vulnRow').classList.add('hidden');
  $('vulnToggle').onchange = (e) => {
    if (e.target.checked) { e.target.checked = false; $('disclaimer').classList.remove('hidden'); }
    else analyzeAll();
  };
  $('disclaimerAccept').onclick = () => {
    $('disclaimer').classList.add('hidden');
    $('vulnToggle').checked = true;
    const pending = state.pendingSample; state.pendingSample = null;
    if (pending) loadSample(pending); else analyzeAll();
  };
  $('disclaimerCancel').onclick = () => {
    $('disclaimer').classList.add('hidden');
    // a practice plugin still loads, just without the security checks
    const pending = state.pendingSample; state.pendingSample = null;
    if (pending) loadSample(pending, { skipScan: true });
  };

  // graph toolbar
  $('fitBtn').onclick = () => view.fit({ overview: true });
  $('zoomIn').onclick = () => view.zoomBy(1.25);
  $('zoomOut').onclick = () => view.zoomBy(0.8);
  $('clearSimBtn').onclick = clearSim;
  $('search').oninput = (e) => view.setSearch(e.target.value);
  $('search').onkeydown = (e) => {
    if (e.key === 'Enter' && state.model) {
      const q = e.target.value.toLowerCase();
      const hit = state.model.nodes.find((n) => n.label.toLowerCase().includes(q));
      if (hit) { view.focus(hit.id); showInspector(hit); }
    }
  };

  // tabs
  $('tabs').querySelectorAll('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

  // report
  $('reportBtn').onclick = openReport;
  $('reportCancel').onclick = () => $('reportModal').classList.add('hidden');
  $('reportDownload').onclick = () => exportReport('download');
  $('reportPrint').onclick = () => exportReport('print');
  $('rLogo').onchange = onLogoPicked;
  $('rLogoClear').onclick = () => { store.del('sl-logo'); $('rLogoPreview').classList.add('hidden'); $('rLogo').value = ''; };
}

function wireDrop(zone, input, onFile) {
  zone.onclick = () => input.click();
  zone.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } };
  input.onchange = (e) => { const f = e.target.files[0]; if (f) onFile(f); e.target.value = ''; };
  ['dragover', 'dragenter'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); zone.classList.add('drag'); }));
  zone.addEventListener('dragleave', (e) => { e.preventDefault(); zone.classList.remove('drag'); });
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); zone.classList.remove('drag');
    const f = e.dataTransfer.files[0]; if (f) onFile(f);
  });
}

// ---------- loading + analysis ----------
async function loadPrimary(file) {
  if (!file.name.toLowerCase().endsWith('.zip')) return toast('Please choose a .zip file.');
  state.primary = { buffer: await file.arrayBuffer(), name: file.name };
  state.compare = null;
  state.traceRaw = null; state.trace = null;
  state.sample = null; hideMission();
  state.afterLoad = () => switchTab('learn'); // learn first: open the walkthrough
  analyzeAll();
}

async function loadCompare(file) {
  if (!state.primary) return toast('Load the main package first, then drop the version to compare.');
  if (!file.name.toLowerCase().endsWith('.zip')) return toast('Please choose a .zip file.');
  state.compare = { buffer: await file.arrayBuffer(), name: file.name };
  analyzeAll();
}

function removeCompare() {
  state.compare = null; state.compareModel = null;
  state.model = state.primaryModel; state.diff = null;
  rematchTrace();
  onModel();
}

function runJob(buffer, opts, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      if (e.data.progress) { onProgress && onProgress(e.data.progress); return; }
      w.terminate();
      e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.model);
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'Worker failed')); };
    // copy the buffer so it isn't detached (lets us re-run on option changes)
    w.postMessage({ id: 1, zip: buffer.slice(0), ...opts });
  });
}

async function analyzeAll({ keepLoader = false } = {}) {
  if (!state.primary) return;
  const gen = ++state.gen;
  const opts = { vulnScan: VULN_ENABLED && $('vulnToggle').checked };
  $('stageHint').classList.add('hidden');
  const keys = state.compare ? ['a', 'b'] : ['a'];
  const title = state.sample ? `Loading ${state.sample.title}`
    : state.compare ? 'Spinning two webs…' : `Spinning ${state.primary.name.replace(/\.zip$/i, '')}…`;
  if (!keepLoader) loader.start(title, keys);
  try {
    const jobs = [runJob(state.primary.buffer, opts, (p) => gen === state.gen && loader.update('a', p))];
    if (state.compare) jobs.push(runJob(state.compare.buffer, opts, (p) => gen === state.gen && loader.update('b', p)));
    const [a, b] = await Promise.all(jobs);
    if (gen !== state.gen) return; // a newer run superseded this one
    a.meta.fileName = state.primary.name;
    state.primaryModel = a;
    if (b) {
      b.meta.fileName = state.compare.name;
      state.compareModel = b;
      const { oldModel, newModel } = orderModels(a, b);
      state.model = newModel;
      state.diff = diffModels(oldModel, newModel);
    } else {
      state.compareModel = null; state.model = a; state.diff = null;
    }
    rematchTrace();
    // draw the result underneath the finished loader, then let it fade away
    await loader.finish(() => onModel());
  } catch (err) {
    if (gen !== state.gen) return;
    loader.fail(err.message.split('\n')[0]);
    $('stageHint').textContent = 'Could not read that archive: ' + err.message.split('\n')[0];
    $('stageHint').classList.remove('hidden');
  }
}

function onModel() {
  const model = state.model;
  $('stageHint').classList.add('hidden');
  if (!/^wordpress-/.test(model.meta.packageType)) {
    $('stageHint').textContent = 'This doesn\'t look like a WordPress plugin or theme (no plugin header or theme style.css). Pluginlore is built for WordPress, so some parts may be empty.';
    $('stageHint').classList.add('notice');
    $('stageHint').classList.remove('hidden');
  } else $('stageHint').classList.remove('notice');
  $('hero').classList.add('hidden');
  $('tableView').classList.toggle('hidden', state.tab === 'graph');
  $('graphToolbar').classList.toggle('hidden', state.tab !== 'graph');
  disabled = new Set();
  view.setDisabled(disabled);
  view.setModel(model);
  view.setHideIsolated($('hideIsoToggle').checked);
  const iso = view.hiddenIsolatedCount();
  $('isoCount').textContent = iso ? `(${iso})` : '';
  view.setDiffStatus(state.diff ? state.diff.nodeStatus : {});
  view.setObserved(state.trace ? state.trace.observed : null, $('dimToggle').checked);
  view.setPackages(null);
  renderStats();
  renderPkgInfo();
  renderCompareInfo();
  renderTraceInfo();
  renderPackageFilters();
  renderEdgeFilters();
  renderReachFilters();
  applyFilters(); // keep the graph in sync with the freshly rendered checkboxes
  renderLegend();
  renderTabCounts();
  clearSim();
  showInspector(null);
  $('reportBtn').disabled = false;
  $('traceBtn').disabled = false;
  if (state.tab !== 'graph') renderTable(state.tab);
  const w = model.meta.warnings || [];
  if (w.length) toast(`${w.length} warning(s) while reading the archive`);
  const after = state.afterLoad; state.afterLoad = null;
  if (after) after();
}

async function loadTrace(file) {
  if (!state.model) return;
  try {
    state.traceRaw = parseTrace(await file.text());
  } catch (e) { return toast(e.message); }
  rematchTrace();
  view.setObserved(state.trace.observed, $('dimToggle').checked);
  renderTraceInfo();
  renderTabCounts();
  renderLegend();
  if (state.tab === 'runtime') renderTable('runtime');
  toast(`Trace: ${state.trace.matchedRequests} of ${state.trace.totalRequests} requests matched this package`);
}
function rematchTrace() {
  state.trace = state.traceRaw && state.model ? matchTrace(state.model, state.traceRaw) : null;
}

// ---------- practice plugins ----------
function renderGallery(host) {
  host.innerHTML = SAMPLES.map((s) => `
    <button class="sample-card" style="--c:${s.color}" data-sample="${s.id}">
      <h4>${esc(s.title)}</h4>
      <p>${esc(s.tagline)}</p>
      <div class="tags">${s.tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>
      <span class="go">Open <svg class="icon xs"><use href="#i-arrow"/></svg></span>
    </button>`).join('');
  host.querySelectorAll('[data-sample]').forEach((b) => (b.onclick = () => {
    $('galleryModal').classList.add('hidden');
    loadSample(SAMPLES.find((s) => s.id === b.dataset.sample));
  }));
}
function openGallery() { $('galleryModal').classList.remove('hidden'); }

// Loads a practice plugin (and its comparison version / trace, if any).
// Resolves once the graph is drawn, so the tour can await it.
async function loadSample(sample, { skipScan = false } = {}) {
  const wantsScan = sample.settings.vulnScan && VULN_ENABLED && !skipScan;
  if (wantsScan && !$('vulnToggle').checked) {
    // the security checks need the user's OK first
    state.pendingSample = sample;
    $('disclaimer').classList.remove('hidden');
    return;
  }
  const fetchZip = async (dir) => {
    const res = await fetch(`samples/${dir}.zip`);
    if (!res.ok) throw new Error(`Practice plugin "${dir}" is missing from this build.`);
    return { buffer: await res.arrayBuffer(), name: `${dir}.zip` };
  };
  try {
    state.primary = await fetchZip(sample.dir);
    state.compare = sample.compare ? await fetchZip(sample.compare) : null;
    state.traceRaw = sample.trace ? parseTrace(await (await fetch(`samples/${sample.trace}`)).text()) : null;
  } catch (err) { return toast(err.message); }
  state.sample = sample;
  state.afterLoad = () => {
    switchTab(sample.tab || 'graph');
    showMission(sample); // refits the graph around the note first…
    if (sample.focus) {  // …then centre the sample's featured file
      const n = state.model.nodes.find((x) => x.id === sample.focus);
      if (n) { view.focus(n.id); showInspector(n); }
    }
  };
  await analyzeAll();
}

// ---------- missions: tick themselves off as the user does them ----------
const missionKey = (s) => `sl-mission-${s.id}`;
function missionDone(s) {
  try { return JSON.parse(store.get(missionKey(s)) || '[]'); } catch { return []; }
}

// The UI reports what the user just did; any open mission it satisfies ticks.
function emit(event, payload = {}) {
  const s = state.sample;
  if (!s) return;
  const done = missionDone(s);
  const fresh = [];
  s.missions.forEach((m, i) => {
    if (!done.includes(i) && missionMatches(m.when, event, payload)) { done.push(i); fresh.push(i); }
  });
  if (!fresh.length) return;
  store.set(missionKey(s), JSON.stringify(done));
  const el = $('mission');
  if (el.classList.contains('hidden')) showMission(s); // bring the note back to show progress
  for (const i of fresh) {
    const li = el.querySelector(`li[data-i="${i}"]`);
    if (li) { li.classList.add('done', 'just'); setTimeout(() => li.classList.remove('just'), 900); }
  }
  updateMissionMeter(s, done);
  toast(done.length === s.missions.length
    ? `All ${s.missions.length} ${s.title} missions done`
    : `Mission done: ${s.missions[fresh[0]].text.split(/[.:]/)[0]}`, done.length === s.missions.length ? 'i-party' : 'i-check');
}

function showMission(sample) {
  const done = missionDone(sample);
  const el = $('mission');
  el.classList.remove('hidden', 'collapsed');
  el.innerHTML = `
    <header>
      <div><b>${esc(sample.title)}</b><div class="progress" data-m="progress"></div></div>
      <div>
        <button class="btn small ghost icon-btn" data-m="toggle" title="Fold"><svg class="icon"><use href="#i-minus"/></svg></button>
        <button class="btn small ghost icon-btn" data-m="close" title="Close"><svg class="icon"><use href="#i-x"/></svg></button>
      </div>
    </header>
    <div class="meter"><i data-m="meter"></i></div>
    <ol>${sample.missions.map((m, i) => `
      <li data-i="${i}" class="${done.includes(i) ? 'done' : ''}" role="checkbox" aria-checked="${done.includes(i)}" tabindex="0">
        <span class="mbox"><svg class="icon"><use href="#i-check"/></svg></span><span>${esc(m.text)}</span>
      </li>`).join('')}
    </ol>`;
  el.querySelector('[data-m="close"]').onclick = hideMission;
  el.querySelector('[data-m="toggle"]').onclick = () => {
    el.classList.toggle('collapsed');
    el.querySelector('[data-m="toggle"] use').setAttribute('href', el.classList.contains('collapsed') ? '#i-plus' : '#i-minus');
    reserveForMission();
  };
  // Missions tick automatically, but a click still toggles one by hand.
  el.querySelectorAll('li[data-i]').forEach((li) => {
    const flip = () => {
      const i = Number(li.dataset.i);
      let d = missionDone(sample);
      d = d.includes(i) ? d.filter((x) => x !== i) : [...d, i];
      store.set(missionKey(sample), JSON.stringify(d));
      li.classList.toggle('done', d.includes(i));
      li.setAttribute('aria-checked', d.includes(i));
      updateMissionMeter(sample, d);
    };
    li.onclick = flip;
    li.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); } };
  });
  updateMissionMeter(sample, done);
  reserveForMission();
}

function updateMissionMeter(sample, done) {
  const el = $('mission');
  const p = el.querySelector('[data-m="progress"]');
  if (!p) return;
  p.textContent = `${done.length} / ${sample.missions.length} missions`;
  el.querySelector('[data-m="meter"]').style.width = `${(done.length / sample.missions.length) * 100}%`;
  el.classList.toggle('all-done', done.length === sample.missions.length);
  el.querySelectorAll('li[data-i]').forEach((li) => li.setAttribute('aria-checked', li.classList.contains('done')));
}
function hideMission() { $('mission').classList.add('hidden'); reserveForMission(); }

// Keep the graph clear of the mission note: shift the fitted area left while
// the note is open (only on wide stages; on narrow ones it sits below).
function reserveForMission() {
  const el = $('mission');
  const stage = $('stageBody').clientWidth;
  const open = !el.classList.contains('hidden') && !el.classList.contains('collapsed') && stage > 700;
  view.insets = { right: open ? el.offsetWidth + 24 : 0, bottom: 0 };
  $('stageBody').classList.toggle('has-mission', open);
  if (state.model) view.fit();
}

// ---------- first-run tour ----------
function runTour() {
  if (tour) return;
  $('galleryModal').classList.add('hidden');
  const shop = SAMPLES.find((s) => s.id === 'tangled-shop');
  // Use whatever is already open; only load the practice shop on a blank slate.
  const ensureShop = async () => { if (!state.model) await loadSample(shop); };
  const focusSomething = () => {
    const nodes = state.model ? state.model.nodes : [];
    const pick = nodes.find((n) => n.id === 'assets/cart.js')
      || nodes.find((n) => n.type === 'js' && n.jsCalls.length)
      || nodes.find((n) => n.entryPoints.length) || nodes[0];
    if (pick) focusNode(pick.id);
  };
  const steps = [
    { title: 'Hi! This is Pluginlore', target: null,
      body: 'It explains how a WordPress plugin works, in plain English, and maps every file so you can poke at it. One minute, a few stops. We\'ll load a practice plugin so there\'s something to look at.' },
    { title: 'Start with a zip', target: () => $('panelPackage'), placement: 'right',
      body: 'Drop any plugin, theme or PHP library here. It\'s read <b>inside your browser</b>: nothing is uploaded. No zip handy? There are practice plugins.' },
    { title: 'Any plugin, any version', target: () => $('wporgBtn'), placement: 'right',
      body: 'Search the WordPress.org directory, pick a plugin or theme and any of its past versions, or two versions to compare. The zip comes straight from WordPress.org to your browser.' },
    { title: 'Learn how it works', target: () => $('tabLearn'), placement: 'bottom', before: async () => { await ensureShop(); switchTab('learn'); },
      body: 'The <b>Learn</b> tab walks through the plugin in the order WordPress runs it: how it boots, what it sets up, what visitors see, what the admin gets, which requests it answers. Every file and function is explained in plain English, and you can <b>Run</b> any function in a throwaway WordPress inside your browser.' },
    { title: 'Web or flow chart', target: () => $('viewToggle'), placement: 'bottom', before: async () => { await ensureShop(); switchTab('graph'); },
      body: '<b>Web</b> clusters files by folder. <b>Flow</b> lines them up left to right: entry points first, then whatever they load and call. Same data, two ways to read it.' },
    { title: 'This is the web', target: () => $('stageBody'), placement: 'inside', before: ensureShop,
      body: 'Each card is a file: <b>php</b>, <b>js</b>, <b>css</b>. Lines are threads: includes, inheritance, hooks, JS calling PHP. The ring says who can reach it; <b>bold red</b> means anyone on the internet.' },
    { title: 'Every file tells you things', target: () => $('inspector'), placement: 'left',
      before: async () => { await ensureShop(); focusSomething(); },
      body: 'Click a file to see who can reach it, what input it expects, what it outputs, plus ready-made <b>curl</b> probes to try on your own test site.' },
    { title: 'Ping a signal', target: () => $('pingBtn'), placement: 'left',
      body: 'Sends one wave through the web from this file, level by level, so you can see where a request could travel: here from JavaScript straight into PHP. Try it after the tour.' },
    { title: 'Tables for the serious bits', target: () => $('tabs'), placement: 'bottom',
      body: `<b>Access</b> lists every request handler with a ${tick(true)} or ${tick(false)} for its capability and nonce checks. <b>Findings</b> collects problems. Extra tabs appear when you compare versions or import a trace.` },
    { title: 'Look for security problems', target: () => $('vulnRow'), placement: 'right',
      body: 'Switch on the security checks to see who can call what, and which code patterns look risky. You\'ll get a short heads-up first: these are leads, not verdicts.' },
    { title: 'What changed in the update?', target: () => $('panelCompare'), placement: 'right',
      body: 'Drop a second version to see new endpoints, removed checks, and bugs that were fixed without a word in the changelog.' },
    { title: 'Hand it to a client', target: () => $('reportBtn'), placement: 'bottom',
      body: 'Export a tidy report with your name and logo, as HTML or PDF.' },
    { title: 'Now go break things (safely)', target: () => $('samplesBtn'), placement: 'bottom',
      body: 'Eight practice plugins, each hiding something, each with missions. You can replay this tour any time from <b>Tour</b>.' },
  ];
  tour = startTour(steps, { onEnd: () => { tour = null; store.set('sl-tour-done', '1'); } });
}

// ---------- left rail ----------
function renderStats() {
  const m = state.model.meta, s = state.model.stats;
  const chips = [
    `<span class="chip"><b>${esc(m.packageType)}</b></span>`,
    `<span class="chip"><b>${m.fileCount}</b> php</span>`,
    `<span class="chip"><b>${m.jsCount || 0}</b> js</span>`,
    `<span class="chip"><b>${(s.byReach['unauth-entry'] || 0) + (s.byReach.rest || 0)}</b> public</span>`,
  ];
  if (m.vulnScan) {
    const high = (s.accessBySeverity.high || 0);
    chips.push(`<span class="chip ${high ? 'danger' : ''}"><b>${high}</b> access high</span>`);
    chips.push(`<span class="chip ${s.vuln ? 'danger' : ''}"><b>${s.vuln}</b> vuln patterns</span>`);
  }
  if (s.perf) chips.push(`<span class="chip"><b>${s.perf}</b> perf</span>`);
  if (s.conflictsHigh) chips.push(`<span class="chip danger"><b>${s.conflictsHigh}</b> fatal duplicates</span>`);
  if (m.parseErrors) chips.push(`<span class="chip">${m.parseErrors} parse error(s)</span>`);
  $('stats').innerHTML = chips.join('');
}

function renderPkgInfo() {
  const m = state.model.meta;
  $('pkgInfo').classList.remove('hidden');
  const shown = state.diff ? state.model.meta.fileName : state.primary.name;
  const src = state.primary && state.primary.wporg;
  $('pkgInfo').innerHTML = `
    <div class="kv"><span>${esc(shown || 'package')}</span><span>${m.fileCount} php</span></div>
    ${src ? `<div class="kv"><span>Source</span><span><a href="https://wordpress.org/${src.kind === 'theme' ? 'themes' : 'plugins'}/${esc(src.slug)}/" target="_blank" rel="noopener">WordPress.org</a></span></div>` : ''}
    ${m.packageName ? `<div class="kv"><span>${esc(m.packageName)}</span><span>${esc(m.packageVersion || '')}</span></div>` : ''}
    <div class="kv"><span>Type</span><span>${esc(m.packageType)}</span></div>
    ${m.packages.length > 1 ? `<div class="kv"><span>Packages</span><span>${m.packages.length}</span></div>` : ''}
    <div class="kv"><span>Total files</span><span>${m.totalFiles}</span></div>
    ${m.skipped && m.skipped.length ? `<div class="kv"><span>Skipped</span><span>${m.skipped.length}</span></div>` : ''}
    ${m.ignored && m.ignored.total ? `<div class="kv" title="${esc(Object.entries(m.ignored.byReason).map(([k, v]) => `${v} ${k}`).join(', '))}"><span>Ignored junk</span><span>${m.ignored.total} file${m.ignored.total === 1 ? '' : 's'}</span></div>` : ''}`;
}

function renderCompareInfo() {
  const el = $('compareInfo');
  if (!state.diff) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  const d = state.diff, s = d.summary;
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="kv"><span>${esc(d.from.version || 'old')} → ${esc(d.to.version || 'new')}</span><span>graph shows newer</span></div>
    <div class="kv"><span>Endpoints</span><span>+${s.endpointsAdded} / −${s.endpointsRemoved}</span></div>
    <div class="kv"><span>Access regressions</span><span>${s.accessRegressions}</span></div>
    <div class="kv"><span>Possible fixes</span><span>${s.possibleFixes}</span></div>
    <button class="link-btn" id="compareView">View changes</button> · <button class="link-btn" id="compareRemove">Remove</button>`;
  $('compareView').onclick = () => switchTab('changes');
  $('compareRemove').onclick = removeCompare;
}

function renderTraceInfo() {
  const el = $('traceInfo');
  $('dimRow').classList.toggle('hidden', !state.trace);
  if (!state.trace) { el.classList.add('hidden'); return; }
  const t = state.trace;
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="kv"><span>Requests matched</span><span>${t.matchedRequests} / ${t.totalRequests}</span></div>
    <div class="kv"><span>PHP files loaded</span><span>${Math.round(t.coverage * 100)}%</span></div>
    <button class="link-btn" id="traceView">View runtime</button> · <button class="link-btn" id="traceRemove">Remove</button>`;
  $('traceView').onclick = () => switchTab('runtime');
  $('traceRemove').onclick = () => {
    state.traceRaw = null; state.trace = null;
    view.setObserved(null); renderTraceInfo(); renderTabCounts(); renderLegend();
    if (state.tab === 'runtime') switchTab('graph');
  };
}

function renderPackageFilters() {
  const pk = state.model.meta.packages;
  const panel = $('packagesPanel');
  if (pk.length < 2) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  const dirs = [...new Set(state.model.nodes.map((n) => n.package))];
  const name = (d) => (pk.find((p) => p.dir === d) || { name: d }).name;
  $('packageFilters').innerHTML = dirs.map((d) => `
    <label class="filter"><input type="checkbox" data-pkg="${esc(d)}" checked />
      <span>${esc(name(d))}</span><span class="count">${state.model.nodes.filter((n) => n.package === d).length}</span></label>`).join('');
  $('packageFilters').querySelectorAll('input').forEach((cb) => (cb.onchange = () => {
    const visible = [...$('packageFilters').querySelectorAll('input:checked')].map((c) => c.dataset.pkg);
    view.setPackages(new Set(visible));
    emit('package-filter', { count: visible.length });
  }));
}

function renderEdgeFilters() {
  const counts = state.model.stats.byEdge || {};
  $('edgeFilters').innerHTML = Object.keys(EDGE_STYLE).map((type) => {
    const st = EDGE_STYLE[type];
    const dash = (DASH[st.style] || []).length ? `border-top-style:${st.style === 'dotted' ? 'dotted' : 'dashed'}` : 'border-top-style:solid';
    return `<label class="filter"><input type="checkbox" data-edge="${type}" checked />
      <span class="swatch" style="border-top-color:${st.color};${dash}"></span>
      <span>${EDGE_LABEL[type]}</span><span class="count">${counts[type] || 0}</span></label>`;
  }).join('');
  $('edgeFilters').querySelectorAll('input').forEach((cb) => (cb.onchange = () => {
    applyFilters();
    emit('edge-filter', { type: cb.dataset.edge, on: cb.checked });
  }));
}

function renderReachFilters() {
  const counts = state.model.stats.byReach || {};
  const order = ['unauth-entry', 'rest', 'auth-entry', 'entry', 'internal', 'orphan', 'asset'];
  $('reachFilters').innerHTML = order.map((r) => `
    <label class="filter"><input type="checkbox" data-reach="${r}" checked />
      <span class="dot" style="background:${REACH_COLOR[r]}"></span>
      <span>${REACH_LABEL[r]}</span><span class="count">${counts[r] || 0}</span></label>`).join('');
  $('reachFilters').querySelectorAll('input').forEach((cb) => (cb.onchange = applyFilters));
}

function renderLegend() {
  $('legend').innerHTML = `
    <div class="item"><span class="tag" style="color:#777BB4;border-color:#777BB4">php</span> <span class="tag" style="color:#c9a227;border-color:#c9a227">js</span> <span class="tag" style="color:#2965f1;border-color:#2965f1">css</span> File-type icons</div>
    <div class="item"><span class="dot" style="background:transparent;border:2px solid ${REACH_COLOR['unauth-entry']}"></span> Ring = reachability (bold ring = public)</div>
    <div class="item"><span class="dot" style="background:var(--danger)"></span> Red dot = finding (vuln / high access risk)</div>
    ${state.diff ? '<div class="item"><span class="dot" style="background:#2f8f5b"></span> + added &nbsp;<span class="dot" style="background:#c9821a"></span> ~ changed since the older version</div>' : ''}
    ${state.trace ? '<div class="item"><span class="dot" style="background:#2f8f5b;box-shadow:0 0 0 2px var(--surface)"></span> Green pip = loaded at runtime</div>' : ''}
    <div class="item"><svg class="icon" style="color:#1d9a5f"><use href="#i-bolt"/></svg> Green wave = a pinged signal's path</div>
    <div class="item"><svg class="icon"><use href="#i-target"/></svg> Click a file to spotlight its links; click empty space to clear</div>`;
}

function applyFilters() {
  const edgeTypes = new Set([...$('edgeFilters').querySelectorAll('input:checked')].map((c) => c.dataset.edge));
  const reachTypes = new Set([...$('reachFilters').querySelectorAll('input:checked')].map((c) => c.dataset.reach));
  view.setFilters({ edgeTypes, reachTypes });
}

// ---------- tabs + table views ----------
function renderTabCounts() {
  const m = state.model;
  const accessBad = m.meta.vulnScan ? m.access.filter((a) => ['high', 'medium'].includes(a.severity)).length : 0;
  setCount('tabCountAccess', m.access.length ? (accessBad ? `${accessBad}/${m.access.length}` : m.access.length) : '', accessBad > 0);
  const findings = m.nodes.reduce((t, n) => t + n.issues.length, 0);
  setCount('tabCountFindings', findings || '', false);
  // Guarded duplicates (function_exists polyfills etc.) are safe: only real clashes earn the tab.
  const showConf = m.stats.conflictsHigh > 0 || m.meta.packages.length > 1;
  $('tabConflicts').classList.toggle('hidden', !showConf);
  setCount('tabCountConflicts', m.stats.conflictsHigh || '', m.stats.conflictsHigh > 0);
  $('tabChanges').classList.toggle('hidden', !state.diff);
  if (state.diff) setCount('tabCountChanges', state.diff.summary.accessRegressions || '', state.diff.summary.accessRegressions > 0);
  $('tabRuntime').classList.toggle('hidden', !state.trace);
  const current = document.querySelector(`.tab[data-tab="${state.tab}"]`);
  if (current && current.classList.contains('hidden')) switchTab('graph');
}
function setCount(id, val, bad) { const el = $(id); el.textContent = val === '' ? '' : String(val); el.classList.toggle('bad', !!bad); }

function switchTab(name) {
  state.tab = name;
  $('tabs').querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  const graph = name === 'graph';
  // Nothing loaded yet: every tab shows the welcome screen instead of an empty table
  $('tableView').classList.toggle('hidden', graph || !state.model);
  $('graphToolbar').classList.toggle('hidden', !graph || !state.model);
  $('simStatus').classList.toggle('hidden', !graph);
  if (!graph && state.model) renderTable(name);
  emit('tab', { name });
}

function renderTable(name) {
  if (!state.model) { $('tableView').innerHTML = '<div class="empty-state">Load a package first.</div>'; return; }
  const html = { learn: tableLearn, access: tableAccess, findings: tableFindings, conflicts: tableConflicts, changes: tableChanges, runtime: tableRuntime }[name]();
  $('tableView').innerHTML = html;
  if (name === 'learn') bindLearn();
  // Row clicks select the file in the inspector but keep you on the table;
  // rows also report what was clicked so missions can tick.
  $('tableView').querySelectorAll('[data-focus],[data-ev]').forEach((el) => (el.onclick = (e) => {
    e.stopPropagation();
    if (el.dataset.ev) { const p = JSON.parse(el.dataset.ev); emit(p.e, p); }
    if (el.dataset.focus) focusNode(el.dataset.focus, { stay: true });
  }));
  $('tableView').querySelectorAll('[data-kind]').forEach((el) => (el.onclick = () => {
    const k = el.dataset.kind;
    state.findingKinds.has(k) ? state.findingKinds.delete(k) : state.findingKinds.add(k);
    renderTable('findings');
    emit('findings-kinds', { only: state.findingKinds.size === 1 ? [...state.findingKinds][0] : null });
  }));
}
const ev = (e, p) => `data-ev="${esc(JSON.stringify({ e, ...p }))}"`;

function tableAccess() {
  const m = state.model, scan = m.meta.vulnScan;
  if (!m.access.length) return '<div class="empty-state">No AJAX, admin-post or REST handlers were found in this package.</div>';
  const rows = [...m.access].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  return `
    <div class="tv-head"><h2>Access-control audit</h2><span class="muted small">${m.access.length} handler(s)</span></div>
    <p class="tv-note">For every AJAX, admin-post and REST handler: who can call it, whether the handler (or a helper it calls) checks capability, login and a nonce, and whether it changes data. Presence of a check is detected, not that it's enforced correctly.</p>
    ${scan ? '' : `<div class="tv-banner">Risk verdicts are part of the security checks. Turn them on in the left panel to see them. The ${tick(true)} / ${tick(false)} columns below are shown either way.</div>`}
    <table class="data"><thead><tr>
      ${scan ? '<th>Risk</th>' : ''}<th>Endpoint</th><th>Who can call</th><th>Capability</th><th>Login</th><th>Nonce</th><th>Changes data</th><th>Handler</th>${scan ? '<th>Assessment</th>' : ''}
    </tr></thead><tbody>
    ${rows.map((a) => `<tr class="click" data-focus="${esc(a.handlerFile || a.file)}" ${ev('access-row', { name: a.name, type: a.type })}>
      ${scan ? `<td>${sevPill(a.severity)}</td>` : ''}
      <td class="ep"><code>${esc(a.name)}</code><div class="muted small">${esc(a.file)}:${a.line}</div></td>
      <td>${a.type === 'rest' ? `REST · ${esc(a.permission || '?')}` : a.auth === 'unauth' ? 'Anyone' : 'Logged-in users'}</td>
      <td>${tick(a.cap)}</td><td>${tick(a.login)}</td><td>${tick(a.nonce)}</td>
      <td>${a.writes.length ? `<code>${esc(a.writes.join(', '))}</code>` : '<span class="muted">-</span>'}</td>
      <td>${a.resolved ? `<code>${esc(a.callback || '')}</code>${a.helpers.length ? `<div class="muted small">via ${esc(a.helpers.join(', '))}</div>` : ''}` : '<span class="muted">not resolved</span>'}</td>
      ${scan ? `<td class="wide">${esc(a.message)}</td>` : ''}
    </tr>`).join('')}
    </tbody></table>`;
}

function tableFindings() {
  const m = state.model;
  const all = m.nodes.flatMap((n) => n.issues.map((i) => ({ file: n.id, ...i })));
  const counts = {};
  for (const f of all) counts[f.kind] = (counts[f.kind] || 0) + 1;
  const rows = all.filter((f) => state.findingKinds.has(f.kind))
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  return `
    <div class="tv-head"><h2>Findings</h2>
      <div class="chips-row">${Object.keys(KIND_LABEL).map((k) => `<span class="chip toggle ${state.findingKinds.has(k) ? 'on' : ''}" data-kind="${k}">${KIND_LABEL[k]} <b>${counts[k] || 0}</b></span>`).join('')}</div>
    </div>
    ${m.meta.vulnScan ? '' : '<div class="tv-banner">Vulnerability and access-control findings appear when the vulnerability scan is on.</div>'}
    ${rows.length ? `<table class="data"><thead><tr><th>Severity</th><th>Type</th><th>Location</th><th>Detail</th></tr></thead><tbody>
      ${rows.map((f) => `<tr class="click" data-focus="${esc(f.file)}" ${ev('finding-row', { file: f.file, kind: f.kind, symbol: f.symbol || null })}>
        <td>${sevPill(f.severity)}</td>
        <td>${esc(KIND_LABEL[f.kind] || f.kind)}${f.cwe ? `<div class="muted small">${esc(f.cwe)}</div>` : ''}</td>
        <td><code>${esc(f.file)}:${f.line}</code></td>
        <td>${esc(f.message)}${f.confidence ? `<div class="muted small">${esc(f.confidence)} confidence</div>` : ''}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty-state">Nothing to show for the selected types.</div>'}`;
}

function tableConflicts() {
  const m = state.model;
  const pk = m.meta.packages;
  return `
    <div class="tv-head"><h2>Packages &amp; duplicate declarations</h2></div>
    ${pk.length > 1 ? `<div class="cards">${pk.map((p) => `<div class="card"><div class="n" style="font-size:15px">${esc(p.name)}</div><div class="l">${esc(p.kind)} · ${esc(p.dir)} · v${esc(p.version || '?')} · ${p.fileCount} files</div></div>`).join('')}</div>` : ''}
    <p class="tv-note">Global functions and classes declared in more than one file. Unguarded duplicates stop PHP with a fatal "Cannot redeclare" error when both files load, which is a classic cause of "activating plugin X breaks the site".</p>
    ${m.conflicts.some((c) => c.severity === 'high') ? `<table class="data"><thead><tr><th>Risk</th><th>Symbol</th><th>Declared in</th></tr></thead><tbody>
      ${m.conflicts.filter((c) => c.severity === 'high').map((c) => `<tr>
        <td>${sevPill(c.severity)}</td>
        <td><code>${esc(c.name)}</code><div class="muted small">${esc(c.message)}</div></td>
        <td>${c.locations.map((l) => `<div class="click" data-focus="${esc(l.file)}" ${ev('conflict-loc', { name: c.name, file: l.file })} style="cursor:pointer"><code>${esc(l.file)}:${l.line}</code>${l.guarded ? ' <span class="muted small">guarded</span>' : ''}</div>`).join('')}</td>
      </tr>`).join('')}</tbody></table>` : '<div class="empty-state">No duplicates that would crash the site.</div>'}
    ${m.conflicts.some((c) => c.severity !== 'high') ? `<details class="lesson-file" style="margin-top:14px"><summary>Safe duplicates (guarded by *_exists checks) <span class="muted small">${m.conflicts.filter((c) => c.severity !== 'high').length}</span></summary>
      <p class="muted small">Declared in more than one file, but each copy is wrapped in function_exists() / class_exists(), so only one is ever used. Common in bundled libraries and polyfills.</p>
      <ul class="tv-list">${m.conflicts.filter((c) => c.severity !== 'high').slice(0, 200).map((c) => `<li><code>${esc(c.name)}</code> <span class="muted small">${c.locations.map((l) => esc(l.file)).join(', ')}</span></li>`).join('')}</ul></details>` : ''}`;
}

function tableChanges() {
  const d = state.diff;
  if (!d) return '<div class="empty-state">Drop a second version in "Compare versions" to see what changed.</div>';
  const s = d.summary;
  const has = (id) => state.model.nodes.some((n) => n.id === id);
  const li = (file, html, payload) => `<li class="${has(file) || payload ? 'click' : ''}" ${has(file) ? `data-focus="${esc(file)}"` : ''} ${payload ? ev('diff-item', payload) : ''}>${html}</li>`;
  const sec = (title, items) => (items.length ? `<div class="tv-section"><h3>${title} (${items.length})</h3><ul class="tv-list">${items.join('')}</ul></div>` : '');
  return `
    <div class="tv-head"><h2>${esc(d.from.name || 'Package')}: ${esc(d.from.version || 'old')} → ${esc(d.to.version || 'new')}</h2></div>
    <div class="cards">
      ${card(`+${s.filesAdded} −${s.filesRemoved} ~${s.filesChanged}`, 'files added / removed / changed')}
      ${card(`+${s.endpointsAdded} −${s.endpointsRemoved}`, 'entry points', s.endpointsAdded ? 'warn' : '')}
      ${card(s.accessRegressions, 'access regressions', s.accessRegressions ? 'bad' : 'good')}
      ${card(s.possibleFixes, 'possible silent fixes', s.possibleFixes ? 'warn' : '')}
      ${card(`+${s.issuesAdded} −${s.issuesRemoved}`, 'findings added / removed')}
    </div>
    ${state.model.meta.vulnScan ? '' : '<div class="tv-banner">Turn on the vulnerability scan to include vulnerability and access findings in this comparison.</div>'}
    ${sec('Access regressions', d.access.regressions.map((r) => li(r.file, `${sevPill(r.severity)} <code>${esc(r.name)}</code>: ${esc(r.change)}<div class="muted small">${esc(r.detail || '')}</div>`, { section: 'regressions', name: r.name, file: r.file })))}
    ${sec('New entry points', d.endpoints.added.map((e) => li(e.file, `<code>${esc(e.name)}</code> · ${esc(e.type)} · ${esc(e.auth)} <span class="muted small">${esc(e.file)}</span>`, { section: 'endpoints-added', name: e.name, file: e.file })))}
    ${sec('Removed entry points', d.endpoints.removed.map((e) => `<li><code>${esc(e.name)}</code> · ${esc(e.type)} <span class="muted small">${esc(e.file)}</span></li>`))}
    ${sec('Auth changed', d.endpoints.authChanged.map((c) => li(c.after.file, `<code>${esc(c.after.name)}</code>: ${esc(c.before.auth)}${c.before.permission ? ` (${esc(c.before.permission)})` : ''} → ${esc(c.after.auth)}${c.after.permission ? ` (${esc(c.after.permission)})` : ''}`)))}
    ${sec('Possible silent security fixes', d.possibleFixes.map((f) => li(f.file, `<code>${esc(f.file)}${f.line ? ':' + f.line : ''}</code> <span class="muted small">(${esc(f.kind)}, gone in the newer version)</span><div>${esc(f.message)}</div>`, { section: 'fixes', name: f.message.split(':')[0], file: f.file })))}
    ${sec('Access improvements', d.access.improvements.map((a) => li(a.file, `<code>${esc(a.name)}</code>: ${esc(a.change)}`)))}
    ${sec('New findings', d.issues.added.map((i) => li(i.file, `${sevPill(i.severity)} <code>${esc(i.file)}:${i.line}</code> ${esc(i.message)}`, { section: 'findings-added', name: i.symbol || null, file: i.file })))}
    ${sec('Files added', d.files.added.map((f) => li(f, `<code>${esc(f)}</code>`, { section: 'files-added', name: f, file: f })))}
    ${sec('Files removed', d.files.removed.map((f) => `<li><code>${esc(f)}</code></li>`))}
    ${sec('Files changed', d.files.changed.map((f) => li(f.id, `<code>${esc(f.id)}</code> <span class="muted small">${f.locDelta >= 0 ? '+' : ''}${f.locDelta} lines</span>`)))}`;
}

function tableRuntime() {
  const t = state.trace;
  if (!t) return '<div class="empty-state">Import a Pluginlore Trace export to compare the static graph with real requests.</div>';
  const m = state.model;
  const handlers = m.access.map((a) => ({ ...a, hits: t.entryHits[`${a.type}|${a.name}`] || 0 }));
  const untested = handlers.filter((h) => !h.hits);
  return `
    <div class="tv-head"><h2>Runtime trace</h2><span class="muted small">${t.totalRequests} recorded request(s)</span></div>
    <p class="tv-note">Files the companion plugin saw PHP load during real requests on your test site. Static analysis says what <em>could</em> run; this shows what <em>did</em>.</p>
    <div class="cards">
      ${card(t.matchedRequests, 'requests touching this package')}
      ${card(`${Math.round(t.coverage * 100)}%`, 'of PHP files loaded', t.coverage < 0.5 ? 'warn' : 'good')}
      ${card(handlers.length - untested.length + ' / ' + handlers.length, 'handlers exercised', untested.length ? 'warn' : 'good')}
      ${card(t.unmatchedFiles, 'trace paths outside this package')}
    </div>
    ${untested.length ? `<div class="tv-section"><h3>Handlers never called during the trace (${untested.length})</h3><ul class="tv-list">${untested.map((h) => `<li class="click" data-focus="${esc(h.file)}" ${ev('untested', { name: h.name })}><code>${esc(h.name)}</code> · ${esc(h.type)} · ${h.auth === 'unauth' ? 'anyone' : 'logged-in'}${m.meta.vulnScan && ['high', 'medium'].includes(h.severity) ? ` ${sevPill(h.severity)}` : ''}</li>`).join('')}</ul></div>` : ''}
    <div class="tv-section"><h3>Requests</h3><ul class="tv-list">${t.requests.slice(0, 100).map((r) => `<li><code>${esc(r.kind)} ${esc(r.target)}</code> ${r.count} time${r.count === 1 ? '' : 's'} <span class="muted small">${r.files.length} file(s)</span></li>`).join('')}</ul></div>
    ${t.neverLoaded.length ? `<div class="tv-section"><h3>PHP files never loaded (${t.neverLoaded.length})</h3><ul class="tv-list">${t.neverLoaded.slice(0, 200).map((f) => `<li class="click" data-focus="${esc(f)}"><code>${esc(f)}</code></li>`).join('')}</ul></div>` : ''}`;
}

// Select a file: centre it on the graph and open it in the inspector.
// `stay` keeps the current table tab open (the graph is updated underneath).
function focusNode(id, { stay = false } = {}) {
  const n = state.model && state.model.nodes.find((x) => x.id === id);
  if (!n) return;
  if (!stay) switchTab('graph');
  view.focus(id);
  showInspector(n);
}

// ---------- inspector ----------
function showInspector(node) {
  if (!node) { currentNodeId = null; $('inspectorEmpty').classList.remove('hidden'); $('inspectorBody').classList.add('hidden'); return; }
  currentNodeId = node.id;
  $('inspectorEmpty').classList.add('hidden');
  const body = $('inspectorBody'); body.classList.remove('hidden');
  const m = state.model;
  const isDisabled = disabled.has(node.id);
  const inputs = expectedInputs(node);
  const probes = generateProbes(node);
  const status = state.diff && state.diff.nodeStatus[node.id];
  const seen = state.trace && state.trace.observed[node.id];
  const handled = m.access.filter((a) => a.handlerFile === node.id && a.file !== node.id);
  const pkgName = m.meta.packages.length > 1 ? (m.meta.packages.find((p) => p.dir === node.package) || { name: node.package }).name : null;
  const parents = m.edges.filter((e) => e.source === node.id && e.type === 'extends');

  body.innerHTML = `
    <h3 class="insp-title">${esc(node.label)}</h3>
    <div class="insp-path">${esc(node.path)}</div>
    <div class="badges">
      <span class="badge reach-${node.reachability}">${REACH_LABEL[node.reachability]}</span>
      ${pkgName ? `<span class="badge">${esc(pkgName)}</span>` : ''}
      ${status ? `<span class="badge" style="color:${status === 'added' ? 'var(--ok)' : 'var(--warn)'}"><svg class="icon xs"><use href="#${status === 'added' ? 'i-plus' : 'i-pulse'}"/></svg> ${status === 'added' ? 'new in' : 'changed in'} ${esc(state.diff.to.version || 'newer version')}</span>` : ''}
      ${state.trace ? `<span class="badge" style="color:${seen ? '#2f8f5b' : 'inherit'}">${seen ? `Loaded in ${seen} request(s)` : 'Never loaded in trace'}</span>` : ''}
      ${node.directAccess ? '<span class="badge reach-unauth-entry">Direct access · no ABSPATH guard</span>' : ''}
      ${node.guarded ? '<span class="badge">ABSPATH guarded</span>' : ''}
      ${node.deadend ? '<span class="badge">Dead end</span>' : ''}
      <span class="badge">${node.loc} LOC</span>
    </div>

    <div class="insp-actions">
      ${pingButtonHtml()}
      <button class="btn small" id="disableBtn">${isDisabled ? 'Enable node' : 'Disable node'}</button>
    </div>

    ${node.access.length ? `<div class="insp-section"><h4>Handlers registered here</h4><ul class="inputs-list">${node.access.map(renderAccessRow).join('')}</ul></div>` : ''}
    ${handled.length ? `<div class="insp-section"><h4>Handlers implemented here</h4><ul class="inputs-list">${handled.map(renderAccessRow).join('')}</ul></div>` : ''}

    ${node.classes.length ? section('Classes', node.classes.map((c) =>
      `<span class="tag">${esc(c.name)}${c.extends ? ' : ' + esc(c.extends) : ''}</span>`).join(' '), 'taglist') : ''}
    ${parents.length ? section('Inherits from', parents.map((e) => `
      <div class="small" style="margin-bottom:4px"><span class="tk">${esc(e.child)}</span> extends <span class="tk">${esc(e.parent)}</span></div>
      ${e.overrides && e.overrides.length ? `<div class="taglist">${e.overrides.map((o) => `<span class="tag" title="overrides the parent's method">overrides ${esc(o)}()</span>`).join(' ')}</div>` : '<div class="muted small">No methods overridden.</div>'}`).join('')) : ''}
    ${node.fns && node.fns.length ? `<div class="insp-section"><h4>Functions</h4><ul class="inputs-list">${node.fns.map((f, fi) => `
      <li><div class="fn-head"><code class="tk">${esc((f.cls ? f.cls + '::' : '') + f.name)}(${(f.params || []).map((p) => esc(p.name)).join(', ')})</code>${f.summary.startsWith('Only declared') ? '' : runButton(node.id, fi)}</div>
        <div class="small">${esc(f.summary)}</div>
        ${(f.params || []).map((p) => `<div class="muted small"><code>${esc(p.name)}</code>: ${esc(p.hint)}</div>`).join('')}</li>`).join('')}</ul></div>` : ''}

    ${node.jsCalls && node.jsCalls.length ? `<div class="insp-section"><h4>Server calls from this script</h4><ul class="inputs-list">${
      node.jsCalls.map(renderJsCall).join('')}</ul></div>` : ''}
    ${node.domRefs && node.domRefs.length ? section('DOM elements this script targets',
      node.domRefs.map((d) => `<span class="tag" title="${esc(d.via)} · line ${d.line}">${esc(d.selector)}</span>`).join(' '), 'taglist') : ''}

    ${inputs.length ? `<div class="insp-section"><h4>Expected inputs</h4><ul class="inputs-list">${inputs.map(renderInput).join('')}</ul></div>` : ''}
    ${node.outputs.length ? section('Outputs', [...new Set(node.outputs.map((o) => o.type))].map((t) => `<span class="tag">${t}</span>`).join(' '), 'taglist') : ''}
    ${node.issues.length ? `<div class="insp-section"><h4>Findings (${node.issues.length})</h4>${node.issues.map(renderIssue).join('')}</div>` : ''}

    <div class="insp-section"><h4>Probe commands <span class="muted small">(run locally - never sent)</span></h4>${probes.map(renderProbe).join('')}</div>
  `;

  $('pingBtn').onclick = () => (simActive ? stopSim() : runSim(node.id));
  bindRunButtons(body);
  emit('select', { id: node.id, observed: !!(state.trace && state.trace.observed[node.id]) });
  $('disableBtn').onclick = () => {
    if (isDisabled) disabled.delete(node.id); else disabled.add(node.id);
    view.setDisabled(disabled);
    showInspector(node);
  };
  body.querySelectorAll('.copy-btn').forEach((b) => (b.onclick = () => {
    navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Copied to clipboard', 'i-check'));
  }));
}

function renderAccessRow(a) {
  const scan = state.model.meta.vulnScan;
  return `<li>${scan ? sevPill(a.severity) + ' ' : ''}<span class="tk">${esc(a.name)}</span>
    <div class="small">cap ${tick(a.cap)} · login ${tick(a.login)} · nonce ${tick(a.nonce)}${a.writes.length ? ` · writes <code>${esc(a.writes.join(', '))}</code>` : ''}</div>
    ${scan ? `<div class="muted small">${esc(a.message)}</div>` : ''}</li>`;
}
function section(title, html, cls = '') {
  return `<div class="insp-section"><h4>${title}</h4><div class="${cls}">${html}</div></div>`;
}
function renderInput(i) {
  const bits = [];
  if (i.transport) bits.push(`<span class="tk">${esc(i.transport)}</span>`);
  if (i.route) bits.push(`route <span class="tk">${esc(i.route)}</span>`);
  if (i.tag) bits.push(`<span class="tk">[${esc(i.tag)}]</span>`);
  if (i.params) bits.push('params ' + Object.entries(i.params).map(([k, v]) => `<span class="tk">${esc(k)}=${esc(v)}</span>`).join(' '));
  const auth = i.auth ? `<span class="auth-tag auth-${i.auth}">${i.auth}</span>` : '';
  return `<li>${auth} ${bits.join(' · ')}${i.note ? `<div class="muted small">${esc(i.note)}</div>` : ''}</li>`;
}
function renderJsCall(j) {
  const target = j.endpoint === 'ajax'
    ? (j.action ? `AJAX action <span class="tk">${esc(j.action)}</span>` : 'AJAX (action unknown)')
    : j.endpoint === 'rest' ? `REST <span class="tk">${esc(j.path || j.url || '')}</span>`
    : `<span class="tk">${esc(j.url || 'dynamic URL')}</span>`;
  const resolved = state.model.edges.some((e) => e.source === currentNodeId && (e.type === 'ajax' || e.type === 'rest-call')
    && (e.action === j.action || e.route === j.path));
  return `<li><span class="tk">${esc(j.kind)}</span> <span class="auth-tag auth-${j.endpoint === 'unknown' ? 'internal' : 'unauth'}">${esc(j.method)}</span> → ${target}
    <div class="muted small">line ${j.line}${j.fallback ? ' · action found via fallback' : ''} · ${resolved ? `${tick(true)} linked to a server endpoint` : 'no matching endpoint found'}</div></li>`;
}
function renderIssue(i) {
  const head = i.kind === 'deprecated' ? 'Deprecated' : i.kind === 'perf' ? 'Performance' : i.kind === 'conflict' ? 'Duplicate declaration' : i.cwe || KIND_LABEL[i.kind] || 'Issue';
  return `<div class="issue sev-${i.severity}">
    <div class="issue-head"><span>${esc(head)}</span><span class="sev">${i.severity}${i.confidence ? ` · ${i.confidence} conf.` : ''}</span></div>
    <div>${esc(i.message)}</div>
    <div class="meta">line ${i.line}${i.symbol ? ` · ${esc(i.symbol)}` : ''}</div>
  </div>`;
}
function renderProbe(p) {
  const cmd = p.custom ? `${p.cmd}\n\n${p.custom}` : p.cmd;
  return `<div class="probe">
    <div class="probe-title"><span class="auth-tag auth-${p.auth}">${p.auth}</span> ${esc(p.title)}</div>
    <pre class="code">${esc(cmd)}<button class="btn ghost small copy-btn" data-copy="${esc(cmd)}">copy</button></pre>
  </div>`;
}

// ---------- view mode (web / flow) ----------
function setViewMode(mode) {
  if (mode !== 'web' && mode !== 'flow') return;
  view.setMode(mode);
  store.set('sl-view', mode);
  syncViewToggle();
  emit('view', { mode });
}
function syncViewToggle() {
  $('viewToggle').querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.view === view.mode)));
}

// ---------- simulation ----------
// A ping runs once: the wave spreads level by level, the lit path holds for a
// moment, then everything fades back and Ping is available again. Timers (not
// animation frames) drive the lifecycle, so it can't get stuck in a throttled
// tab. Stop (button, toolbar or Esc) ends it immediately.
const SIM_HOLD_MS = 1800;
const SIM_FADE_MS = 450;
let simTimer = null;
let simFadeTimer = null;

function pingButtonHtml() {
  return simActive
    ? '<button class="btn small stop" id="pingBtn" title="Stop the signal (Esc)"><svg class="icon"><use href="#i-stop"/></svg> Stop signal</button>'
    : '<button class="btn primary small" id="pingBtn"><svg class="icon"><use href="#i-bolt"/></svg> Ping signal</button>';
}
function syncPingUI() {
  const pb = $('pingBtn');
  if (pb) {
    pb.outerHTML = pingButtonHtml();
    $('pingBtn').onclick = () => (simActive ? stopSim() : runSim(currentNodeId));
  }
  $('clearSimBtn').classList.toggle('hidden', !simActive);
}

function runSim(startId) {
  if (!startId) return;
  stopSim();
  const sim = simulate(state.model, startId, { disabled: [...disabled] });
  view.setSimulation(sim);
  simActive = true;
  syncPingUI();
  const node = state.model.nodes.find((n) => n.id === startId);
  $('simStatus').innerHTML = `
    <span class="chip"><b>Signal</b> from ${esc(node.label)}</span>
    <span class="chip"><b>${sim.visited.length}</b> files reached</span>
    <span class="chip"><b>${sim.maxLevel}</b> levels</span>
    <span class="chip"><b>${sim.paths.length}</b> paths</span>
    <span class="chip"><b>${sim.endpoints.length}</b> dead ends</span>
    ${sim.sinks.length ? `<span class="chip danger"><b>${sim.sinks.length}</b> sinks on path</span>` : ''}
    ${sim.truncated ? '<span class="chip">truncated</span>' : ''}`;
  simTimer = setTimeout(finishSim, view.simDuration() + SIM_HOLD_MS);
  emit('ping', { id: startId });
}
function finishSim() {
  simTimer = null;
  view.fadeOutSimulation(SIM_FADE_MS);
  $('simStatus').classList.add('fading');
  simFadeTimer = setTimeout(stopSim, SIM_FADE_MS + 20);
}
function stopSim() {
  clearTimeout(simTimer); clearTimeout(simFadeTimer);
  simTimer = simFadeTimer = null;
  view.clearSimulation();
  $('simStatus').innerHTML = '';
  $('simStatus').classList.remove('fading');
  simActive = false;
  syncPingUI();
}
const clearSim = stopSim;

// ---------- report ----------
function openReport() {
  if (!state.model) return;
  $('rAgency').value = store.get('sl-agency') || '';
  $('rClient').value = '';
  $('rNotes').value = '';
  const logo = store.get('sl-logo');
  $('rLogoPreview').classList.toggle('hidden', !logo);
  if (logo) $('rLogoPreview').src = logo;
  // only offer sections that have content
  const avail = { changes: !!state.diff, runtime: !!state.trace, conflicts: state.model.conflicts.length > 0 };
  $('reportModal').querySelectorAll('[data-sec]').forEach((cb) => {
    const k = cb.dataset.sec;
    const ok = avail[k] !== false;
    cb.disabled = !ok; cb.checked = ok;
    cb.parentElement.style.opacity = ok ? 1 : 0.45;
  });
  $('reportModal').classList.remove('hidden');
}

function onLogoPicked(e) {
  const f = e.target.files[0];
  if (!f) return;
  if (f.size > 600 * 1024) { toast('Logo is too large (max 600 KB).'); e.target.value = ''; return; }
  const r = new FileReader();
  r.onload = () => {
    store.set('sl-logo', r.result);
    $('rLogoPreview').src = r.result; $('rLogoPreview').classList.remove('hidden');
  };
  r.readAsDataURL(f);
}

function graphSnapshot() {
  // Render once in the light theme, fitted to everything, for a print-friendly image.
  const root = document.documentElement;
  const prevTheme = root.dataset.theme;
  const prev = { tx: view.tx, ty: view.ty, scale: view.scale };
  const wasHidden = $('tableView').classList.contains('hidden');
  root.dataset.theme = 'light';
  view.refreshColors();
  view.fit();
  view._draw();
  const png = view.snapshot('#ffffff');
  if (prevTheme) root.dataset.theme = prevTheme; else delete root.dataset.theme;
  Object.assign(view, prev);
  view.refreshColors();
  if (!wasHidden) view._needsDraw = true;
  return png;
}

function exportReport(mode) {
  const branding = {
    agency: $('rAgency').value.trim(),
    client: $('rClient').value.trim(),
    notes: $('rNotes').value.trim(),
    logo: store.get('sl-logo') || null,
  };
  store.set('sl-agency', branding.agency);
  const sections = {};
  $('reportModal').querySelectorAll('[data-sec]').forEach((cb) => (sections[cb.dataset.sec] = cb.checked && !cb.disabled));
  const html = buildReport({
    model: state.model, diff: state.diff, trace: state.trace, branding, sections,
    graphPng: sections.graph ? graphSnapshot() : null,
  });
  const base = (state.model.meta.packageName || 'package').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (mode === 'download') {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url; a.download = `pluginlore-report-${base}-${new Date().toISOString().slice(0, 10)}.html`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('Report downloaded');
  } else {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    frame.srcdoc = html;
    frame.onload = () => { frame.contentWindow.focus(); frame.contentWindow.print(); setTimeout(() => frame.remove(), 2000); };
    document.body.appendChild(frame);
  }
  $('reportModal').classList.add('hidden');
}

// ---------- utils ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const tick = (v) => (v
  ? '<svg class="icon tick yes" role="img" aria-label="yes"><use href="#i-check"/></svg>'
  : '<svg class="icon tick no" role="img" aria-label="no"><use href="#i-x"/></svg>');
const sevPill = (s) => `<span class="sevpill ${esc(s)}">${esc(s)}</span>`;
const card = (n, label, tone = '') => `<div class="card ${tone}"><div class="n">${esc(n)}</div><div class="l">${esc(label)}</div></div>`;
let toastTimer;
function toast(msg, icon = null) {
  const t = $('toast');
  t.innerHTML = `${icon ? `<svg class="icon"><use href="#${icon}"/></svg>` : ''}<span>${esc(msg)}</span>`;
  t.classList.remove('hidden');
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Learn tab ----------
let lessonCache = null;
function getLessons() {
  if (!lessonCache || lessonCache.model !== state.model) lessonCache = { model: state.model, ...buildLessons(state.model) };
  return lessonCache;
}
// {{key|text}} glossary tokens -> clickable terms (text is already escaped)
function terms(html) {
  return html.replace(/\{\{([a-z]+)\|([^}]+)\}\}/g, (_, k, label) => (GLOSSARY[k] ? `<button class="term" data-term="${k}">${label}</button>` : label));
}
function tableLearn() {
  const m = state.model;
  const { chapters, files } = getLessons();
  const name = m.meta.packageName || (state.primary && state.primary.name.replace(/\.zip$/i, '')) || 'this plugin';
  const num = (i) => String(i + 1).padStart(2, '0');
  const step = (s, ci, si) => `
    <article class="lesson-step${s.risk ? ` risk-${s.risk}` : ''}">
      <h4>${esc(s.title)}${s.risk ? ` <span class="sevpill ${s.risk}">${s.risk} risk</span>` : ''}</h4>
      <p>${terms(s.text)}</p>
      <div class="lesson-actions">
        ${s.files.length ? `<button class="btn small" data-show="${ci}:${si}"><svg class="icon"><use href="#i-eye"/></svg> Show in graph</button>` : ''}
        ${s.ping ? `<button class="btn small" data-ping="${esc(s.ping)}"><svg class="icon"><use href="#i-bolt"/></svg> Follow the signal</button>` : ''}
        <span class="lesson-files">${s.files.slice(0, 6).map((f) => `<button class="tag link" data-file="${esc(f)}" title="${esc(f)}">${esc(f.split('/').pop())}</button>`).join('')}${s.files.length > 6 ? `<span class="muted small">+${s.files.length - 6} more</span>` : ''}</span>
      </div>
    </article>`;
  return `
    <div class="learn">
      <nav class="learn-toc" aria-label="Chapters">
        <div class="toc-title">Chapters</div>
        ${chapters.map((c, i) => `<a href="#ch-${c.id}" data-goto="ch-${c.id}"><span class="num">${num(i)}</span>${esc(c.title)}</a>`).join('')}
        <a href="#ch-files" data-goto="ch-files"><span class="num"><svg class="icon xs"><use href="#i-zip"/></svg></span>Every file</a>
        <a href="#ch-glossary" data-goto="ch-glossary"><span class="num"><svg class="icon xs"><use href="#i-book"/></svg></span>Glossary</a>
      </nav>
      <div class="learn-body">
        <header class="learn-head">
          <h2>How ${esc(name)} works</h2>
          <p class="tv-note">A walk through the code in the order WordPress runs it. <b>Show in graph</b> lights up the files involved; <b>Follow the signal</b> sends a wave from that file; dotted words open a definition.</p>
        </header>
        ${chapters.map((c, ci) => `
          <section class="lesson" id="ch-${c.id}">
            <h3><span class="num">${num(ci)}</span>${esc(c.title)}</h3>
            ${c.intro ? `<p class="lesson-intro">${esc(c.intro)}</p>` : ''}
            ${c.steps.map((s, si) => step(s, ci, si)).join('')}
          </section>`).join('')}
        <section class="lesson" id="ch-files">
          <h3><span class="num"><svg class="icon"><use href="#i-zip"/></svg></span>Every file, every function</h3>
          <input type="search" class="search" id="learnFilter" placeholder="Filter by file or function name…" />
          <div id="learnFiles">${files.map(fileCard).join('')}</div>
        </section>
        <section class="lesson" id="ch-glossary">
          <h3><span class="num"><svg class="icon"><use href="#i-book"/></svg></span>Glossary</h3>
          <dl class="glossary">${Object.entries(GLOSSARY).map(([k, [title, def]]) => `<div id="term-${k}"><dt>${esc(title)}</dt><dd>${esc(def)}</dd></div>`).join('')}</dl>
        </section>
      </div>
    </div>`;
}
function fileCard(f) {
  const text = [f.id, ...f.fns.map((x) => x.name)].join(' ').toLowerCase();
  return `
    <details class="lesson-file" data-text="${esc(text)}">
      <summary><span class="role role-${esc(f.role?.key || 'other')}">${esc(f.role?.label || 'File')}</span><code>${esc(f.id)}</code><span class="muted small">${f.fns.length ? `${f.fns.length} function${f.fns.length === 1 ? '' : 's'}` : ''}</span></summary>
      <p>${esc(f.summary)}</p>
      ${f.fns.length ? `<ul class="fn-list">${f.fns.map((fn, fnIdx) => `
        <li>
          <div class="fn-head"><code>${esc(fn.name)}(${fn.params.map((p) => esc(p.name + (p.optional ? '?' : ''))).join(', ')})</code><span class="muted small">line ${fn.line}</span>${f.id.match(/\.(php|phtml|inc)$/i) && !fn.summary.startsWith('Only declared') ? runButton(f.id, fnIdx) : ''}</div>
          <div>${esc(fn.summary)}</div>
          ${fn.params.length ? `<ul class="param-list">${fn.params.map((p) => `<li><code>${esc(p.name)}</code>${p.type ? ` <span class="muted small">${esc(p.type)}</span>` : ''} <span>${esc(p.hint)}</span>${p.optional ? ' <span class="muted small">(optional)</span>' : ''}<span class="muted small"> · try <code>${esc(typeof p.example === 'string' ? p.example : JSON.stringify(p.example))}</code></span></li>`).join('')}</ul>` : ''}
          ${fn.triggers.length ? `<div class="fn-meta"><svg class="icon xs"><use href="#i-bolt"/></svg> ${fn.triggers.map((t) => esc(t.label)).join('; ')}</div>` : ''}
          ${fn.calledBy.length ? `<div class="fn-meta"><svg class="icon xs"><use href="#i-arrow"/></svg> called by ${fn.calledBy.map((c) => `<code>${esc(c.name)}()</code>`).join(', ')}</div>` : ''}
        </li>`).join('')}</ul>` : ''}
      <button class="btn small" data-file="${esc(f.id)}"><svg class="icon"><use href="#i-target"/></svg> Open in inspector</button>
    </details>`;
}
function bindLearn() {
  const root = $('tableView');
  const { chapters } = getLessons();
  root.querySelectorAll('[data-goto]').forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    const el = root.querySelector(`#${a.dataset.goto}`);
    if (el) el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }));
  root.querySelectorAll('[data-show]').forEach((b) => (b.onclick = () => {
    const [ci, si] = b.dataset.show.split(':').map(Number);
    const s = chapters[ci].steps[si];
    switchTab('graph');
    view.setHighlight(s.files);
    toast(`Showing: ${s.title}. Click empty space to clear.`, 'i-eye');
    emit('learn-show', { chapter: chapters[ci].id });
  }));
  root.querySelectorAll('[data-ping]').forEach((b) => (b.onclick = () => {
    const id = b.dataset.ping;
    switchTab('graph');
    const n = state.model.nodes.find((x) => x.id === id);
    if (n) { view.focus(id); showInspector(n); runSim(id); }
  }));
  root.querySelectorAll('[data-file]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); focusNode(b.dataset.file, { stay: true }); }));
  bindRunButtons(root);
  const filter = $('learnFilter');
  if (filter) filter.oninput = () => {
    const q = filter.value.trim().toLowerCase();
    root.querySelectorAll('.lesson-file').forEach((d) => {
      const hit = !q || d.dataset.text.includes(q);
      d.classList.toggle('hidden', !hit);
      if (q && hit) d.open = true;
    });
  };
}

// glossary pop-over
let termPop = null;
function showTerm(btn) {
  const k = btn.dataset.term;
  const g = GLOSSARY[k];
  if (!g) return;
  hideTerm();
  termPop = document.createElement('div');
  termPop.className = 'term-pop';
  termPop.setAttribute('role', 'tooltip');
  termPop.innerHTML = `<b>${esc(g[0])}</b><p>${esc(g[1])}</p>`;
  document.body.appendChild(termPop);
  const r = btn.getBoundingClientRect();
  const w = termPop.offsetWidth, h = termPop.offsetHeight;
  let x = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), innerWidth - w - 12);
  let y = r.bottom + 8;
  if (y + h > innerHeight - 12) y = r.top - h - 8;
  termPop.style.left = `${x}px`; termPop.style.top = `${y}px`;
}
function hideTerm() { if (termPop) { termPop.remove(); termPop = null; } }

// ---------- WordPress.org ----------
const wp = { kind: 'plugin', timer: null, ctrl: null };
const SUGGEST = {
  plugin: ['hello-dolly', 'akismet', 'classic-editor', 'contact-form-7', 'wordpress-importer', 'query-monitor'],
  theme: ['twentytwentyfive', 'twentytwentyfour', 'twentytwentythree', 'astra'],
};
function openWporg() {
  $('galleryModal').classList.add('hidden');
  $('wporgModal').classList.remove('hidden');
  $('wporgPick').classList.add('hidden');
  if (!$('wporgQuery').value.trim()) renderWporgSuggestions();
  setTimeout(() => $('wporgQuery').focus(), 30);
}
function renderWporgSuggestions() {
  $('wporgResults').innerHTML = `<div class="muted small" style="margin:6px 0">Try one of these:</div>
    <div class="chips-row">${SUGGEST[wp.kind].map((s) => `<button class="chip toggle" data-slug="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
  $('wporgResults').querySelectorAll('[data-slug]').forEach((b) => (b.onclick = () => pickWporg(b.dataset.slug)));
}
async function runWporgSearch() {
  const text = $('wporgQuery').value.trim();
  if (wp.ctrl) wp.ctrl.abort();
  $('wporgPick').classList.add('hidden');
  if (!text) return renderWporgSuggestions();
  wp.ctrl = new AbortController();
  $('wporgResults').innerHTML = '<div class="muted small">Searching WordPress.org…</div>';
  try {
    const results = await wporg.search(wp.kind, text, wp.ctrl.signal);
    if (!results.length) { $('wporgResults').innerHTML = `<div class="muted small">No ${wp.kind}s found for "${esc(text)}".</div>`; return; }
    $('wporgResults').innerHTML = results.map((r) => `
      <button class="wporg-item" data-slug="${esc(r.slug)}">
        ${r.icon && /^https:\/\//.test(r.icon) ? `<img src="${esc(r.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : '<span class="wporg-noicon"><svg class="icon"><use href="#i-wp"/></svg></span>'}
        <span class="wporg-text">
          <b>${esc(decode(r.name))}</b> <span class="muted small">v${esc(r.version)}${r.installs ? ` · ${installs(r.installs)}` : ''}</span>
          <span class="small muted">${esc(decode(r.blurb))}</span>
        </span>
      </button>`).join('');
    $('wporgResults').querySelectorAll('[data-slug]').forEach((b) => (b.onclick = () => pickWporg(b.dataset.slug)));
  } catch (err) {
    if (err.name !== 'AbortError') $('wporgResults').innerHTML = `<div class="muted small">Could not reach WordPress.org: ${esc(err.message)}</div>`;
  }
}
async function pickWporg(slug) {
  const box = $('wporgPick');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="muted small">Loading versions…</div>';
  try {
    const d = await wporg.details(wp.kind, slug);
    const opts = (sel) => d.versions.map((v) => `<option value="${esc(v.url)}" ${v.version === sel ? 'selected' : ''}>${esc(v.version)}${v.version === d.version ? ' (latest)' : v.version === 'trunk' ? ' (development)' : ''}</option>`).join('');
    const older = d.versions.find((v) => v.version !== d.version && v.version !== 'trunk');
    box.innerHTML = `
      <div class="wporg-head"><b>${esc(decode(d.name))}</b> <span class="muted small">${esc(d.author || '')}${d.installs ? ` · ${installs(d.installs)}` : ''}${d.requiresPhp ? ` · needs PHP ${esc(d.requiresPhp)}+` : ''}</span></div>
      <div class="wporg-row">
        <label>Version<select class="select" id="wpVerA">${opts(d.version)}</select></label>
        <label>Compare with <span class="muted small">(optional)</span><select class="select" id="wpVerB"><option value="">Nothing</option>${opts('__none__')}</select></label>
      </div>
      <div class="modal-actions" style="margin-top:12px">
        ${older ? `<button class="btn small" id="wpPrev">Compare with the previous release</button>` : ''}
        <button class="btn primary" id="wpLoad"><svg class="icon"><use href="#i-download"/></svg> Load</button>
      </div>
      <p class="muted small">${d.versions.length} version${d.versions.length === 1 ? '' : 's'} available, back to ${esc(d.versions.filter((v) => v.version !== 'trunk').slice(-1)[0]?.version || d.version)}.</p>`;
    const verOf = (url) => (d.versions.find((v) => v.url === url) || {}).version;
    if (older) $('wpPrev').onclick = () => {
      const a = verOf($('wpVerA').value);
      const idx = d.versions.findIndex((v) => v.version === a);
      const prev = d.versions.slice(idx + 1).find((v) => v.version !== 'trunk');
      if (prev) $('wpVerB').value = prev.url;
    };
    $('wpLoad').onclick = () => {
      const a = $('wpVerA').value, b = $('wpVerB').value;
      if (b && b === a) return toast('Pick two different versions to compare.');
      loadFromWporg(d, { url: a, version: verOf(a) }, b ? { url: b, version: verOf(b) } : null);
    };
  } catch (err) {
    box.innerHTML = `<div class="muted small">${esc(err.message)}</div>`;
  }
}
async function loadFromWporg(d, a, b) {
  $('wporgModal').classList.add('hidden');
  state.sample = null; hideMission();
  state.traceRaw = null; state.trace = null;
  const keys = b ? ['a', 'b'] : ['a'];
  const title = b ? `Fetching ${decode(d.name)} ${a.version} and ${b.version}` : `Fetching ${decode(d.name)} ${a.version}`;
  loader.start(title, keys);
  const fetchOne = async (v, key) => {
    const file = `${d.slug}.${v.version}.zip`;
    const buffer = await wporg.download(v.url, (got, total) => loader.update(key, { phase: 'download', i: got, n: total, file }));
    return { buffer, name: file, wporg: { kind: d.kind, slug: d.slug, version: v.version } };
  };
  try {
    const [pa, pb] = await Promise.all([fetchOne(a, 'a'), b ? fetchOne(b, 'b') : null]);
    state.primary = pa;
    state.compare = pb;
    state.afterLoad = () => switchTab(pb ? 'changes' : 'learn');
    await analyzeAll({ keepLoader: true });
  } catch (err) {
    loader.fail(err.message);
    toast(`Could not load from WordPress.org: ${err.message}`);
  }
}
function decode(s) { const t = document.createElement('textarea'); t.innerHTML = String(s ?? ''); return t.value; }
function installs(n) {
  if (n >= 1e6) return `${Math.floor(n / 1e6)}M+ installs`;
  if (n >= 1e3) return `${Math.floor(n / 1e3)}K+ installs`;
  return `${n}+ installs`;
}


// ---------- Run a function for real (WordPress Playground) ----------
let runner = null;            // lazily created; the Playground client is a separate chunk
let runTarget = null;         // { fileId, fn }
const runPrefs = { as: store.get('sl-run-as') || 'admin', skipNonce: false };

function runButton(fileId, i) {
  return `<button class="btn small run-btn" data-run="${esc(fileId)}" data-run-i="${i}" title="Run this function in a sandboxed WordPress in your browser"><svg class="icon"><use href="#i-play"/></svg> Run</button>`;
}
function bindRunButtons(root) {
  root.querySelectorAll('[data-run]').forEach((b) => (b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openRunner(b.dataset.run, Number(b.dataset.runI)); }));
}

function openRunner(fileId, i) {
  const node = state.model.nodes.find((n) => n.id === fileId);
  const fn = node && node.fns[i];
  if (!fn) return;
  runTarget = { fileId, fn };
  const sig = `${fn.cls ? fn.cls + '::' : ''}${fn.name}(${(fn.params || []).map((p) => p.name).join(', ')})`;
  $('runTitle').textContent = sig;
  $('runWhere').innerHTML = `${esc(fn.summary)} <span class="muted">${esc(fileId)}:${fn.line}</span>`;
  const req = fn.request || {};
  const reqKeys = Object.entries(req).flatMap(([src, keys]) => keys.map((k) => ({ src, k })));
  $('runParams').innerHTML = ((fn.params || []).length
    ? fn.params.map((p, k) => paramField(p, k)).join('')
    : (reqKeys.length ? '' : '<p class="muted small">This function takes no arguments.</p>'))
    + (reqKeys.length ? `<div class="run-req"><div class="run-req-head">Request input <span class="muted small">what a browser would send; the code reads these</span></div>
      ${reqKeys.map(({ src, k }) => `<label class="run-param"><span class="run-param-head"><code>$_${esc(src)}['${esc(k)}']</code></span>
        <input class="select" data-req="${esc(src)}" data-key="${esc(k)}" value="${esc(guessValue(k))}" /></label>`).join('')}</div>` : '');
  $('runAs').value = runPrefs.as;
  $('runNonce').checked = runPrefs.skipNonce;
  $('runConsent').classList.toggle('hidden', !!store.get('sl-run-ok'));
  $('runResult').innerHTML = '';
  setRunStatus(runner && runner.ready ? 'Sandbox is running. Ready.' : 'The sandbox starts when you press Run.');
  $('runModal').classList.remove('hidden');
  emit('run-open', { name: fn.name });
}

function paramField(p, k) {
  const ex = p.example;
  const val = typeof ex === 'string' ? ex : JSON.stringify(ex);
  let input;
  if (['number', 'post ID', 'user ID', 'term ID'].includes(p.kind)) input = `<input class="select" type="number" data-p="${k}" value="${esc(String(ex === '' ? '' : ex))}" />`;
  else if (p.kind === 'yes/no') input = `<label class="row check" style="margin:0"><input type="checkbox" data-p="${k}" ${ex === true || ex === 'true' ? 'checked' : ''}/> <span>true</span></label>`;
  else if (['list', 'array', 'shortcode attributes', 'REST request'].includes(p.kind) || (ex && typeof ex === 'object')) input = `<textarea class="select mono" rows="3" data-p="${k}" data-json="1">${esc(typeof ex === 'string' ? ex : JSON.stringify(ex, null, 1))}</textarea>`;
  else input = `<input class="select" data-p="${k}" value="${esc(val)}" />`;
  return `<div class="run-param">
    <div class="run-param-head"><code>${esc(p.name)}</code>${p.type ? ` <span class="muted small">${esc(p.type)}</span>` : ''}${p.optional ? ' <span class="muted small">optional</span>' : ''}</div>
    ${input}
    <div class="muted small">${esc(p.hint)}</div>
  </div>`;
}

// A sensible value for a request key, from its name.
function guessValue(k) {
  const n = k.toLowerCase();
  if (/nonce|token/.test(n)) return 'not-a-real-nonce';
  if (/(^|_)(id|ids|post_id|user_id|qty|quantity|count|page|num|number|amount|price)$/.test(n)) return '1';
  if (/email/.test(n)) return 'test@example.com';
  if (/url|link|href|redirect/.test(n)) return 'https://example.com';
  if (/^action$/.test(n)) return '';
  if (/name|title|subject/.test(n)) return 'Ada Lovelace';
  if (/message|content|text|comment|desc/.test(n)) return 'Hello from Pluginlore';
  return 'test';
}
function readRequest() {
  const out = {};
  $('runParams').querySelectorAll('[data-req]').forEach((el) => {
    out[el.dataset.req] = out[el.dataset.req] || {};
    out[el.dataset.req][el.dataset.key] = el.value;
  });
  return out;
}

function readArgs(fn) {
  return (fn.params || []).map((p, k) => {
    const el = $('runParams').querySelector(`[data-p="${k}"]`);
    let value;
    if (!el) value = null;
    else if (el.type === 'checkbox') value = el.checked;
    else if (el.type === 'number') value = el.value === '' ? null : Number(el.value);
    else if (el.dataset.json) { try { value = el.value.trim() ? JSON.parse(el.value) : null; } catch { throw new Error(`${p.name} isn't valid JSON.`); } }
    else value = el.value;
    return { kind: p.kind, value };
  });
}

function setRunStatus(msg, busy = false) {
  $('runStatus').innerHTML = `${busy ? '<span class="spin" aria-hidden="true"></span>' : ''}<span>${esc(msg)}</span>`;
}

// What gets installed: each package with its folder name and main file.
function installLayout() {
  const m = state.model;
  const { files } = extractFiles(new Uint8Array(state.primary.buffer));
  const pk = m.meta.packages || [];
  if (pk.length > 1) {
    return pk.map((p) => ({
      kind: p.kind, dir: p.dir, main: p.file.slice(p.dir.length + 1),
      files: files.filter((f) => f.path.startsWith(p.dir + '/')).map((f) => ({ path: f.path.slice(p.dir.length + 1), bytes: f.bytes })),
    }));
  }
  const src = state.primary.wporg;
  const dir = ((src && src.slug) || m.meta.root || state.primary.name.replace(/\.zip$/i, '') || 'plugin').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'plugin';
  const main = (m.nodes.find((n) => n.isMain) || {}).id || (pk[0] && pk[0].file) || null;
  return [{ kind: m.meta.packageType === 'wordpress-theme' ? 'theme' : 'plugin', dir, main, files }];
}

// sandbox path ("plugins/<dir>/inc/x.php") -> graph file id
function idFromSandbox(rel, layout) {
  if (!rel) return null;
  const m = rel.match(/^(plugins|themes)\/([^/]+)\/(.*)$/);
  if (!m) return null;
  return layout.length > 1 ? `${m[2]}/${m[3]}` : m[3];
}

async function runNow() {
  const fn = runTarget && runTarget.fn;
  if (!fn) return;
  let args;
  try { args = readArgs(fn); } catch (e) { return setRunStatus(e.message); }
  runPrefs.as = $('runAs').value; runPrefs.skipNonce = $('runNonce').checked;
  store.set('sl-run-as', runPrefs.as);
  store.set('sl-run-ok', '1');
  $('runConsent').classList.add('hidden');
  $('runGo').disabled = true;
  const t0 = performance.now();
  try {
    if (!runner) {
      setRunStatus('Loading the sandbox…', true);
      const { Runner } = await import('./runner.js');
      runner = new Runner();
    }
    if (!runner.ready) {
      setRunStatus('Starting WordPress in your browser (first time downloads about 35 MB)…', true);
      await runner.boot((p) => {
        if (p && p.total) setRunStatus(`Downloading WordPress and PHP: ${Math.round((p.loaded / p.total) * 100)}%`, true);
      });
    }
    const layout = installLayout();
    const key = `${state.primary.name}|${state.primary.buffer.byteLength}`;
    if (runner.installedKey !== key) setRunStatus('Installing the plugin…', true);
    const inst = await runner.install(key, layout);
    if (inst.errors.length) $('runResult').innerHTML = `<div class="tv-banner">Activation reported: ${inst.errors.map(esc).join('<br>')}</div>`;
    setRunStatus(`Running ${fn.name}()…`, true);
    const ajax = (fn.triggers || []).some((t) => t.kind === 'ajax') || (fn.does || []).includes('sends-json');
    const res = await runner.call({ fn: fn.name, cls: fn.cls, args, as: runPrefs.as, skipNonce: runPrefs.skipNonce, ajax, request: readRequest() });
    renderRunResult(res, layout, inst);
    const who = runPrefs.as === 'admin' ? 'an administrator' : runPrefs.as === 'subscriber' ? 'a subscriber' : 'a logged-out visitor';
    const total = (performance.now() - t0) / 1000;
    const php = res.result ? `the function itself took ${res.result.ms} ms` : 'no timing came back';
    setRunStatus(`Ran as ${who}: ${php}${total >= 1 ? `, ${total.toFixed(1)} s in all including sandbox start-up` : ''}.`);
    emit('run', { name: fn.name });
  } catch (err) {
    setRunStatus(err.message || String(err));
    if (err.timeout && runner) runner.reset();
  } finally {
    $('runGo').disabled = false;
  }
}

function renderRunResult(res, layout, inst) {
  const r = res.result;
  if (!r) {
    $('runResult').innerHTML += `<div class="tv-banner">The sandbox didn't return a result.${res.phpErrors ? `<pre class="code">${esc(res.phpErrors.slice(0, 2000))}</pre>` : ''}${res.stray ? `<pre class="code">${esc(res.stray.slice(0, 2000))}</pre>` : ''}</div>`;
    return;
  }
  const fileChip = (rel) => {
    const id = idFromSandbox(rel, layout);
    return id && state.model.nodes.some((n) => n.id === id)
      ? `<button class="tag link" data-file="${esc(id)}">${esc(id)}</button>`
      : `<span class="tag">${esc(rel || '')}</span>`;
  };
  const outcome = r.exception ? `<span class="sevpill high">${esc(r.exception.type)}</span> ${esc(r.exception.message)} <span class="muted small">${esc(r.exception.file || '')}:${r.exception.line || ''}</span>`
    : r.stopped ? `<span class="sevpill medium">stopped</span> ${r.stopped.by === 'wp_die' ? 'Stopped with wp_die() / wp_send_json()' : 'Ended the request with exit()'}${r.stopped.message ? `: <code>${esc(r.stopped.message.slice(0, 300))}</code>` : ''}`
    : '<span class="sevpill ok">returned</span> Finished normally.';
  const ret = r.returned === null || r.returned === undefined ? '<span class="muted">nothing (null)</span>'
    : `<pre class="code">${esc(typeof r.returned === 'string' ? r.returned : JSON.stringify(r.returned, null, 2))}</pre>`;
  const out = r.output || '';
  const steps = stepChunks(r);
  const looksHtml = /<[a-z][\s\S]*>/i.test(out) || (typeof r.returned === 'string' && /<[a-z][\s\S]*>/i.test(r.returned));
  $('runResult').innerHTML += `
    <div class="run-outcome">${outcome}</div>
    ${r.notes && r.notes.length ? `<div class="muted small">${r.notes.map(esc).join(' ')}</div>` : ''}
    ${r.redirect ? `<div class="run-sec"><h4>Redirects to</h4><code>${esc(r.redirect)}</code></div>` : ''}
    <div class="run-sec"><h4>Returned${r.returnedType && r.returnedType !== 'NULL' ? ` <span class="muted small">${esc(r.returnedType)}</span>` : ''}</h4>${ret}</div>
    <div class="run-sec"><h4>Printed output <span class="muted small">${out.length} characters</span></h4>
      ${out ? `<pre class="code">${esc(out.slice(0, 20000))}</pre>` : '<span class="muted">nothing printed</span>'}
      ${looksHtml ? `<button class="btn small" id="runPreviewBtn"><svg class="icon"><use href="#i-eye"/></svg> Preview as a page</button><iframe class="run-preview hidden" id="runPreview" sandbox="" title="Output preview (scripts disabled)"></iframe>` : ''}
    </div>
    <div class="run-sec"><h4>Step by step <span class="muted small">${steps.length ? `${steps.length} hook${steps.length === 1 ? '' : 's'} ran plugin code` : 'no hooks ran plugin code during the call'}</span></h4>
      ${steps.length ? `<ol class="run-steps">${steps.map((s, k) => `
        <li><div><b>${esc(s.hook)}</b></div>
          <div class="small">${s.callbacks.map((c) => `<code>${esc(c.callback)}</code> in ${fileChip(c.file)}${c.priority !== 10 ? ` <span class="muted">priority ${c.priority}</span>` : ''}`).join('<br>')}</div>
          ${s.output ? `<details><summary class="small">Output added at this step (${s.output.length} chars)</summary><pre class="code">${esc(s.output.slice(0, 4000))}</pre></details>` : ''}
        </li>`).join('')}</ol>` : '<p class="muted small">The function did its work directly, without going through any WordPress hooks that run plugin code.</p>'}
    </div>
    ${r.files && r.files.length ? `<div class="run-sec"><h4>Files loaded during the call</h4><div class="taglist">${r.files.map(fileChip).join(' ')}</div></div>` : ''}
    ${r.errors && r.errors.length ? `<div class="run-sec"><h4>Warnings and notices (${r.errors.length})</h4><ul class="tv-list">${r.errors.map((e) => `<li><b>${esc(e.level)}</b>: ${esc(e.message)} <span class="muted small">${esc(e.file || '')}:${e.line}</span></li>`).join('')}</ul></div>` : ''}
    ${res.stray ? `<div class="run-sec"><h4>Other output</h4><pre class="code">${esc(res.stray.slice(0, 4000))}</pre></div>` : ''}`;
  $('runResult').querySelectorAll('[data-file]').forEach((b) => (b.onclick = () => focusNode(b.dataset.file, { stay: true })));
  const pv = $('runPreviewBtn');
  if (pv) pv.onclick = () => {
    const f = $('runPreview');
    f.srcdoc = `<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;margin:12px}</style>${out || r.returned}`;
    f.classList.toggle('hidden');
  };
  void inst;
}


// Launched from the landing page: the screen is solid yellow (the owl's belly). Shrink that yellow
// back into the header owl, revealing the app underneath.
function enterReveal() {
  const root = document.documentElement;
  if (!root.classList.contains('pl-enter')) return;
  const mark = document.querySelector('.topbar .brand-mark');
  const r = mark ? mark.getBoundingClientRect() : { left: 24, top: 20, width: 34, height: 34 };
  const x = r.left + r.width / 2, y = r.top + r.height * .6;
  const far = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)) + 20;
  const veil = document.createElement('div');
  Object.assign(veil.style, { position: 'fixed', inset: 0, background: '#ffd23f', zIndex: 2147483000, pointerEvents: 'none' });
  document.body.appendChild(veil);
  root.classList.remove('pl-enter');
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { veil.remove(); return; }
  const a = veil.animate([
    { clipPath: `circle(${far}px at ${x}px ${y}px)` },
    { clipPath: `circle(${far * .9}px at ${x}px ${y}px)`, offset: .12 },
    { clipPath: `circle(0px at ${x}px ${y}px)` },
  ], { duration: 820, easing: 'cubic-bezier(.65,0,.25,1)', fill: 'forwards' });
  a.onfinish = () => { veil.remove(); if (mark) mark.animate([{ transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 380, easing: 'cubic-bezier(.2,1.6,.4,1)' }); };
}

init();
enterReveal();
