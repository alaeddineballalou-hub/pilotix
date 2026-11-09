import { ReactNode, RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * A floating panel under (or above) its anchor, in our style. It takes the room it has on screen minus a margin,
 * scrolls inside when the list is long, and closes on Escape or a click outside.
 */
export function Float({ anchor, onClose, children, className = '', minWidth = 280, maxHeight = 420 }: { anchor: RefObject<HTMLElement>; onClose: () => void; children: ReactNode; className?: string; minWidth?: number; maxHeight?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number; max: number }>({ top: -9999, left: -9999, width: minWidth, max: maxHeight });
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      const M = 12;
      // the part of the page still visible (a phone's keyboard hides the bottom: the list stays above it)
      const vv = window.visualViewport;
      const bottom = vv ? Math.min(window.innerHeight, vv.offsetTop + vv.height) : window.innerHeight;
      const below = bottom - a.bottom - M - 6;
      const above = a.top - M - 6;
      // never wider than the screen (a phone: the whole width, 12 px from each edge)
      const width = Math.min(window.innerWidth - 2 * M, Math.max(a.width, minWidth));
      const left = Math.min(Math.max(M, a.left), window.innerWidth - width - M);
      if (below >= Math.min(maxHeight, 260) || below >= above) setPos({ top: a.bottom + 6, left, width, max: Math.max(140, Math.min(maxHeight, below)) });
      else setPos({ bottom: window.innerHeight - a.top + 6, left, width, max: Math.max(140, Math.min(maxHeight, above)) });
    };
    place();
    const vv = window.visualViewport;
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    vv?.addEventListener('resize', place);
    return () => (window.removeEventListener('resize', place), window.removeEventListener('scroll', place, true), vv?.removeEventListener('resize', place));
  }, [anchor, minWidth, maxHeight]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (box.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => (document.removeEventListener('mousedown', down), document.removeEventListener('keydown', key));
  }, [anchor, onClose]);
  return createPortal(
    <div ref={box} className={`px-float ${className}`} style={{ top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.max }} onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}
