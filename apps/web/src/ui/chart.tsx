// Small SVG charts drawn by hand (no chart library): sized to where they are shown, round steps on the scale, dates on
// one regular step under the axis, time running left to right in every language. Used by the control room's
// Pilotix Protection System and by a store's Protection page.
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { n } from '../lib/format';
import './chart.css';

export function useLoc() {
  const { i18n } = useTranslation();
  return i18n.language === 'ar' ? 'ar-DZ' : i18n.language === 'en' ? 'en-GB' : 'fr-FR';
}
export const shortDayIn = (loc: string, day: string) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', timeZone: 'UTC', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions).format(Date.parse(day));
export function shortDay(day: string) {
  const lang = document.documentElement.lang;
  return shortDayIn(lang === 'ar' ? 'ar-DZ' : lang === 'en' ? 'en-GB' : 'fr-FR', day);
}

/** drawn at the size it is shown, so its words keep their size (a phone, a half row, a full row) */
export function useBox() {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setBox({ w: Math.round(r.width), h: Math.round(r.height) });
    const ro = new ResizeObserver(([e]) => setBox({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, box] as const;
}

/** round steps from 0 (1, 2, 5, 10, 20…), 4 or 5 of them, the top tick above the highest value */
export function ticksFor(max: number): number[] {
  const m = Math.max(3, max);
  let step = 1;
  for (let k = 0; k < 30; k++) {
    step = [1, 2, 5][k % 3] * 10 ** Math.floor(k / 3);
    if (Math.floor(m / step) + 1 <= 5) break;
  }
  const top = (Math.floor(m / step) + 1) * step;
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}

/** which days get a date under the axis: the last one, then every few days back, on one regular step */
export function labelStep(count: number, width: number): number {
  const fit = Math.max(2, Math.min(8, Math.floor(width / 64)));
  const raw = Math.ceil(count / fit);
  return [1, 2, 3, 5, 7, 10, 14, 15, 20, 30].find((s) => s >= raw) ?? raw;
}

export function Axis({ ticks, y, L, R, W }: { ticks: number[]; y: (v: number) => number; L: number; R: number; W: number }) {
  return (
    <>
      {ticks.map((v, i) => (
        <g key={v}>
          <line className={i === 0 ? 'base' : 'g'} x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
          <text className="ax" x={L - 8} y={y(v) + 4} textAnchor="end">
            {n(v)}
          </text>
        </g>
      ))}
    </>
  );
}

export function DateLabels({ days, x, iw, L, R, W, Hy }: { days: { day: string }[]; x: (i: number) => number; iw: number; L: number; R: number; W: number; Hy: number }) {
  const loc = useLoc();
  const step = labelStep(days.length, iw);
  return (
    <>
      {days.map((d, i) =>
        (days.length - 1 - i) % step === 0 ? (
          <text key={d.day} className="ax" x={x(i)} y={Hy} textAnchor={x(i) < L + 24 ? 'start' : x(i) > W - R - 24 ? 'end' : 'middle'}>
            {shortDayIn(loc, d.day)}
          </text>
        ) : null,
      )}
    </>
  );
}
