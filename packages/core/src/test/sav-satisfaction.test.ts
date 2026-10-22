// SAV on phones: a ticket ends "réglé au téléphone" or by a delivered exchange, and the customer's satisfaction is
// asked either way. Pas content / Moyen need the reason; "Pas répondu" is counted; an unhappy customer reopens it.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;

before(async () => {
  ({ db, as } = await setup(300));
});

const deliveredOrder = async (skip = 0) => Number((await db.query(`SELECT id FROM orders WHERE follow_status='delivered' ORDER BY id OFFSET $1 LIMIT 1`, [skip]))[0].id);

test('réglé au téléphone: the ticket is born finished, with the satisfaction; unhappy needs the reason', async () => {
  const ctx = await as(EMAILS.suivi);
  const orderId = await deliveredOrder();
  await assert.rejects(
    call('sav.create', ctx, { orderId, type: 'help', details: 'Ne sait pas monter', settle: { reason: 'explain', note: '', satisfaction: 1, satisfactionNote: '' } }),
    /pourquoi/,
  );
  const t: any = await call('sav.create', ctx, { orderId, type: 'help', details: 'Ne sait pas monter', settle: { reason: 'explain', note: 'Montré au téléphone', satisfaction: 4 } });
  assert.equal(t.status, 'resolved');
  assert.equal(t.resolution, 'phone');
  assert.equal(t.satisfaction, 4);
  assert.ok(t.resolvedAt);
  // finished, not waiting for a satisfaction call
  const sat = (await call('sav.list', ctx, { view: 'satisfaction' })) as any;
  assert.equal(sat.rows.some((x: any) => x.id === t.id), false);
  const done = (await call('sav.list', ctx, { view: 'termines' })) as any;
  assert.ok(done.rows.some((x: any) => x.id === t.id));
  // an open ticket can be settled later too
  const t2: any = await call('sav.create', ctx, { orderId, type: 'defect', details: 'Boucle cassée' });
  const s2: any = await call('sav.settle', ctx, { id: t2.id, reason: 'gesture', note: 'Bon de réduction', satisfaction: 2, satisfactionNote: 'Voulait un échange' });
  assert.equal(s2.status, 'resolved');
  assert.equal(s2.satisfactionNote, 'Voulait un échange');
  await assert.rejects(call('sav.settle', ctx, { id: t2.id, reason: 'other', satisfaction: 3 }), /clôturé/);
});

test('after a delivered exchange: asked by a call; no answer is counted; unhappy reopens', async () => {
  const ctx = await as(EMAILS.suivi);
  const orderId = await deliveredOrder(1);
  const t: any = await call('sav.create', ctx, { orderId, type: 'defect', details: 'Roue voilée' });
  const full: any = await call('sav.get', ctx, { id: t.id });
  const item = full.order.items[0];
  const ex: any = await call('sav.exchange', ctx, { id: t.id, kind: 'same', lines: [{ itemId: item.id, qty: 1 }] });
  await db.query(`UPDATE orders SET follow_status='delivered' WHERE id=$1`, [ex.order.id]);
  const k: any = await call('sav.kpis', ctx, {});
  assert.ok(k.satisfaction >= 1);
  const list = (await call('sav.list', ctx, { view: 'satisfaction' })) as any;
  assert.ok(list.rows.some((x: any) => x.id === t.id), 'delivered exchange waits for the satisfaction call');

  const na: any = await call('sav.rate', ctx, { id: t.id, noAnswer: true });
  assert.equal(na.satTries, 1);
  await assert.rejects(call('sav.rate', ctx, { id: t.id, satisfaction: 1 }), /pourquoi/);
  const re: any = await call('sav.rate', ctx, { id: t.id, satisfaction: 1, satisfactionNote: 'Même défaut sur le neuf', reopen: true });
  assert.equal(re.status, 'open');
  assert.equal(re.exchangeOrderId, null, 'a new exchange can be made');
  assert.ok(re.notes.some((n: any) => /Pas content — Même défaut/.test(n.text)));

  // the new exchange, delivered, then a happy customer
  const ex2: any = await call('sav.exchange', ctx, { id: t.id, kind: 'same', lines: [{ itemId: item.id, qty: 1 }] });
  await db.query(`UPDATE orders SET follow_status='delivered' WHERE id=$1`, [ex2.order.id]);
  await call('sav.kpis', ctx, {});
  const ok: any = await call('sav.rate', ctx, { id: t.id, satisfaction: 3 });
  assert.equal(ok.satisfaction, 3);
  assert.equal(ok.status, 'resolved');

  const now = new Date();
  const st: any = await call('sav.stats', ctx, { from: new Date(now.getTime() - 86_400_000).toISOString(), to: new Date(now.getTime() + 86_400_000).toISOString() });
  assert.ok(st.satisfaction.n >= 1);
  assert.ok(st.satisfaction.rate !== null);
  assert.ok(st.satisfaction.ends.length >= 1);
});

test('Moi / Personne / Tous counts', async () => {
  const ctx = await as(EMAILS.suivi);
  const all: any = await call('sav.list', ctx, { view: 'todo' });
  const mine: any = await call('sav.list', ctx, { view: 'todo', owner: 'me' });
  const none: any = await call('sav.list', ctx, { view: 'todo', owner: 'none' });
  assert.equal(all.counts.view, all.total);
  assert.equal(mine.total, all.counts.mine);
  assert.equal(none.total, all.counts.nobody);
});
