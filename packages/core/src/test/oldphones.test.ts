// Customers' old numbers (the owner's rule, 25 Nov 2026): 3 days after an order is over — delivered, cancelled, come
// back — only the seller and the admins still see the customer's number, everywhere (lists, the order's page, a search,
// a number written in a note); an order still going or an open SAV ticket keeps it. The others see the finished orders
// of the last 30 days in their lists; older ones only by a search of 5 digits — their numbers (menu, reports, totals) stay
// whole. A form saved without the hidden number never wipes it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, pgliteTenancy, seedBase, shopCtx, shopStatus } from '../index';
import { confirmSignup, loadShop, startSignup } from '../platform';
import { isLookupCode, lookupReady } from '@pilotix/shared';
import { HIDDEN_IN_TEXT } from '../modules/oldphones';

const PW = 'Agent-Password-1';
let phoneN = 0;
const tph = () => `077${String(++phoneN).padStart(7, '0')}`;

async function store() {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { email: 'owner@boutique.dz', password: 'Owner-Password-1', name: 'Amine' });
  await migrateAll(t);
  const mail: any = await startSignup(t, { name: 'Boss', email: 'boss@phones.dz', phone: tph(), password: PW, storeName: 'Store Old Phones', language: 'fr', terms: true }, null);
  const shopId = ((await confirmSignup(t, mail.token)) as any).shop.id as number;
  const as = async (email: string): Promise<Ctx> => {
    const s = (await loadShop(t, { id: shopId }))!;
    const db = t.shop(s.schema);
    return { db, session: await login(db, email, PW), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t };
  };
  const boss = await as('boss@phones.dz');
  const pid = Number((await boss.db.query(`INSERT INTO products (name, sku, price) VALUES ('Lampe', 'LAMPE', 5000) RETURNING id`))[0].id);
  const person = async (name: string, email: string, roles: string[]) => {
    const u: any = await call('users.create', boss, { name, email, phone: tph(), password: PW, roles });
    return { id: Number(u.id), ctx: await as(email) };
  };
  const A = await person('Agent A', 'a@phones.dz', ['confirmation']);
  const D = await person('Dépôt', 'd@phones.dz', ['depot']);
  let n = 0;
  /** An order of agent A, over `days` days ago (delivered, cancelled or back), or still going (null). */
  const order = async (how: 'delivered' | 'cancelled' | 'returned' | null, days = 0, phone = `0662${String(++n).padStart(6, '0')}`) => {
    const o: any = await call('orders.create', boss, { customerName: `Client ${n}`, phone, wilayaId: 16, commune: 'Kouba', address: 'Rue', items: [{ productId: pid, variantId: null, qty: 1 }] });
    const id = Number(o.id);
    await boss.db.query('UPDATE orders SET agent_id = $1 WHERE id = $2', [A.id, id]);
    if (how) {
      const at = new Date(Date.now() - days * 86_400_000).toISOString();
      // the order's status changes, at that time (its last change is when it was over)
      await boss.db.query('DELETE FROM order_events WHERE order_id = $1', [id]);
      if (how === 'delivered') await boss.db.query(`UPDATE orders SET conf_status = 'confirmed', follow_status = 'delivered', delivered_at = $2, updated_at = $2 WHERE id = $1`, [id, at]);
      if (how === 'returned') await boss.db.query(`UPDATE orders SET conf_status = 'confirmed', follow_status = 'returned', returning_at = $2, returned_at = $2, updated_at = $2 WHERE id = $1`, [id, at]);
      if (how === 'cancelled') {
        await boss.db.query(`UPDATE orders SET conf_status = 'cancelled', updated_at = $2 WHERE id = $1`, [id, at]);
        await boss.db.query(`INSERT INTO order_events (order_id, at, kind, from_value, to_value) VALUES ($1, $2, 'conf_status', 'new', 'cancelled')`, [id, at]);
      }
    }
    return { id, phone };
  };
  return { boss, A, D, order };
}

const phoneOf = async (ctx: Ctx, id: number) => ((await call('orders.get', ctx, { id })) as any) as { phone: string; phone2: string | null; phoneHidden?: boolean; internalNote: string | null };
const listIds = async (ctx: Ctx, input: object = {}) => (((await call('orders.list', ctx, input)) as any).rows as { id: number; phone: string }[]);

test('3 days after an order is over, only the seller and the admins see its number', async () => {
  const { boss, A, D, order } = await store();
  const old = await order('delivered', 5);
  const fresh = await order('delivered', 1);
  const cancelled = await order('cancelled', 4);
  const back = await order('returned', 4);
  const going = await order(null);
  for (const ctx of [A.ctx, D.ctx]) {
    for (const o of [old, cancelled, back]) {
      const g = await phoneOf(ctx, o.id);
      assert.equal(g.phone, '', `hidden from a non seller: ${o.phone}`);
      assert.equal(g.phoneHidden, true);
    }
    assert.equal((await phoneOf(ctx, fresh.id)).phone, fresh.phone);
    assert.equal((await phoneOf(ctx, going.id)).phone, going.phone);
  }
  // the seller (the shop's owner, its admin): every number (a seller cannot add another seller: users.ts)
  const g = await phoneOf(boss, old.id);
  assert.equal(g.phone, old.phone);
  assert.equal(g.phoneHidden, undefined);
  // in the lists too
  const rows = await listIds(A.ctx);
  assert.equal(rows.find((r) => r.id === old.id)?.phone, '');
  assert.equal(rows.find((r) => r.id === fresh.id)?.phone, fresh.phone);
});

test('a customer with an order still going, or an open SAV ticket, keeps his number', async () => {
  const { boss, A, order } = await store();
  const old = await order('delivered', 6);
  assert.equal((await phoneOf(A.ctx, old.id)).phone, '');
  // a SAV ticket open on that order: the number shows again, while it is open
  await boss.db.query(`INSERT INTO complaints (ref, order_id, customer_name, phone, type, wish, status) VALUES ('SAV-T1', $1, 'Client', $2, 'broken', 'exchange', 'open')`, [old.id, old.phone]);
  assert.equal((await phoneOf(A.ctx, old.id)).phone, old.phone);
  await boss.db.query(`UPDATE complaints SET status = 'closed' WHERE ref = 'SAV-T1'`);
  assert.equal((await phoneOf(A.ctx, old.id)).phone, '');
  // the same customer orders again: his number is needed again, on every one of his orders
  await order(null, 0, old.phone);
  assert.equal((await phoneOf(A.ctx, old.id)).phone, old.phone);
});

test('a hidden number written in a note is hidden too, and a form saved without it keeps it', async () => {
  const { boss, A, order } = await store();
  const old = await order('delivered', 5);
  await boss.db.query('UPDATE orders SET internal_note = $2 WHERE id = $1', [old.id, `Rappeler le ${old.phone.replace(/(\d{4})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4')} demain`]);
  const g = await phoneOf(A.ctx, old.id);
  assert.equal(g.internalNote, `Rappeler le ${HIDDEN_IN_TEXT} demain`);
  assert.equal((await phoneOf(boss, old.id)).internalNote?.includes(old.phone.slice(0, 4)), true);
  // the agent saves the order with its number left empty (the screen had none): the order keeps it
  await call('orders.update', A.ctx, { id: old.id, address: 'Rue 2', phone2: null });
  const row = (await boss.db.query('SELECT phone, address FROM orders WHERE id = $1', [old.id]))[0];
  assert.equal(row.phone, old.phone);
  assert.equal(row.address, 'Rue 2');
});

test('finished orders: 30 days in the lists, older ones only by a search of 5 digits', async () => {
  const { boss, A, D, order } = await store();
  const recent = await order('delivered', 10);
  const older = await order('delivered', 40);
  const oldCancel = await order('cancelled', 45);
  for (const ctx of [A.ctx, D.ctx]) {
    const ids = (await listIds(ctx, { follow: ['delivered'] })).map((r) => r.id);
    assert.ok(ids.includes(recent.id));
    assert.ok(!ids.includes(older.id), 'a delivery of 40 days ago is out of the list');
    assert.ok(!(await listIds(ctx)).some((r) => r.id === oldCancel.id));
    // 5 digits of its phone find it, its number hidden
    const found = await listIds(ctx, { q: older.phone.slice(-6) });
    assert.deepEqual(found.map((r) => [r.id, r.phone]), [[older.id, '']]);
    // 4 digits are not a search of an old order
    assert.ok(!(await listIds(ctx, { q: older.phone.slice(-4) })).some((r) => r.id === older.id));
  }
  // their numbers stay whole (owner, 25 Nov 2026): the menu counts both, the list says how many in all
  const counts: any = await call('orders.counts', A.ctx, {});
  assert.equal(counts.lists.delivered, 2);
  const page: any = await call('orders.list', A.ctx, { follow: ['delivered'], pageSize: 1 });
  assert.deepEqual([page.total, page.totalAll], [1, 2]);
  // the seller's lists have no « totalAll »: they show everything
  assert.equal(((await call('orders.list', boss, { follow: ['delivered'], pageSize: 1 })) as any).totalAll, undefined);
  // the seller sees all of them
  const all = (await listIds(boss, { follow: ['delivered'] })).map((r) => r.id);
  assert.ok(all.includes(older.id) && all.includes(recent.id));
});

test('a whole reference or tracking code finds an older order too, typed exactly; a name never does', async () => {
  const { A, D, order } = await store();
  const older = await order('delivered', 40);
  // the real shop's references have 4 digits and ZR's codes 2 (owner's choice « A », 25 Nov 2026)
  await A.ctx.db.query(`UPDATE orders SET ref = 'PX1374', tracking = '43-PCLONZDMHK-ZR' WHERE id = $1`, [older.id]);
  for (const ctx of [A.ctx, D.ctx]) {
    for (const q of ['PX1374', 'px1374', '43-PCLONZDMHK-ZR', '43-pclonzdmhk-zr']) {
      const found = await listIds(ctx, { q });
      assert.deepEqual(found.map((r) => [r.id, r.phone]), [[older.id, '']], `found by ${q}, its number hidden`);
    }
    // a piece of a code is not the code, and a name opens nothing older than 30 days
    for (const q of ['PX137', 'PCLONZDMHK', '43-PCLONZDMHK', 'Client']) assert.ok(!(await listIds(ctx, { q })).some((r) => r.id === older.id), q);
  }
});

test('the search rule shared by the screens and the server', () => {
  for (const q of ['05551', '0555 12 34 56', 'PX1374', 'px13', '43-PCLONZDMHK-ZR', 'PXT1266412']) assert.ok(lookupReady(q), q);
  for (const q of ['0555', 'Fatima', 'PX1', 'yal-LBWCBA', 'Ali 1234', '']) assert.ok(!lookupReady(q), q);
  assert.equal(isLookupCode('0555123456'), false, 'a phone is digits, not a code');
});
