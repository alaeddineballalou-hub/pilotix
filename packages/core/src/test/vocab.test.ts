// The vocabulary book (Pilot AI › Tester & leçons › Leçons › Vocabulaire): Pilotix's Darija words for every shop's AI
// agents, read word by word (only those that touch a chat), and taught by the corrections (accepted Darija lessons, a
// guide's corrected Arabic translation).
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { call, Ctx, Db, migrate, migrateAll, PCtx, pgliteTenancy, platformCall, seedBase, ServerHooks, staffLogin } from '../index';
import { makeSession } from '../rpc';
import { profileById } from '../modules/users';
import { getRaw, setRaw } from '../modules/admin';
import { parseVocab, readCentimes, sameWord, vnorm, vocabBlock, vocabFor, vskel } from '../modules/vocab';
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
/** « Push en test » then « Push sur le serveur »: the working copy goes out to every shop */
const push = async () => {
  await p('p.pilot.stage', { darija: false });
  await p('p.pilot.release', { id: (await p('p.pilot.state')).release.trial.id });
};
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
  // a reverse dictionary (English → Darija) is not read twice
  const rev = parseVocab('## Reverse\n\n| English | Darija |\n|---|---|\n| chair | korsi (الكورسي) |\n\n## Words\n\n| Arabic | Latin | Meaning |\n|---|---|---|\n| الكورسي | korsi | chair |');
  assert.deepEqual(rev.words.map((w) => [w.ar, w.lat, w.meaning]), [['الكورسي', 'korsi', 'chair']]);
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
  // the book is in the working copy: no shop reads it before the push
  assert.deepEqual(await vocabFor(t.platform, ['karrossa']), []);
  await push();
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

test('an accepted lesson writes in the book (a word replaced, a new word); refused, or removed after the push, the book is as it was', async () => {
  const fix: any = await p('p.lahja.add', { words: [{ use: 'kursi', not: 'korsi' }] });
  const chair = (await p<any>('p.vocab.list', { q: 'kursi' })).rows[0];
  assert.deepEqual([chair.ar, chair.lat, chair.avoid, chair.source, chair.lahjaId], ['الكورسي', 'kursi', 'korsi', 'book', fix.id]);
  assert.match(vocabBlock([chair]), /- الكورسي \/ kursi : chaise \(pas « korsi »\)/);
  const added: any = await p('p.lahja.add', { words: [{ use: 'sa7bi' }] });
  const learned = (await p<any>('p.vocab.list', { source: 'coach' })).rows.find((w: any) => w.lat === 'sa7bi');
  assert.equal(learned.topic, 'Appris des corrections');
  assert.deepEqual((await vocabFor(t.platform, ['kursi'])).map((w) => w.lat), ['korsi'], 'the shops still read « korsi »');
  // refused before the push: the chair is « korsi » again, the new word leaves
  await p('p.lahja.decide', { id: fix.id, action: 'refuse' });
  await p('p.lahja.decide', { id: added.id, action: 'refuse' });
  const back = (await p<any>('p.vocab.list', { q: 'chaise' })).rows[0];
  assert.deepEqual([back.lat, back.avoid, back.lahjaId], ['korsi', '', null]);
  assert.equal((await p<any>('p.vocab.list', { q: 'sa7bi' })).total, 0);
  // accepted again and pushed: every shop reads « kursi »; removed: every copy is as it was, at once
  const again: any = await p('p.lahja.add', { words: [{ use: 'kursi', not: 'korsi' }] });
  await push();
  assert.deepEqual((await vocabFor(t.platform, ['kursi'])).map((w) => [w.lat, w.avoid]), [['kursi', 'korsi']]);
  await p('p.lahja.decide', { id: again.id, action: 'remove' });
  assert.deepEqual((await vocabFor(t.platform, ['chaise'])).map((w) => [w.lat, w.avoid]), [['korsi', '']]);
  assert.deepEqual((await p<any>('p.vocab.list', { q: 'chaise' })).rows.map((w: any) => w.lat), ['korsi']);
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

test('one word, any spelling: wach / wesh / wech, ch7al / chhal, bezzaf / bzaf', () => {
  assert.equal(vskel('wach'), vskel('wesh'));
  assert.equal(vskel('wech'), vskel('wsh'));
  assert.equal(vskel('ch7al'), vskel('chhal'));
  assert.equal(vskel('sh7al'), vskel('ch7al'));
  assert.equal(vskel('bezzaf'), vskel('bzaf'));
  assert.equal(vskel('9oddam'), vskel('goddam'));
  assert.equal(vskel('ya3tik'), vskel('yatik'));
  assert.ok(sameWord('wesh', 'wach') && sameWord('chhal', 'ch7al') && sameWord('bzaf', 'bezzaf') && sameWord('karossa', 'karrossa'));
  assert.ok(!sameWord('kursi', 'karrossa'), 'same bones (k-r-s), another word');
  assert.equal(vskel('كروسة'), '', 'Arabic letters: no bones');
  assert.equal(vskel('2026'), '');
});

test('prices said in centimes are read in dinars, never a phone number or a plain quantity', () => {
  const da = (s: string) => readCentimes([s]).map((p) => [p.said, p.da, p.guess, p.dinars]);
  assert.deepEqual(da('ch7al mlyoun w nos l stif?'), [['mlyoun w nos', 15000, false, false]]);
  assert.deepEqual(da('nos mlyoun'), [['nos mlyoun', 5000, false, false]]);
  assert.deepEqual(da('mlyoun w mitin'), [['mlyoun w mitin', 12000, false, false]]);
  assert.deepEqual(da('zouj mlayen'), [['zouj mlayen', 20000, false, false]]);
  assert.deepEqual(da('mitin alf'), [['mitin alf', 2000, false, false]]);
  assert.deepEqual(da('mitin w khamsin ?'), [['mitin w khamsin', 2500, true, false]], '« alf » left out: a guess');
  assert.deepEqual(da('tlatmya w tes3in alf'), [['tlatmya w tes3in alf', 3900, false, false]]);
  assert.deepEqual(da('alf dinar'), [['alf dinar', 1000, false, true]], 'said in dinars: nothing to divide');
  assert.deepEqual(da('شحال مليون ونص؟'), [['مليون و نص', 15000, false, false]]);
  assert.deepEqual(da('15 alf'), [['15 alf', 150, false, false]]);
  assert.deepEqual(da('0661234567 wa7ed b 3900 da'), [], 'a phone, a quantity, a price in DA: nothing to read');
  // in the AI's instructions, after the words (or alone when no word of the book is touched)
  assert.equal(vocabBlock([], ['salam']), '');
  assert.match(vocabBlock([], ['ch7al mlyoun w nos']), /^Prix dits en mots[^\n]*\n- « mlyoun w nos » = 15 000 DA$/);
  assert.match(vocabBlock([], ['mitin w khamsin']), /= 2 500 DA \(« alf » sous-entendu : vérifie avec le client\)/);
});

test('the test box: words found in another spelling, the prices read, the time and the size', async () => {
  const tried: any = await p('p.vocab.try', { text: 'salam, 3andkom karossa ? ch7al nos mlyoun ?' });
  assert.ok(tried.words.some((w: any) => w.lat === 'karrossa'), 'karossa (one r) still finds karrossa');
  assert.deepEqual((await vocabFor(t.platform, ['kursi'])).map((w) => w.lat), ['korsi'], 'kursi finds korsi, not karrossa');
  assert.deepEqual(tried.prices.map((x: any) => [x.said, x.da]), [['nos mlyoun', 5000]]);
  assert.match(tried.block, /Vocabulaire algérien[\s\S]*\n\nPrix dits en mots[\s\S]*« nos mlyoun » = 5 000 DA/);
  assert.equal(typeof tried.ms, 'number');
  assert.ok(tried.tokens > 0 && tried.tokens < 400);
  // Dellal reads the prices the customer said
  reqs.length = 0;
  const conv = (await db.query(`INSERT INTO conversations (channel, external_id) VALUES ('whatsapp', '213661234599') RETURNING id`))[0].id;
  await db.query(`INSERT INTO conv_messages (conversation_id, role, body) VALUES ($1, 'customer', 'salam, karrossa b mlyoun w nos ?')`, [conv]);
  await call('dellal.answer', shop, { id: Number(conv) });
  const last = String(reqs[0].systemBlocks[reqs[0].systemBlocks.length - 1]);
  assert.match(last, /« mlyoun w nos » = 15 000 DA/);
});
