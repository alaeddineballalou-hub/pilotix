// Darija (lahja) lessons. A shop's team writes how Dellal should have said one of its messages (the message that was sent
// never changes): the changed words become a lesson used at once in that shop, and go to Pilotix. Every night Dellal also
// learns from how each shop's customers write (proven words only). Pilotix accepts (as is or modified): every shop uses it;
// refuses: the other shops never see it (a lesson Dellal learned also stops in its shop). Only words travel between shops.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, staffLogin } from '../index';
import { makeSession } from '../rpc';
import { profileById } from '../modules/users';
import { getRaw, setRaw } from '../modules/admin';
import { checkLahjaWords, lahjaDiff, lahjaFor, learnLahja } from '../modules/lahja';
import { cmSystem, DEFAULT_CM } from '../modules/cm';
import { savePilotConfig } from '../platform/pilotai';
import { loadShops } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const NOW = Date.parse('2026-11-02T10:00:00Z');
let t: Tenancy;
let db: Db;
let pctx: PCtx;
let shop: Ctx;
let local: Ctx;
let shopId: number;
/** another shop: no lessons of its own (what « every shop » means for it) */
const other: Db = { query: async () => [], tx: async (f: any) => f(other) } as any;
const p = <T = any>(name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<T>;
/** « Push en test » then « Push sur le serveur »: what Pilotix accepted goes out to every shop */
const push = async () => {
  await p('p.pilot.stage', { darija: false });
  await p('p.pilot.release', { id: (await p('p.pilot.state')).release.trial.id });
};
const reqs: any[] = [];
const hooks: ServerHooks = {
  courier: async () => ({}),
  meta: async () => ({}),
  hashPassword: async (x) => x,
  dellal: async (action, args) => {
    if (action !== 'complete') return { ok: true };
    reqs.push(args);
    return { content: [{ type: 'text', text: 'Wakha khouya, nb3atlek tsawer dorka 👍' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  },
};

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  t = pgliteTenancy((new PGlite()) as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  pctx = { t, staff, now: () => NOW };
  shopId = (await loadShops(t)).find((s) => s.kind === 'store')!.id;
  db = t.shop('public');
  const admin = (await db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) AND active ORDER BY id LIMIT 1`))[0];
  const session = makeSession((await profileById(db, Number(admin.id)))!);
  const base = { db, session, now: () => NOW, emit: () => undefined, server: hooks };
  shop = { ...base, t, shop: { id: shopId, slug: 'boutique', primary: true, features: null, locked: false, demo: false, maxUsers: null, maxDrivers: null } };
  // the same shop without Pilotix's server (the preview, an install of its own): its lessons stay its own
  local = { ...base, server: undefined };
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 }, 'sk-ant-api03-test-key-0123456789');
  // Dellal answers in this shop
  await setRaw(db, 'dellal', { ...(await getRaw<Record<string, unknown>>(db, 'dellal', {})), enabled: true }, Number(admin.id));
});

/** one of Dellal's messages in a conversation of the shop */
async function said(body: string): Promise<number> {
  const c = (await db.query(`INSERT INTO conversations (channel, external_id) VALUES ('whatsapp', $1) RETURNING id`, [`2136610${Math.floor(Math.random() * 1e5)}`]))[0].id;
  await db.query(`INSERT INTO conv_messages (conversation_id, role, body) VALUES ($1, 'customer', 'salam')`, [c]);
  return Number((await db.query(`INSERT INTO conv_messages (conversation_id, role, body) VALUES ($1, 'agent', $2) RETURNING id`, [c, body]))[0].id);
}

test('the words a person changed: replaced, added, removed; numbers and rewritten sentences are not Darija', () => {
  assert.deepEqual(lahjaDiff('Wakha, nb3atlek tsawer', 'Saha, nb3atlek tsawer'), [{ use: 'Saha', not: 'Wakha' }]);
  assert.deepEqual(lahjaDiff('Mar7ba bik', 'Mar7ba bik khouya'), [{ use: 'khouya' }]);
  assert.deepEqual(lahjaDiff('Salam habibi, kifach n3awnek ?', 'Salam, kifach n3awnek ?'), [{ use: '', not: 'habibi' }]);
  assert.deepEqual(lahjaDiff('La montre b 3500 DA', 'La montre b 3900 DA'), [], 'a price is not Darija');
  assert.deepEqual(lahjaDiff('واخا نبعثلك التصاور', 'صحا نبعثلك التصاور'), [{ use: 'صحا', not: 'واخا' }]);
  assert.deepEqual(lahjaDiff('Bonjour monsieur, je vous envoie les photos tout de suite', 'Salam khouya rani nb3atlek tsawer dorka'), [], 'a sentence written again from end to end');
  assert.deepEqual(lahjaDiff('Daba nb3atlek', 'dorka nb3atlek'), [{ use: 'dorka', not: 'Daba' }]);

  assert.equal(checkLahjaWords([{ use: 'saha', not: 'wakha' }]).ok, true);
  const moroccan = checkLahjaWords([{ use: 'daba', not: 'dorka' }]);
  assert.equal(moroccan.ok, false);
  assert.equal(moroccan.problems[0].code, 'dialect', 'what the Darija check removes cannot be taught: the two would fight');
  assert.equal(checkLahjaWords([{ use: '3500 DA' }]).problems[0].code, 'number');
  assert.equal(checkLahjaWords([{ use: 'n3awnek', not: 'n3awnek' }]).problems[0].code, 'same');
  assert.equal(checkLahjaWords([{ use: 'www.site.dz' }]).problems.some((x) => x.code === 'contact'), true);
  assert.equal(checkLahjaWords([{ use: 'n9ollek' }]).ok, true, 'Darija written with 3, 7, 9 is not a number');
});

test('a shop without Pilotix’s server: the lesson is its own, used at once by Dellal (instructions and check), removed at once', async () => {
  const m = await said('Wakha, nb3atlek tsawer daba');
  const r: any = await call('dellal.lahja.add', local, { messageId: m, after: 'Saha, nb3atlek tsawer dorka' });
  assert.equal(r.review, 'local');
  assert.deepEqual(r.words, [{ use: 'Saha', not: 'Wakha' }, { use: 'dorka', not: 'daba' }]);
  assert.equal((await db.query(`SELECT body FROM conv_messages WHERE id = $1`, [m]))[0].body, 'Wakha, nb3atlek tsawer daba', 'the message that was sent never changes');
  await assert.rejects(call('dellal.lahja.add', local, { messageId: m, after: 'Wakha, nb3atlek tsawer daba' }), /Changez au moins un mot/);
  await assert.rejects(call('dellal.lahja.add', local, { messageId: m, after: 'Wakha, nb3atlek tsawer wakha' }), /darija/);
  const own = await lahjaFor(db, null, null);
  assert.deepEqual(own, { all: [], own: [{ use: 'Saha', not: 'Wakha' }, { use: 'dorka', not: 'daba' }] });
  const list: any = await call('dellal.lahja.list', local, {});
  assert.equal(list.platform, false);
  assert.equal(list.own.length, 1);
  assert.equal(list.own[0].review, 'local');
  await call('dellal.lahja.remove', local, { id: r.id });
  assert.deepEqual((await lahjaFor(db, null, null)).own, []);
});

test('Pilotix’s server: a team’s lesson works in its shop at once and waits for Pilotix; accepted (modified), every shop uses it after the push', async () => {
  reqs.length = 0;
  const m = await said('Wakha Ahmed, nb3atlek tsawer');
  const r: any = await call('dellal.lahja.add', shop, { messageId: m, after: 'Saha Ahmed, nb3atlek tsawer' });
  assert.equal(r.review, 'waiting');
  // in its shop at once, not in the others yet
  assert.deepEqual((await lahjaFor(db, t.platform, shopId)).own, [{ use: 'Saha', not: 'Wakha' }]);
  assert.deepEqual((await lahjaFor(other, t.platform, 999)).all, []);
  // Pilotix sees it, anonymized (only words go to other shops)
  const st: any = await p('p.lahja.state');
  assert.equal(st.waiting.length, 1);
  const w = st.waiting[0];
  assert.equal(w.source, 'seller');
  assert.equal(w.shopId, shopId);
  assert.doesNotMatch(w.before, /Ahmed/, 'a customer’s name stays in the shop');
  assert.equal((await p('p.pilot.state')).lahjaWaiting, 1, 'the tab says how many wait');
  // a word the Darija check removes cannot be accepted
  await assert.rejects(p('p.lahja.decide', { id: w.id, action: 'approve', words: [{ use: 'daba', not: 'dorka' }] }), /pas de la darija algérienne/);
  // accepted with the words Pilotix chose: out with the next push, not before; then every shop
  const ok: any = await p('p.lahja.decide', { id: w.id, action: 'approve', words: [{ use: 'saha', not: 'wakha' }] });
  assert.equal(ok.ok, true);
  assert.deepEqual((await lahjaFor(other, t.platform, 999)).all, []);
  assert.equal(((await call('dellal.lahja.list', shop, {})) as any).own[0].review, 'accepted');
  await push();
  assert.deepEqual((await lahjaFor(other, t.platform, 999)).all, [{ use: 'saha', not: 'wakha' }]);
  const mine = await lahjaFor(db, t.platform, shopId);
  assert.deepEqual(mine.all, [{ use: 'saha', not: 'wakha' }]);
  assert.deepEqual(mine.own, [], 'its own copy is the same lesson: said once');
  const list: any = await call('dellal.lahja.list', shop, {});
  assert.equal(list.own[0].review, 'approved');
  assert.equal(list.all[0].mine, true);

  // Dellal uses them: Pilotix's in the block every shop shares, and the Darija check fixes « wakha »
  const conv = (await db.query(`INSERT INTO conversations (channel, external_id) VALUES ('whatsapp', '213661000777') RETURNING id`))[0].id;
  await db.query(`INSERT INTO conv_messages (conversation_id, role, body) VALUES ($1, 'customer', 'salam, mazal kayen ?')`, [conv]);
  const out: any = await call('dellal.answer', shop, { id: Number(conv) });
  assert.match(reqs[0].systemBlocks[0], /LEÇONS DE DARIJA \(validées par Pilotix pour toutes les boutiques\) :\n- écris « saha » au lieu de « wakha »/);
  assert.doesNotMatch(out.reply ?? '', /wakha/i, 'the check took « wakha » out of the answer');
  // removed: no shop uses it any more (the shop's own copy stays its own: it chose it)
  await p('p.lahja.decide', { id: w.id, action: 'remove' });
  assert.deepEqual((await lahjaFor(other, t.platform, 999)).all, []);
  assert.deepEqual((await lahjaFor(db, t.platform, shopId)).own, [{ use: 'Saha', not: 'Wakha' }]);
  // a lesson the shop takes back while it waits leaves Pilotix's queue
  const m2 = await said('Rani hna, sa9sini');
  const r2: any = await call('dellal.lahja.add', shop, { messageId: m2, after: 'Rani hna, s9sini' });
  await call('dellal.lahja.remove', shop, { id: r2.id });
  assert.equal((await p('p.lahja.state')).waiting.length, 0);
});

test('Pilotix’s own lesson (the control room’s test chat): every shop after the push; the same words twice are refused', async () => {
  const r: any = await p('p.lahja.add', { before: 'Mar7ba bik, wach t7ab ?', after: 'Mar7ba bik khouya, wach t7ab ?' });
  assert.deepEqual(r.words, [{ use: 'khouya' }]);
  assert.deepEqual((await lahjaFor(other, t.platform, 999)).all, [], 'accepted at once, out with the next push');
  assert.equal((await p('p.lahja.state')).accepted[0].source, 'coach');
  await push();
  assert.deepEqual((await lahjaFor(other, t.platform, 999)).all, [{ use: 'khouya' }]);
  await assert.rejects(p('p.lahja.add', { words: [{ use: 'khouya' }] }), /déjà une leçon/);
  await assert.rejects(p('p.lahja.add', { before: 'Salam', after: 'Salam' }), /Changez au moins un mot/);
  const st: any = await p('p.lahja.state');
  assert.equal(st.approved[0].source, 'coach');
  await p('p.lahja.decide', { id: r.id, action: 'remove' });
});

test('the night: Dellal learns only words the chats prove; used in its shop at once; refused by Pilotix, it stops there too', async () => {
  const pdb = t.platform;
  // 12 chats of the shop: customers write « wesh » and « 3la jal », Dellal writes « wach »; one customer writes « khoya »
  for (let i = 0; i < 12; i++) {
    const c = [`C: wesh khouya, mazal kayen ?`, `D: wach t7ab tchouf tsawer ?`, i < 4 ? `C: ih 3la jal rabbi` : `C: ih`, i === 0 ? 'C: merci khoya' : ''].filter(Boolean).join('\n');
    await pdb.query(
      `INSERT INTO platform.pilot_cases (shop_id, conv_id, outcome, transcript, last_at, done) VALUES ($1, $2, 'delivered', $3, $4::timestamptz, true)`,
      [shopId, 5000 + i, c, new Date(NOW - 86_400_000).toISOString()],
    );
  }
  const asked: any[] = [];
  const run = async (rs: any[]) => {
    asked.push(...rs);
    return rs.map(() =>
      JSON.stringify({
        words: [
          { use: 'wesh', not: 'wach', why: 'les clients écrivent wesh' },
          { use: '3la jal', not: null, why: 'expression des clients' },
          { use: 'khoya', not: null, why: 'un seul client' },
          { use: 'daba', not: 'dorka', why: 'marocain' },
          { use: 'wesh', not: 'wach', why: 'deux fois' },
        ],
      }),
    );
  };
  const r = await learnLahja(pdb, run, new Date(NOW));
  assert.equal(r.asked, 1);
  assert.match(asked[0].user, /wesh khouya, mazal kayen/);
  assert.equal(r.proposed, 2, '« khoya » (one customer) and « daba » (Moroccan) are left out, « wesh » once');
  const learned: any = await call('dellal.lahja.list', shop, {});
  assert.deepEqual(learned.learned.map((l: any) => l.words[0].use).sort(), ['3la jal', 'wesh']);
  assert.equal(learned.learned.find((l: any) => l.words[0].use === 'wesh').customers, 12);
  // used in its shop at once, not in the others
  assert.ok((await lahjaFor(db, pdb, shopId)).own.some((w) => w.use === 'wesh'));
  assert.ok(!(await lahjaFor(other, pdb, 999)).all.some((w) => w.use === 'wesh'));
  // Pilotix refuses « wesh »: it stops in its shop too; accepts « 3la jal »: every shop
  const st: any = await p('p.lahja.state');
  const wesh = st.waiting.find((x: any) => x.words[0].use === 'wesh');
  const jal = st.waiting.find((x: any) => x.words[0].use === '3la jal');
  assert.equal(wesh.source, 'dellal');
  // the review shows the lines that prove it: customers who write « wesh » (one per chat), Dellal writing « wach »
  assert.equal(wesh.samples.c.length, 3);
  assert.equal(wesh.samples.d.length, 2);
  assert.ok(wesh.samples.c.every((x: any) => /\bwesh\b/.test(x.line) && x.conv >= 5000 && x.conv < 5012));
  assert.equal(new Set(wesh.samples.c.map((x: any) => x.conv)).size, 3, 'three different chats');
  assert.ok(wesh.samples.d.every((x: any) => /\bwach\b/.test(x.line)));
  assert.match((await p('p.pilot.case', { shopId, convId: wesh.samples.c[0].conv })).transcript, /wesh khouya/);
  assert.deepEqual(jal.samples.d, [], 'nothing to drop: no line of Dellal');
  assert.match(jal.samples.c[0].line, /3la jal/);
  // and the shop never gets those lines
  assert.ok(!JSON.stringify(await call('dellal.lahja.list', shop, {})).includes('mazal kayen'));
  await p('p.lahja.decide', { id: wesh.id, action: 'refuse', note: 'pas partout' });
  await p('p.lahja.decide', { id: jal.id, action: 'approve' });
  assert.ok(!(await lahjaFor(db, pdb, shopId)).own.some((w) => w.use === 'wesh'));
  // accepted, « 3la jal » stays in use in its shop until the push takes it to every shop
  assert.ok((await lahjaFor(db, pdb, shopId)).own.some((w) => w.use === '3la jal'));
  await push();
  assert.deepEqual((await lahjaFor(other, pdb, 999)).all, [{ use: '3la jal' }]);
  // the next night does not propose them again
  assert.equal((await learnLahja(pdb, run, new Date(NOW))).proposed, 0);
});

test('CM AI agent: « Leçon de darija » under one of its replies; the reply never changes; its instructions carry the lessons', async () => {
  const post = (await db.query(`INSERT INTO cm_posts (channel, external_id, caption) VALUES ('facebook', 'p-lahja', 'La poussette') RETURNING id`))[0].id;
  const add = async (ext: string, reply: string, by: object | null, team = false) =>
    (
      await db.query(
        `INSERT INTO cm_comments (post_id, channel, external_id, author_id, author_name, body, status, public_reply, private_reply, handled_by, meta)
         VALUES ($1, 'facebook', $2, 'u-1', 'Karim', 'ch7al ?', 'answered', $3, $4, $5, $6::jsonb) RETURNING id`,
        [post, ext, reply, 'Wakha khouya, rani b3atlek f privé 👍', team ? (await db.query(`SELECT id FROM profiles ORDER BY id LIMIT 1`))[0].id : null, by ? JSON.stringify(by) : null],
      )
    )[0].id as number;
  const ai = await add('c-ai', 'Wakha, jawbnakom f privé 👍', { by: 'ai' });
  const r: any = await call('cm.lahja.add', shop, { id: ai, which: 'public', after: 'Saha, jawbnakom f privé 👍' });
  assert.deepEqual(r.words, [{ use: 'Saha', not: 'Wakha' }]);
  assert.equal(r.review, 'waiting');
  // the reply that was sent does not change
  assert.equal((await db.query(`SELECT public_reply FROM cm_comments WHERE id = $1`, [ai]))[0].public_reply, 'Wakha, jawbnakom f privé 👍');
  // the private reply too, and the review knows where it comes from
  await call('cm.lahja.add', shop, { id: ai, which: 'private', after: 'Wakha khouya, rani nb3atlek f privé 👍' });
  const st: any = await p('p.lahja.state');
  const fromCm = st.waiting.filter((x: any) => x.via === 'cm');
  assert.equal(fromCm.length, 2);
  assert.ok(fromCm.some((x: any) => x.words.some((w: any) => w.use === 'Saha' && w.not === 'Wakha')));
  const mine: any = await call('dellal.lahja.list', shop, {});
  assert.equal(mine.own.filter((x: any) => x.via === 'cm').length, 2);
  // used at once in this shop (Dellal and the CM AI agent)
  assert.ok((await lahjaFor(db, t.platform, shopId)).own.some((w) => w.use === 'Saha'));
  // a reply the team wrote is not the agent's Darija
  const team = await add('c-team', 'Wakha, jawbnakom', null, true);
  await assert.rejects(call('cm.lahja.add', shop, { id: team, which: 'public', after: 'Saha, jawbnakom' }), /introuvable/);
  // the CM AI agent's instructions carry the lessons (every shop's, then the shop's own)
  const facts: any = { shop: 'B', channel: 'facebook', isAd: false, caption: null, product: null, catalog: [], place: null, phone: null, alreadyPrivate: false, alreadyPublic: false, tooOld: false, parent: null, lang: 'dz', author: null, body: 'ch7al ?' };
  const sys = cmSystem(facts, DEFAULT_CM, { all: [{ use: 'khouya' }], own: [{ use: 'Saha', not: 'Wakha' }] });
  assert.match(sys, /LEÇONS DE DARIJA \(validées par Pilotix pour toutes les boutiques\) :\n- utilise « khouya »/);
  assert.match(sys, /LEÇONS DE DARIJA DE LA BOUTIQUE[^\n]*\n- écris « Saha » au lieu de « Wakha »/);
  assert.doesNotMatch(cmSystem(facts, DEFAULT_CM), /LEÇONS DE DARIJA/);
  // CM AI agent › Tester: each test keeps what the agent would answer; the same lesson from there
  const tried: any = await call('cm.test', shop, { body: 'ch7al ?' });
  const kept = (await db.query(`SELECT body, public_reply, private_reply FROM cm_tests WHERE id = $1`, [tried.testId]))[0];
  assert.deepEqual([kept.body, kept.public_reply ?? null, kept.private_reply ?? null], ['ch7al ?', tried.decision.publicReply || null, tried.decision.privateReply || null]);
  const test = (await db.query(`INSERT INTO cm_tests (body, public_reply) VALUES ('ch7al ?', 'Wakha, nb3atlek f privé 👍') RETURNING id`))[0].id;
  const fromTest: any = await call('cm.lahja.test', shop, { testId: test, which: 'public', after: 'Saha, nb3atlek f privé 👍' });
  assert.deepEqual(fromTest.words, [{ use: 'Saha', not: 'Wakha' }]);
  assert.equal(((await call('dellal.lahja.list', shop, {})) as any).own.find((x: any) => x.id === fromTest.id).via, 'cm');
  // no private reply in that test: nothing to teach there
  await assert.rejects(call('cm.lahja.test', shop, { testId: test, which: 'private', after: 'Saha' }), /introuvable/);
});

test('the review: several lessons accepted or refused at once; one that fails stays waiting and says why', async () => {
  const pdb = t.platform;
  const ids: number[] = [];
  for (const [use, not] of [['bezzaf', 'ktir'], ['dorka', 'drk'], ['3la jal', null]] as const)
    ids.push(
      Number(
        (
          await pdb.query(`INSERT INTO platform.lahja (shop_id, source, status, own, words) VALUES ($1, 'seller', 'waiting', true, $2::jsonb) RETURNING id`, [
            shopId,
            JSON.stringify([not ? { use, not } : { use }]),
          ])
        )[0].id,
      ),
    );
  // one that no longer passes the checks (a number crept in): it stays waiting
  const bad = Number((await pdb.query(`INSERT INTO platform.lahja (shop_id, source, status, own, words) VALUES ($1, 'seller', 'waiting', true, '[{"use":"500 wakha"}]'::jsonb) RETURNING id`, [shopId]))[0].id);
  const r: any = await p('p.lahja.decideMany', { ids: [ids[0], ids[1], bad], action: 'approve' });
  assert.deepEqual(r.done.sort(), [ids[0], ids[1]].sort());
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].id, bad);
  assert.match(r.failed[0].error, /nombre/);
  assert.equal((await pdb.query(`SELECT status FROM platform.lahja WHERE id = $1`, [bad]))[0].status, 'waiting');
  await push();
  const all = (await lahjaFor(other, pdb, 999)).all.map((w) => w.use);
  assert.ok(all.includes('bezzaf') && all.includes('dorka'));
  // refused together; one already in every shop is said, not changed
  const r2: any = await p('p.lahja.decideMany', { ids: [ids[2], ids[0]], action: 'refuse' });
  assert.deepEqual(r2.done, [ids[2]]);
  assert.match(r2.failed[0].error, /n’attend plus/);
  assert.equal((await pdb.query(`SELECT status FROM platform.lahja WHERE id = $1`, [ids[0]]))[0].status, 'approved');
});
