// End-to-end check of the AI assistants' link (MCP: apps/server/src/mcp.ts) on a running demo server, as Claude or
// ChatGPT use it: the door's papers, an assistant registering, the person saying yes in the app, the keys, every tool
// as an administrator, what an agent and a livreur see, the renewal key, « Couper », a new password.
//   API=http://localhost:3000/api node scripts/mcp-test.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const API = process.env.API || 'http://localhost:3000/api';
const PASS = 'demo-pilotix';
const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
const run = Date.now().toString(36).slice(-6);

const results = [];
const ok = (m) => console.log(`   ✓ ${m}`);
async function section(name, fn) {
  console.log(`\n■ ${name}`);
  try {
    await fn();
    results.push([name, null]);
  } catch (e) {
    console.log(`   ✗ FAILED: ${e.message}\n${String(e.stack || '').split('\n').slice(1, 4).join('\n')}`);
    results.push([name, e.message]);
  }
}
async function http(path, { method, body, token, headers, form } = {}) {
  const r = await fetch(path.startsWith('http') ? path : API + path, {
    method: method ?? (body === undefined && form === undefined ? 'GET' : 'POST'),
    redirect: 'manual',
    headers: {
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: form ? new URLSearchParams(form).toString() : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data, headers: r.headers };
}
const login = async (email, password = PASS) => {
  const r = await http('/auth/login', { body: { email, password } });
  assert.equal(r.status, 201, `login ${email}: ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data.token;
};
const rpc = async (token, name, input = {}) => {
  const r = await http(`/rpc/${name}`, { body: input, token });
  assert.ok(r.status < 300, `${name} → ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
};
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** An assistant registers (as Claude does). */
async function register(extra = {}) {
  const r = await http('/mcp/register', { body: { client_name: 'Claude', redirect_uris: [CLAUDE], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
/** The assistant sends the person to Pilotix: the ticket of the app's « Autoriser » page. */
async function ask(client, p, extra = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_challenge: p.challenge, code_challenge_method: 'S256', state: `st-${run}`, scope: 'read', resource: META.resource.resource, ...extra });
  const r = await http(`/mcp/authorize?${q}`);
  assert.equal(r.status, 302, `authorize → ${r.status} ${String(r.data).slice(0, 200)}`);
  const to = new URL(r.headers.get('location'));
  return { to, ticket: to.searchParams.get('mcp') };
}
/** The whole way: an assistant linked to this person's account; its keys. */
async function link(appToken, extraRegister = {}) {
  const client = await register(extraRegister);
  const p = pkce();
  const { ticket } = await ask(client, p);
  assert.ok(ticket, 'the app’s page gets its ticket');
  const a = await http('/mcp/answer', { body: { ticket, allow: true }, token: appToken });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const back = new URL(a.data.redirect);
  const code = back.searchParams.get('code');
  const t = await http('/mcp/token', { form: { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: client.client_id, redirect_uri: client.redirect_uris[0], resource: META.resource.resource, ...(client.client_secret ? { client_secret: client.client_secret } : {}) } });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  return { client, code, verifier: p.verifier, back, ...t.data };
}
let rpcId = 0;
/** One MCP message to the link. */
const mcp = (token, method, params, headers) => http('/mcp', { body: { jsonrpc: '2.0', id: ++rpcId, method, ...(params === undefined ? {} : { params }) }, token, headers: { Accept: 'application/json, text/event-stream', ...headers } });
/** A tool's answer (parsed), or its error text. */
async function tool(token, name, args = {}) {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, `${name} → ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  assert.ok(r.data.result, `${name}: ${JSON.stringify(r.data).slice(0, 300)}`);
  const text = r.data.result.content[0].text;
  return r.data.result.isError ? { error: text } : JSON.parse(text);
}

let META;
let ADMIN;

await section('The door’s papers', async () => {
  const resource = (await http('/mcp/resource')).data;
  const server = (await http('/mcp/server')).data;
  META = { resource, server };
  assert.equal(resource.authorization_servers[0], server.issuer, 'the same issuer in both papers');
  assert.ok(resource.resource.endsWith('/mcp'));
  assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  assert.ok(server.registration_endpoint && server.authorization_endpoint && server.token_endpoint);
  assert.equal(server.authorization_response_iss_parameter_supported, true);
  ok('where the link is, who gives its keys, PKCE S256, registration open');
  const r = await http('/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /^Bearer resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp", scope="read"$/);
  ok('no key: 401, and the way to the sign-in door');
  const bad = await http('/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize' }, token: 'pxa_bm9wZQ.nope' });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('www-authenticate'), /error="invalid_token"/);
  // an app session is not a key of the link, and a link's key is not an app session
  ADMIN = await login('admin@demo.pilotix.dz');
  assert.equal((await http('/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize' }, token: ADMIN })).status, 401);
  ok('a made-up key and the app’s own session are refused');
  // a person who opens the link in a browser reads what it is for; an assistant asking the same way gets its usual answer
  const page = await fetch(`${API}/mcp`, { headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
  const html = await page.text();
  assert.equal(page.status, 401);
  assert.match(page.headers.get('www-authenticate'), /^Bearer resource_metadata=/);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  assert.ok(html.includes('Claude') && html.includes(resource.resource) && !/<script/i.test(html), html.slice(0, 200));
  const stream = await fetch(`${API}/mcp`, { headers: { Accept: 'text/event-stream' } });
  assert.equal(stream.status, 401);
  assert.match(stream.headers.get('content-type'), /^application\/json/);
  assert.equal((await stream.json()).error, 'unauthorized');
  ok('opened in a browser: a page says what the link is for (the same 401 for an assistant)');
});

await section('An assistant registers', async () => {
  const c = await register();
  assert.ok(c.client_id.startsWith('pxc_') && !c.client_secret && c.token_endpoint_auth_method === 'none');
  ok('Claude: a client id, no secret');
  for (const uri of ['https://evil.example/cb', 'http://claude.ai/api/mcp/auth_callback', 'https://claude.ai.evil.example/api/mcp/auth_callback', 'https://user@claude.ai/api/mcp/auth_callback', 'https://claude.ai/public/artifacts/x', 'https://chatgpt.com/share/x', 'javascript:alert(1)', 'https://chatgpt.com:8443/connector_platform_oauth_redirect']) {
    const r = await http('/mcp/register', { body: { client_name: 'Claude', redirect_uris: [uri] } });
    assert.equal(r.status, 400, uri);
    assert.equal(r.data.error, 'invalid_redirect_uri', uri);
  }
  ok('an answer address that is not Claude’s or ChatGPT’s own (another page of their sites too), or this computer’s: refused');
  const g = await register({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'client_secret_post' });
  assert.ok(g.client_secret?.startsWith('pxs_'));
  const l = await register({ client_name: 'Claude Code', redirect_uris: ['http://localhost:33418/callback'] });
  assert.ok(l.client_id);
  ok('ChatGPT (with a secret) and a tool on this computer');
});

await section('The assistant sends the person to say yes', async () => {
  const c = await register();
  const p = pkce();
  const page = async (q) => http(`/mcp/authorize?${new URLSearchParams(q)}`);
  const base = { response_type: 'code', client_id: c.client_id, redirect_uri: CLAUDE, code_challenge: p.challenge, code_challenge_method: 'S256', state: 'abc' };
  let r = await page({ ...base, client_id: `${c.client_id}x` });
  assert.equal(r.status, 400);
  assert.equal(r.headers.get('location'), null);
  r = await page({ ...base, redirect_uri: 'https://claude.ai/other' });
  assert.equal(r.status, 400);
  assert.equal(r.headers.get('location'), null);
  ok('an unknown assistant, another answer address: a page says so, nothing is sent anywhere');
  for (const [q, err] of [
    [{ ...base, code_challenge: '' }, 'invalid_request'],
    [{ ...base, code_challenge_method: 'plain' }, 'invalid_request'],
    [{ ...base, response_type: 'token' }, 'unsupported_response_type'],
    [{ ...base, resource: 'https://other.example/mcp' }, 'invalid_target'],
  ]) {
    r = await page(q);
    assert.equal(r.status, 302);
    const u = new URL(r.headers.get('location'));
    assert.equal(u.origin + u.pathname, CLAUDE);
    assert.equal(u.searchParams.get('error'), err);
    assert.equal(u.searchParams.get('state'), 'abc');
    assert.equal(u.searchParams.get('iss'), META.server.issuer);
  }
  ok('no PKCE lock, a wrong kind of answer, another resource: told to the assistant’s site');
  const { to, ticket } = await ask(c, p);
  assert.equal(to.origin, new URL(META.server.issuer).origin);
  assert.ok(ticket.startsWith('pxq_'));
  // the app's page: who asks
  assert.equal((await http('/mcp/ask', { body: { ticket } })).status, 401);
  const a = await http('/mcp/ask', { body: { ticket }, token: ADMIN });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.deepEqual({ client: a.data.client, host: a.data.host, site: a.data.site, scope: a.data.scope, cannot: a.data.cannot }, { client: 'Claude', host: 'claude.ai', site: 'known', scope: ['read'], cannot: null });
  assert.equal((await http('/mcp/ask', { body: { ticket: `${ticket}x` }, token: ADMIN })).status, 400);
  ok('the app’s « Autoriser » page: logged in only, it names Claude and claude.ai; a changed ticket is refused');
  assert.equal((await http('/mcp/answer', { body: { ticket, allow: true } })).status, 401);
  const no = await http('/mcp/answer', { body: { ticket, allow: false }, token: ADMIN });
  const u = new URL(no.data.redirect);
  assert.deepEqual([u.origin + u.pathname, u.searchParams.get('error'), u.searchParams.get('state'), u.searchParams.get('iss'), u.searchParams.get('code')], [CLAUDE, 'access_denied', `st-${run}`, META.server.issuer, null]);
  ok('« Refuser »: the assistant’s site is told, no code');
});

let L;
await section('The keys', async () => {
  // a wrong PKCE key, another assistant: no keys
  const c = await register();
  const p = pkce();
  const { ticket } = await ask(c, p);
  const back = new URL((await http('/mcp/answer', { body: { ticket, allow: true }, token: ADMIN })).data.redirect);
  assert.equal(back.searchParams.get('state'), `st-${run}`);
  assert.equal(back.searchParams.get('iss'), META.server.issuer);
  const code = back.searchParams.get('code');
  const form = { grant_type: 'authorization_code', code, code_verifier: p.verifier, client_id: c.client_id, redirect_uri: CLAUDE };
  for (const [f, what] of [
    [{ ...form, code_verifier: pkce().verifier }, 'a wrong PKCE key'],
    [{ ...form, client_id: (await register()).client_id }, 'another assistant'],
    [{ ...form, redirect_uri: 'https://claude.com/api/mcp/auth_callback' }, 'another answer address'],
    [{ ...form, code: `${code}x` }, 'a changed code'],
    [{ ...form, grant_type: 'password' }, 'another kind of grant'],
  ]) {
    const r = await http('/mcp/token', { form: f });
    assert.equal(r.status, 400, what);
    assert.ok(['invalid_grant', 'unsupported_grant_type'].includes(r.data.error), what);
  }
  ok('a wrong PKCE key, another assistant, another address, a changed code: no keys');
  const t = await http('/mcp/token', { form });
  assert.equal(t.status, 200, JSON.stringify(t.data));
  assert.deepEqual([t.data.token_type, t.data.expires_in, t.data.scope], ['Bearer', 3600, 'read']);
  assert.equal(t.headers.get('cache-control'), 'no-store');
  assert.equal((await mcp(t.data.access_token, 'ping')).status, 200);
  ok('the code and its PKCE key: an access key (1 hour) and a renewal key');
  // the code a second time: refused, and the keys it gave stop
  const again = await http('/mcp/token', { form });
  assert.equal(again.status, 400);
  assert.equal((await mcp(t.data.access_token, 'ping')).status, 401);
  assert.equal((await http('/mcp/token', { form: { grant_type: 'refresh_token', refresh_token: t.data.refresh_token, client_id: c.client_id } })).status, 400);
  ok('the same code again: refused, and the link it had opened is cut');
  // an assistant with a secret must show it
  const g = await register({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'client_secret_post' });
  const p2 = pkce();
  const a2 = await ask(g, p2);
  const code2 = new URL((await http('/mcp/answer', { body: { ticket: a2.ticket, allow: true }, token: ADMIN })).data.redirect).searchParams.get('code');
  const f2 = { grant_type: 'authorization_code', code: code2, code_verifier: p2.verifier, client_id: g.client_id };
  assert.equal((await http('/mcp/token', { form: f2 })).status, 401);
  assert.equal((await http('/mcp/token', { form: { ...f2, client_secret: 'pxs_wrong' } })).status, 401);
  const basic = `Basic ${Buffer.from(`${encodeURIComponent(g.client_id)}:${encodeURIComponent(g.client_secret)}`).toString('base64')}`;
  const t2 = await http('/mcp/token', { form: { grant_type: 'authorization_code', code: code2, code_verifier: p2.verifier }, headers: { Authorization: basic } });
  assert.equal(t2.status, 200, JSON.stringify(t2.data));
  ok('an assistant with a secret: no keys without it, keys with it (in the form or in the header)');
  L = await link(ADMIN);
});

await section('The link, as an administrator', async () => {
  const A = L.access_token;
  const init = await mcp(A, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.status, 200);
  assert.equal(init.data.result.protocolVersion, '2025-06-18');
  assert.equal(init.data.result.serverInfo.name, 'pilotix');
  assert.ok(init.data.result.capabilities.tools);
  assert.match(init.data.result.instructions, /read-only/);
  assert.equal((await mcp(A, 'initialize', { protocolVersion: '1999-01-01' })).data.result.protocolVersion, '2025-11-25');
  const note = await http('/mcp', { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, token: A });
  assert.equal(note.status, 202);
  ok('initialize (the version asked, else the newest), notifications taken');
  const list = (await mcp(A, 'tools/list')).data.result.tools;
  assert.deepEqual(list.map((t) => t.name).sort(), ['agent_stats', 'customer_history', 'delivery_companies', 'delivery_follow_up', 'get_order', 'order_counts', 'search_orders', 'search_products', 'shop_dashboard', 'stats_overview', 'stock_levels', 'whoami']);
  assert.ok(list.every((t) => t.annotations.readOnlyHint === true && t.inputSchema.type === 'object' && t.description.length > 20));
  ok(`${list.length} tools, all read-only`);
  const me = await tool(A, 'whoami');
  assert.equal(me.email, 'admin@demo.pilotix.dz');
  assert.equal(me.administrator, true);
  assert.match(me.today, /^\d{4}-\d\d-\d\d$/);
  const found = await tool(A, 'search_orders', { limit: 5 });
  assert.ok(found.total >= 100 && found.orders.length === 5 && found.orders[0].ref && found.orders[0].phone);
  assert.equal(found.total, (await rpc(ADMIN, 'orders.list', { pageSize: 1 })).total, 'the same count as the app');
  const o = found.orders[0];
  const byRef = await tool(A, 'get_order', { ref: o.ref.toLowerCase() });
  assert.equal(byRef.id, o.id);
  assert.ok(Array.isArray(byRef.history) && byRef.history.length >= 1 && Array.isArray(byRef.products) && byRef.products.length >= 1);
  assert.equal((await tool(A, 'get_order', { id: o.id })).ref, o.ref);
  const delivered = await tool(A, 'search_orders', { delivery: ['delivered'], limit: 3 });
  assert.ok(delivered.orders.length && delivered.orders.every((x) => x.delivery === 'delivered'));
  assert.equal((await tool(A, 'search_orders', { q: o.phone, limit: 50 })).orders.every((x) => x.phone === o.phone), true);
  ok('whoami, search_orders (the app’s count, by status, by phone), get_order (by id, by reference)');
  const counts = await tool(A, 'order_counts');
  assert.ok(counts.all_orders >= 100 && Object.keys(counts.confirmation).length && Object.keys(counts.delivery).length);
  const year = { from: '2026-01-01', to: '2026-12-31' };
  const st = await tool(A, 'stats_overview', year);
  assert.ok(st.received >= 100 && st.confirmation_rate_pct > 0 && st.confirmation_rate_pct <= 100 && st.delivery_rate_pct > 0 && st.delivery_rate_pct <= 100);
  const today = await tool(A, 'stats_overview');
  assert.equal(Date.parse(today.period.to) - Date.parse(today.period.from), 86_400_000, 'no dates: today');
  const dash = await tool(A, 'shop_dashboard', year);
  assert.ok(dash.revenue_da > 0 && dash.top_products.length && dash.funnel.received >= 100 && typeof dash.per_day === 'string');
  assert.ok(Array.isArray((await tool(A, 'shop_dashboard')).per_day));
  const agents = await tool(A, 'agent_stats', year);
  assert.ok(agents.agents.length >= 3 && agents.agents[0].agent);
  ok('order_counts, stats_overview, shop_dashboard, agent_stats');
  const prods = await tool(A, 'search_products', { limit: 5 });
  assert.ok(prods.products.length && prods.products[0].variants.length && prods.products[0].price_da > 0);
  const stock = await tool(A, 'stock_levels', {});
  assert.ok(stock.stock.length && stock.stock[0].depot && Number.isInteger(stock.stock[0].available));
  const low = await tool(A, 'stock_levels', { low_only: true });
  assert.ok(low.stock.every((x) => x.available <= x.alert_at));
  const follow = await tool(A, 'delivery_follow_up', { list: 'on_the_road', limit: 5 });
  assert.ok(follow.counts.on_the_road >= 1 && follow.parcels.length && follow.parcels.length <= 5);
  const cos = await tool(A, 'delivery_companies');
  assert.ok(cos.companies.length >= 2 && cos.companies[0].name);
  const cust = await tool(A, 'customer_history', { phone: o.phone });
  assert.ok(cust.customer.orders >= 1 && cust.orders.some((x) => x.id === o.id));
  ok('search_products, stock_levels, delivery_follow_up, delivery_companies, customer_history');
  // nothing private leaves: no photo, no key, no courier settings, no purchase price
  const all = JSON.stringify([found, byRef, prods, stock, cos, dash]);
  for (const word of ['data:image', 'settings', 'keysSet', 'statusMap', 'credentials', 'cost', 'purchasePrice', 'password']) assert.ok(!all.includes(word), `« ${word} » left Pilotix`);
  ok('no photo, no key, no courier settings, no purchase price in what the tools give');
  // mistakes an assistant can read
  assert.equal((await mcp(A, 'tools/call', { name: 'delete_everything', arguments: {} })).data.error.code, -32602);
  assert.match((await tool(A, 'search_orders', { status: 'confirmed' })).error, /Invalid arguments/);
  assert.match((await tool(A, 'get_order', { ref: 'PX-NOPE-0000' })).error, /introuvable/);
  assert.match((await tool(A, 'stats_overview', { from: '2026-13-45' })).error, /Date invalide/);
  assert.equal((await mcp(A, 'nope/nope')).data.error.code, -32601);
  assert.equal((await mcp(A, 'ping', undefined, { 'MCP-Protocol-Version': '1999-01-01' })).status, 400);
  assert.equal((await mcp(A, 'ping', undefined, { 'MCP-Protocol-Version': '2025-06-18' })).status, 200);
  assert.equal((await http('/mcp', { token: A })).status, 405);
  assert.equal((await http('/mcp')).status, 401);
  const batch = await http('/mcp', { body: [{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }], token: A });
  assert.deepEqual(batch.data.map((x) => x.id), ['a', 'b']);
  ok('an unknown tool, wrong arguments, an unknown order, a wrong date, an unknown method, a wrong version: each says why');
  // the link's key opens nothing else
  assert.equal((await http('/rpc/me.get', { body: {}, token: A })).status, 401);
  assert.equal((await http('/rpc/orders.list', { body: {}, token: L.refresh_token })).status, 401);
  ok('a key of the link is not a session of the app');
});

await section('An agent and a livreur see what their own screen shows', async () => {
  const conf = await login('samira@demo.pilotix.dz');
  const S = await link(conf);
  const names = (await mcp(S.access_token, 'tools/list')).data.result.tools.map((t) => t.name);
  assert.ok(!names.includes('shop_dashboard') && !names.includes('stock_levels') && names.includes('search_orders') && names.includes('customer_history'));
  assert.match((await tool(S.access_token, 'shop_dashboard')).error, /Accès refusé/);
  assert.match((await tool(S.access_token, 'stock_levels')).error, /Accès refusé/);
  const mine = await tool(S.access_token, 'search_orders', { limit: 1 });
  assert.equal(mine.total, (await rpc(conf, 'orders.list', { pageSize: 1 })).total);
  assert.ok(mine.total < (await rpc(ADMIN, 'orders.list', { pageSize: 1 })).total, 'an agent does not see every order');
  assert.equal((await tool(S.access_token, 'whoami')).administrator, false);
  ok('a confirmation agent: her own orders (the app’s count), no owner’s dashboard, no stock');
  const liv = await login('lamine@demo.pilotix.dz');
  const V = await link(liv);
  const his = await tool(V.access_token, 'search_orders', { limit: 50 });
  const app = await rpc(liv, 'orders.list', { pageSize: 50 });
  assert.equal(his.total, app.total);
  assert.deepEqual(his.orders.map((x) => x.id).sort(), app.rows.map((x) => x.id).sort());
  // an order that is not his
  const other = (await rpc(ADMIN, 'orders.list', { pageSize: 50 })).rows.find((x) => !app.rows.some((y) => y.id === x.id) && x.livreurId === null);
  assert.match((await tool(V.access_token, 'get_order', { id: other.id })).error, /Accès refusé/);
  assert.match((await tool(V.access_token, 'customer_history', { phone: other.phone })).error, /Accès refusé/);
  ok('a livreur: his own deliveries only, no other order, no customer file');
});

await section('The renewal key', async () => {
  const r1 = await http('/mcp/token', { form: { grant_type: 'refresh_token', refresh_token: L.refresh_token, client_id: L.client.client_id } });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.notEqual(r1.data.refresh_token, L.refresh_token);
  assert.equal((await mcp(r1.data.access_token, 'ping')).status, 200);
  ok('a new access key, and a new renewal key');
  // the answer lost on the way: the same key again, a moment later, gives the same new one
  const retry = await http('/mcp/token', { form: { grant_type: 'refresh_token', refresh_token: L.refresh_token, client_id: L.client.client_id } });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.refresh_token, r1.data.refresh_token);
  ok('the same renewal key a moment later (a lost answer): the same new key');
  const r2 = await http('/mcp/token', { form: { grant_type: 'refresh_token', refresh_token: r1.data.refresh_token } });
  assert.equal(r2.status, 200);
  // an older key, once the next one was used: it was copied — the link is cut
  const old = await http('/mcp/token', { form: { grant_type: 'refresh_token', refresh_token: L.refresh_token, client_id: L.client.client_id } });
  assert.equal(old.status, 400);
  assert.equal(old.data.error, 'invalid_grant');
  assert.equal((await mcp(r2.data.access_token, 'ping')).status, 401);
  assert.equal((await http('/mcp/token', { form: { grant_type: 'refresh_token', refresh_token: r2.data.refresh_token } })).status, 400);
  ok('an old renewal key used again: the link is cut for everyone holding one');
  assert.equal((await http('/mcp/token', { form: { grant_type: 'refresh_token', refresh_token: 'pxr_1.0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } })).status, 400);
  ok('a made-up renewal key: refused');
});

await section('« Couper » and a new password', async () => {
  // a fresh person of the team (the demo accounts keep their password)
  const email = `mcp.${run}@mcp-test.dz`;
  await rpc(ADMIN, 'users.create', { phone: `0770${String(Date.now()).slice(-6)}`, name: 'Mcp Test', email, password: 'Mcp-Test-0001', roles: ['admin'], language: 'fr' });
  const tok = await login(email, 'Mcp-Test-0001');
  const a = await link(tok);
  const b = await link(tok);
  const mine = (await http('/mcp/links', { body: {}, token: tok })).data;
  // the page also gets the link to give an assistant: the site's own (the one its papers name)
  assert.equal(mine.link, META.resource.resource);
  let links = mine.links;
  assert.equal(links.length, 2);
  assert.deepEqual([links[0].client, links[0].host, links[0].scope], ['Claude', 'claude.ai', ['read']]);
  // nobody else's
  assert.equal((await http('/mcp/links', { body: {}, token: ADMIN })).data.links.some((x) => links.some((y) => y.id === x.id)), false);
  assert.equal((await http('/mcp/cut', { body: { id: links[0].id }, token: ADMIN })).status, 404);
  ok('Mon profil › Assistants IA: the link to give, my own links only, and nobody else cuts them');
  const cut = links.find((x) => x.id === Number(/^pxr_(\d+)\./.exec(a.refresh_token)[1]));
  assert.equal((await http('/mcp/cut', { body: { id: cut.id }, token: tok })).status, 201);
  assert.equal((await mcp(a.access_token, 'ping')).status, 401);
  assert.equal((await http('/mcp/token', { form: { grant_type: 'refresh_token', refresh_token: a.refresh_token } })).status, 400);
  assert.equal((await mcp(b.access_token, 'ping')).status, 200);
  links = (await http('/mcp/links', { body: {}, token: tok })).data.links;
  assert.equal(links.length, 1);
  ok('« Couper »: that assistant’s keys stop at once, the other one goes on');
  // a new password ends every link made before it
  const pw = await http('/rpc/me.password', { body: { current: 'Mcp-Test-0001', next: 'Mcp-Test-0002' }, token: tok });
  assert.ok(pw.status < 300, JSON.stringify(pw.data));
  assert.equal((await mcp(b.access_token, 'ping')).status, 401);
  assert.equal((await http('/mcp/token', { form: { grant_type: 'refresh_token', refresh_token: b.refresh_token } })).status, 400);
  assert.equal((await http('/mcp/links', { body: {}, token: pw.data.token })).data.links.length, 0);
  ok('a new password: the links made before it are over');
  // the account closed: its links too
  const tok2 = await login(email, 'Mcp-Test-0002');
  const c = await link(tok2);
  assert.equal((await mcp(c.access_token, 'ping')).status, 200);
  const id = (await rpc(tok2, 'me.get')).profile.id;
  await rpc(ADMIN, 'users.update', { id, active: false });
  assert.equal((await mcp(c.access_token, 'ping')).status, 401);
  ok('the account closed by the administrator: its link stops');
});

await section('The log, and « Peut modifier »', async () => {
  const conf = await login('samira@demo.pilotix.dz');
  const S = await link(conf);
  const sid = Number(/^pxr_(\d+)\./.exec(S.refresh_token)[1]);
  await tool(S.access_token, 'search_orders', { limit: 1 });
  assert.match((await tool(S.access_token, 'shop_dashboard')).error, /Accès refusé/);
  // the log is written just after the answer: a moment
  let mine = { lines: [] };
  for (let i = 0; i < 30 && !mine.lines.some((l) => l.tool === 'shop_dashboard'); i++) {
    if (i) await new Promise((r) => setTimeout(r, 100));
    mine = (await http('/mcp/log', { body: {}, token: conf })).data;
  }
  const said = mine.lines.map((l) => `${l.tool}:${l.kind}`);
  assert.ok(said.includes('search_orders:read') && said.includes('shop_dashboard:refused'), said.join(' '));
  assert.ok(mine.lines.every((l) => l.mine && l.client === 'Claude' && l.host === 'claude.ai'), JSON.stringify(mine.lines[0]));
  assert.match(mine.lines.find((l) => l.tool === 'shop_dashboard').detail.why, /Accès refusé/);
  ok('the log: each tool the assistant used and what came of it, in its person’s log');
  // the whole team's log: the boutique's administrators only, each line with its person
  assert.equal((await http('/mcp/log', { body: { team: true }, token: conf })).status, 403);
  const team = (await http('/mcp/log', { body: { team: true }, token: ADMIN })).data;
  assert.ok(team.lines.some((l) => l.tool === 'shop_dashboard' && !l.mine && l.person), 'the administrator sees the agent’s lines, with her name');
  assert.equal((await http('/mcp/log', { body: {}, token: ADMIN })).data.lines.some((l) => l.tool === 'shop_dashboard' && !l.mine), false);
  assert.ok((await http('/mcp/log', { body: { team: true, filter: 'refused' }, token: ADMIN })).data.lines.every((l) => l.kind === 'refused'));
  ok('the whole team’s log: its administrators only, each line with its person');
  // « Peut modifier »: the person turns it on from Pilotix, part by part — nobody else
  assert.equal((await http('/mcp/write', { body: { id: sid, parts: ['orders'] }, token: ADMIN })).status, 404);
  assert.equal((await http('/mcp/write', { body: { id: sid, parts: ['delete'] }, token: conf })).status, 400);
  const w = await http('/mcp/write', { body: { id: sid, parts: ['products', 'orders'] }, token: conf });
  assert.equal(w.status, 201, JSON.stringify(w.data));
  assert.deepEqual(w.data.write, ['orders', 'products']);
  assert.deepEqual((await http('/mcp/links', { body: {}, token: conf })).data.links.find((x) => x.id === sid).write, ['orders', 'products']);
  assert.ok((await http('/mcp/log', { body: { filter: 'change' }, token: conf })).data.lines.some((l) => l.tool === 'write' && l.kind === 'setting'));
  // still only reading: no tool changes anything yet
  assert.ok((await mcp(S.access_token, 'tools/list')).data.result.tools.every((x) => x.annotations.readOnlyHint === true));
  ok('« Peut modifier »: its person turns it on from Pilotix, part by part, nobody else; the log says so');
});

const failed = results.filter(([, e]) => e);
console.log(`\n${results.length - failed.length}/${results.length} sections passed`);
if (failed.length) {
  for (const [n, e] of failed) console.log(` ✗ ${n}: ${e}`);
  process.exit(1);
}
