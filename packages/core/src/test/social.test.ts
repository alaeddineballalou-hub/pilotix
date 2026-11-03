// Linked accounts (Pilot AI › Comptes): a boutique links a Facebook or TikTok account with one login in a new tab; the
// tab comes back to the server, which keeps the token (never shown), finds the Pages and ad accounts, subscribes the
// Pages, and writes what the boutique uses where its agents read it. One boutique: used at once; all the owner's
// boutiques: each picks its Page (a Page answers for one boutique only), and Meta's webhook sends each Page to its shop.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { loadShop, passwordFromLink } from '../platform';
import { resetSocialDemo, routeMeta } from '../modules/social';
import { finishLogin, loginPage } from '../social-server';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const SELLER = 'karim@bebe.dz';
const PW = 'Vendeur-Password-1';
const URL0 = 'https://pilotix.test';
let t: Tenancy;
let pctx: PCtx;
let a: Ctx;
let b: Ctx;
const p = <T = any>(name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<T>;
const hooks: ServerHooks = { courier: async () => ({}), meta: async () => ({}), hashPassword: async (x) => x, publicUrl: URL0 };

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
      if (path === 'oauth/access_token') return answer(u.searchParams.get('grant_type') === 'fb_exchange_token' ? { access_token: 'LONG_USER_TOKEN', expires_in: 5_184_000 } : { access_token: 'SHORT_USER_TOKEN' });
      if (path === 'me') return answer(graph.me);
      if (path === 'me/accounts') return answer({ data: graph.pages });
      if (path === 'me/adaccounts') return answer({ data: graph.ads });
      if (/\/subscribed_apps$/.test(path)) return answer({ success: true });
    }
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
  assert.deepEqual([l.name, l.assets.map((x: any) => [x.name, x.usedHere])], ['Karim Ads', [['Bébé TikTok', true], ['Bébé TikTok 2', false]]]);
  assert.deepEqual(list.here.advertiser, { name: 'Bébé TikTok', account: 'Karim Ads' });
  assert.equal(await setting(a, 'secret_tiktok_ads_token'), 'TT_ADV_TOKEN');
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
