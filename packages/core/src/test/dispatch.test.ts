// En dispatch: a partner with an API gets the parcel when it is assigned, and its number replaces the Pilotix one
// (labels are printed with it); moving to another company or « Retirer » cancels at the old one; old labels are refused.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(400));
});

const companyId = async (kind: string) => Number((await db.query('SELECT id FROM delivery_companies WHERE kind = $1 ORDER BY id LIMIT 1', [kind]))[0].id);
const row = async (id: number) => (await db.query('SELECT follow_status, tracking, own_tracking, company_id FROM orders WHERE id = $1', [id]))[0];
const toPrepare = async (n: number) =>
  (await db.query(`SELECT id FROM orders WHERE conf_status = 'confirmed' AND follow_status = 'to_prepare' AND tracking IS NULL AND NOT is_exchange ORDER BY id LIMIT $1`, [n])).map((r: any) => Number(r.id));

test('Envoyer au dispatch with a company that has an API: in « En dispatch » with the company’s own number', async () => {
  const depot = await as(EMAILS.depot);
  const yal = await companyId('yalidine');
  const [a, b] = await toPrepare(2);
  const r: any = await call('depot.dispatch', depot, { ids: [a, b], companyId: yal });
  assert.deepEqual([r.moved, r.sent, r.failed.length], [2, 2, 0], JSON.stringify(r));
  for (const id of [a, b]) {
    const o = await row(id);
    assert.equal(o.follow_status, 'prepared');
    assert.equal(Number(o.company_id), yal);
    assert.match(o.tracking, /^yal-[0-9A-Z]{6}$/);
    assert.notEqual(o.tracking, o.own_tracking);
  }
  // sent once: dispatching again sends nothing more and keeps the number
  const before = (await row(a)).tracking;
  const again: any = await call('depot.dispatch', depot, { ids: [a] });
  assert.deepEqual([again.moved, again.sent, again.failed.length], [0, 0, 0]);
  assert.equal((await row(a)).tracking, before);
});

test('own livreurs keep the Pilotix number: nothing is sent', async () => {
  const depot = await as(EMAILS.depot);
  const own = await companyId('own');
  const [a] = await toPrepare(1);
  const r: any = await call('depot.dispatch', depot, { ids: [a], companyId: own });
  assert.deepEqual([r.moved, r.sent, r.failed.length], [1, 0, 0]);
  const o = await row(a);
  assert.equal(o.follow_status, 'prepared');
  assert.equal(o.tracking, null);
});

test('another company in « En dispatch »: cancelled at the old one, sent to the new one with its number', async () => {
  const depot = await as(EMAILS.depot);
  const yal = await companyId('yalidine');
  const zr = await companyId('zr');
  const [a] = await toPrepare(1);
  await call('depot.dispatch', depot, { ids: [a], companyId: yal });
  const yalNo = (await row(a)).tracking;
  const r: any = await call('depot.dispatch', depot, { ids: [a], companyId: zr });
  assert.deepEqual([r.sent, r.failed.length], [1, 0], JSON.stringify(r));
  const o = await row(a);
  assert.equal(Number(o.company_id), zr);
  assert.match(o.tracking, /^ZR-\d{8}$/);
  const ev = await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND note LIKE 'Colis annulé%'`, [a]);
  assert.ok(ev.some((e: any) => e.note.includes(yalNo)));
});

test('a company that refuses: the parcel stays in « En dispatch » without a number, the reason is given', async () => {
  const depot = await as(EMAILS.depot);
  const admin = await as(EMAILS.admin);
  const c: any = await call('delivery.saveCompany', admin, { name: 'Sans clés', kind: 'ecotrack', settings: { base_url: 'https://x.ecotrack.dz' }, secret: {} });
  const [a] = await toPrepare(1);
  const r: any = await call('depot.dispatch', depot, { ids: [a], companyId: c.id });
  assert.equal(r.moved, 1);
  assert.equal(r.sent, 0);
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].error, /Clés API manquantes/);
  const o = await row(a);
  assert.equal(o.follow_status, 'prepared');
  assert.equal(o.tracking, null);
});

test('« Retirer » on a parcel already at the company cancels it there and sends it back to « À préparer »', async () => {
  const depot = await as(EMAILS.depot);
  const yal = await companyId('yalidine');
  const [a] = await toPrepare(1);
  await call('depot.dispatch', depot, { ids: [a], companyId: yal });
  assert.ok((await row(a)).tracking);
  await call('depot.unassign', depot, { id: a });
  const o = await row(a);
  assert.equal(o.follow_status, 'to_prepare');
  assert.equal(o.tracking, null);
  assert.equal(o.company_id, null);
});

test('scanning: the company’s label dispatches; a Pilotix label (reference or Pilotix number) is refused as replaced', async () => {
  const depot = await as(EMAILS.depot);
  const yal = await companyId('yalidine');
  const [a, b] = await toPrepare(2);
  await call('depot.dispatch', depot, { ids: [a, b], companyId: yal });
  const oa = (await db.query('SELECT ref, own_tracking, tracking FROM orders WHERE id = $1', [a]))[0];
  for (const code of [oa.ref, oa.own_tracking]) {
    const r: any = await call('depot.scan', depot, { code, mode: 'dispatch' });
    assert.equal(r.kind, 'bad');
    assert.match(r.why, /Étiquette Pilotix remplacée/);
  }
  const ok: any = await call('depot.scan', depot, { code: oa.tracking, mode: 'dispatch' });
  assert.equal(ok.kind, 'ok', ok.why);
  assert.equal(ok.order.followStatus, 'shipped');
});

test('demo data: parcels on the road with a company that has an API carry that company’s own number', async () => {
  const rows = await db.query(
    `SELECT o.ref, o.tracking, c.kind FROM orders o JOIN delivery_companies c ON c.id = o.company_id
     WHERE o.shipped_at IS NOT NULL AND o.tracking IS NOT NULL AND c.kind IN ('yalidine','zr','noest') AND o.ref NOT LIKE 'PX9%'`,
  );
  assert.ok(rows.length > 10);
  for (const r of rows) {
    assert.notEqual(r.tracking, r.ref);
    assert.match(r.tracking, r.kind === 'yalidine' ? /^yal-/ : r.kind === 'zr' ? /^ZR-/ : /^NOE-/);
  }
});

test('labels: a company with an API gives its own label (link or PDF); none from a courier without labels; a stand-in in the preview', async () => {
  const yal = await companyId('yalidine');
  const noest = await companyId('noest');
  const depot = await as(EMAILS.depot);
  const [a, b, c] = await toPrepare(3);
  await call('depot.dispatch', depot, { ids: [a], companyId: yal });
  await call('depot.dispatch', depot, { ids: [b], companyId: noest });
  // preview (no server): the couriers are simulated, their label is a stand-in
  const demo: any = await call('delivery.labels', depot, { ids: [a, b] });
  assert.deepEqual(demo.map((x: any) => x.label), [{ demo: true }, { demo: true }]);
  // server: the courier answers with a link (stored at sending) or a PDF
  await db.query(`UPDATE orders SET label_url = 'https://yalidine.example/bordereau/1' WHERE id = $1`, [a]);
  const calls: unknown[] = [];
  const server = { courier: async (action: string, args: any) => (calls.push([action, args.item?.tracking]), action === 'label' ? { pdf: 'JVBERi0=', type: 'application/pdf' } : null), meta: async () => null, hashPassword: async (s: string) => s };
  const live = await as(EMAILS.depot, server as any);
  const res: any = await call('delivery.labels', live, { ids: [a, b] });
  assert.deepEqual(res[0].label, { url: 'https://yalidine.example/bordereau/1' });
  assert.deepEqual(res[1].label, { pdf: 'JVBERi0=', type: 'application/pdf' });
  assert.equal(calls.length, 1); // the stored link needs no call
  // a parcel not sent to a company: its reason, the others still come
  const mixed: any = await call('delivery.labels', live, { ids: [c, a] });
  assert.match(mixed[0].error, /Pas encore envoyée/);
  assert.ok(mixed[1].label.url);
  // Procolis (ZR, old platform) gives no label: none, so Pilotix prints its own
  const admin = await as(EMAILS.admin);
  const pro: any = await call('delivery.saveCompany', admin, { name: 'ZR Procolis', kind: 'zr_legacy', settings: {}, secret: {} });
  await db.query(`UPDATE orders SET company_id = $2, tracking = ref, label_url = NULL WHERE id = $1`, [c, pro.id]);
  const none: any = await call('delivery.labels', live, { ids: [c] });
  assert.equal(none[0].label, null);
  assert.equal(none[0].error, undefined);
});
