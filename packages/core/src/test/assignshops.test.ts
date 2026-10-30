// Affectation across the owner's boutiques: one person with an account in two boutiques of the same owner has one
// maximum for both (his open orders in the other boutique count), and his « boutiques » (the same in each) decide
// where he gets orders from.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { loadShop, passwordFromLink } from '../platform';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const PW = 'Boutique-Password-1';
const AGENT = 'samira@boutique.dz';

async function as(t: Tenancy, shopId: number, email: string, password: string): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, password), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t };
}

test('one agent in two boutiques of the same owner: one maximum, and only his boutiques', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<any>;
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');

  // two boutiques of the same owner (Karim)
  const shops = [];
  for (const name of ['Bébé Shop', 'Maison Shop']) {
    const made = await p('p.shops.create', { name, ownerName: 'Karim', ownerEmail: 'karim@shops.dz', planId: biz.id, trialDays: 14 });
    if (made.mail?.token) await passwordFromLink(t, made.mail.token, PW);
    const s = (await loadShop(t, { id: made.id }))!;
    const db = t.shop(s.schema);
    await db.query(`INSERT INTO products (name, sku, price) VALUES ('Vélo', 'VELO', 9000)`);
    shops.push({ id: s.id, db });
  }
  const [A, B] = shops;
  const owner = await as(t, A.id, 'karim@shops.dz', PW);
  const ownerB = await as(t, B.id, 'karim@shops.dz', PW);

  // Samira works in both
  const ag: Record<number, number> = {};
  for (const [s, c] of [[A, owner], [B, ownerB]] as const) {
    const u: any = await call('users.create', c, { name: 'Samira', email: AGENT, phone: s === A ? '0661000001' : '0661000002', roles: ['confirmation'], password: PW });
    ag[s.id] = Number(u.id ?? u.profile?.id ?? (await s.db.query(`SELECT id FROM profiles WHERE email = $1`, [AGENT]))[0].id);
    await s.db.query(`UPDATE profiles SET last_seen_at = now(), presence = 'online' WHERE id = $1`, [ag[s.id]]);
  }

  const g: any = await call('assign.get', owner, {});
  assert.deepEqual(g.shops.map((x: any) => x.name), ['Bébé Shop', 'Maison Shop']);
  const sam = g.conf.find((x: any) => x.id === ag[A.id]);
  assert.deepEqual(new Set(sam.shops), new Set([A.id, B.id]), 'she is seen in both boutiques');

  // 2 open orders in B count in A's maximum of 2
  const pB = Number((await B.db.query('SELECT id FROM products LIMIT 1'))[0].id);
  for (const ph of ['0770000001', '0770000002'])
    await call('orders.create', ownerB, { customerName: 'Client B', phone: ph, wilayaId: 16, commune: 'Kouba', address: 'Rue', items: [{ productId: pB, variantId: null, qty: 1 }] });
  await B.db.query('UPDATE orders SET agent_id = $1', [ag[B.id]]);

  const cfg = g.cfg;
  await call('assign.set', owner, { ...cfg, conf: { ...cfg.conf, mode: 'load', max: 2 } });
  const pA = Number((await A.db.query('SELECT id FROM products LIMIT 1'))[0].id);
  const mk = (ph: string) => call('orders.create', owner, { customerName: 'Client A', phone: ph, wilayaId: 16, commune: 'Kouba', address: 'Rue', items: [{ productId: pA, variantId: null, qty: 1 }] }) as Promise<any>;
  assert.equal((await mk('0770000011')).agentId, null, 'at her maximum with the orders of the other boutique');

  // she works for B only from now: written in both boutiques
  const agent = { out: false, weight: 1, channels: [], products: [], from: null, to: null, langs: [], senior: false, shops: [B.id] };
  await call('assign.set', owner, { ...cfg, conf: { ...cfg.conf, mode: 'load', max: 0 }, agents: { [ag[A.id]]: agent } });
  const inB: any = await call('assign.get', ownerB, {});
  assert.deepEqual(inB.cfg.agents[String(ag[B.id])].shops, [B.id], 'her boutiques are the same in B');
  assert.equal((await mk('0770000012')).agentId, null, 'nothing from A: not one of her boutiques');

  // both again: she gets A's order
  await call('assign.set', owner, { ...cfg, conf: { ...cfg.conf, mode: 'load', max: 0 }, agents: { [ag[A.id]]: { ...agent, shops: [] } } });
  assert.equal((await mk('0770000013')).agentId, ag[A.id]);
});
