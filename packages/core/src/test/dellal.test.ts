// Dellal, the AI sales agent: inbox, takeover, test chat, order taking, stock guard, handoff, secrets, webhook parsing.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, ServerHooks } from '../index';
import { chunks, parseMetaWebhook } from '../dellal-server';
import { findPlace, playbookFor } from '../modules/dellal';
import { checkDarija, fixDarija, parseAvoid } from '../modules/darija';
import { getSetting, setSetting } from '../settings';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(150));
});

/** A fake server: the AI answers with a scripted list of responses, and sent messages are recorded. */
function fakeServer(script: any[], sent: any[]): ServerHooks {
  return {
    courier: async () => ({}),
    meta: async () => ({}),
    hashPassword: async (p) => p,
    dellal: async (action, args) => {
      if (action === 'send') return sent.push(args), { ok: true };
      if (action === 'ping') return { ok: true };
      const next = script.shift();
      if (!next) return { content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' };
      return typeof next === 'function' ? next(args) : next;
    },
  };
}

test('settings: admin only, secrets never returned, verify token created', async () => {
  const conf = await as(EMAILS.conf);
  await assert.rejects(call('dellal.settings.get', conf, {}), /Accès refusé/);
  const admin = await as(EMAILS.admin);
  const g: any = await call('dellal.settings.get', admin, {});
  assert.match(g.settings.verifyToken, /^dellal-/);
  assert.equal(g.has.ai, false);
  const s: any = await call('dellal.settings.save', admin, { ...g.settings, enabled: true, secrets: { ai: 'sk-ant-test-1234567890', waToken: 'EAAB-wa' } });
  assert.equal(s.has.ai, true);
  assert.equal(s.has.waToken, true);
  assert.ok(!JSON.stringify(s).includes('sk-ant-test'));
  assert.equal(s.settings.verifyToken, g.settings.verifyToken);
  const cleared: any = await call('dellal.settings.save', admin, { ...s.settings, secrets: { waToken: null } });
  assert.equal(cleared.has.waToken, false);
  assert.equal(cleared.has.ai, true);
  // the Page token is no longer pasted by hand: it comes from a linked account (Pilot AI › Comptes)
  await assert.rejects(call('dellal.settings.save', admin, { ...s.settings, secrets: { pageToken: 'EAAB-page' } }), /secrets\.pageToken/);
  assert.equal(cleared.page, null, 'no Page linked: none shown');
});

test('test chat (no AI), whole order: answers price, delivery fee, recap, then simulates the order', async () => {
  const conf = await as(EMAILS.conf);
  const admin = await as(EMAILS.admin);
  const g: any = await call('dellal.settings.get', admin, {});
  assert.equal(g.settings.version, '001', 'Version 001 is the default');
  await call('dellal.settings.save', admin, { ...g.settings, version: 'full', secrets: {} });
  const before = Number((await db.query('SELECT count(*)::int AS n FROM orders'))[0].n);
  let r: any;
  for (const m of ['salam', 'ch7al la poussette ?', 'gris', 'livraison l Sétif ch7al', 'Karim Boudiaf 0661234518 El Eulma', 'oui']) r = await call('dellal.test', conf, { body: m });
  const bodies = r.messages.map((m: any) => `${m.role}: ${m.body}`).join('\n');
  assert.match(bodies, /Poussette.*\d+ DA/);
  assert.match(bodies, /Sétif : \d+ DA à domicile/);
  assert.match(bodies, /Récap/);
  assert.match(bodies, /create_order → TEST/);
  assert.equal(r.demo, true);
  assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM orders'))[0].n), before, 'a test never creates a real order');
  // the test conversation stays out of the inbox
  const inbox: any = await call('dellal.inbox', conf, {});
  assert.ok(inbox.rows.every((c: any) => c.channel !== 'test'));
  const reset: any = await call('dellal.test', conf, { reset: true });
  assert.equal(reset.messages.length, 0);
  await call('dellal.settings.save', admin, { ...g.settings, version: '001', secrets: {} });
});

test('Version 001 (no AI): the number first — the order goes in at once, no recap; a new number changes that order', async () => {
  const conf = await as(EMAILS.conf);
  const before = Number((await db.query('SELECT count(*)::int AS n FROM orders'))[0].n);
  let r: any = await call('dellal.test', conf, { reset: true });
  for (const m of ['salam', 'ch7al la poussette ?', 'gris', 'Karim Boudiaf 0661234518 Sétif']) r = await call('dellal.test', conf, { body: m });
  let bodies = r.messages.map((m: any) => `${m.role}: ${m.body}`).join('\n');
  assert.doesNotMatch(bodies, /Récap|Je confirme/);
  assert.match(bodies, /create_order → TEST/);
  assert.match(bodies, /0661\s23\s45\s18/, 'the number is read back digit by digit');
  assert.match(bodies, /conseiller va t’appeler/);
  r = await call('dellal.test', conf, { body: 'smahli, numéro ta3i 0770112233' });
  bodies = r.messages.map((m: any) => `${m.role}: ${m.body}`).join('\n');
  assert.match(bodies, /update_order → TEST · numéro changé/);
  assert.match(bodies, /0770\s11\s22\s33/);
  assert.equal((bodies.match(/create_order → /g) ?? []).length, 1, 'a change never makes a second order');
  assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM orders'))[0].n), before, 'a test never creates a real order');
  await call('dellal.test', conf, { reset: true });
});

test('Version 001: its sales method asks for the number, not for a recap', () => {
  const p = playbookFor({ version: '001', ordersTo: 'new' });
  assert.match(p, /VERSION 001 — le numéro d’abord/);
  assert.match(p, /update_order/);
  assert.doesNotMatch(p, /Avant create_order, fais le récapitulatif/);
  assert.doesNotMatch(p, /13\. Augmenter le panier/);
  assert.doesNotMatch(p, /je te le réserve \?|domicile wela bureau|nréservilek/);
  assert.match(p, /7\. Après la commande/, 'the rest of the method stays');
  const full = playbookFor({ version: 'full', ordersTo: 'new' });
  assert.match(full, /Avant create_order, fais le récapitulatif/);
  assert.doesNotMatch(full, /VERSION 001/);
});

test('Version 001 (AI): the order lands in Nouvelles with the note; a change in the chat changes the same order; once confirmed, Dellal hands over', async () => {
  const sent: any[] = [];
  const admin = await as(EMAILS.admin);
  const g: any = await call('dellal.settings.get', admin, {});
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, nightReplies: true, version: '001', ordersTo: 'confirmed', secrets: {} });
  const vs = await db.query(`SELECT v.id, v.product_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.active AND NOT p.is_service AND v.active ORDER BY v.id LIMIT 2`);
  for (const v of vs) await db.query(`INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, (SELECT id FROM warehouses ORDER BY is_default DESC, id LIMIT 1), 50) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = stock.qty + 50`, [v.id]);
  const [a, b] = vs;
  const lastResult = (req: any) => JSON.parse(req.messages[req.messages.length - 1].content[0].content);
  let seen: any = null;
  let refused: any = null;
  let updated: any = null;
  let late: any = null;
  const first = { customer_name: 'Yasmine', phone: '0550 12 34 56', wilaya: 'Blida', items: [{ product_id: Number(a.product_id), variant_id: Number(a.id), qty: 1 }], note: 'Veut la livraison samedi matin' };
  const server = fakeServer(
    [
      (req: any) => ((seen = req), { content: [{ type: 'tool_use', id: 'u1', name: 'create_order', input: first }], stop_reason: 'tool_use' }),
      { content: [{ type: 'text', text: 'Sajjelt ✅ 0550 12 34 56, un conseiller va t’appeler.' }], stop_reason: 'end_turn' },
      { content: [{ type: 'tool_use', id: 'u2', name: 'create_order', input: first }], stop_reason: 'tool_use' },
      (req: any) => (
        (refused = lastResult(req)),
        { content: [{ type: 'tool_use', id: 'u3', name: 'update_order', input: { phone: '0661 98 76 54', wilaya: '19', items: [{ product_id: Number(b.product_id), variant_id: Number(b.id), qty: 2 }], note: 'Veut la livraison samedi matin, 2 pièces' } }], stop_reason: 'tool_use' }
      ),
      (req: any) => ((updated = lastResult(req)), { content: [{ type: 'text', text: 'C bon ✅' }], stop_reason: 'end_turn' }),
      { content: [{ type: 'tool_use', id: 'u4', name: 'update_order', input: { phone: '0770 00 11 22' } }], stop_reason: 'tool_use' },
      (req: any) => ((late = lastResult(req)), { content: [{ type: 'tool_use', id: 'u5', name: 'handoff', input: { reason: 'Nouveau numéro après la confirmation' } }], stop_reason: 'tool_use' }),
      { content: [{ type: 'text', text: 'Je transmets à l’équipe.' }], stop_reason: 'end_turn' },
    ],
    sent,
  );
  const sys = await as(EMAILS.admin, server);
  const r: any = await call('dellal.receive', sys, { channel: 'messenger', externalId: 'psid-v001', accountId: 'page-1', text: 'Salam, je veux ça. Yasmine 0550123456 Blida', messageId: 'v001_1' });
  await call('dellal.answer', sys, { id: r.conversationId });
  // Version 001's method and tools
  assert.match(seen.system, /VERSION 001/);
  assert.doesNotMatch(seen.system, /Avant create_order, fais le récapitulatif/);
  assert.ok(seen.tools.some((t: any) => t.name === 'update_order'));
  assert.deepEqual(seen.tools.find((t: any) => t.name === 'create_order').input_schema.required, ['customer_name', 'phone', 'wilaya', 'items']);
  let o = (await db.query('SELECT * FROM orders WHERE conversation_id = $1', [r.conversationId]))[0];
  assert.equal(o.conf_status, 'new', 'Version 001 always lets the team call, even when orders are set to go straight to the depot');
  assert.equal(o.phone, '0550123456');
  assert.equal(Number(o.wilaya_id), 9);
  assert.equal(o.customer_note, 'Veut la livraison samedi matin');
  assert.match(o.internal_note, /Version 001/);
  const oldFee = Number(o.delivery_fee);

  // the customer changes his number, his wilaya and his product
  await call('dellal.receive', sys, { channel: 'messenger', externalId: 'psid-v001', text: 'smahli, numéro 0661987654, ana f Sétif, w nheb 2', messageId: 'v001_2' });
  await call('dellal.answer', sys, { id: r.conversationId });
  assert.match(refused.error, /update_order/, 'a second create_order is refused');
  assert.equal(updated.ok, true);
  const orders = await db.query('SELECT * FROM orders WHERE conversation_id = $1', [r.conversationId]);
  assert.equal(orders.length, 1, 'a change never makes a second order');
  o = orders[0];
  assert.equal(o.phone, '0661987654');
  assert.equal(Number(o.wilaya_id), 19);
  assert.equal(o.customer_note, 'Veut la livraison samedi matin, 2 pièces');
  const items = await db.query('SELECT product_id, variant_id, qty, is_upsell FROM order_items WHERE order_id = $1', [o.id]);
  assert.deepEqual(items.map((i: any) => [Number(i.product_id), Number(i.variant_id), Number(i.qty), !!i.is_upsell]), [[Number(b.product_id), Number(b.id), 2, false]]);
  assert.equal(!!o.has_upsell, false, 'what the customer chose himself is not an upsell');
  const quote: any = await call('orders.quote', admin, { wilayaId: 19, isStopdesk: false, items: [{ productId: Number(b.product_id), qty: 2 }] });
  assert.equal(Number(o.delivery_fee), quote.fee ?? oldFee, 'the delivery price follows the new wilaya and products');
  const ev = await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND kind = 'note'`, [o.id]);
  assert.ok(ev.some((e: any) => /numéro 0550123456 → 0661987654/.test(e.note) && /wilaya/.test(e.note) && /produits/.test(e.note)), 'the history says what the customer changed');
  const c: any = await call('dellal.conversation', admin, { id: r.conversationId });
  assert.equal(c.conversation.phone, '0661987654');

  // the team confirmed it: Dellal does not change it any more, it hands over
  await db.query(`UPDATE orders SET conf_status = 'confirmed' WHERE id = $1`, [o.id]);
  await call('dellal.receive', sys, { channel: 'messenger', externalId: 'psid-v001', text: 'bdelt numéro : 0770001122', messageId: 'v001_3' });
  await call('dellal.answer', sys, { id: r.conversationId });
  assert.match(late.error, /déjà confirmée/);
  assert.equal((await db.query('SELECT phone FROM orders WHERE id = $1', [o.id]))[0].phone, '0661987654');
  assert.equal(((await call('dellal.conversation', admin, { id: r.conversationId })) as any).conversation.mode, 'handoff');
  await call('dellal.setMode', admin, { id: r.conversationId, mode: 'ai' });
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, version: '001', ordersTo: g.settings.ordersTo, secrets: {} });
});

test('a question Dellal cannot answer (no AI): the number asked twice, then the service number; his number goes to the team', async () => {
  const conf = await as(EMAILS.conf);
  const admin = await as(EMAILS.admin);
  const g: any = await call('dellal.settings.get', admin, {});
  await call('dellal.settings.save', admin, { ...g.settings, servicePhone: '023 45 67 89', secrets: {} });
  let r: any = await call('dellal.test', conf, { reset: true });
  for (const m of ['salam', 'wach 3andkom magasin nrouh lih ?', 'w 3lach ?', 'la']) r = await call('dellal.test', conf, { body: m });
  let bodies = r.messages.map((m: any) => `${m.role}: ${m.body}`).join('\n');
  assert.match(bodies, /tool: callback → numéro demandé \(1\/2\)/);
  assert.match(bodies, /agent: Je n’ai pas cette information.*Envoie-moi ton numéro/);
  assert.match(bodies, /tool: callback → numéro demandé \(2\/2\)/);
  assert.match(bodies, /tool: callback → numéro du service client donné : 023 45 67 89/);
  assert.match(bodies, /agent: .*service client au 023\s45\s67\s89/, 'the number on one line');
  // he sends his number after all: a conseiller calls him back
  r = await call('dellal.test', conf, { body: 'ok voilà 0661 23 45 18' });
  bodies = r.messages.map((m: any) => `${m.role}: ${m.body}`).join('\n');
  assert.match(bodies, /tool: callback → à rappeler au 0661234518/);
  assert.match(bodies, /agent: .*va t’appeler très vite au 0661\s23\s45\s18/);
  // the colours, the price and a greeting are still answered by the demo itself
  r = await call('dellal.test', conf, { reset: true });
  for (const m of ['salam', 'ch7al la poussette ?', 'kayen gris ?']) r = await call('dellal.test', conf, { body: m });
  assert.doesNotMatch(r.messages.map((m: any) => m.body).join('\n'), /callback/);
  await call('dellal.test', conf, { reset: true });
  await call('dellal.settings.save', admin, { ...g.settings, servicePhone: '', secrets: {} });
});

test('a question Dellal cannot answer (AI, both versions): never a guess; the number goes to the team, the question goes with an order, else the service number', async () => {
  const admin = await as(EMAILS.admin);
  const g: any = await call('dellal.settings.get', admin, {});
  assert.equal(g.settings.servicePhone, '', 'no number of its own by default: the shop’s SAV number is used');
  assert.equal(g.savPhone, '0550 11 22 33');
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, nightReplies: true, version: '001', servicePhone: '', secrets: {} });
  const lastResult = (req: any) => JSON.parse(req.messages[req.messages.length - 1].content[0].content);
  const res: any[] = [];
  let n = 0;
  let seen: any = null;
  const use = (name: string, input: any) => ({ content: [{ type: 'tool_use', id: `cb${++n}`, name, input }], stop_reason: 'tool_use' });
  const reply = (text: string) => (req: any) => (res.push(lastResult(req)), { content: [{ type: 'text', text }], stop_reason: 'end_turn' });
  const conv = async (id: number) => ((await call('dellal.conversation', admin, { id })) as any).conversation;

  // Messenger, Version 001: asked twice, then the service number (the shop's SAV), then his number goes to the team
  const q = 'wach tetplia la poussette f la voiture ?';
  const sys = await as(
    EMAILS.admin,
    fakeServer(
      [
        (req: any) => ((seen = req), use('callback', { question: q })),
        reply('Je n’ai pas cette information : envoie-moi ton numéro, un conseiller t’appelle.'),
        use('callback', { question: q }),
        reply('Envoie-moi ton numéro, un conseiller t’appelle.'),
        use('callback', { question: q, refused: true }),
        reply('Appelle le service client au 0550 11 22 33.'),
        use('callback', { question: q, phone: '0661 23 45 18' }),
        reply('Merci, un conseiller t’appelle au 0661 23 45 18.'),
      ],
      [],
    ),
  );
  const r: any = await call('dellal.receive', sys, { channel: 'messenger', externalId: 'psid-callback', accountId: 'page-1', text: q, messageId: 'cb_1' });
  await call('dellal.answer', sys, { id: r.conversationId });
  assert.ok(seen.tools.some((t: any) => t.name === 'callback'));
  assert.match(seen.system, /Appelle callback avec sa question/);
  assert.doesNotMatch(seen.system, /tu ne sais pas répondre ou le client est fâché|question que tu ne sais pas : passe la main/);
  assert.doesNotMatch(seen.tools.find((t: any) => t.name === 'handoff').description, /pas sûr/);
  assert.deepEqual([res[0].asked, res[0].ask], [true, 1]);
  assert.equal((await conv(r.conversationId)).mode, 'ai', 'asking for the number keeps the chat with Dellal');
  for (const [i, text] of ['3lach ?', 'la'].entries()) {
    await call('dellal.receive', sys, { channel: 'messenger', externalId: 'psid-callback', text, messageId: `cb_${i + 2}` });
    await call('dellal.answer', sys, { id: r.conversationId });
  }
  assert.deepEqual([res[1].asked, res[1].ask], [true, 2]);
  assert.equal(res[2].service_phone, '0550 11 22 33', 'Dellal’s own number empty: the shop’s SAV number');
  assert.equal(res[2].asked, undefined);
  await call('dellal.receive', sys, { channel: 'messenger', externalId: 'psid-callback', text: 'ok 0661 23 45 18', messageId: 'cb_4' });
  await call('dellal.answer', sys, { id: r.conversationId });
  assert.deepEqual([res[3].callback, res[3].phone], [true, '0661234518']);
  let c = await conv(r.conversationId);
  assert.equal(c.mode, 'handoff', 'the team calls him back: the conversation waits in « À reprendre »');
  assert.match(c.handoffReason, /^À rappeler au 0661\s23\s45\s18 — sa question : « wach tetplia la poussette f la voiture \? »$/);
  assert.equal(c.phone, '0661234518');
  const lines = ((await call('dellal.conversation', admin, { id: r.conversationId })) as any).messages.filter((m: any) => m.role === 'tool').map((m: any) => m.body);
  assert.deepEqual(lines, ['callback → numéro demandé (1/2)', 'callback → numéro demandé (2/2)', 'callback → numéro du service client donné : 0550 11 22 33', 'callback → à rappeler au 0661234518']);

  // WhatsApp, the whole order: the number writing is known, nothing to ask; Dellal’s own service number beats the SAV
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, nightReplies: true, version: 'full', servicePhone: '023 45 67 89', secrets: {} });
  const sys2 = await as(EMAILS.admin, fakeServer([(req: any) => ((seen = req), use('callback', { question: 'kayen magasin f Oran ?' })), reply('Un conseiller t’appelle sur ce numéro.')], []));
  const w: any = await call('dellal.receive', sys2, { channel: 'whatsapp', externalId: '213661909097', accountId: '1098', text: 'kayen magasin f Oran ?', messageId: 'wamid.cb1' });
  await call('dellal.answer', sys2, { id: w.conversationId });
  assert.ok(seen.tools.some((t: any) => t.name === 'callback'), 'the whole order has it too');
  assert.match(seen.system, /Question dont tu n’as pas la réponse : ne devine jamais/);
  assert.deepEqual([res[4].callback, res[4].phone], [true, '0661909097']);
  assert.equal((await conv(w.conversationId)).mode, 'handoff');
  const sys3 = await as(EMAILS.admin, fakeServer([use('callback', { question: 'wach ta3tiwni facture ?', refused: true }), reply('Appelle le 023 45 67 89.')], []));
  const r3: any = await call('dellal.receive', sys3, { channel: 'instagram', externalId: 'ig-callback', accountId: 'ig-1', text: 'wach ta3tiwni facture ?', messageId: 'cb_ig1' });
  await call('dellal.answer', sys3, { id: r3.conversationId });
  assert.equal(res[5].service_phone, '023 45 67 89', 'he refuses: the service number at once');
  assert.equal((await conv(r3.conversationId)).mode, 'ai');

  // Version 001 with its order to call about: the question goes with the order, Dellal keeps answering
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, nightReplies: true, version: '001', servicePhone: '', secrets: {} });
  const v = (await db.query(`SELECT v.id, v.product_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.active AND NOT p.is_service AND v.active ORDER BY v.id LIMIT 1`))[0];
  await db.query(`INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, (SELECT id FROM warehouses ORDER BY is_default DESC, id LIMIT 1), 50) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = stock.qty + 50`, [v.id]);
  const sys4 = await as(
    EMAILS.admin,
    fakeServer(
      [
        use('create_order', { customer_name: 'Nadia', phone: '0770 55 66 77', wilaya: 'Oran', items: [{ product_id: Number(v.product_id), variant_id: Number(v.id), qty: 1 }], note: 'Veut la livrer vite' }),
        reply('C’est noté, un conseiller t’appelle.'),
        use('callback', { question: 'wach fiha garantie 2 ans ?' }),
        reply('Le conseiller te répondra en t’appelant.'),
      ],
      [],
    ),
  );
  const r4: any = await call('dellal.receive', sys4, { channel: 'messenger', externalId: 'psid-callback-2', accountId: 'page-1', text: 'Nadia 0770556677 Oran, je la veux', messageId: 'cb_o1' });
  await call('dellal.answer', sys4, { id: r4.conversationId });
  await call('dellal.receive', sys4, { channel: 'messenger', externalId: 'psid-callback-2', text: 'wach fiha garantie 2 ans ?', messageId: 'cb_o2' });
  await call('dellal.answer', sys4, { id: r4.conversationId });
  const o = (await db.query('SELECT * FROM orders WHERE conversation_id = $1', [r4.conversationId]))[0];
  assert.deepEqual([res[7].with_order, res[7].ref], [true, o.ref]);
  assert.equal(o.customer_note, 'Veut la livrer vite · Question : wach fiha garantie 2 ans ?');
  const ev = await db.query(`SELECT note FROM order_events WHERE order_id = $1 AND kind = 'note'`, [o.id]);
  assert.ok(ev.some((e: any) => /question du client sans réponse dans le chat.*« wach fiha garantie 2 ans \? »/.test(e.note)));
  assert.equal((await conv(r4.conversationId)).mode, 'ai', 'the team calls about the order anyway: Dellal keeps answering');

  // no service number anywhere: a person of the team answers in the chat
  const shop = await getSetting(db, 'shop');
  await setSetting(db, 'shop', { ...shop, savPhone: '' });
  const sys5 = await as(EMAILS.admin, fakeServer([use('callback', { question: 'wach tbi3ou b la carte ?', refused: true }), reply('Quelqu’un de l’équipe te répond ici.')], []));
  const r5: any = await call('dellal.receive', sys5, { channel: 'messenger', externalId: 'psid-callback-3', accountId: 'page-1', text: 'wach tbi3ou b la carte ?', messageId: 'cb_n1' });
  await call('dellal.answer', sys5, { id: r5.conversationId });
  assert.equal(res[8].handoff, true);
  c = await conv(r5.conversationId);
  assert.equal(c.mode, 'handoff');
  assert.match(c.handoffReason, /^Question sans réponse, sans numéro du client : « wach tbi3ou b la carte \? »$/);
  await setSetting(db, 'shop', shop);
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, version: '001', servicePhone: '', secrets: {} });
});

test('a WhatsApp message: Dellal (AI) sells, the order lands in Confirmation › Nouvelles, linked to the conversation', async () => {
  const sent: any[] = [];
  const admin = await as(EMAILS.admin);
  const v = (await db.query(`SELECT v.id, v.product_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.active AND NOT p.is_service ORDER BY v.id LIMIT 1`))[0];
  await db.query(`INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1, (SELECT id FROM warehouses ORDER BY is_default DESC, id LIMIT 1), 50) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = stock.qty + 50`, [v.id]);
  const server = fakeServer(
    [
      { content: [{ type: 'text', text: 'Je vérifie…' }, { type: 'tool_use', id: 't1', name: 'create_order', input: { customer_name: 'Sara Kaci', phone: '0770 11 22 33', wilaya: 'Oran', commune: 'Bir El Djir', items: [{ product_id: Number(v.product_id), variant_id: Number(v.id), qty: 1 }] } }], stop_reason: 'tool_use' },
      (req: any) => {
        const res = JSON.parse(req.messages[req.messages.length - 1].content[0].content);
        return { content: [{ type: 'text', text: `C'est noté ✅ ${res.ref}` }], stop_reason: 'end_turn' };
      },
    ],
    sent,
  );
  const sys = await as(EMAILS.admin, server);
  const r: any = await call('dellal.receive', sys, { channel: 'whatsapp', externalId: '213770112233', accountId: '1098', name: 'Sara', text: 'Salam, je veux commander', messageId: 'wamid.1' });
  assert.ok(r.conversationId);
  assert.equal(await call('dellal.receive', sys, { channel: 'whatsapp', externalId: '213770112233', text: 'Salam, je veux commander', messageId: 'wamid.1' }), null, 'the same message twice is stored once');
  const out: any = await call('dellal.answer', sys, { id: r.conversationId });
  assert.match(out.reply, /^C'est noté ✅ PX\d+/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].externalId, '213770112233');
  assert.equal(sent[0].accountId, '1098');
  const o = (await db.query('SELECT * FROM orders WHERE conversation_id = $1', [r.conversationId]))[0];
  assert.equal(o.conf_status, 'new');
  assert.equal(o.channel, 'whatsapp');
  assert.equal(o.phone, '0770112233');
  assert.equal(o.wilaya_id, 31);
  const c: any = await call('dellal.conversation', admin, { id: r.conversationId });
  assert.equal(c.conversation.orderRef, o.ref);
  assert.equal(c.conversation.phone, '0770112233');
  assert.ok(c.messages.some((m: any) => m.role === 'tool' && m.body.startsWith('create_order')));
  const inbox: any = await call('dellal.inbox', admin, { tab: 'orders' });
  assert.ok(inbox.rows.some((x: any) => x.id === r.conversationId));
  const stats: any = await call('dellal.stats', admin, {});
  assert.ok(stats.orders >= 1 && stats.conversations >= 1);
});

test('stock guard and handoff; a person takes over, then gives back to Dellal', async () => {
  const sent: any[] = [];
  const v = (await db.query(`SELECT v.id, v.product_id FROM product_variants v JOIN products p ON p.id = v.product_id WHERE p.active AND NOT p.is_service ORDER BY v.id DESC LIMIT 1`))[0];
  await db.query('UPDATE stock SET qty = 0 WHERE variant_id = $1', [v.id]);
  let toolResult: any = null;
  const server = fakeServer(
    [
      { content: [{ type: 'tool_use', id: 't1', name: 'create_order', input: { customer_name: 'Ali', phone: '0661000111', wilaya: '16', commune: 'Kouba', items: [{ product_id: Number(v.product_id), variant_id: Number(v.id), qty: 1 }] } }], stop_reason: 'tool_use' },
      (req: any) => {
        toolResult = JSON.parse(req.messages[req.messages.length - 1].content[0].content);
        return { content: [{ type: 'tool_use', id: 't2', name: 'handoff', input: { reason: 'Rupture, le client veut une autre couleur' } }], stop_reason: 'tool_use' };
      },
      { content: [{ type: 'text', text: 'Un conseiller te répond.' }], stop_reason: 'end_turn' },
    ],
    sent,
  );
  const sys = await as(EMAILS.admin, server);
  const r: any = await call('dellal.receive', sys, { channel: 'messenger', externalId: 'psid-77', accountId: 'page-1', text: 'Je prends', messageId: 'm_1' });
  await call('dellal.answer', sys, { id: r.conversationId });
  assert.match(toolResult.error, /stock/i);
  const conf = await as(EMAILS.conf, server);
  let c: any = await call('dellal.conversation', conf, { id: r.conversationId });
  assert.equal(c.conversation.mode, 'handoff');
  assert.equal(c.conversation.orderId, null);
  // Dellal no longer answers a conversation waiting for a person
  await call('dellal.receive', sys, { channel: 'messenger', externalId: 'psid-77', text: 'Allô ?', messageId: 'm_2' });
  assert.equal(((await call('dellal.answer', sys, { id: r.conversationId })) as any).reply, null);
  // a person answers: sent on the channel, mode human
  const before = sent.length;
  await call('dellal.reply', conf, { id: r.conversationId, body: 'Bonjour, je regarde pour le bleu.' });
  assert.equal(sent.length, before + 1);
  c = await call('dellal.conversation', conf, { id: r.conversationId });
  assert.equal(c.conversation.mode, 'human');
  assert.equal(c.messages[c.messages.length - 1].role, 'staff');
  await call('dellal.setMode', conf, { id: r.conversationId, mode: 'ai' });
  c = await call('dellal.conversation', conf, { id: r.conversationId });
  assert.equal(c.conversation.mode, 'ai');
  // livreurs and marketers do not see the inbox
  await assert.rejects(call('dellal.inbox', await as(EMAILS.livreur), {}), /Accès refusé/);
});

test('Dellal off or at night: no answer', async () => {
  const admin = await as(EMAILS.admin);
  const g: any = await call('dellal.settings.get', admin, {});
  await call('dellal.settings.save', admin, { ...g.settings, enabled: false, secrets: {} });
  const server = fakeServer([], []);
  const sys = await as(EMAILS.admin, server);
  const r: any = await call('dellal.receive', sys, { channel: 'instagram', externalId: 'ig-1', text: 'prix ?', messageId: 'ig_m1' });
  const out: any = await call('dellal.answer', sys, { id: r.conversationId });
  assert.equal(out.reply, null);
  assert.match(out.skipped, /désactivé/);
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, nightReplies: false, secrets: {} });
  const night = { ...sys, now: () => Date.parse('2026-10-22T01:30:00Z') }; // 02:30 in Algeria
  assert.match(((await call('dellal.answer', night, { id: r.conversationId })) as any).skipped, /nuit/);
});

test('places, Meta webhook parsing and message splitting', () => {
  assert.equal(findPlace('Sétif')?.wilayaId, 19);
  assert.equal(findPlace('16')?.wilayaId, 16);
  assert.equal(findPlace('livraison l bordj bou arreridj')?.wilayaId, 34);
  assert.equal(findPlace('El Eulma')?.wilaya, 'Sétif');
  assert.equal(findPlace('rien du tout'), null);

  const wa = parseMetaWebhook({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { metadata: { phone_number_id: '1098' }, contacts: [{ wa_id: '213661', profile: { name: 'Karim' } }], messages: [{ from: '213661', id: 'wamid.X', type: 'text', text: { body: 'Salam' }, referral: { headline: 'Vélo enfant' } }, { from: '213661', id: 'wamid.Y', type: 'audio' }] } }] }],
  });
  assert.deepEqual(wa.map((m) => [m.channel, m.externalId, m.accountId, m.name, m.text]), [
    ['whatsapp', '213661', '1098', 'Karim', 'Salam'],
    ['whatsapp', '213661', '1098', 'Karim', '[message vocal envoyé]'],
  ]);
  assert.match(wa[0].source!, /Vélo enfant/);
  const fb = parseMetaWebhook({ object: 'page', entry: [{ messaging: [{ sender: { id: 'psid' }, recipient: { id: 'page' }, message: { mid: 'm1', text: 'prix?' } }, { sender: { id: 'page' }, message: { is_echo: true, text: 'echo' } }] }] });
  assert.equal(fb.length, 1);
  assert.equal(fb[0].channel, 'messenger');
  const ig = parseMetaWebhook({ object: 'instagram', entry: [{ messaging: [{ sender: { id: 'igsid' }, recipient: { id: 'ig' }, message: { mid: 'm2', attachments: [{ type: 'image' }] } }] }] });
  assert.equal(ig[0].channel, 'instagram');
  assert.equal(ig[0].text, '[photo envoyée]');

  const parts = chunks('a'.repeat(1500) + '.\n' + 'b'.repeat(1500), 1900);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 1900));
});

test('the sales playbook reaches the AI; a pack quantity gets the pack price, a linked product is marked upsell', async () => {
  const p = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.active AND NOT p.is_service AND p.max_discount IS NOT NULL ORDER BY p.id LIMIT 1`))[0];
  const other = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.active AND NOT p.is_service AND p.id <> $1 ORDER BY p.id LIMIT 1`, [p.id]))[0];
  await db.query(`UPDATE products SET packs = '[{"qty":2,"price":15000}]', linked = $2, fixed_price = false WHERE id = $1`, [p.id, [other.id]]);
  const wid = (await db.query('SELECT id FROM warehouses ORDER BY is_default DESC, id LIMIT 1'))[0].id;
  for (const v of [p.vid, other.vid]) await db.query(`INSERT INTO stock (variant_id, warehouse_id, qty) VALUES ($1,$2,50) ON CONFLICT (variant_id, warehouse_id) DO UPDATE SET qty = stock.qty + 50`, [v, wid]);
  const admin = await as(EMAILS.admin);
  const g: any = await call('dellal.settings.get', admin, {});
  // the whole-order method (Version 001 has no basket raise in the chat)
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, nightReplies: true, version: 'full', secrets: {} });
  let system = '';
  const server = fakeServer(
    [
      (req: any) => {
        system = req.system;
        return { content: [{ type: 'tool_use', id: 't1', name: 'create_order', input: { customer_name: 'Lina H', phone: '0555 12 34 56', wilaya: '9', commune: 'Boufarik', items: [{ product_id: Number(p.id), variant_id: Number(p.vid), qty: 2 }, { product_id: Number(other.id), variant_id: Number(other.vid), qty: 1, upsell: true }] } }], stop_reason: 'tool_use' };
      },
      { content: [{ type: 'text', text: 'Saha !' }], stop_reason: 'end_turn' },
    ],
    [],
  );
  const sys = await as(EMAILS.admin, server);
  const r: any = await call('dellal.receive', sys, { channel: 'whatsapp', externalId: '213555123456', text: 'nheb 2', messageId: 'wamid.pack' });
  await call('dellal.answer', sys, { id: r.conversationId });
  assert.match(system, /MÉTHODE DE VENTE/);
  assert.match(system, /Découverte : comprendre le client avant de vendre/);
  assert.match(system, /Augmenter le panier intelligemment/);
  assert.match(system, /Ne prétends jamais être une personne/);
  assert.match(system, /Ne demande jamais d’acompte/);
  assert.match(system, /9 = ق \(et non ص/);
  assert.match(system, /« nos mlyoun » = 5 000 DA/);
  assert.match(system, /le matin wela l’après-midi/);
  assert.match(system, /1 million/);
  assert.match(system, /packs : 2 pour 15000 DA/);
  assert.match(system, /un conseiller l’appellera aussi pour confirmer/);
  const o = (await db.query('SELECT id FROM orders WHERE conversation_id = $1', [r.conversationId]))[0];
  const items = await db.query('SELECT product_id, qty, unit_price, is_upsell FROM order_items WHERE order_id = $1 ORDER BY id', [o.id]);
  assert.equal(Number(items[0].unit_price), 7500);
  assert.equal(items[0].is_upsell, false);
  assert.equal(items[1].is_upsell, true);
});

test('darija checker: other dialects and wrong phrases are caught; clean Algerian, Arabic script and mirroring pass', () => {
  const ids = (t: string, o?: any) => checkDarija(t, o).map((i) => i.id);
  assert.deepEqual(ids('Saha khouya 🙏 La poussette b 12 900 DA, tkhalles ki testalem. Wach men couleur t7ab ? Rani nab3atlek la photo dorka.'), []);
  assert.deepEqual(ids('وعليكم السلام، الكرسي بـ 8900 دج، تخلص كي تستلم. واش من لون تحب؟ بزاف مليح'), []);
  assert.deepEqual(ids('Wakha, daba nsiftlek la photo'), ['daba', 'wakha']);
  assert.deepEqual(ids('Achmen couleur bghiti ?'), ['achmen']);
  assert.deepEqual(ids('wach men couleur ?'), [], '"ach men" inside "wach men" is Algerian');
  assert.ok(ids('Smahli, ma3andek 7a9 tghdab').includes('ma3andek-7a9'));
  assert.deepEqual(ids('دابا نبعثلك التصويرة'), ['daba']);
  assert.deepEqual(ids('ودابا نبعثلك'), ['daba'], 'Arabic word with و in front');
  assert.deepEqual(ids('3andna barcha couleurs', { customer: 'kayen barcha couleurs ?' }), [], 'the customer said it: mirroring is fine');
  assert.deepEqual(ids('Chine, chinois, machine, Michel'), [], 'no false match inside other words');
  // Algerian words that look like other dialects must never be flagged (research: dialect_markers.md)
  assert.deepEqual(ids('kifek kifi, rebbi y3aychek, bghit nchouf, fin rak, qaddach, ghadi, yezzi, wesh, bach, bessah'), []);
  assert.deepEqual(ids('واشنو تحب؟ هكدا مليح، إيه كاين'), [], 'واشنو contains شنو and هكدا contains كدا: whole words only');
  assert.deepEqual(ids('Achmen couleur ?').map((x) => x), ['achmen']);
  assert.equal(checkDarija('Achmen couleur ?')[0].dialect, 'regional', 'used in some Algerian regions: rewritten, but not called foreign');
  // the shop's own list
  const avoid = parseAvoid('khoya → khouya\n# comment\nchira');
  assert.deepEqual(avoid, [{ term: 'khoya', use: 'khouya' }, { term: 'chira', use: undefined }]);
  assert.deepEqual(ids('Saha khoya', { avoid }), ['boutique:khoya']);
  const t = 'Saha khoya, daba nab3atlek';
  assert.equal(fixDarija(t, checkDarija(t, { avoid }), avoid), 'Saha khouya, dorka nab3atlek');
  assert.equal(fixDarija('Smahli, ma3andek 7a9 tghdab', checkDarija('Smahli, ma3andek 7a9 tghdab')), 'Smahli, 3andek l7a9 tghdab');
  // one spelling per message: q → 9 and 5 → kh, fixed without changing anything else
  const sp = 'Tqdri tchoufi le colis qoddam le livreur 9bel ma tkhallsi, yd5ol f budget.';
  assert.deepEqual(ids(sp), ['orthographe:tqdri', 'orthographe:qoddam', 'orthographe:yd5ol']);
  assert.equal(fixDarija(sp, checkDarija(sp)), 't9dri tchoufi le colis 9oddam le livreur 9bel ma tkhallsi, ydkhol f budget.');
  assert.deepEqual(ids('qbel ma tkhalles', { customer: 'qbel ma nkhalles ?' }), [], 'the customer wrote it that way: mirroring is fine');
  assert.deepEqual(ids('Question : la qualité, quand ?'), [], 'French words with q are not touched');
  assert.deepEqual(ids('le beige ma kaynch'), ['makaynch']);
});

test('a reply in another dialect is rewritten in Algerian Darija before it is sent; the shop list is in the instructions', async () => {
  const admin = await as(EMAILS.admin);
  const g: any = await call('dellal.settings.get', admin, {});
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, nightReplies: true, version: 'full', darijaPrefer: 'Mar7ba bik / biki', darijaAvoid: 'frero → khouya', secrets: { ai: 'sk-ant-test-1234567890' } });
  const sent: any[] = [];
  let system = '';
  let fixer: any = null;
  const sys = await as(
    EMAILS.admin,
    fakeServer(
      [
        (req: any) => ((system = req.system), { content: [{ type: 'text', text: 'Wakha frero, daba nab3atlek la photo ta3 la poussette.' }], stop_reason: 'end_turn' }),
        (req: any) => ((fixer = req), { content: [{ type: 'text', text: 'D’accord khouya, dorka nab3atlek la photo ta3 la poussette.' }], stop_reason: 'end_turn' }),
      ],
      sent,
    ),
  );
  const r: any = await call('dellal.receive', sys, { channel: 'whatsapp', externalId: '213661909090', text: 'sawerli la poussette', messageId: 'wamid.darija' });
  const out: any = await call('dellal.answer', sys, { id: r.conversationId });
  assert.match(system, /Mar7ba bik \/ biki/);
  assert.match(system, /frero → khouya/);
  assert.equal(fixer.tools.length, 0);
  assert.match(fixer.messages[0].content, /« daba » \(marocain\)/);
  assert.match(fixer.messages[0].content, /« frero » \(interdit par la boutique\) → khouya/);
  assert.equal(out.reply, 'D’accord khouya, dorka nab3atlek la photo ta3 la poussette.');
  assert.equal(sent[0].text, out.reply, 'the corrected text is what the customer receives');
  const c: any = await call('dellal.conversation', admin, { id: r.conversationId });
  const tool = c.messages.find((m: any) => m.role === 'tool' && m.body.startsWith('darija'));
  assert.ok(tool && tool.meta.rewritten === true);

  // if the rewrite still has a foreign word, the safe replacement fixes it
  const sys2 = await as(
    EMAILS.admin,
    fakeServer([{ content: [{ type: 'text', text: 'Smahli, ma3andek 7a9, daba nchouf.' }], stop_reason: 'end_turn' }, { content: [{ type: 'text', text: 'Smahli, ma3andek 7a9, daba nchouf.' }], stop_reason: 'end_turn' }], []),
  );
  const r2: any = await call('dellal.receive', sys2, { channel: 'whatsapp', externalId: '213661909091', text: 'wach sra ?', messageId: 'wamid.darija2' });
  const out2: any = await call('dellal.answer', sys2, { id: r2.conversationId });
  assert.equal(out2.reply, 'Smahli, 3andek l7a9, dorka nchouf.');

  // in the Pilotix preview opened in Claude, the page's Claude answers: no key, it runs the same tools, the Darija check applies
  const reqs: any[] = [];
  const page = async (req: any) => {
    reqs.push(req);
    if (!req.tools.length) {
      const m = String(req.messages[0].content).match(/«\n([\s\S]*?)\n»/);
      return { content: [{ type: 'text' as const, text: (m ? m[1] : '').replace('Wakha', 'D’accord') }], stop_reason: 'end_turn' };
    }
    const found = await req.runTool('search_products', { query: 'poussette' });
    const fee = await req.runTool('delivery_fee', { wilaya: 'Oran' });
    assert.ok(found.products.length > 0 && fee.home_delivery > 0);
    return { content: [{ type: 'text' as const, text: `Wakha khouya, la poussette b 12 900 DA, w l Oran ${fee.home_delivery} DA la livraison. tqdar tchouf le colis qoddam le livreur.` }], stop_reason: 'end_turn' };
  };
  const inPage = { ...(await as(EMAILS.admin)), dellalAi: page };
  const first: any = await call('dellal.test', inPage, { reset: true });
  assert.equal(first.demo, false, 'no "demo answers" notice when the page can use Claude');
  const r4: any = await call('dellal.test', inPage, { body: 'ch7al la poussette l Oran ?' });
  assert.equal(r4.demo, false);
  assert.equal(reqs.length, 2, 'one answer, one Darija rewrite');
  assert.deepEqual(reqs[0].tools.map((x: any) => x.name), ['search_products', 'delivery_fee', 'create_order', 'product_guide', 'callback', 'handoff']);
  assert.equal(typeof reqs[0].runTool, 'function');
  assert.match(reqs[0].system, /DARIJA ALGÉRIENNE/);
  assert.equal(reqs[1].tools.length, 0);
  const lastAgent = r4.messages.filter((m: any) => m.role === 'agent').pop();
  assert.equal(lastAgent.body, 'D’accord khouya, la poussette b 12 900 DA, w l Oran 650 DA la livraison. t9der tchouf le colis 9oddam le livreur.');
  assert.equal(lastAgent.meta.model, 'claude (page)');
  const lines = r4.messages.filter((m: any) => m.role === 'tool').map((m: any) => m.body);
  assert.ok(lines.some((l: string) => l.startsWith('search_products "poussette"')));
  assert.ok(lines.some((l: string) => l.startsWith('delivery_fee Oran')));
  assert.ok(lines.some((l: string) => l.startsWith('darija →')));

  // a spelling slip alone is fixed directly: no second AI call
  let calls = 0;
  const sys3 = await as(EMAILS.admin, fakeServer([() => (calls++, { content: [{ type: 'text', text: 'Ma tkhafich khti, tqdri tchoufi le colis qoddam le livreur.' }], stop_reason: 'end_turn' }), () => (calls++, { content: [{ type: 'text', text: 'X' }], stop_reason: 'end_turn' })], []));
  const r3: any = await call('dellal.receive', sys3, { channel: 'whatsapp', externalId: '213661909092', text: 'nkhaf ma yjinich', messageId: 'wamid.darija3' });
  const out3: any = await call('dellal.answer', sys3, { id: r3.conversationId });
  assert.equal(out3.reply, 'Ma tkhafich khti, t9dri tchoufi le colis 9oddam le livreur.');
  assert.equal(calls, 1);
});
