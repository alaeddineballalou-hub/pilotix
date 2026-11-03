// « Mes boutiques »: one seller account, many boutiques. Only the owner changes a boutique's name and logo; its link was
// chosen when it was made and never changes (pilotix.online/<link>/…); the boutique at the bottom of the menu lists the
// person's boutiques with their logos. The in-browser demo's three boutiques.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, pgliteTenancy, seedBase, shopCtx, shopStatus, Tenancy } from '../index';
import { DEMO_BOUTIQUES, seedDemoBoutiques } from '../demoBoutiques';
import { seedDemo } from '../seed';
import { storeChoices, storeNameCheck } from '../platform';
import { freeSlug, loadShop, platformSettings, provisionShop, syncPrimaryStore } from '../platform/shops';
import { landingStore } from '../modules/landingquery';
import { getSetting, setSetting } from '../settings';

const OWNER = { email: 'karim@bebe.dz', password: 'Karim-Password-1' };
const OTHER = { email: 'nadia@sport.dz', password: 'Nadia-Password-1' };
/** a tiny PNG (1 × 1) as the app sends a logo */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Karim' });
  await setSetting(t.shop('public'), 'shop', { ...(await getSetting(t.shop('public'), 'shop')), name: 'Bébé Confort' });
  await migrateAll(t);
  return t;
}

/** The person's request in one of their boutiques, as the server makes it. */
async function as(t: Tenancy, shopId: number, who: { email: string; password: string }, extra: Partial<Ctx> = {}): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  const st = shopStatus(s, Date.now(), (await platformSettings(t)).trial.graceDays);
  return { db, session: await login(db, who.email, who.password), now: () => Date.now(), emit: () => {}, t, shop: shopCtx(s, st), ...extra };
}

async function twoBoutiques(t: Tenancy) {
  const s1 = (await loadShop(t, { primary: true }))!;
  const s2 = await provisionShop(t, { name: 'Maison Karim', kind: 'store', planId: null, trialDays: 30, owner: { name: 'Karim', email: OWNER.email }, password: OWNER.password, verified: true });
  const s3 = await provisionShop(t, { name: 'Sport Nadia', kind: 'store', planId: null, trialDays: 30, owner: { name: 'Nadia', email: OTHER.email }, password: OTHER.password, verified: true });
  return { s1, s2, s3 };
}

test('the boutique at the bottom of the menu: the person’s boutiques, their own first, with their logos', async () => {
  const t = await server();
  const { s1, s2 } = await twoBoutiques(t);
  const k = await as(t, s1.id, OWNER);
  const list = (await call('boutiques.list', k, {})) as any[];
  assert.deepEqual(list.map((b) => [b.id, b.name, b.owner, b.current]), [
    [s1.id, 'Bébé Confort', true, true],
    [s2.id, 'Maison Karim', true, false],
  ]);
  assert.equal(list[0].logo, null);
  assert.deepEqual(list[0].oldSlugs, []);
  // in his other boutique: the same list, that one open
  const k2 = await as(t, s2.id, OWNER);
  assert.deepEqual(((await call('boutiques.list', k2, {}) as any[])).map((b) => b.current), [false, true]);
});

test('its owner changes a boutique’s name and logo; its link never changes', async () => {
  const t = await server();
  const { s2, s3 } = await twoBoutiques(t);
  const k = await as(t, (await loadShop(t, { primary: true }))!.id, OWNER);
  // the other boutique (not the one open), from « Mes boutiques »: a new name and a logo, the link stays
  const saved: any = await call('boutiques.save', k, { id: s2.id, name: 'Maison Fatima', logo: PNG });
  assert.equal(saved.name, 'Maison Fatima');
  assert.equal(saved.slug, 'maison-karim');
  assert.equal(saved.logo, PNG);
  assert.deepEqual(saved.oldSlugs, []);
  const after = (await loadShop(t, { id: s2.id }))!;
  assert.equal(after.name, 'Maison Fatima');
  assert.equal(after.slug, 'maison-karim');
  // the boutique's own settings follow its name (messages, labels); its links in Pilotix do not move
  const db2 = t.shop(after.schema);
  assert.equal((await getSetting(db2, 'shop')).name, 'Maison Fatima');
  assert.equal(await landingStore(db2), 'maison-karim');
  assert.equal((await getSetting(db2, 'logo')).url, PNG);
  // another link is refused (the app no longer sends one; the same one is fine)
  await assert.rejects(call('boutiques.save', k, { id: s2.id, name: 'Maison Fatima', slug: 'maison-fatima' }), /ne change jamais/);
  assert.equal(((await call('boutiques.save', k, { id: s2.id, name: 'Maison Fatima', slug: 'maison-karim' })) as any).slug, 'maison-karim');
  assert.equal((await loadShop(t, { id: s2.id }))!.slug, 'maison-karim');
  // nobody else takes it
  assert.equal((await storeNameCheck(t, '', 'maison-karim')).free, false);
  assert.equal(await freeSlug(t, 'Maison Karim'), 'maison-karim-2');
  await assert.rejects(provisionShop(t, { name: 'X', slug: 'maison-karim', kind: 'store', planId: null, trialDays: 1, owner: { name: 'X', email: 'x@x.dz' } }), /SLUG_TAKEN/);
  const n = await as(t, s3.id, OTHER);
  await assert.rejects(call('boutiques.save', n, { id: s3.id, name: 'Sport Nadia', slug: 'maison-karim' }), /ne change jamais/);
  // the logo stays when it is not sent, goes with null
  const back: any = await call('boutiques.save', k, { id: s2.id, name: 'Maison Fatima' });
  assert.equal(back.logo, PNG);
  assert.equal(((await call('boutiques.save', k, { id: s2.id, name: 'Maison Fatima', logo: null })) as any).logo, null);
});

test('only the owner changes a boutique; a logo is checked; nobody changes a link, shop #1’s neither', async () => {
  const t = await server();
  const { s1, s2, s3 } = await twoBoutiques(t);
  // another seller, and a person of Karim's team (even an administrator), cannot
  const n = await as(t, s3.id, OTHER);
  await assert.rejects(call('boutiques.save', n, { id: s2.id, name: 'Volée' }), /propriétaire/);
  const k1 = await as(t, s1.id, OWNER);
  await call('users.create', k1, { name: 'Samir Admin', email: 'samir@bebe.dz', phone: '0661000001', password: 'Samir-Password-1', roles: ['admin'] });
  const samir = await as(t, s1.id, { email: 'samir@bebe.dz', password: 'Samir-Password-1' });
  await assert.rejects(call('boutiques.save', samir, { id: s1.id, name: 'Autre' }), /propriétaire/);
  // a logo: a small PNG, JPEG or WebP only
  await assert.rejects(call('boutiques.save', k1, { id: s1.id, name: 'Bébé Confort', logo: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }), /PNG, JPEG ou WebP/);
  await assert.rejects(call('boutiques.save', k1, { id: s1.id, name: 'Bébé Confort', logo: 'data:image/png;base64,' + 'A'.repeat(170_000) }), /Champ invalide|trop lourd/);
  // the link: never another one
  for (const slug of ['bebe-confort-1', 'api', 'Bébé Confort']) await assert.rejects(call('boutiques.save', k1, { id: s1.id, name: 'Bébé Confort', slug }), /ne change jamais/);
  // shop #1 changes its name: its link (its landing pages', its addresses') stays, also after the platform syncs it
  const slug = s1.slug;
  assert.equal(((await call('boutiques.save', k1, { id: s1.id, name: 'Bébé Confort Oran' })) as any).slug, slug);
  await syncPrimaryStore(t);
  assert.equal((await loadShop(t, { primary: true }))!.slug, slug);
  assert.equal(await landingStore(t.shop('public')), slug);
  // nor from Landing pages › Réglages
  await call('landing.settings.save', k1, { ...((await call('landing.settings.get', k1, {})) as any).settings, storeSlug: 'autre-lien' });
  assert.equal(await landingStore(t.shop('public')), slug);
  // the store picker shows the same links
  assert.deepEqual((await storeChoices(t, OWNER.email)).map((c) => c.slug).sort(), [slug, s2.slug].sort());
});

test('a server with one shop (and the preview before the platform): this shop alone, its admin changes it', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  const db = t.shop('public');
  await migrate(db, (sql) => t.exec('public', sql));
  await seedBase(db, { ...OWNER, name: 'Karim' });
  const k: Ctx = { db, session: await login(db, OWNER.email, OWNER.password), now: () => Date.now(), emit: () => {} };
  const list = (await call('boutiques.list', k, {})) as any[];
  assert.equal(list.length, 1);
  assert.equal(list[0].current, true);
  assert.equal(list[0].owner, true);
  // its link stays the one it had (written in its settings: the new name does not move it)
  const link = list[0].slug;
  const r: any = await call('boutiques.save', k, { id: 0, name: 'Bébé Confort', logo: PNG });
  assert.deepEqual([r.name, r.slug, r.logo], ['Bébé Confort', link, PNG]);
  assert.equal((await getSetting(db, 'shop')).name, 'Bébé Confort');
  assert.equal(await landingStore(db), link);
  await assert.rejects(call('boutiques.save', k, { id: 0, name: 'Bébé Confort', slug: 'bebe-confort' }), /ne change jamais/);
  await assert.rejects(call('boutiques.save', k, { id: 7, name: 'Autre boutique' }), /introuvable/);
});

test('the in-browser demo: the demo store’s owner has three boutiques, and opens the other two with the same password', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  const db = t.shop('public');
  await migrate(db, (sql) => t.exec('public', sql));
  await seedDemo(db, { orders: 30 });
  const t0 = Date.now();
  await seedDemoBoutiques(t);
  console.log(`demo boutiques in ${Date.now() - t0} ms`);
  await seedDemoBoutiques(t); // a second call finds them
  const s1 = (await loadShop(t, { primary: true }))!;
  const k = await as(t, s1.id, { email: 'admin@demo.pilotix.dz', password: 'demo-pilotix' });
  const list = (await call('boutiques.list', k, {})) as any[];
  // the person's own boutiques, by name
  assert.deepEqual(list.map((b) => b.name), ['Pilotix Démo', ...DEMO_BOUTIQUES.map((b) => b.name)].sort((a, b) => a.localeCompare(b)));
  assert.ok(list.every((b) => b.owner));
  assert.match(list.find((b) => b.current).logo, /^data:image\/svg\+xml;base64,/);
  assert.equal(list.find((b) => b.slug === 'maison-fatima').logo, null);
  for (const b of list.filter((x) => !x.current)) {
    const s = (await loadShop(t, { id: b.id }))!;
    await login(t.shop(s.schema), 'admin@demo.pilotix.dz', 'demo-pilotix');
    assert.equal(shopStatus(s, Date.now(), 3).locked, false);
  }
});
