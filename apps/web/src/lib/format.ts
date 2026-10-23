import { WILAYAS, WILAYAS_AR } from '@pilotix/shared';
import i18n from './i18n';

const loc = () => (i18n.language === 'ar' ? 'ar-DZ' : i18n.language === 'en' ? 'en-GB' : 'fr-FR');
const nf = (opts: Intl.NumberFormatOptions = {}) => new Intl.NumberFormat(loc(), { numberingSystem: 'latn', maximumFractionDigits: 0, ...opts } as Intl.NumberFormatOptions);

/** 12 900 DA / 12 900 د.ج */
export const da = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${nf().format(v)} ${i18n.language === 'ar' ? 'د.ج' : 'DA'}`);
export const n = (v: number | null | undefined) => (v === null || v === undefined ? '—' : nf().format(v));
/** 0.724 → 72 % */
export const pct = (v: number | null | undefined, digits = 0) => (v === null || v === undefined || !isFinite(v) ? '—' : `${nf({ maximumFractionDigits: digits }).format(v * 100)} %`);
/** 1234 → 1,2k (menu counts) */
export const compact = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1).replace('.', ',')}k` : String(v));

const TZ = 'Africa/Algiers';
const df = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc(), { timeZone: TZ, numberingSystem: 'latn', ...o } as Intl.DateTimeFormatOptions);
const dayKey = (t: number) => df({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);

/** "aujourd'hui 21:19", "hier 19:53", "18 oct. 08:51" — like the original app. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  const time = df({ hour: '2-digit', minute: '2-digit' }).format(t);
  const now = Date.now();
  if (dayKey(t) === dayKey(now)) return `${i18n.t('common.today')} ${time}`;
  if (dayKey(t) === dayKey(now - 86_400_000)) return `${i18n.t('common.yesterday')} ${time}`;
  return `${df({ day: 'numeric', month: 'short' }).format(t)} ${time}`;
}
/** "21:19" (Algiers time). */
export const clock = (iso: string | null | undefined) => (iso ? df({ hour: '2-digit', minute: '2-digit' }).format(Date.parse(iso)) : '');
/** In a list: "21:19" today, "hier" yesterday, "18 oct." before. */
export function shortWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  const now = Date.now();
  if (dayKey(t) === dayKey(now)) return clock(iso);
  if (dayKey(t) === dayKey(now - 86_400_000)) return i18n.t('common.yesterday');
  return df({ day: 'numeric', month: 'short' }).format(t);
}
/** Same day in Algiers. */
export const sameDay = (a: string, b: string) => dayKey(Date.parse(a)) === dayKey(Date.parse(b));
/** The day between messages of a conversation: "Aujourd'hui", "Hier", "lundi 18 octobre". */
export function dayLabel(iso: string): string {
  const t = Date.parse(iso);
  const now = Date.now();
  const s = dayKey(t) === dayKey(now) ? i18n.t('common.today') : dayKey(t) === dayKey(now - 86_400_000) ? i18n.t('common.yesterday') : df({ weekday: 'long', day: 'numeric', month: 'long' }).format(t);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export const dateOnly = (iso: string | null | undefined) => (iso ? df({ day: 'numeric', month: 'short', year: 'numeric' }).format(Date.parse(iso)) : '—');
/** A period of days, its end excluded (a day after the last): "1–23 oct.", "28 sept. – 4 oct.", "3 oct. 2025 – 2 janv. 2026". */
export function dayRange(from: string, to: string): string {
  const a = Date.parse(from);
  const b = Math.max(a, Date.parse(to) - 1);
  const year = (t: number) => df({ year: 'numeric' }).format(t);
  const withYear = year(a) !== year(b) || year(b) !== year(Date.now());
  return df({ day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) }).formatRange(a, b);
}
export const dateTime = (iso: string | null | undefined) => (iso ? df({ day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(Date.parse(iso)) : '—');

/** Duration in words: "39 min", "4 j 0 h", "12 h 07". */
/** minutes, hours, days in the language shown */
const DUR_UNITS: Record<string, [string, string, string]> = { fr: ['min', 'h', 'j'], en: ['min', 'h', 'd'], ar: ['د', 'سا', 'يوم'] };
export function dur(ms: number): string {
  const [mn, hr, dy] = DUR_UNITS[i18n.language] ?? DUR_UNITS.fr;
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} ${mn}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${hr} ${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)} ${dy} ${h % 24} ${hr}`;
}
/** Time since: "depuis 3 h 10". */
export const since = (iso: string | null | undefined) => (iso ? dur(Date.now() - Date.parse(iso)) : '—');

export const wilayaName = (id: number | null | undefined) => (id ? (i18n.language === 'ar' ? WILAYAS_AR[id] ?? WILAYAS[id - 1] : WILAYAS[id - 1]) ?? '?' : '—');
export const wilaya = (id: number | null | undefined) => (id ? `${String(id).padStart(2, '0')} ${wilayaName(id)}` : '—');

/** Value for <input type="datetime-local"> in Algiers time. */
export function toLocalInput(t: number): string {
  const d = new Date(t + 60 * 60_000);
  return d.toISOString().slice(0, 16);
}
export const fromLocalInput = (v: string) => new Date(Date.parse(v + ':00Z') - 60 * 60_000).toISOString();

/** Period presets used across pages. */
export type Period = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'lastmonth';
export function periodRange(p: Period): { from: string; to: string } {
  const now = Date.now();
  const day = (t: number) => {
    const d = new Date(t + 3_600_000);
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime() - 3_600_000;
  };
  const today = day(now);
  const monthStart = (t: number) => {
    const d = new Date(t + 3_600_000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 3_600_000;
  };
  const r = (a: number, b: number) => ({ from: new Date(a).toISOString(), to: new Date(b).toISOString() });
  switch (p) {
    case 'today':
      return r(today, today + 86_400_000);
    case 'yesterday':
      return r(today - 86_400_000, today);
    case '7d':
      return r(today - 6 * 86_400_000, today + 86_400_000);
    case '30d':
      return r(today - 29 * 86_400_000, today + 86_400_000);
    case 'month':
      return r(monthStart(now), today + 86_400_000);
    case 'lastmonth': {
      const m = monthStart(now);
      return r(monthStart(m - 86_400_000), m);
    }
  }
}
