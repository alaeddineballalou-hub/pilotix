// The Darija book (Pilot AI › Tester & leçons › Leçons › Darija): the rules of Algerian Darija that Dellal and the CM AI
// agent read before every reply, for every shop, kept apart from the sales book (method of selling + sales lessons,
// pilotlearn.ts). Two parts:
//  - the rules, in chapters (A. Registre, B. Les mots algériens…): text Pilotix edits in the control room;
//  - the Darija lessons for every shop (modules/lahja.ts): the shops' corrections and what Dellal learned, once accepted.
// Every change is a new version, used at once: an edit of the rules, a lesson accepted, removed or added. Going back to an
// older version brings back its rules and its lessons. The first version is the guide written in the code (darija.ts).
// A shop's own lessons (used in that shop only) are not in the book.
import { Db, iso, num } from '../db';
import { DELLAL_DARIJA } from './darija';
import { asWords, lahjaLines, LahjaWord } from './lahja';

export type DarijaChapter = { title: string; text: string };
export type DarijaLesson = { id: number; words: LahjaWord[] };
export type DarijaKind = 'first' | 'edit' | 'lessons' | 'restore';
export type DarijaBook = {
  id: number;
  version: number;
  title: string;
  chapters: DarijaChapter[];
  lessons: DarijaLesson[];
  kind: DarijaKind;
  note: string | null;
  by: string | null;
  at: string;
};
type Row = Record<string, any>;

export const DARIJA_BOOK_SQL = `
CREATE TABLE IF NOT EXISTS platform.darija_books (
  id bigserial PRIMARY KEY,
  version integer NOT NULL UNIQUE,
  live boolean NOT NULL DEFAULT false,
  title text NOT NULL DEFAULT '',
  chapters jsonb NOT NULL DEFAULT '[]',
  lessons jsonb NOT NULL DEFAULT '[]',
  kind text NOT NULL DEFAULT 'edit',
  note text,
  by_user text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS darija_books_live ON platform.darija_books (live) WHERE live;
`;

export const DARIJA_BOOK = { maxChapters: 30, maxTitle: 200, maxChapterTitle: 140, maxChapterText: 8000, maxTotal: 30000 };

// ---------------------------------------------------------------- the text
const CHAPTER = /^([A-Z])\. (.+)$/;
const tidy = (s: unknown) =>
  String(s ?? '')
    .replace(/\r/g, '')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
/** The built-in guide (darija.ts) as a title and chapters: « A. Registre » … « H. Exemples ». */
export function guideChapters(text: string = DELLAL_DARIJA): { title: string; chapters: DarijaChapter[] } {
  const lines = tidy(text).split('\n');
  const title = lines.shift() ?? '';
  const chapters: DarijaChapter[] = [];
  for (const l of lines) {
    const m = l.match(CHAPTER);
    if (m) chapters.push({ title: m[2].trim(), text: '' });
    else if (chapters.length) chapters[chapters.length - 1].text += (chapters[chapters.length - 1].text ? '\n' : '') + l;
  }
  return { title: title.trim(), chapters: chapters.map((c) => ({ title: c.title, text: tidy(c.text) })) };
}
/** A, B, C… (then 27, 28… past Z): the chapters keep their letters in order whatever is added or removed. */
export const chapterMark = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));
/** The rules as Dellal and the CM AI agent read them. */
export function darijaText(b: { title: string; chapters: DarijaChapter[] }): string {
  return [tidy(b.title), ...b.chapters.map((c, i) => `${chapterMark(i)}. ${tidy(c.title)}\n${tidy(c.text)}`)].filter(Boolean).join('\n\n');
}

export type DarijaProblem = 'empty' | 'chapters' | 'title' | 'chapter_title' | 'chapter_text' | 'long' | 'no_change';
/** What a saved book must be: a title, 1 to 30 chapters each with a title and a text, not too long for the instructions. */
export function checkDarijaBook(b: { title: string; chapters: DarijaChapter[] }): DarijaProblem[] {
  const p = new Set<DarijaProblem>();
  if (!tidy(b.title) || tidy(b.title).length > DARIJA_BOOK.maxTitle) p.add('title');
  if (!b.chapters.length) p.add('empty');
  if (b.chapters.length > DARIJA_BOOK.maxChapters) p.add('chapters');
  for (const c of b.chapters) {
    if (!tidy(c.title) || tidy(c.title).length > DARIJA_BOOK.maxChapterTitle || CHAPTER.test(tidy(c.title))) p.add('chapter_title');
    if (!tidy(c.text) || tidy(c.text).length > DARIJA_BOOK.maxChapterText) p.add('chapter_text');
  }
  if (darijaText(b).length > DARIJA_BOOK.maxTotal) p.add('long');
  return [...p];
}
export const DARIJA_WHY: Record<DarijaProblem, string> = {
  empty: 'le livre doit avoir au moins un chapitre',
  chapters: `${DARIJA_BOOK.maxChapters} chapitres au plus`,
  title: `le titre du livre est vide ou trop long (${DARIJA_BOOK.maxTitle} caractères au plus)`,
  chapter_title: `un chapitre a un titre vide ou trop long (${DARIJA_BOOK.maxChapterTitle} caractères au plus, sans « A. » devant : la lettre se met toute seule)`,
  chapter_text: `un chapitre est vide ou trop long (${DARIJA_BOOK.maxChapterText} caractères au plus)`,
  long: `le livre est trop long (${DARIJA_BOOK.maxTotal} caractères au plus) : Dellal le lit avant chaque réponse`,
  no_change: 'rien n’a changé',
};
export const darijaErr = (p: DarijaProblem[]) => 'Livre de darija non enregistré : ' + p.map((x) => DARIJA_WHY[x]).join(' ; ');

// ---------------------------------------------------------------- the versions
const chaptersOf = (x: unknown): DarijaChapter[] =>
  (Array.isArray(x) ? x : []).filter((c) => c && typeof c === 'object').map((c: Row) => ({ title: tidy(c.title), text: tidy(c.text) }));
const lessonsOf = (x: unknown): DarijaLesson[] =>
  (Array.isArray(x) ? x : []).filter((l) => l && typeof l === 'object').map((l: Row) => ({ id: num(l.id), words: asWords(l.words) }));
const book = (r: Row): DarijaBook => ({
  id: num(r.id),
  version: num(r.version),
  title: String(r.title ?? ''),
  chapters: chaptersOf(r.chapters),
  lessons: lessonsOf(r.lessons),
  kind: (r.kind as DarijaKind) ?? 'edit',
  note: (r.note as string | null) ?? null,
  by: (r.by_user as string | null) ?? null,
  at: iso(r.created_at),
});
/** The lessons for every shop right now (accepted, oldest first). */
async function lessonsNow(pdb: Db): Promise<DarijaLesson[]> {
  return (await pdb.query(`SELECT id, words FROM platform.lahja WHERE status = 'approved' ORDER BY decided_at NULLS FIRST, id`)).map((r: Row) => ({ id: num(r.id), words: asWords(r.words) }));
}
const sameIds = (a: DarijaLesson[], b: DarijaLesson[]) => a.length === b.length && a.map((l) => l.id).join(',') === b.map((l) => l.id).join(',');

async function addVersion(pdb: Db, o: { title: string; chapters: DarijaChapter[]; lessons: DarijaLesson[]; kind: DarijaKind; note?: string | null; by: string; now?: Date }): Promise<DarijaBook> {
  return pdb.tx(async (d) => {
    // one version at a time: the table is locked while the next number is taken
    await d.query('LOCK TABLE platform.darija_books IN SHARE ROW EXCLUSIVE MODE');
    // the first version: made only once, even when two answers ask for the book at the same moment
    if (o.kind === 'first') {
      const live = (await d.query('SELECT * FROM platform.darija_books WHERE live LIMIT 1'))[0];
      if (live) return book(live);
    }
    const v = num((await d.query('SELECT COALESCE(max(version), 0) AS v FROM platform.darija_books'))[0]?.v) + 1;
    await d.query('UPDATE platform.darija_books SET live = false WHERE live');
    const r = (
      await d.query(
        `INSERT INTO platform.darija_books (version, live, title, chapters, lessons, kind, note, by_user, created_at)
         VALUES ($1, true, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8::timestamptz) RETURNING *`,
        [v, tidy(o.title), JSON.stringify(o.chapters.map((c) => ({ title: tidy(c.title), text: tidy(c.text) }))), JSON.stringify(o.lessons), o.kind, o.note ? String(o.note).slice(0, 300) : null, o.by, (o.now ?? new Date()).toISOString()],
      )
    )[0];
    return book(r);
  });
}

/** The book in service. The very first time: version 1, the guide written in the code, with the lessons accepted so far. */
export async function darijaBookLive(pdb: Db, now?: Date): Promise<DarijaBook> {
  const r = (await pdb.query('SELECT * FROM platform.darija_books WHERE live LIMIT 1'))[0];
  if (r) return book(r);
  const g = guideChapters();
  try {
    return await addVersion(pdb, { ...g, lessons: await lessonsNow(pdb), kind: 'first', note: 'Première version : le guide de darija de Pilotix', by: 'Pilotix', now });
  } catch {
    // another call made it at the same moment
    return book((await pdb.query('SELECT * FROM platform.darija_books WHERE live LIMIT 1'))[0]);
  }
}

/** The rules Dellal and the CM AI agent read (the book in service), or the guide of the code when there is no platform. Never throws. */
export async function darijaGuide(platform: Db | null): Promise<string> {
  if (!platform) return DELLAL_DARIJA;
  try {
    return darijaText(await darijaBookLive(platform));
  } catch {
    return DELLAL_DARIJA;
  }
}

export type DarijaAck = { ok: boolean; error?: DarijaProblem | 'who' | 'not_found' | 'already_live'; problems?: DarijaProblem[]; book?: DarijaBook };

/** Pilotix edits the rules: a new version, used at once (with the lessons of this moment). */
export async function saveDarijaBook(pdb: Db, o: { title?: string; chapters: DarijaChapter[]; note?: string | null; by: string; now?: Date }): Promise<DarijaAck> {
  if (!String(o.by || '').trim()) return { ok: false, error: 'who' };
  const live = await darijaBookLive(pdb, o.now);
  const next = { title: tidy(o.title ?? live.title), chapters: o.chapters.map((c) => ({ title: tidy(c.title), text: tidy(c.text) })) };
  const problems = checkDarijaBook(next);
  if (problems.length) return { ok: false, error: problems[0], problems };
  if (darijaText(next) === darijaText(live)) return { ok: false, error: 'no_change', problems: ['no_change'] };
  return { ok: true, book: await addVersion(pdb, { ...next, lessons: await lessonsNow(pdb), kind: 'edit', note: o.note, by: o.by, now: o.now }) };
}

/** After a lesson for every shop is accepted, removed or added: a new version with the same rules (none when nothing changed). */
export async function snapshotDarijaLessons(pdb: Db, o: { by: string; note: string; now?: Date }): Promise<DarijaBook | null> {
  const live = await darijaBookLive(pdb, o.now);
  const lessons = await lessonsNow(pdb);
  if (sameIds(lessons, live.lessons)) return null;
  return addVersion(pdb, { title: live.title, chapters: live.chapters, lessons, kind: 'lessons', note: o.note, by: o.by, now: o.now });
}

/**
 * Back to an older version: its rules, and its lessons (one accepted since is removed from every shop; one removed since is
 * accepted again). A new version, used at once; nothing is deleted, so one can come back again.
 */
export async function restoreDarijaBook(pdb: Db, o: { version: number; by: string; now?: Date }): Promise<DarijaAck> {
  if (!String(o.by || '').trim()) return { ok: false, error: 'who' };
  const r = (await pdb.query('SELECT * FROM platform.darija_books WHERE version = $1', [o.version]))[0];
  if (!r) return { ok: false, error: 'not_found' };
  if (r.live) return { ok: false, error: 'already_live' };
  const old = book(r);
  const at = (o.now ?? new Date()).toISOString();
  const want = new Set(old.lessons.map((l) => l.id));
  const now = await lessonsNow(pdb);
  const off = now.filter((l) => !want.has(l.id)).map((l) => l.id);
  const back = old.lessons.map((l) => l.id).filter((id) => !now.some((l) => l.id === id));
  if (off.length)
    await pdb.query(
      `UPDATE platform.lahja SET status = 'removed', own = CASE WHEN source = 'dellal' THEN false ELSE own END, decided_by = $2, decided_at = $3::timestamptz
        WHERE id = ANY($1::bigint[]) AND status = 'approved'`,
      [off, o.by, at],
    );
  if (back.length) await pdb.query(`UPDATE platform.lahja SET status = 'approved', decided_by = $2, decided_at = $3::timestamptz WHERE id = ANY($1::bigint[]) AND status = 'removed'`, [back, o.by, at]);
  return { ok: true, book: await addVersion(pdb, { title: old.title, chapters: old.chapters, lessons: await lessonsNow(pdb), kind: 'restore', note: `Retour à la version ${old.version}`, by: o.by, now: o.now }) };
}

export type DarijaVersion = { version: number; live: boolean; kind: DarijaKind; note: string | null; by: string | null; at: string; chapters: number; lessons: number };
/** The versions, newest first. */
export async function darijaVersions(pdb: Db, limit = 40): Promise<DarijaVersion[]> {
  return (
    await pdb.query(
      `SELECT version, live, kind, note, by_user, created_at, jsonb_array_length(chapters) AS nc, jsonb_array_length(lessons) AS nl
         FROM platform.darija_books ORDER BY version DESC LIMIT $1`,
      [limit],
    )
  ).map((r: Row) => ({ version: num(r.version), live: !!r.live, kind: r.kind as DarijaKind, note: (r.note as string | null) ?? null, by: (r.by_user as string | null) ?? null, at: iso(r.created_at), chapters: num(r.nc), lessons: num(r.nl) }));
}

const frDay = (s: string) => new Date(s).toLocaleDateString('fr-FR', { timeZone: 'Africa/Algiers', day: 'numeric', month: 'long', year: 'numeric' });
/** The book as a file (the one in service, or an older version): the rules, then the lessons for every shop. */
export async function darijaBookFile(pdb: Db, o: { version?: number; now?: Date } = {}): Promise<{ version: number; text: string } | null> {
  const r = o.version ? (await pdb.query('SELECT * FROM platform.darija_books WHERE version = $1', [o.version]))[0] : null;
  if (o.version && !r) return null;
  const b = r ? book(r) : await darijaBookLive(pdb, o.now);
  const rule = '─'.repeat(64);
  const words = b.lessons.flatMap((l) => l.words);
  const text = [
    'DELLAL & CM AI — LE LIVRE DE DARIJA',
    '',
    `Version ${b.version}, du ${frDay(b.at)}${b.by ? ` (${b.by})` : ''}${r && !r.live ? ' — ancienne version' : ''}.`,
    `Fichier préparé le ${frDay((o.now ?? new Date()).toISOString())}.`,
    '',
    'Avant chaque réponse, Dellal et CM AI lisent ces règles, pour toutes les boutiques. Chaque boutique ajoute ensuite ses propres',
    'leçons de darija (ses corrections et ce que Dellal a appris de ses clients) : elles ne sont pas dans ce fichier.',
    'La méthode de vente et les leçons de vente sont dans un autre livre : le livre d’instructions (Pilot AI › Dellal AI).',
    '',
    rule,
    '1. LES RÈGLES',
    rule,
    '',
    darijaText(b),
    '',
    rule,
    `2. LES LEÇONS DE DARIJA POUR TOUTES LES BOUTIQUES (${words.length})`,
    rule,
    '',
    words.length ? words.map((w) => lahjaLines([w])).join('\n') : 'Aucune leçon pour toutes les boutiques pour l’instant.',
    '',
  ].join('\n');
  return { version: b.version, text };
}
