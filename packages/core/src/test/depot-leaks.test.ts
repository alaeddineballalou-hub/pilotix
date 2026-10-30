// Dépôt leaks closed (step 2): each test is one hole that must stay closed.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(800));
});

const companyId = async (kind: string) => Number((await db.query('SELECT id FROM delivery_companies WHERE kind = $1 ORDER BY id LIMIT 1', [kind]))[0].id);
const row = async (id: number) => (await db.query('SELECT * FROM orders WHERE id = $1', [id]))[0];
/** orders still « À préparer » (not picked), without a parcel */
const fresh = async (n: number) =>
  (await db.query(`SELECT id FROM orders WHERE conf_status = 'confirmed' AND follow_status = 'to_prepare' AND tracking IS NULL AND NOT is_exchange ORDER BY id LIMIT $1`, [n])).map((r: any) => Number(r.id));
const pickAll = (ids: number[]) => db.query('UPDATE order_items SET picked_qty = qty WHERE order_id = ANY($1)', [ids]);
/** picked whole and sent to a company by an admin: in « En dispatch » with the company's number */
async function atCompany(kind: string, n = 1) {
  const ids = await fresh(n);
  await pickAll(ids);
  const r: any = await call('depot.dispatch', await as(EMAILS.admin), { ids, companyId: await companyId(kind) });
  assert.equal(r.failed.length, 0, JSON.stringify(r));
  return ids;
}

// ---------------------------------------------------------------- 1. courier changed from the order form
test('leak 1: the company changes on the order form — the old parcel is cancelled first, the new one made, the depot alerted', async () => {
  const [a] = await atCompany('yalidine');
  const old = (await row(a)).tracking as string;
  assert.match(old, /^yal-/);
  const zr = await companyId('zr');
  const suivi = await as(EMAILS.suivi);
  const o: any = await call('orders.update', suivi, { id: a, companyId: zr });
  assert.equal(o.companyId, zr);
  const now = await row(a);
  assert.match(now.tracking, /^ZR-/, 'made at the new company');
  const ev = await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND note LIKE 'Colis annulé%'`, [a]);
  assert.ok(ev.some((e: any) => e.note.includes(old)), 'cancelled at the old company');
  // the depot's alert: one scan of the old label (the right parcel, its old label taken off) closes it
  const al = (await db.query('SELECT id, old_code, new_code FROM depot_alerts WHERE order_id = $1 AND resolved_at IS NULL', [a]))[0];
  assert.equal(al.old_code, old);
  assert.equal(al.new_code, null);
  const scanned: any = await call('depot.alertScan', await as(EMAILS.depot), { id: Number(al.id), code: old });
  assert.equal(scanned.step, 'done');
  // the old label is no longer this order's: the scanner refuses it
  const depot = await as(EMAILS.depot);
  const scan: any = await call('depot.scan', depot, { code: old, mode: 'dispatch' });
  assert.notEqual(scan.kind, 'ok');
});

test('leak 1: a parcel that already left the depot keeps its company', async () => {
  const [a] = await atCompany('yalidine');
  await db.query(`UPDATE orders SET follow_status = 'shipped', shipped_at = now() WHERE id = $1`, [a]);
  const before = (await row(a)).tracking;
  await assert.rejects(call('orders.update', await as(EMAILS.suivi), { id: a, companyId: await companyId('zr') }), /déjà parti du dépôt/);
  assert.equal((await row(a)).tracking, before);
});

// ---------------------------------------------------------------- 2. « Envoyer au dispatch » without picking / rights
test('leak 2: an order not picked whole cannot leave « À préparer »', async () => {
  const [a] = await fresh(1);
  const yal = await companyId('yalidine');
  await db.query('UPDATE orders SET company_id = $2 WHERE id = $1', [a, yal]);
  await assert.rejects(call('depot.dispatch', await as(EMAILS.admin), { ids: [a] }), /pas encore pris/);
  assert.equal((await row(a)).follow_status, 'to_prepare');
});

test('leak 2: only managers and admins choose the company of an order in « À préparer »', async () => {
  const [a] = await fresh(1);
  await pickAll([a]);
  await db.query('UPDATE orders SET company_id = NULL WHERE id = $1', [a]);
  const depot = await as(EMAILS.depot);
  await assert.rejects(call('depot.dispatch', depot, { ids: [a], companyId: await companyId('yalidine') }), /managers et les admins/);
  await assert.rejects(call('depot.dispatch', depot, { ids: [a] }), /À attribuer/);
  assert.equal((await row(a)).follow_status, 'to_prepare');
});

test('leak 2: « Livraison privée » never leaves without its livreur', async () => {
  const [a] = await fresh(1);
  await pickAll([a]);
  await assert.rejects(call('depot.dispatch', await as(EMAILS.admin), { ids: [a], companyId: await companyId('own') }), /sans livreur/);
  assert.equal((await row(a)).follow_status, 'to_prepare');
});

test('leak 2: the depot still moves a parcel of « En dispatch » to another company (« Autre société »)', async () => {
  const [a] = await atCompany('yalidine');
  const r: any = await call('depot.dispatch', await as(EMAILS.depot), { ids: [a], companyId: await companyId('zr') });
  assert.equal(r.failed.length, 0);
  assert.match((await row(a)).tracking, /^ZR-/);
});

// ---------------------------------------------------------------- 4. a parcel made early (« À préparer »), then cancelled
/** an order still « À préparer » whose parcel was made early with « Envoyer » (Commandes) */
async function earlyParcel() {
  const [a] = await fresh(1);
  await db.query('UPDATE orders SET company_id = $2 WHERE id = $1', [a, await companyId('yalidine')]);
  const r: any = await call('delivery.send', await as(EMAILS.depot), { ids: [a] });
  assert.equal(r.sent, 1, JSON.stringify(r));
  const o = await row(a);
  assert.equal(o.follow_status, 'to_prepare');
  return { id: a, tracking: o.tracking as string };
}
const cancelledAtCompany = async (id: number, tracking: string) =>
  (await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND note LIKE 'Colis annulé%'`, [id])).some((e: any) => e.note.includes(tracking));
const openAlert = async (id: number) => (await db.query(`SELECT kind, old_code FROM depot_alerts WHERE order_id = $1 AND resolved_at IS NULL`, [id]))[0];

test('leak 4: cancelled by Confirmation — the early parcel is deleted at the company and the depot gets the red alert', async () => {
  const p = await earlyParcel();
  await call('orders.setConf', await as(EMAILS.conf), { ids: [p.id], status: 'cancelled', reason: 'test' });
  const o = await row(p.id);
  assert.equal(o.follow_status, 'cancelled');
  assert.ok(o.tracking === null || o.cancel_by_hand, 'deleted at the company, or listed to cancel by hand');
  assert.ok(await cancelledAtCompany(p.id, p.tracking));
  const al = await openAlert(p.id);
  assert.equal(al?.kind, 'cancel');
  assert.equal(al.old_code, p.tracking);
});

test('leak 4: cancelled by Suivi — same: deleted at the company, red alert', async () => {
  const p = await earlyParcel();
  await call('orders.setFollow', await as(EMAILS.suivi), { ids: [p.id], status: 'cancelled', reason: 'test' });
  assert.ok(await cancelledAtCompany(p.id, p.tracking));
  assert.equal((await openAlert(p.id))?.kind, 'cancel');
});

// ---------------------------------------------------------------- 5. exchange back, then the first order marked « Retournée »
test('leak 5: the old product scanned back makes the first order « Échangée »; stock counts it once, even if « Retournée » later', async () => {
  const suivi = await as(EMAILS.suivi);
  const o = (await db.query(`SELECT o.id FROM orders o WHERE o.follow_status = 'delivered' AND NOT o.is_exchange AND o.warehouse_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.variant_id IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM complaints c WHERE c.order_id = o.id) LIMIT 1`))[0];
  const first = Number(o.id);
  const t: any = await call('sav.create', suivi, { orderId: first, type: 'defect', details: 'x' });
  const g: any = await call('sav.get', suivi, { id: t.id });
  const line = g.order.items.find((i: any) => i.variantId);
  await call('sav.exchange', suivi, { id: t.id, kind: 'same', lines: [{ itemId: line.id, qty: 1 }] });
  const ex = Number((await db.query('SELECT exchange_order_id FROM complaints WHERE id = $1', [t.id]))[0].exchange_order_id);
  await db.query(`UPDATE orders SET follow_status = 'delivered', shipped_at = now(), delivered_at = now() WHERE id = $1`, [ex]);
  const r: any = await call('depot.scan', await as(EMAILS.depot), { orderId: ex, code: '', mode: 'exchange' });
  assert.equal(r.kind, 'ok', r.why);
  assert.equal((await row(first)).follow_status, 'exchanged', 'delivered and paid, then exchanged — not a return');
  const back = async () => Number((await db.query(`SELECT COALESCE(sum(delta),0)::int AS d FROM stock_movements WHERE order_id = $1 AND reason IN ('exchange_in','returned')`, [first]))[0].d);
  assert.equal(await back(), 1);
  await call('orders.setFollow', await as(EMAILS.admin), { ids: [first], status: 'returned', reason: 'test' });
  assert.equal((await row(first)).follow_status, 'returned');
  assert.equal(await back(), 1, 'not put back a second time');
});

// ---------------------------------------------------------------- 6. a parcel under an open red alert
test('leak 6: the address or the price of a parcel at the company changes through « Modifier le colis » (the form refuses)', async () => {
  const [a] = await atCompany('yalidine');
  const suivi = await as(EMAILS.suivi);
  await assert.rejects(call('orders.update', suivi, { id: a, address: 'Nouvelle adresse, bâtiment 7' }), /Modifier le colis/);
  await assert.rejects(call('orders.update', suivi, { id: a, discount: 100 }), /Modifier le colis/);
});

/** a parcel at the company changes (products or phone): deleted and made again, the scan refuses it until the alert is fixed */
async function remade(change: (a: number) => Promise<Record<string, unknown>>) {
  const [a] = await atCompany('yalidine');
  const old = (await row(a)).tracking as string;
  await call('orders.update', await as(EMAILS.suivi), { id: a, ...(await change(a)) });
  const now = await row(a);
  assert.match(now.tracking, /^yal-/);
  assert.notEqual(now.tracking, old, 'new tracking, new label');
  assert.ok(await cancelledAtCompany(a, old), 'the old parcel deleted at the company');
  const al = (await db.query('SELECT id, old_code, new_code FROM depot_alerts WHERE order_id = $1 AND resolved_at IS NULL', [a]))[0];
  assert.equal(al.old_code, old);
  assert.equal(al.new_code, null, 'one scan of the old label');
  const depot = await as(EMAILS.depot);
  const r: any = await call('depot.scan', depot, { code: now.tracking, mode: 'dispatch' });
  assert.equal(r.kind, 'bad');
  assert.match(r.why, /alerte rouge/);
  assert.equal((await row(a)).follow_status, 'prepared');
  // fixed: one scan of the old label, then the new label sends it
  await call('depot.alertScan', depot, { id: Number(al.id), code: old });
  const ok: any = await call('depot.scan', depot, { code: now.tracking, mode: 'dispatch' });
  assert.equal(ok.kind, 'ok', ok.why);
}

test('leak 6: the products change after packing — parcel deleted and made again, held until the alert is fixed', async () => {
  await remade(async (a) => {
    const items = (await db.query('SELECT product_id, variant_id, qty FROM order_items WHERE order_id = $1 ORDER BY id', [a])).map((r: any) => ({ productId: Number(r.product_id), variantId: r.variant_id === null ? null : Number(r.variant_id), qty: Number(r.qty) }));
    items[0].qty += 1;
    return { items };
  });
});

test('leak 6: the phone changes after packing — parcel deleted and made again, held until the alert is fixed', async () => {
  await remade(async () => ({ phone: '0661234599' }));
});

test('leak 6: a livreur cannot take a parcel whose red alert is open', async () => {
  const own = await companyId('own');
  const lamine = Number((await db.query(`SELECT id FROM profiles WHERE email = $1`, [EMAILS.livreur]))[0].id);
  const [a] = await fresh(1);
  await db.query(`UPDATE orders SET company_id = $2, livreur_id = $3, follow_status = 'prepared' WHERE id = $1`, [a, own, lamine]);
  await call('orders.update', await as(EMAILS.suivi), { id: a, deliveryNote: 'Changé après préparation' });
  assert.ok((await db.query('SELECT 1 FROM depot_alerts WHERE order_id = $1 AND resolved_at IS NULL', [a]))[0]);
  await assert.rejects(call('tournee.take', await as(EMAILS.livreur), { code: (await row(a)).ref }), /alerte rouge/);
  assert.equal((await row(a)).follow_status, 'prepared');
});

// ---------------------------------------------------------------- 7. a parcel in a livreur's hands
/** a parcel Lamine took (his scan): « En livraison » in his hands */
async function inLaminesHands() {
  const own = await companyId('own');
  const lamine = Number((await db.query(`SELECT id FROM profiles WHERE email = $1`, [EMAILS.livreur]))[0].id);
  const [a] = await fresh(1);
  await db.query(`UPDATE orders SET company_id = $2, livreur_id = $3, follow_status = 'out_for_delivery', shipped_at = now() WHERE id = $1`, [a, own, lamine]);
  return { id: a, lamine };
}

test('leak 7: another livreur cannot take a parcel in Lamine’s hands', async () => {
  const p = await inLaminesHands();
  const other = (await db.query(`SELECT email FROM profiles WHERE 'livreur' = ANY(roles) AND active AND id <> $1 LIMIT 1`, [p.lamine]))[0];
  assert.ok(other, 'a second livreur in the demo');
  await assert.rejects(call('tournee.take', await as(other.email), { code: (await row(p.id)).ref }), /dans les mains/);
  assert.equal(Number((await row(p.id)).livreur_id), p.lamine);
});

test('leak 7: in his hands nobody — not even an admin — edits, cancels, moves or gives it to someone else', async () => {
  const p = await inLaminesHands();
  const admin = await as(EMAILS.admin);
  const other = Number((await db.query(`SELECT id FROM profiles WHERE 'livreur' = ANY(roles) AND active AND id <> $1 LIMIT 1`, [p.lamine]))[0].id);
  await assert.rejects(call('orders.update', admin, { id: p.id, address: 'ailleurs' }), /dans les mains/);
  await assert.rejects(call('orders.assignCompany', admin, { ids: [p.id], companyId: await companyId('own'), livreurId: other }), /dans les mains/);
  await assert.rejects(call('orders.setFollow', admin, { ids: [p.id], status: 'delivered' }), /dans les mains/);
  await assert.rejects(call('orders.setFollow', admin, { ids: [p.id], status: 'out_for_delivery', livreurId: other }), /dans les mains/);
  await assert.rejects(call('orders.note', admin, { id: p.id, note: 'x', field: 'delivery' }), /dans les mains/);
  assert.equal((await row(p.id)).follow_status, 'out_for_delivery');
  assert.equal(Number((await row(p.id)).livreur_id), p.lamine);
});

test('leak 7: « Demander le retour » is the only move; he still marks his own parcels; the depot scans it back', async () => {
  const p = await inLaminesHands();
  const lamine = await as(EMAILS.livreur);
  // he marks his own parcel
  await call('orders.setFollow', lamine, { ids: [p.id], status: 'failed', reason: 'Absent' });
  // the suivi asks it back, the depot receives it
  await call('orders.setFollow', await as(EMAILS.suivi), { ids: [p.id], status: 'returning', reason: 'Demander le retour' });
  assert.equal((await row(p.id)).follow_status, 'returning');
  const r: any = await call('depot.scan', await as(EMAILS.depot), { orderId: p.id, code: '', mode: 'return' });
  assert.equal(r.kind, 'ok', r.why);
  assert.equal((await row(p.id)).follow_status, 'returned');
});

// ---------------------------------------------------------------- 8. « Expédier » only on the parcel's label
test('leak 8: typing the customer’s phone in « Expédier » never sends the parcel; its label does', async () => {
  const [a] = await atCompany('yalidine');
  const depot = await as(EMAILS.depot);
  const r: any = await call('depot.scan', depot, { code: (await row(a)).phone, mode: 'dispatch' });
  assert.equal(r.kind, 'bad');
  assert.match(r.why, /pas l’étiquette/);
  assert.equal((await row(a)).follow_status, 'prepared');
  const ok: any = await call('depot.scan', depot, { code: (await row(a)).tracking, mode: 'dispatch' });
  assert.equal(ok.kind, 'ok', ok.why);
});

// ---------------------------------------------------------------- 9. units already picked
const pool = async (productId: number, variantId: number | null) =>
  Number((await db.query('SELECT COALESCE(sum(qty),0)::int AS q FROM depot_pick_pool WHERE product_id = $1 AND variant_id IS NOT DISTINCT FROM $2', [productId, variantId]))[0].q);
const firstLine = async (a: number) => {
  const l = (await db.query('SELECT id, product_id, variant_id, qty FROM order_items WHERE order_id = $1 ORDER BY id LIMIT 1', [a]))[0];
  return { id: Number(l.id), productId: Number(l.product_id), variantId: l.variant_id === null ? null : Number(l.variant_id), qty: Number(l.qty) };
};

test('leak 9: an order cancelled while being picked — what was taken goes back to the depot (used by the next « J’ai pris »)', async () => {
  for (const cancel of ['conf', 'suivi'] as const) {
    const [a] = await fresh(1);
    const l = await firstLine(a);
    await db.query('UPDATE order_items SET picked_qty = qty WHERE id = $1', [l.id]);
    const before = await pool(l.productId, l.variantId);
    if (cancel === 'conf') await call('orders.setConf', await as(EMAILS.conf), { ids: [a], status: 'cancelled', reason: 'test' });
    else await call('orders.setFollow', await as(EMAILS.suivi), { ids: [a], status: 'cancelled', reason: 'test' });
    assert.equal(await pool(l.productId, l.variantId), before + l.qty, cancel);
    assert.equal(Number((await db.query('SELECT COALESCE(sum(picked_qty),0)::int AS p FROM order_items WHERE order_id = $1', [a]))[0].p), 0);
  }
});

test('leak 9: products changed while being picked — the same product stays taken, a removed one goes back to the depot', async () => {
  const [a] = await fresh(1);
  const items = (await db.query('SELECT product_id, variant_id, qty FROM order_items WHERE order_id = $1 ORDER BY id', [a])).map((r: any) => ({ productId: Number(r.product_id), variantId: r.variant_id === null ? null : Number(r.variant_id), qty: Number(r.qty) }));
  await db.query('UPDATE order_items SET picked_qty = qty WHERE order_id = $1', [a]);
  const suivi = await as(EMAILS.suivi);
  // the same products (the form always sends them): still taken
  await call('orders.update', suivi, { id: a, items });
  assert.ok((await db.query('SELECT qty, picked_qty FROM order_items WHERE order_id = $1', [a])).every((r: any) => Number(r.picked_qty) === Number(r.qty)));
  // one less of the first product: the extra unit goes back to the depot
  if (items[0].qty > 1) {
    const before = await pool(items[0].productId, items[0].variantId);
    await call('orders.update', suivi, { id: a, items: [{ ...items[0], qty: items[0].qty - 1 }, ...items.slice(1)] });
    assert.equal(await pool(items[0].productId, items[0].variantId), before + 1);
  }
});

// ---------------------------------------------------------------- 10. « J'ai pris »: double tap, « Annuler »
test('leak 10: two « J’ai pris » at the same moment count each once; « Annuler » puts everything back; after it the orders go on', async () => {
  const depot = await as(EMAILS.depot);
  // three fresh orders of one product, confirmed: 3 to take
  const admin = await as(EMAILS.admin);
  const wh = Number((await db.query('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1'))[0].id);
  const v = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service ORDER BY p.id DESC, v.id LIMIT 1`))[0];
  const p = { productId: Number(v.id), variantId: Number(v.vid) };
  await db.query('INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, $2, 500) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = 500', [p.variantId, wh]);
  for (let k = 0; k < 3; k++) {
    const o: any = await call('orders.create', admin, { customerName: `Pick ${k}`, phone: `069480000${k}`, wilayaId: 16, commune: 'Kouba', address: 'x', items: [{ ...p, qty: 1 }] });
    await call('orders.setConf', admin, { ids: [o.id], status: 'confirmed' });
  }
  const picked = async () => Number((await db.query(
    `SELECT COALESCE(sum(i.picked_qty),0)::int AS q FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.follow_status = 'to_prepare' AND i.product_id = $1 AND i.variant_id IS NOT DISTINCT FROM $2`, [p.productId, p.variantId]))[0].q);
  const before = { picked: await picked(), pool: await pool(p.productId, p.variantId) };
  // one tap, then « Annuler »: as before
  const one: any = await call('depot.pick', depot, { productId: p.productId, variantId: p.variantId, qty: 1, undo: true });
  assert.ok(one.logId);
  assert.equal((await picked()) + (await pool(p.productId, p.variantId)), before.picked + before.pool + 1);
  await call('depot.pickUndo', depot, { id: one.logId });
  assert.deepEqual({ picked: await picked(), pool: await pool(p.productId, p.variantId) }, before);
  // two taps at the same moment: two picks of 1, counted 2 (never more)
  const [a, b]: any[] = await Promise.all([
    call('depot.pick', depot, { productId: p.productId, variantId: p.variantId, qty: 1, undo: true }),
    call('depot.pick', depot, { productId: p.productId, variantId: p.variantId, qty: 1, undo: true }),
  ]);
  assert.equal((await picked()) + (await pool(p.productId, p.variantId)), before.picked + before.pool + 2);
  // the first cannot be undone once the second came after it; the second can
  await assert.rejects(call('depot.pickUndo', depot, { id: Math.min(a.logId, b.logId) }), /après vous/);
  await call('depot.pickDone', depot, { id: Math.max(a.logId, b.logId) });
  await assert.rejects(call('depot.pickUndo', depot, { id: Math.max(a.logId, b.logId) }), /Trop tard/);
});

// ---------------------------------------------------------------- 11. « Créer un sac » twice at once
test('leak 11: two « Créer un sac » at the same moment make one bag at the courier', async () => {
  const zr = await companyId('zr');
  const ids = await atCompany('zr', 2);
  await db.query(`UPDATE orders SET follow_status = 'shipped', shipped_at = now() WHERE id = ANY($1)`, [ids]);
  const depot = await as(EMAILS.depot);
  const before = Number((await db.query('SELECT count(*)::int AS n FROM pickup_bags'))[0].n);
  const res = await Promise.allSettled([call('pickup.create', depot, { companyId: zr, ids }), call('pickup.create', depot, { companyId: zr, ids })]);
  assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM pickup_bags'))[0].n), before + 1, JSON.stringify(res.map((x) => (x.status === 'rejected' ? String(x.reason?.message) : 'ok'))));
});

// ---------------------------------------------------------------- 12. the scanner speaks the worker's language
test('leak 12: the scanner answers in French, English or Arabic; a blocked parcel says to put it aside', async () => {
  const depot = await as(EMAILS.depot);
  const fr: any = await call('depot.scan', depot, { code: 'NOPE-0000', mode: 'dispatch' });
  const en: any = await call('depot.scan', depot, { code: 'NOPE-0000', mode: 'dispatch', lang: 'en' });
  const ar: any = await call('depot.scan', depot, { code: 'NOPE-0000', mode: 'dispatch', lang: 'ar' });
  assert.match(fr.why, /n’existe pas/);
  assert.match(en.why, /does not exist/);
  assert.match(ar.why, /غير موجود/);
  const [a] = await atCompany('yalidine');
  const code = (await row(a)).tracking;
  await call('depot.scan', depot, { code, mode: 'dispatch' });
  const twice: any = await call('depot.scan', depot, { code, mode: 'dispatch', lang: 'ar' });
  assert.equal(twice.kind, 'bad');
  assert.match(twice.why, /أُرسل من قبل/);
  assert.match(twice.why, /مُرسلة/, 'the status in Arabic too');
});
