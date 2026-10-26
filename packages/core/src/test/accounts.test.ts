// Accounts across shops (one e-mail, several shops), the sign-up page, the owner's e-mail confirmation, a shop's own
// domain name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkShopDomain,
  cleanDomain,
  confirmEmail,
  followPasswordChange,
  loadShop,
  login,
  migrate,
  migrateAll,
  pgliteTenancy,
  seedBase,
  setPlatformSetting,
  setShopDomain,
  shopIdByDomain,
  shopIdsOfEmail,
  shopsOpenedBy,
  signupShop,
  slugAvailability,
  spreadResetPassword,
} from '../index';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const DAY = 86_400_000;

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  return t;
}

const NEW = { shopName: 'Bijoux Sétif', name: 'Sara', email: 'sara@bijoux.dz', phone: '0550 11 22 33', password: 'Sara-Password-1' };

test('sign-up: a shop on the trial plan, its owner as administrator, its name unique', async () => {
  const t = await server();
  assert.deepEqual(await slugAvailability(t, 'bijoux-setif'), { slug: 'bijoux-setif', valid: true, available: true, suggestion: 'bijoux-setif' });
  const now = Date.UTC(2026, 9, 26, 10);
  const { shop, confirm } = await signupShop(t, NEW, { ip: '10.0.0.1', now });
  assert.equal(shop.slug, 'bijoux-setif');
  assert.equal(shop.plan?.code, 'pro');
  assert.equal(shop.selfSignup, true);
  assert.equal(Date.parse(shop.trialEndsAt!), now + 14 * DAY);
  assert.equal(shop.emailVerifiedAt, null);
  const s = await login(t.shop(shop.schema), NEW.email, NEW.password);
  assert.equal(s.isAdmin, true);
  // the name is taken now, and a reserved word never works
  assert.equal((await slugAvailability(t, 'bijoux-setif')).available, false);
  assert.equal((await slugAvailability(t, 'bijoux-setif')).suggestion, 'bijoux-setif-2');
  assert.equal((await slugAvailability(t, 'api')).valid, false);
  await assert.rejects(signupShop(t, { ...NEW, email: 'x@y.dz', slug: 'bijoux-setif' }, { ip: '10.0.0.9', now }), /déjà pris/);
  // the link confirms the e-mail, once
  const ok = await confirmEmail(t, confirm, now + DAY);
  assert.ok(ok.emailVerifiedAt);
  await assert.rejects(confirmEmail(t, confirm, now + DAY), /plus valable/);
  await assert.rejects(confirmEmail(t, 'nope', now), /plus valable/);
});

test('sign-up limits: per address and day, per e-mail, closed by the platform', async () => {
  const t = await server();
  const now = Date.UTC(2026, 9, 26, 10);
  await setPlatformSetting(t, 'signup', { open: true, maxShopsPerEmail: 2, perIpPerDay: 2 });
  await signupShop(t, { ...NEW, shopName: 'Un' }, { ip: '10.0.0.1', now });
  await signupShop(t, { ...NEW, shopName: 'Deux', email: 'b@b.dz' }, { ip: '10.0.0.1', now });
  await assert.rejects(signupShop(t, { ...NEW, shopName: 'Trois', email: 'c@c.dz' }, { ip: '10.0.0.1', now }), /Trop d’inscriptions/);
  // the next day the address may again; the e-mail is at its maximum
  await signupShop(t, { ...NEW, shopName: 'Quatre' }, { ip: '10.0.0.1', now: now + 2 * DAY });
  await assert.rejects(signupShop(t, { ...NEW, shopName: 'Cinq' }, { ip: '10.0.0.2', now: now + 2 * DAY }), /maximum/);
  // adding a shop from inside the app: no address limit
  await signupShop(t, { ...NEW, shopName: 'Six', email: 'd@d.dz' }, { ip: '10.0.0.1', now: now + 2 * DAY, fromShopId: 1 });
  await setPlatformSetting(t, 'signup', { open: false, maxShopsPerEmail: 5, perIpPerDay: 3 });
  await assert.rejects(signupShop(t, { ...NEW, shopName: 'Sept', email: 'e@e.dz' }, { ip: '10.0.0.3', now }), /fermées/);
});

test('one person, several shops: the password opens its shops; a change follows, a reset by e-mail opens them all', async () => {
  const t = await server();
  // the owner of shop #1 makes a second shop with the same password, and a third with another
  const two = (await signupShop(t, { ...NEW, shopName: 'Deux', email: OWNER.email, name: 'Amine', password: OWNER.password }, { fromShopId: 1 })).shop;
  const three = (await signupShop(t, { ...NEW, shopName: 'Trois', email: OWNER.email, name: 'Amine', password: 'Another-Pass-9' }, { fromShopId: 1 })).shop;
  assert.deepEqual(await shopIdsOfEmail(t, OWNER.email), [1, two.id, three.id]);
  assert.deepEqual((await shopsOpenedBy(t, OWNER.email, OWNER.password)).map((x) => x.shop.id), [1, two.id]);
  assert.deepEqual((await shopsOpenedBy(t, OWNER.email, 'Another-Pass-9')).map((x) => x.shop.id), [three.id]);
  assert.deepEqual(await shopsOpenedBy(t, OWNER.email, 'wrong'), []);
  // a new password in shop #1: shop 2 (same password) follows, shop 3 keeps its own
  await t.shop('public').query(`UPDATE profiles SET password_hash = (SELECT password_hash FROM ${two.schema}.profiles WHERE id = 1) WHERE id = 1`);
  assert.deepEqual(await followPasswordChange(t, OWNER.email, OWNER.password, 'New-Password-77', 1), [two.id]);
  assert.ok(await login(t.shop(two.schema), OWNER.email, 'New-Password-77'));
  assert.deepEqual((await shopsOpenedBy(t, OWNER.email, 'Another-Pass-9')).map((x) => x.shop.id), [three.id]);
  // « mot de passe oublié » used in shop 3: the person proved the e-mail is theirs, every shop takes that password
  assert.deepEqual(await spreadResetPassword(t, OWNER.email, three.id), [1, two.id]);
  assert.deepEqual((await shopsOpenedBy(t, OWNER.email, 'Another-Pass-9')).map((x) => x.shop.id), [1, two.id, three.id]);
});

test('own domain: cleaned, never the platform or another shop, ready once its DNS points to the server', async () => {
  const t = await server();
  const two = (await signupShop(t, { ...NEW }, {})).shop;
  const three = (await signupShop(t, { ...NEW, shopName: 'Trois', email: 'z@z.dz' }, {})).shop;
  assert.equal(cleanDomain(' https://WWW.Bijoux-Setif.com/page?x=1 '), 'www.bijoux-setif.com');
  assert.equal(cleanDomain('pas un domaine'), null);
  await assert.rejects(setShopDomain(t, two.id, 'shop.pilotix.online', 'pilotix.online'), /appartient à Pilotix/);
  await assert.rejects(setShopDomain(t, two.id, 'nope', 'pilotix.online'), /invalide/);
  const s = await setShopDomain(t, two.id, 'www.bijoux-setif.com', 'pilotix.online');
  assert.equal(s.domain, 'www.bijoux-setif.com');
  assert.equal(s.domainStatus, 'pending');
  await assert.rejects(setShopDomain(t, three.id, 'WWW.bijoux-setif.com', 'pilotix.online'), /autre boutique/);
  assert.equal(await shopIdByDomain(t, 'www.bijoux-setif.com'), null);
  // the DNS: wrong address, then the server's
  const dns = (m: Record<string, string[]>) => async (h: string) => m[h] ?? [];
  assert.equal((await checkShopDomain(t, two.id, 'pilotix.online', dns({ 'pilotix.online': ['1.2.3.4'], 'www.bijoux-setif.com': ['9.9.9.9'] }))).ok, false);
  assert.equal((await checkShopDomain(t, two.id, 'pilotix.online', dns({ 'pilotix.online': ['1.2.3.4'], 'www.bijoux-setif.com': ['1.2.3.4'] }))).ok, true);
  assert.equal(await shopIdByDomain(t, 'WWW.Bijoux-Setif.com:443'), two.id);
  // a suspended shop's domain answers nothing; removing the domain frees it
  await t.platform.query(`UPDATE platform.shops SET status = 'suspended' WHERE id = $1`, [two.id]);
  assert.equal(await shopIdByDomain(t, 'www.bijoux-setif.com'), null);
  await setShopDomain(t, two.id, null, 'pilotix.online');
  assert.equal((await loadShop(t, { id: two.id }))!.domainStatus, 'none');
  await setShopDomain(t, three.id, 'www.bijoux-setif.com', 'pilotix.online');
});
