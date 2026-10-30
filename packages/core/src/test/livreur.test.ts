// « Ma tournée »: « Je travaille aujourd'hui »; only the livreur's scan puts a parcel « En livraison » (the depot scans it
// to « Dispatchées » first); before his scan he sees no customer; taking another livreur's parcel makes it his.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let as: (email: string) => Promise<Ctx>;
let own: number;
let lamineId: number;
let walidEmail: string;
let X: { productId: number; variantId: number };

before(async () => {
  ({ db, as } = await setup(40));
  admin = await as(EMAILS.admin);
  own = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'own' ORDER BY id LIMIT 1`))[0].id);
  lamineId = Number((await db.query('SELECT id FROM profiles WHERE email = $1', [EMAILS.livreur]))[0].id);
  walidEmail = (await db.query(`SELECT email FROM profiles WHERE 'livreur' = ANY(roles) AND active AND email <> $1 ORDER BY id LIMIT 1`, [EMAILS.livreur]))[0].email;
  const wh = Number((await db.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1'))[0].id);
  const r = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  X = { productId: Number(r.id), variantId: Number(r.vid) };
  await db.query('INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, $2, 500) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = 500', [X.variantId, wh]);
});

let n = 0;
const phone = () => `0694${String(700000 + ++n).slice(-6)}`;
/** an order for our own livreur Lamine, prepared (« En dispatch ») */
async function forLamine() {
  const o = (await call('orders.create', admin, { customerName: `Client${n} Secret`, phone: phone(), wilayaId: 16, commune: 'Kouba', address: 'Cité 12', items: [{ ...X, qty: 1 }], companyId: own })) as any;
  await call('orders.setConf', admin, { ids: [o.id], status: 'confirmed' });
  await call('orders.assignCompany', admin, { ids: [o.id], companyId: own, livreurId: lamineId });
  await call('orders.setFollow', admin, { ids: [o.id], status: 'prepared' });
  return o as { id: number; ref: string };
}
const st = async (id: number) => (await db.query('SELECT follow_status, livreur_id FROM orders WHERE id = $1', [id]))[0];

test('« Je travaille aujourd’hui »: the managers see who said it today', async () => {
  const lamine = await as(EMAILS.livreur);
  const before = ((await call('delivery.livreurs', admin, {})) as any[]).find((l) => l.id === lamineId);
  assert.equal(before.checkedInAt, null);
  const r = (await call('tournee.checkIn', lamine, {})) as any;
  assert.ok(r.at);
  const after = ((await call('delivery.livreurs', admin, {})) as any[]).find((l) => l.id === lamineId);
  assert.equal(after.checkedInAt, r.at);
  assert.equal(((await call('delivery.tournee', lamine, {})) as any).checkedInAt, r.at);
});

test('the depot scans to « Dispatchées », the livreur scans to take it: no customer before, « En livraison » after', async () => {
  const o = await forLamine();
  const karim = await as(EMAILS.depot);
  await call('depot.scan', karim, { code: o.ref, mode: 'dispatch' });
  assert.equal((await st(o.id)).follow_status, 'shipped', 'on the shelf (« Dispatchées »)');
  // nobody else puts it in his hands (not even the suivi)
  await assert.rejects(call('orders.setFollow', await as(EMAILS.suivi), { ids: [o.id], status: 'out_for_delivery' }), /seul le livreur/);
  const lamine = await as(EMAILS.livreur);
  const t1 = (await call('delivery.tournee', lamine, {})) as any;
  const waiting = t1.pickup.find((x: any) => x.id === o.id);
  assert.ok(waiting, 'on the shelf: to take');
  assert.equal(waiting.customerName, '', 'no customer before his scan');
  assert.equal(waiting.phone, '');
  assert.ok(!t1.toDeliver.some((x: any) => x.id === o.id));
  const r = (await call('tournee.take', lamine, { code: o.ref.toLowerCase() })) as any;
  assert.equal(r.order.followStatus, 'out_for_delivery');
  assert.match(r.order.customerName, /Secret/, 'his now: the customer shows');
  const t2 = (await call('delivery.tournee', lamine, {})) as any;
  assert.ok(t2.toDeliver.some((x: any) => x.id === o.id));
  assert.equal(((await call('tournee.take', lamine, { code: o.ref })) as any).already, true);
});

test('taking another livreur’s parcel makes it his (and says so); a courier’s parcel is not for our livreurs', async () => {
  const o = await forLamine();
  const walid = await as(walidEmail);
  const r = (await call('tournee.take', walid, { code: o.ref })) as any;
  assert.ok(r.from, 'it was Lamine’s');
  const s = await st(o.id);
  assert.equal(s.follow_status, 'out_for_delivery');
  assert.equal(Number(s.livreur_id), walid.session.profile.id);
  const notes = (await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND note IS NOT NULL`, [o.id])).map((x: any) => String(x.note));
  assert.ok(notes.some((x) => /Pris par .* au lieu de/.test(x)));
  assert.ok(notes.some((x) => /sans le scan/.test(x)), 'the depot had not scanned it to « Dispatchées »');
  const api = (await db.query(`SELECT o.ref FROM orders o JOIN delivery_companies c ON c.id = o.company_id WHERE c.kind <> 'own' AND o.follow_status = 'shipped' LIMIT 1`))[0];
  if (api) await assert.rejects(call('tournee.take', walid, { code: api.ref }), /pas avec nos livreurs/);
});

test('« À retourner »: a parcel going back and the old product of an exchange he delivered, until the depot scans them', async () => {
  const lamine = await as(EMAILS.livreur);
  const suivi = await as(EMAILS.suivi);
  // a refused parcel he brings back
  const o = await forLamine();
  await call('orders.setFollow', admin, { ids: [o.id], status: 'out_for_delivery' });
  await call('orders.setFollow', admin, { ids: [o.id], status: 'returning', reason: 'Refusé' });
  // an exchange he delivers: the customer gives him the old product
  const orig = Number(
    (await db.query(`SELECT o.id FROM orders o JOIN order_items i ON i.order_id = o.id WHERE NOT o.is_exchange AND o.follow_status = 'delivered' AND i.variant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM complaints k WHERE k.order_id = o.id) ORDER BY o.id DESC LIMIT 1`))[0].id,
  );
  const t = (await call('sav.create', suivi, { orderId: orig, type: 'defect', details: 'échange en tournée' })) as any;
  const g: any = await call('sav.get', suivi, { id: t.id });
  const ex: any = await call('sav.exchange', suivi, { id: t.id, kind: 'same', lines: [{ itemId: g.order.items[0].id, qty: 1 }], deliveryFee: 300 });
  const x = Number(ex.order.id);
  await call('orders.assignCompany', admin, { ids: [x], companyId: own, livreurId: lamineId });
  for (const status of ['prepared', 'out_for_delivery']) await call('orders.setFollow', admin, { ids: [x], status });
  // in his hands now: only he marks it delivered
  await call('orders.setFollow', lamine, { ids: [x], status: 'delivered' });
  const t1 = (await call('delivery.tournee', lamine, {})) as any;
  const back = t1.toReturn.map((r: any) => r.id);
  assert.ok(back.includes(o.id), 'the refused parcel');
  assert.ok(back.includes(x), 'the old product of the exchange');
  assert.equal(t1.inHand, t1.toDeliver.length + t1.toReturn.length, 'in his hands: to deliver + to bring back');
  // the depot scans both back: off his list
  const karim = await as(EMAILS.depot);
  for (const id of [o.id, x]) {
    const r = (await call('depot.scan', karim, { orderId: id, mode: 'back' })) as any;
    assert.equal(r.kind, 'ok', r.why);
  }
  const t2 = (await call('delivery.tournee', lamine, {})) as any;
  assert.ok(!t2.toReturn.some((r: any) => r.id === o.id || r.id === x));
});

test('Management › Livreur: ready messages — admins edit them, the livreur gets them in « Ma tournée »', async () => {
  const lamine = await as(EMAILS.livreur);
  const r = (await call('livreur.messages', lamine, {})) as any;
  assert.ok(r.messages.length >= 1 && r.defaults.length >= 1);
  await assert.rejects(call('livreur.messagesSet', lamine, { messages: [] }), 'only admins');
  await assert.rejects(
    call('livreur.messagesSet', admin, { messages: [{ id: 'a', label: 'A', text: 'x' }, { id: 'a', label: 'B', text: 'y' }] }),
    /même identifiant/,
  );
  await call('livreur.messagesSet', admin, { messages: [{ id: 'late', label: 'En retard', text: 'Bonjour {nom}, je serai en retard pour {ref}.' }] });
  const t = (await call('delivery.tournee', lamine, {})) as any;
  assert.deepEqual(
    t.messages.map((m: any) => m.id),
    ['late'],
  );
});
