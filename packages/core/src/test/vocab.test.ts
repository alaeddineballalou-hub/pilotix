// The vocabulary book (Pilot AI › Tester & leçons › Leçons › Vocabulaire): Pilotix's Darija words for every shop's AI
// agents, read word by word (only those that touch a chat), and taught by the corrections (accepted Darija lessons, a
// guide's corrected Arabic translation).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, staffLogin } from '../index';
import { makeSession } from '../rpc';
import { profileById } from '../modules/users';
import { getRaw, setRaw } from '../modules/admin';
import { parseVocab, vnorm, vocabBlock, vocabFor } from '../modules/vocab';
import { lahjaFor } from '../modules/lahja';
import { savePilotConfig } from '../platform/pilotai';
import { loadShops } from '../platform/shops';
import type { Tenancy } from '../platform/tenancy';

const OWNER = { email: 'owner@boutique.dz', password: 'Owner-Password-1' };
const NOW = Date.parse('2026-11-03T15:00:00Z');
let t: Tenancy;
let db: Db;
let pctx: PCtx;
let shop: Ctx;
const p = <T = any>(name: string, input: unknown = {}) => platformCall(name, pctx, input) as Promise<T>;
const reqs: any[] = [];
const hooks: ServerHooks = {
  courier: async () => ({}),
  meta: async () => ({}),
  hashPassword: async (x) => x,
  dellal: async (action, args: any) => {
    if (action !== 'complete') return { ok: true };
    reqs.push(args);
    // a guide's translation: its lines back, marked; Dellal: a short answer
    if (/Tu traduis le « guide de vente »/.test(String(args.system))) {
      const { lines } = JSON.parse(String(args.messages[0].content));
      const ar = /vers l’arabe/.test(String(args.system));
      return { content: [{ type: 'text', text: JSON.stringify({ lines: lines.map((x: string) => (ar ? 'عربة أطفال خفيفة تتطوى بيد وحدة.' : `EN: ${x}`)) }) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
    }
    return { content: [{ type: 'text', text: 'Saha khouya, kayna 👍' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
  },
};

const BOOK = `# Chapter 5 — Everyday life vocabulary

### 5.2 Home

| Arabic | Latin | Meaning |
|---|---|---|
| الكورسي | korsi | chaise |
| الطابلة | **tabla** | table |
| الفراش | lefrach | lit / matelas ⚠️ |

### Shopping

| Latin | Arabic | Meaning |
|---|---|---|
| karrossa | كروسة | poussette |
| ghalya | غالية | chère |

Some text between the tables.

| dispo | disponible |
| px | prix |
`;

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

test('a book in Markdown: its tables become words, under their chapter; a row marked ⚠️ is left out', () => {
  const r = parseVocab(BOOK);
  assert.equal(r.unsure, 1);
  assert.deepEqual(
    r.words.map((w) => [w.ar, w.lat, w.meaning, w.topic]),
    [
      ['الكورسي', 'korsi', 'chaise', '5.2 Home'],
      ['الطابلة', 'tabla', 'table', '5.2 Home'],
      ['كروسة', 'karrossa', 'poussette', 'Shopping'],
      ['غالية', 'ghalya', 'chère', 'Shopping'],
      ['', 'dispo', 'disponible', 'Shopping'],
      ['', 'px', 'prix', 'Shopping'],
    ],
  );
  assert.equal(vnorm('الطَّابلة'), vnorm('الطابله'), 'vowel marks and ta marbuta do not count');
  assert.equal(vnorm('Très'), 'tres');
});

test('Pilotix puts its book in: added once, a second time changes nothing, « replace » keeps what the corrections taught', async () => {
  const r: any = await p('p.vocab.import', { text: BOOK });
  assert.deepEqual([r.added, r.skipped, r.unsure, r.total], [6, 0, 1, 6]);
  const again: any = await p('p.vocab.import', { text: BOOK });
  assert.deepEqual([again.added, again.skipped], [0, 6]);
  const list: any = await p('p.vocab.list', { q: 'pousse' });
  assert.deepEqual(list.rows.map((w: any) => w.lat), ['karrossa']);
  assert.equal(list.counts.book, 6);
  assert.deepEqual(list.counts.topics.map((x: any) => [x.topic, x.n]), [['5.2 Home', 2], ['Shopping', 4]]);
  await assert.rejects(p('p.vocab.import', { text: 'pas de tableau ici' }), /Aucun mot/);
  // one word by hand, then corrected; the same word twice is refused
  const w: any = await p('p.vocab.save', { ar: 'خويا', lat: 'khouya', meaning: 'mon frère', topic: 'Famille' });
  await p('p.vocab.save', { id: w.id, ar: 'خويا', lat: 'khouya', meaning: 'mon frère (pour un client homme)', topic: 'Famille' });
  await assert.rejects(p('p.vocab.save', { lat: 'Khouya' }), /déjà dans le livre/);
  assert.equal((await p<any>('p.vocab.list', { source: 'coach' })).rows[0].meaning, 'mon frère (pour un client homme)');
  const replaced: any = await p('p.vocab.import', { text: '| كروسة | karrossa | poussette |\n| zouj | deux |', replace: true });
  assert.equal(replaced.added, 2);
  const all: any = await p('p.vocab.list', {});
  assert.deepEqual(all.rows.map((x: any) => x.lat).sort(), ['karrossa', 'khouya', 'zouj'], 'the book replaced, Pilotix’s own word kept');
  await p('p.vocab.import', { text: BOOK });
});

test('in a chat, only the words that touch it: what the customer wrote, in Darija or in French', async () => {
  const tried: any = await p('p.vocab.try', { text: 'Salam, 3andkom karrossa ? ghalya chwiya' });
  assert.deepEqual(tried.words.slice(0, 2).map((w: any) => w.lat).sort(), ['ghalya', 'karrossa']);
  assert.match(tried.block, /^Vocabulaire algérien/);
  assert.match(tried.block, /- كروسة \/ karrossa : poussette/);
  const fr = await vocabFor(t.platform, ['Je cherche une poussette']);
  assert.equal(fr[0].lat, 'karrossa', 'its meaning brings the Darija word');
  assert.deepEqual(await vocabFor(t.platform, ['bonjour']), []);
  assert.deepEqual(await vocabFor(null, ['karrossa']), [], 'no book here (the preview)');
  // Dellal: the words in the conversation's part of its instructions, not in the part every shop shares
  reqs.length = 0;
  const conv = (await db.query(`INSERT INTO conversations (channel, external_id) VALUES ('whatsapp', '213661234567') RETURNING id`))[0].id;
  await db.query(`INSERT INTO conv_messages (conversation_id, role, body) VALUES ($1, 'customer', 'salam, kayna karrossa ?')`, [conv]);
  await call('dellal.answer', shop, { id: Number(conv) });
  const blocks: string[] = reqs[0].systemBlocks.map(String);
  assert.doesNotMatch(blocks[0], /Vocabulaire algérien/);
  assert.match(blocks[blocks.length - 1], /Vocabulaire algérien[^\n]*\n- كروسة \/ karrossa : poussette/);
  assert.doesNotMatch(blocks[blocks.length - 1], /korsi/, 'a word the chat does not touch stays out');
});

test('an accepted lesson writes in the book (a word replaced, a new word); removed, the book is as it was', async () => {
  const fix: any = await p('p.lahja.add', { words: [{ use: 'kursi', not: 'korsi' }] });
  const chair = (await p<any>('p.vocab.list', { q: 'kursi' })).rows[0];
  assert.deepEqual([chair.ar, chair.lat, chair.avoid, chair.source, chair.lahjaId], ['الكورسي', 'kursi', 'korsi', 'book', fix.id]);
  assert.match(vocabBlock([chair]), /- الكورسي \/ kursi : chaise \(pas « korsi »\)/);
  const added: any = await p('p.lahja.add', { words: [{ use: 'sa7bi' }] });
  const learned = (await p<any>('p.vocab.list', { source: 'coach' })).rows.find((w: any) => w.lat === 'sa7bi');
  assert.equal(learned.topic, 'Appris des corrections');
  // removed: the chair is « korsi » again, the new word leaves
  await p('p.lahja.decide', { id: fix.id, action: 'remove' });
  await p('p.lahja.decide', { id: added.id, action: 'remove' });
  const back = (await p<any>('p.vocab.list', { q: 'chaise' })).rows[0];
  assert.deepEqual([back.lat, back.avoid, back.lahjaId], ['korsi', '', null]);
  assert.equal((await p<any>('p.vocab.list', { q: 'sa7bi' })).total, 0);
});

test('a guide’s Arabic translation corrected by the team: a lesson in the shop at once, then in the book once accepted', async () => {
  const prod: any = await call('catalog.saveProduct', shop, { name: 'Poussette canne', price: 12900, cost: 7000, maxDiscount: null });
  const line = 'Poussette légère qui se plie d’une main.';
  const s1: any = await call('catalog.saveGuide', shop, { id: prod.id, guide: { brief: line, lang: 'fr' } });
  assert.deepEqual(s1.trMissing, { ar: 1, en: 1 });
  // Pilot AI translates it: the book's words that touch the line are in its instructions
  reqs.length = 0;
  const tr: any = await call('catalog.translateGuide', shop, { id: prod.id });
  assert.equal(tr.by, 'ai');
  const toAr = reqs.find((r) => /vers l’arabe/.test(String(r.system)));
  assert.match(String(toAr.system), /Vocabulaire algérien[\s\S]*karrossa : poussette/);
  // the team writes the Algerian word instead
  const fixed: any = await call('catalog.saveGuide', shop, { id: prod.id, guide: { brief: line, lang: 'fr' }, tr: { ar: { [line]: 'كروسة خفيفة تتطوى بيد وحدة.' } } });
  assert.equal(fixed.tr.ar[line], 'كروسة خفيفة تتطوى بيد وحدة.');
  const mine = await lahjaFor(db, t.platform, shop.shop!.id);
  assert.ok(mine.own.some((w) => w.use.includes('كروسة')), 'used at once in this shop');
  const waiting = (await t.platform.query(`SELECT id, evidence FROM platform.lahja WHERE status = 'waiting' AND shop_id = $1 ORDER BY id DESC LIMIT 1`, [shop.shop!.id]))[0];
  assert.equal((typeof waiting.evidence === 'string' ? JSON.parse(waiting.evidence) : waiting.evidence).via, 'guide');
  // the same correction saved again teaches nothing more
  await call('catalog.saveGuide', shop, { id: prod.id, guide: { brief: line, lang: 'fr' }, tr: { ar: { [line]: 'كروسة خفيفة تتطوى بيد وحدة.' } } });
  assert.equal(Number((await db.query(`SELECT count(*)::int AS n FROM dellal_lahja`))[0].n), 1);
  // accepted by Pilotix: in the book, for every shop (the right word was there: what not to write goes with it)
  await p('p.lahja.decide', { id: Number(waiting.id), action: 'approve' });
  const word = (await p<any>('p.vocab.list', { q: 'karrossa' })).rows[0];
  assert.deepEqual([word.ar, word.avoid, word.lahjaId], ['كروسة', 'عربة أطفال', Number(waiting.id)]);
  assert.match((await p<any>('p.vocab.try', { text: 'عندكم كروسة ؟' })).block, /- كروسة \/ karrossa : poussette \(pas « عربة أطفال »\)/);
});
