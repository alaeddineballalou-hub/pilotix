// Pilot AI inside Dellal: Pilotix's key answers (the shop has none), the coach's lesson book sits in the shared cached
// block, Haiku answers simple messages and Sonnet the hard ones, the chat's book is recorded, and the share switch
// (turning it off forgets what Pilot AI kept of the shop's chats).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, ServerHooks } from '../index';
import { PILOT_PLATFORM_SQL } from '../modules/pilotlearn';
import { pilotConfig, pilotKey, savePilotConfig } from '../platform/pilotai';
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
  for (const s of PILOT_PLATFORM_SQL.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await db.query(s);
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
  assert.deepEqual(c, { enabled: true, maxUsd: 5, share: 0.5, hasKey: true }, 'limits are clamped, the key is only "there"');
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

test('share switch: admin only; turning it off deletes what Pilot AI kept of the shop', async () => {
  const ctx = await shopCtx(server([]));
  const conf = { ...(await as(EMAILS.conf, server([]))), t, shop: SHOP };
  await assert.rejects(call('dellal.pilot.save', conf, { share: true }), /Accès refusé/);
  const on: any = await call('dellal.pilot.save', ctx, { share: true });
  assert.deepEqual(on, { share: true, on: true, platform: true });
  await db.query(
    `INSERT INTO platform.pilot_cases (shop_id, conv_id, outcome, transcript) VALUES (1, 999001, 'delivered', 'customer: <name> ch7al ?')`,
  );
  const off: any = await call('dellal.pilot.save', ctx, { share: false });
  assert.equal(off.share, false);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM platform.pilot_cases WHERE shop_id = 1'))[0].n, 0);
  const g: any = await call('dellal.pilot.get', ctx, {});
  assert.equal(g.share, false);
});
