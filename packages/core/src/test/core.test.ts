// End-to-end tests of the business rules on a real (in-process) PostgreSQL: PGlite.
// Run: npm run build -w @pilotix/core && npm test -w @pilotix/core
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, login, migrate, seedDemo } from '../index';
import { pgliteDb } from '../pglite';
import { DEMO_PASSWORD } from '../seed';

/** a new team member's phone (required, one per person) */
let phoneN = 0;
const tph = () => `072${String(++phoneN).padStart(7, '0')}`;

let db: Db;
const ctxFor = async (email: string): Promise<Ctx> => ({ db, session: await login(db, email, DEMO_PASSWORD), now: () => Date.now(), emit: () => {} });

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  db = pgliteDb(pg as any);
  await migrate(db, async (sql) => {
    await pg.exec(sql);
  });
  const t = Date.now();
  await seedDemo(db, { orders: 400 });
  console.log(`seeded in ${Date.now() - t} ms`);
});

test('login: wrong password refused, right one accepted', async () => {
  await assert.rejects(login(db, 'admin@demo.pilotix.dz', 'nope'));
  const s = await login(db, 'admin@demo.pilotix.dz', DEMO_PASSWORD);
  assert.equal(s.isAdmin, true);
});

test('vendeur gets confirmation, suivi, depot, marketer', async () => {
  const s = await login(db, 'vendeur@demo.pilotix.dz', DEMO_PASSWORD);
  for (const r of ['confirmation', 'suivi', 'depot', 'marketer']) assert.ok(s.roles.includes(r as any), r);
});

test('orders.list filters and paginates', async () => {
  const ctx = await ctxFor('admin@demo.pilotix.dz');
  const all: any = await call('orders.list', ctx, { pageSize: 20 });
  assert.equal(all.rows.length, 20);
  assert.ok(all.total >= 400);
  const todo: any = await call('orders.list', ctx, { conf: ['new'], pageSize: 5 });
  for (const o of todo.rows) assert.equal(o.confStatus, 'new');
  const byPhone: any = await call('orders.list', ctx, { q: all.rows[0].phone });
  assert.ok(byPhone.rows.some((o: any) => o.id === all.rows[0].id));
  // a confirmation agent: only her own orders
  const samira = await ctxFor('samira@demo.pilotix.dz');
  const hers: any = await call('orders.list', samira, { pageSize: 500 });
  const me = samira.session.profile.id;
  assert.ok(hers.total > 0 && hers.total < all.total);
  const tickets = new Set((await db.query('SELECT order_id FROM complaints WHERE assigned_to = $1 OR created_by = $1', [me])).map((r: any) => Number(r.order_id)));
  for (const o of hers.rows) assert.ok(o.agentId === me || o.createdBy === me || o.lockedBy?.id === me || tickets.has(o.id), `${o.ref} is hers`);
});

test('create → confirm → prepare → ship (stock down) → return (stock back)', async () => {
  const conf = await ctxFor('samira@demo.pilotix.dz');
  const depot = await ctxFor('karim@demo.pilotix.dz');
  const prod = (await db.query('SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id ORDER BY p.id LIMIT 1'))[0];
  const o: any = await call('orders.create', conf, {
    customerName: 'Client Test', phone: '+213 661 00 11 22', wilayaId: 16, commune: 'Hydra', items: [{ productId: Number(prod.id), variantId: Number(prod.vid), qty: 2 }],
  });
  assert.equal(o.phone, '0661001122');
  assert.equal(o.confStatus, 'new');
  assert.ok(o.deliveryFee > 0, 'fee from the client grid');
  await assert.rejects(call('orders.setConf', conf, { ids: [o.id], status: 'callback' }), /date/);
  await call('orders.setConf', conf, { ids: [o.id], status: 'no_answer' });
  await call('orders.setConf', conf, { ids: [o.id], status: 'confirmed' });
  let cur: any = await call('orders.get', conf, { id: o.id });
  assert.equal(cur.confStatus, 'confirmed');
  assert.equal(cur.followStatus, 'to_prepare');
  assert.equal(cur.attempts, 1);
  await assert.rejects(call('orders.setFollow', conf, { ids: [o.id], status: 'shipped' }));
  const stock = async () => Number((await db.query('SELECT qty FROM stock WHERE variant_id = $1', [prod.vid]))[0].qty);
  const before = await stock();
  await call('orders.setFollow', depot, { ids: [o.id], status: 'prepared' });
  await call('orders.setFollow', depot, { ids: [o.id], status: 'shipped', tracking: 'YAL-1' });
  assert.equal(await stock(), before - 2);
  await assert.rejects(call('orders.update', conf, { id: o.id, items: [{ productId: Number(prod.id), variantId: Number(prod.vid), qty: 1 }] }), /partie/);
  await call('orders.setFollow', depot, { ids: [o.id], status: 'returned' });
  assert.equal(await stock(), before);
  cur = await call('orders.get', conf, { id: o.id });
  assert.ok(cur.shippedAt && cur.returnedAt);
  const ev: any = await call('orders.events', conf, { id: o.id });
  assert.ok(ev.length >= 6);
});

test('offline retry never applies twice', async () => {
  const conf = await ctxFor('rania@demo.pilotix.dz');
  const o: any = (await call('orders.list', conf, { conf: ['new'], pageSize: 1 }) as any).rows[0];
  await call('orders.setConf', conf, { ids: [o.id], status: 'no_answer', clientId: 'test-client-0001' });
  await call('orders.setConf', conf, { ids: [o.id], status: 'no_answer', clientId: 'test-client-0001' });
  const cur: any = await call('orders.get', conf, { id: o.id });
  assert.equal(cur.attempts, o.attempts + 1);
});

test('livreur only sees own orders and cannot open others', async () => {
  const liv = await ctxFor('lamine@demo.pilotix.dz');
  const list: any = await call('orders.list', liv, { pageSize: 200 });
  assert.ok(list.rows.every((o: any) => o.livreurId === liv.session.profile.id));
  const other = (await db.query('SELECT id FROM orders WHERE livreur_id IS DISTINCT FROM $1 LIMIT 1', [liv.session.profile.id]))[0];
  await assert.rejects(call('orders.get', liv, { id: Number(other.id) }));
  await assert.rejects(call('orders.setConf', liv, { ids: [Number(other.id)], status: 'confirmed' }));
});

test('roles: confirmation cannot create users, admin can', async () => {
  const conf = await ctxFor('samira@demo.pilotix.dz');
  await assert.rejects(call('users.create', conf, { phone: tph(), name: 'X Y', email: 'x@y.dz', password: '12345678', roles: ['admin'] }));
  const admin = await ctxFor('admin@demo.pilotix.dz');
  const u: any = await call('users.create', admin, { phone: tph(), name: 'Nouvel Agent', email: 'nouvel@demo.pilotix.dz', password: 'Mot-de-passe-Fort1', roles: ['confirmation'] });
  assert.equal(u.roles[0], 'confirmation');
});

test('a seller never adds another seller: « Vendeur » is never given, the ones who have it keep it', async () => {
  const admin = await ctxFor('admin@demo.pilotix.dz');
  await assert.rejects(call('users.create', admin, { phone: tph(), name: 'Autre Vendeur', email: 'autre.vendeur@demo.pilotix.dz', password: 'Mot-de-passe-Fort1', roles: ['vendeur'] }), /ne peut pas ajouter un autre vendeur/);
  await assert.rejects(call('users.create', admin, { phone: tph(), name: 'Autre Vendeur', email: 'autre.vendeur@demo.pilotix.dz', password: 'Mot-de-passe-Fort1', roles: ['confirmation', 'vendeur'] }), /ne peut pas ajouter un autre vendeur/);
  // an agent cannot be turned into a seller later either
  const agent: any = await call('users.create', admin, { phone: tph(), name: 'Agent Simple', email: 'agent.simple@demo.pilotix.dz', password: 'Mot-de-passe-Fort1', roles: ['confirmation'] });
  await assert.rejects(call('users.update', admin, { id: agent.id, roles: ['confirmation', 'vendeur'] }), /ne peut pas ajouter un autre vendeur/);
  // a seller made before this rule keeps his role: his account is still changed (name), and the role can be taken away
  const old = (await db.query(`INSERT INTO profiles (name, email, phone, password_hash, roles) VALUES ('Ancien Vendeur', 'ancien.vendeur@demo.pilotix.dz', $1, 'x', '{vendeur}') RETURNING id`, [tph()]))[0];
  const kept: any = await call('users.update', admin, { id: Number(old.id), name: 'Ancien Vendeur 2', roles: ['vendeur'] });
  assert.deepEqual(kept.roles, ['vendeur']);
  const gone: any = await call('users.update', admin, { id: Number(old.id), roles: ['agent_manager'] });
  assert.deepEqual(gone.roles, ['agent_manager']);
});

test('a store never adds a marketer to its team: « Marketeur » is never given, the ones who have it keep it', async () => {
  const admin = await ctxFor('admin@demo.pilotix.dz');
  await assert.rejects(call('users.create', admin, { phone: tph(), name: 'Nouveau Marketeur', email: 'nouveau.marketeur@demo.pilotix.dz', password: 'Mot-de-passe-Fort1', roles: ['marketer'] }), /plus de marketeur/);
  const agent: any = await call('users.create', admin, { phone: tph(), name: 'Agent Deux', email: 'agent.deux@demo.pilotix.dz', password: 'Mot-de-passe-Fort1', roles: ['confirmation'] });
  await assert.rejects(call('users.update', admin, { id: agent.id, roles: ['confirmation', 'marketer'] }), /plus de marketeur/);
  // a marketeur made before this rule keeps his role, and it can be taken away
  const old = (await db.query(`INSERT INTO profiles (name, email, phone, password_hash, roles) VALUES ('Ancien Marketeur', 'ancien.marketeur@demo.pilotix.dz', $1, 'x', '{marketer}') RETURNING id`, [tph()]))[0];
  const kept: any = await call('users.update', admin, { id: Number(old.id), name: 'Ancien Marketeur 2', roles: ['marketer'] });
  assert.deepEqual(kept.roles, ['marketer']);
  const gone: any = await call('users.update', admin, { id: Number(old.id), roles: ['confirmation'] });
  assert.deepEqual(gone.roles, ['confirmation']);
});

test('counts for the menu', async () => {
  const admin = await ctxFor('admin@demo.pilotix.dz');
  const c: any = await call('orders.counts', admin, {});
  assert.ok(c.all >= 400);
  assert.ok(c.conf.new >= 0);
});
