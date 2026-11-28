// ZR payments: each payment the company made is imported (its parcels marked « argent reçu », the versement's net = ZR's
// amount) into a caisse — once. The payment is asked by hand (« Demander le paiement »); by itself only from the 30-minute
// sync when the shop switched it on, never from « Actualiser » (↻), and never for a day ZR refuses (the owner, 28 Nov 2026).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { firstPayDay, payRunAll } from '../modules/courierpay';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(250));
});

const bal = async (ctx: Ctx, caisse: string) => ((await call('caisse.view', ctx, { caisse })) as any).balance as number;

test('ZR pays the next day when asked before 14:00 (Algiers), the day after from 14:00', () => {
  assert.deepEqual(firstPayDay(Date.parse('2026-11-27T12:59:00Z')), { date: '2026-11-28', days: 1 }); // 13:59
  assert.deepEqual(firstPayDay(Date.parse('2026-11-27T13:00:00Z')), { date: '2026-11-29', days: 2 }); // 14:00
  assert.deepEqual(firstPayDay(Date.parse('2026-11-27T22:30:00Z')), { date: '2026-11-29', days: 2 }); // 23:30
  assert.deepEqual(firstPayDay(Date.parse('2026-11-27T23:30:00Z')), { date: '2026-11-29', days: 1 }); // 00:30, the 28th
});

test('↻ imports a paid statement into the caisse, once, and never asks; the 30-minute sync asks only when switched on', async () => {
  const zr = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'zr' LIMIT 1`))[0].id);
  await db.query(`UPDATE delivery_companies SET credentials = '{"api_key":"k","tenant":"t"}', active = true WHERE id = $1`, [zr]);
  const del = await db.query(`SELECT id, tracking FROM orders WHERE company_id = $1 AND follow_status = 'delivered' AND NOT cashed AND tracking IS NOT NULL ORDER BY id LIMIT 2`, [zr]);
  const road = (await db.query(`SELECT id, tracking FROM orders WHERE company_id = $1 AND follow_status = 'out_for_delivery' AND tracking IS NOT NULL LIMIT 1`, [zr]))[0];
  assert.equal(del.length, 2);
  const tracks = [...del, ...(road ? [road] : [])].map((o: any) => o.tracking);
  const reqs: any[] = [];
  const calls: string[] = [];
  const asked: string[] = [];
  const server = {
    courier: async (action: string, args: any) => {
      calls.push(action);
      if (action === 'track') return [];
      if (action === 'payBalance') return { paid: 0, ready: 9000, delivered: 20000, notReady: 1000 };
      if (action === 'payRequests') return reqs;
      if (action === 'payRequest') {
        asked.push(args.date);
        reqs.push({ extId: 'R1', date: args.date, approved: null, comment: null, at: new Date().toISOString() });
        return { extId: 'R1' };
      }
      if (action === 'payments') return [{ extId: 'P1', ref: 'PAY-1', amount: 12_345, status: 'Accepted', done: true, at: new Date().toISOString(), doneAt: new Date().toISOString(), requestId: null, place: 'Hub Alger', details: { parcelsDelivered: tracks.length, labeling: 150 } }];
      if (action === 'payLines') return tracks.map((t: string) => ({ tracking: t, customer: 'X', type: 'Livré', amount: 4000, costs: 0, comment: null }));
      throw new Error('unexpected ' + action);
    },
  } as any;
  const admin = await as(EMAILS.admin, server);
  const m0 = await bal(admin, 'main');
  // ↻ (« Actualiser »): ZR read again and its payment imported, but no payment asked, though money is ready
  const r: any = await call('caisse.paySync', admin, { companyId: zr });
  assert.equal(r.imported, 1);
  assert.equal(r.requested, false);
  assert.deepEqual(asked, []);
  assert.equal(await bal(admin, 'main'), m0 + 12_345);
  const cashed = await db.query('SELECT id, follow_status, cashed FROM orders WHERE tracking = ANY($1)', [tracks]);
  assert.ok(cashed.every((o: any) => o.cashed && o.follow_status === 'delivered'));
  const v: any = await call('caisse.pay', admin, { companyId: zr });
  assert.equal(v.payments[0].inCaisse, true);
  assert.equal(v.payments[0].matched, tracks.length);
  assert.equal(v.cfg.auto, false, 'the automatic request starts off');
  assert.equal(v.requests.length, 0);
  assert.equal(v.firstDay, firstPayDay(Date.now()).date);
  // the 30-minute sync, switched off: no request either
  await payRunAll(admin);
  assert.deepEqual(asked, []);
  // an old setting « auto: true » no longer counts: only the new switch does
  await db.query(`UPDATE delivery_companies SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{pay}', '{"auto": true, "into": "main"}'::jsonb) WHERE id = $1`, [zr]);
  await payRunAll(admin);
  assert.deepEqual(asked, []);
  // switched on: the 30-minute sync asks, for ZR's first day (tomorrow before 14:00, the day after from 14:00)
  await call('caisse.payConfig', admin, { companyId: zr, auto: true, into: 'main' });
  assert.ok(((await payRunAll(admin)) as any[]).some((x) => x.requested));
  assert.deepEqual(asked, [firstPayDay(Date.now()).date]);
  const v1: any = await call('caisse.pay', admin, { companyId: zr });
  assert.equal(v1.cfg.auto, true);
  assert.equal(v1.requests[0].auto, true);
  // a day ZR refuses is refused here first
  const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  await assert.rejects(call('caisse.payRequestDate', admin, { id: v1.requests[0].id, date: today }), /Trop tôt pour ZR/);
  // again: nothing imported twice, no second request while one waits; ↻ still never asks
  const r2: any = await call('caisse.paySync', admin, { companyId: zr });
  assert.equal(r2.imported, 0);
  assert.equal(r2.requested, false);
  assert.ok(!((await payRunAll(admin)) as any[]).some((x) => x.requested));
  assert.equal(asked.length, 1);
  assert.equal(await bal(admin, 'main'), m0 + 12_345);
  const lines: any = await call('caisse.payLines', admin, { id: v.payments[0].id });
  assert.ok(lines.every((l: any) => l.ref));
});

test('in the preview a ZR payment waits at the office; « Reçu » puts it in the chosen caisse', async () => {
  const admin = await as(EMAILS.admin);
  const zr = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'zr' LIMIT 1`))[0].id);
  await db.query('DELETE FROM courier_balances WHERE company_id = $1', [zr]);
  const v: any = await call('caisse.pay', admin, { companyId: zr });
  assert.equal(v.supported, true);
  const wait = v.payments.find((p: any) => !p.done);
  assert.ok(wait, 'a payment waits');
  const karim = (await db.query(`SELECT id FROM profiles WHERE email = $1`, [EMAILS.depot]))[0];
  const k0 = await bal(admin, `u${karim.id}`);
  await call('caisse.payReceive', admin, { id: wait.id, into: `u${karim.id}` });
  assert.equal(await bal(admin, `u${karim.id}`), k0 + wait.amount);
  await assert.rejects(call('caisse.payReceive', admin, { id: wait.id }), /déjà/);
  // « Demander le paiement » for a day ZR refuses: asked for its first day instead
  await db.query('DELETE FROM courier_pay_requests WHERE company_id = $1', [zr]);
  const asked: any = await call('caisse.payRequest', admin, { companyId: zr, date: '2020-01-01' });
  assert.equal(asked.date, firstPayDay(Date.now()).date);
  await call('caisse.payConfig', admin, { companyId: zr, auto: false, into: 'bank' });
  const v2: any = await call('caisse.pay', admin, { companyId: zr });
  assert.deepEqual(v2.cfg, { auto: false, into: 'bank' });
});
