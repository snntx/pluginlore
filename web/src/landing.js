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

// Launch: the owl leaves the logo, glides to the centre of the screen, then zooms into its own
// yellow body until it fills the screen; the app then opens and reveals itself out of that colour.
(function launch() {
  const btn = $('launchBtn'), logo = document.querySelector('.l-nav .brand-mark');
  if (!btn) return;
  const dest = btn.getAttribute('href');
  let owl, cover, timers = [];
  const go = () => { try { sessionStorage.setItem('pl-launch', '1'); } catch { /* fine */ } if (!location.search.includes('nonav')) location.href = dest; };

  function cleanup() {
    timers.forEach(clearTimeout); timers = [];
    owl?.remove(); cover?.remove(); owl = cover = null;
    if (logo) logo.style.visibility = '';
    btn.classList.remove('going'); btn.lastChild.textContent = ' Launch Pluginlore';
  }
  addEventListener('pageshow', (e) => { if (e.persisted) cleanup(); }); // back from the app

  btn.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (btn.classList.contains('going')) return;
    if (!logo || matchMedia('(prefers-reduced-motion: reduce)').matches) return go();
    btn.classList.add('going'); btn.lastChild.textContent = ' Launching...';

    // a copy of the logo owl takes off from exactly where the logo sits
    const r = logo.getBoundingClientRect(), W = r.width;
    owl = logo.cloneNode(true); owl.removeAttribute('aria-hidden');
    Object.assign(owl.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: W + 'px', height: W + 'px',
      margin: 0, zIndex: 90, overflow: 'visible', willChange: 'transform', pointerEvents: 'none' });
    // zoom into a point on the owl's belly (below the beak, above the chest line): pure yellow
    const ox = W * 20 / 40, oy = W * 29.6 / 40;
    owl.style.transformOrigin = `${ox}px ${oy}px`;
    document.body.appendChild(owl); logo.style.visibility = 'hidden';

    const cx = innerWidth / 2, cy = innerHeight / 2;
    const dx = cx - (r.left + ox), dy = cy - (r.top + oy);
    const mid = Math.min(innerWidth, innerHeight) * .34 / W;            // owl size while it glides
    const unit = W / 40, cornerFree = 6.2;                              // belly point -> nearest edge, in owl units
    const big = (Math.hypot(innerWidth, innerHeight) / 2 + 40) / (cornerFree * unit);

    const fly = owl.animate([
      { transform: 'translate(0,0) scale(1) rotate(0deg)' },
      { transform: `translate(${dx * .55}px, ${dy * .55 - innerHeight * .12}px) scale(${mid * .6}) rotate(-14deg)`, offset: .55 },
      { transform: `translate(${dx}px, ${dy}px) scale(${mid}) rotate(0deg)` },
    ], { duration: 720, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'forwards' });
    fly.onfinish = () => {
      const zoom = owl.animate([
        { transform: `translate(${dx}px, ${dy}px) scale(${mid}) rotate(0deg)` },
        { transform: `translate(${dx}px, ${dy}px) scale(${mid * 1.08}) rotate(0deg)`, offset: .18 },
        { transform: `translate(${dx}px, ${dy}px) scale(${big}) rotate(0deg)` },
      ], { duration: 620, easing: 'cubic-bezier(.7,0,.84,0)', fill: 'forwards' });
      zoom.onfinish = () => {
        cover = document.createElement('div');
        Object.assign(cover.style, { position: 'fixed', inset: 0, background: '#ffd23f', zIndex: 91 });
        document.body.appendChild(cover);
        timers.push(setTimeout(go, 40));
      };
    };
  });
})();
