// End-to-end check of a multi-shop server (after scripts/smoke-test.sh, same demo server): sign-up, users of a new shop,
// one e-mail in several shops (store picker, « Mes boutiques »), « Ajouter une boutique », passwords across shops, a
// deactivated account, shops never seeing each other's data, own domains, landing pages and llms.txt per shop.
//   API=http://localhost:3000/api node scripts/shops-test.mjs
const API = process.env.API || 'http://localhost:3000/api';
const SITE = API.replace(/\/api$/, '');
const run = Date.now().toString(36); // names unique per run: the script can run twice on one server
let failed = 0;

async function req(method, path, body, token) {
  const r = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data };
}
const post = (path, body, token) => req('POST', path, body ?? {}, token);
const rpc = (token, name, body) => post(`/rpc/${name}`, body ?? {}, token);
function check(cond, label, extra) {
  console.log(`${cond ? '✓' : '✗'} ${label}${!cond && extra !== undefined ? ` — ${JSON.stringify(extra).slice(0, 300)}` : ''}`);
  if (!cond) failed++;
}
const step = (s) => console.log(`→ ${s}`);

// ---------------------------------------------------------------- shop #1 and its demo accounts still log in
step('shop #1: its demo accounts log in as before');
let r = await post('/auth/login', { email: 'admin@demo.pilotix.dz', password: 'demo-pilotix' });
check(r.status === 201 && r.data.token && !r.data.choose, 'demo admin opens shop #1 directly', r.data);
const ADMIN1 = r.data.token;
r = await post('/auth/login', { email: `nobody-${run}@x.dz`, password: 'whatever-123' });
check(r.status === 401 && r.data.message === 'Email ou mot de passe incorrect', 'an unknown e-mail gets the same answer as a wrong password', r.data);

// ---------------------------------------------------------------- sign-up
step('sign-up');
r = await req('GET', '/auth/signup');
check(r.status === 200 && typeof r.data.open === 'boolean', 'sign-up info', r.data);
if (!r.data.open) {
  console.log('Sign-up is closed on this server: the rest needs it open.');
  process.exit(1);
}
const shopA = { shopName: `Bijoux ${run}`, name: 'Sara', email: `sara-${run}@bijoux.dz`, phone: '0550 11 22 33', password: 'Sara-Password-1', website: '', elapsed: 9000 };
r = await post('/auth/slug', { name: shopA.shopName });
check(r.data.available && r.data.slug === `bijoux-${run}`, 'the shop name gives a free address', r.data);
const slugA = r.data.slug;
check((await post('/auth/slug', { slug: 'api' })).data.valid === false, 'a word of the app is never a shop name');
check((await post('/auth/signup', { ...shopA, website: 'http://spam.example' })).status === 400, 'a robot filling the hidden field is refused');
check((await post('/auth/signup', { ...shopA, elapsed: 800 })).status === 400, 'a form sent faster than a person types is refused');
check((await post('/auth/signup', { ...shopA, password: 'short' })).status === 400, 'a short password is refused');
r = await post('/auth/signup', { ...shopA, slug: slugA });
check(r.status === 201 && r.data.session?.isAdmin && r.data.session.shop?.slug === slugA && r.data.session.shop.state === 'trial', 'sign-up: the shop on trial, its owner logged in as administrator', r.data);
const SARA = r.data.token;
const shopAId = r.data.session?.shop?.id;
r = await post('/auth/signup', { ...shopA, email: `other-${run}@x.dz`, slug: slugA });
check(r.status === 400 && /déjà pris/.test(r.data.message), 'the same address for another shop is refused', r.data);
check((await post('/auth/slug', { slug: slugA })).data.available === false, 'the address is taken now');

// ---------------------------------------------------------------- the new shop: its users
step('the new shop adds users, who log in and see only their shop');
r = await rpc(SARA, 'users.create', { name: 'Agent Confirmation', email: `agent-${run}@bijoux.dz`, password: 'Agent-Pass-1', roles: ['confirmation'], language: 'fr' });
check(r.status === 201 && r.data.id, 'the owner creates a confirmation agent', r.data);
const agentId = r.data.id;
r = await rpc(SARA, 'users.create', { name: 'Depot', email: `depot-${run}@bijoux.dz`, password: 'Depot-Pass-1', roles: ['depot'], language: 'ar' });
check(r.status === 201, 'the owner creates a depot account', r.data);
r = await rpc(SARA, 'users.create', { name: 'Agent Confirmation', email: `agent-${run}@bijoux.dz`, password: 'Agent-Pass-1', roles: ['confirmation'], language: 'fr' });
check(r.status === 400, 'the same e-mail twice in one shop is refused', r.data);
r = await post('/auth/login', { email: `agent-${run}@bijoux.dz`, password: 'Agent-Pass-1' });
check(r.status === 201 && r.data.session?.shop?.slug === slugA && !r.data.session.isAdmin, 'the agent logs in to the new shop', r.data);
const AGENT = r.data.token;
check((await rpc(AGENT, 'users.create', { name: 'X Y', email: `x-${run}@y.dz`, password: '12345678', roles: ['admin'] })).status === 403, 'the agent cannot create accounts');
r = await rpc(SARA, 'users.list', {});
check(r.status === 201 && r.data.length === 3, 'the shop has its 3 accounts, nobody of shop #1', r.data.length);

// ---------------------------------------------------------------- shops never see each other
step('shops never see each other’s data');
r = await rpc(SARA, 'catalog.saveProduct', { name: 'Bague argent', sku: 'BAG-1', price: 4500, cost: 1500, variants: [] });
check(r.status === 201, 'a product in the new shop', r.data);
const prodId = r.data.id;
r = await rpc(AGENT, 'orders.create', { customerName: 'Client Sétif', phone: '0661998877', wilayaId: 19, commune: 'Sétif', items: [{ productId: prodId, variantId: null, qty: 1 }] });
check(r.status === 201 && r.data.ref, 'the agent creates an order in the new shop', r.data);
const orderRef = r.data.ref;
r = await rpc(SARA, 'orders.list', { pageSize: 50 });
check(r.data.total === 1 && r.data.rows[0].ref === orderRef, 'the new shop sees its one order only', r.data.total);
r = await rpc(ADMIN1, 'orders.list', { q: '0661998877', pageSize: 5 });
check(r.status === 201 && r.data.total === 0, 'shop #1 does not see the new shop’s order', r.data.total);
r = await rpc(ADMIN1, 'catalog.products', {});
check(!r.data.some((p) => p.sku === 'BAG-1'), 'shop #1 does not see the new shop’s product');

// ---------------------------------------------------------------- landing pages, llms.txt
step('landing pages and llms.txt of the new shop');
r = await rpc(SARA, 'landing.save', { productId: prodId, slug: 'bague-argent', title: 'خاتم فضة', color: '#0f766e', price: 4500, description: 'خاتم فضة عيار 925' });
check(r.status === 201, 'a landing page in the new shop', r.data);
let page = await fetch(`${API}/s/${slugA}/bague-argent`);
let html = await page.text();
// its own address (canonical) is written when the server knows its public address (PUBLIC_URL)
check(page.status === 200 && html.includes('خاتم فضة') && (!html.includes('rel="canonical"') || html.includes(`/${slugA}/bague-argent"`)), 'the page at <site>/<store>/<page>', page.status);
page = await fetch(`${API}/s/${slugA}/llms.txt`);
const llms = await page.text();
check(page.status === 200 && llms.includes(`# Bijoux ${run}`) && llms.includes(`/${slugA}/bague-argent`), 'the shop’s llms.txt', llms.slice(0, 200));
page = await fetch(`${API}/llms.txt`);
check((await page.text()).includes(`/api/s/${slugA}/llms.txt`), 'the platform’s llms.txt links the new shop');

// ---------------------------------------------------------------- one e-mail, several shops
step('one person in several shops: the store picker');
const MULTI = `multi-${run}@x.dz`;
r = await rpc(SARA, 'users.create', { name: 'Multi', email: MULTI, password: 'Same-Pass-123', roles: ['confirmation'], language: 'fr' });
check(r.status === 201, 'shop A gives Multi an account', r.data);
const multiInA = r.data.id;
r = await post('/auth/signup', { shopName: `Mode ${run}`, name: 'Yasmine', email: `yas-${run}@mode.dz`, password: 'Yasmine-Pass-1', website: '', elapsed: 9000 });
check(r.status === 201, 'a second shop signs up', r.data);
const YAS = r.data.token;
const slugB = r.data.session?.shop?.slug;
r = await rpc(YAS, 'users.create', { name: 'Multi', email: MULTI, password: 'Same-Pass-123', roles: ['depot'], language: 'fr' });
check(r.status === 201, 'shop B gives Multi an account too (same e-mail, same password)', r.data);
r = await post('/auth/signup', { shopName: `Tech ${run}`, name: 'Walid', email: `walid-${run}@tech.dz`, password: 'Walid-Pass-123', website: '', elapsed: 9000 });
const WALID = r.data.token;
const slugC = r.data.session?.shop?.slug;
r = await rpc(WALID, 'users.create', { name: 'Multi', email: MULTI, password: 'Other-Pass-456', roles: ['suivi'], language: 'fr' });
check(r.status === 201, 'shop C gives Multi an account with ANOTHER password', r.data);
r = await post('/auth/login', { email: MULTI, password: 'Same-Pass-123' });
check(r.status === 201 && r.data.choose?.length === 2 && !r.data.token, 'the password opens shops A and B: the picker, not shop C', r.data);
const ticket = r.data.ticket;
const ids = Object.fromEntries((r.data.choose ?? []).map((c) => [c.slug, c.id]));
r = await post('/auth/enter', { shop: ids[slugB], ticket });
check(r.status === 201 && r.data.session.shop.slug === slugB && r.data.session.roles.includes('depot'), 'the picker opens shop B with Multi’s role there', r.data);
const MULTI_B = r.data.token;
r = await post('/auth/shops', { ticket }, MULTI_B);
const mine = r.data.shops ?? [];
check(mine.length === 3 && mine.find((s) => s.current)?.slug === slugB && mine.find((s) => s.slug === slugC)?.open === false, '« Mes boutiques »: the 3 shops, shop C asks its own password', r.data);
const idC = mine.find((s) => s.slug === slugC)?.id;
check((await post('/auth/enter', { shop: idC, ticket })).status === 401, 'the login’s proof never opens shop C');
check((await post('/auth/enter', { shop: idC, email: MULTI, password: 'Same-Pass-123' })).status === 401, 'shop C refuses the other shops’ password');
r = await post('/auth/enter', { shop: idC, email: MULTI, password: 'Other-Pass-456', ticket });
check(r.status === 201 && r.data.session.shop.slug === slugC, 'shop C opens with its own password', r.data);
r = await post('/auth/login', { email: MULTI, password: 'Other-Pass-456' });
check(r.status === 201 && r.data.token && r.data.session.shop.slug === slugC, 'that password alone opens shop C directly', r.data);

// ---------------------------------------------------------------- passwords across shops
step('a password change follows in the shops that had the same one');
r = await post('/auth/enter', { shop: ids[slugA], ticket });
const MULTI_A = r.data.token;
r = await rpc(MULTI_A, 'me.password', { current: 'Same-Pass-123', next: 'New-Pass-7890' });
check(r.status === 201 && r.data.token, 'Multi changes the password in shop A', r.data);
r = await post('/auth/login', { email: MULTI, password: 'New-Pass-7890' });
check(r.data.choose?.length === 2, 'the new password opens A and B', r.data);
check((await post('/auth/login', { email: MULTI, password: 'Same-Pass-123' })).status === 401, 'the old password opens nothing');
// accounts are read again at most every 30 s (as for one shop): the other sessions end within that time
await new Promise((res) => setTimeout(res, 31_000));
check((await rpc(MULTI_B, 'me.get')).status === 401, 'the old session in shop B ended (within 30 s)');
r = await post('/auth/login', { email: MULTI, password: 'Other-Pass-456' });
check(r.data.session?.shop?.slug === slugC, 'shop C kept its own password');

// ---------------------------------------------------------------- a deactivated account
step('an account turned off in one shop');
r = await rpc(SARA, 'users.update', { id: multiInA, active: false });
check(r.status === 201, 'shop A turns Multi off', r.data);
r = await post('/auth/login', { email: MULTI, password: 'New-Pass-7890' });
check(r.status === 201 && r.data.token && r.data.session.shop.slug === slugB, 'the login now opens shop B only', r.data);
check((await rpc(MULTI_A, 'me.get')).status === 401, 'Multi’s session in shop A ended');

// ---------------------------------------------------------------- « Ajouter une boutique »
step('« Ajouter une boutique » from inside the app');
r = await post('/shop/add', { shopName: `Bijoux Oran ${run}`, password: 'wrong-password' }, SARA);
check(r.status === 400, 'a wrong password is refused', r.data);
r = await post('/shop/add', { shopName: `Bijoux Oran ${run}`, password: shopA.password }, SARA);
check(r.status === 201 && r.data.session.isAdmin && r.data.session.shop.state === 'trial' && r.data.session.shop.id !== shopAId, 'a second shop for Sara, on trial, Sara its admin', r.data);
r = await post('/auth/login', { email: shopA.email, password: shopA.password });
check(r.data.choose?.length === 2, 'Sara’s password now offers her 2 shops', r.data);
check((await post('/shop/add', { shopName: 'X', password: 'demo-pilotix' }, AGENT)).status === 400, 'an agent with a wrong password cannot add a shop');

// ---------------------------------------------------------------- own domain
step('own domain');
check((await post('/shop/domain', { domain: 'pas un domaine' }, SARA)).status === 400, 'a wrong domain is refused');
check((await post('/shop/domain', { domain: `www.${run}.com` }, AGENT)).status === 403, 'only the shop’s administrator sets it');
r = await post('/shop/domain', { domain: `https://WWW.Bijoux-${run}.com/` }, SARA);
check(r.status === 201 && r.data.domain === `www.bijoux-${run}.com` && r.data.status === 'pending', 'the domain is cleaned and waits for its DNS', r.data);
check((await post('/shop/domain', { domain: `www.bijoux-${run}.com` }, YAS)).status === 400, 'another shop cannot take it');
check((await fetch(`${API}/domain-check?domain=www.bijoux-${run}.com`)).status === 404, 'no certificate before the DNS points here');
r = await post('/shop/domain/get', {}, SARA);
check(r.status === 201 && r.data.domain === `www.bijoux-${run}.com`, 'the shop reads its domain', r.data);
r = await post('/shop/domain', { domain: null }, SARA);
check(r.status === 201 && r.data.status === 'none', 'the domain is removed', r.data);
check((await post('/shop/domain', { domain: `www.bijoux-${run}.com` }, YAS)).status === 201, 'then another shop may use it');

console.log(failed ? `\n❌ ${failed} check(s) failed` : '\n✅ All multi-shop checks passed');
process.exit(failed ? 1 : 0);
