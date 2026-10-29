// « API Livraison »: the cards of every delivery company (one each, with its logo), as the computer and the phone pick
// them — a search that also finds a company by its platform (EcoTrack, Yalidine…) without ever showing the platform.
import { courierCardOf } from '@pilotix/shared';
import type { TFunction } from 'i18next';
import type { Out } from '../../lib/backend';
import type { Company, CompanyDraft } from './forms';

export type Card = Out<'delivery.kinds'>['cards'][number];

/** A card's new company: its name, its platform and settings, and the card it comes from (its logo, its help). */
export const draftOf = (card: Card): CompanyDraft => ({
  name: card.kind === 'custom' ? '' : card.title,
  kind: card.kind,
  active: true,
  phone: '',
  settings: { ...(card.settings ?? {}), ...(card.kind === 'custom' ? {} : { card: card.id }) },
});

/** How many of the shop's companies are this card. */
export const countOf = (card: Card, cards: readonly Card[], list: Company[]) => list.filter((c) => courierCardOf(cards, c)?.id === card.id).length;

const words = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** A company's platform: found by a search, never shown. */
const PLATFORM: Record<string, string> = { ecotrack: 'ecotrack', yalidine: 'yalidine', zr_legacy: 'procolis' };

/**
 * The cards a search finds — every word typed inside one word of its name, id or platform (« rex » finds Rex and
 * ChronoRex, not « ZR Express ») — in the list's order.
 */
export function searchCards(cards: readonly Card[], q: string): Card[] {
  const want = words(q);
  if (!want.length) return [...cards];
  return cards.filter((c) => {
    const have = words(`${c.title} ${c.id} ${PLATFORM[c.kind] ?? ''}`);
    return want.every((w) => have.some((h) => h.includes(w)));
  });
}

/** Companies a shop can pick (« Autre API » is not one). */
export const companyCount = (cards: readonly Card[]) => cards.filter((c) => c.kind !== 'custom').length;

/** A card's name and its short line in the app's language (the server's are French: « Autre API », « Point relais »…). */
export const cardTitle = (t: TFunction, card: Pick<Card, 'id' | 'title'>) => t(`livraison.card.${card.id}.title`, { defaultValue: card.title });
export const cardSub = (t: TFunction, card: Pick<Card, 'id' | 'sub'>) => (card.sub ? t(`livraison.card.${card.id}.sub`, { defaultValue: card.sub }) : '');
