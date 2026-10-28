// Confirmation agencies: an agency signs up, Pilotix checks it, it finds a store by code (or the store finds it), the
// other side accepts; only the agency sets prices, only the store gives products and tasks; orders go by their first
// product; the agency's agents work inside the store on its orders only; numbers, bills, suspension, the end.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanCode } from '@pilotix/shared';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { confirmSignup, loadShop, membershipsOf, passwordFromLink, startSignup, storeChoices } from '../platform';
import { computePayroll } from '../modules/admin';

/** a new team member's phone (required, one per person) */
let phoneN = 0;
const tph = () => `071${String(++phoneN).padStart(7, '0')}`;

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const PW = 'Agence-Password-1';

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

/** A store made from the control room, with two products. */
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

/** An agency made by its owner (« Créer mon agence »: e-mail confirmed). */
async function agency(t: Tenancy, name: string, email: string) {
  const mail = await startSignup(t, { name: 'Samir', email, phone: tph(), password: PW, storeName: name, language: 'fr', terms: true, kind: 'agency' }, null);
  assert.equal(mail?.kind, 'confirm');
  const made: any = await confirmSignup(t, (mail as any).token);
  return { id: made.shop.id as number, schema: made.shop.schema as string, code: made.shop.publicCode as string };
}

const PRICES = { perConfirmed: 0, perDelivered: 150, perUpsell: 50, monthly: 0, bonusRate: { min: 70, amount: 20 }, bonusVolume: { above: 0, amount: 0 } };
const order = (ctx: Ctx, productId: number, phone: string) =>
  call('orders.create', ctx, { customerName: 'Client', phone, wilayaId: 31, commune: 'Oran', items: [{ productId, variantId: null, qty: 1 }] }) as Promise<any>;

test('an agency: signs up, checked by Pilotix, works for a store on the products it is given', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Oran', 'karim@oran.dz');
  const ag = await agency(t, 'Agence Rapide', 'samir@agence.dz');

  // its own kind: free (never expires, no plan), a code people type, not checked yet
  const sa = (await loadShop(t, { id: ag.id }))!;
  assert.equal(sa.kind, 'agency');
  assert.equal(sa.neverExpires, true);
  assert.equal(sa.plan, null);
  assert.match(ag.code, /^AG-[A-Z2-9]{4}$/);
  assert.match(shop.code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  assert.equal(cleanCode(ag.code.toLowerCase().replace('-', ' '), 'agency'), ag.code);
  assert.equal(cleanCode(shop.code.replace('-', ''), 'store'), shop.code);

  const chief = await as(t, ag.id, 'samir@agence.dz', PW);
  const home0: any = await call('agency.home', chief, {});
  assert.equal(home0.agency.verified, false);
  assert.equal(home0.agency.code, ag.code);
  // an agency's space answers only its own actions
  await assert.rejects(call('orders.list', chief, {}), /Choisissez un vendeur/);
  await assert.rejects(call('partners.home', chief, {}), /espace d’une agence/);
  // before Pilotix checks it: it cannot ask, and stores do not find it
  await call('agency.prices', chief, { prices: PRICES });
  const found: any = await call('agency.find', chief, { code: shop.code.toLowerCase() });
  assert.equal(found.store.name, 'Boutique Oran');
  await assert.rejects(call('agency.request', chief, { storeId: found.store.id, tasks: ['confirmation'] }), /vérifiée/);
  const admin = await as(t, shop.id, 'karim@oran.dz', PW);
  await assert.rejects(call('partners.find', admin, { code: ag.code }), /pas encore vérifiée/);
  // a store's actions are not an agency's
  await assert.rejects(call('agency.home', admin, {}), /agences de confirmation/);

  // the control room: the list of agencies, « Vérifier »
  const list: any[] = await p('p.agencies.list');
  assert.deepEqual(list.map((a) => [a.name, a.verifiedAt]), [['Agence Rapide', null]]);
  assert.equal((await p<any[]>('p.shops.list')).some((s) => s.id === ag.id), false);
  await p('p.agencies.verify', { id: ag.id, verified: true });

  // the store finds it by its code (as typed: lower case, no dash) and sees its prices
  const f: any = await call('partners.find', admin, { code: ag.code.toLowerCase().replace('-', '') });
  assert.equal(f.agency.name, 'Agence Rapide');
  assert.equal(f.agency.prices.perDelivered, 150);
  assert.equal(f.link, null);
  // it asks for the confirmation of one product
  const { id: linkId } = (await call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation'], products: [shop.products.VELO] })) as any;
  await assert.rejects(call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation'], products: null }), /existe déjà/);
  // only the agency answers a store's request
  await assert.rejects(call('partners.answer', admin, { id: linkId, accept: true }), /n’attend plus/);
  const ans: any = await call('agency.answer', chief, { id: linkId, accept: true });
  assert.deepEqual(ans.problems, []);

  // the agency's team, added in Utilisateurs like any account: a confirmation agent, a suivi agent (every seller)
  const nora: any = await call('users.create', chief, { phone: tph(), name: 'Nora', email: 'nora@agence.dz', password: PW, roles: ['confirmation'] });
  const ali: any = await call('users.create', chief, { phone: tph(), name: 'Ali', email: 'ali@agence.dz', password: PW, roles: ['suivi'] });
  assert.equal(nora.agencySellers, null);
  // the store gives only the confirmation: Ali has nothing to do there
  await assert.rejects(call('agency.setAgents', chief, { id: linkId, people: [nora.id, ali.id] }), /rôle confirmation/);
  await assert.rejects(call('users.create', chief, { phone: tph(), name: 'Lyes', email: 'lyes@agence.dz', password: PW, roles: ['depot'] }), /agence de confirmation/);
  const inStore = (await shop.db.query(`SELECT name, roles, agency_id, active FROM profiles WHERE email = 'nora@agence.dz'`))[0];
  assert.deepEqual([inStore.roles, Number(inStore.agency_id), inStore.active], [['confirmation'], ag.id, true]);
  assert.equal((await shop.db.query(`SELECT 1 FROM profiles WHERE email = 'ali@agence.dz'`)).length, 0);
  // one login: Nora lands in her agency's space; the store is reached from there, never opened itself
  assert.deepEqual((await membershipsOf(t, 'nora@agence.dz')).map((m) => m.shopId).sort(), [shop.id, ag.id].sort());
  assert.deepEqual((await storeChoices(t, 'nora@agence.dz')).map((c) => [c.name, c.kind]), [['Agence Rapide', 'agency']]);
  const noraAgency = await as(t, ag.id, 'nora@agence.dz', PW);
  assert.deepEqual(((await call('agency.sellers', noraAgency, {})) as any[]).map((x) => [x.id, x.name, x.tasks]), [[shop.id, 'Boutique Oran', ['confirmation']]]);
  assert.deepEqual(((await call('agency.sellers', await as(t, ag.id, 'ali@agence.dz', PW), {})) as any[]).length, 0);
  // her home has no prices, no money
  const nh: any = await call('agency.home', noraAgency, {});
  assert.deepEqual([nh.lead, nh.links.length, nh.agency.prices], [false, 0, null]);

  // orders go by their first product: the Vélo to the agency, the Poussette stays with the store's team
  const o1 = await order(admin, shop.products.VELO, '0661000001');
  const o2 = await order(admin, shop.products.POUS, '0661000002');
  assert.equal(o1.confAgencyId, ag.id);
  assert.equal(o2.confAgencyId, null);

  // Nora from her agency's space, the store chosen at the top: only the agency's orders, only the confirmation work
  const n: Ctx = { ...noraAgency, seller: shop.id };
  assert.deepEqual(((await call('orders.list', n, {})) as any).rows.map((o: any) => o.id), [o1.id]);
  assert.deepEqual(((await call('confirmation.list', n, { sub: 'nouvelles' })) as any).rows.map((o: any) => o.id), [o1.id]);
  assert.equal(((await call('confirmation.counts', n, {})) as any).nouvelles, 1);
  assert.equal(((await call('orders.counts', n, {})) as any).all, 1);
  await assert.rejects(call('orders.get', n, { id: o2.id }), /pas confiée à votre agence/);
  await assert.rejects(call('orders.setConf', n, { ids: [o2.id], status: 'confirmed' }), /pas confiée à votre agence/);
  await assert.rejects(call('customers.history', n, { phone: '0661000002' }), /pas un client de votre agence/);
  await call('customers.history', n, { phone: '0661000001' });
  await assert.rejects(call('admin.statuses.get', n, {}), /espace d’une agence/);
  await assert.rejects(call('partners.home', n, {}), /Accès refusé|espace d’une agence/);
  // a store she does not work for: refused
  await assert.rejects(call('orders.list', { ...noraAgency, seller: shop.id + 1000 }, {}), /ne travaillez pas pour ce vendeur/);
  // « Tous les vendeurs »: the same orders, each with its seller
  const all: Ctx = { ...noraAgency, seller: 'all' };
  assert.deepEqual(((await call('confirmation.list', all, { sub: 'nouvelles' })) as any).rows.map((o: any) => [o.id, o.seller.name]), [[o1.id, 'Boutique Oran']]);
  assert.equal(((await call('confirmation.counts', all, {})) as any).nouvelles, 1);
  await assert.rejects(call('orders.get', all, { id: o1.id }), /Choisissez un vendeur/);
  // the agency's own people working here (the chief works for every seller)
  assert.deepEqual(((await call('users.list', n, {})) as any[]).map((u) => u.name), ['Nora', 'Samir']);
  assert.equal(((await call('orders.next', n, {})) as any).id, o1.id);
  await call('confirmation.release', n, { id: o1.id });
  assert.deepEqual(await call('orders.next', all, {}), { id: o1.id, seller: shop.id });
  await call('confirmation.release', n, { id: o1.id });
  await call('orders.setConf', n, { ids: [o1.id], status: 'confirmed' });

  // the store's own agent: the orders no agency handles
  await call('users.create', admin, { phone: tph(), name: 'Samia', email: 'samia@oran.dz', password: PW, roles: ['confirmation'] });
  const own = await as(t, shop.id, 'samia@oran.dz', PW);
  const o3 = await order(admin, shop.products.VELO, '0661000003');
  assert.deepEqual(((await call('confirmation.list', own, { sub: 'nouvelles' })) as any).rows.map((o: any) => o.id), [o2.id]);
  assert.equal(((await call('orders.next', own, {})) as any).id, o2.id);
  // the administrator sees every order, the team list without the agency's agents (unless asked)
  assert.equal(((await call('confirmation.list', admin, { sub: 'nouvelles' })) as any).rows.length, 2);
  const team = ((await call('users.list', admin, {})) as any[]).map((u) => u.name);
  assert.ok(team.includes('Samia') && !team.includes('Nora'));
  assert.ok(((await call('users.list', admin, { agencies: true })) as any[]).some((u) => u.name === 'Nora'));
  // the store never edits an agency's account
  const noraId = Number((await shop.db.query(`SELECT id FROM profiles WHERE email = 'nora@agence.dz'`))[0].id);
  await assert.rejects(call('users.update', admin, { id: noraId, name: 'Xavier' }), /appartient à une agence/);
  await assert.rejects(call('admin.users.resetPassword', admin, { id: noraId }), /appartient à une agence/);
  assert.equal(((await call('archive.list', admin, { kind: 'users' })) as any[]).some((r) => r.id === noraId), false);

  // the numbers: o1 delivered → the agency's bill (per delivered + the rate bonus: 100 % ≥ 70 %)
  await shop.db.query(`UPDATE orders SET follow_status = 'delivered', delivered_at = now(), has_upsell = true WHERE id = $1`, [o1.id]);
  const d: any = await call('agency.link', chief, { id: linkId });
  assert.deepEqual([d.counts.received, d.counts.confirmed, d.counts.delivered, d.counts.upsells], [2, 1, 1, 1]);
  assert.equal(d.bill.total, 150 + 50 + 20);
  // the store's own payslips never pay the agency's agents
  const pay = await computePayroll(shop.db, d.month);
  assert.equal(pay.agents.some((a: any) => a.id === noraId), false);
  // « Demander le paiement » → « Payé » (the store) → « Reçu » (the agency)
  await call('agency.billRequest', chief, { id: linkId, month: d.month });
  const sd: any = await call('partners.link', admin, { id: linkId });
  assert.deepEqual(sd.bills.map((b: any) => [b.amount, b.status]), [[220, 'requested']]);
  await call('partners.billPaid', admin, { billId: sd.bills[0].id });
  await call('agency.billReceived', chief, { billId: sd.bills[0].id });
  await assert.rejects(call('agency.billRequest', chief, { id: linkId, month: d.month }), /déjà payé/);

  // only the agency changes its prices; the old ones stay until the store says yes
  await call('agency.linkPrices', chief, { id: linkId, prices: { ...PRICES, perDelivered: 200 } });
  const l1: any = await call('partners.link', admin, { id: linkId });
  assert.deepEqual([l1.link.prices.perDelivered, l1.link.pricesNew.perDelivered], [150, 200]);
  await call('partners.acceptPrices', admin, { id: linkId });
  assert.deepEqual([((await call('partners.link', admin, { id: linkId })) as any).link.prices.perDelivered], [200]);

  // a second agency: never the same product for the same task; « every product » for the rest
  const ag2 = await agency(t, 'Call Center Sétif', 'lina@setif.dz');
  await p('p.agencies.verify', { id: ag2.id, verified: true });
  const chief2 = await as(t, ag2.id, 'lina@setif.dz', PW);
  await call('agency.prices', chief2, { prices: { ...PRICES, perConfirmed: 40, perDelivered: 0 } });
  const req2: any = await call('agency.request', chief2, { storeId: shop.id, tasks: ['confirmation', 'suivi'] });
  await assert.rejects(call('partners.answer', admin, { id: req2.id, accept: true, products: [shop.products.VELO] }), /Déjà confié à Agence Rapide pour la confirmation : Vélo/);
  await call('partners.answer', admin, { id: req2.id, accept: true, products: null });
  const o4 = await order(admin, shop.products.VELO, '0661000004');
  const o5 = await order(admin, shop.products.CASQ, '0661000005');
  assert.deepEqual([o4.confAgencyId, o4.followAgencyId], [ag.id, ag2.id]);
  assert.deepEqual([o5.confAgencyId, o5.followAgencyId], [ag2.id, ag2.id]);

  // Pilotix suspends the first agency: Nora stops at once, its unconfirmed orders go back to the store's team
  await p('p.shops.setStatus', { id: ag.id, status: 'suspended', reason: 'test' });
  await assert.rejects(login(shop.db, 'nora@agence.dz', PW), /désactivé/);
  assert.equal(Number((await shop.db.query('SELECT count(*)::int AS n FROM orders WHERE conf_agency_id = $1 AND conf_status = $2', [ag.id, 'new']))[0].n), 0);
  // the confirmed one stays counted for the agency (it gets paid when it is delivered)
  assert.equal(Number((await shop.db.query('SELECT conf_agency_id FROM orders WHERE id = $1', [o1.id]))[0].conf_agency_id), ag.id);
  // new Vélo orders: the other agency has every product now
  assert.equal((await order(admin, shop.products.VELO, '0661000006')).confAgencyId, ag2.id);
  await p('p.shops.setStatus', { id: ag.id, status: 'active' });
  assert.equal((await shop.db.query(`SELECT active FROM profiles WHERE email = 'nora@agence.dz'`))[0].active, true);
  assert.equal((await order(admin, shop.products.VELO, '0661000007')).confAgencyId, ag.id);

  // the agency closes Nora's account in its team: she stops in the store too
  const noraAg = Number((await t.shop(ag.schema).query(`SELECT id FROM profiles WHERE email = 'nora@agence.dz'`))[0].id);
  await call('users.update', chief, { id: noraAg, active: false });
  assert.equal((await shop.db.query(`SELECT active FROM profiles WHERE email = 'nora@agence.dz'`))[0].active, false);
  await call('users.update', chief, { id: noraAg, active: true });
  assert.equal((await shop.db.query(`SELECT active FROM profiles WHERE email = 'nora@agence.dz'`))[0].active, true);

  // the store ends the contract: the agent stops, products go back, unfinished orders come back to its team
  await call('partners.end', admin, { id: linkId });
  assert.equal((await shop.db.query(`SELECT active FROM profiles WHERE email = 'nora@agence.dz'`))[0].active, false);
  assert.equal(Number((await shop.db.query('SELECT count(*)::int AS n FROM agency_routes WHERE agency_id = $1', [ag.id]))[0].n), 0);
  assert.equal(Number((await shop.db.query(`SELECT count(*)::int AS n FROM orders WHERE conf_agency_id = $1 AND conf_status = 'new'`, [ag.id]))[0].n), 0);
  const after: any = await call('agency.home', chief, {});
  assert.equal(after.links.find((l: any) => l.id === linkId).status, 'ended');
  assert.equal(after.links.find((l: any) => l.id === linkId).endedBy, 'store');
  await assert.rejects(call('partners.end', admin, { id: linkId }), /plus actif/);
  void o3;
});

test('an agency asks a store: its prices for that store; the store chooses what it gives', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Alger', 'nadir@alger.dz');
  const ag = await agency(t, 'Agence Est', 'yasmine@est.dz');
  await p('p.agencies.verify', { id: ag.id, verified: true });
  const chief = await as(t, ag.id, 'yasmine@est.dz', PW);
  const admin = await as(t, shop.id, 'nadir@alger.dz', PW);
  // no prices yet: it cannot ask
  const f: any = await call('agency.find', chief, { code: shop.code });
  await assert.rejects(call('agency.request', chief, { storeId: f.store.id, tasks: ['confirmation'] }), /vos prix/);
  // its prices for this store (from its usual prices)
  const r: any = await call('agency.request', chief, { storeId: f.store.id, tasks: ['confirmation'], prices: { ...PRICES, monthly: 30000 } });
  // the store sees it, refuses once, the agency asks again with other prices, the store accepts with two products
  const h: any = await call('partners.home', admin, {});
  assert.equal(h.code, shop.code);
  assert.deepEqual(h.links.map((l: any) => [l.status, l.requestedBy, l.prices.monthly]), [['pending', 'agency', 30000]]);
  await call('partners.answer', admin, { id: r.id, accept: false });
  const r2: any = await call('agency.request', chief, { storeId: shop.id, tasks: ['confirmation'], prices: { ...PRICES, monthly: 25000 } });
  await call('agency.linkPrices', chief, { id: r2.id, prices: { ...PRICES, monthly: 20000 } }); // not answered yet: changed at once
  await call('partners.answer', admin, { id: r2.id, accept: true, products: [shop.products.VELO, shop.products.CASQ] });
  const d: any = await call('partners.link', admin, { id: r2.id });
  assert.deepEqual([d.link.status, d.link.prices.monthly, d.link.products], ['active', 20000, [shop.products.VELO, shop.products.CASQ]]);
  // the fixed amount counts in the month it works
  assert.equal(d.bill.total, 20000);
  // the store changes what it gives at any time: suivi too, every product
  await call('partners.setWork', admin, { id: r2.id, tasks: ['confirmation', 'suivi'], products: null });
  const o = await order(admin, shop.products.POUS, '0662000001');
  assert.deepEqual([o.confAgencyId, o.followAgencyId], [ag.id, ag.id]);
  // the agency ends it: the store's own team gets the order back
  await call('agency.end', chief, { id: r2.id });
  const back = (await shop.db.query('SELECT conf_agency_id, follow_agency_id FROM orders WHERE id = $1', [o.id]))[0];
  assert.deepEqual([back.conf_agency_id, back.follow_agency_id], [null, null]);
  // the other side's links are not found
  const other = await store(t, p, 'Boutique Blida', 'omar@blida.dz');
  const admin2 = await as(t, other.id, 'omar@blida.dz', PW);
  await assert.rejects(call('partners.link', admin2, { id: r2.id }), /introuvable/);
  await assert.rejects(call('partners.end', admin2, { id: r2.id }), /introuvable/);
});

test('« Créer mon agence » from the account menu: one agency per person, never a store of the plan', async () => {
  const { t, p } = await server();
  const shop = await store(t, p, 'Boutique Tlemcen', 'reda@tlemcen.dz');
  const { addStore, accountByEmail } = await import('../platform');
  const acc = (await accountByEmail(t, 'reda@tlemcen.dz'))!;
  const a = await addStore(t, acc, { name: 'Reda Call', kind: 'agency' });
  assert.equal(a.kind, 'agency');
  assert.equal(a.plan, null);
  await assert.rejects(addStore(t, acc, { name: 'Reda Call 2', kind: 'agency' }), /déjà une agence/);
  // the person now has their store and their agency (one login)
  assert.deepEqual((await storeChoices(t, 'reda@tlemcen.dz')).map((c) => [c.name, c.kind, c.owner]), [
    ['Reda Call', 'agency', true],
    ['Boutique Tlemcen', 'store', true],
  ]);
  void shop;
});

test('an agency works on several sellers: one at a time or all together, its people per seller and per product', async () => {
  const { t, p } = await server();
  const a = await store(t, p, 'Bébé Shop', 'amel@bebe.dz');
  const b = await store(t, p, 'Sport Shop', 'karim@sport.dz');
  const ag = await agency(t, 'Agence Centre', 'samir@centre.dz');
  await p('p.agencies.verify', { id: ag.id, verified: true });
  const chief = await as(t, ag.id, 'samir@centre.dz', PW);
  await call('agency.prices', chief, { prices: PRICES });
  const adminA = await as(t, a.id, 'amel@bebe.dz', PW);
  const adminB = await as(t, b.id, 'karim@sport.dz', PW);
  // seller A gives two products, seller B every product
  const la: any = await call('partners.request', adminA, { agencyId: ag.id, tasks: ['confirmation'], products: [a.products.VELO, a.products.POUS] });
  const lb: any = await call('partners.request', adminB, { agencyId: ag.id, tasks: ['confirmation', 'suivi'], products: null });
  await call('agency.answer', chief, { id: la.id, accept: true });
  await call('agency.answer', chief, { id: lb.id, accept: true });

  // Utilisateurs: Nora works for seller A on the Vélo only; Ali for every seller; Lina for seller B only
  await assert.rejects(call('users.create', chief, { phone: tph(), name: 'Nora', email: 'nora@centre.dz', password: PW, roles: ['confirmation'], sellers: [{ store: a.id, products: [a.products.CASQ] }] }), /pas confié/);
  const nora: any = await call('users.create', chief, { phone: tph(), name: 'Nora', email: 'nora@centre.dz', password: PW, roles: ['confirmation'], sellers: [{ store: a.id, products: [a.products.VELO] }] });
  await call('users.create', chief, { phone: tph(), name: 'Ali', email: 'ali@centre.dz', password: PW, roles: ['confirmation'] });
  const lina: any = await call('users.create', chief, { phone: tph(), name: 'Lina', email: 'lina@centre.dz', password: PW, roles: ['confirmation', 'suivi'], sellers: [{ store: b.id, products: null }] });
  assert.deepEqual(nora.agencySellers, [{ store: a.id, products: [a.products.VELO] }]);
  assert.deepEqual(((await call('agency.products', chief, { store: a.id })) as any[]).map((x) => x.name), ['Poussette', 'Vélo']);
  assert.deepEqual(((await call('agency.products', chief, { store: b.id })) as any[]).map((x) => x.name), ['Casque', 'Poussette', 'Vélo']);
  const home: any = await call('agency.home', chief, {});
  const agentsOf = (store: number) => home.links.find((l: any) => l.store.id === store).agents.map((x: any) => x.name);
  assert.deepEqual([agentsOf(a.id), agentsOf(b.id)], [['Ali', 'Nora', 'Samir'], ['Ali', 'Lina', 'Samir']]);

  const va = await order(adminA, a.products.VELO, '0663000001');
  const pa = await order(adminA, a.products.POUS, '0663000002');
  const cb = await order(adminB, b.products.CASQ, '0663000003');
  await new Promise((r) => setTimeout(r, 5));
  const vb = await order(adminB, b.products.VELO, '0663000004');
  assert.deepEqual([va.confAgencyId, pa.confAgencyId, cb.confAgencyId, vb.confAgencyId], [ag.id, ag.id, ag.id, ag.id]);

  const ctxOf = async (email: string, seller?: number | 'all'): Promise<Ctx> => ({ ...(await as(t, ag.id, email, PW)), ...(seller !== undefined ? { seller } : {}) });
  const ids = async (c: Ctx) => ((await call('confirmation.list', c, { sub: 'nouvelles', sort: 'created_at', dir: 'asc' })) as any).rows.map((o: any) => `${o.seller?.name ?? ''}#${o.ref}`);
  // Nora: seller A, the Vélo only (the Poussette is not hers); her picker has one seller
  assert.deepEqual(((await call('agency.sellers', await ctxOf('nora@centre.dz'), {})) as any[]).map((x) => x.name), ['Bébé Shop']);
  assert.deepEqual(((await call('confirmation.list', await ctxOf('nora@centre.dz', a.id), { sub: 'nouvelles' })) as any).rows.map((o: any) => o.id), [va.id]);
  await assert.rejects(call('orders.get', await ctxOf('nora@centre.dz', a.id), { id: pa.id }), /pas confiée à votre agence/);
  await assert.rejects(call('orders.list', await ctxOf('nora@centre.dz', b.id), {}), /ne travaillez pas pour ce vendeur/);
  // Ali: both sellers; « Tous les vendeurs » puts their orders together, oldest first, each with its seller
  assert.deepEqual(await ids(await ctxOf('ali@centre.dz', 'all')), [`Bébé Shop#${va.ref}`, `Bébé Shop#${pa.ref}`, `Sport Shop#${cb.ref}`, `Sport Shop#${vb.ref}`]);
  const two: any = await call('confirmation.list', await ctxOf('ali@centre.dz', 'all'), { sub: 'nouvelles', sort: 'created_at', dir: 'asc', page: 2, pageSize: 2 });
  assert.deepEqual([two.total, two.rows.map((o: any) => o.id)], [4, [cb.id, vb.id]]);
  assert.equal(((await call('confirmation.counts', await ctxOf('ali@centre.dz', 'all'), {})) as any).nouvelles, 4);
  assert.equal(((await call('orders.counts', await ctxOf('ali@centre.dz', 'all'), {})) as any).all, 4);
  // « Commande suivante » over every seller: the customer who waits the most first, then the next one elsewhere
  const ali = await ctxOf('ali@centre.dz', 'all');
  const n1: any = await call('orders.next', ali, {});
  assert.deepEqual(n1, { id: va.id, seller: a.id });
  const n2: any = await call('orders.next', ali, { skipAll: [{ s: a.id, id: va.id }] });
  assert.deepEqual(n2, { id: pa.id, seller: a.id });
  const n3: any = await call('orders.next', ali, { skipAll: [{ s: a.id, id: va.id }, { s: a.id, id: pa.id }] });
  assert.deepEqual(n3, { id: cb.id, seller: b.id });
  // taken: another agent of the agency does not get the same customers meanwhile
  const nora1: any = await call('orders.next', await ctxOf('nora@centre.dz', 'all'), {});
  assert.equal(nora1.id, null);

  // one seller less for Ali (the chief, from the seller's side): his « every seller » becomes « seller B »
  const sellerA = home.links.find((l: any) => l.store.id === a.id);
  const people = (await call('agency.team', chief, {})) as any[];
  const id = (n: string) => people.find((x) => x.name === n).id;
  await call('agency.setAgents', chief, { id: sellerA.id, people: [id('Nora'), id('Samir')] });
  assert.deepEqual(((await call('agency.team', chief, {})) as any[]).find((x) => x.name === 'Ali').sellers, [{ store: b.id, products: null }]);
  assert.equal((await a.db.query(`SELECT active FROM profiles WHERE email = 'ali@centre.dz'`))[0].active, false);
  // his unfinished Bébé Shop orders are free again
  assert.equal((await a.db.query('SELECT locked_by FROM orders WHERE id = $1', [va.id]))[0].locked_by, null);
  assert.deepEqual(((await call('agency.sellers', await ctxOf('ali@centre.dz'), {})) as any[]).map((x) => x.name), ['Sport Shop']);
  // Lina's products at seller B: the Casque only now
  await call('users.update', chief, { id: lina.id, sellers: [{ store: b.id, products: [b.products.CASQ] }] });
  assert.deepEqual(((await call('confirmation.list', await ctxOf('lina@centre.dz', b.id), { sub: 'nouvelles' })) as any).rows.map((o: any) => o.id), [cb.id]);
  assert.deepEqual((await b.db.query(`SELECT agency_products FROM profiles WHERE email = 'lina@centre.dz'`))[0].agency_products.map(Number), [b.products.CASQ]);

  // Facturation: each seller's month
  await a.db.query(`UPDATE orders SET conf_status = 'confirmed', confirmed_at = now(), follow_status = 'delivered', delivered_at = now() WHERE id = $1`, [va.id]);
  const bill: any = await call('agency.billing', chief, {});
  assert.deepEqual(bill.rows.map((r: any) => [r.link.store.name, r.counts.delivered, r.bill.total, r.request]), [
    ['Bébé Shop', 1, 150 + 20, null],
    ['Sport Shop', 0, 0, null],
  ]);
  await assert.rejects(call('agency.billing', await ctxOf('ali@centre.dz'), {}), /Accès refusé/);
});
