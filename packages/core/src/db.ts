import schema001 from './migrations/001_schema';
import m002 from './migrations/002_orders';
import m003 from './migrations/003_confirmation';
import m004 from './migrations/004_stats';
import m005 from './migrations/005_catalog';
import m006 from './migrations/006_customers';
import m007 from './migrations/007_suivi';
import m008 from './migrations/008_sav';
import m009 from './migrations/009_delivery';
import m010 from './migrations/010_cash';
import m011 from './migrations/011_admin';
import m012 from './migrations/012_ads';
import m013 from './migrations/013_tickets';
import m014 from './migrations/014_own_tracking';
import m015 from './migrations/015_profile';
import m016 from './migrations/016_dellal';
import m017 from './migrations/017_ui';
import m018 from './migrations/018_marketers';
import m019 from './migrations/019_cm';
import m020 from './migrations/020_upsell';
import m021 from './migrations/021_notify';
import m022 from './migrations/022_picking';
import m023 from './migrations/023_sav_satisfaction';
import m024 from './migrations/024_stock';
import m025 from './migrations/025_claims_api';
import m026 from './migrations/026_caisses';
import m027 from './migrations/027_courier_payments';
import m028 from './migrations/028_zr_services';
import m029 from './migrations/029_custom_caisses';
import m030 from './migrations/030_landing';
import m031 from './migrations/031_landing_auto';
import m032 from './migrations/032_safety';
import m033 from './migrations/033_product_details';
import m034 from './migrations/034_product_log';
import m035 from './migrations/035_landing_images';
import m036 from './migrations/036_password_reset';
import m037 from './migrations/037_spy';
import m038 from './migrations/038_user_managers';
import m039 from './migrations/039_sheet_rows';
import m040 from './migrations/040_sheet_memory';
import m041 from './migrations/041_product_options';
import m042 from './migrations/042_archive';
import m043 from './migrations/043_protection';
import m044 from './migrations/044_trust';
import m045 from './migrations/045_agencies';
import m046 from './migrations/046_groups';
import m047 from './migrations/047_landing_w320';
import m048 from './migrations/048_partner_lead';
import m049 from './migrations/049_pixels';
import m050 from './migrations/050_multi_pixels';
import m051 from './migrations/051_fp';
import m052 from './migrations/052_depot_alerts';
import m053 from './migrations/053_push';
import m054 from './migrations/054_dispatch';
import m055 from './migrations/055_livreur';
import m056 from './migrations/056_pilot';
import m057 from './migrations/057_risk_confirms';
import m058 from './migrations/058_can_affect';
import m059 from './migrations/059_courier_fees';
import m060 from './migrations/060_pick_undo';

/** The only thing the core needs from a database: run SQL, and run a function in a transaction. */
export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

export const MIGRATIONS: [string, string][] = [['001_schema', schema001], ['002_orders', m002], ['003_confirmation', m003], ['004_stats', m004], ['005_catalog', m005], ['006_customers', m006], ['007_suivi', m007], ['008_sav', m008], ['009_delivery', m009], ['010_cash', m010], ['011_admin', m011], ['012_ads', m012], ['013_tickets', m013], ['014_own_tracking', m014], ['015_profile', m015], ['016_dellal', m016], ['017_ui', m017], ['018_marketers', m018], ['019_cm', m019], ['020_upsell', m020], ['021_notify', m021], ['022_picking', m022], ['023_sav_satisfaction', m023], ['024_stock', m024], ['025_claims_api', m025], ['026_caisses', m026], ['027_courier_payments', m027], ['028_zr_services', m028], ['029_custom_caisses', m029], ['030_landing', m030], ['031_landing_auto', m031], ['032_safety', m032], ['033_product_details', m033], ['034_product_log', m034], ['035_landing_images', m035], ['036_password_reset', m036], ['037_spy', m037], ['038_user_managers', m038], ['039_sheet_rows', m039], ['040_sheet_memory', m040], ['041_product_options', m041], ['042_archive', m042], ['043_protection', m043], ['044_trust', m044], ['045_agencies', m045], ['046_groups', m046], ['047_landing_w320', m047], ['048_partner_lead', m048], ['049_pixels', m049], ['050_multi_pixels', m050], ['051_fp', m051], ['052_depot_alerts', m052], ['053_push', m053], ['054_dispatch', m054], ['055_livreur', m055], ['056_pilot', m056], ['057_risk_confirms', m057], ['058_can_affect', m058], ['059_courier_fees', m059], ['060_pick_undo', m060],];

/** Applies migrations not applied yet. `exec` runs a multi-statement SQL script. */
export async function migrate(db: Db, exec: (sql: string) => Promise<void>): Promise<string[]> {
  await exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const applied: string[] = [];
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    await exec(sql);
    await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    applied.push(name);
  }
  return applied;
}

// ---------------------------------------------------------------- small helpers
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const iso = (v: unknown): string => new Date(v as string).toISOString();
export const isoOrNull = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/** Builds a WHERE clause step by step with numbered parameters. */
export class Where {
  parts: string[] = [];
  params: unknown[] = [];
  /** add('o.status = ?', v) — each ? becomes the next $n */
  add(sql: string, ...values: unknown[]) {
    let s = sql;
    for (const v of values) {
      this.params.push(v);
      s = s.replace('?', `$${this.params.length}`);
    }
    this.parts.push(s);
    return this;
  }
  /** a parameter placeholder for use in ORDER BY / LIMIT etc. */
  p(v: unknown) {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  get sql() {
    return this.parts.length ? `WHERE ${this.parts.join(' AND ')}` : '';
  }
}

