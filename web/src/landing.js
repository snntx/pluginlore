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

// Launch: a burst of white rockets curls away from the button, each trailing a fading streak,
// like a loading animation. The app opens when the burst has played.
(function launch() {
  const btn = $('launchBtn');
  if (!btn) return;
  const dest = btn.getAttribute('href');
  const body = new Path2D('M12 2.5c3.2 2 5 5.2 5 9.2l-2.1 3.3H9.1L7 11.7c0-4 1.8-7.2 5-9.2z');
  const fins = new Path2D('M9.1 15 6 18.2v-3.6l1-2.2M14.9 15l3.1 3.2v-3.6l-1-2.2');
  const flame = new Path2D('M10.4 18.2c0 2 1.6 3.3 1.6 3.3s1.6-1.3 1.6-3.3');
  const INK = '#1c1a15', COBALT = '#3150f5';
  let canvas, raf, timer;

  function cleanup() {
    cancelAnimationFrame(raf); clearTimeout(timer);
    if (canvas) { canvas.remove(); canvas = null; }
    btn.classList.remove('going');
    btn.lastChild.textContent = ' Launch Pluginlore';
  }
  addEventListener('pageshow', (e) => { if (e.persisted) cleanup(); }); // coming back with the Back button

  btn.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (btn.classList.contains('going')) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { location.href = dest; return; }
    btn.classList.add('going');
    btn.lastChild.textContent = ' Launching...';

    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas = document.createElement('canvas'); canvas.id = 'burst';
    canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
    document.body.appendChild(canvas);
    const g = canvas.getContext('2d'); g.scale(dpr, dpr);

    const icon = btn.querySelector('.rocket').getBoundingClientRect();
    const ox = icon.left + icon.width / 2, oy = icon.top + icon.height / 2;
    const rockets = [];
    const WAVES = 4, PER = 6, GAP = 230;
    for (let w = 0; w < WAVES; w++) for (let i = 0; i < PER; i++) {
      const dir = Math.random() * Math.PI * 2;
      rockets.push({
        t0: w * GAP + i * 28, x: ox, y: oy, a: dir, trail: [],
        v: 320 + Math.random() * 380, acc: 520 + Math.random() * 600,
        turn: (Math.random() < .5 ? -1 : 1) * (1.2 + Math.random() * 3.2),
        size: 26 + Math.random() * 22, life: 1150 + Math.random() * 450, spin: Math.random() * 6,
      });
    }
    const t0 = performance.now(); let last = t0;
    const END = (WAVES - 1) * GAP + PER * 28 + 1700;

    function frame(now) {
      const t = now - t0, dt = Math.min(.05, (now - last) / 1000); last = now;
      g.clearRect(0, 0, innerWidth, innerHeight);
      for (const r of rockets) {
        const age = t - r.t0;
        if (age < 0) continue;
        const k = age / r.life;
        if (k < 1) {
          r.v += r.acc * dt;
          r.a += r.turn * dt * (1 - k * .4);              // keeps curling while it flies
          r.x += Math.cos(r.a) * r.v * dt; r.y += Math.sin(r.a) * r.v * dt;
          r.trail.push([r.x, r.y]); if (r.trail.length > 40) r.trail.shift();
        } else if (r.trail.length) r.trail.shift();         // trail drains away after the rocket is gone
        const fade = k < 1 ? 1 : 0;
        // trail: one tapered ribbon (wide near the rocket, thin at the tail), so it reads as a smooth streak
        const n = r.trail.length;
        if (n > 2) {
          const wMax = r.size * .2, left = [], right = [];
          for (let i = 0; i < n; i++) {
            const p = i / (n - 1), a0 = r.trail[Math.max(0, i - 1)], a1 = r.trail[Math.min(n - 1, i + 1)];
            const dx = a1[0] - a0[0], dy = a1[1] - a0[1], len = Math.hypot(dx, dy) || 1;
            const w = (.4 + p * wMax) / 2, nx = -dy / len * w, ny = dx / len * w;
            left.push([r.trail[i][0] + nx, r.trail[i][1] + ny]); right.push([r.trail[i][0] - nx, r.trail[i][1] - ny]);
          }
          g.beginPath(); g.moveTo(left[0][0], left[0][1]);
          for (let i = 1; i < n; i++) g.lineTo(left[i][0], left[i][1]);
          for (let i = n - 1; i >= 0; i--) g.lineTo(right[i][0], right[i][1]);
          g.closePath();
          const grad = g.createLinearGradient(r.trail[0][0], r.trail[0][1], r.trail[n - 1][0], r.trail[n - 1][1]);
          grad.addColorStop(0, 'rgba(49,80,245,0)'); grad.addColorStop(1, 'rgba(49,80,245,.7)');
          g.globalAlpha = k < 1 ? 1 : Math.max(0, 1 - (k - 1) * 3);
          g.fillStyle = grad; g.fill();
        }
        if (!fade) continue;
        const o = k > .8 ? 1 - (k - .8) / .2 : 1;           // fade out at the end of its flight
        g.save(); g.globalAlpha = Math.max(0, o);
        g.translate(r.x, r.y); g.rotate(r.a + Math.PI / 2 + Math.sin(age / 90 + r.spin) * .25);
        const s = r.size / 24; g.scale(s, s); g.translate(-12, -12);
        g.lineJoin = 'round'; g.lineCap = 'round'; g.lineWidth = 1.7 / s * 1.15;
        g.fillStyle = '#fff'; g.strokeStyle = INK;
        g.fill(body); g.stroke(body); g.stroke(fins); g.stroke(flame);
        g.beginPath(); g.arc(12, 9.5, 1.7, 0, 7); g.fillStyle = COBALT; g.fill(); g.stroke();
        g.restore();
      }
      g.globalAlpha = 1;
      if (t < END) raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    timer = setTimeout(() => { if (!location.search.includes('nonav')) location.href = dest; }, 1500);
  });
})();
