// Management › Archives: accounts, products and depots leave the lists but stay in the history; only what is archived
// and was never used can be deleted for good. And no column that points to one of them is forgotten by the check.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, login } from '../index';
import { NOT_REFS, PRODUCT_REFS, USER_REFS, VARIANT_REFS, WAREHOUSE_REFS } from '../modules/archive';
import { EMAILS, setup } from './harness';
import { DEMO_PASSWORD } from '@pilotix/shared';

/** a new team member's phone (required, one per person) */
let phoneN = 0;
const tph = () => `075${String(++phoneN).padStart(7, '0')}`;

let db: Db;
let as: (email: string) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(150));
});

const list = async (ctx: Ctx, input: Record<string, unknown>) => (await call('archive.list', ctx, input)) as any[];
const today = () => new Date().toISOString().slice(0, 10);
const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

test('every column that points to an account, a product, a variant or a depot is known to the check', async () => {
  // columns of real tables (not views, not the monthly parts of order_events)
  const cols = await db.query<{ tb: string; col: string; type: string }>(
    `SELECT c.table_name AS tb, c.column_name AS col, c.data_type AS type
       FROM information_schema.columns c
       JOIN pg_class k ON k.relname = c.table_name JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = c.table_schema
      WHERE c.table_schema = current_schema() AND k.relkind IN ('r', 'p') AND NOT k.relispartition
        AND c.data_type IN ('integer', 'bigint', 'ARRAY')`,
  );
  const fks = await db.query<{ tb: string; col: string; ref: string }>(
    `SELECT c.conrelid::regclass::text AS tb, a.attname AS col, c.confrelid::regclass::text AS ref
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.contype = 'f' AND c.connamespace = current_schema()::regnamespace
        AND c.confrelid::regclass::text IN ('profiles', 'products', 'product_variants', 'warehouses')`,
  );
  const known = new Set([...USER_REFS, ...PRODUCT_REFS, ...VARIANT_REFS, ...WAREHOUSE_REFS].map(([t, c]) => `${t}.${c}`).concat(NOT_REFS));
  const people = /^(user_id|agent_id|follow_agent_id|livreur_id|marketer_id|profile_id|seller_id|referrer_id|manager_id|assigned_to)$|_by$/;
  const things = /^(product_id|product_ids|variant_id|warehouse_id)$/;
  const missing = new Set<string>();
  for (const c of cols) if ((people.test(c.col) && c.type !== 'ARRAY') || things.test(c.col)) if (!known.has(`${c.tb}.${c.col}`) && c.tb !== 'adsets') missing.add(`${c.tb}.${c.col}`);
  for (const f of fks) if (!known.has(`${f.tb}.${f.col}`)) missing.add(`${f.tb}.${f.col} → ${f.ref}`);
  assert.deepEqual([...missing].sort(), [], 'add them to USER_REFS / PRODUCT_REFS / VARIANT_REFS / WAREHOUSE_REFS (or NOT_REFS) in modules/archive.ts');
  // and every listed column exists
  const all = new Set(cols.map((c) => `${c.tb}.${c.col}`));
  for (const [t, c] of [...USER_REFS, ...PRODUCT_REFS, ...VARIANT_REFS, ...WAREHOUSE_REFS]) assert.ok(all.has(`${t}.${c}`), `${t}.${c} exists`);
});

test('only administrators open the archives', async () => {
  await assert.rejects(call('archive.list', await as(EMAILS.conf), { kind: 'users' }), /Accès refusé/);
  await assert.rejects(call('archive.set', await as(EMAILS.depot), { kind: 'products', ids: [1], archived: true }), /Accès refusé/);
  await assert.rejects(call('archive.delete', await as(EMAILS.manager), { kind: 'users', ids: [1] }), /Accès refusé/);
});

test('accounts: archived = closed and out of the team list, kept in the history; deleted only when archived and never used', async () => {
  const admin = await as(EMAILS.admin);
  const me = admin.session.profile.id;
  const people = await list(admin, { kind: 'users' });
  const samira = people.find((u) => u.detail === EMAILS.conf);
  assert.ok(samira && samira.uses.includes('orders'), 'an agent with orders is used');
  assert.equal(people.find((u) => u.id === me).blocked, 'self');
  // a livreur with parcels on the road cannot leave
  const lamine = people.find((u) => u.detail === EMAILS.livreur);
  const road = Number((await db.query(`SELECT count(*)::int AS n FROM orders WHERE livreur_id = $1 AND follow_status IN ('shipped', 'out_for_delivery')`, [lamine.id]))[0].n);
  if (road) assert.equal(lamine.blocked, 'parcels');

  let r: any = await call('archive.set', admin, { kind: 'users', ids: [samira.id, me], archived: true });
  assert.equal(r.done, 1);
  assert.deepEqual(r.skipped.map((s: any) => s.reason), ['self']);
  await assert.rejects(login(db, EMAILS.conf, DEMO_PASSWORD), /désactivé/);
  const team: any[] = (await call('users.list', admin, {})) as any;
  assert.ok(team.find((u) => u.id === samira.id).archived, 'still known by name for the history (orders, pay)');
  assert.ok(!(((await call('admin.roles', admin, {})) as any).confirmation.names as string[]).includes(samira.name), 'not counted in the roles');
  await assert.rejects(call('users.update', admin, { id: samira.id, active: true }), /archivé/);
  assert.ok(!(await list(admin, { kind: 'users' })).some((u) => u.id === samira.id), 'out of the list to archive');
  const arch = await list(admin, { kind: 'users', archived: true });
  assert.ok(arch.find((u) => u.id === samira.id).archivedAt);

  // used: it stays in the archives
  r = await call('archive.delete', admin, { kind: 'users', ids: [samira.id] });
  assert.equal(r.deleted, 0);
  assert.equal(r.kept[0].reason, 'used');
  assert.ok(r.kept[0].uses.includes('orders'));

  // a new account that never did anything: archived, then deleted for good (and out of the teams)
  const u: any = await call('users.create', admin, { phone: tph(), name: 'Erreur Saisie', email: 'erreur@demo.pilotix.dz', password: 'Password-123', roles: ['confirmation'], language: 'fr' });
  const teams = [{ id: 't-x', name: 'Équipe X', managerId: null, agentIds: [u.id, samira.id] }];
  await db.query(`INSERT INTO settings (key, value) VALUES ('teams', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(teams)]);
  r = await call('archive.delete', admin, { kind: 'users', ids: [u.id] });
  assert.equal(r.kept[0].reason, 'notArchived', 'never deleted before it is archived');
  assert.deepEqual((await list(admin, { kind: 'users', q: 'erreur@' })).map((x) => [x.id, x.uses.length]), [[u.id, 0]]);
  await call('archive.set', admin, { kind: 'users', ids: [u.id], archived: true });
  r = await call('archive.delete', admin, { kind: 'users', ids: [u.id] });
  assert.equal(r.deleted, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM profiles WHERE id = $1', [u.id]))[0].n, 0);
  const after = (await db.query(`SELECT value FROM settings WHERE key = 'teams'`))[0].value as any[];
  assert.deepEqual(after[0].agentIds, [samira.id], 'the team forgets the deleted account');
  await assert.rejects(call('archive.delete', admin, { kind: 'users', ids: [me] }), /propre compte/);

  // back from the archives: still closed
  r = await call('archive.set', admin, { kind: 'users', ids: [samira.id], archived: false });
  assert.equal(r.done, 1);
  const back = (await db.query('SELECT active, archived_at FROM profiles WHERE id = $1', [samira.id]))[0];
  assert.ok(!back.active && !back.archived_at);
  await call('users.update', admin, { id: samira.id, active: true });
  assert.ok(await login(db, EMAILS.conf, DEMO_PASSWORD));
});

test('products: not archived with stock left; archived = out of the lists but still found for old orders; deleted only when never used', async () => {
  const admin = await as(EMAILS.admin);
  const sold = Number((await db.query(`SELECT i.product_id AS id FROM order_items i JOIN products p ON p.id = i.product_id WHERE NOT p.is_service GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`))[0].id);
  const stock = Number((await db.query(`SELECT COALESCE(sum(abs(s.qty)), 0)::int AS n FROM stock s JOIN product_variants v ON v.id = s.variant_id WHERE v.product_id = $1`, [sold]))[0].n);
  let r: any = await call('archive.set', admin, { kind: 'products', ids: [sold], archived: true });
  if (stock) {
    assert.equal(r.skipped[0].reason, 'stock');
    assert.equal((await list(admin, { kind: 'products' })).find((p) => p.id === sold).blocked, 'stock');
    await db.query(`UPDATE stock SET qty = 0 WHERE variant_id IN (SELECT id FROM product_variants WHERE product_id = $1)`, [sold]);
    r = await call('archive.set', admin, { kind: 'products', ids: [sold], archived: true });
  }
  assert.equal(r.done, 1);
  assert.ok(!((await call('catalog.products', admin, {})) as any[]).some((p) => p.id === sold), 'out of the product list');
  assert.equal(((await call('catalog.product', admin, { id: sold })) as any).id, sold, 'still found by id (old orders)');
  const p: any = await call('catalog.product', admin, { id: sold });
  await assert.rejects(call('catalog.saveProduct', admin, { id: sold, name: p.name, price: p.price, cost: p.cost, active: true }), /archivé/);
  r = await call('archive.delete', admin, { kind: 'products', ids: [sold] });
  assert.equal(r.deleted, 0);
  assert.ok(r.kept[0].uses.includes('orders'));

  // a product made by mistake: archived, then deleted with its variants; the products that offered it forget it
  const made: any = await call('catalog.saveProduct', admin, { name: 'Produit Erreur', sku: 'ERR-1', price: 1000, cost: 500, variants: [{ title: 'Rouge' }, { title: 'Bleu' }] });
  const other = Number((await db.query(`SELECT id FROM products WHERE id <> $1 AND archived_at IS NULL ORDER BY id LIMIT 1`, [made.id]))[0].id);
  await db.query('UPDATE products SET linked = array_append(linked, $1) WHERE id = $2', [made.id, other]);
  const found = await list(admin, { kind: 'products', field: 'created', from: today() });
  assert.ok(found.some((x) => x.id === made.id && x.uses.length === 0), 'made today, never used');
  assert.ok(!(await list(admin, { kind: 'products', field: 'created', to: yesterday() })).some((x) => x.id === made.id), 'not before today');
  await call('archive.set', admin, { kind: 'products', ids: [made.id], archived: true });
  r = await call('archive.delete', admin, { kind: 'products', ids: [made.id] });
  assert.equal(r.deleted, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM product_variants WHERE product_id = $1', [made.id]))[0].n, 0);
  assert.ok(!((await db.query('SELECT linked FROM products WHERE id = $1', [other]))[0].linked as any[]).map(Number).includes(made.id));
});

test('depots: never the default one nor one with stock; archived = out of every list; deleted only when never used', async () => {
  const admin = await as(EMAILS.admin);
  const def = Number((await db.query('SELECT id FROM warehouses WHERE is_default'))[0].id);
  let r: any = await call('archive.set', admin, { kind: 'warehouses', ids: [def], archived: true });
  assert.equal(r.skipped[0].reason, 'default');
  const w: any = await call('admin.warehouses.save', admin, { name: 'Dépôt Test', wilayaId: 31, commune: 'Oran' });
  const rows = await list(admin, { kind: 'warehouses' });
  assert.ok(rows.find((x) => x.id === w.id && x.uses.length === 0 && x.createdAt));
  assert.equal(rows.find((x) => x.id === def).blocked, 'default');
  // stock in it: moved out first
  const v = Number((await db.query(`SELECT v.id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE NOT p.is_service AND p.archived_at IS NULL LIMIT 1`))[0].id);
  await db.query('INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, $2, 3)', [v, w.id]);
  r = await call('archive.set', admin, { kind: 'warehouses', ids: [w.id], archived: true });
  assert.equal(r.skipped[0].reason, 'stock');
  await db.query('UPDATE stock SET qty = 0 WHERE warehouse_id = $1', [w.id]);
  r = await call('archive.set', admin, { kind: 'warehouses', ids: [w.id], archived: true });
  assert.equal(r.done, 1);
  assert.ok(!((await call('catalog.warehouses', admin, { all: true })) as any[]).some((x) => x.id === w.id));
  assert.ok(!((await call('admin.warehouses.list', admin, {})) as any[]).some((x) => x.id === w.id));
  assert.ok(!((await call('catalog.depots', admin, {})) as any[]).some((x) => x.id === w.id));
  await assert.rejects(call('admin.warehouses.save', admin, { id: w.id, name: 'Dépôt Test', wilayaId: 31, active: true }), /archivé/);
  r = await call('archive.delete', admin, { kind: 'warehouses', ids: [w.id] });
  assert.equal(r.deleted, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM warehouses WHERE id = $1', [w.id]))[0].n, 0);
  // a depot with orders stays in the archives
  const used = Number((await db.query(`SELECT warehouse_id AS id FROM orders WHERE warehouse_id IS NOT NULL AND warehouse_id <> $1 LIMIT 1`, [def]))[0]?.id ?? 0);
  if (used) {
    await db.query('UPDATE stock SET qty = 0 WHERE warehouse_id = $1', [used]);
    await call('archive.set', admin, { kind: 'warehouses', ids: [used], archived: true });
    r = await call('archive.delete', admin, { kind: 'warehouses', ids: [used] });
    assert.equal(r.kept[0].reason, 'used');
  }
});
