// Landing pages › Événements: one card per page (what the server sent for it, by type, day by day), filtered by
// platform and period; the list of one page's events.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let marketer: Ctx;
let conf: Ctx;
let pageA: number;
let pageB: number;
const NOW = Date.parse('2026-11-19T10:00:00Z');
const H = 3_600_000;
const at = (ctx: Ctx): Ctx => ({ ...ctx, now: () => NOW });
let seq = 0;
const ev = (landing: number | null, name: string, status: string, platform: string, agoH: number) =>
  db.query(`INSERT INTO meta_events (pixel_id, event_name, event_id, landing_id, status, platform, at, send_after) VALUES ('777', $1, $2, $3, $4, $5, $6, $6)`, [
    name,
    `stats-${seq++}`,
    landing,
    status,
    platform,
    new Date(NOW - agoH * H),
  ]);

before(async () => {
  const s = await setup(60);
  db = s.db;
  marketer = at(await s.as(EMAILS.marketer));
  conf = at(await s.as(EMAILS.conf));
  await db.query('DELETE FROM meta_events');
  const p = await db.query(`SELECT id FROM products ORDER BY id LIMIT 2`);
  pageA = (await call('landing.save', marketer, { productId: Number(p[0].id), slug: 'stats-a', title: 'Page A', price: 9950 })).id;
  pageB = (await call('landing.save', marketer, { productId: Number(p[1].id), slug: 'stats-b', title: 'Page B', price: 4500 })).id;
  await ev(pageA, 'Purchase', 'sent', 'meta', 1);
  await ev(pageA, 'Purchase', 'sent', 'tiktok', 1);
  await ev(pageA, 'Lead', 'sent', 'meta', 2);
  await ev(pageA, 'InitiateCheckout', 'sent', 'meta', 26); // yesterday
  await ev(pageA, 'InitiateCheckout', 'skipped', 'meta', 3);
  await ev(pageA, 'Purchase', 'failed', 'tiktok', 3);
  await ev(pageA, 'Purchase', 'sent', 'meta', 24 * 20); // 20 days ago
  await ev(pageB, 'FakeOrder', 'sent', 'meta', 2);
  await ev(pageB, 'Competitor', 'sent', 'meta', 2);
  await ev(pageB, 'Lead', 'queued', 'meta', 2);
  await ev(null, 'Purchase', 'sent', 'chat', 2); // a sale made in a conversation: no page
});

test('one card per page: what was sent by type, skipped, failed, waiting, and both platforms', async () => {
  const r = await call('landing.eventStats', marketer, { days: 14 });
  assert.equal(r.days, 14);
  const a = r.cards.find((c: any) => c.id === pageA)!;
  assert.deepEqual([a.slug, a.title, a.purchase, a.lead, a.checkout, a.fake, a.sent, a.skipped, a.failed, a.waiting, a.meta, a.tiktok], ['stats-a', 'Page A', 2, 1, 1, 0, 4, 1, 1, 0, true, true]);
  assert.equal(r.cards[0].id, pageA, 'the busiest page first');
  const b = r.cards.find((c: any) => c.id === pageB)!;
  assert.deepEqual([b.fake, b.sent, b.waiting, b.tiktok], [2, 2, 1, false]);
  const none = r.cards.find((c: any) => c.id === 0)!;
  assert.deepEqual([none.slug, none.purchase, none.meta], [null, 1, true], 'a sale made in a conversation has no page: its own card, on Meta');
});

test('day by day, in Algiers time: 14 days ending today; an older event is outside the period', async () => {
  const a = (await call('landing.eventStats', marketer, { days: 14 })).cards.find((c: any) => c.id === pageA)!;
  assert.equal(a.series.length, 14);
  assert.equal(a.series[13].day, '2026-11-19');
  assert.deepEqual([a.series[13].purchase, a.series[13].lead, a.series[12].checkout], [2, 1, 1]);
  const month = (await call('landing.eventStats', marketer, { days: 30 })).cards.find((c: any) => c.id === pageA)!;
  assert.equal(month.purchase, 3, '30 days reach the sale of 20 days ago');
  const today = (await call('landing.eventStats', marketer, { days: 1 })).cards.find((c: any) => c.id === pageA)!;
  assert.deepEqual([today.checkout, today.series.length], [0, 1], 'today only: yesterday’s event is out');
});

test('one platform: TikTok alone, Meta alone (a conversation’s sale goes to Meta)', async () => {
  const tt = await call('landing.eventStats', marketer, { days: 14, platform: 'tiktok' });
  assert.deepEqual(tt.cards.map((c: any) => [c.id, c.purchase, c.failed, c.meta]), [[pageA, 1, 1, false]]);
  const meta = await call('landing.eventStats', marketer, { days: 14, platform: 'meta' });
  assert.equal(meta.cards.find((c: any) => c.id === pageA)!.purchase, 1);
  assert.ok(meta.cards.some((c: any) => c.id === 0));
});

test('the list of one page: its events only, with their platform; the old list (no filter) still gives everything', async () => {
  const a = await call('landing.events', marketer, { landingId: pageA, days: 14 });
  assert.equal(a.rows.length, 6);
  assert.ok(a.rows.every((e: any) => e.slug === 'stats-a'));
  assert.equal(a.rows.filter((e: any) => e.platform === 'tiktok').length, 2);
  assert.equal((await call('landing.events', marketer, { landingId: pageA, days: 14, platform: 'tiktok' })).rows.length, 2);
  assert.equal((await call('landing.events', marketer, { landingId: 0 })).rows.length, 1);
  assert.equal((await call('landing.events', marketer, {})).rows.length, 11);
});

test('an agent cannot read the events', async () => {
  await assert.rejects(call('landing.eventStats', conf, { days: 14 }));
});
