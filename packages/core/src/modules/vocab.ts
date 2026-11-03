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
const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, VOCAB.maxLen);
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
  const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cellText);
  const sep = (l: string | undefined) => !!l && /^\s*\|?\s*:?-{2,}/.test(l) && /^[\s|:-]+$/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(l);
    if (h) {
      topic = cellText(h[1]).replace(/^(chapter|chapitre)\s+\d+\s*[—–:-]\s*/i, '').slice(0, 120);
      cols = null;
      continue;
    }
    if (!/^\s*\|.*\|/.test(l)) {
      if (l.trim()) cols = null;
      continue;
    }
    if (sep(l)) continue;
    const c = cells(l);
    // a header row: the next line separates it from the rows
    if (sep(lines[i + 1])) {
      cols = c.map((x) => HEAD.find(([re]) => re.test(x))?.[1] ?? null);
      if (!cols.some(Boolean)) cols = null;
      continue;
    }
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
    }
    for (const x of vwords(w.meaning)) add(`m:${x}`, i);
  });
  mem = { stamp, words, index };
  return mem;
}

/**
 * The words of the book that touch these texts (what the customer wrote, the post, the product): a Darija word written
 * (or its first five letters) counts twice, a word of its meaning once; the best ones first, `limit` at most.
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

/** The words for the AI's instructions. */
export function vocabBlock(ws: VocabWord[]): string {
  if (!ws.length) return '';
  const line = (w: VocabWord) => {
    const forms = [w.ar, w.lat].filter(Boolean).join(' / ');
    const avoid = w.avoid.split(',').map((x) => x.trim()).filter(Boolean);
    // « never write it »: the word itself is one not to write
    if (!forms || avoid.some((x) => vnorm(x) === vnorm(w.ar) || vnorm(x) === vnorm(w.lat))) return `- jamais « ${forms || w.avoid} »${w.meaning ? ` (${w.meaning})` : ''}`;
    return `- ${forms}${w.meaning ? ` : ${w.meaning}` : ''}${avoid.length ? ` (pas « ${avoid.join(' », « ')} »)` : ''}`;
  };
  return `Vocabulaire algérien (les mots du livre de Pilotix qui touchent ce message ; écris-les ainsi, jamais ce qui est marqué « pas ») :\n${ws.map(line).join('\n')}`;
}
