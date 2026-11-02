// The Darija book (Pilot AI › Tester & leçons › Leçons › Darija): the rules of Algerian Darija Dellal and the CM AI agent
// read before every reply, apart from the sales book. Version 1 is the guide of the code; every change is a new version used
// at once (an edit of the rules, a lesson accepted, removed or added); going back to an older version brings back its rules
// and its lessons.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, staffLogin } from '../index';
import { makeSession } from '../rpc';
import { profileById } from '../modules/users';
import { getRaw, setRaw } from '../modules/admin';
import { DELLAL_DARIJA } from '../modules/darija';
import { checkDarijaBook, darijaGuide, darijaText, guideChapters } from '../modules/darijabook';
import { lahjaFor } from '../modules/lahja';
import { cmSystem, DEFAULT_CM } from '../modules/cm';
import { savePilotConfig } from '../platform/pilotai';
import { loadShops } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const NOW = Date.parse('2026-11-02T20:00:00Z');
let t: Tenancy;
let db: Db;
let pctx: PCtx;
let shop: Ctx;
const other: Db = { query: async () => [], tx: async (f: any) => f(other) } as any;
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

before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  t = pgliteTenancy(new PGlite() as any);
  await migrate(t.shop('public'), (sql) => t.exec('public', sql));
  await seedBase(t.shop('public'), { ...OWNER, name: 'Amine' });
  await migrateAll(t);
  const { staff } = await staffLogin(t, OWNER.email, OWNER.password);
  pctx = { t, staff, now: () => NOW };
  const shopId = (await loadShops(t)).find((s) => s.kind === 'store')!.id;
  db = t.shop('public');
  const admin = (await db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) AND active ORDER BY id LIMIT 1`))[0];
  const session = makeSession((await profileById(db, Number(admin.id)))!);
  shop = { db, session, now: () => NOW, emit: () => undefined, server: hooks, t, shop: { id: shopId, slug: 'boutique', primary: true, features: null, locked: false, demo: false, maxUsers: null, maxDrivers: null } };
  await savePilotConfig(t, { enabled: true, maxUsd: 0.15, share: 0.2 }, 'sk-ant-api03-test-key-0123456789');
  await setRaw(db, 'dellal', { ...(await getRaw<Record<string, unknown>>(db, 'dellal', {})), enabled: true }, Number(admin.id));
});

/** Dellal answers one customer message: the shared block of its instructions */
async function sharedBlock(): Promise<string> {
  reqs.length = 0;
  const conv = (await db.query(`INSERT INTO conversations (channel, external_id) VALUES ('whatsapp', $1) RETURNING id`, [`21366${Math.floor(1e6 + Math.random() * 8e6)}`]))[0].id;
  await db.query(`INSERT INTO conv_messages (conversation_id, role, body) VALUES ($1, 'customer', 'salam, mazal kayen ?')`, [conv]);
  await call('dellal.answer', shop, { id: Number(conv) });
  return String(reqs[0].systemBlocks[0]);
}

test('the guide of the code, in chapters: read back exactly, letters set by order', () => {
  const g = guideChapters();
  assert.match(g.title, /^DARIJA ALGÉRIENNE/);
  assert.deepEqual(g.chapters.map((c) => c.title.split(' ')[0]), ['Registre', 'Les', 'Grammaire', 'Homme,', 'Tournures', 'À', 'Régions', 'Exemples']);
  assert.equal(darijaText(g), DELLAL_DARIJA.trim(), 'nothing lost or added');
  assert.deepEqual(checkDarijaBook(g), []);
  assert.deepEqual(checkDarijaBook({ title: 'x', chapters: [] }), ['empty']);
  assert.ok(checkDarijaBook({ title: 'x', chapters: [{ title: 'A. Registre', text: 'y' }] }).includes('chapter_title'), 'the letter is set by the book');
  assert.ok(checkDarijaBook({ title: 'x', chapters: [{ title: 'Grand', text: 'y'.repeat(9000) }] }).includes('chapter_text'));
});

test('version 1 is the guide; an edit is a new version used at once by Dellal and the CM AI agent', async () => {
  const first: any = await p('p.darija.book');
  assert.equal(first.book.version, 1);
  assert.equal(first.book.kind, 'first');
  assert.equal(first.book.chapters.length, 8);
  assert.match(await sharedBlock(), /A\. Registre/);

  // Pilotix writes a new rule in chapter A and adds a chapter
  const chapters = first.book.chapters.map((c: any, i: number) => (i === 0 ? { ...c, text: c.text + '\n- Dis « saha » pour dire d’accord, jamais « wakha ».' } : c));
  chapters.push({ title: 'Mots de Sétif', text: '- À Sétif, les clients disent « wesh rak » : réponds pareil.' });
  const r: any = await p('p.darija.save', { chapters, note: 'saha, Sétif' });
  assert.equal(r.version, 2);
  const block = await sharedBlock();
  assert.match(block, /- Dis « saha » pour dire d’accord, jamais « wakha »\./);
  assert.match(block, /I\. Mots de Sétif\n- À Sétif/, 'the new chapter gets the next letter');
  assert.match(cmSystem({ shop: 'B', channel: 'facebook', isAd: false, caption: null, product: null, catalog: [], place: null, phone: null, alreadyPrivate: false, alreadyPublic: false, tooOld: false, parent: null, lang: 'dz', author: null, body: 'ch7al ?' } as any, DEFAULT_CM, { all: [], own: [] }, await darijaGuide(t.platform)), /I\. Mots de Sétif/);
  // the same text again changes nothing; a broken book is refused and changes nothing
  await assert.rejects(p('p.darija.save', { chapters }), /rien n’a changé/);
  await assert.rejects(p('p.darija.save', { chapters: [{ title: 'Vide', text: '' }] }), /vide/);
  assert.equal((await p('p.darija.book')).book.version, 2);
  // without the platform (the preview, an install of its own): the guide of the code
  assert.equal(await darijaGuide(null), DELLAL_DARIJA);
});

test('lessons for every shop: each change is a version; going back brings back the rules and the lessons of that time', async () => {
  const pdb = t.platform;
  // Pilotix adds a lesson (v3), a shop's lesson is accepted (v4), then removed (v5); a refusal is not a version
  await p('p.lahja.add', { words: [{ use: 'khouya' }] });
  const seller = Number((await pdb.query(`INSERT INTO platform.lahja (shop_id, source, status, own, words) VALUES (1, 'seller', 'waiting', true, '[{"use":"saha","not":"wakha"}]'::jsonb) RETURNING id`))[0].id);
  await p('p.lahja.decide', { id: seller, action: 'approve' });
  const refused = Number((await pdb.query(`INSERT INTO platform.lahja (shop_id, source, status, own, words) VALUES (1, 'seller', 'waiting', true, '[{"use":"bezzaf"}]'::jsonb) RETURNING id`))[0].id);
  await p('p.lahja.decide', { id: refused, action: 'refuse' });
  let st: any = await p('p.darija.book');
  assert.equal(st.book.version, 4);
  assert.deepEqual(st.book.lessons.map((l: any) => l.words[0].use), ['khouya', 'saha']);
  assert.match(st.versions[0].note, /Leçon acceptée : « wakha » → « saha »/);
  assert.equal(st.versions.length, 4);
  await p('p.lahja.decide', { id: seller, action: 'remove' });
  st = await p('p.darija.book');
  assert.equal(st.book.version, 5);
  assert.match(st.versions[0].note, /Leçon retirée/);

  // back to version 2: its rules (with « Mots de Sétif »), and its lessons (none: « khouya » goes, « saha » stays out)
  const back: any = await p('p.darija.restore', { version: 2 });
  assert.equal(back.version, 6);
  st = await p('p.darija.book');
  assert.equal(st.book.kind, 'restore');
  assert.match(st.book.note, /Retour à la version 2/);
  assert.equal(st.book.chapters.at(-1).title, 'Mots de Sétif');
  assert.deepEqual(st.book.lessons, []);
  assert.deepEqual((await lahjaFor(other, pdb, 999)).all, [], 'no shop uses « khouya » any more');
  // and forward again to version 4: « khouya » and « saha » come back for every shop
  await p('p.darija.restore', { version: 4 });
  assert.deepEqual((await lahjaFor(other, pdb, 999)).all.map((w) => w.use).sort(), ['khouya', 'saha']);
  await assert.rejects(p('p.darija.restore', { version: 7 }), /déjà en service/);
  await assert.rejects(p('p.darija.restore', { version: 99 }), /introuvable/);
});

test('the book as a file: the rules then the lessons; an old version too; the sales book has no Darija', async () => {
  const f: any = await p('p.darija.file');
  assert.match(f.text, /^DELLAL & CM AI — LE LIVRE DE DARIJA/);
  assert.match(f.text, /Version 7, du/);
  assert.match(f.text, /1\. LES RÈGLES[\s\S]*A\. Registre[\s\S]*I\. Mots de Sétif/);
  assert.match(f.text, /2\. LES LEÇONS DE DARIJA POUR TOUTES LES BOUTIQUES \(2\)\n[─]+\n\n- utilise « khouya » quand ça va\n- écris « saha » au lieu de « wakha »/);
  const old: any = await p('p.darija.file', { version: 1 });
  assert.match(old.text, /ancienne version/);
  assert.doesNotMatch(old.text, /Mots de Sétif/);
  const sales: any = await p('p.pilot.bookText');
  assert.doesNotMatch(sales.text, /A\. Registre/);
});
