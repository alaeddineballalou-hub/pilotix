// « Quand une alerte commence » on ZR's real answers (the owner, 26 Nov 2026): the advised start is the 2nd failed try,
// a cancel always makes an alert, « Commune erronée » goes to Suivi › Erreurs, a status once ticked for Alertes
// (« Reportée ») no longer makes one. Résolu only holds the alerts sent back on the road with « Relivrer », then
// delivered; only they are paid (to who pressed it).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { alertTouchedSql, relivreSql, relivreurSql } from '../modules/alerttouch';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let admin: Ctx;
let me: number;
let zr: number;

before(async () => {
  ({ db, as } = await setup(160));
  admin = await as(EMAILS.admin);
  me = (await as(EMAILS.suivi)).session.profile.id;
  zr = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'zr' ORDER BY id LIMIT 1`))[0].id);
});

let taken = 0;
/** parcels with ZR, out for delivery, the demo's suivi agent's */
async function onRoad(n: number): Promise<number[]> {
  const rows = await db.query(`SELECT id FROM orders WHERE conf_status = 'confirmed' AND NOT is_exchange ORDER BY id LIMIT $1 OFFSET $2`, [n, taken]);
  assert.equal(rows.length, n, 'enough confirmed orders in the demo');
  taken += n;
  const ids = rows.map((r: any) => Number(r.id));
  await db.query(
    `UPDATE orders SET company_id = $2, follow_status = 'out_for_delivery', sub_status = NULL, tracking = 'ZR-AS-' || id, shipped_at = now() - interval '1 day',
       taken_at = now() - interval '1 day', delivered_at = NULL, returning_at = NULL, returned_at = NULL, livreur_id = NULL, follow_agent_id = $3, locked_by = NULL, ext_status = 'Sortie en livraison' WHERE id = ANY($1)`,
    [ids, zr, me],
  );
  return ids;
}
/** ZR's answers: [key, words] per parcel */
const zrSays = (words: [number, string, string][]) =>
  as(EMAILS.suivi, {
    courier: async (action: string) => (action === 'track' ? words.map(([id, key, status]) => ({ id, key, status, at: null })) : []),
    meta: async () => null,
    hashPassword: async (v: string) => v,
  } as any);
const st = async (id: number) => (await db.query('SELECT follow_status, sub_status FROM orders WHERE id = $1', [id]))[0];
const sync = async (words: [number, string, string][]) => call('delivery.sync', await zrSays(words), { companyId: zr });
const listIds = async (tab: string) => (((await call('suivi.list', await as(EMAILS.suivi), { tab, page: 1, pageSize: 300 })) as any).rows as any[]).map((r) => Number(r.id));

test('the advised start (2nd try): try 1 stays on the road, try 2 is an alert, « Commune erronée » an error, an old tick no alert', async () => {
  const p = ((await call('prefs.get', admin, {})) as any).prefs;
  assert.equal(p.suiviAlertStart, 't2');
  assert.equal(p.suiviProblems, 'errors');
  // a status ticked once in « Alertes du Suivi »
  const cur = (await db.query('SELECT config FROM delivery_companies WHERE id = $1', [zr]))[0].config;
  const cfg = typeof cur === 'string' ? JSON.parse(cur) : cur ?? {};
  await db.query('UPDATE delivery_companies SET config = $2 WHERE id = $1', [zr, JSON.stringify({ ...cfg, statusMap: { ...(cfg.statusMap ?? {}), 'Sortie en livraison · Reportée à une date ultérieure': 'alert' } })]);
  const [a, b, c, d] = await onRoad(4);
  await sync([
    [a, 'sortie_en_livraison', 'Sortie en livraison · Ne répond pas 1'],
    [b, 'sortie_en_livraison', 'Sortie en livraison · Ne répond pas 2'],
    [c, 'sortie_en_livraison', 'Sortie en livraison · Commune erronée'],
    [d, 'sortie_en_livraison', 'Sortie en livraison · Reportée à une date ultérieure'],
  ]);
  assert.equal((await st(a)).follow_status, 'out_for_delivery');
  assert.deepEqual(await st(b), { follow_status: 'alert', sub_status: null });
  assert.deepEqual(await st(c), { follow_status: 'alert', sub_status: 'alert_erreur' });
  assert.equal((await st(d)).follow_status, 'out_for_delivery', 'the old tick no longer makes an alert');
  // Suivi: the error on its own, never in Nouvelles alertes
  const counts: any = await call('suivi.counts', await as(EMAILS.suivi), {});
  assert.ok(counts.erreurs >= 1);
  assert.equal(counts.erreursTab, 1);
  assert.ok((await listIds('erreurs')).includes(c));
  const fresh = await listIds('alertes_new');
  assert.ok(fresh.includes(b));
  assert.ok(!fresh.includes(c));
  // the customer then cancels: no longer an error, an alert
  await sync([[c, 'sortie_en_livraison', 'Sortie en livraison · Commande annulée']]);
  assert.deepEqual(await st(c), { follow_status: 'alert', sub_status: null });
  assert.ok(!(await listIds('erreurs')).includes(c));
});

test('« only at the cancel », problems with the alerts', async () => {
  await call('prefs.setAlertStart', admin, { start: 'cancel', problems: 'alert' });
  const [e, f, g] = await onRoad(3);
  await sync([
    [e, 'sortie_en_livraison', 'Sortie en livraison · Ne répond pas 3'],
    [f, 'sortie_en_livraison', 'Sortie en livraison · Commune erronée'],
    [g, 'confirme_au_bureau', 'Confirmé au bureau · Commande annulée'],
  ]);
  assert.equal((await st(e)).follow_status, 'out_for_delivery', 'ZR « Ne répond pas 3 » is not an alert with this choice');
  assert.deepEqual(await st(f), { follow_status: 'alert', sub_status: null });
  assert.deepEqual(await st(g), { follow_status: 'alert', sub_status: null });
  const counts: any = await call('suivi.counts', await as(EMAILS.suivi), {});
  assert.equal(counts.erreursTab, 0);
  assert.equal(counts.erreurs, 0);
  // the other Préférences keep the choice
  const base = ((await call('prefs.get', admin, {})) as any).prefs;
  const { suiviAlertStart: _s, suiviProblems: _p, ...rest } = base;
  await call('prefs.set', admin, rest);
  const after = ((await call('prefs.get', admin, {})) as any).prefs;
  assert.deepEqual([after.suiviAlertStart, after.suiviProblems], ['cancel', 'alert']);
  await assert.rejects(call('prefs.setAlertStart', await as(EMAILS.suivi), { start: 't1', problems: 'errors' }), 'admin only');
  await call('prefs.setAlertStart', admin, { start: 't2', problems: 'errors' });
});

test('Résolu and the suivi pay: only an alert sent back with « Relivrer », then delivered (kept « En cours »: a plain « Livré »)', async () => {
  const [h, k, r, x] = await onRoad(4);
  const pause = () => new Promise((res) => setTimeout(res, 25));
  const two = 'Sortie en livraison · Ne répond pas 2';
  await sync([h, k, r, x].map((id) => [id, 'sortie_en_livraison', two] as [number, string, string]));
  for (const id of [h, k, r, x]) assert.equal((await st(id)).follow_status, 'alert');
  await pause();
  // k: the agent calls, no answer, and it stays « En cours »; r and x: he reaches the customer and presses « Relivrer »;
  // nobody touches h
  await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value, note) VALUES ($1, now(), $2, 'call', NULL, 'no_answer', 'Appel')`, [k, me]);
  const agent = await as(EMAILS.suivi);
  for (const id of [r, x]) await call('suivi.resolve', agent, { id, outcome: 'resolved', motif: 'reached', relance: false });
  assert.equal((await st(r)).follow_status, 'out_for_delivery');
  await pause();
  // x fails again: an alert again, and nobody presses « Relivrer » this time
  await sync([[x, 'sortie_en_livraison', 'Sortie en livraison · Ne répond pas 3']]);
  assert.equal((await st(x)).follow_status, 'alert');
  await pause();
  await sync([h, k, r, x].map((id) => [id, 'livre', 'Livré'] as [number, string, string]));
  for (const id of [h, k, r, x]) assert.equal((await st(id)).follow_status, 'delivered');
  const resolus = await listIds('resolus');
  assert.ok(resolus.includes(r), '« Relivrer », then delivered: Résolu');
  assert.ok(!resolus.includes(k), 'kept « En cours », then delivered: a plain « Livré »');
  assert.ok(!resolus.includes(h), 'nobody touched it: a plain « Livré »');
  assert.ok(!resolus.includes(x), 'its last alert stayed without « Relivrer »: a plain « Livré »');
  // « Sauvé par » on the Résolu line: who pressed « Relivrer »
  const res = (await call('suivi.list', agent, { tab: 'resolus', page: 1, pageSize: 300 })) as any;
  const myName = String((await db.query('SELECT name FROM profiles WHERE id = $1', [me]))[0].name);
  assert.equal(res.extra[r]?.savedBy, myName, '« Sauvé par » shows who pressed « Relivrer »');
  // the pay: to who pressed « Relivrer »; nobody for the others; k is not « ignorée » (worked on), h can be
  const who = async (id: number) => (await db.query(`SELECT ${alertTouchedSql('o')} AS touched, ${relivreSql('o')} AS back, ${relivreurSql('o')} AS paid FROM orders o WHERE o.id = $1`, [id]))[0];
  const [hw, kw, rw, xw] = [await who(h), await who(k), await who(r), await who(x)];
  assert.equal(Number(rw.paid), me);
  assert.deepEqual([rw.back, kw.back, hw.back, xw.back], [true, false, false, false]);
  assert.deepEqual([kw.paid, hw.paid, xw.paid], [null, null, null]);
  assert.deepEqual([kw.touched, hw.touched], [true, false], 'the company\'s own news (the sync ran as the agent) is not someone working on it');
});

test('each company\'s words for the table « Ce que votre choix veut dire chez chaque société »', async () => {
  const rows = (await call('delivery.alertWords', admin, {})) as any[];
  const zrRow = rows.find((r) => r.kind === 'zr');
  assert.equal(zrRow.numbered, 'Ne répond pas {n}');
  assert.deepEqual(zrRow.cancels, ['Commande annulée']);
  assert.deepEqual(zrRow.problems, ['Commune erronée']);
  assert.equal(rows[0].mine, true, 'the shop\'s own companies first');
  const yal = rows.find((r) => r.kind === 'yalidine');
  assert.ok(yal.tries.includes('Tentative échouée'));
  assert.ok(yal.problems.includes('Bloqué'));
  assert.ok(!yal.problems.includes('Alerte résolue') && !yal.problems.includes('Débloqué'));
  await assert.rejects(call('delivery.alertWords', await as(EMAILS.suivi), {}), 'admin only');
});

test('« Attribuer » in Suivi: a manager gives alerts to a suivi agent; giving is not working on the alert', async () => {
  const [m] = await onRoad(1);
  await db.query('UPDATE orders SET follow_agent_id = NULL WHERE id = $1', [m]);
  await sync([[m, 'sortie_en_livraison', 'Sortie en livraison · Ne répond pas 2']]);
  assert.equal((await st(m)).follow_status, 'alert');
  const agentOf = async () => (await db.query('SELECT follow_agent_id FROM orders WHERE id = $1', [m]))[0].follow_agent_id;
  await call('suivi.assign', admin, { ids: [m], agentId: me });
  assert.equal(Number(await agentOf()), me);
  assert.ok((await listIds('alertes_new')).includes(m), 'still a new alert: giving it is not acting on it');
  await assert.rejects(call('suivi.assign', await as(EMAILS.suivi), { ids: [m], agentId: null }), 'an agent does not give alerts');
  await assert.rejects(call('suivi.assign', admin, { ids: [m], agentId: (await as(EMAILS.depot)).session.profile.id }), 'only the suivi team');
  await call('suivi.assign', admin, { ids: [m], agentId: null });
  assert.equal(await agentOf(), null);
});
