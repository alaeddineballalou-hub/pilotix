// Control room › Pilot AI › Les 3 IA: Claude, Gemini and OpenAI in one place — each one's key (kept sealed, never sent
// back; Google's new « AQ. » keys accepted) and what each cost, Pilotix's part apart from what shops pay with their own keys.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, staffLogin } from '../index';
import { aiProviderSpend, recordAiUsage } from '../platform/aiusage';
import { GOOGLE_KEY_RE, OPENAI_KEY_RE, openaiKey } from '../platform/pilotai';
import { isOpenaiModel } from '../modules/studio';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };

test('the 3 AIs: keys in one place, and what each one cost', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const ctx: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}) => platformCall(name, ctx, input) as Promise<any>;

  let r = await p('p.ai.providers');
  assert.deepEqual(r.keys, { claude: { hasKey: false, on: false }, gemini: { hasKey: false, on: true }, openai: { hasKey: false, on: true } });

  // OpenAI: a wrong key is refused, a right one saved (sealed like the other keys) and never sent back
  await assert.rejects(p('p.ai.openaiKey', { key: 'not-a-key' }), /Clé OpenAI invalide/);
  assert.deepEqual(await p('p.ai.openaiKey', { key: 'sk-proj-abcdefghijklmnopqrstuvwxyz012345' }), { hasKey: true });
  assert.equal(await openaiKey(t), 'sk-proj-abcdefghijklmnopqrstuvwxyz012345');
  r = await p('p.ai.providers');
  assert.equal(r.keys.openai.hasKey, true);
  assert.ok(!JSON.stringify(r).includes('abcdefghijklmnop'));

  // Google: the new « AQ. » keys AI Studio gives now are accepted, as the old « AIza » ones
  assert.ok(GOOGLE_KEY_RE.test('AQ.Ab8RN6JiBTFh8iyYe_1FNvxAbCdEfGh'));
  assert.ok(GOOGLE_KEY_RE.test('AIzaSyD-0123456789abcdefghijklmnopqrs'));
  assert.ok(!GOOGLE_KEY_RE.test('AQ.short'));
  await p('p.pilot.voiceSave', { enabled: false, model: 'gemini-flash-latest', key: 'AQ.Ab8RN6JiBTFh8iyYe_1FNvxAbCdEfGh' });
  assert.equal((await p('p.ai.providers')).keys.gemini.hasKey, true);
  assert.ok(OPENAI_KEY_RE.test('sk-abcdefghijklmnopqrstuvwx') && !OPENAI_KEY_RE.test('AQ.Ab8RN6JiBTFh8iyYe_1FNvx'));

  // the money: each line goes to its company by its model's name; what shops pay with their own keys stays apart
  await recordAiUsage(t, { shopId: 1, feature: 'dellal', model: 'claude-haiku-5-5', payer: 'pilotix', usage: null, usd: 0.5 });
  await recordAiUsage(t, { shopId: 1, feature: 'cm', model: 'gemini:gemini-3.1-flash-image-preview', payer: 'pilotix', usage: null, usd: 0.07 });
  await recordAiUsage(t, { shopId: 1, feature: 'cm', model: 'openai:gpt-image-1', payer: 'pilotix', usage: null, usd: 0.25 });
  await recordAiUsage(t, { shopId: 2, feature: 'cm', model: 'openai:gpt-image-1', payer: 'shop', usage: null, usd: 0.25 });
  const s = await aiProviderSpend(t, 30);
  assert.equal(Math.round(s.providers.claude.today * 100), 50);
  assert.equal(Math.round(s.providers.gemini.month * 100), 7);
  assert.equal(Math.round(s.providers.openai.days30 * 100), 25, 'the shop’s own key is not Pilotix’s money');
  assert.equal(Math.round(s.providers.openai.shopsOwn30 * 100), 25);
  assert.equal(s.providers.openai.byDay[s.today] > 0, true);

  assert.ok(isOpenaiModel('gpt-image-1') && isOpenaiModel('dall-e-3') && !isOpenaiModel('gemini-3.1-flash-image-preview'));
  assert.deepEqual(await p('p.ai.openaiKey', { key: null }), { hasKey: false });
});
