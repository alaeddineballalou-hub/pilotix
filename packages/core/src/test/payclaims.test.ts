// « J'ai payé »: a store's admin sends the period, the way and the receipt's photo; the amount is the plan's (1 month, or
// the year price, else 10 months); one claim waits at a time; the team hears of it (payAlert hook); the control room
// refuses it with a reason, or accepts it: a real payment, exactly like « Enregistrer un paiement ».
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { loadShop, passwordFromLink, platformSettings } from '../platform';

const OWNER = { email: 'owner@platform.dz', password: 'Owner-Password-1' };
const PW = 'Boutique-Password-1';
const SALIM = 'salim@shops.dz';
const PHOTO = `data:image/jpeg;base64,${Buffer.from('a tiny jpeg').toString('base64')}`;

async function as(t: Tenancy, shopId: number, email: string, password: string, server?: ServerHooks): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, password), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t, server };
}

async function waStatus(t: Tenancy, id: number): Promise<string | null> {
  for (let n = 0; n < 50; n++) {
    const r = (await t.platform.query('SELECT wa_status FROM platform.payment_claims WHERE id = $1', [id]))[0];
    if (r?.wa_status) return r.wa_status;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  return null;
}

test('« J’ai payé »: amount from the plan, one at a time, the alert, refuse with a reason, accept = a real payment', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<any>;

  // the WhatsApp numbers: Algerian or with their country code, kept normalised; an old save without them keeps them
  await p('p.settings.save', { payment: { text: 'CCP 123', phone: '', whatsapp: '', alert: { numbers: ['0661 23 45 67', '+33612345678', '0661234567'], template: 'pilotix_paiement', lang: 'fr' } } });
  assert.deepEqual((await platformSettings(t)).payment.alert, { numbers: ['0661234567', '+33612345678'], template: 'pilotix_paiement', lang: 'fr' });
  await p('p.settings.save', { payment: { text: 'CCP 1234', phone: '', whatsapp: '' } });
  assert.deepEqual((await platformSettings(t)).payment.alert.numbers, ['0661234567', '+33612345678']);
  await assert.rejects(p('p.settings.save', { payment: { text: '', phone: '', whatsapp: '', alert: { numbers: ['12'], template: 'pilotix_paiement', lang: 'fr' } } }), /Numéro WhatsApp faux/);

  const { id: planId } = await p('p.plans.save', { name: 'Mensuel', priceMonth: 3000, features: ['*'], maxUsers: 5, maxDrivers: 2, maxOrdersMonth: 1000, maxStores: 1, public: true, active: true });
  const made = await p('p.shops.create', { name: 'Salim Shop', ownerName: 'Salim', ownerEmail: SALIM, planId, trialDays: 14 });
  if (made.mail?.token) await passwordFromLink(t, made.mail.token, PW);
  await t.platform.query('UPDATE platform.accounts SET email_verified_at = now() WHERE email = $1', [SALIM]);

  const alerts: number[] = [];
  const server: ServerHooks = { courier: async () => ({}), meta: async () => ({}), hashPassword: async (x) => x, payAlert: async (id) => (alerts.push(id), 'sent') };
  const admin = await as(t, made.id, SALIM, PW, server);

  // the prices: a month, and a year (no year price: 10 months)
  const info = await call('billing.claims', admin, {});
  assert.deepEqual(info.prices, { month: 3000, year: 30000 });
  assert.equal(info.plan, 'Mensuel');
  assert.deepEqual(info.claims, []);

  // someone of the team who is not an admin cannot send it
  await call('users.create', admin, { name: 'Nadia', email: 'nadia@shops.dz', phone: '0661000009', password: 'Person-Password-1', roles: ['confirmation'], language: 'fr' });
  const agent = await as(t, made.id, 'nadia@shops.dz', 'Person-Password-1', server);
  await assert.rejects(call('billing.claim', agent, { months: 1, method: 'ccp', photo: PHOTO }), (e: any) => e.code === 'forbidden');
  // the photo is needed
  await assert.rejects(call('billing.claim', admin, { months: 1, method: 'ccp', photo: '' }), /photo du reçu/);

  // a year: the amount is the server's (whatever the screen thinks), the team is told
  const c1 = await call('billing.claim', admin, { months: 12, method: 'baridimob', reference: 'BM-778', photo: PHOTO, amount: 1 } as any);
  assert.equal(c1.amount, 30000);
  assert.deepEqual(alerts, [c1.id]);
  assert.equal(await waStatus(t, c1.id), 'sent');
  // one at a time
  await assert.rejects(call('billing.claim', admin, { months: 1, method: 'ccp', photo: PHOTO }), /attend déjà/);

  // the control room's list: no photo inside, asked alone
  const list = await p('p.claims.list');
  assert.equal(list.length, 1);
  assert.equal(list[0].shop.name, 'Salim Shop');
  assert.equal(list[0].hasPhoto, true);
  assert.equal(list[0].waStatus, 'sent');
  assert.equal(list[0].sentBy, `Salim (${SALIM})`);
  assert.equal('photo' in list[0], false);
  assert.equal((await p('p.claims.photo', { id: c1.id })).photo, PHOTO);

  // refused: a reason is needed; the store sees it and may send again
  await assert.rejects(p('p.claims.refuse', { id: c1.id, reason: ' ' }));
  await p('p.claims.refuse', { id: c1.id, reason: 'Reçu illisible' });
  await assert.rejects(p('p.claims.accept', { id: c1.id }), /déjà été vérifié/);
  const after = await call('billing.claims', admin, {});
  assert.deepEqual([after.claims[0].status, after.claims[0].reason], ['refused', 'Reçu illisible']);
  assert.equal(Number((await t.platform.query('SELECT count(*)::int AS n FROM platform.payments WHERE shop_id = $1', [made.id]))[0].n), 0);

  // the plan gets a year price: the year costs that
  await t.platform.query('UPDATE platform.plans SET price_year = 25000 WHERE id = $1', [planId]);
  const c2 = await call('billing.claim', admin, { months: 12, method: 'ccp', reference: 'CCP-1', photo: PHOTO });
  assert.equal(c2.amount, 25000);

  // accepted: a payment like « Enregistrer un paiement » (12 months, from the end of the trial)
  const before = (await loadShop(t, { id: made.id }))!;
  const ok = await p('p.claims.accept', { id: c2.id });
  assert.match(ok.receiptNo, /^PX-\d{4}-\d{4}$/);
  const pay = (await t.platform.query('SELECT * FROM platform.payments WHERE id = $1', [ok.id]))[0];
  assert.deepEqual([Number(pay.amount), pay.method, Number(pay.months), pay.reference, Number(pay.plan_id)], [25000, 'ccp', 12, 'CCP-1', planId]);
  assert.equal(new Date(pay.period_from).toISOString(), before.trialEndsAt);
  const to = new Date(before.trialEndsAt!);
  to.setUTCMonth(to.getUTCMonth() + 12);
  assert.equal(new Date(pay.period_to).toISOString(), to.toISOString());
  const paid = (await loadShop(t, { id: made.id }))!;
  assert.equal(paid.paidUntil, new Date(pay.period_to).toISOString());
  const decided = (await t.platform.query('SELECT status, payment_id, decided_by FROM platform.payment_claims WHERE id = $1', [c2.id]))[0];
  assert.deepEqual([decided.status, Number(decided.payment_id), Number(decided.decided_by)], ['accepted', ok.id, staff.id]);
  await assert.rejects(p('p.claims.accept', { id: c2.id }), /déjà été vérifié/);
  // both decisions are in the journal
  const journal = (await t.platform.query(`SELECT action FROM platform.audit WHERE action LIKE 'claim.%' ORDER BY id`)).map((r: any) => r.action);
  assert.deepEqual(journal, ['claim.refuse', 'claim.accept']);

  // a month more: from the end of the paid period, 1 month; without the server's hook the alert is « pas configuré »
  const plain = await as(t, made.id, SALIM, PW);
  const c3 = await call('billing.claim', plain, { months: 1, method: 'virement', photo: PHOTO });
  assert.equal(c3.amount, 3000);
  assert.equal(await waStatus(t, c3.id), 'off');
  const ok3 = await p('p.claims.accept', { id: c3.id });
  const pay3 = (await t.platform.query('SELECT * FROM platform.payments WHERE id = $1', [ok3.id]))[0];
  assert.equal(Number(pay3.months), 1);
  assert.equal(new Date(pay3.period_from).toISOString(), paid.paidUntil);
  assert.deepEqual(alerts, [c1.id, c2.id]);
  assert.deepEqual(await p('p.claims.list'), []);
  assert.equal((await p('p.claims.list', { status: 'decided' })).length, 3);
});
