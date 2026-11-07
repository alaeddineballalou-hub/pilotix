// AI Spy in the control room (Pilot AI › Spy AI): Pilotix's own search key, shops never bring one. The main tool
// (ScrapeCreators unless the owner picks SearchAPI.io) searches Facebook's Ad Library in Algeria for every shop whose plan
// has AI Spy; the other tool, when it has a key too, takes over when the main one fails. One search = one keyword: a shop
// may make `perShopDay` of them in one day (Algeria's day), counted here (platform.spy_searches). The free Chrome
// extension stays, without a limit (it searches from the person's own Chrome).
import type { Tenancy } from './tenancy';
import { sealPlatformSetting } from '../secretbox';

export const SPY_TOOLS = ['scrapecreators', 'searchapi'] as const;
export type SpyTool = (typeof SPY_TOOLS)[number];

export interface SpyPlatformConfig {
  /** the shops search with Pilotix's key */
  enabled: boolean;
  /** the main tool; the other one, when it has a key, is the backup */
  main: SpyTool;
  /** searches (keywords) one shop may make in one day, Algeria's day */
  perShopDay: number;
}
export const SPY_PLATFORM_DEFAULTS: SpyPlatformConfig = { enabled: false, main: 'scrapecreators', perShopDay: 20 };
export const SPY_PER_SHOP_MAX = 500;

const CONF_ROW = 'spy_platform';
/** Each key is its own row, never part of what the control room's screens read (sealed: secretbox's PLATFORM_SECRETS). */
export const SPY_KEY_ROWS: Readonly<Record<SpyTool, string>> = { scrapecreators: 'spy_key_scrapecreators', searchapi: 'spy_key_searchapi' };

export const SPY_SEARCHES_SQL = `
CREATE TABLE IF NOT EXISTS platform.spy_searches (
  day date NOT NULL,
  shop_id integer NOT NULL,
  n integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, shop_id)
);`;

const json = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);
/** Algeria's day (UTC+1, no daylight saving) */
const dzDay = (now: number) => new Date(now + 3_600_000).toISOString().slice(0, 10);
const isTool = (v: unknown): v is SpyTool => (SPY_TOOLS as readonly unknown[]).includes(v);

async function rows(t: Tenancy): Promise<{ key: string; value: unknown }[]> {
  return t.platform.query<{ key: string; value: unknown }>('SELECT key, value FROM platform.settings WHERE key = ANY($1)', [[CONF_ROW, ...Object.values(SPY_KEY_ROWS)]]);
}
const keyIn = (list: { key: string; value: unknown }[], tool: SpyTool): string => String(json(list.find((r) => r.key === SPY_KEY_ROWS[tool])?.value)?.key || '').trim();

/** The settings, and which tools have a key (the keys themselves never leave the server). */
export async function spyPlatformConfig(t: Tenancy): Promise<SpyPlatformConfig & { keys: Record<SpyTool, boolean> }> {
  const list = await rows(t);
  const conf = list.find((r) => r.key === CONF_ROW);
  const c = { ...SPY_PLATFORM_DEFAULTS, ...(conf ? json(conf.value) : {}) } as SpyPlatformConfig;
  const per = Math.round(Number(c.perShopDay));
  return {
    enabled: !!c.enabled,
    main: isTool(c.main) ? c.main : SPY_PLATFORM_DEFAULTS.main,
    perShopDay: Number.isFinite(per) && per >= 1 ? Math.min(per, SPY_PER_SHOP_MAX) : SPY_PLATFORM_DEFAULTS.perShopDay,
    keys: { scrapecreators: !!keyIn(list, 'scrapecreators'), searchapi: !!keyIn(list, 'searchapi') },
  };
}

/** Server only: one tool's saved key, on or off (the control room's « Tester »). */
export async function spyPlatformKey(t: Tenancy, tool: SpyTool): Promise<string> {
  return keyIn(await rows(t), tool);
}

/** Server only: the tools a shop's search uses, in order (the main one, then the backup); [] when off or without a key. */
export async function spyPlatformTools(t: Tenancy): Promise<{ tool: SpyTool; key: string }[]> {
  const list = await rows(t);
  const c = await spyPlatformConfig(t);
  if (!c.enabled) return [];
  const order: SpyTool[] = [c.main, ...SPY_TOOLS.filter((x) => x !== c.main)];
  return order.map((tool) => ({ tool, key: keyIn(list, tool) })).filter((x) => !!x.key);
}

/** Saves the settings; keys: a new key, null to remove it, not given to keep it. */
export async function saveSpyPlatformConfig(t: Tenancy, c: SpyPlatformConfig, keys: Partial<Record<SpyTool, string | null>> = {}): Promise<void> {
  const per = Math.round(Number(c.perShopDay) || SPY_PLATFORM_DEFAULTS.perShopDay);
  const clean: SpyPlatformConfig = { enabled: !!c.enabled, main: isTool(c.main) ? c.main : SPY_PLATFORM_DEFAULTS.main, perShopDay: Math.min(Math.max(per, 1), SPY_PER_SHOP_MAX) };
  const up = `INSERT INTO platform.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  await t.platform.query(up, [CONF_ROW, JSON.stringify(clean)]);
  for (const tool of SPY_TOOLS) {
    const k = keys[tool];
    if (k === null) await t.platform.query('DELETE FROM platform.settings WHERE key = $1', [SPY_KEY_ROWS[tool]]);
    else if (typeof k === 'string' && k.trim()) await t.platform.query(up, [SPY_KEY_ROWS[tool], JSON.stringify(sealPlatformSetting(SPY_KEY_ROWS[tool], { key: k.trim() }))]);
  }
}

/**
 * One search for a shop today if its daily limit allows it: true (counted), false (the limit is reached). Written
 * atomically: two searches at the same second never pass the limit together.
 */
export async function takeSpySearch(t: Tenancy, shopId: number, max: number, now: number): Promise<boolean> {
  const r = await t.platform.query(
    `INSERT INTO platform.spy_searches (day, shop_id, n) SELECT $1::date, $2::int, 1 WHERE $3::int >= 1
     ON CONFLICT (day, shop_id) DO UPDATE SET n = platform.spy_searches.n + 1 WHERE platform.spy_searches.n < $3::int
     RETURNING n`,
    [dzDay(now), shopId, max],
  );
  return r.length > 0;
}

/** Today's searches on Pilotix's key: one shop's, or every shop's together (and how many shops searched). */
export async function spySearchesToday(t: Tenancy, now: number, shopId?: number): Promise<{ searches: number; shops: number }> {
  const r = await t.platform
    .query<{ searches: unknown; shops: unknown }>(
      `SELECT coalesce(sum(n), 0)::int AS searches, count(*)::int AS shops FROM platform.spy_searches WHERE day = $1::date${shopId ? ' AND shop_id = $2' : ''}`,
      shopId ? [dzDay(now), shopId] : [dzDay(now)],
    )
    .catch(() => [{ searches: 0, shops: 0 }]);
  return { searches: Number(r[0]?.searches) || 0, shops: Number(r[0]?.shops) || 0 };
}

/** Each shop's searches on Pilotix's key in [from, to] (Algeria's days). */
export async function spySearchesByShop(t: Tenancy, from: string, to: string): Promise<Map<number, number>> {
  const list = await t.platform
    .query<{ shop_id: unknown; n: unknown }>(`SELECT shop_id, sum(n)::int AS n FROM platform.spy_searches WHERE day BETWEEN $1::date AND $2::date GROUP BY shop_id`, [from, to])
    .catch(() => [] as { shop_id: unknown; n: unknown }[]);
  return new Map(list.map((r) => [Number(r.shop_id), Number(r.n) || 0]));
}
