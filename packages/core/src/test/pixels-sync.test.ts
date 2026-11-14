// Réglages › Pixels takes in the pixels of the boutique's connected Meta ad accounts by itself; a pixel already there is
// left alone, none is removed, and they stay when Meta is disconnected.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
const asked: string[] = [];
let onMeta: { id: string; name: string; account: string }[] = [];
const server = {
  meta: async (action: string) => {
    asked.push(action);
    if (action === 'pixels') return onMeta;
    return {};
  },
} as unknown as Ctx['server'];

before(async () => {
  const s = await setup(5);
  db = s.db;
  as = s.as;
});

const metaRows = async (): Promise<[string, string, boolean][]> => (await db.query(`SELECT name, pixel_id, is_default FROM tracking_pixels WHERE platform = 'meta' ORDER BY pixel_id`)).map((r: any) => [String(r.name), String(r.pixel_id), !!r.is_default]);

test('pixels come from the connected Meta ad accounts, stay, and are never changed or removed', async () => {
  const before = await metaRows();
  const m = await as(EMAILS.marketer, server);
  // not connected: nothing asked
  await db.query(`INSERT INTO settings (key, value) VALUES ('meta', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ adAccountId: '', adAccountIds: [], hasToken: false })]);
  assert.deepEqual(await call('landing.pixelsSync', m, {}), { connected: false, found: 0, added: 0, madeDefault: null });
  assert.equal(asked.length, 0);
  // connected: two ad accounts, three pixels (one already in the list under the shop's own name, one on both accounts)
  await db.query(`UPDATE settings SET value = $1 WHERE key = 'meta'`, [JSON.stringify({ adAccountId: '111', adAccountIds: ['111', '222'], hasToken: true })]);
  const mine = before[0]?.[1] ?? '1234567890123456';
  if (!before.length) await db.query(`INSERT INTO tracking_pixels (platform, name, pixel_id) VALUES ('meta', 'Mon pixel', $1)`, [mine]);
  onMeta = [
    { id: '9000000000000001', name: 'Baby Joy Pixel', account: '111' },
    { id: mine, name: 'Nom chez Meta', account: '111' },
    { id: '9000000000000002', name: '', account: '222' },
    { id: '9000000000000001', name: 'Baby Joy Pixel', account: '222' },
  ];
  await db.query(`UPDATE tracking_pixels SET is_default = false WHERE platform = 'meta'`);
  assert.deepEqual(await call('landing.pixelsSync', m, {}), { connected: true, found: 3, added: 2, madeDefault: 'Baby Joy Pixel' });
  const rows = await metaRows();
  // no default before: the first one Meta gave is the default now, and only it
  assert.deepEqual(rows.filter(([, , d]) => d).map(([, id]) => id), ['9000000000000001']);
  assert.ok(rows.some(([n, id]) => id === '9000000000000001' && n === 'Baby Joy Pixel'));
  assert.ok(rows.some(([n, id]) => id === '9000000000000002' && n === 'Pixel 9000000000000002'));
  // the one already there keeps the shop's name
  assert.equal(rows.find(([, id]) => id === mine)![0], before.find(([, id]) => id === mine)?.[0] ?? 'Mon pixel');
  // the picker sees them
  const list: any[] = await call('landing.pixels', m, {});
  assert.ok(list.some((p) => p.pixelId === '9000000000000001' && p.platform === 'meta'));
  // asked again within 10 minutes: not again (unless forced)
  const n = asked.length;
  assert.deepEqual(await call('landing.pixelsSync', m, {}), { connected: true, found: -1, added: 0, madeDefault: null });
  assert.equal(asked.length, n);
  // a pixel gone from Meta stays; forced: asked at once
  // the shop picks another default: Meta never changes it back
  await db.query(`UPDATE tracking_pixels SET is_default = (pixel_id = '9000000000000002') WHERE platform = 'meta'`);
  assert.deepEqual(await call('landing.pixelsSync', m, { force: true }), { connected: true, found: 3, added: 0, madeDefault: null });
  const chosen = await metaRows();
  assert.deepEqual(chosen.filter(([, , d]) => d).map(([, id]) => id), ['9000000000000002']);
  onMeta = [];
  assert.deepEqual(await call('landing.pixelsSync', m, { force: true }), { connected: true, found: 0, added: 0, madeDefault: null });
  // Meta disconnected: they stay
  await db.query(`UPDATE settings SET value = $1 WHERE key = 'meta'`, [JSON.stringify({ adAccountId: '', adAccountIds: [], hasToken: false })]);
  assert.deepEqual(await metaRows(), chosen);
  // agents (confirmation) cannot
  await assert.rejects(() => as(EMAILS.conf, server).then((c) => call('landing.pixelsSync', c, {})));
});
