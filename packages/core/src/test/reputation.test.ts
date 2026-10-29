// Le réseau Pilotix: sellers share what they learned about fake orders — anonymously (hashes only, a count only), and
// only when two different businesses agree. A store's own history is never counted for it, one owner's several stores
// count once, a delivery after a refusal takes it back, the demo shop teaches nothing, and the network never blocks an
// order on its own: it sends it to a person.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ctx, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, staffLogin, Tenancy } from '../index';
import { FraudFacts, scoreOrder } from '../modules/fraud';
import { refreshReputation, sharedReputation } from '../platform/reputation';

const OWNER = { email: 'owner@reseau.dz', password: 'Owner-Password-1' };
const DAY = 86_400_000;
let phoneN = 0;

async function world() {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<any>;
  const pro = (await p('p.plans.list')).find((x: any) => x.code === 'pro');
  /** a store of its own owner (another business) */
  const store = async (name: string, email: string) => {
    const made = await p('p.shops.create', { name, ownerName: name, ownerEmail: email, ownerPhone: `055${String(++phoneN).padStart(7, '0')}`, planId: pro.id, trialDays: 14 });
    const s = (await t.platform.query(`SELECT id, schema_name FROM platform.shops WHERE id = $1`, [made.id]))[0];
    return { id: Number(s.id), schema: String(s.schema_name) };
  };
  return { t, store };
}

/** one finished order in a store: conf (the agent's verdict) / follow (the delivery), `daysAgo` days ago */
async function order(t: Tenancy, schema: string, phone: string, o: { conf?: string; follow?: string; daysAgo?: number }) {
  const db = t.shop(schema);
  const c = (await db.query(`INSERT INTO customers (phone, name, wilaya_id) VALUES ($1, 'Client Test', 16) ON CONFLICT (phone) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [phone]))[0];
  await db.query(
    `INSERT INTO orders (ref, customer_id, customer_name, phone, wilaya_id, commune, conf_status, follow_status, subtotal, delivery_fee, discount, total, channel, created_at)
     VALUES ('T' || nextval('order_ref_seq'), $1, 'Client Test', $2, 16, 'Kouba', $3, $4, 1000, 0, 0, 1000, 'site', $5)`,
    [c.id, phone, o.conf ?? 'confirmed', o.follow ?? null, new Date(Date.now() - (o.daysAgo ?? 1) * DAY).toISOString()],
  );
}

/** an agent marks a device « 🕵️ Concurrent » in a store (its fingerprint, the same on every store's pages) */
const mark = (t: Tenancy, schema: string, fphash: string) =>
  t.shop(schema).query(`INSERT INTO fraud_marks (kind, value, reason, device, fphash) VALUES ('device', $1, 'competitor', $1, $2)`, [`d:${fphash}`, fphash]);

/** what a store asks the network about a new order */
const ask = (t: Tenancy, shopId: number, a: { phone?: string; fphash?: string }, demo = false) =>
  sharedReputation({ t, shop: { id: shopId, demo }, now: () => Date.now() } as unknown as Ctx, { phone: a.phone ?? null, fphash: a.fphash ?? null });

test('one seller is never enough; two different businesses are — and a store never counts itself', async () => {
  const { t, store } = await world();
  const a = await store('Boutique Alger', 'a@alger.dz');
  const b = await store('Boutique Oran', 'b@oran.dz');
  const c = await store('Boutique Sétif', 'c@setif.dz');
  const P = '0661112233';

  // A's agent found the order fake: for C, only one seller says so — not enough
  await order(t, a.schema, P, { conf: 'fake' });
  await refreshReputation(t);
  assert.deepEqual(await ask(t, c.id, { phone: P }), { sellers: 1 });

  // B's parcel to the same number was refused at the door: now two different businesses agree
  await order(t, b.schema, P, { follow: 'returned' });
  await refreshReputation(t);
  assert.deepEqual(await ask(t, c.id, { phone: P }), { sellers: 2 });
  // A itself only hears about B (its own result already weighs in its own score)
  assert.deepEqual(await ask(t, a.id, { phone: P }), { sellers: 1 });
  // a number nobody had trouble with
  assert.deepEqual(await ask(t, c.id, { phone: '0770998877' }), { sellers: 0 });

  // only hashes are kept: never the number, never the fingerprint
  const keys = (await t.platform.query(`SELECT key FROM platform.fraud_reputation`)).map((r: any) => String(r.key));
  assert.ok(keys.length >= 2);
  for (const k of keys) {
    assert.match(k, /^[0-9a-f]{64}$/);
    assert.ok(!k.includes('1112233'));
  }
});

test('one owner with several stores counts once; a delivery after the refusal takes it back', async () => {
  const { t, store } = await world();
  const a = await store('Mode Alger', 'owner@mode.dz');
  const a2 = await store('Mode Blida', 'other@mode.dz');
  const b = await store('Tech Oran', 'b@tech.dz');
  const c = await store('Bébé Sétif', 'c@bebe.dz');
  // the second store belongs to the same business as the first
  await t.platform.query(`UPDATE platform.shops SET owner_account_id = s.owner_account_id, owner_email = s.owner_email FROM platform.shops s WHERE s.id = $1 AND platform.shops.id = $2`, [a.id, a2.id]);

  const Q = '0552223344';
  await order(t, a.schema, Q, { conf: 'fake' });
  await order(t, a2.schema, Q, { conf: 'wrong_number' });
  await refreshReputation(t);
  assert.deepEqual(await ask(t, c.id, { phone: Q }), { sellers: 1 }, 'two stores of one owner are one seller');

  // B refused a parcel, then later received and paid one: B no longer holds anything against this number
  const R = '0773334455';
  await order(t, a.schema, R, { conf: 'fake', daysAgo: 3 });
  await order(t, b.schema, R, { follow: 'returned', daysAgo: 5 });
  await refreshReputation(t);
  assert.deepEqual(await ask(t, c.id, { phone: R }), { sellers: 2 });
  await order(t, b.schema, R, { follow: 'delivered', daysAgo: 2 });
  await refreshReputation(t);
  assert.deepEqual(await ask(t, c.id, { phone: R }), { sellers: 1 });
});

test('devices too; a lifted mark is forgotten; the demo shop is not in the network', async () => {
  const { t, store } = await world();
  const a = await store('Sport Alger', 'a@sport.dz');
  const b = await store('Sport Oran', 'b@sport.dz');
  const c = await store('Sport Annaba', 'c@sport.dz');
  const d = await store('Vitrine Essai', 'vitrine@essai.dz');
  await t.platform.query(`UPDATE platform.shops SET is_demo = true WHERE id = $1`, [d.id]);

  const F = 'fp7k2q9x4m1a8b3c5d6e7f8g';
  await mark(t, a.schema, F);
  await mark(t, b.schema, F);
  await mark(t, d.schema, F);
  await refreshReputation(t);
  // a new browser, a new number — but the same physical device, marked by two other sellers (the demo does not count)
  assert.deepEqual(await ask(t, c.id, { phone: '0669990001', fphash: F }), { sellers: 2 });

  // B's agent lifts the mark (a mistake): only A remains
  await t.shop(b.schema).query(`UPDATE fraud_marks SET lifted = true`);
  await refreshReputation(t);
  assert.deepEqual(await ask(t, c.id, { fphash: F }), { sellers: 1 });

  // the demo shop never asks the network; no network on a single-shop install / the preview
  assert.equal(await ask(t, d.id, { fphash: F }, true), null);
  assert.equal(await sharedReputation({ shop: { id: c.id, demo: false }, now: () => Date.now() } as unknown as Ctx, { phone: '0669990001', fphash: F }), null);
});

test('the network and the attacked ad send to a person — never a block on their own, never a paid customer', () => {
  const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
  const base: FraudFacts = {
    name: 'Mohamed Amine Benali', phoneRaw: '0661445566', phone: '0661445566', qty: 1, honeypot: '', servedMs: 30_000, clientMs: 30_000, inputs: 30, pow: 'ok', userAgent: UA, webdriver: false,
    recent: { phone24h: 0, phoneSameProduct24h: 0, ip10m: 0, ip1h: 0, device1h: 0 }, history: { blacklisted: false, orders: 0, delivered: 0, returned: 0, cancelled: 0 }, ipCountry: null, ipWilaya: null, wilayaId: 16,
  };
  assert.equal(scoreOrder(base).verdict, 'allow');

  // two other sellers agree: a person calls first
  const two = scoreOrder({ ...base, shared: { sellers: 2 } });
  assert.equal(two.verdict, 'review');
  assert.ok(two.reasons.some((r) => r.code === 'shared_bad'));
  // one other seller alone: nothing
  assert.equal(scoreOrder({ ...base, shared: { sellers: 1 } }).verdict, 'allow');
  // a customer who already received and paid here is not bothered by what others say
  const paid = { ...base, history: { blacklisted: false, orders: 2, delivered: 2, returned: 0, cancelled: 0 } };
  assert.equal(scoreOrder({ ...paid, shared: { sellers: 3 } }).verdict, 'allow');

  // an order already suspicious (85 points) + the network: still a person, never the block list because of the network
  const shady = { ...base, servedMs: 5000, inputs: 0, userAgent: '' };
  assert.equal(scoreOrder(shady).verdict, 'review');
  assert.equal(scoreOrder({ ...shady, shared: { sellers: 3 } }).verdict, 'review');
  // …but a certain sign still blocks, network or not
  assert.equal(scoreOrder({ ...base, honeypot: 'http://x', shared: { sellers: 2 } }).verdict, 'block');

  // an ad set the agents found mostly fake lately: its orders go to a person
  assert.equal(scoreOrder({ ...base, campaign: { decided: 10, fake: 6 } }).verdict, 'review');
  // too few finished orders to tell, or mostly real customers: nothing
  assert.equal(scoreOrder({ ...base, campaign: { decided: 5, fake: 5 } }).verdict, 'allow');
  assert.equal(scoreOrder({ ...base, campaign: { decided: 20, fake: 4 } }).verdict, 'allow');
});
