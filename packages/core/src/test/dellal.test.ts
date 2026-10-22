// Dellal, the AI sales agent: inbox, takeover, test chat, order taking, stock guard, handoff, secrets, webhook parsing.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, ServerHooks } from '../index';
import { chunks, parseMetaWebhook } from '../dellal-server';
import { findPlace } from '../modules/dellal';
import { checkDarija, fixDarija, parseAvoid } from '../modules/darija';
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
  const s: any = await call('dellal.settings.save', admin, { ...g.settings, enabled: true, secrets: { ai: 'sk-ant-test-1234567890', pageToken: 'EAAB-page' } });
  assert.equal(s.has.ai, true);
  assert.equal(s.has.pageToken, true);
  assert.ok(!JSON.stringify(s).includes('sk-ant-test'));
  assert.equal(s.settings.verifyToken, g.settings.verifyToken);
  const cleared: any = await call('dellal.settings.save', admin, { ...s.settings, secrets: { pageToken: null } });
  assert.equal(cleared.has.pageToken, false);
  assert.equal(cleared.has.ai, true);
});

test('test chat (no AI): answers price, delivery fee, recap, then simulates the order', async () => {
  const conf = await as(EMAILS.conf);
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
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, nightReplies: true, secrets: {} });
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
});

test('a reply in another dialect is rewritten in Algerian Darija before it is sent; the shop list is in the instructions', async () => {
  const admin = await as(EMAILS.admin);
  const g: any = await call('dellal.settings.get', admin, {});
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, nightReplies: true, darijaPrefer: 'Mar7ba bik / biki', darijaAvoid: 'frero → khouya', secrets: { ai: 'sk-ant-test-1234567890' } });
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
});
