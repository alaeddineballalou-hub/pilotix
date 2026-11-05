// Pilot AI › the 10-question exam. Ten simulated customers of a shop (the price, centimes, the delivery and the total, a
// photo asked for, the customer's own photo, a scam fear, « expensive », « I'll ask my husband », a whole order, a question
// without an answer) talk to Dellal on the version chosen, exactly like the control room's test chat (nothing is sent);
// Pilot AI marks each chat out of 10 and writes the lesson that fixes its main fault (only a lesson that passes the
// lesson checks can be added). The mark is the average of the ten; the push card shows the one of each version. And
// Pilotix's own lessons: added in one click, they wait for the next « Push en test ».
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Ctx, Db, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, staffLogin } from '../index';
import { getRaw, setRaw } from '../modules/admin';
import { centimes, EXAM, examFacts, readMark, runExam, startExam } from '../modules/pilotexam';
import { PILOTIX_LESSONS } from '../modules/pilotexamdata';
import { lintLesson } from '../modules/pilotlearn';
import { savePilotConfig } from '../platform/pilotai';
import { loadShop } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const JPEG = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF-${tag}-`.padEnd(48, 'x'))]).toString('base64');

let t: Tenancy;
let db: Db;
let pctx: PCtx;
let shop: Ctx;
let shopId = 0;
let pid = 0;
const p = <T = any>(name: string, input: unknown = {}, as: PCtx = pctx) => platformCall(name, as, input) as Promise<T>;
const read: any[] = [];
const hooks: ServerHooks = {
  courier: async () => ({}),
  meta: async () => ({}),
  hashPassword: async (x) => x,
  dellal: async (action, args: any) => {
    if (action !== 'complete') return { ok: true };
    if (args.system.includes('Tu regardes UNE photo')) {
      read.push(args);
      return { content: [{ type: 'text', text: `{"what":"Une poussette bleue","text":"","product_id":${pid},"sure":true,"variant":"bleu","kind":"product"}` }], stop_reason: 'end_turn' };
    }
    return { content: [{ type: 'text', text: 'Saha khouya 😊 Men ayya wilaya ?' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  },
};
/** the judge: a mark by situation (one answer it cannot read: that question counts 0) */
const judged: any[] = [];
const judge = async (req: any) => {
  judged.push(req);
  const sit = String(req.messages[0].content).match(/^Situation : (.+)\.$/m)?.[1] ?? '';
  if (sit === 'Le prix') return { content: [{ type: 'text', text: '{"score": 10, "good": ["Prix juste et une question"], "faults": [], "lesson": "", "topic": "price"}' }] };
  if (sit === 'La photo du client') return { content: [{ type: 'text', text: 'je ne peux pas noter' }] };
  if (sit === 'Une question sans réponse')
    return { content: [{ type: 'text', text: '{"score": 6, "good": ["Poli"], "faults": ["A promis une garantie"], "lesson": "When you do not know a piece of information about the product, say so simply and offer that someone from the team calls the customer back to answer.", "meaning": "Le dire simplement et proposer un rappel.", "topic": "product"}' }] };
  if (sit === 'Un prix en centimes') return { content: [{ type: 'text', text: '{"score": 8, "good": [], "faults": ["Prix en DA non confirmé"], "lesson": "Confirme toujours 12 900 DA", "topic": "price"}' }] };
  return { content: [{ type: 'text', text: '{"score": 9, "good": ["Court"], "faults": ["Un détail"], "lesson": "Ask one single question at a time, the one that moves the sale towards the order.", "topic": "closing"}' }] };
};

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
  pctx = { t, staff, now: () => Date.now(), shop: async () => shop, ai: judge as any };
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 }, 'sk-ant-api03-test-key-0123456789');
  const admin = (await db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) AND active ORDER BY id LIMIT 1`))[0];
  await setRaw(db, 'dellal', { ...(await getRaw<Record<string, unknown>>(db, 'dellal', {})), enabled: true }, Number(admin.id));
  pid = Number((await db.query(`INSERT INTO products (name, sku, price, photo) VALUES ('Poussette Luxe', 'PL-1', 12900, $1) RETURNING id`, [`data:image/jpeg;base64,${JPEG('product')}`]))[0].id);
  await db.query(`INSERT INTO product_variants (product_id, title, sku) VALUES ($1, 'Bleu', 'PL-1-B'), ($1, 'Rouge', 'PL-1-R')`, [pid]);
});

test('prices in centimes as Algerians say them; the judge’s answer read safely; Pilotix’s lessons pass every lesson check', () => {
  assert.equal(centimes(12_900), 'mlyoun w 290');
  assert.equal(centimes(25_000), '2 mlayen w 500');
  assert.equal(centimes(10_000), 'mlyoun');
  assert.equal(centimes(2_500), '250 alf');
  const m = readMark('```json\n{"score": 12, "good": ["a"], "faults": [], "lesson": "", "topic": "x"}\n```')!;
  assert.equal(m.score, 10, 'never above 10');
  assert.equal(m.topic, 'other');
  assert.equal(m.lesson, null, 'a 10 needs no lesson');
  const bad = readMark('{"score": 6.66, "faults": ["b"], "lesson": "Dis toujours 12 900 DA", "topic": "price"}')!;
  assert.equal(bad.score, 6.7);
  assert.equal(bad.lessonOk, false, 'a lesson with a figure is an idea only');
  assert.equal(readMark('pas de JSON'), null);
  assert.equal(EXAM.length, 10);
  assert.equal(new Set(EXAM.map((q) => q.id)).size, 10);
  for (const l of PILOTIX_LESSONS) assert.deepEqual(lintLesson(l.text), { ok: true, problems: [] }, l.text);
});

test('the exam: ten chats like the test chat, each marked; the customer’s photo is the product’s; nothing left behind', async () => {
  const f = (await examFacts(db))!;
  assert.equal(f.product, 'Poussette Luxe');
  assert.equal(f.photos, true);
  assert.equal(f.variants.length, 2);
  const id = await startExam(t.platform, { shopId, shopName: 'Boutique', book: 'live', version: 0, by: 'Amine' });
  read.length = 0;
  judged.length = 0;
  const v = await runExam({ pdb: t.platform, shop, ask: judge as any, examId: id, book: null, lab: 'live', trial: null });
  assert.equal(v.status, 'done', String(v.error));
  assert.equal(v.items.length, 10);
  assert.equal(v.done, 10);
  // 10 + 8 + 9 × 6 + 0 (not marked) + 6 = 78 → 7,8
  assert.equal(v.score, 7.8);
  const byId = new Map(v.items.map((i) => [i.id, i]));
  assert.equal(byId.get('price')!.score, 10);
  assert.equal(byId.get('photo_client')!.error, 'unreadable');
  assert.equal(byId.get('unknown')!.lessonOk, true, 'a lesson that passes the checks: it can be added');
  assert.equal(byId.get('centimes')!.lessonOk, false);
  // the chats: the turns of each situation, Dellal's answers, the customer's photo read by Pilot AI
  assert.equal(byId.get('order')!.transcript.filter((m) => m.role === 'customer').length, 3);
  assert.match(byId.get('centimes')!.transcript[0].body, /Poussette Luxe rahi b mlyoun w 290 \?/);
  assert.equal(read.length, 1, 'the photo question sent the product’s own photo, read like a customer’s');
  assert.match(byId.get('photo_client')!.transcript[0].body, /^\[photo\] Une poussette bleue/);
  // what the judge read: the situation, a perfect answer, what the shop knows, the chat
  assert.equal(judged.length, 10);
  assert.equal(judged[0].model, 'claude-sonnet-5-5');
  assert.match(judged[0].messages[0].content, /Situation : Le prix\.\nUne réponse parfaite : Le prix exact du catalogue \(12 900 DA\)/);
  assert.match(judged[0].messages[0].content, /Client : salam, ch7al Poussette Luxe \?\nDellal : /);
  assert.match(judged[0].system, /Note Dellal de 0 à 10/);
  // nothing stays in the shop
  assert.equal(Number((await db.query(`SELECT count(*)::int AS n FROM conversations WHERE external_id LIKE 'exam-%'`))[0].n), 0);
});

test('from the control room: one exam at a time, in the background; its mark on the push card; the server only', async () => {
  await assert.rejects(p('p.pilot.exam.start', { shopId, book: 'live' }, { ...pctx, ai: undefined }), /que sur le serveur/);
  await assert.rejects(p('p.pilot.exam.start', { shopId, book: 'trial' }), /Aucune version en test/);
  const { id } = await p<{ id: number }>('p.pilot.exam.start', { shopId, book: 'live' });
  await assert.rejects(p('p.pilot.exam.start', { shopId, book: 'live' }), /déjà en cours/);
  const st0 = await p('p.pilot.state');
  assert.equal(st0.exams.running.id, id);
  let v: any = null;
  for (let i = 0; i < 400; i++) {
    v = await p('p.pilot.exam.get', { id });
    if (v.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(v.status, 'done');
  assert.equal(v.score, 7.8);
  const st = await p('p.pilot.state');
  assert.equal(st.exams.running, null);
  assert.deepEqual({ score: st.exams.live.score, id: st.exams.live.id }, { score: 7.8, id });
  const list = await p<any[]>('p.pilot.exam.list');
  assert.equal(list[0].id, id);
  assert.equal(list[0].items[0].transcript, undefined, 'the list carries no chats');
  // an exam cut by a restart (still « running » long after): failed, and the next one can start
  await t.platform.query(`UPDATE platform.pilot_exams SET status = 'running', started_at = now() - interval '2 hours' WHERE id = $1`, [id]);
  assert.equal((await p('p.pilot.exam.get', { id })).status, 'failed');
  assert.equal((await p('p.pilot.state')).exams.running, null);
});

test('Pilotix’s lessons: one click adds them (checked like the coach’s), they wait for « Push en test », never twice', async () => {
  const st = await p('p.pilot.state');
  assert.equal(st.pilotix.length, PILOTIX_LESSONS.length);
  const before = st.release.pending.sales;
  const r = await p('p.pilot.addPilotixLessons');
  assert.deepEqual(r, { added: PILOTIX_LESSONS.length, skipped: 0 });
  const after = await p('p.pilot.state');
  assert.deepEqual(after.pilotix, [], 'nothing left to add');
  assert.equal(after.release.pending.sales, before + PILOTIX_LESSONS.length, 'they wait for the next « Push en test »');
  assert.deepEqual(await p('p.pilot.addPilotixLessons'), { added: 0, skipped: 0 });
});
