// Shared tables (platform/shared.ts): every shop's rows in the same tables, each shop seeing only its own. These tests
// try on purpose to read, change and write another shop's rows, the ways a bug could: they must all fail.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { login, migrate, migrateAll, pgliteTenancy, seedBase, Tenancy } from '../index';
import { dropShopData, loadShop, provisionShop } from '../platform/shops';
import { MIGRATIONS } from '../db';

const OWNER = { email: 'karim@bebe.dz', password: 'Karim-Password-1' };

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const t = pgliteTenancy(pg as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Karim' });
  await migrateAll(t);
  return { t, pg };
}

async function twoShops(t: Tenancy) {
  const a = await provisionShop(t, { name: 'Boutique A', kind: 'store', planId: null, trialDays: 30, owner: { name: 'Amel', email: 'amel@a.dz' }, password: 'Amel-Password-1', verified: true });
  const b = await provisionShop(t, { name: 'Boutique B', kind: 'store', planId: null, trialDays: 30, owner: { name: 'Bilal', email: 'bilal@b.dz' }, password: 'Bilal-Password-1', verified: true });
  return { a, b, A: t.shop(a.schema), B: t.shop(b.schema) };
}

async function order(db: any, name: string) {
  const phone = `05${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const c = (await db.query(`INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id`, [name, phone]))[0];
  return db.query(
    `INSERT INTO orders (ref, customer_id, customer_name, phone, wilaya_id, commune, conf_status, subtotal, delivery_fee, discount, total, source)
     VALUES ('PX' || nextval('order_ref_seq'), $2, $1, '0555000000', 16, 'Kouba', 'new', 1000, 0, 0, 1000, 'site') RETURNING id, ref`,
    [name, c.id],
  );
}

test('a shop never sees, changes or deletes another shop’s rows', async () => {
  const { t } = await server();
  const { A, B } = await twoShops(t);
  const [oa] = await order(A, 'Client de A');
  assert.equal((await A.query('SELECT count(*)::int n FROM orders'))[0].n, 1);
  assert.equal((await B.query('SELECT count(*)::int n FROM orders'))[0].n, 0, 'B sees none of A’s orders');
  assert.equal((await B.query('SELECT * FROM orders WHERE id = $1', [oa.id])).length, 0, 'not even by its id');
  assert.equal((await B.query(`UPDATE orders SET customer_name = 'piraté' WHERE id = $1 RETURNING id`, [oa.id])).length, 0);
  assert.equal((await B.query('DELETE FROM orders WHERE id = $1 RETURNING id', [oa.id])).length, 0);
  assert.equal((await B.query('DELETE FROM orders RETURNING id')).length, 0, 'a DELETE without WHERE only reaches its own rows');
  assert.equal((await A.query('SELECT customer_name FROM orders WHERE id = $1', [oa.id]))[0].customer_name, 'Client de A');
  // its accounts too: B cannot log in with A's owner, nor read A's profiles
  assert.equal((await B.query(`SELECT 1 FROM profiles WHERE email = 'amel@a.dz'`)).length, 0);
  await assert.rejects(login(B, 'amel@a.dz', 'Amel-Password-1'));
  await login(A, 'amel@a.dz', 'Amel-Password-1');
});

test('a shop cannot write a row into another shop (even by naming its shop_id)', async () => {
  const { t } = await server();
  const { a, B } = await twoShops(t);
  await assert.rejects(
    B.query(`INSERT INTO settings (shop_id, key, value) VALUES ($1, 'piège', '{}')`, [a.id]),
    /row-level security|violates/i,
  );
  await assert.rejects(B.query(`UPDATE settings SET shop_id = $1 WHERE key = 'shop'`, [a.id]), /row-level security|violates/i);
});

test('a connection with no shop sees nothing and writes nothing (fail closed)', async () => {
  const { t, pg } = await server();
  const { A } = await twoShops(t);
  await order(A, 'Client de A');
  await (pg as any).query('SET ROLE px_app');
  await (pg as any).query(`SELECT set_config('app.shop_id', '', false), set_config('search_path', 'public, ext', false)`);
  assert.equal((await (pg as any).query('SELECT count(*)::int n FROM orders')).rows[0].n, 0);
  assert.equal((await (pg as any).query('SELECT count(*)::int n FROM profiles')).rows[0].n, 0);
  await assert.rejects((pg as any).query(`INSERT INTO settings (key, value) VALUES ('x', '{}')`));
  await (pg as any).query('RESET ROLE');
});

test('each shop counts its own order references, from the start', async () => {
  const { t } = await server();
  const { A, B } = await twoShops(t);
  const r1 = (await order(A, 'a1'))[0].ref;
  const r2 = (await order(A, 'a2'))[0].ref;
  const r3 = (await order(B, 'b1'))[0].ref;
  assert.equal(Number(r2.slice(2)), Number(r1.slice(2)) + 1);
  assert.equal(r3, r1, 'B starts where A started: its own counter');
  // setval works per shop too (the demo sets where its references start)
  await B.query(`SELECT setval('order_ref_seq', 5000)`);
  assert.equal((await order(B, 'b2'))[0].ref, 'PX5001');
  assert.equal(Number((await order(A, 'a3'))[0].ref.slice(2)), Number(r2.slice(2)) + 1);
});

test('the same unique value in two shops (a setting key, an e-mail): each shop has its own', async () => {
  const { t } = await server();
  const { A, B } = await twoShops(t);
  await A.query(`INSERT INTO settings (key, value) VALUES ('mine', '1') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await B.query(`INSERT INTO settings (key, value) VALUES ('mine', '2') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  assert.equal((await A.query(`SELECT value FROM settings WHERE key = 'mine'`))[0].value, 1);
  assert.equal((await B.query(`SELECT value FROM settings WHERE key = 'mine'`))[0].value, 2);
});

test('removing a shop removes only its rows', async () => {
  const { t } = await server();
  const { a, b, A, B } = await twoShops(t);
  await order(A, 'a');
  await order(B, 'b');
  await dropShopData(t, a.id, a.schema);
  assert.equal((await A.query('SELECT count(*)::int n FROM orders'))[0].n, 0);
  assert.equal((await A.query('SELECT count(*)::int n FROM profiles'))[0].n, 0);
  assert.equal((await B.query('SELECT count(*)::int n FROM orders'))[0].n, 1);
  assert.ok((await B.query('SELECT count(*)::int n FROM profiles'))[0].n > 0);
  assert.ok(await loadShop(t, { id: b.id }));
});

test('every shop table is converted: shop_id first in every key and index, the filter on every table', async () => {
  const { t, pg } = await server();
  await twoShops(t);
  const q = async (sql: string) => (await (pg as any).query(sql)).rows;
  await (pg as any).query('RESET ROLE');
  const shopTables = `SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') AND c.relname NOT IN ('schema_migrations')`;
  assert.deepEqual(await q(`SELECT c.relname FROM pg_class c WHERE c.oid IN (${shopTables}) AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'shop_id')`), []);
  assert.deepEqual(await q(`SELECT c.relname FROM pg_class c WHERE c.oid IN (${shopTables}) AND NOT c.relrowsecurity`), []);
  assert.deepEqual(
    await q(`SELECT conname, pg_get_constraintdef(k.oid) d FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
             WHERE c.oid IN (${shopTables}) AND NOT c.relispartition AND k.contype IN ('p','u','f') AND pg_get_constraintdef(k.oid) !~ '\\(shop_id'`),
    [],
  );
  assert.deepEqual(
    await q(`SELECT ci.relname FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_class c ON c.oid = i.indrelid
             WHERE c.oid IN (${shopTables}) AND NOT c.relispartition AND pg_get_indexdef(i.indexrelid) ~ 'USING btree' AND pg_get_indexdef(i.indexrelid) !~ 'btree \\(shop_id'`),
    [],
  );
  // every index is whole: none left on a partitioned parent alone, and each partition carries every parent index
  assert.deepEqual(await q(`SELECT indexrelid::regclass::text i FROM pg_index WHERE NOT indisvalid AND indrelid IN (${shopTables})`), []);
  assert.deepEqual(
    await q(`SELECT ch.relname, count(*) FILTER (WHERE TRUE) FROM pg_inherits h JOIN pg_class p ON p.oid = h.inhparent AND p.relkind = 'p' JOIN pg_class ch ON ch.oid = h.inhrelid
             WHERE p.oid IN (${shopTables})
               AND (SELECT count(*) FROM pg_index WHERE indrelid = ch.oid) < (SELECT count(*) FROM pg_index WHERE indrelid = p.oid) GROUP BY ch.relname`),
    [],
  );
  // the views read with the reader's filter
  assert.deepEqual(await q(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'v' AND NOT coalesce('security_invoker=on' = ANY (reloptions), false)`), []);
  // converting again changes nothing
  await (pg as any).query('BEGIN');
  assert.equal((await q('SELECT public.px_tenantize(1) n'))[0].n, 0);
  await (pg as any).query('COMMIT');
});

test('a new shop gets the rows the migrations would have given it (the list is complete)', async () => {
  // what the migrations write in an empty schema, the old way (one schema per shop)
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const t = pgliteTenancy(pg as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql), { legacy: true });
  const tables = (await (pg as any).query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r','p') AND NOT relispartition AND relname <> 'schema_migrations'`)).rows;
  const filled: string[] = [];
  for (const r of tables) if ((await (pg as any).query(`SELECT count(*)::int n FROM public.${r.relname}`)).rows[0].n) filled.push(r.relname);
  assert.deepEqual(filled, ['settings'], 'a migration adds default rows: add them to newShopRows (platform/shops.ts)');
  assert.deepEqual((await (pg as any).query('SELECT key FROM settings')).rows.map((r: any) => r.key), ['referral']);
  // and a shop made in shared tables has them
  const s = await server();
  const { B } = await twoShops(s.t);
  assert.equal((await B.query(`SELECT count(*)::int n FROM settings WHERE key = 'referral'`))[0].n, 1);
  assert.ok(MIGRATIONS.length > 0);
});

test('an old shop schema moves into the shared tables with its ids, counters and logins', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const t = pgliteTenancy(pg as any);
  // the old way: shop #1 in public, shop 7 in its own schema
  await migrate(t.shop('public'), (sql) => t.exec('public', sql), { legacy: true });
  await seedBase(t.shop('public'), { ...OWNER, name: 'Karim' });
  // shop #1 already has orders: its counters are past their start
  const [first] = await order(t.shop('public'), 'Client du premier');
  await t.shop('public').query(`SELECT setval('order_ref_seq', 1500)`);
  await t.exec('public', `CREATE SCHEMA shop_7`);
  await migrate(t.shop('shop_7'), (sql) => t.exec('shop_7', sql), { legacy: true });
  await seedBase(t.shop('shop_7'), { email: 'sami@seven.dz', password: 'Sami-Password-1', name: 'Sami' });
  const old = t.shop('shop_7');
  await old.query(`SELECT setval('order_ref_seq', 1200)`);
  const [o] = await order(old, 'Client ancien');
  await old.query(`INSERT INTO settings (key, value) VALUES ('note', '{"order": ${o.id}}')`);
  // a table whose id is GENERATED ALWAYS (the pay plans): its rows move with their ids too
  const [plan] = await old.query(`INSERT INTO management_payment_plans (kind, name, configuration) VALUES ('agent', 'Plan ancien', '{}') RETURNING id`);
  const before = (await old.query('SELECT count(*)::int n FROM profiles'))[0].n;
  // the platform as before the change, with shop 7 in it
  const { migratePlatform } = await import('../platform/schema');
  await migratePlatform(t);
  await t.platform.query(`INSERT INTO platform.shops (id, slug, name, schema_name, never_expires) VALUES (7, 'seven', 'Seven', 'shop_7', true)`);
  // the start after the change
  await migrateAll(t);
  const S = t.shop('shop_7');
  assert.equal((await S.query('SELECT count(*)::int n FROM profiles'))[0].n, before);
  const moved = (await S.query('SELECT id, ref, customer_name FROM orders'))[0];
  assert.deepEqual([moved.id, moved.ref, moved.customer_name], [o.id, o.ref, 'Client ancien'], 'same id, same reference');
  assert.equal((await S.query(`SELECT value FROM settings WHERE key = 'note'`))[0].value.order, o.id, 'ids inside JSON still right');
  assert.equal((await order(S, 'Nouveau'))[0].ref, 'PX1202', 'its references carry on');
  assert.equal((await S.query(`SELECT id FROM management_payment_plans WHERE name = 'Plan ancien'`))[0]?.id, plan.id, 'a GENERATED ALWAYS id is kept');
  const [plan2] = await S.query(`INSERT INTO management_payment_plans (kind, name, configuration) VALUES ('agent', 'Plan nouveau', '{}') RETURNING id`);
  assert.ok(Number(plan2.id) > Number(plan.id), 'a new one gets a new id');
  await login(S, 'sami@seven.dz', 'Sami-Password-1');
  // shop #1 still has its own rows, not shop 7's
  assert.equal((await t.shop('public').query(`SELECT count(*)::int n FROM orders`))[0].n, 1);
  // shop #1's counters carry on too (they were the old sequences in public): no reference or tracking number twice
  const [next1] = await order(t.shop('public'), 'Après le passage');
  assert.equal(next1.ref, 'PX1501', 'shop #1 references carry on');
  const tr = await t.shop('public').query(`SELECT own_tracking FROM orders WHERE id = ANY($1)`, [[first.id, next1.id]]);
  assert.equal(new Set(tr.map((r: any) => r.own_tracking)).size, 2, 'its own tracking numbers never repeat');
  // the old schema is kept aside (the way back), not used
  assert.equal((await (pg as any).query(`SELECT to_regnamespace('moved_shop_7') IS NOT NULL AS k, to_regnamespace('shop_7') IS NULL AS g`)).rows[0].k, true);
  // a new row gets an id no shop used
  const [n2] = await order(t.shop('public'), 'Premier');
  assert.ok(Number(n2.id) > Number(o.id));
});
