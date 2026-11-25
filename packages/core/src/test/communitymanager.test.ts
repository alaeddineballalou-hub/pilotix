// The Community manager (the owner's choice, 25 Nov 2026): Pilot Message and Pilot Comments only. She answers the chats
// and the comments, and types the order of a chat or a call — it goes to the confirmation as « Nouvelle », like any order.
// She never confirms it, never chooses its delivery company, never posts. She sees the orders she typed; the agent
// manager of her team (Dashboard › Composer les équipes) sees them too, another manager does not. An order typed in a
// chat is linked to that chat and stays the person's: never counted as Dellal's.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { DEMO_PASSWORD, NO_ROLE_RIGHTS, rightsOf } from '@pilotix/shared';
import { call, Ctx, Db, hashPassword } from '../index';
import { forgetRights } from '../modules/rights';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
let lina: Ctx;
let nour: Ctx;
let admin: Ctx;
let yacine: Ctx;
let amel: Ctx;
let linaId: number;
let item: { productId: number; variantId: number | null; qty: number };
let n = 0;
const phone = () => `0770${String(++n).padStart(6, '0')}`;
const order = (extra: Record<string, unknown> = {}) => ({ customerName: `Client CM ${n}`, phone: phone(), wilayaId: 16, commune: 'Kouba', address: 'Rue des Fleurs', items: [item], ...extra });

before(async () => {
  ({ db, as } = await setup(150));
  const hash = await hashPassword(DEMO_PASSWORD);
  const add = async (name: string, email: string, tel: string) =>
    Number((await db.query(`INSERT INTO profiles (name, email, phone, password_hash, roles) VALUES ($1, $2, $3, $4, '{cm}') RETURNING id`, [name, email, tel, hash]))[0].id);
  linaId = await add('Lina', 'lina.cm@demo.pilotix.dz', '0661999001');
  await add('Nour', 'nour.cm@demo.pilotix.dz', '0661999002');
  [lina, nour, admin, yacine, amel] = await Promise.all([as('lina.cm@demo.pilotix.dz'), as('nour.cm@demo.pilotix.dz'), as(EMAILS.admin), as(EMAILS.manager), as(EMAILS.manager2)]);
  // Lina works in Yacine's team
  const vendeur = await as(EMAILS.vendeur);
  await call('stats.saveTeams', vendeur, { assignments: [{ agentId: linaId, managerId: yacine.session.profile.id }] });
  const p = (await db.query(`SELECT p.id, (SELECT v.id FROM product_variants v WHERE v.product_id = p.id AND v.active ORDER BY v.id LIMIT 1) AS vid
    FROM products p WHERE p.active AND NOT p.is_service AND p.archived_at IS NULL ORDER BY p.id LIMIT 1`))[0];
  item = { productId: Number(p.id), variantId: p.vid === null ? null : Number(p.vid), qty: 1 };
});

test('her role: Pilot Message, Pilot Comments and her orders — never posting, the confirmation or the rest', () => {
  const r = rightsOf({ id: 1, roles: ['cm'] }, NO_ROLE_RIGHTS);
  for (const id of ['page:messages', 'page:cm', 'act:dellal.reply', 'act:cm.reply', 'act:orders.create', 'page:commandes', 'tab:commandes/livrees', 'tab:commandes/annulees', 'tab:commandes/tout'])
    assert.ok(r.has(id), `${id}: hers by default`);
  for (const id of ['page:social', 'page:createur', 'page:spy', 'page:comptes', 'page:confirmation', 'page:suivi', 'page:depot', 'page:sav', 'page:clients', 'page:produits', 'page:marketing', 'page:landing', 'act:social.publish', 'act:orders.cancel', 'act:orders.items', 'act:orders.customer', 'act:costs'])
    assert.ok(!r.has(id), `${id}: never hers`);
});

test('she answers the chats and the comments, and never posts', async () => {
  assert.ok(Array.isArray((await call('dellal.inbox', lina, {})).rows));
  assert.ok(Array.isArray((await call('cm.feed', lina, {})).rows));
  await assert.rejects(call('cm.plan.list', lina, {}), (e: any) => e.code === 'forbidden');
  await assert.rejects(call('dellal.settings.get', lina, {}), (e: any) => e.code === 'forbidden');
});

test('the order of a chat or a call goes to the confirmation as « Nouvelle »; nothing else', async () => {
  const o: any = await call('orders.create', lina, order({ channel: 'instagram' }));
  assert.equal(o.confStatus, 'new');
  assert.equal(o.channel, 'instagram');
  assert.equal(o.came, 'hand');
  assert.equal(Number((await db.query('SELECT created_by FROM orders WHERE id = $1', [o.id]))[0].created_by), linaId);
  const call1: any = await call('orders.create', lina, order({ channel: 'appel' }));
  assert.equal(call1.channel, 'appel');
  for (const channel of ['site', 'landing', 'autre'])
    await assert.rejects(call('orders.create', lina, order({ channel })), /chat ou d’un appel/, channel);
  await assert.rejects(call('orders.create', lina, order({ channel: 'facebook', confirm: true })), /confirmation/);
  const company = Number((await db.query('SELECT id FROM delivery_companies WHERE active ORDER BY id LIMIT 1'))[0].id);
  await assert.rejects(call('orders.create', lina, order({ channel: 'facebook', companyId: company })), /société de livraison/);
  await assert.rejects(call('orders.create', lina, order({ channel: 'facebook', isExchange: true })), /SAV/);
  // she never confirms, changes or cancels an order
  await assert.rejects(call('orders.setConf', lina, { ids: [o.id], status: 'confirmed' }), (e: any) => e.code === 'forbidden');
  await assert.rejects(call('orders.update', lina, { id: o.id, address: 'Ailleurs' }), (e: any) => e.code === 'forbidden');
});

test('she sees the orders she typed; her agent manager sees them, another manager does not', async () => {
  const mine: any = await call('orders.create', lina, order({ channel: 'whatsapp' }));
  await db.query('UPDATE orders SET agent_id = NULL WHERE id = $1', [mine.id]);
  const other = Number((await db.query('SELECT id FROM orders WHERE created_by <> $1 ORDER BY id LIMIT 1', [linaId]))[0].id);
  assert.equal((await call('orders.get', lina, { id: mine.id })).id, mine.id);
  await assert.rejects(call('orders.get', lina, { id: other }), (e: any) => e.code === 'forbidden');
  await assert.rejects(call('orders.get', nour, { id: mine.id }), (e: any) => e.code === 'forbidden');
  const listed = await call('orders.list', lina, { ids: [mine.id, other] });
  assert.deepEqual(listed.rows.map((r: any) => r.id), [mine.id]);
  assert.deepEqual((await call('orders.list', yacine, { ids: [mine.id] })).rows.map((r: any) => r.id), [mine.id]);
  assert.deepEqual((await call('orders.list', amel, { ids: [mine.id] })).rows.length, 0);
  // the road above her lists counts her own orders still at the confirmation (she has no queue of her own)
  const mineNew = Number((await db.query(`SELECT count(*)::int AS n FROM orders WHERE created_by = $1 AND conf_status = 'new' AND NOT is_exchange`, [linaId]))[0].n);
  assert.equal((await call('orders.counts', lina, {})).conf.new, mineNew);
  // her team's confirmation boards do not list her (she never confirms)
  const meta = await call('stats.dashMeta', await as(EMAILS.vendeur), {});
  assert.ok(meta.agents.some((a: any) => a.id === linaId && a.cm === true && a.managerId === yacine.session.profile.id));
});

test('an order typed in a chat is linked to it and stays the person’s, never Dellal’s', async () => {
  const conv = Number((await db.query(`INSERT INTO conversations (channel, external_id, customer_name, source) VALUES ('messenger', 'psid-cm-1', 'Imène', 'pub 1234567890') RETURNING id`))[0].id);
  const before = (await call('dellal.stats', admin, { days: 7 })).orders;
  const o: any = await call('orders.create', lina, order({ channel: 'appel', conversationId: conv }));
  // the chat's own channel, the ad that started it
  assert.equal(o.channel, 'facebook');
  assert.equal(o.utm?.ad_id, '1234567890');
  const row = (await db.query('SELECT conversation_id, came FROM orders WHERE id = $1', [o.id]))[0];
  assert.equal(Number(row.conversation_id), conv);
  assert.equal(row.came, 'hand');
  const c = (await db.query('SELECT order_id, phone FROM conversations WHERE id = $1', [conv]))[0];
  assert.equal(Number(c.order_id), o.id);
  assert.equal(c.phone, o.phone);
  // its history shows her, Pilot Message's results do not count it as Dellal's, the chat does not mark it Dellal's
  const created = (await call('orders.events', admin, { id: o.id })).find((e: any) => e.kind === 'created');
  assert.equal(created?.userName, 'Lina');
  assert.equal((await call('dellal.stats', admin, { days: 7 })).orders, before);
  const side = (await call('dellal.conversation', lina, { id: conv })).orders.find((x: any) => x.id === o.id);
  assert.equal(side?.byDellal, false);
  // only the people who work the chats make a chat's order
  await assert.rejects(call('orders.create', await as(EMAILS.suivi), order({ channel: 'facebook', conversationId: conv })), /répondent aux messages/);
});

test('the owner can take her « Nouvelle commande » away (Utilisateurs › Rôles)', async () => {
  const saved = (await call('rights.get', admin, {})).rights;
  await call('rights.save', admin, { roles: { ...saved.roles, cm: { off: ['act:orders.create'] } }, people: saved.people });
  forgetRights(db);
  await assert.rejects(call('orders.create', lina, order({ channel: 'facebook' })), /Votre rôle n’a pas ce droit/);
  await call('rights.save', admin, { roles: saved.roles, people: saved.people });
  forgetRights(db);
  assert.equal((await call('orders.create', lina, order({ channel: 'facebook' }))).confStatus, 'new');
});
