import type { Order } from '@pilotix/shared';

type Items = Pick<Order, 'items'>['items'];
/** "2 × Poussette + Biberon" — product names only (the variant has its own column). */
export const namesOf = (items: Items, sep = ' + ') => items.map((i) => `${i.qty > 1 ? `${i.qty} × ` : ''}${i.name}`).join(sep) || '—';
/** "Gris + Rose" — the variants, in the same order as the products. */
export const variantsOf = (items: Items, sep = ' + ') => (items.some((i) => i.variantTitle) ? items.map((i) => i.variantTitle || '—').join(sep) : '—');

/** The tracking number shown everywhere: the delivery company's once it has one, else Pilotix's own (made at creation). */
export const trackOf = (o: { tracking?: string | null; ownTracking?: string | null }) => o.tracking || o.ownTracking || '';
