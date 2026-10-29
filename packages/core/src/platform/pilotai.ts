// Pilot AI in the control room: Pilotix's own AI key (shops never bring one), the nightly budget and the test share.
// The learning itself is in modules/pilot.ts; this file only keeps its settings on the platform.
import type { Tenancy } from './tenancy';

export interface PilotConfig {
  /** Dellal answers with Pilotix's key, learns every night and uses the coach's lesson book */
  enabled: boolean;
  /** the most the nightly learning may spend (US dollars, Message Batches prices) */
  maxUsd: number;
  /** the share of new chats that try a new lesson book (0.05–0.5) */
  share: number;
}
export const PILOT_DEFAULTS: PilotConfig = { enabled: false, maxUsd: 0.15, share: 0.2 };

/** The key is its own row, never part of what the control room's screens read. */
const KEY_ROW = 'pilot_key';
const CONF_ROW = 'pilot';
const json = (v: unknown): any => (typeof v === 'string' ? JSON.parse(v) : v);

export async function pilotConfig(t: Tenancy): Promise<PilotConfig & { hasKey: boolean }> {
  const rows = await t.platform.query<{ key: string; value: unknown }>('SELECT key, value FROM platform.settings WHERE key = ANY($1)', [[CONF_ROW, KEY_ROW]]);
  const conf = rows.find((r) => r.key === CONF_ROW);
  const key = rows.find((r) => r.key === KEY_ROW);
  const c = { ...PILOT_DEFAULTS, ...(conf ? json(conf.value) : {}) } as PilotConfig;
  return { enabled: !!c.enabled, maxUsd: Number(c.maxUsd) || 0, share: Number(c.share) || PILOT_DEFAULTS.share, hasKey: !!(key && String(json(key.value)?.key || '').trim()) };
}

/** Server only: Pilotix's AI key when Pilot AI is on (null: off, or no key yet). */
export async function pilotKey(t: Tenancy): Promise<string | null> {
  const c = await pilotConfig(t);
  if (!c.enabled || !c.hasKey) return null;
  const r = (await t.platform.query<{ value: unknown }>('SELECT value FROM platform.settings WHERE key = $1', [KEY_ROW]))[0];
  return (r && String(json(r.value)?.key || '').trim()) || null;
}

/** Saves the settings; `key`: a new key, null to remove it, undefined to keep it. */
export async function savePilotConfig(t: Tenancy, c: PilotConfig, key?: string | null): Promise<void> {
  const clean: PilotConfig = {
    enabled: !!c.enabled,
    maxUsd: Math.min(Math.max(Number(c.maxUsd) || 0, 0), 5),
    share: Math.min(Math.max(Number(c.share) || PILOT_DEFAULTS.share, 0.05), 0.5),
  };
  const up = `INSERT INTO platform.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  await t.platform.query(up, [CONF_ROW, JSON.stringify(clean)]);
  if (key === null) await t.platform.query('DELETE FROM platform.settings WHERE key = $1', [KEY_ROW]);
  else if (typeof key === 'string' && key.trim()) await t.platform.query(up, [KEY_ROW, JSON.stringify({ key: key.trim() })]);
}
