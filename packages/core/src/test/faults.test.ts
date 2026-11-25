// Who is responsible for a problem (modules/faults.ts): the owner's rules, who sees which names, « Pas moi ».
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { _test } from '../modules/faults';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(400));
});

const DAY = 86_400_000;
/** an order as the history tells it (only what the rules read) */
const facts = (o: Record<string, unknown> = {}): any => ({
  id: 1,
  ref: 'PX1',
  customer: 'A',
  total: 1000,
  phone: '0550000000',
  wilayaId: 16,
  companyKind: 'zr',
  agentId: 11,
  followAgentId: 31,
  courier: 'ZR Express',
  product: 'Lit parapluie',
  variant: 'Gris',
  qty: 1,
  confirmedAt: 10 * DAY,
  shippedAt: 11 * DAY,
  backAt: 14 * DAY,
  confirmer: 11,
  preparer: 21,
  last: {},
  suiviLost: null,
  words: null,
  alertAt: null,
  acted: false,
  noStock: false,
  cost: 300,
  ...o,
});
const { decide, autoReason } = _test;

test('commune, address, phone: whoever wrote it last (the depot after the confirmation, else the confirmation)', () => {
  assert.deepEqual(decide('wrong_commune', facts()), { team: 'confirmation', personId: 11, personLabel: null });
  const atDepot = facts({ last: { place: { user: 21, depot: true, at: 12 * DAY } } });
  assert.deepEqual(decide('wrong_commune', atDepot), { team: 'depot', personId: 21, personLabel: null });
  // a confirmation agent who changed it later: still the confirmation
  assert.equal(decide('wrong_address', facts({ last: { address: { user: 12, depot: false, at: 12 * DAY } } })).team, 'confirmation');
});

test('wrong colour: the order says what the customer got → Confirmation; something else → Dépôt (who prepared it)', () => {
  assert.deepEqual(decide('wrong_variant', facts(), { variant: 'gris' }), { team: 'confirmation', personId: 11, personLabel: null });
  assert.deepEqual(decide('wrong_variant', facts(), { variant: 'Bleu' }), { team: 'depot', personId: 21, personLabel: null });
  assert.equal(decide('wrong_variant', facts()).team, 'unknown', 'no answer: still to say');
  assert.equal(decide('wrong_qty', facts(), { qty: 1 }).team, 'confirmation');
  assert.equal(decide('wrong_qty', facts(), { qty: 2 }).team, 'depot');
});

test('« Injoignable » / « Numéro erroné »: reached on that number by an agent → the livreur; else the customer', () => {
  assert.deepEqual(decide('unreachable', facts()), { team: 'livreur', personId: null, personLabel: 'ZR Express' });
  assert.equal(decide('unreachable', facts({ confirmer: null })).team, 'client');
  // the number was changed after the confirmation: nobody reached the customer on it
  assert.equal(decide('bad_number', facts({ last: { phone: { user: 12, depot: false, at: 12 * DAY } } })).team, 'confirmation');
});

test('missing part, broken, too late', () => {
  assert.equal(decide('missing_part', facts(), { sealed: true }).team, 'produit');
  assert.equal(decide('missing_part', facts(), { sealed: false }).team, 'depot');
  assert.equal(decide('broken', facts(), { badlyPacked: true }).team, 'depot');
  assert.equal(decide('broken', facts()).team, 'societe');
  assert.equal(decide('too_late', facts({ shippedAt: 13 * DAY })).team, 'depot');
  assert.equal(decide('too_late', facts({ shippedAt: 13 * DAY, noStock: true })).team, 'produit');
  assert.equal(decide('too_late', facts()).team, 'societe');
});

test('a return nobody explained: the Suivi’s motif, else the courier’s words; an untouched alert → the Suivi', () => {
  assert.equal(autoReason(facts({ suiviLost: 'price' })), 'refuses_fee');
  assert.equal(autoReason(facts({ words: 'Adresse incorrecte' })), 'wrong_address');
  assert.equal(autoReason(facts({ words: 'Refusé par le client', alertAt: 13 * DAY, acted: false })), 'alert_ignored');
  assert.equal(autoReason(facts({ words: 'Refusé par le client', alertAt: 13 * DAY, acted: true })), 'refused');
  assert.deepEqual(decide('alert_ignored', facts()), { team: 'suivi', personId: 31, personLabel: null });
});

const RANGE = { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' };

test('the seller sees every name; a manager his own team’s names; an agent nothing but his own', async () => {
  const seller: any = await call('faults.summary', await as(EMAILS.vendeur), RANGE);
  assert.equal(seller.scope, 'all');
  assert.ok(seller.returns > 0, 'the demo has returns');
  const total = seller.teams.reduce((s: number, t: any) => s + t.n, 0) + seller.client.n + seller.unknown;
  assert.equal(total, seller.returns, 'each return has one responsible');
  assert.ok(seller.teams.every((t: any) => Array.isArray(t.people)));
  const manager: any = await call('faults.summary', await as(EMAILS.manager), RANGE);
  assert.equal(manager.scope, 'manager');
  assert.ok(Array.isArray(manager.teams.find((t: any) => t.team === 'confirmation').people), 'his team: names');
  assert.equal(manager.teams.find((t: any) => t.team === 'depot').people, null, 'another team: no names');
  const agent: any = await call('faults.summary', await as(EMAILS.conf), RANGE);
  assert.deepEqual(agent, { scope: 'mine' });
});

test('an agent’s own errors, and a depot line seen from the confirmation without its name', async () => {
  const depotLine = (await db.query(`SELECT order_id, person_id FROM order_faults WHERE team = 'depot' AND person_id IS NOT NULL AND moment <> 'sav' ORDER BY id LIMIT 1`))[0];
  assert.ok(depotLine, 'the demo has a depot error');
  const samira = await as(EMAILS.conf);
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [depotLine.order_id, samira.session.profile.id]);
  const map: any = await call('faults.forOrders', samira, { ids: [Number(depotLine.order_id)] });
  const line = map[String(depotLine.order_id)];
  assert.equal(line.team, 'depot');
  assert.equal(line.who, null, 'not her team: no name');
  const karim = await as(EMAILS.depot);
  const mine: any = await call('faults.mine', karim, RANGE);
  assert.ok(mine.n >= 1);
  assert.ok(mine.list.every((x: any) => x.team === 'depot'));
});

test('an agent says what happened; Pilotix decides; « Pas moi »; only the seller decides', async () => {
  const o = (await db.query(`SELECT f.order_id FROM order_faults f WHERE f.moment <> 'sav' AND f.decided_at IS NULL AND f.contest_at IS NULL ORDER BY f.order_id DESC LIMIT 1`))[0];
  const oid = Number(o.order_id);
  const nadia = await as(EMAILS.suivi);
  await db.query('UPDATE orders SET follow_agent_id = $2 WHERE id = $1', [oid, nadia.session.profile.id]);
  // the item of the order is not « Bleu »: the depot sent something else
  await db.query(`UPDATE order_items SET variant_title = 'Gris' WHERE order_id = $1`, [oid]);
  await call('faults.report', nadia, { orderId: oid, moment: 'return', reason: 'wrong_variant', answers: { variant: 'Bleu' } });
  const f = (await db.query('SELECT id, team FROM order_faults WHERE order_id = $1', [oid]))[0];
  assert.equal(f.team, 'depot');
  await assert.rejects(call('faults.report', nadia, { orderId: oid, moment: 'return', reason: 'wrong_variant', answers: {} }), /couleur/);
  // after delivery the customer's photo is needed
  await assert.rejects(call('faults.report', nadia, { orderId: oid, moment: 'sav', reason: 'wrong_variant', answers: { variant: 'Bleu' } }), /photo/);
  const karim = await as(EMAILS.depot);
  await db.query('UPDATE order_faults SET person_id = $2 WHERE id = $1', [f.id, karim.session.profile.id]);
  await call('faults.contest', karim, { id: Number(f.id), note: 'J’ai pris la bonne couleur' });
  await assert.rejects(call('faults.decide', karim, { id: Number(f.id), action: 'none' }));
  await call('faults.decide', await as(EMAILS.vendeur), { id: Number(f.id), action: 'none' });
  const after = (await db.query('SELECT team, decided_at FROM order_faults WHERE id = $1', [f.id]))[0];
  assert.equal(after.team, 'client');
  assert.ok(after.decided_at);
  await assert.rejects(call('faults.report', nadia, { orderId: oid, moment: 'return', reason: 'changed_mind', answers: {} }), /décidé/);
});

test('an order change keeps what it touched (who wrote the address last)', async () => {
  const ctx = await as(EMAILS.conf);
  const o = (await db.query(`SELECT id FROM orders WHERE conf_status IN ('new','to_check') AND NOT is_exchange ORDER BY id LIMIT 1`))[0];
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [o.id, ctx.session.profile.id]);
  const cur: any = await call('orders.get', ctx, { id: Number(o.id) });
  await call('orders.update', ctx, { id: Number(o.id), version: cur.version, address: 'Cité 20 logements, bloc B' });
  const e = (await db.query(`SELECT data FROM order_events WHERE order_id = $1 AND kind = 'edit' ORDER BY id DESC LIMIT 1`, [o.id]))[0];
  assert.ok(e?.data?.fields?.includes('address'), 'the change says it touched the address');
  assert.ok(!e.data.fields.includes('phone'), 'and only what it touched');
});
