// Helpers shared by the Accueil and Dashboard pages (stats feature).
import type { Tone } from '@pilotix/shared';
import { ReactNode, useState } from 'react';
import { periodRange, Period } from '../../lib/format';
import { store } from '../../lib/store';
import i18n from '../../lib/i18n';

const DAY = 86_400_000;
const ALG = 3_600_000;

/** Algiers midnight of a YYYY-MM-DD date, as a UTC timestamp. */
export const dayStart = (d: string) => Date.parse(`${d}T00:00:00Z`) - ALG;
/** YYYY-MM-DD (Algiers) of a timestamp. */
export const ymd = (t: number) => new Date(t + ALG).toISOString().slice(0, 10);

export type AnyPeriod = Period | 'week' | 'lastweek' | 'custom';

/** A period preset (or custom dates) → { from, to } ISO range; `to` is exclusive. */
export function rangeOf(p: AnyPeriod, custom?: { from: string; to: string }): { from: string; to: string } {
  if (p === 'custom' && custom?.from && custom?.to) {
    const a = dayStart(custom.from);
    const b = dayStart(custom.to) + DAY;
    return { from: new Date(Math.min(a, b - DAY)).toISOString(), to: new Date(Math.max(b, a + DAY)).toISOString() };
  }
  if (p === 'week' || p === 'lastweek') {
    const today = dayStart(ymd(Date.now()));
    const dow = new Date(today + ALG).getUTCDay(); // 0 = Sunday (the Algerian working week starts on Sunday)
    const start = today - dow * DAY - (p === 'lastweek' ? 7 * DAY : 0);
    return { from: new Date(start).toISOString(), to: new Date(p === 'lastweek' ? start + 7 * DAY : today + DAY).toISOString() };
  }
  return periodRange((p === 'custom' ? '7d' : p) as Period);
}

/** Inclusive date inputs for a range. */
export const inputsOf = (r: { from: string; to: string }) => ({ from: ymd(Date.parse(r.from)), to: ymd(Date.parse(r.to) - 1) });

/** "Du jeudi 15 octobre au mercredi 21 octobre 2026" */
export function rangeLabel(r: { from: string; to: string }) {
  const loc = i18n.language === 'ar' ? 'ar-DZ' : i18n.language === 'en' ? 'en-GB' : 'fr-FR';
  const f = (t: number, year: boolean) => new Intl.DateTimeFormat(loc, { weekday: 'long', day: 'numeric', month: 'long', ...(year ? { year: 'numeric' } : {}), timeZone: 'Africa/Algiers', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions).format(t);
  const a = Date.parse(r.from);
  const b = Date.parse(r.to) - 1;
  if (ymd(a) === ymd(b)) return f(a, true);
  return i18n.t('dashboard.range', { from: f(a, false), to: f(b, true) });
}

/** A value remembered in localStorage (per viewer). */
export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => store.json<T>(key, initial));
  return [
    v,
    (nv: T) => {
      setV(nv);
      store.set(key, JSON.stringify(nv));
    },
  ];
}

// ---------------------------------------------------------------- tones (same thresholds as the original)
/** Confirmation rate: red under 50 %, yellow 50–59 %, green from 60 %. */
export const confTone = (r: number | null | undefined, badge = false): Tone | undefined => (r === null || r === undefined ? undefined : r < 0.5 ? 'bad' : r < 0.6 ? (badge ? 'mid' : 'warn') : 'ok');
/** On-time rates (1st call, tries): red under 70 %, yellow 70–79 %, green from 80 %. */
export const timeTone = (r: number | null | undefined): Tone | undefined => (r === null || r === undefined ? undefined : r < 0.7 ? 'bad' : r < 0.8 ? 'warn' : 'ok');
/** Delivery rate: red under 50 %, yellow 50–69 %, green from 70 %. */
export const delivTone = (r: number | null | undefined, badge = false): Tone | undefined => (r === null || r === undefined ? undefined : r < 0.5 ? 'bad' : r < 0.7 ? (badge ? 'mid' : 'warn') : 'ok');

// ---------------------------------------------------------------- KPI box (original markup: .kpi .l .v .s, link or block, "?" popup)
export function KpiBox({ label, value, sub, tone, href, help, zero, className = '' }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone; href?: string; help?: string; zero?: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const cls = `kpi${help ? ' bjt-k' : ''}${tone ? ` t-${tone}` : ''}${zero ? ' px-zero' : ''} ${className}`.trim();
  const body = (
    <>
      <span className={`l${help ? ' bjt-kl' : ''}`}>
        {label}
        {help && (
          <button
            type="button"
            className="bjt-q"
            aria-label={`${i18n.t('dashboard.explain')} : ${typeof label === 'string' ? label : ''}`}
            aria-expanded={open}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen(!open);
            }}
            onBlur={() => setOpen(false)}
          >
            ?
          </button>
        )}
      </span>
      <span className="v ltr">{value}</span>
      {sub !== undefined && <span className="s">{sub}</span>}
      {help && (
        <div className="bjt-pop" role="tooltip" hidden={!open}>
          {help}
        </div>
      )}
    </>
  );
  return href ? (
    <a className={cls} href={href}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Badge({ tone, children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={`badge ${tone ? `t-${tone}` : ''} ${className} ltr`.trim()}>{children}</span>;
}
