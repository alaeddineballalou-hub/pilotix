// Pro marketers: a marketer's space asks « Passer Pro » (its profile and prices written first), Pilotix's staff turn it
// on once paid, and while Pro, verified and active it shows on Pilotix's list: the stores' « Trouver un marketer Pro »
// (with the invite) and the public page. Its numbers come from every store its people made ad sets for, also the
// stores where one of them had an account of their own; réussies ÷ (réussies + ratées) is its rate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { listPros, proByCode, computeProStats, STATS_HOURS } from '../modules/pro';
import { confirmSignup, loadShop, passwordFromLink, setPlatformSetting, startSignup } from '../platform';

let phoneN = 0;
const tph = () => `074${String(++phoneN).padStart(7, '0')}`;
const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const PW = 'Marketer-Password-1';
const PRICES = { perConfirmed: 0, perDelivered: 200, perUpsell: 0, monthly: 0, bonusRate: { min: 0, amount: 0 }, bonusVolume: { above: 0, amount: 0 }, perSuccess: 15000, profitRate: 0 };
const PROFILE = { niches: ['electronics', 'watches'], platforms: ['facebook', 'tiktok'], city: 'Alger', bio: 'Pubs qui vendent.', visible: true };

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = <T = any>(name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<T>;
  return { t, p };
}
async function as(t: Tenancy, shopId: number, email: string, password: string, now = () => Date.now()): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, password), now, emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t };
}
async function store(t: Tenancy, p: (n: string, i?: unknown) => Promise<any>, name: string, email: string) {
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
  const made = await p('p.shops.create', { name, ownerName: 'Karim', ownerEmail: email, planId: biz.id, trialDays: 14 });
  await passwordFromLink(t, made.mail.token, PW);
  const s = (await loadShop(t, { id: made.id }))!;
  const db = t.shop(s.schema);
  await db.query(`INSERT INTO products (name, sku, price) VALUES ('Montre', 'MONT', 9000), ('Écouteurs', 'ECOU', 4000)`);
  const ids = (await db.query('SELECT id, sku FROM products ORDER BY id')).reduce((m: Record<string, number>, r: any) => ({ ...m, [r.sku]: Number(r.id) }), {});
  return { id: s.id, db, code: s.publicCode!, products: ids as Record<'MONT' | 'ECOU', number> };
}
async function marketer(t: Tenancy, name: string, email: string) {
  const mail: any = await startSignup(t, { name: 'Yacine', email, phone: tph(), password: PW, storeName: name, language: 'fr', terms: true, kind: 'marketer' }, null);
  const made: any = await confirmSignup(t, mail.token);
  return { id: made.shop.id as number, code: made.shop.publicCode as string };
}
/** An ad set made by this profile, with spend; its result forced (ok / ko) or left running. */
async function adset(db: any, id: string, productId: number, marketerId: number, st: 'ok' | 'ko' | 'run') {
  await db.query(`INSERT INTO adsets (id, name, product_ids, marketer_id, status) VALUES ($1, $1, $2, $3, $4)`, [id, [productId], marketerId, st === 'run' ? 'ACTIVE' : 'PAUSED']);
  await db.query(`INSERT INTO ad_insights (day, adset_id, spend_cents, impressions, clicks, purchases) VALUES (CURRENT_DATE, $1, 2000, 1000, 10, 1)`, [id]);
  if (st !== 'run') await db.query(`INSERT INTO mk_results (adset_id, st) VALUES ($1, $2)`, [id, st]);
}

test('Pro marketers: ask, staff turn it on, the list, the numbers across stores, the invite', async () => {
  const { t, p } = await server();
  const oran = await store(t, p, 'Boutique Oran', 'karim@oran.dz');
  const alger = await store(t, p, 'Boutique Alger', 'sara@alger.dz');
  const mk = await marketer(t, 'Yacine Ads', 'yacine@ads.dz');
  const chief = await as(t, mk.id, 'yacine@ads.dz', PW);
  const admin = await as(t, oran.id, 'karim@oran.dz', PW);
  const other = await as(t, alger.id, 'sara@alger.dz', PW);

  // its own side only: a store cannot open the marketer's Pro, a marketer cannot search
  await assert.rejects(call('agency.pro.me', admin, {}), /Réservé aux agences|espaces marketer/);
  await assert.rejects(call('partners.pro.search', chief, {}), /espace d’un marketer/);

  // not Pro yet: its state, the price by the month, no stores' numbers yet
  const me0: any = await call('agency.pro.me', chief, {});
  assert.deepEqual([me0.active, me0.until, me0.askedAt, me0.verified, me0.price, me0.listed], [false, null, null, false, 2000, false]);
  assert.deepEqual(me0.card.stats, { adsets: 0, ok: 0, ko: 0, run: 0, stores: 0, products: 0 });
  assert.equal(me0.card.rate, null);

  // « Passer Pro » needs its profile (a platform at least), then its prices
  await assert.rejects(call('agency.pro.ask', chief, {}), /profil Pro/);
  await assert.rejects(call('agency.pro.save', chief, { ...PROFILE, platforms: [] }), /au moins une plateforme/);
  await assert.rejects(call('agency.pro.save', chief, { ...PROFILE, niches: ['cosmetics', 'beauty', 'home', 'kids', 'pets'] }), /4 niches/);
  await assert.rejects(call('agency.pro.save', chief, { ...PROFILE, niches: ['nope'] }));
  await call('agency.pro.save', chief, PROFILE);
  await assert.rejects(call('agency.pro.ask', chief, {}), /vos prix/);
  await call('agency.prices', chief, { prices: PRICES });
  const asked: any = await call('agency.pro.ask', chief, {});
  assert.ok(asked.askedAt);
  // asking twice keeps the first date; cancelling clears it
  assert.equal(((await call('agency.pro.ask', chief, {})) as any).askedAt, asked.askedAt);
  assert.equal(((await call('agency.pro.ask', chief, { cancel: true })) as any).askedAt, null);
  await call('agency.pro.ask', chief, {});

  // the control room sees the request; Pro needs the marketer checked first
  const row = (await p<any[]>('p.agencies.list', { kind: 'marketer' })).find((a) => a.id === mk.id);
  assert.equal(row.pro.active, false);
  assert.ok(row.pro.askedAt);
  await assert.rejects(p('p.pro.activate', { id: mk.id, months: 1, amount: 2000, method: 'baridimob' }), /Vérifiez d’abord/);
  await assert.rejects(p('p.pro.activate', { id: oran.id, months: 1, amount: 2000, method: 'baridimob' }), /réservé aux espaces marketer/);
  await p('p.agencies.verify', { id: mk.id, verified: true });
  // still not on the list: not paid
  assert.deepEqual(await listPros(t, Date.now()), []);
  const on: any = await p('p.pro.activate', { id: mk.id, months: 2, amount: 4000, method: 'baridimob', note: 'RIP 123' });
  const days = (Date.parse(on.until) - Date.now()) / 86_400_000;
  assert.ok(days > 55 && days < 63, `two months ahead, got ${days}`);
  // prolonged: from the end of the months already paid
  const on2: any = await p('p.pro.activate', { id: mk.id, months: 1, amount: 2000, method: 'cash' });
  assert.ok(Date.parse(on2.until) > Date.parse(on.until) + 27 * 86_400_000);
  const pays = await p<any[]>('p.pro.payments', { id: mk.id });
  assert.deepEqual(pays.map((x) => [x.months, x.amount, x.method]), [[1, 2000, 'cash'], [2, 4000, 'baridimob']]);
  const row2 = (await p<any[]>('p.agencies.list', { kind: 'marketer' })).find((a) => a.id === mk.id);
  assert.deepEqual([row2.pro.active, row2.pro.askedAt], [true, null]);

  // on the list now: the stores' search and the public page
  const s1: any = await call('partners.pro.search', admin, {});
  assert.deepEqual(s1.pros.map((c: any) => [c.name, c.code, c.profile.city, c.profile.niches, c.link]), [['Yacine Ads', mk.code, 'Alger', ['electronics', 'watches'], null]]);
  assert.equal(s1.pros[0].prices.perSuccess, 15000);
  assert.equal((await proByCode(t, mk.code.toLowerCase(), Date.now()))?.name, 'Yacine Ads');
  assert.equal(await proByCode(t, 'MK-ZZZZ', Date.now()), null);
  // the filters: a word, a niche, a platform
  assert.equal(((await call('partners.pro.search', admin, { q: 'alger' })) as any).pros.length, 1);
  assert.equal(((await call('partners.pro.search', admin, { q: 'oran' })) as any).pros.length, 0);
  assert.equal(((await call('partners.pro.search', admin, { niche: 'watches' })) as any).pros.length, 1);
  assert.equal(((await call('partners.pro.search', admin, { niche: 'cosmetics' })) as any).pros.length, 0);
  assert.equal(((await call('partners.pro.search', admin, { platform: 'tiktok' })) as any).pros.length, 1);
  assert.equal(((await call('partners.pro.search', admin, { platform: 'snapchat' })) as any).pros.length, 0);

  // « Inviter dans mon équipe »: the usual request; the search then shows it waiting, the marketer accepts
  const { id: linkId } = (await call('partners.request', admin, { agencyId: mk.id, tasks: ['marketing'], products: [oran.products.MONT] })) as any;
  assert.deepEqual(((await call('partners.pro.search', admin, {})) as any).pros[0].link, { id: linkId, status: 'pending' });
  // another store sees no link of its own
  assert.equal(((await call('partners.pro.search', other, {})) as any).pros[0].link, null);
  await call('agency.answer', chief, { id: linkId, accept: true });
  assert.equal(((await call('partners.pro.search', admin, {})) as any).pros[0].link.status, 'active');

  // its numbers: its people's ad sets in Oran (the partner's account there) …
  const nadir: any = await call('users.create', chief, { phone: tph(), name: 'Nadir', email: 'nadir@ads.dz', password: PW, roles: ['marketer'] });
  await call('agency.setAgents', chief, { id: linkId, people: [nadir.id] });
  const inOran = Number((await oran.db.query(`SELECT id FROM profiles WHERE email = 'nadir@ads.dz'`))[0].id);
  await adset(oran.db, 'O-1', oran.products.MONT, inOran, 'ok');
  await adset(oran.db, 'O-2', oran.products.MONT, inOran, 'ok');
  await adset(oran.db, 'O-3', oran.products.MONT, inOran, 'ko');
  await adset(oran.db, 'O-4', oran.products.MONT, inOran, 'run');
  // … a store's own ad set that never spent does not count, nor the store's own marketers' ad sets
  await oran.db.query(`INSERT INTO adsets (id, name, product_ids, marketer_id, status) VALUES ('O-5', 'jamais lancé', $1, $2, 'PAUSED')`, [[oran.products.ECOU], inOran]);
  const ownMk: any = await call('users.create', admin, { phone: tph(), name: 'Interne', email: 'interne@oran.dz', password: PW, roles: ['marketer'] });
  await adset(oran.db, 'O-6', oran.products.ECOU, ownMk.id, 'ok');
  // … and Alger, where Nadir has an account of his own (his work before the space)
  const nadirAlger = { id: Number((await alger.db.query(`INSERT INTO profiles (name, email, password_hash, roles, active) VALUES ('Nadir', 'nadir@ads.dz', 'x', '{marketer}', false) RETURNING id`))[0].id) };
  await adset(alger.db, 'A-1', alger.products.ECOU, nadirAlger.id, 'ok');
  await adset(alger.db, 'A-2', alger.products.MONT, nadirAlger.id, 'ko');
  const st = await computeProStats(t, mk.id, Date.now());
  assert.deepEqual(st, { adsets: 6, ok: 3, ko: 2, run: 1, stores: 2, products: 3 });

  // the card keeps the numbers a few hours (the stores are not opened at each search) …
  const cached: any = await call('partners.pro.search', admin, {});
  assert.equal(cached.pros[0].stats.adsets, 0);
  // … the marketer's own page counts them again (now) …
  const me1: any = await call('agency.pro.me', chief, {});
  assert.equal(me1.card.rate, 60);
  assert.deepEqual([me1.active, me1.listed, me1.card.stats.ok, me1.card.stats.stores], [true, true, 3, 2]);
  // … and the list once they are old
  await t.platform.query(`UPDATE platform.shops SET pro_stats_at = now() - make_interval(hours => $2) WHERE id = $1`, [mk.id, STATS_HOURS + 1]);
  await adset(alger.db, 'A-3', alger.products.MONT, nadirAlger.id, 'ok');
  const fresh = await listPros(t, Date.now());
  assert.deepEqual([fresh[0].stats.ok, fresh[0].rate], [4, 67]);

  // the best rate first; a Pro not judged yet after
  const mk2 = await marketer(t, 'Lina Ads', 'lina@ads.dz');
  const lina = await as(t, mk2.id, 'lina@ads.dz', PW);
  await call('agency.pro.save', lina, { ...PROFILE, niches: ['cosmetics'], city: 'Oran' });
  await call('agency.prices', lina, { prices: PRICES });
  await p('p.agencies.verify', { id: mk2.id, verified: true });
  await p('p.pro.activate', { id: mk2.id, months: 1, amount: 2000, method: 'ccp' });
  assert.deepEqual((await listPros(t, Date.now())).map((c) => [c.name, c.rate]), [['Yacine Ads', 67], ['Lina Ads', null]]);

  // hidden by itself, suspended, unchecked, stopped, expired, or Pro turned off by Pilotix: off the list
  await call('agency.pro.save', lina, { ...PROFILE, visible: false });
  assert.deepEqual((await listPros(t, Date.now())).map((c) => c.name), ['Yacine Ads']);
  assert.equal(((await call('agency.pro.me', lina, {})) as any).listed, false);
  await call('agency.pro.save', lina, PROFILE);
  await p('p.shops.setStatus', { id: mk2.id, status: 'suspended' });
  assert.deepEqual((await listPros(t, Date.now())).map((c) => c.name), ['Yacine Ads']);
  await p('p.shops.setStatus', { id: mk2.id, status: 'active' });
  await p('p.agencies.verify', { id: mk2.id, verified: false });
  assert.deepEqual((await listPros(t, Date.now())).map((c) => c.name), ['Yacine Ads']);
  await p('p.agencies.verify', { id: mk2.id, verified: true });
  assert.equal((await listPros(t, Date.now())).length, 2);
  await p('p.pro.stop', { id: mk2.id });
  assert.deepEqual((await listPros(t, Date.now())).map((c) => c.name), ['Yacine Ads']);
  assert.equal(((await call('agency.pro.me', lina, {})) as any).active, false);
  await t.platform.query(`UPDATE platform.shops SET pro_until = now() - interval '1 minute' WHERE id = $1`, [mk.id]);
  assert.deepEqual(await listPros(t, Date.now()), []);
  await t.platform.query(`UPDATE platform.shops SET pro_until = now() + interval '1 day' WHERE id = $1`, [mk.id]);
  await setPlatformSetting(t, 'pro', { on: false, price: 2000 });
  assert.deepEqual(await listPros(t, Date.now()), []);
  assert.equal(await proByCode(t, mk.code, Date.now()), null);
  await assert.rejects(call('agency.pro.ask', lina, {}), /pas proposé/);
  await setPlatformSetting(t, 'pro', { on: true, price: 2500 });
  assert.equal(((await call('agency.pro.me', lina, {})) as any).price, 2500);
  assert.equal((await listPros(t, Date.now())).length, 1);

  // each payment is kept
  const pay = await p<any[]>('p.pro.payments', { id: mk2.id });
  assert.equal(pay.length, 1);
});
