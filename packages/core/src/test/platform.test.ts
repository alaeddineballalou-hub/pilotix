// Several shops on one server: each in its own schema (nothing shared), the login index, trials and payments, menus
// by plan, the control room's rules, the demo shop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effectiveFeatures, featureOn, routeAllowed } from '@pilotix/shared';
import {
  call,
  Ctx,
  FEATURE_OFF,
  loadShop,
  login,
  migrate,
  migrateAll,
  MIGRATIONS,
  PCtx,
  pgliteTenancy,
  platformCall,
  seedBase,
  shopCtx,
  shopIdOfEmail,
  shopStatus,
  staffLogin,
  Tenancy,
} from '../index';
import { landingStore } from '../modules/landingquery';
import {
  accountByEmail,
  accountResetRequest,
  addStore,
  adminMaySetPassword,
  attachProfile,
  checkAccountPassword,
  confirmSignup,
  deleteStoreByOwner,
  membershipsOf,
  passwordFromLink,
  propagateProfilePassword,
  shopThread,
  shopThreads,
  shopWrite,
  startSignup,
  storeChoices,
  storeReferrals,
  takeDueReminders,
} from '../platform';
import { bootstrapPlatform, platformSettings, setPlatformSetting, syncPrimaryStore } from '../platform/shops';
import { getSetting, setSetting } from '../settings';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const DAY = 86_400_000;

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const t = pgliteTenancy(pg as any);
  // the server as it was before: one shop in "public", its admin, a product
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await t.shop('public').query(`INSERT INTO products (name, sku, price) VALUES ('Vélo', 'VELO', 9000)`);
  // the update: the platform and its first start
  const applied = await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = <T = any>(name: string, input: unknown = {}, as: PCtx = pctx) => platformCall(name, as, input) as Promise<T>;
  return { t, pg, applied, staff, pctx, p };
}

/** A store made from the control room; its owner chooses a password from the invitation e-mail. */
async function invite(t: Tenancy, p: (name: string, input?: unknown) => Promise<any>, input: Record<string, unknown>, password: string) {
  const made = await p('p.shops.create', input);
  if (made.mail.kind === 'invite') await passwordFromLink(t, made.mail.token, password);
  return { ...made, password };
}

async function shopUserCtx(t: Tenancy, schema: string, email: string, password: string, shop?: Ctx['shop']): Promise<Ctx> {
  const db = t.shop(schema);
  return { db, session: await login(db, email, password), now: () => Date.now(), emit: () => {}, shop };
}

test('first start: the existing shop becomes shop #1, its admin the platform owner', async () => {
  const { t, applied, staff } = await server();
  assert.deepEqual(applied.platform, ['p001_platform', 'p002_accounts_signup_domains', 'p003_accounts_privacy', 'p004_turnstile', 'p005_agencies', 'p006_marketers']);
  assert.deepEqual(applied.public, []);
  const s1 = (await loadShop(t, { primary: true }))!;
  assert.equal(s1.schema, 'public');
  assert.equal(s1.neverExpires, true);
  assert.equal(s1.plan?.code, 'interne');
  assert.equal(await shopIdOfEmail(t, ' OWNER@boutique.dz '), s1.id);
  assert.equal(staff.role, 'owner');
  assert.equal(staff.email, OWNER.email);
  // the person already in the store got an account (same password), and owns shop #1
  const acc = (await accountByEmail(t, OWNER.email))!;
  assert.equal(acc.verified, true);
  assert.ok(await checkAccountPassword(t, OWNER.email, OWNER.password));
  assert.equal(s1.ownerAccountId, acc.id);
  assert.match(s1.referralCode ?? '', /^[A-Z2-9]{6}$/);

  // the plans offered at the start
  const plans = await t.platform.query('SELECT code FROM platform.plans ORDER BY sort');
  assert.deepEqual(plans.map((r: any) => r.code), ['interne', 'essentiel', 'pro', 'business']);
  // a second start changes nothing
  const again = await migrateAll(t);
  assert.deepEqual(again.platform, []);
  assert.equal((await t.platform.query('SELECT count(*)::int AS n FROM platform.shops'))[0].n, 1);
  assert.equal((await t.platform.query('SELECT count(*)::int AS n FROM platform.staff'))[0].n, 1);
});

test('a new shop: its own schema, its own admin, nothing shared', async () => {
  const { t, p } = await server();
  const pro = (await p<any[]>('p.plans.list')).find((x) => x.code === 'pro');
  const made = await invite(t, p, { name: 'Bébé Confort Oran', ownerName: 'Karim', ownerEmail: 'Karim@Oran.dz', ownerPhone: '0550 00 00 00', planId: pro.id, trialDays: 14 }, 'Karim-Password-1');
  assert.equal(made.slug, 'bebe-confort-oran');
  // Pilotix never sees a password: an invitation by e-mail (the link only goes in the e-mail)
  assert.equal(made.invited, true);
  assert.equal(made.mail.kind, 'invite');
  assert.equal('password' in (await p('p.shops.get', { id: made.id })), false);
  const s2 = (await loadShop(t, { id: made.id }))!;
  assert.equal(s2.schema, `shop_${made.id}`);
  assert.equal((await t.shop(s2.schema).query('SELECT count(*)::int AS n FROM schema_migrations'))[0].n, MIGRATIONS.length);
  assert.equal(await shopIdOfEmail(t, 'karim@oran.dz'), s2.id);
  // its admin logs in to its own shop only
  const k = await shopUserCtx(t, s2.schema, 'karim@oran.dz', made.password);
  assert.equal(k.session.isAdmin, true);
  await assert.rejects(login(t.shop('public'), 'karim@oran.dz', made.password));
  // nothing of shop #1 is visible in shop 2, and the reverse
  assert.equal((await t.shop(s2.schema).query('SELECT count(*)::int AS n FROM products'))[0].n, 0);
  await t.shop(s2.schema).query(`INSERT INTO products (name, sku, price) VALUES ('Poussette', 'VELO', 12000)`); // same SKU: another shop
  assert.equal((await t.shop('public').query(`SELECT name FROM products WHERE sku = 'VELO'`))[0].name, 'Vélo');
  assert.equal((await t.shop(s2.schema).query(`SELECT name FROM products WHERE sku = 'VELO'`))[0].name, 'Poussette');
  // an order made in shop 2: its own numbers, its own history
  const pid = Number((await t.shop(s2.schema).query(`SELECT id FROM products WHERE sku = 'VELO'`))[0].id);
  const o: any = await call('orders.create', k, { customerName: 'Client Oran', phone: '0661223344', wilayaId: 31, commune: 'Oran', items: [{ productId: pid, variantId: null, qty: 1 }] });
  assert.ok(o.ref);
  assert.equal((await t.shop(s2.schema).query('SELECT count(*)::int AS n FROM orders'))[0].n, 1);
  assert.equal((await t.shop('public').query('SELECT count(*)::int AS n FROM orders'))[0].n, 0);
  assert.ok((await t.shop(s2.schema).query('SELECT count(*)::int AS n FROM order_events'))[0].n >= 1);
  // the shop's name in its own settings
  assert.equal((await t.shop(s2.schema).query(`SELECT value->>'name' AS n FROM settings WHERE key = 'shop'`))[0].n, 'Bébé Confort Oran');
});

test('store names: one per shop, unique, the first part of its links (site/<store>/<page>)', async () => {
  const { t, p } = await server();
  // shop #1: its name on the platform is the one of its « Lien des pages » (here made from the shop's name)
  const s1 = (await loadShop(t, { primary: true }))!;
  assert.equal(s1.slug, await landingStore(t.shop('public')));
  const biz = (await p<any[]>('p.plans.list')).find((x) => x.code === 'business');
  const shop = (name: string, slug?: string, email = `${Math.random().toString(36).slice(2, 8)}@x.dz`) =>
    p('p.shops.create', { name, slug, ownerName: 'Karim', ownerEmail: email, planId: biz.id, trialDays: 14 });
  // the app's own words, a bad format, a name already taken: refused
  await assert.rejects(shop('API', 'api'), /réservé/);
  await assert.rejects(shop('X', 'a'), /invalide/);
  await assert.rejects(shop('Copie', s1.slug), /déjà pris/);
  // a name made from « Admin »: never the app's word
  assert.equal((await shop('Admin')).slug, 'admin-boutique');
  const made = await shop('Bébé Oran', undefined, 'karim@oran.dz');
  assert.equal(made.slug, 'bebe-oran');
  await passwordFromLink(t, made.mail.token, 'Karim-Password-1');
  made.password = 'Karim-Password-1';
  // shop 2: its name is in its own settings (its pages, its llms.txt) and it cannot change it itself
  const s2 = (await loadShop(t, { id: made.id }))!;
  const db2 = t.shop(s2.schema);
  assert.equal(await landingStore(db2), 'bebe-oran');
  const k = await shopUserCtx(t, s2.schema, 'karim@oran.dz', made.password, shopCtx(s2, shopStatus(s2, Date.now(), 3)));
  const g2: any = await call('landing.settings.get', k, {});
  assert.equal(g2.store, 'bebe-oran');
  assert.equal(g2.storeFixed, true);
  await call('landing.settings.save', k, { ...g2.settings, storeSlug: 'autre-nom', capiToken: '' });
  assert.equal(await landingStore(db2), 'bebe-oran');
  // shop #1 chooses its name: not one another shop has (the server tells the core), then the platform follows
  const taken = async (x: string) => (await t.platform.query('SELECT 1 FROM platform.shops WHERE slug = $1 AND id <> $2', [x, s1.id])).length > 0;
  const a1 = { ...(await shopUserCtx(t, 'public', OWNER.email, OWNER.password, shopCtx(s1, shopStatus(s1, Date.now(), 3)))), server: { storeTaken: taken } as any };
  const g1: any = await call('landing.settings.get', a1, {});
  assert.equal(g1.storeFixed, false);
  await assert.rejects(call('landing.settings.save', a1, { ...g1.settings, storeSlug: 'bebe-oran', capiToken: '' }), /déjà pris/);
  await call('landing.settings.save', a1, { ...g1.settings, storeSlug: 'ma-boutique', capiToken: '' });
  await syncPrimaryStore(t);
  assert.equal((await loadShop(t, { primary: true }))!.slug, 'ma-boutique');
  // the control room renames: shop 2's settings follow; shop #1's « Lien des pages » follows
  await assert.rejects(p('p.shops.update', { id: s2.id, slug: 'ma-boutique' }), /déjà pris/);
  await p('p.shops.update', { id: s2.id, slug: 'bebe-confort' });
  assert.equal(await landingStore(db2), 'bebe-confort');
  await p('p.shops.update', { id: s1.id, slug: 'boutique-amine' });
  assert.equal(await landingStore(t.shop('public')), 'boutique-amine');
  await syncPrimaryStore(t);
  assert.equal((await loadShop(t, { primary: true }))!.slug, 'boutique-amine');
  // shop #1 back to a name made from its shop name, which another shop has: it keeps the one it had
  await call('landing.settings.save', a1, { ...g1.settings, storeSlug: '', capiToken: '' });
  await setSetting(t.shop('public'), 'shop', { ...(await getSetting(t.shop('public'), 'shop')), name: 'Bébé Confort' });
  assert.equal(await landingStore(t.shop('public'), { ...(await getSetting(t.shop('public'), 'landing')), storeSlug: '' }), 'bebe-confort');
  await syncPrimaryStore(t);
  assert.equal((await loadShop(t, { primary: true }))!.slug, 'boutique-amine');
  assert.equal(await landingStore(t.shop('public')), 'boutique-amine');
  // a later start puts every other shop's name back in its settings
  await db2.query(`UPDATE settings SET value = jsonb_set(value, '{storeSlug}', '"x-y"') WHERE key = 'landing'`);
  await migrateAll(t);
  assert.equal(await landingStore(db2), 'bebe-confort');
});

test('one e-mail, several stores: one account, one password, chosen by the person only', async () => {
  const { t, p } = await server();
  const plan = (await p<any[]>('p.plans.list')).find((x) => x.code === 'business');
  // a store for an e-mail that already has an account: added to it, its password unchanged
  const two = await p('p.shops.create', { name: 'Deuxième', ownerName: 'Amine', ownerEmail: OWNER.email, planId: plan.id, trialDays: 7 });
  assert.equal(two.mail.kind, 'added');
  assert.equal(two.invited, false);
  assert.deepEqual((await membershipsOf(t, OWNER.email)).map((m) => m.schema), ['public', `shop_${two.id}`]);
  await shopUserCtx(t, `shop_${two.id}`, OWNER.email, OWNER.password);
  const choices = await storeChoices(t, OWNER.email);
  assert.equal(choices.length, 2);
  assert.ok(choices.every((c) => c.owner));
  // Lina's store; Lina adds Amine to her team: Amine keeps his own password (the one Lina typed does nothing)
  const lina = await invite(t, p, { name: 'Shop Lina', ownerName: 'Lina', ownerEmail: 'lina@deux.dz', planId: plan.id, trialDays: 7 }, 'Lina-Password-1');
  const ls = `shop_${lina.id}`;
  const lc = await shopUserCtx(t, ls, 'lina@deux.dz', 'Lina-Password-1');
  const user = { name: 'Amine', password: 'mot-de-passe-de-lina', roles: ['confirmation'], language: 'fr' };
  const added: any = await call('users.create', lc, { ...user, email: OWNER.email });
  const at = await attachProfile(t, ls, added.id);
  assert.equal(at?.existing, true);
  await assert.rejects(login(t.shop(ls), OWNER.email, 'mot-de-passe-de-lina'));
  await shopUserCtx(t, ls, OWNER.email, OWNER.password);
  // Lina may not set Amine's password (he works in other stores, he owns some); she may for her own agent
  assert.equal(await adminMaySetPassword(t, lina.id, OWNER.email), false);
  const agent: any = await call('users.create', lc, { ...user, name: 'Agent', email: 'agent@deux.dz', password: 'agent-pass-1' });
  await attachProfile(t, ls, agent.id);
  assert.equal(await adminMaySetPassword(t, lina.id, 'agent@deux.dz'), true);
  assert.equal(await adminMaySetPassword(t, lina.id, 'lina@deux.dz'), false); // the owner
  // Amine changes his password in one store: every store follows, old sessions end
  const a2 = await shopUserCtx(t, ls, OWNER.email, OWNER.password);
  await call('me.password', a2, { current: OWNER.password, next: 'Nouveau-Pass-9' });
  await propagateProfilePassword(t, ls, added.id);
  await shopUserCtx(t, 'public', OWNER.email, 'Nouveau-Pass-9');
  await shopUserCtx(t, `shop_${two.id}`, OWNER.email, 'Nouveau-Pass-9');
  assert.ok(await checkAccountPassword(t, OWNER.email, 'Nouveau-Pass-9'));
  // « Mot de passe oublié »: one link, every store; an agent (nobody's admin): 2 a month
  const r = (await accountResetRequest(t, 'agent@deux.dz'))!;
  assert.equal(r.kind, 'link');
  await passwordFromLink(t, (r as any).token, 'Agent-Pass-2');
  await shopUserCtx(t, ls, 'agent@deux.dz', 'Agent-Pass-2');
  await assert.rejects(passwordFromLink(t, (r as any).token, 'Agent-Pass-3'), /plus valable/);
  const r2 = (await accountResetRequest(t, 'agent@deux.dz'))!;
  await passwordFromLink(t, (r2 as any).token, 'Agent-Pass-3');
  assert.equal((await accountResetRequest(t, 'agent@deux.dz'))!.kind, 'limit');
  assert.equal((await accountResetRequest(t, OWNER.email))!.kind, 'link');
  assert.equal(await accountResetRequest(t, 'nobody@nowhere.dz'), null);
  // a closed account leaves the index
  const ag = await shopUserCtx(t, ls, 'agent@deux.dz', 'Agent-Pass-3');
  await call('me.delete', ag, { password: 'Agent-Pass-3' });
  assert.deepEqual(await membershipsOf(t, 'agent@deux.dz'), []);
});

test('sign-up: confirmed by e-mail, the store on the trial plan, referral reward at the first payment', async () => {
  const { t, p } = await server();
  const s1 = (await loadShop(t, { primary: true }))!;
  const form = { name: 'Yasmine', email: 'Yasmine@Shop.dz', password: 'yasmine-pass', storeName: 'Yasmine Shop', language: 'fr', referral: s1.referralCode, terms: true };
  await assert.rejects(startSignup(t, { ...form, terms: false }, '1.2.3.4'), /conditions/);
  await assert.rejects(startSignup(t, { ...form, slug: 'api' }, '1.2.3.4'), /réservé/);
  await assert.rejects(startSignup(t, { ...form, referral: 'ZZZZZZ' }, '1.2.3.4'), /parrainage/);
  const m = (await startSignup(t, form, '1.2.3.4'))!;
  assert.equal(m.kind, 'confirm');
  // nothing made before the e-mail is confirmed
  assert.equal(await accountByEmail(t, 'yasmine@shop.dz'), null);
  const done: any = await confirmSignup(t, (m as any).token);
  assert.equal(done.shop.slug, 'yasmine-shop');
  assert.equal(done.shop.selfSignup, true);
  assert.equal(done.shop.plan.code, 'pro');
  assert.equal(done.account.verified, true);
  await shopUserCtx(t, done.shop.schema, 'yasmine@shop.dz', 'yasmine-pass');
  await assert.rejects(confirmSignup(t, (m as any).token), /plus valable/);
  // the same e-mail again: « you already have an account » (nothing made)
  assert.equal((await startSignup(t, form, '1.2.3.4'))!.kind, 'exists');
  // a second store from the account menu, up to the limit
  await p('p.settings.save', { signup: { open: true, maxStores: 2 } });
  const acc = (await accountByEmail(t, 'yasmine@shop.dz'))!;
  const b = await addStore(t, acc, { name: 'Yasmine Bébé' });
  assert.equal(b.ownerAccountId, acc.id);
  await assert.rejects(addStore(t, acc, { name: 'Trois' }), /maximum/);
  // the dashboard counts it; the referrer gets its month at the first payment
  const d = await p('p.dashboard');
  assert.equal(d.signups.week, 2);
  const shopUntil = (await loadShop(t, { id: s1.id }))!.paidUntil;
  const pay = await p('p.payments.add', { shopId: done.shop.id, amount: 7900, method: 'baridimob', months: 1 });
  assert.match(pay.receiptNo, /^PX-\d{4}-0001$/);
  // shop #1 never expires: its referral is recorded, no months added
  assert.equal(pay.rewarded, null);
  assert.equal((await loadShop(t, { id: s1.id }))!.paidUntil, shopUntil);
  const refs = await storeReferrals(t, s1.id);
  assert.equal(refs.list.length, 1);
  // a store brought by Yasmine's store: Yasmine gets a free month when it pays
  const m2 = (await startSignup(t, { ...form, email: 'nadia@x.dz', name: 'Nadia', storeName: 'Nadia Beauty', referral: done.shop.referralCode }, '1.2.3.5'))!;
  const n: any = await confirmSignup(t, (m2 as any).token);
  const before = Date.parse((await loadShop(t, { id: done.shop.id }))!.paidUntil!);
  const pay2 = await p('p.payments.add', { shopId: n.shop.id, amount: 7900, method: 'cash', months: 1 });
  assert.deepEqual(pay2.rewarded, { shop: 'Yasmine Shop', months: 1 });
  assert.equal(pay2.mails[0].kind, 'reward');
  assert.ok(Date.parse((await loadShop(t, { id: done.shop.id }))!.paidUntil!) - before > 27 * DAY);
  // only the first payment counts
  assert.equal((await p('p.payments.add', { shopId: n.shop.id, amount: 7900, method: 'cash', months: 1 })).rewarded, null);
  // sign-ups closed: refused
  await p('p.settings.save', { signup: { open: false, maxStores: 2 } });
  await assert.rejects(startSignup(t, { ...form, email: 'z@z.dz' }, '1.2.3.6'), /fermées/);
});

test('only the owner deletes a store; Pilotix cannot open it, only suspend it', async () => {
  const { t, p } = await server();
  const plan = (await p<any[]>('p.plans.list')).find((x) => x.code === 'pro');
  const made = await invite(t, p, { name: 'A Supprimer', ownerName: 'Omar', ownerEmail: 'omar@x.dz', planId: plan.id, trialDays: 7 }, 'Omar-Password-1');
  const s = (await loadShop(t, { id: made.id }))!;
  const omar = (await accountByEmail(t, 'omar@x.dz'))!;
  const other = (await accountByEmail(t, OWNER.email))!;
  await assert.rejects(deleteStoreByOwner(t, other, s.id, OWNER.password, s.name), /propriétaire/);
  await assert.rejects(deleteStoreByOwner(t, omar, s.id, 'wrong', s.name), /Mot de passe incorrect/);
  await assert.rejects(deleteStoreByOwner(t, omar, s.id, 'Omar-Password-1', 'autre nom'), /nom de la boutique/);
  await deleteStoreByOwner(t, omar, s.id, 'Omar-Password-1', 'a supprimer');
  const gone = (await loadShop(t, { id: s.id }))!;
  assert.equal(gone.status, 'deleted');
  assert.equal(gone.slug, `deleted-${s.id}`);
  assert.equal((await t.platform.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [s.schema])).length, 0);
  assert.deepEqual(await membershipsOf(t, 'omar@x.dz'), []);
  await assert.rejects(p('p.shops.setStatus', { id: s.id, status: 'active' }), /supprimée/);
  // the control room has no « open as » nor « new admin password » any more
  await assert.rejects(p('p.shops.resetAdminPassword', { id: s.id, profileId: 1 }), /inconnue/);
  // shop #1 can never be deleted
  const s1 = (await loadShop(t, { primary: true }))!;
  await assert.rejects(deleteStoreByOwner(t, other, s1.id, OWNER.password, s1.name), /ne peut pas/);
});

test('numbers only, and the plan limits: accounts, livreurs, orders per month, stores per owner', async () => {
  const { t, p } = await server();
  const plan = (await p<any[]>('p.plans.list')).find((x) => x.code === 'essentiel');
  await p('p.plans.save', { id: plan.id, name: plan.name, priceMonth: plan.priceMonth, priceYear: 39000, features: plan.features, maxUsers: 10, maxDrivers: 1, maxOrdersMonth: 1, public: true, active: true });
  const made = await invite(t, p, { name: 'Compteurs', ownerName: 'Rania', ownerEmail: 'rania@x.dz', planId: plan.id, trialDays: 14 }, 'Rania-Password-1');
  const s = (await loadShop(t, { id: made.id }))!;
  const c = await shopUserCtx(t, s.schema, 'rania@x.dz', 'Rania-Password-1', shopCtx(s, shopStatus(s, Date.now(), 3)));
  const user = { name: 'Livreur', password: 'livreur-pass-1', roles: ['livreur'], language: 'fr' };
  await call('users.create', c, { ...user, email: 'l1@x.dz' });
  await assert.rejects(call('users.create', c, { ...user, email: 'l2@x.dz' }), /1 livreur actif/);
  const agent: any = await call('users.create', c, { ...user, roles: ['confirmation'], email: 'a1@x.dz' });
  await assert.rejects(call('users.update', c, { id: agent.id, roles: ['confirmation', 'livreur'] }), /1 livreur actif/);
  // the control room: numbers only (no names, no e-mails of the team)
  const g = await p('p.shops.get', { id: made.id });
  assert.deepEqual(g.usage, { users: 3, drivers: 1, ordersMonth: 0, ordersLastMonth: 0, ordersTotal: 0, ownerStores: 1 });
  assert.equal(g.admins, undefined);
  assert.equal(g.limits.maxDrivers, 1);
  assert.equal(g.ownerAccount.email, 'rania@x.dz');
  // 2 orders with a plan of 1 a month: still taken (no customer lost), the store is « over »
  await t.shop(s.schema).query(`INSERT INTO products (name, sku, price) VALUES ('P', 'P1', 1000)`);
  const pid = Number((await t.shop(s.schema).query(`SELECT id FROM products WHERE sku = 'P1'`))[0].id);
  for (const ph of ['0661000001', '0661000002']) await call('orders.create', c, { customerName: 'Client', phone: ph, wilayaId: 16, commune: 'Alger', items: [{ productId: pid, variantId: null, qty: 1 }] });
  assert.equal((await p('p.shops.get', { id: made.id })).usage.ordersMonth, 2);
  const over = await p<any[]>('p.shops.list', { state: 'over' });
  assert.deepEqual(over.map((x) => x.id), [made.id]);
  assert.equal(over[0].limits.over.orders, true);
  // the owner's stores: their own limit
  await p('p.shops.update', { id: made.id, ownerMaxStores: 1 });
  await assert.rejects(addStore(t, (await accountByEmail(t, 'rania@x.dz'))!, { name: 'Encore' }), /maximum/);
});

test('messages between a store and Pilotix; reminders once per end date', async () => {
  const { t, p } = await server();
  const plan = (await p<any[]>('p.plans.list')).find((x) => x.code === 'pro');
  const made = await invite(t, p, { name: 'Aide', ownerName: 'Sami', ownerEmail: 'sami@x.dz', planId: plan.id, trialDays: 2 }, 'Sami-Password-1');
  const w = await shopWrite(t, made.id, { name: 'Sami', email: 'sami@x.dz' }, { subject: 'Question', body: 'Comment ajouter un livreur ?' });
  assert.equal((await p('p.dashboard')).messages, 1);
  const list = await p<any[]>('p.support.list', {});
  assert.equal(list[0].unreadStaff, true);
  const r = await p('p.support.reply', { id: w.id, body: 'Dans Utilisateurs › Nouveau.' });
  assert.equal(r.mail.kind, 'answer');
  assert.equal((await shopThreads(t, made.id))[0].unreadShop, true);
  const th = await shopThread(t, made.id, w.id);
  assert.equal(th.messages.length, 2);
  await assert.rejects(shopThread(t, 999, w.id), /introuvable/);
  // the trial ends in 2 days: one reminder, once
  const due = await takeDueReminders(t);
  assert.deepEqual(due.map((d) => [d.shop, d.kind, d.to]), [['Aide', 'trial_end', 'sami@x.dz']]);
  assert.deepEqual(await takeDueReminders(t), []);
});

test('trial, grace, lock, payment', async () => {
  const t0 = Date.UTC(2026, 9, 1, 10);
  const base = { status: 'active' as const, neverExpires: false, paidUntil: null as string | null, trialEndsAt: new Date(t0 + 14 * DAY).toISOString() };
  assert.deepEqual(shopStatus(base, t0, 3), { state: 'trial', daysLeft: 14, locked: false });
  assert.deepEqual(shopStatus(base, t0 + 15 * DAY, 3), { state: 'grace', daysLeft: 2, locked: false });
  assert.deepEqual(shopStatus(base, t0 + 18 * DAY, 3), { state: 'expired', daysLeft: 0, locked: true });
  assert.deepEqual(shopStatus({ ...base, paidUntil: new Date(t0 + 40 * DAY).toISOString() }, t0 + 18 * DAY, 3), { state: 'active', daysLeft: 22, locked: false });
  assert.equal(shopStatus({ ...base, status: 'suspended' }, t0, 3).locked, true);
  assert.equal(shopStatus({ ...base, neverExpires: true, trialEndsAt: null }, t0 + 999 * DAY, 3).state, 'active');
  assert.equal(shopStatus({ ...base, trialEndsAt: null }, t0, 3).state, 'expired');

  const { t, p } = await server();
  const plan = (await p<any[]>('p.plans.list')).find((x) => x.code === 'essentiel');
  const made = await p('p.shops.create', { name: 'Payeur', ownerName: 'Paul', ownerEmail: 'p@pay.dz', planId: plan.id, trialDays: 10 });
  const trialEnd = Date.parse((await loadShop(t, { id: made.id }))!.trialEndsAt!);
  // paid during the trial: the month starts at the end of the trial (no day lost)
  const r1 = await p('p.payments.add', { shopId: made.id, amount: 3900, method: 'baridimob', months: 1, reference: 'BM-1' });
  assert.match(r1.receiptNo, /^PX-\d{4}-0001$/);
  const rc = await p('p.payments.receipt', { id: r1.id });
  assert.equal(rc.shop.name, 'Payeur');
  assert.equal(rc.amount, 3900);
  const end1 = Date.parse(r1.paidUntil);
  assert.ok(end1 - trialEnd > 27 * DAY && end1 - trialEnd < 32 * DAY);
  const r2 = await p('p.payments.add', { shopId: made.id, amount: 7800, method: 'ccp', months: 2 });
  assert.ok(Date.parse(r2.paidUntil) - end1 > 58 * DAY);
  // a payment typed by mistake: cancelled, the period goes back
  await assert.rejects(p('p.payments.void', { id: r2.id, reason: 'x' }), /Champ invalide/);
  const v = await p('p.payments.void', { id: r2.id, reason: 'erreur de saisie' });
  assert.equal(v.periodBack, true);
  assert.equal((await loadShop(t, { id: made.id }))!.paidUntil, r1.paidUntil);
  const list = await p('p.payments.list', { shopId: made.id });
  assert.equal(list.total, 3900);
  assert.equal(list.rows.length, 1);
  // suspended, then a payment reactivates it
  await p('p.shops.setStatus', { id: made.id, status: 'suspended', reason: 'impayé' });
  assert.equal((await loadShop(t, { id: made.id }))!.status, 'suspended');
  const r3 = await p('p.payments.add', { shopId: made.id, amount: 3900, method: 'cash', months: 1 });
  assert.equal(r3.reactivated, true);
  assert.equal((await loadShop(t, { id: made.id }))!.status, 'active');
  // never the owner's shop
  const s1 = (await loadShop(t, { primary: true }))!;
  await assert.rejects(p('p.shops.setStatus', { id: s1.id, status: 'suspended' }), /ne peut pas/);
  await assert.rejects(p('p.payments.add', { shopId: s1.id, amount: 1, method: 'cash', months: 1 }), /Pas de paiement/);
  // payments recorded before receipts existed get a number at the next start, after the year's last one
  await t.platform.query('UPDATE platform.payments SET receipt_no = NULL WHERE id = ANY($1)', [[r1.id, r3.id]]);
  await bootstrapPlatform(t);
  const nums = await t.platform.query('SELECT id, receipt_no FROM platform.payments WHERE shop_id = $1 ORDER BY id', [made.id]);
  const year = new Date().getUTCFullYear();
  assert.deepEqual(nums.map((x: any) => x.receipt_no), [`PX-${year}-0003`, `PX-${year}-0002`, `PX-${year}-0004`]);
  const r4 = await p('p.payments.add', { shopId: made.id, amount: 3900, method: 'cash', months: 1 });
  assert.equal(r4.receiptNo, `PX-${year}-0005`);
  // the journal
  const log = await p<any[]>('p.audit.list', { shopId: made.id });
  assert.deepEqual(
    log.map((l) => l.action).reverse(),
    ['shop.create', 'payment.add', 'payment.add', 'payment.void', 'shop.suspend', 'payment.add', 'payment.add'],
  );
});

test('menus by plan, own changes per shop, enforced by the server', async () => {
  // the list rules
  assert.equal(effectiveFeatures(['*']), null);
  const ess = effectiveFeatures(['dashboard', 'commandes', 'produits', '-produits/achats']);
  assert.ok(featureOn(ess, 'produits') && featureOn(ess, 'produits/stock') && !featureOn(ess, 'produits/achats'));
  assert.ok(!featureOn(ess, 'pilotai') && !featureOn(ess, 'pilotai/messages') && featureOn(ess, 'accueil') && featureOn(ess, 'reglages'));
  const plus = effectiveFeatures(['dashboard', 'produits', '-produits/achats'], ['produits/achats', 'landing'], ['dashboard/sav']);
  assert.ok(featureOn(plus, 'produits/achats') && featureOn(plus, 'landing') && !featureOn(plus, 'dashboard/sav') && featureOn(plus, 'dashboard/overview'));
  assert.ok(!routeAllowed(ess, 'messages') && routeAllowed(ess, 'confirmation') && !routeAllowed(ess, 'produits', 'achats') && routeAllowed(ess, 'profil'));

  const { t, p } = await server();
  const plan = (await p<any[]>('p.plans.list')).find((x) => x.code === 'essentiel');
  const made = await invite(t, p, { name: 'Menus', ownerName: 'Mehdi', ownerEmail: 'm@menus.dz', planId: plan.id, trialDays: 14 }, 'Menus-Password-1');
  const schema = `shop_${made.id}`;
  const ctxOf = async () => {
    const s = (await loadShop(t, { id: made.id }))!;
    return shopUserCtx(t, schema, 'm@menus.dz', 'Menus-Password-1', shopCtx(s, shopStatus(s, Date.now(), 3)));
  };
  let c = await ctxOf();
  await assert.rejects(call('dellal.inbox', c, {}), (e: any) => e.code === 'forbidden' && e.message === FEATURE_OFF);
  await assert.rejects(call('landing.list', c, {}), (e: any) => e.message === FEATURE_OFF);
  await call('orders.list', c, {});
  // turned on for this shop only
  await p('p.shops.features', { id: made.id, on: ['landing', 'pilotai'], off: ['pilotai/cm', 'nope', 'commandes/xyz'] });
  const s = (await loadShop(t, { id: made.id }))!;
  assert.deepEqual(s.featuresOn, ['landing', 'pilotai']);
  assert.deepEqual(s.featuresOff, ['pilotai/cm']);
  c = await ctxOf();
  await call('landing.list', c, {});
  await call('dellal.inbox', c, {});
  await assert.rejects(call('cm.feed', c, {}), (e: any) => e.message === FEATURE_OFF);
  // locked (expired): only the user's own account answers
  await p('p.shops.update', { id: made.id, trialEndsAt: new Date(Date.now() - 10 * DAY).toISOString() });
  c = await ctxOf();
  assert.equal(c.shop!.locked, true);
  await assert.rejects(call('orders.list', c, {}), (e: any) => e.code === 'payment_required');
  await call('me.get', c, {});
});

test('the plan limits active accounts', async () => {
  const { t, p } = await server();
  const plan = (await p<any[]>('p.plans.list')).find((x) => x.code === 'essentiel');
  const made = await invite(t, p, { name: 'Petite', ownerName: 'Selma', ownerEmail: 's@petite.dz', planId: plan.id, trialDays: 14 }, 'Petite-Password-1');
  await p('p.shops.update', { id: made.id, maxUsers: 2 });
  const s = (await loadShop(t, { id: made.id }))!;
  const c = await shopUserCtx(t, `shop_${made.id}`, 's@petite.dz', 'Petite-Password-1', shopCtx(s, shopStatus(s, Date.now(), 3)));
  const user = { name: 'Agent', password: 'agent-pass-1', roles: ['confirmation'], language: 'fr' };
  const a: any = await call('users.create', c, { ...user, email: 'a@petite.dz' });
  await assert.rejects(call('users.create', c, { ...user, email: 'b@petite.dz' }), /permet 2 comptes/);
  await call('users.update', c, { id: a.id, active: false });
  await call('users.create', c, { ...user, email: 'b@petite.dz' });
  await assert.rejects(call('users.update', c, { id: a.id, active: true }), /permet 2 comptes/);
});

test('staff roles, plans, settings', async () => {
  const { t, p, pctx } = await server();
  await p('p.staff.save', { name: 'Sara', email: 'sara@pilotix.dz', role: 'support', active: true, password: 'Sara-Password-1' });
  await p('p.staff.save', { name: 'Yanis', email: 'yanis@pilotix.dz', role: 'manager', active: true, password: 'Yanis-Password-1' });
  const sara: PCtx = { ...pctx, staff: (await staffLogin(t, 'sara@pilotix.dz', 'Sara-Password-1')).staff };
  const yanis: PCtx = { ...pctx, staff: (await staffLogin(t, 'yanis@pilotix.dz', 'Yanis-Password-1')).staff };
  const plan = (await p<any[]>('p.plans.list')).find((x) => x.code === 'pro');
  await assert.rejects(p('p.shops.create', { name: 'Non', ownerName: 'Nadir', ownerEmail: 'n@n.dz', planId: plan.id, trialDays: 7 }, sara), /Réservé/);
  await p('p.shops.list', {}, sara);
  const made = await p('p.shops.create', { name: 'Oui', ownerName: 'Omar', ownerEmail: 'o@o.dz', planId: plan.id, trialDays: 7 }, yanis);
  await assert.rejects(p('p.plans.save', { name: 'Gratuit', priceMonth: 0, features: [], public: true, active: true }, yanis), /Réservé/);
  await assert.rejects(p('p.staff.list', {}, yanis), /Réservé/);
  await p('p.shops.notes', { id: made.id, notes: 'Appeler lundi' }, sara);
  // the last owner cannot leave
  const me = (await p<any[]>('p.staff.list')).find((s) => s.role === 'owner');
  await assert.rejects(p('p.staff.save', { id: me.id, name: me.name, email: me.email, role: 'manager', active: true }), /au moins un propriétaire/);
  // a plan: unknown menu keys are dropped; the internal plan always keeps everything
  const np = await p('p.plans.save', { name: 'Starter', priceMonth: 1900, features: ['commandes', 'confirmation', '-produits/achats', 'produits', '*x'], public: true, active: true });
  const starter = (await p<any[]>('p.plans.list')).find((x) => x.id === np.id);
  assert.deepEqual(starter.features, ['commandes', '-produits/achats', 'produits']);
  const sys = (await p<any[]>('p.plans.list')).find((x) => x.code === 'interne');
  await p('p.plans.save', { id: sys.id, name: 'Interne', priceMonth: 0, features: ['commandes'], public: true, active: true });
  assert.deepEqual((await p<any[]>('p.plans.list')).find((x) => x.code === 'interne').features, ['*']);
  // settings: payment details shown to shops
  await p('p.settings.save', { payment: { text: 'BaridiMob RIP 00799999…', phone: '0550 11 22 33', whatsapp: '213550112233' }, trial: { days: 7, graceDays: 2, planCode: 'pro' } });
  const set = await p('p.settings.get');
  assert.equal(set.trial.days, 7);
  assert.equal(set.payment.whatsapp, '213550112233');
  await assert.rejects(p('p.settings.save', { trial: { days: 7, graceDays: 2, planCode: 'pro' } }, yanis), /Réservé/);
  // the dashboard
  const d = await p('p.dashboard');
  assert.equal(d.counts.total, 1);
  assert.equal(d.counts.trial, 1);
});

test('the demo shop: fake data, reset to the start, its accounts not in the login index', async () => {
  const { t, p } = await server();
  const r = await p('p.demo.create');
  const s = (await loadShop(t, { id: r.id }))!;
  assert.equal(s.demo, true);
  assert.equal(s.neverExpires, true);
  const n0 = (await t.shop(s.schema).query('SELECT count(*)::int AS n FROM orders'))[0].n;
  assert.ok(n0 > 100);
  assert.equal(await shopIdOfEmail(t, 'admin@demo.pilotix.dz'), null);
  await t.shop(s.schema).query(`UPDATE orders SET customer_name = 'Visiteur' WHERE id IN (SELECT id FROM orders ORDER BY id LIMIT 50)`);
  await p('p.demo.reset');
  assert.equal((await t.shop(s.schema).query('SELECT count(*)::int AS n FROM orders'))[0].n, n0);
  assert.equal((await t.shop(s.schema).query(`SELECT count(*)::int AS n FROM orders WHERE customer_name = 'Visiteur'`))[0].n, 0);
  await assert.rejects(p('p.demo.create'), /existe déjà/);
  const g = await p('p.demo.get');
  assert.equal(g.shop.id, s.id);
});

test('sign-up without a store: only the account; the first store, added inside, keeps the phone and the referral', async () => {
  const { t } = await server();
  const s1 = (await loadShop(t, { primary: true }))!;
  const form = { name: 'Karim Ouali', email: 'karim@nouveau.dz', password: 'karim-pass-1', phone: '0550 11 22 33', language: 'fr', referral: s1.referralCode, terms: true };
  const m = (await startSignup(t, form, '1.2.3.9'))!;
  assert.equal(m.kind, 'confirm');
  assert.equal((m as any).store, '');
  const done: any = await confirmSignup(t, (m as any).token);
  assert.equal(done.shop, null);
  assert.equal(done.account.verified, true);
  assert.equal(done.account.email, 'karim@nouveau.dz');
  const acc = (await accountByEmail(t, 'karim@nouveau.dz'))!;
  const shop = await addStore(t, acc, { name: 'Karim Bébé' });
  assert.equal(shop.ownerAccountId, acc.id);
  const row = (await t.platform.query('SELECT owner_phone, referred_by FROM platform.shops WHERE id = $1', [shop.id]))[0];
  assert.equal(row.owner_phone, '0550 11 22 33');
  assert.equal(Number(row.referred_by), s1.id);
  // an agency or a marketer still gives its name
  await assert.rejects(startSignup(t, { ...form, email: 'ag@nouveau.dz', kind: 'agency' }, '1.2.3.9'), /au moins 2/);
});

test('the sign-in page designs: all on by default; the control room keeps the ones turned on', async () => {
  const { t } = await server();
  assert.equal((await platformSettings(t)).login.designs.length, 20);
  await setPlatformSetting(t, 'login', { designs: [3, 7, 18] });
  assert.deepEqual((await platformSettings(t)).login.designs, [3, 7, 18]);
});
