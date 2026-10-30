// Pilot AI inside Dellal: Pilotix's key answers (the shop has none), the coach's lesson book sits in the shared cached
// block, Haiku answers simple messages and Sonnet the hard ones, the chat's book is recorded; which shops teach Dellal is
// chosen in the control room only (unticking one forgets what Pilot AI kept of its chats).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, PLATFORM_REGISTRY, ServerHooks } from '../index';
import { PILOT_PLATFORM_SQL } from '../modules/pilotlearn';
import { pilotConfig, pilotKey, pilotLiveKey, pilotToday, savePilotConfig, takePilotRestAlert } from '../platform/pilotai';
import { AI_USAGE_SQL, recordAiUsage } from '../platform/aiusage';
import type { Tenancy } from '../platform/tenancy';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string, server?: Ctx['server']) => Promise<Ctx>;
let t: Tenancy;
const SHOP = { id: 1, slug: 'boutique', primary: true, features: null, locked: false, demo: false, maxUsers: null, maxDrivers: null };

before(async () => {
  ({ db, as } = await setup(150));
  await db.query('CREATE SCHEMA IF NOT EXISTS platform');
  await db.query(`CREATE TABLE IF NOT EXISTS platform.settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
  await db.query(`CREATE TABLE IF NOT EXISTS platform.audit (id bigserial PRIMARY KEY, at timestamptz NOT NULL DEFAULT now(), staff_id integer, staff_name text, shop_id integer, action text NOT NULL, details jsonb NOT NULL DEFAULT '{}')`);
  for (const s of PILOT_PLATFORM_SQL.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await db.query(s);
  for (const s of AI_USAGE_SQL.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await db.query(s);
  t = { platform: db, shop: () => db, exec: async () => undefined };
});

/** The server as Dellal sees it: every AI request is kept, the AI answers with the script. */
function server(reqs: any[], answer = 'Wa 3alikoum salam, mar7ba bik 👋'): ServerHooks {
  return {
    courier: async () => ({}),
    meta: async () => ({}),
    hashPassword: async (p) => p,
    dellal: async (action, args) => {
      if (action !== 'complete') return { ok: true };
      reqs.push(args);
      return { content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    },
  };
}
const shopCtx = async (srv: ServerHooks): Promise<Ctx> => ({ ...(await as(EMAILS.admin, srv)), t, shop: SHOP });

test('the key: kept in its own row, never in what the screens read; Pilot AI is on only when enabled with a key', async () => {
  assert.equal(await pilotKey(t), null);
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 });
  assert.equal(await pilotKey(t), null, 'on without a key: nothing to answer with');
  await savePilotConfig(t, { enabled: true, maxUsd: 9, share: 0.9 }, 'sk-ant-api03-test-key-0123456789');
  const c = await pilotConfig(t);
  assert.deepEqual(c, { enabled: true, maxUsd: 5, share: 0.5, shops: [], dayUsd: 3, hasKey: true }, 'limits are clamped (3 $ a day by default), the key is only "there"');
  assert.ok(!JSON.stringify(c).includes('sk-ant'));
  assert.equal(await pilotKey(t), 'sk-ant-api03-test-key-0123456789');
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 });
  assert.equal(await pilotKey(t), 'sk-ant-api03-test-key-0123456789', 'undefined keeps the key');
});

test('Dellal with Pilot AI: no shop key needed, the book in the first cached block, Haiku or Sonnet, the book recorded', async () => {
  // a published book (what the coach approved), the current champion
  await db.query(
    `INSERT INTO platform.pilot_books (version, status, text, tokens, lesson_ids, by_user, promoted_at)
     VALUES (1, 'champion', 'LEARNED HABITS v1: give the total with delivery in the first price answer.', 20, '[]', 'coach', now())`,
  );
  const reqs: any[] = [];
  const ctx = await shopCtx(server(reqs));
  const g: any = await call('dellal.settings.get', ctx, {});
  assert.equal(g.has.ai, false, 'the shop has no key of its own');
  assert.equal(g.pilotAi, true, 'the settings say Pilotix provides the AI');

  const r: any = await call('dellal.receive', ctx, { channel: 'whatsapp', externalId: '213661777001', text: 'salam, mazal kayen ?', messageId: 'wamid.pilot1' });
  const out: any = await call('dellal.answer', ctx, { id: r.conversationId });
  assert.ok(out.reply && !out.demo, 'the AI answered (not the demo seller)');
  const req = reqs[0];
  assert.equal(req.model, 'claude-haiku-5-5', 'a simple question goes to Haiku');
  assert.equal(req.systemBlocks.length, 3);
  assert.match(req.systemBlocks[0], /MÉTHODE DE VENTE/);
  assert.match(req.systemBlocks[0], /DARIJA ALGÉRIENNE/);
  assert.match(req.systemBlocks[0], /LEARNED HABITS v1/, 'the lesson book is in the block every shop shares');
  assert.match(req.systemBlocks[1], /Catalogue/);
  assert.doesNotMatch(req.systemBlocks[0], /Catalogue|Date :/, 'nothing of the shop or the day in the shared block');
  assert.match(req.systemBlocks[2], /Date :/);
  assert.equal(req.system, req.systemBlocks.join('\n'));
  const c: any = await call('dellal.conversation', ctx, { id: r.conversationId });
  const agent = c.messages.filter((m: any) => m.role === 'agent').pop();
  assert.equal(agent.meta.model, 'claude-haiku-5-5');
  assert.equal(agent.meta.pilot.version, 1);
  assert.equal(agent.meta.pilot.arm, 'A');
  const ex = await db.query('SELECT * FROM platform.pilot_exposure WHERE conv_id = $1', [r.conversationId]);
  assert.equal(ex.length, 1, 'the chat is recorded so its sale is measured');

  // a price fight goes to Sonnet
  await call('dellal.receive', ctx, { channel: 'whatsapp', externalId: '213661777001', text: 'ghalia bezzaf, dernier prix ?', messageId: 'wamid.pilot2' });
  await call('dellal.answer', ctx, { id: r.conversationId });
  assert.equal(reqs[reqs.length - 1].model, 'claude-sonnet-5-5');
});

test('Pilot AI off: Dellal is back to the shop’s own key and model, no book, one block', async () => {
  await savePilotConfig(t, { enabled: false, maxUsd: 0.15, share: 0.2 });
  const reqs: any[] = [];
  const ctx = await shopCtx(server(reqs));
  const g: any = await call('dellal.settings.get', ctx, {});
  assert.equal(g.pilotAi, false);
  const r: any = await call('dellal.receive', ctx, { channel: 'whatsapp', externalId: '213661777002', text: 'salam', messageId: 'wamid.pilot3' });
  const out: any = await call('dellal.answer', ctx, { id: r.conversationId });
  assert.equal(out.demo, true, 'no key anywhere: the demo seller answers');
  assert.equal(reqs.length, 0);
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 });
});

test('which shops teach Dellal: the control room only (managers); unticking one deletes what Pilot AI kept of it', async () => {
  const run = (role: 'owner' | 'manager' | 'support', input: { shopId: number; share: boolean }) =>
    (PLATFORM_REGISTRY as any)['p.pilot.share'].run({ t, staff: { id: 1, name: 'Coach', email: 'c@pilotix.online', role }, now: () => Date.now() }, input);
  assert.deepEqual((PLATFORM_REGISTRY as any)['p.pilot.share'].roles, ['owner', 'manager'], 'support staff cannot choose');
  assert.deepEqual((await run('owner', { shopId: 1, share: true })).shops, [1]);
  assert.deepEqual((await run('manager', { shopId: 7, share: true })).shops, [1, 7]);
  assert.deepEqual((await pilotConfig(t)).shops, [1, 7]);
  await db.query(`INSERT INTO platform.pilot_cases (shop_id, conv_id, outcome, transcript) VALUES (7, 999001, 'delivered', 'C: <name> ch7al ?')`);
  const off = await run('owner', { shopId: 7, share: false });
  assert.deepEqual(off.shops, [1]);
  assert.equal(off.forgot.cases, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM platform.pilot_cases WHERE shop_id = 7'))[0].n, 0);
  // saving the other settings keeps the list
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 });
  assert.deepEqual((await pilotConfig(t)).shops, [1]);
  // shops have no Pilot AI action of their own
  await assert.rejects(call('dellal.pilot.save' as any, await shopCtx(server([])), { share: true }));
  const g: any = await call('dellal.settings.get', await shopCtx(server([])), {});
  assert.equal(g.platform, true, 'on the platform server the shop AI card is hidden');
});

test('the CM AI agent and AI Spy answer with Pilot AI’s key too: on Pilotix’s server no shop brings a key', async () => {
  const decision = JSON.stringify({ intent: 'question', hide: false, public_reply: 'Mar7ba bik ! Chouf l’inbox 📩', private_reply: 'Salam ! Waah kayen.', handoff: false, reason: 'Question' });
  const reqs: any[] = [];
  const on = await shopCtx(server(reqs, decision));
  const cm: any = await call('cm.settings.get', on, {});
  assert.equal(cm.meta.ai, true, 'the CM agent has an AI without a shop key');
  assert.equal(cm.meta.platform, true);
  const r: any = await call('cm.test', on, { body: 'kayen la taille 42 ?' });
  assert.equal(r.by, 'ai', 'Claude decided (Pilot AI’s key), not the demo rules');
  assert.equal(r.platform, true);
  assert.equal(reqs.length, 1);
  const spy: any = await call('spy.settings.get', on, {});
  assert.equal(spy.ai, true, 'AI Spy reads the ads with Pilot AI');
  assert.equal(spy.platform, true);

  // Pilot AI off and no shop key: the demo rules, and the screens say Pilotix has not turned the AI on (no key to add)
  await savePilotConfig(t, { enabled: false, maxUsd: 0.15, share: 0.2 });
  const off = await shopCtx(server(reqs, decision));
  assert.equal(((await call('cm.settings.get', off, {})) as any).meta.ai, false);
  assert.equal(((await call('cm.test', off, { body: 'kayen la taille 42 ?' })) as any).by, 'demo');
  assert.equal(reqs.length, 1, 'no AI request');
  assert.equal(((await call('spy.settings.get', off, {})) as any).ai, false);
  const d: any = await call('dellal.test', off, { body: 'salam' });
  assert.equal(d.demo, true);
  assert.equal(d.platform, true, 'the tester says Pilotix turns the AI on, not « add a key »');
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 });
});

test('the daily limit: reached, the AI rests until midnight as if Pilot AI were off; one e-mail a day; raised, it answers again', async () => {
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2, dayUsd: 1 });
  assert.equal((await pilotConfig(t)).dayUsd, 1);
  // 600,000 Sonnet input tokens = 1.20 $ paid by Pilotix today: over the 1 $ limit
  await recordAiUsage(t, { shopId: SHOP.id, feature: 'dellal', model: 'claude-sonnet-5-5', payer: 'pilotix', usage: { input_tokens: 600_000 } });
  // what a shop paid with its own key does not count
  await recordAiUsage(t, { shopId: SHOP.id, feature: 'dellal', model: 'claude-sonnet-5-5', payer: 'shop', usage: { input_tokens: 9_000_000 } });
  const today = await pilotToday(t);
  assert.equal(today.usd.toFixed(2), '1.20');
  assert.equal(today.rest, true);
  const reqs: any[] = [];
  const ctx = await shopCtx(server(reqs, JSON.stringify({ intent: 'question', hide: false, public_reply: 'Chouf l’inbox', private_reply: 'Salam', handoff: false, reason: 'x' })));
  assert.equal(((await call('dellal.settings.get', ctx, {})) as any).pilotAi, false, 'resting: as if Pilot AI were off');
  assert.equal(((await call('cm.test', ctx, { body: 'kayen la taille 42 ?' })) as any).by, 'demo');
  assert.equal(reqs.length, 0, 'no AI request while resting');
  assert.equal(await pilotLiveKey(t), null, 'no key for a new answer');
  assert.equal(await pilotKey(t), 'sk-ant-api03-test-key-0123456789', 'an answer already started keeps it (and the night learning has its own budget)');
  // the owner hears it once a day
  const hit = await takePilotRestAlert(t);
  assert.ok(hit && hit.dayUsd === 1 && hit.usd > 1);
  assert.equal(await takePilotRestAlert(t), null, 'not twice the same day');
  // raised: it answers again; 0 = no limit
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2, dayUsd: 5 });
  assert.equal(((await call('dellal.settings.get', ctx, {})) as any).pilotAi, true);
  assert.equal(await takePilotRestAlert(t), null);
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2, dayUsd: 0 });
  assert.equal((await pilotToday(t)).rest, false);
  // saving without the limit keeps it
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2, dayUsd: 2 });
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 });
  assert.equal((await pilotConfig(t)).dayUsd, 2);
  await db.query('DELETE FROM platform.ai_usage');
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2, dayUsd: 3 });
});

test('when Pilotix pays, the CM AI agent and AI Spy answer with Haiku, whatever model the shop chose', async () => {
  const decision = JSON.stringify({ intent: 'question', hide: false, public_reply: 'Mar7ba !', private_reply: 'Salam', handoff: false, reason: 'x' });
  const reqs: any[] = [];
  const ctx = await shopCtx(server(reqs, decision));
  assert.equal(((await call('dellal.settings.get', ctx, {})) as any).settings?.model ?? 'claude-sonnet-5-5', 'claude-sonnet-5-5');
  await call('cm.test', ctx, { body: 'kayen la taille 42 ?' });
  const cm = reqs.find((r) => r.feature === 'cm');
  assert.equal(cm.model, 'claude-haiku-5-5');
  assert.equal(cm.pilot, true, 'the job started on Pilotix’s key keeps it to its end');
  const product = (await db.query('SELECT id FROM products ORDER BY id LIMIT 1'))[0];
  await call('spy.keywords.suggest', ctx, { productId: Number(product.id) }).catch(() => null);
  const spy = reqs.find((r) => r.feature === 'spy');
  assert.ok(spy, 'AI Spy asked Claude');
  assert.equal(spy.model, 'claude-haiku-5-5');
});
