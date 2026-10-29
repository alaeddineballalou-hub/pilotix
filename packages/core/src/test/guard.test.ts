// The anti-fraud check of the orders that do not come from a landing page: the same phone, name, history and network
// signals; reasons in the note, and « À vérifier » for what a landing page would block when the order came by itself.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let X: { productId: number; variantId: number };

before(async () => {
  let as: (e: string) => Promise<Ctx>;
  ({ db, as } = await setup(40));
  admin = await as(EMAILS.admin);
  const r = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id AND v.active WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  X = { productId: Number(r.id), variantId: Number(r.vid) };
});

const order = (phone: string, extra: object = {}) =>
  call('orders.create', admin, { customerName: 'Client Garde', phone, wilayaId: 16, commune: 'Kouba', address: 'Rue 1', items: [{ ...X, qty: 1 }], ...extra }) as Promise<any>;
const row = async (id: number) => (await db.query('SELECT conf_status, internal_note FROM orders WHERE id = $1', [id]))[0];

test('a normal new number: nothing to say', async () => {
  const o = await order('0661234517');
  const r = await row(o.id);
  assert.equal(r.conf_status, 'new');
  assert.ok(!String(r.internal_note ?? '').includes('Protection'));
});

test('typed by hand: the reasons in the note, the agent decides', async () => {
  const o = await order('0555555555');
  const r = await row(o.id);
  assert.equal(r.conf_status, 'new');
  assert.match(String(r.internal_note), /Protection anti-fraude/);
});

test('sent by the site (webhook): what a landing page blocks goes « À vérifier »', async () => {
  const o = await order('0777777777', { via: 'api', channel: 'site' });
  const r = await row(o.id);
  assert.equal(r.conf_status, 'to_check');
  assert.match(String(r.internal_note), /À vérifier/);
  // the same number again for the same product, from the site: a duplicate, the agent checks
  const again = await order('0661234517', { via: 'api', channel: 'site' });
  assert.match(String((await row(again.id)).internal_note), /Protection anti-fraude/);
});
