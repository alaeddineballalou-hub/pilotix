// The bell's lines (migration 123): written here, shown at the top of every page (apps/web layout/Bell.tsx), which
// hears of them at once (live event « inbox »). What rings it and with which words: modules/inbox.ts. Every phone
// notification also writes its line here (push.ts › sendPush).
import type { Language } from '@pilotix/shared';
import { num } from '../db';
import type { Ctx } from '../rpc';

export const BELL_KINDS = ['order', 'callback', 'delivered', 'returned', 'cancelled', 'taken', 'alert', 'depot', 'message', 'info'] as const;
export type BellKind = (typeof BELL_KINDS)[number];

export interface BellLine {
  kind: BellKind;
  title: string;
  body: string;
  /** the page it opens (« #/confirmation/nouvelles ») */
  url?: string | null;
  /** the order it opens */
  orderId?: number | null;
  /** loud, and kept on screen until it is seen */
  important?: boolean;
}

/** What one person got: a new line, or their unread line with the same tag replaced (`quiet`: it rang < 90 s ago). */
export interface Rung {
  id: number;
  lang: Language;
  line: BellLine;
  quiet: boolean;
}

/** A replaced line that rang less than this ago refreshes without a new sound (a depot alert ringing every minute). */
const QUIET_MS = 90_000;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const LANGS: readonly string[] = ['fr', 'en', 'ar'];

/**
 * One line per person, in their language. With a `tag`, their unread line with that tag is replaced and its count
 * grows (`n` given to `make`: the things it says now, with the ones of the line it replaces). The screens of the people
 * told hear of it at once. Returns what each person got.
 */
export async function ringBell(ctx: Ctx, people: readonly number[], make: (lang: Language, n: number) => BellLine, o: { tag?: string | null; count?: number; silent?: boolean } = {}): Promise<Rung[]> {
  const ids = [...new Set(people.filter((x) => Number.isSafeInteger(x) && x > 0))];
  if (!ids.length) return [];
  const who = await ctx.db.query('SELECT id, language FROM profiles WHERE id = ANY($1) AND active AND agency_id IS NULL', [ids]);
  const add = Math.max(1, Math.round(o.count ?? 1));
  const tag = o.tag ? clip(o.tag, 120) : null;
  const out: Rung[] = [];
  for (const p of who as any[]) {
    const id = num(p.id);
    const lang = (LANGS.includes(p.language) ? p.language : 'fr') as Language;
    const prev = tag ? (await ctx.db.query('SELECT id, n, created_at FROM inbox WHERE profile_id = $1 AND tag = $2 AND read_at IS NULL ORDER BY id DESC LIMIT 1', [id, tag]))[0] : null;
    const n = (prev ? num(prev.n) : 0) + add;
    const line = make(lang, n);
    const vals = [line.kind, clip(line.title, 200), clip(line.body, 600), line.url ?? null, line.orderId ?? null, !!line.important, n];
    if (prev) {
      await ctx.db.query('UPDATE inbox SET kind = $2, title = $3, body = $4, url = $5, order_id = $6, important = $7, n = $8, created_at = now() WHERE id = $1', [prev.id, ...vals]);
      const was = new Date(prev.created_at).getTime();
      out.push({ id, lang, line, quiet: !!o.silent || (Number.isFinite(was) && ctx.now() - was < QUIET_MS) });
    } else {
      await ctx.db.query('INSERT INTO inbox (profile_id, kind, title, body, url, order_id, important, n, tag) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, ...vals, tag]);
      out.push({ id, lang, line, quiet: !!o.silent });
    }
  }
  if (out.length) ctx.emit({ type: 'inbox', data: { to: out.filter((x) => !x.quiet).map((x) => x.id), quiet: out.filter((x) => x.quiet).map((x) => x.id) } });
  return out;
}

/** The kind of a line from a phone notification's tag (push.ts › sendPush). */
export function kindOfTag(tag: unknown): BellKind {
  const t = typeof tag === 'string' ? tag : '';
  if (t.startsWith('depot-') || t === 'private-backup') return 'depot';
  // a livreur's new parcels (livreur.ts), a new order to call (« Bloquer jusqu'à l'appel »: confblock.ts)
  if (t.startsWith('assigned-') || t.startsWith('conf-new-')) return 'order';
  return 'info';
}
