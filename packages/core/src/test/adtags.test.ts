// Landing pages › Réglages › « Paramètres d’URL »: an ad made in Meta's Ads Manager that sends people to a website
// without the ids gets them from Pilotix while it is new (its first TAG_FIX_H hours: a copy of its créa with them, on
// the same ad); an older one is never touched, only listed; a kind Pilotix does not copy is listed at once; Meta's « no »
// is tried again, then said; Meta's « later » is no « no »; off, nothing is touched. And Meta itself (meta.ts): the créa
// is copied as Meta has it, the parameters added, then put on the same ad; an existing post Meta keeps is not changed.
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, test } from 'node:test';
import { AppError, call, Ctx, Db } from '../index';
import { runMeta } from '../meta';
import { META_TOKEN_KEY, setRaw } from '../modules/admin';
import { TAG_FIX_H, TAG_TRIES, tagRun } from '../modules/adsmgr';
import { HAND_URL_TAGS, needsTags, tagKindOf, taggedCopy, tagsLack, withTags } from '../modules/pilotads';
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
  await db.query(`DELETE FROM settings WHERE key = 'pilot_ads_tags'`);
});

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const H = 3_600_000;
type Ad = { id: string; name: string; campaign: string; adsetId: string; status: string | null; created: string | null; needs: boolean; kind: string };
const ad = (id: string, created: string, o: Partial<Ad> = {}): Ad => ({ id, name: `Pub ${id}`, campaign: 'TEST', adsetId: '777', status: 'ACTIVE', created, needs: true, kind: 'spec', ...o });

/** the server as these tests see it: Meta's ads, and every « tag » asked */
function fakeServer(ads: Ad[], tag: (id: string) => unknown = () => ({ done: true, creativeId: '555' })) {
  const tags: string[] = [];
  const server = {
    courier: async () => null,
    meta: async (action: string, args: any) => {
      if (action === 'tagAds') return { ads };
      if (action === 'tagAd') {
        tags.push(args.id);
        return tag(args.id);
      }
      throw new AppError('bad_request', `unexpected ${action}`);
    },
  } as unknown as Ctx['server'];
  return { server, tags };
}
const owner = (server?: Ctx['server']) => as(EMAILS.vendeur, server);

// ---------------------------------------------------------------- the rules (pilotads.ts)
test('the ids an ad misses; the owner’s own parameters are kept, only the missing ones added', () => {
  assert.deepEqual(tagsLack(''), ['campaign_id', 'adset_id', 'ad_id']);
  assert.deepEqual(tagsLack(null), ['campaign_id', 'adset_id', 'ad_id']);
  assert.deepEqual(tagsLack(HAND_URL_TAGS), []);
  assert.deepEqual(tagsLack('utm_source=fb&ad_id={{ad.id}}&adset_id='), ['campaign_id', 'adset_id'], 'an empty value is missing');
  assert.equal(withTags(''), HAND_URL_TAGS);
  assert.equal(
    withTags('utm_source=fb&adset_id=&promo=ete'),
    'utm_source=fb&adset_id={{adset.id}}&promo=ete&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&ad_id={{ad.id}}',
  );
  assert.equal(withTags(HAND_URL_TAGS), HAND_URL_TAGS, 'nothing twice');
});

test('an ad needs them when it sends people to a website without the ids; Messenger, WhatsApp or a tagged ad does not', () => {
  const page = (link: string, url_tags = '') => ({ url_tags, object_story_spec: { page_id: '1', link_data: { link } } });
  assert.equal(needsTags(page('https://babyjoydz.net/poucette')), true);
  assert.equal(needsTags(page('https://babyjoydz.net/poucette', HAND_URL_TAGS)), false);
  assert.equal(needsTags(page('https://api.whatsapp.com/send?phone=213')), false);
  assert.equal(needsTags(page('https://www.facebook.com/babyjoy')), false);
  assert.equal(needsTags({ object_story_spec: { video_data: { call_to_action: { type: 'SHOP_NOW', value: { link: 'https://go.pilotix.online/baby-joy-dz/velo' } } } } }), true);
  // an existing post shows no link: its ad set says where it goes
  assert.equal(needsTags({ object_story_id: '1_2' }, 'WEBSITE'), true);
  assert.equal(needsTags({ object_story_id: '1_2' }, 'MESSENGER'), false);
  assert.equal(needsTags({ asset_feed_spec: { link_urls: [{ website_url: 'https://babyjoydz.net/x' }] } }), true);
});

test('the kinds: one photo or video and an existing post are copied; several texts, a catalogue or an Instagram post are not', () => {
  assert.equal(tagKindOf({ object_story_spec: { link_data: { link: 'https://x.dz' } } }), 'spec');
  assert.equal(tagKindOf({ object_story_spec: { video_data: { video_id: '9' } } }), 'spec');
  assert.equal(tagKindOf({ object_story_id: '1_2' }), 'post');
  assert.equal(tagKindOf({ object_story_spec: { link_data: {} }, asset_feed_spec: { bodies: [] } }), 'feed');
  assert.equal(tagKindOf({ product_set_id: '5', object_story_spec: { template_data: {} } }), 'catalog');
  assert.equal(tagKindOf({ source_instagram_media_id: '7' }), 'other');
  assert.equal(taggedCopy({ asset_feed_spec: {} }, 'x'), null);
});

test('the copy: the same post as Meta has it, the photo once (its hash), the owner’s choices kept, the parameters added', () => {
  const c = {
    id: '444',
    url_tags: 'utm_source=fb',
    object_story_spec: {
      page_id: '1',
      instagram_user_id: '2',
      video_data: { video_id: '9', message: 'Poussette', image_hash: 'abc', image_url: 'https://scontent/x.jpg', call_to_action: { type: 'SHOP_NOW', value: { link: 'https://babyjoydz.net/p' } } },
    },
    degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_IN' }, image_touchups: { enroll_status: 'OPT_IN' } } },
    contextual_multi_ads: { enroll_status: 'OPT_OUT' },
  };
  const b = taggedCopy(c, 'Pub · paramètres d’URL') as any;
  assert.equal(b.url_tags, withTags('utm_source=fb'));
  assert.equal(b.object_story_spec.video_data.image_hash, 'abc');
  assert.equal(b.object_story_spec.video_data.image_url, undefined, 'Meta takes one photo');
  assert.equal(b.object_story_spec.video_data.call_to_action.value.link, 'https://babyjoydz.net/p');
  assert.equal(b.object_story_spec.instagram_user_id, '2');
  assert.deepEqual(b.degrees_of_freedom_spec, { creative_features_spec: { image_touchups: { enroll_status: 'OPT_IN' } } });
  assert.deepEqual(b.contextual_multi_ads, { enroll_status: 'OPT_OUT' });
  assert.equal(c.object_story_spec.video_data.image_url, 'https://scontent/x.jpg', 'Meta’s answer itself is not changed');
  const p = taggedCopy({ object_story_id: '1_2', instagram_user_id: '3', url_tags: '' }, 'x') as any;
  assert.deepEqual(p, { name: 'x', url_tags: HAND_URL_TAGS, object_story_id: '1_2', instagram_user_id: '3' });
});

// ---------------------------------------------------------------- the check (adsmgr.ts)
test('a new ad made in Meta gets the parameters; an older one is only listed; one that has them or goes to Messenger is left alone', async () => {
  const { server, tags } = fakeServer([
    ad('901', ago(30 * 60_000), { name: 'Poussette pliable' }),
    ad('902', ago(3 * 24 * H), { name: 'Vieux SCALE' }),
    ad('903', ago(10 * 60_000), { needs: false }),
    ad('904', ago(5 * 24 * H), { status: 'PAUSED', name: 'Vieux en pause' }),
  ]);
  const s = await tagRun(await owner(server));
  assert.deepEqual(tags, ['901'], 'only the new one is changed');
  assert.equal(s.fixed[0].id, '901');
  assert.equal(s.fixed[0].name, 'Poussette pliable');
  assert.deepEqual(
    s.missing.map((m) => [m.id, m.why]),
    [
      ['902', 'old'],
      ['904', 'old'],
    ],
    'the older ones are listed, running first',
  );
  assert.ok(s.checkedAt);
  assert.equal(s.error, null);
});

test(`the edge: ${TAG_FIX_H} hours old is still new, a minute more is not`, async () => {
  const { server, tags } = fakeServer([ad('911', ago(TAG_FIX_H * H - 60_000)), ad('912', ago(TAG_FIX_H * H + 60_000))]);
  const s = await tagRun(await owner(server));
  assert.deepEqual(tags, ['911']);
  assert.deepEqual(
    s.missing.map((m) => m.id),
    ['912'],
  );
});

test('a kind Pilotix does not copy is listed at once, with why, and Meta is not asked', async () => {
  const { server, tags } = fakeServer([ad('921', ago(H), { kind: 'feed' }), ad('922', ago(H), { kind: 'catalog' })]);
  const s = await tagRun(await owner(server));
  assert.deepEqual(tags, []);
  assert.deepEqual(
    s.missing.map((m) => [m.id, m.why]).sort(),
    [
      ['921', 'feed'],
      ['922', 'catalog'],
    ],
  );
});

test('an existing post Meta keeps without the parameters: listed, never tried again; one tagged meanwhile is left alone', async () => {
  const { server, tags } = fakeServer([ad('931', ago(H), { kind: 'post' }), ad('932', ago(H))], (id) => (id === '931' ? { done: false, why: 'post' } : { done: false, why: 'tagged' }));
  const ctx = await owner(server);
  const s = await tagRun(ctx);
  assert.deepEqual(
    s.missing.map((m) => [m.id, m.why]),
    [['931', 'post']],
  );
  await tagRun(ctx);
  assert.deepEqual(tags, ['931', '932', '932'], 'the post is asked once; the tagged one is looked at again (it may lose them)');
});

test(`Meta's « no » is tried again on the next runs, ${TAG_TRIES} times in all, then the ad is listed with Meta's words`, async () => {
  const { server, tags } = fakeServer([ad('941', ago(H))], () => {
    throw new AppError('bad_request', 'Meta : Invalid parameter');
  });
  const ctx = await owner(server);
  for (let k = 1; k < TAG_TRIES; k++) {
    const s = await tagRun(ctx);
    assert.equal(s.missing.length, 0, `try ${k}: not « without the parameters » yet, the next run tries again`);
    assert.equal(s.tries['941'].n, k);
  }
  const s = await tagRun(ctx);
  assert.equal(tags.length, TAG_TRIES);
  assert.deepEqual([s.missing[0].id, s.missing[0].why, s.missing[0].error], ['941', 'refused', 'Meta : Invalid parameter']);
  const again = await tagRun(ctx);
  assert.equal(tags.length, TAG_TRIES, 'never again: the tries are used up');
  assert.equal(again.missing[0].error, 'Meta : Invalid parameter', 'the refusal stays said');
});

test('Meta saying « later » is no « no »: nothing counted, the others wait too, said once', async () => {
  const { server, tags } = fakeServer([ad('951', ago(H)), ad('952', ago(H))], () => {
    throw new AppError('conflict', 'Meta limite les demandes pour l’instant : réessayez dans quelques minutes.');
  });
  const s = await tagRun(await owner(server));
  assert.deepEqual(tags, ['951'], 'one asked, the second waits for the next run');
  assert.equal(s.missing.length, 0);
  assert.deepEqual(s.tries, {});
  assert.match(String(s.error), /limite les demandes/);
});

test('Meta out of reach when reading: what was found last time stays, the error is said', async () => {
  const first = fakeServer([ad('961', ago(5 * 24 * H))]);
  await tagRun(await owner(first.server));
  const down = {
    courier: async () => null,
    meta: async () => {
      throw new AppError('bad_request', 'Meta injoignable. Réessayez plus tard.');
    },
  } as unknown as Ctx['server'];
  const s = await tagRun(await owner(down));
  assert.deepEqual(
    s.missing.map((m) => m.id),
    ['961'],
  );
  assert.match(String(s.error), /injoignable/);
});

test('off: Pilotix touches no ad made by hand; the owner turns it back on', async () => {
  const { server, tags } = fakeServer([ad('971', ago(H))]);
  const ctx = await owner(server);
  const off = (await call('ads.tags.save', ctx, { on: false })) as any;
  assert.equal(off.on, false);
  await tagRun(ctx);
  assert.equal(tags.length, 0);
  await call('ads.tags.save', ctx, { on: true });
  await tagRun(ctx);
  assert.deepEqual(tags, ['971']);
});

test('a marketer sees only the ads of his own ad sets on the card; the owner sees them all', async () => {
  const { server } = fakeServer([ad('981', ago(20 * 24 * H), { adsetId: '120200005' }), ad('982', ago(9 * 24 * H), { adsetId: '991' })]);
  await tagRun(await owner(server));
  const mine = (await call('ads.tags.state', await as(EMAILS.marketer), {})) as any;
  assert.deepEqual(
    mine.missing.map((m: any) => m.id),
    ['981'],
  );
  assert.equal(mine.owner, false);
  const all = (await call('ads.tags.state', await owner(), {})) as any;
  assert.deepEqual(all.missing.map((m: any) => m.id).sort(), ['981', '982']);
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
const CREA = { id: '444', name: 'Poussette', url_tags: '', object_story_spec: { page_id: '1', link_data: { link: 'https://babyjoydz.net/p', message: 'Poussette', image_hash: 'abc', picture: 'https://scontent/x.jpg' } } };

test('Meta: the créa is copied with the parameters, then put on the same ad', async () => {
  const calls = fakeMeta((c) => {
    if (c.method === 'GET' && c.path === '120200888') return { account_id: '123', name: 'Pub', creative: CREA };
    if (c.method === 'POST' && c.path === 'act_123/adcreatives') return { id: '555' };
    if (c.method === 'GET' && c.path === '555') return { id: '555', url_tags: HAND_URL_TAGS };
    return { success: true };
  });
  const r = await runMeta('tagAd', { id: '120200888' }, await owner());
  assert.deepEqual(r, { done: true, creativeId: '555' });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ['GET 120200888', 'POST act_123/adcreatives', 'GET 555', 'POST 120200888'],
  );
  const made = calls[1].body;
  assert.equal(made.url_tags, HAND_URL_TAGS);
  assert.equal(made.object_story_spec.link_data.link, 'https://babyjoydz.net/p');
  assert.equal(made.object_story_spec.link_data.picture, undefined);
  assert.deepEqual(calls[3].body.creative, { creative_id: '555' });
  assert.equal(calls[3].body.access_token, 'tok', 'the key in the body, never in the address');
});

test('Meta: an existing post Meta answers with its old créa is not changed; a tagged ad, another account, a kind not copied neither', async () => {
  let calls = fakeMeta((c) => (c.method === 'GET' ? { account_id: '123', creative: { id: '444', object_story_id: '1_2' } } : { id: '444' }));
  assert.deepEqual(await runMeta('tagAd', { id: '120200889' }, await owner()), { done: false, why: 'post' });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ['GET 120200889', 'POST act_123/adcreatives'],
    'the ad itself is never touched',
  );
  calls = fakeMeta(() => ({ account_id: '123', creative: { ...CREA, url_tags: HAND_URL_TAGS } }));
  assert.deepEqual(await runMeta('tagAd', { id: '120200890' }, await owner()), { done: false, why: 'tagged' });
  assert.equal(calls.length, 1);
  calls = fakeMeta(() => ({ account_id: '123', creative: { id: '4', asset_feed_spec: { bodies: [] } } }));
  assert.deepEqual(await runMeta('tagAd', { id: '120200891' }, await owner()), { done: false, why: 'feed' });
  assert.equal(calls.length, 1);
  fakeMeta(() => ({ account_id: '999', creative: CREA }));
  await assert.rejects(runMeta('tagAd', { id: '120200892' }, await owner()), /compte pub relié/);
});

test('Meta: the ads read, deleted ones left out, each with whether it needs the parameters', async () => {
  fakeMeta(() => ({
    data: [
      { id: '1', name: 'A', adset_id: '7', created_time: '2026-11-20T18:30:00+0100', effective_status: 'ACTIVE', campaign: { name: 'TEST' }, adset: { destination_type: 'WEBSITE' }, creative: CREA },
      { id: '2', name: 'B', adset_id: '7', created_time: '2026-11-19T18:30:00+0100', effective_status: 'DELETED', creative: CREA },
      { id: '3', name: 'C', adset_id: '8', effective_status: 'PAUSED', adset: { destination_type: 'MESSENGER' }, creative: { object_story_id: '1_2' } },
    ],
  }));
  const r = (await runMeta('tagAds', {}, await owner())) as any;
  assert.deepEqual(
    r.ads.map((x: any) => [x.id, x.needs, x.kind, x.campaign, x.adsetId]),
    [
      ['1', true, 'spec', 'TEST', '7'],
      ['3', false, 'post', '', '8'],
    ],
  );
  assert.equal(r.ads[0].created, '2026-11-20T18:30:00+01:00');
});
