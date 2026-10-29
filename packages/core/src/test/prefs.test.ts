// Sociétés de livraison › Préférences: the recommended choices to start with, saved for the whole shop by an admin only, a backup
// company that must exist and be a delivery company (not the shop's own delivery men).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(40));
});

test('a new shop starts with the recommended choices; everyone reads them', async () => {
  const agent = await as(EMAILS.conf);
  const r = (await call('prefs.get', agent, {})) as any;
  assert.deepEqual(r.prefs, r.recommended);
  assert.equal(r.prefs.manualDefault, true);
  assert.deepEqual(r.prefs.changeCompany, { confirmation: true, agency: false, depot: false, manager: true });
  assert.equal(r.prefs.strictLock, true);
  assert.deepEqual(r.prefs.rulesBy, { confirmation: false, agency: false, depot: false, manager: false }, 'Pilot rules: admins only');
  assert.equal(r.prefs.privateBackup.on, false);
  assert.equal(r.prefs.noStockDays, 3);
});

test('only an admin saves them; a backup company must be a real delivery company', async () => {
  const admin = await as(EMAILS.admin);
  const agent = await as(EMAILS.conf);
  const base = ((await call('prefs.get', admin, {})) as any).prefs;
  await assert.rejects(call('prefs.set', agent, { ...base, strictLock: false }));
  await assert.rejects(call('prefs.set', admin, { ...base, privateBackup: { on: true, hours: 12, companyId: null } }), /société de secours/);
  const own = (await db.query(`SELECT id FROM delivery_companies WHERE kind = 'own' LIMIT 1`))[0];
  if (own) await assert.rejects(call('prefs.set', admin, { ...base, privateBackup: { on: true, hours: 12, companyId: Number(own.id) } }), /pas vos livreurs/);
  const api = (await db.query(`SELECT id FROM delivery_companies WHERE kind <> 'own' ORDER BY id LIMIT 1`))[0];
  assert.ok(api, 'a delivery company in the demo');
  const next = { ...base, strictLock: false, changeCompany: { ...base.changeCompany, depot: true }, privateBackup: { on: true, hours: 12, companyId: Number(api.id) }, noStockDays: 5 };
  await call('prefs.set', admin, next);
  const r = (await call('prefs.get', agent, {})) as any;
  assert.deepEqual(r.prefs, next);
  assert.notDeepEqual(r.prefs, r.recommended);
});
