// Confirmation call timing, as in the original Pilotix:
// call slots (morning / midday / evening), a first call due shortly after assignment,
// and up to N tries. Every value can be changed in Management → Appels de confirmation.

export interface CallSettings {
  slots: { key: string; from: number; to: number }[]; // hours, Algiers time
  tries: number; // tries per order before auto-cancel suggestion
  firstMinutes: number; // first call due N minutes after assignment
  paceMinutes: number; // + N minutes per more-recent order ahead in the agent's list
  cancelAfterNoAnswer: number; // 0 = never
  /** the try at which the agent must first send the customer a message (Management › Statuts › « Messages client »);
   *  a shop that never chose: 3 (messageTry) */
  messageAtTry?: number;
}

export const DEFAULT_CALL_SETTINGS: CallSettings = {
  slots: [
    { key: 'morning', from: 9, to: 12 },
    { key: 'midday', from: 12, to: 16 },
    { key: 'evening', from: 16, to: 21 },
  ],
  tries: 3,
  firstMinutes: 15,
  paceMinutes: 5,
  cancelAfterNoAnswer: 0,
  messageAtTry: 3,
};

/** Algiers is UTC+1 all year (no daylight saving). */
const ALGIERS_OFFSET = 60 * 60_000;
export const algiersHour = (t: number) => new Date(t + ALGIERS_OFFSET).getUTCHours() + new Date(t + ALGIERS_OFFSET).getUTCMinutes() / 60;
/** Start of the day in Algiers, as a UTC timestamp. */
export function algiersDayStart(t: number): number {
  const d = new Date(t + ALGIERS_OFFSET);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - ALGIERS_OFFSET;
}

export type DueKind = 'first_late' | 'first_due' | 'first_next' | 'now' | 'missed' | 'later' | 'done';

export interface Due {
  kind: DueKind;
  /** When the next call is due (UTC ms), or null. */
  at: number | null;
}

/** The current slot, or the next one (today or tomorrow). */
export function slotAt(t: number, s: CallSettings): { open: boolean; from: number; to: number; key: string } {
  const h = algiersHour(t);
  const day = algiersDayStart(t);
  for (const sl of s.slots) {
    if (h >= sl.from && h < sl.to) return { open: true, from: day + sl.from * 3_600_000, to: day + sl.to * 3_600_000, key: sl.key };
    if (h < sl.from) return { open: false, from: day + sl.from * 3_600_000, to: day + sl.to * 3_600_000, key: sl.key };
  }
  const first = s.slots[0];
  return { open: false, from: day + 86_400_000 + first.from * 3_600_000, to: day + 86_400_000 + first.to * 3_600_000, key: first.key };
}

/**
 * When is the next call due for an order still in the queue?
 * - never called: first call due firstMinutes after it arrived (night orders count from the first slot),
 *   plus paceMinutes for each more recent order ahead of it in the agent's list
 * - a callback / postponed date: due at that date
 * - otherwise one try per slot until `tries`
 */
export function nextDue(
  o: { createdAt: string; attempts: number; nextCallAt: string | null; done: boolean; aheadInList?: number; lastCallAt?: string | null },
  s: CallSettings,
  now: number,
): Due {
  if (o.done) return { kind: 'done', at: null };
  if (o.nextCallAt) {
    const at = Date.parse(o.nextCallAt);
    return { kind: at <= now ? 'now' : 'later', at };
  }
  if (o.attempts === 0) {
    let start = Date.parse(o.createdAt);
    const sl = slotAt(start, s);
    if (!sl.open) start = sl.from;
    const at = start + (s.firstMinutes + (o.aheadInList ?? 0) * s.paceMinutes) * 60_000;
    if (now > at) return { kind: 'first_late', at };
    const cur = slotAt(now, s);
    return { kind: cur.open ? 'first_due' : 'first_next', at };
  }
  if (o.attempts >= s.tries) return { kind: 'missed', at: null };
  // One try per slot: due at the start of the next slot after the last call.
  const last = o.lastCallAt ? Date.parse(o.lastCallAt) : Date.parse(o.createdAt);
  const lastSlot = slotAt(last, s);
  const nextFrom = lastSlot.open ? lastSlot.to : lastSlot.from;
  const next = slotAt(nextFrom, s);
  const at = next.open ? nextFrom : next.from;
  return { kind: at <= now ? 'now' : 'later', at };
}

/**
 * The start of the call slot `t` is in (between two slots: of the last one). An order already called since then was
 * tried in this slot: its next try is in the next slot (one try per slot, as nextDue says).
 */
export function slotStartOf(t: number, s: CallSettings): number {
  const day = algiersDayStart(t);
  for (let d = 0; d < 8; d++) {
    let best = -Infinity;
    for (const sl of s.slots) {
      const from = day - d * 86_400_000 + sl.from * 3_600_000;
      if (from <= t && from > best) best = from;
    }
    if (best > -Infinity) return best;
  }
  return t - 86_400_000;
}

// ---------------------------------------------------------------- working time (the shop's call slots)
/** Working minutes between two moments: only the minutes inside the call slots count (nights and breaks do not). */
export function workMinutes(from: number, to: number, s: CallSettings): number {
  if (to <= from) return -workMinutes(to, from, s);
  let total = 0;
  for (let day = algiersDayStart(from); day < to; day += 86_400_000) {
    for (const sl of s.slots) {
      const a = Math.max(from, day + sl.from * 3_600_000);
      const b = Math.min(to, day + sl.to * 3_600_000);
      if (b > a) total += (b - a) / 60_000;
    }
  }
  return total;
}

/** The moment `minutes` working minutes after `from` (counted inside the call slots only). */
export function addWorkMinutes(from: number, minutes: number, s: CallSettings): number {
  let left = minutes;
  let t = from;
  for (let guard = 0; guard < 400; guard++) {
    const sl = slotAt(t, s);
    const start = sl.open ? t : sl.from;
    const room = (sl.to - start) / 60_000;
    if (left <= room) return start + left * 60_000;
    left -= room;
    t = sl.to;
  }
  return t;
}

/** A statistics period: today, yesterday, the last 7 or 30 days, this month, or chosen days (« Personnalisé »). */
export type StatsPeriod = 'today' | 'yesterday' | '7' | '30' | 'month' | 'custom';
const KF_DAY = 86_400_000;
/** A period's Algiers days as [a, b) in ms (« custom »: `from` / `to` are YYYY-MM-DD, both included). */
export function kfRange(now: number, i: { per: StatsPeriod; from?: string; to?: string }): { a: number; b: number } {
  const day = algiersDayStart(now);
  switch (i.per) {
    case 'yesterday':
      return { a: day - KF_DAY, b: day };
    case '7':
      return { a: day - 6 * KF_DAY, b: day + KF_DAY };
    case '30':
      return { a: day - 29 * KF_DAY, b: day + KF_DAY };
    case 'month': {
      const d = new Date(now + 3_600_000);
      return { a: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 3_600_000, b: day + KF_DAY };
    }
    case 'custom': {
      const p = (s: string | undefined) => (s ? Date.parse(s + 'T00:00:00Z') - 3_600_000 : day);
      let a = p(i.from);
      let b = p(i.to);
      if (a > b) [a, b] = [b, a];
      return { a, b: b + KF_DAY };
    }
    default:
      return { a: day, b: day + KF_DAY };
  }
}
