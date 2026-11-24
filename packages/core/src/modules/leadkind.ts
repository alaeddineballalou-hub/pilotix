// What became of a lead: confirmed, refused by a real client, an attack, a duplicate, or still to call. One rule for
// Confirmation › Statistiques (confirmation.ts) and Publicité's « Qualité des leads » (ads.ts). A leaf module (only
// pilotlearn's reason words): ads.ts is loaded while orders.ts is still loading, so it cannot read confirmation.ts.
import { reasonCode } from './pilotlearn';

/** written by setConf (orders.ts) when the shop cancels after N calls with no answer: the same French words everywhere */
export const AUTO_NO_ANSWER = /Annulée automatiquement après \d+ appels sans réponse/;
export const CONFIRMED_LIKE = ['confirmed', 'no_stock'];
export type Lead = 'pending' | 'confirmed' | 'refused' | 'attack' | 'duplicate';

/**
 * The kind of attack, or null. An attack is never the team's fault: a fake (also a cancel where the client says he never
 * ordered, or a competitor), a wrong number, or an order cancelled after N calls with no answer.
 */
export function attackOf(status: string, note: string | null | undefined): 'fake' | 'wrong' | 'noAnswer' | null {
  if (status === 'fake') return 'fake';
  if (status === 'wrong_number') return 'wrong';
  if (status !== 'cancelled') return null;
  if (AUTO_NO_ANSWER.test(note ?? '')) return 'noAnswer';
  const code = reasonCode(note);
  return code === 'not_ordered' || code === 'competitor' ? 'fake' : null;
}

/** What became of a lead. */
export function leadOf(status: string, note: string | null | undefined): Lead {
  if (CONFIRMED_LIKE.includes(status)) return 'confirmed';
  if (status === 'duplicate') return 'duplicate';
  if (attackOf(status, note)) return 'attack';
  if (status === 'cancelled') return 'refused';
  return 'pending';
}
