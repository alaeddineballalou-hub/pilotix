// Suivi · « Clair » (the owner's design 1, 25 Nov 2026): the counters over each alert list (and the filter they make),
// « Pas de réponse » / « Occupé » = one call each, « Rappel » = « Plus tard », a treated alert waits for the company in
// En cours, Résolu fills itself when the company delivers, « Client annule » sends the parcel back (Swap).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
let suivi: Ctx;

before(async () => {
  ({ db, as } = await setup(120));
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
    `INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, note, at)
     SELECT $1, NULL, 'follow_status', 'shipped', 'alert', 'Numéro erroné', coalesce(max(at), now()) + interval '1 minute' FROM order_events WHERE order_id = $1`,
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

test('a treated alert waits for the company in En cours (« Attend ZR »); delivered, it is in Résolu', async () => {
  const id = await freshAlert();
  const motifs: any = await call('suivi.motifs', suivi, {});
  const m = motifs.resolved.find((x: any) => x.on && !x.date) ?? motifs.resolved.find((x: any) => x.on);
  const date = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await call('suivi.resolve', suivi, { id, outcome: 'resolved', motif: m.key, date: m.date ? date : null, relance: false });
  const l = await list('alertes_encours', { bucket: 'zr' });
  assert.ok(l.rows.some((r: any) => r.id === id), 'treated: « Attend ZR »');
  assert.equal(l.extra[id].last.key, 'relivrer');
  const c: any = await call('suivi.counts', suivi, {});
  assert.equal(c.alertes_new + c.alertes_encours, c.alertes + c.traites);
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
});
