// Referral › Code promo: the welcome code of the « Awareness 🎁 » posts and ads. A fixed rule before Dellal (never the AI,
// never counted as AI), one code per account ever (the same code when asked again), Instagram only to followers, a unique
// code, a % or DA off the products only, a minimum before the discount, 90 days, one order one time, above a product's
// maximum discount (the welcome code only), on the order screen, the landing page and in Dellal; the order is « Awareness ».
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, num, ServerHooks } from '../index';
import { parseMetaWebhook } from '../dellal-server';
import { ASKS_CODE, onlyAsksCode, promoForConversation, promoPromptLine, randomCode } from '../modules/promo';
import { EMAILS, setup } from './harness';

type Log = { action: string; args: any }[];
function fakeServer(log: Log, o: { follows?: () => boolean | null } = {}): ServerHooks {
  return {
    courier: async () => ({}),
    meta: async () => ({}),
    hashPassword: async (p) => p,
    dellal: async (action, args: any) => {
      log.push({ action, args });
      if (action === 'complete') return { content: [{ type: 'text', text: '{"intent":"question","public_reply":"","private_reply":"Salam","reason":"q"}' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
      if (action === 'igFollows') return { follows: o.follows ? o.follows() : true };
      if (action === 'cmPrivate') return { recipientId: `psid-${args.commentId}`, messageId: 'm_x' };
      if (action === 'cmReply') return { id: `reply-${args.commentId}` };
      if (action === 'cmPost') return { caption: null, permalink: null };
      return { ok: true, messageId: `mid-${log.length}` };
    },
  };
}
const SETTINGS = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  prefix: 'BJ',
  kind: 'pct',
  value: 10,
  minOrder: 3000,
  days: 90,
  lang: 'darija',
  message: { darija: 'Code ta3ek {code} {remise}{min} 7ta {date}', fr: 'Votre code {code} {remise}', ar: 'الكود {code} {remise}' },
  follow: { darija: 'Tab3 page w ab3at « {mot} »', fr: 'Suivez puis « {mot} »', ar: 'تابع ثم « {mot} »' },
  word: 'CODE',
  ...over,
});

test('the code: unique letters, how a code ask is read', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const c = randomCode('BJ');
    assert.match(c, /^BJ-[A-HJ-NP-Z2-9]{4}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 290);
  assert.ok(ASKS_CODE.test('salam kayen code ?'));
  assert.ok(ASKS_CODE.test('ابعثلي الكود'));
  assert.ok(onlyAsksCode('Salam, ab3atli le code svp'));
  assert.ok(onlyAsksCode('CODE'));
  assert.equal(onlyAsksCode('salam ch7al la poussette w kayen code ?'), false);
});

test('webhook: a referral without a message is kept (fix A), the ?ref= value too (fix B)', () => {
  const r = parseMetaWebhook({ object: 'page', entry: [{ messaging: [{ sender: { id: 'psid1' }, recipient: { id: 'page' }, referral: { ref: 'babyjoy-promo', source: 'SHORTLINK', type: 'OPEN_THREAD' } }] }] });
  assert.equal(r.length, 1);
  assert.equal(r[0].referral, true);
  assert.equal(r[0].source, 'ref:babyjoy-promo');
  assert.equal(r[0].text, '');
  const ad = parseMetaWebhook({ object: 'instagram', entry: [{ messaging: [{ sender: { id: 'igsid1' }, recipient: { id: 'ig' }, referral: { ad_id: '120210001', source: 'ADS' } }] }] });
  assert.equal(ad[0].source, 'pub 120210001');
  assert.equal(ad[0].channel, 'instagram');
  const msg = parseMetaWebhook({ object: 'page', entry: [{ messaging: [{ sender: { id: 'psid2' }, recipient: { id: 'page' }, message: { mid: 'm1', text: 'salam', referral: { ref: 'x1', source: 'SHORTLINK' } } }] }] });
  assert.equal(msg[0].source, 'ref:x1');
  assert.equal(msg[0].referral, undefined);
});

test('chats: a code only from a marked ad, the same code again, Instagram followers only, never by the AI', async () => {
  const { db, as } = await setup(30);
  // the demo's own codes out of the way
  await db.query('DELETE FROM promo_codes');
  const admin = await as(EMAILS.admin);
  await call('promo.settings.save', admin, SETTINGS());
  // a seller's marketer can mark an ad, an agent cannot
  const conf = await as(EMAILS.conf);
  await assert.rejects(call('promo.mark', conf, { kind: 'ad', id: '999000111', on: true }));
  await call('promo.mark', admin, { kind: 'ad', id: '999000111', on: true, label: 'Pub awareness' });
  await call('promo.mark', admin, { kind: 'ref', id: 'babyjoy-promo', on: true });
  const log: Log = [];
  let follows = false;
  const sys = await as(EMAILS.admin, fakeServer(log, { follows: () => follows }));
  const sent = () => log.filter((l) => l.action === 'send').map((l) => String(l.args.text));

  // not from a marked ad: normal Dellal, no code
  await call('dellal.receive', sys, { channel: 'messenger', externalId: 'p-normal', text: 'salam kayen code ?', source: 'pub 555000111' });
  assert.equal(sent().length, 0);
  assert.equal(num((await db.query(`SELECT count(*)::int AS n FROM promo_codes`))[0].n), 0);

  // from the marked ad (Messenger: no follow check): the code, at once, in the fixed message
  const r1: any = await call('dellal.receive', sys, { channel: 'messenger', externalId: 'p-1', name: 'Amina', text: 'Salam', source: 'pub 999000111' });
  const code = (await db.query(`SELECT * FROM promo_codes WHERE external_id = 'p-1'`))[0];
  assert.match(code.code, /^BJ-[A-Z2-9]{4}$/);
  assert.equal(code.status, 'sent');
  assert.equal(code.source_kind, 'ad');
  assert.ok(Math.abs(Date.parse(code.expires_at) - Date.parse(code.sent_at) - 90 * 86_400_000) < 5000, '90 days');
  assert.equal(sent().length, 1);
  assert.match(sent()[0], new RegExp(`${code.code} -10% \\(min 3000 DA\\) 7ta \\d\\d/\\d\\d/\\d{4}`));
  assert.equal(log.filter((l) => l.action === 'igFollows').length, 0);
  // the fixed message is in the conversation, marked, and answered nothing else: Dellal adds nothing (no AI call)
  const promoMsg = (await db.query(`SELECT * FROM conv_messages WHERE conversation_id = $1 AND role = 'agent'`, [r1.conversationId]))[0];
  assert.equal(promoMsg.meta.promo.code, code.code);
  const a: any = await call('dellal.answer', sys, { id: r1.conversationId });
  assert.equal(a.skipped, 'Code de bienvenue envoyé');
  assert.equal(log.filter((l) => l.action === 'complete').length, 0, 'the code message is not an AI message');

  // asked again: the same code (never a second one), even from the ad again
  await call('dellal.receive', sys, { channel: 'messenger', externalId: 'p-1', text: 'kayen code ?', source: null });
  await call('dellal.receive', sys, { channel: 'messenger', externalId: 'p-1', text: 'salam', source: 'pub 999000111' });
  assert.equal(num((await db.query(`SELECT count(*)::int AS n FROM promo_codes WHERE external_id = 'p-1'`))[0].n), 1);
  assert.equal(sent().length, 3);
  assert.ok(sent()[1].includes(code.code) && sent()[2].includes(code.code));
  // a plain message afterwards: no code sent again
  await call('dellal.receive', sys, { channel: 'messenger', externalId: 'p-1', text: 'ch7al la poussette ?', source: null });
  assert.equal(sent().length, 3);

  // Instagram, not following: « follow first », no code yet; following, « CODE » again: the code
  await call('dellal.receive', sys, { channel: 'instagram', externalId: 'ig-1', name: '@sara', text: 'salam', source: 'pub 999000111' });
  assert.match(sent()[3], /Tab3 page w ab3at « CODE »/);
  assert.equal((await db.query(`SELECT status FROM promo_codes WHERE external_id = 'ig-1'`))[0].status, 'waiting_follow');
  follows = true;
  await call('dellal.receive', sys, { channel: 'instagram', externalId: 'ig-1', text: 'CODE', source: null });
  const ig = (await db.query(`SELECT * FROM promo_codes WHERE external_id = 'ig-1'`))[0];
  assert.equal(ig.status, 'sent');
  assert.ok(sent()[4].includes(ig.code));
  assert.notEqual(ig.code, code.code);

  // an old client clicking the ad again later (a referral without message): gets a code too, once
  await call('dellal.referral', sys, { channel: 'messenger', externalId: 'p-old', source: 'ref:babyjoy-promo' });
  const old = (await db.query(`SELECT * FROM promo_codes WHERE external_id = 'p-old'`))[0];
  assert.equal(old.source_kind, 'ref');
  assert.ok(sent()[5].includes(old.code));

  // Dellal knows the code (in its prompt) and the rule it never makes one
  const conv = r1.conversationId;
  const p: any = await call('promo.codes', admin, {});
  assert.ok(p.rows.some((x: any) => x.code === code.code && x.conversationId === conv));
});

test('orders: the code off the products only, minimum before, above the max discount, once; landing page and Dellal', async () => {
  const { db, as } = await setup(30);
  // the demo's own codes out of the way
  await db.query('DELETE FROM promo_codes');
  const admin = await as(EMAILS.admin);
  await call('promo.settings.save', admin, SETTINGS());
  await call('promo.mark', admin, { kind: 'ad', id: '999000222', on: true });
  const log: Log = [];
  const sys = await as(EMAILS.admin, fakeServer(log));
  const r1: any = await call('dellal.receive', sys, { channel: 'messenger', externalId: 'buyer-1', text: 'Salam', source: 'pub 999000222' });
  const code = (await db.query(`SELECT code FROM promo_codes WHERE external_id = 'buyer-1'`))[0].code as string;
  // a product with a small maximum discount, price 5000
  const prod = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.active AND NOT p.is_service AND v.active ORDER BY p.id LIMIT 1`))[0];
  await db.query('UPDATE products SET price = 5000, max_discount = 100 WHERE id = $1', [prod.id]);
  await db.query('UPDATE product_variants SET price = NULL WHERE product_id = $1', [prod.id]).catch(() => undefined);
  const items = (qty: number) => [{ productId: num(prod.id), variantId: num(prod.vid), qty, unitPrice: 5000 }];
  const base = { customerName: 'Amina B', phone: '0555123401', wilayaId: 16, commune: '', address: '', isStopdesk: false, channel: 'appel' as const, discount: 0, confirm: false, isExchange: false };
  const conf = await as(EMAILS.conf);
  // the badge of the order screen
  const bad: any = await call('promo.check', conf, { code: 'BJ-ZZZZ', subtotal: 5000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unknown');
  const small: any = await call('promo.check', conf, { code, subtotal: 2000 });
  assert.equal(small.reason, 'small');
  const ok: any = await call('promo.check', conf, { code: code.toLowerCase(), subtotal: 10000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.discount, 1000);
  // too small: refused (the minimum is checked before the discount)
  await assert.rejects(call('orders.create', admin, { ...base, items: [{ ...items(1)[0], unitPrice: 2000 }], promoCode: code }), /trop petite/);
  // another remise above the product's maximum: still refused
  await assert.rejects(call('orders.create', admin, { ...base, items: items(2), discount: 500 }), /Remise trop élevée/);
  // the welcome code: 10 % of the products (10 000) = 1 000, above the maximum (200), not on the delivery
  const o: any = await call('orders.create', admin, { ...base, items: items(2), promoCode: code });
  assert.equal(o.promoCode, code);
  assert.equal(o.promoDiscount, 1000);
  assert.equal(o.discount, 1000);
  assert.equal(o.awareness, true);
  assert.equal(o.total, 10000 - 1000 + o.deliveryFee);
  const row = (await db.query(`SELECT * FROM promo_codes WHERE code = $1`, [code]))[0];
  assert.equal(row.status, 'used');
  assert.equal(num(row.order_id), o.id);
  // one order, one time
  await assert.rejects(call('orders.create', admin, { ...base, phone: '0555123402', items: items(1), promoCode: code }), /déjà utilisé/);
  assert.equal(((await call('promo.check', conf, { code, subtotal: 9000 })) as any).reason, 'used');
  // the same order changed: the code follows its products (3 × 5000 → 1 500), another remise stays apart
  const o2: any = await call('orders.update', admin, { id: o.id, version: o.version, items: items(3), discount: 100 });
  assert.equal(o2.promoDiscount, 1500);
  assert.equal(o2.discount, 1600);
  // taken off the order: the code is free again
  const o3: any = await call('orders.update', admin, { id: o.id, version: o2.version, promoCode: null });
  assert.equal(o3.promoCode, null);
  assert.equal(o3.discount, 100);
  assert.equal((await db.query(`SELECT status FROM promo_codes WHERE code = $1`, [code]))[0].status, 'sent');
  // the same phone may use another code
  await db.query(`INSERT INTO promo_codes (code, channel, external_id, source_kind, source_id, status, pct, min_order, sent_at, expires_at) VALUES ('BJ-PH22','messenger','other-1','ad','999000222','sent',NULL,0, now(), now() + interval '90 days')`);
  await db.query(`UPDATE promo_codes SET amount = 700 WHERE code = 'BJ-PH22'`);
  const o4: any = await call('orders.create', admin, { ...base, items: items(1), promoCode: 'BJ-PH22' });
  assert.equal(o4.promoDiscount, 700);
  // expired (90 days gone): refused
  await db.query(`INSERT INTO promo_codes (code, channel, external_id, source_kind, source_id, status, pct, min_order, sent_at, expires_at) VALUES ('BJ-OLD2','messenger','other-2','ad','x','sent',10,0, now() - interval '91 days', now() - interval '1 day')`);
  await assert.rejects(call('orders.create', admin, { ...base, items: items(1), promoCode: 'BJ-OLD2' }), /expiré/);

  // the landing page: the field's check, and the order with the code (a bad code never stops the order)
  await db.query(`UPDATE promo_codes SET status = 'sent', order_id = NULL WHERE code = $1`, [code]);
  const page = (await db.query(`SELECT slug FROM landing_pages WHERE active ORDER BY id LIMIT 1`))[0];
  if (page) {
    const lc: any = await call('landing.code', sys, { slug: page.slug, code, total: 8000 });
    assert.equal(lc.ok, true);
    assert.equal(lc.discount, 800);
    assert.equal(((await call('landing.code', sys, { slug: page.slug, code: 'BJ-NOPE', total: 8000 })) as any).ok, false);
  }

  // Dellal reads the chat's code (it never makes one): in its prompt, with what it takes off
  const pc = await promoForConversation(db, r1.conversationId);
  assert.equal(pc?.code, code);
  assert.match(promoPromptLine(pc), new RegExp(`${code}.*-10%.*jamais d’autre code`));
  assert.match(promoPromptLine(null), /JAMAIS de code/);
});

test('comments: under a post marked « Awareness 🎁 » the private message is the code (not the AI), once per account', async () => {
  const { db, as } = await setup(30);
  // the demo's own codes out of the way
  await db.query('DELETE FROM promo_codes');
  const admin = await as(EMAILS.admin);
  await call('promo.settings.save', admin, SETTINGS({ minOrder: 0 }));
  await db.query(`INSERT INTO settings (key, value) VALUES ('cm', '{"enabled":true,"sendPrivate":true}') ON CONFLICT (key) DO UPDATE SET value = settings.value || '{"enabled":true}'`);
  const log: Log = [];
  const sys = await as(EMAILS.admin, fakeServer(log));
  const c1: any = await call('cm.receive', sys, { channel: 'facebook', externalId: 'cmt-aw-1', postId: 'post-aw', authorId: 'fb-user-1', authorName: 'Lina', text: 'Ch7al ?', caption: 'Poussette 🎁' });
  const post = (await db.query(`SELECT id FROM cm_posts WHERE external_id = 'post-aw'`))[0];
  await call('promo.markPost', admin, { id: num(post.id), on: true });
  assert.equal(((await call('cm.posts', admin, {})) as any).rows.find((p: any) => p.id === num(post.id)).awareness, true);
  await call('cm.run', sys, { id: c1.commentId });
  const priv = log.filter((l) => l.action === 'cmPrivate');
  assert.equal(priv.length, 1);
  const row = (await db.query(`SELECT * FROM promo_codes WHERE author_id = 'fb-user-1'`))[0];
  assert.ok(row, 'a code was made');
  assert.equal(row.source_kind, 'post');
  assert.equal(row.status, 'sent');
  assert.ok(String(priv[0].args.text).includes(row.code));
  // the person's chat id (from the private reply) and its conversation are kept
  assert.equal(row.external_id, `psid-cmt-aw-1`);
  assert.ok(row.conversation_id);
  // another comment of the same person: the same code
  const c2: any = await call('cm.receive', sys, { channel: 'facebook', externalId: 'cmt-aw-2', postId: 'post-aw2', authorId: 'fb-user-1', authorName: 'Lina', text: 'code ?' });
  const post2 = (await db.query(`SELECT id FROM cm_posts WHERE external_id = 'post-aw2'`))[0];
  await call('promo.markPost', admin, { id: num(post2.id), on: true });
  await call('cm.run', sys, { id: c2.commentId });
  assert.equal(num((await db.query(`SELECT count(*)::int AS n FROM promo_codes WHERE author_id = 'fb-user-1'`))[0].n), 1);
  const priv2 = log.filter((l) => l.action === 'cmPrivate');
  if (priv2.length > 1) assert.ok(String(priv2[1].args.text).includes(row.code));
  // stats count it, per post
  const st: any = await call('promo.stats', admin, { days: 30 });
  assert.equal(st.sent, 1);
  assert.ok(st.bySource.some((b: any) => b.kind === 'post' && b.id === 'post-aw'));
});

test('Dellal applies the chat’s welcome code itself when it takes the order (and says the total after it)', async () => {
  const { db, as } = await setup(30);
  await db.query('DELETE FROM promo_codes');
  const admin = await as(EMAILS.admin);
  await call('promo.settings.save', admin, SETTINGS({ minOrder: 0, kind: 'da', value: 500 }));
  await call('promo.mark', admin, { kind: 'ad', id: '999000333', on: true });
  await db.query(`INSERT INTO settings (key, value) VALUES ('dellal', '{"enabled":true,"version":"full","nightReplies":true}') ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value`);
  // the shop's own AI key (the fake server answers for it)
  await db.query(`INSERT INTO settings (key, value) VALUES ('secret_dellal_ai_key', '"sk-test"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const prod = (await db.query(`SELECT p.id, v.id AS vid FROM products p JOIN product_variants v ON v.product_id = p.id WHERE p.active AND NOT p.is_service AND v.active ORDER BY p.id LIMIT 1`))[0];
  const log: Log = [];
  let step = 0;
  const srv = fakeServer(log);
  const base = srv.dellal!;
  srv.dellal = async (action, args: any, ctx) => {
    if (action !== 'complete') return base(action, args, ctx);
    log.push({ action, args });
    step++;
    if (step === 1)
      return {
        content: [{ type: 'tool_use', id: 't1', name: 'create_order', input: { customer_name: 'Amina B', phone: '0555123499', wilaya: 'Alger', items: [{ product_id: num(prod.id), variant_id: num(prod.vid), qty: 1 }] } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    return { content: [{ type: 'text', text: 'C’est noté !' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
  };
  const sys = await as(EMAILS.admin, srv);
  const r: any = await call('dellal.receive', sys, { channel: 'messenger', externalId: 'chat-buyer', text: 'Salam', source: 'pub 999000333' });
  const code = (await db.query(`SELECT code FROM promo_codes WHERE external_id = 'chat-buyer'`))[0].code as string;
  await call('dellal.receive', sys, { channel: 'messenger', externalId: 'chat-buyer', text: 'nheb ncommandi, Amina 0555123499 Alger', source: null });
  const out: any = await call('dellal.answer', sys, { id: r.conversationId });
  // the system prompt told Dellal the code (and never to make one)
  const sysPrompt = String(log.find((l) => l.action === 'complete')!.args.system);
  assert.ok(sysPrompt.includes(code));
  assert.match(sysPrompt, /ne crées ni ne donnes jamais d’autre code/);
  const o = (await db.query(`SELECT * FROM orders WHERE conversation_id = $1`, [r.conversationId]))[0];
  assert.ok(o, `an order (${JSON.stringify(out)})`);
  assert.equal(o.promo_code, code);
  assert.equal(num(o.promo_discount), 500);
  assert.equal(o.awareness, true);
  assert.equal((await db.query(`SELECT status FROM promo_codes WHERE code = $1`, [code]))[0].status, 'used');
});
