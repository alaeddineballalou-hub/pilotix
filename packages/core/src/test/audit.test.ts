// The fixes of the October 2026 audit, one test each: who may change what, money counted once, stock right,
// double clicks harmless, and the order flow's edge cases.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { normalizePhone } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(250));
});

const one = async (sql: string, params: unknown[] = []) => (await db.query(sql, params))[0];
const idOf = async (email: string) => Number((await one('SELECT id FROM profiles WHERE email = $1', [email])).id);
const bal = async (ctx: Ctx, caisse: string) => ((await call('caisse.view', ctx, { caisse })) as any).balance as number;
let n = 0;
const phone = () => `0770${String(500000 + ++n).padStart(6, '0')}`;
async function anItem() {
  const v = await one(`SELECT v.id, v.product_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.active AND p.active AND NOT p.is_service ORDER BY v.id LIMIT 1`);
  return { productId: Number(v.product_id), variantId: Number(v.id), qty: 1 };
}
async function newOrder(ctx: Ctx, extra: Record<string, unknown> = {}) {
  return (await call('orders.create', ctx, { customerName: 'Test Audit', phone: phone(), wilayaId: 16, commune: 'Kouba', items: [await anItem()], ...extra })) as any;
}

// ---------------------------------------------------------------- permissions
test('orders.sync: a livreur or a marketer cannot change a confirmation status, nor note someone else’s parcel', async () => {
  const conf = await as(EMAILS.conf);
  const o = await newOrder(conf);
  for (const email of [EMAILS.livreur, EMAILS.marketer]) {
    const ctx = await as(email);
    const r: any = await call('orders.sync', ctx, { actions: [{ clientId: `audit-sync-${email}`, kind: 'conf', id: o.id, status: 'cancelled', reason: 'test' }] });
    assert.equal(r.results[0].ok, false, email);
  }
  assert.equal((await one('SELECT conf_status FROM orders WHERE id = $1', [o.id])).conf_status, 'new');
  const liv = await as(EMAILS.livreur);
  const r: any = await call('orders.sync', liv, { actions: [{ clientId: 'audit-note-liv-1', kind: 'note', id: o.id, note: 'hack' }] });
  assert.equal(r.results[0].ok, false);
  // confirmation still works through the phone sync
  const ok: any = await call('orders.sync', conf, { actions: [{ clientId: 'audit-sync-conf-1', kind: 'conf', id: o.id, status: 'confirmed' }] });
  assert.equal(ok.results[0].ok, true);
});

test('a livreur cannot hand his parcel (and its cash) to another livreur', async () => {
  const lamine = await idOf(EMAILS.livreur);
  const walid = await idOf('walid@demo.pilotix.dz');
  const o = await one(`SELECT id FROM orders WHERE livreur_id = $1 AND follow_status = 'out_for_delivery' LIMIT 1`, [lamine]);
  assert.ok(o, 'the demo livreur has a parcel on the road');
  const liv = await as(EMAILS.livreur);
  await call('orders.setFollow', liv, { ids: [Number(o.id)], status: 'delivered', livreurId: walid });
  assert.equal(Number((await one('SELECT livreur_id FROM orders WHERE id = $1', [o.id])).livreur_id), lamine);
});

test('deleting an account: refused with parcels or cash in hand; with a money history the account is emptied, not deleted', async () => {
  const liv = await as(EMAILS.livreur);
  await assert.rejects(call('me.delete', liv, { password: 'demo-pilotix' }), /colis ou de l’argent/);
  const walid = await idOf('walid@demo.pilotix.dz');
  // Walid's parcels all settled: delivered and cashed
  await db.query(`UPDATE orders SET follow_status = 'delivered', cashed = true WHERE livreur_id = $1`, [walid]);
  const w = await as('walid@demo.pilotix.dz');
  const had = Number((await one('SELECT count(*)::int AS n FROM orders WHERE livreur_id = $1', [walid])).n);
  assert.ok(had > 0);
  await call('me.delete', w, { password: 'demo-pilotix' });
  const p = await one('SELECT name, email, active FROM profiles WHERE id = $1', [walid]);
  assert.equal(p.active, false);
  assert.equal(p.name, 'Compte supprimé');
  assert.match(p.email, /@pilotix\.invalid$/);
  assert.equal(Number((await one('SELECT count(*)::int AS n FROM orders WHERE livreur_id = $1', [walid])).n), had, 'his parcels keep their livreur');
});

test('changing the password raises the token version (other sessions are logged out)', async () => {
  const depot = await as(EMAILS.depot);
  const id = await idOf(EMAILS.depot);
  const before = Number((await one('SELECT token_version FROM profiles WHERE id = $1', [id])).token_version);
  await call('me.password', depot, { current: 'demo-pilotix', next: 'demo-pilotix' });
  assert.equal(Number((await one('SELECT token_version FROM profiles WHERE id = $1', [id])).token_version), before + 1);
});

test('the dollar rate: the owner sets it, a marketer cannot', async () => {
  const mk = await as(EMAILS.marketer);
  await assert.rejects(call('ads.setFx', mk, { ym: '2026-09', rate: 1 }));
  const owner = await as(EMAILS.vendeur);
  await call('ads.setFx', owner, { ym: '2026-09', rate: 250 });
});

test('a marketer reads no customer (no names, phones, addresses)', async () => {
  const mk = await as(EMAILS.marketer);
  const list: any = await call('orders.list', mk, { pageSize: 50 });
  assert.equal(list.total, 0);
  assert.equal(list.rows.length, 0);
  const any = await one('SELECT id FROM orders LIMIT 1');
  await assert.rejects(call('orders.get', mk, { id: Number(any.id) }));
  await assert.rejects(call('orders.events', mk, { id: Number(any.id) }));
});

// ---------------------------------------------------------------- order flow
test('a cancelled order confirmed again goes back to the depot’s « À préparer »', async () => {
  const conf = await as(EMAILS.conf);
  const o = await newOrder(conf, { confirm: true });
  assert.equal(o.followStatus, 'to_prepare');
  await call('orders.setConf', conf, { ids: [o.id], status: 'cancelled', reason: 'price' });
  assert.equal((await one('SELECT follow_status FROM orders WHERE id = $1', [o.id])).follow_status, 'cancelled');
  await call('orders.setConf', conf, { ids: [o.id], status: 'confirmed' });
  assert.equal((await one('SELECT follow_status FROM orders WHERE id = $1', [o.id])).follow_status, 'to_prepare');
});

test('confirming needs the commune (home delivery), also outside the screen', async () => {
  const conf = await as(EMAILS.conf);
  await assert.rejects(newOrder(conf, { confirm: true, commune: '' }), /commune/);
  const o = await newOrder(conf, { commune: '' });
  await assert.rejects(call('orders.setConf', conf, { ids: [o.id], status: 'confirmed' }), /commune/);
});

test('« Commande suivante »: two agents at the same moment never get the same customer', async () => {
  const a = await as(EMAILS.conf);
  const b = await as(EMAILS.conf2);
  await newOrder(a);
  await newOrder(a);
  const [x, y]: any[] = await Promise.all([call('orders.next', a, {}), call('orders.next', b, {})]);
  assert.ok(x.id && y.id);
  assert.notEqual(x.id, y.id);
});

test('finished orders: a cashed delivery stays delivered; the depot cannot reopen a delivered order; the suivi needs a reason', async () => {
  const suivi = await as(EMAILS.suivi);
  const depot = await as(EMAILS.depot);
  const cashed = await one(`SELECT id FROM orders WHERE follow_status = 'delivered' AND cashed AND NOT is_exchange LIMIT 1`);
  await assert.rejects(call('orders.setFollow', suivi, { ids: [Number(cashed.id)], status: 'returned', note: 'erreur' }), /encaissée/);
  const del = await one(`SELECT id FROM orders WHERE follow_status = 'delivered' AND NOT cashed AND NOT is_exchange LIMIT 1`);
  await assert.rejects(call('orders.setFollow', depot, { ids: [Number(del.id)], status: 'returned' }), /terminée/);
  await assert.rejects(call('orders.setFollow', suivi, { ids: [Number(del.id)], status: 'returning' }), /raison/);
  await call('orders.setFollow', suivi, { ids: [Number(del.id)], status: 'returning', note: 'livré par erreur' });
  // the customer's « livrées » count does not go up twice when it is delivered again
  const c0 = await one('SELECT c.delivered FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.id = $1', [del.id]);
  await call('orders.setFollow', suivi, { ids: [Number(del.id)], status: 'delivered', note: 'finalement livré' });
  const c1 = await one('SELECT c.delivered FROM customers c JOIN orders o ON o.customer_id = c.id WHERE o.id = $1', [del.id]);
  assert.equal(Number(c1.delivered), Number(c0.delivered));
});

test('stock leaves even when the courier reports « en livraison » straight from « Préparée »', async () => {
  const conf = await as(EMAILS.conf);
  const suivi = await as(EMAILS.suivi);
  const o = await newOrder(conf, { confirm: true });
  const it = await one('SELECT variant_id FROM order_items WHERE order_id = $1', [o.id]);
  const wh = Number((await one('SELECT warehouse_id FROM orders WHERE id = $1', [o.id])).warehouse_id);
  const q = async () => Number((await one('SELECT COALESCE(sum(qty),0)::int AS q FROM stock WHERE variant_id = $1 AND warehouse_id = $2', [it.variant_id, wh])).q);
  const q0 = await q();
  await call('orders.setFollow', suivi, { ids: [o.id], status: 'prepared' });
  await call('orders.setFollow', suivi, { ids: [o.id], status: 'out_for_delivery' });
  assert.equal(await q(), q0 - 1);
  assert.ok((await one('SELECT shipped_at FROM orders WHERE id = $1', [o.id])).shipped_at, 'shipped_at is set');
  // and only once
  await call('orders.setFollow', suivi, { ids: [o.id], status: 'shipped' });
  assert.equal(await q(), q0 - 1);
});

test('a parcel at an API courier or cashed: amount and address are frozen (« Modifier le colis » instead)', async () => {
  const conf = await as(EMAILS.conf);
  const zr = await one(`SELECT o.id, o.discount FROM orders o JOIN delivery_companies c ON c.id = o.company_id WHERE c.kind = 'zr' AND o.tracking IS NOT NULL AND o.follow_status = 'out_for_delivery' LIMIT 1`);
  await assert.rejects(call('orders.update', conf, { id: Number(zr.id), discount: Number(zr.discount) + 100 }), /Modifier le colis/);
  // a note still changes, even when the form sends the same products again
  const items = (await db.query('SELECT product_id, variant_id, qty FROM order_items WHERE order_id = $1', [zr.id])).map((r: any) => ({ productId: Number(r.product_id), variantId: r.variant_id == null ? null : Number(r.variant_id), qty: Number(r.qty) }));
  const sent = await one(`SELECT o.id FROM orders o JOIN delivery_companies c ON c.id = o.company_id WHERE c.kind = 'zr' AND o.tracking IS NOT NULL AND o.follow_status = 'prepared' LIMIT 1`);
  if (sent) {
    const its = (await db.query('SELECT product_id, variant_id, qty FROM order_items WHERE order_id = $1', [sent.id])).map((r: any) => ({ productId: Number(r.product_id), variantId: r.variant_id == null ? null : Number(r.variant_id), qty: Number(r.qty) }));
    await call('orders.update', conf, { id: Number(sent.id), customerName: 'Nom corrigé', items: its });
    await assert.rejects(call('orders.update', conf, { id: Number(sent.id), items: its.map((x: any) => ({ ...x, qty: x.qty + 1 })) }), /Modifier le colis/);
  }
  assert.ok(items.length);
  await call('orders.update', conf, { id: Number(zr.id), internalNote: 'rappeler le client' });
  const cashed = await one(`SELECT id, delivery_fee FROM orders WHERE cashed LIMIT 1`);
  await assert.rejects(call('orders.update', conf, { id: Number(cashed.id), deliveryFee: Number(cashed.delivery_fee) + 1 }), /encaissée/);
});

test('phones: +213 0661…, 00213 0661… and 2130661… are read as 0661…', () => {
  for (const p of ['+213 0661234567', '00213 0661 23 45 67', '2130661234567', '+213661234567', '0661234567']) assert.equal(normalizePhone(p), '0661234567', p);
  assert.equal(normalizePhone('+33 6 12 34 56 78'), null);
});

test('the courier sync does not undo the suivi’s alert', async () => {
  const suivi = await as(EMAILS.suivi);
  const zr = await one(`SELECT o.id, o.company_id FROM orders o JOIN delivery_companies c ON c.id = o.company_id WHERE c.kind = 'zr' AND o.tracking IS NOT NULL AND o.follow_status = 'shipped' LIMIT 1`);
  assert.ok(zr, 'a ZR parcel on the road');
  await db.query(`UPDATE delivery_companies SET credentials = '{"api_key":"k","tenant":"t"}', active = true WHERE id = $1`, [zr.company_id]);
  await call('orders.setFollow', suivi, { ids: [Number(zr.id)], status: 'alert', note: 'client injoignable' });
  await call('delivery.sync', suivi, { companyId: Number(zr.company_id) });
  assert.equal((await one('SELECT follow_status FROM orders WHERE id = $1', [zr.id])).follow_status, 'alert');
  // a treated alert: the courier's « en livraison » does not undo it, but a new failed attempt comes in
  await db.query(`UPDATE orders SET follow_status = 'out_for_delivery', sub_status = 'alert_traitee' WHERE id = $1`, [zr.id]);
  const server = { courier: async (a: string, args: any) => (a === 'track' ? args.items.map((x: any) => ({ id: x.id, status: 'Tentative échouée', mapped: x.id === Number(zr.id) ? 'failed' : null })) : []) } as any;
  await call('delivery.sync', await as(EMAILS.suivi, server), { companyId: Number(zr.company_id) });
  assert.equal((await one('SELECT follow_status FROM orders WHERE id = $1', [zr.id])).follow_status, 'failed');
});

test('two « Envoyer » at once send a parcel to the courier only once', async () => {
  const conf = await as(EMAILS.conf);
  const depot = await as(EMAILS.depot);
  const zr = Number((await one(`SELECT id FROM delivery_companies WHERE kind = 'zr' LIMIT 1`)).id);
  await db.query(`UPDATE delivery_companies SET credentials = '{"api_key":"k","tenant":"t"}', active = true WHERE id = $1`, [zr]);
  const o = await newOrder(conf, { confirm: true, companyId: zr });
  const [a, b]: any[] = await Promise.all([call('delivery.send', depot, { ids: [o.id] }), call('delivery.send', depot, { ids: [o.id] })]);
  const sent = [...a.results, ...b.results].filter((r: any) => r.ok);
  assert.equal(sent.length, 1);
});

test('a claim is not created twice for the same reason', async () => {
  const suivi = await as(EMAILS.suivi);
  let o = await one(`SELECT o.id FROM orders o JOIN delivery_companies c ON c.id = o.company_id WHERE c.kind = 'zr' AND o.tracking IS NOT NULL AND o.follow_status = 'out_for_delivery' AND NOT EXISTS (SELECT 1 FROM claims WHERE order_id = o.id) LIMIT 1`);
  if (!o) {
    // the random demo shop has no such parcel this time: make one
    const zr = await one(`SELECT id FROM delivery_companies WHERE kind = 'zr' ORDER BY id LIMIT 1`);
    o = await newOrder(await as(EMAILS.conf), { confirm: true, companyId: Number(zr.id) });
    await db.query(`UPDATE orders SET tracking = 'ZR-AUDIT-CLAIM', follow_status = 'out_for_delivery' WHERE id = $1`, [o.id]);
  }
  const body = { orderId: Number(o.id), reason: 'late', details: 'colis en retard', message: 'Bonjour', channel: 'whatsapp', viaApi: false };
  await call('suivi.claimCreate', suivi, body);
  await assert.rejects(call('suivi.claimCreate', suivi, body), /déjà une réclamation/);
});

// ---------------------------------------------------------------- money
test('a courier without API: its fee (from its tariff) is taken off when the parcel leaves', async () => {
  const conf = await as(EMAILS.conf);
  const suivi = await as(EMAILS.suivi);
  const c = await one(`INSERT INTO delivery_companies (name, kind, active) VALUES ('Coursier manuel test', 'manual', true) RETURNING id`);
  await db.query(`INSERT INTO delivery_fees (company_id, wilaya_id, home, desk) VALUES ($1, 16, 600, 400) ON CONFLICT DO NOTHING`, [c.id]);
  const o = await newOrder(conf, { confirm: true, companyId: Number(c.id) });
  await call('orders.setFollow', suivi, { ids: [o.id], status: 'shipped', tracking: 'MAN-1' });
  assert.equal(Number((await one('SELECT delivery_cost FROM orders WHERE id = $1', [o.id])).delivery_cost), 600);
});

test('a ZR payment counts only the parcels not already received by hand', async () => {
  const zr = Number((await one(`SELECT id FROM delivery_companies WHERE kind = 'zr' LIMIT 1`)).id);
  await db.query(`UPDATE delivery_companies SET credentials = '{"api_key":"k","tenant":"t"}', active = true WHERE id = $1`, [zr]);
  const del = await db.query(`SELECT id, tracking FROM orders WHERE company_id = $1 AND follow_status = 'delivered' AND NOT cashed AND tracking IS NOT NULL ORDER BY id LIMIT 2`, [zr]);
  assert.equal(del.length, 2);
  const admin0 = await as(EMAILS.admin);
  // the first parcel's money already came in by hand
  await call('cash.receive', admin0, { ids: [Number(del[0].id)], into: 'bank' });
  const tracks = del.map((o: any) => o.tracking);
  const server = {
    courier: async (action: string) => {
      if (action === 'track') return [];
      if (action === 'payBalance') return { paid: 0, ready: 0, delivered: 0, notReady: 0 };
      if (action === 'payRequests') return [];
      if (action === 'payments') return [{ extId: 'AUDIT-P1', ref: 'PAY-A1', amount: 7000, status: 'Accepted', done: true, at: new Date().toISOString(), doneAt: new Date().toISOString(), requestId: null, place: 'Hub', details: {} }];
      if (action === 'payLines') return tracks.map((t: string) => ({ tracking: t, customer: 'X', type: 'Livré', amount: 3500, costs: 0, comment: null }));
      throw new Error('unexpected ' + action);
    },
  } as any;
  const admin = await as(EMAILS.admin, server);
  const m0 = await bal(admin, 'main');
  // two runs at once (the job and a click): imported once
  await Promise.allSettled([call('caisse.paySync', admin, { companyId: zr }), call('caisse.paySync', admin, { companyId: zr })]);
  assert.equal(await bal(admin, 'main'), m0 + 3500, 'only the parcel not yet received is counted');
});

test('two transfers at once cannot empty a caisse twice', async () => {
  const admin = await as(EMAILS.admin);
  await call('caisse.add', admin, { caisse: 'bank', kind: 'income', amount: 10_000, note: 'audit' });
  const b = await bal(admin, 'bank');
  const r = await Promise.allSettled([call('caisse.transfer', admin, { from: 'bank', to: 'main', amount: b }), call('caisse.transfer', admin, { from: 'bank', to: 'main', amount: b })]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(await bal(admin, 'bank'), 0);
});

test('paying a supplier takes the money out of a caisse (an employee: his own caisse only)', async () => {
  const depot = await as(EMAILS.depot);
  const admin = await as(EMAILS.admin);
  const own = `u${await idOf(EMAILS.depot)}`;
  const wh = Number((await one('SELECT id FROM warehouses WHERE active ORDER BY is_default DESC, id LIMIT 1')).id);
  const it = await anItem();
  const k0 = await bal(admin, own);
  const p: any = await call('purchases.create', depot, { supplierId: null, warehouseId: wh, lines: [{ variantId: it.variantId, qty: 2, unitCost: 1000 }], paid: 500 });
  assert.equal(await bal(admin, own), k0 - 500);
  await call('purchases.pay', depot, { id: p.id ?? p, paid: 2000 });
  assert.equal(await bal(admin, own), k0 - 2000);
  await assert.rejects(call('purchases.pay', depot, { id: p.id ?? p, paid: 1000, caisse: 'main' }), /votre caisse/);
  // the owner pays from the main caisse
  const m0 = await bal(admin, 'main');
  await call('purchases.pay', admin, { id: p.id ?? p, paid: 1500 });
  assert.equal(await bal(admin, 'main'), m0 + 500, 'paying less back: the difference comes back into the caisse');
});

test('an admin password reset or a deactivation logs the account out everywhere', async () => {
  const admin = await as(EMAILS.admin);
  const id = await idOf(EMAILS.conf2);
  const v0 = Number((await one('SELECT token_version FROM profiles WHERE id = $1', [id])).token_version);
  await call('users.update', admin, { id, password: 'nouveau-mdp-123' });
  assert.equal(Number((await one('SELECT token_version FROM profiles WHERE id = $1', [id])).token_version), v0 + 1);
  await call('users.update', admin, { id, name: 'Rania' });
  assert.equal(Number((await one('SELECT token_version FROM profiles WHERE id = $1', [id])).token_version), v0 + 1, 'a name change does not');
});

// ---------------------------------------------------------------- stock: exchanges
test('an SAV exchange puts back only the exchanged item, and only once', async () => {
  const suivi = await as(EMAILS.suivi);
  const depot = await as(EMAILS.depot);
  const o = await one(`SELECT o.id FROM orders o WHERE o.follow_status = 'delivered' AND NOT o.is_exchange
      AND (SELECT count(*) FROM order_items i WHERE i.order_id = o.id AND i.variant_id IS NOT NULL) >= 2
      AND NOT EXISTS (SELECT 1 FROM complaints c WHERE c.order_id = o.id) LIMIT 1`);
  assert.ok(o, 'a delivered order with two products');
  const t: any = await call('sav.create', suivi, { orderId: Number(o.id), type: 'defect', details: 'un seul article' });
  const g: any = await call('sav.get', suivi, { id: t.id });
  const line = g.order.items.find((i: any) => i.variantId);
  // a double click makes one exchange
  const made = await Promise.allSettled([
    call('sav.exchange', suivi, { id: t.id, kind: 'same', lines: [{ itemId: line.id, qty: 1 }] }),
    call('sav.exchange', suivi, { id: t.id, kind: 'same', lines: [{ itemId: line.id, qty: 1 }] }),
  ]);
  assert.equal(made.filter((x) => x.status === 'fulfilled').length, 1);
  const ex = Number((await one('SELECT exchange_order_id FROM complaints WHERE id = $1', [t.id])).exchange_order_id);
  await db.query(`UPDATE orders SET follow_status = 'delivered', shipped_at = now(), delivered_at = now() WHERE id = $1`, [ex]);
  const moved = async () => Number((await one(`SELECT COALESCE(sum(delta),0)::int AS d FROM stock_movements WHERE reason = 'exchange_in' AND order_id = $1`, [o.id])).d);
  const r: any = await call('depot.scan', depot, { orderId: ex, code: '', mode: 'exchange' });
  assert.equal(r.kind, 'ok', r.why);
  assert.equal(await moved(), 1, 'one article back, not the whole order');
  const again: any = await call('depot.scan', depot, { orderId: ex, code: '', mode: 'exchange' });
  assert.match(again.why, /déjà reçu/);
  assert.equal(await moved(), 1);
});

// ---------------------------------------------------------------- launch review (October 2026)
test('a marketer-only account never sees customers (leads, blocked orders) nor staff emails / phones', async () => {
  const mk = await as(EMAILS.marketer);
  const admin = await as(EMAILS.admin);
  for (const name of ['landing.leads', 'landing.blocked'] as const) {
    const r: any = await call(name, mk, { status: 'all' } as any);
    for (const x of r.rows) {
      assert.equal(x.phone, '•••', name);
      assert.equal(x.customerName, '•••', name);
    }
  }
  const team: any[] = (await call('users.list', mk, {})) as any;
  assert.ok(team.length > 0 && team.every((u) => u.email === '' && u.phone === null));
  assert.ok(((await call('users.list', admin, {})) as any[]).some((u) => u.email.includes('@')));
});

test('an employee cannot sell below the allowed price, nor take a colleague’s credit, nor erase a parcel that left', async () => {
  const conf = await as(EMAILS.conf);
  const suivi = await as(EMAILS.suivi);
  const p = await one(`SELECT p.id, p.price, p.max_discount, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active
                        WHERE p.active AND NOT p.is_service AND p.max_discount IS NOT NULL AND p.price > 2000 ORDER BY p.id LIMIT 1`);
  const line = { productId: Number(p.id), variantId: Number(p.vid), qty: 1 };
  // a unit price far under the catalog is a discount over the maximum
  await assert.rejects(newOrder(conf, { items: [{ ...line, unitPrice: 100 }] }), /Prix trop bas/);
  // within the maximum it goes
  const ok = await newOrder(conf, { items: [{ ...line, unitPrice: Number(p.price) - Number(p.max_discount) }] });
  assert.equal(ok.subtotal, Number(p.price) - Number(p.max_discount));
  // a delivered parcel set « delivered » again by another suivi keeps its first suivi agent
  const d = await one(`SELECT id, follow_agent_id FROM orders WHERE follow_status = 'delivered' AND follow_agent_id IS NOT NULL AND follow_agent_id <> $1 AND NOT cashed LIMIT 1`, [suivi.session.profile.id]);
  if (d) {
    await call('orders.setFollow', suivi, { ids: [Number(d.id)], status: 'delivered' }).catch(() => null);
    assert.equal(Number((await one('SELECT follow_agent_id FROM orders WHERE id = $1', [d.id])).follow_agent_id), Number(d.follow_agent_id));
  }
  // the depot cannot mark « returned » a parcel that is out for delivery (its cash would stop being owed)
  const depot = await as(EMAILS.depot);
  const ofd = await one(`SELECT id FROM orders WHERE follow_status = 'out_for_delivery' LIMIT 1`);
  if (ofd) await assert.rejects(call('orders.setFollow', depot, { ids: [Number(ofd.id)], status: 'returned' }), /pas en retour/);
  // a free « exchange » cannot be typed as a normal order
  await assert.rejects(newOrder(conf, { isExchange: true, items: [{ ...line, unitPrice: 0 }] }), /SAV/);
});
