// Dépôt › Dispatchées (the owner's rule, 22 Nov 2026): a parcel handed over stays in the list while its company says
// nothing after « Prêt à expédier »; as soon as the company says it has it (ZR: « Confirmé au bureau », « Vers wilaya »,
// any other word), it leaves the list, its count and the pickup bags' waiting list — bag or no bag — and stays on the
// road for the Suivi. The courier is faked here, answering with ZR's own state keys.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { companyHasIt } from '../modules/delivery';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(300));
});

const one = async (sql: string, args: unknown[] = []) => (await db.query(sql, args))[0];
type Says = Record<number, { key?: string; status: string }>;
/** ZR, its API keys set, answering each parcel with its word (« Prêt à expédier » when nothing is said). */
const zrSays = (says: Says) =>
  ({
    courier: async (action: string, args: any) =>
      action === 'track' ? args.items.map((x: any) => ({ id: x.id, ...(says[x.id] ?? { key: 'pret_a_expedier', status: 'Prêt à expédier' }), at: null })) : [],
  }) as any;

let zr = 0;
/** parcels a test already used (each test takes new ones) */
const used: number[] = [];
/** ZR parcels just handed over by the depot (Dispatchées): ZR still says « Prêt à expédier », none in a bag. */
async function handedOver(n: number) {
  zr ||= Number((await one(`SELECT id FROM delivery_companies WHERE kind = 'zr' ORDER BY id LIMIT 1`)).id);
  await db.query(`UPDATE delivery_companies SET credentials = '{"api_key":"k","tenant":"t"}', active = true WHERE id = $1`, [zr]);
  const ids = (
    await db.query(
      `SELECT id FROM orders WHERE company_id = $1 AND tracking IS NOT NULL AND NOT is_exchange AND id <> ALL($3)
         AND follow_status IN ('shipped','out_for_delivery','failed','delivered','returned')
       ORDER BY id LIMIT $2`,
      [zr, n, used],
    )
  ).map((r: any) => Number(r.id));
  assert.equal(ids.length, n, `${n} ZR parcels`);
  used.push(...ids);
  await db.query(
    `UPDATE orders SET conf_status = 'confirmed', follow_status = 'shipped', sub_status = NULL, shipped_at = now(), ext_status = 'Prêt à expédier',
       ext_status_at = now() - interval '5 minutes', taken_at = NULL WHERE id = ANY($1)`,
    [ids],
  );
  await db.query('DELETE FROM pickup_bag_parcels WHERE order_id = ANY($1)', [ids]);
  return ids;
}
const sync = async (says: Says) => call('delivery.sync', await as(EMAILS.suivi, zrSays(says)), { companyId: zr });
/** What the depot sees: the Dispatchées list (computer and phone ask the same), its count, the parcels without a bag. */
async function depotSees() {
  const depot = await as(EMAILS.depot);
  const list: any = await call('orders.list', depot, { follow: ['shipped'], conf: ['confirmed'], taken: false, tickets: 'include', pageSize: 3000 });
  const counts: any = await call('depot.counts', depot, {});
  const noBag: any = await call('pickup.waiting', depot, { companyId: zr });
  return { list: new Set<number>(list.rows.map((o: any) => o.id)), total: list.total as number, count: counts.dispatchees as number, noBag: new Set<number>(noBag.map((o: any) => o.id)) };
}

test('a parcel leaves Dispatchées as soon as ZR has it (« Confirmé au bureau », « Vers wilaya »), bag or no bag; the Suivi keeps it', async () => {
  const [a, b, c] = await handedOver(3);
  // c goes in a pickup bag (optional): it waits in Dispatchées all the same
  const made: any = await call('pickup.create', await as(EMAILS.depot), { companyId: zr, ids: [c] });
  assert.equal(made.added, 1);
  await sync({});
  let s = await depotSees();
  assert.ok([a, b, c].every((x) => s.list.has(x)), 'ZR says « Prêt à expédier »: all three wait in Dispatchées');
  assert.equal(s.count, s.total, 'the stage count is the list');
  assert.ok(s.noBag.has(a) && s.noBag.has(b) && !s.noBag.has(c), 'c is in a bag, a and b are not');
  const before = s.count;

  await sync({ [a]: { key: 'confirme_au_bureau', status: 'Confirmé au bureau' }, [c]: { key: 'vers_wilaya', status: 'Dispatch dans une autre wilaya' } });
  s = await depotSees();
  assert.ok(!s.list.has(a) && !s.list.has(c), 'ZR has a (no bag) and c (in a bag): both leave');
  assert.ok(s.list.has(b), 'b: still « Prêt à expédier »');
  assert.equal(s.count, before - 2);
  assert.equal(s.count, s.total);
  assert.ok(!s.noBag.has(a) && s.noBag.has(b), 'taken by ZR: no bag needed any more');
  // still on the road (Suivi › En livraison), with ZR's word, and when ZR took it
  const rows = await db.query('SELECT id, follow_status, ext_status, taken_at FROM orders WHERE id = ANY($1) ORDER BY id', [[a, b, c]]);
  const row = (x: number) => rows.find((r: any) => Number(r.id) === x);
  assert.deepEqual([row(a).follow_status, row(c).follow_status], ['shipped', 'shipped']);
  assert.ok(row(a).taken_at && row(c).taken_at && !row(b).taken_at);
  assert.equal(row(c).ext_status, 'Dispatch dans une autre wilaya');
  const taken: any = await call('orders.list', await as(EMAILS.suivi), { follow: ['shipped'], taken: true, tickets: 'include', pageSize: 3000 });
  assert.ok([a, c].every((x) => taken.rows.some((o: any) => o.id === x)));

  // asked again with the same words: kept once, nothing comes back
  const at = String(row(a).taken_at);
  await sync({ [a]: { key: 'confirme_au_bureau', status: 'Confirmé au bureau' }, [c]: { key: 'vers_wilaya', status: 'Dispatch dans une autre wilaya' } });
  assert.equal(String((await one('SELECT taken_at FROM orders WHERE id = $1', [a])).taken_at), at);
  assert.ok(!(await depotSees()).list.has(a));
});

test('ZR’s words before pickup keep the parcel; any other word, even one Pilotix does not know, takes it out', async () => {
  const [a, b, c, d] = await handedOver(4);
  await sync({
    [a]: { key: 'commande_recue', status: 'Commande reçue' },
    [b]: { key: 'annule', status: 'Annulé' },
    [c]: { key: 'en_attente_dechange', status: 'En attente d’échange' },
    [d]: { key: 'dispatch', status: 'Dispatch dans la même wilaya' },
  });
  const s = await depotSees();
  assert.ok(s.list.has(a) && s.list.has(b), 'before pickup (and ZR’s own « Annulé »): still to check in Dispatchées');
  assert.ok(!s.list.has(c) && !s.list.has(d), 'a word after « Prêt à expédier », known or not: ZR has it');
  // the rule itself
  assert.equal(companyHasIt({ status: 'Prêt à expédier' }, null), false);
  assert.equal(companyHasIt({ status: '' }, undefined), false, 'no word: nothing said');
  assert.equal(companyHasIt({ status: 'Préparé' }, 'prepared'), false);
  assert.equal(companyHasIt({ status: 'Vers wilaya' }, 'shipped'), true);
  assert.equal(companyHasIt({ status: 'Livré' }, 'delivered'), true);
  assert.equal(companyHasIt({ status: 'Mot inconnu' }, undefined), true);
});

test('a parcel ZR took before the depot’s scan skips Dispatchées after the scan; cancelled at ZR, the mark goes', async () => {
  const [a] = await handedOver(1);
  await db.query(`UPDATE orders SET follow_status = 'prepared', shipped_at = NULL WHERE id = $1`, [a]);
  await sync({ [a]: { key: 'vers_wilaya', status: 'Dispatch dans une autre wilaya' } });
  const r1 = await one('SELECT follow_status, sub_status, taken_at FROM orders WHERE id = $1', [a]);
  assert.equal(r1.follow_status, 'prepared', 'it waits « En dispatch » for the scan (the 9 Nov rule)');
  assert.equal(r1.sub_status, 'pris_sans_scan');
  assert.ok(r1.taken_at);
  await call('orders.setFollow', await as(EMAILS.depot), { ids: [a], status: 'shipped' });
  assert.equal((await one('SELECT follow_status FROM orders WHERE id = $1', [a])).follow_status, 'shipped');
  assert.ok(!(await depotSees()).list.has(a), 'scanned: straight to the road, not in Dispatchées');

  // back « En dispatch » and its parcel cancelled at the company: a new parcel will be waited for again
  await db.query(`UPDATE orders SET follow_status = 'prepared', shipped_at = NULL, sub_status = NULL WHERE id = $1`, [a]);
  await call('delivery.cancel', await as(EMAILS.depot), { orderId: a });
  const r2 = await one('SELECT tracking, ext_status, taken_at FROM orders WHERE id = $1', [a]);
  assert.deepEqual([r2.tracking, r2.ext_status, r2.taken_at], [null, null, null]);
});
