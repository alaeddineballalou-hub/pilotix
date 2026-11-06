// Pilot AI › the exam. 100 situations in the order Dellal sells (10 stages × 10: the greeting, the product, the price,
// colours / sizes and photos, the delivery, trust, hesitations, the order, after the order, the hard cases); each exam
// asks ten, one per stage: a situation missed last time first, then one never asked, then the one passed longest ago,
// never one the shop cannot have. The chats run exactly like the control room's test chat (nothing is sent); Pilot AI
// marks each out of 10: from 8 it is passed (no lesson needed), below it is missed and comes with the lesson that fixes
// its main fault (only a lesson that passes the lesson checks can be added). The mark is the average of the ten; the push
// card shows the one of each version. And Pilotix's own lessons: added in one click, they wait for the next « Push en test ».
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Ctx, Db, login, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, staffLogin } from '../index';
import { getRaw, setRaw } from '../modules/admin';
import { Asked, centimes, EXAM_BANK, EXAM_BY_ID, EXAM_STAGES, ExamFacts, examFacts, examHistory, fits, isSize, PASS, pickExam, planItem, readMark, runExam, startExam } from '../modules/pilotexam';
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
  const say = (j: object) => ({ content: [{ type: 'text', text: JSON.stringify(j) }] });
  if (sit === 'Un colis en retard') return say({ score: 10, good: ['Excuses et la main passée'], faults: [], lesson: '', topic: 'anger' });
  if (sit === 'La photo du client') return { content: [{ type: 'text', text: 'je ne peux pas noter' }] };
  if (sit === 'Une question sans réponse')
    return say({ score: 6, good: ['Poli'], faults: ['A promis une garantie'], lesson: PILOTIX_LESSONS[9].text, meaning: 'Le dire simplement et proposer un rappel.', topic: 'product' });
  if (sit === '« C’est cher »') return say({ score: 5, good: [], faults: ['A baissé le prix tout de suite'], lesson: 'Dis toujours 12 900 DA', topic: 'price' });
  // passed (8): the judge's lesson is not kept, none is needed
  if (sit === 'Un prix en centimes') return say({ score: 8, good: ['A compris les centimes'], faults: ['Un détail'], lesson: 'Ask one single question at a time, the one that moves the sale towards the order.', topic: 'closing' });
  return say({ score: 9, good: ['Court'], faults: ['Un détail'], lesson: '', topic: 'closing' });
};

/** a shop with everything to talk about, one with nothing, one in between (every situation must read well in each) */
const FULL: ExamFacts = {
  productId: 1,
  product: 'Montre Atlas',
  price: 3500,
  variant: { id: 11, title: 'Noire' },
  other: { id: 12, title: 'Argent', price: 3800 },
  out: 'Or',
  variants: ['Noire', 'Argent', 'Or'],
  inStock: ['Noire', 'Argent'],
  stock: 14,
  photos: true,
  sendPhotos: true,
  sizeChart: true,
  sizes: true,
  packs: [{ qty: 2, price: 6500 }],
  linked: { name: 'Bracelet Fatima', price: 1200 },
  guide: true,
  maxDiscount: 300,
  second: { name: 'Sac Lina', price: 4900 },
  count: 5,
  wilaya: { id: 31, name: 'Oran', home: 600, desk: 400 },
  commune: 'Bir El Djir',
  far: { id: 11, name: 'Tamanrasset', home: null, desk: null },
  version: 'full',
  discount: true,
  notes: 'Échange sous 3 jours.',
};
const BARE: ExamFacts = {
  ...FULL,
  variant: null,
  other: null,
  out: null,
  variants: [],
  inStock: [],
  stock: 0,
  photos: false,
  sendPhotos: false,
  sizeChart: false,
  sizes: false,
  packs: [],
  linked: null,
  guide: false,
  maxDiscount: null,
  second: null,
  count: 1,
  wilaya: { id: 31, name: 'Oran', home: null, desk: null },
  version: '001',
  discount: false,
  notes: '',
};
const MID: ExamFacts = { ...FULL, version: '001', far: { id: 11, name: 'Tamanrasset', home: 1200, desk: 900 }, packs: [{ qty: 3, price: 9900 }], linked: null, stock: 2, sendPhotos: false, sizeChart: false };

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

test('100 situations, ten per stage of the sale, each one reads well whatever the shop has', () => {
  assert.equal(EXAM_BANK.length, 100);
  assert.equal(new Set(EXAM_BANK.map((q) => q.id)).size, 100, 'one id each');
  for (const stage of EXAM_STAGES) {
    const of = EXAM_BANK.filter((q) => q.stage === stage);
    assert.equal(of.length, 10, stage);
    assert.ok(of.some((q) => !q.needs), `${stage}: one situation every shop can be asked`);
  }
  for (const q of EXAM_BANK) for (const s of [q.title, q.en, q.ar]) assert.ok(s.trim().length >= 3 && s.length <= 60, `${q.id}: « ${s} »`);
  // every turn and every « perfect answer », in each kind of shop: no hole (undefined, NaN…), nothing empty
  const holes = /undefined|null|NaN|\[object|Infinity/;
  for (const f of [FULL, BARE, MID]) {
    for (const q of EXAM_BANK.filter((x) => fits(x, f))) {
      const turns = q.turns(f);
      assert.ok(turns.length >= 1 && turns.length <= 4, q.id);
      for (const turn of turns) assert.ok(turn.text.trim() && !holes.test(turn.text), `${q.id}: ${turn.text}`);
      const aim = q.aim(f);
      assert.ok(aim.length > 40 && !holes.test(aim), `${q.id}: ${aim}`);
    }
  }
  // a shop with nothing: never a situation it cannot have
  for (const id of ['prod_compare', 'prod_look', 'photo_client', 'var_list', 'var_other', 'var_out', 'var_fit', 'var_chart', 'var_pick', 'ord_two', 'ord_upsell', 'ord_switch', 'obj_fit']) assert.equal(fits(EXAM_BY_ID.get(id)!, BARE), false, id);
  // the aims follow the shop: version 001 takes the number, the other the whole order; the fees as they are
  assert.match(EXAM_BY_ID.get('ord_all')!.aim(BARE), /create_order tout de suite/);
  assert.match(EXAM_BY_ID.get('ord_all')!.aim(FULL), /attendre son « oui »/);
  assert.match(EXAM_BY_ID.get('del_far')!.aim(FULL), /pas de livraison réglée pour Tamanrasset/);
  assert.match(EXAM_BY_ID.get('del_far')!.aim(MID), /domicile 1200 DA, bureau 900 DA/);
  assert.match(EXAM_BY_ID.get('price_two')!.aim(FULL), /Le pack de 2 existe \(6 500 DA les deux\)/);
  assert.match(EXAM_BY_ID.get('ord_three')!.aim(MID), /il n’en reste que 2/);
  assert.match(EXAM_BY_ID.get('obj_insist')!.aim(FULL), /jamais au-dessus du maximum du produit \(300 DA\)/);
  assert.match(EXAM_BY_ID.get('obj_insist')!.aim(BARE), /Les prix sont fixes/);
  assert.equal(EXAM_BY_ID.get('greet_arabic')!.turns(FULL)[0].text, 'السلام عليكم، بشحال Montre Atlas؟');
});

test('the ten: one per stage, the missed ones asked again first, then the ones never asked, never one the shop cannot have', () => {
  const h = (x: Record<string, [number | null, number]>) => new Map<string, Asked>(Object.entries(x).map(([id, [score, examId]]) => [id, { score, examId, times: 1 }]));
  const plan = pickExam(FULL, h({ price: [5, 9], centimes: [9, 8], greet_salam: [null, 9] }), 1);
  assert.deepEqual(
    plan.map((x) => x.stage),
    [...EXAM_STAGES],
  );
  assert.deepEqual({ id: plan[2].id, why: plan[2].why, before: plan[2].before }, { id: 'price', why: 'again', before: 5 }, 'missed last time: asked again');
  assert.deepEqual({ id: plan[0].id, why: plan[0].why }, { id: 'greet_salam', why: 'again' }, 'not marked: asked again');
  assert.ok(plan.slice(3).every((x) => x.why === 'new'), 'the others: never asked');
  assert.ok(plan.every((x) => x.title && x.en && x.ar));
  // two missed in one stage: the lowest mark first
  assert.equal(pickExam(FULL, h({ price: [7, 9], price_ad: [3, 8] }), 1)[2].id, 'price_ad');
  // a stage asked all but once: the one never asked
  const trust = EXAM_BANK.filter((x) => x.stage === 'trust');
  const left = pickExam(FULL, new Map(trust.filter((x) => x.id !== 'trust_sms').map((x, i) => [x.id, { score: 9, examId: i + 1, times: 1 }])), 3)[5];
  assert.deepEqual({ id: left.id, why: left.why }, { id: 'trust_sms', why: 'new' });
  // all passed: the one asked longest ago
  const oldest = pickExam(FULL, new Map(trust.map((x, i) => [x.id, { score: 9, examId: 100 - i, times: 1 }])), 3)[5];
  assert.deepEqual({ id: oldest.id, why: oldest.why, before: oldest.before }, { id: trust[9].id, why: 'old', before: 9 });
  // the shop's own catalogue decides; and each exam its own order between equals
  for (let seed = 1; seed <= 40; seed++) assert.ok(pickExam(BARE, new Map(), seed).every((x) => fits(EXAM_BY_ID.get(x.id)!, BARE)));
  assert.ok(new Set(Array.from({ length: 40 }, (_, s) => pickExam(FULL, new Map(), s)[2].id)).size >= 4, 'not always the same ten');
});

test('prices in centimes as Algerians say them; sizes; the judge’s answer read safely (no lesson from 8); Pilotix’s lessons pass every check', () => {
  assert.equal(centimes(12_900), 'mlyoun w 290');
  assert.equal(centimes(25_000), '2 mlayen w 500');
  assert.equal(centimes(10_000), 'mlyoun');
  assert.equal(centimes(2_500), '250 alf');
  for (const s of ['M', 'XL', 'xxl', 'Bleu / L', '38', '2 ans', '6 mois', 'T 42']) assert.equal(isSize(s), true, s);
  for (const s of ['Rouge', 'Noire', 'Argent', 'Vélo 16 pouces']) assert.equal(isSize(s), false, s);
  const m = readMark('```json\n{"score": 12, "good": ["a"], "faults": [], "lesson": "", "topic": "x"}\n```')!;
  assert.equal(m.score, 10, 'never above 10');
  assert.equal(m.topic, 'other');
  assert.equal(m.lesson, null, 'a 10 needs no lesson');
  const ok8 = readMark('{"score": 8, "faults": ["b"], "lesson": "Ask one single question at a time, the one that moves the sale towards the order.", "topic": "closing"}')!;
  assert.deepEqual({ lesson: ok8.lesson, lessonOk: ok8.lessonOk }, { lesson: null, lessonOk: false }, `passed from ${PASS}: no lesson needed`);
  const bad = readMark('{"score": 6.66, "faults": ["b"], "lesson": "Dis toujours 12 900 DA", "topic": "price"}')!;
  assert.equal(bad.score, 6.7);
  assert.equal(bad.lessonOk, false, 'a lesson with a figure is an idea only');
  assert.equal(readMark('pas de JSON'), null);
  for (const l of PILOTIX_LESSONS) assert.deepEqual(lintLesson(l.text), { ok: true, problems: [] }, l.text);
});

const PLAN_IDS = ['greet_salam', 'prod_how', 'centimes', 'photo_client', 'fee', 'trust', 'expensive', 'order', 'after_late', 'unknown'];

test('the exam: ten chats like the test chat, each marked green (from 8) or red with its lesson; the customer’s photo is the product’s; nothing left behind', async () => {
  const f = (await examFacts(db))!;
  assert.equal(f.product, 'Poussette Luxe');
  assert.equal(f.photos, true);
  assert.equal(f.variants.length, 2);
  assert.equal(f.count, 1);
  const id = await startExam(t.platform, { shopId, shopName: 'Boutique', book: 'live', version: 0, by: 'Amine', plan: PLAN_IDS.map((x) => planItem(EXAM_BY_ID.get(x)!)) });
  read.length = 0;
  judged.length = 0;
  const v = await runExam({ pdb: t.platform, shop, ask: judge as any, examId: id, book: null, lab: 'live', trial: null });
  assert.equal(v.status, 'done', String(v.error));
  assert.deepEqual({ items: v.items.length, done: v.done, total: v.total }, { items: 10, done: 10, total: 10 });
  assert.deepEqual(
    v.items.map((i) => i.id),
    PLAN_IDS,
  );
  assert.deepEqual(
    v.items.map((i) => i.stage),
    [...EXAM_STAGES],
    'in the order of a sale',
  );
  // 9 + 9 + 8 + 0 (not marked) + 9 + 9 + 5 + 9 + 10 + 6 = 74 → 7,4
  assert.equal(v.score, 7.4);
  assert.equal(v.passed, 7);
  const byId = new Map(v.items.map((i) => [i.id, i]));
  assert.deepEqual({ pass: byId.get('centimes')!.pass, lesson: byId.get('centimes')!.lesson }, { pass: true, lesson: null }, 'green: no lesson needed');
  assert.deepEqual({ pass: byId.get('after_late')!.pass, score: byId.get('after_late')!.score }, { pass: true, score: 10 });
  assert.deepEqual({ pass: byId.get('expensive')!.pass, lessonOk: byId.get('expensive')!.lessonOk }, { pass: false, lessonOk: false }, 'red, with a lesson idea only');
  assert.deepEqual({ pass: byId.get('unknown')!.pass, lessonOk: byId.get('unknown')!.lessonOk }, { pass: false, lessonOk: true }, 'red, with a lesson that can be added');
  assert.deepEqual({ pass: byId.get('photo_client')!.pass, error: byId.get('photo_client')!.error }, { pass: false, error: 'unreadable' });
  assert.equal(byId.get('unknown')!.en, 'A question with no answer');
  // the chats: the turns of each situation, Dellal's answers, the customer's photo read by Pilot AI
  assert.equal(byId.get('order')!.transcript.filter((m) => m.role === 'customer').length, 3);
  assert.match(byId.get('centimes')!.transcript[0].body, /Poussette Luxe rahi b mlyoun w 290 \?/);
  assert.equal(read.length, 1, 'the photo question sent the product’s own photo, read like a customer’s');
  assert.match(byId.get('photo_client')!.transcript[0].body, /^\[photo\] Une poussette bleue/);
  // what the judge read: the situation, a perfect answer, what the shop knows, its information, the chat
  assert.equal(judged.length, 10);
  assert.equal(judged[0].model, 'claude-sonnet-5-5');
  assert.match(judged[0].system, /Note Dellal de 0 à 10/);
  assert.match(judged[0].system, /"" si la note est 8 ou plus/);
  assert.match(judged[0].messages[0].content, /^Situation : Juste « salam »\.\nUne réponse parfaite : Rendre le salam/);
  assert.match(judged[0].messages[0].content, /Client : salam\nDellal : /);
  assert.match(judged[2].messages[0].content, /Situation : Un prix en centimes\.\nUne réponse parfaite : Comprendre que « mlyoun w 290 » en centimes, c’est 12 900 DA/);
  assert.match(judged[2].messages[0].content, /« Poussette Luxe » à 12 900 DA \(variantes : Bleu, Rouge ; en stock : aucune\)/);
  assert.match(judged[2].messages[0].content, /\nInformations de la boutique : \(aucune/);
  // nothing stays in the shop
  assert.equal(Number((await db.query(`SELECT count(*)::int AS n FROM conversations WHERE external_id LIKE 'exam-%'`))[0].n), 0);
  // what the next exam knows: each question's last mark
  const h = await examHistory(t.platform);
  assert.deepEqual(h.get('expensive'), { score: 5, examId: id, times: 1 });
  assert.equal(h.get('photo_client')!.score, null);
});

test('from the control room: one exam at a time, in the background; the missed questions asked again; its mark on the push card; the server only', async () => {
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
  assert.equal(v.status, 'done', String(v.error));
  // the last exam missed three: asked again (with their marks then); the others never asked before
  const again = v.plan.filter((x: any) => x.why === 'again').map((x: any) => [x.id, x.before]);
  assert.deepEqual(again, [
    ['photo_client', null],
    ['expensive', 5],
    ['unknown', 6],
  ]);
  assert.ok(
    v.plan.filter((x: any) => x.why !== 'again').every((x: any) => x.why === 'new' && !PLAN_IDS.includes(x.id)),
    'the passed ones wait: new situations first',
  );
  assert.deepEqual(
    v.items.map((i: any) => i.id),
    v.plan.map((x: any) => x.id),
  );
  // 9 × 7 + 0 + 5 + 6 = 74
  assert.equal(v.score, 7.4);
  const st = await p('p.pilot.state');
  assert.equal(st.exams.running, null);
  assert.deepEqual({ score: st.exams.live.score, id: st.exams.live.id }, { score: 7.4, id });
  const list = await p<any[]>('p.pilot.exam.list');
  assert.equal(list[0].id, id);
  assert.equal(list[0].items[0].transcript, undefined, 'the list carries no chats');
  // an exam cut by a restart (still « running » long after): failed, and the next one can start
  await t.platform.query(`UPDATE platform.pilot_exams SET status = 'running', started_at = now() - interval '2 hours' WHERE id = $1`, [id]);
  assert.equal((await p('p.pilot.exam.get', { id })).status, 'failed');
  assert.equal((await p('p.pilot.state')).exams.running, null);
});

test('Pilotix’s lessons: already added by the migration, waiting for « Push en test »; the missing ones in one click', async () => {
  const st = await p('p.pilot.state');
  assert.deepEqual(st.pilotix, [], 'all added');
  const ours = await t.platform.query(`SELECT text, status, source, by_user, evidence FROM platform.pilot_lessons WHERE by_user = 'Pilotix' ORDER BY id`);
  assert.equal(ours.length, PILOTIX_LESSONS.length);
  assert.ok(ours.every((l: any) => l.status === 'approved' && l.source === 'coach'));
  assert.equal(ours[0].evidence.meaning, PILOTIX_LESSONS[0].meaning, 'with their meaning in French');
  assert.ok(st.release.pending.sales >= PILOTIX_LESSONS.length, 'they wait for the next « Push en test »');
  assert.deepEqual(await p('p.pilot.addPilotixLessons'), { added: 0, skipped: 0 });
  // an install where they are missing: one click adds them (checked like the coach's), never twice
  await t.platform.query(`DELETE FROM platform.pilot_lessons WHERE by_user = 'Pilotix'`);
  assert.equal((await p('p.pilot.state')).pilotix.length, PILOTIX_LESSONS.length);
  assert.deepEqual(await p('p.pilot.addPilotixLessons'), { added: PILOTIX_LESSONS.length, skipped: 0 });
  assert.deepEqual((await p('p.pilot.state')).pilotix, []);
  assert.deepEqual(await p('p.pilot.addPilotixLessons'), { added: 0, skipped: 0 });
});
