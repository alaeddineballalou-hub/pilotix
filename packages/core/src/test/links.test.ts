// The app's addresses without « # »: pilotix.online/<boutique>/<page>/… The words after a boutique's name (APP_PAGES)
// and the pages of no boutique (PUBLIC_ROOTS) are the same in the web server's rules (deploy/Caddyfile), are never a
// boutique's name, and never a landing page's: /<boutique>/<landing page> stays a landing page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { APP_PAGES, PUBLIC_ROOTS } from '@pilotix/shared';
import { migrate, migrateAll, pgliteTenancy, seedBase } from '../index';
import { storeNameCheck } from '../platform';
import { freeSlug, NAME_RESERVED } from '../platform/shops';
import { freeLandingSlug } from '../modules/landingquery';

const CADDYFILE = readFileSync(join(__dirname, '../../../../deploy/Caddyfile'), 'utf8');

/** The web server's rule for landing pages: its address pattern, and the app's addresses it leaves out. */
function storeRule() {
  const start = CADDYFILE.indexOf('@store {');
  // the block ends with its own line « } » (its patterns hold braces: {2,40})
  const block = CADDYFILE.slice(start, CADDYFILE.indexOf('\n\t}', start));
  const page = /path_regexp page (\S+)/.exec(block)?.[1];
  const not = /not path_regexp (\S+)/.exec(block)?.[1];
  assert.ok(page && not, 'the @store rule has its pattern and the app addresses it leaves out');
  return { page: new RegExp(page!), not: new RegExp(not!) };
}
/** Where the web server sends an address: a landing page (the server), or the app. */
function where(path: string): 'landing' | 'app' {
  const r = storeRule();
  return r.page.test(path) && !r.not.test(path) && !/^\/(api|live)/.test(path) ? 'landing' : 'app';
}

test('the web server knows exactly the app’s words (APP_PAGES, PUBLIC_ROOTS)', () => {
  const { not } = storeRule();
  const lists = [...not.source.matchAll(/\(\?:([a-z0-9|-]+)\)/g)].map((m) => m[1].split('|'));
  assert.equal(lists.length, 2);
  assert.deepEqual([...lists[0]].sort(), [...PUBLIC_ROOTS].sort(), 'deploy/Caddyfile: the pages of no boutique');
  assert.deepEqual([...lists[1]].sort(), [...APP_PAGES].sort(), 'deploy/Caddyfile: the pages of a boutique');
});

test('a boutique’s pages open the app, its landing pages stay landing pages', () => {
  // the app: a boutique's page (two words, or more), the pages of no boutique, a boutique alone
  for (const p of ['/maison-fatima/commandes', '/maison-fatima/accueil/', '/maison-fatima/commandes/tout', '/maison-fatima/aide/12', '/maison-fatima', '/conditions', '/reset/0a1b2c3d4e5f', '/invite/0a1b2c3d4e5f', '/signup/x1y2', '/verify/ab-12', '/inscription/ab12cd', '/pro/mk-7k2q', '/platform/shops', '/'])
    assert.equal(where(p), 'app', p);
  // a landing page, a group of pages
  for (const p of ['/maison-fatima/bague-argent', '/maison-fatima/poussette/', '/sport-zone-alger/mes-produits']) assert.equal(where(p), 'landing', p);
});

test('no boutique and no landing page takes one of the app’s words', async () => {
  for (const w of [...APP_PAGES, ...PUBLIC_ROOTS]) assert.ok(NAME_RESERVED.includes(w), `${w} is reserved for boutiques`);
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  const db = t.shop('public');
  await migrate(db, (sql) => t.exec('public', sql));
  await seedBase(db, { email: 'owner@links.dz', password: 'Owner-Password-1', name: 'Owner' });
  await migrateAll(t);
  // a new boutique, agency or marketer space: its link cannot be a word of the app, a name made from one moves aside
  assert.deepEqual(await storeNameCheck(t, 'x', 'commandes'), { slug: 'commandes', free: false, reason: 'Ce nom est réservé par Pilotix, choisissez-en un autre' });
  assert.equal((await storeNameCheck(t, 'x', 'reset')).free, false);
  assert.equal(await freeSlug(t, 'Suivi'), 'suivi-boutique');
  // a landing page made from a product's name: never a word of the app
  assert.equal(await freeLandingSlug(db, 'Produits'), 'produits-2');
  assert.equal(await freeLandingSlug(db, 'Bague argent'), 'bague-argent');
});
