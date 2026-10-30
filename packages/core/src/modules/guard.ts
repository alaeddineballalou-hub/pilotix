// The anti-fraud check of the orders that do not come from a landing page (a Google Sheet, the AI seller, the site's
// webhook, an order typed by hand): no browser to look at, but the same phone, name, history and Pilotix network
// signals as the landing pages (fraud.ts). A doubtful order gets the reasons in its note; with « check », one that a
// landing page would block goes to « À vérifier » (never dropped: a person decides).
import type { Ctx } from '../rpc';
import type { Db } from '../db';
import { num } from '../db';
import { scoreOrder, type FraudResult } from './fraud';
import { phoneHistory, reasonsText, TEAM_CODES } from './landing';
import { sharedReputation } from '../platform/reputation';

export type GuardMode = 'note' | 'check';

const H = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

/** The score of an order from another channel; null when there is nothing to judge (no phone). */
export async function channelGuard(
  ctx: Ctx,
  db: Db,
  a: { phone: string | null; name: string; wilayaId: number | null; commune: string; productIds: number[]; qty: number },
): Promise<FraudResult | null> {
  if (!a.phone) return null;
  const now = ctx.now();
  const name = a.name.trim().toLowerCase().replace(/\s+/g, ' ');
  const r = (
    await db.query(
      `SELECT
         (SELECT count(*)::int FROM sales WHERE phone = $1 AND created_at > $2) AS phone24h,
         (SELECT count(*)::int FROM sales o WHERE o.phone = $1 AND o.created_at > $2 AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.product_id = ANY($3))) AS dup,
         (SELECT count(DISTINCT phone)::int FROM sales WHERE left(phone, 8) = left($1, 8) AND phone <> $1 AND created_at > $2) AS near,
         (SELECT count(DISTINCT phone)::int FROM sales WHERE $4 <> '' AND lower(customer_name) = $4 AND wilaya_id = $5 AND phone <> $1 AND created_at > $6) AS names`,
      [a.phone, iso(now - 24 * H), a.productIds, name, a.wilayaId ?? 0, iso(now - 7 * 24 * H)],
    )
  )[0];
  const history = await phoneHistory(db, a.phone, { name: a.name, wilayaId: a.wilayaId, commune: a.commune, device: null });
  const shared = await sharedReputation(ctx, { phone: a.phone, fphash: null });
  return scoreOrder({
    name: a.name,
    phoneRaw: a.phone,
    phone: a.phone,
    qty: a.qty,
    honeypot: '',
    // no browser: the robot checks of a landing page do not apply
    servedMs: 60_000,
    clientMs: null,
    inputs: null,
    pow: 'ok',
    userAgent: 'Pilotix order channel',
    webdriver: false,
    recent: { phone24h: num(r.phone24h), phoneSameProduct24h: num(r.dup), ip10m: 0, ip1h: 0, device1h: 0, nearPhones24h: num(r.near), nameOtherPhones7d: num(r.names) },
    history,
    shared,
    turnstile: 'off',
    turnstileExpected: false,
    behavior: null,
    ipCountry: null,
    ipWilaya: null,
    wilayaId: a.wilayaId ?? 0,
  });
}

/** The note the agent reads before calling. */
export function guardNote(r: FraudResult, mode: GuardMode): string {
  const lines = [`⚠ Protection anti-fraude : score ${r.score}/100 — ${reasonsText(r.reasons)}${r.verdict === 'block' && mode === 'check' ? ' (mise « À vérifier »)' : ''}`];
  if (r.reasons.some((x) => x.points > 0 && TEAM_CODES.includes(x.code))) lines.push('🕵️ Peut-être un concurrent : demandez la wilaya et un repère près de chez lui avant d’expédier.');
  return lines.join('\n');
}
