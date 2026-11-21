// Landing pages › Réglages › « Paramètres d’URL »: an ad made in Meta's Ads Manager that sends people to a website
// without the ids gets them from Pilotix while it is new (its first TAG_FIX_H hours: a copy of its créa with them, on
// the same ad); an older one is never touched, only listed; a kind Pilotix does not copy is listed at once; Meta's « no »
// is tried again, then said; Meta's « later » is no « no »; off, nothing is touched. And Meta itself (meta.ts): the créa
// is copied as Meta has it, the parameters added, then put on the same ad; an existing post Meta keeps is not changed.
// Several texts, videos or formats: copied too, put on the ad only when Meta's copy shows the same pieces; a flexible
// ad whose groups changed gets its old créa back. The ids Meta keeps on each link count as the ad's own.
import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, test } from 'node:test';
import { AppError, call, Ctx, Db } from '../index';
import { runMeta } from '../meta';
import { META_TOKEN_KEY, setRaw } from '../modules/admin';
import { TAG_FIX_H, TAG_TRIES, tagRun } from '../modules/adsmgr';
import { adTagsLack, creaEmpty, feedKey, groupsKey, HAND_URL_TAGS, needsTags, tagKindOf, taggedCopy, tagsLack, URL_TAGS, withTags } from '../modules/pilotads';
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
type Ad = { id: string; name: string; campaign: string; adsetId: string; status: string | null; created: string | null; needs: boolean; kind: string; empty?: boolean };
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

test('the line: Facebook and Instagram apart (Meta’s {{site_source_name}}), the three ids, on Pilotix’s ads and on the line to paste', () => {
  for (const line of [URL_TAGS, HAND_URL_TAGS]) {
    assert.match(line, /^utm_source=\{\{site_source_name\}\}&utm_medium=paid&/);
    assert.deepEqual(tagsLack(line), []);
  }
});

test('nothing at all in an ad’s URL parameters (nor on its links): Meta’s own numbers then find its orders', () => {
  assert.equal(creaEmpty({ url_tags: '', object_story_spec: { link_data: { link: 'https://x.dz' } } }), true);
  assert.equal(creaEmpty({}), true);
  assert.equal(creaEmpty({ url_tags: 'utm_source=fb' }), false);
  assert.equal(creaEmpty({ asset_feed_spec: { link_urls: [{ website_url: 'https://x.dz', url_tags: '' }] } }), true);
  assert.equal(creaEmpty({ asset_feed_spec: { link_urls: [{ website_url: 'https://x.dz', url_tags: 'promo=ete' }] } }), false);
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

test('several texts, videos or formats: the ids Meta keeps on each link count, when every link has them', () => {
  const feed = (url_tags: string, ...links: string[]) => ({ url_tags, asset_feed_spec: { link_urls: links.map((t, i) => ({ website_url: `https://babyjoydz.net/p${i}`, url_tags: t })) } });
  assert.deepEqual(adTagsLack(feed('', HAND_URL_TAGS)), [], 'pasted in Meta, kept on the link');
  assert.equal(needsTags(feed('', HAND_URL_TAGS)), false, 'no false alarm');
  assert.deepEqual(adTagsLack(feed(HAND_URL_TAGS, '')), [], 'on the créa itself');
  assert.deepEqual(adTagsLack(feed('', HAND_URL_TAGS, 'utm_source=fb')), ['campaign_id', 'adset_id', 'ad_id'], 'one link without them: its clicks miss them');
  assert.deepEqual(adTagsLack(feed('campaign_id={{campaign.id}}', 'adset_id={{adset.id}}&ad_id={{ad.id}}')), [], 'the créa and the link together');
  assert.equal(needsTags(feed('', 'utm_source=fb')), true);
  // one photo or video: only the créa's own parameters, as before
  assert.deepEqual(adTagsLack({ url_tags: 'ad_id={{ad.id}}' }), ['campaign_id', 'adset_id']);
});

test('the kinds: one photo or video, an existing post and several texts are copied; a catalogue or an Instagram post are not', () => {
  assert.equal(tagKindOf({ object_story_spec: { link_data: { link: 'https://x.dz' } } }), 'spec');
  assert.equal(tagKindOf({ object_story_spec: { video_data: { video_id: '9' } } }), 'spec');
  assert.equal(tagKindOf({ object_story_id: '1_2' }), 'post');
  assert.equal(tagKindOf({ object_story_spec: { link_data: {} }, asset_feed_spec: { bodies: [] } }), 'feed');
  assert.equal(tagKindOf({ product_set_id: '5', object_story_spec: { template_data: {} } }), 'catalog');
  assert.equal(tagKindOf({ product_set_id: '5', asset_feed_spec: { optimization_type: 'FORMAT_AUTOMATION' } }), 'catalog', 'a catalogue ad with several formats');
  assert.equal(tagKindOf({ source_instagram_media_id: '7' }), 'other');
  assert.equal(taggedCopy({ asset_feed_spec: {} }, 'x'), null, 'several texts without their page: not copied');
  assert.equal(taggedCopy({ object_story_id: '1_2', object_story_spec: { page_id: '1' }, asset_feed_spec: { bodies: [] } }, 'x'), null, 'several texts on an existing post: not copied');
  assert.equal(taggedCopy({ product_set_id: '5', object_story_spec: { page_id: '1' }, asset_feed_spec: {} }, 'x'), null);
});

test('the copy of several texts, videos or formats: the same pieces as Meta has them, each picture by its hash, the parameters added', () => {
  const c = {
    id: '445',
    url_tags: '',
    object_story_spec: { page_id: '1', instagram_user_id: '2' },
    asset_feed_spec: {
      videos: [
        { video_id: '91', thumbnail_hash: 'h1', thumbnail_url: 'https://scontent/1.jpg' },
        { video_id: '92', thumbnail_url: 'https://scontent/2.jpg' },
      ],
      images: [{ hash: 'i1', url: 'https://scontent/i1.jpg' }],
      bodies: [{ text: 'Hook 1' }, { text: 'Hook 2' }],
      titles: [{ text: 'Poussette' }],
      link_urls: [{ website_url: 'https://babyjoydz.net/poussette' }],
      call_to_action_types: ['SHOP_NOW'],
      ad_formats: ['AUTOMATIC_FORMAT'],
      optimization_type: 'DEGREES_OF_FREEDOM',
    },
    degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: 'OPT_IN' } } },
  };
  const b = taggedCopy(c, 'Pub') as any;
  assert.equal(b.url_tags, HAND_URL_TAGS);
  assert.deepEqual(b.object_story_spec, { page_id: '1', instagram_user_id: '2' });
  assert.deepEqual(b.asset_feed_spec.videos, [{ video_id: '91', thumbnail_hash: 'h1' }, { video_id: '92', thumbnail_url: 'https://scontent/2.jpg' }], 'one picture per video: its hash when Meta gives it');
  assert.deepEqual(b.asset_feed_spec.images, [{ hash: 'i1' }]);
  assert.deepEqual(b.asset_feed_spec.bodies, c.asset_feed_spec.bodies);
  assert.equal(b.asset_feed_spec.optimization_type, 'DEGREES_OF_FREEDOM');
  assert.equal(b.degrees_of_freedom_spec, undefined, 'Meta’s old bundle alone: nothing left to send');
  assert.equal(c.asset_feed_spec.videos[0].thumbnail_url, 'https://scontent/1.jpg', 'Meta’s answer itself is not changed');
  // the same pieces, in any order, give the same line; one video less does not
  assert.equal(feedKey(b.asset_feed_spec), feedKey(c.asset_feed_spec));
  assert.equal(feedKey({ ...c.asset_feed_spec, bodies: [{ text: 'Hook 2' }, { text: 'Hook 1' }] }), feedKey(c.asset_feed_spec));
  assert.notEqual(feedKey({ ...c.asset_feed_spec, videos: [{ video_id: '91' }] }), feedKey(c.asset_feed_spec));
  assert.notEqual(feedKey({ ...c.asset_feed_spec, titles: [] }), feedKey(c.asset_feed_spec));
});

test('a flexible ad’s groups as one line: none is empty, the same groups in any order match, a change does not', () => {
  const g = (...groups: any[]) => ({ groups });
  assert.equal(groupsKey(undefined), '');
  assert.equal(groupsKey(g()), '');
  const a = { videos: [{ video_id: '1' }, { video_id: '2' }], texts: [{ text: 'Hook', text_type: 'primary_text' }], group_uuid: 'x' };
  const b = { images: [{ hash: 'h' }], texts: [{ text: 'Titre', text_type: 'headline' }] };
  assert.equal(groupsKey(g(a, b)), groupsKey(g(b, { ...a, group_uuid: 'y' })));
  assert.notEqual(groupsKey(g(a, b)), groupsKey(g(a)));
  assert.notEqual(groupsKey(g(a)), groupsKey(g({ ...a, videos: [{ video_id: '1' }] })));
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
  const { server, tags } = fakeServer([ad('921', ago(H), { kind: 'other' }), ad('922', ago(H), { kind: 'catalog' })]);
  const s = await tagRun(await owner(server));
  assert.deepEqual(tags, []);
  assert.deepEqual(
    s.missing.map((m) => [m.id, m.why]).sort(),
    [
      ['921', 'other'],
      ['922', 'catalog'],
    ],
  );
});

test('several texts, videos or formats: a new one is given the parameters; one Meta could not copy the same is listed, never asked again; an old one is not touched', async () => {
  const { server, tags } = fakeServer([ad('925', ago(H), { kind: 'feed', name: 'ad copie 05' }), ad('926', ago(H), { kind: 'feed' }), ad('927', ago(3 * 24 * H), { kind: 'feed' })], (id) =>
    id === '925' ? { done: true, creativeId: '556' } : { done: false, why: 'feed' },
  );
  const ctx = await owner(server);
  const s = await tagRun(ctx);
  assert.deepEqual(tags, ['925', '926'], 'the two new ones are tried, the old one never');
  assert.equal(s.fixed[0].name, 'ad copie 05');
  assert.deepEqual(
    s.missing.map((m) => [m.id, m.why]),
    [
      ['926', 'feed'],
      ['927', 'old'],
    ],
  );
  const again = await tagRun(ctx);
  assert.equal(tags.filter((x) => x === '926').length, 1, 'the one not copied the same is never tried again');
  assert.ok(again.missing.some((m) => m.id === '926' && m.why === 'feed'), 'and stays said');
});

test('a new ad Meta has already shown is left as it is (its learning would start again): listed once, never asked again', async () => {
  const { server, tags } = fakeServer([ad('925', ago(2 * H), { empty: true }), ad('926', ago(2 * H), { empty: false })], () => ({ done: false, why: 'running' }));
  const ctx = await owner(server);
  const s = await tagRun(ctx);
  assert.deepEqual(
    s.missing.map((m) => [m.id, m.why, m.empty]).sort(),
    [
      ['925', 'running', true],
      ['926', 'running', false],
    ],
    'with whether Meta’s own numbers still find its orders (nothing in its URL parameters)',
  );
  await tagRun(ctx);
  assert.deepEqual(tags, ['925', '926'], 'asked once each');
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
    ['GET 120200888', 'GET 120200888/insights', 'GET 120200888', 'POST act_123/adcreatives', 'GET 555', 'POST 120200888'],
  );
  assert.equal(calls[1].body.date_preset, 'maximum', 'shown or not, over its whole life');
  assert.equal(calls[2].body.fields, 'creative_asset_groups_spec', 'its flexible groups read apart: none here');
  const made = calls[3].body;
  assert.equal(made.url_tags, HAND_URL_TAGS);
  assert.equal(made.object_story_spec.link_data.link, 'https://babyjoydz.net/p');
  assert.equal(made.object_story_spec.link_data.picture, undefined);
  assert.deepEqual(calls[5].body.creative, { creative_id: '555' });
  assert.equal(calls[5].body.access_token, 'tok', 'the key in the body, never in the address');
});

test('Meta: an ad Meta has shown already (even a little) is not changed: no copy made', async () => {
  const calls = fakeMeta((c) => {
    if (c.path === '120200895') return { account_id: '123', name: 'Pub', creative: CREA };
    if (c.path === '120200895/insights') return { data: [{ impressions: '37' }] };
    return { id: '999' };
  });
  assert.deepEqual(await runMeta('tagAd', { id: '120200895' }, await owner()), { done: false, why: 'running' });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ['GET 120200895', 'GET 120200895/insights'],
  );
});

test('Meta: an existing post Meta answers with its old créa is not changed; a tagged ad, another account, a kind not copied neither', async () => {
  let calls = fakeMeta((c) => (c.method === 'GET' ? { account_id: '123', creative: { id: '444', object_story_id: '1_2' } } : { id: '444' }));
  assert.deepEqual(await runMeta('tagAd', { id: '120200889' }, await owner()), { done: false, why: 'post' });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ['GET 120200889', 'GET 120200889/insights', 'GET 120200889', 'POST act_123/adcreatives'],
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

// several texts, videos or formats as Meta has them (one video, two hooks), and a flexible ad's groups
const FEED = {
  id: '445',
  name: 'ad copie 05',
  url_tags: '',
  object_story_spec: { page_id: '1' },
  asset_feed_spec: {
    videos: [{ video_id: '91', thumbnail_hash: 'h1', thumbnail_url: 'https://scontent/1.jpg' }],
    bodies: [{ text: 'Hook 1' }, { text: 'Hook 2' }],
    link_urls: [{ website_url: 'https://babyjoydz.net/poussette' }],
    call_to_action_types: ['SHOP_NOW'],
    ad_formats: ['AUTOMATIC_FORMAT'],
  },
};
const GROUPS = { groups: [{ videos: [{ video_id: '91' }], texts: [{ text: 'Hook 1', text_type: 'primary_text' }], group_uuid: 'g1' }] };
/** Meta for one such ad: its créa, its groups (before and after its créa changes), the copy Meta makes */
function feedMeta(o: { groups?: unknown; groupsAfter?: unknown; copy?: unknown; groupsError?: boolean } = {}) {
  let changed = false;
  return fakeMeta((c) => {
    if (c.method === 'GET' && c.path === '120200893') {
      if (c.body.fields !== 'creative_asset_groups_spec') return { account_id: '123', name: 'ad copie 05', creative: FEED };
      if (o.groupsError) return { error: { message: 'Tried accessing nonexisting field (creative_asset_groups_spec)', code: 100 } };
      return { id: '120200893', creative_asset_groups_spec: changed && o.groupsAfter !== undefined ? o.groupsAfter : o.groups };
    }
    if (c.method === 'POST' && c.path === 'act_123/adcreatives') return { id: '556' };
    if (c.method === 'GET' && c.path === '556') return { id: '556', url_tags: HAND_URL_TAGS, asset_feed_spec: o.copy ?? FEED.asset_feed_spec };
    if (c.method === 'POST' && c.path === '120200893') changed = String(c.body.creative?.creative_id) === '556';
    return { success: true };
  });
}
const steps = (calls: MetaCall[]) => calls.map((c) => `${c.method} ${c.path}`);
const onAd = (calls: MetaCall[]) => calls.filter((c) => c.method === 'POST' && c.path === '120200893').map((c) => String(c.body.creative?.creative_id));

test('Meta: several texts, videos or formats are copied with the parameters, then put on the same ad — the copy has the same pieces', async () => {
  const calls = feedMeta();
  assert.deepEqual(await runMeta('tagAd', { id: '120200893' }, await owner()), { done: true, creativeId: '556' });
  assert.deepEqual(steps(calls), ['GET 120200893', 'GET 120200893/insights', 'GET 120200893', 'POST act_123/adcreatives', 'GET 556', 'POST 120200893']);
  const made = calls[3].body;
  assert.equal(made.url_tags, HAND_URL_TAGS);
  assert.deepEqual(made.object_story_spec, { page_id: '1' });
  assert.deepEqual(made.asset_feed_spec.videos, [{ video_id: '91', thumbnail_hash: 'h1' }]);
  assert.deepEqual(made.asset_feed_spec.bodies, FEED.asset_feed_spec.bodies);
  assert.equal(calls[4].body.fields, 'url_tags,asset_feed_spec', 'the copy read back whole');
  assert.deepEqual(onAd(calls), ['556']);
});

test('Meta: a copy that lost a piece, or without the parameters, is never put on the ad', async () => {
  let calls = feedMeta({ copy: { ...FEED.asset_feed_spec, bodies: [{ text: 'Hook 1' }] } });
  assert.deepEqual(await runMeta('tagAd', { id: '120200893' }, await owner()), { done: false, why: 'feed' });
  assert.deepEqual(onAd(calls), [], 'the ad itself is never touched');
  calls = fakeMeta((c) => {
    if (c.method === 'GET' && c.path === '120200893') return c.body.fields === 'creative_asset_groups_spec' ? { id: '120200893' } : { account_id: '123', creative: FEED };
    if (c.method === 'POST' && c.path === 'act_123/adcreatives') return { id: '556' };
    return { id: '556', url_tags: '', asset_feed_spec: FEED.asset_feed_spec };
  });
  assert.deepEqual(await runMeta('tagAd', { id: '120200893' }, await owner()), { done: false, why: 'feed' });
  assert.deepEqual(onAd(calls), []);
});

test('Meta: a flexible ad keeps its groups; if they changed, its old créa is put back at once', async () => {
  let calls = feedMeta({ groups: GROUPS });
  assert.deepEqual(await runMeta('tagAd', { id: '120200893' }, await owner()), { done: true, creativeId: '556' });
  assert.deepEqual(steps(calls), ['GET 120200893', 'GET 120200893/insights', 'GET 120200893', 'POST act_123/adcreatives', 'GET 556', 'POST 120200893', 'GET 120200893'], 'the groups read again after: the same');
  calls = feedMeta({ groups: GROUPS, groupsAfter: { groups: [] } });
  assert.deepEqual(await runMeta('tagAd', { id: '120200893' }, await owner()), { done: false, why: 'feed' });
  assert.deepEqual(onAd(calls), ['556', '445'], 'the copy, then the old créa back');
});

test('Meta: when Meta does not say a flexible ad’s groups, several texts are left as they are; one photo or video is done as before', async () => {
  const calls = feedMeta({ groupsError: true });
  assert.deepEqual(await runMeta('tagAd', { id: '120200893' }, await owner()), { done: false, why: 'feed' });
  assert.deepEqual(steps(calls), ['GET 120200893', 'GET 120200893/insights', 'GET 120200893'], 'nothing made, nothing changed');
  const one = fakeMeta((c) => {
    if (c.method === 'GET' && c.path === '120200888') return c.body.fields === 'creative_asset_groups_spec' ? { error: { message: 'nonexisting field', code: 100 } } : { account_id: '123', creative: CREA };
    if (c.method === 'POST' && c.path === 'act_123/adcreatives') return { id: '555' };
    if (c.method === 'GET' && c.path === '555') return { id: '555', url_tags: HAND_URL_TAGS };
    return { success: true };
  });
  assert.deepEqual(await runMeta('tagAd', { id: '120200888' }, await owner()), { done: true, creativeId: '555' });
  assert.equal(steps(one).at(-1), 'POST 120200888');
});

test('Meta: out of reach while reading the groups is no « not copied »: said as it is, so the next run tries again', async () => {
  globalThis.fetch = (async (u: any) => {
    if (new URL(String(u)).searchParams.get('fields') === 'creative_asset_groups_spec') throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ account_id: '123', creative: FEED }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  await assert.rejects(runMeta('tagAd', { id: '120200893' }, await owner()), /injoignable/);
});

test('Meta: the ads read, deleted ones left out, each with whether it needs the parameters', async () => {
  fakeMeta(() => ({
    data: [
      { id: '1', name: 'A', adset_id: '7', created_time: '2026-11-20T18:30:00+0100', effective_status: 'ACTIVE', campaign: { name: 'TEST' }, adset: { destination_type: 'WEBSITE' }, creative: CREA },
      { id: '2', name: 'B', adset_id: '7', created_time: '2026-11-19T18:30:00+0100', effective_status: 'DELETED', creative: CREA },
      { id: '3', name: 'C', adset_id: '8', effective_status: 'PAUSED', adset: { destination_type: 'MESSENGER' }, creative: { object_story_id: '1_2' } },
      // several texts whose link keeps the parameters pasted in Meta: no false alarm
      { id: '4', name: 'D', adset_id: '9', effective_status: 'ACTIVE', adset: { destination_type: 'WEBSITE' }, creative: { object_story_spec: { page_id: '1' }, asset_feed_spec: { link_urls: [{ website_url: 'https://babyjoydz.net/p', url_tags: HAND_URL_TAGS }] } } },
    ],
  }));
  const r = (await runMeta('tagAds', {}, await owner())) as any;
  assert.deepEqual(
    r.ads.map((x: any) => [x.id, x.needs, x.kind, x.campaign, x.adsetId]),
    [
      ['1', true, 'spec', 'TEST', '7'],
      ['3', false, 'post', '', '8'],
      ['4', false, 'feed', '', '9'],
    ],
  );
  assert.deepEqual(
    r.ads.map((x: any) => x.empty),
    [true, true, false],
    'nothing in its URL parameters: Meta adds its own numbers',
  );
  assert.equal(r.ads[0].created, '2026-11-20T18:30:00+01:00');
});
