// Pilotix — rules and types shared by the core, the server and the app.
// Mirrors the original Pilotix model: two status tracks per order (confirmation, then livraison).

import type { ClientLevel, ClientReason } from './clientscore';
export * from './timers';
export * from './geo';
export * from './demo';
export * from './names';
export * from './upsell';
export * from './features';
export * from './agency';
export * from './couriers';
import type { ShopInfo } from './features';
import type { OrigLine } from './upsell';
import type { AgencySellerWork } from './agency';

// ---------------------------------------------------------------- roles
export const ROLES = ['admin', 'vendeur', 'agent_manager', 'confirmation', 'suivi', 'depot', 'livreur', 'marketer'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that bring other roles with them. */
export const ROLE_INCLUDES: Partial<Record<Role, Role[]>> = {
  vendeur: ['confirmation', 'suivi', 'depot', 'marketer'],
  agent_manager: ['confirmation'],
};

/** All roles a user effectively has (own roles + what they include). */
export function expandRoles(roles: Role[]): Role[] {
  const out = new Set<Role>(roles);
  for (const r of roles) for (const x of ROLE_INCLUDES[r] ?? []) out.add(x);
  return [...out];
}

export const LANGUAGES = ['fr', 'en', 'ar'] as const;
export type Language = (typeof LANGUAGES)[number];

// ---------------------------------------------------------------- order statuses
export type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'mid' | 'off';

export const CONF_STATUSES = [
  'to_check', 'new', 'no_answer', 'busy', 'callback', 'postponed',
  'no_stock', 'confirmed', 'cancelled', 'duplicate', 'wrong_number', 'fake',
] as const;
export type ConfStatus = (typeof CONF_STATUSES)[number];

export const CONF_TONE: Record<ConfStatus, Tone> = {
  to_check: 'warn', new: 'info', no_answer: 'mid', busy: 'mid', callback: 'mid', postponed: 'mid',
  no_stock: 'warn', confirmed: 'ok', cancelled: 'bad', duplicate: 'off', wrong_number: 'bad', fake: 'bad',
};
/** Statuses still waiting in the call queue. */
export const CONF_TODO: ConfStatus[] = ['to_check', 'new', 'no_answer', 'busy', 'callback', 'postponed'];
export const CONF_DONE_BAD: ConfStatus[] = ['cancelled', 'duplicate', 'wrong_number', 'fake'];
/** Statuses that need a date for the next call. */
export const CONF_NEEDS_DATE: ConfStatus[] = ['callback', 'postponed'];
/** Statuses that need a reason. */
export const CONF_NEEDS_REASON: ConfStatus[] = ['cancelled', 'fake', 'wrong_number'];

export const FOLLOW_STATUSES = [
  'to_prepare', 'prepared', 'shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange',
  'delivered', 'returning', 'returned', 'exchanged', 'lost', 'cancelled',
] as const;
export type FollowStatus = (typeof FOLLOW_STATUSES)[number];

export const FOLLOW_TONE: Record<FollowStatus, Tone> = {
  to_prepare: 'info', prepared: 'info', shipped: 'mid', out_for_delivery: 'mid', failed: 'warn', alert: 'bad',
  in_exchange: 'mid', delivered: 'ok', returning: 'bad', returned: 'bad', exchanged: 'off', lost: 'bad', cancelled: 'off',
};
/** Parcels still with the courier. */
export const FOLLOW_ON_ROAD: FollowStatus[] = ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange'];
export const FOLLOW_FINAL: FollowStatus[] = ['delivered', 'returned', 'exchanged', 'lost', 'cancelled'];

/** Which delivery statuses each role may set (admin and suivi: all). */
export const FOLLOW_BY_ROLE: Partial<Record<Role, FollowStatus[]>> = {
  depot: ['to_prepare', 'prepared', 'shipped', 'returned'],
  livreur: ['out_for_delivery', 'delivered', 'failed', 'returning'],
};

export function canSetFollow(roles: Role[], to: FollowStatus): boolean {
  const r = expandRoles(roles);
  if (r.includes('admin') || r.includes('suivi')) return true;
  return r.some((x) => FOLLOW_BY_ROLE[x]?.includes(to));
}
export function canSetConf(roles: Role[]): boolean {
  const r = expandRoles(roles);
  return r.includes('admin') || r.includes('confirmation');
}

/** Products can no longer be changed once the parcel has left. */
export const FOLLOW_LOCKED: FollowStatus[] = ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange', 'delivered', 'returning', 'returned', 'exchanged', 'lost'];

// ---------------------------------------------------------------- reasons and lists
export const CANCEL_REASONS = ['price', 'fee', 'elsewhere', 'not_ordered', 'too_long', 'changed_mind', 'other'] as const;
/** why an order is fake: « concurrent » (its label starts with 🕵️ in every language) marks the landing page's device for good */
export const FAKE_REASONS = ['competitor', 'not_ordered', 'other'] as const;
export const FAIL_REASONS = ['absent', 'no_answer', 'postponed_by_client', 'address', 'no_money', 'other'] as const;
export const RETURN_REASONS = ['refused', 'unreachable', 'mismatch', 'wrong_address', 'cancelled_by_client', 'other'] as const;
export const SALES_CHANNELS = ['site', 'facebook', 'instagram', 'tiktok', 'appel', 'whatsapp', 'autre', 'landing'] as const;
export type SalesChannel = (typeof SALES_CHANNELS)[number];

export const COURIER_KINDS = ['own', 'zr', 'zr_legacy', 'yalidine', 'ecotrack', 'noest', 'maystro', 'zimou', 'elogistia', 'ecom', 'mdm', 'near', 'custom', 'manual'] as const;
export type CourierKind = (typeof COURIER_KINDS)[number];
/** Couriers Pilotix sends parcels to through their API: each gives the parcel its own tracking number, which replaces
 *  the Pilotix one (screens, labels, scanner). Own livreurs and companies without an API keep the Pilotix number. */
export const API_COURIER_KINDS: readonly string[] = ['zr', 'zr_legacy', 'yalidine', 'ecotrack', 'noest', 'maystro', 'zimou', 'elogistia', 'ecom', 'mdm', 'near', 'custom'] satisfies readonly CourierKind[];
/** Couriers whose API gives the parcel its own label, printed instead of the Pilotix one. Procolis (zr_legacy) gives
 *  none; a custom API gives one when it answers with a label link (if not, the Pilotix label prints). */
export const LABEL_COURIER_KINDS: readonly string[] = ['zr', 'yalidine', 'ecotrack', 'noest', 'maystro', 'zimou', 'elogistia', 'ecom', 'mdm', 'near', 'custom'] satisfies readonly CourierKind[];

// ---------------------------------------------------------------- SAV
export const SAV_TYPES = ['defect', 'missing', 'wrong', 'late', 'notdelivered', 'refund', 'exchange', 'help', 'other'] as const;
export const SAV_WISHES = ['exchange', 'refund', 'part', 'repair', 'info'] as const;
export const SAV_STATUSES = ['open', 'progress', 'resolved', 'closed'] as const;
export type SavStatus = (typeof SAV_STATUSES)[number];
export const SAV_TONE: Record<SavStatus, Tone> = { open: 'bad', progress: 'mid', resolved: 'ok', closed: 'off' };
export const EXCHANGE_KINDS = ['same', 'variant', 'other_product', 'parts'] as const;

// ---------------------------------------------------------------- phone and money
/**
 * Normalizes an Algerian phone number to 0XXXXXXXXX. Accepts +213, 00213, 213, spaces and dashes.
 * Returns null when it is not a valid Algerian number.
 */
export function normalizePhone(input: string): string | null {
  let d = (input || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+213')) d = '0' + d.slice(4);
  else if (d.startsWith('00213')) d = '0' + d.slice(5);
  else if (d.startsWith('213') && (d.length === 12 || d.length === 13)) d = '0' + d.slice(3);
  d = d.replace(/\D/g, '');
  // people often keep the 0 after the country code: +213 0661…, 00213 0661…, 2130661… → 0661…
  if (d.startsWith('00') && (d.length === 11 || d.length === 10)) d = d.slice(1);
  if (d.length === 9 && /^[5-7]/.test(d)) d = '0' + d;
  if (/^0[5-7]\d{8}$/.test(d)) return d;
  if (/^0[2-4]\d{7}$/.test(d)) return d;
  return null;
}
/** 0661234567 → 213661234567 (for WhatsApp links). */
export const phoneIntl = (p: string) => '213' + p.replace(/^0/, '');

/**
 * The phone number of an account (a person who logs in): an Algerian mobile (05/06/07…, it gets the WhatsApp code), or
 * a number from another country written with its + (+212…, +33…: 8 to 15 digits). Null when it is neither.
 */
export function normalizeAccountPhone(input: string): string | null {
  const dz = normalizePhone(input);
  if (dz) return /^0[5-7]\d{8}$/.test(dz) ? dz : null;
  const raw = String(input ?? '').trim();
  const d = raw.replace(/[^\d+]/g, '');
  const intl = d.startsWith('00') ? '+' + d.slice(2) : d;
  if (/^\+[1-9]\d{7,14}$/.test(intl) && !intl.startsWith('+213')) return intl;
  return null;
}
/** An account's phone as WhatsApp wants it (digits with the country code, no +): 0661… → 213661…, +33… → 33… */
export const phoneWa = (p: string) => (p.startsWith('+') ? p.slice(1) : phoneIntl(p));
/** A phone shown half hidden (where a code was sent): 0661 •• •• 67 */
export const maskPhone = (p: string) => (p.length > 6 ? `${p.slice(0, 4)} •• •• ${p.slice(-2)}` : p);

// ---------------------------------------------------------------- data types
export interface Profile {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  roles: Role[];
  language: Language;
  active: boolean;
  lastSeenAt: string | null;
  livreurCompanyId?: number | null;
  /** profile picture (a small square image as a data: URL) */
  avatar?: string | null;
  /** code to invite friends to Pilotix */
  referralCode?: string | null;
  /** set by the administrator: may create accounts and set passwords of the team (not administrators) */
  canManageUsers?: boolean;
  /** set by the administrator: gives orders a company or a livreur in the depot's « À attribuer » */
  canAssign?: boolean;
  /** set by the administrator: opens Management › Affectation and changes it */
  canAffect?: boolean;
  /** put in Management › Archives: out of the team list, kept in the history (always closed) */
  archived?: boolean;
  /** an agent of a confirmation agency working in this store (the agency manages the account) */
  agencyId?: number | null;
  /** such an agent: the products they work on here (null: all the agency's) */
  agencyProducts?: number[] | null;
  /** in an agency's own space: the sellers this person works for, and the products (null: every seller) */
  agencySellers?: AgencySellerWork[] | null;
  /** a marketer's chief (or manager) working in this store: sees every ad set of the marketer's people here */
  agencyLead?: boolean;
}

export interface Session {
  profile: Profile;
  roles: Role[]; // expanded
  isAdmin: boolean;
  /** administrator, or given the right to create accounts and set passwords */
  canManageUsers?: boolean;
  /** the shop and its subscription (a multi-shop server only) */
  shop?: ShopInfo;
  /** this e-mail is also a Pilotix staff account (the menu shows the way to the control room) */
  platformStaff?: boolean;
}

export interface Variant {
  id: number;
  productId: number;
  title: string; // '' for a product without variants
  sku: string;
  price: number | null; // null = product price
  active: boolean;
}

export interface Pack {
  qty: number;
  price: number;
}

export interface Product {
  id: number;
  name: string;
  sku: string;
  price: number;
  cost: number;
  weightKg: number;
  photo: string | null;
  isService: boolean;
  active: boolean;
  fixedPrice: boolean;
  maxDiscount: number | null;
  packs: Pack[];
  linked: number[];
  feeGrid: string | null;
  variants: Variant[];
}

export interface OrderItem {
  id?: number;
  productId: number;
  variantId: number | null;
  name: string;
  variantTitle: string;
  qty: number;
  unitPrice: number;
  purchasePrice: number;
  isUpsell: boolean;
}

/**
 * The money of a delivered parcel, step by step: not paid yet → the company has it (its status « Encaissé » /
 * « Recouvert ») → the company paid it (a ZR payment to pick up) → received (in a caisse).
 */
export interface OrderPay {
  step: 'waiting' | 'collected' | 'ready' | 'received';
  /** when it reached this step, when known */
  at: string | null;
  /** the company's payment it is in (ZR), when known */
  ref: string | null;
}

export interface Order {
  id: number;
  ref: string;
  createdAt: string;
  createdBy: number | null;
  customerId: number;
  customerName: string;
  phone: string;
  phone2: string | null;
  wilayaId: number;
  commune: string;
  address: string;
  isStopdesk: boolean;
  stopdeskId: number | null;
  channel: SalesChannel;
  source: string | null;
  utm: Record<string, string> | null;
  /** the landing page the customer ordered on */
  landingId?: number | null;
  confStatus: ConfStatus;
  agentId: number | null;
  attempts: number;
  lastCallAt: string | null;
  nextCallAt: string | null;
  confirmedAt: string | null;
  followStatus: FollowStatus | null;
  followAgentId: number | null;
  companyId: number | null;
  warehouseId: number | null;
  livreurId: number | null;
  tracking: string | null;
  /** Pilotix's own unique tracking number, made when the order is created (the company's `tracking` replaces it on screen) */
  ownTracking: string;
  extStatus: string | null;
  deliveryAttempts: number;
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  deliveryCost: number;
  cashed: boolean;
  cashedAt: string | null;
  customerNote: string | null;
  deliveryNote: string | null;
  internalNote: string | null;
  isExchange: boolean;
  /** SAV ticket this parcel belongs to (exchange parcels are tickets, not orders) */
  savRef: string | null;
  originalOrderId: number | null;
  hasUpsell: boolean;
  /** DA the customer pays for products above what they first ordered (counted by Pilotix, see upsellOf) */
  upsellValue: number;
  /** what the customer first ordered (null for an order made before this was kept: its lines not marked upsell) */
  origItems: OrigLine[] | null;
  origDiscount: number;
  preparedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  returnedAt: string | null;
  updatedAt: string;
  version: number;
  /** the confirmation agency that confirms / follows this order (null: the store's own team) */
  confAgencyId?: number | null;
  followAgencyId?: number | null;
  items: OrderItem[];
  // computed
  possibleDuplicate?: boolean;
  blacklisted?: boolean;
  customerDelivered?: number;
  customerReturned?: number;
  /** refused 2 parcels: delivered at the desk only */
  customerStopdeskOnly?: boolean;
  /** parcels refused since their last delivered one */
  customerRefusals?: number;
  /** a refuser this new number looks like (same device, or same name + commune) */
  looksLikePhone?: string | null;
  /** the customer's score out of 100 (what the protection knows about this number), in the lists and an order's page */
  clientScore?: { score: number; level: ClientLevel; reasons: ClientReason[] } | null;
  /** the order card: where the money of a delivered parcel is (see OrderPay) */
  pay?: OrderPay | null;
  /** the order card: what the courier itself charges for this parcel, from its API — its delivery / return price, the
   *  weight it counted and its weight fee (exact once it paid) */
  courierFees?: { delivery: number | null; ret: number | null; weight: number; weightRet: number; kg: number | null; exact: boolean } | null;
  /** the Meta ad's name (from the ads Pilotix reads), for the ad id in utm */
  adName?: string | null;
  agentName?: string | null;
  followAgentName?: string | null;
  companyName?: string | null;
  livreurName?: string | null;
  subStatus?: string | null;
  /** the courier refused the parcel: why (« En dispatch » shows it with « Renvoyer » / « Autre société ») */
  sendError?: string | null;
  /** cancelled while its parcel was at a courier that could not cancel it: to cancel in the courier's space */
  cancelByHand?: boolean;
  /** « Pilot Auto Assign »: how the company was chosen ('rule' 'strict' 'default' 'bureau' 'hand' 'backup' 'none') */
  pilotBy?: string | null;
  /** the rule that chose it (its id: the number shown is its place in the rules) */
  pilotRule?: string | null;
  /** why it waits for a person: 'conflict:2,4' | 'nobody' | 'manual' */
  pilotWhy?: string | null;
}

export interface OrderEvent {
  id: number;
  orderId: number;
  at: string;
  userId: number | null;
  userName: string | null;
  kind: 'created' | 'conf_status' | 'follow_status' | 'note' | 'call' | 'edit' | 'assign' | 'company' | 'cashed' | 'sub_status' | 'chat' | 'suivi_motif' | 'suivi_stuck';
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
}

export interface Customer {
  id: number;
  name: string;
  phone: string;
  wilayaId: number | null;
  blacklisted: boolean;
  orders: number;
  delivered: number;
  returned: number;
  lastOrderAt: string | null;
}

export interface Company {
  id: number;
  name: string;
  kind: CourierKind;
  active: boolean;
  hasKeys: boolean;
  toShip?: number;
  onRoad?: number;
}

export interface Warehouse {
  id: number;
  name: string;
  wilayaId: number;
  commune: string;
  address: string;
  isDefault: boolean;
  active: boolean;
}

export interface StockRow {
  variantId: number;
  productId: number;
  productName: string;
  variantTitle: string;
  sku: string;
  warehouseId: number;
  warehouseName: string;
  qty: number;
  reserved: number;
  available: number;
  alertQty: number;
  cost: number;
}

export interface Complaint {
  id: number;
  ref: string;
  orderId: number | null;
  orderRef: string | null;
  customerName: string | null;
  phone: string | null;
  type: (typeof SAV_TYPES)[number];
  wish: (typeof SAV_WISHES)[number];
  details: string;
  status: SavStatus;
  assignedTo: number | null;
  assignedName: string | null;
  exchangeOrderId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** The 69 wilayas (code = index + 1). 59–69 named by decree n° 26-206 of 25 May 2026. */
export const WILAYAS: string[] = [
  'Adrar', 'Chlef', 'Laghouat', 'Oum El Bouaghi', 'Batna', 'Béjaïa', 'Biskra', 'Béchar', 'Blida', 'Bouira',
  'Tamanrasset', 'Tébessa', 'Tlemcen', 'Tiaret', 'Tizi Ouzou', 'Alger', 'Djelfa', 'Jijel', 'Sétif', 'Saïda',
  'Skikda', 'Sidi Bel Abbès', 'Annaba', 'Guelma', 'Constantine', 'Médéa', 'Mostaganem', "M'Sila", 'Mascara', 'Ouargla',
  'Oran', 'El Bayadh', 'Illizi', 'Bordj Bou Arréridj', 'Boumerdès', 'El Tarf', 'Tindouf', 'Tissemsilt', 'El Oued', 'Khenchela',
  'Souk Ahras', 'Tipaza', 'Mila', 'Aïn Defla', 'Naâma', 'Aïn Témouchent', 'Ghardaïa', 'Relizane', 'Timimoun', 'Bordj Badji Mokhtar',
  'Ouled Djellal', 'Béni Abbès', 'In Salah', 'In Guezzam', 'Touggourt', 'Djanet', "El M'Ghair", 'El Meniaa',
  'Aflou', 'Barika', 'El Kantara', 'Bir El Ater', 'El Aricha', 'Ksar Chellala', 'Aïn Ouessara', 'Messaad',
  'Ksar El Boukhari', 'Bou Saâda', 'El Abiodh Sidi Cheikh',
];
export const wilayaLabel = (id: number | null | undefined) => (id ? `${String(id).padStart(2, '0')} · ${WILAYAS[id - 1] ?? '?'}` : '—');
export * from './sha256';
export * from './landing';
export * from './doctor';
export * from './clientscore';
export * from './pro';
export * from './pilot';
export * from './colors';
