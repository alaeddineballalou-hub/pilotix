// Landing pages › Réglages › « Team et fournisseurs »: with Team on, a team number's order on a page is a test (never
// blocked, never an order, nothing for Meta, counted nowhere, in no list the ads leave out); with Fournisseurs on, a
// supplier's order is blocked (reason « supplier ») and the supplier joins the « faux numéros » list. Both are off by
// default, and only the owner changes them.
import { sha256Hex, zeroBits } from '@pilotix/shared';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { syncAudiences } from '../modules/adsmgr';
import { LANDING_POW_BITS, makeChallenge } from '../modules/landing';
import { listOf, mobilesIn } from '../modules/landinglists';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let productId: number;
let variantId: number;
const SLUG = 'poussette-team';
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

before(async () => {
  const s = await setup(120);
  db = s.db;
  as = s.as;
  admin = await s.as(EMAILS.admin);
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.sku = 'PX-POU' AND v.title <> '' ORDER BY v.id LIMIT 1`))[0];
  productId = Number(p.id);
  variantId = Number(p.vid);
  await call('landing.save', await s.as(EMAILS.marketer), { productId, slug: SLUG, title: 'عربة أطفال', color: '#db2777', price: 9950, description: '- خفيفة' });
});

const solve = (ch: string) => {
  for (let n = 0; ; n++) if (zeroBits(sha256Hex(`${ch}:${n}`)) >= LANDING_POW_BITS) return String(n);
};
let seq = 0;
/** what the page sends, as a person would (served 25 s earlier, typed by hand) */
async function human(phone: string, over: Record<string, unknown> = {}) {
  const ch = await makeChallenge(db, SLUG, Date.now() - 25_000);
  seq++;
  return { slug: SLUG, name: `Amina Test${String.fromCharCode(97 + (seq % 26))}ari`, phone, wilaya: 16, commune: 'Hydra', variant: variantId, qty: 1, hp: '', ch, pw: solve(ch), t: 25_000, ki: 40, wd: false, fp: `fp${seq}x${Math.random().toString(36).slice(2, 10)}`, did: `d${seq}${Math.random()}`, meta: { ip: `10.1.0.${seq % 250}`, ua: UA }, ...over };
}
const count = async (sql: string, args: unknown[]) => Number((await db.query(sql, args))[0].n);
const orders = (phone: string) => count('SELECT count(*)::int AS n FROM orders WHERE phone = $1', [phone]);
const blocked = (phone: string) => count('SELECT count(*)::int AS n FROM landing_blocked WHERE phone = $1', [phone]);
const tests = (phone: string) => count('SELECT count(*)::int AS n FROM landing_tests WHERE phone = $1', [phone]);
const submits = (phone: string) => count('SELECT count(*)::int AS n FROM landing_submits WHERE phone = $1', [phone]);

test('a supplier field may hold several numbers, written any way', () => {
  assert.deepEqual(mobilesIn('0770 11 22 33 / 0550-44-55-66 · +213 661 77 88 99 · fixe 021 23 45 67'), ['0770112233', '0550445566', '0661778899']);
  assert.deepEqual(mobilesIn(''), []);
});

test('off by default: a team number orders like anyone, and only the owner may change the lists', async () => {
  await call('landing.lists.add', admin, { kind: 'team', phone: '0550 11 22 01', name: 'Moi' });
  assert.equal(await listOf(db, '0550112201'), null, 'the switch is off');
  await call('landing.submit', admin, await human('0550112201'));
  assert.equal(await orders('0550112201'), 1);
  assert.equal(await tests('0550112201'), 0);
  const mk = await as(EMAILS.marketer);
  await assert.rejects(call('landing.lists.save', mk, { team: true }));
  await assert.rejects(call('landing.lists.add', mk, { kind: 'supplier', phone: '0770000001' }));
  await assert.rejects(call('landing.lists.add', admin, { kind: 'team', phone: '021234567' }), /mobile/);
});

test('Team on: a team number is a test — no order, not blocked, nothing for Meta, not counted — even when blacklisted', async () => {
  await call('landing.lists.save', admin, { team: true });
  const phone = '0550112202';
  await call('landing.lists.add', admin, { kind: 'team', phone, name: 'Samir' });
  // on the black list, and many orders from it: it would be blocked for anyone else
  await db.query(`INSERT INTO customers (phone, name, blacklisted, blacklist_reason) VALUES ($1, 'Samir', true, 'Fausse commande (landing page)') ON CONFLICT (phone) DO UPDATE SET blacklisted = true`, [phone]);
  const meta0 = await count('SELECT count(*)::int AS n FROM meta_events', []);
  for (let k = 0; k < 4; k++) assert.deepEqual(await call('landing.submit', admin, await human(phone)), { ok: true, team: true });
  assert.equal(await tests(phone), 4);
  assert.equal(await orders(phone), 0);
  assert.equal(await blocked(phone), 0);
  assert.equal(await submits(phone), 0, 'not counted in the protection numbers');
  assert.equal(await count('SELECT count(*)::int AS n FROM meta_events', []), meta0, 'nothing for Meta');
  // what it typed is no abandoned order either
  await call('landing.capture', admin, { slug: SLUG, name: 'Samir B', phone, wilaya: 16, commune: 'Hydra', variant: variantId, qty: 1, hp: '', ch: await makeChallenge(db, SLUG, Date.now() - 5000), fp: 'fpx', did: 'dx', vid: 'v1', meta: { ip: '10.9.9.9', ua: UA } });
  assert.equal(await count('SELECT count(*)::int AS n FROM landing_leads WHERE phone = $1', [phone]), 0);
  // the team's own accounts count by themselves
  const acc = (await db.query(`SELECT phone FROM profiles WHERE active AND archived_at IS NULL AND agency_id IS NULL AND phone ~ '^0[5-7][0-9]{8}$' LIMIT 1`))[0];
  if (acc) assert.equal(await listOf(db, String(acc.phone)), 'team');
  // the agents see the tests in Protection
  const r: any = await call('landing.tests', await as(EMAILS.conf), {});
  assert.equal(r.on, true);
  const mine = r.tests.filter((x: any) => x.phone === phone);
  assert.equal(mine.length, 4);
  assert.equal(mine[0].total, 9950);
  assert.equal(mine[0].slug, SLUG);
});

test('a team browser fires no pixel and is not counted', async () => {
  await db.query(`UPDATE landing_pages SET pixel_id = '876540001122', meta_pixels = NULL WHERE slug = $1`, [SLUG]);
  const v0 = Number((await db.query('SELECT views FROM landing_pages WHERE slug = $1', [SLUG]))[0].views);
  const open = (team: boolean) => call('landing.html', admin, { slug: SLUG, mode: 'live', post: '/api/lp/x/order', geo: '/g/', imgBase: '/api/lp/img/', visitor: `team${team ? 1 : 0}visitor0001`, ...(team ? { team: true } : {}) }) as Promise<any>;
  const seen = await open(false);
  assert.ok(seen.html.includes('876540001122'), 'a customer gets the pixel');
  const mate = await open(true);
  assert.ok(!mate.html.includes('876540001122'), 'a team browser gets no pixel');
  assert.equal(Number((await db.query('SELECT views FROM landing_pages WHERE slug = $1', [SLUG]))[0].views), v0 + 1, 'only the customer counted');
  assert.equal(await count(`SELECT count(*)::int AS n FROM landing_visits WHERE visitor = 'team1visitor0001'`, []), 0);
});

test('Fournisseurs on: a supplier (Stock › Fournisseurs or added) is blocked; a number in both lists is Team', async () => {
  await db.query(`INSERT INTO suppliers (name, phone) VALUES ('Usine Bébé', '0770 33 44 55 / 0550-11-22-02')`);
  await call('landing.lists.add', admin, { kind: 'supplier', phone: '0661 00 77 88', name: 'Grossiste' });
  // off: a supplier orders like anyone
  await call('landing.submit', admin, await human('0770334455'));
  assert.equal(await orders('0770334455'), 1);
  await call('landing.lists.save', admin, { suppliers: true });
  for (const phone of ['0770334455', '0661007788']) {
    assert.deepEqual(await call('landing.submit', admin, await human(phone)), { ok: true });
    const b = (await db.query(`SELECT score, reasons FROM landing_blocked WHERE phone = $1 ORDER BY id DESC LIMIT 1`, [phone]))[0];
    assert.ok(b, `${phone} blocked`);
    assert.equal(Number(b.score), 100);
    assert.ok((typeof b.reasons === 'string' ? JSON.parse(b.reasons) : b.reasons).some((x: any) => x.code === 'supplier'));
  }
  assert.equal(await orders('0661007788'), 0);
  // 0550112202 is on the team too: still a test
  assert.equal(await listOf(db, '0550112202'), 'team');
  // the owner's card lists both
  const g: any = await call('landing.lists.get', admin, {});
  assert.equal(g.suppliers.on, true);
  assert.ok(g.suppliers.stock.some((x: any) => x.phone === '0770334455' && x.name === 'Usine Bébé'));
  assert.ok(g.suppliers.added.some((x: any) => x.phone === '0661007788'));
  assert.ok(g.team.added.some((x: any) => x.phone === '0550112202' && x.name === 'Samir'));
  await call('landing.lists.remove', admin, { kind: 'supplier', phone: '0661007788' });
  assert.equal(await listOf(db, '0661007788'), null);
});

test('the ads: suppliers join « faux numéros », the team is in no list', async () => {
  const phone = '0550112203';
  await call('landing.lists.add', admin, { kind: 'team', phone });
  // an order of a team number marked fake before (it would be in « faux numéros »)
  const o = (await db.query(`SELECT id FROM orders ORDER BY id LIMIT 1`))[0];
  await db.query(`UPDATE orders SET phone = $2, conf_status = 'fake' WHERE id = $1`, [o.id, phone]);
  await db.query(`INSERT INTO ad_audiences (kind, is_on) VALUES ('fake', true) ON CONFLICT (kind) DO UPDATE SET is_on = true`);
  const sent: Record<string, string[]> = {};
  const server = { meta: async (action: string, args: any) => (action === 'audience' ? ((sent[args.name] = args.phones), { id: '900' }) : { id: '901' }) } as unknown as Ctx['server'];
  await syncAudiences(await as(EMAILS.vendeur, server), ['fake']);
  const list = sent['Pilotix · faux numéros'] ?? [];
  assert.ok(list.includes('213770334455'), 'the supplier is left out of the ads');
  assert.ok(!list.includes('213550112203'), 'the team is not');
});
