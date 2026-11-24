// Confirmation › the customer who does not answer (the owner's rule, 24 Nov 2026).
// - « Messages client » (Management › Statuts): the shop's two texts, read and saved here (confirmation.messages.*).
//   setConf (orders.ts) asks the agent to send the first one at the try the shop chose (« Message au client à la
//   tentative », 3 at the start), and the cancel one, with the reactivation link, at « Annuler après N appels sans
//   réponse ».
// - orders.customerMessage: one order's text, as the agent sends it from his own WhatsApp or SMS (before a cancel, with
//   a one-time reactivation link: the customer opens it and the order comes back « Nouvelle »).
// - An order already at N unanswered tries or more and still waiting for a call (an order from before this rule, or N
//   lowered by the shop) is cancelled by itself, with no message and no link (cancelOverLimit): when the shop saves N,
//   and every 10 minutes (the job « noanswer-sweep »). It reads like the cancel of the Nth call: « Pas de réponse », an
//   attack in the statistics (attackOf), never the team's fault. Not touched: an order an agent has open right now
//   (the next round takes it), an order at the depot or gone, a SAV exchange.
import {
  CUSTOMER_MESSAGE_MAX, type CustomerMessageOrder, customerMessageValues, DEFAULT_CUSTOMER_MESSAGES, fillCustomerMessage, messageTry, REACTIVATION_VAR,
} from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num } from '../db';
import { Ctx, notFound, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { tellAgencyOrderStatus } from './agencybell';
import { firstName } from './notify';
import { addEvent, getOrder } from './orders';

const id = z.number().int().positive();
/** A call nobody answered leaves the order « Pas de réponse » (or « Occupé », counted as a try before 24 Nov 2026). */
const UNANSWERED = ['no_answer', 'busy'];
/** written on every order cancelled here: the words attackOf (confirmation.ts) reads, then why there was no message */
export const OVER_LIMIT_NOTE = (attempts: number) => `Pas de réponse — Annulée automatiquement après ${attempts} appels sans réponse — ancienne commande, sans message`;

/** What one order's message says: the customer's first name, the shop, the products (their Arabic option when the
 *  product has it), the delivery and the total. */
export async function customerMessageOrder(db: Db, orderId: number): Promise<CustomerMessageOrder> {
  const o = (await db.query('SELECT ref, customer_name, delivery_fee, total FROM orders WHERE id = $1', [orderId]))[0];
  if (!o) throw notFound('Commande introuvable');
  const items = await db.query(
    `SELECT i.qty, i.name, i.variant_title, COALESCE(v.title_ar, '') AS title_ar
       FROM order_items i LEFT JOIN product_variants v ON v.id = i.variant_id WHERE i.order_id = $1 ORDER BY i.id`,
    [orderId],
  );
  return {
    name: firstName(o.customer_name, 'ar'),
    shop: (await getSetting(db, 'shop')).name,
    ref: String(o.ref),
    items: items.map((r: any) => ({ qty: num(r.qty), name: String(r.name).trim(), option: String(r.title_ar || r.variant_title || '').trim() || undefined })),
    delivery: num(o.delivery_fee),
    total: num(o.total),
  };
}

/** The orders at the shop's limit or above, still waiting for a call: cancelled, no message (see the top). */
export async function cancelOverLimit(ctx: Ctx): Promise<{ cancelled: number; refs: string[] }> {
  const limit = Math.round(Number((await getSetting(ctx.db, 'calls')).cancelAfterNoAnswer) || 0);
  if (limit <= 0) return { cancelled: 0, refs: [] };
  const done: { id: number; ref: string; agency: boolean }[] = [];
  await ctx.db.tx(async (tx) => {
    const rows = await tx.query(
      `SELECT id, ref, conf_status, attempts, next_call_at, conf_agency_id FROM orders
        WHERE conf_status = ANY($1) AND attempts >= $2 AND shipped_at IS NULL AND NOT is_exchange
          AND (follow_status IS NULL OR follow_status = 'cancelled') AND (locked_until IS NULL OR locked_until < now())
        ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED`,
      [UNANSWERED, limit],
    );
    for (const r of rows) {
      const oid = num(r.id);
      await tx.query(
        `UPDATE orders SET conf_status = 'cancelled', next_call_at = NULL, locked_by = NULL, locked_until = NULL,
           updated_at = now(), version = version + 1 WHERE id = $1`,
        [oid],
      );
      await addEvent(tx, oid, null, 'conf_status', r.conf_status, 'cancelled', OVER_LIMIT_NOTE(num(r.attempts)), {
        att: num(r.attempts), nca: r.next_call_at ? iso(r.next_call_at) : null, overLimit: limit,
      });
      await tx.query(
        `UPDATE notifications SET status = 'skipped', error = 'Commande annulée : pas de réponse'
          WHERE order_id = $1 AND kind = 'no_answer' AND status IN ('queued', 'manual', 'failed')`,
        [oid],
      );
      done.push({ id: oid, ref: String(r.ref), agency: r.conf_agency_id != null });
    }
  });
  for (const d of done) if (d.agency) await tellAgencyOrderStatus(ctx, d.id, 'cancelled', null).catch(() => {});
  if (done.length) ctx.emit({ type: 'orders', orderIds: done.map((d) => d.id) });
  return { cancelled: done.length, refs: done.map((d) => d.ref) };
}

const Text = z.string().trim().min(1).max(CUSTOMER_MESSAGE_MAX);

export const noAnswerProcs = {
  /** Management › Statuts › « Messages client »: the two texts, the tries they go at and the shop's name (the preview). */
  'confirmation.messages.get': proc([], z.object({}), async (ctx) => {
    const [texts, calls, shop] = await Promise.all([getSetting(ctx.db, 'customerMessages'), getSetting(ctx.db, 'calls'), getSetting(ctx.db, 'shop')]);
    return {
      attempt: texts.attempt || DEFAULT_CUSTOMER_MESSAGES.attempt,
      cancel: texts.cancel || DEFAULT_CUSTOMER_MESSAGES.cancel,
      defaults: DEFAULT_CUSTOMER_MESSAGES,
      messageAtTry: messageTry(calls),
      cancelAfterNoAnswer: calls.cancelAfterNoAnswer,
      shopName: shop.name,
    };
  }),
  'confirmation.messages.save': proc([], z.object({ attempt: Text, cancel: Text }), async (ctx, i) => {
    await setSetting(ctx.db, 'customerMessages', { attempt: i.attempt, cancel: i.cancel }, ctx.session.profile.id);
    ctx.emit({ type: 'settings' });
    return { ok: true };
  }),
  /** One order's message as the agent sends it; before a cancel, with a new one-time reactivation link. */
  'orders.customerMessage': proc(['confirmation'], z.object({ id, kind: z.enum(['attempt', 'cancel']), draft: z.string().uuid().optional() }), async (ctx, i) => {
    await getOrder(ctx, i.id);
    const [texts, order] = await Promise.all([getSetting(ctx.db, 'customerMessages'), customerMessageOrder(ctx.db, i.id)]);
    const values = customerMessageValues(order);
    // (the first message has no link: a {رابط_إعادة_التفعيل} written there is left out)
    const text = fillCustomerMessage(texts[i.kind] || DEFAULT_CUSTOMER_MESSAGES[i.kind], i.kind === 'attempt' ? { ...values, [REACTIVATION_VAR]: '' } : values);
    if (i.kind === 'attempt') return { text, token: null, path: null };
    const token = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return { text, token, path: `/api${ctx.shop?.slug ? `/s/${ctx.shop.slug}` : ''}/reorder/${i.id}/${token}` };
  }),
  /** The job « noanswer-sweep » (every 10 minutes): the orders over the shop's limit, cancelled with no message. */
  'confirmation.noAnswerSweep': proc([], z.object({}), (ctx) => cancelOverLimit(ctx)),
};

