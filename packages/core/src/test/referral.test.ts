// Referral › Referral (Pilotix's own programme between stores): the reward once, at the first real payment, really added
// to the referrer's subscription; never for oneself (same account, e-mail or phone); the referrer told at the sign-up
// (once); the page's free months earned / used / left; the on / off and the months of the control room.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadShop, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, staffLogin } from '../index';
import { accountByEmail, addStore, confirmSignup, referralSignupNotice, startSignup, storeReferrals } from '../platform';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const DAY = 86_400_000;

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const t = pgliteTenancy(pg as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = <T = any>(name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<T>;
  return { t, p };
}
const signup = async (t: any, f: Record<string, unknown>) => {
  const m: any = await startSignup(t, { password: 'Tigre-Bleu-Sahara-77', language: 'fr', terms: true, ...f } as any, '1.2.3.9');
  assert.equal(m.kind, 'confirm');
  return (await confirmSignup(t, m.token)) as any;
};

test('referral: told once at sign-up, rewarded once at the first real payment, never for oneself', async () => {
  const { t, p } = await server();
  // the referrer: a store with its own owner (shop #1 never expires, so it is never rewarded)
  const a = await signup(t, { name: 'Yasmine', email: 'yasmine@shop.dz', phone: '0661000001', storeName: 'Yasmine Shop' });
  const code = a.shop.referralCode as string;
  assert.match(code, /^[A-Z2-9]{6}$/);
  // a friend signs up with the code: the referrer is told, once
  const b = await signup(t, { name: 'Nadia', email: 'nadia@x.dz', phone: '0661000002', storeName: 'Nadia Beauty', referral: code });
  const told = await referralSignupNotice(t, b.shop.id);
  assert.equal(told?.referrerShopId, a.shop.id);
  assert.equal(told?.friend, 'Nadia Beauty');
  assert.equal(told?.to, 'yasmine@shop.dz');
  assert.equal(await referralSignupNotice(t, b.shop.id), null, 'told once');
  let r = await storeReferrals(t, a.shop.id);
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].stage, 'signed_up');
  // a payment of 0 DA (a gift, a correction) is not the first real payment
  const before = Date.parse((await loadShop(t, { id: a.shop.id }))!.paidUntil ?? (await loadShop(t, { id: a.shop.id }))!.trialEndsAt!);
  const zero = await p('p.payments.add', { shopId: b.shop.id, amount: 0, method: 'cash', months: 1 });
  assert.equal(zero.rewarded, null);
  // the first real payment: the free month is really added to the referrer's subscription, once
  const pay = await p('p.payments.add', { shopId: b.shop.id, amount: 7900, method: 'cash', months: 1 });
  assert.deepEqual(pay.rewarded, { shop: 'Yasmine Shop', months: 1 });
  const after = Date.parse((await loadShop(t, { id: a.shop.id }))!.paidUntil!);
  assert.ok(after - before > 27 * DAY, 'a month added');
  assert.equal((await p('p.payments.add', { shopId: b.shop.id, amount: 7900, method: 'cash', months: 1 })).rewarded, null, 'never twice');
  r = await storeReferrals(t, a.shop.id);
  assert.equal(r.list[0].stage, 'paying');
  assert.equal(r.earned, 1);
  assert.ok(r.used >= 0 && r.used <= 1);
  assert.equal(Math.round((r.left + r.used) * 10) / 10, 1);
  const row = (await t.platform.query('SELECT * FROM platform.referrals WHERE referred_shop_id = $1', [b.shop.id]))[0];
  assert.ok(row.reward_from && row.reward_to);
  // 3 days later, a little of it is used
  assert.ok((await storeReferrals(t, a.shop.id, Date.now() + 40 * DAY)).used > 0);

  // one's own code: the same phone (another e-mail) is not a referral
  const self = await signup(t, { name: 'Yasmine', email: 'yasmine2@shop.dz', phone: '0661000001', storeName: 'Yasmine Deux', referral: code });
  assert.equal((await t.platform.query('SELECT 1 FROM platform.referrals WHERE referred_shop_id = $1', [self.shop.id])).length, 0);
  // a second store of the same account with its code: not a referral either
  await p('p.settings.save', { signup: { open: true, maxStores: 3 } });
  await t.platform.query('UPDATE platform.plans SET max_stores = NULL');
  const acc = (await accountByEmail(t, 'yasmine@shop.dz'))!;
  const second = await addStore(t, acc, { name: 'Yasmine Bébé' });
  assert.equal((await t.platform.query('SELECT 1 FROM platform.referrals WHERE referred_shop_id = $1', [second.id])).length, 0);

  // the control room turns it off: the next friend's first payment brings nothing (the referral is still recorded)
  await p('p.settings.save', { referral: { on: false, months: 1 } });
  const c = await signup(t, { name: 'Karim', email: 'karim@x.dz', phone: '0661000003', storeName: 'Karim Tech', referral: code });
  const pay3 = await p('p.payments.add', { shopId: c.shop.id, amount: 7900, method: 'cash', months: 1 });
  assert.equal(pay3.rewarded, null);
  // on again with 2 months: the next one gives 2
  await p('p.settings.save', { referral: { on: true, months: 2 } });
  const d = await signup(t, { name: 'Lina', email: 'lina@x.dz', phone: '0661000004', storeName: 'Lina Mode', referral: code });
  assert.deepEqual((await p('p.payments.add', { shopId: d.shop.id, amount: 7900, method: 'cash', months: 1 })).rewarded, { shop: 'Yasmine Shop', months: 2 });
});
