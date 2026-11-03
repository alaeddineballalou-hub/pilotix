// The vocabulary book (Pilot AI › Tester & leçons › Leçons › Vocabulaire): the Algerian Darija words Pilotix gives the AI
// agents of every shop, each in Arabic letters, in Latin letters, and with its meaning. Pilotix puts its book in (a
// Markdown file with tables, pasted or uploaded), edits it word by word, and the corrections teach it more:
//  - a correction of the AI (Dellal's messages, the CM AI agent's replies, the control room's test chat, a guide's Arabic
//    translation) becomes a Darija lesson (lahja.ts): used at once in its shop, then accepted by Pilotix for every shop;
//    an accepted lesson writes its words in the book (a word replaced, or a new word), and removing it takes them back;
//  - in a chat, Dellal and the CM AI agent read only the words of the book that touch what is said (the customer's words,
//    the post, the product), and so does Pilot AI when it translates a guide into Arabic: a big book costs nothing more.
// The book lives in Pilotix's database (schema `platform`); without it (the preview, a single shop) there is no book.
import { Db, iso, num } from '../db';
import type { LahjaWord } from './lahja';

export type VocabSource = 'book' | 'learned' | 'coach';
export interface VocabWord {
  id: number;
  /** the word in Arabic letters */
  ar: string;
  /** the same word in Latin letters (as Algerians write it: 3, 7, 9…) */
  lat: string;
  /** what it means (French, or English) */
  meaning: string;
  /** the chapter it comes from (« 5.1 Family »), or « Appris des corrections » */
  topic: string;
  /** what not to write instead (a lesson's old word) */
  avoid: string;
  /** book: from Pilotix's book; learned: a shop's correction accepted by Pilotix; coach: Pilotix's own correction */
  source: VocabSource;
  lahjaId: number | null;
  by: string | null;
  updatedAt: string;
}
export type VocabInput = Pick<VocabWord, 'ar' | 'lat' | 'meaning' | 'topic' | 'avoid'>;

export const VOCAB = { maxWords: 20_000, maxLen: 200, maxImport: 800_000, promptWords: 40, pageMax: 1000, learnedTopic: 'Appris des corrections' };

export const VOCAB_PLATFORM_SQL = `
CREATE TABLE IF NOT EXISTS platform.vocab (
  id bigserial PRIMARY KEY,
  ar text NOT NULL DEFAULT '',
  lat text NOT NULL DEFAULT '',
  meaning text NOT NULL DEFAULT '',
  topic text NOT NULL DEFAULT '',
  avoid text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'book',
  lahja_id bigint,
  prev jsonb,
  by_user text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vocab_lahja ON platform.vocab (lahja_id);
`;

// ---------------------------------------------------------------- words, as they are compared
const AR_MARKS = /[ً-ٰٟـ]/g;
const ARABIC = /[؀-ۿ]/;
/** The same word whatever its accents, Arabic vowel marks and alef / ya / ta marbuta forms, in small letters. */
export function vnorm(s: string): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(AR_MARKS, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[’`]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
const STOP = new Set(
  'le la les un une des de du d l et ou en au aux a à the of to and or for with pour par sur dans est sont il elle ils on se ce ça que qui ne pas plus tres très bien mon ma mes ton ta tes son sa ses my your his her is are be it this that an in at by as do you i me we us'.split(' '),
);
/** The words of a text, as compared (two letters at least, the small words of French and English left out). */
export function vwords(s: string): string[] {
  return [...vnorm(s).matchAll(/[\p{L}\p{N}']+/gu)].map((m) => m[0].replace(/^'+|'+$/g, '')).filter((w) => w.length >= 2 && !STOP.has(w));
}
/**
 * The bones of a word in Latin letters, the same whatever the spelling: wach / wesh / wech → « wC », ch7al / chhal /
 * sh7al → « Chl », bezzaf / bzaf → « bzf », 9oddam / goddam → « qdm ». Vowels go, 3 and 2 go, 7 = h, 9 = g = q, kh = 5,
 * ch = sh, dj = j, a doubled letter counts once. Empty for Arabic letters and numbers.
 */
export function vskel(w: string): string {
  const x = vnorm(w);
  if (!x || ARABIC.test(x) || /^\d+$/.test(x)) return '';
  return x
    .replace(/sh/g, 'ch')
    .replace(/dj/g, 'j')
    .replace(/tch/g, 'C')
    .replace(/ch/g, 'C')
    .replace(/kh|5/g, 'X')
    .replace(/gh/g, 'R')
    .replace(/th/g, 't')
    .replace(/dh/g, 'd')
    .replace(/[78]/g, 'h')
    .replace(/[9g]/g, 'q')
    .replace(/[32'’]/g, '')
    .replace(/[aeiou]/g, '')
    .replace(/(.)\1+/g, '$1');
}
const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, VOCAB.maxLen);
/** The word with its vowels kept as one mark: to tell karrossa (k-r-s with 3 vowels) from korsi (k-r-s with 2). */
const vpat = (w: string) =>
  vnorm(w)
    .replace(/sh|ch/g, 'C')
    .replace(/kh|5/g, 'X')
    .replace(/gh/g, 'R')
    .replace(/dj/g, 'j')
    .replace(/[78]/g, 'h')
    .replace(/[9g]/g, 'q')
    .replace(/[32'’]/g, '')
    .replace(/[aeiou]+/g, 'a')
    .replace(/(.)\1+/g, '$1');
function lev(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** Another spelling of the same word (wesh for wach, karossa for karrossa), not another word with the same bones (korsi). */
export function sameWord(said: string, word: string): boolean {
  const k = vskel(said);
  return !!k && k === vskel(word) && Math.abs(vnorm(said).length - vnorm(word).length) <= 2 && lev(vpat(said), vpat(word)) <= 1;
}
const keyOf = (w: Pick<VocabInput, 'ar' | 'lat'>) => `${vnorm(w.ar)}|${vnorm(w.lat)}`;

const row = (r: Record<string, any>): VocabWord => ({
  id: num(r.id),
  ar: String(r.ar ?? ''),
  lat: String(r.lat ?? ''),
  meaning: String(r.meaning ?? ''),
  topic: String(r.topic ?? ''),
  avoid: String(r.avoid ?? ''),
  source: (['book', 'learned', 'coach'].includes(r.source) ? r.source : 'book') as VocabSource,
  lahjaId: r.lahja_id == null ? null : num(r.lahja_id),
  by: (r.by_user as string | null) ?? null,
  updatedAt: iso(r.updated_at),
});

// ---------------------------------------------------------------- the book, from a file
export interface VocabImport {
  words: VocabInput[];
  /** rows marked ⚠️ in the book (to check by someone from Algiers): left out */
  unsure: number;
}
const HEAD: [RegExp, 'ar' | 'lat' | 'meaning'][] = [
  [/arab|عرب/i, 'ar'],
  [/latin|latín|translit|darija|short|court|abr[ée]v|dz/i, 'lat'],
  [/mean|sens|signif|tradu|fran[cç]ais|english|anglais|means|veut dire|معنى/i, 'meaning'],
];
const cellText = (c: string) =>
  c
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The words of a book in Markdown: every table row becomes a word (its Arabic letters, its Latin letters, its meaning;
 * the columns named « Arabic », « Latin », « Meaning »… or, without such names, read from their letters), under the last
 * heading (its chapter). A row marked ⚠️ is left out, so are sentences too long to be a word.
 */
export function parseVocab(text: string): VocabImport {
  const lines = String(text ?? '').slice(0, VOCAB.maxImport).split(/\r?\n/);
  const words: VocabInput[] = [];
  let unsure = 0;
  let topic = '';
  let cols: ('ar' | 'lat' | 'meaning' | null)[] | null = null;
  let skipTable = false;
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cellText);
  const sep = (l: string | undefined) => !!l && /^\s*\|?\s*:?-{2,}/.test(l) && /^[\s|:-]+$/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) {
      topic = cellText(h[1]).replace(/^(chapter|chapitre)\s+\d+\s*[—–:-]\s*/i, '').slice(0, 120);
      cols = null;
      skipTable = false;
      continue;
    }
    if (!/^\s*\|.*\|/.test(l)) {
      if (l.trim()) (cols = null), (skipTable = false);
      continue;
    }
    if (sep(l)) continue;
    const c = cells(l);
    // a header row: the next line separates it from the rows
    if (sep(lines[i + 1])) {
      cols = c.map((x) => HEAD.find(([re]) => re.test(x))?.[1] ?? null);
      if (!cols.some(Boolean)) cols = null;
      // a reverse dictionary (« English | Darija », « Français | Darija »): the meaning first and no Arabic column —
      // its words are already in the book's own tables, read the other way round
      else if (cols[0] === 'meaning' && !cols.includes('ar')) skipTable = true;
      continue;
    }
    if (skipTable) continue;
    if (c.length < 2) continue;
    if (c.some((x) => x.includes('⚠'))) {
      unsure++;
      continue;
    }
    const w: VocabInput = { ar: '', lat: '', meaning: '', topic, avoid: '' };
    if (cols && cols.filter(Boolean).length >= 2) {
      c.forEach((x, k) => {
        const role = cols![k];
        if (role && !w[role]) w[role] = x;
      });
    } else {
      // no names: Arabic letters, then the first other cell (Latin letters), then the next one (the meaning)
      for (const x of c) {
        if (!x) continue;
        if (ARABIC.test(x) && !w.ar) w.ar = x;
        else if (!w.lat) w.lat = x;
        else if (!w.meaning) w.meaning = x;
      }
    }
    // a column of Arabic letters read as Latin (or the reverse): put each where its letters say
    if (w.lat && ARABIC.test(w.lat) && !ARABIC.test(w.ar)) [w.ar, w.lat] = [w.lat, w.ar];
    w.ar = clean(w.ar);
    w.lat = clean(w.lat);
    w.meaning = clean(w.meaning);
    if (!w.ar && !w.lat) continue;
    if ((w.ar + w.lat).length > 120) continue;
    words.push(w);
  }
  // each word once
  const seen = new Set<string>();
  return { words: words.filter((w) => !seen.has(keyOf(w)) && !!seen.add(keyOf(w))), unsure };
}

// ---------------------------------------------------------------- reading and writing the book
export async function vocabCounts(pdb: Db): Promise<{ total: number; book: number; learned: number; coach: number; topics: { topic: string; n: number }[] }> {
  const k: Record<string, number> = {};
  for (const r of await pdb.query(`SELECT source, count(*)::int AS n FROM platform.vocab GROUP BY source`)) k[String(r.source)] = num(r.n);
  const topics = (await pdb.query(`SELECT topic, count(*)::int AS n FROM platform.vocab GROUP BY topic ORDER BY min(id)`)).map((r: any) => ({ topic: String(r.topic), n: num(r.n) }));
  return { total: (k.book ?? 0) + (k.learned ?? 0) + (k.coach ?? 0), book: k.book ?? 0, learned: k.learned ?? 0, coach: k.coach ?? 0, topics };
}

/** A page of the book: a search (any of its letters or its meaning), a chapter, a source. */
export async function vocabList(pdb: Db, o: { q?: string; topic?: string; source?: VocabSource; offset?: number; limit?: number }): Promise<{ rows: VocabWord[]; total: number }> {
  const w: string[] = [];
  const p: unknown[] = [];
  if (o.q?.trim()) w.push(`(ar ILIKE '%' || $${p.push(o.q.trim())} || '%' OR lat ILIKE '%' || $${p.length} || '%' OR meaning ILIKE '%' || $${p.length} || '%' OR avoid ILIKE '%' || $${p.length} || '%')`);
  if (o.topic !== undefined) w.push(`topic = $${p.push(o.topic)}`);
  if (o.source) w.push(`source = $${p.push(o.source)}`);
  const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const total = num((await pdb.query(`SELECT count(*)::int AS n FROM platform.vocab ${where}`, p))[0]?.n);
  const rows = await pdb.query(`SELECT * FROM platform.vocab ${where} ORDER BY id LIMIT ${Math.min(VOCAB.pageMax, o.limit ?? 100)} OFFSET ${Math.max(0, o.offset ?? 0)}`, p);
  return { rows: rows.map(row), total };
}

/** Pilotix's book in: its words added (a word already there is kept as it is), or the book's words replaced. */
export async function importVocab(pdb: Db, o: { text: string; replace: boolean; by: string }): Promise<{ added: number; skipped: number; unsure: number; total: number }> {
  const { words, unsure } = parseVocab(o.text);
  return pdb.tx(async (tx) => {
    if (o.replace) await tx.query(`DELETE FROM platform.vocab WHERE source = 'book'`);
    const have = new Set((await tx.query(`SELECT ar, lat FROM platform.vocab`)).map((r: any) => keyOf({ ar: String(r.ar), lat: String(r.lat) })));
    const count = num((await tx.query(`SELECT count(*)::int AS n FROM platform.vocab`))[0]?.n);
    const fresh = words.filter((w) => !have.has(keyOf(w))).slice(0, Math.max(0, VOCAB.maxWords - count));
    for (let i = 0; i < fresh.length; i += 500) {
      const part = fresh.slice(i, i + 500);
      await tx.query(
        `INSERT INTO platform.vocab (ar, lat, meaning, topic, by_user) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])`,
        [part.map((w) => w.ar), part.map((w) => w.lat), part.map((w) => w.meaning), part.map((w) => clean(w.topic)), part.map(() => o.by)],
      );
    }
    bump();
    return { added: fresh.length, skipped: words.length - fresh.length, unsure, total: count + fresh.length };
  });
}

/** One word written or corrected by Pilotix (a word of the book stays from the book). */
export async function saveVocab(pdb: Db, o: VocabInput & { id?: number; by: string }): Promise<{ ok: boolean; error?: 'empty' | 'same' | 'not_found'; id?: number }> {
  const w = { ar: clean(o.ar), lat: clean(o.lat), meaning: clean(o.meaning), topic: clean(o.topic), avoid: clean(o.avoid) };
  if (!w.ar && !w.lat && !w.avoid) return { ok: false, error: 'empty' };
  // the same word: one of its forms already in the book
  const twin = (await pdb.query(`SELECT id, ar, lat FROM platform.vocab`)).find(
    (r: any) => num(r.id) !== o.id && ((!!w.ar && vnorm(r.ar) === vnorm(w.ar)) || (!!w.lat && vnorm(r.lat) === vnorm(w.lat))),
  );
  if (twin) return { ok: false, error: 'same' };
  if (o.id) {
    const r = await pdb.query(`UPDATE platform.vocab SET ar = $2, lat = $3, meaning = $4, topic = $5, avoid = $6, by_user = $7, updated_at = now() WHERE id = $1 RETURNING id`, [o.id, w.ar, w.lat, w.meaning, w.topic, w.avoid, o.by]);
    if (!r.length) return { ok: false, error: 'not_found' };
    bump();
    return { ok: true, id: o.id };
  }
  const r = await pdb.query(`INSERT INTO platform.vocab (ar, lat, meaning, topic, avoid, source, by_user) VALUES ($1, $2, $3, $4, $5, 'coach', $6) RETURNING id`, [w.ar, w.lat, w.meaning, w.topic, w.avoid, o.by]);
  bump();
  return { ok: true, id: num(r[0].id) };
}

export async function removeVocab(pdb: Db, id: number): Promise<boolean> {
  const r = await pdb.query(`DELETE FROM platform.vocab WHERE id = $1 RETURNING id`, [id]);
  bump();
  return r.length > 0;
}

// ---------------------------------------------------------------- what the corrections teach
/**
 * An accepted Darija lesson writes its words in the book: « write X instead of Y » replaces Y where the book has it (the
 * word it was is kept, to give it back if the lesson is removed) or adds X; « never write Y » marks Y; a new word is added.
 */
export async function learnVocab(pdb: Db, o: { lahjaId: number; words: LahjaWord[]; source: 'learned' | 'coach'; by: string }): Promise<number> {
  let n = 0;
  const all = (await pdb.query(`SELECT * FROM platform.vocab`)).map(row);
  const has = (v: VocabWord, x: string) => !!x && (vnorm(v.ar) === vnorm(x) || vnorm(v.lat) === vnorm(x));
  const change = async (v: VocabWord, next: Pick<VocabWord, 'ar' | 'lat' | 'avoid'>) => {
    await pdb.query(`UPDATE platform.vocab SET ar = $2, lat = $3, avoid = $4, lahja_id = $5, prev = $6::jsonb, updated_at = now() WHERE id = $1`, [
      v.id,
      next.ar,
      next.lat,
      next.avoid.slice(0, VOCAB.maxLen),
      o.lahjaId,
      // what it was, to give it back if the lesson is removed
      JSON.stringify({ ar: v.ar, lat: v.lat, avoid: v.avoid, lahjaId: v.lahjaId }),
    ]);
    n++;
  };
  const plus = (a: string, b: string) => [a, b].filter(Boolean).join(', ');
  for (const w of o.words) {
    const use = clean(w.use);
    const not = clean(w.not);
    if (!use && !not) continue;
    const byNot = all.find((v) => has(v, not));
    const byUse = all.find((v) => has(v, use));
    if (byNot) {
      // the book's word, as it should be written (or « never write it »)
      const field = vnorm(byNot.ar) === vnorm(not) ? 'ar' : 'lat';
      await change(byNot, { ar: byNot.ar, lat: byNot.lat, [field]: use || byNot[field], avoid: plus(byNot.avoid, not) });
    } else if (byUse) {
      // the right word is in the book: what not to write instead goes with it
      if (not) await change(byUse, { ar: byUse.ar, lat: byUse.lat, avoid: plus(byUse.avoid, not) });
    } else {
      const ar = ARABIC.test(use || not);
      await pdb.query(`INSERT INTO platform.vocab (ar, lat, topic, avoid, source, lahja_id, by_user) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [ar ? use : '', ar ? '' : use, VOCAB.learnedTopic, not, o.source, o.lahjaId, o.by]);
      n++;
    }
  }
  if (n) bump();
  return n;
}

/** A lesson removed by Pilotix: the words it added leave the book, the words it changed come back as they were. */
export async function forgetVocab(pdb: Db, lahjaId: number): Promise<number> {
  const rows = await pdb.query(`SELECT * FROM platform.vocab WHERE lahja_id = $1`, [lahjaId]);
  for (const r of rows) {
    const prev = r.prev && typeof r.prev === 'string' ? JSON.parse(r.prev) : r.prev;
    if (r.source === 'book' && prev) await pdb.query(`UPDATE platform.vocab SET ar = $2, lat = $3, avoid = $4, lahja_id = $5, prev = NULL, updated_at = now() WHERE id = $1`, [r.id, prev.ar ?? '', prev.lat ?? '', prev.avoid ?? '', prev.lahjaId ?? null]);
    else await pdb.query(`DELETE FROM platform.vocab WHERE id = $1`, [r.id]);
  }
  if (rows.length) bump();
  return rows.length;
}

// ---------------------------------------------------------------- the words of a chat
// the book in memory, with its words indexed, read again when it changes (here, or on another server: its last change)
let mem: { stamp: string; words: VocabWord[]; index: Map<string, Set<number>> } | null = null;
let local = 0;
const bump = () => {
  local++;
};
const prefix = (w: string) => (w.length >= 5 ? `~${w.slice(0, 5)}` : '');
async function loaded(pdb: Db) {
  const s = (await pdb.query(`SELECT count(*)::int AS n, max(updated_at) AS at, max(id) AS id FROM platform.vocab`))[0];
  const stamp = `${num(s?.n)}|${s?.at ? iso(s.at) : ''}|${num(s?.id)}|${local}`;
  if (mem?.stamp === stamp) return mem;
  const words = (await pdb.query(`SELECT * FROM platform.vocab ORDER BY id`)).map(row);
  const index = new Map<string, Set<number>>();
  const add = (k: string, i: number) => {
    if (!k) return;
    let s = index.get(k);
    if (!s) index.set(k, (s = new Set()));
    s.add(i);
  };
  words.forEach((w, i) => {
    for (const x of vwords(`${w.ar} ${w.lat} ${w.avoid}`)) {
      add(`d:${x}`, i);
      add(`d:${prefix(x)}`, i);
      // the same word in another spelling (wesh for wach, chhal for ch7al…)
      const k = vskel(x);
      if (k.length >= 3) add(`s:${k}`, i);
    }
    for (const x of vwords(w.meaning)) add(`m:${x}`, i);
  });
  mem = { stamp, words, index };
  return mem;
}

/**
 * The words of the book that touch these texts (what the customer wrote, the post, the product): a Darija word written
 * counts twice, its first five letters, the same word in another spelling (wesh = wach) or a word of its meaning once;
 * the best ones first, `limit` at most.
 */
export async function vocabFor(pdb: Db | null, texts: string[], limit = VOCAB.promptWords): Promise<VocabWord[]> {
  if (!pdb) return [];
  try {
    const m = await loaded(pdb);
    if (!m.words.length) return [];
    const score = new Map<number, number>();
    const hit = (k: string, n: number) => m.index.get(k)?.forEach((i) => score.set(i, (score.get(i) ?? 0) + n));
    for (const w of new Set(texts.flatMap((t) => vwords(t)))) {
      hit(`d:${w}`, 2);
      if (prefix(w)) hit(`d:${prefix(w)}`, 1);
      hit(`m:${w}`, 1);
      const k = vskel(w);
      if (k.length >= 3 && !m.index.has(`d:${w}`))
        m.index.get(`s:${k}`)?.forEach((i) => {
          const v = m.words[i];
          if (vwords(`${v.lat} ${v.avoid}`).some((x) => sameWord(w, x))) score.set(i, (score.get(i) ?? 0) + 1);
        });
    }
    return [...score.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, limit)
      .map(([i]) => m.words[i]);
  } catch {
    // no book here (the preview, a single shop): no words
    return [];
  }
}

// ---------------------------------------------------------------- prices said in centimes
// Algerians often say prices in centimes (1 DA = 100 centimes): « mlyoun w nos » = 1 500 000 centimes = 15 000 DA,
// « mitin w khamsin (alf) » = 2 500 DA. The numbers a customer writes in words are read here, so the AI never has to
// compute them itself (and is told to check with the customer when unsure).
const NUM: Record<string, number> = {
  wa7ed: 1, wahed: 1, zouj: 2, zoudj: 2, jouj: 2, tlata: 3, tlatha: 3, rab3a: 4, arb3a: 4, khamsa: 5, setta: 6, sitta: 6, sab3a: 7, seb3a: 7,
  tmenya: 8, tmanya: 8, tes3a: 9, tis3a: 9, '3achra': 10, achra: 10, '7dach': 11, hdach: 11, tnach: 12, tlettach: 13, rba3tach: 14,
  khamstach: 15, settach: 16, sba3tach: 17, tmentach: 18, tsa3tach: 19, '3achrin': 20, achrin: 20, tlatin: 30, rb3in: 40, arb3in: 40,
  khamsin: 50, settin: 60, sittin: 60, sab3in: 70, seb3in: 70, tmanin: 80, tmenin: 80, tes3in: 90, tis3in: 90, mya: 100, miya: 100,
  mitin: 200, tlatmya: 300, rab3amya: 400, rb3mya: 400, khamsmya: 500, settmya: 600, sab3amya: 700, tmenmya: 800, tes3amya: 900,
  alfin: 2000,
  واحد: 1, زوج: 2, ثلاثه: 3, تلاته: 3, اربعه: 4, ربعه: 4, خمسه: 5, سته: 6, سبعه: 7, ثمنيه: 8, تمنيه: 8, تسعه: 9, عشره: 10, عشرين: 20,
  ثلاثين: 30, تلاتين: 30, اربعين: 40, خمسين: 50, ستين: 60, سبعين: 70, ثمانين: 80, تمانين: 80, تسعين: 90, ميه: 100, مايه: 100, ميتين: 200, الفين: 2000,
};
const MULT: Record<string, number> = { alf: 1000, alef: 1000, alaf: 1000, mlyoun: 1e6, melyoun: 1e6, mlioun: 1e6, million: 1e6, millions: 1e6, mlayen: 1e6, mlayn: 1e6, الف: 1000, الاف: 1000, مليون: 1e6, ملاين: 1e6, ملايين: 1e6 };
const FRACT: Record<string, number> = { nos: 0.5, noss: 0.5, demi: 0.5, نص: 0.5, rbe3: 0.25, rob3: 0.25, ربع: 0.25 };
const JOIN = new Set(['w', 'ou', 'et', 'و']);
const DINARS = new Set(['da', 'dzd', 'dinar', 'dinars', 'دج', 'دينار']);
export interface SaidPrice {
  /** the words as the customer wrote them (normalised) */
  said: string;
  /** what it is in dinars */
  da: number;
  /** « alf » left out (« mitin w khamsin » for 2 500 DA): a guess the AI should check */
  guess: boolean;
  /** said with « dinar » / DA: already dinars, nothing to divide */
  dinars: boolean;
}
/** The prices written in words in these texts (centimes, unless « dinar » follows), in dinars. */
export function readCentimes(texts: string[]): SaidPrice[] {
  const out: SaidPrice[] = [];
  for (const text of texts) {
    const raw = vnorm(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    // « ونص » → « و » « نص »: the Arabic « and » is written against the next word
    const tk: string[] = [];
    for (const t of raw) {
      const rest = t.slice(1);
      if (t.length > 2 && t[0] === 'و' && (rest in NUM || rest in MULT || rest in FRACT)) tk.push('و', rest);
      else tk.push(t);
    }
    const isNum = (t: string | undefined) => !!t && (t in NUM || t in MULT || t in FRACT || /^\d{1,6}$/.test(t));
    let i = 0;
    while (i < tk.length) {
      // a number in digits counts only before alf / mlyoun (« 15 alf », « 2 mlayen »): never a phone or a quantity
      if (!isNum(tk[i]) || (/^\d+$/.test(tk[i]) && !(tk[i + 1] in MULT))) {
        i++;
        continue;
      }
      let j = i;
      let total = 0;
      let cur = 0;
      let lastMult = 0;
      let words = false;
      const said: string[] = [];
      while (j < tk.length) {
        const t = tk[j];
        if (JOIN.has(t) && said.length && isNum(tk[j + 1])) {
          said.push(t);
          j++;
          continue;
        }
        if (/^\d{1,6}$/.test(t)) cur += Number(t);
        else if (t in NUM) {
          cur += NUM[t];
          words = true;
        } else if (t in FRACT) {
          if (lastMult) total += FRACT[t] * lastMult;
          else cur += FRACT[t];
          words = true;
        } else if (t in MULT) {
          total += (cur || 1) * MULT[t];
          cur = 0;
          lastMult = MULT[t];
          words = true;
        } else break;
        said.push(t);
        j++;
      }
      const dinars = DINARS.has(tk[j] ?? '');
      let centimes = 0;
      let guess = false;
      if (lastMult === 1e6 && cur > 0) centimes = total + cur * 1000; // « mlyoun w mitin » = 1 200 000
      else if (!lastMult && cur >= 100) {
        centimes = cur * 1000; // « mitin w khamsin » (alf left out)
        guess = true;
      } else centimes = total + cur;
      if (words && said.length) {
        const s = said.join(' ');
        const da = dinars ? total + cur : centimes / 100;
        if (da >= 1 && (dinars || centimes >= 100) && !out.some((p) => p.said === s)) out.push({ said: s + (dinars ? ` ${tk[j]}` : ''), da: Math.round(da), guess, dinars });
      }
      i = Math.max(j, i + 1);
    }
  }
  return out.slice(0, 6);
}
const da = (x: number) => `${String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} DA`;
/** The prices a customer said in words, as a short note for the AI's instructions. */
export function pricesBlock(ps: SaidPrice[]): string {
  if (!ps.length) return '';
  const line = (p: SaidPrice) => `- « ${p.said} » = ${da(p.da)}${p.dinars ? ' (dit en dinars)' : p.guess ? ' (« alf » sous-entendu : vérifie avec le client)' : ''}`;
  return `Prix dits en mots dans ce message (centimes → dinars ; en cas de doute, demande « tqsed … DA ? ») :\n${ps.map(line).join('\n')}`;
}

/** The words for the AI's instructions (and, with the customer's texts, the prices he said in centimes). */
export function vocabBlock(ws: VocabWord[], texts: string[] = []): string {
  const prices = pricesBlock(readCentimes(texts));
  if (!ws.length) return prices;
  const line = (w: VocabWord) => {
    const forms = [w.ar, w.lat].filter(Boolean).join(' / ');
    const avoid = w.avoid.split(',').map((x) => x.trim()).filter(Boolean);
    // « never write it »: the word itself is one not to write
    if (!forms || avoid.some((x) => vnorm(x) === vnorm(w.ar) || vnorm(x) === vnorm(w.lat))) return `- jamais « ${forms || w.avoid} »${w.meaning ? ` (${w.meaning})` : ''}`;
    return `- ${forms}${w.meaning ? ` : ${w.meaning}` : ''}${avoid.length ? ` (pas « ${avoid.join(' », « ')} »)` : ''}`;
  };
  const words = `Vocabulaire algérien (les mots du livre de Pilotix qui touchent ce message ; écris-les ainsi, jamais ce qui est marqué « pas ») :\n${ws.map(line).join('\n')}`;
  return prices ? `${words}\n\n${prices}` : words;
}
