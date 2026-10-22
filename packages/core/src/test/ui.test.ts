// Screen choices saved with the account (columns, the preset in use), and what the demo keeps across reloads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, demoRestore, demoSnapshot } from '../index';
import { EMAILS, setup } from './harness';

test('screen choices are saved per user, can be removed, and stay small', async () => {
  const { as } = await setup(20);
  const conf = await as(EMAILS.conf);
  const other = await as(EMAILS.conf2);
  assert.deepEqual(await call('me.ui', conf, {}), {});
  await call('me.setUi', conf, { key: 'cols.active', value: { id: 'p1', at: 5 } });
  await call('me.setUi', conf, { key: 'cols.t.conf-nouvelles', value: { cols: ['order', 'name'], order: ['name', 'order'], at: 9 } });
  const ui: any = await call('me.ui', conf, {});
  assert.deepEqual(ui['cols.active'], { id: 'p1', at: 5 });
  assert.deepEqual(ui['cols.t.conf-nouvelles'].cols, ['order', 'name']);
  // another user does not see them
  assert.deepEqual(await call('me.ui', other, {}), {});
  // replace and remove
  await call('me.setUi', conf, { key: 'cols.active', value: { id: 'p2', at: 7 } });
  assert.equal(((await call('me.ui', conf, {})) as any)['cols.active'].id, 'p2');
  await call('me.setUi', conf, { key: 'cols.active', value: null });
  assert.equal(((await call('me.ui', conf, {})) as any)['cols.active'], undefined);
  // limits
  await assert.rejects(call('me.setUi', conf, { key: 'bad key!', value: 1 }));
  await assert.rejects(call('me.setUi', conf, { key: 'big', value: 'x'.repeat(30_000) }), /volumineux/);
});

test('the demo keeps column presets and screen choices across a rebuilt database', async () => {
  const a = await setup(20);
  const admin = await a.as(EMAILS.admin);
  const conf = await a.as(EMAILS.conf);
  const p: any = await call('confirmation.addColPreset', admin, { name: 'Appels', cols: ['order', 'name', 'phone'] });
  await call('me.setUi', conf, { key: 'cols.active', value: { id: p.id, at: 1 } });
  const keep = JSON.parse(JSON.stringify(await demoSnapshot(a.db)));
  // a new demo database (as after a reload) gets them back
  const b = await setup(20);
  await demoRestore(b.db, keep);
  const presets: any = await call('confirmation.colPresets', await b.as(EMAILS.conf), {});
  assert.deepEqual(presets.map((x: any) => x.name), ['Appels']);
  assert.equal(((await call('me.ui', await b.as(EMAILS.conf), {})) as any)['cols.active'].id, p.id);
  assert.deepEqual(await call('me.ui', await b.as(EMAILS.conf2), {}), {});
  // bad data is ignored
  await demoRestore(b.db, { colPresets: [{ nope: 1 }] as any, ui: { [EMAILS.conf]: 'x' as any } });
  assert.deepEqual(await call('confirmation.colPresets', await b.as(EMAILS.conf), {}), []);
  await demoRestore(b.db, null);
});
