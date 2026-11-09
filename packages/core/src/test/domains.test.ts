// A shop's own domain name for its landing pages (myshop.com): cleaned, never the platform's nor another shop's, ready
// once its DNS points to this server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkShopDomain, cleanDomain, domainProof, loadShop, migrate, migrateAll, pgliteTenancy, provisionShop, seedBase, setShopDomain, shopIdByDomain } from '../index';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  return t;
}

test('own domain: cleaned, never the platform or another shop, ready once its DNS points to the server', async () => {
  const t = await server();
  const two = await provisionShop(t, { name: 'Bijoux Sétif', planId: null, trialDays: 14, owner: { name: 'Sara', email: 'sara@bijoux.dz' }, password: 'Sara-Password-1' });
  const three = await provisionShop(t, { name: 'Trois', planId: null, trialDays: 14, owner: { name: 'Zed', email: 'z@z.dz' }, password: 'Zed-Password-1' });
  assert.equal(cleanDomain(' https://WWW.Bijoux-Setif.com/page?x=1 '), 'www.bijoux-setif.com');
  assert.equal(cleanDomain('pas un domaine'), null);
  await assert.rejects(setShopDomain(t, two.id, 'shop.pilotix.online', 'pilotix.online'), /appartient à Pilotix/);
  await assert.rejects(setShopDomain(t, two.id, 'nope', 'pilotix.online'), /invalide/);
  const s = await setShopDomain(t, two.id, 'www.bijoux-setif.com', 'pilotix.online');
  assert.equal(s.domain, 'www.bijoux-setif.com');
  assert.equal(s.domainStatus, 'pending');
  assert.equal(await shopIdByDomain(t, 'www.bijoux-setif.com'), null);
  // the DNS: wrong address, then the server's
  const dns = (m: Record<string, string[]>) => async (h: string) => m[h] ?? [];
  const here = { 'pilotix.online': ['1.2.3.4'], 'www.bijoux-setif.com': ['1.2.3.4'] };
  assert.equal((await checkShopDomain(t, two.id, 'pilotix.online', dns({ 'pilotix.online': ['1.2.3.4'], 'www.bijoux-setif.com': ['9.9.9.9'] }))).ok, false);
  // pointing here is not enough: every shop's domain points here. Without the shop's TXT proof it stays pending …
  const noProof = await checkShopDomain(t, two.id, 'pilotix.online', dns(here), dns({}));
  assert.deepEqual([noProof.ok, noProof.proof], [false, false]);
  // … and another shop that only typed it first does not keep it from its real owner: it loses it
  await setShopDomain(t, three.id, 'WWW.bijoux-setif.com', 'pilotix.online');
  assert.equal((await loadShop(t, { id: two.id }))!.domain, null);
  // the other shop's proof is refused; the owner's own proof makes it ready
  assert.equal((await checkShopDomain(t, three.id, 'pilotix.online', dns(here), dns({ '_pilotix.www.bijoux-setif.com': [domainProof(two.id, 'www.bijoux-setif.com')] }))).ok, false);
  await setShopDomain(t, two.id, 'www.bijoux-setif.com', 'pilotix.online');
  assert.equal((await loadShop(t, { id: three.id }))!.domain, null);
  assert.equal((await checkShopDomain(t, two.id, 'pilotix.online', dns(here), dns({ '_pilotix.www.bijoux-setif.com': ['other', domainProof(two.id, 'www.bijoux-setif.com')] }))).ok, true);
  // once ready, nobody else takes it
  await assert.rejects(setShopDomain(t, three.id, 'WWW.bijoux-setif.com', 'pilotix.online'), /autre boutique/);
  // a domain ready before the proof existed stays ready while it points here (without its TXT)
  assert.equal((await checkShopDomain(t, two.id, 'pilotix.online', dns(here), dns({}))).ok, true);
  assert.equal(await shopIdByDomain(t, 'WWW.Bijoux-Setif.com:443'), two.id);
  // a suspended shop's domain answers nothing; removing the domain frees it
  await t.platform.query(`UPDATE platform.shops SET status = 'suspended' WHERE id = $1`, [two.id]);
  assert.equal(await shopIdByDomain(t, 'www.bijoux-setif.com'), null);
  await setShopDomain(t, two.id, null, 'pilotix.online');
  assert.equal((await loadShop(t, { id: two.id }))!.domainStatus, 'none');
  await setShopDomain(t, three.id, 'www.bijoux-setif.com', 'pilotix.online');
});
