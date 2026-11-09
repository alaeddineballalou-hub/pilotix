/**
 * Rows that scroll sideways on a phone (tabs, periods, filters): the side where more is hidden fades out, so a tab cut by
 * the screen's edge reads « there is more, slide » instead of « broken ». One watcher for the whole app (the AI pages'
 * rows do the same with their own hook, pages/ai/agent.tsx). Sets data-more="l r" (the sides, on screen) and
 * data-fade="s e" (start / end, for right to left); styles/ux.css draws the fade.
 */
export const FADE_ROWS = '.bjm-bar, .px-pf-tabs, .bqp-tabs, .pxd-tabs, .bjp-tabs, .tb-per, .tb-teams, .pxv-road, .pxn-per, .prx-chips, .pxr-f, .tabs';

function check(el: HTMLElement) {
  const hidden = el.scrollWidth - el.clientWidth;
  let more = '';
  let fade = '';
  if (hidden > 1) {
    const s = getComputedStyle(el);
    if (/(auto|scroll)/.test(s.overflowX)) {
      // right to left: scrollLeft goes from 0 (start, on the right) down to -hidden
      const x = Math.abs(el.scrollLeft);
      const before = x > 1;
      const after = x < hidden - 1;
      const rtl = s.direction === 'rtl';
      more = `${(rtl ? after : before) ? 'l' : ''} ${(rtl ? before : after) ? 'r' : ''}`.trim();
      fade = `${before ? 's' : ''} ${after ? 'e' : ''}`.trim();
    }
  }
  if ((el.dataset.more ?? '') !== more) {
    if (more) el.dataset.more = more;
    else delete el.dataset.more;
  }
  if ((el.dataset.fade ?? '') !== fade) {
    if (fade) el.dataset.fade = fade;
    else delete el.dataset.fade;
  }
}

export function installEdgeFade() {
  const w = window as Window & { __pxFade?: boolean };
  if (w.__pxFade) return;
  w.__pxFade = true;
  let raf = 0;
  const all = () => {
    raf = 0;
    document.querySelectorAll<HTMLElement>(FADE_ROWS).forEach(check);
  };
  const soon = () => {
    if (!raf) raf = requestAnimationFrame(all);
  };
  // a row slid by the finger: its own fades follow
  document.addEventListener(
    'scroll',
    (e) => {
      const t = e.target;
      if (t instanceof HTMLElement && t.matches(FADE_ROWS)) check(t);
    },
    { capture: true, passive: true },
  );
  window.addEventListener('resize', soon);
  // pages and tabs come and go: checked again (once a frame at most)
  new MutationObserver(soon).observe(document.documentElement, { childList: true, subtree: true });
  soon();
}
