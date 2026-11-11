// Marketing › Stratégies → Espace créateur: what the seller chose (the product, the funnel stage, the formats) waits
// here, on this browser, until Espace créateur opens with it. Nothing goes to the server. A brief older than a day is
// forgotten.
import { store } from '../../lib/store';

export type FunnelStage = 'top' | 'middle' | 'bottom';
export interface Brief {
  productId: number;
  stage: FunnelStage;
  /** the formats' keys, best first */
  formats: string[];
  at: number;
}

const key = (boutique: string | number) => `createur.brief.${boutique}`;
const DAY = 86_400_000;

export function saveBrief(boutique: string | number, b: Omit<Brief, 'at'>) {
  store.set(key(boutique), JSON.stringify({ ...b, at: Date.now() }));
  // Espace créateur opens on this product
  store.set(`createur.product.${boutique}`, String(b.productId));
}

export function readBrief(boutique: string | number): Brief | null {
  try {
    const b = JSON.parse(store.get(key(boutique)) ?? 'null') as Brief | null;
    if (!b || typeof b.productId !== 'number' || !Array.isArray(b.formats) || !['top', 'middle', 'bottom'].includes(b.stage)) return null;
    return Date.now() - b.at < DAY ? b : null;
  } catch {
    return null;
  }
}

export const clearBrief = (boutique: string | number) => store.set(key(boutique), null);
