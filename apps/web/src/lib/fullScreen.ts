import { useEffect, useRef } from 'react';

/** Full-screen phone pages: the page behind does not scroll; Échap / the phone's back closes. One history entry is
 *  shared by stacked pages, so going from one page to the next does not pop the new one. */
let openPages = 0;
export function useFullScreen(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    openPages++;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal-wrap, .pxv-sheet, .pxk-sheet') && ref.current();
    // a back that lands on this entry closed a sheet above the page: the page stays
    const back = (e: PopStateEvent) => !e.state?.pxv && ref.current();
    if (!history.state?.pxv) history.pushState({ pxv: 1 }, '');
    window.addEventListener('keydown', esc);
    window.addEventListener('popstate', back);
    return () => {
      openPages--;
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', esc);
      window.removeEventListener('popstate', back);
      setTimeout(() => {
        if (!openPages && history.state?.pxv) history.back();
      }, 0);
    };
  }, []);
}
