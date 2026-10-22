// One date button for the Statistiques cards: quick periods on the side, a month calendar to pick the first
// and the last day, in Pilotix's colours. Days are Algiers days ('YYYY-MM-DD'), like the server's periods.
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../../ui/kit';
import { Kf } from './shared';

const DAY = 86_400_000;
const PRESETS = ['today', 'yesterday', '7', '30', 'month'] as const;
type Range = { from: string; to: string };

export const algToday = () => new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
const toT = (s: string) => Date.parse(`${s}T00:00:00Z`);
const toS = (t: number) => new Date(t).toISOString().slice(0, 10);
const addD = (s: string, n: number) => toS(toT(s) + n * DAY);

/** The days a quick period covers (same rules as the server's kfRange). */
export function presetRange(p: Kf['per'], today = algToday()): Range {
  switch (p) {
    case 'yesterday':
      return { from: addD(today, -1), to: addD(today, -1) };
    case '7':
      return { from: addD(today, -6), to: today };
    case '30':
      return { from: addD(today, -29), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    default:
      return { from: today, to: today };
  }
}

const locOf = (lang: string) => (lang.startsWith('ar') ? 'ar-DZ' : lang.startsWith('en') ? 'en-GB' : 'fr-FR');
const fmt = (loc: string, s: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc, { timeZone: 'UTC', ...o }).format(toT(s));
const day = (loc: string, s: string, year: boolean) => fmt(loc, s, { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}) });
export function rangeText(lang: string, r: Range) {
  const loc = locOf(lang);
  if (r.from === r.to) return day(loc, r.from, true);
  return `${day(loc, r.from, r.from.slice(0, 4) !== r.to.slice(0, 4))} → ${day(loc, r.to, true)}`;
}
/** "Aujourd'hui", "7 jours"… or the chosen days, written out. */
export function periodLabel(t: (k: string) => string, lang: string, kf: Kf) {
  return kf.per === 'custom' ? rangeText(lang, { from: kf.from || algToday(), to: kf.to || algToday() }) : t(`confirmation.per.${kf.per}`);
}

export function DateRange({ kf, onChange }: { kf: Kf; onChange: (p: Pick<Kf, 'per' | 'from' | 'to'>) => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language || 'fr';
  const loc = locOf(lang);
  const today = algToday();
  const cur: Range = kf.per === 'custom' ? { from: kf.from || today, to: kf.to || today } : presetRange(kf.per, today);
  const [open, setOpen] = useState(false);
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [month, setMonth] = useState(cur.to.slice(0, 7));
  const btn = useRef<HTMLButtonElement>(null);

  const show = () => {
    setA(cur.from);
    setB(cur.to);
    setHover(null);
    setMonth(cur.to.slice(0, 7));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  const pick = (s: string) => {
    if (a && !b) {
      if (s < a) {
        setB(a);
        setA(s);
      } else setB(s);
    } else {
      setA(s);
      setB(null);
    }
  };
  const apply = () => {
    if (!a) return;
    onChange({ per: 'custom', from: a, to: b ?? a });
    close();
  };
  const quick = (p: (typeof PRESETS)[number]) => {
    onChange({ per: p, ...presetRange(p, today) });
    close();
  };

  // the month grid, weeks starting on Monday
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const first = Date.UTC(y, m - 1, 1);
  const lead = (new Date(first).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => toS(first + i * DAY))];
  const shift = (n: number) => setMonth(toS(Date.UTC(y, m - 1 + n, 1)).slice(0, 7));
  const end = b ?? (a && hover ? hover : a);
  const lo = a && end ? (end < a ? end : a) : a;
  const hi = a && end ? (end < a ? a : end) : a;
  const heads = Array.from({ length: 7 }, (_, i) => fmt(loc, toS(toT('2024-01-01') + i * DAY), { weekday: 'short' }).replace('.', ''));
  const presetOn = (p: string) => kf.per === p;

  return (
    <div className="px-dr" onKeyDown={(e) => e.key === 'Escape' && open && (e.stopPropagation(), close())}>
      <button ref={btn} type="button" className={`px-dr-btn${open ? ' on' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : show())}>
        <Icon name="calendar" />
        <span>{periodLabel(t, lang, kf)}</span>
        <svg className="px-dr-ch" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <>
          <div className="px-dr-veil" onClick={close} aria-hidden="true" />
          <div className="px-dr-pop" role="dialog" aria-label={t('confirmation.dr.title')}>
            <div className="px-dr-presets">
              {PRESETS.map((p) => (
                <button key={p} type="button" className={presetOn(p) ? 'on' : ''} onClick={() => quick(p)}>
                  {t(`confirmation.per.${p}`)}
                </button>
              ))}
            </div>
            <div className="px-dr-cal">
              <div className="px-dr-month">
                <button type="button" className="px-dr-nav" aria-label={t('confirmation.dr.prev')} onClick={() => shift(-1)}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m15 6-6 6 6 6" />
                  </svg>
                </button>
                <b>{fmt(loc, `${month}-01`, { month: 'long', year: 'numeric' })}</b>
                <button type="button" className="px-dr-nav" aria-label={t('confirmation.dr.next')} disabled={month >= today.slice(0, 7)} onClick={() => shift(1)}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </button>
              </div>
              <div className="px-dr-grid" role="grid" onMouseLeave={() => setHover(null)}>
                {heads.map((h, i) => (
                  <span key={`h${i}`} className="px-dr-wd" role="columnheader">
                    {h}
                  </span>
                ))}
                {cells.map((s, i) =>
                  s === null ? (
                    <span key={`e${i}`} aria-hidden="true" />
                  ) : (
                    <button
                      key={s}
                      type="button"
                      disabled={s > today}
                      aria-pressed={!!(lo && hi && s >= lo && s <= hi)}
                      aria-label={fmt(loc, s, { day: 'numeric', month: 'long', year: 'numeric' })}
                      className={['px-dr-d', s === lo && 'st', s === hi && 'en', lo && hi && s > lo && s < hi && 'in', s === today && 'td'].filter(Boolean).join(' ')}
                      onMouseEnter={() => setHover(s)}
                      onClick={() => pick(s)}
                    >
                      <span>{Number(s.slice(8))}</span>
                    </button>
                  ),
                )}
              </div>
              <div className="px-dr-foot">
                <span className="px-dr-sum">{a ? (b ? rangeText(lang, { from: a, to: b }) : `${rangeText(lang, { from: a, to: a })} → …`) : t('confirmation.dr.hint')}</span>
                <button type="button" className="btn ghost small" onClick={close}>
                  {t('confirmation.dr.cancel')}
                </button>
                <button type="button" className="btn primary small" disabled={!a} onClick={apply}>
                  {t('confirmation.dr.apply')}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
