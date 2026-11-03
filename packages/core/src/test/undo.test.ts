// « ↶ Annuler »: the last status change of an order goes back as if it had not been made — confirmation (confirmée,
// pas de réponse, annulée) and delivery (expédiée, livrée, retournée) — with the stock, the customer's numbers and the
// history put back; the person who made it (24 h) or a manager; never a status given by the delivery company or money
// already in a caisse.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { API_COURIER_KINDS } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { asDepot, autoDispatch, dispatchOrders } from '../modules/dispatch';
import { setFollow } from '../modules/orders';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (e: string) => Promise<Ctx>;
let admin: Ctx;
let samira: Ctx;
let rania: Ctx;
let manager: Ctx;
let depot: Ctx;
let suivi: Ctx;
let X: { productId: number; variantId: number };

before(async () => {
  ({ db, as } = await setup(40));
  [admin, samira, rania, manager, depot, suivi] = await Promise.all([as(EMAILS.admin), as(EMAILS.conf), as(EMAILS.conf2), as(EMAILS.manager), as(EMAILS.depot), as(EMAILS.suivi)]);
  const r = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  X = { productId: Number(r.id), variantId: Number(r.vid) };
});

let n = 0;
/** a new order, given to this agent (Samira by default) */
const order = async (agent: Ctx = samira) => {
  const o = (await call('orders.create', admin, { customerName: `Client Undo ${++n}`, phone: `0672${String(300000 + n).slice(-6)}`, wilayaId: 16, commune: 'Kouba', address: 'Rue 1', items: [{ ...X, qty: 1 }] })) as any;
  await db.query('UPDATE orders SET agent_id = $2, assigned_at = now() WHERE id = $1', [o.id, agent.session.profile.id]);
  return o;
};
const row = async (id: number) => (await db.query('SELECT * FROM orders WHERE id = $1', [id]))[0];
const last = (ctx: Ctx, id: number) => call('orders.lastChange', ctx, { id }) as Promise<any>;
const undo = async (ctx: Ctx, id: number) => call('orders.undo', ctx, { id, eventId: (await last(ctx, id)).eventId });
const kinds = async (id: number) => (await db.query(`SELECT kind, from_value, to_value FROM order_events WHERE order_id = $1 AND kind IN ('conf_status', 'follow_status', 'undo') ORDER BY at, id`, [id])).map((e: any) => `${e.kind}:${e.from_value ?? ''}>${e.to_value ?? ''}`);
const stockOf = async (variant: number, wh: number) => Number((await db.query('SELECT qty FROM stock WHERE variant_id = $1 AND warehouse_id = $2', [variant, wh]))[0]?.qty ?? 0);

test('confirmed by mistake: the agent unconfirms it — back to « Nouvelle », out of the depot, as if never confirmed', async () => {
  const o = await order();
  await call('orders.setConf', samira, { ids: [o.id], status: 'confirmed' });
  const c = await row(o.id);
  assert.ok(['confirmed', 'no_stock'].includes(c.conf_status));
  const lc = await last(samira, o.id);
  assert.equal(lc.area, 'conf');
  assert.equal(lc.from, 'new');
  assert.equal(lc.why, null);
  assert.equal(lc.effects[0].k, 'back');
  // another agent cannot; the agent manager could
  assert.equal((await last(rania, o.id)).why, 'other');
  await assert.rejects(call('orders.undo', rania, { id: o.id, eventId: lc.eventId }), /Fait par Samira/);
  assert.equal((await last(manager, o.id)).why, null);
  // the agent herself
  await call('orders.undo', samira, { id: o.id, eventId: lc.eventId });
  const u = await row(o.id);
  assert.equal(u.conf_status, 'new');
  assert.equal(u.follow_status, null);
  assert.equal(u.confirmed_at, null);
  assert.deepEqual(await kinds(o.id), ['undo:' + c.conf_status + '>new'], 'the confirmation left the history, one undo line');
  // nothing more of hers to undo (the order had no change before)
  assert.equal(await last(samira, o.id), null);
});

test('« pas de réponse » by mistake: the call is not counted any more; more than 24 h: a manager only', async () => {
  const o = await order();
  await call('orders.setConf', samira, { ids: [o.id], status: 'no_answer' });
  assert.equal(Number((await row(o.id)).attempts), 1);
  // a day later she cannot any more, the manager can
  const later = { ...samira, now: () => Date.now() + 25 * 3_600_000 };
  assert.equal((await last(later, o.id)).why, 'old');
  await undo(samira, o.id);
  const u = await row(o.id);
  assert.equal(u.conf_status, 'new');
  assert.equal(Number(u.attempts), 0);
  // the « ↶ » of the message right after a change: her own changes of the last minutes, many at once
  const a = await order();
  const b = await order();
  await call('orders.setConf', samira, { ids: [a.id, b.id], status: 'busy' });
  const r: any = await call('orders.undoMany', samira, { ids: [a.id, b.id] });
  assert.deepEqual(r.done.sort(), [a.id, b.id].sort());
  assert.equal((await row(a.id)).conf_status, 'new');
  assert.equal((await row(b.id)).conf_status, 'new');
  // someone else's: refused
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [a.id, rania.session.profile.id]);
  await call('orders.setConf', rania, { ids: [a.id], status: 'busy' });
  const r2: any = await call('orders.undoMany', samira, { ids: [a.id] });
  assert.equal(r2.done.length, 0);
  assert.equal(r2.refused.length, 1);
});

test('cancelled by mistake: reopened as it was (confirmed, back to « À préparer »)', async () => {
  const o = await order();
  await call('orders.setConf', samira, { ids: [o.id], status: 'confirmed' });
  const before = await row(o.id);
  await call('orders.setConf', samira, { ids: [o.id], status: 'cancelled', reason: 'price' });
  assert.equal((await row(o.id)).conf_status, 'cancelled');
  const lc = await last(samira, o.id);
  assert.equal(lc.from, before.conf_status);
  await call('orders.undo', samira, { id: o.id, eventId: lc.eventId });
  const u = await row(o.id);
  assert.equal(u.conf_status, before.conf_status);
  assert.equal(u.follow_status, before.follow_status);
  assert.equal(String(u.confirmed_at), String(before.confirmed_at), 'its confirmation time kept');
});

test('shipped by mistake (depot scan): back to « Préparée », the stock comes back; shipped again later takes it again once', async () => {
  const p = (
    await db.query(
      `SELECT o.id, o.warehouse_id, i.variant_id FROM orders o JOIN order_items i ON i.order_id = o.id AND i.variant_id IS NOT NULL
        WHERE o.conf_status = 'confirmed' AND o.follow_status = 'prepared' AND o.shipped_at IS NULL AND o.warehouse_id IS NOT NULL AND NOT o.is_exchange AND NOT o.cashed
          AND (SELECT count(*) FROM order_items x WHERE x.order_id = o.id) = 1 ORDER BY o.id LIMIT 1`,
    )
  )[0];
  assert.ok(p, 'a prepared parcel in the demo');
  const id = Number(p.id);
  const v = Number(p.variant_id);
  const wh = Number(p.warehouse_id);
  const qty = Number((await db.query('SELECT qty FROM order_items WHERE order_id = $1', [id]))[0].qty);
  const s0 = await stockOf(v, wh);
  await setFollow(depot, { ids: [id], status: 'shipped', note: 'scan dispatch' });
  assert.equal(await stockOf(v, wh), s0 - qty);
  assert.ok((await row(id)).shipped_at);
  // normally only an admin moves a parcel back once it left: the depot person who scanned it undoes it
  const lc = await last(depot, id);
  assert.equal(lc.why, null);
  assert.ok(lc.effects.some((e: any) => e.k === 'stockBack' && e.n === qty));
  await call('orders.undo', depot, { id, eventId: lc.eventId });
  const u = await row(id);
  assert.equal(u.follow_status, 'prepared');
  assert.equal(u.shipped_at, null);
  assert.equal(await stockOf(v, wh), s0, 'stock back');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM stock_movements WHERE order_id = $1 AND reason = 'shipped'`, [id]))[0].n, 0);
  // the real departure later: the stock leaves once
  await setFollow(depot, { ids: [id], status: 'shipped', note: 'scan dispatch' });
  assert.equal(await stockOf(v, wh), s0 - qty);
});

test('delivered by mistake: back on the road, no longer counted; money in a caisse or a courier status: never undone', async () => {
  const onRoad = `NOT o.is_exchange AND NOT o.cashed AND o.delivered_at IS NULL AND o.conf_status = 'confirmed'`;
  const pick = async (st: string, not = 0) => (await db.query(`SELECT o.id, o.customer_id FROM orders o WHERE o.follow_status = $1 AND o.id <> $2 AND ${onRoad} ORDER BY o.id LIMIT 1`, [st, not])).map((r: any) => ({ id: Number(r.id), c: Number(r.customer_id) }))[0];
  const a = (await pick('out_for_delivery')) ?? (await pick('shipped'));
  assert.ok(a, 'a parcel on the road in the demo');
  const b = (await pick('shipped', a.id)) ?? (await pick('out_for_delivery', a.id)) ?? (await pick('failed', a.id));
  assert.ok(b, 'another parcel on the road');
  const back = (await row(a.id)).follow_status;
  const d0 = Number((await db.query('SELECT delivered FROM customers WHERE id = $1', [a.c]))[0].delivered);
  await call('orders.setFollow', suivi, { ids: [a.id], status: 'delivered' });
  assert.equal(Number((await db.query('SELECT delivered FROM customers WHERE id = $1', [a.c]))[0].delivered), d0 + 1);
  assert.equal((await last(suivi, a.id)).why, null);
  await undo(suivi, a.id);
  const u = await row(a.id);
  assert.equal(u.follow_status, back);
  assert.equal(u.delivered_at, null);
  assert.equal(Number((await db.query('SELECT delivered FROM customers WHERE id = $1', [a.c]))[0].delivered), d0);
  // delivered again, the money put in a caisse: not undone here
  await call('orders.setFollow', suivi, { ids: [a.id], status: 'delivered' });
  await db.query('UPDATE orders SET cashed = true WHERE id = $1', [a.id]);
  assert.equal((await last(suivi, a.id)).why, 'cashed');
  await assert.rejects(undo(suivi, a.id), /déjà en caisse/);
  // the delivery company said « livré »: its next update would say it again
  await setFollow(admin, { ids: [b.id], status: 'delivered', note: 'Statut Test' }, { system: true, courier: true });
  assert.equal((await last(admin, b.id)).why, 'courier');
  await assert.rejects(undo(admin, b.id), /société de livraison/);
});

test('returned by mistake (depot scan): back to « En retour », the stock goes out again', async () => {
  const p = (
    await db.query(
      `SELECT o.id, o.warehouse_id, i.variant_id, i.qty FROM orders o JOIN order_items i ON i.order_id = o.id AND i.variant_id IS NOT NULL
        WHERE o.follow_status = 'returning' AND o.shipped_at IS NOT NULL AND o.returned_at IS NULL AND o.warehouse_id IS NOT NULL AND NOT o.is_exchange
          AND (SELECT count(*) FROM order_items x WHERE x.order_id = o.id) = 1 ORDER BY o.id LIMIT 1`,
    )
  )[0];
  assert.ok(p, 'a parcel coming back in the demo');
  const id = Number(p.id);
  const s0 = await stockOf(Number(p.variant_id), Number(p.warehouse_id));
  await setFollow(depot, { ids: [id], status: 'returned', note: 'reçu au dépôt (scan)' });
  assert.equal(await stockOf(Number(p.variant_id), Number(p.warehouse_id)), s0 + Number(p.qty));
  await undo(depot, id);
  const u = await row(id);
  assert.equal(u.follow_status, 'returning');
  assert.equal(u.returned_at, null);
  assert.equal(await stockOf(Number(p.variant_id), Number(p.warehouse_id)), s0);
  // and the history: the return left it, one undo line
  const k = await kinds(id);
  assert.equal(k[k.length - 1], 'undo:returned>returning');
  assert.ok(!k.includes('follow_status:returning>returned'));
});

/** a parcel in « En dispatch » at a company with an API: an order to prepare, every product taken, sent (the preview's courier) */
const enDispatch = async () => {
  const co = (await db.query('SELECT id FROM delivery_companies WHERE kind = ANY($1) AND active ORDER BY id LIMIT 1', [API_COURIER_KINDS]))[0];
  assert.ok(co, 'a company with an API in the demo');
  const p = (
    await db.query(
      `SELECT o.id FROM orders o WHERE o.conf_status = 'confirmed' AND o.follow_status = 'to_prepare' AND o.tracking IS NULL AND NOT o.is_exchange AND NOT o.cashed
        ORDER BY o.id DESC LIMIT 1`,
    )
  )[0];
  assert.ok(p, 'an order to prepare in the demo');
  const id = Number(p.id);
  await db.query('UPDATE orders SET company_id = $2, livreur_id = NULL WHERE id = $1', [id, co.id]);
  await db.query('UPDATE order_items SET picked_qty = qty WHERE order_id = $1', [id]);
  await dispatchOrders(asDepot(depot), [id]);
  const r = await row(id);
  assert.equal(r.follow_status, 'prepared');
  assert.ok(r.tracking, 'its parcel made at the company');
  return { id, companyId: Number(co.id) };
};

test('in a pickup bag at the company: taken out of the bag first, then undone', async () => {
  const { id, companyId } = await enDispatch();
  await setFollow(depot, { ids: [id], status: 'shipped', note: 'scan dispatch' });
  const bag = (await db.query(`INSERT INTO pickup_bags (company_id, ext_id, tracking, state, parcels, unprocessed, created_by) VALUES ($1, 'bag-undo', 'SAC-UNDO', 'Créé', 1, 1, $2) RETURNING id`, [companyId, depot.session.profile.id]))[0];
  await db.query('INSERT INTO pickup_bag_parcels (bag_id, order_id) VALUES ($1, $2)', [bag.id, id]);
  assert.equal((await last(depot, id)).why, 'bag');
  await assert.rejects(undo(depot, id), /sac de ramassage/);
  // out of the bag (at the company too): then it can go back
  await call('pickup.remove', depot, { bagId: Number(bag.id), orderId: id });
  assert.equal((await last(depot, id)).why, null);
  await undo(depot, id);
  assert.equal((await row(id)).follow_status, 'prepared');
});

test('cancelled by mistake in « En dispatch »: back there, its parcel (cancelled at the company) made again', async () => {
  const { id } = await enDispatch();
  const first = (await row(id)).tracking;
  await call('orders.setFollow', suivi, { ids: [id], status: 'cancelled', reason: 'Client injoignable' });
  const c = await row(id);
  assert.equal(c.follow_status, 'cancelled');
  assert.equal(c.tracking, null, 'its parcel was cancelled at the company');
  const lc = await last(suivi, id);
  assert.equal(lc.why, null);
  assert.ok(lc.effects.some((e: any) => e.k === 'resend'), 'said before: the parcel is made again');
  await call('orders.undo', suivi, { id, eventId: lc.eventId });
  const u = await row(id);
  assert.equal(u.follow_status, 'prepared');
  assert.ok(u.tracking, 'a new parcel at the company');
  assert.notEqual(u.tracking, first);
  assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM depot_alerts WHERE order_id = $1 AND resolved_at IS NULL', [id]))[0].n), 0, 'no red alert left at the depot');
});

test('prepared by mistake (« En dispatch »): back to « À préparer », its products to take again — not sent straight back', async () => {
  const p = (
    await db.query(
      `SELECT o.id FROM orders o WHERE o.conf_status = 'confirmed' AND o.follow_status = 'to_prepare' AND NOT o.is_exchange AND NOT o.cashed AND o.company_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id AND NOT p.is_service) ORDER BY o.id LIMIT 1`,
    )
  )[0];
  assert.ok(p, 'an order to prepare in the demo');
  const id = Number(p.id);
  // every product taken (« J'ai pris »)
  await db.query('UPDATE order_items SET picked_qty = qty WHERE order_id = $1', [id]);
  const items = await db.query('SELECT i.product_id, i.variant_id, i.qty FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = $1 AND NOT p.is_service', [id]);
  const pool = async () => {
    let n = 0;
    for (const i of items) n += Number((await db.query('SELECT coalesce(sum(qty), 0)::int AS n FROM depot_pick_pool WHERE product_id = $1 AND variant_id IS NOT DISTINCT FROM $2', [i.product_id, i.variant_id]))[0].n);
    return n;
  };
  const pool0 = await pool();
  const before0 = await row(id);
  await setFollow(depot, { ids: [id], status: 'prepared' });
  assert.equal((await row(id)).follow_status, 'prepared');
  const lc = await last(depot, id);
  assert.equal(lc.why, null);
  assert.ok(lc.effects.some((e: any) => e.k === 'repick'), 'said before: its products are to take again');
  await call('orders.undo', depot, { id, eventId: lc.eventId });
  const u = await row(id);
  assert.equal(u.follow_status, 'to_prepare');
  assert.equal(String(u.prepared_at), String(before0.prepared_at));
  assert.equal(Number((await db.query('SELECT coalesce(sum(picked_qty), 0)::int AS n FROM order_items WHERE order_id = $1', [id]))[0].n), 0, 'its products are to take again');
  assert.equal(await pool(), pool0 + items.reduce((s: number, i: any) => s + Number(i.qty), 0), 'what was taken waits first in the pool');
  // the depot's page does not send it straight back to « En dispatch »
  await autoDispatch(asDepot(depot), [id]);
  assert.equal((await row(id)).follow_status, 'to_prepare');
});

test('the « ↶ » of an older message never undoes the change before the one already undone', async () => {
  const o = await order();
  await call('orders.setConf', samira, { ids: [o.id], status: 'busy' });
  await call('orders.setConf', samira, { ids: [o.id], status: 'no_answer' });
  // the second change undone from the order's bar
  await undo(samira, o.id);
  assert.equal((await row(o.id)).conf_status, 'busy');
  // the message of the second change, still on screen, pressed: refused — « occupé » stays
  await assert.rejects(call('orders.undoMany', samira, { ids: [o.id] }).then((r: any) => { if (r.refused.length) throw new Error(r.refused[0].why); }), /déjà annulé/);
  await assert.rejects(call('orders.undo', samira, { id: o.id }), /déjà annulé/);
  assert.equal((await row(o.id)).conf_status, 'busy');
  // the bar (the change shown, by its number) still can
  await undo(samira, o.id);
  assert.equal((await row(o.id)).conf_status, 'new');
});
