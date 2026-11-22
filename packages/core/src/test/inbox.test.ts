// The bell (owner's ask, 22 Nov 2026): « a notification for every one, about each order ». An agent hears of a new order
// given to them, of an order taken from them, of their order delivered (or back, or cancelled) and of the callback they
// set; Suivi of an alert on the parcel they follow; the depot of its new orders to prepare, grouped; every phone
// notification is also in the bell. Never the person who did it; the phones ring in the shop's call hours only (a
// callback always: the agent chose its time).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, num, setSetting } from '../index';
import { inboxRun } from '../modules/inbox';
import { setFollow } from '../modules/orders';
import { sendPush } from '../modules/push';
import { EMAILS, setup } from './harness';

const DAY = [{ key: 'day', from: 0, to: 24 }];
const NEVER = [{ key: 'never', from: 0, to: 0 }];
async function hours(db: any, slots: { key: string; from: number; to: number }[]) {
  await setSetting(db, 'calls', { slots, tries: 3, firstMinutes: 15, paceMinutes: 5, cancelAfterNoAnswer: 0 });
}

test('the bell: new order, taken, delivered, back, alert, callback, depot — each to the right person, never to who did it', async () => {
  const { db, as, events } = await setup(120);
  const sent: any[] = [];
  const server = {
    pushKeys: () => ({ publicKey: 'BPUBLIC', privateKey: 'PRIVATE' }),
    push: async (_k: any, subs: any[], payload: any) => {
      sent.push({ subs, payload });
      return subs.map((s) => ({ endpoint: s.endpoint, ok: true, gone: false }));
    },
  } as any;
  const admin = await (as as any)(EMAILS.admin, server);
  const yacine = await (as as any)(EMAILS.manager, server);
  const samira = await (as as any)(EMAILS.conf, server);
  const rania = await (as as any)(EMAILS.conf2, server);
  const nadia = await (as as any)(EMAILS.suivi, server);
  const karim = await (as as any)(EMAILS.depot, server);
  const S = samira.session.profile.id;
  const R = rania.session.profile.id;
  const N = nadia.session.profile.id;
  const Y = yacine.session.profile.id;
  await call('push.key', samira, {});
  await call('push.subscribe', samira, { endpoint: 'https://fcm.googleapis.com/fcm/send/samira', p256dh: 'BKEY-1234567890', auth: 'AUTH-1234' });
  await hours(db, DAY);
  const mine = async (ctx: any) => (await call('inbox.list', ctx, {})) as any;

  // a manager gives Rania's order to Samira: Samira hears of it, Rania too (taken), the manager never
  const o = (await db.query(`SELECT id, ref FROM orders WHERE conf_status = 'new' ORDER BY id LIMIT 1`))[0];
  const oid = num(o.id);
  await db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [oid, R]);
  await call('orders.assignAgent', yacine, { ids: [oid], agentId: S });
  const s1 = await mine(samira);
  assert.equal(s1.unread, 1);
  assert.equal(s1.items[0].kind, 'order');
  assert.equal(s1.items[0].title, 'Nouvelle commande pour vous');
  assert.match(s1.items[0].body, new RegExp(`Donnée par Yacine · ${o.ref}`));
  assert.equal(s1.items[0].orderId, oid);
  assert.equal(s1.items[0].important, true);
  const r1 = await mine(rania);
  assert.equal(r1.items[0].kind, 'taken');
  assert.equal(r1.items[0].title, `${o.ref} n’est plus à vous`);
  assert.equal(r1.items[0].body, 'Donnée à Samira');
  assert.equal((await mine(yacine)).items.filter((x: any) => x.kind === 'order' || x.kind === 'taken').length, 0, 'never the person who did it');
  // her screen heard of it at once; her phone rang (in the call hours)
  assert.ok(events.some((e: any) => e.type === 'inbox' && e.data.to.includes(S)));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, 'Nouvelle commande pour vous');
  assert.equal(sent[0].payload.alarm, true);
  sent.length = 0;

  // her order is delivered (the courier): the cash line, to her; back: the « en retour » line
  const d = (await db.query(`SELECT id, ref FROM orders WHERE conf_status = 'confirmed' AND follow_status = 'to_prepare' ORDER BY id LIMIT 2`)).map((x: any) => ({ id: num(x.id), ref: String(x.ref) }));
  await db.query(`UPDATE orders SET agent_id = $2, follow_agent_id = $3, follow_status = 'shipped', shipped_at = now() WHERE id = ANY($1)`, [d.map((x) => x.id), S, N]);
  await setFollow(admin, { ids: [d[0].id], status: 'delivered' }, { system: true, courier: true });
  const s2 = await mine(samira);
  assert.equal(s2.items[0].kind, 'delivered');
  assert.equal(s2.items[0].title, `💰 ${d[0].ref} livrée`);
  // an alert on the other one: Nadia, who follows it
  await setFollow(admin, { ids: [d[1].id], status: 'alert', note: 'client absent' }, { system: true, courier: true });
  const n1 = await mine(nadia);
  assert.equal(n1.items[0].kind, 'alert');
  assert.equal(n1.items[0].title, `⚠️ Alerte sur ${d[1].ref}`);
  assert.match(n1.items[0].body, /Alerte du livreur/);
  // back: Samira (who confirmed it); Nadia herself marks it « En retour »: she is not told, Samira is
  await setFollow(nadia, { ids: [d[1].id], status: 'returning', note: 'refusé' });
  const s3 = await mine(samira);
  assert.equal(s3.items[0].kind, 'returned');
  assert.equal(s3.items[0].title, `↩️ ${d[1].ref} en retour`);
  assert.equal((await mine(nadia)).items.filter((x: any) => x.kind === 'returned').length, 0);
  // several at once (one courier run): one line
  const many = (await db.query(`SELECT id FROM orders WHERE conf_status = 'confirmed' AND id <> ALL($1) AND follow_status IS DISTINCT FROM 'delivered' ORDER BY id LIMIT 3`, [d.map((x) => x.id)])).map((x: any) => num(x.id));
  assert.equal(many.length, 3);
  await db.query(`UPDATE orders SET agent_id = $2, follow_status = 'shipped', shipped_at = now() WHERE id = ANY($1)`, [many, S]);
  const before = (await mine(samira)).items.length;
  await setFollow(admin, { ids: many, status: 'delivered' }, { system: true, courier: true });
  const s4 = await mine(samira);
  assert.equal(s4.items.length, before + 1);
  assert.equal(s4.items[0].title, '💰 3 commandes livrées');
  assert.equal(s4.items[0].n, 3);

  // a callback whose time came: once, on her phone even outside the call hours (she chose the time)
  await hours(db, NEVER);
  sent.length = 0;
  const c = (await db.query(`SELECT id, ref, customer_name FROM orders WHERE conf_status = 'new' AND id <> $1 ORDER BY id LIMIT 1`, [oid]))[0];
  await db.query(`UPDATE orders SET agent_id = $2, conf_status = 'callback', next_call_at = now() - interval '1 minute' WHERE id = $1`, [num(c.id), S]);
  assert.equal((await inboxRun(admin)).calls, 1);
  assert.equal((await inboxRun(admin)).calls, 0, 'told once');
  const s5 = await mine(samira);
  assert.equal(s5.items[0].kind, 'callback');
  assert.equal(s5.items[0].title, `📞 Rappeler ${String(c.customer_name).trim()} maintenant`);
  assert.equal(sent.length, 1, 'a callback rings the phone at any hour');
  // outside the call hours, a new order waits in the bell without ringing the phone
  sent.length = 0;
  const o2 = (await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND agent_id IS NULL ORDER BY id LIMIT 1`))[0];
  await call('orders.assignAgent', yacine, { ids: [num(o2.id)], agentId: S });
  assert.equal((await mine(samira)).items[0].kind, 'order');
  assert.equal(sent.length, 0);

  // the depot: the new orders to prepare, one line, not again before 15 minutes
  await hours(db, DAY);
  const prep = (await db.query(`SELECT id FROM orders WHERE conf_status = 'confirmed' AND id <> ALL($1) ORDER BY id DESC LIMIT 2`, [[...many, ...d.map((x) => x.id)]])).map((x: any) => num(x.id));
  await db.query(`UPDATE orders SET follow_status = 'to_prepare', shipped_at = NULL, confirmed_at = now() WHERE id = ANY($1)`, [prep]);
  const dep = await inboxRun(admin);
  assert.equal(dep.depot, 1);
  const k1 = await mine(karim);
  assert.equal(k1.items[0].kind, 'depot');
  assert.match(k1.items[0].title, /^📦 (\d+ nouvelles commandes|Une nouvelle commande) à préparer$/);
  assert.match(k1.items[0].body, /à préparer en tout$/);
  assert.equal((await inboxRun(admin)).depot, 0, 'not again before 15 minutes');

  // every phone notification is in the bell; the same tag replaces the unread line
  await sendPush(admin, [Y], { title: '3 commandes attendent un appel', body: 'Depuis 20 min', tag: 'auto-wait', url: '#/confirmation/nouvelles' });
  await sendPush(admin, [Y], { title: '5 commandes attendent un appel', body: 'Depuis 30 min', tag: 'auto-wait', url: '#/confirmation/nouvelles' });
  const y1 = (await mine(yacine)).items.filter((x: any) => x.kind === 'info');
  assert.equal(y1.length, 1);
  assert.equal(y1[0].title, '5 commandes attendent un appel');
  assert.equal(y1[0].n, 2);

  // in the person's language
  await db.query(`UPDATE profiles SET language = 'ar' WHERE id = $1`, [S]);
  const o3 = (await db.query(`SELECT id FROM orders WHERE conf_status = 'new' AND agent_id IS NULL ORDER BY id LIMIT 1`))[0];
  await call('orders.assignAgent', yacine, { ids: [num(o3.id)], agentId: S });
  assert.equal((await mine(samira)).items[0].title, 'طلب جديد لك');

  // read: one line, then all; only one's own lines
  const was = await mine(samira);
  await call('inbox.read', samira, { ids: [was.items[0].id] });
  const after = await mine(samira);
  assert.equal(after.items[0].read, true);
  assert.equal(after.unread, was.unread - 1);
  await call('inbox.read', rania, { ids: [s1.items[0].id] });
  assert.equal((await mine(samira)).items.find((x: any) => x.id === s1.items[0].id).read, false, 'someone else cannot read my line');
  await call('inbox.readAll', samira, {});
  assert.equal((await mine(samira)).unread, 0);
  assert.ok((await mine(rania)).unread > 0);
});
