// A confirmation agency's own column presets (owner's choice, 25 Nov 2026): its chief and its chefs d'équipe save them
// and put one in use for the agency's team, whatever seller is picked (« Tous les vendeurs » too); a plain agent only
// reads them and picks one for himself. The seller's own presets stay the seller's team's: the agency never sees or
// changes them, and the seller's team never sees the agency's. A store keeps its rule: only its administrator leads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { confirmSignup, loadShop, passwordFromLink, startSignup } from '../platform';

let phoneN = 0;
const tph = () => `072${String(++phoneN).padStart(7, '0')}`;
const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const PW = 'Agence-Password-1';
const PRICES = { perConfirmed: 0, perDelivered: 150, perUpsell: 50, monthly: 0, bonusRate: { min: 70, amount: 20 }, bonusVolume: { above: 0, amount: 0 } };

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
  return { pg, t, p };
}

async function as(t: Tenancy, shopId: number, email: string, password = PW): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, password), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t };
}

test('an agency leads its own column presets: chief and chefs d’équipe save them for its team, in every seller; the store’s stay the store’s', async () => {
  const { pg, t, p } = await server();
  try {
    // a store (its admin, one product) and an agency working for it
    const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
    const made = await p('p.shops.create', { name: 'Boutique Oran', ownerName: 'Karim', ownerEmail: 'karim@oran.dz', planId: biz.id, trialDays: 14 });
    await passwordFromLink(t, made.mail.token, PW);
    const shop = (await loadShop(t, { id: made.id }))!;
    const velo = Number((await t.shop(shop.schema).query(`INSERT INTO products (name, sku, price) VALUES ('Vélo', 'VELO', 9000) RETURNING id`))[0].id);
    const mail = await startSignup(t, { name: 'Samir', email: 'samir@agence.dz', phone: tph(), password: PW, storeName: 'Agence Rapide', language: 'fr', terms: true, kind: 'agency' }, null);
    const signed: any = await confirmSignup(t, (mail as any).token);
    const ag = signed.shop as { id: number };
    const chief = await as(t, ag.id, 'samir@agence.dz');
    await call('agency.prices', chief, { prices: PRICES });
    await p('p.agencies.verify', { id: ag.id, verified: true });
    const admin = await as(t, shop.id, 'karim@oran.dz');
    const { id: linkId } = (await call('partners.request', admin, { agencyId: ag.id, tasks: ['confirmation'], products: [velo] })) as any;
    await call('agency.answer', chief, { id: linkId, accept: true });
    await call('users.create', chief, { phone: tph(), name: 'Riad', email: 'riad@agence.dz', password: PW, roles: ['agent_manager'] });
    await call('users.create', chief, { phone: tph(), name: 'Nora', email: 'nora@agence.dz', password: PW, roles: ['confirmation'] });
    const lead = await as(t, ag.id, 'riad@agence.dz');
    const nora = await as(t, ag.id, 'nora@agence.dz');
    // the store's own team: its administrator saves a preset for it; its own agent manager cannot (unchanged)
    const mgr: any = await call('users.create', admin, { phone: tph(), name: 'Yacine', email: 'yacine@oran.dz', password: PW, roles: ['agent_manager'] });
    assert.ok(mgr.id);
    const storeMgr = await as(t, shop.id, 'yacine@oran.dz');
    const own: any = await call('confirmation.addColPreset', admin, { name: 'Boutique', cols: ['order', 'name'] });
    await assert.rejects(call('confirmation.addColPreset', storeMgr, { name: 'Non', cols: ['order'] }), /refus/i);

    // the agency's chief saves one: it goes to the agency's team at once
    const a1: any = await call('confirmation.addColPreset', chief, { name: 'Appels', cols: ['order', 'name', 'phone'], all: ['order', 'name', 'phone', 'wilaya'] });
    assert.equal(((await call('confirmation.colActive', nora, {})) as any).id, a1.id);
    // a chef d'équipe too, and he puts one in use and deletes one
    const a2: any = await call('confirmation.addColPreset', lead, { name: 'Court', cols: ['order', 'status'] });
    assert.equal(((await call('confirmation.colActive', nora, {})) as any).id, a2.id);
    await call('confirmation.setColActive', lead, { id: a1.id });
    assert.equal(((await call('confirmation.colActive', nora, {})) as any).id, a1.id);
    await call('confirmation.deleteColPreset', lead, { id: a2.id });
    // a plain agent reads them, never changes them
    assert.deepEqual(((await call('confirmation.colPresets', nora, {})) as any[]).map((x) => x.name), ['Appels']);
    await assert.rejects(call('confirmation.addColPreset', nora, { name: 'Moi', cols: ['order'] }), /refus/i);
    await assert.rejects(call('confirmation.setColActive', nora, { id: a1.id }), /refus/i);
    await assert.rejects(call('confirmation.deleteColPreset', nora, { id: a1.id }), /refus/i);

    // the seller picked at the top of the page changes nothing: one seller or « Tous les vendeurs », the agency's own
    for (const seller of [shop.id, 'all'] as const) {
      assert.deepEqual(((await call('confirmation.colPresets', { ...nora, seller }, {})) as any[]).map((x) => x.name), ['Appels'], `seller ${seller}`);
      assert.equal(((await call('confirmation.colActive', { ...nora, seller }, {})) as any).id, a1.id, `seller ${seller}`);
    }
    // saved with a seller picked: still the agency's, never the store's
    const a3: any = await call('confirmation.addColPreset', { ...chief, seller: shop.id }, { name: 'Vendeur choisi', cols: ['order'] });
    assert.deepEqual(((await call('confirmation.colPresets', chief, {})) as any[]).map((x) => x.name), ['Appels', 'Vendeur choisi']);

    // the store's team sees only its own presets, and its preset in use is still its administrator's
    assert.deepEqual(((await call('confirmation.colPresets', storeMgr, {})) as any[]).map((x) => x.name), ['Boutique']);
    assert.equal(((await call('confirmation.colActive', storeMgr, {})) as any).id, own.id);
    assert.ok(!((await call('confirmation.colPresets', storeMgr, {})) as any[]).some((x) => x.id === a3.id));
  } finally {
    await pg.close();
  }
});
