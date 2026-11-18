// Pilot Automations › Pilot Checks: the list is the owner's KPI list (83 checks, each in one first helper, with its
// « good », « bad » and « stop » or « urgent » lines), every check has its texts in French, English and Arabic, and the
// owner's changes are kept exactly: only what differs from the starting value, the lines in their order, a door only
// where one stands, « Revenir au départ », and one line in the change list per thing changed. The general settings
// (2 days before an ad is judged, how sure before a stop…) are kept the same way.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { CHECK_EVERY, CHECK_PARTS, CHECK_SETTING_GROUPS, CHECK_SETTINGS, CHECKS, checkLevels, checkLinesInOrder, checkRule, checkSetting } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { checkRules, checkSettings } from '../modules/pilotchecks';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
let admin: Ctx;
before(async () => {
  ({ db, as } = await setup(40));
  admin = await as(EMAILS.admin);
});

const count = <T,>(xs: readonly T[], f: (x: T) => boolean) => xs.filter(f).length;

test('the list: 83 checks, each once, in the parts and the helpers of the owner’s list', () => {
  assert.equal(CHECKS.length, 83);
  assert.equal(new Set(CHECKS.map((d) => d.id)).size, 83);
  // money, leads and parcels, offer, video, landing page, page trust, Meta, team
  assert.deepEqual(CHECK_PARTS.map((p) => count(CHECKS, (d) => d.part === p)), [7, 4, 19, 9, 9, 8, 11, 16]);
  assert.deepEqual([count(CHECKS, (d) => d.level === 'door'), count(CHECKS, (d) => d.level === 'bell'), count(CHECKS, (d) => d.level === 'doctor')], [14, 37, 32]);
  // how often Pilotix looks: 20 every day, 52 every week, 10 every month, 1 before launch
  assert.deepEqual(CHECK_EVERY.map((e) => count(CHECKS, (d) => d.every === e)), [20, 52, 10, 1]);
  // what Pilotix has today to count them: 33 with the data, 12 it cannot count, 4 a person does, 34 nobody verified yet
  const data = (k: string) => count(CHECKS, (d) => d.data === k);
  assert.deepEqual([data('ready'), data('reason') + data('tags') + data('none'), data('tick'), data('unverified')], [33, 12, 4, 34]);
  // the checks that can switch something off, and the stops that wait for proof
  assert.deepEqual(CHECKS.filter((d) => d.stops).map((d) => d.id), ['D1', 'D7', 'D4', 'D6', 'Q1', 'Q2', 'Q3', 'Q4', 'O20', 'O1', 'O2', 'L12', 'T9']);
  assert.deepEqual(CHECKS.filter((d) => d.proof).map((d) => d.id), ['D1', 'D6', 'Q1', 'Q2', 'Q3', 'Q4', 'O2', 'T9']);
  for (const d of CHECKS) {
    // a check that starts as a door has one; a check without a door can never block
    assert.equal(d.level === 'door', d.doors.length > 0, `${d.id}: a door`);
    assert.equal(checkLevels(d).includes('door'), d.doors.length > 0, `${d.id}: its helpers`);
    assert.equal(d.op === 'fixed', d.v === null, `${d.id}: a line, or a fixed condition`);
    assert.equal(d.op === 'out', d.v2 !== null, `${d.id}: two limits only for « outside »`);
    if (d.v2 !== null) assert.ok(d.v! < d.v2, `${d.id}: the two limits in order`);
    // the lines: a second line says what it is, a proof only on a stop, and good, bad, stop keep their order
    assert.equal(d.s === null, d.sKind === null, `${d.id}: a second line and its kind`);
    if (d.proof) assert.ok(d.sKind === 'stop' && d.stops, `${d.id}: a proof only on a stop`);
    if (d.g !== null || d.s !== null) assert.ok(['lt', 'gt', 'gap'].includes(d.op), `${d.id}: lines only on a number that goes one way`);
    assert.ok(checkLinesInOrder(d, d.g, d.v, d.s), `${d.id}: good, bad, stop in order`);
    assert.deepEqual(checkRule(d, undefined).changed, [], `${d.id}: nothing changed at the start`);
  }
  // the general settings: each once, in a group, its starting value in its range
  assert.equal(new Set(CHECK_SETTINGS.map((d) => d.key)).size, CHECK_SETTINGS.length);
  for (const d of CHECK_SETTINGS) {
    assert.ok(CHECK_SETTING_GROUPS.includes(d.group), `${d.key}: its group`);
    assert.ok(d.min < d.max && (d.def === null || (d.def >= d.min && d.def <= d.max)), `${d.key}: its range`);
    assert.deepEqual(checkSetting(d, undefined), { key: d.key, v: d.def, changed: false }, `${d.key}: nothing changed at the start`);
  }
  // the owner's own rules: an ad is judged after 2 days, a stop needs the app to be 95% sure
  assert.deepEqual(['judgeDays', 'proofPct'].map((k) => CHECK_SETTINGS.find((d) => d.key === k)!.def), [2, 5]);
});

test('every case has its texts in French, English and Arabic', () => {
  const LOCALES = join(__dirname, '../../../../apps/web/src/locales');
  for (const lang of ['fr', 'en', 'ar']) {
    const t = JSON.parse(readFileSync(join(LOCALES, lang, 'checks.json'), 'utf8'));
    const has = (o: any, k: string) => typeof o?.[k] === 'string' && o[k].trim() !== '';
    assert.deepEqual(Object.keys(t.c).sort(), CHECKS.map((d) => d.id).sort(), `${lang}: the cases`);
    for (const d of CHECKS) {
      const c = t.c[d.id];
      for (const k of ['name', 'kpi', 'do']) assert.ok(has(c, k), `${lang} ${d.id}: ${k}`);
      assert.equal(has(c, 'tail'), d.tail, `${lang} ${d.id}: tail`);
      assert.equal(has(c, 'also'), d.also, `${lang} ${d.id}: also`);
      assert.equal(has(c, 'when'), d.op === 'fixed', `${lang} ${d.id}: when`);
      // the sentence of its limit, and of its wait
      if (d.op !== 'fixed') assert.ok(has(t.when?.[d.op], d.unit), `${lang} ${d.id}: when.${d.op}.${d.unit}`);
      if (d.wait) assert.ok(has(t.wait, `${d.wait.unit}_other`) || has(t.wait, d.wait.unit), `${lang} ${d.id}: wait.${d.wait.unit}`);
      assert.equal(typeof t.unit?.[d.unit], 'string', `${lang} ${d.id}: unit.${d.unit}`);
      assert.ok(has(t.val, d.unit), `${lang} ${d.id}: val.${d.unit}`);
      // the sentence of its « good » line, and the name of its second line
      if (d.g !== null) assert.ok(has(t.good?.[d.op], d.unit), `${lang} ${d.id}: good.${d.op}.${d.unit}`);
      if (d.sKind) assert.ok(has(t.line, d.sKind) && has(t.ed?.second, d.sKind), `${lang} ${d.id}: line.${d.sKind}`);
      assert.ok(has(t.every, d.every), `${lang} ${d.id}: every.${d.every}`);
    }
    // the general settings: a name and a help per setting, a title per group, a unit
    assert.deepEqual(Object.keys(t.set.k).sort(), CHECK_SETTINGS.map((d) => d.key).sort(), `${lang}: the settings`);
    for (const d of CHECK_SETTINGS) {
      assert.ok(has(t.set.k[d.key], 'name') && has(t.set.k[d.key], 'help'), `${lang} setting ${d.key}`);
      assert.equal(typeof t.set.unit?.[d.unit], 'string', `${lang} setting ${d.key}: unit`);
      assert.ok(has(t.set.val, d.unit), `${lang} setting ${d.key}: val`);
    }
    for (const g of CHECK_SETTING_GROUPS) assert.ok(has(t.set.groups, g), `${lang}: settings group ${g}`);
    for (const k of ['checks', 'settings', 'how']) assert.ok(has(t.view, k), `${lang}: view ${k}`);
    assert.equal(t.how.l.length, 10, `${lang}: the 10 ideas`);
    for (const p of CHECK_PARTS) assert.ok(has(t.parts, p), `${lang}: part ${p}`);
    for (const k of ['off', 'doctor', 'bell', 'door']) assert.ok(has(t.level, k) && has(t.levelHelp, k), `${lang}: level ${k}`);
    for (const k of ['price', 'ad', 'page', 'agent']) assert.ok(has(t.door, k), `${lang}: door ${k}`);
    for (const k of ['ready', 'reason', 'tags', 'tick', 'none', 'unverified']) assert.ok(has(t.data, k), `${lang}: data ${k}`);
  }
});

test('the owner changes a case: only what differs is kept, and every change is in the list', async () => {
  const state = async () => (await call('auto.checks', admin, {})) as any;
  const rule = async (id: string) => (await state()).rules.find((r: any) => r.id === id);
  assert.equal((await state()).rules.length, 83);
  assert.deepEqual((await state()).log, []);

  // « Too expensive »: over 20% → over 25%, with his own words for the action
  const r: any = await call('auto.checkSave', admin, { id: 'O5', v: 25, action: '  Offrir   un cadeau.  ' });
  assert.equal(r.changed, 2);
  assert.deepEqual({ v: r.rule.v, action: r.rule.action, changed: r.rule.changed }, { v: 25, action: 'Offrir un cadeau.', changed: ['v', 'action'] });
  let log = (await state()).log.filter((l: any) => l.checkId === 'O5');
  assert.deepEqual(log.map((l: any) => [l.field, l.old, l.new]).sort(), [['action', null, 'Offrir un cadeau.'], ['v', '20', '25']]);
  assert.ok(log.every((l: any) => l.by && l.at));
  // the same values again: nothing to keep, nothing in the list
  assert.equal(((await call('auto.checkSave', admin, { id: 'O5', v: 25 })) as any).changed, 0);
  assert.equal((await state()).log.length, 2);
  // put back by hand: « not changed » again; an empty text goes back to the app's words
  await call('auto.checkSave', admin, { id: 'O5', v: 20, action: '' });
  assert.deepEqual((await rule('O5')).changed, []);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pilot_checks`))[0].n, 0);
  assert.equal((await state()).log.length, 4);

  // the helper: a door only where one stands
  await assert.rejects(call('auto.checkSave', admin, { id: 'O5', level: 'door' }), /pas de porte/);
  assert.equal(((await call('auto.checkSave', admin, { id: 'O5', level: 'bell' })) as any).rule.level, 'bell');
  assert.equal(((await call('auto.checkSave', admin, { id: 'O9', level: 'off' })) as any).rule.level, 'off');
  assert.equal(((await call('auto.checkSave', admin, { id: 'O9', level: 'door' })) as any).rule.changed.length, 0);
  // the wait: only a case that waits; the limits: in their range and in order
  await assert.rejects(call('auto.checkSave', admin, { id: 'O19', wait: 10 }), /n’attend pas/);
  assert.equal(((await call('auto.checkSave', admin, { id: 'V1', wait: 2000 })) as any).rule.wait, 2000);
  await assert.rejects(call('auto.checkSave', admin, { id: 'V8', v: 1 }), /pas de chiffre/);
  await assert.rejects(call('auto.checkSave', admin, { id: 'L9', v: 11 }), /entre 0 et 10/);
  await assert.rejects(call('auto.checkSave', admin, { id: 'M2', v: 140 }), /plus petit/);
  assert.deepEqual(await call('auto.checkSave', admin, { id: 'M2', v: 60, v2: 140 }).then((x: any) => [x.rule.v, x.rule.v2]), [60, 140]);
  // the lines: « good », « bad » and « stop » stay in their order, and only a check that has the line takes it
  assert.deepEqual(await call('auto.checkSave', admin, { id: 'Q1', g: 96, v: 91, s: 86 }).then((x: any) => [x.rule.g, x.rule.v, x.rule.s, x.rule.changed]), [96, 91, 86, ['v', 'g', 's']]);
  await assert.rejects(call('auto.checkSave', admin, { id: 'Q1', s: 92 }), /dans l’ordre/);
  await assert.rejects(call('auto.checkSave', admin, { id: 'D1', v: 1.7 }), /dans l’ordre/);
  await assert.rejects(call('auto.checkSave', admin, { id: 'O5', s: 30 }), /deuxième ligne/);
  await assert.rejects(call('auto.checkSave', admin, { id: 'O5', g: 5 }), /« bon »/);
  assert.equal(((await call('auto.checkReset', admin, { id: 'Q1' })) as any).rule.s, 85);
  await assert.rejects(call('auto.checkSave', admin, { id: 'X9', v: 1 }), /inconnu/);

  // the next steps read the same rules
  const rules = await checkRules(db);
  assert.deepEqual(rules.filter((x) => x.changed.length).map((x) => [x.id, x.changed]), [['O5', ['level']], ['V1', ['wait']], ['M2', ['v', 'v2']]]);

  // « Revenir au départ »: the starting values again, said once in the list
  const back: any = await call('auto.checkReset', admin, { id: 'M2' });
  assert.deepEqual([back.changed, back.rule.v, back.rule.v2, back.rule.changed], [1, 80, 130, []]);
  assert.equal(((await call('auto.checkReset', admin, { id: 'M2' })) as any).changed, 0);
  log = (await state()).log;
  assert.equal(log[0].field, 'reset');
  assert.equal(count(log, (l: any) => l.field === 'reset'), 2);
});

test('a row of the first list (71 cases) is kept but no longer read', async () => {
  // « Bad quality » meant « over 30% » in the first list; the owner had set 45: it must not become the new « bad » line
  await db.query(`INSERT INTO pilot_checks (id, v, list) VALUES ('O2', 45, 'v1')`);
  // its line in the change list (written before the new list: the column's default marks it 'v1') is kept, not shown
  await db.query(`INSERT INTO pilot_check_log (check_id, field, old, new) VALUES ('O2', 'v', '30', '45')`);
  const rule = async () => ((await call('auto.checks', admin, {})) as any).rules.find((r: any) => r.id === 'O2');
  assert.deepEqual([(await rule()).v, (await rule()).changed], [10, []]);
  const shown = ((await call('auto.checks', admin, {})) as any).log.filter((l: any) => l.checkId === 'O2' && l.old === '30');
  assert.equal(shown.length, 0, 'a change of the first list is not shown as a change of the new O2');
  assert.equal(Number((await db.query(`SELECT count(*) AS n FROM pilot_check_log WHERE check_id = 'O2' AND old = '30' AND list = 'v1'`))[0].n), 1, 'and it is still in the database');
  // he edits the check again: the row becomes the new list's, with his new value
  assert.equal(((await call('auto.checkSave', admin, { id: 'O2', v: 12 })) as any).rule.v, 12);
  assert.deepEqual((await db.query(`SELECT v::float AS v, list FROM pilot_checks WHERE id = 'O2'`))[0], { v: 12, list: 'v3' });
  await call('auto.checkReset', admin, { id: 'O2' });
});

test('the general settings: a whole number in its range, only what differs is kept, every change is in the list', async () => {
  const state = async () => (await call('auto.checks', admin, {})) as any;
  const get = async (key: string) => (await state()).settings.find((x: any) => x.key === key);
  assert.equal((await state()).settings.length, CHECK_SETTINGS.length);
  assert.deepEqual(await get('judgeDays'), { key: 'judgeDays', v: 2, changed: false });
  // the owner judges after 3 days instead of 2
  const r: any = await call('auto.checkSetting', admin, { key: 'judgeDays', v: 3 });
  assert.deepEqual([r.changed, r.setting], [1, { key: 'judgeDays', v: 3, changed: true }]);
  assert.deepEqual((await state()).log.filter((l: any) => l.checkId === '*').map((l: any) => [l.field, l.old, l.new]), [['judgeDays', '2', '3']]);
  assert.equal(((await call('auto.checkSetting', admin, { key: 'judgeDays', v: 3 })) as any).changed, 0);
  await assert.rejects(call('auto.checkSetting', admin, { key: 'judgeDays', v: 2.5 }), /entier/);
  await assert.rejects(call('auto.checkSetting', admin, { key: 'proofPct', v: 60 }), /entre 1 et 25/);
  await assert.rejects(call('auto.checkSetting', admin, { key: 'nope', v: 1 }), /inconnu/);
  // the starting value typed back, or « back to the start »: not changed again, nothing kept
  await call('auto.checkSetting', admin, { key: 'judgeDays', v: 2 });
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM pilot_check_settings`))[0].n, 0);
  // a setting with no starting value: the owner fills it in, then empties it
  assert.deepEqual(await get('awarenessBudget'), { key: 'awarenessBudget', v: null, changed: false });
  assert.equal(((await call('auto.checkSetting', admin, { key: 'awarenessBudget', v: 40 })) as any).setting.v, 40);
  assert.equal(((await call('auto.checkSetting', admin, { key: 'awarenessBudget', v: null })) as any).setting.changed, false);
  // the next steps read the same settings
  await call('auto.checkSetting', admin, { key: 'proofPct', v: 10 });
  assert.deepEqual((await checkSettings(db)).filter((x) => x.changed).map((x) => [x.key, x.v]), [['proofPct', 10]]);
});

test('only the administrators read and change the rules', async () => {
  for (const e of [EMAILS.vendeur, EMAILS.manager, EMAILS.conf, EMAILS.marketer]) {
    await assert.rejects(call('auto.checks', await as(e), {}), (err: any) => !!err, e);
    await assert.rejects(call('auto.checkSave', await as(e), { id: 'O5', v: 30 }), (err: any) => !!err, e);
    await assert.rejects(call('auto.checkReset', await as(e), { id: 'O5' }), (err: any) => !!err, e);
    await assert.rejects(call('auto.checkSetting', await as(e), { key: 'judgeDays', v: 3 }), (err: any) => !!err, e);
  }
});
