// Two Meta fixes (18 Nov 2026):
//  1. A launch that failed and is changed (another goal, budget, words…) makes its campaign again: Meta refuses a
//     campaign made for one goal with ad sets of another (« You can't use the selected performance goal with your
//     campaign objective »). A retry with the same choices still goes on where it stopped. The photos already sent stay.
//  2. The catalog and the creators' posts (partnership ads) are asked through the first business Meta answers for: the
//     ad account's, then the Page's, then the token's own (a system user made in the agency's business reaches an ad
//     account another business holds, but Meta refuses it that other business's catalogs and creators' posts).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { setSetting } from '../settings';
import { META_TOKEN_KEY, setRaw } from '../modules/admin';
import { idsKept, LaunchSpec } from '../modules/adslaunch';
import { runMeta } from '../meta';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(220));
});
const JPEG = '/9j/' + 'A'.repeat(120);
const TOKEN = 'EAAG-test-token-' + 'z'.repeat(40);

// ---------------------------------------------------------------- 1. a changed launch makes its campaign again
const spec = (extra: Partial<LaunchSpec> = {}): LaunchSpec =>
  LaunchSpec.parse({ goal: 'sales', productId: 1, name: 'Poussette — test', mediaIds: [3], text: { primary: 'Texte', headline: 'Titre' }, budgetUsd: 5, ...extra });
const made = { account: '1234567890', 'image:p1': 'hash1', 'video:v1': '9001', campaign: '120300', 'adset:a': '120310', 'creative:c': '120320', 'ad:x': '120330', form: '555000' };

test('idsKept: the same choices keep everything (a retry goes on where it stopped)', () => {
  assert.deepEqual(idsKept(spec(), spec(), made), made);
  assert.deepEqual(idsKept(spec(), spec(), null), {});
});

test('idsKept: another goal (or any other change) makes the campaign again, the photos and videos sent stay', () => {
  const kept = { account: '1234567890', 'image:p1': 'hash1', 'video:v1': '9001' };
  assert.deepEqual(idsKept(spec(), spec({ goal: 'traffic' }), made), kept);
  assert.deepEqual(idsKept(spec(), spec({ budgetUsd: 6 }), made), kept);
  assert.deepEqual(idsKept(spec(), spec({ text: { primary: 'Autre texte', headline: 'Titre' } }), made), kept);
  // a launch saved before (no spec yet, or one that no longer reads): made again too
  assert.deepEqual(idsKept({}, spec(), made), kept);
});

test('idsKept: the instant form stays while the goal is still a form with the same questions', () => {
  const form = { name: 'Poussette — form', commune: true, variant: false, privacyUrl: 'https://pilotix.online/conditions', lang: 'fr' as const };
  const before1 = spec({ goal: 'form', newForm: form });
  assert.equal(idsKept(before1, spec({ goal: 'form', newForm: form, budgetUsd: 7 }), made).form, '555000');
  assert.equal(idsKept(before1, spec({ goal: 'form', newForm: { ...form, commune: false } }), made).form, undefined);
  assert.equal(idsKept(before1, spec({ goal: 'messages' }), made).form, undefined);
  assert.equal(idsKept(before1, spec({ goal: 'form', newForm: form, budgetUsd: 7 }), made).campaign, undefined);
});

type Seen = { action: string; args: any };
test('a failed launch: the same retry reuses its campaign, another goal makes a new one (the photo sent stays)', async () => {
  const seen: Seen[] = [];
  let refuse = true;
  let n = 0;
  const server: NonNullable<Ctx['server']> = {
    courier: async () => ({}),
    hashPassword: async (p) => p,
    publicUrl: 'https://pilotix.test',
    meta: async (action, args: any) => {
      seen.push({ action, args });
      if (action === 'test') return { name: 'Compte test', currency: 'USD' };
      if (action === 'eventAudience') return { id: args.metaId ?? `99000000000000${++n}`, made: !args.metaId, partial: false };
      if (action === 'audience') return { id: args.metaId ?? '23851000000000009', received: args.phones.length };
      if (action === 'launch') {
        // the photo and the campaign are made; Meta refuses the ad set (as it refused the Messages ad set on a Lead campaign)
        const ids: Record<string, string> = { ...(args.done ?? {}) };
        ids['image:p1'] ??= 'hash-photo';
        ids.campaign ??= `1203000000000${++n}`;
        if (refuse) return { ids, error: 'Meta : You can’t use the selected performance goal with your campaign objective.', step: 'adsets' };
        args.plan.adsets.forEach((a: any, k: number) => (ids[`adset:${a.key}`] = `1203100000${n}${k}`));
        args.plan.ads.forEach((a: any, k: number) => (ids[`ad:${a.key}`] = `1203200000${n}${k}`));
        return { ids, error: null, step: 'done' };
      }
      return {};
    },
  };
  const boss = () => as(EMAILS.vendeur, server);
  await call('admin.meta.save', await as(EMAILS.admin, server), { adAccountId: 'act_1234567890', token: TOKEN });
  await setRaw(db, 'social_page', { pageId: '104500000000001', name: 'Bébé Confort DZ' });
  const o: any = await call('ads.launch.options', await boss(), {});
  const p = o.products.find((x: any) => x.landing);
  assert.ok(p, 'a product with its sales page');
  const photo: any = await call('ads.media.photo', await boss(), { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1350 });
  const draft = async (goal: 'sales' | 'traffic', id?: number): Promise<any> =>
    call('ads.launch.save', await boss(), { ...(id ? { id } : {}), mode: 'simple', spec: { goal, productId: p.id, name: 'Retry — test', mediaIds: [photo.id], text: { primary: 'Texte', headline: 'Titre' }, budgetUsd: 5 } });
  const metaIds = async (id: number) => (await db.query(`SELECT meta_ids FROM ad_launches WHERE id = $1`, [id]))[0].meta_ids;
  const launches = () => seen.filter((c) => c.action === 'launch');

  // 1st try: the campaign is made, Meta refuses the ad set
  const d: any = await draft('sales');
  await assert.rejects(call('ads.launch.go', await boss(), { id: d.id }));
  const first = await metaIds(d.id);
  assert.ok(first.campaign && first['image:p1'], JSON.stringify(first));
  assert.equal(first.account, '1234567890', 'the ad account the ids were made in');

  // the same choices again: the campaign made is reused (nothing made twice)
  await draft('sales', d.id);
  assert.equal((await metaIds(d.id)).campaign, first.campaign);
  await assert.rejects(call('ads.launch.go', await boss(), { id: d.id }));
  assert.equal(launches().at(-1)!.args.done.campaign, first.campaign);

  // another goal: the old campaign (made for « sales ») is not sent again; the photo already sent is
  await draft('traffic', d.id);
  const changed = await metaIds(d.id);
  assert.equal(changed.campaign, undefined, JSON.stringify(changed));
  assert.equal(changed['image:p1'], first['image:p1']);
  refuse = false;
  const live: any = await call('ads.launch.go', await boss(), { id: d.id });
  assert.equal(live.status, 'live');
  const sent = launches().at(-1)!.args.done;
  assert.equal(sent.campaign, undefined, 'a new campaign for the new goal');
  assert.equal(sent['image:p1'], first['image:p1']);
  assert.notEqual(live.campaignId, first.campaign);
});

// ---------------------------------------------------------------- 2. the business Meta answers for
type Answer = [number, unknown];
let realFetch: typeof fetch;
before(() => {
  realFetch = globalThis.fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});
/** Meta's Graph API, faked: `answers` by « METHOD path » (no version, no query); every call is written in `calls` */
function fakeGraph(answers: Record<string, Answer>, calls: string[]) {
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    const path = new URL(String(url)).pathname.replace(/^\/v\d+\.\d+\//, '');
    const key = `${init?.method ?? 'GET'} ${path}`;
    calls.push(key);
    const [status, body] = answers[key] ?? [404, { error: { code: 100, message: `unexpected ${key}` } }];
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}
const NO_RIGHT: Answer = [400, { error: { code: 10, message: 'Application does not have permission for this action' } }];
const FORBIDDEN: Answer = [403, { error: { message: 'Forbidden' } }];
const connect = async () => {
  await setSetting(db, 'meta', { adAccountId: '1234567890', hasToken: true });
  await setRaw(db, META_TOKEN_KEY, TOKEN);
  return as(EMAILS.admin);
};

test('catalog: made in the ad account’s business when Meta takes it there (nothing else asked)', async () => {
  const ctx = await connect();
  const calls: string[] = [];
  fakeGraph(
    {
      'GET act_1234567890': [200, { id: 'act_1234567890', business: { id: '111111', name: 'Propriétaire' } }],
      'POST 111111/owned_product_catalogs': [200, { id: '7777777' }],
      'POST 7777777/external_event_sources': [200, { success: true }],
    },
    calls,
  );
  const r = await runMeta('catalogSetup', { name: 'Ma boutique', pixelIds: ['1234567890123456'] }, ctx);
  assert.deepEqual(r, { catalogId: '7777777', businessId: '111111', businessName: 'Propriétaire', pixelsLinked: true });
  assert.deepEqual(calls, ['GET act_1234567890', 'POST 111111/owned_product_catalogs', 'POST 7777777/external_event_sources']);
});

test('catalog: refused in the ad account’s business (a system user of the agency), made in the token’s own one', async () => {
  const ctx = await connect();
  const calls: string[] = [];
  fakeGraph(
    {
      'GET act_1234567890': [200, { id: 'act_1234567890', business: { id: '111111', name: 'Propriétaire' } }],
      'POST 111111/owned_product_catalogs': NO_RIGHT,
      'GET me/businesses': [200, { data: [{ id: '111111', name: 'Propriétaire' }, { id: '222222', name: 'Agence' }] }],
      'POST 222222/owned_product_catalogs': [200, { id: '3333333' }],
      'POST 3333333/external_event_sources': FORBIDDEN,
    },
    calls,
  );
  const r = await runMeta('catalogSetup', { name: 'Ma boutique', pixelIds: ['1234567890123456'] }, ctx);
  // the pixel another business holds cannot be linked: the catalog is made all the same
  assert.deepEqual(r, { catalogId: '3333333', businessId: '222222', businessName: 'Agence', pixelsLinked: false });
  assert.deepEqual(calls, ['GET act_1234567890', 'POST 111111/owned_product_catalogs', 'GET me/businesses', 'POST 222222/owned_product_catalogs', 'POST 3333333/external_event_sources']);
});

test('catalog: refused everywhere: the first « no » is told; Meta limiting the calls stops at once', async () => {
  const ctx = await connect();
  const calls: string[] = [];
  fakeGraph(
    {
      'GET act_1234567890': [200, { id: 'act_1234567890', business: { id: '111111', name: 'Propriétaire' } }],
      'POST 111111/owned_product_catalogs': NO_RIGHT,
      'GET me/businesses': [200, { data: [{ id: '222222', name: 'Agence' }] }],
      'POST 222222/owned_product_catalogs': NO_RIGHT,
    },
    calls,
  );
  await assert.rejects(runMeta('catalogSetup', { name: 'Ma boutique', pixelIds: [] }, ctx), /permission de gérer vos catalogues/);
  const limited: string[] = [];
  fakeGraph(
    {
      'GET act_1234567890': [200, { id: 'act_1234567890', business: { id: '111111', name: 'Propriétaire' } }],
      'POST 111111/owned_product_catalogs': [400, { error: { code: 17, message: 'User request limit reached' } }],
    },
    limited,
  );
  await assert.rejects(runMeta('catalogSetup', { name: 'Ma boutique', pixelIds: [] }, ctx), /limite/);
  assert.deepEqual(limited, ['GET act_1234567890', 'POST 111111/owned_product_catalogs']);
});

test('influencers: the creators’ posts asked through the ad account’s business, then the Page’s, then the token’s own', async () => {
  const ctx = await connect();
  const calls: string[] = [];
  fakeGraph(
    {
      'GET 178400000000001/branded_content_ad_permissions': [200, { data: [{ creator_username: 'amina' }] }],
      'GET act_1234567890': [200, { id: 'act_1234567890', business: { id: '111111', name: 'Propriétaire' } }],
      'GET 111111/partnership-ads-advertisable-content': FORBIDDEN,
      'GET 104500000000001': [200, { id: '104500000000001', business: { id: '444444', name: 'Page' } }],
      'GET 444444/partnership-ads-advertisable-content': FORBIDDEN,
      'GET me/businesses': [200, { data: [{ id: '222222', name: 'Agence' }] }],
      'GET 222222/partnership-ads-advertisable-content': [200, { data: [{ content_id: 'c1' }] }],
    },
    calls,
  );
  const r: any = await runMeta('partnerSync', { igId: '178400000000001', pageId: '104500000000001' }, ctx);
  assert.deepEqual(r, { permissions: [{ creator_username: 'amina' }], content: [{ content_id: 'c1' }], errors: [] });
  assert.deepEqual(calls.slice(1), [
    'GET act_1234567890',
    'GET 111111/partnership-ads-advertisable-content',
    'GET 104500000000001',
    'GET 444444/partnership-ads-advertisable-content',
    'GET me/businesses',
    'GET 222222/partnership-ads-advertisable-content',
  ]);

  // one creator's post, by its code: the same way
  const one: string[] = [];
  fakeGraph(
    {
      'GET act_1234567890': [200, { id: 'act_1234567890', business: { id: '111111', name: 'Propriétaire' } }],
      'GET 111111/partnership-ads-advertisable-content': FORBIDDEN,
      'GET 104500000000001': [200, { id: '104500000000001' }],
      'GET me/businesses': [200, { data: [{ id: '222222', name: 'Agence' }] }],
      'GET 222222/partnership-ads-advertisable-content': [200, { data: [{ content_id: 'c2' }] }],
    },
    one,
  );
  assert.deepEqual(await runMeta('partnerLookup', { igId: '178400000000001', pageId: '104500000000001', adCode: 'CODE1' }, ctx), { content: [{ content_id: 'c2' }] });
});

test('influencers: refused by every business: the first « no » is told, the requests list still comes', async () => {
  const ctx = await connect();
  const calls: string[] = [];
  fakeGraph(
    {
      'GET 178400000000001/branded_content_ad_permissions': [200, { data: [] }],
      'GET act_1234567890': [200, { id: 'act_1234567890', business: { id: '111111', name: 'Propriétaire' } }],
      'GET 111111/partnership-ads-advertisable-content': FORBIDDEN,
      'GET 104500000000001': [200, { id: '104500000000001' }],
      'GET me/businesses': [200, { data: [] }],
    },
    calls,
  );
  const r: any = await runMeta('partnerSync', { igId: '178400000000001', pageId: '104500000000001' }, ctx);
  assert.deepEqual(r.permissions, []);
  assert.deepEqual(r.content, []);
  assert.deepEqual(r.errors, ['Meta : Forbidden']);
});
