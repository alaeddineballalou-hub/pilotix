// The secrets saved before the server had its DATA_KEY (or by an older version) are sealed at each start, in the
// background: the control room's settings, Facebook / TikTok tokens and Turnstile secrets, then every shop's secret
// settings and couriers' keys. Each value is read as it is stored (its text: a sealed value is never opened here) and
// written back only when something in it was still readable, and only if nobody changed it meanwhile.
import { isSecretSetting, PLATFORM_SECRETS, SEALED, sealDeep, sealingOn, sealPlatformSetting, sealSetting, sealString } from '../secretbox';
import { loadShops } from './shops';
import type { Tenancy } from './tenancy';

/** The stored JSON as it is (its text, parsed without opening anything), sealed: the new text when it changed. */
function resealed(raw: string, seal: (v: unknown) => unknown): string | null {
  const stored = JSON.parse(raw);
  const next = JSON.stringify(seal(stored));
  return next === JSON.stringify(stored) ? null : next;
}

export async function sealStoredSecrets(t: Tenancy): Promise<{ sealed: number; shops: number } | null> {
  if (!sealingOn()) return null;
  let sealed = 0;
  // the control room's settings
  for (const r of await t.platform.query<{ key: string; raw: string }>(`SELECT key, value::text AS raw FROM platform.settings WHERE key = ANY($1)`, [Object.keys(PLATFORM_SECRETS)])) {
    const next = resealed(r.raw, (v) => sealPlatformSetting(r.key, v));
    if (next) sealed += (await t.platform.query(`UPDATE platform.settings SET value = $2::jsonb WHERE key = $1 AND value::text = $3 RETURNING key`, [r.key, next, r.raw])).length;
  }
  // tokens and widget secrets (text columns: a value still readable does not start with the seal's mark)
  for (const [table, col, idCol] of [
    ['platform.social_links', 'token', 'id'],
    ['platform.social_assets', 'token', 'id'],
    ['platform.turnstile_widgets', 'secret', 'sitekey'],
  ] as const) {
    const rows = await t.platform.query<{ id: string; v: string }>(`SELECT ${idCol}::text AS id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL AND ${col} <> '' AND left(${col}, ${SEALED.length}) <> $1`, [SEALED]);
    for (const r of rows) sealed += (await t.platform.query(`UPDATE ${table} SET ${col} = $2 WHERE ${idCol}::text = $1 AND ${col} = $3 RETURNING 1`, [r.id, sealString(r.v), r.v])).length;
  }
  // every shop: its secret settings and its couriers' keys
  const shops = await loadShops(t);
  for (const s of shops) {
    const db = t.shop(s.schema);
    try {
      for (const r of await db.query<{ key: string; raw: string }>(`SELECT key, value::text AS raw FROM settings WHERE key LIKE 'secret\\_%' OR key = 'landing_secret'`)) {
        if (!isSecretSetting(r.key)) continue;
        const next = resealed(r.raw, (v) => sealSetting(r.key, v));
        if (next) sealed += (await db.query(`UPDATE settings SET value = $2::jsonb WHERE key = $1 AND value::text = $3 RETURNING 1`, [r.key, next, r.raw])).length;
      }
      for (const r of await db.query<{ id: string; raw: string }>(`SELECT id::text AS id, credentials::text AS raw FROM delivery_companies WHERE credentials IS NOT NULL`)) {
        const next = resealed(r.raw, (v) => sealDeep(v));
        if (next) sealed += (await db.query(`UPDATE delivery_companies SET credentials = $2::jsonb WHERE id::text = $1 AND credentials::text = $3 RETURNING 1`, [r.id, next, r.raw])).length;
      }
    } catch {
      /* a shop being made or removed right now: the next start does it */
    }
  }
  return { sealed, shops: shops.length };
}
