// A shop's own domain name for its landing pages (myshop.com): cleaned, never the platform's nor another shop's, ready
// once its TXT record proves it is the shop's and the site answers in HTTPS from this server (Cloudflare or not).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkShopDomain, cleanDomain, domainFallback, domainProof, loadShop, migrate, migrateAll, pgliteTenancy, provisionShop, seedBase, setShopDomain, shopIdByDomain, shopIdForCertificate } from '../index';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  return t;
}

test('own domain: cleaned, never the platform or another shop, ready once its TXT proves it and it answers in HTTPS', async () => {
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
  // the outside world as the check sees it: TXT texts, the HTTPS test (counted), the addresses (only shown)
  const txt = (m: Record<string, string[]>) => async (h: string) => m[h] ?? [];
  const proofOf = (id: number) => ({ '_pilotix.www.bijoux-setif.com': ['other', domainProof(id, 'www.bijoux-setif.com')] });
  let tests = 0;
  const look = (m: Record<string, string[]>, https: { ok: boolean; why?: any }, ips: string[] = ['104.21.5.6']) => ({
    resolveTxt: txt(m),
    reaches: async () => (tests++, https),
    resolve: async () => ips,
  });
  // answering in HTTPS is not enough: every shop's domain reaches this server. Without the shop's TXT proof it stays
  // pending, and the HTTPS test is not even run (it would make Caddy ask for a certificate)
  const noProof = await checkShopDomain(t, two.id, look({}, { ok: true }));
  assert.deepEqual([noProof.ok, noProof.proof, noProof.https, tests], [false, false, false, 0]);
  // … and another shop that only typed it first does not keep it from its real owner: it loses it
  await setShopDomain(t, three.id, 'WWW.bijoux-setif.com', 'pilotix.online');
  assert.equal((await loadShop(t, { id: two.id }))!.domain, null);
  // the other shop's proof is refused
  assert.equal((await checkShopDomain(t, three.id, look(proofOf(two.id), { ok: true }))).ok, false);
  await setShopDomain(t, two.id, 'www.bijoux-setif.com', 'pilotix.online');
  assert.equal((await loadShop(t, { id: three.id }))!.domain, null);
  // the proof is there but the site does not answer from Pilotix yet: pending, with the reason for the owner
  const notYet = await checkShopDomain(t, two.id, look(proofOf(two.id), { ok: false, why: 'tls' }));
  assert.deepEqual([notYet.ok, notYet.proof, notYet.https, notYet.why], [false, true, false, 'tls']);
  // proof + HTTPS answer: ready, whatever its addresses are (here Cloudflare's: the orange cloud)
  const ready = await checkShopDomain(t, two.id, look(proofOf(two.id), { ok: true }, ['104.21.5.6', '172.67.1.2']));
  assert.deepEqual([ready.ok, ready.proof, ready.https, ready.found], [true, true, true, ['104.21.5.6', '172.67.1.2']]);
  // once ready, nobody else takes it
  await assert.rejects(setShopDomain(t, three.id, 'WWW.bijoux-setif.com', 'pilotix.online'), /autre boutique/);
  // a ready domain that still carries its proof stays ready when the HTTPS test fails once (Cloudflare, the network)
  assert.equal((await checkShopDomain(t, two.id, look(proofOf(two.id), { ok: false, why: 'timeout' }))).ok, true);
  // a domain ready before the proof existed stays ready while it answers (without its TXT) …
  assert.equal((await checkShopDomain(t, two.id, look({}, { ok: true }))).ok, true);
  assert.equal(await shopIdByDomain(t, 'WWW.Bijoux-Setif.com:443'), two.id);
  // … and goes back to pending when it neither answers nor carries its proof
  assert.equal((await checkShopDomain(t, two.id, look({}, { ok: false, why: 'other-site' }))).ok, false);
  assert.equal(await shopIdByDomain(t, 'www.bijoux-setif.com'), null);
  assert.equal((await checkShopDomain(t, two.id, look(proofOf(two.id), { ok: true }))).ok, true);
  // a suspended shop's domain answers nothing; removing the domain frees it
  await t.platform.query(`UPDATE platform.shops SET status = 'suspended' WHERE id = $1`, [two.id]);
  assert.equal(await shopIdByDomain(t, 'www.bijoux-setif.com'), null);
  await setShopDomain(t, two.id, null, 'pilotix.online');
  assert.equal((await loadShop(t, { id: two.id }))!.domainStatus, 'none');
  await setShopDomain(t, three.id, 'www.bijoux-setif.com', 'pilotix.online');
});

test('own domain: Caddy may make the certificate of a ready domain, or of a pending one whose TXT already proves it', async () => {
  const t = await server();
  const shop = await provisionShop(t, { name: 'Baby', planId: null, trialDays: 14, owner: { name: 'Ala', email: 'ala@baby.dz' }, password: 'Ala-Password-1' });
  const txt = (m: Record<string, string[]>) => async (h: string) => m[h] ?? [];
  const proof = { '_pilotix.babyjoydz.net': [domainProof(shop.id, 'babyjoydz.net')] };
  // nobody's domain: nothing
  assert.equal(await shopIdForCertificate(t, 'random-name.com', txt({})), null);
  await setShopDomain(t, shop.id, 'babyjoydz.net', 'pilotix.online');
  // pending without its TXT: nothing (a name pointed here by anyone gets no certificate)
  assert.equal(await shopIdForCertificate(t, 'babyjoydz.net', txt({})), null);
  // another shop's proof: nothing
  assert.equal(await shopIdForCertificate(t, 'babyjoydz.net', txt({ '_pilotix.babyjoydz.net': [domainProof(shop.id + 1, 'babyjoydz.net')] })), null);
  // pending with its TXT proof: yes (the HTTPS test needs the certificate before the domain can be ready)
  assert.equal(await shopIdForCertificate(t, 'BabyJoyDZ.net:443', txt(proof)), shop.id);
  // ready: yes, without asking the DNS
  await checkShopDomain(t, shop.id, { resolveTxt: txt(proof), reaches: async () => ({ ok: true }) });
  assert.equal(await shopIdForCertificate(t, 'babyjoydz.net', async () => { throw new Error('no DNS asked'); }), shop.id);
  // a suspended shop: nothing, proof or not
  await t.platform.query(`UPDATE platform.shops SET status = 'suspended' WHERE id = $1`, [shop.id]);
  assert.equal(await shopIdForCertificate(t, 'babyjoydz.net', txt(proof)), null);
});

test('own domain: an address that is none of its pages leads to the shop home, a file stays not found', () => {
  // old links from the site the domain came from (JustSell: /product/28026), a page taken offline, a typo
  assert.equal(domainFallback('/product/28026'), '/');
  assert.equal(domainFallback('/product/28026?fbclid=IwAR0abc'), '/');
  assert.equal(domainFallback('/old-page'), '/');
  assert.equal(domainFallback('/Landau-Gargour'), '/');
  assert.equal(domainFallback('/cart/checkout/'), '/');
  assert.equal(domainFallback('/product/28026.html'), '/');
  // a page's address with a slash at its end: that page
  assert.equal(domainFallback('/landau-gargour/'), '/landau-gargour');
  // files and hidden addresses: not found
  assert.equal(domainFallback('/favicon.ico'), null);
  assert.equal(domainFallback('/sitemap.xml'), null);
  assert.equal(domainFallback('/.well-known/security.txt'), null);
  assert.equal(domainFallback('/.env'), null);
  // the home itself never sends anyone anywhere (no circle)
  assert.equal(domainFallback('/'), null);
  assert.equal(domainFallback(''), null);
  assert.equal(domainFallback('/?x=1'), null);
});

test('the addresses of a domain behind Cloudflare’s orange cloud are known as Cloudflare’s', async () => {
  const { isCloudflareIp } = await import('@pilotix/shared');
  // babyjoydz.net behind the orange cloud would show such addresses; the server's own and other hosts' are not Cloudflare's
  for (const ip of ['104.21.32.1', '172.67.150.12', '188.114.97.3', '162.159.1.1', '173.245.48.0', '131.0.75.255']) assert.equal(isCloudflareIp(ip), true, ip);
  for (const ip of ['161.97.171.250', '203.0.113.10', '1.1.1.1', '104.32.0.1', '131.0.76.0', '2606:4700::1', '', 'not-an-ip', '104.21.32', '256.1.1.1']) assert.equal(isCloudflareIp(ip), false, ip);
});
