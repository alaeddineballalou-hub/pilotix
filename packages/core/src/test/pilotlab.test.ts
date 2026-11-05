// Pilot AI › Test & lessons (control room): a Pilotix person talks to Dellal as a customer of a shop, with the lesson book
// they choose (in service, the version of « Push en test », an A/B test's, none), in their own test chat (never measured, Pilotix's key, Pilot AI's
// own cost); and teaches Dellal in a chat: Pilot AI turns their words into one lesson that passes the checks, they read it
// and add it, and it waits for the next book (tested on a share of new chats like any book).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Ctx, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, staffLogin } from '../index';
import { makeSession } from '../rpc';
import { profileById } from '../modules/users';
import * as pilot from '../modules/pilotlearn';
import { savePilotConfig } from '../platform/pilotai';
import { aiCostUsd, aiLabOfMonth, aiUsageOfMonth, recordAiUsage } from '../platform/aiusage';
import { loadShops } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const NOW = Date.parse('2026-11-02T10:00:00Z');

let t: Tenancy;
let pctx: PCtx;
let shopId: number;
const p = <T = any>(name: string, input: unknown = {}, as: PCtx = pctx) => platformCall(name, as, input) as Promise<T>;

/** the server as Dellal sees it: every AI request kept, the AI answers with the script */
const reqs: any[] = [];
const hooks: ServerHooks = {
  courier: async () => ({}),
  meta: async () => ({}),
  hashPassword: async (x) => x,
  dellal: async (action, args) => {
    if (action !== 'complete') return { ok: true };
    reqs.push(args);
    return { content: [{ type: 'text', text: 'Salam 3likoum, mar7ba bik 👋 wach t7ab ta3ref ?' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  },
};

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  t = pgliteTenancy(pg as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  shopId = (await loadShops(t)).find((s) => s.kind === 'store')!.id;
  const db = t.shop('public');
  const admin = (await db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) AND active ORDER BY id LIMIT 1`))[0];
  const session = makeSession((await profileById(db, Number(admin.id)))!);
  const shop = async (id: number): Promise<Ctx> => ({
    db,
    session,
    shop: { id, slug: 'boutique', primary: true, features: null, locked: false, demo: false, maxUsers: null, maxDrivers: null },
    now: () => NOW,
    emit: () => undefined,
    server: hooks,
    t,
  });
  pctx = { t, staff, now: () => NOW, shop };
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 }, 'sk-ant-api03-test-key-0123456789');
});

test('a lesson from the chat: checked, approved by its author, first in the next book; a near copy is refused, a refused one comes back', async () => {
  const pdb = t.platform;
  const bad = await pilot.addCoachLesson(pdb, { by: 'Amine', topic: 'price', text: 'When the customer asks the price, say it costs 2500 DA with delivery.' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'lint');
  assert.ok(bad.problems!.includes('number'));
  assert.deepEqual(await pilot.addCoachLesson(pdb, { by: '', topic: 'trust', text: 'x' }), { ok: false, error: 'who' });

  const text = 'When the customer asks for photos, send the real photos from the product tool and ask which color they prefer.';
  const ok = await pilot.addCoachLesson(pdb, { by: 'Amine', topic: 'product', text, meaning: 'Quand le client demande des photos, envoyer les vraies photos.' });
  assert.equal(ok.ok, true);
  const row = (await pdb.query(`SELECT status, source, prio, by_user, evidence FROM platform.pilot_lessons WHERE id = $1`, [ok.id]))[0];
  assert.equal(row.status, 'approved', 'the person who added it checked it: approved at once');
  assert.equal(row.source, 'coach');
  assert.equal(Number(row.prio), pilot.COACH_PRIO, 'kept before the lessons the nights found when the book is full');
  assert.equal(row.by_user, 'Amine');
  assert.equal(row.evidence.meaning, 'Quand le client demande des photos, envoyer les vraies photos.');

  const twin = await pilot.addCoachLesson(pdb, { by: 'Amine', topic: 'product', text: 'When the customer asks for photos, send the real photos from the product tool and ask which color they like.' });
  assert.equal(twin.error, 'duplicate', 'nearly the same idea: refused');
  assert.equal(twin.id, ok.id);

  // the coach refuses it, then writes it again: it comes back (same lesson, approved again)
  await pilot.rejectLesson(pdb, ok.id as number, 'Amine', 'pas maintenant');
  const back = await pilot.addCoachLesson(pdb, { by: 'Amine', topic: 'product', text });
  assert.equal(back.ok, true);
  assert.equal(back.id, ok.id);
  assert.equal((await pdb.query(`SELECT status FROM platform.pilot_lessons WHERE id = $1`, [ok.id]))[0].status, 'approved');

  // the next book: version 1 (no book yet), the new lesson is in it
  const next = await pilot.nextBook(pdb);
  assert.equal(next.version, 1);
  assert.equal(next.lessons, 1);
  assert.equal(next.changed, true);
  assert.deepEqual(
    next.fresh.map((f) => [f.id, f.source, f.fits]),
    [[ok.id, 'coach', true]],
  );

  // through the control room: checked again, written to the audit
  const added = await p('p.pilot.addLesson', { topic: 'closing', text: 'Before closing, read the full order back in one line and wait for a clear yes from the customer.' });
  assert.equal(added.ok, true);
  await assert.rejects(p('p.pilot.addLesson', { topic: 'closing', text: 'Promise a fast delivery tomorrow to close.' }), /pas sûre/);
  const st = await p('p.pilot.state');
  assert.equal(st.next.fresh.length, 2);
  assert.equal(st.next.version, 1);
});

test('the test chat: the book chosen is used as is and never recorded; Pilot AI pays it as its own cost; reset; no test running', async () => {
  reqs.length = 0;
  // the book in service (v1, promoted) and the next one (every approved lesson)
  await t.platform.query(
    `INSERT INTO platform.pilot_books (version, status, text, tokens, lesson_ids, by_user, promoted_at)
     VALUES (1, 'champion', 'LEARNED HABITS v1: greet the customer in their language.', 12, '[]', 'coach', now())`,
  );
  const live = await p('p.pilot.try', { shopId, book: 'live', body: 'salam, mazal kayen ?' });
  assert.equal(live.book.kind, 'live');
  assert.equal(live.book.version, 1);
  const agent = live.messages.filter((m: any) => m.role === 'agent').pop();
  assert.ok(agent, 'Dellal answered');
  assert.equal(agent.meta.pilot.version, 1);
  assert.equal(agent.meta.pilot.lab, 'live');
  assert.match(reqs[0].systemBlocks[0], /LEARNED HABITS v1: greet/, 'the book in service is in the shared block');
  assert.equal(reqs[0].feature, 'pilot', 'Pilot AI’s own cost: never in the shop’s bill');
  assert.equal(reqs[0].pilot, true, 'Pilotix’s key');

  // no version in test yet; « Push en test »: the coach's new lesson in a version only this chat uses
  await assert.rejects(p('p.pilot.try', { shopId, book: 'trial', body: 'salam' }), /Push en test/);
  await p('p.pilot.stage', { darija: false });
  const next = await p('p.pilot.try', { shopId, book: 'trial', body: 'nheb nchouf tsawer' });
  assert.equal(next.book.version, 2, 'the version in test is the version after the last one');
  const last = reqs[reqs.length - 1];
  assert.match(last.systemBlocks[0], /LEARNED HABITS v2/);
  assert.match(last.systemBlocks[0], /send the real photos from the product tool/, 'the coach’s new lesson is in it');
  assert.equal(next.conversationId, live.conversationId, 'one test chat per person, the book can change between messages');

  const none = await p('p.pilot.try', { shopId, book: 'none', body: 'chhal le prix ?' });
  assert.equal(none.book.version, 0);
  assert.doesNotMatch(reqs[reqs.length - 1].systemBlocks[0], /LEARNED HABITS/);

  // never measured: no exposure, not in the shop's lists, not in Pilot AI's cases
  assert.equal((await t.platform.query(`SELECT count(*)::int AS n FROM platform.pilot_exposure`))[0].n, 0);
  const conv = (await t.shop('public').query(`SELECT channel, external_id FROM conversations WHERE id = $1`, [live.conversationId]))[0];
  assert.deepEqual(conv, { channel: 'test', external_id: `pilot-${pctx.staff.id}` });

  // no test running: « in test » is not there
  await assert.rejects(p('p.pilot.try', { shopId, book: 'test', body: 'salam' }), /Aucun livre en test/);
  // reset: an empty chat
  const reset = await p('p.pilot.try', { shopId, book: 'live', reset: true });
  assert.equal(reset.messages.length, 0);
  // Pilot AI off: no answer on anybody's key
  await savePilotConfig(t, { enabled: false, maxUsd: 0.15, share: 0.2 });
  await assert.rejects(p('p.pilot.try', { shopId, book: 'live', body: 'salam' }), /Pilot AI est éteint/);
  assert.equal((await p('p.pilot.try', { shopId, book: 'live' })).messages.length, 0, 'the customer message of a failed try is not kept');
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 });
  // a shop that does not exist, and the preview (no server)
  await assert.rejects(p('p.pilot.try', { shopId: 999, book: 'live', body: 'salam' }), /introuvable/);
  await assert.rejects(p('p.pilot.try', { shopId, book: 'live', body: 'salam' }, { ...pctx, shop: undefined }), /serveur/);
});

test('the lessons chat: one lesson in the book’s form, a failed check gets one more try told why, a copy is shown, nothing saved', async () => {
  const asks: any[] = [];
  const script: string[] = [];
  const ai: PCtx['ai'] = async (req) => {
    asks.push(req);
    return { content: [{ type: 'text', text: script.shift() ?? '{}' }] };
  };
  const as: PCtx = { ...pctx, ai };
  const before = (await t.platform.query(`SELECT count(*)::int AS n FROM platform.pilot_lessons`))[0].n;

  // the first lesson has a figure: the second try is told why and passes
  script.push(
    '```json\n{"reply": "Compris : rassurer le client sur le paiement.", "lesson": {"topic": "trust", "text": "When the customer fears a scam, say payment happens in 2 steps at the door.", "meaning": "x"}}\n```',
    '{"reply": "ok", "lesson": {"topic": "trust", "text": "When the customer fears a scam, explain calmly that payment happens only when the parcel is in their hands.", "meaning": "Quand le client a peur d’une arnaque, expliquer calmement qu’il paie seulement quand il a le colis."}}',
  );
  const r = await p('p.pilot.teach', { lang: 'fr', messages: [{ from: 'pilot', text: 'Bonjour !' }, { from: 'coach', text: 'les clients ont peur' }, { from: 'coach', text: 'des arnaques' }] }, as);
  assert.equal(r.reply, 'Compris : rassurer le client sur le paiement.', 'the first answer is what the coach reads');
  assert.equal(r.lesson.ok, true);
  assert.equal(r.lesson.topic, 'trust');
  assert.match(r.lesson.text, /only when the parcel is in their hands/);
  assert.match(r.lesson.meaning, /arnaque/);
  assert.equal(asks.length, 2);
  assert.equal(asks[0].model, pilot.TEACH_MODEL);
  assert.deepEqual(asks[0].messages, [{ role: 'user', content: 'les clients ont peur\n\ndes arnaques' }], 'turns start with the coach and alternate');
  assert.match(asks[0].system, /in French/);
  assert.match(asks[0].system, /send the real photos from the product tool/, 'the lessons already there are shown, so none is proposed twice');
  assert.match(asks[1].messages[asks[1].messages.length - 1].content, /a digit/, 'the second try is told what failed');

  // a copy of a lesson already there: shown, the coach decides
  script.push('{"reply": "ok", "lesson": {"topic": "product", "text": "When the customer asks for photos, send the real photos from the product tool and ask which color they love.", "meaning": "photos"}}');
  const dup = await p('p.pilot.teach', { lang: 'en', messages: [{ from: 'coach', text: 'photos' }] }, as);
  assert.ok(dup.lesson.twin, 'the lesson that is already there');
  assert.match(asks[asks.length - 1].system, /in English/);

  // still failing after the second try: shown with its problems
  script.push('{"reply": "a", "lesson": {"topic": "price", "text": "Give a discount to close."}}', '{"reply": "b", "lesson": {"topic": "price", "text": "Offer a free gift to close the order fast."}}');
  const still = await p('p.pilot.teach', { lang: 'ar', messages: [{ from: 'coach', text: 'remise' }] }, as);
  assert.equal(still.lesson.ok, false);
  assert.ok(still.lesson.problems.includes('discount'));

  // not JSON: the text is the answer, no lesson; a question: no lesson
  script.push('Je n’ai pas compris : pouvez-vous donner un exemple ?');
  assert.deepEqual(await p('p.pilot.teach', { messages: [{ from: 'coach', text: '?' }] }, as), { reply: 'Je n’ai pas compris : pouvez-vous donner un exemple ?', lesson: null });
  script.push('{"reply": "Bonjour ! Dites-moi ce que Dellal doit faire.", "lesson": null}');
  assert.equal((await p('p.pilot.teach', { messages: [{ from: 'coach', text: 'salut' }] }, as)).lesson, null);

  assert.equal((await t.platform.query(`SELECT count(*)::int AS n FROM platform.pilot_lessons`))[0].n, before, 'nothing saved before « Add »');
  await assert.rejects(p('p.pilot.teach', { messages: [{ from: 'coach', text: 'x' }] }), /serveur/, 'the preview: no Pilot AI');
});

test('Pilot AI’s own cost (the test chat, the lessons chat): counted apart, in no shop’s bill', async () => {
  const at = new Date(NOW);
  const u = { input_tokens: 50_000, output_tokens: 2_000 };
  await recordAiUsage(t, { shopId, feature: 'dellal', model: 'claude-haiku-5-5', payer: 'pilotix', usage: u, at });
  await recordAiUsage(t, { shopId, feature: 'pilot', model: 'claude-haiku-5-5', payer: 'pilotix', usage: u, at });
  await recordAiUsage(t, { shopId: 0, feature: 'pilot', model: 'claude-sonnet-5-5', payer: 'pilotix', usage: u, at });
  await recordAiUsage(t, { shopId: 0, feature: 'dellal', model: 'claude-haiku-5-5', payer: 'pilotix', usage: u, at });
  const rows = await aiUsageOfMonth(t, '2026-11');
  assert.deepEqual(
    rows.map((r) => [r.shopId, r.feature]),
    [[shopId, 'dellal']],
    'only the shop’s own Dellal is billed (shop 0 is only for Pilot AI’s own work)',
  );
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
  const lab = await aiLabOfMonth(t, '2026-11');
  assert.equal(lab.calls, 2);
  close(lab.usd, aiCostUsd('claude-haiku-5-5', u) + aiCostUsd('claude-sonnet-5-5', u));
  const costs = await p('p.ai.costs', { month: '2026-11' });
  close(costs.labUsd, lab.usd);
  close(costs.total.usd, aiCostUsd('claude-haiku-5-5', u));
});
