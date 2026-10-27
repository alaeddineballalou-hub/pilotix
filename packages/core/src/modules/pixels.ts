// Landing pages › Réglages › Pixels: the shop's Meta and TikTok pixels, by name. Each landing page and group page
// picks one of each platform (NULL: the default one, 0: none). Real orders reach them from the server only (Meta's
// Conversions API, TikTok's Events API) with the same fake-order rules; each pixel can have its own token, kept on the
// server (settings secret_pixel_<id>): the app only learns whether one is saved.
import { z } from 'zod';
import { Db, iso, num } from '../db';
import { bad, Ctx, forbidden, notFound, proc } from '../rpc';

export const PIXEL_PLATFORMS = ['meta', 'tiktok'] as const;
export type PixelPlatform = (typeof PIXEL_PLATFORMS)[number];
const WHO = ['marketer'] as const;
const id = z.number().int().positive();
const secretKey = (pixelRowId: number) => `secret_pixel_${pixelRowId}`;
const META_ID = /^\d{5,20}$/;
const TIKTOK_ID = /^[A-Z0-9]{10,30}$/;

export interface PixelRow {
  id: number;
  platform: PixelPlatform;
  name: string;
  pixelId: string;
  testCode: string;
  isDefault: boolean;
  hasToken: boolean;
  /** pages and groups that chose it */
  pages: number;
  createdAt: string;
}

export async function listPixels(db: Db): Promise<PixelRow[]> {
  const rows = await db.query(
    `SELECT p.*, EXISTS (SELECT 1 FROM settings s WHERE s.key = 'secret_pixel_' || p.id) AS has_token,
       (SELECT count(*)::int FROM landing_pages l WHERE CASE p.platform WHEN 'meta' THEN l.meta_pixels ELSE l.tiktok_pixels END @> to_jsonb(p.id))
       + (SELECT count(*)::int FROM landing_groups g WHERE CASE p.platform WHEN 'meta' THEN g.meta_pixels ELSE g.tiktok_pixels END @> to_jsonb(p.id)) AS n_pages
     FROM tracking_pixels p ORDER BY p.platform, p.is_default DESC, lower(p.name), p.id`,
  );
  return rows.map((r: any) => ({
    id: num(r.id),
    platform: r.platform as PixelPlatform,
    name: String(r.name),
    pixelId: String(r.pixel_id),
    testCode: String(r.test_code ?? ''),
    isDefault: !!r.is_default,
    hasToken: !!r.has_token,
    pages: num(r.n_pages),
    createdAt: iso(r.created_at),
  }));
}

/** a page's or group's list of pixels of a platform: null = the default one, [] = none */
const listOf = (v: unknown): number[] | null => {
  const a = typeof v === 'string' ? JSON.parse(v) : v;
  return Array.isArray(a) ? a.map(Number).filter((x) => Number.isInteger(x) && x > 0) : null;
};

/**
 * The pixels a page (or group) reports to: the ones it ticked, else the platform's default. Meta also falls back on
 * what the page had typed before pixels had names, then on the pixel of Réglages.
 */
export async function pixelsOf(
  db: Db,
  row: { meta_pixels?: unknown; tiktok_pixels?: unknown; pixel_id?: unknown } | null | undefined,
  legacyDefault: string,
): Promise<{ meta: string[]; tiktok: string[] }> {
  const all = await db.query('SELECT id, platform, pixel_id, is_default FROM tracking_pixels ORDER BY id');
  const pick = (platform: PixelPlatform, v: unknown): string[] | null => {
    const ids = listOf(v);
    if (ids === null) return null;
    return all.filter((p: any) => p.platform === platform && ids.includes(num(p.id))).map((p: any) => String(p.pixel_id));
  };
  const def = (platform: PixelPlatform) => all.find((p: any) => p.platform === platform && p.is_default);
  const legacy = String(row?.pixel_id ?? '').trim();
  const dm = def('meta');
  const dt = def('tiktok');
  const meta = pick('meta', row?.meta_pixels) ?? [legacy || (dm ? String(dm.pixel_id) : legacyDefault.trim())];
  const tiktok = pick('tiktok', row?.tiktok_pixels) ?? (dt ? [String(dt.pixel_id)] : []);
  return { meta: [...new Set(meta.filter((x) => META_ID.test(x)))], tiktok: [...new Set(tiktok.filter((x) => TIKTOK_ID.test(x)))] };
}

/** The token of a pixel (its own), or '' (Meta then uses the shop's Conversions API token). */
export async function pixelToken(db: Db, platform: PixelPlatform, pixelId: string): Promise<string> {
  const r = (
    await db.query(`SELECT s.value FROM tracking_pixels p JOIN settings s ON s.key = 'secret_pixel_' || p.id WHERE p.platform = $1 AND p.pixel_id = $2`, [platform, pixelId])
  )[0];
  return r ? String(r.value ?? '') : '';
}

/** TikTok's test event code of a pixel ('' for none). */
export async function pixelTestCode(db: Db, platform: PixelPlatform, pixelId: string): Promise<string> {
  return String((await db.query('SELECT test_code FROM tracking_pixels WHERE platform = $1 AND pixel_id = $2', [platform, pixelId]))[0]?.test_code ?? '');
}

/** a page's or group's pixels of one platform: null = the default one, [] = none, else pixels of that platform */
export const PixelList = z.array(id).max(10, '10 pixels au maximum').nullable().default(null);
export async function checkPixels(db: Db, platform: PixelPlatform, ids: number[] | null) {
  if (!ids?.length) return;
  const n = num((await db.query('SELECT count(*)::int AS n FROM tracking_pixels WHERE id = ANY($1) AND platform = $2', [[...new Set(ids)], platform]))[0].n);
  if (n !== new Set(ids).size) throw notFound('Pixel introuvable');
}
export const pixelsJson = (ids: number[] | null) => (ids === null ? null : JSON.stringify([...new Set(ids)]));
export const readPixels = listOf;

const PixelInput = z.object({
  id: id.optional(),
  platform: z.enum(PIXEL_PLATFORMS),
  name: z.string().trim().min(1, 'Donnez un nom au pixel').max(80),
  pixelId: z.string().trim().max(40),
  testCode: z.string().trim().max(40).regex(/^[A-Za-z0-9_-]*$/, 'Code de test : lettres et chiffres').default(''),
  isDefault: z.boolean().default(false),
  /** '' = unchanged, null = removed, else the new token (administrator only) */
  token: z.string().max(1000).nullable().default(''),
});

export const pixelProcs = {
  'landing.pixels': proc([...WHO], z.object({}), (ctx) => listPixels(ctx.db)),

  'landing.pixelSave': proc([...WHO], PixelInput, async (ctx: Ctx, i) => {
    const pixelId = i.platform === 'tiktok' ? i.pixelId.toUpperCase() : i.pixelId.replace(/\s/g, '');
    if (i.platform === 'meta' && !META_ID.test(pixelId)) throw bad('Pixel Meta : 5 à 20 chiffres (Gestionnaire d’événements › Paramètres)');
    if (i.platform === 'tiktok' && !TIKTOK_ID.test(pixelId)) throw bad('Pixel TikTok : son code (lettres et chiffres, ex. CQ1AB2C3D4E5F6G7H8I9), dans TikTok Ads › Outils › Événements');
    if (i.token !== '' && !ctx.session.isAdmin) throw forbidden('Seul l’administrateur modifie le jeton d’un pixel');
    const dup = (await ctx.db.query('SELECT id FROM tracking_pixels WHERE platform = $1 AND pixel_id = $2', [i.platform, pixelId]))[0];
    if (dup && num(dup.id) !== i.id) throw bad('Ce pixel est déjà dans la liste');
    const rowId = await ctx.db.tx(async (tx) => {
      let rid: number;
      if (i.id) {
        const cur = (await tx.query('SELECT platform FROM tracking_pixels WHERE id = $1', [i.id]))[0];
        if (!cur) throw notFound('Pixel introuvable');
        if (cur.platform !== i.platform) throw bad('La plateforme d’un pixel ne change pas');
        await tx.query('UPDATE tracking_pixels SET name = $2, pixel_id = $3, test_code = $4 WHERE id = $1', [i.id, i.name, pixelId, i.testCode]);
        rid = i.id;
      } else {
        rid = num((await tx.query('INSERT INTO tracking_pixels (platform, name, pixel_id, test_code, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [i.platform, i.name, pixelId, i.testCode, ctx.session.profile.id]))[0].id);
      }
      // one default per platform; the first pixel of a platform is its default
      const first = !(await tx.query('SELECT 1 FROM tracking_pixels WHERE platform = $1 AND is_default AND id <> $2', [i.platform, rid])).length;
      if (i.isDefault || first) {
        await tx.query('UPDATE tracking_pixels SET is_default = (id = $2) WHERE platform = $1', [i.platform, rid]);
      }
      if (i.token === null) await tx.query('DELETE FROM settings WHERE key = $1', [secretKey(rid)]);
      else if (i.token.trim())
        await tx.query(
          `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [secretKey(rid), JSON.stringify(i.token.trim()), ctx.session.profile.id],
        );
      return rid;
    });
    // events that waited for a token: sent again
    if (i.token && i.token.trim()) await ctx.db.query(`UPDATE meta_events SET send_after = now(), error = NULL WHERE status = 'queued' AND pixel_id = $1 AND platform = $2`, [pixelId, i.platform]);
    return (await listPixels(ctx.db)).find((p) => p.id === rowId)!;
  }),

  'landing.pixelRemove': proc([...WHO], z.object({ id }), async (ctx, { id: rid }) => {
    const p = (await ctx.db.query('SELECT platform, is_default FROM tracking_pixels WHERE id = $1', [rid]))[0];
    if (!p) throw notFound('Pixel introuvable');
    await ctx.db.tx(async (tx) => {
      // the pages that chose it follow the default again
      // taken off the pages that ticked it (a page left with none of its own follows the default again)
      const col = p.platform === 'tiktok' ? 'tiktok_pixels' : 'meta_pixels';
      for (const table of ['landing_pages', 'landing_groups'])
        await tx.query(`UPDATE ${table} SET ${col} = (SELECT jsonb_agg(x) FROM jsonb_array_elements(${col}) x WHERE x <> to_jsonb($1::bigint)) WHERE ${col} @> to_jsonb($1::bigint)`, [rid]);
      await tx.query('DELETE FROM tracking_pixels WHERE id = $1', [rid]);
      await tx.query('DELETE FROM settings WHERE key = $1', [secretKey(rid)]);
      if (p.is_default) await tx.query(`UPDATE tracking_pixels SET is_default = true WHERE id = (SELECT id FROM tracking_pixels WHERE platform = $1 ORDER BY id LIMIT 1)`, [p.platform]);
    });
    return { ok: true };
  }),
};
