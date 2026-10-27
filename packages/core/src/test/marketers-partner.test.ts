// Marketers: their own accounts, like the confirmation agencies but on their own (they never deal with an agency).
// A marketer signs up (or is made from a seller's account), Pilotix checks it, it finds a store by code (or the store
// finds it), the other side accepts; only the marketer sets prices, only the store gives products (several marketers
// may share one) and ad sets to its people; its people see the ads of their ad sets only, from the marketer's space;
// its month counts its ad sets (spend, delivered orders, net profit, « réussis ») and makes its bill.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCode } from '@pilotix/shared';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { confirmSignup, loadShop, membershipsOf, passwordFromLink, startSignup, storeChoices } from '../platform';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const PW = 'Marketer-Password-1';

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const t = pgliteTenancy(pg as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = <T = any>(name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<T>;
  return { t, p };
}

/** A logged-in person of a shop, as the server builds it (its shop's rules, the whole server's data). */
async function as(t: Tenancy, shopId: number, email: string, password: string): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, password), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t };
}

/** A store made from the control room, with three products. */
async function store(t: Tenancy, p: (n: string, i?: unknown) => Promise<any>, name: string, email: string) {
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
  const made = await p('p.shops.create', { name, ownerName: 'Karim', ownerEmail: email, planId: biz.id, trialDays: 14 });
  await passwordFromLink(t, made.mail.token, PW);
  const s = (await loadShop(t, { id: made.id }))!;
  const db = t.shop(s.schema);
  await db.query(`INSERT INTO products (name, sku, price) VALUES ('Vélo', 'VELO', 9000), ('Poussette', 'POUS', 12000), ('Casque', 'CASQ', 3000)`);
  const ids = (await db.query('SELECT id, sku FROM products ORDER BY id')).reduce((m: Record<string, number>, r: any) => ({ ...m, [r.sku]: Number(r.id) }), {});
  return { id: s.id, schema: s.schema, db, code: s.publicCode!, products: ids as Record<'VELO' | 'POUS' | 'CASQ', number> };
}

/** A marketer made by its owner on the sign-up page (« Marketer » chosen, e-mail confirmed). */
async function marketer(t: Tenancy, name: string, email: string) {
  const mail = await startSignup(t, { name: 'Yacine', email, password: PW, storeName: name, language: 'fr', terms: true, kind: 'marketer' }, null);
  assert.equal(mail?.kind, 'confirm');
  assert.equal((mail as any).marketer, true);
  const made: any = await confirmSignup(t, (mail as any).token);
  return { id: made.shop.id as number, schema: made.shop.schema as string, code: made.shop.publicCode as string };
}

const PRICES = { perConfirmed: 300, perDelivered: 200, perUpsell: 0, monthly: 0, bonusRate: { min: 0, amount: 0 }, bonusVolume: { above: 0, amount: 0 }, perSuccess: 15000, profitRate: 10 };
/** Algiers day / month now. */
const today = () => new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);

test('a marketer: its own account, checked by Pilotix, works for a store on the ad sets the store gives', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Oran', 'karim@oran.dz');
  const mk = await marketer(t, 'Yacine Ads', 'yacine@ads.dz');

  // its own kind: free (never expires, no plan), a code people type, not checked yet
  const sm = (await loadShop(t, { id: mk.id }))!;
  assert.equal(sm.kind, 'marketer');
  assert.equal(sm.neverExpires, true);
  assert.equal(sm.plan, null);
  assert.match(mk.code, /^MK-[A-Z2-9]{4}$/);
  assert.equal(cleanCode(mk.code.toLowerCase().replace('-', ' '), 'marketer'), mk.code);

  const chief = await as(t, mk.id, 'yacine@ads.dz', PW);
  const home0: any = await call('agency.home', chief, {});
  assert.deepEqual([home0.agency.kind, home0.agency.verified, home0.agency.code], ['marketer', false, mk.code]);
  // its space answers only its own actions: the ads need a seller, the orders are not its work
  await assert.rejects(call('mk.overview', chief, {}), /Choisissez un vendeur/);
  await assert.rejects(call('orders.list', chief, {}), /espace d’un marketer/);
  await assert.rejects(call('partners.home', chief, {}), /espace d’un marketer/);
  // its prices: only a marketer's pieces are kept
  await call('agency.prices', chief, { prices: PRICES });
  const home1: any = await call('agency.home', chief, {});
  assert.deepEqual([home1.agency.prices.perConfirmed, home1.agency.prices.perDelivered, home1.agency.prices.perSuccess, home1.agency.prices.profitRate], [0, 200, 15000, 10]);
  // before Pilotix checks it: it cannot ask, and stores do not find it
  const found: any = await call('agency.find', chief, { code: shop.code });
  await assert.rejects(call('agency.request', chief, { storeId: found.store.id, tasks: ['marketing'] }), /espace marketer doit d’abord être vérifié/);
  const admin = await as(t, shop.id, 'karim@oran.dz', PW);
  await assert.rejects(call('partners.find', admin, { code: mk.code }), /pas encore vérifié/);

  // the control room: marketers on their own page, « Vérifier »
  assert.deepEqual((await p<any[]>('p.agencies.list', { kind: 'marketer' })).map((a) => [a.name, a.kind, a.verifiedAt]), [['Yacine Ads', 'marketer', null]]);
  assert.deepEqual(await p<any[]>('p.agencies.list', { kind: 'agency' }), []);
  assert.equal((await p<any[]>('p.shops.list')).some((s) => s.id === mk.id), false);
  await p('p.agencies.verify', { id: mk.id, verified: true });

  // the store finds it by its code (typed any way) and sees its prices; it gives the Vélo
  const f: any = await call('partners.find', admin, { code: mk.code.toLowerCase().replace('-', '') });
  assert.deepEqual([f.agency.kind, f.agency.name, f.agency.prices.perSuccess], ['marketer', 'Yacine Ads', 15000]);
  const { id: linkId } = (await call('partners.request', admin, { agencyId: mk.id, tasks: ['confirmation'], products: [shop.products.VELO] })) as any;
  const asked: any = await call('partners.link', admin, { id: linkId });
  // a marketer's work is always the ads (whatever the tasks sent)
  assert.deepEqual([asked.link.kind, asked.link.tasks], ['marketer', ['marketing']]);
  const ans: any = await call('agency.answer', chief, { id: linkId, accept: true });
  assert.deepEqual(ans.problems, []);

  // its team, added in Utilisateurs: a marketer (media buyer) — never a confirmation agent
  await assert.rejects(call('users.create', chief, { name: 'Nora', email: 'nora@ads.dz', password: PW, roles: ['confirmation'] }), /espace marketer/);
  const nadir: any = await call('users.create', chief, { name: 'Nadir', email: 'nadir@ads.dz', password: PW, roles: ['marketer'] });
  await call('agency.setAgents', chief, { id: linkId, people: [nadir.id] });
  const inStore = (await shop.db.query(`SELECT id, roles, agency_id, agency_products, active FROM profiles WHERE email = 'nadir@ads.dz'`))[0];
  assert.deepEqual([inStore.roles, Number(inStore.agency_id), (inStore.agency_products ?? []).map(Number), inStore.active], [['marketer'], mk.id, [shop.products.VELO], true]);
  // the marketer's price per ad set « réussi » is the one the store's Marketer page uses
  assert.equal(Number((await shop.db.query('SELECT price FROM marketer_prices WHERE profile_id = $1', [inStore.id]))[0].price), 15000);
  // one login: Nadir lands in the marketer's space; the store is reached from there, never opened itself
  assert.deepEqual((await membershipsOf(t, 'nadir@ads.dz')).map((m) => m.shopId).sort(), [shop.id, mk.id].sort());
  assert.deepEqual((await storeChoices(t, 'nadir@ads.dz')).map((c) => [c.name, c.kind]), [['Yacine Ads', 'marketer']]);

  // the store gives Nadir an ad set selling the Vélo; Meta's results and the month's orders (all delivered)
  await shop.db.query(`INSERT INTO adsets (id, name, campaign, product_ids, marketer_id, status) VALUES ('AS-1', 'Vélo — Oran 25-45', 'Vélos', $1, NULL, 'PAUSED'), ('AS-2', 'Poussette — mamans', 'Bébé', $2, NULL, 'ACTIVE')`, [
    [shop.products.VELO],
    [shop.products.POUS],
  ]);
  const day = today();
  await shop.db.query(`INSERT INTO ad_insights (day, adset_id, spend_cents, impressions, clicks, purchases) VALUES ($1, 'AS-1', 5000, 10000, 200, 10), ($1, 'AS-2', 3000, 8000, 150, 6)`, [day]);
  await shop.db.query(`INSERT INTO fx_rates (ym, rate) VALUES ($1, 250) ON CONFLICT (ym) DO UPDATE SET rate = 250`, [day.slice(0, 7)]);
  for (let i = 0; i < 5; i++)
    await call('orders.create', admin, { customerName: `Client ${i}`, phone: `055000010${i}`, wilayaId: 31, commune: 'Oran', items: [{ productId: shop.products.VELO, variantId: null, qty: 1 }] });
  await shop.db.query(`UPDATE orders SET conf_status = 'confirmed', confirmed_at = now(), follow_status = 'delivered', delivered_at = now()`);
  const given: any = await call('mk.assign', admin, { ids: ['AS-1'], marketerId: Number(inStore.id) });
  assert.equal(given.n, 1);
  // the store cannot change the marketer's price, nor pay his ad sets one by one (his monthly bill does)
  await assert.rejects(call('mk.price', admin, { marketerId: Number(inStore.id), price: 1000 }), /fixe lui-même ses prix/);
  await assert.rejects(call('mk.pay', admin, { ids: ['AS-1'] }), /facture mensuelle/);
  const own: any = await call('mk.overview', admin, {});
  const row = own.rows.find((r: any) => r.id === 'AS-1');
  assert.deepEqual([row.partnerId, row.owe, row.final, row.ok], [mk.id, null, true, true]);
  assert.equal(own.marketers.find((m: any) => m.id === Number(inStore.id)).partner.name, 'Yacine Ads');

  // Nadir, from the marketer's space, with the store chosen at the top: his ad set only
  const nadirCtx = await as(t, mk.id, 'nadir@ads.dz', PW);
  const sellers: any[] = (await call('agency.sellers', nadirCtx, {})) as any;
  assert.deepEqual(sellers.map((s) => [s.name, s.tasks]), [['Boutique Oran', ['marketing']]]);
  const mine: any = await call('mk.overview', { ...nadirCtx, seller: shop.id }, {});
  assert.deepEqual(mine.rows.map((r: any) => r.id), ['AS-1']);
  assert.equal(mine.owner, false);
  const pub: any = await call('ads.overview', { ...nadirCtx, seller: shop.id }, { from: day, to: day });
  assert.deepEqual(pub.adsets.map((a: any) => a.id), ['AS-1']);
  // the products the store gave only (to link his ad sets to)
  assert.deepEqual(pub.catalog.map((c: any) => c.id), [shop.products.VELO]);
  await shop.db.query(`INSERT INTO adsets (id, name, product_ids, marketer_id, status) VALUES ('AS-3', 'Test', '{}', $1, 'ACTIVE')`, [Number(inStore.id)]);
  await assert.rejects(call('ads.link', { ...nadirCtx, seller: shop.id }, { adsetId: 'AS-3', productIds: [shop.products.POUS] }), /pas confié/);
  await call('ads.link', { ...nadirCtx, seller: shop.id }, { adsetId: 'AS-3', productIds: [shop.products.VELO] });
  // nothing else of the store: no orders, no customers, no team
  await assert.rejects(call('orders.list', { ...nadirCtx, seller: shop.id }, {}), /espace d’un marketer/);
  const inside = await as(t, shop.id, 'nadir@ads.dz', PW);
  await assert.rejects(call('orders.list', inside, {}), /équipe de la boutique/);
  await assert.rejects(call('users.list', inside, {}), /équipe de la boutique/);
  // « Tous les vendeurs »: every ad set of every seller, each with its seller
  const all: any = await call('mk.overview', { ...nadirCtx, seller: 'all' }, {});
  assert.deepEqual(all.rows.map((r: any) => [r.id, r.seller.name]), [['AS-1', 'Boutique Oran']]);

  // the marketer's chief works there too: he sees every ad set of his team (never a role of the store's own team)
  await call('agency.setAgents', chief, { id: linkId, people: [nadir.id, chief.session.profile.id] });
  const boss = (await shop.db.query(`SELECT roles, agency_lead FROM profiles WHERE email = 'yacine@ads.dz'`))[0];
  assert.deepEqual([boss.roles, boss.agency_lead], [['marketer'], true]);
  assert.equal((await shop.db.query(`SELECT agency_lead FROM profiles WHERE email = 'nadir@ads.dz'`))[0].agency_lead, false);
  const team: any = await call('mk.overview', { ...chief, seller: shop.id }, {});
  assert.deepEqual(team.rows.map((r: any) => r.id), ['AS-1']);
  assert.deepEqual(team.marketers.map((m: any) => m.name).sort(), ['Nadir', 'Yacine']);

  // the month: his ad sets (spend, delivered, net profit, « réussis ») and the bill with the marketer's prices
  const d: any = await call('agency.link', chief, { id: linkId });
  assert.deepEqual([d.counts.adsets, d.counts.spend, d.counts.orders, d.counts.delivered, d.counts.successes], [1, 12500, 5, 5, 1]);
  assert.ok(d.counts.net > 0);
  assert.deepEqual(
    d.bill.lines.map((l: any) => [l.key, l.qty, l.price]),
    [
      ['perDelivered', 5, 200],
      ['perSuccess', 1, 15000],
      ['profitRate', d.counts.net, 10],
    ],
  );
  assert.equal(d.bill.total, 1000 + 15000 + Math.round(d.counts.net / 10));
  const billing: any = await call('agency.billing', chief, {});
  assert.equal(billing.rows[0].bill.total, d.bill.total);
  // asked, paid by the store (outside Pilotix), received
  await call('agency.billRequest', chief, { id: linkId, month: d.month });
  const sd: any = await call('partners.link', admin, { id: linkId });
  assert.deepEqual([sd.bills[0].amount, sd.bills[0].status], [d.bill.total, 'requested']);
  await call('partners.billPaid', admin, { billId: sd.bills[0].id });
  await call('agency.billReceived', chief, { billId: sd.bills[0].id });
  assert.equal(((await call('partners.link', admin, { id: linkId })) as any).bills[0].status, 'received');

  // the store ends it: Nadir's account there closes, his ad sets stay with the store
  await call('partners.end', admin, { id: linkId });
  assert.equal((await shop.db.query(`SELECT active FROM profiles WHERE email = 'nadir@ads.dz'`))[0].active, false);
  assert.equal(Number((await shop.db.query(`SELECT marketer_id FROM adsets WHERE id = 'AS-1'`))[0].marketer_id), Number(inStore.id));
  await assert.rejects(call('mk.overview', { ...nadirCtx, seller: shop.id }, {}), /ne travaillez pas pour ce vendeur/);
});

test('marketers and agencies never meet; several marketers can share a product', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Sétif', 'omar@setif.dz');
  const admin = await as(t, shop.id, 'omar@setif.dz', PW);
  const a = await marketer(t, 'Ads Est', 'a@ads.dz');
  const b = await marketer(t, 'Ads Ouest', 'b@ads.dz');
  for (const m of [a, b]) {
    await p('p.agencies.verify', { id: m.id, verified: true });
    await call('agency.prices', await as(t, m.id, m === a ? 'a@ads.dz' : 'b@ads.dz', PW), { prices: { ...PRICES, perSuccess: 0, profitRate: 0 } });
  }
  // the same product to two marketers: each one is judged on its own ad sets
  await call('partners.request', admin, { agencyId: a.id, tasks: ['marketing'], products: [shop.products.VELO] });
  await call('partners.request', admin, { agencyId: b.id, tasks: ['marketing'], products: [shop.products.VELO] });
  // an agency's code is not a marketer's (and the other way round)
  await assert.rejects(call('partners.find', admin, { code: a.code, kind: 'agency' }), /Aucune agence/);
  const h: any = await call('partners.home', admin, {});
  assert.deepEqual(h.links.map((l: any) => l.kind), ['marketer', 'marketer']);
  // a marketer's space never sees an agency's actions on orders, nor a store's settings
  const ca = await as(t, a.id, 'a@ads.dz', PW);
  await assert.rejects(call('confirmation.list', { ...ca, seller: 'all' }, { sub: 'nouvelles' }), /espace d’un marketer/);
  await assert.rejects(call('admin.statuses.get', ca, {}), /espace d’un marketer/);
});

test('« Créer mon espace marketer » from a seller’s account: one per person, never a store of the plan', async () => {
  const { t, p } = await server();
  await store(t, p, 'Boutique Tlemcen', 'reda@tlemcen.dz');
  const { addStore, accountByEmail, shopInfoExtra, platformSettings } = await import('../platform');
  const acc = (await accountByEmail(t, 'reda@tlemcen.dz'))!;
  const m = await addStore(t, acc, { name: 'Reda Ads', kind: 'marketer' });
  assert.equal(m.kind, 'marketer');
  assert.equal(m.plan, null);
  assert.match(m.publicCode!, /^MK-/);
  await assert.rejects(addStore(t, acc, { name: 'Reda Ads 2', kind: 'marketer' }), /déjà un espace marketer/);
  // an agency too is still possible: two different jobs
  const ag = await addStore(t, acc, { name: 'Reda Call', kind: 'agency' });
  assert.equal(ag.kind, 'agency');
  assert.deepEqual((await storeChoices(t, 'reda@tlemcen.dz')).map((c) => [c.name, c.kind, c.owner]), [
    ['Reda Ads', 'marketer', true],
    ['Reda Call', 'agency', true],
    ['Boutique Tlemcen', 'store', true],
  ]);
  const extra = await shopInfoExtra(t, m, 'reda@tlemcen.dz', await platformSettings(t));
  assert.deepEqual([extra.canAddMarketer, extra.canAddAgency], [false, false]);
});
