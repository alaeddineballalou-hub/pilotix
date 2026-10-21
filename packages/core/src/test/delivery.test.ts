// Delivery + cash rules: sending (demo simulation), credentials never returned, cash receive, livreur scope, chat.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { fillJson } from '../couriers/custom';
import { resolveStatus } from '../couriers/load';
import { ADAPTERS } from '../couriers/adapters';
import { bestMatch } from '../couriers/util';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(400));
});

const companyId = async (kind: string) => Number((await db.query('SELECT id FROM delivery_companies WHERE kind = $1 ORDER BY id LIMIT 1', [kind]))[0].id);

test('delivery.send in demo mode gives a tracking number and keeps the follow status', async () => {
  const admin = await as(EMAILS.admin);
  const yal = await companyId('yalidine');
  const o = (await db.query(`SELECT id, follow_status FROM orders WHERE conf_status='confirmed' AND follow_status='prepared' AND tracking IS NULL LIMIT 1`))[0];
  await db.query('UPDATE orders SET company_id=$2 WHERE id=$1', [o.id, yal]);
  const r: any = await call('delivery.send', admin, { ids: [Number(o.id)] });
  assert.equal(r.sent, 1, JSON.stringify(r));
  assert.match(r.results[0].tracking, /^YAL-\d{6}$/);
  const after = (await db.query('SELECT tracking, follow_status, ext_status FROM orders WHERE id=$1', [o.id]))[0];
  assert.equal(after.tracking, r.results[0].tracking);
  assert.equal(after.follow_status, 'prepared');
  assert.ok(after.ext_status);
  // sending twice is refused per order
  const again: any = await call('delivery.send', admin, { ids: [Number(o.id)] });
  assert.equal(again.sent, 0);
});

test('delivery.send uses the server courier hook when present', async () => {
  const calls: unknown[] = [];
  const server = { courier: async (action: string, args: any) => (calls.push([action, args]), args.ids.map((id: number) => ({ id, ok: true, tracking: 'SRV-1', extId: 'x', labelUrl: null }))), meta: async () => null, hashPassword: async (s: string) => s };
  const depot = await as(EMAILS.depot, server as any);
  const zr = await companyId('zr');
  const o = (await db.query(`SELECT id FROM orders WHERE conf_status='confirmed' AND follow_status='to_prepare' AND tracking IS NULL LIMIT 1`))[0];
  const r: any = await call('delivery.send', depot, { ids: [Number(o.id)], companyId: zr });
  assert.equal(r.sent, 1);
  assert.equal((calls[0] as any)[0], 'send');
  assert.equal((await db.query('SELECT tracking, company_id FROM orders WHERE id=$1', [o.id]))[0].tracking, 'SRV-1');
});

test('credentials are write-only: never returned, hasKeys says if they are set', async () => {
  const admin = await as(EMAILS.admin);
  const c: any = await call('delivery.saveCompany', admin, { name: 'DHD test', kind: 'ecotrack', settings: { base_url: 'https://dhd.ecotrack.dz' }, secret: { token: 'SECRET-123' } });
  assert.equal(c.hasKeys, true);
  assert.deepEqual(c.keysSet, ['token']);
  const list: any[] = (await call('delivery.companies', admin, {})) as any[];
  const json = JSON.stringify(list);
  assert.ok(!json.includes('SECRET-123'));
  assert.ok(list.every((x) => !('credentials' in x) && !('secret' in x)));
  // saving again without keys keeps them
  const again: any = await call('delivery.saveCompany', admin, { id: c.id, name: 'DHD', kind: 'ecotrack', settings: { base_url: 'https://dhd.ecotrack.dz' }, secret: { token: '' } });
  assert.equal(again.hasKeys, true);
  const raw = (await db.query('SELECT credentials FROM delivery_companies WHERE id=$1', [c.id]))[0].credentials;
  assert.equal((typeof raw === 'string' ? JSON.parse(raw) : raw).token, 'SECRET-123');
  // only admins manage companies
  await assert.rejects(call('delivery.saveCompany', await as(EMAILS.suivi), { name: 'x', kind: 'manual' }), /Accès refusé/);
});

test('delivery.sync advances parcels on the road (demo)', async () => {
  const suivi = await as(EMAILS.suivi);
  const before = (await db.query(`SELECT count(*)::int n FROM orders WHERE follow_status='delivered'`))[0].n;
  let changed = 0;
  for (let i = 0; i < 3; i++) changed += ((await call('delivery.sync', suivi, {})) as any).changed;
  assert.ok(changed > 0);
  const after = (await db.query(`SELECT count(*)::int n FROM orders WHERE follow_status='delivered'`))[0].n;
  assert.ok(after >= before);
});

test('fees grid and status mapping', async () => {
  const admin = await as(EMAILS.admin);
  const yal = await companyId('yalidine');
  await call('delivery.saveFees', admin, { companyId: yal, rows: [{ wilayaId: 16, home: 350, desk: 250, returnFee: 100 }] });
  const fees: any[] = (await call('delivery.fees', admin, { companyId: yal })) as any[];
  assert.equal(fees.length, 69);
  assert.deepEqual(fees[15], { wilayaId: 16, name: 'Alger', home: 350, desk: 250, returnFee: 100 });
  assert.equal(resolveStatus(ADAPTERS.yalidine.statuses, {}, { status: 'Livré' }), 'delivered');
  assert.equal(resolveStatus(ADAPTERS.yalidine.statuses, { 'Livré': 'returned' }, { status: 'Livré' }), 'returned');
  assert.equal(resolveStatus(ADAPTERS.ecotrack.statuses, {}, { key: 'en_livraison', status: 'En livraison · client absent' }), 'out_for_delivery');
  assert.equal(bestMatch('Bab Ezzouar', ['BAB-EZZOUAR', 'Bordj El Kiffan']), 'BAB-EZZOUAR');
  assert.equal(fillJson('{"a":"{{ref}}","n":{{total}}}', { ref: 'PX"1', total: 5 }), '{"a":"PX\\"1","n":5}');
});

test('cash.receive creates a versement and marks the orders cashed; cancel puts them back', async () => {
  const admin = await as(EMAILS.admin);
  const due: any = await call('cash.due', admin, {});
  const g = due.groups.find((x: any) => !x.livreurId && x.count >= 2);
  const oids = g.orders.slice(0, 2).map((o: any) => o.id);
  const r: any = await call('cash.receive', admin, { ids: oids });
  assert.equal(r.handovers.length, 1);
  const rows = await db.query('SELECT cashed, handover_id FROM orders WHERE id = ANY($1)', [oids]);
  assert.ok(rows.every((x: any) => x.cashed && Number(x.handover_id) === r.handovers[0]));
  const h = (await db.query('SELECT collected, fees, net FROM cash_handovers WHERE id=$1', [r.handovers[0]]))[0];
  assert.equal(Number(h.net), g.orders.slice(0, 2).reduce((s: number, o: any) => s + o.net, 0));
  await assert.rejects(call('cash.receive', admin, { ids: oids }), /déjà encaissée/);
  const hist: any[] = (await call('cash.history', admin, {})) as any[];
  assert.ok(hist.some((x) => x.id === r.handovers[0] && x.orders.length === 2));
  await call('cash.cancel', admin, { handoverId: r.handovers[0] });
  assert.ok((await db.query('SELECT cashed FROM orders WHERE id = ANY($1)', [oids])).every((x: any) => !x.cashed));
  await assert.rejects(call('cash.due', await as(EMAILS.suivi), {}), /Accès refusé/);
});

test('a livreur only sees his own round, cash and chat', async () => {
  const lamine = await as(EMAILS.livreur);
  const me = lamine.session.profile.id;
  const t: any = await call('delivery.tournee', lamine, {});
  assert.ok(t.toDeliver.length > 0);
  assert.ok([...t.toDeliver, ...t.pickup].every((o: any) => o.livreurId === me));
  const walid = Number((await db.query(`SELECT id FROM profiles WHERE email='walid@demo.pilotix.dz'`))[0].id);
  const t2: any = await call('delivery.tournee', lamine, { livreurId: walid });
  assert.equal(t2.livreur.id, me);
  const cash: any = await call('cash.livreurs', lamine, {});
  assert.deepEqual(cash.livreurs.map((l: any) => l.id), [me]);
  await assert.rejects(call('cash.chat', lamine, { livreurId: walid }), /Accès refusé/);
  await call('cash.chatSend', lamine, { body: 'Bonjour le bureau' });
  const suivi = await as(EMAILS.suivi);
  const msgs: any[] = (await call('cash.chat', suivi, { livreurId: me })) as any[];
  assert.ok(msgs.some((m) => m.body === 'Bonjour le bureau' && m.fromLivreur));
  await call('cash.chatSend', suivi, { livreurId: me, body: 'Bien reçu' });
  // livreur marks a parcel delivered with orders.setFollow
  const o = t.toDeliver[0];
  await call('orders.setFollow', lamine, { ids: [o.id], status: 'delivered' });
  const other = (await db.query(`SELECT id FROM orders WHERE livreur_id <> $1 AND follow_status='out_for_delivery' LIMIT 1`, [me]))[0];
  if (other) await assert.rejects(call('orders.setFollow', lamine, { ids: [Number(other.id)], status: 'delivered' }));
  // the office collects Lamine's cash, his share kept
  const admin = await as(EMAILS.admin);
  const r: any = await call('cash.livreurCollect', admin, { livreurId: me, all: true });
  assert.ok(r.orders >= 1);
  const h = (await db.query('SELECT fees, collected, net FROM cash_handovers WHERE id=$1', [r.handovers[0]]))[0];
  assert.ok(Number(h.fees) > 0 && Number(h.net) === Number(h.collected) - Number(h.fees));
});

test('route sheet and preview', async () => {
  const lamine = await as(EMAILS.livreur);
  const s: any = await call('delivery.routeSheet', lamine, {});
  assert.ok(s.orders.length > 0);
  const admin = await as(EMAILS.admin);
  const c: any = await call('delivery.saveCompany', admin, {
    name: 'Ma société API', kind: 'custom', secret: { token: 'abcdef123' },
    settings: { base_url: 'https://api.example.dz', auth: { name: 'Authorization', prefix: 'Bearer ' }, create: { method: 'POST', path: '/orders', format: 'json', body: '{"ref":"{{ref}}","amount":{{total}}}', tracking_path: 'data.tracking' } },
  });
  const p: any = await call('delivery.preview', admin, { companyId: c.id });
  assert.equal(p.request.url, 'https://api.example.dz/orders');
  assert.equal(p.request.headers.Authorization, 'Bearer…');
  assert.equal(typeof p.request.body.amount, 'number');
});
