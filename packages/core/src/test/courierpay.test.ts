// ZR payments: Pilotix asks for the payment when money is ready, imports each payment the company made (its parcels
// marked « argent reçu », the versement's net = ZR's amount) into a caisse — once.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(250));
});

const bal = async (ctx: Ctx, caisse: string) => ((await call('caisse.view', ctx, { caisse })) as any).balance as number;

test('the sync asks ZR for the payment and imports a paid statement into the caisse, once', async () => {
  const zr = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'zr' LIMIT 1`))[0].id);
  await db.query(`UPDATE delivery_companies SET credentials = '{"api_key":"k","tenant":"t"}', active = true WHERE id = $1`, [zr]);
  const del = await db.query(`SELECT id, tracking FROM orders WHERE company_id = $1 AND follow_status = 'delivered' AND NOT cashed AND tracking IS NOT NULL ORDER BY id LIMIT 2`, [zr]);
  const road = (await db.query(`SELECT id, tracking FROM orders WHERE company_id = $1 AND follow_status = 'out_for_delivery' AND tracking IS NOT NULL LIMIT 1`, [zr]))[0];
  assert.equal(del.length, 2);
  const tracks = [...del, ...(road ? [road] : [])].map((o: any) => o.tracking);
  const reqs: any[] = [];
  const calls: string[] = [];
  const server = {
    courier: async (action: string, args: any) => {
      calls.push(action);
      if (action === 'track') return [];
      if (action === 'payBalance') return { paid: 0, ready: 9000, delivered: 20000, notReady: 1000 };
      if (action === 'payRequests') return reqs;
      if (action === 'payRequest') {
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
  const r: any = await call('caisse.paySync', admin, { companyId: zr });
  assert.equal(r.imported, 1);
  assert.equal(r.requested, true);
  assert.equal(await bal(admin, 'main'), m0 + 12_345);
  const cashed = await db.query('SELECT id, follow_status, cashed FROM orders WHERE tracking = ANY($1)', [tracks]);
  assert.ok(cashed.every((o: any) => o.cashed && o.follow_status === 'delivered'));
  const v: any = await call('caisse.pay', admin, { companyId: zr });
  assert.equal(v.payments[0].inCaisse, true);
  assert.equal(v.payments[0].matched, tracks.length);
  assert.equal(v.requests[0].auto, true);
  // again: nothing imported twice, no second request while one waits
  const r2: any = await call('caisse.paySync', admin, { companyId: zr });
  assert.equal(r2.imported, 0);
  assert.equal(r2.requested, false);
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
  await call('caisse.payConfig', admin, { companyId: zr, auto: false, into: 'bank' });
  const v2: any = await call('caisse.pay', admin, { companyId: zr });
  assert.deepEqual(v2.cfg, { auto: false, into: 'bank' });
});
