// Pilot AI's two pushes (control room › Pilot AI): nothing Pilotix changes reaches the shops at once.
//  - « Push en test »: everything waiting — the sales lessons (the nights' ones approved by the pusher), the Darija lessons
//    Pilotix accepted (and the shops' ones waiting, with the box), the Darija rules' draft, the vocabulary's working copy —
//    becomes one version that only the control room's test chat uses;
//  - « Push sur le serveur »: exactly that version goes out to every shop at once.
// An edit made after « Push en test » waits for the next one; a lesson of the version refused since makes it out of date.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Ctx, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, staffLogin } from '../index';
import { makeSession } from '../rpc';
import { profileById } from '../modules/users';
import { getRaw, setRaw } from '../modules/admin';
import { bookFor, SEEDS } from '../modules/pilotlearn';
import { darijaGuide } from '../modules/darijabook';
import { lahjaFor } from '../modules/lahja';
import { vocabFor } from '../modules/vocab';
import { savePilotConfig } from '../platform/pilotai';
import { loadShops } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const NOW = Date.parse('2026-11-05T17:00:00Z');
let t: Tenancy;
let pctx: PCtx;
let shopId: number;
let me = '';
/** another shop: no lessons of its own (what « every shop » sees) */
const other: any = { query: async () => [], tx: async (f: any) => f(other) };
const p = <T = any>(name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<T>;
const reqs: any[] = [];
const hooks: ServerHooks = {
  courier: async () => ({}),
  meta: async () => ({}),
  hashPassword: async (x) => x,
  dellal: async (action, args) => {
    if (action !== 'complete') return { ok: true };
    reqs.push(args);
    return { content: [{ type: 'text', text: 'Saha khouya, nb3atlek tsawer dorka 👍' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  },
};
let fp = 0;
const lesson = async (key: string, status: 'candidate' | 'approved', source = 'ai'): Promise<number> =>
  Number(
    (
      await t.platform.query(`INSERT INTO platform.pilot_lessons (topic, text, status, source, prio, fp) VALUES ($1, $2, $3, $4, 1, $5) RETURNING id`, [
        SEEDS[key][0],
        SEEDS[key][1],
        status,
        source,
        `rel-${++fp}`,
      ])
    )[0].id,
  );
const shopLesson = async (words: unknown): Promise<number> =>
  Number((await t.platform.query(`INSERT INTO platform.lahja (shop_id, source, status, own, words) VALUES (1, 'seller', 'waiting', true, $1::jsonb) RETURNING id`, [JSON.stringify(words)]))[0].id);
const state = async () => (await p('p.pilot.state')).release;
/** what a shop's Dellal reads right now: the sales book, the Darija rules, the lessons for every shop, the vocabulary */
const shops = async (word: string) => ({
  version: (await bookFor(t.platform, { shopId: 1, convId: 5000 + ++fp })).version,
  rules: await darijaGuide(t.platform),
  lahja: (await lahjaFor(other, t.platform, 999)).all.map((w) => w.use || `!${w.not}`),
  vocab: (await vocabFor(t.platform, [word])).map((w) => w.lat),
});
/** one message in the control room's test chat: the instructions Dellal got */
const tryWith = async (book: string, body: string): Promise<string> => {
  reqs.length = 0;
  await p('p.pilot.try', { shopId, book, body, reset: true });
  return reqs.map((r) => (r.systemBlocks ?? [r.system]).join('\n')).join('\n');
};

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  me = staff.name || staff.email;
  shopId = (await loadShops(t)).find((s) => s.kind === 'store')!.id;
  const db = t.shop('public');
  const admin = (await db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) AND active ORDER BY id LIMIT 1`))[0];
  const session = makeSession((await profileById(db, Number(admin.id)))!);
  const shop = async (id: number): Promise<Ctx> => ({ db, session, shop: { id, slug: 'boutique', primary: true, features: null, locked: false, demo: false, maxUsers: null, maxDrivers: null }, now: () => NOW, emit: () => undefined, server: hooks, t });
  pctx = { t, staff, now: () => NOW, shop };
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 }, 'sk-ant-api03-test-key-0123456789');
  await setRaw(db, 'dellal', { ...(await getRaw<Record<string, unknown>>(db, 'dellal', {})), enabled: true }, Number(admin.id));
  // the Darija book's first version (the guide of the code)
  await p('p.darija.book');
});

test('nothing waiting: « Push en test » says so; there is nothing to push to the server', async () => {
  await assert.rejects(p('p.pilot.stage'), /Rien de nouveau/);
  const s = await state();
  assert.equal(s.trial, null);
  assert.deepEqual(s.pending, { candidates: 0, sales: 0, waiting: 0, darija: 0, rules: false, vocab: { added: 0, changed: 0, removed: 0, total: 0 } });
  await assert.rejects(p('p.pilot.try', { shopId, book: 'trial', body: 'salam' }), /Push en test/);
});

test('everything waits: a lesson, a Darija lesson, a rule and a word reach no shop until the push', async () => {
  const before = await shops('tbarkallah');
  await lesson('refused', 'candidate');
  await lesson('address', 'approved', 'coach');
  const seller = await shopLesson([{ use: 'saha', not: 'wakha' }]);
  const coach: any = await p('p.lahja.add', { words: [{ use: 'khouya' }] });
  // accepting a shop's lesson: it goes out with the next push, not now
  const sellerOk: any = await p('p.lahja.decide', { id: seller, action: 'approve' });
  assert.equal(sellerOk.ok, true);
  assert.equal((await t.platform.query(`SELECT status FROM platform.lahja WHERE id = $1`, [seller]))[0].status, 'accepted');
  const waiting = await shopLesson([{ use: '3la jal', not: 'pour' }]);
  const book: any = await p('p.darija.book');
  const chapters = book.book.chapters.map((c: any, i: number) => (i === 0 ? { ...c, text: c.text + '\n- Mots de Sétif : « dorka » se dit partout.' } : c));
  assert.deepEqual(await p('p.darija.save', { chapters }), { draft: true });
  await p('p.vocab.save', { ar: 'تبارك الله', lat: 'tbarkallah', meaning: 'bravo, que Dieu bénisse', topic: 'Politesse' });
  // nothing reached the shops
  assert.deepEqual(await shops('tbarkallah'), before);
  assert.doesNotMatch((await shops('x')).rules, /Mots de Sétif/);
  // the control room sees what waits
  const s = await state();
  assert.equal(s.trial, null);
  assert.deepEqual({ ...s.pending, vocab: s.pending.vocab.total > 0 }, { candidates: 1, sales: 1, waiting: 1, darija: 2, rules: true, vocab: true });
  const darija: any = await p('p.darija.book');
  assert.equal(darija.draft.by, me);
  assert.equal(darija.book.version, 1, 'the book in service did not change');
  const vocab: any = await p('p.vocab.list', { q: 'tbarkallah' });
  assert.equal(vocab.rows.length, 1, 'the working copy has the word');
  assert.ok(vocab.changes.added >= 1);
  assert.ok(coach.id && waiting);
});

test('« Push en test »: one version for the control room’s test chat only; the shops still see nothing new', async () => {
  const before = await shops('tbarkallah');
  const r: any = await p('p.pilot.stage', { darija: true });
  assert.deepEqual({ version: r.version, approved: r.approved, skipped: r.skipped, accepted: r.accepted }, { version: 1, approved: 1, skipped: 0, accepted: 1 });
  // the nights' lesson approved in the pusher's name, the shop's waiting lesson accepted
  assert.equal((await t.platform.query(`SELECT count(*)::int AS n FROM platform.pilot_lessons WHERE status = 'candidate'`))[0].n, 0);
  assert.equal((await t.platform.query(`SELECT count(*)::int AS n FROM platform.lahja WHERE status = 'waiting'`))[0].n, 0);
  const s = await state();
  assert.equal(s.trial.version, 1);
  assert.equal(s.trial.by, me);
  assert.deepEqual(s.trial.sales, { lessons: 2, fresh: 2, gone: 0, dropped: 0, changed: true });
  assert.deepEqual(s.trial.darija, { rules: true, lessons: 3 });
  assert.ok(s.trial.vocab.added >= 1);
  assert.deepEqual(s.trial.stale, { sales: 0, darija: 0 });
  assert.deepEqual({ ...s.pending, vocab: s.pending.vocab.total }, { candidates: 0, sales: 0, waiting: 0, darija: 0, rules: false, vocab: 0 }, 'everything is in the version in test');
  assert.deepEqual(await shops('tbarkallah'), before, 'the shops still use what they used');
  // the test chat on the version in test: its sales book, its Darija rules, its Darija lessons, its vocabulary
  const trial = await tryWith('trial', 'salam, tbarkallah 3likom, ch7al la livraison ?');
  assert.match(trial, new RegExp(SEEDS.refused[1].slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(trial, /Mots de Sétif/);
  assert.match(trial, /écris « saha » au lieu de « wakha »/);
  assert.match(trial, /utilise « khouya »/);
  assert.match(trial, /tbarkallah : bravo/);
  // the test chat on the version in service: none of it
  const live = await tryWith('live', 'salam, tbarkallah 3likom, ch7al la livraison ?');
  assert.doesNotMatch(live, /Mots de Sétif|au lieu de « wakha »|utilise « khouya »|tbarkallah : bravo/);
  assert.doesNotMatch(live, new RegExp(SEEDS.refused[1].slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // the same push twice: nothing new to make
  await assert.rejects(p('p.pilot.stage'), /a déjà tout ce qui attend/);
});

test('« Push sur le serveur »: the version tested goes out to every shop at once', async () => {
  const s = await state();
  const r: any = await p('p.pilot.release', { id: s.trial.id });
  assert.deepEqual({ version: r.version, previous: r.previous, stoppedTest: r.stoppedTest }, { version: 1, previous: null, stoppedTest: null });
  assert.equal(r.darijaVersion, 2, 'the Darija book has a new version');
  const now = await shops('tbarkallah');
  assert.equal(now.version, 1);
  assert.match(now.rules, /Mots de Sétif/);
  assert.deepEqual(now.lahja.sort(), ['3la jal', 'khouya', 'saha']);
  assert.deepEqual(now.vocab, ['tbarkallah']);
  const after = await state();
  assert.equal(after.trial, null);
  assert.equal(after.live.version, 1);
  assert.deepEqual(after.lastPush, { version: 1, by: me, at: new Date(NOW).toISOString() });
  assert.deepEqual({ ...after.pending, vocab: after.pending.vocab.total }, { candidates: 0, sales: 0, waiting: 0, darija: 0, rules: false, vocab: 0 });
  const darija: any = await p('p.darija.book');
  assert.equal(darija.draft, null, 'the draft went out: no draft any more');
  assert.equal(darija.versions[0].kind, 'push');
  assert.match(darija.versions[0].note, /Push sur le serveur de la v1/);
  assert.equal((await t.platform.query(`SELECT count(*)::int AS n FROM platform.lahja WHERE status = 'approved'`))[0].n, 3);
  await assert.rejects(p('p.pilot.release', { id: s.trial.id }), /déjà sur le serveur/);
  // the test chat in service now has it all
  assert.match(await tryWith('live', 'tbarkallah'), /Mots de Sétif[\s\S]*utilise « khouya »/);
});

test('an edit after « Push en test » waits for the next one; a lesson refused since makes the version in test out of date', async () => {
  await lesson('mismatch', 'approved', 'coach');
  const fix: any = await p('p.lahja.add', { words: [{ use: 'mlih', not: 'kwayes' }] });
  const v2: any = await p('p.pilot.stage');
  assert.equal(v2.version, 2);
  // after the push to the test version: a new word waits for the next one
  await p('p.vocab.save', { lat: 'sa7bi', meaning: 'mon ami', topic: 'Politesse' });
  let s = await state();
  assert.equal(s.trial.version, 2);
  assert.equal(s.pending.vocab.added, 1, 'the new word is not in the version in test');
  const vocab: any = await p('p.vocab.list', { q: 'sa7bi' });
  assert.equal(vocab.notInTrial.added, 1);
  // a Darija lesson of v2 refused: v2 is out of date, it cannot go out as it is
  await p('p.lahja.decide', { id: fix.id, action: 'refuse' });
  s = await state();
  assert.deepEqual(s.trial.stale, { sales: 0, darija: 1 });
  await assert.rejects(p('p.pilot.release', { id: s.trial.id }), /a changé/);
  assert.equal((await p<any>('p.vocab.list', { q: 'kwayes' })).total, 0, 'its words left the working copy');
  // pushed to test again: v3, with the new word and without the refused lesson; v2 replaced
  const v3: any = await p('p.pilot.stage');
  assert.equal(v3.version, 3);
  await assert.rejects(p('p.pilot.release', { id: s.trial.id }), /remplacée/);
  s = await state();
  assert.deepEqual(s.trial.darija, { rules: false, lessons: 0 });
  assert.equal(s.trial.sales.fresh, 1);
  await p('p.pilot.release', { id: s.trial.id });
  const now = await shops('sa7bi');
  assert.equal(now.version, 3);
  assert.deepEqual(now.vocab, ['sa7bi']);
  assert.ok(!now.lahja.includes('mlih'));
  const books = (await p('p.pilot.state')).books.books.map((b: any) => `v${b.version} ${b.status}`);
  assert.deepEqual(books, ['v3 champion', 'v2 replaced', 'v1 retired']);
});

test('a running A/B test stops at the push; « Revenir au livre précédent » brings the sales book before back', async () => {
  await lesson('price', 'approved', 'coach');
  const pub: any = await p('p.pilot.publish');
  assert.equal(pub.version, 4);
  await lesson('fee', 'approved', 'coach');
  const v5: any = await p('p.pilot.stage');
  const r: any = await p('p.pilot.release', { id: (await state()).trial.id });
  assert.deepEqual([v5.version, r.version, r.previous, r.stoppedTest], [5, 5, 3, pub.testId]);
  const test = (await t.platform.query(`SELECT status, why FROM platform.pilot_tests WHERE id = $1`, [pub.testId]))[0];
  assert.deepEqual([test.status, test.why], ['stopped', 'push']);
  assert.equal((await shops('x')).version, 5);
  await p('p.pilot.rollback');
  assert.equal((await shops('x')).version, 3);
});

test('removing a Darija lesson every shop uses: off every shop at once, its words too', async () => {
  const saha = (await t.platform.query(`SELECT id FROM platform.lahja WHERE status = 'approved' AND words @> '[{"use":"saha"}]'::jsonb`))[0];
  await p('p.lahja.decide', { id: Number(saha.id), action: 'remove' });
  assert.ok(!(await shops('x')).lahja.includes('saha'));
  const versions = (await p<any>('p.darija.book')).versions;
  assert.match(versions[0].note, /Leçon retirée/);
});

test('the vocabulary: « Annuler les changements » brings the working copy back to the live book; the rules’ draft can be thrown away', async () => {
  await p('p.vocab.save', { lat: 'ya3tik sa7a', meaning: 'merci', topic: 'Politesse' });
  assert.equal((await state()).pending.vocab.added, 1);
  const r: any = await p('p.vocab.reset');
  assert.equal(r.total, 0);
  assert.equal((await p<any>('p.vocab.list', { q: 'ya3tik' })).total, 0);
  const book: any = await p('p.darija.book');
  const chapters = book.book.chapters.map((c: any, i: number) => (i === 1 ? { ...c, text: c.text + '\n- Essai.' } : c));
  await p('p.darija.save', { chapters });
  assert.equal((await state()).pending.rules, true);
  await p('p.darija.discard');
  assert.equal((await state()).pending.rules, false);
  await assert.rejects(p('p.darija.discard'), /Pas de brouillon/);
  // edited back to the rules in service: no draft
  await p('p.darija.save', { chapters });
  assert.deepEqual(await p('p.darija.save', { chapters: book.book.chapters }), { draft: false });
});
