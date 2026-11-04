// Linked accounts (Pilot AI › Comptes): a boutique links a Facebook or TikTok account with one login in a new tab; the
// tab comes back to the server, which keeps the token (never shown), finds the Pages and ad accounts, subscribes the
// Pages, and writes what the boutique uses where its agents read it. One boutique: used at once; all the owner's
// boutiques: each picks its Page (a Page answers for one boutique only), and Meta's webhook sends each Page to its shop.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { loadShop, passwordFromLink } from '../platform';
import { resetSocialDemo, routeMeta } from '../modules/social';
import { finishLogin, loginPage, runSocial } from '../social-server';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const SELLER = 'karim@bebe.dz';
const PW = 'Vendeur-Password-1';
const URL0 = 'https://pilotix.test';
let t: Tenancy;
let pctx: PCtx;
let a: Ctx;
let b: Ctx;
const p = <T = any>(name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<T>;
const hooks: ServerHooks = { courier: async () => ({}), meta: async () => ({}), social: (action, args, ctx) => runSocial(action, args, ctx), hashPassword: async (x) => x, publicUrl: URL0 };

async function as(shopId: number): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, SELLER, PW), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t, server: hooks };
}
async function store(name: string, email: string) {
  const biz = (await p('p.plans.list')).find((x: any) => x.code === 'business');
  const made = await p('p.shops.create', { name, ownerName: 'Karim', ownerEmail: email, planId: biz.id, trialDays: 14 });
  if (made.mail?.token) await passwordFromLink(t, made.mail.token, PW);
  return made.id as number;
}
const setting = async (ctx: Ctx, key: string) => (await ctx.db.query('SELECT value FROM settings WHERE key = $1', [key]))[0]?.value ?? null;

// ---------------------------------------------------------------- Facebook and TikTok, answered here
const calls: { url: string; method: string; body: string }[] = [];
let graph: { me: any; pages: any[]; ads: any[] } = { me: {}, pages: [], ads: [] };
let tiktok: { token: string; ids: string[]; list: any[]; user: any } = { token: '', ids: [], list: [], user: {} };
// a configuration « System-user access token »: Facebook will not turn its token into another one
let refuseSwap = false;
// what « Tester » finds on Facebook's side
const ALL_PERMS = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_engagement', 'pages_read_user_content', 'instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments', 'ads_read'];
let probe: { perms: string[]; pageSubs: any[]; appSubs: any[]; unreadable: string[]; cloudflare: boolean; refuse: boolean; inbox?: string | null } = { perms: ALL_PERMS, pageSubs: [], appSubs: [], unreadable: [], cloudflare: false, refuse: false };
const realFetch = globalThis.fetch;
const answer = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  pctx = { t, staff, now: () => Date.now(), publicUrl: URL0 };
  a = await as(await store('Bébé Confort', SELLER));
  b = await as(await store('Bébé Oran', SELLER));
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET');
    calls.push({ url, method, body: String(init?.body ?? '') });
    const u = new URL(url);
    if (u.host === 'graph.facebook.com') {
      const path = u.pathname.replace(/^\/v[\d.]+\//, '');
      if (path === 'oauth/access_token' && u.searchParams.get('grant_type') === 'fb_exchange_token' && refuseSwap)
        return new Response(JSON.stringify({ error: { message: 'Unsupported token type', code: 100 } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (path === 'oauth/access_token') return answer(u.searchParams.get('grant_type') === 'fb_exchange_token' ? { access_token: 'LONG_USER_TOKEN', expires_in: 5_184_000 } : { access_token: 'SHORT_USER_TOKEN' });
      if (path === 'me' && probe.refuse) return new Response(JSON.stringify({ error: { message: 'Error validating access token', code: 190 } }), { status: 400 });
      if (path === 'me') return answer(graph.me);
      // Publicité: each ad account's ad sets, ads and days (one that cannot be read answers an error)
      const ins = path.match(/^(act_\d+)\/(insights|adsets|ads)$/);
      if (ins) {
        if (probe.unreadable.includes(ins[1])) return new Response(JSON.stringify({ error: { message: 'Pas d’accès', code: 200 } }), { status: 400 });
        const n = ins[1].slice(4);
        if (ins[2] === 'adsets') return answer({ data: [{ id: `S${n}`, name: `Set ${n}`, effective_status: 'ACTIVE', campaign: { name: 'C' } }] });
        if (ins[2] === 'ads') return answer({ data: [{ id: `A${n}`, adset_id: `S${n}`, name: `Ad ${n}`, effective_status: 'ACTIVE', creative: {} }] });
        return answer({ data: [{ date_start: '2026-11-01', adset_id: `S${n}`, ad_id: `A${n}`, spend: '2.00', impressions: '100', actions: [] }] });
      }
      if (path === 'me/accounts') return answer({ data: graph.pages });
      if (path === 'me/adaccounts') return answer({ data: graph.ads });
      // « Tester »: what the account was allowed, the Page's subscription, Pilotix's app webhook, a Page, an ad account
      if (path === 'me/permissions') return answer({ data: probe.perms.map((permission) => ({ permission, status: 'granted' })) });
      if (/\/subscribed_apps$/.test(path)) return method === 'GET' ? answer({ data: probe.pageSubs }) : answer({ success: true });
      if (path === `${APPS.meta.appId}/subscriptions`) return answer({ data: probe.appSubs });
      // a Page's Instagram inbox (Meta can refuse it, and says why)
      if (/^\d+\/conversations$/.test(path)) return probe.inbox ? new Response(JSON.stringify({ error: { message: probe.inbox, code: 3 } }), { status: 400 }) : answer({ data: [] });
      if (/^act_\d+$/.test(path)) return probe.unreadable.includes(path) ? new Response(JSON.stringify({ error: { message: 'Pas d’accès', code: 200 } }), { status: 400 }) : answer({ id: path });
      if (/^\d+$/.test(path)) return answer({ id: path, name: 'Page', username: 'bebeconfort.dz' });
    }
    // the webhook's own address, called as Meta does: it answers the challenge (or Cloudflare stops it)
    if (u.host === 'pilotix.test' && u.pathname === '/api/hooks/meta-app')
      return probe.cloudflare ? new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge' } }) : new Response(String(u.searchParams.get('hub.challenge')), { status: 200 });
    if (u.host === 'business-api.tiktok.com') {
      if (u.pathname.endsWith('/oauth2/access_token/')) return answer({ code: 0, data: { access_token: tiktok.token, advertiser_ids: tiktok.ids } });
      if (u.pathname.endsWith('/oauth2/advertiser/get/')) return answer({ code: 0, data: { list: tiktok.list } });
      if (u.pathname.endsWith('/user/info/')) return answer({ code: 0, data: tiktok.user });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

const APPS = { meta: { appId: '1234567890', configId: '', secret: 'meta-app-secret-123' }, tiktok: { appId: '7400000000', secret: 'tiktok-secret-456' } };

test('Pilotix puts in its Meta and TikTok apps: their secrets are kept but never shown; the boutiques can link', async () => {
  const before = await call('social.list', a, {});
  assert.deepEqual(before.apps, { meta: false, tiktok: false });
  await assert.rejects(() => call('social.start', a, { provider: 'meta' }), /pas encore prête/);
  const r: any = await p('p.social.apps.save', APPS);
  assert.equal(r.meta.hasSecret, true);
  assert.equal(r.tiktok.hasSecret, true);
  assert.deepEqual(r.ready, { meta: true, tiktok: true });
  assert.ok(r.verifyToken.length > 20, 'a verify token for the webhook');
  assert.deepEqual(r.urls, { metaRedirect: `${URL0}/api/oauth/meta/callback`, tiktokRedirect: `${URL0}/api/oauth/tiktok/callback`, metaWebhook: `${URL0}/api/hooks/meta-app` });
  assert.ok(!JSON.stringify(r).includes('meta-app-secret-123') && !JSON.stringify(r).includes('tiktok-secret-456'), 'no secret goes back');
  // '' keeps a secret
  const kept: any = await p('p.social.apps.save', { meta: { ...APPS.meta, secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });
  assert.deepEqual(kept.ready, { meta: true, tiktok: true });
  const now = await call('social.list', a, {});
  assert.deepEqual(now.apps, { meta: true, tiktok: true });
  assert.equal(now.canAll, true, 'the owner of two boutiques may link for both');
  assert.deepEqual(now.sisters.map((s: any) => s.name), ['Bébé Confort', 'Bébé Oran']);
});

test('one boutique: the login tab comes back, the account is kept, its first Page (with Instagram) and ad account work there at once', async () => {
  const s: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
  const u = new URL(s.url);
  assert.equal(u.origin + u.pathname, 'https://www.facebook.com/v25.0/dialog/oauth');
  assert.equal(u.searchParams.get('client_id'), APPS.meta.appId);
  assert.equal(u.searchParams.get('redirect_uri'), `${URL0}/api/oauth/meta/callback`);
  assert.equal(u.searchParams.get('state'), s.state);
  assert.match(String(u.searchParams.get('scope')), /pages_messaging.*instagram_manage_messages.*ads_read/);
  assert.equal((await call('social.state', a, { state: s.state })).status, 'waiting');

  graph = {
    me: { id: '5001', name: 'Karim Benali', picture: { data: { url: 'https://fb.test/k.jpg' } } },
    pages: [
      { id: '9001', name: 'Bébé Confort Promo', access_token: 'PAGE_TOKEN_1' },
      { id: '9002', name: 'Bébé Confort DZ', access_token: 'PAGE_TOKEN_2', instagram_business_account: { id: '178002', username: 'bebeconfort.dz' } },
    ],
    ads: [{ id: 'act_3003', account_id: '3003', name: 'Bébé pub', currency: 'USD', account_status: 1 }],
  };
  calls.length = 0;
  const end = await finishLogin(t, 'meta', { code: 'THE_CODE', state: s.state }, URL0);
  assert.deepEqual(end, { ok: true, message: 'Compte lié', account: 'Karim Benali' });
  assert.match(loginPage(end), /Karim Benali.*fermer cet onglet/s);
  // each Page is subscribed to Pilotix's webhook with its own token
  const subs = calls.filter((c) => /subscribed_apps/.test(c.url));
  assert.equal(subs.length, 2);
  assert.ok(subs.every((c) => c.method === 'POST' && /subscribed_fields=messages/.test(c.body)));
  assert.equal((await call('social.state', a, { state: s.state })).status, 'done');

  const list: any = await call('social.list', a, {});
  assert.equal(list.links.length, 1);
  const l = list.links[0];
  assert.deepEqual([l.provider, l.name, l.scope, l.status], ['meta', 'Karim Benali', 'here', 'ok']);
  assert.deepEqual(l.assets.map((x: any) => [x.kind, x.name, x.usedHere]), [
    ['ad_account', 'Bébé pub', true],
    ['page', 'Bébé Confort DZ', true],
    ['page', 'Bébé Confort Promo', false],
  ]);
  assert.deepEqual(list.here.page, { name: 'Bébé Confort DZ', igUsername: 'bebeconfort.dz', account: 'Karim Benali' });
  assert.ok(!/TOKEN/.test(JSON.stringify(list)), 'no token reaches the page');
  // where the agents read it: the Page, its token, its Instagram account; the ad account and the account's token
  assert.equal(await setting(a, 'secret_dellal_page_token'), 'PAGE_TOKEN_2');
  const d = await setting(a, 'dellal');
  assert.deepEqual([d.messengerPageId, d.instagramId], ['9002', '178002']);
  assert.deepEqual([(await setting(a, 'meta')).adAccountId, await setting(a, 'secret_meta_token')], ['3003', 'LONG_USER_TOKEN']);
  assert.deepEqual((await setting(a, 'meta')).adAccountIds, ['3003']);
  const ds: any = await call('dellal.settings.get', a, {});
  assert.deepEqual(ds.page, { pageId: '9002', name: 'Bébé Confort DZ', igId: '178002', igUsername: 'bebeconfort.dz', account: 'Karim Benali' });
  // a state serves once
  assert.equal((await finishLogin(t, 'meta', { code: 'AGAIN', state: s.state }, URL0)).ok, false);
});

test('the Page is chosen by the boutique; a Page cannot be pasted by hand any more', async () => {
  const list: any = await call('social.list', a, {});
  const promo = list.links[0].assets.find((x: any) => x.name === 'Bébé Confort Promo');
  const r: any = await call('social.use', a, { assetId: promo.id });
  assert.equal(r.here.page.name, 'Bébé Confort Promo');
  assert.equal(await setting(a, 'secret_dellal_page_token'), 'PAGE_TOKEN_1');
  assert.equal((await setting(a, 'dellal')).instagramId, '', 'this Page has no Instagram account');
  // the Message AI agent's settings no longer take a Page token or Page ids
  const cur: any = await call('dellal.settings.get', a, {});
  await call('dellal.settings.save', a, { ...cur.settings, messengerPageId: '1111', instagramId: '2222', secrets: {} });
  assert.equal((await setting(a, 'dellal')).messengerPageId, '9001');
  await assert.rejects(() => call('dellal.settings.save', a, { ...cur.settings, secrets: { pageToken: 'EAAG-pasted' } }));
  // another boutique cannot take a Page linked to this one
  await assert.rejects(() => call('social.use', b, { assetId: promo.id }), /pas lié à cette boutique/);
  await call('social.use', a, { assetId: list.links[0].assets.find((x: any) => x.name === 'Bébé Confort DZ').id });
});

test('all boutiques: each picks its Page in one click, a Page answers for one boutique only, the webhook sends each Page to its boutique', async () => {
  const s: any = await call('social.start', a, { provider: 'meta', scope: 'all' });
  graph = {
    me: { id: '5002', name: 'Sara Benali' },
    pages: [
      { id: '9101', name: 'Bébé Oran', access_token: 'PAGE_TOKEN_3', instagram_business_account: { id: '178101', username: 'bebe.oran' } },
      { id: '9102', name: 'Bébé Annaba', access_token: 'PAGE_TOKEN_4' },
    ],
    ads: [],
  };
  assert.equal((await finishLogin(t, 'meta', { code: 'C2', state: s.state }, URL0)).ok, true);
  const la: any = await call('social.list', a, {});
  const shared = la.links.find((l: any) => l.scope === 'all');
  assert.ok(shared.assets.every((x: any) => !x.usedHere && !x.usedBy.length), 'nothing used before a boutique picks');
  const oran = shared.assets.find((x: any) => x.name === 'Bébé Oran');
  const lb: any = await call('social.use', b, { assetId: oran.id });
  assert.equal(lb.here.page.name, 'Bébé Oran');
  assert.equal(lb.links.length, 1, 'boutique B sees the shared account only, not A’s own');
  await assert.rejects(() => call('social.use', a, { assetId: oran.id }), /répond déjà pour « Bébé Oran »/);
  const again: any = await call('social.list', a, {});
  assert.deepEqual(again.links.find((l: any) => l.scope === 'all').assets.find((x: any) => x.id === oran.id).usedBy, [{ id: b.shop!.id, name: 'Bébé Oran' }]);
  assert.equal(await setting(b, 'secret_dellal_page_token'), 'PAGE_TOKEN_3');

  // Meta's one webhook: each Page's entries to the boutique that uses it; Instagram by its account; others dropped
  const routes = await routeMeta(t, { object: 'page', entry: [{ id: '9002', messaging: [] }, { id: '9101', messaging: [] }, { id: '9999', messaging: [] }, { id: '9101', changes: [] }] });
  assert.deepEqual(
    routes.map((r) => [r.shopId, r.body.entry.length]).sort(),
    [
      [a.shop!.id, 1],
      [b.shop!.id, 2],
    ].sort(),
  );
  assert.deepEqual((await routeMeta(t, { object: 'instagram', entry: [{ id: '178101' }] })).map((r) => r.shopId), [b.shop!.id]);
  assert.deepEqual(await routeMeta(t, { object: 'whatsapp_business_account', entry: [{ id: '9002' }] }), []);
});

test('only the owner links for all boutiques or removes a shared account', async () => {
  const other: Ctx = { ...a, session: { ...a.session, profile: { ...a.session.profile, email: 'agent@bebe.dz' } } };
  const v: any = await call('social.list', other, {});
  assert.equal(v.canAll, false);
  await assert.rejects(() => call('social.start', other, { provider: 'meta', scope: 'all' }), /propriétaire/);
  const shared = v.links.find((l: any) => l.scope === 'all');
  await assert.rejects(() => call('social.remove', other, { linkId: shared.id }), /propriétaire/);
});

test('linked again: the new tokens reach the boutiques, a Page no longer shared stops; removed: every boutique stops', async () => {
  const s: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
  graph = {
    me: { id: '5001', name: 'Karim Benali' },
    pages: [{ id: '9002', name: 'Bébé Confort DZ', access_token: 'PAGE_TOKEN_2_NEW', instagram_business_account: { id: '178002', username: 'bebeconfort.dz' } }],
    ads: [{ id: 'act_3003', account_id: '3003', name: 'Bébé pub', currency: 'USD' }],
  };
  const before: any = await call('social.list', a, {});
  await finishLogin(t, 'meta', { code: 'C3', state: s.state }, URL0);
  const now: any = await call('social.list', a, {});
  assert.equal(now.links.length, before.links.length, 'the same account, the same row');
  assert.deepEqual(now.links.find((l: any) => l.name === 'Karim Benali').assets.map((x: any) => x.name), ['Bébé pub', 'Bébé Confort DZ']);
  assert.equal(await setting(a, 'secret_dellal_page_token'), 'PAGE_TOKEN_2_NEW');

  // the shared account goes: boutique B loses its Page
  const shared = now.links.find((l: any) => l.scope === 'all');
  await call('social.remove', a, { linkId: shared.id });
  assert.equal(await setting(b, 'secret_dellal_page_token'), null);
  assert.equal((await setting(b, 'dellal')).messengerPageId, '');
  assert.equal(await setting(b, 'social_page'), null);
  // boutique A stops using its ad account
  const r: any = await call('social.unuse', a, { kind: 'ad_account' });
  assert.equal(r.here.ad_account, null);
  assert.deepEqual([(await setting(a, 'meta')).adAccountId, await setting(a, 'secret_meta_token')], ['', null]);
});

test('linked again with Instagram: a Page first seen without its Instagram gets it, and Instagram’s messages find the boutique', async () => {
  const login = async (ig: boolean) => {
    const s: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
    graph = {
      me: { id: '5001', name: 'Karim Benali' },
      pages: [{ id: '9002', name: 'Bébé Confort DZ', access_token: 'PAGE_TOKEN_2', ...(ig ? { instagram_business_account: { id: '178002', username: 'bebeconfort.dz' } } : {}) }],
      ads: [],
    };
    assert.equal((await finishLogin(t, 'meta', { code: ig ? 'IG1' : 'IG0', state: s.state }, URL0)).ok, true);
  };
  // without Instagram's permissions Facebook does not show the Page's Instagram: its messages find no boutique
  await login(false);
  assert.deepEqual(await routeMeta(t, { object: 'instagram', entry: [{ id: '178002' }] }), []);
  // a new login with them: boutique A gets its Instagram's messages, without taking the Page again
  await login(true);
  assert.deepEqual((await routeMeta(t, { object: 'instagram', entry: [{ id: '178002' }] })).map((x) => x.shopId), [a.shop!.id]);
});

test('a login cancelled, too old, or from another place: nothing is linked', async () => {
  const s: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
  const no = await finishLogin(t, 'meta', { state: s.state, error: 'access_denied', error_reason: 'user_denied' }, URL0);
  assert.deepEqual(no, { ok: false, message: 'Connexion annulée. Fermez cet onglet.' });
  assert.deepEqual(await call('social.state', a, { state: s.state }), { status: 'error', error: 'Connexion annulée.', linkId: null });
  const old: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
  await t.platform.query(`UPDATE platform.social_states SET expires_at = now() - interval '1 minute' WHERE state = $1`, [old.state]);
  assert.equal((await finishLogin(t, 'meta', { code: 'X', state: old.state }, URL0)).ok, false);
  assert.equal((await finishLogin(t, 'meta', { code: 'X', state: 'not-a-real-state-123' }, URL0)).ok, false);
  // TikTok's state is not Facebook's
  const tt: any = await call('social.start', a, { provider: 'tiktok', scope: 'here' });
  assert.equal((await finishLogin(t, 'meta', { code: 'X', state: tt.state }, URL0)).ok, false);
  // another boutique does not see this boutique's login
  await assert.rejects(() => call('social.state', b, { state: tt.state }), /introuvable/);
});

test('TikTok for Business: the advertiser’s token and its ad accounts; linked to one boutique, its first ad account is used', async () => {
  const s: any = await call('social.start', a, { provider: 'tiktok', scope: 'here' });
  const u = new URL(s.url);
  assert.equal(u.origin + u.pathname, 'https://business-api.tiktok.com/portal/auth');
  assert.deepEqual([u.searchParams.get('app_id'), u.searchParams.get('redirect_uri')], [APPS.tiktok.appId, `${URL0}/api/oauth/tiktok/callback`]);
  tiktok = { token: 'TT_ADV_TOKEN', ids: ['7001', '7002'], list: [{ advertiser_id: '7001', advertiser_name: 'Bébé TikTok' }, { advertiser_id: '7002', advertiser_name: 'Bébé TikTok 2' }], user: { core_user_id: 'u77', display_name: 'Karim Ads' } };
  calls.length = 0;
  const end = await finishLogin(t, 'tiktok', { auth_code: 'TT_CODE', state: s.state }, URL0);
  assert.equal(end.ok, true);
  const tok = calls.find((c) => c.url.endsWith('/oauth2/access_token/'))!;
  assert.deepEqual(JSON.parse(tok.body), { app_id: APPS.tiktok.appId, secret: APPS.tiktok.secret, auth_code: 'TT_CODE' });
  const list: any = await call('social.list', a, {});
  const l = list.links.find((x: any) => x.provider === 'tiktok');
  // its ad accounts are counted together
  assert.deepEqual([l.name, l.assets.map((x: any) => [x.name, x.usedHere])], ['Karim Ads', [['Bébé TikTok', true], ['Bébé TikTok 2', true]]]);
  assert.deepEqual(list.here.advertiser, { name: 'Bébé TikTok', account: 'Karim Ads', count: 2 });
  assert.equal(await setting(a, 'secret_tiktok_ads_token'), 'TT_ADV_TOKEN');
  assert.deepEqual((await setting(a, 'social_tiktok_ads')).advertisers.map((x: any) => x.advertiserId), ['7001', '7002']);
  const apps: any = await p('p.social.apps');
  assert.deepEqual(apps.counts, { meta: 1, tiktok: 1, shops: 1 });
});

test('the preview: a sample account, and a « login » that links a new one after two seconds', async () => {
  resetSocialDemo();
  let now = Date.parse('2026-11-03T16:00:00Z');
  const demo: Ctx = { ...a, t: undefined, server: undefined, now: () => now };
  const first: any = await call('social.list', demo, {});
  assert.equal(first.preview, true);
  assert.equal(first.links[0].scope, 'all');
  assert.equal(first.here.page.name, 'Bébé Confort DZ');
  const s: any = await call('social.start', demo, { provider: 'tiktok', scope: 'here' });
  assert.equal(s.url, null);
  assert.equal((await call('social.state', demo, { state: s.state })).status, 'waiting');
  now += 2500;
  assert.equal((await call('social.state', demo, { state: s.state })).status, 'done');
  const after: any = await call('social.list', demo, {});
  assert.equal(after.links.length, 2);
  assert.equal(after.here.advertiser.name, 'Bébé Confort TikTok');
  // a page used by the other sample boutique
  const oran = after.links[0].assets.find((x: any) => x.name === 'Bébé Confort Oran');
  await assert.rejects(() => call('social.use', demo, { assetId: oran.id }), /répond déjà/);
});

test('a Facebook Login for Business configuration: a person’s short token is turned into a long one too; a « system user » token Facebook will not turn is kept, without an end', async () => {
  await p('p.social.apps.save', { meta: { ...APPS.meta, configId: '777000111', secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });
  const kept = async (extId: string) => (await t.platform.query(`SELECT token, token_kind, expires_at FROM platform.social_links WHERE provider = 'meta' AND ext_id = $1`, [extId]))[0];
  // « User access token »: the login dialog uses the configuration, and the hour's token becomes one of about 60 days
  const s: any = await call('social.start', b, { provider: 'meta', scope: 'here' });
  const u = new URL(s.url);
  assert.equal(u.searchParams.get('config_id'), '777000111');
  assert.equal(u.searchParams.get('scope'), null, 'the configuration says what is asked');
  graph = { me: { id: '5099', name: 'Nadia Oran' }, pages: [{ id: '9901', name: 'Bébé Oran Promo', access_token: 'PAGE_TOKEN_9' }], ads: [] };
  calls.length = 0;
  assert.equal((await finishLogin(t, 'meta', { code: 'CFG_CODE', state: s.state }, URL0)).ok, true);
  assert.ok(calls.some((c) => /grant_type=fb_exchange_token/.test(c.url)), 'the short token is turned into a long one');
  const user = await kept('5099');
  assert.deepEqual([user.token, user.token_kind], ['LONG_USER_TOKEN', 'user']);
  const days = (Date.parse(user.expires_at) - Date.now()) / 86_400_000;
  assert.ok(days > 59 && days < 61, 'about 60 days');
  // « System-user access token »: Facebook refuses to turn it; it is kept as it came, with no end date
  refuseSwap = true;
  try {
    const s2: any = await call('social.start', b, { provider: 'meta', scope: 'here' });
    graph = { me: { id: '5100', name: 'Pilotix (système)' }, pages: [{ id: '9902', name: 'Bébé Oran Pro', access_token: 'PAGE_TOKEN_10' }], ads: [] };
    assert.equal((await finishLogin(t, 'meta', { code: 'SYS_CODE', state: s2.state }, URL0)).ok, true);
    const sys = await kept('5100');
    assert.deepEqual([sys.token, sys.token_kind, sys.expires_at], ['SHORT_USER_TOKEN', 'system', null]);
    // without a configuration, a token Facebook will not turn is an error: nothing half-linked
    await p('p.social.apps.save', { meta: { ...APPS.meta, secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });
    const s3: any = await call('social.start', b, { provider: 'meta', scope: 'here' });
    const end3 = await finishLogin(t, 'meta', { code: 'NO_CFG', state: s3.state }, URL0);
    assert.equal(end3.ok, false);
  } finally {
    refuseSwap = false;
  }
});

test('several ad accounts: a boutique counts them all, Publicité reads each one; a new login keeps the others; one switch stops and starts them', async () => {
  const login = async (ads: any[]) => {
    const s: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
    graph = { me: { id: '5001', name: 'Karim Benali' }, pages: [{ id: '9002', name: 'Bébé Confort DZ', access_token: 'PAGE_TOKEN_2', instagram_business_account: { id: '178002', username: 'bebeconfort.dz' } }], ads };
    assert.equal((await finishLogin(t, 'meta', { code: `C${ads.length}`, state: s.state }, URL0)).ok, true);
  };
  const act = (id: string, name: string, currency = 'USD') => ({ id: `act_${id}`, account_id: id, name, currency, account_status: 1 });
  await login([act('3003', 'Bébé pub'), act('3004', 'Bébé pub 2'), act('3005', 'Promo')]);
  const karim = (l: any) => l.links.find((x: any) => x.name === 'Karim Benali');
  let list: any = await call('social.list', a, {});
  assert.deepEqual(
    karim(list).assets.filter((x: any) => x.kind === 'ad_account').map((x: any) => [x.name, x.usedHere]),
    [
      ['Bébé pub', true],
      ['Bébé pub 2', true],
      ['Promo', true],
    ],
  );
  assert.deepEqual(list.here.ad_account, { name: 'Bébé pub', account: 'Karim Benali', count: 3 });
  assert.deepEqual((await setting(a, 'meta')).adAccountIds, ['3003', '3004', '3005']);
  assert.equal((await setting(a, 'social_ads')).accounts.length, 3);
  // a boutique set up before (one ad account written): opening Pilot AI › Comptes writes them all again
  await a.db.query(`UPDATE settings SET value = $1 WHERE key = 'meta'`, [JSON.stringify({ adAccountId: '3003', hasToken: true })]);
  await call('social.list', a, {});
  assert.deepEqual((await setting(a, 'meta')).adAccountIds, ['3003', '3004', '3005']);
  // Publicité reads every ad account and joins them; one that cannot be read is left out
  const { runMeta } = await import('../meta');
  probe.unreadable = ['act_3005'];
  const ins: any = await runMeta('insights', { from: '2026-11-01', to: '2026-11-02' }, a);
  assert.deepEqual(ins.adsets.map((x: any) => x.id), ['S3003', 'S3004']);
  assert.equal(ins.adsetDays.length, 2);
  probe.unreadable = ['act_3003', 'act_3004', 'act_3005'];
  await assert.rejects(() => runMeta('insights', { from: '2026-11-01', to: '2026-11-02' }, a), /Pas d’accès/);
  probe.unreadable = [];
  // the switch: off, then on again
  list = await call('social.ads', a, { linkId: karim(list).id, on: false });
  assert.equal(list.here.ad_account, null);
  assert.deepEqual([(await setting(a, 'meta')).adAccountIds, (await setting(a, 'meta')).hasToken], [[], false]);
  list = await call('social.ads', a, { linkId: karim(list).id, on: true });
  assert.equal(list.here.ad_account.count, 3);
  // a new login without the first ad account: the boutique keeps counting the two others
  await login([act('3004', 'Bébé pub 2'), act('3005', 'Promo')]);
  assert.deepEqual((await setting(a, 'meta')).adAccountIds, ['3004', '3005']);
  assert.equal(((await call('social.list', a, {})) as any).here.ad_account.count, 2);
  // and without any: it stops
  await login([]);
  assert.equal(((await call('social.list', a, {})) as any).here.ad_account, null);
  assert.equal((await setting(a, 'meta')).adAccountId, '');
  await login([act('3004', 'Bébé pub 2')]);
});

test('« Tester »: the key, the permissions, the Page (subscribed again), Instagram, the app webhook, the address from the Internet, the ad accounts', async () => {
  const list: any = await call('social.list', a, {});
  const karim = list.links.find((x: any) => x.name === 'Karim Benali');
  assert.equal(list.here.page.name, 'Bébé Confort DZ');
  probe = {
    perms: ALL_PERMS.filter((x) => x !== 'instagram_manage_comments'),
    // the Page lost its subscription: the test subscribes it again
    pageSubs: [],
    // the app sends the Pages' messages and comments, not Instagram's yet
    appSubs: [{ object: 'page', callback_url: `${URL0}/api/hooks/meta-app`, active: true, fields: [{ name: 'messages' }, { name: 'feed' }] }],
    unreadable: [],
    cloudflare: false,
    refuse: false,
  };
  calls.length = 0;
  const r: any = await call('social.test', a, { linkId: karim.id });
  const st = Object.fromEntries(r.checks.map((c: any) => [c.key, c.state]));
  assert.deepEqual(st, { token: 'ok', perms: 'warn', page: 'ok', pageHook: 'ok', ig: 'ok', fbComment: 'warn', igInbox: 'ok', igSeen: 'warn', igComment: 'warn', catchUp: 'warn', appHook: 'ok', appHookIg: 'warn', reach: 'ok', ads: 'ok' });
  assert.equal(r.checks.find((c: any) => c.key === 'perms').params.list, 'instagram_manage_comments');
  assert.equal(r.checks.find((c: any) => c.key === 'pageHook').params.fixed, 1);
  assert.ok(calls.some((c) => /9002\/subscribed_apps/.test(c.url) && c.method === 'POST'), 'subscribed again');
  assert.equal(r.checks.find((c: any) => c.key === 'appHookIg').params.list, 'messages, comments');
  assert.ok(!/PAGE_TOKEN|LONG_USER_TOKEN|SHORT_USER_TOKEN|meta-app-secret/.test(JSON.stringify(r)), 'no token or secret reaches the page');
  // Cloudflare stops the webhook's address
  probe.cloudflare = true;
  const cf: any = await call('social.test', a, { linkId: karim.id });
  assert.deepEqual(cf.checks.find((c: any) => c.key === 'reach'), { key: 'reach', state: 'bad', params: { why: 'cloudflare' }, detail: null });
  probe.cloudflare = false;
  // a key Facebook refuses turns the account red; working again, green
  probe.refuse = true;
  const bad: any = await call('social.test', a, { linkId: karim.id });
  assert.equal(bad.checks[0].state, 'bad');
  assert.equal(((await call('social.list', a, {})) as any).links.find((x: any) => x.id === karim.id).status, 'error');
  probe.refuse = false;
  await call('social.test', a, { linkId: karim.id });
  assert.equal(((await call('social.list', a, {})) as any).links.find((x: any) => x.id === karim.id).status, 'ok');
  // ad accounts in dinars: Publicité counts them in dinars (fine); in another money: as dollars (to look at)
  const money = (c: string) =>
    t.platform.query(`UPDATE platform.social_assets SET extra = jsonb_set(extra, '{currency}', to_jsonb($1::text)) WHERE link_id = $2 AND kind = 'ad_account'`, [c, karim.id]);
  const currencyLine = async () => ((await call('social.test', a, { linkId: karim.id })) as any).checks.find((c: any) => c.key === 'adsCurrency');
  await money('DZD');
  assert.deepEqual(await currencyLine(), { key: 'adsCurrency', state: 'ok', detail: null });
  await money('EUR');
  assert.deepEqual(await currencyLine(), { key: 'adsCurrency', state: 'warn', params: { list: 'EUR' }, detail: null });
  await money('USD');
  assert.equal(await currencyLine(), undefined);
  // Instagram: Meta refuses its inbox and says why; when Pilotix last got something from it, or never
  const line = async (key: string) => ((await call('social.test', a, { linkId: karim.id })) as any).checks.find((c: any) => c.key === key);
  probe.inbox = '(#3) Application does not have the capability to make this API call.';
  const inbox = await line('igInbox');
  assert.deepEqual([inbox.state, inbox.params.username], ['bad', 'bebeconfort.dz']);
  assert.match(inbox.detail, /does not have the capability/);
  probe.inbox = null;
  const seen = async () => {
    const c = await line('igSeen');
    return [c.state, c.params.why ?? (c.params.lost ? 'lost' : null), typeof c.params.at];
  };
  const msg = (u: string) => ({ sender: { id: u }, recipient: { id: '178002' }, message: { mid: `m-${u}`, text: 'salam' } });
  // nothing from Instagram yet; then only a message for an Instagram account no boutique uses
  await t.platform.query(`DELETE FROM platform.social_hooks WHERE object = 'instagram'`);
  assert.deepEqual(await seen(), ['warn', null, 'undefined']);
  await routeMeta(t, { object: 'instagram', entry: [{ id: '178999', messaging: [msg('u0')] }] });
  assert.deepEqual(await seen(), ['warn', 'unknown', 'string']);
  // only « standby »: another app has Instagram's conversations
  await routeMeta(t, { object: 'instagram', entry: [{ id: '178002', standby: [msg('u1')] }] });
  assert.deepEqual(await seen(), ['warn', 'standby', 'string']);
  // a read is not a customer's message
  await routeMeta(t, { object: 'instagram', entry: [{ id: '178002', messaging: [{ sender: { id: 'u1' }, recipient: { id: '178002' }, read: { mid: 'm-0' } }] }] });
  assert.deepEqual(await seen(), ['warn', 'other', 'string']);
  // a customer's message: Pilotix writes it down, the boutique takes it; a read after it keeps it
  await routeMeta(t, { object: 'instagram', entry: [{ id: '178002', messaging: [msg('u1')] }] });
  assert.deepEqual(await seen(), ['ok', null, 'string']);
  await routeMeta(t, { object: 'instagram', entry: [{ id: '178002', messaging: [{ sender: { id: 'u1' }, recipient: { id: '178002' }, read: { mid: 'm-u1' } }] }] });
  assert.deepEqual(await seen(), ['ok', null, 'string']);
  // taken by no boutique
  await t.platform.query(`UPDATE platform.social_hooks SET routed = false WHERE object = 'instagram' AND ext_id = '178002'`);
  assert.deepEqual(await seen(), ['warn', 'lost', 'string']);
  // comments: a customer's on the Page's post, then on Instagram; the account's own replies do not count
  const state = async (key: string) => {
    const c = await line(key);
    return [c.state, typeof c.params.at];
  };
  const fb = (from: string) => ({ object: 'page', entry: [{ id: '9002', changes: [{ field: 'feed', value: { item: 'comment', verb: 'add', from: { id: from }, comment_id: `c-${from}`, post_id: '9002_1', message: 'ch7al ?' } }] }] });
  assert.deepEqual(await state('fbComment'), ['warn', 'undefined']);
  await routeMeta(t, fb('9002'));
  assert.deepEqual(await state('fbComment'), ['warn', 'undefined'], 'the Page answering is not a customer');
  await routeMeta(t, fb('u-77'));
  assert.deepEqual(await state('fbComment'), ['ok', 'string']);
  assert.deepEqual(await state('igComment'), ['warn', 'undefined']);
  await routeMeta(t, { object: 'instagram', entry: [{ id: '178002', changes: [{ field: 'comments', value: { from: { id: 'ig-u-1', username: 'amina' }, media: { id: 'm1' }, id: 'igc1', text: 'prix ?' } }] }] });
  assert.deepEqual(await state('igComment'), ['ok', 'string']);
  // another boutique cannot test this boutique's account
  await assert.rejects(() => call('social.test', b, { linkId: karim.id }), /introuvable/);
});

test('the preview: « Tester » answers a sample, the ad accounts switch off and on', async () => {
  resetSocialDemo();
  const demo: Ctx = { ...a, t: undefined, server: undefined };
  const first: any = await call('social.list', demo, {});
  assert.deepEqual(first.here.ad_account, { name: 'Bébé Confort — publicité', account: 'Alaeddine Benali', count: 4 });
  assert.ok(first.links[0].assets.filter((x: any) => x.kind === 'page').length >= 10, 'many Pages: the boutique picks one');
  const r: any = await call('social.test', demo, { linkId: first.links[0].id });
  assert.equal(r.checks.find((c: any) => c.key === 'appHookIg').state, 'warn');
  assert.ok(r.checks.filter((c: any) => c.key !== 'appHookIg').every((c: any) => c.state === 'ok'));
  const off: any = await call('social.ads', demo, { linkId: first.links[0].id, on: false });
  assert.equal(off.here.ad_account, null);
  const on: any = await call('social.ads', demo, { linkId: first.links[0].id, on: true });
  assert.equal(on.here.ad_account.count, 4);
  resetSocialDemo();
});
