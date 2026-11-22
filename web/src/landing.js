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
