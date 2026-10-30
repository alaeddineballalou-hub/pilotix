import { useEffect, useState, useSyncExternalStore } from 'react';

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

/**
 * A mouse or trackpad (not a touch screen). List menus (wilaya, commune, bureau) put the cursor in their search box
 * right away only then: on a phone or tablet that opens the keyboard by itself, hides most of the list and makes
 * the menu jump above the field. On a touch screen the person scrolls the list, or taps the search box to type.
 */
export const hasMouse = () => typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

// The theme the page shows (html[data-theme], set by the moon button or the phone's setting): one watcher for all.
const themeSubs = new Set<() => void>();
let themeWatch: MutationObserver | null = null;
function watchTheme(fn: () => void) {
  themeSubs.add(fn);
  if (!themeWatch && typeof MutationObserver !== 'undefined') {
    themeWatch = new MutationObserver(() => themeSubs.forEach((f) => f()));
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  return () => {
    themeSubs.delete(fn);
    if (!themeSubs.size) {
      themeWatch?.disconnect();
      themeWatch = null;
    }
  };
}
const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';

/** True while the page is in the dark theme (for pictures that have a dark version, e.g. the companies' logos). */
export const useIsDark = () => useSyncExternalStore(watchTheme, isDark, () => false);
