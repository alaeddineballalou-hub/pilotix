// Pilot AI › the lesson test. After « Push en test », Pilot AI writes ten cases on the version's new sales lessons with the
// shop's catalogue; Dellal answers each on the version in test (nothing is sent) and Pilot AI marks it, as a hint. The coach
// decides: « Réussi » keeps the lesson tried for the case (approved, waiting for the next push); « Pas encore » and the
// coach's words: Pilot AI makes a lesson of them and « Refaire » plays that one case again with it. « D'autres cas »: ten
// new cases, never the ones already written for the version.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Ctx, Db, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, staffLogin } from '../index';
import { getRaw, setRaw } from '../modules/admin';
import { CASES_PER_ROUND, readCases } from '../modules/pilotcases';
import { addCoachLesson, stageRelease } from '../modules/pilotlearn';
import { savePilotConfig } from '../platform/pilotai';
import { loadShop } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const LESSON = 'When the customer asks for the price, give it with the tool first, then ask one single question to move forward.';

let t: Tenancy;
let db: Db;
let pctx: PCtx;
let shop: Ctx;
let shopId = 0;
const p = <T = any>(name: string, input: unknown = {}, as: PCtx = pctx) => platformCall(name, as, input) as Promise<T>;
/** what Dellal was told (its book) */
const dellalSys: string[] = [];
const hooks: ServerHooks = {
  courier: async () => ({}),
  meta: async () => ({}),
  hashPassword: async (x) => x,
  dellal: async (action, args: any) => {
    if (action !== 'complete') return { ok: true };
    dellalSys.push(String(args.system ?? ''));
    return { content: [{ type: 'text', text: 'Saha khouya 😊 Men ayya wilaya ?' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  },
};

/** Pilot AI: writes the cases, marks them, turns the coach's words into a lesson */
const asked: any[] = [];
const say = (j: object) => ({ content: [{ type: 'text', text: JSON.stringify(j) }] });
const cases = (round: string) =>
  Array.from({ length: 12 }, (_, k) => ({ title: `Cas ${round}${k + 1}`, turns: [`ch7al Poussette Luxe ? (${round}${k + 1})`, 'w la livraison ?'], aim: 'Le prix exact avec l’outil, puis une seule question.', lesson: 1 }));
const ai = async (req: any) => {
  asked.push(req);
  const sys = String(req.system);
  const msg = String(req.messages.at(-1)?.content ?? '');
  if (sys.startsWith('Tu écris des cas de test')) return say({ cases: cases(msg.includes('Les cas déjà écrits') ? 'B' : 'A') });
  if (sys.includes('examinateur de Dellal')) {
    const sit = msg.match(/^Situation : (.+)\.$/m)?.[1] ?? '';
    if (sit === 'Cas A2') return say({ score: msg.includes('La leçon ajoutée pour ce cas') ? 9 : 5, good: [], faults: ['Deux questions à la fois'], lesson: '', topic: 'closing' });
    return say({ score: 9, good: ['Court'], faults: [], lesson: '', topic: 'closing' });
  }
  // the lessons chat: the coach's words for one case
  return say({ reply: 'Voici la leçon : lisez-la, puis Refaire.', lesson: { topic: 'closing', text: 'When the customer asks two things at once, answer both briefly, then ask one single question to move forward.', meaning: 'Deux questions à la fois : répondre aux deux, puis une seule question.' } });
};

async function waitDone(id: number) {
  let v: any = null;
  for (let i = 0; i < 400; i++) {
    v = await p('p.pilot.cases.get', { id });
    if (v.status !== 'writing' && v.status !== 'running') return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return v;
}

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  db = t.shop('public');
  const s1 = (await loadShop(t, { primary: true }))!;
  shopId = s1.id;
  const session = await login(db, OWNER.email, OWNER.password);
  shop = { db, session, now: () => Date.now(), emit: () => undefined, server: hooks, t, shop: { id: s1.id, slug: 'boutique', primary: true, features: null, locked: false, demo: false, maxUsers: null, maxDrivers: null } };
  pctx = { t, staff, now: () => Date.now(), shop: async () => shop, ai: ai as any };
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 }, 'sk-ant-api03-test-key-0123456789');
  const admin = (await db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) AND active ORDER BY id LIMIT 1`))[0];
  await setRaw(db, 'dellal', { ...(await getRaw<Record<string, unknown>>(db, 'dellal', {})), enabled: true }, Number(admin.id));
  const pid = Number((await db.query(`INSERT INTO products (name, sku, price) VALUES ('Poussette Luxe', 'PL-1', 12900) RETURNING id`))[0].id);
  await db.query(`INSERT INTO product_variants (product_id, title, sku) VALUES ($1, 'Bleu', 'PL-1-B')`, [pid]);
});

test('Pilot AI’s cases read safely: ten at most, 1 to 3 short turns, a lesson that exists', () => {
  const raw = JSON.stringify({
    cases: [
      { title: 'Prix demandé', turns: ['ch7al ?', 'w livraison ?', 'w l bureau ?', 'w lyoum ?'], aim: 'Le prix avec l’outil.', lesson: 7 },
      { title: '', turns: ['x'], aim: 'y', lesson: 1 },
      { title: 'Sans message', turns: [], aim: 'y', lesson: 1 },
      ...cases('A'),
    ],
  });
  const c = readCases('```json\n' + raw + '\n```', 2, 'r1c');
  assert.equal(c.length, CASES_PER_ROUND);
  assert.deepEqual(c[0], { id: 'r1c1', title: 'Prix demandé', turns: ['ch7al ?', 'w livraison ?', 'w l bureau ?'], aim: 'Le prix avec l’outil.', lesson: 1 });
  assert.equal(c[1].title, 'Cas A1');
  assert.deepEqual(readCases('pas de JSON', 1, 'x'), []);
});

test('the lesson test: ten cases on the new lessons, the coach decides, « Refaire » plays one case with the coach’s lesson, « D’autres cas » never repeats', async () => {
  await assert.rejects(p('p.pilot.cases.start', { shopId }), /Aucune version en test/);
  // a new lesson, pushed to test (Pilotix's own lessons, added by the migration, set aside here)
  await t.platform.query(`DELETE FROM platform.pilot_lessons WHERE by_user = 'Pilotix'`);
  assert.equal((await addCoachLesson(t.platform, { by: 'Amine', topic: 'price', text: LESSON, meaning: 'Le prix avec l’outil, puis une seule question.' })).ok, true);
  assert.equal((await stageRelease(t.platform, { by: 'Amine' })).ok, true);
  const st = await p('p.pilot.state');
  assert.deepEqual(
    st.caseTest.lessons.map((l: any) => [l.text, l.fresh]),
    [[LESSON, true]],
  );
  await assert.rejects(p('p.pilot.cases.start', { shopId }, { ...pctx, ai: undefined }), /que sur le serveur/);

  const { id } = await p<{ id: number }>('p.pilot.cases.start', { shopId });
  await assert.rejects(p('p.pilot.cases.start', { shopId }), /déjà en cours/);
  const v = await waitDone(id);
  assert.equal(v.status, 'done', String(v.error));
  assert.deepEqual({ cases: v.cases.length, items: v.items.length, done: v.done, total: v.total, round: v.round }, { cases: 10, items: 10, done: 10, total: 10, round: 1 });
  assert.deepEqual(v.lessons.map((l: any) => l.text), [LESSON]);
  assert.ok(v.items.every((i: any) => i.verdict === null && i.tries === 1), 'the coach decides, not Pilot AI');
  const a2 = v.items.find((i: any) => i.id === 'r1c2');
  assert.deepEqual({ score: a2.score, hint: a2.hint }, { score: 5, hint: false }, 'Pilot AI’s mark is a hint');
  assert.equal(a2.transcript.filter((m: any) => m.role === 'customer').length, 2);
  // what Pilot AI read to write the cases: the lessons, the shop's catalogue
  const writing = asked.find((r) => String(r.system).startsWith('Tu écris des cas de test'));
  assert.match(writing.messages[0].content, /1\. \[price\] When the customer asks for the price/);
  assert.match(writing.messages[0].content, /« Poussette Luxe » à 12 900 DA/);
  assert.match(writing.messages[0].content, /Aucun cas écrit avant/);
  assert.equal(Number((await db.query(`SELECT count(*)::int AS n FROM conversations WHERE external_id LIKE 'case-%'`))[0].n), 0, 'nothing stays in the shop');
  assert.equal((await p('p.pilot.state')).caseTest.last.id, id);

  // « Réussi » on a case with no lesson of its own: nothing to keep
  let w = await p('p.pilot.cases.verdict', { id, caseId: 'r1c1', pass: true });
  assert.deepEqual(
    (({ verdict, kept }) => ({ verdict, kept }))(w.items.find((i: any) => i.id === 'r1c1')),
    { verdict: 'pass', kept: null },
  );
  // « Pas encore », the coach's words, « Refaire »: that case only, played again with the lesson made of them
  w = await p('p.pilot.cases.verdict', { id, caseId: 'r1c2', pass: false });
  assert.equal(w.missed, 1);
  const r = await p('p.pilot.cases.redo', { id, caseId: 'r1c2', note: 'Il doit répondre aux deux questions puis poser une seule question.' });
  const again = r.test.items.find((i: any) => i.id === 'r1c2');
  assert.deepEqual({ tries: again.tries, verdict: again.verdict, score: again.score, note: again.note }, { tries: 2, verdict: null, score: 9, note: 'Il doit répondre aux deux questions puis poser une seule question.' });
  assert.match(again.draft.text, /answer both briefly/);
  const judged = asked.filter((x) => String(x.system).includes('examinateur de Dellal')).at(-1);
  assert.match(judged.messages[0].content, /La leçon ajoutée pour ce cas : « When the customer asks two things at once/);
  const taught = asked.filter((x) => !String(x.system).startsWith('Tu écris') && !String(x.system).includes('examinateur')).at(-1);
  assert.match(taught.messages[0].content, /Le cas : Cas A2\. Le client a écrit : « ch7al Poussette Luxe \? \(A2\) » puis « w la livraison \? »/);
  // « Réussi »: the lesson is kept (approved, waiting for « Push en test »); « Pas encore » again takes it back
  w = await p('p.pilot.cases.verdict', { id, caseId: 'r1c2', pass: true });
  const keptId = w.items.find((i: any) => i.id === 'r1c2').kept;
  assert.ok(keptId > 0);
  assert.equal((await t.platform.query(`SELECT status, source FROM platform.pilot_lessons WHERE id = $1`, [keptId]))[0].status, 'approved');
  assert.equal(w.kept, 1);
  w = await p('p.pilot.cases.verdict', { id, caseId: 'r1c2', pass: false });
  assert.equal(w.items.find((i: any) => i.id === 'r1c2').kept, null);
  assert.equal((await t.platform.query(`SELECT status FROM platform.pilot_lessons WHERE id = $1`, [keptId]))[0].status, 'rejected');
  w = await p('p.pilot.cases.verdict', { id, caseId: 'r1c2', pass: true });
  assert.ok(w.items.find((i: any) => i.id === 'r1c2').kept > 0, 'kept again');

  // « D'autres cas »: round 2, never the cases already written, and every case plays with the lessons kept
  dellalSys.length = 0;
  const more = await p<{ id: number }>('p.pilot.cases.more', { id });
  const v2 = await waitDone(more.id);
  assert.equal(v2.status, 'done', String(v2.error));
  assert.equal(v2.round, 2);
  assert.equal(v2.cases[0].id, 'r2c1');
  assert.equal(v2.cases[0].title, 'Cas B1');
  const writing2 = asked.filter((x) => String(x.system).startsWith('Tu écris des cas de test')).at(-1);
  assert.match(writing2.messages[0].content, /Les cas déjà écrits \(ne refais aucun d’eux[^\n]*\n- Cas A1 — « ch7al Poussette Luxe \? \(A1\) »/);
  assert.ok(dellalSys.length > 0 && dellalSys.every((x) => x.includes('When the customer asks two things at once')), 'the kept lesson plays in every case');
  assert.equal(Number((await t.platform.query(`SELECT count(*)::int AS n FROM platform.pilot_case_tests`))[0].n), 2);
});
