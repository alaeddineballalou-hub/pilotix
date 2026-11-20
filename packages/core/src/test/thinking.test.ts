// No thinking before the answer, on every call to Claude (20 Nov 2026): Claude 5.5 thinks first by default and its thinking
// counts in max_tokens, so Pilotix's answers sized for the answer alone (Dellal 1024 tokens, a landing page title 500, the
// night lessons 200) could come back empty or cut in half. Each model gets the setting it accepts (Sonnet 5.5
// « between_tools », Haiku 5.5 « disabled »; Opus 5.5 always thinks: more room), on the three ways Pilotix asks Claude.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { login, migrate, migrateAll, pgliteTenancy, seedBase } from '../index';
import { noThinkingFirst, pilotBatch, pilotComplete, runDellal } from '../dellal-server';
import { savePilotConfig } from '../platform/pilotai';
import { loadShop } from '../platform/shops';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const KEY = 'sk-ant-api03-pilotix-key-0123456789';

test('each model gets the setting it accepts; a call that chose its own keeps it', () => {
  const r = (model: string, max_tokens = 1024, extra: Record<string, unknown> = {}) => noThinkingFirst({ model, max_tokens, ...extra }) as any;
  assert.deepEqual(r('claude-sonnet-5-5').thinking, { type: 'between_tools' });
  assert.deepEqual(r('claude-sonnet-5-5-20261001').thinking, { type: 'between_tools' });
  assert.deepEqual(r('claude-haiku-5-5').thinking, { type: 'disabled' });
  assert.equal(r('claude-haiku-5-5', 200).max_tokens, 200, 'the room stays as it was');
  // Opus 5.5 always thinks (« between_tools » and « disabled » are refused): 4 × the room, at least 4,000 tokens more
  assert.equal(r('claude-opus-5-5').thinking, undefined);
  assert.equal(r('claude-opus-5-5', 1024).max_tokens, 5024);
  assert.equal(r('claude-opus-5-5', 5).max_tokens, 4005);
  assert.equal(r('claude-opus-5-5', 16_000).max_tokens, 64_000);
  assert.deepEqual(r('claude-sonnet-5-5', 4000, { thinking: { type: 'adaptive' } }).thinking, { type: 'adaptive' });
  const other = { model: 'claude-sonnet-4-6', max_tokens: 300 };
  assert.equal(noThinkingFirst(other), other, 'a model that does not think first by default: sent as it was');
});

/** Every request Pilotix sends to Anthropic, answered as Anthropic would. */
function fakeAnthropic(results: string[] = []) {
  const sent: { url: string; body: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    sent.push({ url: u, body });
    const json = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.endsWith('/messages/batches')) return json({ id: 'b1', processing_status: 'ended', results_url: 'https://api.anthropic.com/v1/messages/batches/b1/results' });
    if (u.endsWith('/results')) return new Response(results.map((text, i) => JSON.stringify({ custom_id: `r${i}`, result: { type: 'succeeded', message: { content: [{ type: 'text', text }] } } })).join('\n'));
    return json({ model: body?.model, content: [{ type: 'text', text: 'Salam' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } });
  }) as any;
  return { sent, restore: () => (globalThis.fetch = real) };
}

test('every call to Claude goes without thinking first: Dellal (with its tools), the control room, the night batch', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const shop = (await loadShop(t, { primary: true }))!;
  const db = t.shop('public');
  const ctx = { db, t, shop: { id: shop.id } as any, session: await login(db, OWNER.email, OWNER.password), now: () => Date.now(), emit: () => {} };
  const tools = [{ name: 'create_order', description: 'x', input_schema: { type: 'object', properties: {} } }];
  const msg = [{ role: 'user', content: 'salam' }];
  const fake = fakeAnthropic(['{"a":1}', '{"b":2}']);
  try {
    await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 }, KEY);
    // Dellal: Sonnet for a hard moment, Haiku for a simple one, Opus if the shop chose it
    await runDellal('complete', { model: 'claude-sonnet-5-5', system: 'x', messages: msg, tools, max_tokens: 1024, feature: 'dellal' }, ctx as any);
    await runDellal('complete', { model: 'claude-haiku-5-5', system: 'x', messages: msg, tools, max_tokens: 1024, feature: 'dellal' }, ctx as any);
    await runDellal('complete', { model: 'claude-opus-5-5', system: 'x', messages: msg, tools, max_tokens: 1024, feature: 'dellal' }, ctx as any);
    const [sonnet, haiku, opus] = fake.sent.map((s) => s.body);
    assert.deepEqual(sonnet.thinking, { type: 'between_tools' });
    assert.equal(sonnet.max_tokens, 1024);
    assert.equal(sonnet.tools.length, 1, 'its tools still go');
    assert.deepEqual(haiku.thinking, { type: 'disabled' });
    assert.equal(opus.thinking, undefined);
    assert.equal(opus.max_tokens, 5024);
    // the key test (« Tester »): 5 tokens, Haiku without thinking
    await runDellal('ping', {}, ctx as any);
    assert.deepEqual(fake.sent[3].body.thinking, { type: 'disabled' });
    assert.equal(fake.sent[3].body.max_tokens, 5);

    // the control room (Pilot AI's lessons chat, its exams)
    const r = await pilotComplete(t, { model: 'claude-sonnet-5-5', system: 'x', messages: [{ role: 'user', content: 'salam' }], max_tokens: 700 });
    assert.equal(r.content[0].type, 'text');
    assert.deepEqual(fake.sent[4].body.thinking, { type: 'between_tools' });

    // the night batch: each request gets its model's setting, the answers come back in order
    const out = await pilotBatch(KEY, { everyMs: 1 })([
      { model: 'claude-haiku-5-5', system: 'x', user: 'a', maxTokens: 200 },
      { model: 'claude-sonnet-5-5', system: 'x', user: 'b', maxTokens: 600 },
    ]);
    assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
    const batch = fake.sent.find((s) => s.url.endsWith('/messages/batches'))!.body.requests;
    assert.deepEqual(batch[0].params.thinking, { type: 'disabled' });
    assert.equal(batch[0].params.max_tokens, 200);
    assert.deepEqual(batch[1].params.thinking, { type: 'between_tools' });
  } finally {
    fake.restore();
  }
});
