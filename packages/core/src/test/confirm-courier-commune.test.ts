// Each delivery company's own name for the order's commune is found by Pilotix alone, for every company (22 Nov 2026, the
// owner: nobody fixes a commune by hand): the same name, the same sound (« Azzefoun » = « Azeffoun » = « azefoune »), the
// same Arabic name — the one the customer picks on the landing page (« Beni Zmenzer » is أيت زمنزر: ZR's « Ait Zmenzer ») —
// and never another commune's (a parcel sent to the wrong town is worse than one stopped). A commune the company really
// does not know is stopped before « Confirmer » (PX1226, « Azzefoun », was refused only at the depot), for every company
// whose list Pilotix can read; when it can't say (no answer), the order goes on.
import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { runCourier } from '../couriers/index';
import { helpers } from '../couriers/load';
import { zr } from '../couriers/zr';
import { listClock, matchCommune, ourCommunes, soundKey } from '../couriers/util';
import type { CourierCompany, Parcel } from '../couriers/types';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(120));
});

const real = globalThis.fetch;
const clock = listClock.now;
afterEach(() => {
  globalThis.fetch = real;
  listClock.now = clock;
});
/** the lists' clock moved forward */
const later = (ms: number) => {
  const t = listClock.now() + ms;
  listClock.now = () => t;
};

/** ZR's own communes of wilaya 15 (as its territories give them: its names, and Arabic names) */
const ZR_15 = [
  { name: 'Tizi Ouzou', ar: 'تيزي وزو' },
  { name: 'Azeffoun', ar: 'أزفون' },
  { name: 'Tigzirt', ar: 'تقزيرت' },
  { name: 'Draa Ben Khedda', ar: 'ذراع بن خدة' },
  { name: 'Ait Zmenzer', ar: 'أيت زمنزر' },
  { name: 'Ait Yahia Moussa', ar: 'آيت يحيى موسى' },
];

test('ZR lists its own communes of a wilaya with their Arabic names (its territories, kept in memory)', async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (u: string, o: any) => {
    calls.push(`${o?.method ?? 'GET'} ${String(u).replace(/^.*\/api\/v1/, '')}`);
    const level = JSON.parse(o.body)?.advancedFilter?.filters?.[0]?.value;
    const items =
      level === 'wilaya'
        ? [{ id: 'w15', code: '15', name: 'Tizi Ouzou', level: 'wilaya' }, { id: 'w16', code: '16', name: 'Alger', level: 'wilaya' }]
        : [...ZR_15.map((x, k) => ({ id: `c${k}`, name: x.name, nameArabic: x.ar, level: 'commune', parentId: 'w15' })), { id: 'h1', name: 'Hydra', level: 'commune', parentId: 'w16' }];
    return new Response(JSON.stringify({ items, hasNext: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const c = { id: 9150, name: 'ZR', kind: 'zr', secret: { api_key: 'k', tenant: 't' }, settings: {}, statusMap: {}, shop: { name: 'S', fromWilayaId: 16, fromWilaya: 'Alger' } } as unknown as CourierCompany;
  assert.deepEqual(
    (await zr.communes!(c, 15)).map((x) => [x.name, x.ar]),
    ZR_15.map((x) => [x.name, x.ar]),
  );
  assert.deepEqual((await zr.communes!(c, 16)).map((x) => x.name), ['Hydra']);
  assert.deepEqual(await zr.communes!(c, 33), [], 'a wilaya ZR does not have');
  assert.equal(calls.length, 2, 'asked once, then kept in memory');
});

test('the company’s name is found alone: the same name, the same sound, the same Arabic name', () => {
  const name = (want: string, list: { name: string; ar?: string }[] = ZR_15) => matchCommune(want, list, 15)?.name ?? null;
  assert.equal(name('Tizi Ouzou'), 'Tizi Ouzou');
  assert.equal(name('TIZI-OUZOU'), 'Tizi Ouzou');
  assert.equal(name('Azzefoun'), 'Azeffoun', 'the same sound');
  assert.equal(name('azefoune'), 'Azeffoun', 'the same sound (as a customer types it)');
  assert.equal(name('Beni Zmenzer'), 'Ait Zmenzer', 'the same Arabic name: أيت زمنزر');
  assert.equal(name('أيت زمنزر'), 'Ait Zmenzer', 'a commune written in Arabic');
  assert.equal(name('Beni Zmenzer', ZR_15.map((x) => ({ name: x.name }))), null, 'a company without Arabic names: not found');
  assert.equal(name('Ait Yahia'), null, '« Ait Yahia Moussa » is another commune: never sent there');
  assert.equal(name('Ait Chaffaa'), null);
  assert.equal(name('Bab Ezzouar'), null);
});

test('never another commune: one missing from a company’s list is never sent elsewhere (all 1,541 communes)', () => {
  let n = 0;
  for (let w = 1; w <= 58; w++) {
    const ours = ourCommunes(w);
    assert.equal(new Set(ours.map((x) => soundKey(x.name))).size, ours.length, `wilaya ${w}: two communes sound the same`);
    for (const x of ours) {
      n++;
      assert.equal(matchCommune(x.name, ours, w), x, `${x.name} finds itself`);
      assert.equal(matchCommune(x.name, ours.filter((y) => y !== x), w), null, `${x.name} (${w}) missing: not sent elsewhere`);
    }
  }
  assert.equal(n, 1541);
});

test('sending finds the company’s name the same way (« Beni Zmenzer » goes to ZR as « Ait Zmenzer »)', async () => {
  const p = (commune: string) => ({ wilaya_id: 15, commune, is_stopdesk: false, stopdesk_commune: null }) as unknown as Parcel;
  const load = async () => ZR_15.map((x, k) => ({ id: `c${k}`, ...x }));
  assert.equal((await helpers.communeName(p('Beni Zmenzer'), load))?.id, 'c4');
  assert.equal((await helpers.communeName(p('Azzefoun'), load))?.id, 'c1');
  assert.equal(await helpers.communeName(p('Ait Chaffaa'), load), null, 'ZR does not have it: refused at sending, never another commune');
});

/** a server whose couriers answer `communes` with `list` (or fail), `fresh` (read again) with `now`; records the calls */
function server(list: { name: string; ar?: string }[] | 'fail', now = list) {
  const calls: { action: string; args: any }[] = [];
  return {
    calls,
    server: {
      courier: async (action: string, args: any) => {
        calls.push({ action, args });
        if (action !== 'communes') throw new Error(`unexpected ${action}`);
        const l = args.fresh ? now : list;
        if (l === 'fail') throw new Error('la société ne répond pas');
        return l;
      },
    } as unknown as Ctx['server'],
  };
}

const companyId = async (kind: string) => Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = $1 ORDER BY id LIMIT 1`, [kind]))[0].id);
const anItem = async () => {
  const v = (await db.query(`SELECT v.id, v.product_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.active AND v.active ORDER BY v.id LIMIT 1`))[0];
  return { productId: Number(v.product_id), variantId: Number(v.id), qty: 1 };
};
const check = async (ctx: Ctx, commune: string, kind = 'zr', isStopdesk = false) =>
  (await call('orders.confirmCheck', ctx, { items: [await anItem()], wilayaId: 15, commune, isStopdesk, companyId: await companyId(kind) })) as any;

test('the order card, ZR at home: its name is found alone; a commune ZR does not know cannot be confirmed', async () => {
  const f = server(ZR_15);
  const samira = await as(EMAILS.conf, f.server);
  assert.equal((await check(samira, 'Azzefoun')).canConfirm, true, 'the same sound');
  assert.equal((await check(samira, 'Beni Zmenzer')).canConfirm, true, 'the same Arabic name');
  assert.deepEqual(f.calls[0], { action: 'communes', args: { companyId: await companyId('zr'), wilayaId: 15 } });
  const r = await check(samira, 'Ait Chaffaa');
  assert.equal(r.canConfirm, false);
  assert.equal(r.deliver.why, 'courierCommune');
  assert.equal(r.deliver.commune, 'Ait Chaffaa');
  assert.equal(r.deliver.canLink, undefined, 'nobody links a commune by hand');
  assert.deepEqual((await check(samira, 'Tizgirt')).deliver.near, ['Tigzirt'], 'the company’s closest names, to choose with the customer');
  // at an office (stop desk): the company's office, not its list of communes
  const n = f.calls.length;
  assert.notEqual((await check(samira, 'Ait Chaffaa', 'zr', true)).deliver.why, 'courierCommune');
  assert.equal(f.calls.length, n, 'not asked for a stop desk');
});

test('every company whose list Pilotix can read is checked (Yalidine too); own delivery men are not asked', async () => {
  const f = server(ZR_15.filter((x) => x.name !== 'Tigzirt'));
  const samira = await as(EMAILS.conf, f.server);
  const r = await check(samira, 'Tigzirt', 'yalidine');
  assert.equal(r.deliver.why, 'courierCommune');
  assert.equal(r.deliver.companyName, 'Yalidine');
  const yal = await companyId('yalidine');
  assert.deepEqual(
    f.calls.slice(-2).map((x) => x.args),
    [{ companyId: yal, wilayaId: 15 }, { companyId: yal, wilayaId: 15, fresh: true }],
    'not on its list: asked again at once',
  );
  assert.equal((await check(samira, 'Tizi Ouzou', 'yalidine')).canConfirm, true);
  const n = f.calls.length;
  assert.notEqual((await check(samira, 'Tigzirt', 'own')).deliver.why, 'courierCommune');
  assert.equal(f.calls.length, n, 'own delivery men have no list');
});

test('a commune the company just added is found at once: not on the list kept in memory → asked again', async () => {
  const f = server(ZR_15, [...ZR_15, { name: 'Ait Chaffaa', ar: 'آيت شفعة' }]);
  const r = await check(await as(EMAILS.conf, f.server), 'Ait Chaffaa');
  assert.equal(r.canConfirm, true);
  assert.deepEqual(
    f.calls.map((x) => x.args.fresh ?? false),
    [false, true],
  );
});

test('sending: a commune not on the list kept in memory is asked again at once, at most once a minute', async () => {
  const p = (commune: string) => ({ wilaya_id: 15, commune, is_stopdesk: false, stopdesk_commune: null }) as unknown as Parcel;
  let list = ZR_15;
  const asked: boolean[] = [];
  const load = async (_w: number, fresh?: boolean) => {
    asked.push(!!fresh);
    return list.map((x, k) => ({ id: `c${k}`, ...x }));
  };
  assert.equal((await helpers.communeName(p('Tigzirt'), load, 'test-again'))?.name, 'Tigzirt');
  list = [...ZR_15, { name: 'Ait Chaffaa', ar: 'آيت شفعة' }];
  assert.equal(await helpers.communeName(p('Ait Chaffaa'), load, 'test-again'), null, 'read a moment ago: not asked again');
  assert.deepEqual(asked, [false]);
  later(61_000);
  assert.equal((await helpers.communeName(p('Ait Chaffaa'), load, 'test-again'))?.name, 'Ait Chaffaa', 'ZR added it: found');
  assert.deepEqual(asked, [false, true]);
  assert.equal((await helpers.communeName(p('Ait Chaffaa'), load, 'test-again'))?.name, 'Ait Chaffaa');
  assert.deepEqual(asked, [false, true], 'kept again');
  later(3600_000);
  await helpers.communeName(p('Tigzirt'), load, 'test-again');
  assert.deepEqual(asked, [false, true, false], 'read again after an hour');
});

test('the company does not answer: the order is not blocked (the depot’s sending still tells)', async () => {
  assert.equal((await check(await as(EMAILS.conf, server('fail').server), 'Ait Chaffaa')).canConfirm, true);
  assert.equal((await check(await as(EMAILS.conf, server([]).server), 'Ait Chaffaa')).canConfirm, true, 'an empty list says nothing');
});

test('the browser preview (no server): its stand-ins know Pilotix’s list but « Ait Chaffaa », ZR writes two its own way', async () => {
  const samira = await as(EMAILS.conf);
  assert.equal((await check(samira, 'Azzefoun')).canConfirm, true, 'ZR’s « Azeffoun »: the same sound');
  assert.equal((await check(samira, 'Beni Zmenzer')).canConfirm, true, 'ZR’s « Ait Zmenzer »: the same Arabic name');
  assert.equal((await check(samira, 'Tigzirt')).canConfirm, true);
  assert.equal((await check(samira, 'Ait Chaffaa')).deliver.why, 'courierCommune');
  assert.equal((await check(samira, 'Ait Chaffaa', 'yalidine')).deliver.why, 'courierCommune');
  assert.equal((await check(samira, 'Ali Mendjeli')).canConfirm, true, 'a name outside Pilotix’s list: the stand-in can’t say');
});

test('« Confirmer » on a saved order: refused with the reason in the agent’s words', async () => {
  const o = (await db.query(`SELECT id, ref FROM orders WHERE conf_status = 'new' AND NOT is_stopdesk ORDER BY id LIMIT 1`))[0];
  assert.ok(o, 'an order to call');
  await db.query(`UPDATE orders SET wilaya_id = 15, commune = 'Ait Chaffaa', company_id = $2, wilaya_guess = NULL WHERE id = $1`, [o.id, await companyId('zr')]);
  const admin = await as(EMAILS.admin, server(ZR_15).server);
  await assert.rejects(
    call('orders.setConf', admin, { ids: [Number(o.id)], status: 'confirmed' }),
    (e: any) => {
      assert.match(e.message, /ne trouve pas la commune « Ait Chaffaa »/);
      assert.doesNotMatch(e.message, /relie/, 'nobody links a commune by hand');
      return true;
    },
  );
  assert.equal((await db.query('SELECT conf_status FROM orders WHERE id = $1', [o.id]))[0].conf_status, 'new');
  // « Azzefoun » (Pilotix's spelling): ZR's « Azeffoun » is found alone, the order is confirmed
  await db.query(`UPDATE orders SET commune = 'Azzefoun' WHERE id = $1`, [o.id]);
  await call('orders.setConf', admin, { ids: [Number(o.id)], status: 'confirmed' });
  assert.match((await db.query('SELECT conf_status FROM orders WHERE id = $1', [o.id]))[0].conf_status, /^(confirmed|no_stock)$/);
});

test('each company’s list is kept an hour on the server, asked again at once when a commune is missing (Yalidine counts every call)', async () => {
  const yal = await companyId('yalidine');
  const kept = (await db.query('SELECT credentials FROM delivery_companies WHERE id = $1', [yal]))[0].credentials;
  await db.query(`UPDATE delivery_companies SET credentials = $2 WHERE id = $1`, [yal, JSON.stringify({ api_id: 'i', api_token: 't' })]);
  try {
    let calls = 0;
    globalThis.fetch = (async (u: string) => {
      if (/\/communes\//.test(String(u))) calls++;
      return new Response(JSON.stringify({ data: [{ id: 1501, name: 'Tizi Ouzou' }, { id: 1502, name: 'Azeffoun' }], has_more: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const admin = await as(EMAILS.admin);
    const one = await runCourier('communes', { companyId: yal, wilayaId: 15 }, admin);
    assert.deepEqual(one, [
      { name: 'Tizi Ouzou', ar: null },
      { name: 'Azeffoun', ar: null },
    ]);
    assert.deepEqual(await runCourier('communes', { companyId: yal, wilayaId: 15 }, admin), one);
    assert.equal(calls, 1, 'asked once');
    await runCourier('communes', { companyId: yal, wilayaId: 15, fresh: true }, admin);
    assert.equal(calls, 1, 'read a moment ago: not asked again');
    later(61_000);
    await runCourier('communes', { companyId: yal, wilayaId: 15, fresh: true }, admin);
    assert.equal(calls, 2, 'a commune not found a minute later: asked again');
    later(30 * 60_000);
    await runCourier('communes', { companyId: yal, wilayaId: 15 }, admin);
    assert.equal(calls, 2, 'kept an hour');
    later(31 * 60_000);
    await runCourier('communes', { companyId: yal, wilayaId: 15 }, admin);
    assert.equal(calls, 3, 'read again after an hour');
  } finally {
    await db.query(`UPDATE delivery_companies SET credentials = $2 WHERE id = $1`, [yal, typeof kept === 'string' ? kept : JSON.stringify(kept)]);
  }
});
