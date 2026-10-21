// Suivi + SAV: swap moves the parcel, alerts are treated, claims are kept, SAV exchanges create an order, roles are enforced.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(400));
});

async function shippedParcel(status = 'returning') {
  const r = (await db.query(`SELECT id FROM orders WHERE shipped_at IS NOT NULL AND tracking IS NOT NULL AND follow_status IN ('out_for_delivery','alert','failed') ORDER BY id LIMIT 1`))[0];
  await db.query(`UPDATE orders SET follow_status=$2 WHERE id=$1`, [r.id, status]);
  return Number(r.id);
}
async function waitingOrder(exclude: number[] = []) {
  const r = (await db.query(`SELECT id FROM orders WHERE conf_status='confirmed' AND follow_status='to_prepare' AND shipped_at IS NULL AND NOT (id = ANY($1)) ORDER BY id LIMIT 1`, [exclude]))[0];
  return Number(r.id);
}

test('suivi: counts and lists by tab', async () => {
  const ctx = await as(EMAILS.suivi);
  const c: any = await call('suivi.counts', ctx, {});
  const l: any = await call('suivi.list', ctx, { tab: 'alertes' });
  assert.equal(l.total, c.alertes);
  assert.ok(l.rows.every((o: any) => o.followStatus === 'alert'));
});

test('suivi: swap moves the tracking and the company to the new order', async () => {
  const ctx = await as(EMAILS.suivi);
  const fromId = await shippedParcel('returning');
  const toId = await waitingOrder();
  const before = (await db.query('SELECT tracking, company_id FROM orders WHERE id=$1', [fromId]))[0];
  const cands: any = await call('suivi.swapCandidates', ctx, { fromId });
  assert.ok(Array.isArray(cands.rows));
  const res: any = await call('suivi.swap', ctx, { fromId, toId });
  assert.equal(res.to.tracking, before.tracking);
  assert.equal(res.to.companyId, Number(before.company_id));
  assert.equal(res.to.followStatus, 'out_for_delivery');
  assert.equal(res.to.subStatus, 'livraison_swappe');
  assert.equal(res.from.followStatus, 'cancelled');
  assert.equal(res.from.subStatus, 'annule_swappe');
  assert.equal(res.from.tracking, null);
  const evA = await db.query(`SELECT * FROM order_events WHERE order_id=$1 AND kind='follow_status' AND to_value='cancelled'`, [fromId]);
  const evB = await db.query(`SELECT * FROM order_events WHERE order_id=$1 AND kind='follow_status' AND to_value='out_for_delivery'`, [toId]);
  assert.equal(evA.length, 1);
  assert.equal(evB.length, 1);
  const tgt: any = await call('suivi.swapTarget', ctx, { id: fromId });
  assert.equal(tgt.to.id, toId);
  assert.equal(tgt.oldTracking, before.tracking);
  // the same parcel cannot be swapped twice, an unconfirmed order cannot receive one
  await assert.rejects(call('suivi.swap', ctx, { fromId, toId: await waitingOrder([toId]) }), /pas chez la société/);
});

test('suivi: swap refused for the depot role', async () => {
  const ctx = await as(EMAILS.depot);
  await assert.rejects(call('suivi.swap', ctx, { fromId: 1, toId: 2 }), /Accès refusé/);
});

test('suivi: treat an alert → back on the road with alert_traitee', async () => {
  const ctx = await as(EMAILS.suivi);
  const oid = await shippedParcel('alert');
  const o: any = await call('suivi.treat', ctx, { id: oid, what: 'date', date: '2026-10-25', note: 'après 17 h' });
  assert.equal(o.followStatus, 'out_for_delivery');
  assert.equal(o.subStatus, 'alert_traitee');
  const traites: any = await call('suivi.list', ctx, { tab: 'traites' });
  assert.ok(traites.rows.some((x: any) => x.id === oid));
  const again: any = await call('suivi.act', ctx, { id: oid, action: 'realert' });
  assert.equal(again.followStatus, 'alert');
});

test('suivi: claims are saved with their status history', async () => {
  const ctx = await as(EMAILS.suivi);
  const r = (await db.query(`SELECT o.id FROM orders o JOIN delivery_companies c ON c.id=o.company_id WHERE c.kind <> 'own' AND o.tracking IS NOT NULL LIMIT 1`))[0];
  const c: any = await call('suivi.claimCreate', ctx, { orderId: Number(r.id), reason: 'late', message: 'Bonjour…' });
  assert.equal(c.status, 'waiting');
  const u: any = await call('suivi.claimUpdate', ctx, { id: c.id, sentVia: 'whatsapp' });
  assert.ok(u.sentAt);
  const s: any = await call('suivi.claimUpdate', ctx, { id: c.id, status: 'still_waiting', note: 'relancé' });
  assert.equal(s.status, 'still_waiting');
  const done: any = await call('suivi.claimUpdate', ctx, { id: c.id, status: 'resolved' });
  assert.ok(done.resolvedAt);
  assert.ok(done.notes.length >= 4);
  const list: any = await call('suivi.claims', ctx, { orderId: Number(r.id) });
  assert.ok(list.rows.some((x: any) => x.id === c.id));
  await assert.rejects(call('suivi.claims', await as(EMAILS.livreur), {}), /Accès refusé/);
});

test('sav: create a ticket, then an exchange creates a linked order at the depot', async () => {
  const ctx = await as(EMAILS.suivi);
  const o = (await db.query(`SELECT o.id FROM orders o WHERE o.follow_status='delivered' AND EXISTS (SELECT 1 FROM order_items i JOIN product_variants v ON v.product_id=i.product_id AND v.id <> i.variant_id WHERE i.order_id=o.id) LIMIT 1`))[0];
  const orderId = Number(o.id);
  const t: any = await call('sav.create', ctx, { orderId, type: 'wrong', wish: 'exchange', details: 'Mauvaise taille' });
  assert.equal(t.status, 'open');
  assert.match(t.ref, /^SAV-\d{4}$/);
  const full: any = await call('sav.get', ctx, { id: t.id });
  const item = full.order.items[0];
  const other = (await db.query(`SELECT id FROM product_variants WHERE product_id=$1 AND id <> $2 LIMIT 1`, [item.productId, item.variantId]))[0];
  const ex: any = await call('sav.exchange', ctx, { id: t.id, kind: 'variant', lines: [{ itemId: item.id, qty: 1, variantId: Number(other.id) }] });
  assert.equal(ex.order.isExchange, true);
  assert.equal(ex.order.originalOrderId, orderId);
  assert.equal(ex.order.confStatus, 'confirmed');
  assert.equal(ex.order.followStatus, 'to_prepare');
  assert.equal(ex.order.items[0].variantId, Number(other.id));
  assert.equal(ex.ticket.exchangeOrderId, ex.order.id);
  assert.equal(ex.ticket.status, 'progress');
  // only one exchange per ticket
  await assert.rejects(call('sav.exchange', ctx, { id: t.id, kind: 'same', lines: [{ itemId: item.id, qty: 1 }] }), /existe déjà/);
  // once delivered, the ticket settles by itself
  await db.query(`UPDATE orders SET follow_status='delivered' WHERE id=$1`, [ex.order.id]);
  const k: any = await call('sav.kpis', ctx, {});
  assert.ok(k.livres7 >= 1);
  const after: any = await call('sav.get', ctx, { id: t.id });
  assert.equal(after.ticket.status, 'resolved');
});

test('sav: update status / responsable, and role checks', async () => {
  const ctx = await as(EMAILS.depot);
  const t: any = await call('sav.create', ctx, { orderId: null, customerName: 'Client sans commande', phone: '0550000000', type: 'help', details: '' });
  const mgr = (await db.query(`SELECT id FROM profiles WHERE email=$1`, [EMAILS.manager]))[0];
  const u: any = await call('sav.update', ctx, { id: t.id, status: 'progress', assignedTo: Number(mgr.id), note: 'rappel demain' });
  assert.equal(u.status, 'progress');
  assert.equal(u.assignedTo, Number(mgr.id));
  assert.ok(u.notes.length >= 2);
  await assert.rejects(call('sav.exchange', ctx, { id: t.id, kind: 'same', lines: [{ itemId: 1, qty: 1 }] }), /aucune commande/);
  await assert.rejects(call('sav.list', await as(EMAILS.livreur), {}), /Accès refusé/);
  await assert.rejects(call('sav.create', await as(EMAILS.marketer), { type: 'help', customerName: 'X' }), /Accès refusé/);
  const list: any = await call('sav.list', await as(EMAILS.conf), { view: 'all', q: t.ref });
  assert.equal(list.rows[0].id, t.id);
});
