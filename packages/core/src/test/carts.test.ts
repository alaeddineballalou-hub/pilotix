// Abandoned carts and the team's confirmation rate (the owner's rule, 24 Nov 2026): a cart (`came` abandoned or
// recovered) counts in the team's numbers only once confirmed; cancelled, fake or still to call it counts for nothing.
// Landing pages › Abandonnées counts them all, and what they brought.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { cartLeftOut, teamCountsSql } from '../modules/carts';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(80));
});

const freeNew = async (n: number) =>
  (
    await db.query(
      `SELECT o.id FROM orders o WHERE o.conf_status = 'new' AND o.agent_id IS NULL AND o.follow_status IS NULL AND NOT o.is_exchange
         AND o.wilaya_id IS NOT NULL AND o.commune IS NOT NULL AND NOT o.is_stopdesk AND coalesce(o.came, '') NOT IN ('abandoned', 'recovered')
         AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id)
       ORDER BY o.id DESC LIMIT $1`,
      [n],
    )
  ).map((r: any) => Number(r.id));

test('the rule: a cart is left out unless confirmed; the other orders always count', () => {
  assert.equal(cartLeftOut('abandoned', 'cancelled'), true);
  assert.equal(cartLeftOut('recovered', 'new'), true);
  assert.equal(cartLeftOut('abandoned', 'fake'), true);
  assert.equal(cartLeftOut('abandoned', 'confirmed'), false);
  assert.equal(cartLeftOut('recovered', 'no_stock'), false);
  assert.equal(cartLeftOut('form', 'cancelled'), false);
  assert.equal(cartLeftOut(null, 'cancelled'), false);
  assert.equal(teamCountsSql('o.', 'ev.to_value'), "(o.came IS NULL OR o.came NOT IN ('abandoned','recovered') OR ev.to_value IN ('confirmed','no_stock'))");
});

test('Confirmation › Statistiques, the Accueil and Landing pages › Abandonnées', async () => {
  const admin = await as(EMAILS.admin);
  const mgr = await as(EMAILS.manager);
  // a day of its own for Confirmation › Statistiques (by creation day), a window around now for the Accueil (by event)
  const day = { per: 'custom' as const, from: '2025-03-10', to: '2025-03-10' };
  const win = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() };
  const ov0: any = await call('confirmation.overview', mgr, day);
  const home0: any = await call('stats.overview', admin, win);
  const ag0: any = await call('stats.agents', admin, win);
  const ab0: any = await call('landing.leads', admin, {});
  const me = (rows: any[]) => rows.find((r: any) => r.id === admin.session.profile.id) ?? { treated: 0, confirmed: 0 };

  // a: a cart the agent confirms · b: a cart the client refuses · c: a cart that was a fake · d: a normal order refused
  const [a, b, c, d] = await freeNew(4);
  await db.query(`UPDATE orders SET created_at = '2025-03-10T10:00:00Z' WHERE id = ANY($1)`, [[a, b, c, d]]);
  await db.query(`UPDATE orders SET came = 'abandoned' WHERE id = ANY($1)`, [[a, b]]);
  await db.query(`UPDATE orders SET came = 'recovered' WHERE id = $1`, [c]);
  await db.query(`UPDATE orders SET came = 'form' WHERE id = $1`, [d]);
  await call('orders.setConf', admin, { ids: [a], status: 'confirmed' });
  await call('orders.setConf', admin, { ids: [b, d], status: 'cancelled', reason: 'price' });
  await call('orders.setConf', admin, { ids: [c], status: 'fake', reason: 'test' });
  const aTotal = Number((await db.query('SELECT total FROM orders WHERE id = $1', [a]))[0].total);

  // Confirmation › Statistiques: the confirmed cart counts like any order, the 2 others are on their own line only
  const ov: any = await call('confirmation.overview', mgr, day);
  assert.equal(ov.received - ov0.received, 2, 'a and d');
  assert.equal(ov.confirmed.n - ov0.confirmed.n, 1);
  assert.equal(ov.refused.n - ov0.refused.n, 1, 'only d');
  assert.equal(ov.attacks.n - ov0.attacks.n, 0, 'the fake cart does not count');
  assert.deepEqual(
    { n: ov.carts.n - ov0.carts.n, confirmed: ov.carts.confirmed - ov0.carts.confirmed, value: ov.carts.value - ov0.carts.value, pending: ov.carts.pending - ov0.carts.pending },
    { n: 3, confirmed: 1, value: aTotal, pending: 0 },
  );
  if (ov0.received === 0) assert.equal(ov.leadsQuality, 50, '1 confirmed ÷ (1 + 1 refused)');

  // Accueil: the period's rate and the agents' table leave the cart refusal and the cart fake out
  const home: any = await call('stats.overview', admin, win);
  assert.equal(home.confirmed - home0.confirmed, 1);
  assert.equal(home.cancelled - home0.cancelled, 1, 'only d');
  const ag: any = await call('stats.agents', admin, win);
  assert.equal(me(ag).treated - me(ag0).treated, 2, 'a and d');
  assert.equal(me(ag).confirmed - me(ag0).confirmed, 1);

  // Landing pages › Abandonnées: every cart that became an order, and the money it brought
  await db.query(`UPDATE orders SET follow_status = 'delivered', delivered_at = now() WHERE id = $1`, [a]);
  const ab: any = await call('landing.leads', admin, {});
  assert.equal(ab.stats.orders - ab0.stats.orders, 3);
  assert.equal(ab.stats.confirmed - ab0.stats.confirmed, 1);
  assert.equal(ab.stats.confirmedValue - ab0.stats.confirmedValue, aTotal);
  assert.equal(ab.stats.delivered - ab0.stats.delivered, 1);
  assert.equal(ab.stats.deliveredValue - ab0.stats.deliveredValue, aTotal);
});
