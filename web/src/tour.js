// Spotlight tour. One fixed element with a huge box-shadow dims everything
// except a rounded "hole", so the spotlight can glide between targets.
//
// step = {
//   target: () => Element | null   (null = centered card, no spotlight)
//   title, body (trusted HTML from our own copy),
//   placement: 'right' | 'left' | 'bottom' | 'top' | 'inside',
//   before: async () => {}         (optional setup, e.g. load a sample)
// }

export function startTour(steps, { onEnd } = {}) {
  const block = el('div', 'tour-block');
  const spot = el('div', 'tour-spot center');
  const pop = el('div', 'tour-pop');
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true');
  pop.setAttribute('aria-live', 'polite');
  document.body.append(block, spot, pop);

  let i = 0;
  let busy = false;
  let target = null;

  const end = () => {
    window.removeEventListener('resize', place);
    window.removeEventListener('keydown', onKey, true);
    block.remove(); spot.remove(); pop.remove();
    onEnd && onEnd();
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); end(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  block.addEventListener('click', () => pop.animate(
    [{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }],
    { duration: 220 }));

  async function go(n) {
    if (busy) return;
    if (n < 0) return;
    if (n >= steps.length) return end();
    busy = true;
    i = n;
    const step = steps[i];
    pop.style.opacity = '0.35';
    try { if (step.before) await step.before(); } catch (err) { console.error('tour step setup failed', err); }
    target = step.target ? step.target() : null;
    if (target) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    render(step);
    await frame();
    place();
    pop.style.opacity = '1';
    busy = false;
    const next = pop.querySelector('[data-t="next"]');
    if (next) next.focus({ preventScroll: true });
  }

  function render(step) {
    const last = i === steps.length - 1;
    pop.innerHTML = `
      <div class="arrow"></div>
      <div class="step">${i + 1} / ${steps.length}</div>
      <h3>${step.title}</h3>
      <p>${step.body}</p>
      <footer>
        <div class="tour-dots">${steps.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
        ${last ? '' : '<button class="btn small ghost" data-t="skip">Skip</button>'}
        ${i > 0 ? '<button class="btn small" data-t="back">Back</button>' : ''}
        <button class="btn small primary" data-t="next">${last ? 'Let me play' : 'Next'}</button>
      </footer>`;
    pop.querySelector('[data-t="next"]').onclick = () => go(i + 1);
    const back = pop.querySelector('[data-t="back"]'); if (back) back.onclick = () => go(i - 1);
    const skip = pop.querySelector('[data-t="skip"]'); if (skip) skip.onclick = end;
  }

  function place() {
    const step = steps[i];
    const vw = window.innerWidth, vh = window.innerHeight, M = 12, pad = 6;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const arrow = pop.querySelector('.arrow');
    const r = target && target.isConnected ? target.getBoundingClientRect() : null;

    if (!r || r.width === 0) {
      spot.classList.add('center');
      Object.assign(spot.style, { top: `${vh / 2}px`, left: `${vw / 2}px`, width: '0px', height: '0px' });
      setPos((vw - pw) / 2, (vh - ph) / 2);
      if (arrow) arrow.style.display = 'none';
      return;
    }
    spot.classList.remove('center');
    Object.assign(spot.style, {
      top: `${r.top - pad}px`, left: `${r.left - pad}px`,
      width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`,
    });

    // Try the preferred side, then fall back to whichever side has room.
    const fits = {
      right: r.right + pad + 14 + pw <= vw - M,
      left: r.left - pad - 14 - pw >= M,
      bottom: r.bottom + pad + 14 + ph <= vh - M,
      top: r.top - pad - 14 - ph >= M,
    };
    let side = step.placement || 'right';
    if (side !== 'inside' && !fits[side]) side = ['right', 'left', 'bottom', 'top'].find((s) => fits[s]) || 'inside';

    let x, y;
    if (side === 'right') { x = r.right + pad + 14; y = r.top + r.height / 2 - ph / 2; }
    else if (side === 'left') { x = r.left - pad - 14 - pw; y = r.top + r.height / 2 - ph / 2; }
    else if (side === 'bottom') { x = r.left + r.width / 2 - pw / 2; y = r.bottom + pad + 14; }
    else if (side === 'top') { x = r.left + r.width / 2 - pw / 2; y = r.top - pad - 14 - ph; }
    else { x = r.left + 20; y = r.bottom - ph - 20; }
    x = Math.min(Math.max(M, x), vw - pw - M);
    y = Math.min(Math.max(M, y), vh - ph - M);
    setPos(x, y);

    if (!arrow) return;
    if (side === 'inside') { arrow.style.display = 'none'; return; }
    arrow.style.display = 'block';
    const ax = Math.min(Math.max(16, r.left + r.width / 2 - x - 7), pw - 30);
    const ay = Math.min(Math.max(16, r.top + r.height / 2 - y - 7), ph - 30);
    const A = { right: [ -8, ay, -45 ], left: [ pw - 7, ay, 135 ], bottom: [ ax, -8, 45 ], top: [ ax, ph - 7, 225 ] }[side];
    Object.assign(arrow.style, { left: `${A[0]}px`, top: `${A[1]}px`, transform: `rotate(${A[2]}deg)` });
  }

  function setPos(x, y) { pop.style.left = `${Math.round(x)}px`; pop.style.top = `${Math.round(y)}px`; }

  // start centered so the first transition has somewhere to glide from
  Object.assign(spot.style, { top: `${innerHeight / 2}px`, left: `${innerWidth / 2}px`, width: '0px', height: '0px' });
  go(0);
  return { end };
}

function el(tag, cls) { const e = document.createElement(tag); e.className = cls; return e; }
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
