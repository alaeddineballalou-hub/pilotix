// Pilot Ads › Audiences › « Pubs faites à la main »: an ad set made in Meta's Ads Manager gets the Pilotix lists from
// Pilotix while it is new (its first HAND_FIX_H hours: its learning loses nothing); an older one is never touched, only
// listed; an ad set Pilotix launched without the lists stays so; Meta's « no » is tried again, then said; Meta's
// « later » is no « no »; off, nothing is touched. And Meta itself (meta.ts): the targeting is sent back whole.
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, test } from 'node:test';
import { AppError, call, Ctx, Db } from '../index';
import { runMeta } from '../meta';
import { META_TOKEN_KEY, setRaw } from '../modules/admin';
import { HAND_FIX_H, HAND_TRIES, handRun } from '../modules/adsmgr';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(120));
  await setRaw(db, META_TOKEN_KEY, 'tok');
  await setRaw(db, 'meta', { adAccountId: '123', hasToken: true });
});
// the demo's own example is not these tests' starting point
beforeEach(async () => {
  await db.query(`DELETE FROM settings WHERE key = 'pilot_ads_hand'`);
  await db.query(`DELETE FROM ad_launches WHERE name LIKE 'hand-test%'`);
});

/** the four lists the demo shop has ready (returners, fake numbers, fake orders, competitors) */
const LISTS = ['23851000000000001', '23851000000000002', '23851000000000003', '23851000000000004'];
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const H = 3_600_000;
type Adset = { id: string; name: string; campaign: string; status: string | null; created: string | null; excluded: string[]; included: string[] };
const adset = (id: string, created: string, o: Partial<Adset> = {}): Adset => ({ id, name: `Ad set ${id}`, campaign: 'TEST', status: 'ACTIVE', created, excluded: [], included: [], ...o });

/** the server as these tests see it: Meta's ad sets, and every « add » kept */
function fakeServer(adsets: Adset[], add: (id: string, audiences: string[]) => unknown = (_id, a) => ({ added: a.length })) {
  const adds: { id: string; audiences: string[] }[] = [];
  const server = {
    courier: async () => null,
    meta: async (action: string, args: any) => {
      if (action === 'handAdsets') return { account: '123', adsets };
      if (action === 'handAdd') {
        adds.push({ id: args.id, audiences: args.audiences });
        return add(args.id, args.audiences);
      }
      throw new AppError('bad_request', `unexpected ${action}`);
    },
  } as unknown as Ctx['server'];
  return { server, adds };
}
const owner = (server?: Ctx['server']) => as(EMAILS.vendeur, server);

test('a new ad set made in Meta gets every list it misses; an older one is only listed; one with all of them is left alone', async () => {
  const { server, adds } = fakeServer([
    adset('901', ago(30 * 60_000), { name: 'Bureau pliable' }),
    adset('902', ago(3 * 24 * H), { name: 'Vieux SCALE', excluded: [LISTS[0]] }),
    adset('903', ago(10 * 60_000), { excluded: LISTS }),
    adset('904', ago(5 * 24 * H), { status: 'PAUSED', name: 'Vieux en pause' }),
  ]);
  const s = await handRun(await owner(server));
  assert.deepEqual(adds, [{ id: '901', audiences: LISTS }], 'only the new one is changed, with the four lists');
  assert.equal(s.fixed[0].id, '901');
  assert.equal(s.fixed[0].added, 4);
  assert.equal(s.fixed[0].name, 'Bureau pliable');
  assert.deepEqual(
    s.missing.map((m) => [m.id, m.lacks]),
    [
      ['902', 3],
      ['904', 4],
    ],
    'the older ones are listed, running first, with how many lists they miss',
  );
  assert.equal(s.lists, 4);
  assert.ok(s.checkedAt);
  assert.equal(s.error, null);
});

test(`the edge: ${HAND_FIX_H} hours old is still new, a minute more is not`, async () => {
  const { server, adds } = fakeServer([adset('911', ago(HAND_FIX_H * H - 60_000)), adset('912', ago(HAND_FIX_H * H + 60_000))]);
  const s = await handRun(await owner(server));
  assert.deepEqual(
    adds.map((a) => a.id),
    ['911'],
  );
  assert.deepEqual(
    s.missing.map((m) => m.id),
    ['912'],
  );
});

test('an ad set Pilotix launched with « Utiliser les audiences » unticked is the owner’s choice: left alone, not listed', async () => {
  await db.query(`INSERT INTO ad_launches (mode, goal, name, spec, status, adset_ids, meta_ids) VALUES ('pro','sales','hand-test 1',$1,'live','{921}',$2)`, [
    JSON.stringify({ useAudiences: false }),
    JSON.stringify({ 'adset:a1': '922' }),
  ]);
  const { server, adds } = fakeServer([adset('921', ago(H)), adset('922', ago(H)), adset('923', ago(9 * 24 * H))]);
  const s = await handRun(await owner(server));
  assert.deepEqual(adds, []);
  assert.deepEqual(
    s.missing.map((m) => m.id),
    ['923'],
  );
});

test('a list the ad set targets is not put into its exclusions', async () => {
  const { server, adds } = fakeServer([adset('931', ago(H), { included: [LISTS[1]] })]);
  await handRun(await owner(server));
  assert.deepEqual(adds, [{ id: '931', audiences: [LISTS[0], LISTS[2], LISTS[3]] }]);
});

test(`Meta's « no » is tried again on the next runs, ${HAND_TRIES} times in all, then the ad set is listed with Meta's words`, async () => {
  const { server, adds } = fakeServer([adset('941', ago(H))], () => {
    throw new AppError('bad_request', 'Meta : Invalid parameter');
  });
  const ctx = await owner(server);
  for (let k = 1; k < HAND_TRIES; k++) {
    const s = await handRun(ctx);
    assert.equal(s.missing.length, 0, `try ${k}: not « without the lists » yet, the next run tries again`);
    assert.equal(s.tries['941'].n, k);
  }
  const s = await handRun(ctx);
  assert.equal(adds.length, HAND_TRIES);
  assert.equal(s.missing[0].id, '941');
  assert.equal(s.missing[0].error, 'Meta : Invalid parameter');
  // and never again: the tries are used up
  const again = await handRun(ctx);
  assert.equal(adds.length, HAND_TRIES);
  assert.equal(again.missing[0].error, 'Meta : Invalid parameter', 'the refusal stays said');
});

test('Meta saying « later » (too many requests, out of reach) is no « no »: nothing counted, the others wait too, said once', async () => {
  const { server, adds } = fakeServer([adset('951', ago(H)), adset('952', ago(H))], () => {
    throw new AppError('conflict', 'Meta limite les demandes pour l’instant : réessayez dans quelques minutes.');
  });
  const s = await handRun(await owner(server));
  assert.deepEqual(
    adds.map((a) => a.id),
    ['951'],
    'one asked, the second waits for the next run',
  );
  assert.equal(s.missing.length, 0);
  assert.deepEqual(s.tries, {});
  assert.match(String(s.error), /limite les demandes/);
});

test('Meta out of reach when reading: what was found last time stays, the error is said', async () => {
  const first = fakeServer([adset('961', ago(5 * 24 * H))]);
  await handRun(await owner(first.server));
  const down = {
    courier: async () => null,
    meta: async () => {
      throw new AppError('bad_request', 'Meta injoignable. Réessayez plus tard.');
    },
  } as unknown as Ctx['server'];
  const s = await handRun(await owner(down));
  assert.deepEqual(
    s.missing.map((m) => m.id),
    ['961'],
  );
  assert.match(String(s.error), /injoignable/);
});

test('off: Pilotix touches no ad set made by hand; the owner turns it back on', async () => {
  const { server, adds } = fakeServer([adset('971', ago(H))]);
  const ctx = await owner(server);
  const off = (await call('ads.hand.save', ctx, { on: false })) as any;
  assert.equal(off.on, false);
  await handRun(ctx);
  assert.equal(adds.length, 0);
  await call('ads.hand.save', ctx, { on: true });
  await handRun(ctx);
  assert.deepEqual(
    adds.map((a) => a.id),
    ['971'],
  );
});

test('no list ready: nothing to add, nothing listed', async () => {
  await db.query(`UPDATE ad_audiences SET is_on = false`);
  try {
    const { server, adds } = fakeServer([adset('981', ago(H)), adset('982', ago(9 * 24 * H))]);
    const s = await handRun(await owner(server));
    assert.deepEqual(adds, []);
    assert.deepEqual(s.missing, []);
    assert.equal(s.lists, 0);
  } finally {
    await db.query(`UPDATE ad_audiences SET is_on = true WHERE kind IN ('returners','fake','fakeorder','competitor')`);
  }
});

test('a marketer sees only his own ad sets on the card; the owner sees them all', async () => {
  const { server } = fakeServer([adset('120200005', ago(20 * 24 * H)), adset('991', ago(9 * 24 * H))]);
  await handRun(await owner(server));
  const mine = (await call('ads.hand.state', await as(EMAILS.marketer), {})) as any;
  assert.deepEqual(
    mine.missing.map((m: any) => m.id),
    ['120200005'],
  );
  assert.equal(mine.owner, false);
  const all = (await call('ads.hand.state', await owner(), {})) as any;
  assert.deepEqual(all.missing.map((m: any) => m.id).sort(), ['120200005', '991']);
});

// ---------------------------------------------------------------- Meta itself (meta.ts), its answers made up
const real = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = real;
});
type MetaCall = { method: string; path: string; body: Record<string, any> };
function fakeMeta(answer: (c: MetaCall) => unknown): MetaCall[] {
  const calls: MetaCall[] = [];
  globalThis.fetch = (async (u: any, init: any = {}) => {
    const url = new URL(String(u));
    const body: Record<string, any> = {};
    for (const [k, v] of init.body instanceof URLSearchParams ? init.body : url.searchParams)
      try {
        body[k] = JSON.parse(v);
      } catch {
        body[k] = v;
      }
    const c: MetaCall = { method: String(init.method ?? 'GET'), path: url.pathname.replace(/^\/v[\d.]+\//, ''), body };
    calls.push(c);
    return new Response(JSON.stringify(answer(c)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

test('Meta: the targeting is read and sent back whole, only the missing lists added (never one the ad set targets)', async () => {
  const targeting = {
    geo_locations: { countries: ['DZ'], location_types: ['home', 'recent'] },
    age_min: 18,
    targeting_automation: { advantage_audience: 1 },
    excluded_custom_audiences: [{ id: '23851000000000501', name: 'Pilotix · retours' }],
    custom_audiences: [{ id: '23851000000000502', name: 'Pilotix · comme mes clients livrés' }],
  };
  const calls = fakeMeta((c) => (c.method === 'GET' ? { account_id: '123', targeting, id: '120200777' } : { success: true }));
  const r = await runMeta('handAdd', { id: '120200777', audiences: ['23851000000000501', '23851000000000502', '23851000000000503'] }, await owner());
  assert.deepEqual(r, { added: 1 });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ['GET 120200777', 'POST 120200777'],
  );
  const sent = calls[1].body.targeting;
  assert.deepEqual(
    sent.excluded_custom_audiences.map((x: any) => x.id),
    ['23851000000000501', '23851000000000503'],
  );
  assert.deepEqual(sent.geo_locations, targeting.geo_locations, 'the rest of the targeting as Meta has it');
  assert.deepEqual(sent.targeting_automation, { advantage_audience: 1 });
  assert.equal(sent.age_min, 18);
  assert.deepEqual(sent.custom_audiences, targeting.custom_audiences);
  assert.equal(calls[1].body.access_token, 'tok', 'the key in the body, never in the address');
});

test('Meta: nothing missing, nothing sent; an ad set of another ad account is refused', async () => {
  let calls = fakeMeta(() => ({ account_id: '123', targeting: { excluded_custom_audiences: [{ id: '23851000000000601' }] } }));
  assert.deepEqual(await runMeta('handAdd', { id: '120200778', audiences: ['23851000000000601'] }, await owner()), { added: 0 });
  assert.deepEqual(
    calls.map((c) => c.method),
    ['GET'],
  );
  calls = fakeMeta(() => ({ account_id: '999', targeting: {} }));
  const ctx = await owner();
  await assert.rejects(() => runMeta('handAdd', { id: '120200779', audiences: ['23851000000000601'] }, ctx), /compte pub des listes/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});

test('Meta: the ad sets of the lists’ ad account, archived and deleted ones left out, Meta’s time made readable', async () => {
  const calls = fakeMeta(() => ({
    data: [
      { id: '1', name: 'A', campaign: { name: 'TEST' }, created_time: '2026-11-20T18:30:00+0100', effective_status: 'ACTIVE', targeting: { excluded_custom_audiences: [{ id: '9' }], custom_audiences: [{ id: '8' }] } },
      { id: '2', name: 'B', created_time: '2026-11-01T10:00:00+0100', effective_status: 'ARCHIVED', targeting: {} },
      { id: '3', name: 'C', created_time: '2026-11-02T10:00:00+0100', effective_status: 'DELETED', targeting: {} },
    ],
  }));
  const r = (await runMeta('handAdsets', {}, await owner())) as any;
  assert.equal(calls[0].path, 'act_123/adsets');
  assert.match(String(calls[0].body.fields), /targeting/);
  assert.equal(r.adsets.length, 1);
  assert.deepEqual(r.adsets[0], { id: '1', name: 'A', campaign: 'TEST', status: 'ACTIVE', created: '2026-11-20T18:30:00+01:00', excluded: ['9'], included: ['8'] });
  assert.equal(Date.parse(r.adsets[0].created), Date.parse('2026-11-20T17:30:00Z'));
});
