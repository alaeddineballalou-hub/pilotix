// Contrôle in a real shop's database: the facts read from the orders, their history and the companies' payments, each
// problem kept as one case; what Pilotix does alone (a stopped parcel to Alertes), told once, set aside, and closed by
// itself as soon as the depot, Pilotix and the company agree again (the scan came, the money came, the company answers).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call as rawCall, Ctx, Db, seedLeaks } from '../index';
import { EMAILS, setup } from './harness';

const call = (name: string, ctx: Ctx, input: unknown = {}) => rawCall(name, ctx, input) as Promise<any>;

let db: Db;
let admin: Ctx;
let nadia: Ctx;
let karim: Ctx;
let samira: Ctx;
let zr = 0;
let yal = 0;

const one = async (sql: string, args: unknown[] = []) => (await db.query(sql, args))[0] as any;
const open = async (kind: string) => db.query(`SELECT * FROM leak_cases WHERE kind = $1 AND closed_at IS NULL ORDER BY id`, [kind]) as Promise<any[]>;

before(async () => {
  const s = await setup(700);
  db = s.db;
  admin = await s.as(EMAILS.admin);
  nadia = await s.as(EMAILS.suivi);
  karim = await s.as(EMAILS.depot);
  samira = await s.as(EMAILS.conf);
  zr = Number((await one(`SELECT id FROM delivery_companies WHERE kind = 'zr'`)).id);
  yal = Number((await one(`SELECT id FROM delivery_companies WHERE kind = 'yalidine'`)).id);
  await seedLeaks(db);
});

test('the first check finds each planted problem, company by company, and rings nobody', async () => {
  const r = await call('leaks.run', admin);
  assert.ok(r.found >= 9, JSON.stringify(r));
  assert.equal(r.told, 0, 'what was already there is shown, not rung');
  for (const [kind, company] of [
    ['stop_words', zr],
    ['unknown_words', zr],
    ['return_not_scanned', zr],
    ['out_not_taken', zr],
    ['paid_unknown', zr],
    ['paid_wrong_amount', zr],
    ['return_stalled', yal],
    ['not_paid', yal],
    ['sync_down', yal],
  ] as const) {
    const rows = await open(kind);
    assert.ok(rows.some((x) => Number(x.company_id) === company), `${kind} for company ${company}`);
  }
  // each company alone: Yalidine's silence is Yalidine's only
  assert.deepEqual((await open('sync_down')).map((x) => Number(x.company_id)), [yal]);
  const wrong = (await open('paid_wrong_amount'))[0];
  assert.equal(Number(wrong.amount), 700);
  // our livreurs: the cash still with the livreur after 2 days
  assert.ok((await open('not_paid')).some((x) => x.details.livreur === true));
});

test('a parcel ZR stopped while Pilotix said « En livraison » goes to Suivi › Alertes by itself (24 Nov 2026)', async () => {
  const k = (await db.query(`SELECT * FROM leak_cases WHERE kind = 'stop_words' ORDER BY id`))[0] as any;
  assert.equal(k.action, 'alert');
  const o = await one('SELECT follow_status FROM orders WHERE id = $1', [k.order_id]);
  assert.equal(o.follow_status, 'alert');
  const ev = await one(`SELECT note FROM order_events WHERE order_id = $1 AND kind = 'follow_status' AND to_value = 'alert' ORDER BY id DESC LIMIT 1`, [k.order_id]);
  assert.match(ev.note, /Contrôle : ZR Express dit « Sortie en livraison · Commande annulée »/);
  // the next check: Pilotix and ZR agree now (it is an alert): closed by itself, and never raised twice
  const again = await call('leaks.run', admin);
  assert.equal(again.acted, 0);
  const closed = await one('SELECT closed_at, closed_by FROM leak_cases WHERE id = $1', [k.id]);
  assert.ok(closed.closed_at);
  assert.equal(closed.closed_by, 'auto');
});

test('the money is for the owners: the suivi and the depot see the rest', async () => {
  const mine = await call('leaks.overview', nadia);
  assert.equal(mine.money, false);
  const zrCard = mine.companies.find((c: any) => c.id === zr);
  assert.equal(zrCard.atRisk, null);
  assert.equal(zrCard.byArea.argent, 0);
  await assert.rejects(call('leaks.list', nadia, { area: 'argent' }), /Argent/);
  const list = await call('leaks.list', karim, {});
  assert.ok(list.rows.length > 0);
  assert.ok(list.rows.every((r: any) => r.area !== 'argent'));
  const boss = await call('leaks.overview', admin);
  assert.equal(boss.money, true);
  assert.ok(boss.companies.find((c: any) => c.id === zr).atRisk > 0);
  assert.ok((await call('leaks.list', admin, { area: 'argent' })).rows.length >= 3);
  // a confirmation agent has no Contrôle page
  await assert.rejects(call('leaks.overview', samira), /refusé|droit|rôle/i);
});

test('« C’est vu » sets a problem aside while it lasts; it closes by itself once agreed', async () => {
  const k = (await open('unknown_words'))[0];
  await call('leaks.seen', nadia, { id: Number(k.id) });
  const before_ = await call('leaks.overview', nadia);
  assert.equal(before_.companies.find((c: any) => c.id === zr).seen >= 1, true);
  await call('leaks.run', admin);
  const still = await one('SELECT closed_at, dismissed_by FROM leak_cases WHERE id = $1', [k.id]);
  assert.equal(still.closed_at, null);
  assert.ok(still.dismissed_by);
  // the owner tells Pilotix what the words mean (Préférences): read again by the sync, the case closes
  await db.query(`UPDATE orders SET ext_meaning = 'shipped' WHERE id = $1`, [k.order_id]);
  await call('leaks.run', admin);
  assert.ok((await one('SELECT closed_at FROM leak_cases WHERE id = $1', [k.id])).closed_at);
});

test('the depot scans the return: Contrôle closes « rendu par ZR, pas scanné »', async () => {
  const k = (await open('return_not_scanned'))[0];
  const r = await call('depot.scan', karim, { orderId: Number(k.order_id), code: '', mode: 'return' });
  assert.equal(r.kind, 'ok', r.why);
  await call('leaks.run', admin);
  assert.ok((await one('SELECT closed_at FROM leak_cases WHERE id = $1', [k.id])).closed_at);
});

test('« Reçu au dépôt » for a return the company marked « Retourné » by itself (Pilotix had put it back in stock)', async () => {
  const o = await one(`SELECT id FROM orders WHERE company_id = $1 AND follow_status = 'returned' ORDER BY id DESC LIMIT 1`, [zr]);
  await db.query(`DELETE FROM order_events WHERE order_id = $1 AND to_value = 'returned'`, [o.id]);
  await db.query(
    `INSERT INTO order_events (order_id, kind, from_value, to_value, note, data, at) VALUES ($1, 'follow_status', 'shipped', 'returned', 'ZR : Récupéré par le fournisseur', '{"courier": true, "by": "ZR Express"}', now() - interval '5 days')`,
    [o.id],
  );
  await call('leaks.run', admin);
  const k = (await open('return_not_scanned')).find((x) => Number(x.order_id) === Number(o.id));
  assert.ok(k, 'found');
  assert.equal(k.details.stock, true);
  const row = (await call('leaks.list', karim, { area: 'retours' })).rows.find((x: any) => x.id === Number(k.id));
  assert.equal(row.canReceive, true);
  await assert.rejects(call('leaks.received', nadia, { id: Number(k.id) }), /refusé|droit|rôle/i);
  await call('leaks.received', karim, { id: Number(k.id) });
  assert.ok((await one('SELECT closed_at FROM leak_cases WHERE id = $1', [k.id])).closed_at);
  await call('leaks.run', admin);
  assert.equal((await open('return_not_scanned')).filter((x) => Number(x.order_id) === Number(o.id)).length, 0, 'its depot event keeps it closed');
});

test('a new problem after the first check is rung once, to who acts', async () => {
  const p = await one(`SELECT id FROM orders WHERE company_id = $1 AND follow_status = 'delivered' AND cashed AND total > 0 ORDER BY id LIMIT 1`, [yal]);
  await db.query(`UPDATE orders SET cashed = false, delivered_at = now() - interval '20 days' WHERE id = $1`, [p.id]);
  const r = await call('leaks.run', admin);
  assert.ok(r.told >= 1, JSON.stringify(r));
  const k = (await open('not_paid')).find((x) => Number(x.order_id) === Number(p.id));
  assert.ok(k.notified_at);
  const r2 = await call('leaks.run', admin);
  assert.equal(r2.told, 0, 'never twice');
  // the money comes: closed by itself
  await db.query(`UPDATE orders SET cashed = true WHERE id = $1`, [p.id]);
  await call('leaks.run', admin);
  assert.ok((await one('SELECT closed_at FROM leak_cases WHERE id = $1', [k.id])).closed_at);
});

test('the full courier sync runs Contrôle after the companies answered: Yalidine answers again, its case closes', async () => {
  const r = await call('delivery.sync', admin, {});
  assert.ok(r.control, JSON.stringify(r.steps));
  assert.equal((await open('sync_down')).length, 0);
  const h = await one('SELECT error, error_since, ok_at FROM courier_health WHERE company_id = $1', [yal]);
  assert.equal(h.error, null);
  assert.ok(h.ok_at);
  // what the company's words mean is kept with the words they were read for
  const m = await one(`SELECT count(*) FILTER (WHERE ext_meaning IS NOT NULL AND ext_meaning_of = left(ext_status, 200))::int AS n FROM orders WHERE company_id = $1`, [zr]);
  assert.ok(m.n > 0);
  // a fast sync (every 5 minutes) does not run it
  const fast = await call('delivery.sync', admin, { fast: true });
  assert.equal(fast.control, undefined);
});

test('a company that fails for more than an hour is one case for the company, not one per parcel', async () => {
  await db.query(`UPDATE courier_health SET error = 'ZR refuse les clés API', error_since = now() - interval '2 hours' WHERE company_id = $1`, [zr]);
  await call('leaks.run', admin);
  const rows = await open('sync_down');
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].company_id), zr);
  assert.equal(rows[0].order_id, null);
  const count = await call('orders.counts', admin, {}).catch(() => null);
  if (count) assert.ok(typeof count.controle === 'number');
});
