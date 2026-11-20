// A big table on a tablet (Confirmation, Suivi): only its most useful columns, in the table's own order, so a row fits
// the screen without scrolling sideways. One button shows the others (and hides them again). On a computer every
// column the person chose shows; on a phone the tables are cards.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMedia } from '../lib/useMedia';

/** the tablet's width: above the phones' cards (760 px), under a computer's screen */
const TABLET = '(min-width: 761px) and (max-width: 1100px)';

/**
 * The columns to draw: on a tablet, the first `max` of `useful` the table has (filled up in the table's order when it
 * has fewer of them), unless the person asked for all of them.
 */
export function useTabletCols<T>(cols: T[], keyOf: (c: T) => string, useful: string[], max = 6) {
  const tablet = useMedia(TABLET);
  const [all, setAll] = useState(false);
  if (!tablet || cols.length <= max) return { cols, more: 0, all: false, toggle: null };
  if (all) return { cols, more: 0, all: true, toggle: () => setAll(false) };
  const keep = new Set(useful.filter((k) => cols.some((c) => keyOf(c) === k)).slice(0, max));
  for (const c of cols) if (keep.size < max) keep.add(keyOf(c));
  const shown = cols.filter((c) => keep.has(keyOf(c)));
  return { cols: shown, more: cols.length - shown.length, all: false, toggle: () => setAll(true) };
}

/** « +5 colonnes » / « Moins de colonnes »: only on a tablet, when columns are hidden or shown again. */
export function TabletColsButton({ more, all, toggle }: { more: number; all: boolean; toggle: (() => void) | null }) {
  const { t } = useTranslation();
  if (!toggle) return null;
  return (
    <button type="button" className="btn small px-tcols" aria-pressed={all} onClick={toggle}>
      {all ? t('common.cols.less') : t('common.cols.more', { count: more })}
    </button>
  );
}
