// Delivery side of the fraud protection: the customer's trust from their parcels.
// 1 refusal → 🟡, 2 → stop-desk only, 3 → blacklisted by Pilotix (blocked on the landing pages), a paid delivery forgives;
// a driver problem the claim proves is not counted (once); a look-alike of a refuser is 🟡, and blacklisted if they refuse.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { FraudFacts, scoreOrder } from '../modules/fraud';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let items: { productId: number; variantId: number; qty: number }[];
let companyId: number;
before(async () => {
  let as: (email: string) => Promise<Ctx>;
  ({ db, as } = await setup(120));
  admin = await as(EMAILS.admin);
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  items = [{ productId: Number(p.id), variantId: Number(p.vid), qty: 1 }];
  companyId = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind <> 'own' ORDER BY id LIMIT 1`))[0].id);
});

let n = 0;
const phone = () => `0698${String(300000 + ++n).slice(-6)}`;
const cust = async (ph: string) => (await db.query('SELECT * FROM customers WHERE phone = $1', [ph]))[0];
const notes = async (oid: number) => (await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND note IS NOT NULL ORDER BY id`, [oid])).map((r: any) => String(r.note));

async function order(ph: string, extra: Record<string, unknown> = {}) {
  return (await call('orders.create', admin, { customerName: `Client${n} Test`, phone: ph, wilayaId: 16, commune: 'Kouba', items, confirm: true, ...extra })) as any;
}
async function ship(oid: number) {
  await db.query('UPDATE orders SET company_id = $2 WHERE id = $1', [oid, companyId]);
  await call('orders.setFollow', admin, { ids: [oid], status: 'shipped', tracking: `TRK-${oid}` });
}
async function refuse(oid: number) {
  await ship(oid);
  await call('orders.setFollow', admin, { ids: [oid], status: 'returning', reason: 'Refusé par le client' });
  await call('orders.setFollow', admin, { ids: [oid], status: 'returned' });
}

test('trust: 1 refusal, 2 → stop-desk only, 3 → blacklisted by Pilotix, a paid delivery forgives', async () => {
  const ph = phone();
  const a = await order(ph);
  await refuse(a.id);
  let c = await cust(ph);
  assert.equal(c.refusals, 1);
  assert.equal(c.stopdesk_only, false);
  assert.equal(c.blacklisted, false);

  const b = await order(ph);
  await refuse(b.id);
  c = await cust(ph);
  assert.equal(c.refusals, 2);
  assert.equal(c.stopdesk_only, true);
  assert.ok((await notes(b.id)).some((x) => /stop-desk uniquement/.test(x)));

  // a home delivery is no longer confirmed: by the AI seller (checked first) nor by an agent
  const home = await order(ph);
  assert.equal(home.confStatus, 'to_check');
  assert.equal(home.customerStopdeskOnly, true);
  assert.match(home.internalNote ?? '', /stop-desk/);
  await assert.rejects(call('orders.setConf', admin, { ids: [home.id], status: 'confirmed' }), /stop-desk/);
  await call('orders.setConf', admin, { ids: [home.id], status: 'cancelled', reason: 'test' });

  // at the desk it goes; refused a 3rd time → blacklisted, automatically
  // at a bureau (chosen before confirming: the courier needs it)
  const sd = (await db.query(`SELECT s.id, s.company_id FROM stopdesks s JOIN delivery_companies c ON c.id = s.company_id AND c.active WHERE s.wilaya_id = 16 ORDER BY s.id LIMIT 1`))[0];
  const desk = await order(ph, { isStopdesk: true, ...(sd ? { stopdeskId: Number(sd.id), companyId: Number(sd.company_id) } : {}) });
  assert.equal(desk.confStatus, 'confirmed');
  await refuse(desk.id);
  c = await cust(ph);
  assert.equal(c.refusals, 3);
  assert.equal(c.blacklisted, true);
  assert.equal(c.blacklist_auto, true);
  assert.match(c.blacklist_reason, /Refuse ses colis/);

  // they receive and pay one (checked by a person first) → forgiven
  const paid = await order(ph, { isStopdesk: true, ...(sd ? { stopdeskId: Number(sd.id), companyId: Number(sd.company_id) } : {}) });
  assert.equal(paid.confStatus, 'to_check');
  await call('orders.setConf', admin, { ids: [paid.id], status: 'confirmed' });
  await ship(paid.id);
  await call('orders.setFollow', admin, { ids: [paid.id], status: 'delivered' });
  c = await cust(ph);
  assert.equal(c.refusals, 0);
  assert.equal(c.stopdesk_only, false);
  assert.equal(c.blacklisted, false);
  assert.ok((await notes(paid.id)).some((x) => /Liste noire levée/.test(x)));
});

test('trust: a blacklist set by a person is never lifted by Pilotix', async () => {
  const ph = phone();
  const a = await order(ph);
  await call('customers.setBlacklist', admin, { phone: ph, on: true, reason: 'Insulte les agents' });
  await ship(a.id);
  await call('orders.setFollow', admin, { ids: [a.id], status: 'delivered' });
  const c = await cust(ph);
  assert.equal(c.blacklisted, true);
  assert.equal(c.blacklist_reason, 'Insulte les agents');
});

test('trust: a driver problem proved by a claim does not count against the customer (once)', async () => {
  const ph = phone();
  const a = await order(ph);
  await refuse(a.id);
  const b = await order(ph);
  await refuse(b.id);
  assert.equal((await cust(ph)).stopdesk_only, true);
  await call('suivi.claimCreate', admin, { orderId: b.id, reason: 'nocall', message: 'Le livreur n’a jamais appelé', viaApi: false });
  let c = await cust(ph);
  assert.equal(c.refusals, 1);
  assert.equal(c.stopdesk_only, false);
  // a second « driver problem » is a normal refusal
  await call('suivi.claimCreate', admin, { orderId: a.id, reason: 'fakeret', message: 'Faux retour', viaApi: false });
  c = await cust(ph);
  assert.equal(c.refusals, 1);
});

test('trust: a look-alike of a refuser is checked (🟡), and blacklisted at once if they refuse', async () => {
  const bad = phone();
  const a = await order(bad, { customerName: 'Walid Benkhaled', commune: 'Hussein Dey' });
  await refuse(a.id);
  const ph = phone();
  const look = await order(ph, { customerName: 'walid  Benkhaled', commune: 'hussein dey', confirm: false });
  assert.equal(look.looksLikePhone, bad);
  assert.match(look.internalNote ?? '', /Même nom et même commune/);
  // never blocked for that alone
  assert.equal(look.confStatus, 'new');
  assert.equal((await cust(ph)).blacklisted, false);
  // another name or another commune: not a look-alike; a single first name neither
  assert.equal((await order(phone(), { customerName: 'Walid Benkhaled', commune: 'Kouba', confirm: false })).looksLikePhone, null);
  await call('orders.setConf', admin, { ids: [look.id], status: 'confirmed' });
  await refuse(look.id);
  const c = await cust(ph);
  assert.equal(c.blacklisted, true);
  assert.equal(c.blacklist_auto, true);
});

test('trust: the landing page score (1 refusal 🟡, look-alike 🟡 even from an ad, blacklisted by Pilotix → blocked)', () => {
  const base: FraudFacts = {
    name: 'Amina Boudiaf', phoneRaw: '0661445566', phone: '0661445566', qty: 1, honeypot: '', servedMs: 30_000, clientMs: 30_000, inputs: 30, pow: 'ok',
    userAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/128.0 Mobile', webdriver: false,
    recent: { phone24h: 0, phoneSameProduct24h: 0, ip10m: 0, ip1h: 0, device1h: 0 },
    history: { blacklisted: false, orders: 1, delivered: 0, returned: 1, cancelled: 0, refusals: 1 }, ipCountry: null, ipWilaya: null, wilayaId: 16,
  };
  const fromAd = { scroll: 60, pasted: false, tz: 'Africa/Algiers', touch: 5, fromAd: true };
  assert.equal(scoreOrder({ ...base, behavior: fromAd }).verdict, 'review');
  assert.equal(scoreOrder({ ...base, behavior: fromAd }, 'relaxed').verdict, 'review');
  assert.equal(scoreOrder({ ...base, history: { ...base.history, refusals: 2 } }).verdict, 'review');
  // forgiven: refused before, then received and paid
  assert.equal(scoreOrder({ ...base, history: { ...base.history, delivered: 1, refusals: 0 } }).verdict, 'allow');
  const look = { ...base, history: { blacklisted: false, orders: 0, delivered: 0, returned: 0, cancelled: 0, refusals: 0, lookAlike: true } };
  assert.equal(scoreOrder({ ...look, behavior: fromAd }, 'relaxed').verdict, 'review');
  const blocked = scoreOrder({ ...base, history: { ...base.history, blacklisted: true, blacklistAuto: true, refusals: 3 } });
  assert.equal(blocked.verdict, 'block');
  assert.ok(blocked.reasons.some((r) => r.code === 'refuser_blocked'));
  // blacklisted by a person: checked, as before
  assert.equal(scoreOrder({ ...base, history: { ...base.history, blacklisted: true, refusals: 0 } }).verdict, 'review');
});
