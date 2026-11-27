// Our own livreurs' corrections (the owner, 27 Nov 2026: « sometimes the livreur taps Livré by mistake »): the livreur
// carrying a parcel puts his own « Livrée » back « Pas livrée » / « Retour au dépôt », with a reason, until his versement
// (cashed); a refused parcel he still has becomes « Livrée finalement ». « Ma tournée » lists his « Livrée » not handed
// over yet.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let lamine: Ctx;
let other: number;
let own: number;

before(async () => {
  ({ db, as } = await setup(160));
  lamine = await as(EMAILS.livreur);
  own = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'own' ORDER BY id LIMIT 1`))[0].id);
  other = Number((await db.query(`SELECT id FROM profiles WHERE 'livreur' = ANY(roles) AND id <> $1 ORDER BY id LIMIT 1`, [lamine.session.profile.id]))[0]?.id ?? 0);
});

let taken = 0;
/** confirmed orders carried by our livreur (or another), in this status, not handed over */
async function his(n: number, status: string, livreurId = lamine.session.profile.id): Promise<number[]> {
  const rows = await db.query(`SELECT id FROM orders WHERE conf_status = 'confirmed' AND NOT is_exchange ORDER BY id DESC LIMIT $1 OFFSET $2`, [n, taken]);
  assert.equal(rows.length, n);
  taken += n;
  const ids = rows.map((r: any) => Number(r.id));
  await db.query(
    `UPDATE orders SET company_id = $2, livreur_id = $3, follow_status = $4, sub_status = NULL, tracking = NULL, cashed = false, handover_id = NULL,
       shipped_at = now() - interval '1 day', delivered_at = CASE WHEN $4 = 'delivered' THEN now() - interval '1 hour' END, returned_at = NULL, locked_by = NULL
     WHERE id = ANY($1)`,
    [ids, own, livreurId, status],
  );
  return ids;
}
const st = async (id: number) => (await db.query('SELECT follow_status FROM orders WHERE id = $1', [id]))[0].follow_status as string;
const notes = async (id: number) => (await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND kind = 'note'`, [id])).map((r: any) => String(r.note));
const setFollow = (ctx: Ctx, input: Record<string, unknown>) => call('orders.setFollow', ctx, { clientId: `t-${Math.random()}`, ...input });

test('the livreur puts his own « Livrée » back « Pas livrée », with a reason, written in the history', async () => {
  const [a] = await his(1, 'delivered');
  await setFollow(lamine, { ids: [a], status: 'failed', reason: 'Client absent' });
  assert.equal(await st(a), 'failed');
  assert.ok((await notes(a)).some((n) => n === 'Correction du livreur : pas livrée finalement (Client absent)'), JSON.stringify(await notes(a)));
});

test('or « Retour au dépôt »; never without a reason', async () => {
  const [b] = await his(1, 'delivered');
  await assert.rejects(setFollow(lamine, { ids: [b], status: 'returning' }), /indiquez pourquoi/);
  assert.equal(await st(b), 'delivered');
  await setFollow(lamine, { ids: [b], status: 'returning', reason: 'Refusée' });
  assert.equal(await st(b), 'returning');
});

test('after his versement (cashed) the « Livrée » is final for him', async () => {
  const [c] = await his(1, 'delivered');
  await db.query('UPDATE orders SET cashed = true WHERE id = $1', [c]);
  await assert.rejects(setFollow(lamine, { ids: [c], status: 'failed', reason: 'Client absent' }), /déjà encaissée/);
  assert.equal(await st(c), 'delivered');
});

test('another livreur’s « Livrée » is not his to correct', async () => {
  if (!other) return;
  const [e] = await his(1, 'delivered', other);
  await assert.rejects(setFollow(lamine, { ids: [e], status: 'failed', reason: 'Client absent' }));
  assert.equal(await st(e), 'delivered');
});

test('a refused parcel he still has: « Livrée finalement »', async () => {
  const [f] = await his(1, 'returning');
  await setFollow(lamine, { ids: [f], status: 'delivered', reason: 'Livrée finalement' });
  assert.equal(await st(f), 'delivered');
});

test('« Ma tournée » lists his « Livrée » not handed over yet, newest first, never a cashed one', async () => {
  const [g, h] = await his(2, 'delivered');
  await db.query('UPDATE orders SET cashed = true WHERE id = $1', [h]);
  const d: any = await call('delivery.tournee', lamine, {});
  const ids = (d.delivered as any[]).map((o) => Number(o.id));
  assert.ok(ids.includes(g));
  assert.ok(!ids.includes(h));
});
