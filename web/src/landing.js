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


// Trailer popup: grows out of the Watch button with a springy ease, the page dims and blurs behind it, and the
// video only starts downloading when it is opened. Esc, the X or a click outside closes it.
(function trailer() {
  const btn = $('watchBtn'), modal = $('trailerModal'), card = $('trailerCard'), video = $('trailerVideo');
  if (!btn || !modal) return;
  const back = modal.querySelector('.tm-back');
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let open = false, anim = [];

  function from() {                       // card starts as the button, then grows to its place
    const b = btn.getBoundingClientRect(), c = card.getBoundingClientRect();
    return `translate(${b.left + b.width / 2 - (c.left + c.width / 2)}px, ${b.top + b.height / 2 - (c.top + c.height / 2)}px) scale(${Math.max(.08, b.width / c.width)}, ${Math.max(.08, b.height / c.height)})`;
  }
  function run(opening) {
    anim.forEach((a) => a.cancel()); anim = [];
    const ms = reduce() ? 160 : opening ? 520 : 320;
    const easing = opening ? 'cubic-bezier(.2,1.05,.3,1)' : 'cubic-bezier(.5,0,.75,0)';
    anim.push(back.animate([{ opacity: opening ? 0 : 1 }, { opacity: opening ? 1 : 0 }], { duration: ms, easing: 'ease', fill: 'forwards' }));
    const keys = reduce()
      ? [{ opacity: opening ? 0 : 1 }, { opacity: opening ? 1 : 0 }]
      : opening ? [{ opacity: 0, transform: from(), borderRadius: '40px' }, { opacity: 1, transform: 'none', borderRadius: '16px' }]
                : [{ opacity: 1, transform: 'none', borderRadius: '16px' }, { opacity: 0, transform: from(), borderRadius: '40px' }];
    const a = card.animate(keys, { duration: ms, easing, fill: 'forwards' });
    anim.push(a);
    return a;
  }
  function show() {
    if (open) return; open = true;
    if (!video.getAttribute('src')) video.src = video.dataset.src;       // first open: start loading now
    modal.hidden = false; document.body.classList.add('tm-open');
    run(true).onfinish = () => { card.querySelector('.tm-x').focus({ preventScroll: true }); };
    const p = video.play(); if (p && p.catch) p.catch(() => { /* needs a tap: controls are visible */ });
  }
  function hide() {
    if (!open) return; open = false;
    video.pause();
    run(false).onfinish = () => { if (!open) { modal.hidden = true; document.body.classList.remove('tm-open'); btn.focus({ preventScroll: true }); } };
  }
  btn.addEventListener('click', show);
  modal.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) hide(); });
  addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); hide(); }
    if (e.key === 'Tab') {                                               // keep focus inside the popup
      const f = [...modal.querySelectorAll('button, video')];
      const i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    }
  });
})();
