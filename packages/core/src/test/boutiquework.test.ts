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

test('alerts from every boutique: a phone alert reaches the person’s devices of their other boutiques; a new order from the site says so', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<any>;
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
  const ids: number[] = [];
  for (const name of ['Bébé Shop', 'Maison Shop']) {
    const made = await p('p.shops.create', { name, ownerName: 'Karim', ownerEmail: SELLER, planId: biz.id, trialDays: 14 });
    if (made.mail?.token) await passwordFromLink(t, made.mail.token, PW);
    ids.push(made.id);
  }
  const [A, B] = ids;
  const sent: { endpoint: string; title: string; key: string }[] = [];
  const server: any = {
    hashPassword: async (x: string) => x,
    pushKeys: () => ({ publicKey: `pub-${Math.random()}`, privateKey: 'priv' }),
    push: async (k: any, subs: any[], payload: any) => {
      for (const s of subs) sent.push({ endpoint: s.endpoint, title: payload.title, key: k.publicKey });
      return subs.map((s) => ({ endpoint: s.endpoint, ok: true, gone: false }));
    },
  };
  const inA = await as(t, A, SELLER, PW, { server });
  const inB = await as(t, B, SELLER, PW, { server });
  await setSettingName(inA, 'Bébé Shop');
  // his phone turned on the notifications in Maison Shop only
  await call('push.key', inB, {});
  await call('push.subscribe', inB, { endpoint: 'https://push.example/phone-1', p256dh: 'p256dh-key-0123456789', auth: 'auth-key-01' });
  const { sendPush } = await import('../modules/push');
  const n = await sendPush(inA, [inA.session.profile.id], { title: 'Colis pris par Walid', body: 'x' });
  assert.equal(n, 1);
  assert.deepEqual(sent.map((s) => [s.endpoint, s.title]), [['https://push.example/phone-1', 'Bébé Shop · Colis pris par Walid']]);
  const bKey = (await call('push.key', inB, {}) as any).key;
  assert.equal(sent[0].key, bKey, 'signed with the keys of the boutique where the phone signed up');

  // an order from the shop's site: the event says it was created (the new-order toast, in every boutique of the person)
  const events: any[] = [];
  const pid = Number((await inA.db.query(`INSERT INTO products (name, sku, price) VALUES ('Vélo', 'VELO', 9000) RETURNING id`))[0].id);
  const site = { ...inA, emit: (e: any) => events.push(e) };
  const o: any = await call('orders.create', site, { customerName: 'Client', phone: '0770000099', wilayaId: 16, commune: 'Kouba', address: 'Rue', via: 'api', items: [{ productId: pid, variantId: null, qty: 1 }] });
  assert.ok(events.some((e) => e.type === 'orders' && e.data?.created?.ref === o.ref));
  // typed in the app by someone: no toast
  events.length = 0;
  await call('orders.create', site, { customerName: 'Client', phone: '0770000098', wilayaId: 16, commune: 'Kouba', address: 'Rue', items: [{ productId: pid, variantId: null, qty: 1 }] });
  assert.ok(!events.some((e) => e.data?.created));
});

async function setSettingName(c: Ctx, name: string) {
  const { getSetting, setSetting } = await import('../settings');
  await setSetting(c.db, 'shop', { ...(await getSetting(c.db, 'shop')), name });
}

test('the team: a new person made in the boutiques ticked, the same roles; « Boutiques » says where each person works', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<any>;
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
  const ids: number[] = [];
  for (const name of ['Bébé Shop', 'Maison Shop', 'Sport Shop']) {
    const made = await p('p.shops.create', { name, ownerName: 'Karim', ownerEmail: SELLER, planId: biz.id, trialDays: 14 });
    if (made.mail?.token) await passwordFromLink(t, made.mail.token, PW);
    ids.push(made.id);
  }
  const [A, B, C] = ids;
  const inA = await as(t, A, SELLER, PW);
  const user = { name: 'Nadia', email: 'nadia@shops.dz', phone: '0661000077', roles: ['confirmation', 'suivi'], password: PW };
  const made: any = await call('users.create', inA, user);
  const r: any[] = (await call('users.addToBoutiques', inA, { shops: [B, C, A], user })) as any[];
  assert.deepEqual(r.map((x) => [x.id, x.ok]).sort(), [[B, true], [C, true]].sort());
  const inB = await as(t, B, SELLER, PW);
  const nB = (await call('users.list', inB, {}) as any[]).find((u) => u.name === 'Nadia');
  assert.deepEqual([...nB.roles].sort(), ['confirmation', 'suivi']);
  // she logs in to B with the same password
  const sB = (await loadShop(t, { id: B }))!;
  assert.ok(await login(t.shop(sB.schema), 'nadia@shops.dz', PW));
  // twice in B: refused there, said in the answer
  const again: any[] = (await call('users.addToBoutiques', inA, { shops: [B], user })) as any[];
  assert.equal(again[0].ok, false);
  // « Boutiques »: Nadia works in the three, Karim too
  const where: any = await call('users.boutiques', inA, {});
  assert.deepEqual([...where[String(made.id)]].sort(), [A, B, C].sort());
  // someone who may not add people: nothing made, and no list
  await call('users.create', inA, { name: 'Rania', email: 'rania@shops.dz', phone: '0661000078', roles: ['confirmation'], password: PW });
  const rania = await as(t, A, 'rania@shops.dz', PW);
  assert.deepEqual(await call('users.boutiques', rania, {}), {});
  const none: any[] = (await call('users.addToBoutiques', rania, { shops: [B], user: { ...user, email: 'x@shops.dz', phone: '0661000079' } })) as any[];
  assert.equal(none.length, 0, 'Rania has no account in B');
});

test('« Toutes les boutiques » › Dépôt and Caisse: added up and boutique by boutique; a return received in its boutique', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<any>;
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
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
  const mk = async (c: Ctx, pid: number, ph: string, follow: string) => {
    const o: any = await call('orders.create', c, { customerName: 'Client', phone: ph, wilayaId: 16, commune: 'Kouba', address: 'Rue', items: [{ productId: pid, variantId: null, qty: 1 }] });
    await c.db.query(`UPDATE orders SET conf_status = 'confirmed', follow_status = $2, shipped_at = CASE WHEN $2 = 'returning' THEN now() END WHERE id = $1`, [o.id, follow]);
    return o;
  };
  await mk(inA, A.product, '0770000001', 'to_prepare');
  await mk(inB, B.product, '0770000002', 'to_prepare');
  await mk(inB, B.product, '0770000003', 'to_prepare');
  const back = await mk(inB, B.product, '0770000004', 'returning');

  // Dépôt: what waits at each stage, added up and boutique by boutique; the « Boutique » filter
  const all = await as(t, A.id, SELLER, PW, { boutique: 'all' });
  const dc: any = await call('depot.counts', all, {});
  assert.deepEqual([dc.preparer, dc.retours], [3, 1]);
  assert.deepEqual(dc.byBoutique.map((b: any) => [b.id, b.preparer, b.retours]).sort(), [[A.id, 1, 0], [B.id, 2, 1]].sort());
  const dcB: any = await call('depot.counts', all, { shops: [B.id] });
  assert.equal(dcB.preparer, 2);
  // the stage's orders from both boutiques
  const prep: any = await call('orders.list', all, { conf: ['confirmed'], follow: ['to_prepare'], pageSize: 50 });
  assert.equal(prep.total, 3);
  // a returned parcel scanned from A: found in B, received there (from A, inside B)
  const found: any[] = (await call('depot.find', all, { code: back.ref })) as any[];
  assert.deepEqual(found.map((o) => [o.id, o.seller.id]), [[back.id, B.id]]);
  const oneB = await as(t, A.id, SELLER, PW, { boutique: B.id });
  const got: any = await call('depot.receiveReturn', oneB, { id: back.id });
  assert.equal(got.followStatus, 'returned');
  assert.equal((await B.db.query('SELECT follow_status FROM orders WHERE id = $1', [back.id]))[0].follow_status, 'returned');
  // the depot's own work (scanning, sending to a company) stays in B's Dépôt
  await assert.rejects(call('depot.scan', oneB, { code: back.ref, mode: 'dispatch' }), /Ouvrez « Maison Shop »/);
  await assert.rejects(call('depot.dispatch', oneB, { ids: [back.id] }), /Ouvrez « Maison Shop »/);
  // À prendre: every boutique's products, each with its boutique; « J'ai pris » for B's orders, from A, runs in B
  const pl: any[] = (await call('depot.pickList', all, {})) as any[];
  assert.deepEqual(pl.map((r) => [r.seller.id, r.name, r.need]).sort(), [[A.id, 'Poussette', 1], [B.id, 'Lampe', 2]].sort());
  const took: any = await call('depot.pick', oneB, { productId: B.product, variantId: null, qty: 2 });
  assert.deepEqual([took.served, took.toAssign], [2, 2], 'both B orders picked whole, waiting for a company');
  assert.equal((await B.db.query(`SELECT count(*)::int AS n FROM order_items WHERE picked_qty = qty`))[0].n, 2);
  const pl2: any[] = (await call('depot.pickList', all, {})) as any[];
  assert.deepEqual(pl2.map((r) => r.seller.id), [A.id]);

  // Caisse: the main caisses added up, and boutique by boutique
  await call('caisse.add', inA, { caisse: 'main', kind: 'income', amount: 5000 });
  await call('caisse.add', inB, { caisse: 'main', kind: 'income', amount: 2000 });
  const co: any = await call('caisse.overview', all, {});
  assert.equal(co.main, 7000);
  assert.equal(co.today, 7000);
  assert.deepEqual(co.byBoutique.map((b: any) => [b.id, b.main]).sort(), [[A.id, 5000], [B.id, 2000]].sort());
  const coA: any = await call('caisse.overview', all, { shops: [A.id] });
  assert.deepEqual([coA.main, coA.byBoutique.length], [5000, 1]);
  // its money moves in its own caisse only
  await assert.rejects(call('caisse.add', oneB, { caisse: 'main', kind: 'income', amount: 1 }), /Ouvrez « Maison Shop »/);
  // Walid delivers for both boutiques: one livreur, what he must hand over in each and in all
  for (const [c, pid, ph] of [[inA, A.product, '0770000021'], [inB, B.product, '0770000022']] as const) {
    const w: any = await call('users.create', c, { name: 'Walid', email: 'walid@shops.dz', phone: ph.replace('077', '066'), roles: ['livreur'], password: PW });
    const o: any = await call('orders.create', c, { customerName: 'Client', phone: ph, wilayaId: 16, commune: 'Kouba', address: 'Rue', items: [{ productId: pid, variantId: null, qty: 1 }] });
    await c.db.query(`UPDATE orders SET conf_status = 'confirmed', follow_status = 'delivered', delivered_at = now(), shipped_at = now(), livreur_id = $2, cashed = false WHERE id = $1`, [o.id, w.id]);
  }
  const co2: any = await call('caisse.overview', all, {});
  const walid = co2.livreurs.filter((l: any) => l.name === 'Walid');
  assert.equal(walid.length, 1, 'one Walid');
  assert.deepEqual(walid[0].boutiques.map((b: any) => b.id).sort(), [A.id, B.id].sort());
  assert.equal(walid[0].notCashed, 2);
  assert.equal(walid[0].net, walid[0].boutiques.reduce((s: number, b: any) => s + b.net, 0));
  assert.ok(walid[0].net > 0);
  assert.ok(!JSON.stringify(co2).includes('walid@shops.dz'), 'no e-mail in the answer');
  // Samira (confirmation in both): no caisse anywhere, no depot
  await call('users.create', inA, { name: 'Samira', email: AGENT, phone: '0661000001', roles: ['confirmation'], password: PW });
  await call('users.create', inB, { name: 'Samira', email: AGENT, phone: '0661000002', roles: ['confirmation'], password: PW });
  const sam = await as(t, A.id, AGENT, PW, { boutique: 'all' });
  await assert.rejects(call('caisse.overview', sam, {}));
  await assert.rejects(call('depot.counts', sam, {}));
});
