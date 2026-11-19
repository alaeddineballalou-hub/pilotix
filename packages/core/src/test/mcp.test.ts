// AI assistants linked to a Pilotix account (mcp-server.ts): the sign-in door (an assistant registers, the person says
// yes, the keys), what stops a link (a code or a renewal key used twice, time, « Couper », a new password, a closed
// account), and the tools: each one reads as the person, with the app's own role checks.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { before, test } from 'node:test';
import { DEMO_PASSWORD } from '@pilotix/shared';
import { call, Ctx, Db, login, migrate, migrateAll, pgliteTenancy, seedDemo, Tenancy } from '../index';
import { dropShopData } from '../platform/shops';
import {
  ACCESS_SECONDS,
  ASK_SECONDS,
  CODE_SECONDS,
  IDLE_DAYS,
  McpEnv,
  McpPersonOf,
  mcpAccess,
  mcpAnswer,
  mcpAsk,
  mcpAuthorize,
  mcpCannot,
  mcpChallenge,
  mcpClient,
  mcpCut,
  mcpLinks,
  mcpLog,
  mcpLogAdd,
  mcpMessage,
  mcpSetWrite,
  LOG_DAYS,
  McpCall,
  mcpRegister,
  mcpResourceMeta,
  mcpServerMeta,
  mcpStoreOk,
  mcpToken,
  redirectKind,
} from '../mcp-server';
import { EMAILS } from './harness';

const SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuv:mcp';
const BASE = 'https://pilotix.test';
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-15T09:00:00Z');

let t: Tenancy;
let db: Db;
/** the people's token versions (a new password raises one; a closed account has none) */
const people = new Map<string, number>();
const person: McpPersonOf = async (shopId, profileId) => (people.has(`${shopId}:${profileId}`) ? { tv: people.get(`${shopId}:${profileId}`)! } : null);
const ME = { shopId: 1, profileId: 7, tv: 0 };

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  t = pgliteTenancy(new PGlite() as any);
  db = t.shop('public');
  await migrate(db, (sql) => t.exec('public', sql));
  await seedDemo(db, { orders: 120 });
  await migrateAll(t);
  people.set('1:7', 0);
  people.set('1:8', 0);
});

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const register = (extra: Record<string, unknown> = {}) => mcpRegister(SECRET, { client_name: 'Claude', redirect_uris: [CLAUDE], token_endpoint_auth_method: 'none', ...extra }, T0).json as any;
/** The assistant's question, as the app's « Autoriser » page gets it. */
function question(client: any, challenge: string, now = T0, extra: Record<string, string> = {}): string {
  const r = mcpAuthorize(SECRET, BASE, { response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_challenge: challenge, code_challenge_method: 'S256', state: 'st1', ...extra }, now);
  assert.ok('redirect' in r, JSON.stringify(r));
  const u = new URL((r as { redirect: string }).redirect);
  assert.equal(u.origin, BASE);
  return u.searchParams.get('mcp')!;
}
/** The whole way: the person says yes, the assistant gets its keys. */
async function link(who = ME, now = T0) {
  const client = register();
  const p = pkce();
  const ticket = question(client, p.challenge, now);
  const back = new URL((await mcpAnswer(t, SECRET, ticket, who, true, now)).redirect);
  const code = back.searchParams.get('code')!;
  const r = await mcpToken(t, SECRET, BASE, { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: client.client_id, redirect_uri: CLAUDE }, null, person, now);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { client, code, verifier: p.verifier, access: r.json.access_token as string, refresh: r.json.refresh_token as string, id: Number(/^pxr_(\d+)\./.exec(r.json.refresh_token as string)![1]) };
}
const refresh = (token: string, now: number, clientId?: string) => mcpToken(t, SECRET, BASE, { grant_type: 'refresh_token', refresh_token: token, ...(clientId ? { client_id: clientId } : {}) }, null, person, now);
const why = async (id: number) => (await t.platform.query('SELECT revoked_why FROM platform.mcp_grants WHERE id = $1', [id]))[0]?.revoked_why ?? null;

test('the door’s papers name one door, and the answer without a key shows the way to it', () => {
  const r = mcpResourceMeta(`${BASE}/`);
  const s = mcpServerMeta(BASE);
  assert.equal(r.resource, `${BASE}/mcp`);
  assert.deepEqual(r.authorization_servers, [s.issuer]);
  assert.equal(s.issuer, BASE);
  assert.deepEqual(s.code_challenge_methods_supported, ['S256']);
  assert.deepEqual([s.authorization_endpoint, s.token_endpoint, s.registration_endpoint], [`${BASE}/api/mcp/authorize`, `${BASE}/api/mcp/token`, `${BASE}/api/mcp/register`]);
  assert.equal(mcpChallenge(BASE), `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="read"`);
  assert.match(mcpChallenge(BASE, 'invalid_token', 'a "bad" key'), /^Bearer error="invalid_token", error_description="a  bad  key", resource_metadata=/);
});

test('answers only go to Claude’s and ChatGPT’s own sites, or to a tool on this computer', () => {
  for (const u of [CLAUDE, 'https://claude.com/api/mcp/auth_callback', 'https://claude.ai:443/api/mcp/auth_callback', 'https://chatgpt.com/connector_platform_oauth_redirect', 'https://chatgpt.com/connector/oauth/6mt_L_yi2KyC']) assert.equal(redirectKind(u), 'known', u);
  for (const u of ['http://localhost:33418/callback', 'http://127.0.0.1/cb', 'http://[::1]:8080/cb']) assert.equal(redirectKind(u), 'local', u);
  for (const u of [
    'https://evil.example/cb',
    // their sites, but not their answer addresses: another page there could show the code to someone else
    'https://claude.ai/',
    'https://claude.ai/public/artifacts/abc',
    'https://claude.ai/api/mcp/auth_callback/more',
    'https://claude.ai/api/mcp/auth_callback?next=https://evil.example',
    'https://claude.ai//api/mcp/auth_callback',
    'https://claude.ai/api/mcp/../mcp/auth_callback/..%2f',
    'https://chatgpt.com/share/abc',
    'https://chatgpt.com/connector/oauth/abc/def',
    'https://chatgpt.com/connector/oauth/',
    'https://chatgpt.com/connector_platform_oauth_redirect/x',
    'https://claude.com/api/mcp/auth_callback2',
    'http://claude.ai/api/mcp/auth_callback',
    'https://claude.ai.evil.example/api/mcp/auth_callback',
    'https://evil.example/claude.ai/api/mcp/auth_callback',
    'https://user:pw@claude.ai/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback#frag',
    'https://chatgpt.com:8443/connector_platform_oauth_redirect',
    'https://sub.claude.ai/api/mcp/auth_callback',
    'https://localhost/cb',
    'javascript:alert(1)',
    'claude.ai/api/mcp/auth_callback',
    '',
    null,
    42,
    `https://claude.ai/${'a'.repeat(300)}`,
  ])
    assert.equal(redirectKind(u), null, String(u));
});

test('an assistant registers: its name and addresses are signed into its client id (nothing is kept)', async () => {
  const before = Number((await t.platform.query('SELECT count(*)::int AS n FROM platform.mcp_grants'))[0].n);
  const c = register({ client_name: '  Claude <script>\u0000 ' });
  assert.equal(c.client_name, 'Claude script');
  assert.deepEqual(mcpClient(SECRET, c.client_id), { name: 'Claude script', uris: [CLAUDE], secret: false });
  assert.equal(c.client_secret, undefined);
  // two assistants registering alike are still two
  assert.notEqual(register().client_id, register().client_id);
  // changed, or signed by another server: unknown
  assert.equal(mcpClient(SECRET, `${c.client_id}x`), null);
  assert.equal(mcpClient(SECRET, c.client_id.replace(/^pxc_./, 'pxc_Z')), null);
  assert.equal(mcpClient('another-secret', c.client_id), null);
  assert.equal(mcpClient(SECRET, mcpRegister('another-secret', { redirect_uris: [CLAUDE] }, T0).json.client_id), null);
  // what is refused
  for (const body of [{}, { redirect_uris: [] }, { redirect_uris: 'x' }, { redirect_uris: [CLAUDE, 'https://evil.example/cb'] }, { redirect_uris: Array(6).fill(CLAUDE) }, { redirect_uris: [1] }]) {
    const r = mcpRegister(SECRET, body, T0);
    assert.deepEqual([r.status, r.json.error], [400, 'invalid_redirect_uri'], JSON.stringify(body));
  }
  assert.equal(mcpRegister(SECRET, { redirect_uris: [CLAUDE], token_endpoint_auth_method: 'private_key_jwt' }, T0).json.error, 'invalid_client_metadata');
  assert.equal(mcpRegister(SECRET, { redirect_uris: [CLAUDE] }, T0).json.client_name, 'Assistant IA');
  // an assistant that keeps a secret gets one
  const g = register({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'client_secret_post' });
  assert.match(g.client_secret, /^pxs_/);
  assert.equal(mcpClient(SECRET, g.client_id)!.secret, true);
  assert.equal(Number((await t.platform.query('SELECT count(*)::int AS n FROM platform.mcp_grants'))[0].n), before);
});

test('the assistant’s question: a wrong assistant or address is shown to the person, the rest goes back to its site', () => {
  const c = register();
  const p = pkce();
  const q = { response_type: 'code', client_id: c.client_id, redirect_uri: CLAUDE, code_challenge: p.challenge, code_challenge_method: 'S256', state: 'abc' };
  for (const bad of [{ ...q, client_id: 'nope' }, { ...q, redirect_uri: 'https://claude.ai/other' }, { ...q, redirect_uri: 'https://evil.example/cb' }]) {
    const r = mcpAuthorize(SECRET, BASE, bad, T0) as any;
    assert.equal(r.status, 400);
    assert.equal(r.redirect, undefined);
  }
  for (const [bad, err] of [
    [{ ...q, code_challenge: undefined }, 'invalid_request'],
    [{ ...q, code_challenge: 'short' }, 'invalid_request'],
    [{ ...q, code_challenge_method: 'plain' }, 'invalid_request'],
    [{ ...q, code_challenge_method: undefined }, 'invalid_request'],
    [{ ...q, response_type: 'token' }, 'unsupported_response_type'],
    [{ ...q, resource: 'https://other.example/mcp' }, 'invalid_target'],
    [{ ...q, resource: `${BASE}/other` }, 'invalid_target'],
    [{ ...q, state: 'x'.repeat(1001) }, 'invalid_request'],
  ] as const) {
    const u = new URL((mcpAuthorize(SECRET, BASE, bad as any, T0) as any).redirect);
    assert.equal(u.origin + u.pathname, CLAUDE);
    assert.equal(u.searchParams.get('error'), err);
    assert.equal(u.searchParams.get('iss'), BASE);
  }
  // the link named with or without its last « / », or the site alone
  for (const resource of [`${BASE}/mcp`, `${BASE}/mcp/`, BASE, `${BASE}/`]) assert.ok(question(c, p.challenge, T0, { resource }));
  // one address registered: it need not be said again; unknown scopes fall back to « read »
  const r = mcpAuthorize(SECRET, BASE, { ...q, redirect_uri: undefined, scope: 'openid write admin' }, T0) as any;
  const a = mcpAsk(SECRET, new URL(r.redirect).searchParams.get('mcp'), T0);
  assert.deepEqual(a, { client: 'Claude', host: 'claude.ai', site: 'known', scope: ['read'], expiresIn: ASK_SECONDS });
  // a tool on this computer answers on any port
  const local = register({ client_name: 'Claude Code', redirect_uris: ['http://localhost:33418/callback'] });
  const lt = question(local, p.challenge, T0, { redirect_uri: 'http://localhost:50123/callback' });
  assert.deepEqual([mcpAsk(SECRET, lt, T0).host, mcpAsk(SECRET, lt, T0).site], ['localhost:50123', 'local']);
  assert.equal((mcpAuthorize(SECRET, BASE, { ...q, client_id: local.client_id, redirect_uri: 'http://localhost:50123/other' }, T0) as any).status, 400);
  // the question waits 10 minutes, and cannot be changed
  const ticket = question(c, p.challenge);
  assert.ok(mcpAsk(SECRET, ticket, T0 + (ASK_SECONDS - 1) * 1000));
  assert.throws(() => mcpAsk(SECRET, ticket, T0 + ASK_SECONDS * 1000), /expiré/);
  assert.throws(() => mcpAsk(SECRET, `${ticket}x`, T0), /expiré/);
  assert.throws(() => mcpAsk('another-secret', ticket, T0), /expiré/);
  // through the backup door: the person still says yes on the site, and the answer names the door taken
  const direct = mcpAuthorize(SECRET, 'https://direct.pilotix.test', q, T0, BASE) as any;
  assert.equal(new URL(direct.redirect).origin, BASE);
});

test('« Refuser » tells the assistant’s site; « Autoriser » gives a code only its PKCE key can use, once, for 5 minutes', async () => {
  const c = register();
  const p = pkce();
  const ticket = question(c, p.challenge);
  const no = new URL((await mcpAnswer(t, SECRET, ticket, ME, false, T0)).redirect);
  assert.deepEqual([no.origin + no.pathname, no.searchParams.get('error'), no.searchParams.get('state'), no.searchParams.get('iss'), no.searchParams.get('code')], [CLAUDE, 'access_denied', 'st1', BASE, null]);
  await assert.rejects(() => mcpAnswer(t, SECRET, ticket, ME, true, T0 + ASK_SECONDS * 1000), /expiré/);
  const yes = new URL((await mcpAnswer(t, SECRET, ticket, ME, true, T0)).redirect);
  assert.deepEqual([yes.origin + yes.pathname, yes.searchParams.get('state'), yes.searchParams.get('iss')], [CLAUDE, 'st1', BASE]);
  const code = yes.searchParams.get('code')!;
  assert.match(code, /^pxk_\d+\.[A-Za-z0-9_-]{43}$/);
  const form = { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: c.client_id, redirect_uri: CLAUDE };
  const tok = (f: Record<string, unknown>, now = T0) => mcpToken(t, SECRET, BASE, f, null, person, now);
  // no keys for: a wrong PKCE key, none, another assistant, no assistant, another address, a changed code, another resource
  for (const [f, err] of [
    [{ ...form, code_verifier: pkce().verifier }, 'invalid_grant'],
    [{ ...form, code_verifier: undefined }, 'invalid_grant'],
    [{ ...form, client_id: register().client_id }, 'invalid_grant'],
    [{ ...form, client_id: undefined }, 'invalid_request'],
    [{ ...form, client_id: 'nope' }, 'invalid_client'],
    [{ ...form, redirect_uri: 'https://claude.com/api/mcp/auth_callback' }, 'invalid_grant'],
    [{ ...form, code: `${code}x` }, 'invalid_grant'],
    [{ ...form, code: code.replace(/^pxk_\d+/, 'pxk_999999') }, 'invalid_grant'],
    [{ ...form, resource: 'https://other.example/mcp' }, 'invalid_target'],
    [{ ...form, grant_type: 'password' }, 'unsupported_grant_type'],
    [{}, 'unsupported_grant_type'],
  ] as const) {
    const r = await tok(f as any);
    assert.notEqual(r.status, 200);
    assert.equal(r.json.error, err, JSON.stringify(f));
  }
  // too late
  assert.equal((await tok(form, T0 + CODE_SECONDS * 1000)).json.error, 'invalid_grant');
  // the code and its key
  const ok = await tok(form, T0 + (CODE_SECONDS - 1) * 1000);
  assert.deepEqual([ok.status, ok.json.token_type, ok.json.expires_in, ok.json.scope], [200, 'Bearer', ACCESS_SECONDS, 'read']);
  const now = T0 + CODE_SECONDS * 1000;
  assert.ok(await mcpAccess(t, SECRET, BASE, ok.json.access_token, person, now));
  // the same code again: refused, and the link it opened is cut (the code was copied)
  assert.equal((await tok(form, now)).json.error, 'invalid_grant');
  assert.equal(await mcpAccess(t, SECRET, BASE, ok.json.access_token, person, now), null);
  assert.equal(await why(Number(/^pxk_(\d+)/.exec(code)![1])), 'code_reuse');
});

test('an assistant with a secret gets no keys without it', async () => {
  const g = register({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'client_secret_basic' });
  const p = pkce();
  const code = new URL((await mcpAnswer(t, SECRET, question(g, p.challenge), ME, true, T0)).redirect).searchParams.get('code')!;
  const form = { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: g.client_id };
  assert.deepEqual([(await mcpToken(t, SECRET, BASE, form, null, person, T0)).status, (await mcpToken(t, SECRET, BASE, { ...form, client_secret: 'pxs_nope' }, null, person, T0)).status], [401, 401]);
  assert.equal((await mcpToken(t, SECRET, BASE, { ...form, client_id: undefined }, { id: g.client_id, secret: 'nope' }, person, T0)).status, 401);
  const ok = await mcpToken(t, SECRET, BASE, { ...form, client_id: undefined }, { id: g.client_id, secret: g.client_secret }, person, T0);
  assert.equal(ok.status, 200);
  // its renewal key needs the secret too — with or without its client id (an assistant without a secret may leave it out)
  assert.equal((await mcpToken(t, SECRET, BASE, { grant_type: 'refresh_token', refresh_token: ok.json.refresh_token, client_id: g.client_id }, null, person, T0)).status, 401);
  assert.deepEqual([(await mcpToken(t, SECRET, BASE, { grant_type: 'refresh_token', refresh_token: ok.json.refresh_token }, null, person, T0)).status, (await why(Number(/^pxr_(\d+)\./.exec(ok.json.refresh_token as string)![1])))], [401, null]);
  assert.equal((await mcpToken(t, SECRET, BASE, { grant_type: 'refresh_token', refresh_token: ok.json.refresh_token, client_id: g.client_id, client_secret: g.client_secret }, null, person, T0)).status, 200);
});

test('an access key: one hour, for this link only, never changed', async () => {
  const l = await link();
  const a = await mcpAccess(t, SECRET, BASE, l.access, person, T0 + 1000);
  assert.deepEqual(a, { grantId: l.id, shopId: 1, profileId: 7, scope: ['read'], write: [], client: 'Claude', host: 'claude.ai' });
  assert.ok(await mcpAccess(t, SECRET, BASE, l.access, person, T0 + (ACCESS_SECONDS - 1) * 1000));
  assert.equal(await mcpAccess(t, SECRET, BASE, l.access, person, T0 + ACCESS_SECONDS * 1000), null, 'over after an hour');
  // for another site's link, signed by another server, changed, or not an access key at all
  assert.equal(await mcpAccess(t, SECRET, 'https://other.test', l.access, person, T0), null);
  assert.equal(await mcpAccess(t, 'another-secret', BASE, l.access, person, T0), null);
  const [head, sig] = [l.access.slice(0, l.access.lastIndexOf('.')), l.access.slice(l.access.lastIndexOf('.'))];
  const forged = `pxa_${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(head.slice(4), 'base64url').toString()), p: 1 })).toString('base64url')}${sig}`;
  assert.equal(await mcpAccess(t, SECRET, BASE, forged, person, T0), null, 'another person written in the key');
  for (const k of [l.refresh, l.code, l.client.client_id, '', null, undefined, 'x'.repeat(7000)]) assert.equal(await mcpAccess(t, SECRET, BASE, k, person, T0), null);
});

test('a renewal key changes at every use; a lost answer may ask again; an old key used again cuts the link', async () => {
  const l = await link();
  const r1 = await refresh(l.refresh, T0 + 1000, l.client.client_id);
  assert.equal(r1.status, 200);
  assert.notEqual(r1.json.refresh_token, l.refresh);
  assert.ok(await mcpAccess(t, SECRET, BASE, r1.json.access_token, person, T0 + 2000));
  // the answer was lost on the way: the same key within a minute gives the same new key (nothing is changed again)
  const again = await refresh(l.refresh, T0 + 50_000);
  assert.deepEqual([again.status, again.json.refresh_token], [200, r1.json.refresh_token]);
  // another assistant cannot use it
  assert.equal((await refresh(r1.json.refresh_token as string, T0 + 51_000, register().client_id)).json.error, 'invalid_grant');
  const r2 = await refresh(r1.json.refresh_token as string, T0 + 52_000);
  assert.equal(r2.status, 200);
  // the first key, later: it was copied — the link stops for everyone holding one of its keys
  const old = await refresh(l.refresh, T0 + 53_000);
  assert.deepEqual([old.status, old.json.error], [400, 'invalid_grant']);
  assert.equal(await why(l.id), 'refresh_reuse');
  assert.equal(await mcpAccess(t, SECRET, BASE, r2.json.access_token, person, T0 + 54_000), null);
  assert.equal((await refresh(r2.json.refresh_token as string, T0 + 55_000)).status, 400);

  // the key just before, but more than a minute after it was changed: a copy too
  const m = await link();
  const m1 = await refresh(m.refresh, T0 + 1000);
  assert.equal((await refresh(m.refresh, T0 + 1000 + 61_000)).status, 400);
  assert.equal(await why(m.id), 'refresh_reuse');
  assert.equal((await refresh(m1.json.refresh_token as string, T0 + 1000 + 62_000)).status, 400);

  // the same key twice at the same moment: both get the same new key, the link goes on
  const s = await link();
  const [a, b] = await Promise.all([refresh(s.refresh, T0 + 1000), refresh(s.refresh, T0 + 1000)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(a.json.refresh_token, b.json.refresh_token);
  assert.equal(await why(s.id), null);

  // made up, or another link's signature
  for (const k of ['pxr_1.0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', s.refresh.replace(/^pxr_\d+/, `pxr_${m.id}`), `${s.refresh}x`, '', l.access]) assert.equal((await refresh(k, T0)).json.error, 'invalid_grant', k);
  assert.equal(await why(s.id), null, 'a made-up key cuts nothing');
});

test(`a link nobody uses for ${IDLE_DAYS} days is cut; one that is used goes on`, async () => {
  const idle = await link();
  const late = await refresh(idle.refresh, T0 + IDLE_DAYS * DAY + 1000);
  assert.equal(late.json.error, 'invalid_grant');
  assert.equal(await why(idle.id), 'idle');
  // used every two months: still there after six
  const used = await link();
  let key = used.refresh;
  for (let k = 1; k <= 3; k++) {
    const r = await refresh(key, T0 + k * 60 * DAY);
    assert.equal(r.status, 200, `month ${k * 2}`);
    key = r.json.refresh_token as string;
    assert.ok(await mcpAccess(t, SECRET, BASE, r.json.access_token, person, T0 + k * 60 * DAY + 1000));
  }
});

test('a new password, or a closed account, cuts the person’s links', async () => {
  const who = { shopId: 1, profileId: 8, tv: 0 };
  const a = await link(who);
  const b = await link(who);
  assert.ok(await mcpAccess(t, SECRET, BASE, a.access, person, T0));
  // a new password
  people.set('1:8', 1);
  assert.equal(await mcpAccess(t, SECRET, BASE, a.access, person, T0), null);
  assert.equal(await why(a.id), 'password');
  assert.equal((await refresh(b.refresh, T0)).json.error, 'invalid_grant');
  assert.equal(await why(b.id), 'password');
  assert.deepEqual(await mcpLinks(t, 1, 8, 1, T0), []);
  // a link made with the new password works; then the account is closed
  const c = await link({ ...who, tv: 1 });
  assert.ok(await mcpAccess(t, SECRET, BASE, c.access, person, T0));
  people.delete('1:8');
  assert.equal(await mcpAccess(t, SECRET, BASE, c.access, person, T0), null);
  assert.equal(await why(c.id), 'account');
  // a code given just before the account was closed gives no keys
  people.set('1:8', 1);
  const cl = register();
  const p = pkce();
  const code = new URL((await mcpAnswer(t, SECRET, question(cl, p.challenge), { ...who, tv: 1 }, true, T0)).redirect).searchParams.get('code')!;
  people.delete('1:8');
  assert.equal((await mcpToken(t, SECRET, BASE, { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: cl.client_id }, null, person, T0)).json.error, 'invalid_grant');
  people.set('1:8', 1);
});

test('Mon profil: my links only; « Couper » stops one at once; at most 20 links, the least used go', async () => {
  people.set('1:9', 0);
  people.set('1:10', 0);
  const mine = { shopId: 1, profileId: 9, tv: 0 };
  const a = await link(mine, T0);
  const b = await link(mine, T0 + 1000);
  const other = await link({ shopId: 1, profileId: 10, tv: 0 });
  // a question never answered with a code used is not a link
  await mcpAnswer(t, SECRET, question(register(), pkce().challenge), mine, true, T0);
  const list = await mcpLinks(t, 1, 9, 0, T0 + 2000);
  assert.deepEqual(list.map((x) => x.id), [b.id, a.id]);
  // « pas encore utilisé » until the assistant asks something; then the moment it did
  assert.deepEqual([list[0].client, list[0].host, list[0].scope, list[0].lastUsedAt, list[1].lastUsedAt], ['Claude', 'claude.ai', ['read'], null, null]);
  assert.ok(await mcpAccess(t, SECRET, BASE, a.access, person, T0 + 1500));
  assert.deepEqual((await mcpLinks(t, 1, 9, 0, T0 + 2000)).map((x) => [x.id, x.lastUsedAt]), [[b.id, null], [a.id, new Date(T0 + 1500).toISOString()]]);
  // the same person's number in another boutique is someone else
  assert.deepEqual(await mcpLinks(t, 2, 9, 0, T0), []);
  await assert.rejects(() => mcpCut(t, 1, 9, other.id, T0), /introuvable/);
  await assert.rejects(() => mcpCut(t, 2, 9, a.id, T0), /introuvable/);
  assert.deepEqual(await mcpCut(t, 1, 9, a.id, T0 + 3000), { ok: true });
  await assert.rejects(() => mcpCut(t, 1, 9, a.id, T0 + 3000), /introuvable/);
  assert.equal(await mcpAccess(t, SECRET, BASE, a.access, person, T0 + 4000), null);
  assert.equal((await refresh(a.refresh, T0 + 4000)).json.error, 'invalid_grant');
  assert.ok(await mcpAccess(t, SECRET, BASE, b.access, person, T0 + 4000));
  assert.ok(await mcpAccess(t, SECRET, BASE, other.access, person, T0 + 4000));
  assert.deepEqual((await mcpLinks(t, 1, 9, 0, T0 + 5000)).map((x) => x.id), [b.id]);
  // 21 more links: 20 are left, and the oldest one (b) went
  const made: number[] = [];
  for (let k = 0; k < 21; k++) made.push((await link(mine, T0 + 10_000 + k * 1000)).id);
  const left = (await mcpLinks(t, 1, 9, 0, T0 + 60_000)).map((x) => x.id);
  assert.equal(left.length, 20);
  assert.ok(!left.includes(b.id) && left.includes(made[20]) && left.includes(made[1]));
  assert.equal(await why(b.id), 'limit');
});

test('a boutique whose data is removed takes its links with it', async () => {
  people.set('77:3', 0);
  people.set('78:3', 0);
  const gone = await link({ shopId: 77, profileId: 3, tv: 0 });
  const kept = await link({ shopId: 78, profileId: 3, tv: 0 });
  await mcpSetWrite(t, 77, 3, gone.id, ['orders'], T0);
  await dropShopData(t, 77, 'shop_77');
  // the same number in that boutique is someone else afterwards: the old key opens nothing, and nothing is left of it
  assert.equal(await mcpAccess(t, SECRET, BASE, gone.access, person, T0), null);
  assert.equal((await refresh(gone.refresh, T0, gone.client.client_id)).json.error, 'invalid_grant');
  assert.deepEqual(await t.platform.query('SELECT id FROM platform.mcp_grants WHERE shop_id = 77'), []);
  assert.deepEqual(await t.platform.query('SELECT id FROM platform.mcp_log WHERE shop_id = 77'), []);
  assert.ok(await mcpAccess(t, SECRET, BASE, kept.access, person, T0));
});

test('a link is made in a live boutique only: not the shared demo, not a partner’s space, not an unpaid boutique', () => {
  const store = { status: 'active', kind: 'store', demo: false };
  assert.equal(mcpCannot(store, false), null);
  assert.equal(mcpCannot(store, false, null), null);
  // the demo first (whatever else it is), then whose space it is, then its subscription
  assert.equal(mcpCannot({ ...store, demo: true }, true, 4), 'demo');
  assert.equal(mcpCannot({ ...store, kind: 'agency' }, false), 'partner');
  assert.equal(mcpCannot({ ...store, kind: 'marketer' }, true), 'partner');
  assert.equal(mcpCannot(store, false, 4), 'partner');
  assert.equal(mcpCannot(store, true), 'locked');
  assert.equal(mcpCannot({ ...store, status: 'suspended' }, true), 'locked');
  // the keys of a link: a suspended boutique keeps its links (its tools are refused by the app's own rule, as its
  // screens are); an archived or deleted one, a partner's space and the demo have none
  assert.deepEqual(
    [store, { ...store, status: 'suspended' }, { ...store, status: 'archived' }, { ...store, status: 'deleted' }, { ...store, kind: 'agency' }, { ...store, kind: 'marketer' }, { ...store, demo: true }].map(mcpStoreOk),
    [true, true, false, false, false, false, false],
  );
});

// ---------------------------------------------------------------- the tools, on the demo boutique
let rpcId = 0;
async function envFor(email: string): Promise<McpEnv> {
  const session = await login(db, email, DEMO_PASSWORD);
  const ctx: Ctx = { db, session, now: () => Date.now(), emit: () => undefined };
  return {
    call: (name, input) => call(name, ctx, input),
    who: { name: session.profile.name, email: session.profile.email, roles: session.roles, isAdmin: session.isAdmin },
    shop: { name: 'Ma boutique', slug: 'ma-boutique' },
    scope: ['read'],
    now: Date.now(),
    version: 'test',
  };
}
const say = (env: McpEnv, method: string, params?: unknown) => mcpMessage({ jsonrpc: '2.0', id: ++rpcId, method, ...(params === undefined ? {} : { params }) }, env) as Promise<any>;
async function tool(env: McpEnv, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const r = await say(env, 'tools/call', { name, arguments: args });
  assert.ok(r.result, JSON.stringify(r));
  const text = r.result.content[0].text;
  return r.result.isError ? { error: text } : JSON.parse(text);
}

test('the link speaks MCP: initialize, the tools of the person’s role, what it does not have', async () => {
  const admin = await envFor(EMAILS.admin);
  const init = await say(admin, 'initialize', { protocolVersion: '2025-03-26', capabilities: {} });
  assert.deepEqual([init.jsonrpc, init.result.protocolVersion, init.result.serverInfo.name, init.result.capabilities], ['2.0', '2025-03-26', 'pilotix', { tools: { listChanged: false } }]);
  assert.match(init.result.instructions, /Administrateur \(administrator\).*read-only/s);
  assert.equal((await say(admin, 'initialize', { protocolVersion: '2099-01-01' })).result.protocolVersion, '2025-11-25');
  assert.deepEqual((await say(admin, 'ping')).result, {});
  // notifications and answers to nothing we asked: nothing to say
  assert.equal(await mcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, admin), null);
  assert.equal(await mcpMessage({ jsonrpc: '2.0', id: 3, result: {} }, admin), null);
  // not a message
  for (const bad of [null, 'x', [], {}, { jsonrpc: '1.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 1 }]) assert.equal(((await mcpMessage(bad, admin)) as any).error.code, -32600, JSON.stringify(bad));
  assert.equal((await say(admin, 'tools/remove')).error.code, -32601);
  assert.deepEqual([(await say(admin, 'resources/list')).result, (await say(admin, 'prompts/list')).result], [{ resources: [] }, { prompts: [] }]);
  const names = async (email: string) => (await say(await envFor(email), 'tools/list')).result.tools.map((x: any) => x.name).sort();
  const all = await names(EMAILS.admin);
  assert.deepEqual(all, ['agent_stats', 'customer_history', 'delivery_companies', 'delivery_follow_up', 'get_order', 'order_counts', 'search_orders', 'search_products', 'shop_dashboard', 'stats_overview', 'stock_levels', 'whoami']);
  const tools = (await say(admin, 'tools/list')).result.tools;
  for (const x of tools) {
    assert.deepEqual([x.inputSchema.type, x.inputSchema.additionalProperties, x.annotations.readOnlyHint, x.annotations.destructiveHint], ['object', false, true, false], x.name);
    assert.ok(x.title && x.description.length > 30, x.name);
  }
  // each role: the tools of its own screens
  assert.deepEqual(await names(EMAILS.vendeur), all);
  const conf = await names(EMAILS.conf);
  assert.ok(conf.includes('search_orders') && conf.includes('stats_overview') && conf.includes('customer_history') && !conf.includes('shop_dashboard') && !conf.includes('stock_levels'));
  const depot = await names(EMAILS.depot);
  assert.ok(depot.includes('stock_levels') && !depot.includes('customer_history') && !depot.includes('shop_dashboard'));
  assert.deepEqual(await names(EMAILS.livreur), ['delivery_companies', 'get_order', 'order_counts', 'search_orders', 'search_products', 'whoami']);
});

test('every tool answers as the administrator, with the app’s own numbers, and nothing private', async () => {
  const env = await envFor(EMAILS.admin);
  const ctx: Ctx = { db, session: await login(db, EMAILS.admin, DEMO_PASSWORD), now: () => Date.now(), emit: () => undefined };
  const me = await tool(env, 'whoami');
  assert.deepEqual([me.email, me.administrator, me.boutique], [EMAILS.admin, true, 'Ma boutique']);
  assert.match(me.today, /^\d{4}-\d\d-\d\d$/);
  const found = await tool(env, 'search_orders', { limit: 5 });
  const app: any = await call('orders.list', ctx, { pageSize: 5 });
  assert.equal(found.total, app.total);
  assert.deepEqual(found.orders.map((o: any) => o.id), app.rows.map((o: any) => o.id));
  assert.deepEqual([found.page, found.pages, found.orders.length], [1, Math.ceil(app.total / 5), 5]);
  const o = found.orders[0];
  assert.ok(o.ref && o.phone && o.customer && /^\d\d /.test(o.wilaya) && o.items.includes(' × ') && o.total_da > 0);
  // filters
  for (const x of (await tool(env, 'search_orders', { delivery: ['delivered'], limit: 50 })).orders) assert.equal(x.delivery, 'delivered');
  for (const x of (await tool(env, 'search_orders', { confirmation: ['cancelled', 'fake'], limit: 50 })).orders) assert.ok(['cancelled', 'fake'].includes(x.confirmation));
  assert.ok((await tool(env, 'search_orders', { q: o.ref })).orders.some((x: any) => x.id === o.id));
  assert.equal((await tool(env, 'search_orders', { wilaya: 16, limit: 50 })).orders.every((x: any) => x.wilaya === '16 Alger'), true);
  const oldest = await tool(env, 'search_orders', { oldest_first: true, limit: 2 });
  assert.ok(Date.parse(oldest.orders[0].created) <= Date.parse(oldest.orders[1].created));
  // a day alone is Algeria's day, whole
  const day = o.created.slice(0, 10);
  const that: any = await call('orders.list', ctx, { from: `${day}T00:00:00+01:00`, to: new Date(Date.parse(`${day}T00:00:00+01:00`) + DAY).toISOString(), pageSize: 1 });
  assert.equal((await tool(env, 'search_orders', { from: day, to: day })).total, that.total);
  assert.equal((await tool(env, 'search_orders', { page: 2, limit: 5 })).orders[0].id, ((await call('orders.list', ctx, { page: 2, pageSize: 5 })) as any).rows[0].id);
  // one order
  const full = await tool(env, 'get_order', { ref: o.ref.toLowerCase() });
  assert.deepEqual([full.id, full.ref], [o.id, o.ref]);
  assert.ok(full.products.length >= 1 && full.products[0].unit_price_da >= 0 && full.history.length >= 1 && full.history[0].what);
  assert.equal(full.subtotal_da + full.delivery_fee_da - full.discount_da, full.total_da);
  assert.equal((await tool(env, 'get_order', { id: o.id })).ref, o.ref);
  assert.match((await tool(env, 'get_order', {})).error, /id or ref/);
  assert.match((await tool(env, 'get_order', { ref: 'PX-NOPE-0000' })).error, /introuvable/);
  assert.match((await tool(env, 'get_order', { id: 99_999_999 })).error, /introuvable/);
  // counts and stats: the app's numbers
  const counts = await tool(env, 'order_counts');
  const appCounts: any = await call('orders.counts', ctx, {});
  assert.deepEqual([counts.all_orders, counts.confirmation, counts.delivery], [appCounts.all, appCounts.conf, appCounts.follow]);
  const year = { from: '2026-01-01', to: '2026-12-31' };
  const st = await tool(env, 'stats_overview', year);
  const appSt: any = await call('stats.overview', ctx, { from: '2025-12-31T23:00:00.000Z', to: '2026-12-31T23:00:00.000Z' });
  assert.deepEqual([st.received, st.confirmed, st.delivered, st.returned, st.delivered_money_da], [appSt.received, appSt.confirmed, appSt.delivered, appSt.returned, appSt.cashed]);
  assert.equal(st.confirmation_rate_pct, Math.round(appSt.confRate * 1000) / 10);
  assert.deepEqual(st.period, { from: '2025-12-31T23:00:00.000Z', to: '2026-12-31T23:00:00.000Z' });
  const today = await tool(env, 'stats_overview');
  assert.equal(Date.parse(today.period.to) - Date.parse(today.period.from), DAY);
  assert.equal(new Date(Date.parse(today.period.from) + 3_600_000).toISOString().slice(11, 19), '00:00:00', 'the day starts at midnight in Algeria');
  assert.match((await tool(env, 'stats_overview', { from: '2026-13-45' })).error, /Date invalide/);
  assert.match((await tool(env, 'stats_overview', { from: '2026-05-02', to: '2026-05-01' })).error, /Période invalide/);
  assert.match((await tool(env, 'stats_overview', { from: '2020-01-01', to: '2026-01-01' })).error, /trop longue/);
  const dash = await tool(env, 'shop_dashboard', year);
  assert.ok(dash.revenue_da > 0 && dash.top_products.length && dash.top_products[0].name && dash.funnel.received === st.received && dash.channels.length && typeof dash.per_day === 'string');
  const week = await tool(env, 'shop_dashboard');
  assert.ok(Array.isArray(week.per_day) && week.per_day.length === 7);
  const agents = await tool(env, 'agent_stats', year);
  assert.ok(agents.agents.length >= 3 && agents.agents.every((a: any) => a.agent && a.treated >= 0));
  // products and stock
  const prods = await tool(env, 'search_products', { limit: 5 });
  assert.ok(prods.products.length >= 3 && prods.products[0].variants.length >= 1 && prods.products[0].price_da > 0);
  const p0 = prods.products[0];
  assert.ok((await tool(env, 'search_products', { q: p0.name.slice(0, 5) })).products.some((x: any) => x.id === p0.id));
  assert.ok((await tool(env, 'search_orders', { product_id: p0.id, limit: 1 })).total >= 0);
  const stock = await tool(env, 'stock_levels');
  assert.ok(stock.stock.length >= 3 && stock.stock.every((x: any) => x.available === x.in_stock - x.held_by_orders && x.depot));
  assert.ok((await tool(env, 'stock_levels', { low_only: true })).stock.every((x: any) => x.available <= x.alert_at));
  // deliveries
  const road = await tool(env, 'delivery_follow_up', { list: 'on_the_road', limit: 5 });
  const appRoad: any = await call('suivi.counts', ctx, {});
  assert.deepEqual([road.counts.on_the_road, road.counts.alerts, road.total], [appRoad.enlivraison, appRoad.alertes, appRoad.enlivraison]);
  assert.ok(road.parcels.length <= 5 && road.parcels.every((x: any) => ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange'].includes(x.delivery)));
  assert.equal((await tool(env, 'delivery_follow_up')).list, 'alerts');
  const cos = await tool(env, 'delivery_companies');
  assert.ok(cos.companies.length >= 2 && cos.companies.every((c: any) => c.name && typeof c.in_use === 'boolean'));
  const cust = await tool(env, 'customer_history', { phone: o.phone });
  assert.ok(cust.customer.orders >= 1 && cust.customer.phone === o.phone && cust.orders.some((x: any) => x.id === o.id));
  assert.match((await tool(env, 'customer_history', { phone: '0550000000' })).error, /introuvable/);
  // nothing private leaves: no photo, no key, no courier settings, no purchase price
  const everything = JSON.stringify([found, full, counts, st, dash, agents, prods, stock, road, cos, cust]);
  for (const word of ['data:image', 'settings', 'keysSet', 'statusMap', 'credentials', 'cost', 'purchasePrice', 'password', 'token']) assert.ok(!everything.includes(word), `« ${word} » left Pilotix`);
  // mistakes the assistant can read and fix
  assert.equal((await say(env, 'tools/call', { name: 'delete_everything', arguments: {} })).error.code, -32602);
  assert.match((await tool(env, 'search_orders', { status: 'confirmed' })).error, /Invalid arguments for search_orders/);
  assert.match((await tool(env, 'search_orders', { limit: 500 })).error, /Invalid arguments/);
  assert.match((await tool(env, 'search_orders', { delivery: ['flying'] })).error, /Invalid arguments/);
  // a link that was not allowed to read reads nothing
  assert.match((await tool({ ...env, scope: [] }, 'search_orders')).error, /Accès refusé/);
  // a bug in a tool is not shown to the assistant
  const errors: string[] = [];
  const broken: McpEnv = { ...env, call: async () => Promise.reject(new TypeError('secret detail')), onError: (e, where) => errors.push(`${where}: ${(e as Error).message}`) };
  const r = await tool(broken, 'order_counts');
  assert.ok(r.error && !r.error.includes('secret detail'));
  assert.deepEqual(errors, ['tool order_counts: secret detail']);
});

test('an agent, the depot and a livreur see through the link what their own screen shows', async () => {
  const admin = await envFor(EMAILS.admin);
  const all = (await tool(admin, 'search_orders', { limit: 1 })).total;
  // a confirmation agent: her own orders
  const conf = await envFor(EMAILS.conf);
  const confCtx: Ctx = { db, session: await login(db, EMAILS.conf, DEMO_PASSWORD), now: () => Date.now(), emit: () => undefined };
  const hers = await tool(conf, 'search_orders', { limit: 50 });
  const app: any = await call('orders.list', confCtx, { pageSize: 50 });
  assert.equal(hers.total, app.total);
  assert.deepEqual(hers.orders.map((x: any) => x.id), app.rows.map((x: any) => x.id));
  assert.ok(hers.total < all);
  assert.match((await tool(conf, 'shop_dashboard')).error, /Accès refusé/);
  assert.match((await tool(conf, 'stock_levels')).error, /Accès refusé/);
  assert.equal((await tool(conf, 'whoami')).administrator, false);
  // an order given to another agent stays closed
  const notHers = (await tool(admin, 'search_orders', { limit: 50 })).orders.find((x: any) => !hers.orders.some((y: any) => y.id === x.id) && x.agent && x.agent !== conf.who.name);
  assert.match((await tool(conf, 'get_order', { id: notHers.id })).error, /autre agent|Accès refusé/);
  // the depot: the stock, no customer file
  const depot = await envFor(EMAILS.depot);
  assert.ok((await tool(depot, 'stock_levels')).stock.length >= 3);
  assert.match((await tool(depot, 'customer_history', { phone: hers.orders[0].phone })).error, /Accès refusé/);
  // a livreur: his own deliveries, and no customer before the parcel is in his hands
  const liv = await envFor(EMAILS.livreur);
  const livCtx: Ctx = { db, session: await login(db, EMAILS.livreur, DEMO_PASSWORD), now: () => Date.now(), emit: () => undefined };
  const his = await tool(liv, 'search_orders', { limit: 50 });
  const appLiv: any = await call('orders.list', livCtx, { pageSize: 50 });
  assert.deepEqual(his.orders.map((x: any) => x.id), appLiv.rows.map((x: any) => x.id));
  assert.deepEqual(his.orders.map((x: any) => x.phone ?? ''), appLiv.rows.map((x: any) => x.phone));
  const notHis = (await tool(admin, 'search_orders', { limit: 50 })).orders.find((x: any) => !appLiv.rows.some((y: any) => y.id === x.id));
  assert.match((await tool(liv, 'get_order', { id: notHis.id })).error, /Accès refusé/);
  assert.match((await tool(liv, 'stats_overview')).error, /Accès refusé/);
});

// ---------------------------------------------------------------- the log, and « Peut modifier »
test('the log: each tool an assistant used, with what came of it — a phone number cut, never the answer', async () => {
  const calls: McpCall[] = [];
  const plain = await envFor(EMAILS.conf);
  const phone = String((await tool(plain, 'search_orders', { limit: 1 })).orders[0].phone);
  const conf = { ...plain, log: (c: McpCall) => calls.push(c) };
  const found = await tool(conf, 'search_orders', { limit: 5, q: '  Vélo  ', delivery: ['delivered'] });
  await tool(conf, 'shop_dashboard');
  await tool(conf, 'customer_history', { phone });
  await tool(conf, 'search_orders', { limit: 500 });
  // what is not a tool call is not written
  await say(conf, 'tools/list');
  await say(conf, 'ping');
  assert.deepEqual(
    calls.map((c) => [c.tool, c.kind]),
    [
      ['search_orders', 'read'],
      ['shop_dashboard', 'refused'],
      ['customer_history', 'read'],
      ['search_orders', 'error'],
    ],
  );
  assert.deepEqual(calls[0].detail, { q: 'Vélo', delivery: ['delivered'], count: found.total });
  assert.match(String(calls[1].detail.why), /Accès refusé/);
  const digits = String(phone).replace(/\D/g, '');
  assert.equal(calls[2].detail.phone, `${digits.slice(0, 4)} •• •• ${digits.slice(-2)}`);
  assert.ok(!JSON.stringify(calls).includes(digits), 'the whole number is never kept');
  assert.match(String(calls[3].detail.why), /Invalid arguments/);
  // a log that fails never stops the answer
  const broken = { ...(await envFor(EMAILS.admin)), log: () => { throw new Error('log down'); } };
  assert.ok((await tool(broken, 'order_counts')) && true);
});

test('the log is read by its person, or by the boutique’s administrators for the whole team; 90 days', async () => {
  const at = T0 + 10 * DAY;
  const add = (shopId: number, profileId: number, tool: string, kind: 'read' | 'refused' | 'error', now: number) =>
    mcpLogAdd(t, { shopId, profileId, grantId: null, client: 'Claude', host: 'claude.ai', kind, tool, detail: { count: 3 } }, now);
  await add(5, 7, 'search_orders', 'read', at);
  await add(5, 8, 'stock_levels', 'refused', at + 1000);
  await add(5, 7, 'whoami', 'read', at + 2000);
  await add(6, 7, 'whoami', 'read', at + 2000);
  const mine = await mcpLog(t, 5, { profileId: 7 }, at + 5000);
  assert.deepEqual(mine.lines.map((l) => l.tool), ['whoami', 'search_orders']);
  assert.deepEqual([mine.lines[1].client, mine.lines[1].host, mine.lines[1].kind, mine.lines[1].detail, mine.more], ['Claude', 'claude.ai', 'read', { count: 3 }, false]);
  const team = await mcpLog(t, 5, { profileId: null }, at + 5000);
  assert.deepEqual(team.lines.map((l) => [l.profileId, l.tool]), [[7, 'whoami'], [8, 'stock_levels'], [7, 'search_orders']]);
  assert.deepEqual((await mcpLog(t, 5, { profileId: null, filter: 'refused' }, at + 5000)).lines.map((l) => l.tool), ['stock_levels']);
  // 2 at a time: the next ones after the last shown
  const p1 = await mcpLog(t, 5, { profileId: null, limit: 2 }, at + 5000);
  const p2 = await mcpLog(t, 5, { profileId: null, limit: 2, before: p1.lines[1].id }, at + 5000);
  assert.deepEqual([p1.more, p2.more, p2.lines.map((l) => l.tool)], [true, false, ['search_orders']]);
  // after 90 days the lines are gone
  assert.deepEqual((await mcpLog(t, 5, { profileId: null }, at + (LOG_DAYS + 1) * DAY)).lines, []);
  assert.equal((await mcpLog(t, 6, { profileId: null }, at + 5000)).lines.length, 1);
});

test('« Peut modifier »: only the link’s person turns it on, part by part, and the log says so', async () => {
  const l = await link();
  const mine = async () => (await mcpLinks(t, 1, 7, 0, T0)).find((x) => x.id === l.id)!;
  assert.deepEqual((await mine()).write, []);
  assert.deepEqual((await mcpAccess(t, SECRET, BASE, l.access, person, T0))!.write, []);
  // someone else's link, an unknown part, not a list
  await assert.rejects(mcpSetWrite(t, 1, 8, l.id, ['orders'], T0), /introuvable/);
  await assert.rejects(mcpSetWrite(t, 2, 7, l.id, ['orders'], T0), /introuvable/);
  await assert.rejects(mcpSetWrite(t, 1, 7, l.id, ['orders', 'delete'], T0), /inconnue/);
  await assert.rejects(mcpSetWrite(t, 1, 7, l.id, 'orders', T0), /inconnue/);
  assert.deepEqual((await mcpSetWrite(t, 1, 7, l.id, ['products', 'orders', 'orders'], T0)).write, ['orders', 'products']);
  assert.deepEqual((await mine()).write, ['orders', 'products']);
  // the link's own key knows it (for the tools that change things), with the assistant's name and site
  const a = (await mcpAccess(t, SECRET, BASE, l.access, person, T0 + 1000))!;
  assert.deepEqual([a.write, a.client, a.host], [['orders', 'products'], 'Claude', 'claude.ai']);
  // written in the log, as a change
  const log = await mcpLog(t, 1, { profileId: 7, filter: 'change' }, T0 + 2000);
  assert.deepEqual([log.lines[0].kind, log.lines[0].tool, log.lines[0].detail], ['setting', 'write', { parts: ['orders', 'products'] }]);
  // back to reading only; a cut link cannot be changed
  assert.deepEqual((await mcpSetWrite(t, 1, 7, l.id, [], T0)).write, []);
  await mcpCut(t, 1, 7, l.id, T0);
  await assert.rejects(mcpSetWrite(t, 1, 7, l.id, ['orders'], T0), /introuvable/);
});
