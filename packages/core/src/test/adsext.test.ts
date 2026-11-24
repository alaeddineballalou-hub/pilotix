// The Pilotix extension in Meta's Ads Manager: next to each ad, Pilotix's numbers for it (orders that came by its link,
// confirmed, delivered, what one confirmed order cost) and where that cost stands against its product's bid limit.
// A marketer sees only the ads of their own ad sets.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { setRaw } from '../modules/admin';
import { bidLevel } from '../modules/adsext';
import { BID_LIMITS_KEY } from '../modules/adslaunch';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let mk: Ctx;
let pou: number;
const AD1 = '120200000000000001';
const AD2 = '120200000000000002';
const AD3 = '120200000000000003';

before(async () => {
  const s = await setup(40);
  db = s.db;
  admin = await s.as(EMAILS.admin);
  mk = await s.as(EMAILS.marketer);
  pou = Number((await db.query(`SELECT id FROM products WHERE sku = 'PX-POU'`))[0].id);
  const today = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
  await db.query(`INSERT INTO fx_rates (ym, rate) VALUES ($1, 250) ON CONFLICT (ym) DO UPDATE SET rate = 250`, [today.slice(0, 7)]);
  await db.query(`INSERT INTO adsets (id, name, campaign, product_ids, marketer_id, status, currency) VALUES ('AX-1', 'Poussette', 'TEST', $1, $2, 'ACTIVE', 'USD'), ('AX-2', 'Autre', 'TEST', '{}', NULL, 'ACTIVE', 'USD')`, [[pou], mk.session.profile.id]);
  await db.query(`INSERT INTO ads (id, adset_id, name, status) VALUES ($1, 'AX-1', 'Poussette POV 1', 'ACTIVE'), ($2, 'AX-1', 'Poussette POV 2', 'ACTIVE'), ($3, 'AX-2', 'Autre pub', 'ACTIVE')`, [AD1, AD2, AD3]);
  // today: 20 $ on the first ad (5,000 DA at 250), 4 $ on the second, 10 $ on the other ad set's; 40 days ago: not counted
  await db.query(
    `INSERT INTO ad_daily (day, ad_id, adset_id, spend_cents) VALUES ($1, $2, 'AX-1', 2000), ($1, $3, 'AX-1', 400), ($1, $4, 'AX-2', 1000), ($5, $2, 'AX-1', 99900)`,
    [today, AD1, AD2, AD3, new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10)],
  );
  // five orders by the first ad's link: three confirmed (one of them delivered), one cancelled, one to call
  const ids = (await db.query(`SELECT id FROM sales ORDER BY id DESC LIMIT 5`)).map((r: any) => Number(r.id));
  await db.query(`UPDATE orders SET utm = $2, created_at = now(), conf_status = 'confirmed', follow_status = NULL WHERE id = ANY($1)`, [ids.slice(0, 3), JSON.stringify({ ad_id: AD1 })]);
  await db.query(`UPDATE orders SET follow_status = 'delivered' WHERE id = $1`, [ids[0]]);
  await db.query(`UPDATE orders SET utm = $2, created_at = now(), conf_status = 'cancelled', follow_status = NULL WHERE id = $1`, [ids[3], JSON.stringify({ ad_id: AD1 })]);
  await db.query(`UPDATE orders SET utm = $2, created_at = now(), conf_status = 'new', follow_status = NULL WHERE id = $1`, [ids[4], JSON.stringify({ ad_id: AD1 })]);
  await setRaw(db, BID_LIMITS_KEY, { [String(pou)]: 1500 });
});

test('the levels: under the bid limit, above it, past the alert limit (× 1.33), past the stop limit (× 1.58)', () => {
  assert.equal(bidLevel(3000, 3, 1500), 'good');
  assert.equal(bidLevel(5000, 3, 1500), 'over');
  assert.equal(bidLevel(6600, 3, 1500), 'alert');
  assert.equal(bidLevel(9000, 3, 1500), 'stop');
  assert.equal(bidLevel(1000, 0, 1500), null, 'no confirmed order yet, less than the bid limit spent: not judged');
  assert.equal(bidLevel(1800, 0, 1500), 'over', 'more than the bid limit spent with no confirmed order');
  assert.equal(bidLevel(2500, 0, 1500), 'stop');
  assert.equal(bidLevel(3000, 3, null), null, 'no bid limit typed');
});

test('each ad’s numbers over the last days, by its id or its name; a marketer sees only their own ad sets', async () => {
  const r: any = await call('ads.extNumbers', admin, { adIds: [AD1], names: ['poussette pov 2'], days: 7 });
  const a1 = r.ads.find((a: any) => a.id === AD1);
  assert.deepEqual([a1.orders, a1.confirmed, a1.delivered, a1.spendDzd, a1.costConfirmed, a1.bidLimit, a1.level, a1.productId], [5, 3, 1, 5000, 1667, 1500, 'over', pou]);
  const a2 = r.ads.find((a: any) => a.id === AD2);
  assert.deepEqual([a2.orders, a2.spendDzd, a2.costConfirmed, a2.level], [0, 1000, null, null], 'the old spend is out of the 7 days');
  assert.ok(r.ads.some((a: any) => a.id === AD3 && a.bidLimit === null), 'the owner sees every ad that spent');
  const m: any = await call('ads.extNumbers', mk, { adIds: [AD1, AD3], days: 7 });
  const seen = m.ads.map((a: any) => a.id);
  assert.ok(seen.includes(AD1) && seen.includes(AD2) && !seen.includes(AD3), 'their own ad sets only (the other ad set is not theirs)');
  await assert.rejects(call('ads.extNumbers', await (await setup(5)).as(EMAILS.livreur), {}), /Accès refusé/);
});
