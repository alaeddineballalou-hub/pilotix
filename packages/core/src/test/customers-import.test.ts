// Clients › « Importer des clients »: customers from another app come WITH their history there, so their score and
// level show at once; a number already here keeps its name and orders; importing again replaces the old history.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call } from '../index';
import { EMAILS, setup } from './harness';

const row = (phone: string, f: Record<string, unknown> = {}) => ({
  phone,
  orders: 0,
  delivered: 0,
  returned: 0,
  fake: 0,
  cancelled: 0,
  ...f,
});

test('imported history gives the level at once, keeps what Pilotix knows, and a new import replaces it', async () => {
  const s = await setup(60);
  const admin = await s.as(EMAILS.admin);
  const known: any = (await call('customers.list', admin, { page: 1, pageSize: 1 })).rows[0];

  const r: any = await call('customers.import', admin, {
    source: 'clients.xlsx',
    rows: [
      row('0799 10 02 01', {
        name: 'Amina Test',
        wilayaId: 16,
        orders: 2,
        delivered: 2,
        lastOrderAt: '2026-10-30',
      }),
      row('+213 799100202', {
        name: 'Karim Test',
        wilayaId: 31,
        returned: 1,
        cancelled: 2,
      }),
      row('12345', { name: 'Faux numéro' }),
      row(known.phone, { name: 'Autre nom', delivered: 1 }),
      row('0799100203', { name: 'Double', fake: 3 }),
      row('0799100203', { name: 'Double', delivered: 1 }), // the same number twice: the last line counts
    ],
  });
  assert.deepEqual([r.added, r.updated, r.invalid, r.blacklisted], [3, 1, 1, 0]);

  const one = async (phone: string) => ((await call('customers.history', admin, { phone })) as any).customer;
  const amina = await one('0799100201');
  assert.deepEqual([amina.name, amina.wilayaId, amina.orders, amina.score.score, amina.score.level], ['Amina Test', 16, 0, 84, 'top']);
  assert.deepEqual(
    { ...amina.imported, at: undefined },
    {
      source: 'clients.xlsx',
      orders: 2,
      delivered: 2,
      returned: 0,
      fake: 0,
      cancelled: 0,
      lastOrderAt: '2026-10-30T00:00:00.000Z',
      at: undefined,
    },
  );
  const karim = await one('0799100202');
  assert.deepEqual([karim.score.score, karim.score.level, karim.imported.orders], [34, 'risk', 3]); // 60 − 18 − 8; orders = what it tells about
  assert.equal((await one('0799100203')).score.score, 72);
  const again = await one(known.phone);
  assert.equal(again.name, known.name); // Pilotix's own name stays
  assert.equal(again.score.score >= known.score.score, true);
  assert.equal(again.imported.delivered, 1);

  // the level filter (every customer scored on the server) sees the imported history too
  const top: any = await call('customers.list', admin, {
    level: 'top',
    page: 1,
    pageSize: 500,
  });
  assert.ok(top.rows.some((c: any) => c.phone === '0799100201'));

  // importing again REPLACES the old history (never adds up); a « liste noire » line blacklists the number
  const r2: any = await call('customers.import', admin, {
    rows: [row('0799100201', { delivered: 1 }), row('0799100202', { blacklisted: true })],
  });
  assert.deepEqual([r2.added, r2.updated, r2.blacklisted], [0, 2, 1]);
  const amina2 = await one('0799100201');
  assert.deepEqual([amina2.imported.delivered, amina2.score.score, amina2.score.level], [1, 72, 'good']);
  const karim2 = await one('0799100202');
  assert.deepEqual([karim2.blacklisted, karim2.blacklistReason, karim2.score.score], [true, 'Ancienne base', 5]);
});

test('only an administrator imports customers; a file part is 1,000 lines at most', async () => {
  const s = await setup(20);
  await assert.rejects(
    call('customers.import', await s.as(EMAILS.conf), {
      rows: [row('0799100301', { delivered: 1 })],
    }),
  );
  await assert.rejects(
    call('customers.import', await s.as(EMAILS.vendeur), {
      rows: [row('0799100302', { delivered: 1 })],
    }),
  );
  const admin = await s.as(EMAILS.admin);
  const big = Array.from({ length: 1001 }, (_, k) => row(`0799${String(200000 + k)}`));
  await assert.rejects(call('customers.import', admin, { rows: big }));
  const ok: any = await call('customers.import', admin, {
    rows: big.slice(0, 1000),
  });
  assert.equal(ok.added, 1000);
});

test('Accueil › « Venez avec vos données »: what is already in (admin only)', async () => {
  const s = await setup(20);
  const admin = await s.as(EMAILS.admin);
  const before: any = await call('welcome.status', admin, {});
  assert.ok(before.products > 0 && before.couriers > 0 && before.team > 1);
  assert.equal(before.importedClients, 0);
  await call('customers.import', admin, {
    rows: [row('0799100401', { delivered: 1 }), row('0799100402')],
  });
  assert.equal(((await call('welcome.status', admin, {})) as any).importedClients, 2);
  await assert.rejects(call('welcome.status', await s.as(EMAILS.conf), {}));
});
