// « Le chemin de la commande » (24 Nov 2026, the owner's choice 3 of 5): where an order came from and how it was made,
// step by step, for the order card — the ad, the place (a landing page, a chat, a Meta form, the site, a sheet, a
// call), how it was made and by whom, the landing page's fake-order check, then where its confirmation stands. The
// app draws the steps (pages/orders/OrderPath.tsx); this only reads what Pilotix already keeps.
import { cameOf, isPersonCame, type OrderOrigin } from '@pilotix/shared';
import { z } from 'zod';
import { iso, num } from '../db';
import { Ctx, proc } from '../rpc';
import { getOrder } from './orders';

const id = z.number().int().positive();
/** Meta's own number (an id under utm_*, not a name) */
const isNumber = (v: unknown) => /^\d{6,25}$/.test(String(v ?? ''));
/** Meta's {{site_source_name}} (fb, ig, msg, an, th) and the usual utm_source words, as people say them */
const PLATFORM: Record<string, string> = {
  fb: 'Facebook',
  facebook: 'Facebook',
  ig: 'Instagram',
  instagram: 'Instagram',
  msg: 'Messenger',
  messenger: 'Messenger',
  an: 'Audience Network',
  th: 'Threads',
  tiktok: 'TikTok',
};
const platformOf = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s ? PLATFORM[s.toLowerCase()] ?? s : null;
};
/** the « name » Pilotix wrote in a source (« Formulaire « Poussettes » ») */
const quoted = (s: string | null | undefined) => String(s ?? '').match(/«\s*(.+?)\s*»/)?.[1] ?? null;
const LANDING_CAME = ['form', 'abandoned', 'recovered', 'restored'];

export async function orderOrigin(ctx: Ctx, orderId: number): Promise<OrderOrigin> {
  // the same right as to open the order itself (an agent: only his own; an agency: only what it was given)
  const o = await getOrder(ctx, orderId);
  const db = ctx.db;
  const came = o.came ?? cameOf(o);
  const row = (await db.query('SELECT conversation_id, internal_note FROM orders WHERE id = $1', [orderId]))[0] ?? {};
  const u: Record<string, string> = o.utm ?? {};

  // the ad: the link's ids (a landing page, a Meta form), or the ad that started the chat (kept in utm too)
  const adId = u.ad_id || null;
  const adRow = adId ? (await db.query('SELECT name, adset_id FROM ads WHERE id = $1', [adId]))[0] : null;
  const adsetId = u.adset_id || adRow?.adset_id || null;
  const set = adsetId
    ? (await db.query(`SELECT s.name, coalesce(nullif(s.campaign, ''), c.name) AS campaign FROM adsets s LEFT JOIN ad_campaigns c ON c.id = s.campaign_id WHERE s.id = $1`, [String(adsetId)]))[0]
    : null;
  const adName = o.adName || adRow?.name || (isNumber(u.utm_content) ? null : u.utm_content || null);
  const campaign = set?.campaign || (isNumber(u.utm_campaign) ? null : u.utm_campaign || null);
  const ad =
    adId || adName || adsetId
      ? { platform: platformOf(u.utm_source), name: adName ?? null, id: adId, adset: set?.name ?? null, campaign: campaign ?? null, ids: u.px_ids || null }
      : null;
  const fromAd = !!(u.fbclid || u.adset_id || u.campaign_id || u.utm_source);
  const noAd = !ad && LANDING_CAME.includes(came) ? (fromAd ? ('noIds' as const) : ('none' as const)) : null;

  // the place it was sent from
  const lp = o.landingId ? (await db.query('SELECT slug, title FROM landing_pages WHERE id = $1', [o.landingId]))[0] : null;
  const slug = lp?.slug ?? String(o.source ?? '').match(/^Landing · ([a-z0-9-]+)/)?.[1] ?? null;
  const page = LANDING_CAME.includes(came) || lp ? { slug, title: lp?.title ?? null, group: u.g || null } : null;
  const conv = row.conversation_id ? (await db.query('SELECT channel, source FROM conversations WHERE id = $1', [row.conversation_id]))[0] : null;
  const chatChannel = conv?.channel ?? String(o.source ?? '').match(/·\s*(messenger|instagram|whatsapp|tiktok|test)\b/i)?.[1]?.toLowerCase() ?? null;
  const chat =
    came === 'chat' || came === 'chat_auto'
      ? { channel: chatChannel ?? 'messenger', post: conv?.source && !/^pub \d/.test(String(conv.source)) ? String(conv.source) : null }
      : null;
  const formName = u.form_id ? (await db.query('SELECT name FROM lead_forms WHERE form_id = $1', [u.form_id]))[0]?.name : null;
  const form = came === 'meta_form' ? { name: formName || quoted(o.source), platform: platformOf(u.utm_source) } : null;

  // an exchange or a copy: the order it comes from
  let from: OrderOrigin['from'] = null;
  if (came === 'exchange') {
    const first = o.originalOrderId ? (await db.query('SELECT ref FROM orders WHERE id = $1', [o.originalOrderId]))[0]?.ref : null;
    from = { ref: first ?? null, ticket: o.savRef ?? null };
  } else if (came === 'copy') from = { ref: String(row.internal_note ?? '').match(/Copie de (PX\d+)/)?.[1] ?? null, ticket: null };

  // the landing page's fake-order check on the form that was sent (a held order put back: it was blocked)
  let check: OrderOrigin['check'] = null;
  if (came === 'form') {
    const s = (await db.query('SELECT verdict, score FROM landing_submits WHERE order_id = $1 ORDER BY at DESC LIMIT 1', [orderId]))[0];
    if (s && ['allow', 'review', 'block'].includes(s.verdict)) check = { verdict: s.verdict, score: num(s.score) };
  } else if (came === 'restored') {
    const b = (await db.query(`SELECT score FROM landing_blocked WHERE order_id = $1 AND status = 'restored' ORDER BY id DESC LIMIT 1`, [orderId]))[0];
    if (b) check = { verdict: 'block', score: num(b.score) };
  }

  // where the confirmation stands: the change that gave the order its status now (or its creation, made confirmed)
  const ev = (
    await db.query(
      `SELECT e.at, e.user_id, e.kind, e.data, p.name FROM order_events e LEFT JOIN profiles p ON p.id = e.user_id
        WHERE e.order_id = $1 AND (e.kind = 'conf_status' OR e.kind = 'created') AND e.to_value = $2 ORDER BY e.at DESC, e.id DESC LIMIT 1`,
      [orderId, o.confStatus],
    )
  )[0];
  // a person's name only for what a person did: an order that came by itself got its first status from Pilotix (its
  // creation carries the account the server works with, or « by » since 24 Nov 2026: never that person's doing)
  const data = ev && typeof ev.data === 'string' ? JSON.parse(ev.data) : ev?.data;
  const byPerson = !!ev && ev.user_id !== null && !(ev.kind === 'created' && (!isPersonCame(came) || data?.by));
  const conf = { status: o.confStatus, by: byPerson ? (ev.name ?? null) : null, at: ev ? iso(ev.at) : null };

  return {
    came,
    by: isPersonCame(came) ? o.creatorName ?? null : null,
    at: o.createdAt,
    ad,
    noAd,
    page,
    chat,
    form,
    channelName: came === 'site' || came === 'sheet' ? o.source ?? null : null,
    channel: o.channel,
    from,
    check,
    conf,
  };
}

export const originProcs = {
  /** « Le chemin de la commande »: where this order came from and how it was made, for its card */
  'orders.origin': proc(null, z.object({ id }), (ctx, { id: orderId }) => orderOrigin(ctx, orderId)),
};
