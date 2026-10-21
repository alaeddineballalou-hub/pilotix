// Orders feature: order form data, delivery quote, exchange pricing, delivered report, customers and blacklist.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  const s = await setup(300);
  db = s.db;
  as = s.as;
});

test('orders.formData lists products with variants, stock and packs', async () => {
  const ctx = await as(EMAILS.conf);
  const d: any = await call('orders.formData', ctx, {});
  assert.ok(d.products.length >= 5);
  const withPacks = d.products.find((p: any) => p.packs.length);
  assert.ok(withPacks, 'a product with packs');
  assert.ok(d.products.every((p: any) => p.variants.length >= 1));
  assert.ok(d.companies.length >= 2);
  await assert.rejects(call('orders.formData', await as(EMAILS.marketer), {}), /Accès refusé/);
});

test('orders.quote uses the client price grid and adds weight fees', async () => {
  const ctx = await as(EMAILS.conf);
  const d: any = await call('orders.formData', ctx, {});
  const light = d.products.find((p: any) => p.name.startsWith('Biberon'));
  const q1: any = await call('orders.quote', ctx, { wilayaId: 16, isStopdesk: false, items: [{ productId: light.id, qty: 1 }] });
  assert.equal(q1.fee, 400);
  const q2: any = await call('orders.quote', ctx, { wilayaId: 16, isStopdesk: true, items: [{ productId: light.id, qty: 1 }] });
  assert.equal(q2.fee, 300);
  const heavy = d.products.find((p: any) => p.name.startsWith('Lit parapluie')); // 9 kg → 4 kg over 5 kg × 50
  const q3: any = await call('orders.quote', ctx, { wilayaId: 16, isStopdesk: false, items: [{ productId: heavy.id, qty: 1 }] });
  assert.equal(q3.fee, 400 + 4 * 50);
  assert.equal(q3.maxDiscount, 1500);
  const none: any = await call('orders.quote', ctx, { wilayaId: null, items: [] });
  assert.equal(none.fee, null);
});

test('create an order with the quoted fee, discount capped, then an exchange at price 0', async () => {
  const ctx = await as(EMAILS.conf);
  const d: any = await call('orders.formData', ctx, {});
  const p = d.products.find((x: any) => x.name.startsWith('Poussette'));
  const items = [{ productId: p.id, variantId: p.variants[0].id, qty: 1 }];
  await assert.rejects(call('orders.create', ctx, { customerName: 'Test Client', phone: '0555000111', wilayaId: 16, items, discount: 5000 }), /Remise trop élevée/);
  const o: any = await call('orders.create', ctx, { customerName: 'Test Client', phone: '0555000111', wilayaId: 16, commune: 'Kouba', items, discount: 500 });
  assert.equal(o.deliveryFee, 450); // 6 kg: 1 kg above 5 kg × 50
  assert.equal(o.total, p.price - 500 + 450);
  const ex: any = await call('orders.create', ctx, {
    customerName: 'Test Client', phone: '0555000111', wilayaId: 16, items: [{ ...items[0], unitPrice: 0 }], isExchange: true, originalOrderId: o.id,
  });
  assert.equal(ex.isExchange, true);
  assert.equal(ex.subtotal, 0);
  assert.equal(ex.total, 450);
});

test('customers: list, search, history and blacklist (role checked)', async () => {
  const ctx = await as(EMAILS.suivi);
  const l: any = await call('customers.list', ctx, { pageSize: 20 });
  assert.equal(l.rows.length, 20);
  const c = l.rows[0];
  const s: any = await call('customers.list', ctx, { q: c.phone.slice(2, 8) });
  assert.ok(s.rows.some((r: any) => r.id === c.id));
  const h: any = await call('customers.history', ctx, { id: c.id });
  assert.equal(h.customer.id, c.id);
  assert.ok(h.orders.length >= 1);
  await call('customers.setBlacklist', ctx, { id: c.id, on: true, reason: 'Refuse les colis' });
  const bl: any = await call('customers.list', ctx, { blacklisted: true, pageSize: 500 });
  assert.ok(bl.rows.some((r: any) => r.id === c.id && r.blacklistReason === 'Refuse les colis'));
  // A new order from a blacklisted number arrives "to check".
  const conf = await as(EMAILS.conf);
  const d: any = await call('orders.formData', conf, {});
  const p = d.products[0];
  const o: any = await call('orders.create', conf, { customerName: c.name, phone: c.phone, wilayaId: 16, items: [{ productId: p.id, variantId: p.variants[0].id, qty: 1 }] });
  assert.equal(o.confStatus, 'to_check');
  assert.equal(o.blacklisted, true);
  await call('customers.setBlacklist', ctx, { phone: c.phone, on: false });
  const after: any = await call('customers.history', ctx, { phone: c.phone });
  assert.equal(after.customer.blacklisted, false);
  await assert.rejects(call('customers.setBlacklist', await as(EMAILS.depot), { id: c.id, on: true }), /Accès refusé/);
  await assert.rejects(call('customers.list', await as(EMAILS.livreur), {}), /Accès refusé/);
});

test('orders.deliveredReport and companyFees add up', async () => {
  const ctx = await as(EMAILS.suivi);
  const from = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const to = new Date(Date.now() + 86_400_000).toISOString();
  const r: any = await call('orders.deliveredReport', ctx, { from, to });
  assert.ok(r.total.n > 0);
  assert.equal(r.total.n, r.companies.reduce((s: number, c: any) => s + c.n, 0));
  assert.equal(r.total.amount, r.total.cashed + r.total.uncashed);
  const n = (await db.query(`SELECT count(*)::int AS n FROM orders WHERE follow_status='delivered' AND delivered_at >= $1 AND delivered_at < $2`, [from, to]))[0].n;
  assert.equal(r.total.n, Number(n));
  const ids = (await db.query(`SELECT id FROM orders WHERE follow_status='delivered' AND company_id IS NOT NULL LIMIT 5`)).map((x: any) => Number(x.id));
  const fees: any = await call('orders.companyFees', ctx, { ids });
  assert.equal(Object.keys(fees).length, ids.length);
  assert.ok(Object.values(fees).every((f: any) => f.fee > 0));
  await assert.rejects(call('orders.deliveredReport', await as(EMAILS.conf), { from, to }), /Accès refusé/);
});

test('orders.list can be limited to a selection (export / print)', async () => {
  const ctx = await as(EMAILS.conf);
  const l: any = await call('orders.list', ctx, { pageSize: 3 });
  const ids = l.rows.map((o: any) => o.id);
  const sel: any = await call('orders.list', ctx, { ids, pageSize: 100 });
  assert.deepEqual(sel.rows.map((o: any) => o.id).sort(), [...ids].sort());
});
