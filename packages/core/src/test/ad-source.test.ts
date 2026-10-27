// Which ad brought an order: the ad id the link carried (utm), its name from the ads Pilotix reads, and the search by id.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
before(async () => {
  const s = await setup(30);
  db = s.db;
  admin = await s.as(EMAILS.admin);
});

test('orders: the ad id and name, and the search by ad / ad set / campaign id', async () => {
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.active AND NOT p.is_service ORDER BY p.id LIMIT 1`))[0];
  await db.query(`INSERT INTO ads (id, adset_id, name) VALUES ('120211111111111111', '120222222222222222', 'Vidéo poussette V2') ON CONFLICT (id) DO NOTHING`);
  const o: any = await call('orders.create', admin, {
    customerName: 'Pub Test',
    phone: '0661909090',
    wilayaId: 16,
    commune: 'Kouba',
    items: [{ productId: Number(p.id), variantId: Number(p.vid), qty: 1 }],
    utm: { utm_source: 'facebook', utm_campaign: 'Poussettes', utm_content: 'video', ad_id: '120211111111111111', adset_id: '120222222222222222', campaign_id: '120233333333333333' },
  });
  assert.equal(o.utm.ad_id, '120211111111111111');
  assert.equal(o.adName, 'Vidéo poussette V2');
  for (const q of ['120211111111111111', '120222222222222222', '120233333333333333']) {
    const r: any = await call('orders.list', admin, { q });
    assert.deepEqual(r.rows.map((x: any) => x.id), [o.id], q);
  }
  const none: any = await call('orders.list', admin, { q: '120299999999999999' });
  assert.equal(none.rows.length, 0);
});
