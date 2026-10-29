// Control room › Sociétés de livraison: the companies removed from Pilotix (no longer offered to the shops — a shop that
// already uses one keeps it, its parcels keep moving), and « Changements API »: the to-do list of what changed at each
// company's API, found by the server's daily look (documentation, open-source code, API addresses, the team's tests) or
// added by hand. Each line stays « À faire » until someone marks it « Résolu » (and can go back to « À faire »).
import { isCompany, type CatalogCompany } from '../couriers/catalog';
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
 *  fields new or gone in the answers, or a line added by hand. */
export type WatchKind = 'docs' | 'code' | 'gone' | 'broken' | 'fields' | 'manual';
export const WATCH_KINDS: WatchKind[] = ['docs', 'code', 'gone', 'broken', 'fields', 'manual'];

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
