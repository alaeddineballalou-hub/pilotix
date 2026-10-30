import { CallSettings, DEFAULT_CALL_SETTINGS, DEFAULT_SCORE_RULES, PILOT_DEFAULT, type PilotConfig, type ScoreRules } from '@pilotix/shared';
import type { Db } from './db';

export interface SuiviMotif {
  key: string;
  fr: string;
  ar: string;
  on: boolean;
  client?: boolean;
  /** « Résolu »: the agent must give the new delivery date */
  date?: boolean;
}

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
  /**
   * Landing pages: the shop's Meta pixel (each page may have its own), when a real order is reported as a Purchase,
   * after how long a customer who typed their number without ordering becomes an order in Commandes (« Nouvelle »),
   * and the automations. The Conversions API token is a secret of its own.
   */
  landing: {
    pixelId: string;
    testEventCode: string;
    purchaseAt: 'order' | 'confirmed' | 'delivered';
    abandonAfterMin: number;
    /** a landing page is made for every new product */
    autoCreate: boolean;
    /** products that will never get a page (accessories…): no alert for them */
    ignored: number[];
    /** the store's part of the pages' address (site/<store>/<page>); '' = made from the shop's name */
    storeSlug?: string;
    /** Cloudflare Turnstile's site key (invisible robot check on the pages); '' = off. Its secret key is a secret of its own. */
    turnstileSiteKey?: string;
    /** the « contact us on WhatsApp » button of the thank-you screen */
    whatsapp?: { on: boolean; number: string; label: string; message: string };
  };
  /** Dashboard goals (admin): delivered revenue per month */
  goals: { monthlyRevenue: number };
  /** Caisse: the bank can be removed by a shop that does not use one */
  caisses: { bankHidden: boolean };
  /** Dépôt alerts (an order still in the depot was changed or cancelled): who gets them; [] = every depot agent */
  depotAlerts: { to: number[] };
  /** Order-list column presets: saved by an admin, shared with everyone, never edited (only deleted by an admin) */
  colPresets: { id: string; name: string; cols: string[]; by: string; at: string }[];
  /** The preset every team uses (set by an admin; only an admin changes the columns) */
  colPresetActive: { id: string; at: number; by: string } | null;
  /**
   * Management › Livreur: the messages a livreur sends a customer in one tap (WhatsApp or SMS) from « Ma tournée ».
   * {nom} the customer, {ref} the order, {montant} what to pay, {commune}, {livreur} his name, {boutique} the shop.
   */
  livreurMessages: { id: string; label: string; text: string }[];
  /**
   * Sociétés de livraison › « Pilot Auto Assign »: « Manuel » (the team chooses, the default company first) or
   * « Pilot Auto Assign » (the rules choose: wilayas, communes, products → a company or « Livraison privée »), and the
   * seller's answers to clashes between rules.
   */
  pilot: PilotConfig;
  /** Sociétés de livraison › Couverture: the last import of tariffs and bureaus from the companies' APIs */
  coverageRefresh: { at: string | null; results: { companyId: number; name: string; ok: boolean; error: string | null }[] };
  /**
   * Sociétés de livraison › Préférences: each seller's own choices (shown in « Mode avancé »).
   *  - manualDefault: in « Manuel », the default company counts as chosen when the agent confirms (otherwise the order
   *    waits in « À attribuer » for a manager);
   *  - changeCompany: who may change an order's company by hand (admins always may);
   *  - strictLock: an order placed by a strict « Pilot Auto Assign » rule is changed only by managers and admins;
   *  - privateBackup: « Livraison privée » orders waiting in « À attribuer » longer than `hours` go to `companyId`, when
   *    that company delivers there;
   *  - noStockDays: a « sans stock » order waiting longer than this rings an alert.
   */
  /** Management › Motifs du Suivi: why an alert ends « Résolu » (relancé) or « Perdu »; `client`: the customer said it
   *  himself (a « Perdu » allowed before the agent's calls) */
  suiviMotifs: { resolved: SuiviMotif[]; lost: SuiviMotif[] };
  prefs: {
    manualDefault: boolean;
    changeCompany: { confirmation: boolean; agency: boolean; depot: boolean; manager: boolean };
    strictLock: boolean;
    /** who writes the « Pilot Auto Assign » rules (admins always) */
    rulesBy: { confirmation: boolean; agency: boolean; depot: boolean; manager: boolean };
    privateBackup: { on: boolean; hours: number; companyId: number | null };
    noStockDays: number;
    /** « Livraison privée »: what the livreur says (« failed:no_answer », « returning:refused »…) that sends the parcel
     *  to Suivi › Alertes instead (a suivi agent calls the customer first) */
    livreurAlerts: string[];
    /** Suivi's clock on every alert (same for every company and our livreurs), in working hours (the call slots):
     *  the first call, then the alert solved (treated, swapped or cancelled) */
    suiviClock: { firstHours: number; solveHours: number };
    /** Suivi: the calls before « Client annule » (unless the customer himself cancels), at least `gapMinutes` apart */
    suiviTries: { calls: number; gapMinutes: number };
    /** Suivi › Bloqués: a parcel with no new status for `days` days; 2 days later, a claim by itself (companies with an API) */
    suiviStuck: { days: number };
  };
  /** Réglages › Score client: the points of the customer's score out of 100 (shared/clientscore.ts) */
  clientScore: ScoreRules;
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
  landing: { pixelId: '', testEventCode: '', purchaseAt: 'confirmed', abandonAfterMin: 20, autoCreate: false, ignored: [] },
  goals: { monthlyRevenue: 3_000_000 },
  caisses: { bankHidden: false },
  depotAlerts: { to: [] },
  colPresets: [],
  colPresetActive: null,
  livreurMessages: [
    { id: 'coming', label: 'J’arrive', text: 'Bonjour {nom}, je suis {livreur}, le livreur de {boutique}. J’arrive dans 15 minutes avec votre commande {ref} ({montant} DA).' },
    { id: 'here', label: 'Je suis devant', text: 'Bonjour {nom}, je suis devant chez vous avec votre commande {ref}. Merci de sortir, le montant est de {montant} DA.' },
    { id: 'noanswer', label: 'Pas de réponse', text: 'Bonjour {nom}, j’ai essayé de vous appeler pour votre commande {ref} ({boutique}). Rappelez-moi s’il vous plaît.' },
    { id: 'tomorrow', label: 'Demain', text: 'Bonjour {nom}, je repasse demain pour votre commande {ref}. Merci de rester joignable.' },
  ],
  pilot: PILOT_DEFAULT,
  coverageRefresh: { at: null, results: [] },
  suiviMotifs: {
    resolved: [
      { key: 'new_date', fr: 'Nouvelle date de livraison', ar: 'موعد توصيل جديد', on: true, date: true },
      { key: 'address', fr: 'Adresse corrigée', ar: 'تصحيح العنوان', on: true },
      { key: 'phone', fr: 'Téléphone corrigé', ar: 'تصحيح الهاتف', on: true },
      { key: 'reached', fr: 'Client joint, il attend', ar: 'تم الاتصال بالزبون، ينتظر', on: true },
      { key: 'desk', fr: 'Livraison au bureau', ar: 'التوصيل إلى المكتب', on: true },
      { key: 'other', fr: 'Autre', ar: 'أخرى', on: true },
    ],
    lost: [
      { key: 'refused', fr: 'Refus du client', ar: 'رفض الزبون', on: true, client: true },
      { key: 'unreachable', fr: 'Injoignable après les appels', ar: 'لا يمكن الوصول إليه بعد الاتصالات', on: true },
      { key: 'price', fr: 'Prix ou frais trop chers', ar: 'السعر أو المصاريف مرتفعة', on: true, client: true },
      { key: 'elsewhere', fr: 'A acheté ailleurs', ar: 'اشترى من مكان آخر', on: true, client: true },
      { key: 'not_ordered', fr: 'N’a pas commandé', ar: 'لم يطلب', on: true, client: true },
      { key: 'other', fr: 'Autre', ar: 'أخرى', on: true },
    ],
  },
  prefs: {
    manualDefault: true,
    changeCompany: { confirmation: true, agency: false, depot: false, manager: true },
    strictLock: true,
    rulesBy: { confirmation: false, agency: false, depot: false, manager: false },
    privateBackup: { on: false, hours: 24, companyId: null },
    noStockDays: 3,
    livreurAlerts: ['failed:no_answer', 'failed:absent', 'returning:refused', 'returning:unreachable'],
    suiviClock: { firstHours: 2, solveHours: 24 },
    suiviTries: { calls: 3, gapMinutes: 60 },
    suiviStuck: { days: 3 },
  },
  clientScore: DEFAULT_SCORE_RULES,
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

/** The home delivery price of every wilaya for a fee grid: clientFee for all of them, the settings read once. */
export async function clientHomeFees(db: Db, grid?: string | null): Promise<Record<number, number>> {
  const fees = await getSetting(db, 'clientFees');
  const name = grid || (await getSetting(db, 'defaultFeeGrid'));
  const out: Record<number, number> = {};
  for (let w = 1; w <= 69; w++) {
    const row = fees[name]?.[String(w)];
    if (row && row.home !== null) out[w] = row.home;
  }
  return out;
}

/** SAV delivery price for a wilaya (null when the SAV tariff has no price there). */
export async function savFee(db: Db, wilayaId: number, stopdesk: boolean): Promise<number | null> {
  const row = (await getSetting(db, 'savFees'))[String(wilayaId)];
  if (!row) return null;
  return stopdesk ? row.desk : row.home;
}
