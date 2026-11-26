// A delivery company's card in Caisse counts its money as the company does (the owner's request, 26 Nov 2026): its
// delivered orders, its SAV exchange parcels, and the fees it takes for its returns (+ their weight fee) and its swaps.
// Each fee comes out once: with an « Argent reçu », or with the company's own payment — never both.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let zr: number;

before(async () => {
  ({ db, as } = await setup(250));
  zr = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'zr' LIMIT 1`))[0].id);
  // the seed's own returns and swaps: already taken, so each test counts only its own
  await db.query('UPDATE orders SET fee_taken_at = now() WHERE fee_taken_at IS NULL');
});

const fees = (delivery: number, ret: number, est: number) => JSON.stringify({ delivery, ret, kg: est ? 5 + est / 50 : 3, weight: null, est, estRet: est, at: new Date().toISOString(), src: 'track' });
/** n orders not sent to any company yet (the demo has few ZR parcels on the road): the test makes them ZR parcels */
async function free(n: number): Promise<number[]> {
  const rows = await db.query(`SELECT id FROM orders WHERE company_id IS NULL AND follow_status IS NULL AND NOT is_exchange AND NOT cashed ORDER BY id LIMIT $1`, [n]);
  assert.equal(rows.length, n, 'enough orders not sent yet in the demo');
  const ids = rows.map((r: any) => Number(r.id));
  await db.query(`UPDATE orders SET company_id = $2, conf_status = 'confirmed', follow_status = 'shipped', shipped_at = now(), livreur_id = NULL WHERE id = ANY($1)`, [ids, zr]);
  return ids;
}
async function makeReturn(id: number, ret: number, est: number, tracking: string) {
  await db.query(
    `UPDATE orders SET follow_status = 'returned', returning_at = now(), returned_at = now(), livreur_id = NULL, tracking = $2, courier_fees = $3, fee_taken_at = NULL WHERE id = $1`,
    [id, tracking, fees(500, ret, est)],
  );
}
async function makeDelivered(id: number, total: number, cost: number, tracking: string) {
  await db.query(
    `UPDATE orders SET follow_status = 'delivered', delivered_at = now(), livreur_id = NULL, cashed = false, cashed_at = NULL, handover_id = NULL,
       total = $2, delivery_fee = 550, delivery_cost = $3, tracking = $4, courier_fees = $5, fee_taken_at = NULL WHERE id = $1`,
    [id, total, cost, tracking, fees(cost, 200, 0)],
  );
}
const zrCard = async (admin: Ctx) => ((await call('cash.due', admin, {})) as any).groups.find((g: any) => g.key === `c${zr}`);

test('the ZR card counts its returns (+ weight), swaps and SAV exchanges; « Argent reçu » takes each fee once', async () => {
  const admin = await as(EMAILS.admin);
  const [r1, r2, a, b, d] = await free(5);
  await makeReturn(r1, 200, 100, 'TRK-R1');
  await makeReturn(r2, 150, 0, 'TRK-R2');
  await makeDelivered(d, 3000, 600, 'TRK-D');
  // a parcel the Suivi gave to another customer: its swap fee is on it
  await db.query(`UPDATE orders SET follow_status = 'cancelled', sub_status = 'annule_swappe', tracking = NULL, livreur_id = NULL, fee_taken_at = NULL WHERE id = $1`, [a]);
  await db.query(`INSERT INTO order_events (order_id, kind, from_value, to_value, data) VALUES ($1, 'follow_status', 'out_for_delivery', 'cancelled', $2)`, [a, JSON.stringify({ swap_to: b, tracking: 'TRK-A', swap_fee: 100 })]);
  // a free SAV exchange sent with ZR: nothing collected, ZR's price 350 + its weight fee 50
  const t = Number((await db.query('SELECT id FROM orders WHERE is_exchange ORDER BY id LIMIT 1'))[0].id);
  await db.query(
    `UPDATE orders SET company_id = $2, livreur_id = NULL, follow_status = 'delivered', delivered_at = now(), cashed = false, cashed_at = NULL, handover_id = NULL,
       total = 0, delivery_cost = 400, courier_fees = $3 WHERE id = $1`,
    [t, zr, JSON.stringify({ delivery: 350, ret: 150, kg: 6, weight: 50, est: 50, estRet: 50, at: new Date().toISOString(), src: 'pay' })],
  );

  const g = await zrCard(admin);
  assert.ok(g, 'ZR has a card');
  assert.deepEqual([g.extra.returns.n, g.extra.returns.fee, g.extra.returns.weight], [2, 350, 100]);
  assert.deepEqual(g.extra.returns.ids.sort(), [r1, r2].sort());
  assert.deepEqual([g.extra.swaps.n, g.extra.swaps.fee, g.extra.swaps.ids], [1, 100, [a]]);
  assert.ok(g.extra.exchanges.ids.includes(t));
  const sumOrders = g.orders.reduce((s: number, o: any) => s + o.net, 0);
  const x = g.extra;
  assert.equal(g.net, sumOrders + x.exchanges.collected - x.exchanges.price - x.exchanges.weight - 350 - 100 - 100);
  const od = g.orders.find((o: any) => o.id === d);
  assert.deepEqual([od.total, od.deliveryCost, od.clientDelivery, od.net], [3000, 600, 550, 2400]);
  // its SAV parcels are on its card, not with the tickets of our own livreurs
  const due: any = await call('cash.due', admin, {});
  assert.ok(!due.tickets.groups.some((tg: any) => tg.orders.some((o: any) => o.id === t)));

  const feeIds = [...x.returns.ids, ...x.swaps.ids];
  const r: any = await call('cash.receive', admin, { ids: [d, ...x.exchanges.ids], fees: feeIds });
  const hs = await db.query('SELECT * FROM cash_handovers WHERE id = ANY($1)', [r.handovers]);
  const sales = hs.find((h: any) => (h.orders ?? []).map(Number).includes(d));
  assert.equal(Number(sales.collected), 3000);
  assert.equal(Number(sales.fees), 600 + 350 + 100 + 100);
  assert.equal(Number(sales.net), 3000 - 1150);
  assert.match(sales.note, /2 retours et 1 swap : 550 DA/);
  const ticketH = hs.find((h: any) => (h.orders ?? []).map(Number).includes(t));
  assert.equal(Number(ticketH.net), -400);
  const taken = await db.query('SELECT id, fee_taken, fee_handover_id FROM orders WHERE id = ANY($1) ORDER BY id', [feeIds]);
  assert.deepEqual(
    taken.map((o: any) => [Number(o.id), Number(o.fee_taken), Number(o.fee_handover_id)]),
    [
      [r1, 300, Number(sales.id)],
      [r2, 150, Number(sales.id)],
      [a, 100, Number(sales.id)],
    ].sort((p, q) => p[0] - q[0]),
  );
  const g2 = await zrCard(admin);
  assert.deepEqual([g2?.extra.returns.n ?? 0, g2?.extra.swaps.n ?? 0], [0, 0]);
  assert.ok(!(g2?.extra.exchanges.ids ?? []).includes(t));

  // never twice
  const [d2] = await free(1);
  await makeDelivered(d2, 2000, 500, 'TRK-D2');
  await assert.rejects(call('cash.receive', admin, { ids: [d2], fees: [r1] }), /déjà sortis/);
  // only returns and swaps: a parcel still on the road has no fee to take
  await assert.rejects(call('cash.receive', admin, { ids: [d2], fees: [b] }), /ni un retour ni un swap/);

  // cancelling the versement puts the fees back to take
  await call('cash.cancel', admin, { handoverId: Number(sales.id) });
  const g3 = await zrCard(admin);
  assert.deepEqual([g3.extra.returns.n, g3.extra.swaps.n], [2, 1]);
  const back = await db.query('SELECT fee_taken_at FROM orders WHERE id = ANY($1)', [feeIds]);
  assert.ok(back.every((o: any) => o.fee_taken_at === null));
  // leave the next test a clean card
  await db.query('UPDATE orders SET fee_taken_at = now() WHERE id = ANY($1)', [feeIds]);
});

test('a ZR payment takes the fees it holds, and gives back the ones taken by hand: never twice', async () => {
  await db.query(`UPDATE delivery_companies SET credentials = '{"api_key":"k","tenant":"t"}', active = true WHERE id = $1`, [zr]);
  const [r3, r4, d3, d4] = await free(4);
  await makeReturn(r3, 250, 0, 'TRK-R3');
  await makeReturn(r4, 200, 0, 'TRK-R4');
  await makeDelivered(d3, 3000, 500, 'TRK-D3');
  await makeDelivered(d4, 4500, 500, 'TRK-D4');
  const admin0 = await as(EMAILS.admin);
  // R3's fee comes out by hand with D3's money: 3000 − 500 − 250
  const byHand: any = await call('cash.receive', admin0, { ids: [d3], fees: [r3] });
  assert.equal(Number((await db.query('SELECT net FROM cash_handovers WHERE id = $1', [byHand.handovers[0]]))[0].net), 2250);

  // then ZR pays D4 (4000 after its fee) and takes both returns: 4000 − 250 − 200
  const lines = [
    { tracking: 'TRK-D4', customer: 'X', type: 'Livré', amount: 4000, costs: 0, comment: null },
    { tracking: 'TRK-R3', customer: 'Y', type: 'Retour', amount: -250, costs: 0, comment: null },
    { tracking: 'TRK-R4', customer: 'Z', type: 'Retour', amount: -200, costs: 0, comment: null },
  ];
  const server = {
    courier: async (action: string) => {
      if (action === 'track') return [];
      if (action === 'payBalance') return { paid: 0, ready: 0, delivered: 0, notReady: 0 };
      if (action === 'payRequests') return [];
      if (action === 'payments') return [{ extId: 'PF1', ref: 'PAY-F1', amount: 3550, status: 'Accepted', done: true, at: new Date().toISOString(), doneAt: new Date().toISOString(), requestId: null, place: 'Hub', details: {} }];
      if (action === 'payLines') return lines;
      throw new Error('unexpected ' + action);
    },
  } as any;
  const admin = await as(EMAILS.admin, server);
  const main0 = ((await call('caisse.view', admin, { caisse: 'main' })) as any).balance as number;
  const s: any = await call('caisse.paySync', admin, { companyId: zr });
  assert.equal(s.imported, 1);
  // R3's 250 is already out of the caisse (by hand): the payment gives it back — 3550 + 250
  const main1 = ((await call('caisse.view', admin, { caisse: 'main' })) as any).balance as number;
  assert.equal(main1 - main0, 3800);
  const [o3, o4] = await db.query('SELECT id, fee_taken, fee_payment_id, fee_taken_at FROM orders WHERE id = ANY($1) ORDER BY array_position($1, id)', [[r3, r4]]);
  assert.equal(Number(o3.fee_taken), 250);
  assert.equal(o3.fee_payment_id, null, 'R3 stays taken by hand');
  assert.ok(o4.fee_taken_at && o4.fee_payment_id, 'R4 taken by the payment');
  assert.equal(o4.fee_taken, null);
  // all in all the caisse holds what ZR paid for D3 + D4 minus both fees, once
  assert.equal(2250 + 3800, 3000 - 500 + 4000 - 250 - 200);
  const g = await zrCard(admin);
  assert.ok(!(g?.extra.returns.ids ?? []).some((id: number) => id === r3 || id === r4));
});
