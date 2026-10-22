import { useEffect, useState } from 'react';

/** True while the media query matches (updates on resize / rotation). */
export function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const fn = () => setOn(m.matches);
    fn();
    m.addEventListener('change', fn);
    return () => m.removeEventListener('change', fn);
  }, [query]);
  return on;
}

/** Phones: the width under which tables become cards (same breakpoint as the stylesheets). */
export const useIsPhone = () => useMedia('(max-width: 760px)');
