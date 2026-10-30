// Pilot AI in the control room: Pilotix's own AI key (shops never bring one), the nightly budget, the daily limit of
// the live answers (every shop together) and the test share. The learning itself is in modules/pilotlearn.ts; this file
// only keeps its settings on the platform.
import type { Tenancy } from './tenancy';

export interface PilotConfig {
  /** Dellal answers with Pilotix's key, learns every night and uses the coach's lesson book */
  enabled: boolean;
  /** the most the nightly learning may spend (US dollars, Message Batches prices) */
  maxUsd: number;
  /** the share of new chats that try a new lesson book (0.05–0.5) */
  share: number;
  /** the shops whose chats teach Dellal (chosen in the control room only; their terms say it) */
  shops: number[];
  /**
   * the most Pilotix's key may spend on live answers in one day, every shop together (US dollars, Algeria's day; 0 = no
   * limit). Reached: the AI rests until midnight (Dellal answers with its simple rules) and the owner gets an e-mail.
   */
  dayUsd: number;
}
export const PILOT_DEFAULTS: PilotConfig = { enabled: false, maxUsd: 0.15, share: 0.2, shops: [], dayUsd: 3 };
const DAY_MAX = 200;

/** The key is its own row, never part of what the control room's screens read. */
const KEY_ROW = 'pilot_key';
const CONF_ROW = 'pilot';
const json = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);

export async function pilotConfig(t: Tenancy): Promise<PilotConfig & { hasKey: boolean }> {
  const rows = await t.platform.query<{ key: string; value: unknown }>('SELECT key, value FROM platform.settings WHERE key = ANY($1)', [[CONF_ROW, KEY_ROW]]);
  const conf = rows.find((r) => r.key === CONF_ROW);
  const key = rows.find((r) => r.key === KEY_ROW);
  const c = { ...PILOT_DEFAULTS, ...(conf ? json(conf.value) : {}) } as PilotConfig;
  const shops = [...new Set((Array.isArray(c.shops) ? c.shops : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  const day = Number(c.dayUsd);
  return {
    enabled: !!c.enabled,
    maxUsd: Number(c.maxUsd) || 0,
    share: Number(c.share) || PILOT_DEFAULTS.share,
    shops,
    dayUsd: Number.isFinite(day) ? Math.min(Math.max(day, 0), DAY_MAX) : PILOT_DEFAULTS.dayUsd,
    hasKey: !!(key && String(json(key.value)?.key || '').trim()),
  };
}

/** What Pilotix's key spent on live answers today (Algeria's day), every shop together, in USD. */
export async function pilotSpentToday(t: Tenancy): Promise<number> {
  const r = await t.platform
    .query<{ usd: unknown }>(`SELECT coalesce(sum(usd), 0) AS usd FROM platform.ai_usage WHERE payer = 'pilotix' AND day = (now() AT TIME ZONE 'Africa/Algiers')::date`)
    .catch(() => [{ usd: 0 }]);
  return Number(r[0]?.usd) || 0;
}

/** Today's spend against the daily limit: rest = the AI rests until midnight (the limit is reached). */
export async function pilotToday(t: Tenancy, c?: PilotConfig): Promise<{ usd: number; dayUsd: number; rest: boolean }> {
  const conf = c ?? (await pilotConfig(t));
  const usd = await pilotSpentToday(t);
  return { usd, dayUsd: conf.dayUsd, rest: conf.dayUsd > 0 && usd >= conf.dayUsd };
}

/** Server only: Pilotix's key for a live answer, unless today's limit is reached (null: off, no key, or resting). */
export async function pilotLiveKey(t: Tenancy): Promise<string | null> {
  const c = await pilotConfig(t);
  if (!c.enabled || !c.hasKey || (await pilotToday(t, c)).rest) return null;
  return pilotKey(t);
}

/**
 * The daily limit was just reached and nobody heard it today: true once a day (the server then e-mails the owner and the
 * managers). The day is written atomically, so two answers at the same second send one e-mail.
 */
export async function takePilotRestAlert(t: Tenancy): Promise<{ usd: number; dayUsd: number } | null> {
  const c = await pilotConfig(t);
  if (!c.enabled || !c.hasKey) return null;
  const today = await pilotToday(t, c);
  if (!today.rest) return null;
  const r = await t.platform.query(
    `INSERT INTO platform.settings (key, value) VALUES ('pilot_rest_alert', jsonb_build_object('day', (now() AT TIME ZONE 'Africa/Algiers')::date::text))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
       WHERE platform.settings.value->>'day' IS DISTINCT FROM EXCLUDED.value->>'day'
     RETURNING key`,
  );
  return r.length ? { usd: today.usd, dayUsd: today.dayUsd } : null;
}

/** Server only: Pilotix's AI key when Pilot AI is on (null: off, or no key yet). */
export async function pilotKey(t: Tenancy): Promise<string | null> {
  const c = await pilotConfig(t);
  if (!c.enabled || !c.hasKey) return null;
  const r = (await t.platform.query<{ value: unknown }>('SELECT value FROM platform.settings WHERE key = $1', [KEY_ROW]))[0];
  return (r && String(json(r.value)?.key || '').trim()) || null;
}

/** Saves the settings; `key`: a new key, null to remove it, undefined to keep it. */
export async function savePilotConfig(t: Tenancy, c: Omit<PilotConfig, 'shops' | 'dayUsd'> & { shops?: number[]; dayUsd?: number }, key?: string | null): Promise<void> {
  const before = c.shops === undefined || c.dayUsd === undefined ? await pilotConfig(t) : null;
  const clean: PilotConfig = {
    enabled: !!c.enabled,
    maxUsd: Math.min(Math.max(Number(c.maxUsd) || 0, 0), 5),
    share: Math.min(Math.max(Number(c.share) || PILOT_DEFAULTS.share, 0.05), 0.5),
    shops: c.shops ?? before!.shops,
    dayUsd: c.dayUsd === undefined ? before!.dayUsd : Math.min(Math.max(Number(c.dayUsd) || 0, 0), DAY_MAX),
  };
  const up = `INSERT INTO platform.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  await t.platform.query(up, [CONF_ROW, JSON.stringify(clean)]);
  if (key === null) await t.platform.query('DELETE FROM platform.settings WHERE key = $1', [KEY_ROW]);
  else if (typeof key === 'string' && key.trim()) await t.platform.query(up, [KEY_ROW, JSON.stringify({ key: key.trim() })]);
}

/** The coach's morning note: how many lessons wait for an answer, how many came since `since` (tonight), the first five. */
export async function pilotCoachDigest(t: Tenancy, since?: Date): Promise<{ waiting: number; fresh: number; lessons: { topic: string; text: string }[] }> {
  const [n, top] = await Promise.all([
    t.platform.query<{ waiting: unknown; fresh: unknown }>(
      `SELECT count(*)::int AS waiting, count(*) FILTER (WHERE created_at >= $1)::int AS fresh FROM platform.pilot_lessons WHERE status = 'candidate'`,
      [(since ?? new Date()).toISOString()],
    ),
    t.platform.query<{ topic: string; text: string }>(`SELECT topic, text FROM platform.pilot_lessons WHERE status = 'candidate' ORDER BY prio DESC, id DESC LIMIT 5`),
  ]);
  return { waiting: Number(n[0]?.waiting) || 0, fresh: since ? Number(n[0]?.fresh) || 0 : 0, lessons: top.map((r) => ({ topic: String(r.topic), text: String(r.text) })) };
}
