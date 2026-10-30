// What each shop's AI costs Pilotix: every answer Claude gives on the server is counted per shop, day (Algeria),
// feature (Dellal, CM AI agent, AI Spy) and payer (Pilotix's key or the shop's own); the control room shows the month per
// shop in USD and in DA at the owner's rate, to bill it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, staffLogin } from '../index';
import { runDellal } from '../dellal-server';
import { aiCostUsd, aiPrice, aiUsageOfMonth, monthOf, recordAiUsage } from '../platform/aiusage';
import { pilotCoachDigest, savePilotConfig } from '../platform/pilotai';
import { setRaw } from '../modules/admin';
import { DELLAL_SECRETS } from '../modules/dellal';
import { loadShop } from '../platform/shops';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };

async function server() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const t = pgliteTenancy(pg as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = <T = any>(name: string, input: unknown = {}, as: PCtx = pctx) => platformCall(name, as, input) as Promise<T>;
  return { t, staff, pctx, p };
}

test('the price of one answer: Haiku, Haiku over 100,000 tokens, Sonnet with its cache, an unknown model never free', () => {
  // Haiku 5.5: 0.10 $ in, 0.50 $ out per million (a prompt up to 100,000 tokens)
  assert.equal(aiCostUsd('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 1_000_000 }).toFixed(4), '0.5100');
  // over 100,000 tokens in one prompt (cache included): 5 × dearer
  assert.equal(aiPrice('claude-haiku-5-5', 100_001).in, 0.5);
  assert.equal(aiCostUsd('claude-haiku-5-5', { input_tokens: 50_000, cache_read_input_tokens: 60_000 }).toFixed(6), (50_000 * 0.5e-6 + 60_000 * 0.05e-6).toFixed(6));
  // Sonnet 5.5: 2 $ in, 10 $ out, cache write 2.50 $, cache read 0.10 $
  const u = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 4000, cache_read_input_tokens: 10_000 };
  assert.equal(aiCostUsd('claude-sonnet-5-5', u).toFixed(6), ((1000 * 2 + 200 * 10 + 4000 * 2.5 + 10_000 * 0.1) / 1e6).toFixed(6));
  // a dated name keeps its family's price; an unknown one is counted as Sonnet (never 0)
  assert.equal(aiPrice('claude-haiku-5-5-20261001').in, 0.1);
  assert.equal(aiPrice('claude-opus-5-5').out, 20);
  assert.equal(aiPrice('some-new-model').in, 2);
  assert.equal(aiCostUsd('claude-sonnet-5-5', null), 0);
});

test('counted per shop, day (Algeria), feature and payer; the month follows Algeria’s clock', async () => {
  const { t } = await server();
  const s1 = (await loadShop(t, { primary: true }))!;
  const u = { input_tokens: 1000, output_tokens: 100 };
  await recordAiUsage(t, { shopId: s1.id, feature: 'dellal', model: 'claude-haiku-5-5', payer: 'pilotix', usage: u, at: new Date('2026-10-10T10:00:00Z') });
  await recordAiUsage(t, { shopId: s1.id, feature: 'dellal', model: 'claude-haiku-5-5', payer: 'pilotix', usage: u, at: new Date('2026-10-10T12:00:00Z') });
  await recordAiUsage(t, { shopId: s1.id, feature: 'cm', model: 'claude-sonnet-5-5', payer: 'pilotix', usage: u, at: new Date('2026-10-11T09:00:00Z') });
  await recordAiUsage(t, { shopId: s1.id, feature: 'spy', model: 'claude-sonnet-5-5', payer: 'shop', usage: u, at: new Date('2026-10-12T09:00:00Z') });
  // 23:30 UTC on 31 October is already 1 November in Algeria
  await recordAiUsage(t, { shopId: s1.id, feature: 'dellal', model: 'claude-haiku-5-5', payer: 'pilotix', usage: u, at: new Date('2026-10-31T23:30:00Z') });
  // a name we do not know is « other »; a shop id that cannot be is ignored; nothing throws
  await recordAiUsage(t, { shopId: s1.id, feature: 'weird', model: 'claude-haiku-5-5', payer: 'pilotix', usage: u, at: new Date('2026-10-13T09:00:00Z') });
  await recordAiUsage(t, { shopId: 0, feature: 'dellal', model: 'claude-haiku-5-5', payer: 'pilotix', usage: u });

  const rows = await t.platform.query('SELECT * FROM platform.ai_usage ORDER BY day, feature');
  assert.equal(rows.length, 5, 'the two Dellal answers of 10 October share one row');
  const oct10 = rows.find((r: any) => r.feature === 'dellal' && String(r.calls) === '2')!;
  assert.equal(Number(oct10.input_tokens), 2000);
  const oct = await aiUsageOfMonth(t, '2026-10');
  const dellal = oct.find((r) => r.feature === 'dellal')!;
  assert.equal(dellal.calls, 2, 'the answer at 00:30 Algeria time on 1 November is November’s');
  assert.ok(oct.some((r) => r.feature === 'other'));
  assert.equal((await aiUsageOfMonth(t, '2026-11'))[0].calls, 1);
  assert.equal(monthOf(new Date('2026-10-31T23:30:00Z')), '2026-11');
  await assert.rejects(aiUsageOfMonth(t, '2026-13'));
});

test('control room: each shop’s month in USD and DA (owner’s rate), its own key apart, the night learning, managers only', async () => {
  const { t, p, pctx } = await server();
  const s1 = (await loadShop(t, { primary: true }))!;
  const plan = (await p<any[]>('p.plans.list'))[0];
  const made = await p('p.shops.create', { name: 'Cosmo', ownerName: 'Lina', ownerEmail: 'lina@cosmo.dz', planId: plan.id, trialDays: 14 });
  const month = monthOf();
  const at = new Date();
  const haiku = { input_tokens: 100_000, output_tokens: 780_000 }; // 0.01 + 0.39 = 0.40 $
  const sonnet = { input_tokens: 100_000, output_tokens: 10_000 }; // 0.20 + 0.10 = 0.30 $
  await recordAiUsage(t, { shopId: s1.id, feature: 'dellal', model: 'claude-haiku-5-5', payer: 'pilotix', usage: haiku, at });
  await recordAiUsage(t, { shopId: s1.id, feature: 'cm', model: 'claude-sonnet-5-5', payer: 'pilotix', usage: sonnet, at });
  await recordAiUsage(t, { shopId: s1.id, feature: 'spy', model: 'claude-sonnet-5-5', payer: 'shop', usage: sonnet, at });
  await recordAiUsage(t, { shopId: made.id, feature: 'spy', model: 'claude-sonnet-5-5', payer: 'pilotix', usage: sonnet, at });
  await t.platform.query(`INSERT INTO platform.pilot_nights (at, night, spend_usd, cap_usd) VALUES (now(), ($1 || '-02')::date, 0.12, 0.15)`, [month]);

  let r = await p('p.ai.costs', {});
  assert.equal(r.month, month);
  assert.equal(r.rate, 0);
  assert.equal(r.shops.length, 2);
  const a = r.shops[0];
  assert.equal(a.id, s1.id, 'the dearest shop first');
  assert.equal(a.dellal.calls, 1);
  assert.equal(a.dellal.usd.toFixed(2), '0.40');
  assert.equal(a.cm.usd.toFixed(2), '0.30');
  assert.equal(a.spy.calls, 0, 'what the shop paid with its own key is not billed');
  assert.equal(a.pilotixUsd.toFixed(2), '0.70');
  assert.equal(a.shopUsd.toFixed(2), '0.30');
  assert.equal(a.da, null, 'no rate yet: USD only');
  assert.equal(r.shops[1].name, 'Cosmo');
  assert.equal(r.total.usd.toFixed(2), '1.00');
  assert.equal(r.nightUsd.toFixed(2), '0.12');
  assert.ok(r.since);

  await p('p.ai.rate', { rate: 250 });
  r = await p('p.ai.costs', { month });
  assert.equal(r.rate, 250);
  assert.equal(r.shops[0].da, 175);
  assert.equal(r.total.da, 250);
  assert.equal((await p('p.ai.costs', { month: '2020-01' })).shops.length, 0);
  // support staff cannot see the bill nor change the rate
  const support = { ...pctx, staff: { ...pctx.staff, role: 'support' as const } };
  await assert.rejects(p('p.ai.costs', {}, support));
  await assert.rejects(p('p.ai.rate', { rate: 1 }, support));
});

test('the server’s AI call counts each answer for its shop, under its agent, paid by Pilotix’s key or the shop’s own', async () => {
  const { t } = await server();
  const s1 = (await loadShop(t, { primary: true }))!;
  const db = t.shop('public');
  const ctx = { db, t, shop: { id: s1.id } as any, session: await login(db, OWNER.email, OWNER.password), now: () => Date.now(), emit: () => {} };
  const real = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = (async (_url: any, init: any) => {
    sent.push({ key: init.headers['x-api-key'], body: JSON.parse(init.body) });
    const usage = { input_tokens: 1200, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 };
    return new Response(JSON.stringify({ model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Salam' }], stop_reason: 'end_turn', usage }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as any;
  try {
    await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 }, 'sk-ant-api03-pilotix-key-0123456789');
    const req = { model: 'claude-haiku-5-5', system: 'x', messages: [{ role: 'user', content: 'salam' }], tools: [], max_tokens: 100 };
    await runDellal('complete', { ...req, feature: 'cm' }, ctx as any);
    assert.equal(sent[0].key, 'sk-ant-api03-pilotix-key-0123456789');
    assert.equal(sent[0].body.feature, undefined, 'the agent’s name is not sent to Anthropic');
    // today's limit reached: a new job gets no Pilotix key (and the shop has none: refused); a job that started keeps it
    await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2, dayUsd: 0.0001 });
    await assert.rejects(runDellal('complete', { ...req, feature: 'cm' }, ctx as any), /Clé API/);
    await runDellal('complete', { ...req, feature: 'cm', pilot: true }, ctx as any);
    assert.equal(sent[1].key, 'sk-ant-api03-pilotix-key-0123456789');
    assert.equal(sent[1].body.pilot, undefined, 'not sent to Anthropic');
    // Pilot AI without its key: the shop's own key answers, counted as paid by the shop
    await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 }, null);
    await setRaw(db, DELLAL_SECRETS.ai, 'sk-ant-api03-shop-own-key-0123456789');
    await runDellal('complete', { ...req, feature: 'dellal' }, ctx as any);
    assert.equal(sent[2].key, 'sk-ant-api03-shop-own-key-0123456789');
    // no agent name: « other »
    await runDellal('complete', req, ctx as any);
  } finally {
    globalThis.fetch = real;
  }
  const rows = await t.platform.query(`SELECT feature, payer, calls, input_tokens, cache_read, usd FROM platform.ai_usage WHERE shop_id = $1`, [s1.id]);
  const cm = rows.find((r: any) => r.feature === 'cm' && r.payer === 'pilotix')!;
  assert.equal(Number(cm.calls), 2);
  assert.ok(rows.some((r: any) => r.feature === 'dellal' && r.payer === 'shop'), 'the shop’s own key: paid by the shop');
  assert.ok(rows.some((r: any) => r.feature === 'other' && r.payer === 'shop'));
  assert.equal(Number(cm.input_tokens), 2400);
  assert.equal(Number(cm.cache_read), 6000);
  assert.equal(Number(cm.usd).toFixed(6), (2 * aiCostUsd('claude-haiku-5-5', { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 3000 })).toFixed(6));
});

test('control room: today’s spend against the daily limit, the lessons waiting in the menu, the coach’s morning note', async () => {
  const { t, p } = await server();
  const s1 = (await loadShop(t, { primary: true }))!;
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2, dayUsd: 1 }, 'sk-ant-api03-pilotix-key-0123456789');
  await recordAiUsage(t, { shopId: s1.id, feature: 'dellal', model: 'claude-sonnet-5-5', payer: 'pilotix', usage: { input_tokens: 200_000 } }); // 0.40 $
  let st = await p('p.pilot.state', {});
  assert.equal(st.config.dayUsd, 1);
  assert.equal(st.today.usd.toFixed(2), '0.40');
  assert.equal(st.today.rest, false);
  await recordAiUsage(t, { shopId: s1.id, feature: 'cm', model: 'claude-sonnet-5-5', payer: 'pilotix', usage: { input_tokens: 400_000 } }); // +0.80 $
  st = await p('p.pilot.state', {});
  assert.equal(st.today.rest, true, 'over the limit: resting');
  // the limit is saved with the other settings (managers), and kept when not sent
  await p('p.pilot.save', { enabled: true, maxUsd: 0.15, share: 0.2, dayUsd: 4 });
  assert.equal((await p('p.pilot.state', {})).today.rest, false);
  await p('p.pilot.save', { enabled: true, maxUsd: 0.15, share: 0.2 });
  assert.equal((await p('p.pilot.state', {})).config.dayUsd, 4);

  // lessons waiting: the menu's number and the coach's note (tonight's new ones apart, the first five)
  const since = new Date(Date.now() - 60_000);
  await t.platform.query(`INSERT INTO platform.pilot_lessons (topic, text, status, prio, fp, created_at) VALUES ('price', 'Donner le total avec la livraison dès la première réponse.', 'candidate', 2, 'fp1', now() - interval '2 days')`);
  await t.platform.query(`INSERT INTO platform.pilot_lessons (topic, text, status, prio, fp) VALUES ('trust', 'Rappeler qu’on paie à la livraison.', 'candidate', 1, 'fp2')`);
  await t.platform.query(`INSERT INTO platform.pilot_lessons (topic, text, status, prio, fp) VALUES ('fee', 'Déjà approuvée.', 'approved', 1, 'fp3')`);
  assert.equal((await p('p.dashboard', {})).pilot, 2);
  const d = await pilotCoachDigest(t, since);
  assert.equal(d.waiting, 2);
  assert.equal(d.fresh, 1, 'one came tonight');
  assert.equal(d.lessons[0].topic, 'price', 'the most important first');
  assert.equal((await pilotCoachDigest(t)).fresh, 0);
});
