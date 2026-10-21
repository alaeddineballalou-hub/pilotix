/**
 * Demo mode: the whole app runs on sample data kept in memory, with no server.
 * Every name, phone number and order here is invented.
 */
import {
  canSetStatus,
  DashboardStats,
  normalizePhone,
  OfflineAction,
  Order,
  OrderEvent,
  OrderItem,
  OrderStatus,
  Page,
  Product,
  User,
} from '@pilotix/shared';
import type { OrderQuery } from './api';

// Deterministic random numbers, so the demo looks the same on every visit.
let seed = 20261021;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];

const FIRST = ['Amine', 'Yacine', 'Sofiane', 'Karim', 'Walid', 'Nassim', 'Riad', 'Mehdi', 'Bilal', 'Hichem', 'Lyes', 'Anis',
  'Amel', 'Samira', 'Nadia', 'Lina', 'Sarah', 'Imane', 'Meriem', 'Yasmine', 'Rania', 'Khadidja', 'Asma', 'Selma'];
const LAST = ['Benali', 'Bouzid', 'Haddad', 'Mansouri', 'Belkacem', 'Cherif', 'Saidi', 'Boudiaf', 'Ait Ahmed', 'Kaci',
  'Meziane', 'Hamidi', 'Rahmani', 'Zerrouki', 'Brahimi', 'Lounis', 'Touati', 'Benyahia', 'Djebbar', 'Ouali'];
// Wilaya code → a few communes; weighted toward the big cities.
const PLACES: [number, string[]][] = [
  [16, ['Bab Ezzouar', 'Hydra', 'Kouba', 'Bir Mourad Raïs', 'Chéraga', 'El Harrach']],
  [16, ['Dely Ibrahim', 'Bordj El Kiffan', 'Rouiba']],
  [31, ['Oran', 'Bir El Djir', 'Es Senia']],
  [31, ['Arzew', 'Aïn El Turck']],
  [25, ['Constantine', 'El Khroub', 'Ali Mendjeli']],
  [9, ['Blida', 'Boufarik', 'Ouled Yaïch']],
  [19, ['Sétif', 'El Eulma']],
  [23, ['Annaba', 'El Bouni']],
  [6, ['Béjaïa', 'Akbou']],
  [15, ['Tizi Ouzou', 'Azazga']],
  [35, ['Boumerdès', 'Thénia']],
  [42, ['Tipaza', 'Koléa']],
  [5, ['Batna', 'Barika']],
  [13, ['Tlemcen', 'Maghnia']],
  [30, ['Ouargla', 'Hassi Messaoud']],
  [47, ['Ghardaïa']],
  [7, ['Biskra']],
  [10, ['Bouira']],
];

const products: Product[] = [
  { id: 1, name: 'Robe d’été coton', sku: 'PX-ROB-01', price: 3900, cost: 1700, variants: ['S', 'M', 'L', 'XL'], stock: 84, active: true },
  { id: 2, name: 'Ensemble bébé 3 pièces', sku: 'PX-BEB-02', price: 2900, cost: 1200, variants: ['3 mois', '6 mois', '12 mois'], stock: 132, active: true },
  { id: 3, name: 'Sac à main cuir', sku: 'PX-SAC-03', price: 5500, cost: 2600, variants: ['Noir', 'Camel'], stock: 41, active: true },
  { id: 4, name: 'Montre homme acier', sku: 'PX-MON-04', price: 6900, cost: 3100, variants: [], stock: 7, active: true },
  { id: 5, name: 'Crème hydratante 200 ml', sku: 'PX-CRE-05', price: 1800, cost: 650, variants: [], stock: 260, active: true },
  { id: 6, name: 'Baskets running', sku: 'PX-BAS-06', price: 4800, cost: 2300, variants: ['40', '41', '42', '43', '44'], stock: 58, active: true },
  { id: 7, name: 'Parure de lit 2 places', sku: 'PX-PAR-07', price: 4200, cost: 1900, variants: ['Gris', 'Beige'], stock: 9, active: true },
  { id: 8, name: 'Écouteurs sans fil', sku: 'PX-ECO-08', price: 3200, cost: 1400, variants: [], stock: 115, active: true },
];

const users: (User & { lastSeenAt: string | null })[] = [
  { id: 1, name: 'Admin Pilotix', email: 'admin@demo.pilotix.dz', roles: ['admin'], language: 'fr', active: true, lastSeenAt: null },
  { id: 2, name: 'Yacine Manager', email: 'yacine@demo.pilotix.dz', roles: ['manager'], language: 'fr', active: true, lastSeenAt: null },
  { id: 3, name: 'Samira Confirmation', email: 'samira@demo.pilotix.dz', roles: ['confirmation'], language: 'ar', active: true, lastSeenAt: null },
  { id: 4, name: 'Rania Agent', email: 'rania@demo.pilotix.dz', roles: ['agent'], language: 'fr', active: true, lastSeenAt: null },
  { id: 5, name: 'Amel Agent', email: 'amel@demo.pilotix.dz', roles: ['agent'], language: 'ar', active: true, lastSeenAt: null },
  { id: 6, name: 'Nadia Suivi', email: 'nadia@demo.pilotix.dz', roles: ['suivi'], language: 'fr', active: true, lastSeenAt: null },
  { id: 7, name: 'Karim Dépôt', email: 'karim@demo.pilotix.dz', roles: ['depot'], language: 'fr', active: true, lastSeenAt: null },
  { id: 8, name: 'Lamine Livreur', email: 'lamine@demo.pilotix.dz', roles: ['livreur'], language: 'ar', active: true, lastSeenAt: null },
];
export const demoPresence: Record<number, 'online' | 'idle'> = { 2: 'online', 3: 'online', 4: 'online', 5: 'idle', 6: 'online', 7: 'idle' };

const orders: Order[] = [];
const events: OrderEvent[] = [];
let nextOrderId = 1;
let nextEventId = 1;
const customerHistory = new Map<string, { delivered: number; returned: number }>();

function addEvent(orderId: number, userId: number | null, type: OrderEvent['type'], from: string | null, to: string | null, note: string | null, at: Date) {
  events.push({ id: nextEventId++, orderId, userId, userName: users.find((u) => u.id === userId)?.name ?? null, type, fromValue: from, toValue: to, note, createdAt: at.toISOString() });
}

// Where an order ends up, by age: recent ones are still being confirmed, older ones are delivered or returned.
function finalStatus(ageDays: number): OrderStatus {
  const r = rnd();
  if (ageDays < 1) return r < 0.55 ? 'new' : r < 0.7 ? 'callback' : r < 0.8 ? 'no_answer' : r < 0.93 ? 'confirmed' : 'cancelled';
  if (ageDays < 3) return r < 0.08 ? 'new' : r < 0.18 ? 'callback' : r < 0.25 ? 'postponed' : r < 0.45 ? 'confirmed' : r < 0.6 ? 'assigned' : r < 0.85 ? 'shipped' : r < 0.95 ? 'cancelled' : 'duplicate';
  if (ageDays < 7) return r < 0.1 ? 'shipped' : r < 0.18 ? 'returning' : r < 0.72 ? 'delivered' : r < 0.82 ? 'returned' : 'cancelled';
  return r < 0.74 ? 'delivered' : r < 0.86 ? 'returned' : r < 0.97 ? 'cancelled' : 'duplicate';
}
const PATH: OrderStatus[] = ['new', 'confirmed', 'assigned', 'shipped', 'delivered'];
function pathTo(s: OrderStatus): OrderStatus[] {
  if (PATH.includes(s)) return PATH.slice(0, PATH.indexOf(s) + 1);
  if (s === 'returning') return ['new', 'confirmed', 'assigned', 'shipped', 'returning'];
  if (s === 'returned') return ['new', 'confirmed', 'assigned', 'shipped', 'returning', 'returned'];
  if (s === 'callback' || s === 'no_answer' || s === 'postponed') return ['new', s];
  return ['new', s];
}

function generate() {
  const now = Date.now();
  const phones: string[] = [];
  for (let i = 0; i < 1500; i++) {
    const ageDays = Math.pow(rnd(), 1.8) * 60;
    const created = new Date(now - ageDays * 86_400_000);
    const [wilaya, communes] = pick(PLACES);
    const reuse = phones.length > 50 && rnd() < 0.12;
    const phone = reuse ? pick(phones) : `0${pick(['5', '6', '7'])}${String(Math.floor(rnd() * 1e8)).padStart(8, '0')}`;
    if (!reuse) phones.push(phone);
    const lines = rnd() < 0.8 ? 1 : 2;
    const items: OrderItem[] = Array.from({ length: lines }, () => {
      const p = pick(products);
      return { productId: p.id, variant: p.variants.length ? pick(p.variants) : null, quantity: rnd() < 0.85 ? 1 : 2, unitPrice: p.price };
    });
    const fee = wilaya === 16 ? 400 : [9, 35, 42].includes(wilaya) ? 500 : [30, 47, 7].includes(wilaya) ? 900 : 600;
    const subtotal = items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);
    const discount = rnd() < 0.15 ? 300 : 0;
    const status = finalStatus(ageDays);
    const id = nextOrderId++;
    const agentId = pick([3, 4, 5]);
    const o: Order = {
      id,
      reference: `PX-${1000 + id}`,
      createdAt: created.toISOString(),
      updatedAt: created.toISOString(),
      status,
      customerName: `${pick(FIRST)} ${pick(LAST)}`,
      phone,
      wilaya,
      commune: pick(communes),
      address: rnd() < 0.7 ? `Cité ${pick(['des Oliviers', '1er Novembre', 'El Amel', 'Les Pins', 'Bensaci'])}, bât. ${1 + Math.floor(rnd() * 30)}` : '',
      items,
      deliveryFee: fee,
      discount,
      total: subtotal - discount + fee,
      note: rnd() < 0.08 ? 'Appeler après 17h' : null,
      agentId: status === 'new' ? null : agentId,
      livreurId: ['assigned', 'shipped', 'delivered', 'returning', 'returned'].includes(status) ? 8 : null,
      callbackAt: ['callback', 'postponed', 'no_answer'].includes(status) ? new Date(now + (rnd() * 48 - 12) * 3_600_000).toISOString() : null,
      tracking: ['shipped', 'delivered', 'returning', 'returned'].includes(status) ? `YAL-${Math.floor(100000 + rnd() * 899999)}` : null,
      attempts: status === 'no_answer' ? 1 + Math.floor(rnd() * 3) : 0,
      version: 1,
    };
    orders.push(o);
    let t = created.getTime();
    addEvent(id, null, 'created', null, 'new', null, created);
    const steps = pathTo(status);
    for (let k = 1; k < steps.length; k++) {
      t += (0.2 + rnd() * 1.5) * 3_600_000 * (k > 2 ? 12 : 1);
      if (t > now) t = now - 60_000;
      const by = k <= 1 ? agentId : steps[k] === 'assigned' ? 7 : steps[k] === 'shipped' || steps[k] === 'delivered' ? 8 : 6;
      addEvent(id, by, 'status', steps[k - 1], steps[k], null, new Date(t));
      o.updatedAt = new Date(t).toISOString();
    }
    if (status === 'delivered' || status === 'returned') {
      const h = customerHistory.get(phone) ?? { delivered: 0, returned: 0 };
      h[status === 'delivered' ? 'delivered' : 'returned']++;
      customerHistory.set(phone, h);
    }
  }
}
generate();

const OPEN: OrderStatus[] = ['new', 'callback', 'no_answer', 'postponed', 'confirmed', 'assigned'];
function decorate(o: Order): Order {
  const h = customerHistory.get(o.phone);
  const dup = OPEN.includes(o.status) && orders.some((x) => x.id !== o.id && x.phone === o.phone && OPEN.includes(x.status));
  return { ...o, possibleDuplicate: dup, customerDelivered: h?.delivered ?? 0, customerReturned: h?.returned ?? 0 };
}

let current: (typeof users)[number] = users[0];
const delay = <T,>(v: T, ms = 120): Promise<T> => new Promise((r) => setTimeout(() => r(structuredClone(v)), ms));
const fail = (msg: string) => Promise.reject(new Error(msg));
const isLivreurOnly = () => current.roles.length === 1 && current.roles[0] === 'livreur';

export function demoLogin(userId: number) {
  current = users.find((u) => u.id === userId) ?? users[0];
  return { token: 'demo', user: current as User };
}

function startOfTodayAlgiers() {
  const now = new Date();
  const local = new Date(now.getTime() + 60 * 60_000); // UTC+1
  local.setUTCHours(0, 0, 0, 0);
  return local.getTime() - 60 * 60_000;
}

export const demoApi = {
  login: () => fail('Demo: choose a role'),
  me: () => delay(current as User),
  setMyLanguage: (language: string) => {
    current = { ...current, language: language as User['language'] };
    return delay(current as User);
  },

  orders: (q: OrderQuery): Promise<Page<Order>> => {
    let list = orders;
    if (isLivreurOnly()) list = list.filter((o) => o.livreurId === current.id);
    if (q.status?.length) list = list.filter((o) => q.status!.includes(o.status));
    if (q.wilaya) list = list.filter((o) => o.wilaya === q.wilaya);
    if (q.callbackDue) list = list.filter((o) => o.callbackAt && Date.parse(o.callbackAt) <= Date.now() && ['callback', 'postponed', 'no_answer'].includes(o.status));
    if (q.q) {
      const s = q.q.trim().toLowerCase();
      const phone = normalizePhone(s);
      const digits = s.replace(/\D/g, '');
      list = list.filter((o) =>
        phone ? o.phone === phone : digits.length >= 4 && digits.length === s.replace(/[\s+-]/g, '').length ? o.phone.includes(digits.slice(-8))
          : o.reference.toLowerCase() === s || o.tracking?.toLowerCase() === s || o.customerName.toLowerCase().includes(s),
      );
    }
    list = [...list].sort((a, b) =>
      q.sort === 'callback_asc' ? Date.parse(a.callbackAt ?? '9999') - Date.parse(b.callbackAt ?? '9999') : Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
    const page = q.page ?? 1;
    const size = q.pageSize ?? 50;
    return delay({ rows: list.slice((page - 1) * size, page * size).map(decorate), total: list.length, page, pageSize: size });
  },

  order: (id: number) => {
    const o = orders.find((x) => x.id === id);
    return o ? delay(decorate(o)) : fail('Order not found');
  },

  orderEvents: (id: number) => delay(events.filter((e) => e.orderId === id)),

  createOrder: (body: any): Promise<Order> => {
    const phone = normalizePhone(body.phone);
    if (!phone) return fail('Invalid Algerian phone number');
    const items: OrderItem[] = body.items.map((i: any) => ({ ...i, unitPrice: products.find((p) => p.id === i.productId)?.price ?? 0 }));
    const subtotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
    const discount = Math.min(body.discount ?? 0, subtotal);
    const id = nextOrderId++;
    const now = new Date();
    const o: Order = {
      id, reference: `PX-${1000 + id}`, createdAt: now.toISOString(), updatedAt: now.toISOString(), status: 'new',
      customerName: body.customerName, phone, wilaya: body.wilaya, commune: body.commune ?? '', address: body.address ?? '', items,
      deliveryFee: body.deliveryFee ?? 0, discount, total: subtotal - discount + (body.deliveryFee ?? 0), note: body.note ?? null,
      agentId: null, livreurId: null, callbackAt: null, tracking: null, attempts: 0, version: 1,
    };
    orders.unshift(o);
    addEvent(id, current.id, 'created', null, 'new', null, now);
    return delay(decorate(o));
  },

  setStatus: (id: number, b: { status: OrderStatus; note?: string; callbackAt?: string | null; livreurId?: number; tracking?: string }) => {
    const o = orders.find((x) => x.id === id);
    if (!o) return fail('Order not found');
    const boss = current.roles.includes('admin') || current.roles.includes('manager');
    if (!canSetStatus(['admin'], o.status, b.status)) return fail(`An order cannot go from "${o.status}" to "${b.status}"`);
    if (!boss && !canSetStatus(current.roles, o.status, b.status)) return fail(`You cannot move an order to "${b.status}"`);
    const from = o.status;
    o.status = b.status;
    o.updatedAt = new Date().toISOString();
    o.version++;
    o.callbackAt = ['callback', 'postponed', 'no_answer'].includes(b.status) ? b.callbackAt ?? null : null;
    if (b.status === 'no_answer') o.attempts++;
    if (b.livreurId) o.livreurId = b.livreurId;
    if (b.tracking) o.tracking = b.tracking;
    if (!o.agentId && ['confirmed', 'callback', 'no_answer', 'postponed', 'cancelled', 'duplicate'].includes(b.status)) o.agentId = current.id;
    if (b.status === 'shipped' || b.status === 'returned') {
      for (const it of o.items) {
        const p = products.find((x) => x.id === it.productId);
        if (p) p.stock += (b.status === 'shipped' ? -1 : 1) * it.quantity;
      }
    }
    addEvent(id, current.id, 'status', from, b.status, b.note ?? null, new Date());
    return delay(decorate(o));
  },

  sync: (actions: OfflineAction[]) => delay({ results: actions.map((a) => ({ clientId: a.clientId, ok: true })) }),
  products: (q?: string) => delay(products.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.sku.toLowerCase().startsWith(q.toLowerCase()))),
  users: () => delay(users),

  dashboard: (): Promise<DashboardStats> => {
    const today = startOfTodayAlgiers();
    const since = Date.now() - 30 * 86_400_000;
    const evToday = (s: OrderStatus) => new Set(events.filter((e) => e.toValue === s && e.type === 'status' && Date.parse(e.createdAt) >= today).map((e) => e.orderId)).size;
    const recent = orders.filter((o) => Date.parse(o.createdAt) >= since);
    const byStatus: Partial<Record<OrderStatus, number>> = {};
    for (const o of recent) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;
    const n = (s: OrderStatus) => byStatus[s] ?? 0;
    const decided = n('confirmed') + n('assigned') + n('shipped') + n('delivered') + n('returning') + n('returned') + n('cancelled');
    const finished = n('delivered') + n('returned');
    return delay({
      today: { created: orders.filter((o) => Date.parse(o.createdAt) >= today).length, confirmed: evToday('confirmed'), delivered: evToday('delivered'), returned: evToday('returned') },
      byStatus,
      confirmationRate: decided ? (decided - n('cancelled')) / decided : 0,
      deliveryRate: finished ? n('delivered') / finished : 0,
      revenueDelivered: recent.filter((o) => o.status === 'delivered').reduce((s, o) => s + o.total, 0),
    });
  },
};
