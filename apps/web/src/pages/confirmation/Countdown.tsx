import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../ui/kit';

// One shared 1-second clock for every countdown chip on screen.
const subs = new Set<(t: number) => void>();
let timer: number | undefined;
function subscribe(fn: (t: number) => void) {
  subs.add(fn);
  if (!timer) timer = window.setInterval(() => subs.forEach((s) => s(Date.now())), 1000);
  return () => {
    subs.delete(fn);
    if (!subs.size && timer) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}
/** Current time, refreshed every second. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => subscribe(setNow), []);
  return now;
}

/** "12:05" under an hour, "3 h 07", "2 j 9 h" — like the original chips. */
export function cdText(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)} j ${h % 24} h`;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export interface Deadline {
  t: number;
  m: 'first' | 'slot' | 'start';
  e?: number;
}

/** The `.bj-cd` chip: ok (green), soon (< 5 min, blinking), late (coral, "+…"), wait (grey, next slot). */
export function Countdown({ d }: { d: Deadline }) {
  const { t } = useTranslation();
  const now = useNow();
  let mode = d.m;
  let at = d.t;
  if (mode === 'start' && at - now <= 0) {
    mode = 'slot';
    at = d.e ?? d.t;
  }
  const left = at - now;
  if (mode === 'start') {
    const txt = cdText(left);
    return (
      <span className="bj-cd wait" title={t('confirmation.cd.waitTitle', { d: txt })}>
        <Icon name="hourglass" /> {t('confirmation.cd.wait', { d: txt })}
      </span>
    );
  }
  const txt = cdText(left);
  if (left < 0)
    return (
      <span className="bj-cd late ltr" title={t('confirmation.cd.lateTitle', { d: txt })}>
        <Icon name="timer" /> +{txt}
      </span>
    );
  return (
    <span className={`bj-cd ltr ${left < 5 * 60_000 ? 'soon' : 'ok'}`} title={t(mode === 'slot' ? 'confirmation.cd.slotTitle' : 'confirmation.cd.firstTitle', { d: txt })}>
      <Icon name="timer" /> {txt}
    </span>
  );
}
