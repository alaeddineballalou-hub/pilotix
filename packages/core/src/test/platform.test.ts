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
  shopIdsOfEmail,
  shopsOpenedBy,
  shopStatus,
  staffLogin,
  Tenancy,
} from '../index';
import { landingStore } from '../modules/landingquery';
import { syncPrimaryStore } from '../platform/shops';
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

async function shopUserCtx(t: Tenancy, schema: string, email: string, password: string, shop?: Ctx['shop']): Promise<Ctx> {
  const db = t.shop(schema);
  return { db, session: await login(db, email, password), now: () => Date.now(), emit: () => {}, shop };
}

test('first start: the existing shop becomes shop #1, its admin the platform owner', async () => {
  const { t, applied, staff } = await server();
  assert.deepEqual(applied.platform, ['p001_platform', 'p002_accounts_signup_domains']);
  assert.deepEqual(applied.public, []);
  const s1 = (await loadShop(t, { primary: true }))!;
  assert.equal(s1.schema, 'public');
  assert.equal(s1.neverExpires, true);
  assert.equal(s1.plan?.code, 'interne');
  assert.equal(await shopIdOfEmail(t, ' OWNER@boutique.dz '), s1.id);
  assert.equal(staff.role, 'owner');
  assert.equal(staff.email, OWNER.email);
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
  const made = await p('p.shops.create', { name: 'Bébé Confort Oran', ownerName: 'Karim', ownerEmail: 'Karim@Oran.dz', ownerPhone: '0550 00 00 00', planId: pro.id, trialDays: 14 });
  assert.equal(made.slug, 'bebe-confort-oran');
  assert.match(made.password, /^Pilotix-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
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

test('one e-mail, several shops: each shop keeps its accounts, the login index lists them all', async () => {
  const { t, p } = await server();
  const plan = (await p<any[]>('p.plans.list')).find((x) => x.code === 'business');
  // the owner of shop #1 may own another shop (its own password there)
  const other = await p('p.shops.create', { name: 'Deuxième', ownerName: 'Amine', ownerEmail: OWNER.email, planId: plan.id, trialDays: 7, password: 'Other-Password-1' });
  assert.deepEqual(await shopIdsOfEmail(t, OWNER.email), [1, other.id]);
  const made = await p('p.shops.create', { name: 'Shop Deux', ownerName: 'Lina', ownerEmail: 'lina@deux.dz', planId: plan.id, trialDays: 7, password: 'Lina-Password-1' });
  const schema = `shop_${made.id}`;
  const lina = await shopUserCtx(t, schema, 'lina@deux.dz', 'Lina-Password-1');
  const amine = await shopUserCtx(t, 'public', OWNER.email, OWNER.password);
  const user = { name: 'Agent', password: 'agent-pass-1', roles: ['confirmation'], language: 'fr' };
  // the same person may work in two shops; inside one shop an e-mail is still unique
  await call('users.create', lina, { ...user, email: 'agent@deux.dz' });
  await assert.rejects(call('users.create', lina, { ...user, email: 'agent@deux.dz' }), /déjà utilisé/);
  const a1: any = await call('users.create', amine, { ...user, email: 'agent@deux.dz', password: 'other-pass-22' });
  assert.deepEqual(await shopIdsOfEmail(t, 'agent@deux.dz'), [1, made.id]);
  // the login page offers only the shops the password opens: shop #1's admin setting a password never opens shop 2
  assert.deepEqual((await shopsOpenedBy(t, 'agent@deux.dz', 'other-pass-22')).map((x) => x.shop.id), [1]);
  assert.deepEqual((await shopsOpenedBy(t, 'agent@deux.dz', 'agent-pass-1')).map((x) => x.shop.id), [made.id]);
  // changing the e-mail in one shop moves only that shop's line
  await call('users.update', amine, { id: a1.id, email: 'agent2@un.dz' });
  assert.deepEqual(await shopIdsOfEmail(t, 'agent@deux.dz'), [made.id]);
  assert.deepEqual(await shopIdsOfEmail(t, 'agent2@un.dz'), [1]);
  // a closed account leaves the index (the same "deleted-…@pilotix.invalid" in two shops is fine)
  const agent = await shopUserCtx(t, schema, 'agent@deux.dz', 'agent-pass-1');
  await call('me.delete', agent, { password: 'agent-pass-1' });
  assert.deepEqual(await shopIdsOfEmail(t, 'agent@deux.dz'), []);
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
  // the journal
  const log = await p<any[]>('p.audit.list', { shopId: made.id });
  assert.deepEqual(
    log.map((l) => l.action).reverse(),
    ['shop.create', 'payment.add', 'payment.add', 'payment.void', 'shop.suspend', 'payment.add'],
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
  const made = await p('p.shops.create', { name: 'Menus', ownerName: 'Mehdi', ownerEmail: 'm@menus.dz', planId: plan.id, trialDays: 14, password: 'Menus-Password-1' });
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
  const made = await p('p.shops.create', { name: 'Petite', ownerName: 'Selma', ownerEmail: 's@petite.dz', planId: plan.id, trialDays: 14, password: 'Petite-Password-1' });
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
