// What each shop's AI costs Pilotix (control room › Pilot AI › AI cost per shop), so the owner can bill it.
// Every answer Claude gives on the server (Dellal, the CM AI agent, AI Spy) goes through dellal-server › complete(), which
// adds its tokens here: one row per day, shop, feature, model and payer (Pilotix's key or the shop's own), so the table
// stays small. The price is worked out at that moment from Anthropic's list price (USD per million tokens).
import type { Tenancy } from './tenancy';

export const AI_USAGE_SQL = `
CREATE TABLE IF NOT EXISTS platform.ai_usage (
  day date NOT NULL,
  shop_id integer NOT NULL,
  feature text NOT NULL,
  model text NOT NULL,
  payer text NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read bigint NOT NULL DEFAULT 0,
  cache_write bigint NOT NULL DEFAULT 0,
  usd double precision NOT NULL DEFAULT 0,
  PRIMARY KEY (day, shop_id, feature, model, payer)
);
CREATE INDEX IF NOT EXISTS ai_usage_shop ON platform.ai_usage (shop_id, day);
`;

export const AI_FEATURES = ['dellal', 'cm', 'spy', 'other'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];
export type AiPayer = 'pilotix' | 'shop';
/** Anthropic's usage block (as the Messages API returns it). */
export type AiUsage = { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };

type Price = { in: number; out: number; read: number; write: number };
/**
 * Anthropic's list prices, USD per million tokens (live answers, not the half-price night batches). Cache write = the
 * 5-minute cache (1.25 × input), cache read = a hit. Haiku 5.5 costs 5 × more when one prompt is over 100,000 tokens.
 */
const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5, read: 0.01, write: 0.125 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.1, write: 2.5 },
  'claude-opus-5-5': { in: 4, out: 20, read: 0.2, write: 5 },
};
const HAIKU_LONG: Price = { in: 0.5, out: 2.5, read: 0.05, write: 0.625 };
const HAIKU_LONG_FROM = 100_000;

const tok = (x: unknown) => Math.max(0, Math.round(Number(x) || 0));

/** The price list of a model (an unknown one is counted at the dearest family it names, never at zero). */
export function aiPrice(model: string, promptTokens = 0): Price {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return promptTokens > HAIKU_LONG_FROM ? HAIKU_LONG : PRICES['claude-haiku-5-5'];
  if (PRICES[m]) return PRICES[m];
  if (m.includes('opus')) return PRICES['claude-opus-5-5'];
  return PRICES['claude-sonnet-5-5'];
}

/** What one answer cost, in USD. */
export function aiCostUsd(model: string, u: AiUsage | null | undefined): number {
  const inp = tok(u?.input_tokens);
  const out = tok(u?.output_tokens);
  const read = tok(u?.cache_read_input_tokens);
  const write = tok(u?.cache_creation_input_tokens);
  const p = aiPrice(model, inp + read + write);
  return (inp * p.in + out * p.out + read * p.read + write * p.write) / 1e6;
}

/** Adds one answer to the shop's day (Algeria's date). Never throws: counting must not stop an answer. */
export async function recordAiUsage(
  t: Tenancy,
  a: { shopId: number; feature?: string | null; model: string; payer: AiPayer; usage: AiUsage | null | undefined; at?: Date },
): Promise<void> {
  try {
    if (!Number.isInteger(a.shopId) || a.shopId <= 0) return;
    const feature = (AI_FEATURES as readonly string[]).includes(String(a.feature)) ? String(a.feature) : 'other';
    const u = a.usage ?? {};
    await t.platform.query(
      `INSERT INTO platform.ai_usage (day, shop_id, feature, model, payer, calls, input_tokens, output_tokens, cache_read, cache_write, usd)
       VALUES ((($1::timestamptz) AT TIME ZONE 'Africa/Algiers')::date, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10)
       ON CONFLICT (day, shop_id, feature, model, payer) DO UPDATE SET
         calls = platform.ai_usage.calls + 1,
         input_tokens = platform.ai_usage.input_tokens + EXCLUDED.input_tokens,
         output_tokens = platform.ai_usage.output_tokens + EXCLUDED.output_tokens,
         cache_read = platform.ai_usage.cache_read + EXCLUDED.cache_read,
         cache_write = platform.ai_usage.cache_write + EXCLUDED.cache_write,
         usd = platform.ai_usage.usd + EXCLUDED.usd`,
      [
        (a.at ?? new Date()).toISOString(),
        a.shopId,
        feature,
        String(a.model || 'unknown').slice(0, 60),
        a.payer,
        tok(u.input_tokens),
        tok(u.output_tokens),
        tok(u.cache_read_input_tokens),
        tok(u.cache_creation_input_tokens),
        aiCostUsd(a.model, u),
      ],
    );
  } catch {
    /* the table may not exist yet (an update half done): the answer still goes out */
  }
}

/** YYYY-MM of a date in Algeria. */
export function monthOf(at: Date | number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit' }).format(new Date(at)).slice(0, 7);
}

export type AiCostRow = {
  shopId: number;
  feature: AiFeature;
  payer: AiPayer;
  calls: number;
  usd: number;
};

/** The month's answers per shop, feature and payer (Algeria's days). */
export async function aiUsageOfMonth(t: Tenancy, month: string): Promise<AiCostRow[]> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('mois invalide');
  const rows = await t.platform.query(
    `SELECT shop_id, feature, payer, sum(calls)::bigint AS calls, sum(usd) AS usd
       FROM platform.ai_usage
      WHERE day >= ($1 || '-01')::date AND day < (($1 || '-01')::date + interval '1 month')
      GROUP BY shop_id, feature, payer`,
    [month],
  );
  return rows.map((r: any) => ({
    shopId: Number(r.shop_id),
    feature: ((AI_FEATURES as readonly string[]).includes(r.feature) ? r.feature : 'other') as AiFeature,
    payer: (r.payer === 'shop' ? 'shop' : 'pilotix') as AiPayer,
    calls: Number(r.calls) || 0,
    usd: Number(r.usd) || 0,
  }));
}

/** The first day anything was counted (the counter started with this version). */
export async function aiUsageSince(t: Tenancy): Promise<string | null> {
  const r = await t.platform.query(`SELECT min(day)::text AS d FROM platform.ai_usage`);
  return r[0]?.d ?? null;
}

// ---------------------------------------------------------------- the owner's billing rate (DA for 1 $)
const BILL_ROW = 'ai_bill';
export type AiBill = { rate: number };

export async function aiBill(t: Tenancy): Promise<AiBill> {
  const r = await t.platform.query(`SELECT value FROM platform.settings WHERE key = $1`, [BILL_ROW]);
  const rate = Number(r[0]?.value?.rate) || 0;
  return { rate: rate > 0 ? rate : 0 };
}

export async function saveAiBill(t: Tenancy, b: AiBill): Promise<AiBill> {
  const rate = Math.min(Math.max(Number(b.rate) || 0, 0), 10_000);
  await t.platform.query(
    `INSERT INTO platform.settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [BILL_ROW, JSON.stringify({ rate })],
  );
  return { rate };
}
