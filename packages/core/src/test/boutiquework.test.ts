// « Toutes les boutiques »: someone in several boutiques of a seller sees their orders and numbers together, each
// boutique answering as their own account there; the « Boutique » filter, a person / a product given boutique by
// boutique; an order of another boutique opens and works there; nothing outside the order work runs there that way.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { loadShop, passwordFromLink } from '../platform';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const PW = 'Boutique-Password-1';
const SELLER = 'karim@shops.dz';
const AGENT = 'samira@shops.dz';

async function as(t: Tenancy, shopId: number, email: string, password: string, extra: Partial<Ctx> = {}): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, password), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t, ...extra };
}

test('« Toutes les boutiques »: lists and numbers together, the Boutique filter, per-boutique values, an order of another boutique', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<any>;
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');

  // two boutiques of Karim, each with its product and its orders
  const shops: { id: number; db: any; product: number }[] = [];
  for (const [name, prod] of [['Bébé Shop', 'Poussette'], ['Maison Shop', 'Lampe']]) {
    const made = await p('p.shops.create', { name, ownerName: 'Karim', ownerEmail: SELLER, planId: biz.id, trialDays: 14 });
    if (made.mail?.token) await passwordFromLink(t, made.mail.token, PW);
    const s = (await loadShop(t, { id: made.id }))!;
    const db = t.shop(s.schema);
    const pid = Number((await db.query(`INSERT INTO products (name, sku, price) VALUES ($1, $2, 9000) RETURNING id`, [prod, prod.toUpperCase()]))[0].id);
    shops.push({ id: s.id, db, product: pid });
  }
  const [A, B] = shops;
  const inA = await as(t, A.id, SELLER, PW);
  const inB = await as(t, B.id, SELLER, PW);
  const mk = (c: Ctx, pid: number, ph: string) => call('orders.create', c, { customerName: 'Client', phone: ph, wilayaId: 16, commune: 'Kouba', address: 'Rue', items: [{ productId: pid, variantId: null, qty: 1 }] }) as Promise<any>;
  for (const ph of ['0770000001', '0770000002']) await mk(inA, A.product, ph);
  for (const ph of ['0770000003', '0770000004', '0770000005']) await mk(inB, B.product, ph);
  const oB = (await call('orders.list', inB, { pageSize: 1 }) as any).rows[0];

  // from A, all boutiques: B's orders too, each with its boutique
  const all = await as(t, A.id, SELLER, PW, { boutique: 'all' });
  const l: any = await call('orders.list', all, { pageSize: 50 });
  assert.equal(l.total, 5);
  assert.deepEqual(l.rows.map((r: any) => r.seller.id).sort(), [A.id, A.id, B.id, B.id, B.id].sort());
  assert.ok(l.rows.every((r: any, i: number) => i === 0 || r.createdAt <= l.rows[i - 1].createdAt), 'newest first over both');
  // a page cut over both
  const p2: any = await call('orders.list', all, { pageSize: 2, page: 2 });
  assert.equal(p2.rows.length, 2);
  assert.equal(p2.total, 5);
  // counts added up
  const c: any = await call('orders.counts', all, {});
  const cA: any = await call('orders.counts', inA, {});
  const cB: any = await call('orders.counts', inB, {});
  assert.equal(c.all, cA.all + cB.all);
  // « Boutique »: B only
  const onlyB: any = await call('orders.list', all, { shops: [B.id], pageSize: 50 });
  assert.equal(onlyB.total, 3);
  assert.ok(onlyB.rows.every((r: any) => r.seller.id === B.id));
  // a product is one boutique's: given for that boutique, the other left out
  const byProd: any = await call('orders.list', all, { byShop: { [B.id]: { productId: B.product }, [A.id]: null }, pageSize: 50 });
  assert.equal(byProd.total, 3);
  // a filter that leaves no boutique: empty, not an error
  const none: any = await call('orders.list', all, { shops: [A.id], byShop: { [A.id]: null }, pageSize: 50 });
  assert.deepEqual([none.total, none.rows.length], [0, 0]);
  const zero: any = await call('orders.counts', all, { shops: [A.id], byShop: { [A.id]: null } });
  assert.equal(zero.all, 0);
  // the Accueil's numbers: added up, and boutique by boutique
  const day = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() };
  const ov: any = await call('stats.overview', all, day);
  assert.equal(ov.received, 5);
  assert.deepEqual(ov.byBoutique.map((b: any) => [b.id, b.received]).sort(), [[A.id, 2], [B.id, 3]].sort());
  const now: any = await call('stats.now', all, {});
  assert.equal(now.toCall, 5);
  // the filter lists, boutique by boutique
  const opts: any = await call('filters.options', all, {});
  assert.deepEqual(opts.boutiques.map((b: any) => b.id).sort(), [A.id, B.id].sort());
  assert.ok(opts.boutiques.find((b: any) => b.id === B.id).options.products.some((x: any) => x.id === B.product && x.name === 'Lampe'));
  // something that needs one boutique
  await assert.rejects(call('users.list', all, {}), /Choisissez une boutique/);

  // an order of B opened from A: its work runs in B
  const oneB = await as(t, A.id, SELLER, PW, { boutique: B.id });
  const got: any = await call('orders.get', oneB, { id: oB.id });
  assert.equal(got.id, oB.id);
  assert.equal(got.items[0].name, 'Lampe');
  await call('orders.note', oneB, { id: oB.id, note: 'vu depuis Bébé Shop' });
  assert.ok((await B.db.query(`SELECT 1 FROM order_events WHERE order_id = $1 AND note LIKE '%vu depuis%'`, [oB.id])).length, 'written in B');
  // not the rest of B (its team, its settings): « Ouvrez … »
  await assert.rejects(call('users.update', oneB, { id: 1, name: 'X' }), /Ouvrez « Maison Shop »/);

  // Samira works in A only: no « Toutes les boutiques » into B
  await call('users.create', inA, { name: 'Samira', email: AGENT, phone: '0661000001', roles: ['confirmation'], password: PW });
  const sam = await as(t, A.id, AGENT, PW, { boutique: B.id });
  await assert.rejects(call('orders.get', sam, { id: oB.id }), /pas de compte dans cette boutique/);
  const samAll = await as(t, A.id, AGENT, PW, { boutique: 'all' });
  const samList: any = await call('confirmation.list', samAll, { sub: 'nouvelles' });
  assert.ok(samList.rows.every((r: any) => r.seller.id === A.id), 'her one boutique only');
  // and once she works in B too, B's orders come with them
  await call('users.create', inB, { name: 'Samira', email: AGENT, phone: '0661000002', roles: ['confirmation'], password: PW });
  await B.db.query(`UPDATE orders SET agent_id = (SELECT id FROM profiles WHERE email = $1)`, [AGENT]);
  const samAll2 = await as(t, A.id, AGENT, PW, { boutique: 'all' });
  const both: any = await call('confirmation.list', samAll2, { sub: 'nouvelles' });
  assert.ok(both.rows.some((r: any) => r.seller.id === B.id), 'her orders in B too');
  // the filter lists: Samira works in both, one key for her (never her e-mail)
  const o2: any = await call('filters.options', all, {});
  const keysOf = (id: number) => o2.boutiques.find((b: any) => b.id === id).options.agents.filter((a: any) => a.name === 'Samira').map((a: any) => a.key);
  assert.deepEqual(keysOf(A.id), keysOf(B.id));
  assert.ok(!JSON.stringify(o2).includes(AGENT), 'no e-mail in the lists');
  // « Commande suivante » over both boutiques
  const nx: any = await call('orders.next', samAll2, { skip: [], skipAll: [] });
  assert.ok(nx.id && [A.id, B.id].includes(nx.seller));
});
