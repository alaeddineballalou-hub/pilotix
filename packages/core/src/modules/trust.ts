// Trust of a customer from their parcels (delivery side of the fraud protection).
//
//   refusals = parcels refused (en retour / retournée) since their last delivered one
//              − 1 when a claim proved the driver was at fault (never called, fake return, fake delivery): once per customer
//   1 refusal  → 🟡 (the landing page sends their next order to be checked)
//   2 refusals → stop-desk only: no home delivery until they receive and pay a parcel
//   3 refusals → blacklisted by Pilotix (silently blocked on the landing pages)
//   a look-alike (new number, same device or same name + commune as a refuser) who refuses → blacklisted at once
//   a delivered parcel forgives everything Pilotix decided by itself (never a blacklist set by a person)
import { Db, num } from '../db';

/** claim reasons that prove the driver, not the customer, made the parcel fail */
export const DRIVER_CLAIMS = ['nocall', 'fakeret', 'fakedeliv'];
export const STOPDESK_AT = 2;
export const BLACKLIST_AT = 3;
export const AUTO_BLACKLIST_REASON = 'Refuse ses colis (3 retours)';
export const LOOKALIKE_BLACKLIST_REASON = 'Ressemble à un client qui refuse ses colis, et a refusé';

export interface Trust {
  refusals: number;
  /** refusals the driver was blamed for (only one is forgiven) */
  driver: number;
  lookAlike: boolean;
}

export async function trustOf(db: Db, customerId: number): Promise<Trust> {
  const r = (
    await db.query(
      `WITH last AS (SELECT max(delivered_at) AS d FROM orders WHERE customer_id = $1 AND delivered_at IS NOT NULL),
       ref AS (
         SELECT o.id, o.looks_like_customer_id,
           EXISTS (SELECT 1 FROM claims k WHERE k.order_id = o.id AND k.reason = ANY($2)) AS drv
         FROM orders o, last
         WHERE o.customer_id = $1 AND NOT o.is_exchange AND o.delivered_at IS NULL
           AND (o.follow_status IN ('returning','returned') OR o.returned_at IS NOT NULL)
           AND (last.d IS NULL OR coalesce(o.returning_at, o.returned_at, o.updated_at) > last.d))
       SELECT count(*)::int AS n, count(*) FILTER (WHERE drv)::int AS d, bool_or(looks_like_customer_id IS NOT NULL AND NOT drv) AS look FROM ref`,
      [customerId, DRIVER_CLAIMS],
    )
  )[0];
  const n = num(r?.n);
  const d = num(r?.d);
  return { refusals: Math.max(0, n - Math.min(d, 1)), driver: d, lookAlike: !!r?.look };
}

/**
 * Works the customer's trust out again (after a delivery status or a driver claim) and applies what follows from it.
 * Returns a line for the order's history when something changed.
 */
export async function applyTrust(db: Db, customerId: number | null): Promise<string | null> {
  if (!customerId) return null;
  const c = (await db.query('SELECT blacklisted, blacklist_auto, stopdesk_only, refusals FROM customers WHERE id = $1 FOR UPDATE', [customerId]))[0];
  if (!c) return null;
  const t = await trustOf(db, customerId);
  const black = t.refusals >= BLACKLIST_AT || (t.lookAlike && t.refusals >= 1);
  const stopdesk = t.refusals >= STOPDESK_AT;
  const lines: string[] = [];
  let blacklisted = !!c.blacklisted;
  let auto = !!c.blacklist_auto;
  let reason: string | null = null;
  if (black && !blacklisted) {
    blacklisted = true;
    auto = true;
    reason = t.refusals >= BLACKLIST_AT ? AUTO_BLACKLIST_REASON : LOOKALIKE_BLACKLIST_REASON;
    lines.push(t.refusals >= BLACKLIST_AT ? `🚫 Client mis en liste noire automatiquement : ${t.refusals} colis refusés` : '🚫 Client mis en liste noire automatiquement : il ressemble à un client qui refuse ses colis, et il a refusé');
  } else if (!black && blacklisted && auto) {
    // forgiven: a paid delivery (or the driver was at fault)
    blacklisted = false;
    auto = false;
    lines.push('✅ Liste noire levée automatiquement : le client a reçu et payé un colis');
  }
  if (stopdesk && !c.stopdesk_only && !blacklisted) lines.push(`🏬 Client en stop-desk uniquement : ${t.refusals} colis refusés (plus de livraison à domicile tant qu’il ne paie pas un colis)`);
  if (!stopdesk && c.stopdesk_only) lines.push('✅ Stop-desk levé : le client peut de nouveau être livré à domicile');
  await db.query(
    `UPDATE customers SET refusals = $2, stopdesk_only = $3, blacklisted = $4, blacklist_auto = $5,
       blacklist_reason = CASE WHEN $4 AND $6::text IS NOT NULL THEN $6 WHEN NOT $4 THEN NULL ELSE blacklist_reason END
     WHERE id = $1`,
    [customerId, t.refusals, stopdesk, blacklisted, auto, reason],
  );
  return lines.length ? lines.join('\n') : null;
}

const BAD = `(b.blacklisted OR b.stopdesk_only OR b.refusals >= 1)`;

/**
 * A new number that looks like a customer who refuses their parcels: the same device sent an order with the refuser's
 * number, or the same full name in the same wilaya and commune. Never blocked for this alone (🟡): if they refuse too,
 * they are blacklisted at once.
 */
export async function lookAlikeOf(
  db: Db,
  i: { phone: string | null; name: string; wilayaId: number | null; commune: string; device?: string | null },
): Promise<{ id: number; phone: string; why: 'device' | 'name' } | null> {
  if (i.device) {
    const r = (
      await db.query(
        `SELECT b.id, b.phone FROM landing_submits s JOIN customers b ON b.phone = s.phone
         WHERE s.fp = $1 AND s.phone IS DISTINCT FROM $2 AND ${BAD} ORDER BY s.at DESC LIMIT 1`,
        [i.device, i.phone],
      )
    )[0];
    if (r) return { id: num(r.id), phone: String(r.phone), why: 'device' };
  }
  const name = i.name.trim().replace(/\s+/g, ' ').toLowerCase();
  const commune = i.commune.trim().toLowerCase();
  // a single word (« Mohamed ») is far too common: a full name only
  if (name.length < 6 || !name.includes(' ') || !commune || !i.wilayaId) return null;
  const r = (
    await db.query(
      `SELECT b.id, b.phone FROM orders o JOIN customers b ON b.id = o.customer_id
       WHERE lower(o.customer_name) = $1 AND o.wilaya_id = $2 AND lower(trim(o.commune)) = $3 AND b.phone IS DISTINCT FROM $4 AND ${BAD}
       ORDER BY o.created_at DESC LIMIT 1`,
      [name, i.wilayaId, commune, i.phone],
    )
  )[0];
  return r ? { id: num(r.id), phone: String(r.phone), why: 'name' } : null;
}

export function lookAlikeNote(l: { phone: string; why: 'device' | 'name' }) {
  return l.why === 'device'
    ? `👀 Même appareil qu’un client qui refuse ses colis (${l.phone}) : appelez avant d’expédier. S’il refuse, il passe en liste noire.`
    : `👀 Même nom et même commune qu’un client qui refuse ses colis (${l.phone}) : appelez avant d’expédier. S’il refuse, il passe en liste noire.`;
}
