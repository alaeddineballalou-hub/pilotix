// Delivery AI agent: the cases (received, confirmed, shipped, with the livreur, at the desk, failed attempt, cancelled
// by the livreur, delivered), once only, the night, WhatsApp → SMS → by hand, Meta's statuses and templates, the SMS
// gateway, the customer's answers in Message AI agent, the texts, the demo and the roles.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, ServerHooks } from '../index';
import { checkDarija } from '../modules/darija';
import { DEFAULT_TEXTS, firstName, NOTIFY_KINDS, ordersForDellal, render, sendTime, smsParts, smsValidUntil, templateBody, templateParams, textProblems } from '../modules/notify';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let items: { productId: number; variantId: number; qty: number }[];
before(async () => {
  ({ db, as } = await setup(400));
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.active AND NOT p.is_service ORDER BY p.id, v.id LIMIT 1`))[0];
  items = [{ productId: Number(p.id), variantId: Number(p.vid), qty: 1 }];
  // the tests send at any hour: no quiet hours, except in the test about the night
  await save({ quietFrom: 0, quietTo: 0 });
});

async function save(patch: Record<string, unknown>) {
  const admin = await as(EMAILS.admin);
  const g: any = await call('notify.settings.get', admin, {});
  return call('notify.settings.save', admin, { ...g.settings, ...patch }) as Promise<any>;
}
let phoneN = 0;
/** A fresh number; `last` is its last digit (3 or 7: no WhatsApp in the preview). */
const phone = (last = 0) => `0661${String(100000 + ++phoneN * 10).slice(-5)}${String(last).padStart(1, '0')}`.slice(0, 10);
const newOrder = async (ctx: Ctx, extra: Record<string, unknown> = {}) =>
  (await call('orders.create', ctx, { customerName: 'amina boudiaf', phone: phone(), wilayaId: 16, commune: 'Kouba', items, ...extra })) as any;
const notes = (orderId: number) => db.query(`SELECT * FROM notifications WHERE order_id = $1 ORDER BY id`, [orderId]);
const kinds = async (orderId: number) => (await notes(orderId)).map((n: any) => `${n.kind}:${n.status}`);

/** A fake server: records every action; WhatsApp and SMS answer with ids. */
function fakeServer(
  log: { action: string; args: any }[],
  opts: { waError?: { message: string; metaCode?: number }; templates?: { name: string; status: string }[]; complete?: (req: any) => any; waId?: string; smsError?: string } = {},
): ServerHooks {
  return {
    courier: async () => ({}),
    meta: async () => ({}),
    hashPassword: async (p) => p,
    dellal: async (action, args: any) => {
      log.push({ action, args });
      if (action === 'complete') return opts.complete ? opts.complete(args) : { content: [{ type: 'text', text: 'Saha 🙏' }], stop_reason: 'end_turn' };
      if (action === 'waTemplate') {
        if (opts.waError) throw Object.assign(new Error(opts.waError.message), { metaCode: opts.waError.metaCode });
        return { id: opts.waId ?? `wamid.${log.length}` };
      }
      if (action === 'sms') {
        if (opts.smsError) throw new Error(opts.smsError);
        return { id: `sms-${log.length}`, status: 'Pending' };
      }
      if (action === 'waTemplates') return opts.templates ?? [];
      return { ok: true };
    },
  };
}

test('the default texts: Algerian Darija, cheap SMS, valid WhatsApp templates', () => {
  const ex = { nom: 'Amina', boutique: 'Bébé Shop', ref: 'PX2041', produits: 'Poussette canne pliable Gris', total: '13 200', societe: 'Yalidine', suivi: 'YAL-48213', bureau: 'Yalidine Bab Ezzouar', commune: 'Bab Ezzouar', wilaya: 'Alger' };
  for (const k of NOTIFY_KINDS) {
    for (const l of ['dz', 'fr', 'ar'] as const) {
      const t = DEFAULT_TEXTS[k][l];
      assert.deepEqual(textProblems(t), [], `${k} ${l}`);
      assert.doesNotMatch(t, /[’😀-🙏]/u, `${k} ${l}: no curly apostrophe or emoji`);
      const body = render(t, ex);
      assert.doesNotMatch(body, /\{\w+\}/);
      // Latin texts stay in the cheap SMS alphabet: 2 SMS at most
      if (l !== 'ar') assert.ok(!smsParts(body).unicode && smsParts(body).parts <= 2, `${k} ${l}: ${JSON.stringify(smsParts(body))}`);
    }
    assert.deepEqual(checkDarija(render(DEFAULT_TEXTS[k].dz, ex), { customer: '', avoid: [] }), [], k);
  }
  assert.equal(templateBody('Salam {nom}, la commande {ref} : {total} DA.'), 'Salam {{1}}, la commande {{2}} : {{3}} DA.');
  assert.deepEqual(templateParams('Salam {nom}, {produits}.', { nom: 'Amina', produits: 'A\nB' }), ['Amina', 'A B']);
  assert.deepEqual(templateParams('Salam {nom}.', { nom: '' }), ['-']);
  assert.match(textProblems('{nom}, votre commande est partie')[0], /commencer ou finir/);
  assert.match(textProblems('Bonjour {client}, votre commande est partie.')[0], /Variable inconnue \{client\}/);
  assert.equal(smsParts('a'.repeat(160)).parts, 1);
  assert.equal(smsParts('a'.repeat(161)).parts, 2);
  assert.equal(smsParts('À payer').unicode, true);
  assert.equal(smsParts('السلام').unicode, true);
  // first names
  assert.equal(firstName('amina BOUDIAF', 'dz'), 'Amina');
  assert.equal(firstName('Om yasmine', 'fr'), 'Om Yasmine');
  assert.equal(firstName('client', 'dz'), '3likom');
  assert.equal(firstName('X', 'fr'), 'Madame, Monsieur');
  assert.equal(firstName('أمينة', 'dz'), '3likom'); // an Arabic name would make a Latin SMS expensive
  assert.equal(firstName('أمينة', 'ar'), 'أمينة');
  assert.equal(render('Salam {nom}, m3akom {boutique}.', { nom: '3likom', boutique: 'Shop' }), 'Salam 3likom, m3akom Shop.');
});

test('a new order: "received", then "confirmed" once; WhatsApp, or SMS when the number has no WhatsApp', async () => {
  const conf = await as(EMAILS.conf);
  const o = await newOrder(conf);
  let n = await notes(o.id);
  assert.deepEqual(n.map((x: any) => [x.kind, x.status, x.channel]), [['created', 'whatsapp', 'whatsapp']]);
  assert.match(n[0].body, new RegExp(`^Salam Amina, m3akom .+\\. La commande ta3kom ${o.ref} wslatna : .+, [\\d ]+ DA\\. Ra7 n3ayetoulkom bach nconfirmiw m3akom`));
  await call('orders.setConf', conf, { ids: [o.id], status: 'confirmed' });
  assert.deepEqual(await kinds(o.id), ['created:whatsapp', 'confirmed:whatsapp']);
  n = await notes(o.id);
  assert.match(n[1].body, /tconfirmat : .+ DA m3a la livraison/);
  // back to "callback" and confirmed again: no second message
  await call('orders.setConf', conf, { ids: [o.id], status: 'callback', nextCallAt: new Date(Date.now() + 3_600_000).toISOString() });
  await call('orders.setConf', conf, { ids: [o.id], status: 'confirmed' });
  assert.deepEqual(await kinds(o.id), ['created:whatsapp', 'confirmed:whatsapp']);
  // in the order's history
  const ev = await db.query(`SELECT from_value, to_value, note FROM order_events WHERE order_id = $1 AND kind = 'chat' ORDER BY id`, [o.id]);
  assert.deepEqual(ev.map((e: any) => [e.from_value, e.to_value]), [['whatsapp', 'created'], ['whatsapp', 'confirmed']]);
  assert.equal(ev[0].note, n[0].body);

  // no WhatsApp on this number (preview: ends in 3 or 7) → SMS
  const o2 = await newOrder(conf, { phone: phone(7), customerName: 'Client' });
  const n2 = (await notes(o2.id))[0];
  assert.equal(n2.status, 'sms');
  assert.equal(n2.channel, 'sms');
  assert.match(n2.error, /Pas de WhatsApp/);
  assert.match(n2.body, /^Salam 3likom, m3akom/);
  // created already confirmed: only "confirmed"; an SAV exchange: nothing
  const o3 = await newOrder(conf, { confirm: true });
  assert.deepEqual(await kinds(o3.id), ['confirmed:whatsapp']);
  const ex = await newOrder(await as(EMAILS.admin), { isExchange: true, originalOrderId: o.id, items: [{ ...items[0], unitPrice: 0 }] });
  assert.deepEqual(await kinds(ex.id), []);
  // a blacklisted customer's order (to check) gets nothing until it is confirmed
  const cust = (await db.query(`SELECT phone FROM customers WHERE blacklisted LIMIT 1`))[0];
  if (cust) {
    const bl = await newOrder(conf, { phone: cust.phone });
    assert.equal(bl.confStatus, 'to_check');
    assert.deepEqual(await kinds(bl.id), []);
  }
});

test('delivery: shipped, with the livreur, failed attempt, cancelled by the livreur; at the desk; once each; delivered when on', async () => {
  const conf = await as(EMAILS.conf);
  const suivi = await as(EMAILS.suivi);
  const o = await newOrder(conf, { confirm: true });
  const go = (status: string, ids = [o.id]) => call('orders.setFollow', suivi, { ids, status });
  await go('prepared');
  await go('shipped');
  await go('out_for_delivery');
  await go('failed');
  await go('out_for_delivery'); // the livreur tries again the same day: no second "with the livreur"
  await go('alert');
  await go('shipped'); // back on the road after an alert: "shipped" is not sent twice
  await go('returning');
  assert.deepEqual(await kinds(o.id), ['confirmed:whatsapp', 'shipped:whatsapp', 'out_for_delivery:whatsapp', 'failed:whatsapp', 'returning:whatsapp']);
  const n = await notes(o.id);
  assert.match(n[1].body, /kherjet m3a .+, tousel normalement bin 24 w 72 sa3a\. Tkhallsou [\d ]+ DA ki testalmou\. Numéro de suivi : /);
  assert.match(n[2].body, /rahi m3a le livreur lyoum/);
  assert.match(n[3].body, /ma9derch ywasselkom la commande/);
  assert.match(n[4].body, /tannulat 3and le livreur/);

  // at the desk (stop desk)
  const d = await newOrder(conf, { confirm: true, isStopdesk: true, commune: 'Hydra' });
  await go('shipped', [d.id]);
  await go('out_for_delivery', [d.id]);
  const dn = await notes(d.id);
  assert.equal(dn[2].kind, 'stopdesk');
  assert.match(dn[2].body, /rahi testennakom f le bureau .*Hydra\. Jibou [\d ]+ DA bach testalmouha\./);

  // back at the depot, lost, exchanged…: no message
  await go('returned');
  assert.equal((await notes(o.id)).length, 5);

  // delivered: off by default, then on
  await go('delivered', [d.id]);
  assert.equal((await notes(d.id)).length, 3);
  await save({ cases: { created: true, confirmed: true, shipped: true, out_for_delivery: true, stopdesk: true, failed: true, returning: true, delivered: true } });
  const e = await newOrder(conf, { confirm: true });
  await go('shipped', [e.id]);
  await go('delivered', [e.id]);
  assert.deepEqual(await kinds(e.id), ['confirmed:whatsapp', 'shipped:whatsapp', 'delivered:whatsapp']);
  // a case turned off sends nothing
  await save({ cases: { created: false, confirmed: true, shipped: true, out_for_delivery: true, stopdesk: true, failed: true, returning: true, delivered: false } });
  const f = await newOrder(conf);
  assert.deepEqual(await kinds(f.id), []);
  await save({ cases: { created: true, confirmed: true, shipped: true, out_for_delivery: true, stopdesk: true, failed: true, returning: true, delivered: false } });

  // a parcel that left more than 15 days ago (a courier's first sync): no message
  const old = await newOrder(conf, { confirm: true });
  await db.query(`UPDATE orders SET follow_status = 'shipped', shipped_at = now() - interval '20 days', confirmed_at = now() - interval '21 days', created_at = now() - interval '22 days' WHERE id = $1`, [old.id]);
  await go('delivered', [old.id]);
  // a finished order only changes with a reason (the suivi corrects a wrong « Livré »)
  await call('orders.setFollow', suivi, { ids: [old.id], status: 'returning', note: 'livré par erreur chez la société' });
  assert.deepEqual(await kinds(old.id), ['confirmed:whatsapp']);
});

test('the night: messages wait for 8:00, a newer step replaces the older one, "send now" sends at once', async () => {
  await save({ quietFrom: 22, quietTo: 8 });
  try {
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const at = (h: number, m = 0) => day + (h - 1) * 3_600_000 + m * 60_000; // Algeria time (UTC+1)
    assert.equal(sendTime(at(23), { quietFrom: 22, quietTo: 8 }), at(8) + 86_400_000);
    assert.equal(sendTime(at(6, 30), { quietFrom: 22, quietTo: 8 }), at(8));
    assert.equal(sendTime(at(13), { quietFrom: 22, quietTo: 8 }), at(13));
    const night = async (t: number, email = EMAILS.conf) => Object.assign(await as(email), { now: () => t });
    const conf = await night(at(23));
    const o = await newOrder(conf);
    let n = await notes(o.id);
    assert.equal(n[0].status, 'queued');
    assert.equal(new Date(n[0].send_after).getTime(), at(8) + 86_400_000);
    // still night at 7:59; at 8:01 it leaves
    await call('notify.feed', await night(at(7, 59) + 86_400_000), {});
    assert.equal((await notes(o.id))[0].status, 'queued');
    await call('notify.feed', await night(at(8, 1) + 86_400_000), {});
    assert.equal((await notes(o.id))[0].status, 'whatsapp');

    // shipped at 23:00 then with the livreur at 7:00: only the newer one is sent in the morning
    const s = await newOrder(await night(at(13)), { confirm: true });
    await call('orders.setFollow', await night(at(23), EMAILS.suivi), { ids: [s.id], status: 'shipped' });
    await call('orders.setFollow', await night(at(7) + 86_400_000, EMAILS.suivi), { ids: [s.id], status: 'out_for_delivery' });
    n = await notes(s.id);
    assert.deepEqual(n.map((x: any) => `${x.kind}:${x.status}`), ['confirmed:whatsapp', 'shipped:skipped', 'out_for_delivery:queued']);
    assert.match(n[1].error, /Remplacé/);
    // "Envoyer maintenant"
    const r: any = await call('notify.sendNow', await as(EMAILS.suivi), { id: Number(n[2].id) });
    assert.equal(r.status, 'whatsapp');
    // waiting messages are not sent after the agent is stopped
    const w = await newOrder(conf);
    assert.equal((await notes(w.id))[0].status, 'queued');
    await save({ enabled: false });
    assert.equal((await notes(w.id))[0].status, 'skipped');
  } finally {
    await save({ enabled: true, quietFrom: 0, quietTo: 0 });
  }
});

test('a waiting message whose order moved on is not sent (no outdated news)', async () => {
  await save({ quietFrom: 22, quietTo: 8 });
  try {
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const conf = Object.assign(await as(EMAILS.conf), { now: () => day + 22 * 3_600_000 });
    const o = await newOrder(conf);
    // cancelled before the morning (no new message is queued by a cancellation)
    await db.query(`UPDATE orders SET conf_status = 'cancelled' WHERE id = $1`, [o.id]);
    await call('notify.feed', Object.assign(await as(EMAILS.conf), { now: () => day + 31 * 3_600_000 }), {});
    const n = (await notes(o.id))[0];
    assert.equal(n.status, 'skipped');
    assert.match(n.error, /statut de la commande a changé/);
  } finally {
    await save({ quietFrom: 0, quietTo: 0 });
  }
});

test('no SMS sender: the list "to send by hand", marked as sent', async () => {
  await save({ sms: 'manual' });
  try {
    const conf = await as(EMAILS.conf);
    const o = await newOrder(conf, { phone: phone(3) });
    const n = (await notes(o.id))[0];
    assert.equal(n.status, 'manual');
    const feed: any = await call('notify.feed', conf, { tab: 'todo' });
    assert.ok(feed.rows.some((r: any) => r.id === Number(n.id)));
    assert.ok(feed.counts.todo >= 1);
    const counts: any = await call('orders.counts', conf, {});
    assert.ok(counts.ai.notify >= 1);
    await call('notify.markSent', conf, { id: Number(n.id), via: 'sms' });
    const done = (await notes(o.id))[0];
    assert.equal(done.status, 'done');
    assert.ok(done.sent_at);
    const ev = (await db.query(`SELECT from_value, user_id FROM order_events WHERE order_id = $1 AND kind = 'chat'`, [o.id]))[0];
    assert.equal(ev.from_value, 'manual_sms');
    assert.equal(Number(ev.user_id), conf.session.profile.id);
    // a manual "received" message whose order got confirmed is dropped from the list
    const o2 = await newOrder(conf, { phone: phone(3) });
    await call('orders.setConf', conf, { ids: [o2.id], status: 'confirmed' });
    assert.deepEqual(await kinds(o2.id), ['created:skipped', 'confirmed:manual']);
  } finally {
    await save({ sms: 'gateway' });
  }
});

test('server: Meta templates, WhatsApp, delivery statuses, fallback to SMS, the SMS gateway', async () => {
  const log: { action: string; args: any }[] = [];
  const admin = await as(EMAILS.admin, fakeServer(log, { templates: [] }));
  // Message AI agent's WhatsApp number is connected
  await db.query(`UPDATE settings SET value = value || '{"whatsappPhoneId":"1098765432"}'::jsonb WHERE key = 'dellal'`);
  await db.query(`INSERT INTO settings (key, value) VALUES ('secret_dellal_wa_token', '"EAAB-wa"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  await save({ wabaId: '', templates: undefined });
  await db.query(`UPDATE settings SET value = value - 'templates' WHERE key = 'notify'`);
  const conf = await as(EMAILS.conf, admin.server);
  const run = () => call('notify.run', admin, {}) as Promise<any>;

  // no template at Meta yet: SMS through the gateway
  const o = await newOrder(conf);
  assert.equal((await notes(o.id))[0].status, 'queued'); // sent by the server's job
  await run();
  let n = (await notes(o.id))[0];
  assert.equal(n.status, 'sms');
  assert.match(n.error, /pas encore envoyé à Meta/);
  const sms = log.find((l) => l.action === 'sms')!;
  assert.equal(sms.args.to, n.phone);
  assert.equal(sms.args.text, n.body);
  assert.ok(Date.parse(sms.args.validUntil) > Date.now() + 14 * 60_000);
  assert.equal(n.sms_id, 'sms-' + (log.indexOf(sms) + 1));
  // the gateway says delivered
  await call('notify.smsEvent', admin, { event: 'delivered', id: n.sms_id });
  assert.ok((await notes(o.id))[0].delivered_at);

  // send the texts to Meta: one template per case that is on, then approved
  await assert.rejects(call('notify.templates.submit', admin, {}), /ID du compte WhatsApp Business/);
  await save({ wabaId: '102938475610293' });
  const sub: any = await call('notify.templates.submit', admin, {});
  const created = log.filter((l) => l.action === 'waCreateTemplate');
  assert.deepEqual(created.map((c) => c.args.name), ['pilotix_created_dz', 'pilotix_confirmed_dz', 'pilotix_shipped_dz', 'pilotix_out_for_delivery_dz', 'pilotix_stopdesk_dz', 'pilotix_failed_dz', 'pilotix_returning_dz']);
  assert.equal(created[0].args.lang, 'fr');
  assert.equal(created[0].args.body, templateBody(DEFAULT_TEXTS.created.dz));
  assert.equal(created[0].args.example.length, 5);
  assert.ok(sub.results.every((r: any) => r.ok));
  assert.equal(sub.view.cases[0].template.status, 'PENDING');
  const approved = created.map((c) => ({ name: c.args.name, status: 'APPROVED', language: 'fr' }));
  const v: any = await call('notify.templates.check', await as(EMAILS.admin, fakeServer(log, { templates: approved })), {});
  assert.equal(v.cases.find((c: any) => c.kind === 'shipped').template.status, 'APPROVED');

  // approved: WhatsApp template with its parameters
  const o2 = await newOrder(conf, { customerName: 'Yasmine Kaci' });
  await run();
  n = (await notes(o2.id))[0];
  assert.equal(n.status, 'whatsapp');
  assert.equal(n.wa_status, 'sent');
  const wa = log.filter((l) => l.action === 'waTemplate').pop()!;
  assert.equal(wa.args.name, 'pilotix_created_dz');
  assert.equal(wa.args.lang, 'fr');
  assert.equal(wa.args.to, '213' + n.phone.slice(1));
  assert.equal(wa.args.params[0], 'Yasmine');
  assert.equal(wa.args.params[2], o2.ref);
  // Meta: delivered, then read
  await call('notify.waStatus', admin, { id: n.wa_id, status: 'delivered' });
  await call('notify.waStatus', admin, { id: n.wa_id, status: 'read' });
  n = (await notes(o2.id))[0];
  assert.equal(n.wa_status, 'read');
  assert.ok(n.delivered_at && n.read_at);

  // Meta: failed (no WhatsApp on this number) → SMS
  const o3 = await newOrder(conf);
  await run();
  n = (await notes(o3.id))[0];
  const before = log.filter((l) => l.action === 'sms').length;
  await call('notify.waStatus', admin, { id: n.wa_id, status: 'failed', code: 131026, title: 'Message undeliverable' });
  // Meta sends the same status twice: still one SMS
  await call('notify.waStatus', admin, { id: n.wa_id, status: 'failed', code: 131026, title: 'Message undeliverable' });
  assert.equal((await notes(o3.id))[0].status, 'queued');
  await run();
  await run();
  n = (await notes(o3.id))[0];
  assert.equal(n.status, 'sms');
  assert.equal(n.wa_status, 'failed');
  assert.match(n.error, /WhatsApp : Message undeliverable \(131026\)/);
  assert.equal(log.filter((l) => l.action === 'sms').length, before + 1);

  // WhatsApp refuses at once (number not allowed) → SMS; Meta busy → tried again later
  const refused = await as(EMAILS.admin, fakeServer(log, { waError: { message: 'WhatsApp : Recipient phone number not in allowed list', metaCode: 131030 } }));
  const o4 = await newOrder(conf);
  await call('notify.run', refused, {});
  assert.equal((await notes(o4.id))[0].status, 'sms');
  const busy = await as(EMAILS.admin, fakeServer(log, { waError: { message: 'WhatsApp injoignable' } }));
  const o5 = await newOrder(conf);
  await call('notify.run', busy, {});
  n = (await notes(o5.id))[0];
  assert.equal(n.status, 'queued');
  assert.equal(n.attempts, 1);
  assert.ok(new Date(n.send_after).getTime() > Date.now() + 9 * 60_000);

  // a WhatsApp still not received after an hour → SMS
  const o6 = await newOrder(conf);
  await run();
  await db.query(`UPDATE notifications SET sent_at = now() - interval '2 hours' WHERE order_id = $1`, [o6.id]);
  await run();
  n = (await notes(o6.id))[0];
  assert.equal(n.status, 'sms');
  assert.match(n.error, /pas reçu après 1 h/);

  // the text changes after approval: SMS until the new text is approved, as a new template (_v2)
  const g: any = await call('notify.settings.get', admin, {});
  await call('notify.settings.save', admin, { ...g.settings, texts: { created: { dz: 'Salam {nom}, m3akom {boutique}. La commande {ref} wslatna, ra7 n3ayetoulkom.' } } });
  const v2: any = await call('notify.settings.get', admin, {});
  assert.equal(v2.cases[0].template.status, 'CHANGED');
  assert.equal(v2.cases[0].custom, true);
  const o7 = await newOrder(conf);
  await run();
  n = (await notes(o7.id))[0];
  assert.equal(n.status, 'sms');
  assert.match(n.error, /Texte modifié/);
  assert.match(n.body, /La commande PX\d+ wslatna, ra7 n3ayetoulkom\.$/);
  await call('notify.templates.submit', admin, {});
  assert.equal(log.filter((l) => l.action === 'waCreateTemplate').pop()!.args.name, 'pilotix_created_dz_v2');
  // a bad text is refused
  await assert.rejects(call('notify.settings.save', admin, { ...g.settings, texts: { shipped: { dz: '{nom} la commande est partie' } } }), /Expédiée : Le texte ne peut pas commencer/);
  // back to the default text: no custom text kept
  await call('notify.settings.save', admin, { ...g.settings, texts: { created: { dz: DEFAULT_TEXTS.created.dz } } });
  assert.equal(((await call('notify.settings.get', admin, {})) as any).cases[0].custom, false);
  // the SMS gateway's webhooks point to this server with the secret key
  const hooks: any = await call('notify.smsHooks', admin, { baseUrl: 'https://pilotix.example.dz/' });
  assert.match(hooks.url, /^https:\/\/pilotix\.example\.dz\/api\/hooks\/sms\?key=sms-/);
  assert.equal(log.filter((l) => l.action === 'smsHooks').pop()!.args.url, hooks.url);
  // the secrets are never returned
  await call('notify.settings.save', admin, { ...g.settings, texts: {}, smsSecret: 'gateway-password' });
  const back: any = await call('notify.settings.get', admin, {});
  assert.equal(JSON.stringify(back).includes('gateway-password'), false);
  assert.equal(back.meta.smsSecret, true);
  // a test message
  const t: any = await call('notify.test', await as(EMAILS.admin, fakeServer(log)), { phone: '0661 22 33 44', kind: 'shipped' });
  assert.equal(t.channel, 'whatsapp');
  assert.match(t.body, /kherjet m3a Yalidine/);
  await db.query(`UPDATE settings SET value = value - 'whatsappPhoneId' WHERE key = 'dellal'`);
  await db.query(`DELETE FROM settings WHERE key = 'secret_dellal_wa_token'`);
});

test('answers: the delivery message shows in Message AI agent before the answer, Dellal knows the order', async () => {
  const conf = await as(EMAILS.conf);
  const suivi = await as(EMAILS.suivi);
  const o = await newOrder(conf, { confirm: true, customerName: 'Selma Haddad' });
  await call('orders.setFollow', suivi, { ids: [o.id], status: 'shipped' });
  await call('orders.setFollow', suivi, { ids: [o.id], status: 'failed' });
  const failed = (await notes(o.id)).find((x: any) => x.kind === 'failed');
  assert.equal(failed.status, 'whatsapp');

  // Dellal on, with its AI (fake): the customer answers on WhatsApp
  const log: { action: string; args: any }[] = [];
  let round = 0;
  const server = fakeServer(log, {
    complete: () =>
      round++ === 0
        ? { content: [{ type: 'tool_use', id: 't1', name: 'handoff', input: { reason: `renvoyer ${o.ref}` } }], stop_reason: 'tool_use' }
        : { content: [{ type: 'text', text: 'Saha Selma 🙏 Nkhabbar l’équipe bach y3awdou yab3atouhalkom.' }], stop_reason: 'end_turn' },
  });
  const admin = await as(EMAILS.admin, server);
  const g: any = await call('dellal.settings.get', admin, {});
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, whatsappPhoneId: '1098765432', secrets: { ai: 'sk-ant-test-notify', waToken: 'EAAB-wa' } });
  const wa = '213' + o.phone.slice(1);
  const r: any = await call('dellal.receive', admin, { channel: 'whatsapp', externalId: wa, text: 'Wah mazal nhabha', messageId: 'wamid.in.1' });
  const msgs = await db.query(`SELECT role, body, meta FROM conv_messages WHERE conversation_id = $1 ORDER BY id`, [r.conversationId]);
  assert.equal(msgs[0].role, 'agent');
  assert.equal(msgs[0].body, failed.body);
  assert.equal(msgs[0].meta.notify, 'failed');
  assert.equal(msgs[0].meta.ref, o.ref);
  assert.equal(msgs[1].role, 'customer');
  // noted on the message and in the order's history
  const after = (await notes(o.id)).find((x: any) => x.kind === 'failed');
  assert.equal(after.reply, 'Wah mazal nhabha');
  assert.ok(after.replied_at);
  const ev = await db.query(`SELECT from_value, note FROM order_events WHERE order_id = $1 AND kind = 'chat' AND to_value = 'reply'`, [o.id]);
  assert.deepEqual(ev.map((e: any) => [e.from_value, e.note]), [['whatsapp', 'Wah mazal nhabha']]);
  // a second message: the delivery message is not shown twice, the first answer stays
  await call('dellal.receive', admin, { channel: 'whatsapp', externalId: wa, text: 'ab3athouha ghodwa', messageId: 'wamid.in.2' });
  const msgs2 = await db.query(`SELECT role FROM conv_messages WHERE conversation_id = $1 ORDER BY id`, [r.conversationId]);
  assert.deepEqual(msgs2.map((m: any) => m.role), ['agent', 'customer', 'customer']);
  assert.equal((await notes(o.id)).find((x: any) => x.kind === 'failed').reply, 'Wah mazal nhabha');

  // Dellal answers: its instructions have the customer's orders and the delivery messages
  await call('dellal.answer', admin, { id: r.conversationId });
  const req = log.find((l) => l.action === 'complete')!.args;
  assert.match(req.system, /Commandes récentes de ce client/);
  assert.match(req.system, new RegExp(`${o.ref} .*tentative de livraison échouée.*dernier message automatique : « Livraison échouée »`));
  assert.match(req.system, /renvoyer <référence>/);
  // the AI sees the delivery message before the customer's first words
  assert.match(String(req.messages[0].content), /\(Avant, la boutique a écrit au client : \[message automatique de suivi de la commande PX\d+\] Salam Selma/);
  const conv = (await db.query(`SELECT mode, handoff_reason FROM conversations WHERE id = $1`, [r.conversationId]))[0];
  assert.equal(conv.mode, 'handoff');

  // an SMS answer (from the gateway)
  const o2 = await newOrder(conf, { phone: phone(3) });
  const n2 = (await notes(o2.id))[0];
  assert.equal(n2.status, 'sms');
  await call('notify.smsEvent', admin, { event: 'received', phone: '+213' + o2.phone.slice(1), text: 'Oui c’est bon' });
  assert.equal((await notes(o2.id))[0].reply, 'Oui c’est bon');

  // feed: the answers tab
  const f: any = await call('notify.feed', conf, { tab: 'replies' });
  assert.ok(f.rows.some((x: any) => x.ref === o.ref && x.reply === 'Wah mazal nhabha' && x.conversationId === r.conversationId));
  await db.query(`UPDATE settings SET value = value || '{"enabled":false,"whatsappPhoneId":""}'::jsonb WHERE key = 'dellal'`);
  await db.query(`DELETE FROM settings WHERE key IN ('secret_dellal_wa_token','secret_dellal_ai_key')`);
});

test('an order taken by Message AI agent on WhatsApp: no "received" or "confirmed" message', async () => {
  const log: { action: string; args: any }[] = [];
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.active AND NOT p.is_service
     AND (SELECT count(*) FROM product_variants x WHERE x.product_id = p.id AND x.active) = 1 ORDER BY p.id LIMIT 1`))[0];
  const ph = phone();
  let step = 0;
  const server = fakeServer(log, {
    complete: () =>
      step++ === 0
        ? { content: [{ type: 'tool_use', id: 't1', name: 'create_order', input: { customer_name: 'Lina Touati', phone: ph, wilaya: '16', commune: 'Kouba', items: [{ product_id: Number(p.id), qty: 1 }] } }], stop_reason: 'tool_use' }
        : { content: [{ type: 'text', text: 'C’est noté, saha 🙏' }], stop_reason: 'end_turn' },
  });
  const admin = await as(EMAILS.admin, server);
  const g: any = await call('dellal.settings.get', admin, {});
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, whatsappPhoneId: '1098765432', secrets: { ai: 'sk-ant-test-notify', waToken: 'EAAB-wa' } });
  // stock for the product, so the order can be taken
  await db.query(`INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, (SELECT id FROM warehouses ORDER BY id LIMIT 1), 50) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = stock.qty + 50`, [p.vid]);
  const r: any = await call('dellal.receive', admin, { channel: 'whatsapp', externalId: '213' + ph.slice(1), text: 'nheb ncommandi', messageId: 'wamid.in.x' });
  const out: any = await call('dellal.answer', admin, { id: r.conversationId });
  assert.ok(out.orderRef, JSON.stringify(out));
  const o = (await db.query(`SELECT id FROM orders WHERE ref = $1`, [out.orderRef]))[0];
  const n = await notes(Number(o.id));
  assert.deepEqual(n.map((x: any) => x.status), ['skipped']);
  assert.match(n[0].error, /conversation WhatsApp/);
  await call('notify.run', admin, {});
  assert.equal(log.filter((l) => l.action === 'waTemplate' || l.action === 'sms').length, 0);
  await db.query(`UPDATE settings SET value = value || '{"enabled":false,"whatsappPhoneId":""}'::jsonb WHERE key = 'dellal'`);
  await db.query(`DELETE FROM settings WHERE key IN ('secret_dellal_wa_token','secret_dellal_ai_key')`);
});

test('the demo: messages of the last days, answers, saved parcels; results', async () => {
  const conf = await as(EMAILS.conf);
  const f: any = await call('notify.feed', conf, { tab: 'all', limit: 300 });
  assert.ok(f.enabled);
  assert.ok(f.demo);
  assert.ok(f.counts.whatsapp > 10 && f.counts.sms > 0, JSON.stringify(f.counts));
  assert.ok(f.counts.replies >= 2);
  assert.ok(f.counts.problems >= 1);
  const kindsSeen = new Set(f.rows.map((r: any) => r.kind));
  for (const k of ['created', 'confirmed', 'shipped', 'out_for_delivery']) assert.ok(kindsSeen.has(k), k);
  for (const r of f.rows.filter((x: any) => x.status === 'whatsapp' || x.status === 'sms')) assert.doesNotMatch(r.body, /\{\w+\}/);
  const st: any = await call('notify.stats', conf, { days: 7 });
  assert.ok(st.sent > 20);
  assert.ok(st.saved >= 1, JSON.stringify(st));
  assert.ok(st.savedAmount > 0);
  assert.ok(st.byKind.created.sent > 0);
  const p: any = await call('notify.preview', conf, { kind: 'shipped' });
  assert.match(p.body, /^Salam Amina, m3akom /);
  assert.equal(p.params.length, 6);
  const t: any = await call('notify.test', await as(EMAILS.admin), { phone: '0661223347', kind: 'failed' });
  assert.equal(t.channel, 'sms'); // ends in 7: no WhatsApp in the preview
  assert.equal(t.demo, true);
});

test('roles: the follow-up team and the sellers see the messages; only an admin changes the settings', async () => {
  for (const email of [EMAILS.livreur, EMAILS.depot, EMAILS.marketer]) await assert.rejects(call('notify.feed', await as(email), {}), /Accès refusé/);
  await call('notify.feed', await as(EMAILS.suivi), {});
  await call('notify.feed', await as(EMAILS.conf), {});
  await assert.rejects(call('notify.settings.get', await as(EMAILS.suivi), {}), /Accès refusé/);
  await assert.rejects(call('notify.run', await as(EMAILS.conf), {}), /Accès refusé/);
  await assert.rejects(call('notify.waStatus', await as(EMAILS.suivi), { id: 'x', status: 'read' }), /Accès refusé/);
  // a test message is billed: admins only
  await assert.rejects(call('notify.test', await as(EMAILS.conf), { phone: '0661223344', kind: 'shipped' }), /Accès refusé/);
});

// ---------------------------------------------------------------- the independent review's cases
/** WhatsApp connected, every text approved at Meta (the server path). */
async function whatsappReady() {
  await db.query(`UPDATE settings SET value = value || '{"whatsappPhoneId":"1098765432"}'::jsonb WHERE key = 'dellal'`);
  await db.query(`INSERT INTO settings (key, value) VALUES ('secret_dellal_wa_token', '"EAAB-wa"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const templates = Object.fromEntries(NOTIFY_KINDS.map((k) => [`${k}_dz`, { name: `pilotix_${k}_dz`, text: DEFAULT_TEXTS[k].dz, status: 'APPROVED', version: 1 }]));
  await db.query(`UPDATE settings SET value = value || $1::jsonb WHERE key = 'notify'`, [JSON.stringify({ templates, texts: {}, sms: 'gateway', whatsapp: true, quietFrom: 0, quietTo: 0 })]);
}
/** A confirmed order shipped through the server path: its "shipped" message is queued. */
async function shippedOrder(server: ServerHooks) {
  const o = await newOrder(await as(EMAILS.conf, server), { confirm: true });
  await call('orders.setFollow', await as(EMAILS.suivi, server), { ids: [o.id], status: 'shipped' });
  return o;
}
const shippedRow = async (orderId: number) => (await notes(orderId)).find((x: any) => x.kind === 'shipped');

test('review: the 1-hour SMS fallback that fails is tried again by SMS, never by WhatsApp again', async () => {
  await whatsappReady();
  const log: { action: string; args: any }[] = [];
  const ok = fakeServer(log);
  const o = await shippedOrder(ok);
  await call('notify.run', await as(EMAILS.admin, ok), {});
  let n = await shippedRow(o.id);
  assert.equal(n.status, 'whatsapp');
  await db.query(`UPDATE notifications SET sent_at = now() - interval '2 hours' WHERE id = $1`, [n.id]);
  // the SMS phone is offline
  await call('notify.run', await as(EMAILS.admin, fakeServer(log, { smsError: 'SMS Gateway injoignable. Réessayez plus tard.' })), {});
  n = await shippedRow(o.id);
  assert.equal(n.status, 'queued');
  assert.equal(n.attempts, 1);
  assert.ok(n.wa_id);
  await db.query(`UPDATE notifications SET send_after = now() WHERE id = $1`, [n.id]);
  await call('notify.run', await as(EMAILS.admin, ok), {});
  n = await shippedRow(o.id);
  assert.equal(n.status, 'sms');
  assert.equal(log.filter((l) => l.action === 'waTemplate' && l.args.params.includes(o.ref)).length, 1, 'one WhatsApp only');
  assert.match(n.error, /pas reçu après 1 h|WhatsApp pas reçu/);
});

test('review: the fallback checks the order again (no outdated SMS), and a status Meta sends early is kept', async () => {
  await whatsappReady();
  const log: { action: string; args: any }[] = [];
  const o = await shippedOrder(fakeServer(log));
  await call('notify.run', await as(EMAILS.admin, fakeServer(log)), {});
  const n = await shippedRow(o.id);
  // delivered meanwhile (with the delivered message off): no SMS saying "it left" an hour later
  await call('orders.setFollow', await as(EMAILS.suivi, fakeServer(log)), { ids: [o.id], status: 'out_for_delivery' });
  await db.query(`UPDATE notifications SET sent_at = now() - interval '2 hours' WHERE id = $1`, [n.id]);
  const smsBefore = log.filter((l) => l.action === 'sms').length;
  await call('notify.run', await as(EMAILS.admin, fakeServer(log)), {});
  const after = await shippedRow(o.id);
  assert.equal(after.status, 'whatsapp');
  assert.match(after.error, /Pas de SMS/);
  assert.equal(log.filter((l) => l.action === 'sms' && l.args.text.includes('kherjet')).length, 0);
  assert.ok(log.filter((l) => l.action === 'sms').length >= smsBefore);
  // and it is not taken again by the next runs
  await call('notify.run', await as(EMAILS.admin, fakeServer(log)), {});
  assert.equal((await shippedRow(o.id)).status, 'whatsapp');

  // Meta's "delivered" arrives before the message id is stored: applied when it is
  const early = fakeServer(log, { waId: `wamid.early.${o.id}` });
  const o2 = await shippedOrder(early);
  const r: any = await call('notify.waStatus', await as(EMAILS.admin), { id: `wamid.early.${o2.id}`, status: 'delivered' });
  assert.equal(r.ok, false);
  await call('notify.run', await as(EMAILS.admin, fakeServer(log, { waId: `wamid.early.${o2.id}` })), {});
  const n2 = await shippedRow(o2.id);
  assert.equal(n2.wa_status, 'delivered');
  assert.ok(n2.delivered_at);
  assert.equal((await db.query(`SELECT count(*)::int AS c FROM notification_early_statuses WHERE wa_id = $1`, [`wamid.early.${o2.id}`]))[0].c, 0);
});

test('review: nothing leaves in the night, even a message due before it; the SMS expires before the night', async () => {
  const log: { action: string; args: any }[] = [];
  await whatsappReady();
  await db.query(`UPDATE settings SET value = value || '{"quietFrom":22,"quietTo":8}'::jsonb WHERE key = 'notify'`);
  try {
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const at = (h: number, m = 0) => day + (h - 1) * 3_600_000 + m * 60_000; // Algeria time
    const server = fakeServer(log);
    const conf = Object.assign(await as(EMAILS.conf, server), { now: () => at(21, 58) });
    const o = await newOrder(conf);
    assert.equal((await notes(o.id))[0].status, 'queued');
    // the job runs late (behind the courier sync): 22:30
    await call('notify.run', Object.assign(await as(EMAILS.admin, server), { now: () => at(22, 30) }), {});
    let n = (await notes(o.id))[0];
    assert.equal(n.status, 'queued');
    assert.equal(new Date(n.send_after).getTime(), at(8) + 86_400_000);
    await call('notify.run', Object.assign(await as(EMAILS.admin, server), { now: () => at(8, 1) + 86_400_000 }), {});
    n = (await notes(o.id))[0];
    assert.ok(['whatsapp', 'sms'].includes(n.status), n.status);
    // an SMS handed to the phone at 21:50 may only leave until 22:05 (15 minutes at least), at 15:00 until 21:00
    assert.equal(smsValidUntil(at(21, 50), { quietFrom: 22, quietTo: 8 }), at(22, 5));
    assert.equal(smsValidUntil(at(15), { quietFrom: 22, quietTo: 8 }), at(21));
  } finally {
    await db.query(`UPDATE settings SET value = value || '{"quietFrom":0,"quietTo":0}'::jsonb WHERE key = 'notify'`);
  }
});

test('review: a run that died — not handed over goes back to the queue, handed over waits in Problems', async () => {
  await whatsappReady();
  const log: { action: string; args: any }[] = [];
  const conf = await as(EMAILS.conf, fakeServer(log));
  const a = await newOrder(conf);
  const b = await newOrder(conf);
  await db.query(`UPDATE notifications SET status = 'sending', claimed_at = now() - interval '20 minutes', sending_at = NULL WHERE order_id = $1`, [a.id]);
  await db.query(`UPDATE notifications SET status = 'sending', claimed_at = now() - interval '20 minutes', sending_at = now() - interval '19 minutes' WHERE order_id = $1`, [b.id]);
  await call('notify.run', await as(EMAILS.admin, fakeServer(log)), {});
  assert.ok(['whatsapp', 'sms'].includes((await notes(a.id))[0].status));
  const nb = (await notes(b.id))[0];
  assert.equal(nb.status, 'failed');
  assert.match(nb.error, /Envoi interrompu/);
  // a person decides: "Réessayer" works from Problems
  const r: any = await call('notify.sendNow', await as(EMAILS.suivi, fakeServer(log)), { id: Number(nb.id) });
  assert.ok(['whatsapp', 'sms'].includes(r.status), r.status);
});

test('review: a parcel leaving now is told even if the order waited weeks; old parcels are not', async () => {
  const conf = await as(EMAILS.conf);
  const o = await newOrder(conf, { confirm: true });
  await db.query(`UPDATE orders SET created_at = now() - interval '20 days', confirmed_at = now() - interval '19 days' WHERE id = $1`, [o.id]);
  await call('orders.setFollow', await as(EMAILS.suivi), { ids: [o.id], status: 'shipped' });
  assert.ok((await kinds(o.id)).includes('shipped:whatsapp'));
});

test('review: Dellal only sees the orders of the WhatsApp number writing, or of its own conversation', async () => {
  const conf = await as(EMAILS.conf);
  const o = await newOrder(conf, { confirm: true });
  assert.match(await ordersForDellal(db, o.phone, null), new RegExp(o.ref));
  // a Messenger chat where someone typed this number: nothing
  const conv = (await db.query(`INSERT INTO conversations (channel, external_id, phone) VALUES ('messenger', $1, $2) RETURNING id`, [`psid-${o.id}`, o.phone]))[0];
  assert.equal(await ordersForDellal(db, null, Number(conv.id)), '');
  // the order taken in that chat: yes
  await db.query(`UPDATE orders SET conversation_id = $2 WHERE id = $1`, [o.id, conv.id]);
  assert.match(await ordersForDellal(db, null, Number(conv.id)), new RegExp(o.ref));
});

test('review: an answer is the customer’s first message after the delivery message, not a later chat', async () => {
  const conf = await as(EMAILS.conf);
  const suivi = await as(EMAILS.suivi);
  const o = await newOrder(conf, { confirm: true });
  await call('orders.setFollow', suivi, { ids: [o.id], status: 'shipped' });
  const sent = await shippedRow(o.id);
  assert.equal(sent.status, 'whatsapp');
  // the team already wrote to this customer after the message: their next words answer the team
  const wa = '213' + o.phone.slice(1);
  const conv = (await db.query(`INSERT INTO conversations (channel, external_id, phone, mode) VALUES ('whatsapp', $1, $2, 'human') RETURNING id`, [wa, o.phone]))[0];
  await db.query(`INSERT INTO conv_messages (conversation_id, role, body, created_at) VALUES ($1, 'staff', 'Bonjour, votre colis arrive demain', now() + interval '1 second')`, [conv.id]);
  await call('dellal.receive', await as(EMAILS.admin), { channel: 'whatsapp', externalId: wa, text: 'Merci', messageId: `wamid.in.r${o.id}` });
  const after = await shippedRow(o.id);
  assert.equal(after.reply, null);
  assert.equal(after.replied_at, null);
});

test('review: no sales follow-up to a customer who answered a delivery message', async () => {
  const conf = await as(EMAILS.conf);
  const o = await newOrder(conf, { confirm: true });
  await call('orders.setFollow', await as(EMAILS.suivi), { ids: [o.id], status: 'shipped' });
  const log: { action: string; args: any }[] = [];
  const server = fakeServer(log);
  const admin = await as(EMAILS.admin, server);
  const g: any = await call('dellal.settings.get', admin, {});
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, followUpHours: 3, secrets: { ai: 'sk-ant-test-notify' } });
  const r: any = await call('dellal.receive', admin, { channel: 'whatsapp', externalId: '213' + o.phone.slice(1), text: 'Merci', messageId: `wamid.in.f${o.id}` });
  await call('dellal.answer', admin, { id: r.conversationId });
  // 4 hours later, the conversation ends with Dellal's answer: still no follow-up for it
  await db.query(`UPDATE conv_messages SET created_at = created_at - interval '4 hours' WHERE conversation_id = $1`, [r.conversationId]);
  await db.query(`UPDATE conversations SET last_message_at = now() - interval '4 hours', last_customer_at = now() - interval '4 hours' WHERE id = $1`, [r.conversationId]);
  await call('dellal.followUps', admin, {});
  // (without the rule, Dellal would write a sales follow-up here and mark the conversation followed up)
  assert.equal((await db.query(`SELECT followed_up FROM conversations WHERE id = $1`, [r.conversationId]))[0].followed_up, false);
  await db.query(`UPDATE settings SET value = value || '{"enabled":false}'::jsonb WHERE key = 'dellal'`);
  await db.query(`DELETE FROM settings WHERE key = 'secret_dellal_ai_key'`);
});
