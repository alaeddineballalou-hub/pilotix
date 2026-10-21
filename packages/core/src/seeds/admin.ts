import type { Db } from '../db';

/** Demo data for the admin feature: sales channels like the original, a cron key, a second client price grid. */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  void now;
  await db.query(
    `INSERT INTO sales_channels (kind, name, creator_id, sku_required, active, config, webhook_key, last_sync_at) VALUES
      ('api', 'Site Pilotix Démo', $1, false, true, '{}', 'demo-chan-key-api-000000000001', now() - interval '2 hours'),
      ('shopify', 'Boutique Shopify', $1, true, false, '{}', 'demo-chan-key-shop-00000000002', NULL),
      ('sheets', 'Commandes Facebook (feuille)', $1, false, true, '{"url":"https://docs.google.com/spreadsheets/d/e/2PACX-demo-pilotix/pubhtml"}', 'demo-chan-key-sheet-0000000003', NULL)`,
    [users.admin],
  );
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('cron', '{"key":"demo-cron-key"}') ON CONFLICT (key) DO NOTHING`,
  );
  // a second client price grid for big parcels (not assigned: the admin ticks its products in Management → Prix de livraison)
  const std = (await db.query(`SELECT value FROM settings WHERE key = 'clientFees'`))[0]?.value as Record<string, Record<string, { home: number; desk: number }>> | undefined;
  if (std?.Standard) {
    const big: Record<string, { home: number; desk: number }> = {};
    for (const [w, r] of Object.entries(std.Standard)) big[w] = { home: r.home + 300, desk: r.desk + 200 };
    await db.query(`UPDATE settings SET value = $1 WHERE key = 'clientFees'`, [JSON.stringify({ ...std, 'Gros colis': big })]);
  }
}
