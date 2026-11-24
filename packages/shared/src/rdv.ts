// Rendez-vous (a module of Management › Modules): a boutique that sells a service — a training centre first (owner's
// choice, 24 Nov 2026: « Seats in sessions ») — adds its sessions, its website shows them, people book a seat, and each
// booking is called and confirmed in Pilotix › Rendez-vous. The core's actions: packages/core/src/modules/rdv.ts.

/** A booking's states. `blocked`: a number of the boutique's black list (kept apart, it takes no seat). */
export const RDV_STATUSES = ['new', 'no_answer', 'callback', 'confirmed', 'cancelled', 'present', 'absent', 'blocked'] as const;
export type RdvStatus = (typeof RDV_STATUSES)[number];

/** Still to call (the page's « À confirmer »). */
export const RDV_TODO: readonly RdvStatus[] = ['new', 'no_answer', 'callback'];
/** Confirmed, then at the door: there or not (« Confirmés »). */
export const RDV_OK: readonly RdvStatus[] = ['confirmed', 'present', 'absent'];
/** Lost (« Annulés »). */
export const RDV_OFF: readonly RdvStatus[] = ['cancelled', 'blocked'];
/** The bookings that hold their seats. */
export const RDV_TAKES: readonly RdvStatus[] = [...RDV_TODO, ...RDV_OK];

/** The page's lists (Pilotix › Rendez-vous) and the states each one shows. */
export const RDV_LISTS = { attente: RDV_TODO, confirmes: RDV_OK, annules: RDV_OFF } as const;
export type RdvList = keyof typeof RDV_LISTS;

/** At most this many seats in one booking (a person and their friends). */
export const RDV_MAX_SEATS = 5;

/** The code a person shows at the door (RDV-0421). */
export const rdvCode = (id: number) => `RDV-${String(id).padStart(4, '0')}`;

/** A day and an hour in Algiers (UTC+1 all year) as a time: '2026-12-05', '09:00'. Null when they are not real. */
export function algiersTime(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = new Date(`${date}T${time}:00+01:00`);
  if (Number.isNaN(d.getTime())) return null;
  // 2026-02-31 rolls over to March: not a real day
  const back = new Date(d.getTime() + 3_600_000).toISOString();
  return back.slice(0, 10) === date && back.slice(11, 16) === time ? d.toISOString() : null;
}

/** A time as its day and hour in Algiers: { date: '2026-12-05', time: '09:00' }. */
export function algiersParts(at: string): { date: string; time: string } {
  const s = new Date(new Date(at).getTime() + 3_600_000).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}
