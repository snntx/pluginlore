// Landing page: source link, light/dark toggle (shared with the app).
import { LINKS } from './links.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

if (LINKS.source) { $('sourceLink').href = LINKS.source; $('sourceLink').classList.remove('hidden'); }

const saved = store.get('sl-theme');
if (saved) document.documentElement.dataset.theme = saved;
$('themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('sl-theme', next);
};

// One-time spotlight on the Launch button: dim the page, zoom in on it, pulse, then fade away.
(function spotlight() {
  const btn = $('launchBtn');
  if (!btn || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  try { if (sessionStorage.getItem('pl-spot')) return; sessionStorage.setItem('pl-spot', '1'); } catch { /* private mode: show it every time */ }
  const spot = document.createElement('div'); spot.id = 'spot';
  document.body.append(spot);
  const place = (el, pad) => {
    const r = btn.getBoundingClientRect();
    Object.assign(el.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
  };
  let done = false;
  const end = () => { if (done) return; done = true; removeEventListener('scroll', end); removeEventListener('pointerdown', end); spot.remove(); };
  setTimeout(() => {
    if (scrollY > 40) return end();
    place(spot, 8);
    addEventListener('scroll', end, { once: true, passive: true });
    addEventListener('pointerdown', end, { once: true });
    const ease = 'cubic-bezier(.2,.9,.3,1)';
    spot.animate([
      { opacity: 0, transform: 'scale(2.6)' },
      { opacity: 1, transform: 'scale(1)', offset: .28 },
      { opacity: 1, transform: 'scale(1.03)', offset: .78 },
      { opacity: 0, transform: 'scale(1.1)' },
    ], { duration: 2600, easing: ease, fill: 'forwards' });
    setTimeout(end, 2700);
  }, 900);
})();

// Launch: the owl leaves the logo and glides to the centre at full sharpness, then melts: its body
// stretches and drips into liquid yellow that merges (SVG "goo" filter) and floods the whole screen.
// Everything is vector, so nothing is ever scaled up from pixels. The app then opens and reveals itself.
(function launch() {
  const btn = $('launchBtn'), logo = document.querySelector('.l-nav .brand-mark');
  if (!btn) return;
  const dest = btn.getAttribute('href');
  const YELLOW = '#ffd23f', NS = 'http://www.w3.org/2000/svg';
  let owl, goo, cover, timers = [];
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));
  const go = () => { try { sessionStorage.setItem('pl-launch', '1'); } catch { /* fine */ } if (!location.search.includes('nonav')) location.href = dest; };

  function cleanup() {
    timers.forEach(clearTimeout); timers = [];
    owl?.remove(); goo?.remove(); cover?.remove(); owl = goo = cover = null;
    if (logo) logo.style.visibility = '';
    btn.classList.remove('going'); btn.lastChild.textContent = ' Launch Pluginlore';
  }
  addEventListener('pageshow', (e) => { if (e.persisted) cleanup(); }); // back from the app

  const el = (name, attrs, parent) => { const n = document.createElementNS(NS, name); for (const k in attrs) n.setAttribute(k, attrs[k]); parent?.appendChild(n); return n; };
  const rnd = (a, b) => a + Math.random() * (b - a);

  btn.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (btn.classList.contains('going')) return;
    if (!logo || matchMedia('(prefers-reduced-motion: reduce)').matches) return go();
    btn.classList.add('going'); btn.lastChild.textContent = ' Launching...';

    const W = innerWidth, H = innerHeight, cx = W / 2, cy = H / 2;
    const S = Math.min(W, H) * .36;                         // owl size while it is centred
    const r = logo.getBoundingClientRect();
    const lx = r.left + r.width / 2, ly = r.top + r.height / 2;

    // The owl is created at its large size and shrunk to the logo (not the other way round),
    // so the browser rasterises it big and it stays sharp the whole flight.
    owl = logo.cloneNode(true); owl.removeAttribute('aria-hidden');
    Object.assign(owl.style, { position: 'fixed', left: cx - S / 2 + 'px', top: cy - S / 2 + 'px', width: S + 'px', height: S + 'px',
      margin: 0, zIndex: 90, overflow: 'visible', pointerEvents: 'none', transformOrigin: '50% 50%' });
    document.body.appendChild(owl); logo.style.visibility = 'hidden';
    const k0 = r.width / S, dx0 = lx - cx, dy0 = ly - cy;
    const start = `translate(${dx0}px, ${dy0}px) scale(${k0}) rotate(0deg)`;
    owl.style.transform = start;
    const fly = owl.animate([
      { transform: start },
      { transform: `translate(${dx0 * .45}px, ${dy0 * .45 - H * .1}px) scale(${k0 + (1 - k0) * .55}) rotate(-12deg)`, offset: .55 },
      { transform: 'translate(0px, 0px) scale(1) rotate(0deg)' },
    ], { duration: 760, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });

    fly.onfinish = () => {
      // owl body geometry in screen pixels (the owl's viewBox is 40 units wide)
      const u = S / 40, top = cy - S / 2;
      const bx = cx, by = top + 23.5 * u, brx = 11 * u, bry = 12.5 * u, bottom = top + 36 * u;

      goo = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
      Object.assign(goo.style, { position: 'fixed', inset: 0, zIndex: 91, pointerEvents: 'none' });
      const defs = el('defs', {}, goo);
      const f = el('filter', { id: 'plGoo', filterUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H, 'color-interpolation-filters': 'sRGB' }, defs);
      el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: Math.max(8, S * .055), result: 'b' }, f);
      el('feColorMatrix', { in: 'b', values: '1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 32 -14' }, f);
      const g = el('g', { filter: 'url(#plGoo)', fill: YELLOW }, goo);
      document.body.appendChild(goo);

      // the body: starts as the owl's belly shape and sags downward
      const body = el('ellipse', { cx: bx, cy: by, rx: brx, ry: bry }, g);
      body.animate([{ ry: bry + 'px', cy: by + 'px' }, { ry: bry * 1.5 + 'px', cy: by + bry * .45 + 'px' }],
        { duration: 650, easing: 'ease-in', fill: 'forwards' });

      // the features slump and fade as the owl melts
      owl.style.transformOrigin = '50% 88%';
      owl.animate([
        { transform: 'scale(1,1)', opacity: 1 },
        { transform: 'translateY(2%) scale(1.04,.94)', opacity: 1, offset: .3 },
        { transform: 'translateY(14%) scale(1.14,1.5)', opacity: 0 },
      ], { duration: 560, easing: 'ease-in', fill: 'forwards' });

      // drips: droplets fall from the belly, stretching as they go
      const N = 11;
      for (let i = 0; i < N; i++) {
        const x = bx + (i / (N - 1) - .5) * brx * 1.7 + rnd(-6, 6);
        const rr = rnd(.05, .1) * S, d = el('ellipse', { cx: x, cy: bottom - rr, rx: rr, ry: rr }, g);
        const fall = (H - bottom) * rnd(.55, 1.05) + rr * 2, dur = rnd(620, 980), delay = rnd(0, 260);
        d.animate([
          { cy: bottom - rr + 'px', ry: rr + 'px', rx: rr + 'px' },
          { cy: bottom + fall * .35 + 'px', ry: rr * 1.8 + 'px', rx: rr * .85 + 'px', offset: .45 },
          { cy: bottom + fall + 'px', ry: rr * 3.2 + 'px', rx: rr * 1.4 + 'px' },
        ], { duration: dur, delay, easing: 'cubic-bezier(.5,0,.9,.5)', fill: 'forwards' });
      }

      // the flood: the liquid swells from the belly until it has covered every corner
      const far = Math.hypot(Math.max(bx, W - bx), Math.max(by, H - by)) + S;
      const flood = el('circle', { cx: bx, cy: by, r: Math.min(brx, bry) * .9 }, g);
      flood.animate([
        { r: Math.min(brx, bry) * .9 + 'px' },
        { r: far * .35 + 'px', offset: .45 },
        { r: far + 'px' },
      ], { duration: 980, delay: 330, easing: 'cubic-bezier(.55,0,.35,1)', fill: 'forwards' })
        .onfinish = () => {
          cover = document.createElement('div');
          Object.assign(cover.style, { position: 'fixed', inset: 0, background: YELLOW, zIndex: 92 });
          document.body.appendChild(cover);
          later(go, 40);
        };
    };
  });
})();
