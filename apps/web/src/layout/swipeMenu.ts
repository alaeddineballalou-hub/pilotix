// Phone menu by swipe (the app and the website on a phone): a swipe toward the inside opens the menu (it follows the
// finger), a swipe back toward its edge closes it. The menu sits on the left in French and English, on the right in Arabic.
// A swipe that starts in something that scrolls sideways (a table, tabs…), in a field or in a map is left alone.
import { useEffect } from 'react';

const PHONE = '(max-width: 900px)';
/** a closed menu opens from this part of the screen, from its edge (40 %) */
const ZONE = 0.4;

function scrollsSideways(el: Element | null): boolean {
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    if (n.matches('input, textarea, select, [contenteditable="true"], [data-noswipe], canvas, iframe, video')) return true;
    if (n.scrollWidth > n.clientWidth + 2) {
      const o = getComputedStyle(n).overflowX;
      if (o === 'auto' || o === 'scroll') return true;
    }
  }
  return false;
}

export function useSwipeMenu(open: boolean, setOpen: (v: boolean) => void) {
  useEffect(() => {
    const side = document.getElementById('side');
    if (!side) return;
    const body = document.body;
    let x0 = 0;
    let y0 = 0;
    let t0 = 0;
    let w = 270;
    /** 1 = the menu opens toward the right (left menu), -1 toward the left (Arabic) */
    let s = 1;
    /** 0: waiting, 1: maybe, 2: dragging, -1: not a menu swipe */
    let mode = 0;
    let shown = open ? 1 : 0;

    const paint = (p: number) => {
      shown = p;
      side.style.transform = `translateX(${s * (p - 1) * w}px)`;
      body.style.setProperty('--nav-p', String(p));
    };
    const clear = () => {
      side.style.transform = '';
      body.classList.remove('nav-drag');
      body.style.removeProperty('--nav-p');
    };

    const start = (e: TouchEvent) => {
      mode = -1;
      if (e.touches.length !== 1 || !window.matchMedia(PHONE).matches) return;
      const tch = e.touches[0];
      s = document.documentElement.dir === 'rtl' ? -1 : 1;
      w = side.offsetWidth || 270;
      const fromEdge = s === 1 ? tch.clientX : window.innerWidth - tch.clientX;
      if (!open && (fromEdge > window.innerWidth * ZONE || scrollsSideways(e.target as Element))) return;
      x0 = tch.clientX;
      y0 = tch.clientY;
      t0 = e.timeStamp;
      mode = 1;
    };
    const move = (e: TouchEvent) => {
      if (mode < 1) return;
      const tch = e.touches[0];
      const dx = (tch.clientX - x0) * s;
      const dy = tch.clientY - y0;
      if (mode === 1) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        // sideways enough, and toward the right way (inside to open, back to the edge to close)
        if (Math.abs(dx) < Math.abs(dy) * 1.3 || (open ? dx > 0 : dx < 0)) {
          mode = -1;
          return;
        }
        mode = 2;
        body.classList.add('nav-drag');
      }
      e.preventDefault();
      const p = open ? 1 + dx / w : dx / w;
      paint(Math.max(0, Math.min(1, p)));
    };
    const end = (e: TouchEvent) => {
      if (mode !== 2) {
        mode = 0;
        return;
      }
      mode = 0;
      const dx = ((e.changedTouches[0]?.clientX ?? x0) - x0) * s;
      const speed = dx / Math.max(1, e.timeStamp - t0); // px per ms
      const next = Math.abs(speed) > 0.5 ? speed > 0 : shown > 0.5;
      // let the menu glide from where the finger left it to its end
      body.classList.remove('nav-drag');
      requestAnimationFrame(() => {
        clear();
        if (next !== open) setOpen(next);
      });
    };

    document.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', end, { passive: true });
    return () => {
      document.removeEventListener('touchstart', start);
      document.removeEventListener('touchmove', move);
      document.removeEventListener('touchend', end);
      document.removeEventListener('touchcancel', end);
      clear();
    };
  }, [open, setOpen]);
}
