// Landing pages › Meta, the events beside Purchase: « Lead » (the form of a clean order; a borderline or blocked one once
// a person accepted it), « FakeOrder » and « Competitor » (the browser behind an order an agent marked fake, or behind a
// blocked order nobody restored in a day): when each is queued, what Meta receives, and what never leaves.
import { sha256Hex, zeroBits } from '@pilotix/shared';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db } from '../index';
import { LANDING_POW_BITS, makeChallenge } from '../modules/landing';
import { BLOCKED_FAKE_AFTER_MS, FAKE_EVENT_DELAY_MS } from '../modules/landingquery';
import { EMAILS, setup } from './harness';

let db: Db;
let admin: Ctx;
let conf: Ctx;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let productId: number;
let variantId: number;
const SLUG = 'events-test';
const PIXEL = '555566667777888';
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const FBP = 'fb.1.1731000000000.1234567890';
const MIN = 60_000;
const at = (ctx: Ctx, ms: number): Ctx => ({ ...ctx, now: () => ms });

/** what Meta received, as the server's hook saw it */
const sent: { action: string; args: any }[] = [];
const server: Ctx['server'] = { courier: async () => ({}), hashPassword: async (p) => p, meta: async (action: string, args: any) => (sent.push({ action, args }), { received: args.events.length }) };
const received = () => sent.flatMap((x) => x.args.events as any[]);

before(async () => {
  const s = await setup(120);
  db = s.db;
  as = s.as;
  admin = await s.as(EMAILS.admin);
  conf = await s.as(EMAILS.conf);
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.sku = 'PX-POU' AND v.title <> '' ORDER BY v.id LIMIT 1`))[0];
  productId = Number(p.id);
  variantId = Number(p.vid);
  await call('landing.save', await s.as(EMAILS.marketer), { productId, slug: SLUG, title: 'Events', price: 9950, pixelId: PIXEL });
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'confirmed', abandonAfterMin: 20, autoCreate: false, capiToken: 'EAAtest' });
  // the demo's own events are not this file's
  await db.query(`UPDATE meta_events SET status = 'sent' WHERE status = 'queued'`);
  await db.query(`UPDATE landing_blocked SET meta_at = now() WHERE meta_at IS NULL`);
});

const SURNAMES = ['Benali', 'Haddad', 'Mansouri', 'Belkacem', 'Saidi', 'Bouzid', 'Cherif', 'Djebbar', 'Ferhat', 'Hamidi', 'Kaci', 'Larbi', 'Meziane', 'Nouri', 'Ouali', 'Rahmani', 'Slimani', 'Taleb', 'Yahiaoui', 'Zerrouki', 'Amrani', 'Benaissa', 'Brahimi', 'Chaoui', 'Derradji', 'Guerfi', 'Hadjadj', 'Khelifi', 'Lounes', 'Mebarki'];
/** a different family name each time: the same full name sent with many numbers is a signal of its own */
let nameSeq = 0;
const custName = () => `Amina ${SURNAMES[nameSeq++ % SURNAMES.length]}`;
const solve = (ch: string) => {
  for (let n = 0; ; n++) if (zeroBits(sha256Hex(`${ch}:${n}`)) >= LANDING_POW_BITS) return String(n);
};
const rndPhone = () => `066${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
/** a person's form, from a browser Meta knows (its cookie); `t0`: when it is sent */
async function human(over: Record<string, unknown> = {}, phone = rndPhone(), t0 = Date.now()) {
  const ch = await makeChallenge(db, SLUG, t0 - 25_000);
  return { slug: SLUG, name: custName(), phone, wilaya: 16, commune: 'Hydra', variant: variantId, qty: 1, hp: '', ch, pw: solve(ch), t: 25_000, ki: 40, wd: false, fp: `fp${Math.random().toString(36).slice(2, 14)}`, did: `d${Math.random()}`, vid: `v${Math.random().toString(36).slice(2, 8)}`, fbp: FBP, meta: { ip: `10.2.0.${Math.floor(Math.random() * 250)}`, ua: UA }, ...over };
}
const orderOf = async (phone: string) => (await db.query(`SELECT * FROM orders WHERE phone = $1 ORDER BY id DESC`, [phone]))[0];
const events = async (where: string, params: unknown[]) => db.query(`SELECT * FROM meta_events WHERE ${where} ORDER BY id`, params);
const mine = async (id: unknown) => db.query('UPDATE orders SET agent_id = $2 WHERE id = $1', [id, conf.session.profile.id]);
const run = async (ms: number) => call('landing.run', at(await as(EMAILS.admin, server), ms), {});
/** a form sent from a real browser less than 3 seconds after its page was served: blocked (too fast for a person) */
async function hasty(t0: number, over: Record<string, unknown> = {}) {
  const f = await human(over, rndPhone(), t0);
  const ch = await makeChallenge(db, SLUG, t0 - 500);
  return { ...f, ch, pw: solve(ch), t: 400 };
}

test('Lead: the form of a clean order, at once and once; never an abandoned order, a blocked one or a second send', async () => {
  const f = await human();
  await call('landing.submit', admin, f);
  const o = await orderOf(f.phone);
  let ev = await events(`order_id = $1`, [o.id]);
  assert.deepEqual(ev.map((e: any) => [e.event_name, e.event_id, e.pixel_id, Number(e.value), e.platform]), [['Lead', `lead-${o.ref}`, PIXEL, Number(o.total), 'meta']]);
  // sent again the same day (one order): no second Lead; confirmed: its Purchase, the Lead stays one
  await call('landing.submit', admin, await human({}, f.phone));
  await mine(o.id);
  await call('orders.setConf', conf, { ids: [Number(o.id)], status: 'confirmed' });
  ev = await events(`order_id = $1`, [o.id]);
  assert.deepEqual(ev.map((e: any) => e.event_name).sort(), ['Lead', 'Purchase']);

  // a robot: blocked, nothing for Meta
  const bot = { ...(await human()), hp: 'spam', pw: '', meta: { ip: '1.2.3.4', ua: 'curl/8.0' } };
  await call('landing.submit', admin, bot);
  assert.equal(await orderOf(bot.phone), undefined);
  assert.equal((await events(`event_name = 'Lead' AND at > now() - interval '1 minute' AND order_id IS NULL`, [])).length, 0);

  // a number typed, the form never sent: Pilotix adds the order, an agent confirms it: a Purchase, never a Lead
  const t0 = Date.now();
  const a = await human({}, rndPhone(), t0);
  await call('landing.capture', at(admin, t0), a);
  await call('landing.run', at(admin, t0 + 30 * MIN), {});
  const ab = await orderOf(a.phone);
  assert.match(ab.source, /abandonnée/);
  await mine(ab.id);
  await call('orders.setConf', conf, { ids: [Number(ab.id)], status: 'confirmed' });
  assert.deepEqual((await events(`order_id = $1`, [ab.id])).map((e: any) => e.event_name), ['Purchase']);
});

test('Lead: a borderline order waits for the agent who confirms it; a blocked one for the person who restores it', async () => {
  // a number on the blacklist: « À vérifier »
  const refuser = '0662003355';
  await db.query(`INSERT INTO customers (phone, name, blacklisted, blacklist_reason) VALUES ($1, 'R', true, 'test') ON CONFLICT (phone) DO UPDATE SET blacklisted = true`, [refuser]);
  await call('landing.submit', admin, await human({}, refuser));
  const o = await orderOf(refuser);
  assert.match(o.internal_note, /score anti-fraude/);
  assert.equal((await events(`order_id = $1`, [o.id])).length, 0, 'nothing while nobody accepted it');
  await mine(o.id);
  await call('orders.setConf', conf, { ids: [Number(o.id)], status: 'confirmed' });
  assert.deepEqual((await events(`order_id = $1`, [o.id])).map((e: any) => e.event_name).sort(), ['Lead', 'Purchase']);

  // « Purchase at delivery »: the Lead still leaves at the confirmation
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'delivered', abandonAfterMin: 20, autoCreate: false, capiToken: '' });
  const refuser2 = '0662003366';
  await db.query(`INSERT INTO customers (phone, name, blacklisted, blacklist_reason) VALUES ($1, 'R', true, 'test') ON CONFLICT (phone) DO UPDATE SET blacklisted = true`, [refuser2]);
  await call('landing.submit', admin, await human({}, refuser2));
  const o2 = await orderOf(refuser2);
  await mine(o2.id);
  await call('orders.setConf', conf, { ids: [Number(o2.id)], status: 'confirmed' });
  assert.deepEqual((await events(`order_id = $1`, [o2.id])).map((e: any) => e.event_name), ['Lead']);
  await call('landing.settings.save', admin, { pixelId: '', testEventCode: '', purchaseAt: 'confirmed', abandonAfterMin: 20, autoCreate: false, capiToken: '' });

  // blocked (sent too fast), then a person says it is real: its Lead, and no fake event later
  const t0 = Date.now();
  const odd = await hasty(t0);
  await call('landing.submit', at(admin, t0), odd);
  const b = (await db.query(`SELECT id, status FROM landing_blocked WHERE phone = $1`, [odd.phone]))[0];
  assert.equal(b?.status, 'blocked');
  const r: any = await call('landing.restore', at(admin, t0 + MIN), { id: Number(b.id) });
  assert.deepEqual((await events(`order_id = $1`, [r.orderId])).map((e: any) => e.event_name), ['Lead']);
  await call('landing.run', at(admin, t0 + BLOCKED_FAKE_AFTER_MS + 5 * MIN), {});
  assert.equal((await events(`blocked_id = $1`, [b.id])).length, 0, 'restored: never fake for Meta');
});

test('Lead: Meta gets the customer hashed, like a Purchase; fake before it left, it is skipped; cancelled, it stays a Lead', async () => {
  sent.length = 0;
  // on the server (in the preview an event is only marked « simulé », at once)
  const sys = await as(EMAILS.admin, server);
  const [a, b, c] = [await human(), await human(), await human()];
  for (const f of [a, b, c]) await call('landing.submit', sys, f);
  const [oa, ob, oc] = [await orderOf(a.phone), await orderOf(b.phone), await orderOf(c.phone)];
  await db.query(`UPDATE orders SET conf_status = 'fake' WHERE id = $1`, [ob.id]);
  await db.query(`UPDATE orders SET conf_status = 'cancelled' WHERE id = $1`, [oc.id]);
  await run(Date.now() + MIN);
  const lead = received().find((e) => e.event_id === `lead-${oa.ref}`);
  assert.ok(lead, 'the clean one left');
  assert.equal(sent[0].action, 'capi');
  assert.equal(sent[0].args.pixelId, PIXEL);
  assert.equal(lead.event_name, 'Lead');
  assert.equal(lead.action_source, 'website');
  assert.deepEqual(lead.user_data.ph, [sha256Hex(`213${a.phone.slice(1)}`)]);
  assert.equal(lead.user_data.fbp, FBP);
  assert.equal(lead.user_data.client_user_agent, UA);
  assert.deepEqual([lead.custom_data.currency, lead.custom_data.value, lead.custom_data.order_id], ['DZD', Number(oa.total), oa.ref]);
  assert.ok(received().some((e) => e.event_id === `lead-${oc.ref}`), 'a cancelled order was still a real person’s form');
  assert.ok(!received().some((e) => e.event_id === `lead-${ob.ref}`));
  const skipped = (await events(`order_id = $1 AND event_name = 'Lead'`, [ob.id]))[0];
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.error, /pas de Lead/);
});

test('FakeOrder: an agent marks the order fake; Meta is told the browser, never the number typed, a few minutes later', async () => {
  sent.length = 0;
  const t0 = Date.now() + 2 * MIN;
  const f = await human({ fbc: 'fb.1.1731000000000.IwAR-click' }, rndPhone(), t0);
  await call('landing.submit', at(admin, t0), f);
  const o = await orderOf(f.phone);
  await mine(o.id);
  await db.query(`UPDATE meta_events SET status = 'sent' WHERE order_id = $1`, [o.id]); // its Lead left already
  await call('orders.setConf', at(conf, t0 + MIN), { ids: [Number(o.id)], status: 'fake', reason: 'N’a pas commandé' });
  let ev = await events(`order_id = $1 AND event_name = 'FakeOrder'`, [o.id]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].event_id, `fake-${o.ref}`);
  assert.equal(new Date(ev[0].send_after).getTime(), t0 + MIN + FAKE_EVENT_DELAY_MS);
  assert.equal((await events(`order_id = $1 AND event_name = 'Competitor'`, [o.id])).length, 0);
  // not yet
  await run(t0 + 5 * MIN);
  assert.ok(!received().some((e) => e.event_id === `fake-${o.ref}`));
  // then it leaves: the browser only
  await run(t0 + MIN + FAKE_EVENT_DELAY_MS + MIN);
  const fake = received().find((e) => e.event_id === `fake-${o.ref}`);
  assert.ok(fake);
  assert.equal(fake.event_name, 'FakeOrder');
  assert.equal(fake.action_source, 'website');
  assert.deepEqual(Object.keys(fake.user_data).sort(), ['client_ip_address', 'client_user_agent', 'fbc', 'fbp']);
  assert.deepEqual([fake.user_data.fbp, fake.user_data.fbc, fake.user_data.client_user_agent, fake.user_data.client_ip_address], [FBP, 'fb.1.1731000000000.IwAR-click', UA, f.meta.ip]);
  assert.deepEqual(fake.custom_data, { content_type: 'product_group', content_ids: [String(productId)] });
  assert.ok(!JSON.stringify(fake).includes(sha256Hex(`213${f.phone.slice(1)}`)), 'the number typed may be a stranger’s');
});

test('FakeOrder: a wrong click put right in time never reaches Meta; marked again, it is queued again', async () => {
  sent.length = 0;
  const t0 = Date.now() + 40 * MIN;
  const f = await human({}, rndPhone(), t0);
  await call('landing.submit', at(admin, t0), f);
  const o = await orderOf(f.phone);
  await mine(o.id);
  await call('orders.setConf', at(conf, t0), { ids: [Number(o.id)], status: 'fake', reason: 'Autre' });
  await call('orders.setConf', at(conf, t0 + 2 * MIN), { ids: [Number(o.id)], status: 'callback', nextCallAt: new Date(t0 + 3600_000).toISOString() });
  let ev = (await events(`order_id = $1 AND event_name = 'FakeOrder'`, [o.id]))[0];
  assert.deepEqual([ev.status, ev.error], ['skipped', 'Plus marquée fausse']);
  await run(t0 + FAKE_EVENT_DELAY_MS + 5 * MIN);
  assert.ok(!received().some((e) => e.event_id === `fake-${o.ref}`));
  // fake after all
  await call('orders.setConf', at(conf, t0 + 30 * MIN), { ids: [Number(o.id)], status: 'fake', reason: 'Autre' });
  ev = (await events(`order_id = $1 AND event_name = 'FakeOrder'`, [o.id]))[0];
  assert.equal(ev.status, 'queued');
  assert.equal(new Date(ev.send_after).getTime(), t0 + 30 * MIN + FAKE_EVENT_DELAY_MS);
  await run(t0 + 30 * MIN + FAKE_EVENT_DELAY_MS + MIN);
  assert.equal(received().filter((e) => e.event_id === `fake-${o.ref}`).length, 1);
});

test('Competitor: the reason « concurrent » names it; a browser Meta cannot recognise is not sent', async () => {
  sent.length = 0;
  const t0 = Date.now() + 3 * 3600_000;
  const f = await human({}, rndPhone(), t0);
  // no Meta cookie and no ad click: a pixel that never ran
  const blind = await human({ fbp: '' }, rndPhone(), t0);
  for (const x of [f, blind]) await call('landing.submit', at(admin, t0), x);
  const [o, ob] = [await orderOf(f.phone), await orderOf(blind.phone)];
  await mine(o.id);
  await mine(ob.id);
  await call('orders.setConf', at(conf, t0), { ids: [Number(o.id)], status: 'fake', reason: '🕵️ Concurrent' });
  await call('orders.setConf', at(conf, t0), { ids: [Number(ob.id)], status: 'fake', reason: 'Autre' });
  assert.deepEqual((await events(`order_id = $1 AND event_name IN ('FakeOrder','Competitor')`, [o.id])).map((e: any) => [e.event_name, e.event_id]), [['Competitor', `competitor-${o.ref}`]]);
  await run(t0 + FAKE_EVENT_DELAY_MS + MIN);
  const comp = received().find((e) => e.event_id === `competitor-${o.ref}`);
  assert.equal(comp?.event_name, 'Competitor');
  assert.ok(!received().some((e) => e.event_id === `fake-${ob.ref}`));
  const skipped = (await events(`order_id = $1 AND event_name = 'FakeOrder'`, [ob.id]))[0];
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.error, /ne reconnaît pas/);
});

test('a blocked order nobody restored in a day: FakeOrder for its browser, once; a script gets no event; a marked device is a Competitor', async () => {
  sent.length = 0;
  const t0 = Date.now() + 6 * 3600_000;
  // a person's browser, sent too fast (blocked); and a script
  const odd = await hasty(t0 + MIN);
  const bot = { ...(await human({ fbp: '' }, rndPhone(), t0)), hp: 'spam', pw: '', meta: { ip: '1.2.3.4', ua: 'curl/8.0' } };
  // the device an agent marked « concurrent »: its next order is blocked as such
  const did = `cmp${Math.random()}`;
  const first = await human({ did }, rndPhone(), t0);
  await call('landing.submit', at(admin, t0), first);
  const fo = await orderOf(first.phone);
  await mine(fo.id);
  await call('orders.setConf', at(conf, t0), { ids: [Number(fo.id)], status: 'fake', reason: '🕵️ Concurrent' });
  const again = await human({ did }, rndPhone(), t0);
  for (const x of [odd, bot, again]) await call('landing.submit', at(admin, t0 + MIN), x);
  const blocked = async (phone: string) => (await db.query(`SELECT * FROM landing_blocked WHERE phone = $1`, [phone]))[0];
  const [bo, bb, ba] = [await blocked(odd.phone), await blocked(bot.phone), await blocked(again.phone)];
  assert.ok(bo && bb && ba);
  assert.ok(ba.reasons.some((r: any) => r.code === 'device_competitor'));

  // within the day: nothing
  await run(t0 + 23 * 3600_000);
  assert.equal((await events(`blocked_id = ANY($1)`, [[bo.id, bb.id, ba.id]])).length, 0);
  // a day later
  const r: any = await run(t0 + MIN + BLOCKED_FAKE_AFTER_MS + MIN);
  assert.ok(r.fakes >= 2);
  const ev = await events(`blocked_id = ANY($1)`, [[bo.id, bb.id, ba.id]]);
  assert.deepEqual(ev.map((e: any) => [Number(e.blocked_id), e.event_name, e.event_id]).sort(), [[Number(bo.id), 'FakeOrder', `fake-blocked-${bo.id}`], [Number(ba.id), 'Competitor', `competitor-blocked-${ba.id}`]].sort());
  const fake = received().find((e) => e.event_id === `fake-blocked-${bo.id}`);
  assert.ok(fake, 'sent in the same run');
  assert.deepEqual(Object.keys(fake.user_data).sort(), ['client_ip_address', 'client_user_agent', 'fbp']);
  assert.equal(fake.event_time, Math.floor((t0 + MIN) / 1000), 'at the time it was blocked');
  assert.equal(received().find((e) => e.event_id === `competitor-blocked-${ba.id}`)?.event_name, 'Competitor');
  // each one looked at once (the script too)
  assert.ok((await blocked(bot.phone)).meta_at && (await blocked(odd.phone)).meta_at);
  const again2: any = await run(t0 + 2 * BLOCKED_FAKE_AFTER_MS);
  assert.equal(again2.fakes, 0);
  assert.equal((await events(`blocked_id = ANY($1)`, [[bo.id, bb.id, ba.id]])).length, 2);

  // the list names them
  const log: any = await call('landing.events', await as(EMAILS.marketer), { limit: 200 });
  for (const name of ['Lead', 'FakeOrder', 'Competitor', 'Purchase']) assert.ok(log.rows.some((x: any) => x.name === name), name);
  const full: any = await call('landing.events', admin, { limit: 200 });
  assert.ok(full.rows.some((x: any) => x.name === 'FakeOrder' && x.customer === odd.name), 'a blocked order’s event shows who it was');
});

test('Delivered: the parcel reached its customer — an event of its own beside Purchase, once, with the customer hashed; not when Purchase itself waits for the delivery', async () => {
  const f = await human();
  await call('landing.submit', admin, f);
  const o = await orderOf(f.phone);
  await mine(o.id);
  await call('orders.setConf', conf, { ids: [Number(o.id)], status: 'confirmed' });
  assert.ok(!(await events(`order_id = $1`, [o.id])).some((e: any) => e.event_name === 'Delivered'), 'confirmed is not delivered');
  // the follow-up says delivered (the couriers' sync and the agents go through the same hook)
  const { onLandingFollow, landingSettings } = await import('../modules/landingquery');
  const s = await landingSettings(db);
  await onLandingFollow(db, s, { id: Number(o.id), landing_id: o.landing_id }, 'out_for_delivery', 'delivered', Date.now());
  await onLandingFollow(db, s, { id: Number(o.id), landing_id: o.landing_id }, 'out_for_delivery', 'delivered', Date.now());
  const ev = (await events(`order_id = $1`, [o.id])).filter((e: any) => e.event_name === 'Delivered');
  assert.deepEqual(ev.map((e: any) => [e.event_id, e.pixel_id, Number(e.value), e.platform]), [[`delivered-${o.ref}`, PIXEL, Number(o.total), 'meta']]);
  sent.length = 0;
  await run(Date.now() + MIN);
  const got = received().find((e: any) => e.event_name === 'Delivered');
  assert.ok(got, 'Meta received it');
  assert.equal(got.event_id, `delivered-${o.ref}`);
  assert.ok(got.user_data?.ph, 'the phone, hashed');
  assert.ok(!JSON.stringify(got).includes(f.phone), 'never the number in clear');
  // an exchange parcel, or a return: nothing
  await onLandingFollow(db, s, { id: Number(o.id), landing_id: o.landing_id, is_exchange: true }, 'shipped', 'delivered', Date.now());
  await onLandingFollow(db, s, { id: Number(o.id), landing_id: o.landing_id }, 'shipped', 'returned', Date.now());
  assert.equal((await events(`order_id = $1 AND event_name = 'Delivered'`, [o.id])).length, 1);
  // Purchase « at delivery »: the delivery is the Purchase, no second event saying the same
  const g = await human();
  await call('landing.submit', admin, g);
  const o2 = await orderOf(g.phone);
  await onLandingFollow(db, { ...s, purchaseAt: 'delivered' }, { id: Number(o2.id), landing_id: o2.landing_id }, 'shipped', 'delivered', Date.now());
  assert.ok(!(await events(`order_id = $1`, [o2.id])).some((e: any) => e.event_name === 'Delivered'));
});

test('TikTok too: the form (SubmitForm) and the delivered parcel (a custom « Delivered ») go to the page’s TikTok pixel, hashed; a fake order tells TikTok the browser it can recognise', async () => {
  await call('landing.pixelSave', admin, { platform: 'tiktok', name: 'TikTok test', pixelId: 'CTESTPIXEL0000000001', isDefault: true, token: 'tt-token' } as any);
  const f = await human();
  await call('landing.submit', admin, f);
  const o = await orderOf(f.phone);
  await mine(o.id);
  await call('orders.setConf', conf, { ids: [Number(o.id)], status: 'confirmed' });
  const { onLandingFollow, landingSettings } = await import('../modules/landingquery');
  await onLandingFollow(db, await landingSettings(db), { id: Number(o.id), landing_id: o.landing_id }, 'out_for_delivery', 'delivered', Date.now());
  const tt = (await events(`order_id = $1 AND platform = 'tiktok'`, [o.id])).map((e: any) => e.event_name).sort();
  assert.deepEqual(tt, ['Delivered', 'Lead', 'Purchase']);
  assert.deepEqual((await events(`order_id = $1 AND platform = 'meta'`, [o.id])).map((e: any) => e.event_name).sort(), ['Delivered', 'Lead', 'Purchase']);
  sent.length = 0;
  await run(Date.now() + MIN);
  const names = sent.filter((x) => x.action === 'tiktok').flatMap((x) => x.args.events.map((e: any) => e.event)).sort();
  assert.deepEqual(names, ['CompletePayment', 'Delivered', 'SubmitForm']);
  const lead = sent.filter((x) => x.action === 'tiktok').flatMap((x) => x.args.events).find((e: any) => e.event === 'SubmitForm');
  assert.equal(lead.event_id, `lead-${o.ref}`);
  assert.ok(lead.user?.phone && !JSON.stringify(lead).includes(f.phone), 'the phone hashed, never in clear');
  // marked fake: TikTok is told the browser too (its own cookie), never the number typed; a browser it cannot recognise is not sent
  const TTP = 'ttp-cookie-0123456789';
  const g = await human({ ttp: TTP });
  await call('landing.submit', admin, g);
  const o2 = await orderOf(g.phone);
  await mine(o2.id);
  const t0 = Date.now();
  await call('orders.setConf', at(conf, t0), { ids: [Number(o2.id)], status: 'fake', reason: 'faux numéro' } as any);
  assert.deepEqual((await events(`order_id = $1 AND event_name = 'FakeOrder'`, [o2.id])).map((e: any) => e.platform).sort(), ['meta', 'tiktok']);
  const h = await human(); // no TikTok cookie
  await call('landing.submit', admin, h);
  const o3 = await orderOf(h.phone);
  await mine(o3.id);
  await call('orders.setConf', at(conf, t0), { ids: [Number(o3.id)], status: 'fake', reason: 'faux numéro' } as any);
  sent.length = 0;
  await run(t0 + FAKE_EVENT_DELAY_MS + MIN);
  const fakes = sent.filter((x) => x.action === 'tiktok').flatMap((x) => x.args.events).filter((e: any) => e.event === 'FakeOrder');
  assert.equal(fakes.length, 1, 'only the browser TikTok can recognise');
  assert.equal(fakes[0].user.ttp, TTP);
  assert.equal(fakes[0].user.user_agent, UA);
  assert.ok(!fakes[0].user.phone && !JSON.stringify(fakes[0]).includes(g.phone), 'never the number typed');
  const skipped = (await events(`order_id = $1 AND platform = 'tiktok' AND event_name = 'FakeOrder'`, [o3.id]))[0];
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.error, /TikTok ne reconnaît pas/);
  // Meta still gets both (its own cookie is there)
  assert.equal(received().filter((e: any) => e.event_name === 'FakeOrder').length, 2);
  // put right in time: the TikTok event is dropped with Meta's
  const k = await human({ ttp: TTP });
  await call('landing.submit', admin, k);
  const o4 = await orderOf(k.phone);
  await mine(o4.id);
  await call('orders.setConf', conf, { ids: [Number(o4.id)], status: 'fake', reason: 'faux numéro' } as any);
  await call('orders.setConf', conf, { ids: [Number(o4.id)], status: 'new' } as any);
  assert.ok((await events(`order_id = $1 AND event_name = 'FakeOrder'`, [o4.id])).every((e: any) => e.status === 'skipped'));
  // a blocked order nobody restored in a day: TikTok is told when the browser carries its cookie; Meta's rule is unchanged
  const tb = Date.now() + 40 * 3600_000;
  const withTt = await hasty(tb + MIN, { ttp: TTP });
  const metaOnly = await hasty(tb + MIN);
  for (const x of [withTt, metaOnly]) await call('landing.submit', at(admin, tb + MIN), x);
  const bl = async (phone: string) => (await db.query(`SELECT * FROM landing_blocked WHERE phone = $1`, [phone]))[0];
  const [b1, b2] = [await bl(withTt.phone), await bl(metaOnly.phone)];
  assert.ok(b1 && b2, 'both were blocked');
  sent.length = 0;
  await run(tb + MIN + BLOCKED_FAKE_AFTER_MS + MIN);
  assert.deepEqual((await events(`blocked_id = $1`, [b1.id])).map((e: any) => e.platform).sort(), ['meta', 'tiktok']);
  assert.deepEqual((await events(`blocked_id = $1`, [b2.id])).map((e: any) => e.platform), ['meta']);
  const bt = sent.filter((x) => x.action === 'tiktok').flatMap((x) => x.args.events).filter((e: any) => e.event_id === `fake-blocked-${b1.id}`);
  assert.equal(bt.length, 1);
  assert.equal(bt[0].user.ttp, TTP);
  assert.ok(!JSON.stringify(bt[0]).includes(withTt.phone));
  await db.query(`DELETE FROM tracking_pixels WHERE pixel_id = 'CTESTPIXEL0000000001'`);
});
