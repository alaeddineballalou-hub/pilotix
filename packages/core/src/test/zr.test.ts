// ZR Express services from Pilotix: pickup bags, modification requests, exchanges, the parcel's journey, webhook.
// The preview simulates ZR; with a server, every call goes through ctx.server.courier (faked here).
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
const toPrepare = async (n: number) =>
  (await db.query(`SELECT id FROM orders WHERE conf_status = 'confirmed' AND follow_status = 'to_prepare' AND tracking IS NULL AND NOT is_exchange ORDER BY id DESC LIMIT $1`, [n])).map((r: any) => Number(r.id));
/** Sends parcels to ZR and hands them over (Dispatchées), as the depot does. */
async function handedToZr(n: number) {
  const depot = await as(EMAILS.depot);
  const ids = await toPrepare(n);
  await call('depot.dispatch', depot, { ids, companyId: await companyId('zr') });
  await db.query(`UPDATE orders SET follow_status = 'shipped', shipped_at = now(), ext_status_at = now() - interval '5 minutes' WHERE id = ANY($1)`, [ids]);
  return ids;
}
type Calls = [string, any][];
const fakeServer = (answer: (action: string, args: any) => unknown, calls: Calls) => ({
  courier: async (action: string, args: any) => {
    calls.push([action, args]);
    return answer(action, args);
  },
  meta: async () => null,
  hashPassword: async (s: string) => s,
  publicUrl: 'https://pilotix.example',
});

test('pickup bags (preview): a bag for the parcels handed over, its label, take one out, delete it', async () => {
  const zr = await companyId('zr');
  const ids = await handedToZr(3);
  const depot = await as(EMAILS.depot);
  const before: any = await call('pickup.overview', depot, {});
  const z = before.find((c: any) => c.companyId === zr);
  assert.ok(z.waiting >= 3);
  const waiting: any = await call('pickup.waiting', depot, { companyId: zr });
  assert.ok(ids.every((x) => waiting.some((w: any) => w.id === x)));
  const made: any = await call('pickup.create', depot, { companyId: zr, ids });
  assert.equal(made.added, 3);
  assert.match(made.bag.tracking, /^SAC-\d{6}$/);
  assert.equal(made.bag.parcels, 3);
  // already in a bag: not waiting any more, and refused in another bag
  const after: any = await call('pickup.overview', depot, {});
  assert.equal(after.find((c: any) => c.companyId === zr).waiting, z.waiting - 3);
  await assert.rejects(call('pickup.create', depot, { companyId: zr, ids: [ids[0]] }), /ne peuvent pas aller dans un sac/);
  assert.deepEqual(await call('pickup.label', depot, { bagId: made.bag.id }), { demo: true });
  const inBag: any = await call('pickup.parcels', depot, { bagId: made.bag.id });
  assert.deepEqual(inBag.parcels.map((p: any) => p.id).sort(), [...ids].sort());
  await call('pickup.remove', depot, { bagId: made.bag.id, orderId: ids[0] });
  assert.equal(((await call('pickup.parcels', depot, { bagId: made.bag.id })) as any).parcels.length, 2);
  // the order's history says it
  const ev = await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND note LIKE '%sac de ramassage%' ORDER BY id`, [ids[0]]);
  assert.equal(ev.length, 2);
  await call('pickup.drop', depot, { bagId: made.bag.id });
  await assert.rejects(call('pickup.parcels', depot, { bagId: made.bag.id }), /Sac introuvable/);
  assert.equal(((await call('pickup.waiting', depot, { companyId: zr })) as any).filter((w: any) => ids.includes(w.id)).length, 3);
});

test('pickup bags (server): ZR makes the bag, refuses a parcel, then says how far it is', async () => {
  const zr = await companyId('zr');
  const ids = await handedToZr(3);
  const tr = new Map((await db.query('SELECT id, tracking FROM orders WHERE id = ANY($1)', [ids])).map((r: any) => [Number(r.id), String(r.tracking)]));
  const calls: Calls = [];
  const server = fakeServer((action, args) => {
    if (action === 'bagCreate') return { extId: 'bag-uuid-1', tracking: 'PB-0001', added: args.items.slice(0, 2).map((i: any) => i.tracking), failed: [{ tracking: args.items[2].tracking, error: 'Colis déjà ramassé' }] };
    if (action === 'bags') return [{ extId: 'bag-uuid-1', tracking: 'PB-0001', state: 'Traité', parcels: 2, unprocessed: 0, at: null }];
    if (action === 'bagLabel') return { url: 'https://zr.example/bags/PB-0001.pdf' };
    return null;
  }, calls);
  const live = await as(EMAILS.depot, server as any);
  const made: any = await call('pickup.create', live, { companyId: zr, ids });
  assert.equal(calls[0][0], 'bagCreate');
  assert.deepEqual(calls[0][1].items.map((i: any) => i.tracking).sort(), ids.map((x) => tr.get(x)).sort());
  assert.equal(made.added, 2);
  assert.equal(made.bag.tracking, 'PB-0001');
  assert.equal(made.failed.length, 1);
  assert.equal(made.failed[0].error, 'Colis déjà ramassé');
  assert.deepEqual(await call('pickup.label', live, { bagId: made.bag.id }), { url: 'https://zr.example/bags/PB-0001.pdf' });
  assert.deepEqual(calls.at(-1), ['bagLabel', { companyId: zr, bag: 'PB-0001' }]);
  await call('pickup.sync', live, { companyId: zr });
  const bag = ((await call('pickup.parcels', live, { bagId: made.bag.id })) as any).bag;
  assert.equal(bag.unprocessed, 0);
  assert.equal(bag.state, 'Traité');
  // processed: it can no longer be deleted
  await assert.rejects(call('pickup.drop', live, { bagId: made.bag.id }), /déjà traité/);
});

/** An SAV exchange waiting to leave, whose original parcel ZR delivered. */
async function exchangeAtZr(ext: string | null) {
  const zr = await companyId('zr');
  const x = (await db.query(`SELECT id, original_order_id FROM orders WHERE is_exchange AND original_order_id IS NOT NULL AND tracking IS NULL AND conf_status = 'confirmed' AND follow_status IN ('to_prepare','prepared') ORDER BY id LIMIT 1`))[0];
  assert.ok(x, 'an exchange to send');
  await db.query(`UPDATE orders SET company_id = $2, tracking = 'ZR-ORIG-0001', ext_id = $3, follow_status = 'delivered' WHERE id = $1`, [x.original_order_id, zr, ext]);
  await db.query(`UPDATE orders SET follow_status = 'prepared', company_id = $2 WHERE id = $1`, [x.id, zr]);
  return { id: Number(x.id), orig: Number(x.original_order_id), zr };
}

test('exchange (server): sent to ZR as its own exchange; the return parcel’s number brings the old product back', async () => {
  const { id: xid, orig, zr } = await exchangeAtZr('uuid-orig');
  const calls: Calls = [];
  const server = fakeServer((action) => (action === 'exchange' ? { tracking: 'ZR-NEW-0001', extId: 'uuid-new', labelUrl: null, returnTracking: 'ZR-RET-0001', returnExtId: 'uuid-ret' } : null), calls);
  const live = await as(EMAILS.depot, server as any);
  const r: any = await call('delivery.send', live, { ids: [xid] });
  assert.equal(r.sent, 1);
  assert.deepEqual(calls[0], ['exchange', { companyId: zr, orderId: xid, item: { id: orig, tracking: 'ZR-ORIG-0001', extId: 'uuid-orig' } }]);
  const o = (await db.query('SELECT tracking, ext_id FROM orders WHERE id = $1', [xid]))[0];
  assert.deepEqual([o.tracking, o.ext_id], ['ZR-NEW-0001', 'uuid-new']);
  assert.equal((await db.query('SELECT tracking FROM parcel_returns WHERE order_id = $1', [xid]))[0].tracking, 'ZR-RET-0001');
  // the depot: the return label is not the parcel to send; scanning it back finds the exchange
  const depot = await as(EMAILS.depot);
  const d: any = await call('depot.scan', depot, { code: 'ZR-RET-0001', mode: 'dispatch' });
  assert.equal(d.kind, 'bad');
  assert.match(d.why, /retour de l’échange/);
  const found: any = await call('depot.find', depot, { code: 'zr-ret-0001' });
  assert.equal(found[0].id, xid);
  // cancelled at ZR: the return number goes too
  await db.query(`UPDATE orders SET follow_status = 'prepared' WHERE id = $1`, [xid]);
  await call('delivery.cancel', live, { orderId: xid });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM parcel_returns WHERE order_id = $1', [xid]))[0].n, 0);
});

test('exchange (preview): a ZR exchange gets its new number and a return number', async () => {
  const { id: xid } = await exchangeAtZr(null);
  const r: any = await call('delivery.send', await as(EMAILS.depot), { ids: [xid] });
  assert.equal(r.sent, 1);
  const t = (await db.query('SELECT o.tracking, r.tracking AS back FROM orders o JOIN parcel_returns r ON r.order_id = o.id WHERE o.id = $1', [xid]))[0];
  assert.match(t.tracking, /^ZR-\d{8}$/);
  assert.match(t.back, /^ZR-\d{8}$/);
  assert.notEqual(t.tracking, t.back);
});

test('exchange at ZR: its two parcels — the new product out, the old one back once it is delivered (preview, server)', async () => {
  const r = (await db.query(`SELECT r.order_id, r.tracking, o.tracking AS out FROM parcel_returns r JOIN orders o ON o.id = r.order_id JOIN delivery_companies c ON c.id = o.company_id WHERE c.kind = 'zr' ORDER BY r.order_id LIMIT 1`))[0];
  assert.ok(r, 'an exchange at ZR');
  const xid = Number(r.order_id);
  await db.query(`UPDATE orders SET follow_status = 'out_for_delivery' WHERE id = $1`, [xid]);
  const suivi = await as(EMAILS.suivi);
  const p: any = await call('parcel.info', suivi, { orderId: xid });
  assert.equal(p.returnTracking, r.tracking);
  assert.deepEqual([p.returnInfo.state, p.returnInfo.waiting], ['En attente', true]);
  await db.query(`UPDATE orders SET follow_status = 'exchanged' WHERE id = $1`, [xid]);
  assert.equal(((await call('parcel.info', suivi, { orderId: xid })) as any).returnInfo.waiting, false);
  // server: ZR is asked about both parcels
  const calls: Calls = [];
  const server = fakeServer((action, args) => (action === 'parcel' ? { state: args.item.tracking === r.tracking ? 'Vers vendeur' : 'Livré', color: null, situation: null, history: [], sms: [], swap: null } : null), calls);
  const live: any = await call('parcel.info', await as(EMAILS.suivi, server as any), { orderId: xid });
  assert.deepEqual(calls.map(([a, x]) => `${a}:${x.item.tracking}`).sort(), [`parcel:${r.tracking}`, `parcel:${r.out}`].sort());
  assert.equal(live.returnInfo.state, 'Vers vendeur');
  assert.equal(live.info.state, 'Livré');
});

/** A ZR parcel on the road (sent, with its number), at home delivery. */
async function zrOnRoad() {
  const zr = await companyId('zr');
  const r = (await db.query(`SELECT id FROM orders WHERE company_id = $1 AND follow_status = 'out_for_delivery' AND tracking IS NOT NULL AND NOT is_stopdesk AND NOT is_exchange ORDER BY id LIMIT 1`, [zr]))[0];
  if (r) return { id: Number(r.id), zr };
  const [oid] = await handedToZr(1);
  await db.query(`UPDATE orders SET follow_status = 'out_for_delivery', is_stopdesk = false, stopdesk_id = NULL WHERE id = $1`, [oid]);
  return { id: oid, zr };
}
const order = async (oid: number) => (await db.query('SELECT total, discount, delivery_fee, subtotal, phone, is_stopdesk, stopdesk_id, wilaya_id, commune FROM orders WHERE id = $1', [oid]))[0];

test('parcel at ZR (preview): its journey, livreur and return risk; a price change waits for ZR, then is applied', async () => {
  const { id: oid } = await zrOnRoad();
  const suivi = await as(EMAILS.suivi);
  const p: any = await call('parcel.info', suivi, { orderId: oid });
  assert.equal(p.supported, true);
  assert.ok(p.info.livreur?.name);
  assert.ok(p.info.risk && p.info.risk.orders >= 1);
  assert.equal(p.info.canModify, true);
  const before = await order(oid);
  const ch: any = await call('parcel.change', suivi, { orderId: oid, kind: 'amount', amount: Number(before.total) - 500, note: 'remise accordée' });
  assert.equal(ch.status, 'pending');
  await assert.rejects(call('parcel.change', suivi, { orderId: oid, kind: 'amount', amount: 100 }), /attend déjà/);
  // ZR answers (the preview accepts after half a minute)
  await db.query(`UPDATE parcel_changes SET created_at = now() - interval '1 minute' WHERE id = $1`, [ch.id]);
  await call('parcel.changeSync', suivi, { orderId: oid });
  const after = await order(oid);
  assert.equal(Number(after.total), Number(before.total) - 500);
  assert.equal(Number(after.subtotal) + Number(after.delivery_fee) - Number(after.discount), Number(after.total));
  const again: any = await call('parcel.info', suivi, { orderId: oid });
  assert.equal(again.changes[0].status, 'approved');
  // a phone change is applied at once
  const ph: any = await call('parcel.change', suivi, { orderId: oid, kind: 'phone', phone: '0661 23 45 67' });
  assert.equal(ph.status, 'approved');
  assert.equal((await order(oid)).phone, '0661234567');
});

test('swap at ZR (preview): what it costs in the same wilaya or another, while the parcel can still be given', async () => {
  const { id: oid } = await zrOnRoad();
  const p: any = await call('parcel.info', await as(EMAILS.suivi), { orderId: oid });
  assert.deepEqual(p.info.swap, { eligible: true, count: 0, sameCityPrice: 50, differentCityPrice: 100 });
});

test('parcel at ZR (preview): home → stop desk, applied once ZR accepts; a request can be withdrawn', async () => {
  const { id: oid, zr } = await zrOnRoad();
  const suivi = await as(EMAILS.suivi);
  const w = Number((await order(oid)).wilaya_id);
  let sd = (await db.query('SELECT id FROM stopdesks WHERE company_id = $1 AND wilaya_id = $2 LIMIT 1', [zr, w]))[0];
  if (!sd) sd = (await db.query(`INSERT INTO stopdesks (company_id, wilaya_id, commune, name, address, ext_id) VALUES ($1,$2,'Centre','ZR Centre','Rue 1','hub-1') RETURNING id`, [zr, w]))[0];
  const ch: any = await call('parcel.change', suivi, { orderId: oid, kind: 'delivery', stopdesk: true, stopdeskId: Number(sd.id) });
  assert.equal(ch.status, 'pending');
  await db.query(`UPDATE parcel_changes SET created_at = now() - interval '1 minute' WHERE id = $1`, [ch.id]);
  await call('parcel.changeSync', suivi, {});
  const o = await order(oid);
  assert.equal(o.is_stopdesk, true);
  assert.equal(Number(o.stopdesk_id), Number(sd.id));
  // back home: withdrawn before ZR answers
  const back: any = await call('parcel.change', suivi, { orderId: oid, kind: 'delivery', stopdesk: false, wilayaId: w, commune: 'Centre', address: 'Cité 5 juillet' });
  await call('parcel.changeCancel', suivi, { id: back.id });
  const info: any = await call('parcel.info', suivi, { orderId: oid });
  assert.equal(info.changes.find((c: any) => c.id === back.id).status, 'cancelled');
  assert.equal((await order(oid)).is_stopdesk, true);
});

test('parcel at ZR (server): the request goes to ZR, its refusal is kept and the order stays the same', async () => {
  const { id: oid, zr } = await zrOnRoad();
  const calls: Calls = [];
  const server = fakeServer((action, args) => {
    if (action === 'change') return { extId: 'mod-1', approved: null };
    if (action === 'changeStates') return [{ extId: 'mod-1', approved: false, answer: 'Colis déjà en livraison', at: null }];
    if (action === 'parcel') return { state: 'En livraison', history: [], sms: [], livreur: null, risk: null, canModify: true, canChangePhone: true, pendingChange: false };
    return null;
  }, calls);
  const live = await as(EMAILS.suivi, server as any);
  const info: any = await call('parcel.info', live, { orderId: oid });
  assert.equal(info.info.state, 'En livraison');
  assert.equal(calls[0][0], 'parcel');
  const before = await order(oid);
  await call('parcel.change', live, { orderId: oid, kind: 'amount', amount: 1000 });
  const sent = calls.find((c) => c[0] === 'change')!;
  assert.equal(sent[1].companyId, zr);
  assert.equal(sent[1].change.kind, 'amount');
  assert.equal(sent[1].change.amount, 1000);
  await call('parcel.changeSync', live, { orderId: oid });
  const ch = (await db.query(`SELECT status, answer FROM parcel_changes WHERE order_id = $1 ORDER BY id DESC LIMIT 1`, [oid]))[0];
  assert.deepEqual([ch.status, ch.answer], ['refused', 'Colis déjà en livraison']);
  assert.equal(Number((await order(oid)).total), Number(before.total));
  const ev = await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND note LIKE 'Modification refusée%'`, [oid]);
  assert.equal(ev.length, 1);
});

test('live statuses (webhook): turned on at ZR with a key; a call with the key re-reads only that parcel from ZR', async () => {
  const zr = await companyId('zr');
  const admin = await as(EMAILS.admin);
  // preview: on and off, nothing sent
  await call('delivery.webhookOn', admin, { companyId: zr });
  assert.equal(((await call('delivery.zr', admin, { companyId: zr })) as any).webhook.on, true);
  await call('delivery.webhookOff', admin, { companyId: zr });
  assert.equal(((await call('delivery.zr', admin, { companyId: zr })) as any).webhook.on, false);
  // server
  const calls: Calls = [];
  const { id: oid } = await zrOnRoad();
  const tracking = (await db.query('SELECT tracking FROM orders WHERE id = $1', [oid]))[0].tracking;
  const server = fakeServer((action, args) => {
    if (action === 'webhookOn') return { extId: 'hook-1' };
    if (action === 'track') return args.items.map((i: any) => ({ id: i.id, key: 'livre', status: 'Livré', at: new Date().toISOString() }));
    if (action === 'services') return [{ key: 'phoneChange', label: 'Changement de téléphone', price: 50 }];
    if (action === 'webhookGet') return { on: true, url: 'https://pilotix.example/api/hooks/courier/x' };
    return null;
  }, calls);
  const live = await as(EMAILS.admin, server as any);
  await call('delivery.webhookOn', live, { companyId: zr });
  const on = calls.find((c) => c[0] === 'webhookOn')![1];
  assert.match(on.url, new RegExp(`^https://pilotix\\.example/api/hooks/courier/${zr}\\?key=[0-9a-f]{36}$`));
  const key = on.key;
  assert.ok(on.url.endsWith(key));
  const info: any = await call('delivery.zr', live, { companyId: zr });
  assert.equal(info.webhook.on, true);
  assert.equal(info.services[0].price, 50);
  await assert.rejects(call('delivery.hook', live, { companyId: zr, key: 'wrong', trackings: [tracking], extIds: [] }), /Clé du webhook invalide/);
  const r: any = await call('delivery.hook', live, { companyId: zr, key, trackings: [String(tracking).toLowerCase()], extIds: [] });
  assert.equal(r.checked, 1);
  assert.deepEqual(calls.filter((c) => c[0] === 'track').map((c) => c[1].items.map((i: any) => i.id)), [[oid]]);
  assert.equal((await db.query('SELECT follow_status FROM orders WHERE id = $1', [oid]))[0].follow_status, 'delivered');
  // editing the company keeps the webhook
  const c: any = (await call('delivery.companies', live, {}) as any[]).find((x: any) => x.id === zr);
  await call('delivery.saveCompany', live, { id: zr, name: c.name, kind: 'zr', active: true, settings: { base_url: 'https://api.zrexpress.app' }, secret: {} });
  assert.equal(((await call('delivery.companies', live, {})) as any[]).find((x: any) => x.id === zr).settings.webhook_id, 'hook-1');
});

test('payment request: another date, or withdrawn (preview)', async () => {
  const zr = await companyId('zr');
  const admin = await as(EMAILS.admin);
  await db.query('DELETE FROM courier_pay_requests WHERE company_id = $1', [zr]);
  await call('caisse.payRequest', admin, { companyId: zr });
  const r = (await db.query('SELECT id FROM courier_pay_requests WHERE company_id = $1', [zr]))[0];
  const later = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  await call('caisse.payRequestDate', admin, { id: Number(r.id), date: later });
  assert.equal(new Date((await db.query('SELECT date FROM courier_pay_requests WHERE id = $1', [r.id]))[0].date).toISOString().slice(0, 10), later);
  await assert.rejects(call('caisse.payRequestDate', admin, { id: Number(r.id), date: '2020-01-01' }), /demain/);
  await call('caisse.payRequestCancel', admin, { id: Number(r.id) });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM courier_pay_requests WHERE company_id = $1', [zr]))[0].n, 0);
});
