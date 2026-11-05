// Accounts cannot be taken by a store's admin: a team member's e-mail never becomes someone else's Pilotix account, a
// known person keeps their own password (and with none yet, nothing the admin typed opens it), and a password a store's
// admin chose opens that seller's stores only — never a store the person creates, and it goes when the person proves
// their e-mail with Google. Only a link sent to the e-mail makes a password the person's own.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, makeSession, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, profileById, seedBase, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import {
  accountByEmail,
  addStore,
  adminMaySetPassword,
  attachProfile,
  checkAccountPassword,
  confirmSignup,
  loadShop,
  ownerProfileId,
  passwordFromLink,
  passwordOpens,
  PLATFORM_MIGRATIONS,
  propagateProfilePassword,
  setAccountPhone,
  setPasswordFromLink,
  socialAccount,
  startSignup,
} from '../platform';
import { boutiqueWork } from '../modules/boutiquework';
import { hashPassword } from '../modules/users';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const PW = 'Attacker-Pass-1';
let phoneN = 0;
const tph = () => `077${String(++phoneN).padStart(7, '0')}`;

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = <T = any>(name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<T>;
  return { t, p };
}

async function as(t: Tenancy, shopId: number, email: string, password: string): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, password), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t };
}

/** The session as the server rebuilds it from a token's profile id. */
async function reread(t: Tenancy, shopId: number, profileId: number): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  const p = (await profileById(db, profileId))!;
  return { db, session: makeSession(p), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t };
}

/** The server's steps around a team action (apps/server/src/api.ts: teamRules → core → afterTeam), in the same order. */
async function serverRpc(t: Tenancy, ctx: Ctx, name: string, body: any) {
  const s = (await loadShop(t, { id: ctx.shop!.id }))!;
  if (['users.update', 'admin.users.resetPassword'].includes(name)) {
    const target = Number(body?.id);
    if (target && target !== ctx.session.profile.id) {
      if ((await ownerProfileId(t, s)) === target) throw new Error('owner protected');
      const setsPassword = name === 'admin.users.resetPassword' || (typeof body?.password === 'string' && body.password !== '');
      if (setsPassword) {
        const old = (await ctx.db.query('SELECT email FROM profiles WHERE id = $1', [target]))[0]?.email;
        const next = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : undefined;
        for (const email of [old, next]) if (email && !(await adminMaySetPassword(t, s.id, email))) throw new Error('teamRules refused');
      }
    }
  }
  const out: any = await call(name, ctx, body);
  if (name === 'users.create' && out?.id) await attachProfile(t, s.schema, Number(out.id));
  if (name === 'users.update' && body?.id) {
    if (body.email) await attachProfile(t, s.schema, Number(body.id));
    if (body.password) await propagateProfilePassword(t, s.schema, Number(body.id), 'admin');
  }
  return out;
}

/** A seller who signed up with Google (no password), with a store and a customer. */
async function googleSeller(t: Tenancy, email: string, shopName: string) {
  const { account } = await socialAccount(t, { email, name: 'Victim' });
  await setAccountPhone(t, account.id, tph(), true);
  const shop = await addStore(t, (await accountByEmail(t, email))!, { name: shopName });
  return { shop, account };
}

/** Someone who opens their own store with an e-mail and a password (sign-up confirmed). */
async function selfSeller(t: Tenancy, email: string, storeName: string) {
  const mail: any = await startSignup(t, { name: 'Seller', email, phone: tph(), password: PW, storeName, language: 'fr', terms: true }, null);
  const made: any = await confirmSignup(t, mail.token);
  return { id: made.shop.id as number, ctx: await as(t, made.shop.id, email, PW) };
}

test('a team member’s e-mail never becomes someone else’s Pilotix account (with or without a password)', async () => {
  const { t, p } = await server();
  const victim = await googleSeller(t, 'victim@gmail.com', 'Victim Shop');
  const eve = await selfSeller(t, 'eve@evil.dz', 'Evil Shop');
  const dummy: any = await serverRpc(t, eve.ctx, 'users.create', { name: 'Dummy', email: 'dummy@evil.dz', phone: tph(), roles: ['confirmation'], password: 'Dummy-Pass-123' });
  // e-mail + password in one request: refused before anything is written (the server's rule on the new e-mail, and
  // the team's own rule)
  await assert.rejects(serverRpc(t, eve.ctx, 'users.update', { id: dummy.id, email: 'victim@gmail.com', password: 'Owned-Pass-123' }), /teamRules refused/);
  await assert.rejects(call('users.update', eve.ctx, { id: dummy.id, email: 'victim@gmail.com', password: 'Owned-Pass-123' }), /déjà un compte Pilotix/);
  // the e-mail alone, on someone else or on oneself
  await assert.rejects(serverRpc(t, eve.ctx, 'users.update', { id: dummy.id, email: 'Victim@Gmail.com' }), /déjà un compte Pilotix/);
  await assert.rejects(serverRpc(t, eve.ctx, 'users.update', { id: eve.ctx.session.profile.id, email: 'victim@gmail.com' }), /déjà un compte Pilotix/);
  assert.equal((await eve.ctx.db.query('SELECT email FROM profiles WHERE id = $1', [dummy.id]))[0].email, 'dummy@evil.dz');
  assert.equal((await accountByEmail(t, 'victim@gmail.com'))!.hasPassword, false);
  assert.equal(await checkAccountPassword(t, 'victim@gmail.com', 'Owned-Pass-123'), null);
  // a victim with a password: the same (no moment where Eve's profile carries their e-mail)
  const vm: any = await p('p.shops.create', { name: 'Pw Shop', ownerName: 'Pat', ownerEmail: 'pat@shop.dz', planId: (await p('p.plans.list')).find((x: any) => x.code === 'business').id, trialDays: 14 });
  await passwordFromLink(t, vm.mail.token, 'Pat-Password-1');
  await assert.rejects(call('users.update', eve.ctx, { id: eve.ctx.session.profile.id, email: 'pat@shop.dz' }), /déjà un compte Pilotix/);
  assert.equal((await eve.ctx.db.query('SELECT email FROM profiles WHERE id = $1', [eve.ctx.session.profile.id]))[0].email, 'eve@evil.dz');
  // a fresh address is fine (a typo fixed)
  await serverRpc(t, eve.ctx, 'users.update', { id: dummy.id, email: 'dummy2@evil.dz' });
  assert.equal((await eve.ctx.db.query('SELECT email FROM profiles WHERE id = $1', [dummy.id]))[0].email, 'dummy2@evil.dz');
  void victim;
});

test('adding a known person to a team never sets their password', async () => {
  const { t } = await server();
  await googleSeller(t, 'victim@gmail.com', 'Victim Shop');
  const pat = await selfSeller(t, 'pat@shop.dz', 'Pat Shop');
  const eve = await selfSeller(t, 'eve@evil.dz', 'Evil Shop');
  // a Google person (no password): what Eve typed opens nothing, here or anywhere
  const g: any = await serverRpc(t, eve.ctx, 'users.create', { name: 'Victim', email: 'victim@gmail.com', phone: tph(), roles: ['admin'], password: 'Typed-Pass-123' });
  assert.ok(g.id);
  await assert.rejects(login(eve.ctx.db, 'victim@gmail.com', 'Typed-Pass-123'), /incorrect/);
  assert.equal((await accountByEmail(t, 'victim@gmail.com'))!.hasPassword, false);
  assert.equal(await checkAccountPassword(t, 'victim@gmail.com', 'Typed-Pass-123'), null);
  // someone with a password keeps theirs (the same in Eve's store)
  await serverRpc(t, eve.ctx, 'users.create', { name: 'Pat', email: 'pat@shop.dz', phone: tph(), roles: ['confirmation'], password: 'Typed-Pass-123' });
  await assert.rejects(login(eve.ctx.db, 'pat@shop.dz', 'Typed-Pass-123'), /incorrect/);
  assert.ok(await login(eve.ctx.db, 'pat@shop.dz', PW));
  assert.ok(await checkAccountPassword(t, 'pat@shop.dz', PW));
  void pat;
});

test('a password a store’s admin chose: that seller’s stores only, never a store of the person, gone with Google', async () => {
  const { t, p } = await server();
  const eve = await selfSeller(t, 'eve@evil.dz', 'Evil Shop');
  const karim = await selfSeller(t, 'karim@shop.dz', 'Karim Shop');
  const eveAcc = (await accountByEmail(t, 'eve@evil.dz'))!;
  // Eve adds a new person with a password she chooses (the usual way to make an agent)
  const f: any = await serverRpc(t, eve.ctx, 'users.create', { name: 'Future', email: 'future@gmail.com', phone: tph(), roles: ['confirmation'], password: 'Eve-Chose-123' });
  let acc = (await accountByEmail(t, 'future@gmail.com'))!;
  assert.deepEqual([acc.passwordBy, acc.passwordOwner, acc.verified], ['admin', eveAcc.id, false]);
  assert.ok(await checkAccountPassword(t, 'future@gmail.com', 'Eve-Chose-123'), 'the agent logs in as usual');
  assert.equal(await passwordOpens(t, acc, eve.id), true);
  // another seller adds the same person: that password does not open their store
  await serverRpc(t, karim.ctx, 'users.create', { name: 'Future', email: 'future@gmail.com', phone: tph(), roles: ['confirmation'], password: 'Karim-Typed-123' });
  assert.equal(await passwordOpens(t, acc, karim.id), false);
  // « Toutes les boutiques » from Eve's store does not reach it either
  const fs = await reread(t, eve.id, f.id);
  assert.deepEqual((await boutiqueWork(fs)).map((b) => b.id), [eve.id]);
  // a store of their own: the e-mail first, then their own password
  await assert.rejects(addStore(t, acc, { name: 'Future Shop' }), /VERIFY_EMAIL/);
  await t.platform.query('UPDATE platform.accounts SET email_verified_at = now() WHERE id = $1', [acc.id]);
  await assert.rejects(addStore(t, (await accountByEmail(t, 'future@gmail.com'))!, { name: 'Future Shop' }), /OWN_PASSWORD/);
  // a new password in Mon profil (Eve could do it, she knows the old one): still not « their own »
  await eve.ctx.db.query('UPDATE profiles SET password_hash = $2 WHERE id = $1', [f.id, await hashPassword('Still-Eve-123')]);
  await propagateProfilePassword(t, (await loadShop(t, { id: eve.id }))!.schema, f.id, 'keep');
  acc = (await accountByEmail(t, 'future@gmail.com'))!;
  assert.deepEqual([acc.passwordBy, acc.passwordOwner], ['admin', eveAcc.id]);
  // the real person signs in with Google: the password Eve knows is gone, everywhere
  const g = await socialAccount(t, { email: 'future@gmail.com', name: 'Future' });
  assert.deepEqual([g.account.hasPassword, g.account.passwordBy], [false, null]);
  assert.equal(await checkAccountPassword(t, 'future@gmail.com', 'Still-Eve-123'), null);
  await assert.rejects(login(eve.ctx.db, 'future@gmail.com', 'Still-Eve-123'), /incorrect/);
  assert.equal(await passwordOpens(t, g.account, karim.id), true);
  // their own password, from a link: every store, and their own stores
  const own = (await setPasswordFromLink(t, g.account.id, 'Mine-Only-123'))!;
  assert.deepEqual([own.passwordBy, own.passwordOwner], ['self', null]);
  await setAccountPhone(t, own.id, tph(), true);
  const shop = await addStore(t, (await accountByEmail(t, 'future@gmail.com'))!, { name: 'Future Shop' });
  assert.ok(shop.id);
  void p;
});

test('the control room never reuses a password someone else may know: the owner is invited', async () => {
  const { t, p } = await server();
  const eve = await selfSeller(t, 'eve@evil.dz', 'Evil Shop');
  await serverRpc(t, eve.ctx, 'users.create', { name: 'Boss', email: 'boss@gmail.com', phone: tph(), roles: ['confirmation'], password: 'Eve-Chose-123' });
  const plan = (await p('p.plans.list')).find((x: any) => x.code === 'business').id;
  const made: any = await p('p.shops.create', { name: 'Boss Shop', ownerName: 'Boss', ownerEmail: 'boss@gmail.com', planId: plan, trialDays: 14 });
  assert.equal(made.invited, true);
  assert.equal(made.mail.kind, 'invite');
  assert.equal(await checkAccountPassword(t, 'boss@gmail.com', 'Eve-Chose-123'), null);
  // the owner's own password, from the invitation
  await passwordFromLink(t, made.mail.token, 'Boss-Own-123');
  const acc = (await accountByEmail(t, 'boss@gmail.com'))!;
  assert.equal(acc.passwordBy, 'self');
  assert.equal(await passwordOpens(t, acc, made.id), true);
});

test('accounts made by a store’s admin before: marked so by the migration', async () => {
  const { t } = await server();
  const eve = await selfSeller(t, 'eve@evil.dz', 'Evil Shop');
  await serverRpc(t, eve.ctx, 'users.create', { name: 'Old', email: 'old@agent.dz', phone: tph(), roles: ['confirmation'], password: 'Old-Pass-123' });
  // as before this change: nothing known about who chose it
  await t.platform.query(`UPDATE platform.accounts SET password_by = NULL, password_owner = NULL WHERE email = 'old@agent.dz'`);
  const sql = PLATFORM_MIGRATIONS.find(([n]) => n === 'p023_password_by')![1];
  await t.exec('public', sql);
  const acc = (await accountByEmail(t, 'old@agent.dz'))!;
  assert.deepEqual([acc.passwordBy, acc.passwordOwner], ['admin', (await accountByEmail(t, 'eve@evil.dz'))!.id]);
  // the people who signed up themselves are not touched
  assert.equal((await accountByEmail(t, 'eve@evil.dz'))!.passwordBy, 'self');
});
