// « Tous les vendeurs » (a confirmation agency) and « Toutes les boutiques » (a seller) put several shops' lists in one
// (fanout.ts: the same merges for both). What each shop answers beside its rows must come through the merge too —
// found missing on 27 Nov 2026: En cours' tries (an agency showed « 5/3 » for a seller who allows 6 tries), the
// counters over Confirmation's and Suivi's lists (not shown at all), Terminé's whole number (only the 30 days).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { loadShop, passwordFromLink } from '../platform';
import { getSetting, setSetting } from '../settings';

const OWNER = { email: 'owner@fan.dz', password: 'Owner-Password-1' };
const PW = 'Boutique-Password-1';
const SELLER = 'karim@fan.dz';
const AGENT = 'samira@fan.dz';

async function as(t: Tenancy, shopId: number, email: string, password: string, extra: Partial<Ctx> = {}): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, password), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t, ...extra };
}

/** two counters objects added key by key */
const add = (a: Record<string, number> | null, b: Record<string, number> | null) =>
  Object.fromEntries([...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].map((k) => [k, (a?.[k] ?? 0) + (b?.[k] ?? 0)]));

test('several shops in one list: each row keeps its shop’s tries, the counters and Livré’s whole number add up', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<any>;
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');

  // two boutiques of Karim
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
  // Bébé Shop allows 6 tries before « Client annule »; Maison Shop keeps the default
  await setSetting(A.db, 'calls', { ...(await getSetting(A.db, 'calls')), tries: 6 });
  const triesB = (await getSetting(B.db, 'calls')).tries;
  assert.notEqual(triesB, 6);

  const mk = (c: Ctx, pid: number, ph: string) => call('orders.create', c, { customerName: 'Client', phone: ph, wilayaId: 16, commune: 'Kouba', address: 'Rue', items: [{ productId: pid, variantId: null, qty: 1 }] });
  for (const ph of ['0770000001', '0770000002', '0770000003']) await mk(inA, A.product, ph);
  for (const ph of ['0770000004', '0770000005']) await mk(inB, B.product, ph);
  // En cours: one order of each, not answered (5 tries in Bébé Shop, 2 in Maison Shop)
  await A.db.query(`UPDATE orders SET conf_status = 'no_answer', attempts = 5 WHERE id = (SELECT min(id) FROM orders)`);
  await B.db.query(`UPDATE orders SET conf_status = 'no_answer', attempts = 2 WHERE id = (SELECT min(id) FROM orders)`);

  const all = await as(t, A.id, SELLER, PW, { boutique: 'all' });

  // ---- En cours: each row its own shop's tries (the shops differ)
  const enCours: any = await call('confirmation.list', all, { sub: 'attente', pageSize: 50 });
  assert.equal(enCours.rows.length, 2);
  for (const r of enCours.rows) assert.equal(r.tries, r.seller.id === A.id ? 6 : triesB, `the tries of ${r.seller.name}`);
  // one shop alone: the list's own number, and on its rows
  const onlyA: any = await call('confirmation.list', inA, { sub: 'attente', pageSize: 50 });
  assert.equal(onlyA.tries, 6);
  assert.ok(onlyA.rows.every((r: any) => r.tries === 6));

  // ---- the counters over the list (Nouvelles and En cours): both shops' added up, never left out
  for (const sub of ['nouvelles', 'attente'] as const) {
    const merged: any = await call('confirmation.list', all, { sub, pageSize: 50 });
    const a: any = await call('confirmation.list', inA, { sub, pageSize: 50 });
    const b: any = await call('confirmation.list', inB, { sub, pageSize: 50 });
    assert.ok(a.buckets && b.buckets, `one shop counts ${sub}`);
    assert.deepEqual(merged.buckets, add(a.buckets, b.buckets), `the counters of ${sub}`);
  }

  // ---- Suivi's counters (Nouvelles alertes): the same
  const sAll: any = await call('suivi.list', all, { tab: 'alertes_new', pageSize: 50 });
  const sA: any = await call('suivi.list', inA, { tab: 'alertes_new', pageSize: 50 });
  const sB: any = await call('suivi.list', inB, { tab: 'alertes_new', pageSize: 50 });
  assert.ok(sA.buckets && sB.buckets, 'one shop counts its alerts');
  assert.deepEqual(sAll.buckets, add(sA.buckets, sB.buckets));

  // ---- Livré's whole number: an agent sees 30 days of finished orders, the number counts them all
  await call('users.create', inA, { name: 'Samira', email: AGENT, phone: '0661000001', roles: ['confirmation'], password: PW });
  await call('users.create', inB, { name: 'Samira', email: AGENT, phone: '0661000002', roles: ['confirmation'], password: PW });
  for (const s of [A, B]) await s.db.query(`UPDATE orders SET agent_id = (SELECT id FROM profiles WHERE email = $1)`, [AGENT]);
  // delivered 60 days ago in Bébé Shop: out of the list, still in the number
  await A.db.query(`UPDATE orders SET conf_status = 'confirmed', follow_status = 'delivered', delivered_at = now() - interval '60 days' WHERE id = (SELECT max(id) FROM orders)`);
  const samA = await as(t, A.id, AGENT, PW);
  const samB = await as(t, B.id, AGENT, PW);
  const samAll = await as(t, A.id, AGENT, PW, { boutique: 'all' });
  const lA: any = await call('orders.list', samA, { pageSize: 50 });
  const lB: any = await call('orders.list', samB, { pageSize: 50 });
  assert.equal(lA.totalAll, lA.total + 1, 'the old delivered order counts, not listed');
  const lAll: any = await call('orders.list', samAll, { pageSize: 50 });
  assert.equal(lAll.total, lA.total + lB.total);
  assert.equal(lAll.totalAll, (lA.totalAll ?? lA.total) + (lB.totalAll ?? lB.total));
});
