// The companies' corrections (the owner, 27 Nov 2026: « sometimes the livreur taps Livré by mistake, then cancels »).
// A finished parcel is followed until its company pays it: « Livrée » until it is cashed, « Annulée » after it left until
// it is back at the depot or its return fee was taken. Suivi › Erreurs leave the tab by themselves when the company no
// longer says the problem; an « En retour » the company gave itself follows its correction (the Suivi's own does not).
// Every correction is written in the order's history.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let me: number;
let zr: number;

before(async () => {
  ({ db, as } = await setup(160));
  me = (await as(EMAILS.suivi)).session.profile.id;
  zr = Number((await db.query(`SELECT id FROM delivery_companies WHERE kind = 'zr' ORDER BY id LIMIT 1`))[0].id);
});

let taken = 0;
/** confirmed orders with ZR, left the depot two days ago, in this status with these last words from ZR */
async function parcels(n: number, status: string, words: string): Promise<number[]> {
  const rows = await db.query(`SELECT id FROM orders WHERE conf_status = 'confirmed' AND NOT is_exchange ORDER BY id LIMIT $1 OFFSET $2`, [n, taken]);
  assert.equal(rows.length, n, 'enough confirmed orders in the demo');
  taken += n;
  const ids = rows.map((r: any) => Number(r.id));
  await db.query(
    `UPDATE orders SET company_id = $2, follow_status = $4, ext_status = $5, sub_status = NULL, tracking = 'ZR-FIX-' || id,
       shipped_at = now() - interval '2 days', taken_at = now() - interval '2 days', ext_status_at = now() - interval '1 hour',
       delivered_at = CASE WHEN $4 = 'delivered' THEN now() - interval '1 hour' END, returning_at = NULL, returned_at = NULL,
       livreur_id = NULL, follow_agent_id = $3, locked_by = NULL, cashed = false, fee_taken_at = NULL WHERE id = ANY($1)`,
    [ids, zr, me, status, words],
  );
  return ids;
}
/** ZR's answers: [order, key, words, when its status started (ZR's « lastStateUpdateAt »)] */
const zrSays = (words: [number, string, string, string?][]) =>
  as(EMAILS.suivi, {
    courier: async (action: string) => (action === 'track' ? words.map(([id, key, status, at]) => ({ id, key, status, at: at ?? null })) : []),
    meta: async () => null,
    hashPassword: async (v: string) => v,
  } as any);
/** the sync every 30 minutes (the full one) */
const sync = async (words: [number, string, string, string?][]) => call('delivery.sync', await zrSays(words), { companyId: zr });
const st = async (id: number) => (await db.query('SELECT follow_status, sub_status FROM orders WHERE id = $1', [id]))[0];
const notes = async (id: number) => (await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND kind = 'note' ORDER BY at, id`, [id])).map((r: any) => String(r.note));
const listIds = async (tab: string) => (((await call('suivi.list', await as(EMAILS.suivi), { tab, page: 1, pageSize: 300 })) as any).rows as any[]).map((r) => Number(r.id));

test('Suivi › Erreurs: ZR no longer says « Commune erronée »: the parcel leaves the tab and follows ZR again', async () => {
  const [a] = await parcels(1, 'out_for_delivery', 'Sortie en livraison');
  await sync([[a, 'sortie_en_livraison', 'Sortie en livraison · Commune erronée']]);
  assert.deepEqual(await st(a), { follow_status: 'alert', sub_status: 'alert_erreur' });
  assert.ok((await listIds('erreurs')).includes(a));
  await sync([[a, 'en_livraison', 'En livraison']]);
  assert.deepEqual(await st(a), { follow_status: 'out_for_delivery', sub_status: null });
  assert.ok(!(await listIds('erreurs')).includes(a));
  assert.ok((await notes(a)).some((n) => /ne signale plus d’erreur : le colis quitte « Erreurs »/.test(n)), JSON.stringify(await notes(a)));
});

test('ZR puts an « Erreur » out for delivery again with the old « Commune erronée » still written (PX1312): it leaves « Erreurs »', async () => {
  const [a] = await parcels(1, 'out_for_delivery', 'En livraison');
  // back at its office, the office writes the problem
  await sync([[a, 'confirme_au_bureau', 'Confirmé au bureau · Commune erronée']]);
  assert.deepEqual(await st(a), { follow_status: 'alert', sub_status: 'alert_erreur' });
  // minutes later ZR puts it out for delivery again, the old problem still next to its status
  const out = new Date(Date.now() + 1000).toISOString();
  await sync([[a, 'en_livraison', 'En livraison · Commune erronée', out]]);
  assert.deepEqual(await st(a), { follow_status: 'out_for_delivery', sub_status: null });
  assert.ok(!(await listIds('erreurs')).includes(a));
  assert.ok((await notes(a)).some((n) => /a remis le colis en livraison après l’erreur : il quitte « Erreurs »/.test(n)), JSON.stringify(await notes(a)));
  // read again: it stays on its way (never back and forth)
  await sync([[a, 'en_livraison', 'En livraison · Commune erronée', out]]);
  assert.deepEqual(await st(a), { follow_status: 'out_for_delivery', sub_status: null });
});

test('« Commune erronée » written while the parcel is out stays an error; out again later (ZR\'s new status), it leaves', async () => {
  const [b] = await parcels(1, 'out_for_delivery', 'Sortie en livraison');
  // it went out three hours ago, the livreur wrote the problem since
  const morning = new Date(Date.now() - 3 * 3_600_000).toISOString();
  await sync([[b, 'sortie_en_livraison', 'Sortie en livraison · Commune erronée', morning]]);
  assert.deepEqual(await st(b), { follow_status: 'alert', sub_status: 'alert_erreur' });
  await sync([[b, 'sortie_en_livraison', 'Sortie en livraison · Commune erronée', morning]]);
  assert.deepEqual(await st(b), { follow_status: 'alert', sub_status: 'alert_erreur' }, 'its status did not change since: still an error');
  // the next run: ZR puts it out again (a new status time), the problem still written
  await sync([[b, 'sortie_en_livraison', 'Sortie en livraison · Commune erronée', new Date(Date.now() + 1000).toISOString()]]);
  assert.deepEqual(await st(b), { follow_status: 'out_for_delivery', sub_status: null });
});

test('the error read again with the same words stays in « Erreurs »', async () => {
  const [a] = await parcels(1, 'out_for_delivery', 'Sortie en livraison');
  await sync([[a, 'sortie_en_livraison', 'Sortie en livraison · Commune erronée']]);
  await sync([[a, 'sortie_en_livraison', 'Sortie en livraison · Commune erronée']]);
  assert.deepEqual(await st(a), { follow_status: 'alert', sub_status: 'alert_erreur' });
});

test('« Livrée », then ZR corrects it (« Retourné »): the parcel follows, said in its history; one ZR already paid stays « Livrée »', async () => {
  const [d, e] = await parcels(2, 'out_for_delivery', 'Sortie en livraison');
  await sync([[d, 'livre', 'Livré'], [e, 'livre', 'Livré']]);
  assert.equal((await st(d)).follow_status, 'delivered');
  assert.equal((await st(e)).follow_status, 'delivered');
  // ZR paid e: its money is in a caisse
  await db.query('UPDATE orders SET cashed = true WHERE id = $1', [e]);
  await sync([[d, 'retourne', 'Retourné'], [e, 'retourne', 'Retourné']]);
  assert.equal((await st(d)).follow_status, 'returning');
  assert.equal((await st(e)).follow_status, 'delivered', 'paid by ZR: final');
  assert.ok((await notes(d)).some((n) => /^Correction de .+ : « Livrée » → « Retour en cours »$/.test(n)), JSON.stringify(await notes(d)));
});

test('the livreur taps « Livré » by mistake, then the customer cancels: the parcel becomes an alert, like any cancel on the way', async () => {
  const [f] = await parcels(1, 'out_for_delivery', 'Sortie en livraison');
  await sync([[f, 'livre', 'Livré']]);
  await sync([[f, 'sortie_en_livraison', 'Sortie en livraison · Commande annulée']]);
  assert.deepEqual(await st(f), { follow_status: 'alert', sub_status: null });
  assert.ok((await notes(f)).some((n) => /« Livrée » → « Alerte »/.test(n)));
});

test('« Annulée » after it left, then ZR says « Livré »: it becomes « Livrée »; one already back at the depot is not followed', async () => {
  const [g, h] = await parcels(2, 'cancelled', 'Retourné');
  await db.query('UPDATE orders SET returned_at = now() WHERE id = $1', [h]);
  await sync([[g, 'livre', 'Livré'], [h, 'livre', 'Livré']]);
  assert.equal((await st(g)).follow_status, 'delivered');
  assert.equal((await st(h)).follow_status, 'cancelled', 'back at the depot: final');
  assert.ok((await notes(g)).some((n) => /« Annulée » → « Livrée »/.test(n)));
});

test('an « En retour » ZR gave itself follows ZR back on the road; the Suivi’s own « En retour » waits for the depot', async () => {
  const [i, j] = await parcels(2, 'out_for_delivery', 'Sortie en livraison');
  await sync([[i, 'retourne', 'Retourné']]);
  assert.equal((await st(i)).follow_status, 'returning');
  // j: the Suivi marked it « En retour » by hand
  await db.query(`UPDATE orders SET follow_status = 'returning' WHERE id = $1`, [j]);
  await db.query(`INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, note) VALUES ($1, $2, 'follow_status', 'out_for_delivery', 'returning', 'Client injoignable')`, [j, me]);
  await sync([[i, 'en_livraison', 'En livraison'], [j, 'en_livraison', 'En livraison']]);
  assert.equal((await st(i)).follow_status, 'out_for_delivery');
  assert.equal((await st(j)).follow_status, 'returning');
  assert.ok((await notes(i)).some((n) => /« Retour en cours » → « En livraison »/.test(n)));
});

test('the same words read again never move a finished parcel (only a new word from ZR is a correction)', async () => {
  // « Livrée » in Pilotix while ZR still says « Sortie en livraison », as it already did
  const [k] = await parcels(1, 'delivered', 'Sortie en livraison');
  await sync([[k, 'sortie_en_livraison', 'Sortie en livraison']]);
  assert.equal((await st(k)).follow_status, 'delivered');
});

test('« Actualiser » on a delivered parcel (and a webhook) reads ZR’s correction at once', async () => {
  const [m] = await parcels(1, 'out_for_delivery', 'Sortie en livraison');
  await sync([[m, 'livre', 'Livré']]);
  assert.equal((await st(m)).follow_status, 'delivered');
  await call('delivery.syncOne', await zrSays([[m, 'retourne', 'Retourné']]), { orderId: m });
  assert.equal((await st(m)).follow_status, 'returning');
});

test('the fast sync (every 5 minutes) leaves the finished parcels to the full one', async () => {
  const [n] = await parcels(1, 'out_for_delivery', 'Sortie en livraison');
  await sync([[n, 'livre', 'Livré']]);
  await call('delivery.sync', await zrSays([[n, 'retourne', 'Retourné']]), { companyId: zr, fast: true });
  assert.equal((await st(n)).follow_status, 'delivered');
  await sync([[n, 'retourne', 'Retourné']]);
  assert.equal((await st(n)).follow_status, 'returning');
});
