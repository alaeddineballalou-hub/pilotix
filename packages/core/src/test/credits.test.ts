// AI credits (Espace créateur): the plan's credits each month, then the bought ones; a tool takes its credits and gives
// them back when the AI fails; a pack is bought with « J'ai payé » (months = 0) next to a subscription claim, and
// « Valider » adds the credits without touching the plan's period; the control room edits tools, strategies and packs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { call, Ctx, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, shopCtx, shopStatus, staffLogin, Tenancy } from '../index';
import { cleanCredits, creditKey, creditMonth, DEFAULT_CREDITS, loadShop, passwordFromLink } from '../platform';
import { readClipWords } from '../dellal-server';
import { demoLines, readLines } from '../modules/createur';

const OWNER = { email: 'owner@platform.dz', password: 'Owner-Password-1' };
const PW = 'Boutique-Password-1';
const SALIM = 'salim@shops.dz';
const PHOTO = `data:image/jpeg;base64,${Buffer.from('a tiny jpeg').toString('base64')}`;
const AUDIO = Buffer.from('OggS fake sound').toString('base64');

async function as(t: Tenancy, shopId: number, email: string, password: string, server?: ServerHooks): Promise<Ctx> {
  const s = (await loadShop(t, { id: shopId }))!;
  const db = t.shop(s.schema);
  return { db, session: await login(db, email, password), now: () => Date.now(), emit: () => {}, shop: shopCtx(s, shopStatus(s, Date.now(), 3)), t, server };
}

test('the settings are made safe (keys, numbers, units)', () => {
  const c = cleanCredits({
    defaultCredits: '50',
    planCredits: { 3: 300, x: 5, 4: -7 },
    tools: [
      { name: 'Sous-titres', credits: -2, unit: 'nope' },
      { key: 'BAD KEY', name: 'Sous-titres' },
    ],
    packs: [{ name: 'P', credits: 0, price: -1 }],
  });
  assert.equal(c.defaultCredits, 50);
  assert.deepEqual(c.planCredits, { 3: 300, 4: -1 });
  assert.equal(c.tools[0].credits, 0);
  assert.equal(c.tools[0].unit, 'post');
  assert.notEqual(c.tools[0].key, c.tools[1].key);
  assert.deepEqual([c.packs[0].credits, c.packs[0].price], [1, 0]);
  assert.equal(creditKey('Avant / Après', new Set(['avant-apres'])), 'avant-apres-2');
  assert.deepEqual(
    cleanCredits(null).tools.map((x) => x.key),
    DEFAULT_CREDITS.tools.map((x) => x.key),
  );
  assert.equal(creditMonth(Date.parse('2026-11-30T23:30:00Z')), '2026-12');
});

test('subtitle lines and post lines read from the AI', () => {
  const lines = readClipWords(
    { candidates: [{ content: { parts: [{ text: '```json\n{"segments":[{"start":0,"end":1.2,"text":" راك  تعبت "},{"start":0.5,"end":0.4,"text":"x"},{"start":"a","end":2,"text":"y"}]}\n```' }] } }] },
    3,
  );
  assert.deepEqual(lines, [
    { start: 0, end: 1.2, text: 'راك تعبت' },
    { start: 0.5, end: 0.7, text: 'x' },
  ]);
  assert.deepEqual(readLines('{"lines":["a","b","c"]}', 2), ['a', 'b']);
  assert.equal(readLines('nothing', 2), null);
  assert.equal(demoLines([{ hook: 'Tu cherches ?' }], 'Montre', 'fr')[0], 'Tu cherches ?\n✨ Montre');
});

test('credits: month first, then packs; refunds; buying a pack; the control room', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  const pctx: PCtx = { t, staff, now: () => Date.now() };
  const p = (name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<any>;

  const { id: planId } = await p('p.plans.save', { name: 'Mensuel', priceMonth: 3000, features: ['*'], maxUsers: 5, maxDrivers: 2, maxOrdersMonth: 1000, maxStores: 1, public: true, active: true });
  const made = await p('p.shops.create', { name: 'Salim Shop', ownerName: 'Salim', ownerEmail: SALIM, planId, trialDays: 14 });
  if (made.mail?.token) await passwordFromLink(t, made.mail.token, PW);
  await t.platform.query('UPDATE platform.accounts SET email_verified_at = now() WHERE email = $1', [SALIM]);

  // the control room: 5 credits a month on this plan, subtitles at 2 a minute, a new strategy added
  const got = await p('p.credits.get');
  assert.ok(got.plans.some((x: any) => x.id === planId));
  const cfg = { ...got.config, planCredits: { [planId]: 5 }, strategies: [...got.config.strategies, { name: 'Avant / Après', kind: 'recipe', style: 'clean', credits: 1, on: true }] };
  const saved = await p('p.credits.save', { config: cfg });
  assert.equal(saved.strategies.at(-1).key, 'avant-apres');

  let answer: any = { ok: true, segments: [{ start: 0, end: 1, text: 'سلام' }] };
  const server: ServerHooks = {
    courier: async () => ({}),
    meta: async () => ({}),
    hashPassword: async (x) => x,
    payAlert: async () => 'sent',
    dellal: async (action) => (action === 'clipWords' ? answer : { content: [{ type: 'text', text: '{"lines":["ok"]}' }], stop_reason: 'end' }),
  };
  const admin = await as(t, made.id, SALIM, PW, server);

  let st = await call('createur.state', admin, {});
  assert.equal(st.preview, false);
  assert.deepEqual([st.wallet!.allowance, st.wallet!.left], [5, 5]);
  assert.ok(st.strategies.some((x: { key: string }) => x.key === 'avant-apres'));
  assert.ok(!('prompt' in st.tools[0]));

  // 90 seconds = 2 minutes = 4 credits
  const w = await call('createur.words', admin, { audio: AUDIO, mime: 'audio/ogg', seconds: 90 });
  assert.equal(w.segments[0].text, 'سلام');
  assert.equal(w.credits, 4);
  st = await call('createur.state', admin, {});
  assert.equal(st.wallet!.left, 1);
  // not enough left
  await assert.rejects(call('createur.words', admin, { audio: AUDIO, mime: 'audio/ogg', seconds: 30 }), /Pas assez de crédits/);
  // the AI fails: the credit comes back
  answer = { ok: false, error: 'boom' };
  await p('p.credits.gift', { shopId: made.id, credits: 10, note: 'Bienvenue' });
  st = await call('createur.state', admin, {});
  assert.deepEqual([st.wallet!.bonus, st.wallet!.left], [10, 11]);
  await assert.rejects(call('createur.words', admin, { audio: AUDIO, mime: 'audio/ogg', seconds: 30 }), /n’a pas pu écouter/);
  st = await call('createur.state', admin, {});
  assert.equal(st.wallet!.left, 11);

  // a pack: next to a subscription claim (each kind waits on its own)
  await call('billing.claim', admin, { months: 1, method: 'ccp', photo: PHOTO });
  const b = await call('createur.buy', admin, { pack: 'medium', method: 'baridimob', reference: 'BM-1', photo: PHOTO });
  assert.deepEqual([b.credits, b.amount], [500, 2000]);
  await assert.rejects(call('createur.buy', admin, { pack: 'small', method: 'ccp', photo: PHOTO }), /attend déjà/);
  // the subscription's window does not show the pack
  assert.equal((await call('billing.claims', admin, {})).claims.length, 1);
  const list = await p('p.claims.list');
  const pack = list.find((c: any) => c.credits);
  assert.equal(pack.credits, 500);
  assert.equal(pack.months, 0);
  const before = (await loadShop(t, { id: made.id }))!;
  await p('p.claims.accept', { id: pack.id });
  const after = (await loadShop(t, { id: made.id }))!;
  assert.equal(String(after.paidUntil), String(before.paidUntil));
  st = await call('createur.state', admin, {});
  assert.equal(st.wallet!.bonus, 510);
  assert.equal(st.claim!.status, 'accepted');
  const shopCredits = await p('p.credits.shop', { shopId: made.id });
  assert.deepEqual(
    shopCredits.log.map((x: any) => x.kind),
    ['pack', 'refund', 'use', 'gift', 'use'],
  );

  // credits off: free and unlimited
  await p('p.credits.save', { config: { ...saved, on: false } });
  st = await call('createur.state', admin, {});
  assert.equal(st.wallet!.left, -1);
  assert.deepEqual(st.packs, []);
});
