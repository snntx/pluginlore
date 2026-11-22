// Loading screen: shows the real file being read and a progress bar that eases
// toward the worker's actual progress, so it feels smooth on tiny plugins and
// stays honest on huge ones.

const PHASES = {
  download: { label: 'Downloading from WordPress.org', from: 0.00, to: 0.14 },
  unzip:  { label: 'Unpacking the zip',          from: 0.14, to: 0.22 },
  parse:  { label: 'Reading files',              from: 0.22, to: 0.80 },
  audit:  { label: 'Checking who can call what', from: 0.80, to: 0.85 },
  link:   { label: 'Weaving the threads',        from: 0.85, to: 0.89 },
  layout: { label: 'Arranging the web',          from: 0.89, to: 0.98 },
  finish: { label: 'Wrapping up',               from: 0.98, to: 1.00 },
};
const MIN_VISIBLE_MS = 1100;   // long enough to read, short enough not to annoy
const TICK_MS = 70;            // how long each file name stays on screen at minimum
const kb = (b) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export class Loader {
  constructor(root) {
    this.root = root;
    this.el = {
      title: root.querySelector('[data-l="title"]'),
      phase: root.querySelector('[data-l="phase"]'),
      file: root.querySelector('[data-l="file"]'),
      fill: root.querySelector('[data-l="fill"]'),
      count: root.querySelector('[data-l="count"]'),
      pct: root.querySelector('[data-l="pct"]'),
    };
    this.raf = null;
  }

  start(title, jobKeys = ['main']) {
    cancelAnimationFrame(this.raf);
    this.jobs = new Map(jobKeys.map((k) => [k, { target: 0, phase: 'unzip', i: 0, n: 0 }]));
    this.shown = 0;
    this.queue = [];
    this.lastTick = 0;
    this.lastFrame = null;
    this.t0 = performance.now();
    this.done = false;
    this.el.title.textContent = title;
    this.el.phase.textContent = PHASES.unzip.label;
    this.el.file.textContent = '…';
    this.el.count.textContent = '';
    this.el.fill.style.transform = 'scaleX(0)';
    this.el.pct.textContent = '0%';
    this.root.classList.remove('hidden', 'leaving', 'finished', 'failed');
    this.root.setAttribute('aria-busy', 'true');
    const loop = (t) => { this._frame(t); this.raf = requestAnimationFrame(loop); };
    this.raf = requestAnimationFrame(loop);
  }

  update(key, p) {
    const job = this.jobs && this.jobs.get(key);
    if (!job || !p) return;
    const ph = PHASES[p.phase];
    if (!ph) return;
    job.phase = p.phase;
    if (p.phase === 'download') {
      job.target = Math.max(job.target, p.n ? ph.from + (ph.to - ph.from) * (p.i / p.n) : ph.from + (ph.to - ph.from) * (1 - 1 / (1 + p.i / 300000)));
      this.el.file.textContent = `${p.file} · ${kb(p.i)}${p.n ? ` of ${kb(p.n)}` : ''}`;
      return;
    }
    if (p.phase === 'unzip') {
      // total unknown while unzipping: creep toward the end of the phase
      job.target = Math.max(job.target, ph.from + (ph.to - ph.from) * (1 - 1 / (1 + p.i / 25)));
    } else if (p.phase === 'parse' && p.n) {
      job.i = p.i; job.n = p.n;
      job.target = Math.max(job.target, ph.from + (ph.to - ph.from) * (p.i / p.n));
    } else {
      job.target = Math.max(job.target, ph.from);
    }
    if (p.file && (p.phase === 'parse' || p.phase === 'unzip')) this.queue.push({ file: p.file, key });
  }

  // Resolves once the bar has filled and the minimum display time has passed.
  // `reveal` runs while the finished card is still on screen, so the result is
  // already drawn underneath when the loader fades away.
  finish(reveal) {
    for (const job of this.jobs.values()) { job.target = 1; job.phase = 'finish'; }
    const asked = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        const now = performance.now();
        // Nobody is watching a hidden tab, and nobody should wait > 2.5 s for polish.
        if (document.hidden || now - asked > 2500) { this.shown = 1; this.queue.length = 0; }
        const elapsed = now - this.t0;
        const minMs = reduceMotion() || document.hidden ? 0 : MIN_VISIBLE_MS;
        if (this.shown >= 0.995 && elapsed >= minMs && this.queue.length === 0) {
          this.done = true;
          this.root.classList.add('finished');
          this.el.phase.textContent = 'Woven';
          try { reveal && reveal(); } catch (e) { console.error(e); }
          setTimeout(() => {
            this.root.classList.add('leaving');
            setTimeout(() => {
              cancelAnimationFrame(this.raf);
              this.root.classList.add('hidden');
              this.root.setAttribute('aria-busy', 'false');
              resolve();
            }, reduceMotion() ? 0 : 260);
          }, reduceMotion() ? 0 : 320);
        } else {
          setTimeout(check, 40);
        }
      };
      check();
    });
  }

  fail(message) {
    cancelAnimationFrame(this.raf);
    this.root.classList.add('failed');
    this.el.phase.textContent = 'Something snapped';
    this.el.file.textContent = message;
    this.root.setAttribute('aria-busy', 'false');
    setTimeout(() => { this.root.classList.add('leaving'); setTimeout(() => this.root.classList.add('hidden'), 260); }, 2600);
  }

  _frame(now) {
    if (!this.jobs) return;
    const jobs = [...this.jobs.values()];
    const target = jobs.reduce((t, j) => t + j.target, 0) / jobs.length;

    // Time-based easing (not per-frame), so a throttled background tab still
    // converges as fast as a 60 fps one. Never overshoot, never stall.
    const dt = Math.min(this.lastFrame == null ? 16 : now - this.lastFrame, 1000);
    this.lastFrame = now;
    const k = reduceMotion() ? 1 : 1 - Math.exp(-dt / 220);
    const crawl = target > this.shown ? dt * 0.00012 : 0;
    this.shown = Math.min(target, this.shown + Math.max((target - this.shown) * k, crawl));
    this.el.fill.style.transform = `scaleX(${this.shown.toFixed(4)})`;
    this.el.pct.textContent = `${Math.round(this.shown * 100)}%`;

    // File ticker: one name per TICK_MS; if the worker races ahead, skip to
    // recent names so the ticker never lags far behind reality.
    if (this.queue.length && now - this.lastTick >= TICK_MS) {
      if (this.queue.length > 14) this.queue.splice(0, this.queue.length - 6);
      const { file } = this.queue.shift();
      this.lastTick = now;
      this.el.file.textContent = file;
      this.el.file.classList.remove('tick'); void this.el.file.offsetWidth; this.el.file.classList.add('tick');
    }

    // Phase label follows the slowest job; counts show combined parse progress.
    const order = Object.keys(PHASES);
    const slowest = jobs.reduce((a, j) => (order.indexOf(j.phase) < order.indexOf(a.phase) ? j : a), jobs[0]);
    if (!this.done) this.el.phase.textContent = PHASES[slowest.phase].label;
    const n = jobs.reduce((t, j) => t + j.n, 0), i = jobs.reduce((t, j) => t + j.i, 0);
    this.el.count.textContent = n ? `${i} / ${n} files` : '';
  }
}
