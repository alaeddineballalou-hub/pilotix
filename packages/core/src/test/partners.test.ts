// Marketing › Influenceurs (Meta's partnership ads) and Publicité › Demander (Pilot AI with Meta's ads MCP server):
// what the person types, Meta's answers made plain, the ads in two names (a new ad with the creator as second name, a
// creator's post boosted), the creators' numbers from their ads' own ids, the requests on the server, Pilot AI's reads
// and the change that waits for the owner's yes (then the owner's limits, Meta, the log), and the MCP client itself.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { setRaw, META_TOKEN_KEY } from '../modules/admin';
import { changeOf, intentOf, isWrite } from '../modules/adsask';
import { contentOf, igUsername, pageNumber, permissionOf, statusOf } from '../modules/partners';
import { launchProblems, metaPlan, type LaunchInput } from '../modules/pilotads';
import { SOCIAL_KEYS } from '../modules/social';
import { McpSession, readMessage, resultOf, toolOf } from '../metamcp';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(220));
});
const owner = (server?: Ctx['server']) => as(EMAILS.vendeur, server);
const mk = (server?: Ctx['server']) => as(EMAILS.marketer, server);

const base = (extra: Partial<LaunchInput> = {}): LaunchInput => ({
  goal: 'sales',
  name: 'Poussette × Amina',
  pageId: '104500000000001',
  instagramId: '178400000000001',
  pixelId: '1234567890123456',
  link: 'https://go.pilotix.app/boutique/poussette',
  text: { primary: 'Poussette à 8 900 DA', headline: 'Poussette' },
  media: [{ kind: 'photo', mediaId: 7, name: 'Photo 1' }],
  budgetCents: 800,
  budgetLevel: 'adset',
  split: 'one',
  regions: [],
  ageMin: 18,
  ageMax: 65,
  genders: [],
  advantageAudience: true,
  excludeAudiences: [],
  includeAudiences: [],
  ...extra,
});

test('what the person types: an Instagram name, a Page number', () => {
  assert.equal(igUsername('@Amina.Style'), 'amina.style');
  assert.equal(igUsername('https://www.instagram.com/rym.beauty.dz/?hl=fr'), 'rym.beauty.dz');
  assert.equal(igUsername('amina style'), null);
  assert.equal(igUsername('.amina'), null);
  assert.equal(igUsername('a..b'), null);
  assert.equal(pageNumber('https://www.facebook.com/profile.php?id=100089123456789'), '100089123456789');
  assert.equal(pageNumber('104900000000044'), '104900000000044');
  assert.equal(pageNumber('https://facebook.com/pages/Lina-Maman/104900000000044/'), '104900000000044');
  assert.equal(pageNumber('facebook.com/linamaman'), null);
});

test('Meta’s answers made plain: requests and posts', () => {
  assert.equal(statusOf('APPROVED'), 'approved');
  assert.equal(statusOf('PENDING'), 'pending');
  assert.equal(statusOf('DECLINED'), 'refused');
  assert.equal(statusOf('REVOKED'), 'revoked');
  assert.deepEqual(permissionOf({ creator_username: 'Jaspersmarket', creator_id: '123', creator_fb_page: '456', permission_status: 'APPROVED', id: '9' }), {
    id: '9',
    username: 'jaspersmarket',
    igId: '123',
    pageId: '456',
    status: 'approved',
  });
  const c = contentOf({
    content_id: '17901',
    platform: 'INSTAGRAM',
    media_type: 'VIDEO',
    post_type: 'REEL',
    caption: 'Merci @shop',
    permalink: 'https://www.instagram.com/reel/abc/',
    creation_time: '2026-10-30',
    author: { display_name: 'amina.style', ig_user_id: '1784', profile_picture_url: 'https://scontent.example/p.jpg' },
    partnership_info: [
      { ad_eligibility: 'NEEDS_ATTENTION', permission_status: 'PENDING' },
      { ad_eligibility: 'AD_READY', permission_status: 'APPROVED', ad_code: 'AbC_123-xyz', eligibility_errors: [{ code: 'X', message: 'm', severity: 'WARNING' }] },
    ],
    organic_insights: { likes: 10, views: '200', comments: null },
  })!;
  assert.equal(c.contentId, '17901');
  assert.equal(c.eligibility, 'AD_READY', 'the best of its partnership lines');
  assert.equal(c.permission, 'APPROVED');
  assert.equal(c.adCode, 'AbC_123-xyz');
  assert.equal(c.errors[0].severity, 'warning');
  assert.equal(c.postedOn, '2026-10-30');
  assert.deepEqual(c.insights, { likes: 10, comments: null, views: 200, reach: null, shares: null, saves: null });
  assert.equal(c.author.picture, 'https://scontent.example/p.jpg');
  assert.equal(contentOf({ content_id: 'x' }), null);
  assert.equal(contentOf({ content_id: '104_9', platform: 'FACEBOOK', permalink: 'javascript:x' })!.permalink, null);
});

test('an ad in two names: the shop first, the creator second; a creator’s post boosted', () => {
  const p = metaPlan(base({ partner: { igId: '178419900000011', pageId: '104900000000011' } }));
  const c = p.creatives[0].body as any;
  assert.deepEqual(c.instagram_branded_content, { sponsor_id: '178419900000011' });
  assert.deepEqual(c.facebook_branded_content, { sponsor_page_id: '104900000000011' });
  assert.equal(c.object_story_spec.page_id, '104500000000001', 'the shop’s Page is the ad’s first name');
  assert.ok(c.url_tags.includes('ad_id={{ad.id}}'), 'the ad’s ids on the link count the creator’s orders');
  // a creator's Instagram reel, boosted to sell: the creator first, the shop second, the shop's page and button
  const b = metaPlan(base({ media: [], text: { primary: '', headline: '' }, boost: { platform: 'INSTAGRAM', contentId: '17901000000000201' } }));
  assert.equal(b.creatives.length, 1);
  assert.equal(b.ads.length, 1);
  const bc = b.creatives[0].body as any;
  assert.equal(bc.object_id, '104500000000001');
  assert.equal(bc.source_instagram_media_id, '17901000000000201');
  assert.deepEqual(bc.branded_content, { ad_format: 1 });
  assert.deepEqual(bc.instagram_branded_content, { sponsor_id: '178400000000001' });
  assert.deepEqual(bc.facebook_branded_content, { sponsor_page_id: '104500000000001' });
  assert.deepEqual(bc.call_to_action, { type: 'SHOP_NOW', value: { link: 'https://go.pilotix.app/boutique/poussette' } });
  assert.equal(bc.object_story_spec, undefined);
  // with the creator's ad code, the code carries their yes (no media id)
  const code = metaPlan(base({ media: [], boost: { platform: 'INSTAGRAM', contentId: '1790', adCode: 'CODE123' } })).creatives[0].body as any;
  assert.deepEqual(code.branded_content, { instagram_boost_post_access_token: 'CODE123', ad_format: 1 });
  assert.equal(code.source_instagram_media_id, undefined);
  // a Facebook post stays as it is
  const fb = metaPlan(base({ goal: 'awareness', media: [], boost: { platform: 'FACEBOOK', contentId: '104_901' } })).creatives[0].body as any;
  assert.equal(fb.object_story_id, '104_901');
  assert.equal(fb.call_to_action, undefined);
  // what stops it
  assert.deepEqual(launchProblems(base({ media: [], text: { primary: '', headline: '' }, boost: { platform: 'INSTAGRAM', contentId: '1' } })), []);
  assert.ok(launchProblems(base({ goal: 'messages', channels: ['messenger'], media: [], boost: { platform: 'INSTAGRAM', contentId: '1' } })).some((x) => /booste/.test(x)));
  assert.ok(launchProblems(base({ media: [], boost: { platform: 'FACEBOOK', contentId: '1' } })).some((x) => /Être vu/.test(x)));
  assert.ok(launchProblems(base({ partner: { igId: null, pageId: null } })).some((x) => /actualisez/.test(x)));
});

test('the demo: the creators, what their ads brought, their posts', async () => {
  const b: any = await call('partners.board', await mk(), { days: 30 });
  assert.equal(b.demo, true);
  assert.equal(b.partners.length, 4);
  const amina = b.partners.find((p: any) => p.igUsername === 'amina.style');
  assert.equal(amina.status, 'approved');
  assert.ok(amina.launches >= 1 && amina.live >= 1);
  assert.ok(amina.spendUsd > 0, 'its ads spent');
  assert.ok(amina.orders > 0, 'orders came from its ads (their ids on the order)');
  assert.ok(amina.delivered <= amina.orders);
  assert.equal(amina.posts, 3);
  const rym = b.partners.find((p: any) => p.igUsername === 'rym.beauty.dz');
  assert.ok(rym.orders > 0, 'the boosted reel brought orders too');
  assert.equal(b.partners.find((p: any) => p.igUsername === 'yasmine.mamans').status, 'pending');
  assert.equal(b.partners.find((p: any) => p.pageId === '104900000000044').status, 'page');
  assert.ok(b.content.length >= 8);
  assert.equal(b.content.find((c: any) => c.id === '17901000000000202').boostable, false);
  assert.ok(
    b.content.some((c: any) => c.partnerId === null),
    'a creator the shop does not know yet',
  );
  assert.equal(b.totals.approved, 2);
  // since the start: at least as much
  const all: any = await call('partners.board', await mk(), { days: 0 });
  assert.ok(all.totals.orders >= b.totals.orders);
  // only Marketing
  await assert.rejects(call('partners.board', await as(EMAILS.conf), { days: 30 }));
});

test('the demo: add by Instagram or Page, a code pub, remove', async () => {
  const r: any = await call('partners.add', await mk(), { ig: 'https://instagram.com/Nour.Kids/', note: 'Vue sur TikTok' });
  assert.equal(r.status, 'pending');
  await assert.rejects(call('partners.add', await mk(), { ig: '@nour.kids' }), /déjà/);
  await assert.rejects(call('partners.add', await mk(), { ig: '@bebeconfort.dz' }), /compte Instagram de la boutique/);
  await assert.rejects(call('partners.add', await mk(), { page: 'facebook.com/nour' }), /numéro de la Page/);
  await assert.rejects(call('partners.add', await mk(), {}), /Instagram ou le numéro/);
  const pg: any = await call('partners.add', await mk(), { page: '100089000000123', name: 'Nour Page' });
  assert.equal(pg.status, 'page');
  // a code pub: the post and its creator join
  const l: any = await call('partners.lookup', await mk(), { code: 'AdCode_7788' });
  assert.equal(l.ids.length, 1);
  const post = (await db.query(`SELECT partner_id, ad_code FROM ad_partner_content WHERE content_id = $1`, [l.ids[0]]))[0];
  assert.ok(post.partner_id);
  assert.equal(post.ad_code, 'AdCode_7788');
  assert.equal((await db.query(`SELECT status FROM ad_partners WHERE id = $1`, [post.partner_id]))[0].status, 'code');
  // removed: gone when no ad used them, kept as « retiré » when one did
  assert.deepEqual(await call('partners.revoke', await mk(), { id: r.id, remove: true }), { removed: true });
  const amina = Number((await db.query(`SELECT id FROM ad_partners WHERE ig_username = 'amina.style'`))[0].id);
  assert.deepEqual(await call('partners.revoke', await mk(), { id: amina, remove: true }), { removed: false });
  assert.equal((await db.query(`SELECT status FROM ad_partners WHERE id = $1`, [amina]))[0].status, 'revoked');
  // asked again
  const again: any = await call('partners.ask', await mk(), { id: amina });
  assert.equal(again.status, 'pending');
  await db.query(`UPDATE ad_partners SET status = 'approved' WHERE id = $1`, [amina]);
});

test('the launcher offers the creators; a launch in two names, and a creator’s post boosted (demo)', async () => {
  const o: any = await call('ads.launch.options', await owner(), {});
  assert.ok(o.partners.some((p: any) => p.igUsername === 'amina.style'));
  const withPost: any = await call('ads.launch.options', await owner(), { contentId: '17901000000000101' });
  assert.equal(withPost.boost.id, '17901000000000101');
  assert.equal(withPost.boost.adCode, undefined, 'the creator’s code stays on the server');
  const p = o.products.find((x: any) => x.landing);
  const amina = o.partners.find((x: any) => x.igUsername === 'amina.style');
  const JPEG = '/9j/' + 'A'.repeat(120);
  const photo: any = await call('ads.media.photo', await owner(), { jpeg: JPEG, thumb: JPEG, w: 1080, h: 1350 });
  const d: any = await call('ads.launch.save', await owner(), {
    mode: 'simple',
    spec: { goal: 'sales', productId: p.id, name: 'Test × Amina', mediaIds: [photo.id], text: { primary: 'Texte', headline: 'Titre' }, budgetUsd: 6, partnerId: amina.id },
  });
  assert.equal(d.partnerId, amina.id);
  const live: any = await call('ads.launch.go', await owner(), { id: d.id });
  assert.equal(live.status, 'live');
  assert.equal(live.partnerName, 'Amina Style');
  // boosted: no photo of the shop, the creator from the post
  const b: any = await call('ads.launch.save', await owner(), {
    mode: 'simple',
    spec: { goal: 'sales', productId: p.id, name: 'Reel boosté', mediaIds: [photo.id], text: { primary: '', headline: '' }, budgetUsd: 5, partnerContentId: '17901000000000101' },
  });
  assert.equal(b.partnerId, amina.id);
  assert.deepEqual(b.spec.mediaIds, []);
  const chk: any = await call('ads.launch.check', await owner(), { id: b.id });
  assert.equal(chk.ok, true, chk.problems.join(' | '));
  // a post Meta refuses: stopped before Meta
  const no: any = await call('ads.launch.save', await owner(), {
    mode: 'simple',
    spec: { goal: 'sales', productId: p.id, name: 'Refusé', mediaIds: [], text: { primary: '', headline: '' }, budgetUsd: 5, partnerContentId: '17901000000000202' },
  });
  const nochk: any = await call('ads.launch.check', await owner(), { id: no.id });
  assert.equal(nochk.ok, false);
  assert.ok(nochk.problems.some((x: string) => /musique/.test(x)));
});

test('server: a request, the refresh (statuses, posts), a launch in two names sent to Meta', async () => {
  const calls: { action: string; args: any }[] = [];
  const server: any = {
    publicUrl: 'https://pilotix.test',
    publicApi: 'https://pilotix.test/api',
    pagesUrl: () => 'https://go.pilotix.test',
    courier: async () => null,
    hashPassword: async (x: string) => x,
    meta: async (action: string, args: any) => {
      calls.push({ action, args });
      if (action === 'partnerRequest') return { id: 'perm-1' };
      if (action === 'partnerSync')
        return {
          permissions: [
            { creator_username: 'sofia.dz', creator_id: '178477', permission_status: 'APPROVED', id: 'perm-1' },
            { creator_username: 'elsewhere.made', creator_id: '178488', permission_status: 'PENDING', id: 'perm-2' },
          ],
          content: [
            { content_id: '1790777', platform: 'INSTAGRAM', media_type: 'VIDEO', author: { display_name: 'sofia.dz', ig_user_id: '178477' }, partnership_info: [{ ad_eligibility: 'AD_READY' }] },
            { content_id: 'bad id!' },
          ],
          errors: [],
        };
      if (action === 'launch') return { ids: { campaign: '900', 'adset:a0': '901', 'creative:c0': '902', 'ad:d0': '903' }, error: null, step: 'done' };
      return { ok: true };
    },
  };
  await setRaw(db, SOCIAL_KEYS.page, { pageId: '104500000000001', name: 'Bébé Confort DZ', igId: '178400000000001', igUsername: 'bebeconfort.dz' });
  const m = await mk(server);
  const r: any = await call('partners.add', m, { ig: 'sofia.dz' });
  assert.equal(r.status, 'pending');
  assert.deepEqual(calls.at(-1), { action: 'partnerRequest', args: { igId: '178400000000001', username: 'sofia.dz' } });
  const s: any = await call('partners.refresh', m, {});
  assert.equal(s.permissions, 2);
  assert.equal(s.posts, 1, 'a post with a bad id is left out');
  const sofia = (await db.query(`SELECT * FROM ad_partners WHERE ig_username = 'sofia.dz'`))[0];
  assert.equal(sofia.status, 'approved');
  assert.equal(sofia.ig_id, '178477');
  assert.equal((await db.query(`SELECT partner_id FROM ad_partner_content WHERE content_id = '1790777'`))[0].partner_id, sofia.id);
  assert.ok((await db.query(`SELECT 1 FROM ad_partners WHERE ig_username = 'elsewhere.made' AND status = 'pending'`)).length, 'a request made in Meta Business Suite joins');
  // a launch in two names: the creator's Instagram as second name on every créa
  await setRaw(db, META_TOKEN_KEY, 'tok');
  await setRaw(db, 'meta', { adAccountId: '120211887', hasToken: true });
  const o: any = await call('ads.launch.options', await owner(server), {});
  const p = o.products.find((x: any) => x.landing && x.landing.url);
  if (!p) return;
  const img = Number((await db.query(`INSERT INTO cm_media (key, w, h, jpeg, thumb, bytes, for_ads) VALUES ('k', 1080, 1080, '/9j/x', '/9j/x', 10, true) RETURNING id`))[0].id);
  const d: any = await call('ads.launch.save', await owner(server), {
    mode: 'simple',
    spec: { goal: 'sales', productId: p.id, name: 'Server × Sofia', mediaIds: [img], text: { primary: 'Texte', headline: 'Titre' }, budgetUsd: 6, partnerId: Number(sofia.id), pixelId: '1234567890123456' },
  });
  const live: any = await call('ads.launch.go', await owner(server), { id: d.id });
  assert.equal(live.status, 'live');
  const plan = calls.find((c) => c.action === 'launch')!.args.plan;
  assert.deepEqual(plan.creatives[0].body.instagram_branded_content, { sponsor_id: '178477' });
  // revoked: Meta is told, and an ad in their name is refused
  await call('partners.revoke', m, { id: Number(sofia.id) });
  assert.deepEqual(calls.at(-1), { action: 'partnerRevoke', args: { igId: '178400000000001', creatorId: '178477', username: 'sofia.dz' } });
  const d2: any = await call('ads.launch.save', await owner(server), {
    mode: 'simple',
    spec: { goal: 'sales', productId: p.id, name: 'Encore', mediaIds: [img], text: { primary: 'T', headline: 'T' }, budgetUsd: 6, partnerId: Number(sofia.id) },
  });
  const chk: any = await call('ads.launch.check', await owner(server), { id: d2.id });
  assert.ok(chk.problems.some((x: string) => /retiré son accord/.test(x)));
  await db.query(`DELETE FROM settings WHERE key IN ($1, $2, 'meta')`, [SOCIAL_KEYS.page, META_TOKEN_KEY]);
});

test('Demander: reading or changing, the change Pilotix knows, the intent of a question', () => {
  assert.equal(isWrite({ name: 'ads_get_ad_set_status', readOnly: null, destructive: null }), false);
  assert.equal(isWrite({ name: 'ads_insights_performance', readOnly: null, destructive: null }), false);
  assert.equal(isWrite({ name: 'ads_catalog_get_products', readOnly: null, destructive: null }), false);
  assert.equal(isWrite({ name: 'ads_update_entity', readOnly: null, destructive: null }), true);
  assert.equal(isWrite({ name: 'ads_create_campaign', readOnly: null, destructive: null }), true);
  assert.equal(isWrite({ name: 'mystery_tool', readOnly: null, destructive: null }), true, 'a tool that says nothing waits for the owner');
  assert.equal(isWrite({ name: 'ads_update_entity', readOnly: true, destructive: null }), false, 'what the tool says of itself first');
  assert.equal(isWrite({ name: 'ads_get_x', readOnly: false, destructive: null }), true);
  assert.deepEqual(changeOf({ entity_id: '120200005', status: 'PAUSED' }), { op: 'pause', objectId: '120200005', budgetCents: null });
  assert.deepEqual(changeOf({ id: '120200001', fields: { daily_budget: '2500' } }), { op: 'budget', objectId: '120200001', budgetCents: 2500 });
  assert.deepEqual(changeOf({ adset_id: '120200001', daily_budget: 25 }, 'units'), { op: 'budget', objectId: '120200001', budgetCents: 2500 });
  assert.deepEqual(changeOf({ name: 'Nouvelle campagne', objective: 'OUTCOME_SALES' }), { op: null, objectId: null, budgetCents: null });
  assert.equal(intentOf('Mets en pause celle qui ne vend pas'), 'pause');
  assert.equal(intentOf('وقف الإعلان الغالي'), 'pause');
  assert.equal(intentOf('Augmente le budget de la meilleure'), 'raise');
  assert.equal(intentOf('Compare avec la semaine dernière'), 'compare');
  assert.equal(intentOf('Combien j’ai dépensé ?'), 'summary');
});

test('Demander (demo): the owner only, a change waits for the yes, then the log', async () => {
  await assert.rejects(call('ads.ask.state', await mk(), {}));
  const st: any = await call('ads.ask.state', await owner(), {});
  assert.equal(st.demo, true);
  assert.ok(st.asks.length >= 2, 'the demo’s questions');
  assert.equal(st.waiting, 1);
  const a: any = await call('ads.ask.send', await owner(), { question: 'Combien j’ai dépensé cette semaine ?', lang: 'fr' });
  assert.equal(a.status, 'done');
  assert.match(a.answer, /\$/);
  assert.ok(a.reads.length);
  const p: any = await call('ads.ask.send', await owner(), { question: 'Mets en pause celle qui vend le moins', threadId: a.threadId, lang: 'fr' });
  assert.equal(p.threadId, a.threadId);
  assert.equal(p.status, 'waiting_yes');
  assert.equal(p.pending.op, 'pause');
  const target = String(p.pending.input.entity_id);
  assert.equal((await db.query(`SELECT status FROM adsets WHERE id = $1`, [target]))[0].status, 'ACTIVE', 'nothing changed before the yes');
  const done: any = await call('ads.ask.decide', await owner(), { id: p.id, yes: true });
  assert.equal(done.status, 'applied');
  assert.equal((await db.query(`SELECT status FROM adsets WHERE id = $1`, [target]))[0].status, 'PAUSED');
  const log = (await db.query(`SELECT op, source, status FROM ad_actions WHERE object_id = $1 ORDER BY id DESC LIMIT 1`, [target]))[0];
  assert.deepEqual({ ...log }, { op: 'pause', source: 'ask', status: 'done' });
  await assert.rejects(call('ads.ask.decide', await owner(), { id: p.id, yes: true }), /n’attend plus/);
  // « Tout arrêter » is on: starting it again is refused
  const ar: any = await call('ads.ask.send', await owner(), { question: 'Arabic: وقف الإعلان', lang: 'fr' });
  assert.equal(ar.lang, 'ar');
  await call('ads.ctl.stopAll', await owner(), { on: true });
  const again = Number(
    (
      await db.query(`INSERT INTO ads_asks (thread_id, by_user, question, answer, pending, status) VALUES (1, NULL, 'q', 'a', $1, 'waiting_yes') RETURNING id`, [
        JSON.stringify({ tool: 'ads_update_entity', input: { entity_id: target, status: 'ACTIVE' }, label: 'x', kind: { op: 'resume', objectId: target, budgetCents: null } }),
      ])
    )[0].id,
  );
  await assert.rejects(call('ads.ask.decide', await owner(), { id: again, yes: true }), /arrêté/);
  await call('ads.ctl.stopAll', await owner(), { on: false });
  const no: any = await call('ads.ask.decide', await owner(), { id: again, yes: false });
  assert.equal(no.status, 'refused');
  await call('ads.ask.forget', await owner(), { threadId: a.threadId });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM ads_asks WHERE thread_id = $1`, [a.threadId]))[0].n, 0);
});

test('Demander (server): Meta’s tools read, the change waits, then the same tool with the same arguments', async () => {
  const calls: { action: string; args: any }[] = [];
  let round = 0;
  const server: any = {
    publicUrl: 'https://pilotix.test',
    courier: async () => null,
    hashPassword: async (x: string) => x,
    meta: async (action: string, args: any) => {
      calls.push({ action, args });
      if (action === 'mcpTools')
        return {
          tools: [
            { name: 'ads_insights_performance', description: 'Results', inputSchema: { type: 'object', properties: { level: { type: 'string' } } }, readOnly: true, destructive: false },
            {
              name: 'ads_update_entity',
              description: 'Change',
              inputSchema: { type: 'object', properties: { entity_id: { type: 'string' }, daily_budget: { type: 'integer', description: 'in cents' } } },
              readOnly: null,
              destructive: null,
            },
          ],
        };
      if (action === 'mcpCall') return { text: JSON.stringify({ data: [{ id: '120200001', spend_usd: 70, purchases: 30 }] }), isError: false };
      return { ok: true };
    },
    dellal: async (action: string, req: any) => {
      assert.equal(action, 'complete');
      assert.ok(req.tools.find((t: any) => t.name === 'ads_update_entity').description.includes('waits for the owner'));
      round++;
      if (round === 1) return { content: [{ type: 'tool_use', id: 't1', name: 'ads_insights_performance', input: { level: 'adset' } }], stop_reason: 'tool_use' };
      if (round === 2) return { content: [{ type: 'tool_use', id: 't2', name: 'ads_update_entity', input: { entity_id: '120200001', daily_budget: 2600 } }], stop_reason: 'tool_use' };
      return { content: [{ type: 'text', text: 'Je propose de monter **Poussette** à 26 $ par jour.' }], stop_reason: 'end_turn' };
    },
  };
  await setRaw(db, 'meta', { adAccountId: '120211887', hasToken: true });
  await setRaw(db, 'secret_dellal_ai_key', 'sk-test');
  const o = await owner(server);
  const r: any = await call('ads.ask.send', o, { question: 'Monte la meilleure de 20 %', lang: 'fr' });
  assert.equal(r.status, 'waiting_yes');
  assert.equal(r.answer, 'Je propose de monter Poussette à 26 $ par jour.', 'no markdown');
  assert.deepEqual(r.reads, [{ tool: 'ads_insights_performance', ok: true }]);
  assert.ok(!calls.some((c) => c.action === 'mcpCall' && c.args.name === 'ads_update_entity'), 'the change is not made before the yes');
  assert.match(r.pending.label, /Budget de « Poussette/);
  const done: any = await call('ads.ask.decide', o, { id: r.id, yes: true });
  assert.equal(done.status, 'applied');
  assert.deepEqual(calls.at(-1), { action: 'mcpCall', args: { name: 'ads_update_entity', args: { entity_id: '120200001', daily_budget: 2600 } } });
  assert.equal((await db.query(`SELECT daily_budget_cents FROM adsets WHERE id = '120200001'`))[0].daily_budget_cents, 2600);
  await db.query(`DELETE FROM settings WHERE key IN ('meta', 'secret_dellal_ai_key')`);
});

test('the MCP client: a session, an event stream, the tools and a call', async () => {
  const seen: { body: any; headers: Record<string, string> }[] = [];
  const http = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    seen.push({ body, headers: init.headers });
    if (body.method === 'initialize')
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } });
    if (!('id' in body)) return new Response(null, { status: 202 });
    if (body.method === 'tools/list')
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'ads_get_campaigns', description: 'List', annotations: { readOnlyHint: true } }] } })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    if (body.method === 'tools/call') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } }), { headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 500 });
  }) as unknown as typeof fetch;
  const s = new McpSession('tok', 'https://mcp.test/ads', http);
  const tools = await s.tools();
  assert.deepEqual(
    tools.map((t) => [t.name, t.readOnly]),
    [['ads_get_campaigns', true]],
  );
  assert.equal((await s.call('ads_get_campaigns', {})).text, 'ok');
  assert.equal(seen[0].headers.Authorization, 'Bearer tok');
  assert.equal(seen[2].headers['Mcp-Session-Id'], 'sess-1', 'the session id goes back on each call');
  assert.equal(readMessage('data: {"jsonrpc":"2.0","id":3,"result":{}}\n\n', 'text/event-stream', 3).id, 3);
  assert.equal(readMessage('{"jsonrpc":"2.0","id":4,"error":{"message":"no"}}', 'application/json', 4).error.message, 'no');
  assert.deepEqual(resultOf({ structuredContent: { a: 1 }, isError: true }), { text: '{"a":1}', isError: true });
  assert.equal(toolOf({ name: 'x', annotations: { destructiveHint: true } }).destructive, true);
  const refused = new McpSession('tok', 'https://mcp.test/ads', (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch);
  await assert.rejects(refused.tools(), /ads_mcp_management/);
});
