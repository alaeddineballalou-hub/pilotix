import { CallSettings, DEFAULT_CALL_SETTINGS } from '@pilotix/shared';
import type { Db } from './db';

/** Every setting with its default. Admin edits them in Management / Réglages. */
export interface SettingsMap {
  /** savPhone: the shop's after-sales number, printed on the parcel labels */
  shop: { name: string; fromWilayaId: number; defaultCompanyId: number | null; whatsappTemplate: string; savPhone: string };
  calls: CallSettings;
  /** Client delivery price grids: name → wilaya → { home, desk } */
  clientFees: Record<string, Record<string, { home: number; desk: number }>>;
  defaultFeeGrid: string;
  /** SAV tickets' own delivery price per wilaya (suggested on each exchange, editable there) */
  savFees: Record<string, { home: number; desk: number }>;
  /** Extra fee per kg above `fromKg`. */
  weightFees: { fromKg: number; perKg: number };
  /** Renamed / recolored / custom statuses. */
  statusLabels: Record<string, { fr?: string; ar?: string; tone?: string; hidden?: boolean }>;
  customStatuses: { key: string; track: 'conf' | 'follow' | 'sav'; label: string; ar?: string; tone: string; behavesLike: string }[];
  teams: { id: string; name: string; managerId: number | null; agentIds: number[] }[];
  mgrScope: Record<string, string[]>; // manager id → dashboard areas
  payPlans: {
    agent: { threshold: number; below: number; above: number; upsellBonus: number; formOrder: number };
    manager: { perDelivered: number };
    suivi: { perDelivered: number };
    depot: { perPrepared: number };
    livreur: { light: number; heavy: number; heavyFromKg: number };
  };
  webhook: { key: string };
  cron: { key: string };
  meta: { adAccountId: string; hasToken: boolean };
  /** Dashboard goals (admin): delivered revenue per month */
  goals: { monthlyRevenue: number };
  /** Caisse: the bank can be removed by a shop that does not use one */
  caisses: { bankHidden: boolean };
  /** Order-list column presets: saved by an admin, shared with everyone, never edited (only deleted by an admin) */
  colPresets: { id: string; name: string; cols: string[]; by: string; at: string }[];
  /** The preset every team uses (set by an admin; only an admin changes the columns) */
  colPresetActive: { id: string; at: number; by: string } | null;
}

export const DEFAULT_SETTINGS: SettingsMap = {
  shop: { name: 'Pilotix', fromWilayaId: 16, defaultCompanyId: null, whatsappTemplate: 'Bonjour {nom}, ici {boutique} à propos de votre commande {ref}.', savPhone: '' },
  calls: DEFAULT_CALL_SETTINGS,
  clientFees: {},
  defaultFeeGrid: 'Standard',
  savFees: {},
  weightFees: { fromKg: 5, perKg: 50 },
  statusLabels: {},
  customStatuses: [],
  teams: [],
  mgrScope: {},
  payPlans: {
    agent: { threshold: 0, below: 100, above: 150, upsellBonus: 50, formOrder: 0 },
    manager: { perDelivered: 20 },
    suivi: { perDelivered: 15 },
    depot: { perPrepared: 10 },
    livreur: { light: 150, heavy: 250, heavyFromKg: 5 },
  },
  webhook: { key: '' },
  cron: { key: '' },
  meta: { adAccountId: '', hasToken: false },
  goals: { monthlyRevenue: 3_000_000 },
  caisses: { bankHidden: false },
  colPresets: [],
  colPresetActive: null,
};

export async function getSetting<K extends keyof SettingsMap>(db: Db, key: K): Promise<SettingsMap[K]> {
  const r = await db.query<{ value: SettingsMap[K] }>('SELECT value FROM settings WHERE key = $1', [key]);
  const d = DEFAULT_SETTINGS[key];
  if (!r[0]) return d;
  const v = r[0].value;
  return typeof d === 'object' && d !== null && !Array.isArray(d) && typeof v === 'object' && v !== null && !Array.isArray(v) ? ({ ...d, ...v } as SettingsMap[K]) : v;
}

export async function setSetting<K extends keyof SettingsMap>(db: Db, key: K, value: SettingsMap[K], userId?: number) {
  await db.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), userId ?? null],
  );
}

/** Client delivery price for a wilaya, from the product's grid (or the default grid). */
export async function clientFee(db: Db, wilayaId: number, stopdesk: boolean, grid?: string | null): Promise<number | null> {
  const fees = await getSetting(db, 'clientFees');
  const name = grid || (await getSetting(db, 'defaultFeeGrid'));
  const row = fees[name]?.[String(wilayaId)];
  if (!row) return null;
  return stopdesk ? row.desk : row.home;
}

/** SAV delivery price for a wilaya (null when the SAV tariff has no price there). */
export async function savFee(db: Db, wilayaId: number, stopdesk: boolean): Promise<number | null> {
  const row = (await getSetting(db, 'savFees'))[String(wilayaId)];
  if (!row) return null;
  return stopdesk ? row.desk : row.home;
}
