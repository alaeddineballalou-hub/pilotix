// Pilotix Doctor (stats.doctor): who may open it, the shape of its answer, and every check — each one on its own
// problem, each one quiet when all is well, and the borders (just under / just over a limit, ignored rows).
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import { DoctorItem, doctorScore, doctorSort, effectiveFeatures, FEATURE_KEYS, featureOn, routeAllowed, ShopDoctorReport } from '@pilotix/shared';
import { call, Ctx, Db, hashPassword, login, migrate, seedBase } from '../index';
import { pgliteDb } from '../pglite';
import { EMAILS, setup } from './harness';

const H = 3_600_000;
const D = 24 * H;
// a Tuesday, 13:00 in Algiers
const NOW = Date.parse('2026-10-20T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const SHOP_IDS = ['stockOut', 'stockSoon', 'notCalled', 'lateCallbacks', 'fakeOrders', 'weakAgents', 'notShipped', 'stuckParcels', 'openAlerts', 'badWilayas', 'cashLate'];
const AREAS = ['stock', 'confirmation', 'team', 'depot', 'delivery', 'sales', 'cash'];
const UNITS = ['n', 'pct', 'days', 'hours', 'min', 'da', 'ms', 'mb', 'text'];

// ---------------------------------------------------------------- a small shop built order by order
interface Shop {
  db: Db;
  admin: Ctx;
  vendeur: Ctx;
  product: number;
  variant: (title: string, stock: number, opts?: { active?: boolean; service?: boolean; warehouse2?: number }) => Promise<{ v: number; p: number }>;
  agent: (name: string) => Promise<number>;
  order: (o: Record<string, unknown> & { items?: { v: number; p: number; qty: number }[] }) => Promise<number>;
  doctor: (as?: Ctx) => Promise<ShopDoctorReport>;
}

let seq = 0;
async function shop(): Promise<Shop> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const db = pgliteDb(pg as any);
  await migrate(db, async (sql) => {
    await pg.exec(sql);
  });
  await seedBase(db, { email: 'boss@shop.dz', password: 'Boss-Password-1', name: 'Boss' });
  await db.query(`INSERT INTO profiles (name, email, password_hash, roles) VALUES ('Vendeur', 'vend@shop.dz', $1, '{vendeur}')`, [await hashPassword('Vend-Password-1')]);
  const wh = Number((await db.query('SELECT id FROM warehouses LIMIT 1'))[0].id);
  const ctx = async (email: string, pw: string): Promise<Ctx> => ({ db, session: await login(db, email, pw), now: () => NOW, emit: () => {} });
  const product = Number((await db.query(`INSERT INTO products (name, sku, price) VALUES ('Poussette', 'POUS', 9900) RETURNING id`))[0].id);
  return {
    db,
    product,
    admin: await ctx('boss@shop.dz', 'Boss-Password-1'),
    vendeur: await ctx('vend@shop.dz', 'Vend-Password-1'),
    async variant(title, stock, opts = {}) {
      let p = product;
      if (opts.active === false || opts.service) {
        p = Number((await db.query(`INSERT INTO products (name, sku, price, active, is_service) VALUES ($1, $2, 100, $3, $4) RETURNING id`, [`P ${title}`, `P-${++seq}`, opts.active !== false, !!opts.service]))[0].id);
      }
      const v = Number((await db.query(`INSERT INTO product_variants (product_id, title, sku) VALUES ($1, $2, $3) RETURNING id`, [p, title, `V-${++seq}`]))[0].id);
      await db.query(`INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, $2, $3)`, [v, wh, stock]);
      if (opts.warehouse2) {
        const w2 = Number((await db.query(`INSERT INTO warehouses (name, wilaya_id) VALUES ('Oran', 31) RETURNING id`))[0].id);
        await db.query(`INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, $2, $3)`, [v, w2, opts.warehouse2]);
      }
      return { v, p };
    },
    async agent(name) {
      return Number((await db.query(`INSERT INTO profiles (name, email, password_hash, roles) VALUES ($1, $2, 'x', '{confirmation}') RETURNING id`, [name, `a${++seq}@shop.dz`]))[0].id);
    },
    async order(o) {
      const n = ++seq;
      const phone = `05${String(n).padStart(8, '0')}`;
      const cust = Number((await db.query(`INSERT INTO customers (phone, name) VALUES ($1, 'Client') RETURNING id`, [phone]))[0].id);
      const { items, ...cols } = o;
      const row: Record<string, unknown> = { ref: `T${n}`, customer_id: cust, customer_name: 'Client', phone, wilaya_id: 16, created_at: ago(30 * D), conf_status: 'new', total: 5000, ...cols };
      const keys = Object.keys(row);
      const id = Number((await db.query(`INSERT INTO orders (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, keys.map((k) => row[k])))[0].id);
      for (const it of items ?? []) await db.query(`INSERT INTO order_items (order_id, product_id, variant_id, name, qty, unit_price) VALUES ($1,$2,$3,'Poussette',$4,5000)`, [id, it.p, it.v, it.qty]);
      return id;
    },
    doctor: (as) => call('stats.doctor', as ?? (undefined as any), {}) as Promise<ShopDoctorReport>,
  };
}
const many = async (n: number, fn: (i: number) => Promise<unknown>) => {
  for (let i = 0; i < n; i++) await fn(i);
};
const find = (r: ShopDoctorReport, id: string) => r.items.find((i) => i.id === id);
const level = (r: ShopDoctorReport, ...ids: string[]) => ids.map((id) => r.items.find((i) => i.id === id)?.level).find(Boolean);

/** What every answer must respect, whatever the data. `full`: the whole shop (admin / vendeur) — every check answers. */
function wellFormed(r: ShopDoctorReport, full = true) {
  assert.ok(!isNaN(Date.parse(r.checkedAt)));
  assert.equal(r.score, doctorScore(r.items), 'score = the items');
  assert.ok(r.score >= 5 && r.score <= 100);
  assert.deepEqual(r.items, doctorSort([...r.items]), 'worst first');
  const ids = r.items.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'one item per check');
  // each check answers exactly once (some under two names: confRate/confRateDrop, returns/returnsUp, ordersDrop/ordersOk)
  if (full) for (const id of SHOP_IDS) assert.equal(ids.filter((x) => x === id).length, 1, id);
  if (full) {
    assert.equal(ids.filter((x) => x === 'confRate' || x === 'confRateDrop').length, 1);
    assert.equal(ids.filter((x) => x === 'returns' || x === 'returnsUp').length, 1);
    assert.equal(ids.filter((x) => x === 'ordersDrop' || x === 'ordersOk').length, 1);
    assert.equal(r.items.length, SHOP_IDS.length + 3);
    assert.deepEqual(r.scope, { whole: true, mine: false });
  }
  for (const i of r.items) {
    assert.ok(['bad', 'warn', 'ok', 'info'].includes(i.level), i.id);
    assert.ok(AREAS.includes(i.area), `${i.id}: area ${i.area}`);
    if (i.href) assert.match(i.href, /^#\/[a-z]/);
    for (const v of Object.values(i.params ?? {})) assert.ok(typeof v === 'string' || Number.isFinite(v), `${i.id}: param ${v}`);
    for (const l of i.list ?? []) {
      assert.ok(UNITS.includes(l.unit), `${i.id}: unit ${l.unit}`);
      assert.ok(Number.isFinite(l.n), `${i.id}: ${l.label} ${l.n}`);
      assert.ok(l.label || l.wilaya, `${i.id}: a line has a name`);
    }
    if (i.level === 'bad' || i.level === 'warn') assert.ok(i.href || i.list?.length, `${i.id}: a problem says where to look`);
  }
}

// ---------------------------------------------------------------- who
describe('who may open Pilotix Doctor', () => {
  let as: (email: string) => Promise<Ctx>;
  before(async () => {
    ({ as } = await setup(400));
  });

  test('admin and vendeur: yes, on the demo shop, with a well-formed answer', async () => {
    for (const e of [EMAILS.admin, EMAILS.vendeur]) {
      const r = (await call('stats.doctor', await as(e), {})) as ShopDoctorReport;
      wellFormed(r);
    }
  });

  test('everybody else gets the part that is theirs', async () => {
    const ids = async (e: string) => {
      const r = (await call('stats.doctor', await as(e), {})) as ShopDoctorReport;
      wellFormed(r, false);
      return { r, ids: r.items.map((i) => i.id.replace(/^confRateDrop$/, 'confRate').replace(/^returnsUp$/, 'returns').replace(/^ordersOk$/, 'ordersDrop')).sort() };
    };
    const sorted = (a: string[]) => [...a].sort();
    // a confirmation agent: their own orders
    let x = await ids(EMAILS.conf);
    assert.deepEqual(x.ids, sorted(['notCalled', 'lateCallbacks', 'confRate', 'meVsTeam']));
    assert.deepEqual(x.r.scope, { whole: false, mine: true });
    // a suivi agent: their own parcels
    x = await ids(EMAILS.suivi);
    assert.deepEqual(x.ids, sorted(['stuckParcels', 'openAlerts', 'returns']));
    assert.deepEqual(x.r.scope, { whole: false, mine: true });
    // dépôt: stock and orders to ship
    x = await ids(EMAILS.depot);
    assert.deepEqual(x.ids, sorted(['stockOut', 'stockSoon', 'notShipped']));
    assert.deepEqual(x.r.scope, { whole: false, mine: false });
    // an agent manager: the team's confirmation (their area by default)
    x = await ids(EMAILS.manager);
    assert.deepEqual(x.ids, sorted(['notCalled', 'lateCallbacks', 'confRate', 'fakeOrders', 'weakAgents']));
    assert.deepEqual(x.r.scope, { whole: false, mine: false });
    // marketer: orders dropping, fake orders
    x = await ids(EMAILS.marketer);
    assert.deepEqual(x.ids, sorted(['ordersDrop', 'fakeOrders']));
    // livreur: nothing to check, nothing to worry about
    x = await ids(EMAILS.livreur);
    assert.deepEqual(x.ids, []);
    assert.equal(x.r.score, 100);
  });

  test('money only for the administrator', async () => {
    const a = (await call('stats.doctor', await as(EMAILS.admin), {})) as ShopDoctorReport;
    const v = (await call('stats.doctor', await as(EMAILS.vendeur), {})) as ShopDoctorReport;
    for (const i of v.items) assert.equal(i.params?.amount, undefined, `vendeur sees no amount (${i.id})`);
    const cash = find(a, 'cashLate')!;
    if (cash.level !== 'ok') assert.ok(typeof cash.params?.amount === 'number' && cash.params.amount > 0);
  });

  test('a menu in the plans: on with the dashboard, can be turned off alone', () => {
    assert.ok(FEATURE_KEYS.includes('dashboard/doctor'));
    assert.ok(routeAllowed(['dashboard'], 'dashboard', 'doctor'));
    assert.ok(!routeAllowed(['dashboard', '-dashboard/doctor'], 'dashboard', 'doctor'));
    assert.ok(routeAllowed(['dashboard', '-dashboard/doctor'], 'dashboard', 'overview'));
    assert.ok(!featureOn(effectiveFeatures(['*'], [], ['dashboard/doctor']), 'dashboard/doctor'));
    assert.ok(featureOn(effectiveFeatures(['dashboard'], ['dashboard/doctor'], []), 'dashboard/doctor'));
  });
});

// ---------------------------------------------------------------- an empty shop
test('a new shop with nothing: no problem, nothing to judge, score 100', async () => {
  const s = await shop();
  const r = await s.doctor(s.admin);
  wellFormed(r);
  assert.equal(r.score, 100);
  assert.deepEqual(r.items.filter((i) => i.level === 'bad' || i.level === 'warn'), []);
  for (const id of ['confRate', 'returns', 'ordersDrop', 'weakAgents']) assert.equal(find(r, id)?.level, 'info', id);
});

// ---------------------------------------------------------------- each problem
describe('every problem is seen', () => {
  let s: Shop;
  let r: ShopDoctorReport;
  before(async () => {
    s = await shop();
    const A = await s.variant('Bleu', 1); // 4 needed, 1 on the shelves
    const B = await s.variant('Rouge', 10); // 5 a day → 2 days
    const C = await s.variant('Vert', 60); // 2 a day → 30 days: fine
    // stock out: 2 orders waiting for stock + 1 confirmed to prepare
    // (orders not about confirmation are made 20 days ago: they stay out of this week's and last week's rates)
    await s.order({ conf_status: 'no_stock', created_at: ago(20 * D), items: [{ ...A, qty: 2 }] });
    await s.order({ conf_status: 'confirmed', follow_status: 'prepared', confirmed_at: ago(H), created_at: ago(20 * D), items: [{ ...A, qty: 2 }] });
    // running out: 35 Rouge and 14 Vert confirmed and shipped in the last 7 days
    await many(7, (i) => s.order({ conf_status: 'confirmed', follow_status: 'delivered', confirmed_at: ago((i + 1) * 20 * H), created_at: ago(20 * D), delivered_at: ago(i * 20 * H + H), cashed: true, items: [{ ...B, qty: 5 }, { ...C, qty: 2 }] }));
    // not called: 25 new orders, the oldest 30 h ago (one only 1 h ago: not late)
    await many(25, (i) => s.order({ conf_status: 'new', created_at: ago(3 * H + i * H) }));
    await s.order({ conf_status: 'new', created_at: ago(H) });
    // late callbacks
    await many(3, () => s.order({ conf_status: 'callback', next_call_at: ago(2 * H), created_at: ago(D) }));
    // confirmation drop + weak agent: the week before 30 orders 80 % confirmed; this week 40, agent B confirms 6 of 20
    const a1 = await s.agent('Samira');
    const a2 = await s.agent('Rania');
    await many(30, (i) => s.order({ agent_id: a1, conf_status: i < 24 ? 'confirmed' : 'cancelled', follow_status: i < 24 ? 'delivered' : null, created_at: ago(10 * D), confirmed_at: ago(10 * D), delivered_at: ago(9 * D), cashed: true }));
    await many(20, (i) => s.order({ agent_id: a1, conf_status: i < 17 ? 'confirmed' : 'cancelled', follow_status: i < 17 ? 'delivered' : null, created_at: ago(3 * D), confirmed_at: ago(3 * D), delivered_at: ago(2 * D), cashed: true }));
    await many(20, (i) => s.order({ agent_id: a2, conf_status: i < 6 ? 'confirmed' : i < 14 ? 'cancelled' : 'fake', follow_status: i < 6 ? 'delivered' : null, created_at: ago(3 * D), confirmed_at: ago(3 * D), delivered_at: ago(2 * D), cashed: true }));
    // confirmed 3 days ago, still in the depot
    await many(4, () => s.order({ conf_status: 'confirmed', follow_status: 'to_prepare', confirmed_at: ago(3 * D), created_at: ago(20 * D) }));
    // stuck at the courier: shipped 10 days ago, no news for 5 days (a recent one is not stuck)
    await many(2, () => s.order({ conf_status: 'confirmed', follow_status: 'shipped', confirmed_at: ago(11 * D), shipped_at: ago(10 * D), ext_status_at: ago(5 * D) }));
    await s.order({ conf_status: 'confirmed', follow_status: 'shipped', confirmed_at: ago(11 * D), shipped_at: ago(10 * D), ext_status_at: ago(D) });
    // open alerts (a handled one does not count)
    await many(3, () => s.order({ conf_status: 'confirmed', follow_status: 'alert', shipped_at: ago(3 * D), ext_status_at: ago(H) }));
    await s.order({ conf_status: 'confirmed', follow_status: 'alert', sub_status: 'alert_traitee', shipped_at: ago(3 * D), ext_status_at: ago(H) });
    // returns: Oran (31) sends 12 of 15 back
    await many(15, (i) => s.order({ wilaya_id: 31, conf_status: 'confirmed', follow_status: i < 12 ? 'returned' : 'delivered', shipped_at: ago(6 * D), returning_at: i < 12 ? ago(4 * D) : null, returned_at: i < 12 ? ago(3 * D) : null, delivered_at: i < 12 ? null : ago(4 * D), cashed: true }));
    // money: delivered 12 days ago, not paid
    await many(2, () => s.order({ conf_status: 'confirmed', follow_status: 'delivered', delivered_at: ago(12 * D), total: 7000 }));
    r = await s.doctor(s.admin);
  });

  test('the answer is well formed and the score is low', () => {
    wellFormed(r);
    assert.ok(r.score <= 40, `score ${r.score}`);
    assert.equal(r.items[0].level, 'bad');
  });

  test('stock missing for confirmed orders (no_stock + prepared count, shelves do not)', () => {
    const i = find(r, 'stockOut')!;
    assert.equal(i.level, 'bad');
    assert.deepEqual(i.list, [{ label: 'Poussette · Bleu', n: 3, unit: 'n' }]);
    assert.equal(i.params?.orders, 3);
  });

  test('stock running out in 2 days; the one that lasts 30 days is not listed', () => {
    const i = find(r, 'stockSoon')!;
    assert.equal(i.level, 'bad');
    assert.equal(i.list?.[0].label, 'Poussette · Rouge');
    assert.equal(i.list?.[0].n, 2);
    assert.ok(!i.list?.some((l) => l.label.includes('Vert')));
  });

  test('new orders not called: 25 (≥ 20 → urgent), the oldest 27 h; the one of 1 h is not late', () => {
    const i = find(r, 'notCalled')!;
    assert.equal(i.level, 'bad');
    assert.equal(i.params?.count, 25);
    assert.equal(i.params?.hours, 27);
  });

  test('late callbacks', () => {
    assert.equal(find(r, 'lateCallbacks')?.level, 'warn');
    assert.equal(find(r, 'lateCallbacks')?.params?.count, 3);
  });

  test('confirmation rate dropping: 80 % → 57.5 %', () => {
    const i = find(r, 'confRateDrop')!;
    assert.equal(i.level, 'bad');
    assert.equal(i.params?.before, 80);
    assert.equal(i.params?.now, 57.5);
  });

  test('fake orders: 6 of the orders of the week', () => {
    const i = find(r, 'fakeOrders')!;
    assert.ok(i.level === 'warn' || i.level === 'bad');
    assert.equal(i.params?.count, 6);
  });

  test('the agent far below the team is named, the good one is not', () => {
    const i = find(r, 'weakAgents')!;
    assert.equal(i.level, 'warn');
    assert.deepEqual(i.list?.map((l) => l.label), ['Rania']);
    assert.equal(i.list?.[0].n, 30);
  });

  test('confirmed but not shipped after 2 days', () => {
    const i = find(r, 'notShipped')!;
    assert.equal(i.level, 'warn');
    assert.equal(i.params?.count, 4);
    assert.equal(i.params?.days, 3);
  });

  test('parcels stuck at the courier (recent news = not stuck)', () => {
    assert.equal(find(r, 'stuckParcels')?.params?.count, 2);
  });

  test('open alerts (handled ones do not count)', () => {
    assert.equal(find(r, 'openAlerts')?.params?.count, 3);
  });

  test('a wilaya that sends parcels back, and the returns rate', () => {
    const w = find(r, 'badWilayas')!;
    assert.equal(w.level, 'bad');
    assert.deepEqual(w.list, [{ label: '', wilaya: 31, n: 80, unit: 'pct' }]);
  });

  test('delivered, not paid after 10 days, with the amount (admin)', () => {
    const i = find(r, 'cashLate')!;
    assert.equal(i.level, 'warn');
    assert.equal(i.params?.count, 2);
    assert.equal(i.params?.amount, 14000);
  });

  test('the vendeur sees the same problems, without the amount', async () => {
    const v = await s.doctor(s.vendeur);
    assert.deepEqual(v.items.map((i) => [i.id, i.level]), r.items.map((i) => [i.id, i.level]));
    assert.equal(find(v, 'cashLate')?.params?.amount, undefined);
  });
});

// ---------------------------------------------------------------- a healthy shop
test('a healthy shop: every check says OK', async () => {
  const s = await shop();
  const V = await s.variant('Bleu', 500);
  const a1 = await s.agent('Samira');
  const a2 = await s.agent('Rania');
  // 14 days of steady orders, 10 a day, 80 % confirmed, delivered and paid
  for (let d = 0; d < 14; d++)
    await many(10, (i) =>
      s.order({
        agent_id: i % 2 ? a1 : a2,
        conf_status: i < 8 ? 'confirmed' : 'cancelled',
        follow_status: i < 8 ? 'delivered' : null,
        created_at: ago(d * D + 13 * H + (i + 1) * 60_000),
        confirmed_at: i < 8 ? ago(d * D + 12 * H) : null,
        shipped_at: i < 8 ? ago(d * D + 10 * H) : null,
        delivered_at: i < 8 ? ago(d * D + 2 * H) : null,
        cashed: true,
        items: [{ ...V, qty: 1 }],
      }),
    );
  // an order just in, being called
  await s.order({ conf_status: 'new', created_at: ago(30 * 60_000) });
  const r = await s.doctor(s.admin);
  wellFormed(r);
  const open = r.items.filter((i) => i.level !== 'ok');
  assert.deepEqual(open.map((i) => `${i.id}:${i.level}`), []);
  assert.equal(r.score, 100);
  assert.equal(find(r, 'ordersOk')?.params?.avg, 10);
});

// ---------------------------------------------------------------- each person's own score
test('one agent works well, another does not: each sees their own score; the suivi agent only their parcels', async () => {
  const s = await shop();
  const mk = async (name: string, roles: string) => {
    const email = `${name.toLowerCase()}@shop.dz`;
    const id = Number((await s.db.query(`INSERT INTO profiles (name, email, password_hash, roles) VALUES ($1, $2, $3, $4) RETURNING id`, [name, email, await hashPassword('Agent-Password-1'), `{${roles}}`]))[0].id);
    return { id, ctx: { db: s.db, session: await login(s.db, email, 'Agent-Password-1'), now: () => NOW, emit: () => {} } as Ctx };
  };
  const good = await mk('Samira', 'confirmation');
  const late = await mk('Rania', 'confirmation');
  const nadia = await mk('Nadia', 'suivi');
  const karim = await mk('Karim', 'suivi');
  // Samira: 25 orders this week, 22 confirmed, all called on time
  await many(25, (i) => s.order({ agent_id: good.id, conf_status: i < 22 ? 'confirmed' : 'cancelled', created_at: ago(2 * D), confirmed_at: ago(2 * D) }));
  // Rania: 25 orders, 8 confirmed, 12 new orders not called for 5 h, 4 late callbacks
  await many(25, (i) => s.order({ agent_id: late.id, conf_status: i < 8 ? 'confirmed' : 'cancelled', created_at: ago(2 * D), confirmed_at: ago(2 * D) }));
  await many(12, () => s.order({ agent_id: late.id, conf_status: 'new', created_at: ago(5 * H) }));
  await many(4, () => s.order({ agent_id: late.id, conf_status: 'callback', next_call_at: ago(3 * H), created_at: ago(D) }));
  // Nadia's parcels are fine; Karim has 3 stuck and 2 open alerts
  await many(3, () => s.order({ follow_agent_id: nadia.id, conf_status: 'confirmed', follow_status: 'shipped', shipped_at: ago(2 * D), ext_status_at: ago(H) }));
  await many(3, () => s.order({ follow_agent_id: karim.id, conf_status: 'confirmed', follow_status: 'shipped', shipped_at: ago(10 * D), ext_status_at: ago(5 * D) }));
  await many(2, () => s.order({ follow_agent_id: karim.id, conf_status: 'confirmed', follow_status: 'alert', shipped_at: ago(3 * D) }));

  const sam = (await call('stats.doctor', good.ctx, {})) as ShopDoctorReport;
  const ran = (await call('stats.doctor', late.ctx, {})) as ShopDoctorReport;
  assert.deepEqual(sam.items.filter((i) => i.level === 'bad' || i.level === 'warn').map((i) => i.id), [], 'Samira did everything well');
  assert.equal(sam.score, 100);
  assert.equal(sam.items.find((i) => i.id === 'meVsTeam')?.params?.me, 88);
  assert.equal(ran.items.find((i) => i.id === 'notCalled')?.params?.count, 12);
  assert.equal(ran.items.find((i) => i.id === 'lateCallbacks')?.params?.count, 4);
  assert.equal(ran.items.find((i) => i.id === 'meVsTeam')?.level, 'bad', 'Rania is far below the team (32 % vs 60 %)');
  assert.ok(ran.score < sam.score);

  const nad = (await call('stats.doctor', nadia.ctx, {})) as ShopDoctorReport;
  const kar = (await call('stats.doctor', karim.ctx, {})) as ShopDoctorReport;
  assert.equal(nad.score, 100, 'Nadia sees only her own parcels');
  assert.equal(kar.items.find((i) => i.id === 'stuckParcels')?.params?.count, 3);
  assert.equal(kar.items.find((i) => i.id === 'openAlerts')?.params?.count, 2);
  assert.ok(kar.score < 100);

  // the administrator sees the whole shop: everybody's problems
  const all = await s.doctor(s.admin);
  assert.equal(all.items.find((i) => i.id === 'notCalled')?.params?.count, 12);
  assert.equal(all.items.find((i) => i.id === 'stuckParcels')?.params?.count, 3);
  assert.equal(all.items.find((i) => i.id === 'weakAgents')?.list?.[0]?.label, 'Rania');
});

// ---------------------------------------------------------------- borders
describe('borders and rows to ignore', () => {
  test('notCalled: exactly 2 h is not late yet; 19 is "watch", 20 is "urgent"; a called order (attempts) is not "not called"', async () => {
    const s = await shop();
    await s.order({ conf_status: 'new', created_at: ago(2 * H - 60_000) });
    await s.order({ conf_status: 'new', attempts: 1, created_at: ago(5 * H) });
    await s.order({ conf_status: 'to_check', created_at: ago(3 * H) });
    let r = await s.doctor(s.admin);
    assert.equal(find(r, 'notCalled')?.params?.count, 1);
    assert.equal(level(r, 'notCalled'), 'warn');
    await many(18, () => s.order({ conf_status: 'new', created_at: ago(3 * H) }));
    r = await s.doctor(s.admin);
    assert.equal(find(r, 'notCalled')?.params?.count, 19);
    assert.equal(level(r, 'notCalled'), 'warn');
    await s.order({ conf_status: 'new', created_at: ago(3 * H) });
    r = await s.doctor(s.admin);
    assert.equal(level(r, 'notCalled'), 'bad');
  });

  test('notCalled: one order waiting 24 h is urgent on its own', async () => {
    const s = await shop();
    await s.order({ conf_status: 'new', created_at: ago(25 * H) });
    assert.equal(level(await s.doctor(s.admin), 'notCalled'), 'bad');
  });

  test('callbacks less than 1 h late, or in the future, are fine', async () => {
    const s = await shop();
    await s.order({ conf_status: 'callback', next_call_at: ago(30 * 60_000) });
    await s.order({ conf_status: 'postponed', next_call_at: new Date(NOW + D).toISOString() });
    await s.order({ conf_status: 'confirmed', next_call_at: ago(5 * H) }); // done: no callback
    assert.equal(level(await s.doctor(s.admin), 'lateCallbacks'), 'ok');
  });

  test('stock: inactive products and services are ignored; two depots are added up', async () => {
    const s = await shop();
    const off = await s.variant('Ancien', 0, { active: false });
    const svc = await s.variant('Emballage cadeau', 0, { service: true });
    const two = await s.variant('Deux dépôts', 1, { warehouse2: 3 });
    await s.order({ conf_status: 'no_stock', items: [{ ...off, qty: 5 }, { ...svc, qty: 5 }, { ...two, qty: 4 }] });
    const r = await s.doctor(s.admin);
    assert.equal(level(r, 'stockOut'), 'ok', 'Deux dépôts has 1 + 3 = 4');
  });

  test('stock: shipped orders no longer need the shelves; exchanges (SAV parcels) are not orders', async () => {
    const s = await shop();
    const V = await s.variant('Bleu', 0);
    await s.order({ conf_status: 'confirmed', follow_status: 'shipped', confirmed_at: ago(D), shipped_at: ago(H), items: [{ ...V, qty: 3 }] });
    await s.order({ conf_status: 'confirmed', follow_status: 'to_prepare', is_exchange: true, confirmed_at: ago(D), items: [{ ...V, qty: 3 }] });
    const r = await s.doctor(s.admin);
    assert.equal(level(r, 'stockOut'), 'ok');
    // sold 3 in 7 days with nothing left: runs out "within 1 day"
    assert.equal(find(r, 'stockSoon')?.list?.[0]?.n, 1);
  });

  test('negative stock (shipped more than counted) with orders waiting = missing', async () => {
    const s = await shop();
    const V = await s.variant('Bleu', -2);
    await s.order({ conf_status: 'confirmed', follow_status: 'to_prepare', confirmed_at: ago(H), items: [{ ...V, qty: 1 }] });
    assert.equal(find(await s.doctor(s.admin), 'stockOut')?.list?.[0]?.n, 3);
  });

  test('rates need enough orders: 19 decided orders are "info", not a verdict', async () => {
    const s = await shop();
    await many(19, (i) => s.order({ conf_status: i < 5 ? 'confirmed' : 'cancelled', created_at: ago(2 * D) }));
    await many(19, () => s.order({ conf_status: 'confirmed', created_at: ago(9 * D) }));
    const r = await s.doctor(s.admin);
    assert.equal(find(r, 'confRate')?.level, 'info');
    assert.equal(find(r, 'confRateDrop'), undefined);
  });

  test('confirmation: under 5 points down is OK, 5 to 15 is "watch", 15 and more is "urgent"', async () => {
    const mk = async (cur: number) => {
      const s = await shop();
      await many(25, (i) => s.order({ conf_status: i < 20 ? 'confirmed' : 'cancelled', created_at: ago(9 * D) })); // 80 %
      await many(25, (i) => s.order({ conf_status: i < cur ? 'confirmed' : 'cancelled', created_at: ago(2 * D) }));
      return s.doctor(s.admin);
    };
    const ok = await mk(19); // 76 %
    assert.equal(find(ok, 'confRate')?.level, 'ok');
    assert.equal(find(ok, 'confRate')?.params?.now, 76);
    assert.equal(find(await mk(17), 'confRateDrop')?.level, 'warn'); // 68 %
    const bad = await mk(13); // 52 %
    assert.equal(find(bad, 'confRateDrop')?.level, 'bad');
    assert.equal(find(bad, 'confRateDrop')?.params?.drop, 28);
  });

  test('returns: under 55 % delivered is urgent, under 70 % watch; a fall of 12 points is urgent even when high', async () => {
    const mk = async (cd: number, cr: number, pd = 0, pr = 0) => {
      const s = await shop();
      const put = async (n: number, delivered: boolean, at: string) =>
        many(n, () => s.order({ conf_status: 'confirmed', follow_status: delivered ? 'delivered' : 'returned', cashed: true, ...(delivered ? { delivered_at: at } : { returning_at: at, returned_at: at }) }));
      await put(cd, true, ago(5 * D));
      await put(cr, false, ago(5 * D));
      await put(pd, true, ago(20 * D));
      await put(pr, false, ago(20 * D));
      return s.doctor(s.admin);
    };
    const r1 = await mk(8, 12);
    assert.equal(find(r1, 'returnsUp')?.level, 'bad');
    assert.equal(find(r1, 'returnsUp')?.params?.back, 60);
    assert.equal(find(await mk(26, 14), 'returnsUp')?.level, 'warn'); // 65 %
    assert.equal(find(await mk(30, 10), 'returns')?.level, 'ok'); // 75 %
    assert.equal(find(await mk(32, 8, 38, 2), 'returnsUp')?.level, 'bad'); // 80 % after 95 %
    assert.equal(find(await mk(34, 6, 37, 3), 'returnsUp')?.level, 'warn'); // 85 % after 92.5 %
    assert.equal(find(await mk(10, 9), 'returns')?.level, 'info'); // 19 parcels: not enough
  });

  test('orders drop: yesterday half of the usual = urgent, 35 % less = watch', async () => {
    const day0 = Date.parse('2026-10-19T23:00:00Z'); // today 00:00 in Algiers
    const mk = async (yesterday: number) => {
      const s = await shop();
      for (let d = 2; d <= 8; d++) await many(10, () => s.order({ created_at: new Date(day0 - d * D + 10 * H).toISOString() }));
      await many(yesterday, () => s.order({ created_at: new Date(day0 - D + 10 * H).toISOString() }));
      return s.doctor(s.admin);
    };
    const r1 = await mk(4);
    assert.equal(find(r1, 'ordersDrop')?.level, 'bad');
    assert.equal(find(r1, 'ordersDrop')?.params?.yesterday, 4);
    assert.equal(find(r1, 'ordersDrop')?.params?.avg, 10);
    assert.equal(find(await mk(6), 'ordersDrop')?.level, 'warn');
    assert.equal(find(await mk(9), 'ordersOk')?.level, 'ok');
  });

  test('parcels: news within 3 days or shipped less than 8 days ago = not stuck; delivered/returned never', async () => {
    const s = await shop();
    await s.order({ conf_status: 'confirmed', follow_status: 'out_for_delivery', shipped_at: ago(5 * D), ext_status_at: ago(5 * D) });
    await s.order({ conf_status: 'confirmed', follow_status: 'failed', shipped_at: ago(9 * D), ext_status_at: ago(2 * D) });
    await s.order({ conf_status: 'confirmed', follow_status: 'delivered', shipped_at: ago(20 * D), ext_status_at: ago(19 * D), delivered_at: ago(19 * D), cashed: true });
    await s.order({ conf_status: 'confirmed', follow_status: 'returned', shipped_at: ago(20 * D), ext_status_at: ago(19 * D), returned_at: ago(15 * D) });
    assert.equal(level(await s.doctor(s.admin), 'stuckParcels'), 'ok');
    // no courier news at all: the shipping date counts
    await s.order({ conf_status: 'confirmed', follow_status: 'shipped', shipped_at: ago(9 * D) });
    assert.equal(find(await s.doctor(s.admin), 'stuckParcels')?.params?.count, 1);
  });

  test('cash: paid parcels and recent deliveries are fine', async () => {
    const s = await shop();
    await s.order({ conf_status: 'confirmed', follow_status: 'delivered', delivered_at: ago(20 * D), cashed: true });
    await s.order({ conf_status: 'confirmed', follow_status: 'delivered', delivered_at: ago(9 * D) });
    assert.equal(level(await s.doctor(s.admin), 'cashLate'), 'ok');
  });

  test('wilayas need 12 parcels before a verdict', async () => {
    const s = await shop();
    await many(11, () => s.order({ wilaya_id: 5, conf_status: 'confirmed', follow_status: 'returned', shipped_at: ago(5 * D), returned_at: ago(2 * D) }));
    assert.equal(level(await s.doctor(s.admin), 'badWilayas'), 'ok');
  });

  test('agents need 20 decided orders before being compared', async () => {
    const s = await shop();
    const a = await s.agent('Good');
    const b = await s.agent('New');
    await many(30, () => s.order({ agent_id: a, conf_status: 'confirmed', created_at: ago(D) }));
    await many(19, () => s.order({ agent_id: b, conf_status: 'cancelled', created_at: ago(D) }));
    assert.equal(level(await s.doctor(s.admin), 'weakAgents'), 'ok');
  });
});

// ---------------------------------------------------------------- score and order
test('score: 15 per urgent, 5 per watch, never under 5; sort keeps the order inside a level', () => {
  const it = (id: string, level: DoctorItem['level']): DoctorItem => ({ id, level, area: 'stock' });
  assert.equal(doctorScore([]), 100);
  assert.equal(doctorScore([it('a', 'bad'), it('b', 'warn'), it('c', 'ok'), it('d', 'info')]), 80);
  assert.equal(doctorScore(Array.from({ length: 9 }, (_, i) => it(`x${i}`, 'bad'))), 5);
  assert.deepEqual(
    doctorSort([it('a', 'ok'), it('b', 'warn'), it('c', 'bad'), it('d', 'info'), it('e', 'bad'), it('f', 'warn')]).map((i) => i.id),
    ['c', 'e', 'b', 'f', 'd', 'a'],
  );
});
