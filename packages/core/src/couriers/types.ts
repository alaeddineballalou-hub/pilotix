// Courier integration framework — shared types. Every provider is one adapter file in this folder.
import type { CourierKind, FollowStatus } from '@pilotix/shared';

/** A delivery company as the adapters see it (server side only: includes the API keys). */
export interface CourierCompany {
  id: number;
  name: string;
  kind: CourierKind;
  /** API keys (write-only from the app; never sent back). */
  secret: Record<string, string>;
  /** Non-secret settings: base_url, validate, custom API template… */
  settings: Record<string, any>;
  /** Our own mapping: courier status → follow status ('' = do nothing). Overrides the adapter defaults. */
  statusMap: Record<string, string>;
  shop: { name: string; fromWilayaId: number; fromWilaya: string };
}

/** One order, normalized for the couriers (what every adapter receives). */
export interface Parcel {
  id: number;
  ref: string;
  customer_name: string;
  phone: string;
  phone2: string | null;
  wilaya_id: number;
  wilaya: string;
  wilaya_ar: string;
  commune: string;
  address: string;
  is_stopdesk: boolean;
  stopdesk_ext_id: string | null;
  stopdesk_name: string | null;
  stopdesk_commune: string | null;
  stopdesk_wilaya_id: number | null;
  total: number;
  subtotal: number;
  delivery_fee: number;
  /** "1 × Poussette (Gris) + 2 × Body" */
  products: string;
  items: { name: string; sku: string | null; price: number; qty: number }[];
  pieces: number;
  /** kg, at least 1 */
  weight: number;
  delivery_note: string;
  is_exchange: boolean;
  tracking: string | null;
  ext_id: string | null;
}

export interface SendResult {
  tracking: string;
  extId: string | null;
  labelUrl: string | null;
}

export interface TrackItem {
  id: number;
  tracking: string;
  extId: string | null;
}

export interface TrackResult {
  id: number;
  /** machine key at the courier (when it has one) */
  key?: string;
  /** what the courier says, in words */
  status: string;
  at?: string | null;
  /** adapter's own decision for special cases (e.g. ZR "isReturn"); undefined = use the maps */
  mapped?: FollowStatus | null;
}

export interface FeeRow {
  wilayaId: number;
  home: number | null;
  desk: number | null;
  returnFee: number | null;
}

export interface Desk {
  extId: string;
  name: string;
  wilayaId: number | null;
  commune: string | null;
  address: string | null;
}

export interface LabelResult {
  url?: string | null;
  /** base64 PDF when the courier returns the file itself */
  pdf?: string;
  type?: string;
  /** browser preview: the courier is simulated, so its label is a stand-in made by Pilotix */
  demo?: boolean;
}

export interface PreviewResult {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  note?: string;
}

/** A réclamation sent to the courier through its API. */
export interface ClaimInput {
  /** our claim number (REC-0001) */
  ref: string;
  item: TrackItem;
  /** our reason key (late, damaged…) and its French words */
  reason: string;
  reasonText: string;
  /** the courier's own category, when the user chose one */
  categoryId: string | null;
  /** what the user wrote, plus the order facts */
  description: string;
}

export interface ClaimCategory {
  id: string;
  name: string;
}

export interface ClaimSent {
  extId: string;
  /** the courier's claim number, shown to the user */
  extRef: string | null;
  status: string | null;
}

export interface ClaimState {
  extId: string;
  /** what the courier says, in words */
  status: string;
  /** the courier closed / solved it */
  resolved: boolean;
  at?: string | null;
  /** the courier's last answer (comment), if any */
  answer?: string | null;
}

/** The courier's money: what it holds for us, payment requests, and the payments it made (with their parcels). */
export interface PayBalance {
  paid: number;
  /** ready to be paid now (a payment request can be made) */
  ready: number;
  delivered: number;
  notReady: number;
}
export interface PayRequest {
  extId: string;
  date: string | null;
  /** null = waiting for the courier, true = approved, false = refused */
  approved: boolean | null;
  comment: string | null;
  at: string | null;
}
export interface PayLine {
  tracking: string | null;
  customer: string | null;
  type: string;
  amount: number;
  /** extra costs the courier took on this parcel (weight, exchange, phone change) */
  costs: number;
  comment: string | null;
}
export interface PayStatement {
  extId: string;
  ref: string | null;
  amount: number;
  status: string;
  /** the payment was handed over (accepted) */
  done: boolean;
  at: string | null;
  doneAt: string | null;
  requestId: string | null;
  /** ZR's breakdown: parcels delivered / cancelled, refunds, labeling, office holding, storage… */
  details: Record<string, number>;
  /** where it was handed over (ZR hub / cash drawer), when known */
  place: string | null;
}
export interface CourierPayments {
  balance(c: CourierCompany): Promise<PayBalance>;
  requests(c: CourierCompany): Promise<PayRequest[]>;
  /** asks the courier to pay on that date (YYYY-MM-DD) */
  request(c: CourierCompany, date: string): Promise<{ extId: string }>;
  list(c: CourierCompany): Promise<PayStatement[]>;
  lines(c: CourierCompany, extId: string): Promise<PayLine[]>;
  /** tells the courier we received this payment */
  accept(c: CourierCompany, extId: string): Promise<void>;
  /** a payment request still waiting: another date (YYYY-MM-DD), or withdrawn */
  requestDate?(c: CourierCompany, extId: string, date: string): Promise<void>;
  requestCancel?(c: CourierCompany, extId: string): Promise<void>;
}

/** A pickup bag (sac de ramassage) at the courier: the parcels handed to its driver together. */
export interface BagInfo {
  extId: string;
  /** the bag's number, on its label */
  tracking: string | null;
  /** the courier's word for the bag */
  state: string | null;
  parcels: number | null;
  /** parcels of the bag the courier has not processed yet */
  unprocessed: number | null;
  at: string | null;
}
export interface BagAdded {
  /** our tracking numbers now in the bag */
  added: string[];
  failed: { tracking: string; error: string }[];
}
export interface CourierBags {
  create(c: CourierCompany, items: TrackItem[]): Promise<{ extId: string; tracking: string | null } & BagAdded>;
  add(c: CourierCompany, bag: string, items: TrackItem[]): Promise<BagAdded>;
  remove(c: CourierCompany, bag: string, item: TrackItem): Promise<void>;
  list(c: CourierCompany): Promise<BagInfo[]>;
  /** the bag's label (A4 PDF), by its number */
  label(c: CourierCompany, tracking: string): Promise<LabelResult | null>;
  drop(c: CourierCompany, bag: string): Promise<void>;
}

/** What the courier knows about one parcel: its journey, the SMS it sent, its livreur, the customer's return risk. */
export interface ParcelInfo {
  state: string | null;
  color: string | null;
  situation: string | null;
  livreur: { name: string; phone: string | null; hub: string | null } | null;
  /** the customer's return risk at the courier (all its shops): score, level, completed orders, returns */
  risk: { score: number; level: string | null; orders: number; returns: number } | null;
  /** a modification request / a phone change can be made; one is already waiting */
  canModify: boolean;
  canChangePhone: boolean;
  pendingChange: boolean;
  modifications: number | null;
  modificationLimit: number | null;
  phoneChanges: number | null;
  phoneChangeLimit: number | null;
  phoneChangePrice: number | null;
  /** where the courier delivers it: home / pickup-point, its hub (stop desk), wilaya and commune names */
  delivery: { type: string | null; hub: string | null; city: string | null; district: string | null; street: string | null };
  amount: number | null;
  deliveryPrice: number | null;
  returnPrice: number | null;
  /** giving the parcel to another customer (a swap): allowed, how many so far, and its price (same wilaya / another) */
  swap: { eligible: boolean; count: number; sameCityPrice: number | null; differentCityPrice: number | null } | null;
  history: { at: string; status: string; color: string | null; hub: string | null; by: string | null; comment: string | null; situations: { name: string; at: string | null }[] }[];
  sms: { at: string; phone: string | null; message: string | null; status: string | null }[];
}

/** A modification request for a parcel already sent (validated by the courier); a phone change is applied at once. */
export interface ChangeInput {
  item: TrackItem;
  kind: 'amount' | 'delivery' | 'address' | 'phone';
  amount?: number;
  /** delivery: to a stop desk (its courier id) or home */
  stopdesk?: boolean;
  hubExtId?: string | null;
  wilayaId?: number;
  commune?: string;
  address?: string;
  phone?: string;
  phone2?: string | null;
}
export interface ChangeState {
  extId: string;
  /** null = waiting for the courier */
  approved: boolean | null;
  answer: string | null;
  at: string | null;
}

/** An exchange sent to the courier: the new parcel, and the courier's return parcel bringing the old product back. */
export interface ExchangeResult extends SendResult {
  returnTracking: string | null;
  returnExtId: string | null;
}

/** Helpers the framework gives to adapters. */
export interface Helpers {
  /** Finds the courier's commune matching ours (fuzzy). `load` lists the courier's communes of the wilaya. */
  communeName<T extends { name: string }>(p: Parcel, load: (wilayaId: number) => Promise<T[]>, cacheKey?: string): Promise<T | null>;
}

/**
 * One adapter per provider. `create` sends ONE parcel (the framework loops and keeps going on errors).
 * Optional methods are missing when the provider has no such API.
 */
export interface CourierAdapter {
  /** courier status (key or words) → our follow status; null = no change */
  statuses: Record<string, FollowStatus | null>;
  test(c: CourierCompany): Promise<{ ok: boolean; message: string }>;
  create(c: CourierCompany, p: Parcel, h: Helpers): Promise<SendResult>;
  track(c: CourierCompany, items: TrackItem[]): Promise<TrackResult[]>;
  label?(c: CourierCompany, p: TrackItem): Promise<LabelResult | null>;
  /** the labels of many parcels as ONE file (ZR: up to 250); `failed`: the tracking numbers left out */
  labels?(c: CourierCompany, items: TrackItem[]): Promise<{ label: LabelResult | null; failed: string[] }>;
  cancel?(c: CourierCompany, p: TrackItem): Promise<void>;
  fees?(c: CourierCompany): Promise<FeeRow[]>;
  stopdesks?(c: CourierCompany): Promise<Desk[]>;
  /** Réclamations through the courier API (create, its categories, read back their state). */
  claimCategories?(c: CourierCompany): Promise<ClaimCategory[]>;
  claim?(c: CourierCompany, i: ClaimInput): Promise<ClaimSent>;
  claimStates?(c: CourierCompany, extIds: string[]): Promise<ClaimState[]>;
  /** adds a message (follow-up) to a claim at the courier */
  claimComment?(c: CourierCompany, extId: string, text: string): Promise<void>;
  /** Payments through the courier API (balance, payment requests, payments and their parcels). */
  payments?: CourierPayments;
  /** Pickup bags (sacs de ramassage) through the courier API. */
  bags?: CourierBags;
  /** One parcel as the courier sees it: journey, SMS, livreur, return risk, what can still be changed. */
  parcel?(c: CourierCompany, item: TrackItem): Promise<ParcelInfo>;
  /** Modification requests (price, home / stop desk, address, phone) and their answers. */
  change?(c: CourierCompany, i: ChangeInput, h: Helpers, p: Parcel | null): Promise<{ extId: string; approved: boolean | null }>;
  changeStates?(c: CourierCompany, extIds: string[]): Promise<ChangeState[]>;
  /** withdraws a modification request the courier has not answered yet */
  changeCancel?(c: CourierCompany, extId: string): Promise<void>;
  /** Sends an exchange: a new parcel to the customer and the courier's return parcel for the old product. */
  exchange?(c: CourierCompany, p: Parcel, original: TrackItem, h: Helpers): Promise<ExchangeResult>;
  /** The courier's own list of statuses (its workflow), for the status mapping. */
  states?(c: CourierCompany): Promise<{ key: string; label: string; color: string | null }[]>;
  /** The courier's prices for its services (swap, phone change, labelling, office holding…). */
  services?(c: CourierCompany): Promise<{ key: string; label: string; price: number }[]>;
  /** Instant status updates: the courier calls our server on every status change. */
  webhook?: {
    on(c: CourierCompany, hookUrl: string, key: string): Promise<{ extId: string }>;
    off(c: CourierCompany, extId: string): Promise<void>;
    get(c: CourierCompany, extId: string): Promise<{ on: boolean; url: string | null } | null>;
  };
  /** What would be sent, without sending (secrets masked). */
  preview?(c: CourierCompany, p: Parcel): Promise<PreviewResult>;
}

/** The common shape of the framework (spec): send many, track many, label/cancel one, fees, stop desks, test. */
export interface CourierApi {
  send(orders: Parcel[]): Promise<({ id: number; ok: true } & SendResult | { id: number; ok: false; error: string })[]>;
  track(items: TrackItem[]): Promise<TrackResult[]>;
  label(item: TrackItem): Promise<LabelResult | null>;
  cancel(item: TrackItem): Promise<void>;
  fees(): Promise<FeeRow[]>;
  stopdesks(): Promise<Desk[]>;
  test(): Promise<{ ok: boolean; message: string }>;
}
