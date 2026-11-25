// Suivi · « Clair » (the owner's design 1, 25 Nov 2026): the counters over each alert list (and the filter they make),
// « Pas de réponse » / « Occupé » = one call each, « Rappel » = « Plus tard », a réclamation sent = « Attend ZR »;
// « Relivrer » sends the parcel back on the road (out of En cours), Résolu fills itself when the company delivers, a new
// alert from the company is a new alert to do, and so is a « Relivrer » the company refuses; « Client annule » sends
// the parcel back (Annulés, where Swap is).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let suivi: Ctx;

before(async () => {
  ({ db, as } = await setup(240));
  suivi = await as(EMAILS.suivi);
});

const used: number[] = [];
/** a parcel on the road that just became an alert (nobody acted on it yet) */
async function freshAlert(kind?: string): Promise<number> {
  const co = kind ? Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = $1 LIMIT 1`, [kind]))[0]?.id ?? 0) : 0;
  const o = (await db.query(`SELECT id FROM sales o WHERE follow_status IN ('shipped','out_for_delivery','failed') AND shipped_at IS NOT NULL AND locked_by IS NULL AND NOT (id = ANY($1)) ORDER BY id LIMIT 1`, [used]))[0];
  const id = Number(o.id);
  used.push(id);
  // (hers: a suivi agent's lists are her own parcels and nobody's)
  await db.query(`UPDATE orders SET follow_status = 'alert', sub_status = NULL, follow_agent_id = $2${co ? ', company_id = $3' : ''} WHERE id = $1`, co ? [id, suivi.session.profile.id, co] : [id, suivi.session.profile.id]);
  await db.query(
    // (just now: some demo events are planned for later, and what the test does next comes after it)
    `INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, note, at)
     VALUES ($1, NULL, 'follow_status', 'shipped', 'alert', 'Numéro erroné', now() - interval '1 second')`,
    [id],
  );
  return id;
}
const list = async (tab: string, extra: Record<string, unknown> = {}) => (await call('suivi.list', suivi, { tab, pageSize: 500, ...extra })) as any;
const ids = async (tab: string, extra: Record<string, unknown> = {}) => (await list(tab, extra)).rows.map((r: any) => r.id);

test('Nouvelles alertes: three counters over the whole list, and each one filters', async () => {
  const id = await freshAlert();
  const l = await list('alertes_new');
  assert.deepEqual(Object.keys(l.buckets).sort(), ['late', 'ok', 'soon']);
  assert.equal(l.buckets.late + l.buckets.soon + l.buckets.ok, l.total);
  const b = l.extra[id]?.bucket;
  assert.ok(['late', 'soon', 'ok'].includes(b));
  const only = await list('alertes_new', { bucket: b });
  assert.ok(only.rows.length > 0 && only.rows.every((r: any) => only.extra[r.id].bucket === b));
  assert.ok(only.rows.some((r: any) => r.id === id));
  // the counters do not move with the filter: they always count the whole list
  assert.deepEqual(only.buckets, l.buckets);
});

test('« Pas de réponse » and « Occupé » are one call each; the alert moves to En cours with its last result', async () => {
  const id = await freshAlert();
  assert.ok((await ids('alertes_new')).includes(id));
  await call('suivi.callResult', suivi, { id, result: 'no_answer' });
  assert.ok(!(await ids('alertes_new')).includes(id));
  const l = await list('alertes_encours');
  const x = l.extra[id];
  assert.ok(x, 'in progress');
  assert.equal(x.last.key, 'no_answer');
  assert.equal(x.bucket, 'call');
  assert.ok(x.tries.done >= 1, 'the call counts as a try');
  const calls = (await db.query(`SELECT count(*)::int AS n FROM order_events WHERE order_id = $1 AND kind = 'call'`, [id]))[0].n;
  assert.equal(calls, 1);
  await call('suivi.callResult', suivi, { id, result: 'busy' });
  assert.equal((await list('alertes_encours')).extra[id].last.key, 'busy');
});

test('« Rappel » at a day and hour: « Plus tard » until then', async () => {
  const id = await freshAlert();
  await assert.rejects(call('suivi.callResult', suivi, { id, result: 'callback', at: null }), /rappel/i);
  const at = new Date(Date.now() + 3 * 3_600_000).toISOString();
  await call('suivi.callResult', suivi, { id, result: 'callback', at });
  const l = await list('alertes_encours', { bucket: 'later' });
  assert.ok(l.rows.some((r: any) => r.id === id));
  assert.equal(l.extra[id].last.key, 'callback');
  assert.equal(l.extra[id].callbackAt, at);
});

test('a réclamation sent on an alert: En cours › « Attend ZR » until the company answers', async () => {
  const kind = (await db.query(`SELECT kind FROM delivery_companies WHERE kind <> 'own' ORDER BY id LIMIT 1`))[0]?.kind;
  const id = await freshAlert(kind);
  await call('suivi.callResult', suivi, { id, result: 'no_answer' });
  const c: any = await call('suivi.claimCreate', suivi, { orderId: id, reason: 'other', message: 'Merci de rappeler le client', viaApi: false });
  await db.query(`UPDATE claims SET created_at = now() + interval '2 minutes' WHERE id = $1`, [c.id]);
  const l = await list('alertes_encours', { bucket: 'zr' });
  assert.ok(l.rows.some((r: any) => r.id === id), '« Attend ZR »');
  assert.equal(l.extra[id].last.key, 'claim');
  assert.ok(l.extra[id].tries.done >= 1, 'its calls still show');
});

test('« Relivrer »: back on the road, out of En cours; delivered, it is in Résolu', async () => {
  const id = await freshAlert();
  await call('suivi.callResult', suivi, { id, result: 'busy' });
  assert.ok((await ids('alertes_encours')).includes(id));
  const motifs: any = await call('suivi.motifs', suivi, {});
  const m = motifs.resolved.find((x: any) => x.on && !x.date) ?? motifs.resolved.find((x: any) => x.on);
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await call('suivi.resolve', suivi, { id, outcome: 'resolved', motif: m.key, date: m.date ? date : null, relance: false });
  assert.equal((await db.query('SELECT follow_status FROM orders WHERE id = $1', [id]))[0].follow_status, 'out_for_delivery');
  assert.ok(!(await ids('alertes_encours')).includes(id), 'relivrée: no longer in En cours');
  assert.ok(!(await ids('alertes_new')).includes(id));
  const c: any = await call('suivi.counts', suivi, {});
  // the two lists hold every alert, nothing else
  assert.equal(c.alertes_new + c.alertes_encours, c.alertes);
  assert.equal((await list('alertes_encours')).total, c.alertes_encours);
  // the company delivers it: Résolu, today, saved by the suivi agent — nobody pressed anything
  await db.query(`UPDATE orders SET follow_status = 'delivered', delivered_at = now(), sub_status = NULL WHERE id = $1`, [id]);
  await db.query(`INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, at) SELECT $1, NULL, 'follow_status', 'out_for_delivery', 'delivered', max(at) + interval '1 minute' FROM order_events WHERE order_id = $1`, [id]);
  const r = await list('resolus');
  assert.ok(r.rows.some((x: any) => x.id === id));
  assert.equal(r.extra[id].bucket, 'today');
  assert.equal(r.extra[id].savedBy, suivi.session.profile.name);
  assert.equal(r.buckets.all, r.total);
  assert.ok((await ids('resolus', { bucket: 'today' })).includes(id));
  assert.ok(!(await ids('alertes_encours')).includes(id));
});

test('relivrée, then the company cancels it again: a new alert to do (Nouvelles alertes), its tries from zero', async () => {
  const id = await freshAlert();
  await call('suivi.callResult', suivi, { id, result: 'no_answer' });
  const motifs: any = await call('suivi.motifs', suivi, {});
  const m = motifs.resolved.find((x: any) => x.on && !x.date) ?? motifs.resolved.find((x: any) => x.on);
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await call('suivi.resolve', suivi, { id, outcome: 'resolved', motif: m.key, date: m.date ? date : null, relance: false });
  // the company's news: « Commande annulée » (the sync writes it with nobody's name)
  await db.query(`UPDATE orders SET follow_status = 'alert', sub_status = NULL WHERE id = $1`, [id]);
  await db.query(
    `INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, note, at) SELECT $1, NULL, 'follow_status', 'out_for_delivery', 'alert', 'Commande annulée', max(at) + interval '1 minute' FROM order_events WHERE order_id = $1`,
    [id],
  );
  const l = await list('alertes_new');
  assert.ok(l.rows.some((r: any) => r.id === id), 'a new alert');
  assert.equal(l.extra[id].tries.done, 0);
  assert.ok(!(await ids('alertes_encours')).includes(id));
});

test('ZR refuses « Relivrer » at once (its API says no): the parcel is an alert again, in Nouvelles alertes', async () => {
  const id = await freshAlert('zr');
  await db.query(`UPDATE orders SET tracking = coalesce(tracking, 'ZR-REFUS-' || id) WHERE id = $1`, [id]);
  await call('suivi.callResult', suivi, { id, result: 'no_answer' });
  // ZR's API answers no to the réclamation « relancer »
  const refusing = await as(EMAILS.suivi, { courier: async () => { throw new Error('Colis déjà clôturé chez ZR'); } } as any);
  const motifs: any = await call('suivi.motifs', suivi, {});
  const m = motifs.resolved.find((x: any) => x.on && !x.date) ?? motifs.resolved.find((x: any) => x.on);
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const r: any = await call('suivi.resolve', refusing, { id, outcome: 'resolved', motif: m.key, date: m.date ? date : null, relance: true });
  assert.equal(r.back, true, 'the screen is told it came back');
  assert.match(r.claimError, /clôturé/);
  assert.equal((await db.query('SELECT follow_status FROM orders WHERE id = $1', [id]))[0].follow_status, 'alert');
  const l = await list('alertes_new');
  assert.ok(l.rows.some((x: any) => x.id === id), 'a new alert to do');
  assert.match(l.extra[id].alertReason, /Relance refusée — Colis déjà clôturé/);
  assert.equal(l.extra[id].tries.done, 0, 'its calls start again');
  assert.ok(!(await ids('alertes_encours')).includes(id));
});

test('a « Relivrer » réclamation marked « Perdue » (the company said no): the parcel is an alert again', async () => {
  const kind = (await db.query(`SELECT kind FROM delivery_companies WHERE kind NOT IN ('zr', 'own') ORDER BY id LIMIT 1`))[0]?.kind;
  const id = await freshAlert(kind);
  await call('suivi.callResult', suivi, { id, result: 'busy' });
  const motifs: any = await call('suivi.motifs', suivi, {});
  const m = motifs.resolved.find((x: any) => x.on && !x.date) ?? motifs.resolved.find((x: any) => x.on);
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await call('suivi.resolve', suivi, { id, outcome: 'resolved', motif: m.key, date: m.date ? date : null, relance: false });
  assert.equal((await db.query('SELECT follow_status FROM orders WHERE id = $1', [id]))[0].follow_status, 'out_for_delivery');
  const c: any = await call('suivi.claimCreate', suivi, { orderId: id, reason: 'relivrer', message: 'Merci de relivrer le colis', viaApi: false });
  await call('suivi.claimUpdate', suivi, { id: c.id, status: 'lost', note: 'La société refuse de relivrer' });
  assert.equal((await db.query('SELECT follow_status FROM orders WHERE id = $1', [id]))[0].follow_status, 'alert');
  const l = await list('alertes_new');
  assert.ok(l.rows.some((x: any) => x.id === id), 'a new alert to do');
  assert.match(l.extra[id].alertReason, /Relance refusée — La société refuse de relivrer/);
  // another réclamation lost on a parcel already an alert, or delivered: nothing moves
  const c2: any = await call('suivi.claimCreate', suivi, { orderId: id, reason: 'late', message: 'Colis en retard', viaApi: false });
  await call('suivi.claimUpdate', suivi, { id: c2.id, status: 'lost' });
  assert.equal((await db.query('SELECT follow_status FROM orders WHERE id = $1', [id]))[0].follow_status, 'alert');
});

test('« Client annule »: the parcel goes back; with a company that swaps by hand it is in Swap, « Client annulé »', async () => {
  const kind = (await db.query(`SELECT kind FROM delivery_companies WHERE kind NOT IN ('zr') ORDER BY id LIMIT 1`))[0]?.kind;
  const id = await freshAlert(kind);
  await call('suivi.act', suivi, { id, action: 'cancel', by: 'client' });
  assert.equal((await db.query('SELECT follow_status FROM orders WHERE id = $1', [id]))[0].follow_status, 'returning');
  const s = await list('swap');
  assert.ok(s.rows.some((r: any) => r.id === id), 'in Swap');
  assert.equal(s.extra[id].cancelBy, 'client');
  assert.equal(s.extra[id].bucket, 'client');
  assert.equal(s.buckets.all, s.total);
  assert.ok((await ids('swap', { bucket: 'client' })).includes(id));
  // Suivi › Annulés: the same parcel, « Client annulé », with its Swap
  const a = await list('annules');
  assert.ok(a.rows.some((r: any) => r.id === id), 'in Annulés');
  assert.equal(a.extra[id].cancelBy, 'client');
  assert.ok((await ids('annules', { bucket: 'client' })).includes(id));
});
