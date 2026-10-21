// Shared types and rules used by both the Pilotix server and the app.

export const ROLES = ['admin', 'manager', 'confirmation', 'agent', 'suivi', 'depot', 'livreur'] as const;
export type Role = (typeof ROLES)[number];

export const LANGUAGES = ['fr', 'en', 'ar'] as const;
export type Language = (typeof LANGUAGES)[number];

export const ORDER_STATUSES = [
  'new',
  'confirmed',
  'callback',
  'no_answer',
  'postponed',
  'cancelled',
  'duplicate',
  'assigned',
  'shipped',
  'delivered',
  'returning',
  'returned',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Which statuses an order may move to from each status. */
export const STATUS_FLOW: Record<OrderStatus, OrderStatus[]> = {
  new: ['confirmed', 'callback', 'no_answer', 'postponed', 'cancelled', 'duplicate'],
  callback: ['confirmed', 'callback', 'no_answer', 'postponed', 'cancelled'],
  no_answer: ['confirmed', 'callback', 'no_answer', 'postponed', 'cancelled'],
  postponed: ['confirmed', 'callback', 'no_answer', 'postponed', 'cancelled'],
  confirmed: ['assigned', 'cancelled'],
  assigned: ['shipped', 'confirmed', 'cancelled'],
  shipped: ['delivered', 'returning'],
  returning: ['returned', 'delivered'],
  delivered: [],
  returned: [],
  cancelled: ['new'],
  duplicate: ['new'],
};

/** Which roles may set an order to a given status. Admin and manager may set any. */
export const STATUS_ROLES: Record<OrderStatus, Role[]> = {
  new: ['admin', 'manager'],
  confirmed: ['admin', 'manager', 'confirmation', 'agent'],
  callback: ['admin', 'manager', 'confirmation', 'agent'],
  no_answer: ['admin', 'manager', 'confirmation', 'agent'],
  postponed: ['admin', 'manager', 'confirmation', 'agent'],
  cancelled: ['admin', 'manager', 'confirmation', 'agent'],
  duplicate: ['admin', 'manager', 'confirmation', 'agent'],
  assigned: ['admin', 'manager', 'depot'],
  shipped: ['admin', 'manager', 'depot', 'livreur'],
  delivered: ['admin', 'manager', 'suivi', 'livreur'],
  returning: ['admin', 'manager', 'suivi', 'livreur'],
  returned: ['admin', 'manager', 'suivi', 'depot'],
};

export function canSetStatus(roles: Role[], from: OrderStatus, to: OrderStatus): boolean {
  if (!STATUS_FLOW[from].includes(to)) return false;
  return roles.some((r) => STATUS_ROLES[to].includes(r));
}

/**
 * Normalizes an Algerian phone number to the local 10-digit form (0XXXXXXXXX).
 * Accepts +213, 00213, 213 and spaces/dashes. Returns null when it is not a valid number.
 */
export function normalizePhone(input: string): string | null {
  let d = (input || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+213')) d = '0' + d.slice(4);
  else if (d.startsWith('00213')) d = '0' + d.slice(5);
  else if (d.startsWith('213') && d.length === 12) d = '0' + d.slice(3);
  d = d.replace(/\D/g, '');
  if (/^0[5-7]\d{8}$/.test(d)) return d; // mobile: Mobilis 06, Djezzy 07, Ooredoo 05
  if (/^0[2-4]\d{7}$/.test(d)) return d; // landline
  return null;
}

/** Money is stored as whole dinars (integers), never floats. */
export type DZD = number;

export interface OrderItem {
  productId: number;
  variant?: string | null;
  quantity: number;
  unitPrice: DZD;
}

export interface Order {
  id: number;
  reference: string;
  createdAt: string;
  updatedAt: string;
  status: OrderStatus;
  customerName: string;
  phone: string;
  wilaya: number;
  commune: string;
  address: string;
  items: OrderItem[];
  deliveryFee: DZD;
  discount: DZD;
  total: DZD;
  note?: string | null;
  agentId?: number | null;
  livreurId?: number | null;
  callbackAt?: string | null;
  tracking?: string | null;
  attempts: number;
  version: number;
  /** Another open order exists for the same phone. */
  possibleDuplicate?: boolean;
  /** Customer history: delivered and returned orders. */
  customerDelivered?: number;
  customerReturned?: number;
}

export const OPEN_STATUSES: OrderStatus[] = ['new', 'callback', 'no_answer', 'postponed', 'confirmed', 'assigned'];

export interface OrderEvent {
  id: number;
  orderId: number;
  userId: number | null;
  userName: string | null;
  type: 'created' | 'status' | 'edit' | 'call' | 'note';
  fromValue: string | null;
  toValue: string | null;
  note: string | null;
  createdAt: string;
}

/** An action made on the phone, possibly while offline, replayed when back online. */
export interface OfflineAction {
  clientId: string;
  orderId: number;
  kind: 'status' | 'call' | 'note';
  status?: OrderStatus;
  note?: string;
  callbackAt?: string | null;
  at: string;
}

export interface Product {
  id: number;
  name: string;
  sku: string;
  price: DZD;
  cost: DZD;
  variants: string[];
  stock: number;
  active: boolean;
}

export interface User {
  id: number;
  name: string;
  email: string;
  roles: Role[];
  language: Language;
  active: boolean;
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DashboardStats {
  today: { created: number; confirmed: number; delivered: number; returned: number };
  byStatus: Partial<Record<OrderStatus, number>>;
  confirmationRate: number;
  deliveryRate: number;
  revenueDelivered: DZD;
}

/** Live events sent over WebSockets. */
export type LiveEvent =
  | { type: 'order.created'; order: Order }
  | { type: 'order.updated'; order: Order }
  | { type: 'presence'; userId: number; state: 'online' | 'idle' | 'offline' };

/**
 * The 69 wilayas of Algeria, numbered by official code (index + 1).
 * 59–69 were named by presidential decree n° 26-206 of 25 May 2026.
 */
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
