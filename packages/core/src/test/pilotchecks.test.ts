// Pilot Automations › Pilot Checks: the list is the owner's table (71 cases, each in one first helper), every case has
// its texts in French, English and Arabic, and the owner's changes are kept exactly: only what differs from the starting
// value, a door only where one stands, « Revenir au départ », and one line in the change list per thing changed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { CHECK_PARTS, CHECKS, checkLevels, checkRule } from '@pilotix/shared';
import { call, Ctx, Db } from '../index';
import { checkRules } from '../modules/pilotchecks';
import { EMAILS, setup } from './harness';

let db: Db;
let as: (email: string) => Promise<Ctx>;
let admin: Ctx;
before(async () => {
  ({ db, as } = await setup(40));
  admin = await as(EMAILS.admin);
});

const count = <T,>(xs: readonly T[], f: (x: T) => boolean) => xs.filter(f).length;

test('the list: 71 cases, each once, in the parts and the helpers of the owner’s table', () => {
  assert.equal(CHECKS.length, 71);
  assert.equal(new Set(CHECKS.map((d) => d.id)).size, 71);
  assert.deepEqual(CHECK_PARTS.map((p) => count(CHECKS, (d) => d.part === p)), [19, 10, 10, 8, 12, 12]);
  assert.deepEqual([count(CHECKS, (d) => d.level === 'door'), count(CHECKS, (d) => d.level === 'bell'), count(CHECKS, (d) => d.level === 'doctor')], [17, 25, 29]);
  // what Pilotix has today to count them: 35 with the data, 13 it cannot count, 3 a person ticks, 20 nobody verified yet
  const data = (k: string) => count(CHECKS, (d) => d.data === k);
  assert.deepEqual([data('ready'), data('reason') + data('tags') + data('none'), data('tick'), data('unverified')], [35, 13, 3, 20]);
  for (const d of CHECKS) {
    // a case that starts as a door has one; a case without a door can never block
    assert.equal(d.level === 'door', d.doors.length > 0, `${d.id}: a door`);
    assert.equal(checkLevels(d).includes('door'), d.doors.length > 0, `${d.id}: its helpers`);
    assert.equal(d.op === 'fixed', d.v === null, `${d.id}: a limit, or a fixed condition`);
    assert.equal(d.op === 'out', d.v2 !== null, `${d.id}: two limits only for « outside »`);
    if (d.v2 !== null) assert.ok(d.v! < d.v2, `${d.id}: the two limits in order`);
    assert.deepEqual(checkRule(d, undefined).changed, [], `${d.id}: nothing changed at the start`);
  }
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
    }
    for (const p of CHECK_PARTS) assert.ok(has(t.parts, p), `${lang}: part ${p}`);
    for (const k of ['off', 'doctor', 'bell', 'door']) assert.ok(has(t.level, k) && has(t.levelHelp, k), `${lang}: level ${k}`);
    for (const k of ['price', 'ad', 'page', 'agent']) assert.ok(has(t.door, k), `${lang}: door ${k}`);
    for (const k of ['ready', 'reason', 'tags', 'tick', 'none', 'unverified']) assert.ok(has(t.data, k), `${lang}: data ${k}`);
  }
});

test('the owner changes a case: only what differs is kept, and every change is in the list', async () => {
  const state = async () => (await call('auto.checks', admin, {})) as any;
  const rule = async (id: string) => (await state()).rules.find((r: any) => r.id === id);
  assert.equal((await state()).rules.length, 71);
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
  assert.equal(((await call('auto.checkSave', admin, { id: 'O8', level: 'off' })) as any).rule.level, 'off');
  assert.equal(((await call('auto.checkSave', admin, { id: 'O8', level: 'door' })) as any).rule.changed.length, 0);
  // the wait: only a case that waits; the limits: in their range and in order
  await assert.rejects(call('auto.checkSave', admin, { id: 'O8', wait: 10 }), /n’attend pas/);
  assert.equal(((await call('auto.checkSave', admin, { id: 'V1', wait: 2000 })) as any).rule.wait, 2000);
  await assert.rejects(call('auto.checkSave', admin, { id: 'V8', v: 1 }), /pas de chiffre/);
  await assert.rejects(call('auto.checkSave', admin, { id: 'L9', v: 11 }), /entre 0 et 10/);
  await assert.rejects(call('auto.checkSave', admin, { id: 'M2', v: 140 }), /plus petit/);
  assert.deepEqual(await call('auto.checkSave', admin, { id: 'M2', v: 60, v2: 140 }).then((x: any) => [x.rule.v, x.rule.v2]), [60, 140]);
  await assert.rejects(call('auto.checkSave', admin, { id: 'X9', v: 1 }), /inconnu/);

  // the next steps read the same rules
  const rules = await checkRules(db);
  assert.deepEqual(rules.filter((x) => x.changed.length).map((x) => [x.id, x.changed]), [['O5', ['level']], ['V1', ['wait']], ['M2', ['v', 'v2']]]);

  // « Revenir au départ »: the starting values again, said once in the list
  const back: any = await call('auto.checkReset', admin, { id: 'M2' });
  assert.deepEqual([back.changed, back.rule.v, back.rule.v2, back.rule.changed], [1, 70, 130, []]);
  assert.equal(((await call('auto.checkReset', admin, { id: 'M2' })) as any).changed, 0);
  log = (await state()).log;
  assert.equal(log[0].field, 'reset');
  assert.equal(count(log, (l: any) => l.field === 'reset'), 1);
});

test('only the administrators read and change the rules', async () => {
  for (const e of [EMAILS.vendeur, EMAILS.manager, EMAILS.conf, EMAILS.marketer]) {
    await assert.rejects(call('auto.checks', await as(e), {}), (err: any) => !!err, e);
    await assert.rejects(call('auto.checkSave', await as(e), { id: 'O5', v: 30 }), (err: any) => !!err, e);
    await assert.rejects(call('auto.checkReset', await as(e), { id: 'O5' }), (err: any) => !!err, e);
  }
});
