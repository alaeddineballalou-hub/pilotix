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
  const n = (await db.query(`SELECT count(*)::int AS n FROM sales WHERE follow_status='delivered' AND delivered_at >= $1 AND delivered_at < $2`, [from, to]))[0].n;
  assert.equal(r.total.n, Number(n));
  const ids = (await db.query(`SELECT id FROM orders WHERE follow_status='delivered' AND company_id IS NOT NULL LIMIT 5`)).map((x: any) => Number(x.id));
  const fees: any = await call('orders.companyFees', ctx, { ids });
  assert.equal(Object.keys(fees).length, ids.length);
  assert.ok(Object.values(fees).every((f: any) => f.fee > 0));
  await assert.rejects(call('orders.deliveredReport', await as(EMAILS.conf), { from, to }), /Accès refusé/);
});

test('orders.cancelReport: cancellations by status, reason and agent; returns by company with their rate and cost', async () => {
  const ctx = await as(EMAILS.suivi);
  const from = new Date(Date.now() - 120 * 86_400_000).toISOString();
  const to = new Date(Date.now() + 86_400_000).toISOString();
  const r: any = await call('orders.cancelReport', ctx, { from, to });
  // confirmation: every cancelled order of the period, once, by status and by agent
  const n = (await db.query(`SELECT count(*)::int AS n FROM sales WHERE conf_status = ANY($1) AND updated_at >= $2 AND updated_at < $3`, [['cancelled', 'duplicate', 'wrong_number', 'fake'], from, to]))[0].n;
  assert.ok(r.conf.n > 0);
  assert.equal(r.conf.n, Number(n));
  assert.equal(Object.values(r.conf.byStatus).reduce((s: number, x: any) => s + x, 0), r.conf.n);
  assert.equal(r.conf.agents.reduce((s: number, a: any) => s + a.n, 0), r.conf.n);
  assert.ok(r.conf.rate > 0 && r.conf.rate < 1);
  // the reasons given (« Prix trop cher »…), and those given none
  const R = r.conf.reasons;
  assert.equal(R.top.reduce((s: number, x: any) => s + x.n, 0) + R.others + R.none, r.conf.n);
  assert.ok(R.top.some((x: any) => x.reason === 'Prix trop cher'));
  // returns: the parcels of the delivery report's returns, by company out of what it delivered
  const d: any = await call('orders.deliveredReport', ctx, { from, to });
  assert.equal(r.returns.n, d.total.returns);
  assert.equal(r.returns.returning + r.returns.returned, r.returns.n);
  assert.equal(r.returns.companies.reduce((s: number, c: any) => s + c.returns, 0), r.returns.n);
  assert.equal(r.returns.fees, d.total.returnFees + d.total.returnOverweight);
  for (const c of r.returns.companies) assert.equal(c.rate, c.returns / (c.returns + c.delivered));
  assert.equal(r.returns.reasons.top[0].reason, 'Refusé par le client');
  await assert.rejects(call('orders.cancelReport', await as(EMAILS.conf), { from, to }), /Accès refusé/);
  assert.ok(await call('orders.cancelReport', await as(EMAILS.manager), { from, to }));

  // the lists behind each line: the same orders, found by the same period, status, agent, company and reason
  const list = (f: any) => call('orders.list', ctx, { from, to, pageSize: 1, ...f }) as Promise<any>;
  assert.equal((await list({ conf: ['cancelled', 'duplicate', 'wrong_number', 'fake'], dateField: 'updated_at' })).total, r.conf.n);
  assert.equal((await list({ follow: ['returning', 'returned'], dateField: 'back_at' })).total, r.returns.n);
  assert.equal((await list({ follow: ['returning'], dateField: 'back_at' })).total, r.returns.returning);
  const top = R.top[0];
  assert.equal((await list({ conf: ['cancelled', 'duplicate', 'wrong_number', 'fake'], dateField: 'updated_at', reason: { of: 'conf', text: top.reason } })).total, top.n);
  assert.equal((await list({ conf: ['cancelled', 'duplicate', 'wrong_number', 'fake'], dateField: 'updated_at', reason: { of: 'conf', text: null } })).total, R.none);
  const back = r.returns.reasons.top[0];
  assert.equal((await list({ follow: ['returning', 'returned'], dateField: 'back_at', reason: { of: 'back', text: back.reason } })).total, back.n);
  const a = r.conf.agents[0];
  assert.equal((await list({ conf: ['cancelled', 'duplicate', 'wrong_number', 'fake'], dateField: 'updated_at', agentId: a.id ?? 'none' })).total, a.n);
  const c = r.returns.companies[0];
  assert.equal((await list({ follow: ['returning', 'returned'], dateField: 'back_at', companyId: c.companyId ?? 'none' })).total, c.returns);
  // each card says why: the reason of each order of the list
  const rows: any = await call('orders.list', ctx, { from, to, pageSize: 40, conf: ['cancelled', 'duplicate', 'wrong_number', 'fake'], dateField: 'updated_at', reason: { of: 'conf', text: top.reason } });
  const why: any = await call('orders.reasons', ctx, { ids: rows.rows.map((o: any) => o.id), of: 'conf' });
  assert.ok(rows.rows.length > 0 && rows.rows.every((o: any) => why[String(o.id)] === top.reason));
});

test('orders.list can be limited to a selection (export / print)', async () => {
  const ctx = await as(EMAILS.conf);
  const l: any = await call('orders.list', ctx, { pageSize: 3 });
  const ids = l.rows.map((o: any) => o.id);
  const sel: any = await call('orders.list', ctx, { ids, pageSize: 100 });
  assert.deepEqual(sel.rows.map((o: any) => o.id).sort(), [...ids].sort());
});

test('every order has its own unique Pilotix tracking number, made at creation (old ones filled in), also on duplicates', async () => {
  const all = await db.query('SELECT own_tracking FROM orders');
  assert.ok(all.length > 0 && all.every((r: any) => /^PXT\d{8}$/.test(r.own_tracking)));
  assert.equal(new Set(all.map((r: any) => r.own_tracking)).size, all.length);
  const ctx = await as(EMAILS.conf);
  const items = [{ productId: Number((await db.query('SELECT id FROM products WHERE active ORDER BY id LIMIT 1'))[0].id), qty: 1 }];
  const o: any = await call('orders.create', ctx, { customerName: 'Suivi Test', phone: '0555000222', wilayaId: 16, commune: 'Kouba', items });
  assert.match(o.ownTracking, /^PXT\d{8}$/);
  assert.equal(o.tracking, null);
  const d: any = await call('orders.duplicate', ctx, { ids: [o.id] });
  const copy = (await db.query('SELECT own_tracking FROM orders ORDER BY id DESC LIMIT 1'))[0].own_tracking;
  assert.notEqual(copy, o.ownTracking);
  assert.ok(d);
  // found by its number in the search
  const found: any = await call('orders.list', ctx, { q: o.ownTracking.toLowerCase() });
  assert.equal(found.rows[0]?.id, o.id);
});

test('changing only the discount is still capped by the products of the order', async () => {
  const ctx = await as(EMAILS.conf);
  const d: any = await call('orders.formData', ctx, {});
  const p = d.products.find((x: any) => x.maxDiscount !== null && x.maxDiscount > 0);
  const o: any = await call('orders.create', ctx, { customerName: 'Remise Test', phone: '0555000333', wilayaId: 16, commune: 'Kouba', items: [{ productId: p.id, variantId: p.variants[0]?.id, qty: 1 }] });
  await assert.rejects(call('orders.update', ctx, { id: o.id, discount: p.maxDiscount + 1 }), /Remise trop élevée/);
  const ok: any = await call('orders.update', ctx, { id: o.id, discount: p.maxDiscount });
  assert.equal(ok.discount, p.maxDiscount);
});
