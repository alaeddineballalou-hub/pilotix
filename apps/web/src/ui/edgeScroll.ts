/**
 * Tables wider than their card: with the mouse near the card's left or right end — on any row, not only at the
 * scrollbar under the last one — the table scrolls that way, faster nearer the end. A round orange arrow shows where.
 * The arrow lets clicks through, so the cells under it still work. Installed once for every table (.tbl-wrap).
 */
const ZONE = 56; // px from each end of the card
const DELAY = 250; // ms of hovering before it starts (moving past an end does not scroll)

export function installEdgeScroll() {
  const w0 = window as Window & { __pxEdge?: boolean };
  if (w0.__pxEdge) return;
  w0.__pxEdge = true;

  const hint = document.createElement('div');
  hint.className = 'px-edge';
  hint.setAttribute('aria-hidden', 'true');
  hint.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';

  let wrap: HTMLElement | null = null;
  let dir = 0;
  let depth = 0;
  let since = 0;
  let raf = 0;

  const stop = () => {
    dir = 0;
    wrap = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    hint.classList.remove('on');
  };

  const tick = (t: number) => {
    raf = 0;
    if (!wrap || !dir || !wrap.isConnected) return stop();
    if (t - since >= DELAY) {
      const before = wrap.scrollLeft;
      wrap.scrollLeft += dir * (2 + 16 * depth * depth);
      if (Math.abs(wrap.scrollLeft - before) < 0.5) return stop(); // reached the end
    }
    raf = requestAnimationFrame(tick);
  };

  document.addEventListener(
    'pointermove',
    (e) => {
      // not with a finger or a pen, and not while a button is held (resizing a column, selecting text)
      if (e.pointerType !== 'mouse' || e.buttons) return stop();
      const w = (e.target as Element | null)?.closest?.('.tbl-wrap') as HTMLElement | null;
      if (!w) return stop();
      const max = w.scrollWidth - w.clientWidth;
      if (max < 2) return stop();
      const r = w.getBoundingClientRect();
      // scrollLeft runs 0 → max in LTR and 0 → −max in RTL: +x always moves the view to the right
      const pos = Math.abs(w.scrollLeft);
      const rtl = getComputedStyle(w).direction === 'rtl';
      const canLeft = rtl ? pos < max - 1 : pos > 1;
      const canRight = rtl ? pos > 1 : pos < max - 1;
      const fromL = e.clientX - r.left;
      const fromR = r.right - e.clientX;
      let d = 0;
      let dep = 0;
      if (fromL < ZONE && canLeft) (d = -1), (dep = 1 - fromL / ZONE);
      else if (fromR < ZONE && canRight) (d = 1), (dep = 1 - fromR / ZONE);
      if (!d) return stop();
      if (d !== dir || w !== wrap) since = performance.now();
      wrap = w;
      dir = d;
      depth = Math.max(0, Math.min(1, dep));
      // the arrow at the mouse's height, inside the part of the table on screen (below the top bar)
      const bar = document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 0;
      const top = Math.max(r.top, bar, 0) + 22;
      const bottom = Math.min(r.bottom, window.innerHeight) - 22;
      if (!hint.isConnected) document.body.appendChild(hint);
      hint.style.top = `${Math.min(Math.max(e.clientY, top), Math.max(top, bottom))}px`;
      hint.style.left = `${d < 0 ? r.left + 8 : r.right - 8 - 36}px`;
      hint.classList.toggle('l', d < 0);
      hint.classList.add('on');
      if (!raf) raf = requestAnimationFrame(tick);
    },
    { passive: true },
  );
  // the mouse leaves the window, the page scrolls, the window loses focus
  document.addEventListener('mouseout', (e) => !e.relatedTarget && stop());
  window.addEventListener('scroll', stop, { passive: true });
  window.addEventListener('blur', stop);
}
