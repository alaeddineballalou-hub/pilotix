// End-to-end check of a multi-shop server (after scripts/smoke-test.sh, same demo server, with e-mails going to the
// test mailbox of scripts/smtp-sink.cjs): accounts (one e-mail, one password, every store of the person), the control
// room (two-step login, new stores and their owner's invitation, plans, limits, payments and receipts, sign-ups,
// messages, reminders), « Créer ma boutique », « Ajouter une boutique », the store picker, the owner's rights, stores
// never seeing each other's data, landing pages and llms.txt per store, own domains, deleting a store.
//   API=http://localhost:3000/api MAILS_DIR=/tmp/mails DATABASE_URL=… REDIS_URL=… node scripts/shops-test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allMails, codeIn, linkToken, mailCount, mailTo, staffLogin } from './mailbox.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'apps/server/package.json'));
const API = process.env.API || 'http://localhost:3000/api';
const run = Date.now().toString(36).slice(-6); // names unique per run: the script can run twice on one server
const em = (n) => `${n}.${run}@shops-test.dz`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- helpers
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
async function req(path, body, token, method, headers) {
  const r = await fetch(API + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
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
/** The answer, or an error carrying the status and the answer. */
async function must(path, body, token, headers) {
  const r = await req(path, body, token, undefined, headers);
  if (r.status >= 300) throw Object.assign(new Error(`${path} → ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`), { status: r.status, data: r.data });
  return r.data;
}
const rpc = (token, name, input = {}) => must(`/rpc/${name}`, input, token);
/** A confirmation agency's space, on one seller's orders (or 'all' of them). */
const rpcSeller = (token, seller, name, input = {}) => must(`/rpc/${name}`, input, token, { 'X-Seller': String(seller) });
let P; // the control room's token
const prpc = (name, input = {}) => must(`/platform/rpc/${name}`, input, P);
/** The call must fail (with this status, and a message matching re). */
async function fails(p, status, re) {
  try {
    await p;
  } catch (e) {
    if (status) assert.equal(e.status, status, e.message);
    if (re) assert.match(JSON.stringify(e.data ?? e.message), re);
    return e;
  }
  assert.fail(`expected a failure${status ? ` (${status})` : ''}`);
}
const login = (email, password, shop) => must('/auth/login', { email, password, ...(shop ? { shop } : {}) });

const ctx = {};
let plans;

// ---------------------------------------------------------------- shop #1
await section('Shop #1: its demo accounts log in as before; an unknown e-mail gets the same answer as a wrong password', async () => {
  const r = await login('admin@demo.pilotix.dz', 'demo-pilotix');
  assert.ok(r.token && !r.pick, 'the demo admin opens shop #1 directly');
  ctx.admin1 = r.token;
  ok('demo admin → shop #1');
  const e = await fails(login(`nobody-${run}@x.dz`, 'whatever-123'), 401);
  assert.equal(e.data.message, 'Email ou mot de passe incorrect');
  ok('unknown e-mail → « Email ou mot de passe incorrect »');
});

// ---------------------------------------------------------------- the control room
await section('Control room: two-step login (a code by e-mail, « remember this device »)', async () => {
  // a demo server has no Pilotix staff (demo accounts never become staff): one is added for the test
  const { Pool } = require('pg');
  const bcrypt = require(createRequire(join(ROOT, 'packages/core/package.json')).resolve('bcryptjs'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  ctx.staff = { email: `owner-${run}@pilotix.test`, password: 'Owner-Password-1' };
  await pool.query(`INSERT INTO platform.staff (name, email, password_hash, role) VALUES ('Owner Shops Test', $1, $2, 'owner')`, [ctx.staff.email, await bcrypt.hash(ctx.staff.password, 10)]);
  await pool.end();
  const n0 = mailCount();
  const r1 = await must('/platform/auth/login', ctx.staff);
  assert.equal(r1.step, 'code', 'two-step is on when the server sends e-mails');
  assert.ok(!r1.token, 'no token before the code');
  assert.match(r1.email, /^o•+@pilotix\.test$/);
  ok(`password accepted → the « code » step, the e-mail shown masked (${r1.email})`);
  const code = codeIn(await mailTo(ctx.staff.email, n0));
  assert.ok(code, 'a 6-digit code in the e-mail');
  await fails(must('/platform/auth/code', { ticket: r1.ticket, code: code === '000000' ? '111111' : '000000' }), 401, /incorrect/i);
  ok('a wrong code is refused');
  const r2 = await must('/platform/auth/code', { ticket: r1.ticket, code, remember: true });
  assert.ok(r2.token && r2.device);
  P = r2.token;
  ok('the right code → logged in, this device remembered');
  await fails(must('/platform/auth/code', { ticket: r1.ticket, code }), 401);
  ok('a code works once');
  const r3 = await must('/platform/auth/login', { ...ctx.staff, device: r2.device });
  assert.ok(r3.token, 'a remembered device needs no code');
  ok('remembered device → straight in');
  await fails(must('/platform/auth/login', { ...ctx.staff, password: 'Wrong-Password-1' }), 401);
  ok('a wrong password is refused');
  const r4 = await staffLogin(API, ctx.staff.email, ctx.staff.password);
  assert.ok(r4.data.token);
});

await section('Control room: settings (sign-ups, reminders, referral, company, terms) and the public terms page', async () => {
  const d = await prpc('p.dashboard');
  for (const k of ['signups', 'messages', 'overLimit', 'counts', 'mrr']) assert.ok(k in d, `dashboard has ${k}`);
  const s = await prpc('p.settings.get');
  for (const k of ['signup', 'reminders', 'referral', 'security', 'company', 'legal']) assert.ok(k in s, `settings has ${k}`);
  await prpc('p.settings.save', {
    signup: { open: true, maxStores: 3 },
    reminders: { on: true, daysBefore: 3 },
    referral: { on: true, months: 1 },
    company: { name: 'Pilotix SARL', address: 'Alger', phone: '0550 00 00 00', email: 'contact@pilotix.test', taxId: '0001234567' },
    legal: { text: '' },
  });
  const s2 = await prpc('p.settings.get');
  assert.equal(s2.company.name, 'Pilotix SARL');
  assert.equal(s2.signup.maxStores, 3);
  assert.equal(s2.security.twoStep, true, 'saving other settings keeps two-step on');
  ok('settings saved and read back (two-step untouched)');
  const legal = await must('/legal');
  assert.equal(legal.company, 'Pilotix SARL');
  assert.equal(legal.text, '');
  ok('the terms page answers (standard text, the company’s name)');
});

await section('Control room: a plan with a yearly price and a limit of drivers', async () => {
  plans = await prpc('p.plans.list');
  const pro = plans.find((p) => p.code === 'pro');
  assert.ok(pro, 'the Pro plan exists');
  await prpc('p.plans.save', { id: pro.id, name: pro.name, priceMonth: pro.priceMonth, priceYear: pro.priceMonth * 10, maxUsers: pro.maxUsers, maxDrivers: 2, maxOrdersMonth: pro.maxOrdersMonth, description: pro.description ?? '', public: pro.public, active: true, features: pro.features });
  plans = await prpc('p.plans.list');
  const pro2 = plans.find((p) => p.code === 'pro');
  assert.equal(pro2.priceYear, pro.priceMonth * 10);
  assert.equal(pro2.maxDrivers, 2);
  ok(`Pro: ${pro2.priceMonth} DA a month, ${pro2.priceYear} DA a year, ${pro2.maxDrivers} drivers`);
});

await section('A store for a NEW person: invitation e-mail, the owner chooses the password (Pilotix never sees it)', async () => {
  const n0 = mailCount();
  const email = em('owner1');
  const pro = plans.find((p) => p.code === 'pro');
  const r = await prpc('p.shops.create', { name: `Boutique Invit ${run}`, ownerName: 'Owner Un', ownerEmail: email, ownerPhone: '0550 11 22 33', city: 'Oran', planId: pro.id, trialDays: 14, language: 'fr' });
  assert.equal(r.invited, true);
  assert.ok(!('mail' in r) && !('password' in r) && !JSON.stringify(r).includes('token'), 'no password, no link in the answer');
  ok(`store #${r.id} « ${r.slug} »: the answer carries no password and no link`);
  const m = await mailTo(email, n0);
  const tok = linkToken(m, 'invite');
  ok(`invitation e-mail: « ${m.subject} »`);
  assert.equal((await must(`/auth/link/${tok}`)).kind, 'invite');
  await fails(login(email, 'Anything-123'), 401);
  ok('before choosing a password nobody can log in');
  await fails(must('/auth/reset', { token: tok, password: 'short' }), 400);
  await must('/auth/reset', { token: tok, password: 'Owner1-Password!' });
  assert.equal((await must(`/auth/link/${tok}`)).kind, null);
  ok('the owner chose a password with the link; the link is used up');
  const l = await login(email, 'Owner1-Password!');
  assert.ok(l.token, 'one store → straight in');
  assert.equal(l.session.shop.id, r.id);
  assert.equal(l.session.shop.owner, true);
  assert.equal(l.session.shop.state, 'trial');
  ctx.owner1 = { email, password: 'Owner1-Password!', shopId: r.id, slug: r.slug, name: `Boutique Invit ${run}` };
  ok('the owner logs in to the store, as its owner, on trial');
  const det = await prpc('p.shops.get', { id: r.id });
  assert.equal(det.ownerAccount.email, email);
  assert.equal(det.ownerAccount.invited, false);
  assert.ok(!('admins' in det) && !JSON.stringify(det).includes('password_hash'));
  ok('the control room shows the owner (invitation accepted) and numbers only');
  await fails(must(`/platform/open/${r.id}`, {}, P), 404);
  ok('« open the store as its admin » is gone (404)');
});

await section('A store for a person who ALREADY has an account: added to their stores, their password unchanged', async () => {
  const n0 = mailCount();
  const ess = plans.find((p) => p.code === 'essentiel');
  const r = await prpc('p.shops.create', { name: `Deuxième Owner ${run}`, ownerName: 'Owner Un', ownerEmail: ctx.owner1.email, planId: ess.id, trialDays: 7, language: 'fr' });
  assert.equal(r.invited, false);
  const m = await mailTo(ctx.owner1.email, n0);
  assert.ok(!/#\/invite\//.test(m.text), 'no invitation link for an existing account');
  ok(`store #${r.id} added to the account; the e-mail « ${m.subject} » has no link`);
  const l = await login(ctx.owner1.email, ctx.owner1.password);
  assert.equal(l.pick, true, 'two stores → the picker');
  assert.equal(l.stores.length, 2);
  assert.ok(l.stores.every((s) => s.owner));
  ok(`the usual password → the picker: ${l.stores.map((s) => s.name).join(' / ')}`);
  const e1 = await must('/auth/pick', { ticket: l.ticket, shop: r.id });
  assert.equal(e1.session.shop.id, r.id);
  const e2 = await must('/auth/switch', { shop: ctx.owner1.shopId }, e1.token);
  assert.equal(e2.session.shop.id, ctx.owner1.shopId);
  ok('the picker opens a store; « Changer de boutique » needs no password');
  assert.equal((await must('/auth/stores', undefined, e2.token)).length, 2);
  const primary = (await prpc('p.shops.list', {})).find((s) => s.primary);
  await fails(must('/auth/switch', { shop: primary.id }, e2.token), 403);
  ok('no way into a store where one has no account');
  await fails(must('/auth/pick', { ticket: 'not-a-ticket', shop: r.id }), 401);
  ctx.owner1.second = r.id;
  ctx.owner1.token = e2.token;
});

await section('Invitation sent again', async () => {
  await fails(prpc('p.shops.resendInvite', { id: ctx.owner1.shopId }), 400, /déjà choisi/);
  ok('an owner who chose a password already: refused');
  const n0 = mailCount();
  const ess = plans.find((p) => p.code === 'essentiel');
  const r = await prpc('p.shops.create', { name: `Pas Encore ${run}`, ownerName: 'Owner Deux', ownerEmail: em('owner2'), planId: ess.id, trialDays: 14, language: 'ar' });
  await mailTo(em('owner2'), n0);
  const n1 = mailCount();
  const rs = await prpc('p.shops.resendInvite', { id: r.id });
  assert.ok(!JSON.stringify(rs).includes('token'));
  const m = await mailTo(em('owner2'), n1);
  linkToken(m, 'invite');
  ok(`invitation sent again (in Arabic: « ${m.subject} »)`);
  ctx.owner2 = { shopId: r.id };
});

// ---------------------------------------------------------------- sign-up
await section('« Créer ma boutique »: the e-mail link makes the store, on trial, with its referral', async () => {
  const info = await must('/auth/signup');
  assert.equal(info.open, true);
  ok(`sign-up open, ${info.trialDays} days of trial`);
  const taken = await must(`/auth/store-name?name=${encodeURIComponent(ctx.owner1.name)}`);
  assert.equal(taken.slug, `${ctx.owner1.slug}-2`, 'a taken name gets the next free link');
  const takenSlug = await must(`/auth/store-name?name=x&slug=${ctx.owner1.slug}`);
  assert.equal(takenSlug.free, false);
  for (const w of ['platform', 'pilotix', 'api', 'support']) assert.equal((await must(`/auth/store-name?name=x&slug=${w}`)).free, false, `${w} is reserved`);
  assert.equal((await must('/auth/store-name?name=Pilotix')).slug, 'pilotix-boutique');
  ok(`store names: a taken one → ${taken.slug}; a taken link → « ${takenSlug.reason} »; Pilotix’s words refused`);
  const code = (await prpc('p.shops.get', { id: ctx.owner1.shopId })).referralCode;
  assert.ok(code, 'every store has a referral code');
  await fails(must('/auth/signup', { name: 'X Y', email: em('bad'), password: 'Password-123', storeName: 'Abc', language: 'fr', terms: false }), 400);
  ok('terms not accepted → refused');
  await fails(must('/auth/signup', { name: 'Sara Test', email: em('bad2'), password: 'Password-123', storeName: `Ref Bad ${run}`, language: 'fr', referral: 'ZZZZZZ', terms: true }), 400, /parrainage/i);
  ok('an unknown referral code → a clear message');
  const n0 = mailCount();
  const email = em('signup1');
  await must('/auth/signup', { name: 'Sara Signup', email, password: 'Signup-Password-1', phone: '0770 00 11 22', storeName: `Nouvelle Boutique ${run}`, language: 'fr', referral: code, terms: true });
  const m = await mailTo(email, n0);
  const tok = linkToken(m, 'signup');
  ok(`confirmation e-mail: « ${m.subject} »`);
  await fails(login(email, 'Signup-Password-1'), 401);
  ok('nothing exists before the link is opened');
  assert.ok((await prpc('p.signups.list')).pending.some((p) => p.email === email), 'waiting in the control room');
  ok('control room › Inscriptions shows it waiting');
  const c = await must('/auth/signup/confirm', { token: tok });
  assert.ok(c.token);
  assert.equal(c.session.shop.owner, true);
  assert.equal(c.session.shop.state, 'trial');
  ctx.signup1 = { email, password: 'Signup-Password-1', shopId: c.session.shop.id, token: c.token, slug: c.session.shop.slug };
  ok(`the link → store #${c.session.shop.id} made, its owner logged in, on trial`);
  await fails(must('/auth/signup/confirm', { token: tok }), 400);
  ok('the link works once');
  assert.ok((await prpc('p.signups.list')).made.some((x) => x.id === ctx.signup1.shopId));
  assert.equal((await prpc('p.shops.get', { id: ctx.signup1.shopId })).referredBy?.id, ctx.owner1.shopId);
  ok('control room: in « made », brought by the first store');
  const n1 = mailCount();
  await must('/auth/signup', { name: 'Owner Un', email: ctx.owner1.email, password: 'Whatever-123', storeName: `Doublon ${run}`, language: 'fr', terms: true });
  const ex = await mailTo(ctx.owner1.email, n1);
  assert.ok(!/#\/signup\//.test(ex.text));
  ok(`an e-mail that has an account signs up → « ${ex.subject} » (log in instead), nothing made`);
});

await section('« Ajouter une boutique »: stores per person, and an e-mail check for accounts made by a store', async () => {
  const a = await must('/auth/add-store', { name: `Deuxième ${run}` }, ctx.signup1.token);
  assert.equal(a.session.shop.owner, true);
  const b = await must('/auth/add-store', { name: `Troisième ${run}` }, a.token);
  await fails(must('/auth/add-store', { name: `Quatrième ${run}` }, b.token), 400, /3 boutiques/);
  ok('a 2nd and a 3rd store; the 4th is refused (3 per person)');
  await prpc('p.shops.update', { id: ctx.signup1.shopId, ownerMaxStores: 4 });
  const d = await must('/auth/add-store', { name: `Quatrième ${run}` }, b.token);
  ctx.signup1.fourth = d.session.shop.id;
  ok('the control room allows this owner 4 → the 4th works');
  // an account made by a store's admin is not proven: adding a store asks to confirm the e-mail first
  const admin = await login(ctx.owner1.email, ctx.owner1.password, ctx.owner1.shopId);
  const staff = em('staff1');
  await rpc(admin.token, 'users.create', { name: 'Staff Un', email: staff, password: 'Staff1-Password', roles: ['admin'], language: 'fr' });
  const st = await login(staff, 'Staff1-Password');
  await fails(must('/auth/add-store', { name: `Staff Store ${run}` }, st.token), 403, /VERIFY_EMAIL/);
  ok('an account made by an admin → « confirm your e-mail first »');
  const n0 = mailCount();
  await must('/auth/verify/send', {}, st.token);
  await must('/auth/verify', { token: linkToken(await mailTo(staff, n0), 'verify') });
  const s2 = await must('/auth/add-store', { name: `Staff Store ${run}` }, st.token);
  assert.equal(s2.session.shop.owner, true);
  ok('the e-mail confirmed with its link → the store is made');
  ctx.staff1 = { email: staff, password: 'Staff1-Password' };
});

await section('The team: the owner is protected; an admin sets passwords only of people in this store alone', async () => {
  const T = (await login(ctx.owner1.email, ctx.owner1.password, ctx.owner1.shopId)).token;
  const list = await rpc(T, 'users.list', {});
  const staff = list.find((u) => u.email === ctx.staff1.email);
  const me = list.find((u) => u.email === ctx.owner1.email);
  assert.ok(staff && me);
  const st = await login(ctx.staff1.email, ctx.staff1.password, ctx.owner1.shopId);
  await fails(rpc(st.token, 'users.update', { id: me.id, name: 'Hacked' }), 403, /propriétaire/);
  await fails(rpc(st.token, 'admin.users.resetPassword', { id: me.id }), 403);
  ok('another admin cannot change or reset the owner');
  await fails(rpc(T, 'users.update', { id: staff.id, password: 'New-Password-99' }), 403, /autre boutique/);
  ok('a person who works in another store too: the admin cannot set their password');
  const solo = em('solo');
  await rpc(T, 'users.create', { name: 'Solo', email: solo, password: 'Solo-Password-1', roles: ['confirmation'], language: 'fr' });
  const soloU = (await rpc(T, 'users.list', {})).find((u) => u.email === solo);
  await rpc(T, 'users.update', { id: soloU.id, password: 'Solo-Password-2' });
  assert.ok((await login(solo, 'Solo-Password-2')).token);
  ok('a person in this store alone: the admin sets the password, and it works');
  const r = await rpc(T, 'users.create', { name: 'Sara', email: ctx.signup1.email, password: 'Ignored-Password-1', roles: ['confirmation'], language: 'fr' });
  assert.equal(r.existingAccount, true);
  const sl = await login(ctx.signup1.email, ctx.signup1.password);
  assert.equal(sl.pick, true);
  assert.equal(sl.stores.length, 5);
  await fails(login(ctx.signup1.email, 'Ignored-Password-1'), 401);
  ok('someone who has an account joins with their own password (the one typed by the admin is ignored)');
  await fails(rpc(T, 'me.delete', { password: ctx.owner1.password, email: ctx.owner1.email }), 400, /propriétaire/);
  ok('the owner cannot delete their own account (only the whole store)');
  ctx.solo = { email: solo, password: 'Solo-Password-2', id: soloU.id };
  ctx.owner1.token = T;
});

await section('Passwords: « Mot de passe oublié » and Mon profil change it in every store; old sessions end', async () => {
  const n0 = mailCount();
  await must('/auth/forgot', { email: ctx.signup1.email });
  const tok = linkToken(await mailTo(ctx.signup1.email, n0), 'reset');
  await must('/auth/reset', { token: tok, password: 'Signup-New-Pass-1' });
  const l = await login(ctx.signup1.email, 'Signup-New-Pass-1');
  assert.equal(l.pick, true);
  for (const s of l.stores) assert.equal((await must('/auth/pick', { ticket: l.ticket, shop: s.id })).session.profile.email, ctx.signup1.email);
  await fails(login(ctx.signup1.email, ctx.signup1.password), 401);
  await fails(rpc(ctx.signup1.token, 'me.get'), 401);
  ok(`the new password opens all ${l.stores.length} stores; the old one and the old sessions stop at once`);
  const n1 = mailCount();
  assert.equal((await must('/auth/forgot', { email: em('nobody') })).ok, true);
  await sleep(800);
  assert.equal(mailCount(), n1);
  ok('an unknown e-mail: the same answer, no e-mail');
  const e = await must('/auth/pick', { ticket: l.ticket, shop: ctx.signup1.shopId });
  const ch = await rpc(e.token, 'me.password', { current: 'Signup-New-Pass-1', next: 'Signup-Pass-3' });
  assert.ok(ch.token, 'this session gets a fresh token');
  assert.equal((await login(ctx.signup1.email, 'Signup-Pass-3')).stores.length, 5);
  await fails(rpc(e.token, 'me.get'), 401);
  ok('Mon profil › new password: every store follows, the other sessions end');
  ctx.signup1.password = 'Signup-Pass-3';
  ctx.signup1.token = (await must('/auth/pick', { ticket: (await login(ctx.signup1.email, 'Signup-Pass-3')).ticket, shop: ctx.signup1.shopId })).token;
});

await section('An account turned off: out of that store at once', async () => {
  const S = (await login(ctx.solo.email, ctx.solo.password)).token;
  await rpc(ctx.owner1.token, 'users.update', { id: ctx.solo.id, active: false });
  await fails(rpc(S, 'me.get'), 401);
  const l = await login(ctx.solo.email, ctx.solo.password);
  assert.equal(l.pick, true);
  assert.equal(l.stores.length, 0);
  ok('the session ends; the login finds no store left (« create your store »)');
});

// ---------------------------------------------------------------- stores never see each other
await section('Stores never see each other’s data', async () => {
  const p = await rpc(ctx.owner1.token, 'catalog.saveProduct', { name: 'Bague argent', sku: `BAG-${run}`, price: 4500, cost: 1500, variants: [] });
  ctx.product = p.id ?? p.product?.id;
  assert.ok(ctx.product);
  const o = await rpc(ctx.owner1.token, 'orders.create', { customerName: 'Client Sétif', phone: '0661998877', wilayaId: 19, commune: 'Sétif', items: [{ productId: ctx.product, variantId: null, qty: 1 }] });
  assert.ok(o.ref);
  const mine = await rpc(ctx.owner1.token, 'orders.list', { pageSize: 50 });
  assert.ok(mine.rows.some((r) => r.ref === o.ref));
  ok(`a product and an order (${o.ref}) in the first store`);
  for (const [who, T] of [
    ['another store', ctx.signup1.token],
    ['shop #1', ctx.admin1],
  ]) {
    assert.equal((await rpc(T, 'orders.list', { q: '0661998877', pageSize: 5 })).total, 0, `${who} sees the order`);
    assert.ok(!(await rpc(T, 'catalog.products', {})).some((x) => x.sku === `BAG-${run}`), `${who} sees the product`);
  }
  ok('neither another store nor shop #1 sees them');
});

await section('Landing pages and llms.txt of a store', async () => {
  await rpc(ctx.owner1.token, 'landing.save', { productId: ctx.product, slug: 'bague-argent', title: 'خاتم فضة', color: '#0f766e', price: 4500, description: 'خاتم فضة عيار 925' });
  let page = await fetch(`${API}/s/${ctx.owner1.slug}/bague-argent`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.includes('خاتم فضة'));
  ok('the page at <site>/<store>/<page>');
  page = await fetch(`${API}/s/${ctx.owner1.slug}/llms.txt`);
  const llms = await page.text();
  assert.equal(page.status, 200);
  assert.ok(llms.includes(`# ${ctx.owner1.name}`) && llms.includes(`/${ctx.owner1.slug}/bague-argent`), llms.slice(0, 200));
  ok('the store’s llms.txt lists its page');
  assert.ok((await (await fetch(`${API}/llms.txt`)).text()).includes(`/api/s/${ctx.owner1.slug}/llms.txt`));
  ok('the platform’s llms.txt links the store’s');
});

// ---------------------------------------------------------------- archives
await section('Management › Archives: the owner is never archived, only the owner deletes for good, archived sessions end at once', async () => {
  const O = ctx.owner1.token;
  const A = (await login(ctx.staff1.email, ctx.staff1.password, ctx.owner1.shopId)).token; // another administrator
  const ownerId = (await rpc(O, 'me.get')).profile.id;
  const seen = await rpc(A, 'archive.list', { kind: 'users' });
  assert.equal(seen.find((u) => u.id === ownerId)?.blocked, 'owner');
  await fails(rpc(A, 'archive.set', { kind: 'users', ids: [ownerId], archived: true }), 403, /propriétaire/);
  ok('the owner’s account shows « propriétaire » and cannot be archived');
  const temp = await rpc(O, 'users.create', { name: 'Compte Erreur', email: em('erreur'), password: 'Erreur-Pass-1', roles: ['confirmation'], language: 'fr' });
  const T = (await login(em('erreur'), 'Erreur-Pass-1')).token;
  const r = await rpc(A, 'archive.set', { kind: 'users', ids: [temp.id], archived: true });
  assert.equal(r.done, 1);
  await fails(rpc(T, 'me.get'), 401);
  ok('an administrator archives an account: its session ends at once');
  assert.ok((await rpc(O, 'archive.list', { kind: 'users', archived: true })).some((u) => u.id === temp.id && u.uses.length === 0));
  await fails(rpc(A, 'archive.delete', { kind: 'users', ids: [temp.id] }), 403, /propriétaire/);
  const d = await rpc(O, 'archive.delete', { kind: 'users', ids: [temp.id] });
  assert.equal(d.deleted, 1);
  ok('another administrator cannot delete for good; the owner can (never used)');
  const prod = await rpc(O, 'catalog.saveProduct', { name: `Produit Erreur ${run}`, price: 1000, variants: [] });
  await rpc(O, 'archive.set', { kind: 'products', ids: [prod.id], archived: true });
  assert.ok(!(await rpc(O, 'catalog.products', {})).some((p) => p.id === prod.id));
  assert.equal((await rpc(O, 'archive.delete', { kind: 'products', ids: [prod.id] })).deleted, 1);
  const sold = await rpc(O, 'catalog.saveProduct', { name: `Produit Vendu ${run}`, price: 2000, variants: [] });
  await rpc(O, 'orders.create', { customerName: 'Client Archive', phone: '0661334455', wilayaId: 16, commune: 'Alger', items: [{ productId: sold.id, variantId: null, qty: 1 }] });
  assert.equal((await rpc(O, 'archive.set', { kind: 'products', ids: [sold.id], archived: true })).done, 1, 'a sold product with no stock is archived');
  const kept = await rpc(O, 'archive.delete', { kind: 'products', ids: [sold.id] });
  assert.equal(kept.kept[0]?.reason, 'used');
  assert.ok(kept.kept[0].uses.includes('orders'));
  ok('a product made by mistake is deleted for good; a sold one stays in the archives');
});

// ---------------------------------------------------------------- limits
await section('Limits: accounts and drivers (hard), orders per month (soft), « over » in the control room', async () => {
  const sid = ctx.owner1.shopId;
  const u0 = (await prpc('p.shops.get', { id: sid })).usage.users;
  await prpc('p.shops.update', { id: sid, maxUsers: u0 + 2, maxDrivers: 1 });
  const T = ctx.owner1.token;
  ok(`${u0} active accounts → limits set to ${u0 + 2} accounts and 1 driver`);
  await rpc(T, 'users.create', { name: 'Livreur Un', email: em('liv1'), password: 'Livreur-Pass-1', roles: ['livreur'], language: 'fr' });
  await fails(rpc(T, 'users.create', { name: 'Livreur Deux', email: em('liv2'), password: 'Livreur-Pass-2', roles: ['livreur'], language: 'fr' }), 400, /livreur/i);
  ok('1 driver allowed → the 2nd is refused');
  await rpc(T, 'users.create', { name: 'Agent Limite', email: em('lim1'), password: 'Limite-Pass-1', roles: ['confirmation'], language: 'fr' });
  await fails(rpc(T, 'users.create', { name: 'Trop', email: em('trop'), password: 'Trop-Password-1', roles: ['confirmation'], language: 'fr' }), 400, /comptes actifs/);
  ok('accounts at the limit → one more is refused with a clear message');
  const det = await prpc('p.shops.get', { id: sid });
  assert.equal(det.usage.users, u0 + 2);
  assert.equal(det.usage.drivers, 1);
  ok(`the control room’s numbers: ${det.usage.users} accounts, ${det.usage.drivers} driver`);
  const ess = plans.find((p) => p.code === 'essentiel');
  const tiny = await prpc('p.plans.save', { name: `Tiny ${run}`, priceMonth: 1000, priceYear: null, maxUsers: null, maxDrivers: null, maxOrdersMonth: 2, description: '', public: false, active: false, features: ess.features });
  await prpc('p.shops.update', { id: sid, planId: tiny.id });
  for (let i = 0; i < 3; i++) await rpc(T, 'orders.create', { customerName: `Client ${i}`, phone: `066120000${i}`, wilayaId: 31, commune: 'Oran', items: [{ productId: ctx.product, variantId: null, qty: 1 }] });
  ok('3 more orders on a plan of 2 a month: none blocked');
  const me = await rpc(T, 'me.get');
  assert.equal(me.shop.maxOrdersMonth, 2);
  assert.ok(me.shop.ordersMonth >= 3, `ordersMonth ${me.shop.ordersMonth}`);
  ok(`the store knows: ${me.shop.ordersMonth} / ${me.shop.maxOrdersMonth} this month (its banner)`);
  await prpc('p.shops.get', { id: sid }); // the store's page refreshes its numbers (the list keeps them a minute)
  assert.ok((await prpc('p.shops.list', { state: 'over' })).some((s) => s.id === sid), 'listed in « over »');
  assert.ok((await prpc('p.dashboard')).overLimit >= 1);
  ok('control room: in « Au-dessus des limites », counted on the dashboard');
});

// ---------------------------------------------------------------- payments
await section('Payments: numbered receipts, receipt by e-mail, the referral reward (a free month)', async () => {
  const end = (s) => new Date(s.paidUntil ?? s.trialEndsAt).getTime();
  const before = await prpc('p.shops.get', { id: ctx.owner1.shopId });
  const pro = plans.find((p) => p.code === 'pro');
  const n0 = mailCount();
  const pay = await prpc('p.payments.add', { shopId: ctx.signup1.shopId, amount: pro.priceMonth, method: 'baridimob', months: 1, reference: 'BM-TEST', planId: pro.id });
  assert.match(pay.receiptNo, /^PX-\d{4}-\d{4}$/);
  assert.ok(pay.rewarded, 'the store that brought it is rewarded at its first payment');
  ok(`payment saved, receipt ${pay.receiptNo}`);
  assert.ok(end(await prpc('p.shops.get', { id: ctx.owner1.shopId })) > end(before), 'the referrer got time');
  const rm = await mailTo(ctx.owner1.email, n0, /mois|month|شهر/i);
  ok(`the referrer’s free month, and its e-mail « ${rm.subject} »`);
  const pay2 = await prpc('p.payments.add', { shopId: ctx.signup1.shopId, amount: pro.priceYear ?? pro.priceMonth * 12, method: 'ccp', months: 12, planId: pro.id });
  assert.ok(!pay2.rewarded, 'only the first payment rewards');
  assert.equal(Number(pay2.receiptNo.slice(-4)), Number(pay.receiptNo.slice(-4)) + 1);
  ok(`a second payment (a year) → ${pay2.receiptNo}, no second reward`);
  const rc = await prpc('p.payments.receipt', { id: pay2.id });
  assert.equal(rc.receiptNo, pay2.receiptNo);
  assert.equal(rc.company.name, 'Pilotix SARL');
  const n1 = mailCount();
  await prpc('p.payments.mailReceipt', { id: pay2.id });
  const m = await mailTo(ctx.signup1.email, n1);
  assert.ok(`${m.text} ${m.html}`.includes(pay2.receiptNo));
  ok(`the receipt e-mailed to the owner: « ${m.subject} »`);
  await prpc('p.payments.void', { id: pay2.id, reason: 'Test annulation' });
  assert.ok((await prpc('p.payments.receipt', { id: pay2.id })).voidAt);
  ok('cancelled → the receipt says so');
  const ref = await rpc(ctx.owner1.token, 'me.referrals');
  assert.equal(ref.platform, true);
  assert.match(String(ref.link), /#\/inscription\/[A-Z0-9]+$/);
  assert.ok(ref.friends.some((f) => f.status === 'subscribed'));
  ok(`the store’s « Parrainage »: ${ref.link}, ${ref.friends.length} store(s) brought, ${ref.totals.months} month(s) earned`);
});

// ---------------------------------------------------------------- messages
await section('« Contacter Pilotix »: a store writes, Pilotix answers (by e-mail too), unread dots, closed', async () => {
  const T = ctx.signup1.token;
  const t1 = await must('/support', { subject: 'Question bon de livraison', body: 'Bonjour, comment imprimer 2 bons par page ?' }, T);
  assert.ok((await prpc('p.dashboard')).messages >= 1);
  assert.ok((await prpc('p.support.list', { status: 'open' })).find((x) => x.id === t1.id)?.unreadStaff);
  ok(`the store’s admin wrote (#${t1.id}); the control room shows it unread`);
  assert.equal((await prpc('p.support.get', { id: t1.id })).messages.length, 1);
  const n0 = mailCount();
  await prpc('p.support.reply', { id: t1.id, body: 'Bonjour ! Dans Réglages › Impression, choisissez 2 par page.' });
  const m = await mailTo(ctx.signup1.email, n0);
  ok(`the answer goes by e-mail too: « ${m.subject} »`);
  assert.ok((await rpc(T, 'me.get')).shop.supportUnread >= 1);
  assert.equal((await must(`/support/${t1.id}`, undefined, T)).messages.length, 2);
  assert.equal((await rpc(T, 'me.get')).shop.supportUnread, 0);
  ok('the store reads the answer; its unread dot goes away');
  await must(`/support/${t1.id}`, { body: 'Merci beaucoup !' }, T);
  await prpc('p.support.setStatus', { id: t1.id, status: 'closed' });
  assert.equal((await must('/support', undefined, T)).find((x) => x.id === t1.id).status, 'closed');
  ok('the store answers again; Pilotix closes the conversation');
  const agent = em('agent');
  await rpc(T, 'users.create', { name: 'Agent', email: agent, password: 'Agent-Pass-123', roles: ['confirmation'], language: 'fr' });
  ctx.agent = (await login(agent, 'Agent-Pass-123')).token;
  await fails(must('/support', undefined, ctx.agent), 403);
  ok('someone who is not an admin of the store cannot use it');
});

// ---------------------------------------------------------------- own domain
await section('A store’s own domain for its landing pages', async () => {
  await fails(must('/shop/domain', { domain: 'pas un domaine' }, ctx.signup1.token), 400);
  await fails(must('/shop/domain', { domain: `www.${run}.com` }, ctx.agent), 403);
  ok('a wrong name is refused; only the store’s administrator sets it');
  const r = await must('/shop/domain', { domain: `https://WWW.Bijoux-${run}.com/` }, ctx.signup1.token);
  assert.equal(r.domain, `www.bijoux-${run}.com`);
  assert.equal(r.status, 'pending');
  ok('the name is cleaned and waits for its DNS');
  await fails(must('/shop/domain', { domain: `www.bijoux-${run}.com` }, ctx.owner1.token), 400);
  assert.equal((await fetch(`${API}/domain-check?domain=www.bijoux-${run}.com`)).status, 404);
  assert.equal((await must('/shop/domain/get', {}, ctx.signup1.token)).domain, `www.bijoux-${run}.com`);
  ok('another store cannot take it; no certificate before the DNS points here');
  assert.equal((await must('/shop/domain', { domain: null }, ctx.signup1.token)).status, 'none');
  await must('/shop/domain', { domain: `www.bijoux-${run}.com` }, ctx.owner1.token);
  ok('removed → another store may use it');
});

// ---------------------------------------------------------------- deleting a store
await section('The owner deletes a store (and only the owner)', async () => {
  const sid = ctx.signup1.fourth;
  const T = (await login(ctx.signup1.email, ctx.signup1.password, sid)).token;
  const other = em('admin2');
  await rpc(T, 'users.create', { name: 'Admin Deux', email: other, password: 'Admin2-Password', roles: ['admin'], language: 'fr' });
  const a2 = await login(other, 'Admin2-Password');
  await fails(must('/auth/delete-store', { password: 'Admin2-Password', name: 'x' }, a2.token), 403);
  ok('another admin of the store cannot delete it');
  const det = await prpc('p.shops.get', { id: sid });
  await fails(must('/auth/delete-store', { password: 'Wrong-Password-1', name: det.name }, T), 400, /Mot de passe/);
  await fails(must('/auth/delete-store', { password: ctx.signup1.password, name: 'wrong name' }, T), 400);
  ok('a wrong password or a wrong name is refused');
  const r = await must('/auth/delete-store', { password: ctx.signup1.password, name: det.name }, T);
  assert.ok(!r.stores.some((s) => s.id === sid));
  assert.ok(r.next?.token && r.next.session.shop.id !== sid, 'the owner goes on in another store');
  await rpc(r.next.token, 'me.get');
  await fails(rpc(T, 'me.get'), 401);
  assert.equal((await prpc('p.shops.get', { id: sid })).status, 'deleted');
  ok(`deleted: its sessions end, the owner goes on in « ${r.next.session.shop.name} »`);
  const gone = await login(other, 'Admin2-Password');
  assert.equal(gone.pick, true);
  assert.equal(gone.stores.length, 0);
  ok('its employee logs in to an empty list (« create your store »)');
  // from that list: the e-mail check link is asked with the login's ticket (no store to be in)
  await fails(must('/auth/add-store/ticket', { ticket: gone.ticket, name: `Admin Deux ${run}` }), 403, /VERIFY_EMAIL/);
  const n0 = mailCount();
  await must('/auth/verify/send/ticket', { ticket: gone.ticket });
  await must('/auth/verify', { token: linkToken(await mailTo(other, n0), 'verify') });
  const mine = await must('/auth/add-store/ticket', { ticket: (await login(other, 'Admin2-Password')).ticket, name: `Admin Deux ${run}` });
  assert.equal(mine.session.shop.owner, true);
  ok('…confirms the e-mail from there and makes a store of their own');
  await fails(prpc('p.shops.update', { id: sid, name: 'Back' }), 400);
  assert.ok((await prpc('p.shops.list', { state: 'deleted' })).some((s) => s.id === sid));
  ok('the control room cannot touch it, and lists it in « Supprimées »');
});

// ---------------------------------------------------------------- the rest of the control room
await section('Backups page, journal', async () => {
  const h = await must('/platform/health', undefined, P);
  assert.ok(h.db.total > 0 && h.db.shops.length >= 5 && Number.isInteger(h.backups.count));
  assert.equal(h.server.mail, true);
  ok(`database ${Math.round(h.db.total / 1e6)} MB, ${h.db.shops.length} stores, ${h.backups.count} backup(s)`);
  const acts = new Set((await prpc('p.audit.list', { limit: 200 })).map((x) => x.action));
  for (const a of ['shop.create', 'shop.signup', 'shop.added', 'shop.deleted', 'shop.invite', 'shop.ownerStores', 'payment.receipt', 'referral.reward', 'support.reply']) assert.ok(acts.has(a), `the journal has ${a}`);
  ok(`the journal has every new action (${acts.size} kinds)`);
});

await section('Reminders: a trial ending → one e-mail to its owner, never twice', async () => {
  await prpc('p.shops.update', { id: ctx.owner2.shopId, trialEndsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() });
  const { Queue } = require('bullmq');
  const IORedis = require('ioredis');
  const conn = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
  const q = new Queue('pilotix', { connection: conn });
  try {
    const n0 = mailCount();
    await q.add('platform-reminders', {}, { removeOnComplete: true });
    const m = await mailTo(em('owner2'), n0);
    ok(`reminder e-mail (in Arabic): « ${m.subject} »`);
    const n1 = mailCount();
    await q.add('platform-reminders', {}, { removeOnComplete: true });
    await sleep(3000);
    assert.equal(allMails().slice(n1).filter((x) => String(x.to).includes(em('owner2'))).length, 0, 'not twice');
    ok('the next run sends no second e-mail');
  } finally {
    await q.close();
    await conn.quit();
  }
});

await section('A suspended store: locked in the picker, its work refused', async () => {
  await prpc('p.shops.setStatus', { id: ctx.owner1.second, status: 'suspended', reason: 'Test' });
  const l = await login(ctx.owner1.email, ctx.owner1.password);
  const s = l.stores.find((x) => x.id === ctx.owner1.second);
  assert.equal(s.locked, true);
  const e = await must('/auth/pick', { ticket: l.ticket, shop: s.id });
  assert.equal(e.session.shop.state, 'suspended');
  await fails(rpc(e.token, 'orders.list', { pageSize: 5 }), 402);
  ok('« Bloquée » in the picker; it opens on the lock screen; its work is refused');
  await prpc('p.shops.setStatus', { id: ctx.owner1.second, status: 'active' });
});

// ---------------------------------------------------------------- confirmation agencies
await section('Confirmation agencies: « Créer mon agence », Pilotix’s check, a store and an agency work together', async () => {
  const PR = { perConfirmed: 0, perDelivered: 150, perUpsell: 50, monthly: 0, bonusRate: { min: 0, amount: 0 }, bonusVolume: { above: 0, amount: 0 } };
  // the agency signs up like a store, with its own e-mail
  const n0 = mailCount();
  const email = em('agence');
  await must('/auth/signup', { name: 'Samir Agence', email, password: 'Agence-Password-1', storeName: `Agence Rapide ${run}`, language: 'fr', terms: true, kind: 'agency' });
  const m = await mailTo(email, n0);
  assert.match(`${m.subject} ${m.text}`, /agence/i);
  const a = await must('/auth/signup/confirm', { token: linkToken(m, 'signup') });
  assert.equal(a.session.shop.kind, 'agency');
  assert.equal(a.session.shop.verified, false);
  assert.match(a.session.shop.code, /^AG-[A-Z2-9]{4}$/);
  ok(`the e-mail « ${m.subject} » → agency ${a.session.shop.code} made, free, not checked yet`);
  const A = a.token;
  const agencyId = a.session.shop.id;
  // its space runs only its own actions (a seller's orders need a seller); a store's never runs agency.*
  await fails(rpc(A, 'orders.list', { pageSize: 5 }), 400, /vendeur/);
  await fails(rpc(A, 'catalog.products', {}), 403);
  await fails(rpc(ctx.signup1.token, 'agency.home'), 403);
  ok('an agency’s space opens no store page; a store opens no agency page');
  await rpc(A, 'agency.prices', { prices: PR });
  const nora = await rpc(A, 'users.create', { name: 'Nora Agent', email: em('nora'), password: 'Nora-Password-1', roles: ['confirmation'], language: 'fr' });
  // the store: its code; the agency is not found before Pilotix checks it
  const sh = await rpc(ctx.signup1.token, 'partners.home');
  assert.match(sh.code, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  await fails(rpc(ctx.signup1.token, 'partners.find', { code: a.session.shop.code }), 400, /vérifiée/);
  assert.ok((await prpc('p.agencies.list')).some((x) => x.id === agencyId && !x.verifiedAt));
  assert.ok(!(await prpc('p.shops.list')).some((x) => x.id === agencyId), 'not among the stores');
  await prpc('p.agencies.verify', { id: agencyId, verified: true });
  ok(`control room › Agences: checked; the store’s code is ${sh.code}`);
  // the store asks for one product; the agency accepts and sends its agent
  const prod = await rpc(ctx.signup1.token, 'catalog.saveProduct', { name: `Montre ${run}`, price: 3000, variants: [] });
  const pid = prod.id ?? prod.product?.id;
  const other = await rpc(ctx.signup1.token, 'catalog.saveProduct', { name: `Sac ${run}`, price: 2000, variants: [] });
  const oid2 = other.id ?? other.product?.id;
  const f = await rpc(ctx.signup1.token, 'partners.find', { code: a.session.shop.code.toLowerCase().replace('-', '') });
  assert.equal(f.agency.prices.perDelivered, 150);
  const link = await rpc(ctx.signup1.token, 'partners.request', { agencyId, tasks: ['confirmation'], products: [pid] });
  const ans = await rpc(A, 'agency.answer', { id: link.id, accept: true });
  assert.deepEqual(ans.problems, []);
  ok('the store found it by its code, asked, the agency accepted (its agents work for every seller unless the chief chooses)');
  // one login: Nora lands in her agency; the store is not opened by itself (its orders are reached from the agency)
  const l = await login(em('nora'), 'Nora-Password-1');
  assert.ok(!l.pick, 'no picker: her agency only');
  assert.equal(l.session.shop.kind, 'agency');
  const N = l.token;
  await fails(must('/auth/switch', { shop: ctx.signup1.shopId }, N), 403, /agence/);
  const sellers = await rpc(N, 'agency.sellers');
  assert.deepEqual(sellers.map((x) => x.id), [ctx.signup1.shopId]);
  ok('Nora lands in her agency; the seller is in her picker at the top, never opened by itself');
  // orders go by their first product: hers, and the store’s own
  const o1 = await rpc(ctx.signup1.token, 'orders.create', { customerName: 'Client Agence', phone: '0661223311', wilayaId: 16, commune: 'Alger', items: [{ productId: pid, variantId: null, qty: 1 }] });
  const o2 = await rpc(ctx.signup1.token, 'orders.create', { customerName: 'Client Boutique', phone: '0661223312', wilayaId: 16, commune: 'Alger', items: [{ productId: oid2, variantId: null, qty: 1 }] });
  assert.equal(o1.confAgencyId, agencyId);
  assert.equal(o2.confAgencyId, null);
  const S = ctx.signup1.shopId;
  const seen = await rpcSeller(N, S, 'orders.list', { pageSize: 50 });
  assert.deepEqual(seen.rows.map((r) => r.id), [o1.id]);
  await fails(rpcSeller(N, S, 'orders.get', { id: o2.id }), 403);
  await fails(rpcSeller(N, S, 'catalog.products', {}), 403);
  const all = await rpcSeller(N, 'all', 'confirmation.list', { sub: 'nouvelles' });
  assert.deepEqual(all.rows.map((r) => [r.id, r.seller.id]), [[o1.id, S]]);
  await rpcSeller(N, S, 'orders.setConf', { ids: [o1.id], status: 'confirmed' });
  ok('from her agency: one seller or all of them; only the agency’s orders; nothing else of the store opens');
  // the store never edits the agent's account
  const team = await rpc(ctx.signup1.token, 'users.list', { agencies: true });
  const nid = team.find((u) => u.email === em('nora'))?.id;
  await fails(rpc(ctx.signup1.token, 'users.update', { id: nid, name: 'Autre Nom' }), 403, /agence/);
  // the numbers and the payment request: the store says « Payé », the agency « Reçu »
  const d = await rpc(A, 'agency.link', { id: link.id });
  assert.equal(d.counts.received, 1);
  assert.equal(d.counts.confirmed, 1);
  // only the agency changes its prices; the old ones stay until the store says yes
  await rpc(A, 'agency.linkPrices', { id: link.id, prices: { ...PR, perDelivered: 170 } });
  const sd = await rpc(ctx.signup1.token, 'partners.link', { id: link.id });
  assert.deepEqual([sd.link.prices.perDelivered, sd.link.pricesNew.perDelivered], [150, 170]);
  await rpc(ctx.signup1.token, 'partners.acceptPrices', { id: link.id });
  ok('numbers per month; new prices wait for the store’s yes');
  // Facturation: the seller's month
  const bill = await rpc(A, 'agency.billing', {});
  assert.deepEqual(bill.rows.map((r) => [r.link.store.id, r.counts.confirmed]), [[S, 1]]);
  // Pilotix suspends the agency: its agents stop at once
  await prpc('p.shops.setStatus', { id: agencyId, status: 'suspended', reason: 'Test' });
  await sleep(200);
  const stopped = await fails(rpcSeller(N, S, 'orders.list', { pageSize: 5 }));
  assert.ok([401, 402, 403].includes(stopped.status), `stopped: ${stopped.status}`);
  await prpc('p.shops.setStatus', { id: agencyId, status: 'active' });
  // the store ends the contract
  await rpc(ctx.signup1.token, 'partners.end', { id: link.id });
  const l2 = await login(em('nora'), 'Nora-Password-1');
  assert.deepEqual(await rpc(l2.token, 'agency.sellers'), [], 'the seller left her picker');
  await fails(rpcSeller(l2.token, S, 'orders.list', { pageSize: 5 }), 403);
  ok('suspended → the agents are out at once; contract ended → the seller leaves the picker');
});

// ---------------------------------------------------------------- marketers (their own accounts, never an agency's)
await section('Marketers: « Marketer » on the sign-up page, Pilotix’s check, a store gives products, its people see their ad sets only', async () => {
  const PR = { perConfirmed: 0, perDelivered: 120, perUpsell: 0, monthly: 0, bonusRate: { min: 0, amount: 0 }, bonusVolume: { above: 0, amount: 0 }, perSuccess: 12000, profitRate: 10 };
  const n0 = mailCount();
  const email = em('marketer');
  await must('/auth/signup', { name: 'Yacine Marketer', email, password: 'Marketer-Password-1', storeName: `Yacine Ads ${run}`, language: 'fr', terms: true, kind: 'marketer' });
  const m = await mailTo(email, n0);
  assert.match(`${m.subject} ${m.text}`, /marketer/i);
  const a = await must('/auth/signup/confirm', { token: linkToken(m, 'signup') });
  assert.equal(a.session.shop.kind, 'marketer');
  assert.equal(a.session.shop.verified, false);
  assert.match(a.session.shop.code, /^MK-[A-Z2-9]{4}$/);
  ok(`the e-mail « ${m.subject} » → marketer ${a.session.shop.code} made, free, not checked yet`);
  const M = a.token;
  const mkId = a.session.shop.id;
  // its space runs only its own actions: the ads need a seller, the orders are never its work
  await fails(rpc(M, 'mk.overview', {}), 400, /vendeur/);
  await fails(rpc(M, 'orders.list', { pageSize: 5 }), 403);
  await rpc(M, 'agency.prices', { prices: PR });
  await fails(rpc(M, 'users.create', { name: 'Agent', email: em('mk-agent'), password: 'Agent-Password-1', roles: ['confirmation'], language: 'fr' }), 400, /marketer/);
  await rpc(M, 'users.create', { name: 'Nadir Marketer', email: em('nadir'), password: 'Nadir-Password-1', roles: ['marketer'], language: 'fr' });
  ok('a marketer’s space: its own prices and team (marketers only), no store page');
  // the store does not find it before Pilotix checks it; the control room lists it with the marketers only
  await fails(rpc(ctx.signup1.token, 'partners.find', { code: a.session.shop.code, kind: 'marketer' }), 400, /vérifié/);
  assert.ok((await prpc('p.agencies.list', { kind: 'marketer' })).some((x) => x.id === mkId && x.kind === 'marketer'));
  assert.ok(!(await prpc('p.agencies.list', { kind: 'agency' })).some((x) => x.id === mkId), 'not among the agencies');
  await prpc('p.agencies.verify', { id: mkId, verified: true });
  // the store finds it by its code and gives it one product; the marketer accepts
  const prod = await rpc(ctx.signup1.token, 'catalog.saveProduct', { name: `Lampe ${run}`, price: 4500, variants: [] });
  const pid = prod.id ?? prod.product?.id;
  const f = await rpc(ctx.signup1.token, 'partners.find', { code: a.session.shop.code.toLowerCase() });
  assert.deepEqual([f.agency.kind, f.agency.prices.perSuccess], ['marketer', 12000]);
  const link = await rpc(ctx.signup1.token, 'partners.request', { agencyId: mkId, tasks: ['marketing'], products: [pid] });
  assert.deepEqual((await rpc(M, 'agency.answer', { id: link.id, accept: true })).problems, []);
  ok('control room › Marketers: checked; the store found it, gave one product, it accepted');
  // Nadir lands in the marketer's space; from there: the seller's ads, never its orders
  const l = await login(em('nadir'), 'Nadir-Password-1');
  assert.ok(!l.pick, 'no picker: the marketer’s space only');
  assert.equal(l.session.shop.kind, 'marketer');
  const K = l.token;
  const S = ctx.signup1.shopId;
  assert.deepEqual((await rpc(K, 'agency.sellers')).map((x) => [x.id, x.tasks]), [[S, ['marketing']]]);
  const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  const pub = await rpcSeller(K, S, 'ads.overview', { from: today, to: today });
  assert.equal(pub.owner, false);
  assert.deepEqual(pub.catalog.map((c) => c.id), [pid], 'only the product given');
  assert.deepEqual((await rpcSeller(K, 'all', 'mk.overview', {})).rows, []);
  await fails(rpcSeller(K, S, 'orders.list', { pageSize: 5 }), 403);
  await fails(rpcSeller(K, S, 'catalog.products', {}), 403);
  ok('from the marketer’s space: one seller’s ads or every seller’s ad sets; no order, no catalog of the store');
  // the store never sets his price (the marketer does), nor edits his account
  const team = await rpc(ctx.signup1.token, 'users.list', { agencies: true });
  const nid = team.find((u) => u.email === em('nadir'))?.id;
  assert.ok(nid, 'his account in the store');
  await fails(rpc(ctx.signup1.token, 'mk.price', { marketerId: nid, price: 1000 }), 403, /fixe lui-même/);
  await fails(rpc(ctx.signup1.token, 'users.update', { id: nid, name: 'Autre Nom' }), 403);
  const d = await rpc(M, 'agency.link', { id: link.id });
  assert.deepEqual([d.link.kind, d.counts.adsets, d.bill.total], ['marketer', 0, 0]);
  ok('his price is the marketer’s; the month counts his ad sets');
  // two changes at the same moment (a new person of the team, the store changing its products): both are done, one
  // sync of the team waits for the other (no « this e-mail already exists » clash in the store)
  for (let k = 0; k < 3; k++) {
    const burst = await Promise.all([
      req('/rpc/users.create', { name: `Selma Marketer ${k}`, email: em(`selma${k}`), password: 'Selma-Password-1', roles: ['marketer'], language: 'fr' }, M),
      req('/rpc/partners.setWork', { id: link.id, tasks: ['marketing'], products: [pid] }, ctx.signup1.token),
      req('/rpc/partners.setWork', { id: link.id, tasks: ['marketing'], products: [pid] }, ctx.signup1.token),
    ]);
    assert.ok(burst.every((r) => r.status < 300), JSON.stringify(burst.map((r) => [r.status, r.data])));
  }
  ok('a new person of the team and the store’s change at the same moment: both done');
  // the store ends it: the seller leaves Nadir's picker
  await rpc(ctx.signup1.token, 'partners.end', { id: link.id });
  assert.deepEqual(await rpc((await login(em('nadir'), 'Nadir-Password-1')).token, 'agency.sellers'), []);
  ok('contract ended → the seller leaves the picker');
});

console.log('\n========== SUMMARY');
for (const [n, err] of results) console.log(`${err ? '✗' : '✓'} ${n}${err ? `  → ${err}` : ''}`);
const failed = results.filter(([, e]) => e).length;
console.log(failed ? `\n❌ ${failed} part(s) failed` : '\n✅ All multi-shop checks passed');
process.exit(failed ? 1 : 0);
