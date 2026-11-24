// Swap with ZR (owner, 24 Nov 2026: « swap done through the API directly, with one click; the same wilaya and the same
// variant first, then the same variant; another variant never shown »): ZR makes it itself through its own swap API, only
// an order asking for exactly the parcel's products receives it, the same wilaya first; ZR's « Commande annulée » under
// any status is an alert (PX1254 and PX1276 stayed « En livraison »); a swap Pilotix made alone can be undone.
import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { itemsKey, swapWayOf, zrSwapStatus } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { helpers, resolveStatus } from '../couriers/load';
import type { CourierCompany, Parcel } from '../couriers/types';
import { zr } from '../couriers/zr';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(300));
});

const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});

const companyId = async (kind: string) => Number((await db.query('SELECT id FROM delivery_companies WHERE kind = $1 ORDER BY id LIMIT 1', [kind]))[0].id);
const used = new Set<number>();
/** `to` asks for exactly the products of `from`'s parcel (or `variantOf`: the same product, another variant). */
async function copyItems(from: number, to: number) {
  await db.query('DELETE FROM order_items WHERE order_id = $1', [to]);
  await db.query(
    `INSERT INTO order_items (order_id, product_id, variant_id, name, variant_title, qty, unit_price, purchase_price, is_upsell, for_product_id)
     SELECT $2, product_id, variant_id, name, variant_title, qty, unit_price, purchase_price, is_upsell, for_product_id FROM order_items WHERE order_id = $1`,
    [from, to],
  );
}
/** A ZR parcel its customer cancelled, still at its destination (ZR lets swap it), in wilaya `w`. */
async function cancelledAtZr(w: number, status = 'Sortie en livraison · Commande annulée') {
  // (one whose product has another variant too: the list test needs it)
  const r = (
    await db.query(
      `SELECT o.id FROM orders o WHERE o.shipped_at IS NOT NULL AND o.tracking IS NOT NULL AND NOT o.is_exchange AND NOT (o.id = ANY($1))
         AND EXISTS (SELECT 1 FROM order_items i JOIN product_variants v ON v.product_id = i.product_id AND v.id <> i.variant_id WHERE i.order_id = o.id)
       ORDER BY o.id LIMIT 1`,
      [[...used]],
    )
  )[0];
  const id = Number(r.id);
  used.add(id);
  await db.query(`UPDATE orders SET company_id = $2, wilaya_id = $3, follow_status = 'alert', sub_status = NULL, ext_status = $4, ext_id = $5, tracking = $6, cashed = false WHERE id = $1`, [
    id,
    await companyId('zr'),
    w,
    status,
    `zr-uuid-${id}`,
    `16-TEST${id}-ZR`,
  ]);
  return id;
}
/** A confirmed order waiting at the depot (home delivery, no parcel made yet), in wilaya `w`, asking for what `like` asks. */
async function waiting(w: number, like: number) {
  const r = (await db.query(`SELECT id FROM orders WHERE shipped_at IS NULL AND NOT is_exchange AND NOT (id = ANY($1)) ORDER BY id DESC LIMIT 1`, [[...used]]))[0];
  const id = Number(r.id);
  used.add(id);
  await db.query(
    `UPDATE orders SET conf_status = 'confirmed', confirmed_at = COALESCE(confirmed_at, now()), follow_status = 'to_prepare', sub_status = NULL, tracking = NULL, ext_id = NULL,
       wilaya_id = $2, is_stopdesk = false, stopdesk_id = NULL, cashed = false WHERE id = $1`,
    [id, w],
  );
  await copyItems(like, id);
  return id;
}
/** The same product as one of `like`'s lines, another of its variants. */
async function otherVariant(id: number, like: number) {
  for (const l of await db.query('SELECT product_id, variant_id FROM order_items WHERE order_id = $1 AND variant_id IS NOT NULL ORDER BY id', [like])) {
    const v = (await db.query('SELECT id FROM product_variants WHERE product_id = $1 AND id <> $2 ORDER BY id LIMIT 1', [l.product_id, l.variant_id]))[0];
    if (!v) continue;
    await db.query('UPDATE order_items SET variant_id = $2 WHERE order_id = $1 AND variant_id = $3', [id, v.id, l.variant_id]);
    return;
  }
  assert.fail('a product with two variants in the parcel');
}

test('ZR takes a swap only while the customer cancelled or never answered, before the parcel leaves for its return', () => {
  assert.equal(zrSwapStatus('Sortie en livraison · Commande annulée'), true);
  assert.equal(zrSwapStatus('Confirmé au bureau · Commande annulée'), true);
  assert.equal(zrSwapStatus('En livraison · Ne répond pas 3'), true);
  assert.equal(zrSwapStatus('Sortie en livraison · Ne répond pas 2'), false, 'not yet: the third call');
  assert.equal(zrSwapStatus('Dispatch dans une autre wilaya · Commande annulée'), false, 'PX1250: already on its way back');
  assert.equal(zrSwapStatus('Sortie en livraison'), false);
  const o = (followStatus: string, extStatus: string | null) => ({ followStatus, extStatus, shippedAt: '2026-11-23T10:00:00.000Z' });
  assert.equal(swapWayOf(o('alert', 'Sortie en livraison · Commande annulée'), 'zr'), 'api');
  assert.equal(swapWayOf(o('out_for_delivery', 'Sortie en livraison · Commande annulée'), 'zr'), 'api', 'PX1254, PX1276');
  assert.equal(swapWayOf(o('returning', 'Dispatch dans une autre wilaya · Commande annulée'), 'zr'), null, 'ZR no longer takes it');
  assert.equal(swapWayOf(o('returning', 'Retour en cours'), 'yalidine'), 'manual');
  assert.equal(swapWayOf(o('returning', null), 'own'), 'manual');
  assert.equal(swapWayOf({ followStatus: 'returning', extStatus: null, shippedAt: null }, 'own'), null, 'never left the depot');
  // the same products, variants and quantities, whatever their order
  assert.equal(itemsKey([{ productId: 1, variantId: 2, qty: 1 }, { productId: 1, variantId: 3, qty: 1 }]), itemsKey([{ productId: 1, variantId: 3, qty: 1 }, { productId: 1, variantId: 2, qty: 1 }]));
  assert.notEqual(itemsKey([{ productId: 1, variantId: 2, qty: 1 }, { productId: 1, variantId: 3, qty: 1 }]), itemsKey([{ productId: 1, variantId: 3, qty: 1 }]), 'PX1250 (Bleu + Beige) is not PX1347 (Beige)');
});

test('ZR « Commande annulée » under any status is an alert, never during the return; the seller’s own choice comes first', () => {
  const st = zr.statuses;
  const sit = zr.situations;
  const r = (status: string, key: string | null, mapped?: 'returning') => ({ status, key: key ?? undefined, ...(mapped ? { mapped } : {}) });
  // PX1254 / PX1276: ZR's status had been taken for « Sortie en livraison » and stayed « En livraison »
  assert.equal(resolveStatus(st, {}, r('Sortie en livraison · Commande annulée', 'sortie_en_livraison'), sit), 'alert');
  assert.equal(resolveStatus(st, { 'Sortie en livraison': 'out_for_delivery' }, r('Sortie en livraison · Commande annulée', 'sortie_en_livraison'), sit), 'alert');
  assert.equal(resolveStatus(st, {}, r('Confirmé au bureau · Ne répond pas 3', 'confirme_au_bureau'), sit), 'alert');
  // the return: ZR's own word (isReturn) wins
  assert.equal(resolveStatus(st, {}, r('Dispatch dans une autre wilaya · Commande annulée', 'dispatch', 'returning'), sit), 'returning');
  assert.equal(resolveStatus(st, {}, r('Retourné · Commande annulée', 'retourne'), sit), 'returning');
  // the seller unticked this exact status in « Alertes du Suivi »: kept
  assert.equal(resolveStatus(st, { 'Sortie en livraison · Commande annulée': 'out_for_delivery' }, r('Sortie en livraison · Commande annulée', 'sortie_en_livraison'), sit), 'out_for_delivery');
  // other situations are untouched
  assert.equal(resolveStatus(st, {}, r('Sortie en livraison · Ne répond pas 1', 'sortie_en_livraison'), sit), 'out_for_delivery');
});

test('the swap list: exactly the parcel’s products only (another variant never, not even in search), the same wilaya first', async () => {
  const admin = await as(EMAILS.admin);
  const a = await cancelledAtZr(19);
  const far = await waiting(16, a);
  const near = await waiting(19, a);
  const variant = await waiting(19, a);
  await otherVariant(variant, a);
  const got: any = await call('suivi.swapCandidates', admin, { fromId: a });
  const ids = got.rows.map((x: any) => x.id);
  assert.ok(ids.indexOf(near) >= 0 && ids.indexOf(far) > ids.indexOf(near), 'the same wilaya first, then another wilaya');
  assert.ok(!ids.includes(variant), 'another variant is never offered');
  assert.equal(got.viaApi, true);
  const phone = (await db.query('SELECT phone FROM orders WHERE id = $1', [variant]))[0].phone;
  const found: any = await call('suivi.swapCandidates', admin, { fromId: a, q: phone });
  assert.ok(!found.rows.some((x: any) => x.id === variant), 'nor found by its phone');
  await assert.rejects(call('suivi.swap', admin, { fromId: a, toId: variant }), /pas exactement les mêmes produits/);
});

test('ZR’s southern wilayas: a parcel at Adrar only goes to a customer of Adrar', async () => {
  const admin = await as(EMAILS.admin);
  const a = await cancelledAtZr(1);
  const other = await waiting(16, a);
  const same = await waiting(1, a);
  const got: any = await call('suivi.swapCandidates', admin, { fromId: a });
  assert.equal(got.sameWilayaOnly, true);
  assert.ok(got.rows.some((x: any) => x.id === same));
  assert.ok(!got.rows.some((x: any) => x.id === other));
  await assert.rejects(call('suivi.swap', admin, { fromId: a, toId: other }), /que dans la même wilaya/);
});

test('swap at ZR (server): one click through ZR’s swap API, its new number kept; its refusal changes nothing; never undone', async () => {
  const calls: [string, any][] = [];
  let refuse = false;
  const server = {
    courier: async (action: string, args: any) => {
      calls.push([action, args]);
      if (action === 'services') return [{ key: 'swapSameCity', price: 50 }, { key: 'swapOtherCity', price: 100 }];
      if (action === 'parcel') return { state: 'Sortie en livraison', situation: 'Commande annulée', swap: { eligible: true, count: 0, sameCityPrice: 50, differentCityPrice: 100 } };
      if (action === 'swap') {
        if (refuse) throw new Error('ZR refuse le swap de ce colis maintenant (Vers wilaya · Commande annulée)');
        return { extId: 'swap-1', parcelExtId: args.item.extId, tracking: '19-NEWSWAP-ZR' };
      }
      return null;
    },
    meta: async () => null,
    hashPassword: async (s: string) => s,
    publicUrl: 'https://pilotix.example',
  } as unknown as Ctx['server'];
  const admin = await as(EMAILS.admin, server);
  const a = await cancelledAtZr(19);
  const b = await waiting(19, a);
  const cands: any = await call('suivi.swapCandidates', admin, { fromId: a });
  assert.deepEqual(cands.courier, { eligible: true, count: 0, same: 50, other: 100 });
  const r: any = await call('suivi.swap', admin, { fromId: a, toId: b });
  const sent = calls.find(([x]) => x === 'swap');
  assert.ok(sent, 'asked to ZR');
  assert.equal(sent![1].orderId, b);
  assert.equal(sent![1].item.extId, `zr-uuid-${a}`);
  assert.equal(r.viaApi, true);
  assert.equal(r.swapFee, 50);
  assert.equal(r.to.tracking, '19-NEWSWAP-ZR', 'ZR’s new number');
  assert.equal(r.to.followStatus, 'out_for_delivery');
  assert.equal(r.from.subStatus, 'annule_swappe');
  const ev = (await db.query(`SELECT note, data FROM order_events WHERE order_id = $1 AND kind = 'follow_status' ORDER BY id DESC LIMIT 1`, [b]))[0];
  assert.match(ev.note, /fait chez ZR[^·]* par API · nouveau n° 19-NEWSWAP-ZR/);
  assert.equal(ev.data.via_api, true);
  // made at ZR: never undone from Pilotix (ZR cannot)
  const last: any = await call('orders.lastChange', admin, { id: b });
  assert.equal(last.swapUndo, false);
  await assert.rejects(call('suivi.unswap', admin, { id: b }), /par API/);
  // ZR refuses: nothing moves in Pilotix, its words are shown
  refuse = true;
  const a2 = await cancelledAtZr(19);
  const b2 = await waiting(19, a2);
  const before = (await db.query('SELECT id, follow_status, tracking FROM orders WHERE id = ANY($1) ORDER BY id', [[a2, b2]])).map((x: any) => [Number(x.id), x.follow_status, x.tracking]);
  await assert.rejects(call('suivi.swap', admin, { fromId: a2, toId: b2 }), /ZR refuse le swap/);
  const after = (await db.query('SELECT id, follow_status, tracking FROM orders WHERE id = ANY($1) ORDER BY id', [[a2, b2]])).map((x: any) => [Number(x.id), x.follow_status, x.tracking]);
  assert.deepEqual(after, before);
});

test('a swap Pilotix made alone (no swap API) can be undone: the parcel back to its order, the other one back to prepare', async () => {
  const admin = await as(EMAILS.admin);
  const ya = await companyId('yalidine');
  const r = (await db.query(`SELECT id FROM orders WHERE shipped_at IS NOT NULL AND tracking IS NOT NULL AND NOT is_exchange AND NOT (id = ANY($1)) ORDER BY id DESC LIMIT 1`, [[...used]]))[0];
  const a = Number(r.id);
  used.add(a);
  await db.query(`UPDATE orders SET company_id = $2, follow_status = 'returning', sub_status = NULL, tracking = 'YAL-UNDO-1', ext_id = NULL, cashed = false WHERE id = $1`, [a, ya]);
  const b = await waiting(16, a);
  const swapped: any = await call('suivi.swap', admin, { fromId: a, toId: b });
  assert.equal(swapped.viaApi, false);
  assert.equal(swapped.to.tracking, 'YAL-UNDO-1');
  const last: any = await call('orders.lastChange', admin, { id: b });
  assert.equal(last.why, 'swap');
  assert.equal(last.swapUndo, true);
  const back: any = await call('suivi.unswap', admin, { id: b });
  assert.equal(back.from.tracking, 'YAL-UNDO-1');
  assert.equal(back.from.followStatus, 'returning');
  assert.equal(back.from.subStatus, null);
  assert.equal(back.to.tracking, null);
  assert.equal(back.to.followStatus, 'to_prepare');
  assert.equal(back.to.shippedAt, null, 'its own stock never left: it leaves with its own parcel');
  await assert.rejects(call('suivi.unswap', admin, { id: a }), /rien à annuler/);
});

test('ZR’s swap API: the new customer, phones, address and amount in one call; refused at once when ZR no longer takes it', async () => {
  const c: CourierCompany = { id: 1, name: 'ZR', kind: 'zr', secret: { api_key: 'k', tenant: 't' }, settings: {}, statusMap: {}, shop: { name: 'Test', fromWilayaId: 16, fromWilaya: 'Alger' }, cacheKey: 'swap-test' } as CourierCompany;
  const to = { id: 9, ref: 'PX9', customer_name: 'Islam', phone: '0558361171', phone2: null, wilaya_id: 40, wilaya: 'Khenchela', wilaya_ar: 'خنشلة', commune: 'Bouhmama', address: 'Bouhmama', is_stopdesk: false, stopdesk_ext_id: null, stopdesk_name: null, stopdesk_commune: null, stopdesk_wilaya_id: null, total: 3050, subtotal: 2300, delivery_fee: 950, products: '1 × Pouf (Beige)', items: [], pieces: 1, weight: 1, delivery_note: '', is_exchange: false, tracking: null, ext_id: null, retry: false } as Parcel;
  const seen: { method: string; path: string; body: any }[] = [];
  let eligible = true;
  globalThis.fetch = (async (u: string, o: any = {}) => {
    const path = String(u).replace(/^.*\/api\/v1/, '');
    const body = o.body ? JSON.parse(o.body) : null;
    seen.push({ method: o.method ?? 'GET', path, body });
    const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } });
    if (path.startsWith('/parcels/')) return json({ id: 'uuid-1', trackingNumber: seen.some((x) => x.path.endsWith('/swap')) ? '40-NEW-ZR' : '12-OLD-ZR', state: { name: 'sortie_en_livraison', description: 'Sortie en livraison' }, situation: { name: 'Commande annulée' }, swap: { count: 0, isEligibleForSwap: eligible } });
    if (path === '/territories/search') return json({ items: [{ id: 'w40', code: 40, level: 'wilaya', name: 'Khenchela' }, { id: 'c1', parentId: 'w40', level: 'commune', name: 'Bouhmama', nameArabic: 'بوحمامة' }], hasNext: false });
    if (path.endsWith('/swap')) return json({ id: 'swap-9' });
    return json({}, 404);
  }) as typeof fetch;
  const sent = await zr.swap!(c, { item: { id: 1, tracking: '12-OLD-ZR', extId: 'uuid-1' }, to }, helpers);
  const post = seen.find((x) => x.path === '/parcel-modification-requests/swap');
  assert.ok(post, 'ZR’s swap address');
  assert.deepEqual(
    { parcelId: post!.body.parcelId, name: post!.body.newCustomerName, phone: post!.body.phone.number1, type: post!.body.deliveryType, city: post!.body.deliveryAddress.cityTerritoryId, district: post!.body.deliveryAddress.districtTerritoryId, amount: post!.body.amount },
    { parcelId: 'uuid-1', name: 'Islam', phone: '+213558361171', type: 'home', city: 'w40', district: 'c1', amount: 3050 },
  );
  assert.deepEqual(sent, { extId: 'swap-9', parcelExtId: 'uuid-1', tracking: '40-NEW-ZR' });
  // ZR says no more: refused before anything is sent
  eligible = false;
  seen.length = 0;
  await assert.rejects(zr.swap!(c, { item: { id: 1, tracking: '12-OLD-ZR', extId: 'uuid-1' }, to }, helpers), /ZR refuse le swap/);
  assert.ok(!seen.some((x) => x.path.endsWith('/swap')));
});
