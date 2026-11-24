// Where an order came from and how it was made (« Le chemin de la commande », 24 Nov 2026, the owner's choice 3): every
// order in every boutique says it — a landing page the customer filled, a chat Dellal answered, a Meta form, the
// shop's site, a Google Sheet, a person who typed it… What Pilotix does by itself is signed « Pilotix », never with
// the name of the boutique's first administrator (that is only the account it acts with).

/** How an order was made. Stored on the order (`came`); for an order made before it was kept, see cameOf. */
export const ORDER_CAME = [
  'form', // the customer filled a landing page's form
  'meta_form', // the customer filled a Meta lead form (Facebook / Instagram)
  'chat', // Dellal took it in a chat (Messenger, Instagram, WhatsApp, TikTok)
  'chat_auto', // Dellal made it by itself: the customer gave his number, then went quiet
  'site', // the shop's own site sent it (Canaux de vente › API, Shopify, WooCommerce…)
  'sheet', // Pilotix read it in a Google Sheet (Canaux de vente)
  'abandoned', // Pilotix added it: the customer left his number on a landing page without sending the form
  'recovered', // a person added that unsent form as an order
  'restored', // a person put it back from Landing pages › Bloquées
  'hand', // a person typed it (a call, a message, a visit)
  'exchange', // an exchange parcel made from a SAV ticket
  'copy', // « Dupliquer » of another order
  'test', // a test order (Canaux › simulation, « Test Pilotix », the scanner's test parcels)
] as const;
export type OrderCame = (typeof ORDER_CAME)[number];

/** Made by a person of the boutique: the order shows his name. The others came by themselves (Pilotix, the customer). */
export const PERSON_CAME: readonly OrderCame[] = ['recovered', 'restored', 'hand', 'exchange', 'copy'];
export const isPersonCame = (c: OrderCame | null | undefined): boolean => !!c && PERSON_CAME.includes(c);

/** The chat channels a Dellal order names in its source (« Dellal · messenger · pub 1202… »). */
const CHAT_IN_SOURCE = /·\s*(messenger|instagram|whatsapp|tiktok|test)(\s*·|\s*$)/i;

/**
 * How an order came when it does not say (made before `came` was kept, or written by an old seed): read from its
 * channel and the source Pilotix wrote on it. The server's migration (130_order_came) keeps the same rules and also
 * reads the tables only it has (Landing pages › Bloquées, the unsent forms, the sales channels).
 */
export function cameOf(o: { came?: string | null; channel?: string | null; source?: string | null; isExchange?: boolean; landingId?: number | null }): OrderCame {
  if (o.came && (ORDER_CAME as readonly string[]).includes(o.came)) return o.came as OrderCame;
  const src = String(o.source ?? '').trim();
  if (o.isExchange) return 'exchange';
  if (/·\s*abandonnée$/.test(src)) return 'abandoned';
  if (/^Formulaire «/.test(src)) return 'meta_form';
  if (/·\s*commande auto$/.test(src)) return 'chat_auto';
  if (src === 'site (simulation)' || src === 'Test Pilotix') return 'test';
  if (o.channel === 'landing' || o.landingId) return 'form';
  if (CHAT_IN_SOURCE.test(src)) return 'chat';
  return 'hand';
}

/** Who made it, as the lists say it: the customer, Dellal, Pilotix or the person (his name). */
export type OrderMaker = 'client' | 'dellal' | 'pilotix' | 'person';
export function makerOf(c: OrderCame): OrderMaker {
  if (c === 'form' || c === 'meta_form' || c === 'site') return 'client';
  if (c === 'chat' || c === 'chat_auto') return 'dellal';
  if (isPersonCame(c)) return 'person';
  return 'pilotix';
}

/** « Le chemin de la commande » (orders.origin): what the order card draws, step by step. */
export interface OrderOrigin {
  came: OrderCame;
  /** the person who made it (a PERSON_CAME order), else null */
  by: string | null;
  at: string;
  /** the Meta ad the customer came from (the link's ids, or the ad that started the chat) */
  ad: {
    /** Facebook, Instagram, Messenger… (Meta's site_source_name when the link has it) */
    platform: string | null;
    name: string | null;
    id: string | null;
    adset: string | null;
    campaign: string | null;
    /** how the ad was found: 'meta' = Meta's own numbers on the link, 'found' = one of its ids, null = the link's ids */
    ids: string | null;
  } | null;
  /** a landing page order with no ad known: 'noIds' = the link says an ad but without its ids, 'none' = no ad at all */
  noAd: 'noIds' | 'none' | null;
  /** the landing page (or group page) it was sent from */
  page: { slug: string | null; title: string | null; group: string | null } | null;
  /** the chat it was taken in */
  chat: { channel: string; post: string | null } | null;
  /** the Meta lead form */
  form: { name: string | null; platform: string | null } | null;
  /** the shop's site or Google Sheet (Canaux de vente): its name */
  channelName: string | null;
  /** what a person picked when typing it (Appel, WhatsApp, Facebook…) */
  channel: string;
  /** an exchange or a copy: the order it comes from, and the SAV ticket */
  from: { ref: string | null; ticket: string | null } | null;
  /** the landing page's fake-order check (the form was sent): passed, to check, or blocked then put back */
  check: { verdict: 'allow' | 'review' | 'block'; score: number } | null;
  /** where the confirmation stands: its status, who set it (null: Pilotix / Dellal) and when */
  conf: { status: string; by: string | null; at: string | null } | null;
}
