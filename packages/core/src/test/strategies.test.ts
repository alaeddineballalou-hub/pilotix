// Marketing › Stratégies: a product's type for the ads, and the video formats recommended for it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { CHECK_SETTINGS, CIRCLE_FIELDS, CIRCLE_FROM_SETTINGS, CIRCLE_RULE_TEXTS, CIRCLE_STEPS, CircleChecks, circleRules, circleValues } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { DEFAULT_CREDITS } from '../platform/credits';
import { recommend, StratFormat } from '../modules/strategies';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
before(async () => {
  ({ db, as } = await setup(20));
});

const lib: StratFormat[] = DEFAULT_CREDITS.strategies.map((x) => ({ key: x.key, name: x.name, desc: x.desc, kind: x.kind, style: x.style, credits: x.credits, trend: x.trend, types: x.types, stages: x.stages }));

test('the formats for each type: only recipes made for it, the most precise first, never an editing style', () => {
  const t2 = recommend(lib, 2).map((x) => x.key);
  assert.ok(t2.includes('comparaison') && t2.includes('details'));
  assert.ok(!t2.includes('livraison') && !t2.includes('tutoriel'));
  assert.ok(!t2.includes('ugly') && !t2.includes('propre'));
  // made for type 2 only, before the ones for every type
  assert.ok(t2.indexOf('comparaison') < t2.indexOf('offre'));
  const t3 = recommend(lib, 3).map((x) => x.key);
  assert.deepEqual(t3.slice(0, 3).sort(), ['coulisses', 'fidele', 'livraison']);
  assert.ok(!t3.includes('comparaison'));
  const t1 = recommend(lib, 1).map((x) => x.key);
  assert.ok(t1.includes('tutoriel') && t1.includes('microtrottoir') && !t1.includes('unboxing'));
});

test('with the funnel stage: only the formats made for it, the ones made for that stage only first', () => {
  const top3 = recommend(lib, 3, 'top').map((x) => x.key);
  assert.ok(!top3.includes('offre') && !top3.includes('livraison'));
  const bottom3 = recommend(lib, 3, 'bottom').map((x) => x.key);
  assert.ok(bottom3.includes('offre'));
  assert.deepEqual(lib.find((x) => x.key === bottom3[0])?.types, [3]);
  assert.ok(bottom3.includes('livraison') && bottom3.includes('captures') && !bottom3.includes('probleme'));
  const top1 = recommend(lib, 1, 'top').map((x) => x.key);
  assert.ok(top1.includes('microtrottoir') && top1.includes('demo') && !top1.includes('temoignage'));
  // every type and stage has at least one format
  for (const t of [1, 2, 3] as const) for (const st of ['top', 'middle', 'bottom'] as const) assert.ok(recommend(lib, t, st).length > 0, `${t}-${st}`);
});

test('a product gets its type; the marketer and the seller may, a confirmation agent may not', async () => {
  const mk = await as(EMAILS.marketer);
  const s: any = await call('strat.state', mk, {});
  assert.ok(s.products.length > 0);
  assert.ok(s.products.every((p: any) => p.type === null));
  assert.deepEqual(s.byType[2], recommend(lib, 2).map((x) => x.key));
  assert.deepEqual(s.byStage['3-bottom'], recommend(lib, 3, 'bottom').map((x) => x.key));
  const id = s.products[0].id;
  await call('strat.setType', mk, { id, type: 2 });
  const after: any = await call('strat.state', await as(EMAILS.vendeur), {});
  assert.equal(after.products.find((p: any) => p.id === id).type, 2);
  await call('strat.setType', await as(EMAILS.vendeur), { id, type: null });
  assert.equal(num((await db.query('SELECT product_type FROM products WHERE id = $1', [id]))[0].product_type), null);
  await assert.rejects(call('strat.setType', await as(EMAILS.conf), { id, type: 1 }));
  await assert.rejects(call('strat.setType', mk, { id, type: 4 as any }));
  await assert.rejects(call('strat.setType', mk, { id: 999999, type: 1 }), /introuvable/);
});

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

test('« Life ad circle »: its own settings, one changed, wrong values refused', async () => {
  const vendeur = await as(EMAILS.vendeur);
  const first = await call('strat.circle', vendeur, {});
  assert.deepEqual(first.steps, ['test', 'judge', 'scale', 'watch', 'again']);
  // the plan as written: tests start on Tuesday, the verdict is on Wednesday, a test is 3 videos and 1 image
  assert.equal(first.values.testDay, 2);
  assert.equal(first.values.judgeDay, 3);
  assert.equal(first.values.testVideos, 3);
  assert.equal(first.values.testImages, 1);
  assert.equal(first.values.testPerWeek, null);
  // the circle keeps only its own settings: the days of the week and what a test is made of
  assert.deepEqual(Object.keys(first.values).sort(), CIRCLE_FIELDS.map((f) => f.key).sort());

  const r = await call('strat.circleSet', vendeur, { key: 'testBuys', value: 60 });
  assert.equal(r.values.testBuys, 60);
  await call('strat.circleSet', vendeur, { key: 'testPerWeek', value: 6 });
  await call('strat.circleSet', vendeur, { key: 'againAlways', value: false });
  const again = await call('strat.circle', vendeur, {});
  assert.equal(again.values.testBuys, 60);
  assert.equal(again.values.testPerWeek, 6);
  assert.equal(again.values.againAlways, false);
  await call('strat.circleSet', vendeur, { key: 'againAlways', value: true });
  // everything else keeps its default
  assert.equal(again.values.testDays, 7);
  // a setting that may stay « not chosen » can be emptied again
  await call('strat.circleSet', vendeur, { key: 'testPerWeek', value: null });
  assert.equal((await call('strat.circle', vendeur, {})).values.testPerWeek, null);

  await assert.rejects(call('strat.circleSet', vendeur, { key: 'nope', value: 1 }), /inconnu/);
  await assert.rejects(call('strat.circleSet', vendeur, { key: 'testBuys', value: null }), /vide/);
  await assert.rejects(call('strat.circleSet', vendeur, { key: 'judgeDay', value: 9 }), /Jour/);
  await assert.rejects(call('strat.circleSet', vendeur, { key: 'testBuys', value: 2.5 }), /incorrecte/);
  await assert.rejects(call('strat.circleSet', vendeur, { key: 'testDays', value: 500 }), /entre/);
  await assert.rejects(call('strat.circleSet', vendeur, { key: 'againAlways', value: 1 }), /incorrecte/);
  // an agent has no business here
  await assert.rejects(call('strat.circle', await as(EMAILS.conf), {}));
});

test('« Life ad circle »: the numbers that judge an ad are Pilot Checks’, shown here and never kept twice', async () => {
  const vendeur = await as(EMAILS.vendeur);
  const admin = await as(EMAILS.admin);
  const checks = async () => (await call('strat.circle', vendeur, {})).checks;
  const c = await checks();
  // the starting rules: good at the bid limit, bad above 1.33, stop above 1.58; the brake, the stock, the edits, the ideas
  assert.deepEqual([c.good, c.bad, c.stop, c.brakeAt, c.stockStop, c.freezeEdits, c.ideasMin, c.budgetWait], [1, 1.33, 1.58, 1.33, 3, 2, 5, 10]);
  assert.deepEqual(Object.keys(c.set).sort(), [...CIRCLE_FROM_SETTINGS].sort());
  assert.deepEqual(
    CIRCLE_FROM_SETTINGS.map((k) => c.set[k]),
    CIRCLE_FROM_SETTINGS.map((k) => CHECK_SETTINGS.find((d) => d.key === k)!.def),
  );
  assert.deepEqual([c.set.judgeDays, c.set.proofPct, c.set.winOrders, c.set.testAds, c.set.awarenessBudget], [2, 5, 5, 4, null]);

  // the owner changes them in Pilot Checks: the circle follows, for the seller too
  await call('auto.checkSetting', admin, { key: 'winOrders', v: 8 });
  await call('auto.checkSetting', admin, { key: 'awarenessBudget', v: 12 });
  await call('auto.checkSave', admin, { id: 'D1', v: 1.4, s: 1.7, wait: 12 });
  await call('auto.checkSave', admin, { id: 'M3', v: 4 });
  const c2 = await checks();
  assert.deepEqual([c2.set.winOrders, c2.set.awarenessBudget, c2.good, c2.bad, c2.stop, c2.ideasMin, c2.budgetWait], [8, 12, 1, 1.4, 1.7, 4, 12]);
  // … and only the administrators change them: the circle has no setting of that name any more
  await assert.rejects(call('auto.checkSetting', vendeur, { key: 'winOrders', v: 3 }));
  for (const gone of ['judgeWin', 'judgeCut', 'judgeCutCost', 'judgeMoreDays', 'scaleGroups', 'scaleBudget', 'scaleKeepAds', 'scaleDay', 'watchGrow', 'watchBack', 'watchBrakeDays', 'againVideos', 'againWeeks', 'againMessages', 'testBidCap', 'winOrders'])
    await assert.rejects(call('strat.circleSet', vendeur, { key: gone, value: 3 }), /inconnu/, gone);
  // a value saved for a setting the circle no longer has stays in the row, unread
  const row = (await db.query<{ value: any }>(`SELECT value FROM settings WHERE key = 'ad_circle'`))[0].value;
  await db.query(`UPDATE settings SET value = $1 WHERE key = 'ad_circle'`, [JSON.stringify({ ...row, judgeWin: 9, watchGrow: 35 })]);
  const after = await call('strat.circle', vendeur, {});
  assert.equal(after.values.judgeWin, undefined);
  assert.equal(after.values.watchGrow, undefined);
  await call('strat.circleSet', vendeur, { key: 'testDays', value: 8 });
  assert.equal((await db.query<{ value: any }>(`SELECT value FROM settings WHERE key = 'ad_circle'`))[0].value.judgeWin, 9);
  await call('strat.circleSet', vendeur, { key: 'testDays', value: 7 });

  // Pilot Checks names the two days of the tests in its texts: it reads them from the circle
  assert.deepEqual((await call('auto.checks', admin, {})).days, { test: 2, judge: 3 });
  await call('strat.circleSet', vendeur, { key: 'testDay', value: 1 });
  await call('strat.circleSet', vendeur, { key: 'judgeDay', value: 4 });
  assert.deepEqual((await call('auto.checks', admin, {})).days, { test: 1, judge: 4 });
  await call('strat.circleSet', vendeur, { key: 'testDay', value: 2 });
  await call('strat.circleSet', vendeur, { key: 'judgeDay', value: 3 });

  // back to the starting rules for the tests below
  await call('auto.checkSetting', admin, { key: 'winOrders', v: null });
  await call('auto.checkSetting', admin, { key: 'awarenessBudget', v: null });
  await call('auto.checkReset', admin, { id: 'D1' });
  await call('auto.checkReset', admin, { id: 'M3' });
});

test('« Life ad circle »: a test holds one ad at least and never more than Pilot Checks allows', async () => {
  const vendeur = await as(EMAILS.vendeur);
  const admin = await as(EMAILS.admin);
  const ads = async () => { const v = (await call('strat.circle', vendeur, {})).values; return [v.testVideos, v.testImages]; };
  assert.deepEqual(await ads(), [3, 1]);
  // 4 ads at most (Pilot Checks): a 4th video is one too many, 2 videos and 2 images are fine
  await assert.rejects(call('strat.circleSet', vendeur, { key: 'testVideos', value: 4 }), /4 pubs au plus/);
  await assert.rejects(call('strat.circleSet', vendeur, { key: 'testImages', value: 2 }), /pubs au plus/);
  await call('strat.circleSet', vendeur, { key: 'testVideos', value: 2 });
  await call('strat.circleSet', vendeur, { key: 'testImages', value: 2 });
  assert.deepEqual(await ads(), [2, 2]);
  // the owner allows 6: now 4 videos fit
  await call('auto.checkSetting', admin, { key: 'testAds', v: 6 });
  await call('strat.circleSet', vendeur, { key: 'testVideos', value: 4 });
  assert.deepEqual(await ads(), [4, 2]);
  // he lowers it to 3: the circle is over. Nothing is changed for the shop; taking ads out is kept, adding is refused
  await call('auto.checkSetting', admin, { key: 'testAds', v: 3 });
  assert.deepEqual(await ads(), [4, 2]);
  await assert.rejects(call('strat.circleSet', vendeur, { key: 'testImages', value: 3 }), /3 pubs au plus/);
  await call('strat.circleSet', vendeur, { key: 'testVideos', value: 3 });
  assert.deepEqual(await ads(), [3, 2]);
  await call('strat.circleSet', vendeur, { key: 'testImages', value: 0 });
  // a test of videos only is a test; a test of nothing is not
  await assert.rejects(call('strat.circleSet', vendeur, { key: 'testVideos', value: 0 }), /au moins une pub/);
  assert.deepEqual(await ads(), [3, 0]);
  // back to the start
  await call('auto.checkSetting', admin, { key: 'testAds', v: null });
  await call('strat.circleSet', vendeur, { key: 'testImages', value: 1 });
  assert.deepEqual(await ads(), [3, 1]);
});

test('« Life ad circle »: each step tells its rules, and a rule follows the shop’s choices', () => {
  const v = circleValues({});
  const set = Object.fromEntries(CIRCLE_FROM_SETTINGS.map((k) => [k, CHECK_SETTINGS.find((d) => d.key === k)!.def])) as CircleChecks['set'];
  const c: CircleChecks = { set, good: 1, bad: 1.33, stop: 1.58, brakeAt: 1.33, stockStop: 3, freezeEdits: 2, ideasMin: 5, budgetWait: 10 };
  assert.deepEqual(circleRules('test', v, c), ['bidLimit', 'noMargin', 'launch', 'testCap', 'testBudget', 'handsOff', 'adId']);
  assert.deepEqual(circleRules('judge', v, c), ['verdict', 'winner', 'notWinner', 'undecided', 'pending', 'after']);
  assert.deepEqual(circleRules('scale', v, c), ['batch', 'keep', 'group', 'own', 'startBudget']);
  assert.deepEqual(circleRules('watch', v, c), ['lines', 'budgetWait', 'budgetUp', 'budgetDown', 'proof', 'stock', 'freeze', 'brake', 'noData']);
  assert.deepEqual(circleRules('again', v, c), ['round', 'videoDay', 'newIdea', 'copy', 'always', 'noRule']);
  // a test of videos only, or of images only, says so
  assert.ok(circleRules('test', { ...v, testImages: 0 }, c).includes('launchVideos'));
  assert.ok(circleRules('test', { ...v, testVideos: 0 }, c).includes('launchImages'));
  // 0 day before an ad is judged: the two rules that name the wait no longer do
  const now = { ...c, set: { ...set, judgeDays: 0 } };
  assert.ok(circleRules('test', v, now).includes('handsOffNow') && !circleRules('test', v, now).includes('handsOff'));
  assert.ok(circleRules('watch', v, now).includes('proofNow') && !circleRules('watch', v, now).includes('proof'));
  // a number of products per week, a budget for the awareness ads: the rule names them
  assert.ok(circleRules('again', { ...v, testPerWeek: 4 }, c).includes('roundN'));
  assert.ok(circleRules('again', v, { ...c, set: { ...set, awarenessBudget: 10 } }).includes('alwaysBudget'));
  // a rule about something the shop switched off is left out
  assert.deepEqual(circleRules('again', { ...v, againAlways: false }, c), ['round', 'videoDay', 'newIdea', 'copy', 'noRule']);
  // every text a rule can take is in the list the languages are checked against
  for (const st of CIRCLE_STEPS) for (const k of circleRules(st, v, c)) assert.ok(CIRCLE_RULE_TEXTS.includes(k), k);
  assert.equal(new Set(CIRCLE_RULE_TEXTS).size, CIRCLE_RULE_TEXTS.length);
});

test('« Life ad circle »: every rule and every setting has its words in French, English and Arabic', () => {
  const LOCALES = join(__dirname, '../../../../apps/web/src/locales');
  // what a rule's sentence may name: the circle's own settings and the numbers of Pilot Checks
  const OWN = ['testDay', 'judgeDay', 'againVideoDay', 'testVideos', 'testImages', 'testBuys', 'testDays', 'testPerWeek'];
  const FROM = [...CIRCLE_FROM_SETTINGS, 'good', 'bad', 'stop', 'brakeAt', 'stockStop', 'freezeEdits', 'ideasMin', 'budgetWait'];
  const named = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
  const texts = Object.fromEntries(['fr', 'en', 'ar'].map((lang) => [lang, JSON.parse(readFileSync(join(LOCALES, lang, 'strat.json'), 'utf8')).circle]));
  const has = (o: any, k: string) => typeof o?.[k] === 'string' && o[k].trim() !== '';
  for (const lang of ['fr', 'en', 'ar']) {
    const t = texts[lang];
    assert.deepEqual(Object.keys(t.r).sort(), [...CIRCLE_RULE_TEXTS].sort(), `${lang}: the rules`);
    for (const k of CIRCLE_RULE_TEXTS) {
      assert.ok(has(t.r, k), `${lang}: rule ${k}`);
      for (const name of named(t.r[k])) assert.ok(OWN.includes(name) || FROM.includes(name), `${lang}: rule ${k} names {{${name}}}`);
      // the three languages name the same values: a number is never left out of a translation
      assert.deepEqual(named(t.r[k]), named(texts.fr.r[k]), `${lang}: rule ${k} names the same values as the French one`);
    }
    // the settings the circle still has, and only them
    assert.deepEqual(Object.keys(t.f).sort(), CIRCLE_FIELDS.map((f) => f.key).sort(), `${lang}: the settings' names`);
    assert.deepEqual(Object.keys(t.h).sort(), CIRCLE_FIELDS.map((f) => f.key).sort(), `${lang}: the settings' helps`);
    for (const f of CIRCLE_FIELDS) assert.ok(has(t.f, f.key) && has(t.h, f.key), `${lang}: setting ${f.key}`);
    for (const st of CIRCLE_STEPS) assert.ok(has(t.step, st) && has(t.help, st), `${lang}: step ${st}`);
    for (let d = 0; d < 7; d++) assert.ok(has(t.day, String(d)) && has(t.dayIn, String(d)), `${lang}: day ${d}`);
    // a counted word has its plural forms (Arabic: all six), and a plain form
    for (const unit of ['videos', 'images', 'ads', 'days', 'hours', 'confirmed', 'times', 'edits', 'ideas', 'products'])
      for (const form of ['', '_one', '_other', ...(lang === 'ar' ? ['_zero', '_two', '_few', '_many'] : [])]) assert.ok(has(t.n, unit + form), `${lang}: n.${unit}${form}`);
    for (const unit of ['pct', 'perDay']) assert.ok(has(t.n, unit), `${lang}: n.${unit}`);
    for (const k of ['name', 'tag', 'open', 'close', 'whyTitle', 'why1', 'why2', 'why3', 'tap', 'ringLabel', 'mid1', 'mid2', 'choose', 'saved', 'note', 'rulesTitle', 'settingsTitle', 'noSettings', 'from', 'fromOther', 'fromLink', 'fromTip', 'warnAds', 'tooManyAds', 'noAds', 'badNumber'])
      assert.ok(has(t, k), `${lang}: ${k}`);
  }
  // the three sentences of Pilot Checks that name a day of the week take it from the circle
  for (const lang of ['fr', 'en', 'ar']) {
    const t = JSON.parse(readFileSync(join(LOCALES, lang, 'checks.json'), 'utf8'));
    assert.deepEqual(named(t.c.V10.do), ['testDay'], `${lang}: V10`);
    assert.deepEqual(named(t.set.k.testAds.help), ['testDay'], `${lang}: testAds`);
    assert.deepEqual(named(t.how.l[8]), ['judgeDay', 'testDay'], `${lang}: how`);
    assert.doesNotMatch(JSON.stringify(t), /mardi|mercredi|Tuesday|Wednesday|الثلاثاء|ثلاثاء|الأربعاء/, `${lang}: no day of the week written in Pilot Checks' own texts`);
  }
});
