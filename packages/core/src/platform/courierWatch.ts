// Control room › Sociétés de livraison: the companies removed from Pilotix (no longer offered to the shops — a shop that
// already uses one keeps it, its parcels keep moving), and « Changements API »: the to-do list of what changed at each
// company's API, found by the server's daily look (documentation, open-source code, API addresses, the team's tests) or
// added by hand. Each line stays « À faire » until someone marks it « Résolu » (and can go back to « À faire »).
import { courierCatalog, isCompany, type CatalogCompany } from '../couriers/catalog';
import { readSetting, writeSetting } from './courierTests';
import { loadShops } from './shops';
import type { Tenancy } from './tenancy';

const REMOVED = 'courier_removed';
const WATCH = 'courier_watch';
const MEMORY = 'courier_watch_memory';

// ---------------------------------------------------------------- removed companies
export interface RemovedCourier {
  at: string;
  by: string | null;
}

export const removedCouriers = (t: Tenancy) => readSetting<RemovedCourier>(t, REMOVED);

export async function removeCourier(t: Tenancy, company: string, by: string | null) {
  const all = await removedCouriers(t);
  all[company] = { at: new Date().toISOString(), by };
  await writeSetting(t, REMOVED, all);
}

export async function restoreCourier(t: Tenancy, company: string) {
  const all = await removedCouriers(t);
  delete all[company];
  await writeSetting(t, REMOVED, all);
}

/** How many stores use this company now (a number only: Pilotix never says which store has what). */
export async function courierUsage(t: Tenancy, co: Pick<CatalogCompany, 'kind' | 'host'>): Promise<number> {
  if (!co.kind) return 0;
  let n = 0;
  for (const s of await loadShops(t)) {
    if (s.kind !== 'store' || s.demo || s.status === 'archived' || s.status === 'deleted') continue;
    try {
      const rows = await t.shop(s.schema).query<{ url: string }>(
        `SELECT coalesce(config->'settings'->>'base_url', '') AS url FROM delivery_companies WHERE active AND kind = $1`,
        [co.kind],
      );
      if (rows.some((r) => isCompany(co, co.kind!, r.url))) n++;
    } catch {
      /* a store not ready yet */
    }
  }
  return n;
}

// ---------------------------------------------------------------- the to-do list
/** What a line is about: the documentation, the open-source code, an API address gone, a test that stopped working,
 *  fields new or gone in the answers, a problem seen in the shops' own use of the API, or a line added by hand. */
export type WatchKind = 'docs' | 'code' | 'gone' | 'broken' | 'fields' | 'shops' | 'manual';
export const WATCH_KINDS: WatchKind[] = ['docs', 'code', 'gone', 'broken', 'fields', 'shops', 'manual'];

export interface WatchItem {
  id: number;
  company: string;
  kind: WatchKind;
  /** the same change found again while still « À faire » is not added twice */
  key: string;
  title: string;
  detail: string;
  link: string | null;
  at: string;
  /** who added it by hand (null: found by Pilotix) */
  by: string | null;
  status: 'open' | 'resolved';
  resolvedAt: string | null;
  /** who marked it « Résolu » (« Pilotix » when it fixed itself: the test works again, the address is back) */
  resolvedBy: string | null;
}

export interface WatchRun {
  at: string;
  /** who asked (null: the daily look) */
  by: string | null;
  /** companies looked at */
  companies: number;
  added: number;
  /** what could not be looked at this time (a page that did not answer…) */
  notes: string[];
}

export interface WatchState {
  items: WatchItem[];
  next: number;
  last: WatchRun | null;
  /** a look started at (cleared at its end; older than 15 minutes = stopped half way) */
  running: string | null;
}

const MAX_ITEMS = 400;

export async function watchState(t: Tenancy): Promise<WatchState> {
  const r = (await readSetting<unknown>(t, WATCH)) as Partial<WatchState>;
  const running = r.running && Date.now() - Date.parse(r.running) < 15 * 60_000 ? r.running : null;
  return { items: Array.isArray(r.items) ? r.items : [], next: Number(r.next) || 1, last: r.last ?? null, running };
}

async function saveWatch(t: Tenancy, s: WatchState) {
  // a list too long loses its oldest « Résolu » lines; « À faire » ones are always kept
  const extra = s.items.length - MAX_ITEMS;
  if (extra > 0) {
    const drop = new Set(
      s.items
        .filter((i) => i.status === 'resolved')
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(0, extra)
        .map((i) => i.id),
    );
    s.items = s.items.filter((i) => !drop.has(i.id));
  }
  await writeSetting(t, WATCH, s);
}

export type NewWatchItem = Pick<WatchItem, 'company' | 'kind' | 'key' | 'title' | 'detail' | 'link'> & { by?: string | null };

/**
 * New lines (one already « À faire » with the same key is not added again), the lines that fixed themselves (keys:
 * marked « Résolu » by Pilotix) and, at the end of a look, its summary. Returns the lines added.
 */
export async function addWatchItems(t: Tenancy, found: NewWatchItem[], opts: { fixed?: string[]; run?: WatchRun } = {}): Promise<WatchItem[]> {
  const s = await watchState(t);
  const now = new Date().toISOString();
  const open = new Set(s.items.filter((i) => i.status === 'open').map((i) => i.key));
  const added: WatchItem[] = [];
  for (const f of found) {
    if (open.has(f.key)) continue;
    open.add(f.key);
    const item: WatchItem = {
      id: s.next++,
      company: f.company,
      kind: f.kind,
      key: f.key.slice(0, 300),
      title: f.title.slice(0, 200),
      detail: f.detail.slice(0, 1500),
      link: f.link,
      at: now,
      by: f.by ?? null,
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
    };
    s.items.unshift(item);
    added.push(item);
  }
  const fixed = new Set(opts.fixed ?? []);
  for (const i of s.items) if (i.status === 'open' && fixed.has(i.key)) Object.assign(i, { status: 'resolved', resolvedAt: now, resolvedBy: 'Pilotix' });
  if (opts.run) {
    s.last = opts.run;
    s.running = null;
  }
  await saveWatch(t, s);
  return added;
}

/** « Résolu » / « À faire » again. */
export async function setWatchStatus(t: Tenancy, id: number, status: WatchItem['status'], by: string | null): Promise<WatchItem | null> {
  const s = await watchState(t);
  const it = s.items.find((i) => i.id === id);
  if (!it) return null;
  it.status = status;
  it.resolvedAt = status === 'resolved' ? new Date().toISOString() : null;
  it.resolvedBy = status === 'resolved' ? by : null;
  await saveWatch(t, s);
  return it;
}

/** Removes a line (the page allows it for the lines added by hand only). */
export async function removeWatchItem(t: Tenancy, id: number): Promise<WatchItem | null> {
  const s = await watchState(t);
  const it = s.items.find((i) => i.id === id) ?? null;
  if (!it) return null;
  s.items = s.items.filter((i) => i.id !== id);
  await saveWatch(t, s);
  return it;
}

/** A look starts (the page shows « en cours » until its summary is saved). */
export async function startWatchRun(t: Tenancy): Promise<string> {
  const s = await watchState(t);
  s.running = new Date().toISOString();
  await saveWatch(t, s);
  return s.running;
}

/** SERVER ONLY: what the last look saw (to tell what changed since), shaped by the couriers' watch module. */
export const watchMemory = async (t: Tenancy): Promise<Record<string, unknown>> => readSetting<unknown>(t, MEMORY);
export const saveWatchMemory = (t: Tenancy, m: object) => writeSetting(t, MEMORY, m);

// ---------------------------------------------------------------- problems seen in the shops
/**
 * The problems the shops meet with each company's API, over the last 14 days (numbers only: never which store): its
 * answers never give the weight it found, never give the parcel's prices, parcels it refused, its prices that could not
 * be taken. One line per company and problem (« À faire »); it is marked « Résolu » by Pilotix once it is gone.
 */
export async function shopsApiProblems(t: Tenancy, nowMs = Date.now()): Promise<{ found: NewWatchItem[]; fixed: string[] }> {
  const catalog = courierCatalog().filter((co) => co.kind && co.kind !== 'own' && co.kind !== 'manual' && co.kind !== 'custom');
  const since = new Date(nowMs - 14 * 86_400_000).toISOString();
  type Agg = { shops: Set<number>; ended: number; weighed: number; priced: number; refused: number; refusedShops: Set<number>; errors: Map<string, number>; feesErr: Map<string, number> };
  const by = new Map<string, Agg>();
  const agg = (k: string) => {
    if (!by.has(k)) by.set(k, { shops: new Set(), ended: 0, weighed: 0, priced: 0, refused: 0, refusedShops: new Set(), errors: new Map(), feesErr: new Map() });
    return by.get(k)!;
  };
  for (const sh of await loadShops(t)) {
    if (sh.kind !== 'store' || sh.demo || sh.status === 'archived' || sh.status === 'deleted') continue;
    try {
      const db = t.shop(sh.schema);
      const comps = await db.query<any>(`SELECT id, kind, coalesce(config->'settings'->>'base_url', '') AS url, config->'feesSync'->>'error' AS fees_error FROM delivery_companies WHERE active`);
      for (const c of comps) {
        const co = catalog.find((x) => x.kind === c.kind && isCompany(x, c.kind, c.url));
        if (!co) continue;
        const a = agg(co.key);
        a.shops.add(sh.id);
        const r = (
          await db.query<any>(
            `SELECT count(*) FILTER (WHERE (courier_fees->>'final') IS NOT NULL OR (courier_fees->>'src') = 'pay')::int AS ended,
                    count(*) FILTER (WHERE ((courier_fees->>'final') IS NOT NULL OR (courier_fees->>'src') = 'pay') AND (courier_fees->>'kg') IS NOT NULL)::int AS weighed,
                    count(*) FILTER (WHERE ((courier_fees->>'final') IS NOT NULL OR (courier_fees->>'src') = 'pay') AND ((courier_fees->>'delivery') IS NOT NULL OR (courier_fees->>'ret') IS NOT NULL))::int AS priced
               FROM orders WHERE company_id = $1 AND follow_status IN ('delivered','returned','exchanged') AND updated_at >= $2`,
            [c.id, since],
          )
        )[0];
        a.ended += Number(r?.ended) || 0;
        a.weighed += Number(r?.weighed) || 0;
        a.priced += Number(r?.priced) || 0;
        const errs = await db.query<any>(`SELECT send_error AS e, count(*)::int AS n FROM orders WHERE company_id = $1 AND send_error IS NOT NULL AND send_error_at >= $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 5`, [c.id, since]);
        for (const e of errs) {
          a.refused += Number(e.n) || 0;
          a.refusedShops.add(sh.id);
          // the company's words only (an order's number or a phone is not kept)
          const txt = String(e.e).replace(/\b(PX|px)\d+\b/g, '…').replace(/0[5-7]\d{8}/g, '…').slice(0, 140);
          a.errors.set(txt, (a.errors.get(txt) ?? 0) + Number(e.n));
        }
        if (c.fees_error) a.feesErr.set(String(c.fees_error).slice(0, 140), (a.feesErr.get(String(c.fees_error).slice(0, 140)) ?? 0) + 1);
      }
    } catch {
      /* a store not ready yet */
    }
  }
  const found: NewWatchItem[] = [];
  const fixed: string[] = [];
  const shopsTxt = (n: number) => (n > 1 ? `${n} boutiques` : '1 boutique');
  const top = (m: Map<string, number>) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([e, n]) => `« ${e} » (${n})`).join(' · ');
  for (const [key, a] of by) {
    const co = catalog.find((x) => x.key === key)!;
    const where = `couriers/${co.kind}.ts`;
    const line = (problem: string, on: boolean, title: string, detail: string) => {
      const k = `shops:${problem}:${key}`;
      if (on) found.push({ company: key, kind: 'shops', key: k, title, detail, link: null });
      else fixed.push(k);
    };
    const enough = a.ended >= 5;
    line('weight', enough && a.weighed === 0, 'Ses réponses ne donnent pas le poids',
      `Vu dans ${shopsTxt(a.shops.size)} : ${a.ended} colis finis ces 14 jours (livrés, retournés, échangés), aucun avec le poids trouvé par la société. Le surpoids ne peut pas être compté. Chercher où elle met le poids dans sa réponse (${where}).`);
    line('prices', enough && a.priced === 0, 'Ses réponses ne donnent pas les prix du colis',
      `Vu dans ${shopsTxt(a.shops.size)} : ${a.ended} colis finis ces 14 jours, aucun avec son prix de livraison ou de retour : la grille de prix est utilisée à la place. Chercher où elle met ses prix dans sa réponse (${where}).`);
    line('refused', a.refused >= 3, 'Colis refusés par son API',
      `${a.refused} colis refusés ces 14 jours dans ${shopsTxt(a.refusedShops.size)}. Raisons les plus vues : ${top(a.errors)}.`);
    line('fees', a.feesErr.size > 0, 'Ses prix n’ont pas pu être repris',
      `La mise à jour des prix échoue dans ${shopsTxt([...a.feesErr.values()].reduce((x, y) => x + y, 0))} : ${top(a.feesErr)}.`);
  }
  return { found, fixed };
}
