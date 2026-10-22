// Marketing › Marketer: lifetime result per ad set, who sees what, hand-set results, prices, payments.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call } from '../index';
import { isOpen, STALE_DAYS } from '../modules/marketers';
import { EMAILS, setup } from './harness';

test('marketer payments: results, rules, assign, force, pay and unpay', async () => {
  const { as } = await setup(500);
  const owner = await as(EMAILS.vendeur);
  const mk = await as(EMAILS.marketer);

  // others cannot open it
  await assert.rejects(call('mk.overview', await as(EMAILS.depot), {}), (e: any) => e.code === 'forbidden');

  const ov: any = await call('mk.overview', owner, {});
  assert.equal(ov.owner, true);
  assert.deepEqual(ov.rules, { seuil: 0.3, mult: 3 });
  const ids = ov.rows.map((r: any) => r.id);
  for (const id of ['120200006', '120200007', '120200008']) assert.ok(ids.includes(id), `stopped ad set ${id} listed`);
  const lyes = ov.marketers.find((m: any) => m.price === 15000);
  assert.ok(lyes, 'marketer price seeded');

  // every figure is consistent with the rules
  for (const r of ov.rows) {
    assert.ok(Math.abs(r.net - (r.avant - r.spDa)) <= 2, 'net = before ads − spend');
    assert.ok(r.n >= r.d - 1e-9, 'delivered ≤ orders');
    if (r.status === 'ACTIVE' && !r.manual) assert.equal(r.final, false, 'an active ad set is not judged');
    if (r.okShare) assert.ok(r.marge > 0 && r.ratio >= 0.3);
    if (!r.marketerId) assert.equal(r.owe, null);
    if (r.final && r.ok && r.marketerId) assert.equal(r.owe, r.price);
    if (r.final && !r.ok) assert.ok(r.owe === 0 || r.owe === null);
  }

  // the marketer only sees his own ad sets and cannot change anything
  const mine: any = await call('mk.overview', mk, {});
  assert.equal(mine.owner, false);
  assert.ok(mine.rows.length >= 1);
  assert.ok(mine.rows.every((r: any) => r.marketerId === mine.marketers[0].id));
  assert.ok(!mine.rows.some((r: any) => r.id === '120200008'));
  await assert.rejects(call('mk.force', mk, { ids: ['120200006'], st: 'ok' }), (e: any) => e.code === 'forbidden');
  await assert.rejects(call('mk.pay', mk, { ids: ['120200006'] }), (e: any) => e.code === 'forbidden');

  // give the unassigned ad set to the marketer, force it réussi, pay it, cancel the payment
  await call('mk.assign', owner, { ids: ['120200008'], marketerId: lyes.id });
  await call('mk.force', owner, { ids: ['120200008'], st: 'ok' });
  let a: any = ((await call('mk.overview', owner, {})) as any).rows.find((r: any) => r.id === '120200008');
  assert.equal(a.marketerId, lyes.id);
  assert.equal(a.final, true);
  assert.equal(a.ok, true);
  assert.equal(a.owe, 15000);
  const paid: any = await call('mk.pay', owner, { ids: ['120200008'] });
  assert.deepEqual([paid.n, paid.total], [1, 15000]);
  await assert.rejects(call('mk.pay', owner, { ids: ['120200008'] }), /Rien à payer/);
  // once paid, it stays a success even when the hand-set result is removed
  await call('mk.force', owner, { ids: ['120200008'], st: null });
  a = ((await call('mk.overview', owner, {})) as any).rows.find((r: any) => r.id === '120200008');
  assert.equal(a.paid.amount, 15000);
  assert.equal(a.ok, true);
  await call('mk.unpay', owner, { id: '120200008' });
  a = ((await call('mk.overview', owner, {})) as any).rows.find((r: any) => r.id === '120200008');
  assert.equal(a.paid, null);

  // raté by hand: nothing owed
  await call('mk.force', owner, { ids: ['120200007'], st: 'ko' });
  a = ((await call('mk.overview', owner, {})) as any).rows.find((r: any) => r.id === '120200007');
  assert.equal(a.ok, false);
  assert.equal(a.owe, 0);
  await assert.rejects(call('mk.pay', owner, { ids: ['120200007'] }), /Rien à payer/);

  // price and rules
  await call('mk.price', owner, { marketerId: lyes.id, price: 20000 });
  await call('mk.force', owner, { ids: ['120200006'], st: 'ok' });
  a = ((await call('mk.overview', owner, {})) as any).rows.find((r: any) => r.id === '120200006');
  assert.equal(a.owe, 20000);
  await call('mk.rules', owner, { seuil: 0.5, mult: 0 });
  const after: any = await call('mk.overview', owner, {});
  assert.deepEqual(after.rules, { seuil: 0.5, mult: 0 });
  assert.ok(after.rows.every((r: any) => r.okBig === false), 'the × price rule is off');

  // ad set page
  const det: any = await call('mk.adset', owner, { id: '120200006' });
  assert.equal(det.row.id, '120200006');
  assert.equal(det.orders30.length, 30);
  assert.ok(det.ads.length >= 1);
  assert.ok('lpvRate' in det.ads[0] && 'conv' in det.ads[0]);
  await assert.rejects(call('mk.adset', mk, { id: '120200004' }), (e: any) => e.code === 'not_found');
});

test('marketer payments: whole life, forgotten confirmations, missing dollar rate', async () => {
  const { db, as } = await setup(500);
  const owner = await as(EMAILS.vendeur);

  // the whole life: from the first day of Meta results, not only the last 6 months
  const first = (await db.query('SELECT min(day)::text AS d FROM ad_insights'))[0].d;
  const ov: any = await call('mk.overview', owner, {});
  assert.equal(ov.from, first);
  assert.deepEqual(ov.fxMissing, []);

  // an order still in confirmation stops counting as open after STALE_DAYS; a confirmed one waits for its parcel
  const now = Date.now();
  const old = new Date(now - (STALE_DAYS + 1) * 86_400_000).toISOString();
  const recent = new Date(now - 2 * 86_400_000).toISOString();
  assert.equal(isOpen({ conf_status: 'no_answer', follow_status: null, created_at: old }, now), false);
  assert.equal(isOpen({ conf_status: 'no_answer', follow_status: null, created_at: recent }, now), true);
  assert.equal(isOpen({ conf_status: 'confirmed', follow_status: 'shipped', created_at: old }, now), true);
  assert.equal(isOpen({ conf_status: 'confirmed', follow_status: 'delivered', created_at: recent }, now), false);

  // a month with spend and no dollar rate of its own: not judged, not payable, even when forced réussi
  const a0: any = ov.rows.find((r: any) => r.id === '120200006');
  const ym = a0.months[0];
  await db.query('DELETE FROM fx_rates WHERE ym = $1', [ym]);
  await call('mk.force', owner, { ids: ['120200006'], st: 'ok' });
  const after: any = await call('mk.overview', owner, {});
  const a1 = after.rows.find((r: any) => r.id === '120200006');
  assert.ok(a1.fxMissing.includes(ym));
  assert.ok(after.fxMissing.includes(ym));
  assert.equal(a1.finalAuto, false);
  assert.equal(a1.owe, null);
  await assert.rejects(call('mk.pay', owner, { ids: ['120200006'] }), /Rien à payer/);
  // the rate entered again: payable
  await call('ads.setFx', owner, { ym, rate: 247 });
  const back: any = ((await call('mk.overview', owner, {})) as any).rows.find((r: any) => r.id === '120200006');
  assert.deepEqual(back.fxMissing, []);
  assert.ok(back.owe > 0);
});
