// CM AI agent (community manager): the demo comments, Meta comment webhooks, the decision guardrails, the actions sent
// to Meta, the private message that opens a conversation in Message AI agent, the tester, posts, results and roles.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, ServerHooks } from '../index';
import { parseMetaComments } from '../dellal-server';
import { CM_LINES, guard, langOf, phoneOf } from '../modules/cm';
import { checkDarija } from '../modules/darija';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(150));
});

/** A fake server: the AI answers with a scripted list, and every Meta action is recorded. */
function fakeServer(script: any[], log: { action: string; args: any }[], opts: { failPublic?: boolean; failPrivate?: boolean } = {}): ServerHooks {
  return {
    courier: async () => ({}),
    meta: async () => ({}),
    hashPassword: async (p) => p,
    dellal: async (action, args: any) => {
      if (action === 'complete') {
        const next = script.shift();
        if (!next) return { content: [{ type: 'text', text: '{"intent":"other","reason":"rien"}' }], stop_reason: 'end_turn' };
        return typeof next === 'function' ? next(args) : next;
      }
      log.push({ action, args });
      if (action === 'cmReply') {
        if (opts.failPublic) throw new Error('Facebook : permission manquante');
        return { id: `reply-${args.commentId}` };
      }
      if (action === 'cmPrivate') {
        if (opts.failPrivate) throw new Error('Instagram : la personne n’accepte pas les messages');
        return { recipientId: `psid-${args.commentId}`, messageId: 'm_x' };
      }
      if (action === 'cmPost') return { caption: null, permalink: null };
      return { ok: true };
    },
  };
}
const ai = (j: Record<string, unknown>) => ({ content: [{ type: 'text', text: '```json\n' + JSON.stringify(j) + '\n```' }], stop_reason: 'end_turn' });

async function enableAi() {
  const admin = await as(EMAILS.admin);
  const g: any = await call('dellal.settings.get', admin, {});
  await call('dellal.settings.save', admin, { ...g.settings, enabled: true, messengerPageId: '1029384756', secrets: { ai: 'sk-ant-test-cm', pageToken: 'EAAB-page' } });
}
async function cmSave(patch: Record<string, unknown>) {
  const admin = await as(EMAILS.admin);
  const g: any = await call('cm.settings.get', admin, {});
  return call('cm.settings.save', admin, { ...g.settings, ...patch });
}
let n = 0;
const comment = (text: string, extra: Record<string, unknown> = {}) => ({
  channel: 'facebook' as const,
  externalId: `t_${++n}`,
  postId: '1029384756_900',
  accountId: '1029384756',
  authorId: `u_${n}`,
  authorName: 'Test Client',
  text,
  caption: 'Poussette canne pliable, livraison 58 wilayas',
  ...extra,
});

test('demo comments: answered, private messages, hidden spam and phone, a complaint for the team', async () => {
  const conf = await as(EMAILS.conf);
  const f: any = await call('cm.feed', conf, { tab: 'all' });
  const by = (t: RegExp) => f.rows.find((c: any) => t.test(c.body));
  const price = by(/^ch7al \?$/);
  assert.equal(price.status, 'answered');
  assert.equal(price.intent, 'price');
  assert.equal(price.publicReply, CM_LINES.privateDone.dz);
  assert.match(price.privateReply, /Poussette canne pliable b 12 900 DA/);
  assert.ok(price.conversationId);
  const spam = by(/bebe-discount/);
  assert.equal(spam.status, 'hidden');
  assert.equal(spam.hidden, true);
  assert.equal(spam.by, 'rule');
  assert.equal(spam.publicReply, null);
  const phone = by(/0661 23 45 67/);
  assert.equal(phone.hidden, true);
  assert.equal(phone.phone, '0661234567');
  assert.equal(phone.publicReply, null, 'no public answer under a hidden comment');
  assert.match(phone.privateReply, /Blida/);
  const complaint = by(/wsalni walou/);
  assert.equal(complaint.status, 'handoff');
  assert.equal(complaint.hidden, false, 'a complaint is not hidden');
  // an angry customer who insults: hidden (vulgar), but it reaches the team with a private message
  const rude = by(/nsabin/);
  assert.equal(rude.status, 'handoff');
  assert.equal(rude.hidden, true);
  assert.equal(rude.intent, 'complaint');
  assert.ok(rude.privateReply);
  assert.equal(by(/Machallah/).publicReply, CM_LINES.thanks.dz);
  assert.equal(by(/^Amina Boudiaf$/).status, 'ignored');
  const arabic = by(/لوهران/);
  assert.match(arabic.privateReply, /التوصيل لـ وهران: \d+ دج للدار/);
  assert.equal(f.counts.todo, 6, '4 new + 2 complaints waiting for a person');
  // the private messages opened conversations in Message AI agent: the comment first, then the CM AI agent's message
  const c: any = await call('dellal.conversation', conf, { id: price.conversationId });
  assert.equal(c.conversation.channel, 'messenger');
  assert.match(c.conversation.source, /^Commentaire Facebook \(pub\)/);
  assert.equal(c.messages[0].role, 'customer');
  assert.ok(c.messages[0].meta.comment);
  assert.equal(c.messages[1].role, 'agent');
  assert.equal(c.messages[1].meta.cm, true);
  const quiet = (await db.query('SELECT unread, last_customer_at FROM conversations WHERE id = $1', [arabic.conversationId]))[0];
  assert.equal(quiet.last_customer_at, null, 'a comment is not a message: no follow-up, no unread');
  assert.equal(quiet.unread, 0);
  // the first commenter answered the private message and Dellal took the order
  assert.ok(c.conversation.orderRef, 'comment → private message → conversation → order');
  assert.equal(c.messages[c.messages.length - 2].body.startsWith('create_order → '), true);
  const results: any = await call('cm.stats', conf, { days: 7 });
  assert.equal(results.orders, 1);
  assert.equal(results.replied, 1);
  // the menu counts
  const counts: any = await call('orders.counts', conf, {});
  assert.equal(counts.ai.cm, 6);
  assert.ok(counts.ai.messages >= 1);
});

test('the demo texts are clean Algerian Darija', () => {
  for (const k of Object.keys(CM_LINES) as (keyof typeof CM_LINES)[]) {
    assert.deepEqual(checkDarija(CM_LINES[k].dz), [], `${k} (latin)`);
    assert.deepEqual(checkDarija(CM_LINES[k].ar), [], `${k} (arabic)`);
  }
  assert.equal(langOf('ch7al ?'), 'dz');
  assert.equal(langOf('Commandit men 10 jours w ma wsalni walou'), 'dz');
  assert.equal(langOf('بشحال التوصيل؟'), 'ar');
  assert.equal(langOf('Bonjour, il est disponible en 2ème taille ?'), 'fr');
  assert.equal(langOf('Prix svp'), 'fr');
});

test('roles: sellers and marketers work the comments, settings are admin only', async () => {
  await assert.rejects(call('cm.feed', await as(EMAILS.livreur), {}), /Accès refusé/);
  await assert.rejects(call('cm.feed', await as(EMAILS.depot), {}), /Accès refusé/);
  assert.ok(((await call('cm.feed', await as(EMAILS.marketer), {})) as any).rows);
  await assert.rejects(call('cm.settings.get', await as(EMAILS.conf), {}), /Accès refusé/);
  await assert.rejects(call('cm.receive', await as(EMAILS.conf), comment('x')), /Accès refusé/);
});

test('Meta comment webhooks: Facebook feed and Instagram comments, the page’s own comments left out', () => {
  const fb = parseMetaComments({
    object: 'page',
    entry: [
      {
        id: 'PAGE',
        changes: [
          { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'P_C1', post_id: 'PAGE_P', parent_id: 'PAGE_P', message: 'ch7al ?', from: { id: 'U1', name: 'Karim' }, post: { promotion_status: 'active', permalink_url: 'https://fb/p' } } },
          { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'P_C2', post_id: 'PAGE_P', parent_id: 'P_C1', message: 'Jawbnakom f privé', from: { id: 'PAGE', name: 'Shop' } } },
          { field: 'feed', value: { item: 'comment', verb: 'edited', comment_id: 'P_C1', post_id: 'PAGE_P', message: 'ch7al ??', from: { id: 'U1' } } },
          { field: 'feed', value: { item: 'reaction', verb: 'add', post_id: 'PAGE_P', from: { id: 'U3' } } },
          { field: 'feed', value: { item: 'comment', verb: 'add', comment_id: 'P_C3', post_id: 'PAGE_P', parent_id: 'P_C1', message: 'Oran', from: { id: 'U1', name: 'Karim' } } },
        ],
      },
    ],
  });
  assert.deepEqual(
    fb.map((c) => [c.channel, c.externalId, c.postId, c.parentId, c.authorName, c.text, c.isAd]),
    [
      ['facebook', 'P_C1', 'PAGE_P', null, 'Karim', 'ch7al ?', true],
      ['facebook', 'P_C3', 'PAGE_P', 'P_C1', 'Karim', 'Oran', false],
    ],
  );
  const ig = parseMetaComments({
    object: 'instagram',
    entry: [{ id: 'IGID', changes: [{ field: 'comments', value: { id: 'IGC1', text: 'prix ?', from: { id: 'IGU', username: 'amel' }, media: { id: 'M1', media_product_type: 'FEED' } } }, { field: 'comments', value: { id: 'IGC2', text: 'merci', from: { id: 'IGID', username: 'shop' }, media: { id: 'M1' } } }] }],
  });
  assert.deepEqual(ig.map((c) => [c.channel, c.externalId, c.postId, c.authorName]), [['instagram', 'IGC1', 'M1', '@amel']]);
  // a message webhook holds no comments
  assert.equal(parseMetaComments({ object: 'page', entry: [{ messaging: [{ sender: { id: 'x' }, message: { text: 'hi' } }] }] }).length, 0);
});

test('a comment with Claude: hide → private message → public reply, sent to Meta; the conversation is keyed by the PSID', async () => {
  await enableAi();
  await cmSave({ enabled: true, delaySec: 0, nightReplies: true });
  const log: any[] = [];
  const system: string[] = [];
  const server = fakeServer(
    [
      (req: any) => {
        system.push(req.system);
        return ai({ intent: 'price', hide: false, public_reply: 'Jawbnakom f privé 📩', private_reply: 'Salam 👋 La poussette b 12 900 DA. Wach men wilaya ?', handoff: false, reason: 'prix' });
      },
    ],
    log,
  );
  const sys = await as(EMAILS.admin, server);
  // a new post: the webhook carries no text, the agent reads it once (cmPost)
  const first = comment('ch7al la poussette ?', { postId: '1029384756_901', caption: null });
  const ext = first.externalId;
  const r: any = await call('cm.receive', sys, first);
  assert.ok(r.commentId);
  assert.equal(r.enabled, true);
  assert.equal(await call('cm.receive', sys, { ...first, text: 'x' }), null, 'the same comment twice is stored once');
  const out: any = await call('cm.run', sys, { id: r.commentId });
  assert.equal(out.status, 'answered');
  assert.equal(out.by, 'ai');
  assert.match(system[0], /community manager/);
  assert.match(system[0], /Prix en public : NON/);
  assert.match(system[0], /DARIJA ALGÉRIENNE/);
  assert.deepEqual(
    log.map((l) => l.action),
    ['cmPost', 'cmPrivate', 'cmReply'],
  );
  assert.equal(log[1].args.commentId, ext);
  const row = (await db.query('SELECT * FROM cm_comments WHERE id = $1', [r.commentId]))[0];
  assert.equal(row.public_reply_id, `reply-${ext}`);
  assert.equal(row.private_sent, true);
  const conv = (await db.query('SELECT * FROM conversations WHERE id = $1', [row.conversation_id]))[0];
  assert.equal(conv.external_id, `psid-${ext}`);
  assert.equal(conv.channel, 'messenger');
  // our own public reply coming back through the webhook is not a new comment
  assert.equal(await call('cm.receive', sys, { ...comment('Jawbnakom f privé 📩'), externalId: `reply-${ext}`, authorId: 'someone' }), null);
  // the page's own comment either
  assert.equal(await call('cm.receive', sys, { ...comment('merci'), authorId: '1029384756' }), null);
  // answered once: the timer and the sweep do not answer it again
  assert.equal(((await call('cm.run', sys, { id: r.commentId })) as any).skipped, 'Déjà traité');
});

test('guardrails: no price in public, one private message per person and post, phones hidden, complaints never hidden', async () => {
  await enableAi();
  await cmSave({ enabled: true, showPrice: false, hidePhones: true, hideSpam: true, sendPrivate: true, replyPublic: true });
  const log: any[] = [];
  const server = fakeServer(
    [
      ai({ intent: 'price', public_reply: 'La poussette b 12 900 DA 👌', private_reply: 'Salam, 12 900 DA.', reason: 'prix' }),
      ai({ intent: 'price', public_reply: 'Jawbnakom f privé 📩', private_reply: 'Salam encore', reason: 'prix' }),
      ai({ intent: 'complaint', hide: true, public_reply: 'Smhoulna 🙏', private_reply: 'Ab3toulna le numéro de la commande', handoff: true, reason: 'réclamation' }),
      ai({ intent: 'order', hide: false, public_reply: 'Jawbnakom f privé 📩', private_reply: 'Wach men commune ?', reason: 'numéro' }),
    ],
    log,
  );
  const sys = await as(EMAILS.admin, server);
  const a: any = await call('cm.receive', sys, { ...comment('ch7al ?'), authorId: 'same-person' });
  await call('cm.run', sys, { id: a.commentId });
  let row = (await db.query('SELECT * FROM cm_comments WHERE id = $1', [a.commentId]))[0];
  assert.equal(row.public_reply, CM_LINES.privateDone.dz, 'the price was taken out of the public reply');
  assert.equal(row.private_reply, 'Salam, 12 900 DA.');
  // the same person again under the same post: no second private message, the public line says so
  const b: any = await call('cm.receive', sys, { ...comment('wach ?'), authorId: 'same-person' });
  await call('cm.run', sys, { id: b.commentId });
  row = (await db.query('SELECT * FROM cm_comments WHERE id = $1', [b.commentId]))[0];
  assert.equal(row.private_sent, false);
  assert.equal(row.public_reply, 'Jawbnakom f privé 📩');
  // a complaint is not hidden even when the AI says so
  const c: any = await call('cm.receive', sys, comment('arnaque, ma wsalni walou'));
  await call('cm.run', sys, { id: c.commentId });
  row = (await db.query('SELECT * FROM cm_comments WHERE id = $1', [c.commentId]))[0];
  assert.equal(row.hidden, false);
  assert.equal(row.status, 'handoff');
  // a phone number is hidden even when the AI forgot, and gets no public answer
  const d: any = await call('cm.receive', sys, comment('bghit wahda 0770 11 22 33'));
  const before = log.length;
  await call('cm.run', sys, { id: d.commentId });
  row = (await db.query('SELECT * FROM cm_comments WHERE id = $1', [d.commentId]))[0];
  assert.equal(row.hidden, true);
  assert.equal(row.phone, '0770112233');
  assert.equal(row.public_reply, null);
  assert.deepEqual(
    log.slice(before).map((l) => l.action),
    ['cmHide', 'cmPrivate'],
  );
  // a link or an insult is hidden by rule, without asking the AI
  const e: any = await call('cm.receive', sys, comment('Promo 👉 https://autre-page.dz/x'));
  const out: any = await call('cm.run', sys, { id: e.commentId });
  assert.equal(out.by, 'rule');
  assert.equal(out.status, 'hidden');
});

test('a complaint always reaches the team: with a link it stays visible, with insults it is hidden', async () => {
  await enableAi();
  await cmSave({ enabled: true, hideSpam: true, hidePhones: true, sendPrivate: true, replyPublic: true });
  const sys = await as(
    EMAILS.admin,
    fakeServer(
      [
        ai({ intent: 'spam', hide: true, reason: 'lien' }),
        ai({ intent: 'complaint', hide: false, public_reply: 'Smhoulna 🙏', private_reply: 'Ab3toulna le numéro', reason: 'réclamation' }),
      ],
      [],
    ),
  );
  // the AI said "spam", but the rules see a complaint first: never decided by rule, and a link alone does not hide it
  const a: any = await call('cm.receive', sys, comment('arnaque, voir le suivi sur yalidine.com, ma wsalni walou'));
  const outA: any = await call('cm.run', sys, { id: a.commentId });
  assert.equal(outA.by, 'ai');
  const b: any = await call('cm.receive', sys, comment('Nassabin ! ma wsalni walou, 9a7ba'));
  const outB: any = await call('cm.run', sys, { id: b.commentId });
  assert.equal(outB.status, 'handoff');
  const row = (await db.query('SELECT * FROM cm_comments WHERE id = $1', [b.commentId]))[0];
  assert.equal(row.hidden, true, 'vulgar: hidden');
  assert.equal(row.public_reply, null, 'no public answer under a hidden comment');
  assert.equal(row.private_sent, true, 'the customer still gets a private message');
});

test('a private message that fails: no "answered in private" in public, and the comment stays to handle', async () => {
  await enableAi();
  await cmSave({ enabled: true });
  const log: any[] = [];
  const sys = await as(EMAILS.admin, fakeServer([ai({ intent: 'price', public_reply: 'Jawbnakom f privé 📩', private_reply: 'Salam 👋 12 900 DA', reason: 'prix' })], log, { failPrivate: true }));
  const r: any = await call('cm.receive', sys, comment('ch7al ?'));
  const out: any = await call('cm.run', sys, { id: r.commentId });
  assert.equal(out.status, 'error');
  const reply = log.find((l) => l.action === 'cmReply');
  assert.equal(reply.args.text, CM_LINES.writeUs.dz);
  const row = (await db.query('SELECT * FROM cm_comments WHERE id = $1', [r.commentId]))[0];
  assert.equal(row.private_sent, false);
  assert.match(row.send_error, /Message privé/);
  // answering again only does what is missing: the public reply is not posted twice
  const again: any[] = [];
  const conf = await as(EMAILS.conf, fakeServer([ai({ intent: 'price', public_reply: 'Jawbnakom f privé 📩', private_reply: 'Salam 👋', reason: 'prix' })], again));
  const second: any = await call('cm.answer', conf, { id: r.commentId });
  assert.equal(second.status, 'answered');
  assert.deepEqual(
    again.map((l) => l.action),
    ['cmPrivate'],
  );
});

test('two comments of one person at the same time: one private message', async () => {
  await enableAi();
  await cmSave({ enabled: true });
  const log: any[] = [];
  const slow = (j: any) => () => new Promise((res) => setTimeout(() => res(ai(j)), 30));
  const sys = await as(
    EMAILS.admin,
    fakeServer(
      [slow({ intent: 'price', public_reply: 'Jawbnakom f privé 📩', private_reply: 'Salam 1', reason: 'prix' }), slow({ intent: 'price', public_reply: 'Jawbnakom f privé 📩', private_reply: 'Salam 2', reason: 'prix' })],
      log,
    ),
  );
  const a: any = await call('cm.receive', sys, { ...comment('ch7al ?'), authorId: 'twice' });
  const b: any = await call('cm.receive', sys, { ...comment('ch7al la rose ?'), authorId: 'twice' });
  await Promise.all([call('cm.run', sys, { id: a.commentId }), call('cm.run', sys, { id: b.commentId })]);
  assert.equal(log.filter((l) => l.action === 'cmPrivate').length, 1);
});

test('the AI keeps failing: tried again, then left to a person', async () => {
  await enableAi();
  await cmSave({ enabled: true });
  const boom = () => {
    throw new Error('IA (Anthropic) limite les demandes pour l’instant.');
  };
  const sys = await as(EMAILS.admin, fakeServer([boom, boom, boom], []));
  const r: any = await call('cm.receive', sys, comment('prix ?'));
  for (let i = 0; i < 3; i++) await assert.rejects(call('cm.run', sys, { id: r.commentId }), /limite/);
  const row = (await db.query('SELECT status, send_error FROM cm_comments WHERE id = $1', [r.commentId]))[0];
  assert.equal(row.status, 'error');
  assert.match(row.send_error, /limite/);
});

test('public replies never carry a price (when private), a phone number or a link; numbers in Arabic digits too', () => {
  const f: any = { channel: 'facebook', phone: null, alreadyPrivate: false, alreadyPublic: false, tooOld: false, lang: 'dz', body: 'ch7al ?' };
  const s: any = { replyPublic: true, showPrice: false, sendPrivate: true, hideSpam: true, hidePhones: true, banned: '' };
  for (const pub of ['b 12 900 ✅', 'Prix : 12900', 'b melyoun w 290', 'السعر ١٢٩٠٠ دج', 'Appelez le 0555 12 34 56', 'Appelez le ٠٥٥٥١٢٣٤٥٦', 'Fixe : 021 23 45 67', 'Voir boutique.fr']) {
    const d = guard({ intent: 'price', hide: false, publicReply: pub, privateReply: 'Salam 👋', handoff: false, reason: '' }, f, s);
    assert.equal(d.publicReply, CM_LINES.privateDone.dz, pub);
  }
  // a phone number written in Arabic digits, or a landline, is found in the comment
  assert.equal(phoneOf('nheb wahda ٠٦٦١٢٣٤٥٦٧'), '0661234567');
  assert.equal(phoneOf('fixe 021 23 45 67 Alger'), '021234567');
  // tagged friends do not decide the language
  assert.equal(langOf('Amina Benali شحال السعر'), 'ar');
  assert.equal(langOf('@ines شحال'), 'ar');
  assert.equal(langOf('Salam, ch7al ?'), 'dz');
});

test('the sweep: channels turned off wait without blocking the others', async () => {
  await enableAi();
  await cmSave({ enabled: true, delaySec: 0, nightReplies: true, channels: { facebook: true, instagram: false, tiktok: false } });
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  const sys = await as(EMAILS.admin, fakeServer([], []));
  for (let i = 0; i < 31; i++) {
    const r: any = await call('cm.receive', sys, { ...comment(`ig ${i} prix ?`), channel: 'instagram', postId: 'IGMEDIA' });
    await db.query('UPDATE cm_comments SET created_at = $2 WHERE id = $1', [r.commentId, old]);
  }
  const fb: any = await call('cm.receive', sys, comment('fb prix ?'));
  await db.query('UPDATE cm_comments SET created_at = $2 WHERE id = $1', [fb.commentId, new Date(Date.now() - 5 * 60_000).toISOString()]);
  await call('cm.sweep', sys, {});
  const row = (await db.query('SELECT status FROM cm_comments WHERE id = $1', [fb.commentId]))[0];
  assert.notEqual(row.status, 'new');
  await cmSave({ channels: { facebook: true, instagram: true, tiktok: false } });
});

test('the shop’s settings change the decision', () => {
  const f: any = { channel: 'facebook', phone: null, alreadyPrivate: false, alreadyPublic: false, tooOld: false, lang: 'fr' };
  const s: any = { replyPublic: true, showPrice: true, sendPrivate: false, hideSpam: false, hidePhones: false };
  const d = guard({ intent: 'price', hide: false, publicReply: 'Elle est à 12 900 DA', privateReply: 'Bonjour…', handoff: false, reason: '' }, f, s);
  assert.equal(d.privateReply, '', 'no private message when the shop turned it off');
  assert.equal(d.publicReply, 'Elle est à 12 900 DA', 'the price may be public when allowed');
  const spam = guard({ intent: 'spam', hide: true, publicReply: 'x', privateReply: 'y', handoff: false, reason: '' }, f, s);
  assert.equal(spam.hide, false, 'nothing is hidden when the shop turned it off');
  assert.equal(spam.publicReply, '');
  // "answered in private" when no private message can go (more than 7 days): ask them to write instead
  const old = guard({ intent: 'price', hide: false, publicReply: 'Nous vous avons répondu en privé 📩', privateReply: 'Bonjour', handoff: false, reason: '' }, { ...f, tooOld: true }, { ...s, sendPrivate: true });
  assert.equal(old.privateReply, '');
  assert.equal(old.publicReply, CM_LINES.writeUs.fr);
  // a phone number or a link never goes in a public reply
  const clean = guard({ intent: 'question', hide: false, publicReply: 'Appelez le 0550 12 34 56 ou www.site.com', privateReply: '', handoff: false, reason: '' }, f, s);
  assert.doesNotMatch(clean.publicReply, /0550|www/);
});

test('when the public reply fails, the comment shows the error; off or at night the agent waits', async () => {
  await enableAi();
  await cmSave({ enabled: true, nightReplies: false });
  const log: any[] = [];
  const server = fakeServer([ai({ intent: 'praise', public_reply: 'Ya3tikom saha 🙏', reason: 'merci' })], log, { failPublic: true });
  const sys = await as(EMAILS.admin, server);
  const day = { ...sys, now: () => Date.parse('2026-10-22T11:00:00Z') };
  const r: any = await call('cm.receive', day, comment('Machallah 😍 top'));
  const out: any = await call('cm.run', day, { id: r.commentId });
  assert.equal(out.status, 'error');
  const row = (await db.query('SELECT * FROM cm_comments WHERE id = $1', [r.commentId]))[0];
  assert.match(row.send_error, /permission manquante/);
  // at night: kept for the morning
  const night = { ...sys, now: () => Date.parse('2026-10-22T01:30:00Z') };
  const r2: any = await call('cm.receive', night, comment('prix ?'));
  assert.match(((await call('cm.run', night, { id: r2.commentId })) as any).skipped, /nuit/);
  // off: nothing, but a person can still ask the agent (cm.answer)
  await cmSave({ enabled: false, nightReplies: true });
  assert.match(((await call('cm.run', sys, { id: r2.commentId })) as any).skipped, /désactivé/);
  const conf = await as(EMAILS.conf, fakeServer([ai({ intent: 'price', public_reply: 'Jawbnakom f privé 📩', private_reply: 'Salam 👋', reason: 'prix' })], []));
  const manual: any = await call('cm.answer', conf, { id: r2.commentId });
  assert.equal(manual.status, 'answered');
  assert.equal(manual.comment.privateSent, true);
  await cmSave({ enabled: true });
});

test('an unreadable AI answer falls back to the rules; Darija mistakes are rewritten', async () => {
  await enableAi();
  await cmSave({ enabled: true, nightReplies: true });
  const sys = await as(EMAILS.admin, fakeServer([{ content: [{ type: 'text', text: 'Désolé, je ne peux pas.' }], stop_reason: 'end_turn' }], []));
  const r: any = await call('cm.receive', sys, comment('ch7al ?'));
  const out: any = await call('cm.run', sys, { id: r.commentId });
  assert.equal(out.by, 'demo');
  assert.match(out.decision.reason, /illisible/);
  // a Moroccan word in the AI's private message: one rewrite
  let rewrite = '';
  const sys2 = await as(
    EMAILS.admin,
    fakeServer(
      [
        ai({ intent: 'price', public_reply: 'Jawbnakom f privé 📩', private_reply: 'Salam, daba nab3atlek les détails', reason: 'prix' }),
        (req: any) => {
          rewrite = req.messages[0].content;
          return { content: [{ type: 'text', text: 'Salam, dorka nab3atlek les détails' }], stop_reason: 'end_turn' };
        },
      ],
      [],
    ),
  );
  const r2: any = await call('cm.receive', sys2, comment('chhal ?'));
  await call('cm.run', sys2, { id: r2.commentId });
  assert.match(rewrite, /daba/);
  const row = (await db.query('SELECT private_reply, meta FROM cm_comments WHERE id = $1', [r2.commentId]))[0];
  assert.equal(row.private_reply, 'Salam, dorka nab3atlek les détails');
  assert.equal(row.meta.darija.private.issues[0].id, 'daba');
});

test('Dellal continues the sale: it sees the comment, and does not follow up a private message nobody answered', async () => {
  await enableAi();
  const conf = await as(EMAILS.conf);
  const f: any = await call('cm.feed', conf, { tab: 'all', q: 'لوهران' });
  const convId = f.rows[0].conversationId;
  let seen: any = null;
  const server: ServerHooks = {
    courier: async () => ({}),
    meta: async () => ({}),
    hashPassword: async (p) => p,
    dellal: async (action, args: any) => {
      if (action === 'complete') {
        seen ??= args;
        return { content: [{ type: 'text', text: 'مليح، نسجلكم؟' }], stop_reason: 'end_turn' };
      }
      return { ok: true };
    },
  };
  const sys = await as(EMAILS.admin, server);
  // no follow-up: the person never answered the private message
  assert.equal(((await call('dellal.followUps', sys, {})) as any).sent, 0);
  const ext = (await db.query('SELECT external_id FROM conversations WHERE id = $1', [convId]))[0].external_id;
  const r: any = await call('dellal.receive', sys, { channel: 'messenger', externalId: ext, text: 'الرمادية', messageId: 'mid-cm-1' });
  assert.equal(r.conversationId, convId, 'the answer lands in the conversation the comment opened');
  await call('dellal.answer', sys, { id: convId });
  assert.match(seen.messages[0].content, /^\[commentaire public sous la publication « 🔥 Poussette/);
  assert.equal(seen.messages[1].role, 'assistant');
});

test('tester, posts and results', async () => {
  const conf = await as(EMAILS.conf);
  const before = Number((await db.query('SELECT count(*)::int AS n FROM cm_comments'))[0].n);
  const posts: any = await call('cm.posts', conf, {});
  const ad = posts.rows.find((p: any) => p.isAd);
  assert.match(ad.productName, /Poussette/);
  const t: any = await call('cm.test', conf, { body: 'kayen livraison l Tamanrasset ?', postId: ad.id });
  assert.equal(t.by, 'demo');
  assert.equal(t.decision.intent, 'delivery');
  assert.match(t.decision.privateReply, /Tamanrasset/);
  assert.equal(t.facts.place, 'Tamanrasset');
  assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM cm_comments'))[0].n), before, 'a test stores nothing');
  // link the post to another product: the agent now answers with that one
  const chaise = posts.products.find((p: any) => /Chaise/.test(p.name));
  await call('cm.linkPost', conf, { id: ad.id, productId: chaise.id });
  const t2: any = await call('cm.test', conf, { body: 'Prix svp', postId: ad.id });
  assert.match(t2.decision.privateReply, /Chaise haute/);
  await call('cm.linkPost', conf, { id: ad.id, productId: null });
  // without a linked product the caption tells it; a common word does not change the product, a product's name does
  assert.match(((await call('cm.test', conf, { body: 'c bien pour un bébé de 6 mois ?', postId: ad.id })) as any).facts.product, /Poussette/);
  assert.match(((await call('cm.test', conf, { body: 'w la chaise haute ch7al ?', postId: ad.id })) as any).facts.product, /Chaise haute/);
  assert.match(((await call('cm.test', conf, { body: 'les poussettes dispo ?', postId: null })) as any).facts.product, /Poussette/);
  // results
  const s: any = await call('cm.stats', conf, { days: 7 });
  assert.ok(s.total >= 13);
  assert.ok(s.byAi >= 8);
  assert.ok(s.hidden >= 3);
  assert.ok(s.private >= 5);
  assert.ok(s.intents.some((x: any) => x.intent === 'price'));
});

test('a person answers, writes in private, hides, ignores', async () => {
  const conf = await as(EMAILS.conf);
  const sys = await as(EMAILS.admin);
  const fresh = async (text: string) => ((await call('cm.receive', sys, comment(text))) as any).commentId as number;
  const id = await fresh('Prix svp');
  await call('cm.reply', conf, { id, body: 'Jawbnakom f privé 📩' });
  await call('cm.private', conf, { id, body: 'Salam, la chaise b 8 900 DA.' });
  let row: any = ((await call('cm.feed', conf, { tab: 'all' })) as any).rows.find((x: any) => x.id === id);
  assert.equal(row.status, 'answered');
  assert.equal(row.by, 'team');
  assert.equal(row.handledBy, 'Samira');
  const conv: any = await call('dellal.conversation', conf, { id: row.conversationId });
  assert.equal(conv.conversation.mode, 'human', 'a seller wrote: Dellal pauses on this conversation');
  assert.equal(conv.messages[1].role, 'staff');
  await assert.rejects(call('cm.private', conf, { id, body: 'encore' }), /déjà parti/);
  // a marketer writes in private: Dellal keeps the conversation (marketers do not open Message AI agent)
  const mkId = await fresh('kayen livraison ?');
  const sentMk: any = await call('cm.private', await as(EMAILS.marketer), { id: mkId, body: 'Salam, nchoufou m3akom.' });
  assert.equal(((await db.query('SELECT mode FROM conversations WHERE id = $1', [sentMk.conversationId]))[0]).mode, 'ai');
  await call('cm.hide', conf, { id, hidden: true });
  row = ((await call('cm.feed', conf, { tab: 'hidden' })) as any).rows.find((x: any) => x.id === id);
  assert.equal(row.hidden, true);
  await call('cm.hide', conf, { id, hidden: false });
  const other = await fresh('hmm');
  await call('cm.ignore', conf, { id: other });
  assert.equal(((await call('cm.feed', conf, { tab: 'all' })) as any).rows.find((x: any) => x.id === other).status, 'ignored');
  // a complaint settled by a person: marked as handled
  const done = await fresh('ma wsalni walou');
  await call('cm.ignore', conf, { id: done, done: true });
  assert.equal(((await call('cm.feed', conf, { tab: 'all' })) as any).rows.find((x: any) => x.id === done).status, 'answered');
});

