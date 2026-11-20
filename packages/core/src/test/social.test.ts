// Linked accounts (Pilot AI › Comptes): a boutique links a Facebook or TikTok account with one login in a new tab; the
// tab comes back to the server, which keeps the token (never shown), finds the Pages and ad accounts, subscribes the
// Pages, and writes what the boutique uses where its agents read it. One boutique: used at once; all the owner's
// boutiques: each picks its Page (a Page answers for one boutique only), and Meta's webhook sends each Page to its shop.
// That one Facebook login is the only way Meta is connected: Instagram's answers ride on its key, Publicité on its ad
// accounts; keys connected before somewhere else keep working until it replaces them, and « Tester » says, part by
// part, where a problem is.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { loadShop, passwordFromLink } from '../platform';
import { CHECK_GROUPS, noteBadSignature, noteIgLogin, resetSocialDemo, routeMeta, SOCIAL_PICKED_SQL } from '../modules/social';
import { setRaw } from '../modules/admin';
import { confirmLogin, deletionPage, finishLogin, finishWhatsappPopup, loginPage, metaDeletion, parseSignedRequest, runSocial, testMetaApp } from '../social-server';
import { createHmac } from 'node:crypto';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const SELLER = 'karim@bebe.dz';
const PW = 'Vendeur-Password-1';
const URL0 = 'https://pilotix.test';
/** The login tab comes back and the person says « Oui, c'est ma boutique » in it: the account linked (most tests). */
/** A login whose tab says yes, every ad account it shows ticked (unless `ads` says which ones). */
async function linked(t: Tenancy, provider: 'meta' | 'tiktok', q: Record<string, unknown>, url: string, ads?: string[]) {
  const end = await finishLogin(t, provider, q, url);
  return end.confirm ? confirmLogin(t, end.confirm.state, end.confirm.key, true, '', ads ?? (end.confirm.ads ?? []).map((x) => x.id)) : end;
}
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
// byId: Pages Facebook gives one by one (a business key whose own list is empty)
// business: each ad account's business portfolio (Meta gives it for several ad accounts in one call, ?ids=…)
let graph: { me: any; pages: any[]; ads: any[]; assigned?: any[]; byId?: Record<string, any>; business?: Record<string, any> } = { me: {}, pages: [], ads: [] };
// the key Facebook gives for a login's code (each door of Meta gets its own)
let codeToken = 'SHORT_USER_TOKEN';
let tiktok: { token: string; ids: string[]; list: any[]; user: any } = { token: '', ids: [], list: [], user: {} };
// a configuration « System-user access token »: Facebook will not turn its token into another one
let refuseSwap = false;
// « Connecter WhatsApp »: the WhatsApp Business account the key was given ('' : none), its numbers, its number's registration
let wa: { waba: string; numbers: any[]; registerFail: boolean } = { waba: '', numbers: [], registerFail: false };
// what « Tester » finds on Facebook's side
const ALL_PERMS = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement', 'pages_manage_engagement', 'pages_read_user_content', 'instagram_basic', 'instagram_manage_messages', 'instagram_manage_comments', 'ads_read'];
// scopes / granular / expiresAt: what Meta's debug_token says of the key (without scopes, « Tester » asks me/permissions);
// igReach: Meta's refusal when the account's own key asks an Instagram account's inbox (null: it reaches it);
// adStatus / tasks: an ad account's state at Meta and what the key may do there; catalog / pixelRefuse: the catalogue and pixels
let probe: {
  perms: string[];
  pageSubs: any[];
  appSubs: any[];
  unreadable: string[];
  cloudflare: boolean;
  refuse: boolean;
  inbox?: string | null;
  igRefuse?: boolean;
  igReach?: string | null;
  scopes?: string[];
  granular?: any[];
  expiresAt?: number;
  adStatus?: Record<string, number>;
  tasks?: string[];
  catalog?: { id: string; refuse?: boolean };
  pixelRefuse?: string[];
  formsRefuse?: boolean;
  // « Coller une clé Meta Ads »: what Meta says of a pasted key (alive or not, whose app, a person's or a system user's)
  keyValid?: boolean;
  // a key without the business permission: Meta refuses a business portfolio's picture
  bizPicRefuse?: boolean;
  keyApp?: string;
  keyType?: string;
} = { perms: ALL_PERMS, pageSubs: [], appSubs: [], unreadable: [], cloudflare: false, refuse: false };
const realFetch = globalThis.fetch;
const answer = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  pctx = { t, staff, now: () => Date.now(), publicUrl: URL0, metaAppTest: () => testMetaApp(t, URL0) };
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
      if (path === 'oauth/access_token') return answer(u.searchParams.get('grant_type') === 'fb_exchange_token' ? { access_token: 'LONG_USER_TOKEN', expires_in: 5_184_000 } : { access_token: codeToken });
      if (path === 'me' && probe.refuse) return new Response(JSON.stringify({ error: { message: 'Error validating access token', code: 190 } }), { status: 400 });
      if (path === 'me') return answer(graph.me);
      // « Connecter WhatsApp »: what the key was given (Embedded Signup), the account's numbers, a number's registration
      if (path === 'debug_token')
        return answer({
          data: {
            ...(probe.scopes ? { scopes: probe.scopes } : {}),
            ...(probe.expiresAt !== undefined ? { expires_at: probe.expiresAt } : {}),
            ...(probe.keyValid !== undefined ? { is_valid: probe.keyValid } : {}),
            ...(probe.keyApp ? { app_id: probe.keyApp } : {}),
            ...(probe.keyType ? { type: probe.keyType } : {}),
            granular_scopes: [
              ...(wa.waba ? [{ scope: 'whatsapp_business_management', target_ids: [wa.waba] }, { scope: 'whatsapp_business_messaging', target_ids: [wa.waba] }] : [{ scope: 'business_management' }]),
              ...(probe.granular ?? []),
            ],
          },
        });
      if (wa.waba && path === `${wa.waba}/phone_numbers`) return answer({ data: wa.numbers });
      if (/^\d+\/register$/.test(path))
        return wa.registerFail ? new Response(JSON.stringify({ error: { message: 'Two step verification PIN Mismatch', code: 133005 } }), { status: 400 }) : answer({ success: true });
      // Meta's Unified login: the Instagram accounts a key was given
      if (path === 'me/assigned_instagram_accounts') return answer({ data: [{ id: '178555', username: 'bebeconfort.dz' }] });
      // Publicité: each ad account's ad sets, ads and days (one that cannot be read answers an error)
      const ins = path.match(/^(act_\d+)\/(insights|adsets|ads)$/);
      if (ins) {
        if (probe.unreadable.includes(ins[1])) return new Response(JSON.stringify({ error: { message: 'Pas d’accès', code: 200 } }), { status: 400 });
        const n = ins[1].slice(4);
        if (ins[2] === 'adsets') return answer({ data: [{ id: `S${n}`, name: `Set ${n}`, effective_status: 'ACTIVE', campaign: { name: 'C' } }] });
        if (ins[2] === 'ads') return answer({ data: [{ id: `A${n}`, adset_id: `S${n}`, name: `Ad ${n}`, effective_status: 'ACTIVE', creative: {} }] });
        return answer({ data: [{ date_start: '2026-11-01', adset_id: `S${n}`, ad_id: `A${n}`, spend: '2.00', impressions: '100', actions: [] }] });
      }
      // several nodes in one call (?ids=…): the ad accounts' business portfolio (Meta may refuse its picture)
      if (path === '' && u.searchParams.get('ids')) {
        const fields = String(u.searchParams.get('fields') ?? '');
        const pic = /profile_picture_uri/.test(fields);
        if (pic && probe.bizPicRefuse) return new Response(JSON.stringify({ error: { message: '(#100) Missing Permission', code: 100 } }), { status: 400 });
        const one = (id: string) => {
          const biz = graph.business?.[id];
          return [id, { id, ...(biz ? { business: pic ? biz : { id: biz.id, name: biz.name } } : {}) }];
        };
        return answer(Object.fromEntries(String(u.searchParams.get('ids')).split(',').map(one)));
      }
      if (path === 'me/accounts') return answer({ data: graph.pages });
      if (path === 'me/adaccounts') return answer({ data: graph.ads });
      // a business key (« system user »): the ad accounts it was given
      if (path === 'me/assigned_ad_accounts') return answer({ data: graph.assigned ?? [] });
      // « Tester »: what the account was allowed, the Page's subscription, Pilotix's app webhook, a Page, an ad account
      if (path === 'me/permissions') return answer({ data: probe.perms.map((permission) => ({ permission, status: 'granted' })) });
      if (/\/subscribed_apps$/.test(path)) return method === 'GET' ? answer({ data: probe.pageSubs }) : answer({ success: true });
      if (path === `${APPS.meta.appId}/subscriptions`) return answer({ data: probe.appSubs });
      // an Instagram inbox: through the Page (9…), or asked of the Instagram account itself with the account's key (178…);
      // Meta can refuse either, and says why
      const inbox = path.match(/^(\d+)\/conversations$/);
      if (inbox) {
        const no = inbox[1].startsWith('178') ? probe.igReach : probe.inbox;
        return no ? new Response(JSON.stringify({ error: { message: no, code: 3 } }), { status: 400 }) : answer({ data: [] });
      }
      // the ads' forms of a Page
      if (/^\d+\/leadgen_forms$/.test(path)) return probe.formsRefuse ? new Response(JSON.stringify({ error: { message: '(#200) Requires leads_retrieval', code: 200 } }), { status: 400 }) : answer({ data: [] });
      if (/^act_\d+$/.test(path))
        return probe.unreadable.includes(path)
          ? new Response(JSON.stringify({ error: { message: 'Pas d’accès', code: 200 } }), { status: 400 })
          : answer({ id: path, name: `Compte ${path.slice(4)}`, account_status: probe.adStatus?.[path] ?? 1, ...(probe.tasks ? { user_tasks: probe.tasks } : {}) });
      // the boutique's catalogue, its pixels
      if (probe.catalog && path === probe.catalog.id)
        return probe.catalog.refuse ? new Response(JSON.stringify({ error: { message: '(#100) Missing permissions', code: 100 } }), { status: 400 }) : answer({ id: path, name: 'Catalogue Bébé', product_count: 36 });
      if (probe.pixelRefuse?.includes(path)) return new Response(JSON.stringify({ error: { message: '(#100) Unsupported get request', code: 100 } }), { status: 400 });
      if (graph.byId?.[path]) return answer(graph.byId[path]);
      if (/^\d+$/.test(path)) return answer({ id: path, name: 'Page', username: 'bebeconfort.dz' });
    }
    // Instagram's own login (graph.instagram.com): its key's account
    if (u.host === 'graph.instagram.com') {
      if (probe.igRefuse) return new Response(JSON.stringify({ error: { message: 'Invalid OAuth access token', code: 190 } }), { status: 400 });
      if (/\/me$/.test(u.pathname)) return answer({ user_id: '178555', username: 'bebeconfort.dz', id: '2601' });
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
  assert.deepEqual(r.urls, { metaRedirect: `${URL0}/api/oauth/meta/callback`, tiktokRedirect: `${URL0}/api/oauth/tiktok/callback`, metaWebhook: `${URL0}/api/hooks/meta-app`, metaDeletion: `${URL0}/api/hooks/meta-deletion` });
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
  const back = await finishLogin(t, 'meta', { code: 'THE_CODE', state: s.state }, URL0);
  // the tab asks « Oui, c'est ma boutique ? »: nothing is linked before, and only that tab's key says yes
  assert.equal(back.ok, true);
  // the two Pages are listed; the ad account is a box to tick (ticked: it is the only one)
  assert.deepEqual([back.confirm!.account, back.confirm!.provider, back.confirm!.assets.length], ['Karim Benali', 'meta', 2]);
  assert.deepEqual(back.confirm!.ads, [{ id: '3003', name: 'Bébé pub', currency: 'USD', on: true }]);
  assert.match(loginPage(back), /Karim Benali.*Quels comptes publicitaires.*name="ad" value="3003" checked.*Oui, c’est ma boutique.*Non, ce n’est pas moi/s);
  assert.ok(!/TOKEN/.test(loginPage(back)), 'no token in the page');
  assert.equal((await call('social.state', a, { state: s.state })).status, 'confirm');
  assert.equal(((await call('social.list', a, {})) as any).links.length, 0);
  assert.equal((await confirmLogin(t, s.state, 'not-the-key-of-this-tab', true)).ok, false);
  const end = await confirmLogin(t, back.confirm!.state, back.confirm!.key, true, '', ['3003']);
  assert.deepEqual(end, { ok: true, message: 'Compte lié', account: 'Karim Benali' });
  assert.match(loginPage(end), /Karim Benali.*fermer cet onglet/s);
  assert.equal((await confirmLogin(t, back.confirm!.state, back.confirm!.key, true)).ok, false, 'a yes serves once');
  // each Page is subscribed to Pilotix's webhook with its own token
  const subs = calls.filter((c) => /\/900\d\/subscribed_apps/.test(c.url));
  assert.equal(subs.length, 2);
  // the account's own key was tried on the Page's Instagram inbox (it reaches it), and the Instagram account's messages asked for
  assert.ok(calls.some((c) => /\/v23\.0\/178002\/conversations\?platform=instagram/.test(c.url) && /access_token=LONG_USER_TOKEN/.test(c.url)), 'the Instagram inbox asked with the account’s key');
  assert.ok(calls.some((c) => /178002\/subscribed_apps/.test(c.url) && c.method === 'POST' && /subscribed_fields=messages/.test(c.body)), 'the Instagram account subscribed');
  // and each ad account, so its ads' problems reach Co-Pilot
  assert.ok(calls.some((c) => /act_\d+\/subscribed_apps/.test(c.url) && c.method === 'POST'), 'the ad account subscribed');
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
  // Instagram came with the same login: the account's key answers every Instagram customer (no second connection)
  assert.equal(await setting(a, 'secret_dellal_ig_token'), 'LONG_USER_TOKEN');
  assert.deepEqual([d.instagramLoginId, d.instagramLoginUser, d.igLoginKind], ['178002', 'bebeconfort.dz', 'unified']);
  assert.equal((await setting(a, 'social_page')).igKey, true);
  assert.ok(ds.has.igToken);
  // nothing connected somewhere else, no WhatsApp number yet
  assert.deepEqual([list.old, list.whatsapp], [{ ads: null, instagram: null }, null]);
  // a state serves once
  assert.equal((await linked(t, 'meta', { code: 'AGAIN', state: s.state }, URL0)).ok, false);
});

test('the Page is chosen by the boutique; a Page cannot be pasted by hand any more', async () => {
  const list: any = await call('social.list', a, {});
  const promo = list.links[0].assets.find((x: any) => x.name === 'Bébé Confort Promo');
  const r: any = await call('social.use', a, { assetId: promo.id });
  assert.equal(r.here.page.name, 'Bébé Confort Promo');
  assert.equal(await setting(a, 'secret_dellal_page_token'), 'PAGE_TOKEN_1');
  assert.equal((await setting(a, 'dellal')).instagramId, '', 'this Page has no Instagram account');
  // the Instagram key came with the other Page: it goes with it, and Instagram's webhooks no longer find the boutique by it
  assert.equal(await setting(a, 'secret_dellal_ig_token'), null);
  assert.deepEqual([(await setting(a, 'dellal')).instagramLoginId, (await setting(a, 'dellal')).igLoginKind], ['', '']);
  assert.deepEqual(await routeMeta(t, { object: 'instagram', entry: [{ id: '178002' }] }), []);
  // the Message AI agent's settings no longer take a Page token or Page ids
  const cur: any = await call('dellal.settings.get', a, {});
  await call('dellal.settings.save', a, { ...cur.settings, messengerPageId: '1111', instagramId: '2222', secrets: {} });
  assert.equal((await setting(a, 'dellal')).messengerPageId, '9001');
  await assert.rejects(() => call('dellal.settings.save', a, { ...cur.settings, secrets: { pageToken: 'EAAG-pasted' } }));
  // another boutique cannot take a Page linked to this one
  await assert.rejects(() => call('social.use', b, { assetId: promo.id }), /pas lié à cette boutique/);
  await call('social.use', a, { assetId: list.links[0].assets.find((x: any) => x.name === 'Bébé Confort DZ').id });
  // back on the Page with Instagram: its key answers again
  assert.equal(await setting(a, 'secret_dellal_ig_token'), 'LONG_USER_TOKEN');
  assert.equal((await setting(a, 'dellal')).instagramLoginId, '178002');
  // no Page: no Instagram key either
  await call('social.unuse', a, { kind: 'page' });
  assert.deepEqual([await setting(a, 'secret_dellal_ig_token'), await setting(a, 'social_page')], [null, null]);
  await call('social.use', a, { assetId: list.links[0].assets.find((x: any) => x.name === 'Bébé Confort DZ').id });
  assert.equal(await setting(a, 'secret_dellal_ig_token'), 'LONG_USER_TOKEN');
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
  assert.equal((await linked(t, 'meta', { code: 'C2', state: s.state }, URL0)).ok, true);
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
  await linked(t, 'meta', { code: 'C3', state: s.state }, URL0);
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
    assert.equal((await linked(t, 'meta', { code: ig ? 'IG1' : 'IG0', state: s.state }, URL0)).ok, true);
  };
  // without Instagram's permissions Facebook does not show the Page's Instagram: its messages find no boutique
  await login(false);
  assert.deepEqual(await routeMeta(t, { object: 'instagram', entry: [{ id: '178002' }] }), []);
  assert.equal(await setting(a, 'secret_dellal_ig_token'), null, 'and the key that answered Instagram goes');
  // a new login with them: boutique A gets its Instagram's messages, without taking the Page again
  await login(true);
  assert.deepEqual((await routeMeta(t, { object: 'instagram', entry: [{ id: '178002' }] })).map((x) => x.shopId), [a.shop!.id]);
  assert.equal(await setting(a, 'secret_dellal_ig_token'), 'LONG_USER_TOKEN');
  // Instagram ticked, but Meta does not let the account's key into its inbox: no Instagram key (the Page still answers
  // the people Meta lets it), until a login where it does
  probe.igReach = '(#3) Application does not have the capability to make this API call.';
  await login(true);
  assert.equal(await setting(a, 'secret_dellal_ig_token'), null);
  assert.deepEqual([(await setting(a, 'social_page')).igId, (await setting(a, 'social_page')).igKey], ['178002', false]);
  probe.igReach = null;
  await login(true);
  assert.deepEqual([await setting(a, 'secret_dellal_ig_token'), (await setting(a, 'social_page')).igKey], ['LONG_USER_TOKEN', true]);
});

test('a login cancelled, too old, or from another place: nothing is linked', async () => {
  const s: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
  const no = await linked(t, 'meta', { state: s.state, error: 'access_denied', error_reason: 'user_denied' }, URL0);
  assert.deepEqual(no, { ok: false, message: 'Connexion annulée. Fermez cet onglet.' });
  assert.deepEqual(await call('social.state', a, { state: s.state }), { status: 'error', error: 'Connexion annulée.', linkId: null });
  const old: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
  await t.platform.query(`UPDATE platform.social_states SET expires_at = now() - interval '1 minute' WHERE state = $1`, [old.state]);
  assert.equal((await linked(t, 'meta', { code: 'X', state: old.state }, URL0)).ok, false);
  assert.equal((await linked(t, 'meta', { code: 'X', state: 'not-a-real-state-123' }, URL0)).ok, false);
  // TikTok's state is not Facebook's
  const tt: any = await call('social.start', a, { provider: 'tiktok', scope: 'here' });
  assert.equal((await linked(t, 'meta', { code: 'X', state: tt.state }, URL0)).ok, false);
  // another boutique does not see this boutique's login
  await assert.rejects(() => call('social.state', b, { state: tt.state }), /introuvable/);
  // « Non, ce n'est pas moi » in the tab (a login link sent to someone else): nothing linked, the boutique told why
  const s9: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
  const links = ((await call('social.list', a, {})) as any).links.length;
  const back9 = await finishLogin(t, 'meta', { code: 'SOMEONE_ELSE', state: s9.state }, URL0);
  assert.ok(back9.confirm, back9.message);
  assert.equal((await confirmLogin(t, back9.confirm!.state, back9.confirm!.key, false)).ok, false);
  assert.equal(((await call('social.list', a, {})) as any).links.length, links);
  const st9: any = await call('social.state', a, { state: s9.state });
  assert.equal(st9.status, 'error');
  assert.match(String(st9.error), /pas ma boutique/);
  // what the login brought does not stay behind
  assert.equal((await t.platform.query('SELECT found FROM platform.social_states WHERE state = $1', [s9.state]))[0].found, null);
});

test('TikTok for Business: the advertiser’s token and its ad accounts; linked to one boutique, its first ad account is used', async () => {
  const s: any = await call('social.start', a, { provider: 'tiktok', scope: 'here' });
  const u = new URL(s.url);
  assert.equal(u.origin + u.pathname, 'https://business-api.tiktok.com/portal/auth');
  assert.deepEqual([u.searchParams.get('app_id'), u.searchParams.get('redirect_uri')], [APPS.tiktok.appId, `${URL0}/api/oauth/tiktok/callback`]);
  tiktok = { token: 'TT_ADV_TOKEN', ids: ['7001', '7002'], list: [{ advertiser_id: '7001', advertiser_name: 'Bébé TikTok' }, { advertiser_id: '7002', advertiser_name: 'Bébé TikTok 2' }], user: { core_user_id: 'u77', display_name: 'Karim Ads' } };
  calls.length = 0;
  const end = await linked(t, 'tiktok', { auth_code: 'TT_CODE', state: s.state }, URL0);
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

test('the preview: the boutique’s one Page and its ads connection; a « login » links after two seconds, and a new Page takes the old one’s place', async () => {
  resetSocialDemo();
  let now = Date.parse('2026-11-03T16:00:00Z');
  const demo: Ctx = { ...a, t: undefined, server: undefined, now: () => now };
  const first: any = await call('social.list', demo, {});
  assert.equal(first.preview, true);
  // Meta's two doors: a Facebook account with the boutique's one Page; the ads, a connection of their own
  assert.deepEqual(first.links.map((x: any) => [x.part, x.scope, x.assets.map((y: any) => y.kind).join()]), [['main', 'here', 'page'], ['ads', 'all', 'ad_account,ad_account,ad_account,ad_account,ad_account']]);
  assert.equal(first.here.page.name, 'Bébé Confort DZ');
  // the boutique uses the ad accounts it ticked (2 of 5); its sister ticked others
  assert.deepEqual(first.links[1].assets.map((y: any) => `${y.name}:${y.usedHere}:${y.usedBy.length}`), ['Bébé Confort — publicité:true:1', 'Bébé Confort — tests:true:1', 'Promo Ramadan:false:1', 'Ancien compte (lecture seule):false:0', 'Compte en dinars:false:0']);
  assert.equal(first.here.ad_account.count, 2);
  const s: any = await call('social.start', demo, { provider: 'tiktok', scope: 'here' });
  assert.equal(s.url, null);
  assert.equal((await call('social.state', demo, { state: s.state })).status, 'waiting');
  now += 2500;
  assert.equal((await call('social.state', demo, { state: s.state })).status, 'done');
  const after: any = await call('social.list', demo, {});
  assert.equal(after.links.length, 3);
  assert.equal(after.here.advertiser.name, 'Bébé Confort TikTok');
  // « Facebook et Instagram » again: the boutique answers on the new Page, the Facebook account it had goes
  const s2: any = await call('social.start', demo, { provider: 'meta', scope: 'all' });
  now += 2500;
  const done: any = await call('social.state', demo, { state: s2.state });
  assert.equal(done.status, 'done');
  const again: any = await call('social.list', demo, {});
  const pages = again.links.filter((x: any) => x.provider === 'meta' && x.part === 'main');
  assert.deepEqual(pages.map((x: any) => [x.id, x.scope, x.assets.map((y: any) => `${y.name}:${y.usedHere}`).join()]), [[done.linkId, 'here', 'Bébé Confort Alger:true']]);
  assert.equal(again.here.page.name, 'Bébé Confort Alger');
  assert.equal(again.here.ad_account.count, 2, 'the ads keep their own connection, and the ticks');
  // a Page's account stays with its boutique
  await assert.rejects(() => call('social.scope', demo, { linkId: done.linkId, scope: 'all' }), /une seule boutique/);
  resetSocialDemo();
});

test('« Connecter Instagram » is gone: Instagram comes with the Facebook account; a key connected before stays until the boutique removes it', async () => {
  // no Instagram-only login any more: not asked for, not kept in Pilotix's settings, and a tab of it still open ends
  await assert.rejects(() => call('social.start', a, { provider: 'meta', kind: 'instagram' }), /kind/);
  await p('p.social.apps.save', { meta: { ...APPS.meta, configId: '777000111', igConfigId: '1485334790168642', secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });
  const apps: any = await p('p.social.apps', {});
  assert.equal('igConfigId' in apps.meta, false);
  assert.equal(apps.meta.configId, '777000111');
  await t.platform.query(`INSERT INTO platform.social_states (state, provider, owner_id, shop_id, from_shop, by_name, expires_at) VALUES ('ig.old-tab-state-1234567890', 'meta', 0, $1, $1, 'Karim', now() + interval '10 minutes')`, [a.shop!.id]);
  const old = await finishLogin(t, 'meta', { code: 'IG_ONLY', state: 'ig.old-tab-state-1234567890' }, URL0);
  assert.equal(old.ok, false);
  assert.match(old.message, /Continuer avec Facebook/);
  await p('p.social.apps.save', { meta: { ...APPS.meta, configId: '', secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });

  // a boutique that connected Instagram before, in Pilot Message: its key is its own. Linking the Facebook account
  // again, or picking the Page again, leaves it in place; the list names it
  const page = ((await call('social.list', a, {})) as any).links.find((x: any) => x.name === 'Karim Benali').assets.find((x: any) => x.kind === 'page' && x.usedHere);
  await call('social.unuse', a, { kind: 'page' });
  await setRaw(a.db, 'secret_dellal_ig_token', 'IGAA-CONNECTED-BEFORE');
  await setRaw(a.db, 'dellal', { ...(await setting(a, 'dellal')), instagramLoginId: '2601', instagramLoginUser: 'bebeconfort.dz', igTokenAt: '2026-11-01T00:00:00.000Z', igLoginKind: 'ig' });
  await noteIgLogin(t, a.shop!.id, '2601', 'bebeconfort.dz');
  const used: any = await call('social.use', a, { assetId: page.id });
  assert.equal(await setting(a, 'secret_dellal_ig_token'), 'IGAA-CONNECTED-BEFORE');
  assert.deepEqual([(await setting(a, 'dellal')).instagramLoginId, (await setting(a, 'dellal')).igLoginKind, (await setting(a, 'social_page')).igKey], ['2601', 'ig', false]);
  // (the account's key reaches the Instagram inbox: the old key may be removed, the account's key is ready to take over)
  assert.deepEqual(used.old.instagram, { username: 'bebeconfort.dz', ready: true });
  // that old login gives the account another number in its webhooks: they still find the boutique
  assert.deepEqual((await routeMeta(t, { object: 'instagram', entry: [{ id: '2601' }] })).map((x) => x.shopId), [a.shop!.id]);
  const s: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
  graph = { me: { id: '5001', name: 'Karim Benali' }, pages: [{ id: '9002', name: 'Bébé Confort DZ', access_token: 'PAGE_TOKEN_2', instagram_business_account: { id: '178002', username: 'bebeconfort.dz' } }], ads: [] };
  assert.equal((await linked(t, 'meta', { code: 'AGAIN', state: s.state }, URL0)).ok, true);
  assert.equal(await setting(a, 'secret_dellal_ig_token'), 'IGAA-CONNECTED-BEFORE', 'a new login does not take a working key’s place');
  // only an admin of the boutique removes it
  const agent: Ctx = { ...a, session: { ...a.session, isAdmin: false, profile: { ...a.session.profile, role: 'confirmation' } } as any };
  await assert.rejects(() => call('social.dropOld', agent, { what: 'instagram' }));
  // and not while the account's key has not been seen to reach the Instagram inbox: Instagram would be left to the Page alone
  await t.platform.query(`UPDATE platform.social_assets SET extra = extra #- '{ig,key}' WHERE id = $1`, [page.id]);
  assert.deepEqual(((await call('social.list', a, {})) as any).old.instagram, { username: 'bebeconfort.dz', ready: false });
  await assert.rejects(() => call('social.dropOld', a, { what: 'instagram' }), /Relier/);
  assert.equal(await setting(a, 'secret_dellal_ig_token'), 'IGAA-CONNECTED-BEFORE');
  await t.platform.query(`UPDATE platform.social_assets SET extra = jsonb_set(extra, '{ig,key}', 'true') WHERE id = $1`, [page.id]);
  // removed, the Facebook account's key answers Instagram at once
  const gone: any = await call('social.dropOld', a, { what: 'instagram' });
  assert.equal(gone.old.instagram, null);
  assert.equal(await setting(a, 'secret_dellal_ig_token'), 'LONG_USER_TOKEN');
  assert.deepEqual([(await setting(a, 'dellal')).instagramLoginId, (await setting(a, 'dellal')).igLoginKind, (await setting(a, 'social_page')).igKey], ['178002', 'unified', true]);
  assert.deepEqual(await routeMeta(t, { object: 'instagram', entry: [{ id: '2601' }] }), []);
  assert.deepEqual((await routeMeta(t, { object: 'instagram', entry: [{ id: '178002' }] })).map((x) => x.shopId), [a.shop!.id]);
  // asked twice: nothing more to remove, nothing breaks
  await call('social.dropOld', a, { what: 'instagram' });
  assert.equal(await setting(a, 'secret_dellal_ig_token'), 'LONG_USER_TOKEN');
});

test('« Connecter WhatsApp »: Meta’s Embedded Signup for one shop; its number answers there, and its messages come through Pilotix’s app', async () => {
  const apps = (waConfigId: string) => p('p.social.apps.save', { meta: { ...APPS.meta, configId: '777000111', waConfigId, secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });
  // not before Pilotix has put in the WhatsApp configuration
  await apps('');
  await assert.rejects(() => call('social.start', b, { provider: 'meta', kind: 'whatsapp' }), /WhatsApp/);
  await apps('880011223344');
  assert.equal(((await p('p.social.apps', {})) as any).meta.waConfigId, '880011223344');
  const s: any = await call('social.start', b, { provider: 'meta', kind: 'whatsapp' });
  assert.ok(s.state.startsWith('wa.'));
  const u = new URL(s.url);
  assert.equal(u.searchParams.get('config_id'), '880011223344');
  assert.equal(u.searchParams.get('override_default_response_type'), 'true');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.deepEqual(JSON.parse(u.searchParams.get('extras')!), { setup: {}, featureType: '', sessionInfoVersion: '3' });
  // for this boutique only
  assert.equal(Number((await t.platform.query(`SELECT shop_id FROM platform.social_states WHERE state = $1`, [s.state]))[0].shop_id), b.shop!.id);

  // the shop picked its account and number in Meta's window: the tab asks « Oui, c'est ma boutique ? »
  wa = { waba: '102030405060', numbers: [{ id: '109988776655', display_phone_number: '+213 550 98 76 54', verified_name: 'Bébé Oran' }], registerFail: false };
  calls.length = 0;
  const end = await finishLogin(t, 'meta', { state: s.state, code: 'WA_CODE' }, URL0);
  assert.equal(end.ok, true);
  assert.equal(end.confirm?.net, 'WhatsApp Business');
  assert.deepEqual(end.confirm?.assets, [{ kind: 'whatsapp', name: '+213 550 98 76 54' }]);
  assert.match(loginPage(end), /WhatsApp Business/);
  // which account the key was given: asked with the app's own key
  const dbg = calls.find((c) => new URL(c.url).pathname.endsWith('/debug_token'))!;
  assert.equal(new URL(dbg.url).searchParams.get('access_token'), `${APPS.meta.appId}|${APPS.meta.secret}`);
  const done = await confirmLogin(t, end.confirm!.state, end.confirm!.key, true);
  assert.deepEqual([done.ok, done.account, done.warn], [true, '+213 550 98 76 54', undefined]);
  assert.match(loginPage(done), /window\.close/);
  // the account's messages come to Pilotix's app; the number is registered with a 6-digit PIN the boutique keeps
  assert.ok(calls.some((c) => c.method === 'POST' && new URL(c.url).pathname.endsWith('/102030405060/subscribed_apps')));
  const reg = new URLSearchParams(calls.find((c) => c.method === 'POST' && new URL(c.url).pathname.endsWith('/109988776655/register'))!.body);
  assert.equal(reg.get('messaging_product'), 'whatsapp');
  assert.match(reg.get('pin')!, /^\d{6}$/);
  assert.equal(await setting(b, 'secret_dellal_wa_pin'), reg.get('pin'));
  // Pilot Message answers on it, the delivery messages and the campaigns use it
  assert.equal(await setting(b, 'secret_dellal_wa_token'), 'LONG_USER_TOKEN');
  const d = await setting(b, 'dellal');
  assert.deepEqual([d.whatsappPhoneId, d.whatsappPhone], ['109988776655', '+213 550 98 76 54']);
  assert.equal((await setting(b, 'notify')).wabaId, '102030405060');
  assert.equal(await setting(a, 'secret_dellal_wa_token'), null, 'not the other boutique');
  // Comptes shows the number (and that Pilotix's « Connecter WhatsApp » is ready); the other boutique has none
  const lb: any = await call('social.list', b, {});
  assert.deepEqual([lb.whatsapp, lb.waReady], [{ phone: '+213 550 98 76 54', phoneId: '109988776655', old: false }, true]);
  assert.equal(((await call('social.list', a, {})) as any).whatsapp, null);
  assert.ok(!/LONG_USER_TOKEN/.test(JSON.stringify(lb)), 'its key never reaches the page');

  // Meta's webhook: each number's changes to the boutique that connected it; another number is dropped (and noted)
  const hook = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102030405060',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '213550987654', phone_number_id: '109988776655' },
              contacts: [{ wa_id: '213661000111', profile: { name: 'Samia' } }],
              messages: [{ from: '213661000111', id: 'wamid.A1', type: 'text', text: { body: 'Salam, le prix ?' } }],
            },
          },
          { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: '555000111' }, statuses: [{ id: 'wamid.X', status: 'delivered' }] } },
        ],
      },
    ],
  };
  const routed = await routeMeta(t, hook);
  assert.deepEqual(routed.map((r) => r.shopId), [b.shop!.id]);
  assert.deepEqual(routed[0].body.entry[0].changes.map((c: any) => c.value.metadata.phone_number_id), ['109988776655']);
  assert.equal(routed[0].body.entry[0].id, '102030405060');
  const seen = async (id: string) => (await t.platform.query(`SELECT routed, what, message_at FROM platform.social_hooks WHERE object = 'whatsapp_business_account' AND ext_id = $1`, [id]))[0];
  const mine = await seen('109988776655');
  assert.deepEqual([mine.routed, mine.what, !!mine.message_at], [true, 'message', true]);
  const other = await seen('555000111');
  assert.deepEqual([other.routed, other.what], [false, 'status']);

  // a number Meta would not register: linked all the same, and the tab says why (it stays open)
  wa.registerFail = true;
  const s2: any = await call('social.start', b, { provider: 'meta', kind: 'whatsapp' });
  const e2 = await finishLogin(t, 'meta', { state: s2.state, code: 'WA_CODE_2' }, URL0);
  const d2 = await confirmLogin(t, e2.confirm!.state, e2.confirm!.key, true);
  assert.equal(d2.ok, true);
  assert.match(d2.warn ?? '', /PIN Mismatch/);
  assert.match(loginPage(d2), /class="warn"/);
  assert.doesNotMatch(loginPage(d2), /window\.close/);
  // no WhatsApp Business account given in Meta's window: said plainly
  wa = { waba: '', numbers: [], registerFail: false };
  const s3: any = await call('social.start', b, { provider: 'meta', kind: 'whatsapp' });
  const e3 = await finishLogin(t, 'meta', { state: s3.state, code: 'WA_CODE_3' }, URL0);
  assert.equal(e3.ok, false);
  assert.match(e3.message, /Aucun compte WhatsApp Business/);
  // an account without a number yet: said plainly too
  wa = { waba: '102030405061', numbers: [], registerFail: false };
  const s4: any = await call('social.start', b, { provider: 'meta', kind: 'whatsapp' });
  assert.match((await finishLogin(t, 'meta', { state: s4.state, code: 'WA_CODE_4' }, URL0)).message, /pas encore de numéro/);

  // Pilot Message's settings no longer take a WhatsApp key or number: saving them changes nothing of it
  const g: any = await call('dellal.settings.get', b, {});
  assert.equal(g.settings.whatsappPhone, '+213 550 98 76 54');
  await assert.rejects(() => call('dellal.settings.save', b, { ...g.settings, secrets: { waToken: null } }), /secrets\.waToken/);
  await call('dellal.settings.save', b, { ...g.settings, whatsappPhoneId: '', whatsappPhone: '', secrets: {} });
  assert.deepEqual([(await setting(b, 'dellal')).whatsappPhoneId, await setting(b, 'secret_dellal_wa_token')], ['109988776655', 'LONG_USER_TOKEN']);
  // « Retirer » in Comptes: the number and its key are forgotten, its messages are no longer routed here; the PIN
  // Pilotix gave the number stays (Meta asks for it to move the number)
  const off: any = await call('social.waRemove', b, {});
  assert.equal(off.whatsapp, null);
  assert.deepEqual([(await setting(b, 'dellal')).whatsappPhoneId, (await setting(b, 'dellal')).whatsappPhone, await setting(b, 'secret_dellal_wa_token')], ['', '', null]);
  assert.ok(await setting(b, 'secret_dellal_wa_pin'));
  assert.deepEqual(await routeMeta(t, hook), []);
  // a number and a key typed by hand before (the boutique's own Meta app): still the boutique's, shown as such
  await setRaw(b.db, 'secret_dellal_wa_token', 'EAAB-typed-before');
  await setRaw(b.db, 'dellal', { ...(await setting(b, 'dellal')), whatsappPhoneId: '555000999' });
  assert.deepEqual(((await call('social.list', b, {})) as any).whatsapp, { phone: '', phoneId: '555000999', old: true });
  await call('social.waRemove', b, {});
  wa = { waba: '', numbers: [], registerFail: false };
  await p('p.social.apps.save', { meta: { ...APPS.meta, configId: '', waConfigId: '', secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });
});

test('« Connecter WhatsApp » in Meta’s own popup (JavaScript SDK): the code without redirect_uri, the account and number Meta’s window said, for this boutique only', async () => {
  await p('p.social.apps.save', { meta: { ...APPS.meta, configId: '777000111', waConfigId: '880011223344', secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });
  // what the page needs before the click: Pilotix's app, its WhatsApp configuration, Meta's version and Embedded Signup's extras
  const sdk: any = await call('social.waSdk', b, {});
  assert.deepEqual(sdk, { appId: APPS.meta.appId, configId: '880011223344', version: 'v25.0', extras: { setup: {}, featureType: '', sessionInfoVersion: '3' } });
  // two numbers: the one chosen in Meta's window is the one linked
  wa = {
    waba: '102030405070',
    numbers: [
      { id: '109988770001', display_phone_number: '+213 550 00 00 01', verified_name: 'Bébé Oran' },
      { id: '109988770002', display_phone_number: '+213 550 00 00 02', verified_name: 'Bébé Oran' },
    ],
    registerFail: false,
  };
  const s: any = await call('social.start', b, { provider: 'meta', kind: 'whatsapp' });
  calls.length = 0;
  const r: any = await finishWhatsappPopup(t, b.shop!.id, { state: s.state, code: 'SDK_CODE', wabaId: '102030405070', phoneId: '109988770002' });
  assert.deepEqual([r.ok, r.account], [true, '+213 550 00 00 02']);
  // an SDK code is exchanged without redirect_uri
  const ex = calls.find((c) => new URL(c.url).pathname.endsWith('/oauth/access_token') && new URL(c.url).searchParams.get('code') === 'SDK_CODE')!;
  assert.equal(new URL(ex.url).searchParams.get('redirect_uri'), null);
  assert.equal((await setting(b, 'dellal')).whatsappPhoneId, '109988770002');
  assert.equal(await setting(a, 'secret_dellal_wa_token'), null, 'not the other boutique');
  // the state served once
  assert.match((await finishWhatsappPopup(t, b.shop!.id, { state: s.state, code: 'SDK_CODE' })).message, /déjà servi/);
  // another boutique's state is refused
  const s2: any = await call('social.start', b, { provider: 'meta', kind: 'whatsapp' });
  assert.match((await finishWhatsappPopup(t, a.shop!.id, { state: s2.state, code: 'SDK_CODE' })).message, /introuvable/);
  // an account the key was not given (the page said another one): refused, nothing linked
  const s3: any = await call('social.start', b, { provider: 'meta', kind: 'whatsapp' });
  const bad: any = await finishWhatsappPopup(t, b.shop!.id, { state: s3.state, code: 'SDK_CODE', wabaId: '999999999999' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /n’a pas donné/);
  // the state of a Facebook account's login is not a WhatsApp one
  const s4: any = await call('social.start', b, { provider: 'meta', scope: 'here' });
  assert.match((await finishWhatsappPopup(t, b.shop!.id, { state: s4.state, code: 'SDK_CODE' })).message, /introuvable/);
  await call('social.waRemove', b, {});
  wa = { waba: '', numbers: [], registerFail: false };
  await p('p.social.apps.save', { meta: { ...APPS.meta, configId: '', waConfigId: '', secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });
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
  assert.equal((await linked(t, 'meta', { code: 'CFG_CODE', state: s.state }, URL0)).ok, true);
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
    assert.equal((await linked(t, 'meta', { code: 'SYS_CODE', state: s2.state }, URL0)).ok, true);
    const sys = await kept('5100');
    assert.deepEqual([sys.token, sys.token_kind, sys.expires_at], ['SHORT_USER_TOKEN', 'system', null]);
    // without a configuration, a token Facebook will not turn is an error: nothing half-linked
    await p('p.social.apps.save', { meta: { ...APPS.meta, secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });
    const s3: any = await call('social.start', b, { provider: 'meta', scope: 'here' });
    const end3 = await linked(t, 'meta', { code: 'NO_CFG', state: s3.state }, URL0);
    assert.equal(end3.ok, false);
  } finally {
    refuseSwap = false;
  }
});

test('several ad accounts: a boutique counts them all, Publicité reads each one; a new login keeps the others; one switch stops and starts them', async () => {
  const login = async (ads: any[]) => {
    const s: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
    graph = { me: { id: '5001', name: 'Karim Benali' }, pages: [{ id: '9002', name: 'Bébé Confort DZ', access_token: 'PAGE_TOKEN_2', instagram_business_account: { id: '178002', username: 'bebeconfort.dz' } }], ads };
    assert.equal((await linked(t, 'meta', { code: `C${ads.length}`, state: s.state }, URL0)).ok, true);
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
  // « Compte pour lancer »: the first by default; the owner's choice goes first (launches and customer lists use it), all stay counted
  assert.equal(list.launch.id, '3003');
  assert.deepEqual(list.launch.accounts.map((x: any) => [x.id, x.name, x.currency]), [['3003', 'Bébé pub', 'USD'], ['3004', 'Bébé pub 2', 'USD'], ['3005', 'Promo', 'USD']]);
  list = await call('social.launchAccount', a, { adAccountId: '3005' });
  assert.equal(list.launch.id, '3005');
  assert.deepEqual([(await setting(a, 'meta')).adAccountId, (await setting(a, 'meta')).adAccountIds, (await setting(a, 'meta')).hasToken], ['3005', ['3005', '3003', '3004'], true]);
  assert.deepEqual([(await setting(a, 'social_ads')).adAccountId, (await setting(a, 'social_ads')).name], ['3005', 'Promo']);
  await assert.rejects(() => call('social.launchAccount', a, { adAccountId: '999999' }), /n’est pas compté/);
  // it is kept when the page writes the accounts again, and when the account is linked again with it
  await a.db.query(`UPDATE settings SET value = $1 WHERE key = 'meta'`, [JSON.stringify({ adAccountId: '3003', hasToken: true })]);
  await call('social.list', a, {});
  assert.deepEqual((await setting(a, 'meta')).adAccountIds, ['3005', '3003', '3004']);
  await login([act('3003', 'Bébé pub'), act('3004', 'Bébé pub 2'), act('3005', 'Promo')]);
  assert.equal(((await call('social.list', a, {})) as any).launch.id, '3005');
  list = await call('social.launchAccount', a, { adAccountId: 'act_3003' });
  assert.equal((await setting(a, 'meta')).adAccountId, '3003');
  assert.deepEqual([...(await setting(a, 'meta')).adAccountIds].sort(), ['3003', '3004', '3005']);
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

/** « Tester »'s lines as « part.line[:case] » → state (a line's case: fixed, lost, or its « why »). */
const lines = (r: any): Record<string, string> =>
  Object.fromEntries(r.checks.map((c: any) => [`${c.group}.${c.key}${c.params?.fixed ? ':fixed' : c.params?.lost ? ':lost' : c.params?.why ? `:${c.params.why}` : ''}`, c.state]));
const karimOf = async () => ((await call('social.list', a, {})) as any).links.find((x: any) => x.name === 'Karim Benali');

test('« Tester », part by part: the key and what Facebook gave it, the Page (subscribed again), Instagram, the forms, Publicité; Pilotix’s Meta app (its webhook, its address from the Internet) in the control room', async () => {
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
  // every line says where it belongs: the page shows the test part by part
  assert.ok(r.checks.every((c: any) => (CHECK_GROUPS as readonly string[]).includes(c.group)));
  assert.deepEqual(lines(r), {
    'key.token': 'ok',
    'key.keyLife': 'ok',
    'key.given': 'ok',
    'fb.page': 'ok',
    'fb.pageHook:fixed': 'ok',
    'fb.fbSeen': 'warn',
    'fb.fbComment': 'warn',
    'fb.catchUp': 'warn',
    // each part names the permission it misses: here Instagram's comments (red: the boutique uses that part)…
    'ig.perm:igComments': 'bad',
    'ig.ig': 'ok',
    'ig.igInbox': 'ok',
    // (Meta already sent things for this Instagram account in the tests above, but no customer's message)
    'ig.igSeen:other': 'warn',
    'ig.igComment': 'warn',
    'ig.igKey': 'ok',
    // …and what the boutique would need for the forms, publishing, launching ads, the catalogue (to look at)
    'forms.perm:forms': 'warn',
    'forms.leadHook:fixed': 'ok',
    'forms.forms': 'ok',
    'content.perm:content': 'warn',
    'ads.perm:adsManage': 'warn',
    'ads.ads': 'ok',
    'ads.adsRead': 'ok',
    'ads.adsLaunch:perm': 'warn',
    'catalog.perm:catalog': 'warn',
    'catalog.catalogNone': 'info',
    'pixels.pixelNone': 'info',
  });
  // Pilotix's own Meta app: the Pilotix team's part, tried in the control room (never in a boutique's test)
  const app: any = await p('p.social.appTest');
  assert.deepEqual(lines(app), {
    'app.appHook': 'ok',
    'app.appHookLeads': 'warn',
    'app.appHookEdits': 'warn',
    'app.appHookIg': 'warn',
    'app.appHookAds': 'warn',
    'app.reach': 'ok',
  });
  const find = (x: any, key: string, why?: string) => x.checks.find((c: any) => c.key === key && (why === undefined || c.params?.why === why));
  assert.equal(find(r, 'perm', 'igComments').params.list, 'instagram_manage_comments');
  assert.equal(find(r, 'perm', 'adsManage').params.list, 'ads_management, pages_manage_ads, business_management');
  assert.equal(find(r, 'perm', 'forms').params.list, 'leads_retrieval, pages_manage_ads');
  // what Facebook gave at the last login, and how long the key lasts (a person's key: about 60 days)
  assert.deepEqual(find(r, 'given').params, { pages: 1, igs: 1, ads: 1 });
  assert.ok(Date.parse(find(r, 'keyLife').params.until) > Date.now() + 50 * 86_400_000);
  // Marketing › Formulaires: the Page subscribed to its ads' lead forms too; the app's webhook does not send them yet
  assert.ok(calls.some((c) => /9002\/subscribed_apps/.test(c.url) && c.method === 'POST' && /leadgen/.test(String(c.body ?? ''))), 'the lead forms asked');
  assert.equal(find(app, 'appHookLeads').params.list, 'leadgen');
  assert.equal(find(r, 'pageHook').params.fixed, 1);
  assert.ok(calls.some((c) => /9002\/subscribed_apps/.test(c.url) && c.method === 'POST'), 'subscribed again');
  assert.equal(find(app, 'appHookIg').params.list, 'messages, comments');
  // Publicité: the ad account's numbers were read as Publicité reads them, with the account's key
  assert.ok(calls.some((c) => /act_3004\/insights/.test(c.url) && /access_token=LONG_USER_TOKEN/.test(c.url)));
  assert.deepEqual([find(r, 'ads').params, find(r, 'adsRead').params], [{ count: 1, bad: 0 }, { name: 'Compte 3004' }]);
  assert.ok(!/PAGE_TOKEN|LONG_USER_TOKEN|SHORT_USER_TOKEN|meta-app-secret/.test(JSON.stringify(r)), 'no token or secret reaches the page');

  // Meta's own word on the key (debug_token) comes first when it gives the permissions: every one given, a key without an end
  probe.scopes = [...ALL_PERMS, 'ads_management', 'pages_manage_ads', 'business_management', 'leads_retrieval', 'catalog_management', 'pages_manage_posts', 'instagram_content_publish', 'read_insights', 'instagram_manage_insights'];
  probe.expiresAt = 0;
  probe.pageSubs = [{ id: APPS.meta.appId, subscribed_fields: ['messages', 'messaging_postbacks', 'messaging_referrals', 'message_edits', 'message_reactions', 'feed', 'leadgen'] }];
  calls.length = 0;
  const full: any = await call('social.test', a, { linkId: karim.id });
  assert.ok(!calls.some((c) => /me\/permissions/.test(c.url)), 'debug_token said the permissions');
  assert.equal(r.checks.filter((c: any) => c.key === 'perm').length, 5);
  assert.deepEqual(full.checks.filter((c: any) => c.key === 'perm').map((c: any) => c.params.why), []);
  assert.deepEqual([find(full, 'keyLife').params, find(full, 'pageHook').params, find(full, 'leadHook').params], [{ why: 'never' }, undefined, undefined]);
  assert.deepEqual([lines(full)['content.content'], lines(full)['ads.adsLaunch']], ['ok', 'ok']);
  // a key that ends within a week: to link again soon
  probe.expiresAt = Math.round(Date.now() / 1000) + 3 * 86_400;
  assert.equal(find(await call('social.test', a, { linkId: karim.id }), 'keyLife').state, 'warn');
  // reading the numbers is allowed by the permission to manage ads too (no « ads_read » asked then)
  probe.scopes = probe.scopes.filter((x) => x !== 'ads_read');
  assert.equal(find(await call('social.test', a, { linkId: karim.id }), 'perm', 'adsRead'), undefined);
  probe.scopes = undefined;
  probe.expiresAt = undefined;
  probe.pageSubs = [];
  // the ads' forms Meta refuses: said in the forms' part, with Meta's words
  probe.formsRefuse = true;
  const noForms = find(await call('social.test', a, { linkId: karim.id }), 'forms');
  assert.deepEqual([noForms.group, noForms.state], ['forms', 'warn']);
  assert.match(noForms.detail, /leads_retrieval/);
  probe.formsRefuse = false;

  // a webhook Pilotix refused (its signature matched no secret): said for 2 days, in the control room's test
  await noteBadSignature(t, 'instagram');
  const sig: any = await p('p.social.appTest');
  assert.deepEqual([find(sig, 'badSig').state, find(sig, 'badSig').group, find(sig, 'badSig').params.count], ['warn', 'app', 1]);
  assert.equal(find(await call('social.test', a, { linkId: karim.id }), 'badSig'), undefined, 'never in a boutique’s test');
  await t.platform.query(`DELETE FROM platform.settings WHERE key = 'meta_badsig'`);
  // Cloudflare stops the webhook's address
  probe.cloudflare = true;
  const cf: any = await p('p.social.appTest');
  assert.deepEqual(find(cf, 'reach'), { key: 'reach', group: 'app', state: 'bad', params: { why: 'cloudflare' }, detail: null });
  probe.cloudflare = false;
  // a key Facebook refuses turns the account red; working again, green
  probe.refuse = true;
  const bad: any = await call('social.test', a, { linkId: karim.id });
  assert.deepEqual([bad.checks[0].key, bad.checks[0].group, bad.checks[0].state], ['token', 'key', 'bad']);
  assert.equal(((await call('social.list', a, {})) as any).links.find((x: any) => x.id === karim.id).status, 'error');
  probe.refuse = false;
  await call('social.test', a, { linkId: karim.id });
  assert.equal(((await call('social.list', a, {})) as any).links.find((x: any) => x.id === karim.id).status, 'ok');
  // ad accounts in dinars: Publicité counts them in dinars (fine); in another money: as dollars (to look at)
  const money = (c: string) =>
    t.platform.query(`UPDATE platform.social_assets SET extra = jsonb_set(extra, '{currency}', to_jsonb($1::text)) WHERE link_id = $2 AND kind = 'ad_account'`, [c, karim.id]);
  const currencyLine = async () => find(await call('social.test', a, { linkId: karim.id }), 'adsCurrency');
  await money('DZD');
  assert.deepEqual(await currencyLine(), { key: 'adsCurrency', group: 'ads', state: 'ok', detail: null });
  await money('EUR');
  assert.deepEqual(await currencyLine(), { key: 'adsCurrency', group: 'ads', state: 'warn', params: { list: 'EUR' }, detail: null });
  await money('USD');
  assert.equal(await currencyLine(), undefined);
  // Instagram: Meta refuses its inbox and says why; when Pilotix last got something from it, or never
  const line = async (key: string) => find(await call('social.test', a, { linkId: karim.id }), key);
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
  // Messenger: a customer's message on the Page, written down the same way
  const fbSeen = async () => {
    const c = await line('fbSeen');
    return [c.group, c.state, typeof c.params.at];
  };
  await t.platform.query(`DELETE FROM platform.social_hooks WHERE object = 'page'`);
  assert.deepEqual(await fbSeen(), ['fb', 'warn', 'undefined']);
  await routeMeta(t, { object: 'page', entry: [{ id: '9002', messaging: [{ sender: { id: 'psid-1' }, recipient: { id: '9002' }, message: { mid: 'm-fb-1', text: 'salam' } }] }] });
  assert.deepEqual(await fbSeen(), ['fb', 'ok', 'string']);
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
  // no Page chosen in this boutique: said in the Page's part, and nothing of Instagram, the forms or publishing is tried
  const pageId = karim.assets.find((x: any) => x.kind === 'page' && x.usedHere).id;
  await call('social.unuse', a, { kind: 'page' });
  const none = lines(await call('social.test', a, { linkId: karim.id }));
  assert.equal(none['fb.pageNone'], 'warn');
  assert.deepEqual(Object.keys(none).filter((k) => /^(ig|forms|content)\./.test(k)), []);
  await call('social.use', a, { assetId: pageId });
  // another boutique cannot test this boutique's account
  await assert.rejects(() => call('social.test', b, { linkId: karim.id }), /introuvable/);
});

test('« Tester », Instagram: which key answers every customer — the account’s own; one connected before while it works; repaired when it can be', async () => {
  const karim = await karimOf();
  const page = karim.assets.find((x: any) => x.kind === 'page' && x.usedHere);
  const key = async () => {
    const r: any = await call('social.test', a, { linkId: karim.id });
    const c = r.checks.find((x: any) => x.key === 'igKey');
    assert.ok(!/IGAA|LONG_USER_TOKEN/.test(JSON.stringify(r)), 'no key reaches the page');
    return [c.group, c.state, c.params.fixed ? 'fixed' : c.params.why ?? null, c.detail];
  };
  const stored = async () => [await setting(a, 'secret_dellal_ig_token'), (await setting(a, 'dellal')).igLoginKind, (await setting(a, 'social_page')).igKey];
  // the account's key answers Instagram (it came with the login) and reaches the inbox: nothing to do
  assert.deepEqual(await stored(), ['LONG_USER_TOKEN', 'unified', true]);
  assert.deepEqual(await key(), ['ig', 'ok', null, null]);
  // Meta no longer lets it in: red, with Meta's reason; when Meta says the Instagram account was not ticked, said so
  probe.igReach = '(#10) Application does not have permission for this action';
  assert.deepEqual(await key(), ['ig', 'bad', 'none', 'Facebook : (#10) Application does not have permission for this action']);
  probe.granular = [{ scope: 'instagram_manage_messages', target_ids: ['178999'] }];
  assert.equal((await key())[2], 'tick');
  probe.granular = [{ scope: 'instagram_manage_messages', target_ids: ['178002'] }];
  assert.equal((await key())[2], 'none');
  probe.granular = undefined;
  assert.deepEqual(await stored(), ['LONG_USER_TOKEN', 'unified', true], 'a refusal takes nothing away (Meta may only be slow)');
  probe.igReach = null;

  // an account linked before Instagram came with it: no key yet. « Tester » sees the account's key reach the inbox and
  // gives it Instagram's answers at once
  const before = async () => {
    await t.platform.query(`UPDATE platform.social_assets SET extra = extra #- '{ig,key}' WHERE id = $1`, [page.id]);
    await a.db.query(`DELETE FROM settings WHERE key = 'secret_dellal_ig_token'`);
    await setRaw(a.db, 'social_page', { ...(await setting(a, 'social_page')), igKey: false });
    await setRaw(a.db, 'dellal', { ...(await setting(a, 'dellal')), instagramLoginId: '', instagramLoginUser: '', igTokenAt: '', igLoginKind: '' });
  };
  await before();
  // …unless Meta does not let the key in: to look at (the Page still answers the people Meta lets it), nothing written
  probe.igReach = '(#3) Application does not have the capability to make this API call.';
  assert.deepEqual((await key()).slice(0, 3), ['ig', 'warn', 'none']);
  assert.deepEqual(await stored(), [null, '', false]);
  probe.igReach = null;
  assert.deepEqual(await key(), ['ig', 'ok', 'fixed', null]);
  assert.deepEqual(await stored(), ['LONG_USER_TOKEN', 'unified', true]);
  assert.deepEqual([(await setting(a, 'dellal')).instagramLoginId, (await setting(a, 'dellal')).instagramLoginUser], ['178002', 'bebeconfort.dz']);
  assert.deepEqual(await key(), ['ig', 'ok', null, null]);

  // a key connected before in Pilot Message (Instagram's own login) that works: it keeps its place, named as the old one
  const old = async (kind: string, loginId: string) => {
    await before();
    await setRaw(a.db, 'secret_dellal_ig_token', 'IGAA-CONNECTED-BEFORE');
    await setRaw(a.db, 'dellal', { ...(await setting(a, 'dellal')), instagramLoginId: loginId, instagramLoginUser: 'bebeconfort.dz', igTokenAt: '2026-11-01T00:00:00.000Z', igLoginKind: kind });
  };
  const oldHere = async () => ((await call('social.list', a, {})) as any).old.instagram;
  await old('ig', '2601');
  // Meta does not let the account's key into the inbox: the old key is the only one, it cannot be removed yet
  probe.igReach = '(#3) no';
  assert.deepEqual(await key(), ['ig', 'ok', 'old', null]);
  assert.deepEqual(await oldHere(), { username: 'bebeconfort.dz', ready: false });
  probe.igReach = null;
  // the account's key reaches the inbox too: the old key still answers (nothing changes by itself), and the boutique is
  // told it may remove it to keep one single connection (Comptes offers « Retirer » from now on)
  assert.deepEqual(await key(), ['ig', 'ok', 'oldReady', null]);
  assert.deepEqual(await stored(), ['IGAA-CONNECTED-BEFORE', 'ig', false]);
  assert.deepEqual(await oldHere(), { username: 'bebeconfort.dz', ready: true });
  // one of Meta's Unified login: read on Facebook's side (its Instagram accounts)
  await old('unified', '178555');
  calls.length = 0;
  assert.deepEqual(await key(), ['ig', 'ok', 'oldReady', null]);
  assert.ok(calls.some((c) => /graph\.facebook\.com\/v23\.0\/me\/assigned_instagram_accounts/.test(c.url)));
  // Instagram refuses the old key and Meta does not let the account's key in either: red, « Relier » is the way
  await old('ig', '2601');
  probe.igRefuse = true;
  probe.igReach = '(#3) no';
  const dead = await key();
  assert.deepEqual(dead.slice(0, 3), ['ig', 'bad', 'oldBad']);
  assert.match(String(dead[3]), /refusé la clé/);
  assert.deepEqual(await stored(), ['IGAA-CONNECTED-BEFORE', 'ig', false]);
  // the old key refused, the account's key reaches the inbox: it takes over, the old one is forgotten
  probe.igReach = null;
  assert.deepEqual(await key(), ['ig', 'ok', 'fixed', null]);
  assert.deepEqual(await stored(), ['LONG_USER_TOKEN', 'unified', true]);
  assert.equal(((await call('social.list', a, {})) as any).old.instagram, null);
  probe.igRefuse = false;
});

test('« Tester », Publicité: each ad account and its state at Meta, its numbers, launching; a key pasted before in Réglages › Meta Ads; the catalogue, the pixels, WhatsApp', async () => {
  const karim = await karimOf();
  const run = async () => (await call('social.test', a, { linkId: karim.id })) as any;
  const find = (x: any, key: string) => x.checks.find((c: any) => c.key === key);
  // the ad account cannot be read: red (none can), and nothing more is tried on it
  probe.unreadable = ['act_3004'];
  let r = await run();
  assert.deepEqual([find(r, 'ads').state, find(r, 'ads').params, find(r, 'adsRead'), find(r, 'adsLaunch')], ['bad', { count: 1, bad: 1 }, undefined, undefined]);
  assert.match(find(r, 'ads').detail, /Bébé pub 2 — .*Pas d’accès/);
  probe.unreadable = [];
  // its state at Meta, in plain cases: disabled (red), in its grace period (to look at), a state Pilotix does not know
  probe.adStatus = { act_3004: 2 };
  assert.deepEqual([find(await run(), 'adsState').state, find(await run(), 'adsState').params], ['bad', { name: 'Bébé pub 2', why: 's2' }]);
  probe.adStatus = { act_3004: 9 };
  assert.deepEqual([find(await run(), 'adsState').state, find(await run(), 'adsState').params.why], ['warn', 's9']);
  probe.adStatus = { act_3004: 55 };
  assert.deepEqual([find(await run(), 'adsState').params.why, find(await run(), 'adsState').detail], ['sx', 'account_status 55']);
  probe.adStatus = undefined;
  assert.equal(find(await run(), 'adsState'), undefined);
  // launching: the permission to manage ads, and a role that may advertise in the account
  probe.scopes = [...ALL_PERMS, 'ads_management', 'pages_manage_ads', 'business_management'];
  probe.tasks = ['ANALYZE'];
  assert.deepEqual([find(await run(), 'adsLaunch').state, find(await run(), 'adsLaunch').params], ['warn', { name: 'Compte 3004', why: 'task' }]);
  probe.tasks = ['DRAFT', 'ANALYZE', 'ADVERTISE'];
  assert.equal(find(await run(), 'adsLaunch').state, 'ok');
  probe.tasks = undefined;
  // its ads' problems reach Co-Pilot only when the account is subscribed: one that was not is asked again
  await t.platform.query(`UPDATE platform.social_assets SET extra = jsonb_set(extra, '{hook}', 'false') WHERE link_id = $1 AND kind = 'ad_account'`, [karim.id]);
  r = await run();
  assert.deepEqual([find(r, 'adsHook').state, find(r, 'adsHook').params], ['ok', { name: 'Bébé pub 2', fixed: 1 }]);
  assert.equal(find(await run(), 'adsHook'), undefined);

  // the catalogue and the pixels are read with the boutique's ads key: the catalogue ticked in Facebook's window or not
  await setRaw(a.db, 'metacatalog', { catalogId: '424242', businessName: 'Bébé', pixelsLinked: true, at: '2026-11-01T00:00:00.000Z' });
  probe.catalog = { id: '424242' };
  r = await run();
  assert.deepEqual([find(r, 'catalog').group, find(r, 'catalog').state, find(r, 'catalog').params], ['catalog', 'ok', { name: 'Catalogue Bébé', count: 36 }]);
  probe.catalog = { id: '424242', refuse: true };
  assert.deepEqual([find(await run(), 'catalog').state, find(await run(), 'catalog').params], ['bad', { why: 'bad' }]);
  probe.granular = [{ scope: 'catalog_management', target_ids: ['111'] }];
  r = await run();
  assert.deepEqual([find(r, 'catalog').params, /Missing permissions/.test(find(r, 'catalog').detail)], [{ why: 'tick' }, true]);
  probe.granular = undefined;
  probe.catalog = { id: '424242' };
  const px = Number((await a.db.query(`INSERT INTO tracking_pixels (platform, name, pixel_id, is_default) VALUES ('meta', 'Pixel Bébé', '880001', true) RETURNING id`))[0].id);
  assert.deepEqual([find(await run(), 'pixel').group, find(await run(), 'pixel').state, find(await run(), 'pixel').params], ['pixels', 'ok', { name: 'Pixel Bébé' }]);
  probe.pixelRefuse = ['880001'];
  assert.equal(find(await run(), 'pixel').state, 'bad');
  // a pixel with a key of its own (Landing pages › Réglages) sends with it: said, not tried
  await setRaw(a.db, `secret_pixel_${px}`, 'EAA-PIXEL-OWN');
  assert.deepEqual([find(await run(), 'pixel').state, find(await run(), 'pixel').params.why], ['info', 'own']);
  await a.db.query(`DELETE FROM settings WHERE key = $1`, [`secret_pixel_${px}`]);
  probe.pixelRefuse = undefined;
  probe.scopes = undefined;

  // the boutique stops counting this account's ad accounts: said, with the way back (the switch above)
  await call('social.ads', a, { linkId: karim.id, on: false });
  r = await run();
  assert.deepEqual([find(r, 'adsOff').state, find(r, 'adsOff').params, find(r, 'ads'), find(r, 'catalog')], ['warn', { count: 1 }, undefined, undefined]);

  // A key pasted before in Réglages › Meta Ads (that form is gone): Publicité still runs on it. « Tester » tries it and
  // says how to bring the ads here; Comptes names it; the catalogue and the pixels are read with it
  await setRaw(a.db, 'secret_meta_token', 'EAA-PASTED-BEFORE');
  await a.db.query(`UPDATE settings SET value = $1 WHERE key = 'meta'`, [JSON.stringify({ adAccountId: '7007', hasToken: true })]);
  assert.deepEqual(((await call('social.list', a, {})) as any).old.ads, { adAccountId: '7007' });
  calls.length = 0;
  r = await run();
  assert.deepEqual([find(r, 'adsOld').group, find(r, 'adsOld').state, find(r, 'adsOld').params], ['ads', 'info', { name: 'Compte 7007', why: 'switch' }]);
  assert.ok(calls.some((c) => /act_7007\?/.test(c.url) && /access_token=EAA-PASTED-BEFORE/.test(c.url)), 'the old key itself was tried');
  assert.ok(calls.some((c) => /\/424242\?/.test(c.url) && /access_token=EAA-PASTED-BEFORE/.test(c.url)), 'the catalogue is read with the key Publicité uses');
  assert.deepEqual([find(r, 'catalog').state, find(r, 'pixel').state], ['ok', 'ok']);
  assert.ok(!JSON.stringify(r).includes('EAA-PASTED-BEFORE'));
  // Meta refuses the old key: red
  probe.unreadable = ['act_7007'];
  assert.deepEqual([find(await run(), 'adsOld').state, find(await run(), 'adsOld').params.why], ['bad', 'switchBad']);
  probe.unreadable = [];
  // « Les compter dans … »: the account's key takes its place; the pasted key is forgotten
  const on: any = await call('social.ads', a, { linkId: karim.id, on: true });
  assert.deepEqual([on.old.ads, on.here.ad_account.count], [null, 1]);
  assert.deepEqual([await setting(a, 'secret_meta_token'), (await setting(a, 'meta')).adAccountIds], ['LONG_USER_TOKEN', ['3004']]);
  assert.equal(find(await run(), 'adsOld'), undefined);
  // an account with no ad account (none ticked in Facebook's window): said, with what to tick
  const sara = await (async () => {
    const s: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
    graph = { me: { id: '5055', name: 'Sara Sans Pub' }, pages: [], ads: [] };
    assert.equal((await linked(t, 'meta', { code: 'NOADS', state: s.state }, URL0)).ok, true);
    return ((await call('social.list', a, {})) as any).links.find((x: any) => x.name === 'Sara Sans Pub');
  })();
  const alone = lines(await call('social.test', a, { linkId: sara.id }));
  // this boutique counts another account's ad accounts: said, nothing to do
  assert.deepEqual([alone['key.given'], alone['fb.pagesNone'], alone['ads.adsOther']], ['info', 'warn', 'info']);
  await call('social.ads', a, { linkId: karim.id, on: false });
  const none = lines(await call('social.test', a, { linkId: sara.id }));
  assert.deepEqual([none['ads.adsNone'], none['ads.adsRight:none']], ['warn', undefined]);
  // Facebook gave the key no right on ads at all (not even to read them): linking again only helps when the ad account
  // shows in Facebook's window — said, with where to look and whose side the block is on
  probe.scopes = ALL_PERMS.filter((x) => x !== 'ads_read');
  const noRight = lines(await call('social.test', a, { linkId: sara.id }));
  assert.deepEqual([noRight['ads.adsNone'], noRight['ads.adsRight:none']], ['warn', 'warn']);
  // … while Publicité runs on a key pasted before: nothing is broken, the same line only informs
  await setRaw(a.db, 'secret_meta_token', 'EAA-PASTED-BEFORE');
  await a.db.query(`UPDATE settings SET value = $1 WHERE key = 'meta'`, [JSON.stringify({ adAccountId: '7007', hasToken: true })]);
  const pasted = lines(await call('social.test', a, { linkId: sara.id }));
  assert.deepEqual([pasted['ads.adsOld:relink'], pasted['ads.adsRight:none'], pasted['ads.adsNone']], ['info', 'info', undefined]);
  probe.scopes = undefined;
  assert.equal(lines(await call('social.test', a, { linkId: sara.id }))['ads.adsRight:none'], undefined);
  await a.db.query(`DELETE FROM settings WHERE key = 'secret_meta_token'`);
  await call('social.remove', a, { linkId: sara.id });
  await call('social.ads', a, { linkId: karim.id, on: true });

  // WhatsApp, in the same test: the boutique's number read with its key, and when Meta last sent something for it
  assert.equal(find(await run(), 'wa'), undefined);
  await setRaw(a.db, 'secret_dellal_wa_token', 'EAA-WA-KEY');
  await setRaw(a.db, 'dellal', { ...(await setting(a, 'dellal')), whatsappPhoneId: '109911', whatsappPhone: '+213 550 11 22 33' });
  r = await run();
  assert.deepEqual([find(r, 'wa').group, find(r, 'wa').state, find(r, 'waSeen').state], ['wa', 'ok', 'warn']);
  await t.platform.query(`INSERT INTO platform.social_hooks (object, ext_id, routed, what) VALUES ('whatsapp_business_account', '109911', true, 'message')`);
  assert.equal(find(await run(), 'waSeen').state, 'ok');
  assert.ok(!JSON.stringify(await run()).includes('EAA-WA-KEY'));
  await call('social.waRemove', a, {});
  await t.platform.query(`DELETE FROM platform.social_hooks WHERE object = 'whatsapp_business_account' AND ext_id = '109911'`);
  await a.db.query(`DELETE FROM settings WHERE key = 'metacatalog'`);
  await a.db.query(`DELETE FROM tracking_pixels WHERE id = $1`, [px]);
});

test('a key pasted before in Réglages › Meta Ads: linking the account again with its ad accounts takes its place, and new ads keep leaving from the same ad account', async () => {
  // boutique A counted no ad account of its linked account; its ads ran on a pasted key, from ad account 3005
  const karim = await karimOf();
  await call('social.ads', a, { linkId: karim.id, on: false });
  await a.db.query(`DELETE FROM settings WHERE key = 'ads_launch_account'`);
  await setRaw(a.db, 'secret_meta_token', 'EAA-PASTED-BEFORE');
  await a.db.query(`UPDATE settings SET value = $1 WHERE key = 'meta'`, [JSON.stringify({ adAccountId: '3005', hasToken: true })]);
  // « Relier », every ad account ticked this time (3005 is not the first of them)
  const s: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
  const act = (id: string, name: string) => ({ id: `act_${id}`, account_id: id, name, currency: 'USD', account_status: 1 });
  graph = { me: { id: '5001', name: 'Karim Benali' }, pages: [{ id: '9002', name: 'Bébé Confort DZ', access_token: 'PAGE_TOKEN_2', instagram_business_account: { id: '178002', username: 'bebeconfort.dz' } }], ads: [act('3004', 'Bébé pub 2'), act('3005', 'Promo')] };
  assert.equal((await linked(t, 'meta', { code: 'ALL_TICKED', state: s.state }, URL0)).ok, true);
  // the account is this boutique's own: its ad accounts are counted at once, with its key; the pasted key is gone
  const list: any = await call('social.list', a, {});
  assert.deepEqual([list.old.ads, list.here.ad_account.count], [null, 2]);
  assert.equal(await setting(a, 'secret_meta_token'), 'LONG_USER_TOKEN');
  // 3005 stays the ad account new ads leave from; both are counted
  assert.deepEqual([(await setting(a, 'meta')).adAccountId, (await setting(a, 'meta')).adAccountIds, list.launch.id], ['3005', ['3005', '3004'], '3005']);
  // back to one ad account for the tests that follow
  const s2: any = await call('social.start', a, { provider: 'meta', scope: 'here' });
  graph = { ...graph, ads: [act('3004', 'Bébé pub 2')] };
  assert.equal((await linked(t, 'meta', { code: 'ONE', state: s2.state }, URL0)).ok, true);
  assert.deepEqual((await setting(a, 'meta')).adAccountIds, ['3004']);
});

test('a business key (« system user ») lists its ad accounts as the ones it was given', async () => {
  await p('p.social.apps.save', { meta: { ...APPS.meta, configId: '777000111', secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });
  refuseSwap = true;
  try {
    const s: any = await call('social.start', b, { provider: 'meta', scope: 'here' });
    graph = { me: { id: '5200', name: 'PILOTIX APP System User' }, pages: [{ id: '9950', name: 'Bébé Oran Pro', access_token: 'PAGE_TOKEN_50' }], ads: [], assigned: [{ id: 'act_3090', account_id: '3090', name: 'Oran pub', currency: 'USD', account_status: 1 }] };
    assert.equal((await linked(t, 'meta', { code: 'SYS_ADS', state: s.state }, URL0)).ok, true);
    const l = ((await call('social.list', b, {})) as any).links.find((x: any) => x.name === 'PILOTIX APP System User');
    assert.deepEqual(l.assets.filter((x: any) => x.kind === 'ad_account').map((x: any) => [x.name, x.usedHere]), [['Oran pub', true]]);
    assert.equal(await setting(b, 'secret_meta_token'), 'SHORT_USER_TOKEN');
    await call('social.remove', b, { linkId: l.id });
  } finally {
    refuseSwap = false;
    await p('p.social.apps.save', { meta: { ...APPS.meta, configId: '', secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });
  }
});

/** Meta's two doors, opened and closed around a test (the control room's ads configuration). */
const twoDoorsOn = () => p('p.social.apps.save', { meta: { ...APPS.meta, configId: '777000111', adsConfigId: '777000222', secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });
const twoDoorsOff = () => p('p.social.apps.save', { meta: { ...APPS.meta, configId: '', secret: '' }, tiktok: { ...APPS.tiktok, secret: '' } });
const subscriptions = () => calls.filter((c) => c.method === 'POST' && /\/subscribed_apps$/.test(new URL(c.url).pathname)).map((c) => `${new URL(c.url).pathname.split('/').slice(-2)[0]}${/method=delete/.test(c.body) ? ':stop' : ''}`);

test('Meta’s two doors: « Facebook et Instagram » keeps the boutique’s one Page (asked when Facebook gave several), never an ad account; « Publicité Meta » is a connection of its own, with its own key', async () => {
  // one configuration for everything: the second window is not offered, and asking for it says why
  assert.equal(((await call('social.list', b, {})) as any).adsReady, false);
  await assert.rejects(() => call('social.start', b, { provider: 'meta', kind: 'ads' }), /Publicité n’est pas encore prête/);
  await assert.rejects(() => call('social.start', b, { provider: 'tiktok', kind: 'ads' }), /Seul Meta/);
  const saved: any = await twoDoorsOn();
  assert.equal(saved.meta.adsConfigId, '777000222');
  assert.equal(((await call('social.list', b, {})) as any).adsReady, true);
  const adsKeyBefore = await setting(b, 'secret_meta_token');
  // a Page another boutique answers on: Facebook's window may give it too
  const theirs = (await t.platform.query(`SELECT u.ext_id FROM platform.social_uses u WHERE u.kind = 'page' AND u.shop_id = $1`, [a.shop!.id]))[0];
  assert.ok(theirs, 'the other boutique answers on a Page');
  refuseSwap = true;
  try {
    // door 1, « Facebook et Instagram »: the first configuration's window, for this boutique alone (never « all »)
    const s1: any = await call('social.start', b, { provider: 'meta', scope: 'all' });
    assert.equal(new URL(s1.url).searchParams.get('config_id'), '777000111');
    assert.equal(Number((await t.platform.query(`SELECT shop_id FROM platform.social_states WHERE state = $1`, [s1.state]))[0].shop_id), b.shop!.id);
    // Facebook's window gave several Pages, and its key would list an ad account too
    graph = {
      me: { id: '5300', name: 'PILOTIX APP System User' },
      pages: [
        { id: '9960', name: 'Bébé Oran Deux', access_token: 'PAGE_TOKEN_60', instagram_business_account: { id: '178960', username: 'oran.deux' } },
        { id: '9961', name: 'Une autre page', access_token: 'PAGE_TOKEN_61' },
        ...(theirs ? [{ id: String(theirs.ext_id), name: 'La page d’Alger', access_token: 'PAGE_TOKEN_A' }] : []),
      ],
      ads: [],
      assigned: [{ id: 'act_3190', account_id: '3190', name: 'Oran pub deux', currency: 'USD', account_status: 1 }],
    };
    codeToken = 'DOOR_1_KEY';
    calls.length = 0;
    const back = await finishLogin(t, 'meta', { code: 'DOOR_1', state: s1.state }, URL0);
    assert.equal(back.ok, true);
    assert.deepEqual(back.confirm!.pages!.map((x) => [x.id, x.ig, !!x.taken]), [['9960', 'oran.deux', false], ['9961', null, false], ...(theirs ? [[String(theirs.ext_id), null, true]] : [])]);
    assert.deepEqual(back.confirm!.assets, []);
    assert.deepEqual(subscriptions(), [], 'nothing is listened to before the boutique chose its Page');
    const html = loginPage(back);
    assert.match(html, /Quelle page est celle de cette boutique/);
    assert.match(html, /name="page" value="9960"/);
    assert.match(html, /garde une seule page par boutique/);
    if (theirs) assert.match(html, /Répond déjà pour/);
    // no Page chosen: the question stays open; another boutique's Page: refused in the test below
    assert.match((await confirmLogin(t, back.confirm!.state, back.confirm!.key, true)).message, /Choisissez la page/);
    const end = await confirmLogin(t, back.confirm!.state, back.confirm!.key, true, '9960');
    assert.deepEqual([end.ok, end.account], [true, 'Bébé Oran Deux']);
    const l1: any = await call('social.list', b, {});
    const mine = l1.links.filter((x: any) => x.name === 'PILOTIX APP System User');
    assert.deepEqual(mine.map((x: any) => [x.part, x.scope, x.assets.map((y: any) => `${y.kind}:${y.name}:${y.usedHere}`)]), [['main', 'here', ['page:Bébé Oran Deux:true']]]);
    assert.equal(l1.here.page.name, 'Bébé Oran Deux');
    assert.deepEqual(l1.links.filter((x: any) => x.provider === 'meta' && x.part === 'main' && x.scope === 'here').length, 1, 'one boutique, one Page: its other Facebook accounts went');
    // the kept Page alone is subscribed; the other one, held nowhere in Pilotix, is no longer listened to
    assert.deepEqual(subscriptions().sort(), ['178960', '9960', '9961:stop']);
    assert.equal(await setting(b, 'secret_dellal_page_token'), 'PAGE_TOKEN_60');
    assert.equal(await setting(b, 'secret_meta_token'), adsKeyBefore, 'the first door never touches Publicité');
    // door 2, « Publicité Meta »: its own window (the second configuration); its state says which login it is
    const s2: any = await call('social.start', b, { provider: 'meta', scope: 'here', kind: 'ads' });
    assert.ok(s2.state.startsWith('ads.'));
    const u2 = new URL(s2.url);
    assert.equal(u2.searchParams.get('config_id'), '777000222');
    assert.equal(u2.searchParams.get('scope'), null, 'the configuration says what is asked');
    // the same Facebook account comes back with the door's own key: a connection of its own, the ad accounts only
    codeToken = 'DOOR_2_KEY';
    calls.length = 0;
    assert.equal((await linked(t, 'meta', { code: 'DOOR_2', state: s2.state }, URL0)).ok, true);
    assert.deepEqual(subscriptions().filter((x) => !x.startsWith('act_')), [], 'no Page is touched by the ads’ door');
    const l2: any = await call('social.list', b, {});
    const both = l2.links.filter((x: any) => x.name === 'PILOTIX APP System User');
    assert.deepEqual(both.map((x: any) => [x.part, x.assets.map((y: any) => `${y.kind}:${y.name}`)]), [['main', ['page:Bébé Oran Deux']], ['ads', ['ad_account:Oran pub deux']]]);
    const [pageLink, adsLink] = both;
    if (!adsKeyBefore) {
      assert.equal(adsLink.assets[0].usedHere, true, 'its ads are counted at once');
      assert.equal(await setting(b, 'secret_meta_token'), 'DOOR_2_KEY');
    } else await call('social.ads', b, { linkId: adsLink.id, on: true });
    assert.equal(await setting(b, 'secret_meta_token'), 'DOOR_2_KEY', 'Publicité runs on the ads’ own key');
    assert.equal(await setting(b, 'secret_dellal_page_token'), 'PAGE_TOKEN_60', 'the Page keeps its key');
    // the Page linked again (a new key for it): the ads keep theirs
    codeToken = 'DOOR_1_KEY_AGAIN';
    graph = { ...graph, pages: [{ id: '9960', name: 'Bébé Oran Deux', access_token: 'PAGE_TOKEN_60_B', instagram_business_account: { id: '178960', username: 'oran.deux' } }] };
    const s3: any = await call('social.start', b, { provider: 'meta', scope: 'here' });
    const back3 = await finishLogin(t, 'meta', { code: 'DOOR_1_AGAIN', state: s3.state }, URL0);
    assert.equal(back3.confirm!.pages!.length, 1);
    assert.equal(back3.confirm!.was ?? null, null, 'the same Page: nothing is replaced');
    assert.doesNotMatch(loginPage(back3), /Quelle page/);
    assert.equal((await confirmLogin(t, back3.confirm!.state, back3.confirm!.key, true)).ok, true, 'one Page: no choice to make');
    assert.equal(await setting(b, 'secret_dellal_page_token'), 'PAGE_TOKEN_60_B');
    assert.equal(await setting(b, 'secret_meta_token'), 'DOOR_2_KEY');
    const l3: any = await call('social.list', b, {});
    assert.deepEqual(l3.links.filter((x: any) => x.name === 'PILOTIX APP System User').map((x: any) => [x.id, x.part]), [[pageLink.id, 'main'], [adsLink.id, 'ads']]);
    // « Tester »: each connection answers for its own part
    const keysOf = async (linkId: number) => ((await call('social.test', b, { linkId })) as any).checks.map((c: any) => c.key);
    const k1 = await keysOf(pageLink.id);
    assert.ok(k1.includes('page') && !k1.includes('adsNone') && !k1.includes('adsRight'), k1.join());
    const k2 = await keysOf(adsLink.id);
    assert.ok(k2.includes('ads') && !k2.includes('pageNone') && !k2.includes('pagesNone') && !k2.includes('page'), k2.join());
    // a Page that already answers for another boutique cannot be taken
    if (theirs) {
      graph = { ...graph, pages: [{ id: String(theirs.ext_id), name: 'La page d’Alger', access_token: 'PAGE_TOKEN_A' }] };
      const s4: any = await call('social.start', b, { provider: 'meta', scope: 'here' });
      assert.match((await finishLogin(t, 'meta', { code: 'DOOR_1_THEIRS', state: s4.state }, URL0)).message, /répond déjà pour/);
    }
    // Facebook gave no Page: said in plain words, nothing changes
    graph = { ...graph, pages: [] };
    const s5: any = await call('social.start', b, { provider: 'meta', scope: 'here' });
    assert.match((await finishLogin(t, 'meta', { code: 'DOOR_1_NONE', state: s5.state }, URL0)).message, /aucune page/);
    assert.equal(((await call('social.list', b, {})) as any).here.page.name, 'Bébé Oran Deux');
    await call('social.remove', b, { linkId: adsLink.id });
    await call('social.remove', b, { linkId: pageLink.id });
  } finally {
    refuseSwap = false;
    codeToken = 'SHORT_USER_TOKEN';
    await twoDoorsOff();
  }
  assert.equal(((await p('p.social.apps', {})) as any).meta.adsConfigId, '', 'saved without it: one login for everything again');
});

test('the two doors, an account linked before them: its ad accounts move to a connection of their own with the key they had; a business key whose list is empty still shows its Page', async () => {
  // before the two doors: one login brought the Page and the ad account, on one key
  graph = { me: { id: '5400', name: 'Nadia Oran' }, pages: [{ id: '9970', name: 'Page de Nadia', access_token: 'PAGE_TOKEN_70' }], ads: [{ id: 'act_3200', account_id: '3200', name: 'Pub de Nadia', currency: 'USD', account_status: 1 }] };
  const s0: any = await call('social.start', b, { provider: 'meta', scope: 'here' });
  assert.equal((await linked(t, 'meta', { code: 'BEFORE', state: s0.state }, URL0)).ok, true);
  const before: any = ((await call('social.list', b, {})) as any).links.find((x: any) => x.name === 'Nadia Oran');
  assert.deepEqual(before.assets.map((x: any) => x.kind).sort(), ['ad_account', 'page']);
  await call('social.use', b, { assetId: before.assets.find((x: any) => x.kind === 'page').id });
  await call('social.ads', b, { linkId: before.id, on: true });
  assert.equal(await setting(b, 'secret_meta_token'), 'LONG_USER_TOKEN');
  await twoDoorsOn();
  refuseSwap = true;
  try {
    // « Facebook et Instagram » again, with the two doors: a business key now, whose own list of Pages comes back empty
    // (Facebook still says which Page its rights were given for)
    codeToken = 'CONTENT_KEY';
    graph = { me: { id: '5400', name: 'Nadia Oran' }, pages: [], ads: [], assigned: [], byId: { '9970': { id: '9970', name: 'Page de Nadia', access_token: 'PAGE_TOKEN_70_B' } } };
    probe = { ...probe, granular: [{ scope: 'pages_show_list', target_ids: ['9970'] }, { scope: 'pages_messaging', target_ids: ['9970'] }] };
    const s1: any = await call('social.start', b, { provider: 'meta', scope: 'here' });
    assert.equal((await linked(t, 'meta', { code: 'AFTER', state: s1.state }, URL0)).ok, true);
    const now: any = await call('social.list', b, {});
    const mine = now.links.filter((x: any) => x.name === 'Nadia Oran');
    assert.deepEqual(mine.map((x: any) => [x.part, x.assets.map((y: any) => `${y.kind}:${y.name}:${y.usedHere}`)]).sort(), [['ads', ['ad_account:Pub de Nadia:true']], ['main', ['page:Page de Nadia:true']]]);
    assert.equal(mine.find((x: any) => x.part === 'main').id, before.id, 'the Facebook account is the same one');
    // Publicité keeps running on the key it had; the Page answers with its new one
    assert.equal(await setting(b, 'secret_meta_token'), 'LONG_USER_TOKEN');
    assert.equal(await setting(b, 'secret_dellal_page_token'), 'PAGE_TOKEN_70_B');
    assert.equal(Number(((await setting(b, 'social_ads')) as any).linkId), mine.find((x: any) => x.part === 'ads').id);
    assert.equal(now.here.ad_account.name, 'Pub de Nadia');
    // a pasted ads key of the very same Facebook account: an ads connection, it never replaces the Page's key
    const key = `EAAG${'z'.repeat(60)}`;
    probe = { ...probe, keyValid: true, keyApp: APPS.meta.appId, scopes: ['ads_read', 'ads_management'], keyType: 'SYSTEM_USER' };
    graph = { ...graph, assigned: [{ id: 'act_3200', account_id: '3200', name: 'Pub de Nadia', currency: 'USD', account_status: 1 }] };
    const r: any = await call('social.adsKey', b, { token: key });
    const after = r.list.links.filter((x: any) => x.name === 'Nadia Oran');
    assert.deepEqual(after.map((x: any) => [x.part, x.assets.map((y: any) => y.kind).join()]).sort(), [['ads', 'ad_account'], ['main', 'page']]);
    assert.equal(r.linkId, mine.find((x: any) => x.part === 'ads').id, 'the same ads connection, with its new key');
    assert.equal(await setting(b, 'secret_dellal_page_token'), 'PAGE_TOKEN_70_B');
    assert.equal(await setting(b, 'secret_meta_token'), key);
    for (const l of after) await call('social.remove', b, { linkId: l.id });
  } finally {
    refuseSwap = false;
    codeToken = 'SHORT_USER_TOKEN';
    probe = { ...probe, granular: undefined, keyValid: undefined, keyApp: undefined, keyType: undefined, scopes: undefined };
    await twoDoorsOff();
  }
});

test('« Coller une clé Meta Ads »: Meta is asked about the key; its ad accounts join the boutique like a linked account; a wrong key is refused in plain words', async () => {
  const key = `EAAG${'x'.repeat(60)}`;
  const before = ((await call('social.list', b, {})) as any).links.length;
  try {
    // dead, of another app, without an ads permission, or with no ad account: refused, nothing kept
    probe = { ...probe, keyValid: false };
    await assert.rejects(() => call('social.adsKey', b, { token: key }), /Meta refuse cette clé/);
    probe = { ...probe, keyValid: true, keyApp: '999', scopes: ['ads_read'] };
    await assert.rejects(() => call('social.adsKey', b, { token: key }), /autre app/);
    probe = { ...probe, keyApp: APPS.meta.appId, scopes: ['pages_show_list'] };
    await assert.rejects(() => call('social.adsKey', b, { token: key }), /permission des publicités/);
    probe = { ...probe, scopes: ['ads_read', 'ads_management'], keyType: 'SYSTEM_USER' };
    graph = { me: { id: '6100', name: 'pilotix' }, pages: [], ads: [], assigned: [] };
    await assert.rejects(() => call('social.adsKey', b, { token: key }), /aucun compte publicitaire/);
    await assert.rejects(() => call('social.adsKey', b, { token: 'trop court' }));
    assert.equal(((await call('social.list', b, {})) as any).links.length, before);
    // the right key: its account in the list, the key kept on the server only; its ad account is used once ticked (the
    // page opens « Changer » by itself)
    graph = { ...graph, assigned: [{ id: 'act_4100', account_id: '4100', name: 'Clé pub', currency: 'USD', account_status: 1 }] };
    const r: any = await call('social.adsKey', b, { token: key });
    const l = r.list.links.find((x: any) => x.id === r.linkId);
    assert.equal(l.name, 'pilotix');
    assert.deepEqual(l.assets.map((x: any) => [x.kind, x.name, x.usedHere]), [['ad_account', 'Clé pub', false]]);
    assert.notEqual(await setting(b, 'secret_meta_token'), key, 'nothing used before it is ticked');
    const ticked: any = await call('social.adsPick', b, { linkId: r.linkId, ids: ['4100'] });
    assert.deepEqual(ticked.links.find((x: any) => x.id === r.linkId).assets.map((x: any) => [x.kind, x.name, x.usedHere]), [['ad_account', 'Clé pub', true]]);
    assert.equal(await setting(b, 'secret_meta_token'), key);
    assert.ok(!JSON.stringify(r).includes(key), 'the key never comes back to a page');
    const row = (await t.platform.query(`SELECT token_kind, expires_at, shop_id FROM platform.social_links WHERE id = $1`, [r.linkId]))[0];
    assert.deepEqual([row.token_kind, row.expires_at, Number(row.shop_id)], ['system', null, b.shop!.id]);
    await call('social.remove', b, { linkId: r.linkId });
    assert.equal(await setting(b, 'secret_meta_token'), null);
  } finally {
    probe = { ...probe, keyValid: undefined, keyApp: undefined, keyType: undefined, scopes: undefined };
  }
});

test('the preview: « Publicité Meta » links a sample ad account, a pasted key too', async () => {
  resetSocialDemo();
  let now = Date.parse('2026-11-19T12:00:00Z');
  const demo: Ctx = { ...a, t: undefined, server: undefined, now: () => now };
  const first: any = await call('social.list', demo, {});
  assert.equal(first.adsReady, true, 'the preview shows Meta in two steps');
  const s: any = await call('social.start', demo, { provider: 'meta', scope: 'here', kind: 'ads' });
  now += 2500;
  const done: any = await call('social.state', demo, { state: s.state });
  assert.equal(done.status, 'done');
  const withAds: any = await call('social.list', demo, {});
  // several sample ad accounts, none ticked yet: the page opens « Changer » by itself (live, the login's tab asks it)
  const sara = withAds.links.find((x: any) => x.id === done.linkId);
  assert.deepEqual(sara.assets.map((x: any) => `${x.kind}:${x.usedHere}`), ['ad_account:false', 'ad_account:false', 'ad_account:false']);
  const two = sara.assets.slice(0, 2).map((x: any) => x.extId);
  const picked: any = await call('social.adsPick', demo, { linkId: done.linkId, ids: two });
  assert.deepEqual(picked.links.find((x: any) => x.id === done.linkId).assets.map((x: any) => x.usedHere), [true, true, false]);
  assert.deepEqual([picked.here.ad_account.count, picked.launch.accounts.map((x: any) => x.id)], [2, two]);
  // the other account's ad accounts stop here: a boutique's come from one account
  assert.ok(picked.links.filter((x: any) => x.id !== done.linkId).every((x: any) => x.assets.every((y: any) => y.kind !== 'ad_account' || !y.usedHere)));
  const none: any = await call('social.adsPick', demo, { linkId: done.linkId, ids: [] });
  assert.equal(none.here.ad_account, null);
  const k: any = await call('social.adsKey', demo, { token: `EAAG${'y'.repeat(40)}` });
  assert.equal(k.list.links.length, withAds.links.length + 1);
  assert.deepEqual(k.list.links.find((x: any) => x.id === k.linkId).assets.map((x: any) => x.kind), ['ad_account']);
  resetSocialDemo();
});

test('the preview: « Tester » answers a sample for each connection, the ad accounts switch off and on', async () => {
  resetSocialDemo();
  const demo: Ctx = { ...a, t: undefined, server: undefined };
  const first: any = await call('social.list', demo, {});
  assert.deepEqual(first.here.ad_account, { name: 'Bébé Confort — publicité', account: 'Alaeddine Benali', count: 2 });
  const [page, ads] = first.links;
  assert.deepEqual([page.part, page.assets.length, ads.part, ads.assets.length], ['main', 1, 'ads', 5]);
  // part by part, as on the server: the page folds the parts that work and opens the one with a problem
  const r: any = await call('social.test', demo, { linkId: page.id });
  assert.ok(r.checks.every((c: any) => c.state === 'ok'));
  assert.deepEqual([...new Set(r.checks.map((c: any) => c.group))], ['key', 'fb', 'ig', 'forms', 'content']);
  const r2: any = await call('social.test', demo, { linkId: ads.id });
  assert.deepEqual([...new Set(r2.checks.map((c: any) => c.group))], ['key', 'ads', 'catalog', 'pixels']);
  // the sample pictures: the Page's and its Instagram account's, the business portfolio of the ad accounts
  assert.ok(page.assets[0].picture?.startsWith('data:image/svg+xml') && page.assets[0].igPicture?.startsWith('data:image/svg+xml'));
  assert.deepEqual(ads.assets.map((x: any) => x.business?.name), Array(5).fill('Bébé Confort SARL'));
  assert.deepEqual([first.old, first.whatsapp, first.waReady], [{ ads: null, instagram: null }, null, true]);
  // « Tester » tries the ticked ones
  assert.equal(r2.checks.find((c: any) => c.key === 'ads').params.count, 2);
  const off: any = await call('social.ads', demo, { linkId: ads.id, on: false });
  assert.equal(off.here.ad_account, null);
  const on: any = await call('social.ads', demo, { linkId: ads.id, on: true });
  assert.equal(on.here.ad_account.count, 5);
  resetSocialDemo();
});

test('Instagram’s own login: its webhooks (another number, maybe) go to the boutique that linked it; unlinked, to none', async () => {
  assert.deepEqual(await routeMeta(t, { object: 'instagram', entry: [{ id: '178999' }] }), []);
  await noteIgLogin(t, a.shop!.id, '178999', 'bebeconfort.dz');
  assert.deepEqual((await routeMeta(t, { object: 'instagram', entry: [{ id: '178999', messaging: [] }] })).map((r) => r.shopId), [a.shop!.id]);
  // one account per boutique: a new one replaces it
  await noteIgLogin(t, a.shop!.id, '178888', 'bebeconfort.dz');
  assert.deepEqual(await routeMeta(t, { object: 'instagram', entry: [{ id: '178999' }] }), []);
  assert.deepEqual((await routeMeta(t, { object: 'instagram', entry: [{ id: '178888' }] })).map((r) => r.shopId), [a.shop!.id]);
  await noteIgLogin(t, a.shop!.id, '', '');
  assert.deepEqual(await routeMeta(t, { object: 'instagram', entry: [{ id: '178888' }] }), []);
});

// ---------------------------------------------------------------- Meta's data deletion request
/** A signed_request as Meta sends it: « signature.payload », both base64url, HMAC-SHA256 with the app secret. */
const signed = (payload: object, secret = APPS.meta.secret) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${createHmac('sha256', secret).update(body).digest('base64url')}.${body}`;
};
test('Meta’s data deletion request: signed with the app secret, the person’s linked accounts go, Meta gets a code and a page', async () => {
  refuseSwap = false;
  probe.refuse = false;
  const c = await as(await store('Bébé Annaba', SELLER));
  const s: any = await call('social.start', c, { provider: 'meta', scope: 'here' });
  graph = { me: { id: '7007', name: 'Sara Meziane' }, pages: [{ id: '9100', name: 'Bébé Annaba DZ', access_token: 'PAGE_TOKEN_9' }], ads: [] };
  assert.equal((await linked(t, 'meta', { code: 'C9', state: s.state }, URL0)).ok, true);
  assert.equal(await setting(c, 'secret_dellal_page_token'), 'PAGE_TOKEN_9');

  // not signed with Pilotix's secret, changed on the way, another algorithm, or no signature: nothing goes
  const ok = { algorithm: 'HMAC-SHA256', issued_at: 1790000000, user_id: '7007' };
  await assert.rejects(() => metaDeletion(t, signed(ok, 'another-secret'), URL0), /Signature Meta invalide/);
  const [sig, body] = signed(ok).split('.');
  assert.equal(parseSignedRequest(`${sig}.${Buffer.from(JSON.stringify({ ...ok, user_id: '5001' })).toString('base64url')}`, APPS.meta.secret), null);
  assert.equal(parseSignedRequest(signed({ ...ok, algorithm: 'HMAC-SHA1' }), APPS.meta.secret), null);
  assert.equal(parseSignedRequest(body, APPS.meta.secret), null);
  assert.equal(parseSignedRequest(signed(ok), ''), null);
  assert.equal(parseSignedRequest(signed(ok), APPS.meta.secret)?.user_id, '7007');
  assert.equal((await call('social.list', c, {})).links.length, 1);

  // the right one: the person's account, its token and its Page go, the boutique stops using them
  const r = await metaDeletion(t, signed(ok), URL0);
  assert.match(r.confirmation_code, /^[A-F0-9]{20}$/);
  assert.equal(r.url, `${URL0}/api/hooks/meta-deletion/${r.confirmation_code}`);
  assert.equal(r.removed, 1);
  assert.equal((await call('social.list', c, {})).links.length, 0);
  assert.equal(await setting(c, 'secret_dellal_page_token'), null);
  assert.equal((await t.platform.query(`SELECT count(*)::int AS n FROM platform.social_links WHERE ext_id = '7007'`))[0].n, 0);
  // the other people's accounts stay
  assert.ok((await call('social.list', a, {})).links.length > 0);

  // the page Meta gives the person: done, when, how many; nothing about who
  const page = await deletionPage(t, r.confirmation_code.toLowerCase());
  assert.equal(page.found, true);
  assert.match(page.html, new RegExp(`${r.confirmation_code}</bdi>: done on <bdi>\\d{4}-\\d{2}-\\d{2}</bdi>`));
  assert.match(page.html, /deleted the Facebook accounts you had linked \(1\)/);
  assert.ok(!page.html.includes('7007') && !page.html.includes('Sara'));
  assert.equal((await deletionPage(t, 'NOPE1234')).found, false);
  assert.equal((await deletionPage(t, '<script>')).found, false);
  // a person with nothing linked still gets a code, and the page says nothing was kept
  const none = await metaDeletion(t, signed({ ...ok, user_id: '8008' }), URL0);
  assert.equal(none.removed, 0);
  assert.match((await deletionPage(t, none.confirmation_code)).html, /there was nothing to delete/);
  // only the code is kept, never the person's id
  const row = (await t.platform.query(`SELECT * FROM platform.social_deletions WHERE code = $1`, [r.confirmation_code]))[0];
  assert.deepEqual(Object.keys(row).sort(), ['at', 'code', 'provider', 'removed']);
});

test('Pilot AI › Comptes shows the pictures: the Page’s and its Instagram account’s, the business portfolio of the ad accounts; « Tester » reads them again', async () => {
  const c = await as(await store('Bébé Sétif', SELLER));
  const s: any = await call('social.start', c, { provider: 'meta', scope: 'here' });
  graph = {
    me: { id: '5301', name: 'Nadia Sétif' },
    pages: [{ id: '9301', name: 'Bébé Sétif', access_token: 'PAGE_TOKEN_31', picture: { data: { url: 'https://fb.test/page-1.jpg' } }, instagram_business_account: { id: '178301', username: 'bebe.setif' } }],
    ads: [{ id: 'act_4301', account_id: '4301', name: 'Sétif pub', currency: 'USD', account_status: 1 }],
    byId: { '178301': { id: '178301', profile_picture_url: 'https://ig.test/ig-1.jpg' } },
    business: { act_4301: { id: '880', name: 'Wesh Vision', profile_picture_uri: 'https://fb.test/wv-1.jpg' } },
  };
  assert.equal((await linked(t, 'meta', { code: 'LOOKS', state: s.state }, URL0)).ok, true);
  const mine = async () => ((await call('social.list', c, {})) as any).links.find((x: any) => x.name === 'Nadia Sétif');
  const l = await mine();
  const page = l.assets.find((x: any) => x.kind === 'page');
  assert.deepEqual([page.picture, page.igUsername, page.igPicture], ['https://fb.test/page-1.jpg', 'bebe.setif', 'https://ig.test/ig-1.jpg']);
  assert.deepEqual(l.assets.find((x: any) => x.kind === 'ad_account').business, { name: 'Wesh Vision', picture: 'https://fb.test/wv-1.jpg' });
  // Meta changed the addresses, and refuses the business picture (no business permission): « Tester » keeps what it can
  graph.byId = { '9301': { id: '9301', picture: { data: { url: 'https://fb.test/page-2.jpg' } } }, '178301': { id: '178301', profile_picture_url: 'https://ig.test/ig-2.jpg' } };
  graph.business = { act_4301: { id: '880', name: 'Wesh Vision SARL', profile_picture_uri: 'https://fb.test/wv-2.jpg' } };
  probe.bizPicRefuse = true;
  try {
    await call('social.test', c, { linkId: l.id });
    const again = await mine();
    const p2 = again.assets.find((x: any) => x.kind === 'page');
    assert.deepEqual([p2.picture, p2.igPicture], ['https://fb.test/page-2.jpg', 'https://ig.test/ig-2.jpg']);
    assert.deepEqual(again.assets.find((x: any) => x.kind === 'ad_account').business, { name: 'Wesh Vision SARL', picture: null });
    // only a https address is kept as a picture
    probe.bizPicRefuse = false;
    graph.business = { act_4301: { id: '880', name: 'Wesh Vision', profile_picture_uri: 'javascript:alert(1)' } };
    await call('social.test', c, { linkId: l.id });
    assert.deepEqual((await mine()).assets.find((x: any) => x.kind === 'ad_account').business, { name: 'Wesh Vision', picture: null });
    // Meta says nothing about the business portfolio: what was read before stays
    graph.business = {};
    await call('social.test', c, { linkId: l.id });
    assert.equal((await mine()).assets.find((x: any) => x.kind === 'ad_account').business.name, 'Wesh Vision');
    assert.ok(!/PAGE_TOKEN/.test(JSON.stringify(await mine())), 'no token reaches the page');
  } finally {
    probe.bizPicRefuse = undefined;
    graph.business = undefined;
    await call('social.remove', c, { linkId: l.id });
  }
});

test('« Publicité Meta »: the login’s tab asks which ad accounts the boutique uses, and only the ticked ones are used; one Facebook brings later comes unticked; « Changer » ticks others', async () => {
  await twoDoorsOn();
  const acct = (id: string, name: string, currency = 'USD') => ({ id: `act_${id}`, account_id: id, name, currency, account_status: 1 });
  let linkId = 0;
  try {
    graph = { me: { id: '5800', name: 'Ala Ads' }, pages: [], ads: [acct('3301', 'babyjoydz velo'), acct('3302', 'Mighty prod'), acct('3303', 'baby product', 'DZD')] };
    const s: any = await call('social.start', a, { provider: 'meta', scope: 'here', kind: 'ads' });
    const back = await finishLogin(t, 'meta', { code: 'ADS_PICK', state: s.state }, URL0);
    assert.equal(back.ok, true);
    // the tab: one box per ad account, none ticked (the boutique uses none of them today); not listed twice
    assert.deepEqual(back.confirm!.assets, []);
    assert.deepEqual(back.confirm!.ads!.map((x) => [x.id, x.name, x.currency, x.on]), [['3301', 'babyjoydz velo', 'USD', false], ['3302', 'Mighty prod', 'USD', false], ['3303', 'baby product', 'DZD', false]]);
    const html = loginPage(back);
    assert.match(html, /Quels comptes publicitaires Pilotix utilise dans cette boutique/);
    assert.match(html, /name="ad" value="3302"/);
    assert.doesNotMatch(html, / checked/);
    assert.match(html, /Cochez-en au moins un/);
    assert.ok(!/TOKEN/.test(html), 'no token in the page');
    // nothing ticked: the question stays open (the tab's « back » shows it again)
    assert.match((await confirmLogin(t, back.confirm!.state, back.confirm!.key, true)).message, /Cochez au moins un compte publicitaire/);
    assert.equal((await call('social.state', a, { state: s.state })).status, 'confirm');
    // two ticked (a number the login did not bring is left out)
    const end = await confirmLogin(t, back.confirm!.state, back.confirm!.key, true, '', ['3301', 'act_3303', '9999']);
    assert.equal(end.ok, true);
    const l1: any = await call('social.list', a, {});
    const link = l1.links.find((x: any) => x.name === 'Ala Ads');
    linkId = link.id;
    assert.deepEqual(Object.fromEntries(link.assets.map((x: any) => [x.name, x.usedHere])), { 'babyjoydz velo': true, 'Mighty prod': false, 'baby product': true });
    assert.equal(l1.here.ad_account.count, 2);
    // Publicité, the pixels and the catalogue read these two alone; new ads leave from the first ticked one
    assert.deepEqual((await setting(a, 'meta')).adAccountIds, ['3301', '3303']);
    assert.deepEqual([l1.launch.id, l1.launch.accounts.map((x: any) => x.id)], ['3301', ['3301', '3303']]);
    assert.equal(await setting(a, 'secret_meta_token'), 'LONG_USER_TOKEN');
    // an ad account's webhook (an ad rejected…) reaches the boutiques that ticked it
    assert.deepEqual((await routeMeta(t, { object: 'ad_account', entry: [{ id: 'act_3303', changes: [] }] })).map((r) => r.shopId), [a.shop!.id]);
    assert.deepEqual(await routeMeta(t, { object: 'ad_account', entry: [{ id: 'act_3302', changes: [] }] }), []);
    // « Tester » tries the ticked ones
    const tested: any = await call('social.test', a, { linkId });
    assert.equal(tested.checks.find((c: any) => c.key === 'ads').params.count, 2);

    // linked again: Facebook brings a new ad account; the tab ticks what the boutique uses, the new one comes unticked
    graph = { ...graph, ads: [...graph.ads, acct('3304', 'SERVICE AD ACCOUNT')] };
    const s2: any = await call('social.start', a, { provider: 'meta', scope: 'here', kind: 'ads' });
    const back2 = await finishLogin(t, 'meta', { code: 'ADS_PICK_2', state: s2.state }, URL0);
    assert.deepEqual(back2.confirm!.ads!.map((x) => `${x.id}:${x.on}`), ['3301:true', '3302:false', '3303:true', '3304:false']);
    assert.match(loginPage(back2), /name="ad" value="3301" checked/);
    assert.equal((await confirmLogin(t, back2.confirm!.state, back2.confirm!.key, true, '', ['3301', '3303'])).ok, true);
    const l2: any = await call('social.list', a, {});
    assert.deepEqual(l2.links.find((x: any) => x.id === linkId).assets.filter((x: any) => x.usedHere).map((x: any) => x.extId).sort(), ['3301', '3303']);
    assert.deepEqual((await setting(a, 'meta')).adAccountIds, ['3301', '3303']);

    // « Changer »: new ads leave from « baby product »; unticked, they leave from the one still ticked, and the customer
    // lists Pilotix made in the former account are made again in the new one
    await call('social.launchAccount', a, { adAccountId: '3303' });
    await a.db.query(`INSERT INTO ad_audiences (kind, meta_id, status) VALUES ('pick-test', 'AUD_1', 'on') ON CONFLICT (kind) DO UPDATE SET meta_id = 'AUD_1', status = 'on'`);
    const changed: any = await call('social.adsPick', a, { linkId, ids: ['3302'] });
    assert.deepEqual(changed.links.find((x: any) => x.id === linkId).assets.filter((x: any) => x.usedHere).map((x: any) => x.name), ['Mighty prod']);
    assert.deepEqual([changed.launch.id, (await setting(a, 'meta')).adAccountIds], ['3302', ['3302']]);
    assert.deepEqual((await a.db.query(`SELECT meta_id, status FROM ad_audiences WHERE kind = 'pick-test'`))[0], { meta_id: null, status: 'off' });
    // a number of another account, or none at all
    await assert.rejects(() => call('social.adsPick', a, { linkId, ids: ['nope'] }));
    const none: any = await call('social.adsPick', a, { linkId, ids: [] });
    assert.equal(none.here.ad_account, null);
    assert.deepEqual([(await setting(a, 'meta')).adAccountIds, await setting(a, 'secret_meta_token')], [[], null]);

    // p044: a boutique that counted all of an account's ad accounts keeps exactly those, ticked
    const any3301 = (await t.platform.query(`SELECT id FROM platform.social_assets WHERE link_id = $1 AND ext_id = '3301'`, [linkId]))[0];
    await t.platform.query(`INSERT INTO platform.social_uses (shop_id, kind, asset_id, ext_id, by_name) VALUES ($1, 'ad_account', $2, '3301', 'avant')`, [a.shop!.id, any3301.id]);
    // (its UPDATE: the column itself came with the platform's migrations)
    for (const sql of SOCIAL_PICKED_SQL.split(';').map((x) => x.trim()).filter((x) => x.startsWith('UPDATE'))) await t.platform.query(sql);
    assert.deepEqual((await t.platform.query(`SELECT picked FROM platform.social_uses WHERE shop_id = $1 AND kind = 'ad_account'`, [a.shop!.id]))[0].picked, ['3301', '3302', '3303', '3304']);
  } finally {
    if (linkId) await call('social.remove', a, { linkId }).catch(() => null);
    await twoDoorsOff();
  }
});
