// What each team board shows: the numbers of an area, how they are read (format, better up or down, the target), which
// ones say how someone works (for coaching), and what is late now. Text lives in dashboard.tb.* (fr / en / ar).
import type { Tone } from '@pilotix/shared';
import { da, dur, n, pct } from '../../../lib/format';

export type AreaKey = 'confirmation' | 'suivi' | 'depot' | 'livreurs' | 'sav';
export type Vals = Record<string, number | null>;
export type Fmt = 'pct' | 'n' | 'dur' | 'da' | 'x';

export interface MetricDef {
  key: string;
  fmt: Fmt;
  better: 'up' | 'down';
  /** [good, fair]: up = at least, down = at most */
  target?: [number, number];
  /** says how someone works: used to find their focus and their strength */
  coach?: boolean;
  /** how many it must be out of before it is judged (the `<key>_n` count, or the area's volume) */
  min?: number;
  /** a number of now (no period before to compare with) */
  live?: boolean;
}

export interface NowDef {
  tone: Tone;
  href?: string;
  money?: boolean;
  adminHref?: boolean;
}

export interface AreaDef {
  volume: string;
  pulse: string[];
  cols: string[];
  card: string[];
  metrics: Record<string, MetricDef>;
  now: Record<string, NowDef>;
  /** the reasons the board shows (cancellations, returns, preparation mistakes) */
  reasons: boolean;
}

const H = 3_600_000;
const m = (key: string, fmt: Fmt, better: 'up' | 'down', o: Partial<MetricDef> = {}): MetricDef => ({ key, fmt, better, ...o });

export const AREAS: Record<AreaKey, AreaDef> = {
  confirmation: {
    volume: 'treated',
    pulse: ['confRate', 'deliveryRate', 'firstRate', 'basket'],
    cols: ['treated', 'confRate', 'deliveryRate', 'firstRate', 'triesRate', 'upsellRate', 'basket'],
    card: ['confRate', 'deliveryRate', 'firstRate'],
    metrics: Object.fromEntries(
      [
        m('treated', 'n', 'up'),
        m('confirmed', 'n', 'up'),
        m('calls', 'n', 'up'),
        m('confRate', 'pct', 'up', { target: [0.6, 0.5], coach: true, min: 5 }),
        m('deliveryRate', 'pct', 'up', { target: [0.7, 0.5], coach: true, min: 5 }),
        m('firstRate', 'pct', 'up', { target: [0.8, 0.7], coach: true, min: 5 }),
        m('firstMs', 'dur', 'down'),
        m('triesRate', 'pct', 'up', { target: [0.8, 0.7], coach: true, min: 5 }),
        m('upsellRate', 'pct', 'up', { coach: true, min: 8 }),
        m('basket', 'da', 'up'),
        m('callsPerConf', 'x', 'down'),
        m('inProgress', 'n', 'down', { live: true }),
        m('lateCallbacks', 'n', 'down', { live: true }),
      ].map((x) => [x.key, x]),
    ),
    now: {
      firstLate: { tone: 'bad', href: '#/confirmation/nouvelles' },
      lateCallbacks: { tone: 'bad', href: '#/confirmation/attente' },
      unassigned: { tone: 'warn', href: '#/confirmation/nouvelles' },
      inProgress: { tone: 'info', href: '#/confirmation/attente' },
    },
    reasons: true,
  },
  suivi: {
    volume: 'outcomes',
    pulse: ['deliveryRate', 'treatMs', 'savedRate', 'outcomes'],
    cols: ['outcomes', 'deliveryRate', 'treated', 'treatMs', 'savedRate', 'calls', 'alertsNow'],
    card: ['deliveryRate', 'treatMs', 'alertsNow'],
    metrics: Object.fromEntries(
      [
        m('outcomes', 'n', 'up'),
        m('deliveryRate', 'pct', 'up', { target: [0.7, 0.5], coach: true, min: 5 }),
        m('treated', 'n', 'up'),
        m('treatMs', 'dur', 'down', { target: [4 * H, 24 * H], coach: true, min: 3 }),
        m('savedRate', 'pct', 'up', { target: [0.6, 0.4], coach: true, min: 3 }),
        m('calls', 'n', 'up'),
        m('alertsNow', 'n', 'down', { live: true }),
        m('alertsOld', 'n', 'down', { live: true }),
      ].map((x) => [x.key, x]),
    ),
    now: {
      alertsOld: { tone: 'bad', href: '#/suivi/alertes' },
      alerts: { tone: 'warn', href: '#/suivi/alertes' },
      claimsLate: { tone: 'bad', href: '#/suivi/reclamation' },
      orphan: { tone: 'info', href: '#/suivi' },
    },
    reasons: true,
  },
  depot: {
    volume: 'packed',
    pulse: ['packed', 'prepMs', 'prep24Rate', 'wrongRate'],
    cols: ['packed', 'shipped', 'prepMs', 'prep24Rate', 'wrongRate', 'returnsIn'],
    card: ['packed', 'prepMs', 'wrongRate'],
    metrics: Object.fromEntries(
      [
        m('packed', 'n', 'up'),
        m('shipped', 'n', 'up'),
        m('prepMs', 'dur', 'down', { target: [12 * H, 24 * H], coach: true, min: 5 }),
        m('prep24Rate', 'pct', 'up', { target: [0.9, 0.75], coach: true, min: 5 }),
        m('wrongRate', 'pct', 'down', { target: [0.01, 0.03], coach: true, min: 10 }),
        m('returnsIn', 'n', 'up'),
      ].map((x) => [x.key, x]),
    ),
    now: {
      late24: { tone: 'bad', href: '#/depot/preparer' },
      waitingPickup: { tone: 'warn', href: '#/depot/prepares' },
      toPrepare: { tone: 'info', href: '#/depot/preparer' },
      toReceive: { tone: 'info', href: '#/depot/retours' },
    },
    reasons: true,
  },
  livreurs: {
    volume: 'delivered',
    pulse: ['deliveryRate', 'delivered', 'late', 'uncashed'],
    cols: ['delivered', 'deliveryRate', 'inHand', 'late', 'toBring', 'uncashed'],
    card: ['deliveryRate', 'late', 'uncashed'],
    metrics: Object.fromEntries(
      [
        m('delivered', 'n', 'up'),
        m('returned', 'n', 'down'),
        m('deliveryRate', 'pct', 'up', { target: [0.8, 0.65], coach: true, min: 5 }),
        m('inHand', 'n', 'up', { live: true }),
        m('late', 'n', 'down', { live: true }),
        m('lateRate', 'pct', 'down', { target: [0.1, 0.25], coach: true, min: 3, live: true }),
        m('toBring', 'n', 'down', { live: true }),
        m('uncashed', 'da', 'down', { live: true }),
      ].map((x) => [x.key, x]),
    ),
    now: {
      late: { tone: 'bad' },
      toBring: { tone: 'warn' },
      uncashed: { tone: 'info', money: true, href: '#/caisse/livreurs', adminHref: true },
    },
    reasons: true,
  },
  sav: {
    volume: 'settled',
    pulse: ['settled', 'settleMs', 'settled48Rate', 'satRate'],
    cols: ['settled', 'settleMs', 'settled48Rate', 'satRate', 'todo', 'old48'],
    card: ['settleMs', 'satRate', 'todo'],
    metrics: Object.fromEntries(
      [
        m('settled', 'n', 'up'),
        m('settleMs', 'dur', 'down', { target: [24 * H, 48 * H], coach: true, min: 3 }),
        m('settled48Rate', 'pct', 'up', { target: [0.9, 0.7], coach: true, min: 3 }),
        m('satRate', 'pct', 'up', { target: [0.8, 0.6], coach: true, min: 3 }),
        m('todo', 'n', 'down', { live: true }),
        m('old48', 'n', 'down', { live: true }),
      ].map((x) => [x.key, x]),
    ),
    now: {
      old48: { tone: 'bad', href: '#/sav/attente' },
      nobody: { tone: 'warn', href: '#/sav/tickets' },
      todo: { tone: 'info', href: '#/sav/tickets' },
    },
    reasons: false,
  },
};

// ---------------------------------------------------------------- reading a number
export function fmt(def: MetricDef | undefined, v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  switch (def?.fmt) {
    case 'pct':
      return pct(v);
    case 'dur':
      return dur(v);
    case 'da':
      return da(v);
    case 'x':
      return n(Math.round(v * 10) / 10);
    default:
      return n(v);
  }
}

/** how many the number is out of (a rate's count, else the member's volume) */
export const outOf = (area: AreaDef, v: Vals, key: string) => (v[`${key}_n`] ?? v[area.volume] ?? 0) as number;

/** What a member is compared with: the team's rate or average, or for a count the team's count per active member. */
export function teamRef(area: AreaDef, key: string, team: Vals, members: { none?: boolean; v: Vals }[]): number | null {
  const d = area.metrics[key];
  const x = team[key];
  if (x === null || x === undefined) return null;
  if (d && (d.fmt === 'n' || (d.fmt === 'da' && d.live))) {
    // the average of the people who worked (work that belongs to nobody is left out)
    const active = members.filter((m) => !m.none && ((m.v[area.volume] ?? 0) > 0 || (d.live && (m.v[key] ?? 0) > 0)));
    return active.length ? active.reduce((s, m) => s + (m.v[key] ?? 0), 0) / active.length : null;
  }
  return x;
}

/** Against the target: ok, fair or under (grey when too few to judge). */
export function toneOf(area: AreaDef, key: string, v: Vals): Tone | undefined {
  const d = area.metrics[key];
  const x = v[key];
  if (!d?.target || x === null || x === undefined) return undefined;
  if (d.min && outOf(area, v, key) < d.min) return 'off';
  const [good, fair] = d.target;
  if (d.better === 'up') return x >= good ? 'ok' : x >= fair ? 'warn' : 'bad';
  return x <= good ? 'ok' : x <= fair ? 'warn' : 'bad';
}

/** The change since the period before: points for a rate, a share for the rest; good or bad by the way it should go. */
export function trendOf(def: MetricDef | undefined, v: number | null | undefined, p: number | null | undefined): { txt: string; good: boolean | null; up: boolean } | null {
  if (!def || def.live || v === null || v === undefined || p === null || p === undefined) return null;
  if (def.fmt === 'pct') {
    const d = v - p;
    if (Math.abs(d) < 0.005) return { txt: '=', good: null, up: true };
    return { txt: `${Math.abs(Math.round(d * 100))} pts`, good: (d > 0) === (def.better === 'up'), up: d > 0 };
  }
  if (!p) return null;
  const d = (v - p) / p;
  if (Math.abs(d) < 0.005) return { txt: '=', good: null, up: true };
  return { txt: `${Math.round(Math.abs(d) * 100)} %`, good: (d > 0) === (def.better === 'up'), up: d > 0 };
}

// ---------------------------------------------------------------- coaching
export interface Coach {
  focus?: { key: string; v: number; team: number | null; gap: number };
  strength?: { key: string; v: number; team: number | null; gap: number };
  /** how many of the numbers that say how someone works could be judged */
  judged: number;
}

/** A member's focus (furthest under the target, or behind the team) and strength (furthest ahead of the team). */
export function coachOf(area: AreaDef, v: Vals, team: Vals): Coach {
  const out: Coach = { judged: 0 };
  for (const d of Object.values(area.metrics)) {
    if (!d.coach) continue;
    const x = v[d.key];
    if (x === null || x === undefined) continue;
    if (outOf(area, v, d.key) < (d.min ?? 5)) continue;
    out.judged++;
    const T = team[d.key] ?? null;
    const sign = d.better === 'up' ? 1 : -1;
    // relative distance to the target and to the team (negative = behind), kept within ±1 so no number outweighs the rest
    const clamp = (y: number) => Math.max(-1, Math.min(1, y));
    const toTarget = d.target ? clamp((sign * (x - d.target[0])) / Math.max(1e-9, d.target[0])) : null;
    const toTeam = T !== null && T !== 0 ? clamp((sign * (x - T)) / Math.abs(T)) : null;
    const behind = Math.min(toTarget ?? Infinity, toTeam ?? Infinity);
    const under = toTarget !== null && toTarget < 0 ? toTarget : toTeam !== null && toTeam < -0.1 ? toTeam : null;
    if (under !== null && (!out.focus || behind < out.focus.gap)) out.focus = { key: d.key, v: x, team: T, gap: behind };
    const ahead = toTeam !== null ? toTeam : toTarget;
    if (ahead !== null && ahead > 0.08 && (toTarget === null || toTarget >= 0) && (!out.strength || ahead > out.strength.gap)) out.strength = { key: d.key, v: x, team: T, gap: ahead };
  }
  if (out.focus && out.strength?.key === out.focus.key) delete out.strength;
  return out;
}

/** Where a value sits on its meter (0 → 1): rates on 0–100 %, durations on 0 → 1.5 × the fair limit (or the largest). */
export function scaleOf(def: MetricDef, ...xs: (number | null | undefined)[]): (x: number) => number {
  if (def.fmt === 'pct') return (x) => Math.max(0, Math.min(1, x));
  const top = Math.max(def.target ? def.target[1] * 1.5 : 0, ...xs.map((x) => (x === null || x === undefined ? 0 : x)), 1);
  return (x) => Math.max(0, Math.min(1, x / top));
}
