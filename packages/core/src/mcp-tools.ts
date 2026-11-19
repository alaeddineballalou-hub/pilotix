// What an AI assistant linked to Pilotix (mcp-server.ts) can ask — SERVER ONLY. Read-only for now: every tool reads
// through the app's own actions (index.ts › call), as the person who linked the assistant: the same role checks, the
// same rights (Utilisateurs › Rôles), the same rows as on their own screen. A tool only gives the fields listed here
// (never a photo, a key, a courier's settings or a purchase price), in short lines an assistant reads well.
import { CONF_STATUSES, FOLLOW_STATUSES, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { AppError, bad } from './rpc';

/** One call of an assistant: who it acts for, in which boutique, and the way to run the app's actions as that person. */
export interface McpEnv {
  /** runs one Pilotix action as the person (role checks, rights and rows as on their own screen) */
  call: (name: string, input: unknown) => Promise<any>;
  who: { name: string; email: string; roles: string[]; isAdmin: boolean };
  shop: { name: string; slug: string };
  /** what the person allowed (« read ») */
  scope: string[];
  now: number;
  /** the server's version (shown to the assistant) */
  version: string;
  /** an unexpected error (a bug): written in the server's log */
  onError?: (e: unknown, where: string) => void;
  /** each tool the assistant used, for the person's log (Mon profil › Assistants IA › Journal) */
  log?: (call: McpCall) => void;
}

/** One tool an assistant used, as its log keeps it: what came of it, and a few short facts (callDetail). */
export interface McpCall {
  tool: string;
  /** read: it answered · refused: not allowed (the person's role, or what the link may do) · error: anything else */
  kind: 'read' | 'refused' | 'error';
  detail: Record<string, unknown>;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  /** the roles that may use it (as the action it reads); null: everyone. Administrators always may. */
  roles: string[] | null;
  /** what the assistant sends, as it is told (JSON Schema) and as it is checked (zod) */
  inputSchema: Record<string, unknown>;
  input: z.ZodTypeAny;
  run: (env: McpEnv, input: any) => Promise<unknown>;
}

// ---------------------------------------------------------------- small helpers
const DAY_MS = 86_400_000;
/** Algeria is UTC+1 all year (no summer time). */
const ALGIERS_MS = 3_600_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const algiersDay = (now: number) => new Date(now + ALGIERS_MS).toISOString().slice(0, 10);

/** A day (YYYY-MM-DD: Algeria's day) or a moment (ISO) → where the period starts. */
function startOf(v: string): string {
  const t = DAY_RE.test(v) ? Date.parse(`${v}T00:00:00+01:00`) : Date.parse(v);
  if (Number.isNaN(t)) throw bad(`Date invalide : « ${v} » (attendu : AAAA-MM-JJ)`);
  return new Date(t).toISOString();
}
/** … → where the period ends (a day alone: that whole day is inside). */
function endOf(v: string): string {
  const t = DAY_RE.test(v) ? Date.parse(`${v}T00:00:00+01:00`) + DAY_MS : Date.parse(v);
  if (Number.isNaN(t)) throw bad(`Date invalide : « ${v} » (attendu : AAAA-MM-JJ)`);
  return new Date(t).toISOString();
}
/**
 * The period asked. Nothing given: today (Algeria's day), or the last `back` days too. Only its start: from there until
 * the end of today. Only its end: that day.
 */
function period(env: McpEnv, i: { from?: string; to?: string }, back = 0): { from: string; to: string } {
  const to = endOf(i.to ?? algiersDay(env.now));
  const from = startOf(i.from ?? i.to ?? algiersDay(env.now - back * DAY_MS));
  if (Date.parse(to) <= Date.parse(from)) throw bad('Période invalide : la fin est avant le début');
  return { from, to };
}
const pct = (r: unknown): number | null => (typeof r === 'number' && Number.isFinite(r) ? Math.round(r * 1000) / 10 : null);
const wilaya = (id: unknown): string | null => {
  const n = Number(id);
  return Number.isInteger(n) && n >= 1 ? `${String(n).padStart(2, '0')} ${WILAYAS[n - 1] ?? ''}`.trim() : null;
};
const text = (v: unknown, max = 300): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? (s.length > max ? `${s.slice(0, max)}…` : s) : null;
};
const itemsOf = (items: unknown): string =>
  (Array.isArray(items) ? items : [])
    .map((x: any) => `${Number(x?.qty) || 1} × ${String(x?.name ?? '')}${x?.variantTitle ? ` (${x.variantTitle})` : ''}`)
    .join(' · ');

/** An order, as one line of a list. */
const orderLine = (o: any) => ({
  id: Number(o.id),
  ref: String(o.ref ?? ''),
  created: o.createdAt ?? null,
  customer: text(o.customerName, 120),
  phone: text(o.phone, 30),
  wilaya: wilaya(o.wilayaId),
  commune: text(o.commune, 120),
  items: itemsOf(o.items),
  total_da: Number(o.total) || 0,
  confirmation: o.confStatus ?? null,
  delivery: o.followStatus ?? null,
  agent: text(o.agentName, 80),
  company: text(o.companyName ?? o.livreurName, 80),
  tracking: text(o.tracking, 80),
  courier_status: text(o.extStatus, 120),
  call_attempts: Number(o.attempts) || 0,
});

const day = z.string().min(8).max(40);
const DAY_DOC = 'A day as YYYY-MM-DD (the day in Algeria), or a full ISO date-time.';
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const DATE_OF = { created: 'created_at', confirmed: 'confirmed_at', shipped: 'shipped_at', delivered: 'delivered_at', returned: 'back_at', updated: 'updated_at' } as const;
const SORT_OF = { created: 'created_at', confirmed: 'confirmed_at', shipped: 'shipped_at', delivered: 'delivered_at', returned: 'updated_at', updated: 'updated_at' } as const;
const FOLLOW_UP = { on_the_road: 'enlivraison', alerts: 'alertes', stuck: 'bloques', treated: 'traites', delivered_last_30_days: 'livres', coming_back: 'annules' } as const;

// ---------------------------------------------------------------- the tools
export const MCP_TOOLS: McpTool[] = [
  {
    name: 'whoami',
    title: 'Who am I in Pilotix',
    description: 'The person this assistant acts for (name, roles), their boutique, and today’s date in Algeria. Use it first when a question depends on today’s date or on what the person may see.',
    roles: null,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    input: z.object({}).strict(),
    run: async (env) => ({
      name: env.who.name,
      email: env.who.email,
      roles: env.who.roles,
      administrator: env.who.isAdmin,
      boutique: env.shop.name,
      boutique_link: env.shop.slug,
      access: 'read-only (nothing can be changed from this assistant)',
      today: algiersDay(env.now),
      now: new Date(env.now).toISOString(),
      timezone: 'Africa/Algiers (UTC+1)',
      currency: 'DZD (Algerian dinar, DA)',
    }),
  },
  {
    name: 'search_orders',
    title: 'Search orders',
    description:
      'Finds orders: by reference, phone, tracking number or customer name (q), by confirmation status, delivery status, wilaya, product and period. Returns one line per order (newest first) and the total count. For returns use delivery ["returning","returned"] with date_of "returned".',
    roles: null,
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'An order reference (PX-…), a phone number, a tracking number or part of the customer’s name.' },
        confirmation: { type: 'array', items: { type: 'string', enum: [...CONF_STATUSES] }, description: 'Only these confirmation statuses.' },
        delivery: { type: 'array', items: { type: 'string', enum: [...FOLLOW_STATUSES, 'none'] }, description: 'Only these delivery statuses ("none": not confirmed yet, no parcel).' },
        wilaya: { type: 'integer', minimum: 1, maximum: 69, description: 'The wilaya’s number (16 = Alger, 31 = Oran…).' },
        product_id: { type: 'integer', description: 'Only orders containing this product (its id from search_products).' },
        date_of: { type: 'string', enum: Object.keys(DATE_OF), description: 'Which date from / to look at (default: created).' },
        from: { type: 'string', description: `Start of the period. ${DAY_DOC}` },
        to: { type: 'string', description: `End of the period (a day alone is included whole). ${DAY_DOC}` },
        oldest_first: { type: 'boolean', description: 'Oldest first (default: newest first).' },
        page: { type: 'integer', minimum: 1, description: 'Page number (default 1).' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Orders per page (default 20, 50 at most).' },
      },
      additionalProperties: false,
    },
    input: z
      .object({
        q: z.string().max(100).optional(),
        confirmation: z.array(z.enum(CONF_STATUSES)).max(12).optional(),
        delivery: z.array(z.enum([...FOLLOW_STATUSES, 'none'] as const)).max(14).optional(),
        wilaya: z.number().int().min(1).max(69).optional(),
        product_id: z.number().int().positive().optional(),
        date_of: z.enum(['created', 'confirmed', 'shipped', 'delivered', 'returned', 'updated']).default('created'),
        from: day.optional(),
        to: day.optional(),
        oldest_first: z.boolean().default(false),
        page: z.number().int().min(1).max(100_000).default(1),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .strict(),
    run: async (env, i) => {
      const of = i.date_of as keyof typeof DATE_OF;
      const p = await env.call('orders.list', {
        ...(i.q?.trim() ? { q: i.q.trim() } : {}),
        ...(i.confirmation?.length ? { conf: i.confirmation } : {}),
        ...(i.delivery?.length ? { follow: i.delivery } : {}),
        ...(i.wilaya ? { wilayaId: i.wilaya } : {}),
        ...(i.product_id ? { productId: i.product_id } : {}),
        dateField: DATE_OF[of],
        ...(i.from ? { from: startOf(i.from) } : {}),
        ...(i.to ? { to: endOf(i.to) } : {}),
        sort: SORT_OF[of],
        dir: i.oldest_first ? 'asc' : 'desc',
        page: i.page,
        pageSize: i.limit,
      });
      const total = Number(p?.total) || 0;
      return { total, page: i.page, pages: Math.max(1, Math.ceil(total / i.limit)), orders: (p?.rows ?? []).map(orderLine) };
    },
  },
  {
    name: 'get_order',
    title: 'One order in full',
    description: 'Everything about one order, by its id or its reference: customer, address, products, prices, notes, both statuses, courier and tracking, and its history (who did what, when).',
    roles: null,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'The order’s id (from search_orders).' },
        ref: { type: 'string', description: 'Or its reference, as written on the order (PX-…).' },
      },
      additionalProperties: false,
    },
    input: z
      .object({ id: z.number().int().positive().optional(), ref: z.string().trim().min(2).max(40).optional() })
      .strict()
      .refine((x) => x.id !== undefined || !!x.ref, { message: 'id or ref is required' }),
    run: async (env, i) => {
      let id: number | undefined = i.id;
      if (id === undefined) {
        const found = await env.call('orders.list', { q: i.ref, tickets: 'include', pageSize: 10 });
        const hit = (found?.rows ?? []).find((o: any) => String(o.ref).toUpperCase() === String(i.ref).toUpperCase());
        if (!hit) throw new AppError('not_found', `Commande introuvable : ${i.ref}`);
        id = Number(hit.id);
      }
      const o = await env.call('orders.get', { id });
      const events: any[] = await env.call('orders.events', { id });
      return {
        ...orderLine(o),
        phone2: text(o.phone2, 30),
        address: text(o.address),
        pickup_at_desk: !!o.isStopdesk,
        channel: o.channel ?? null,
        source: text(o.source, 120),
        products: (Array.isArray(o.items) ? o.items : []).map((x: any) => ({
          product_id: Number(x.productId),
          name: String(x.name ?? ''),
          variant: text(x.variantTitle, 80),
          qty: Number(x.qty) || 0,
          unit_price_da: Number(x.unitPrice) || 0,
          upsell: !!x.isUpsell,
        })),
        subtotal_da: Number(o.subtotal) || 0,
        delivery_fee_da: Number(o.deliveryFee) || 0,
        discount_da: Number(o.discount) || 0,
        notes: { customer: text(o.customerNote, 1000), delivery: text(o.deliveryNote, 1000), internal: text(o.internalNote, 1000) },
        next_call: o.nextCallAt ?? null,
        confirmed: o.confirmedAt ?? null,
        shipped: o.shippedAt ?? null,
        delivered: o.deliveredAt ?? null,
        returned: o.returnedAt ?? null,
        delivery_attempts: Number(o.deliveryAttempts) || 0,
        money_received: !!o.cashed,
        exchange_parcel: !!o.isExchange,
        customer_score: o.clientScore ? { score: Number(o.clientScore.score), level: o.clientScore.level } : null,
        customer_blacklisted: !!o.blacklisted,
        history: (Array.isArray(events) ? events : []).slice(-60).map((e: any) => ({ at: e.at, by: text(e.userName, 80), what: e.kind, from: text(e.fromValue, 80), to: text(e.toValue, 80), note: text(e.note, 500) })),
      };
    },
  },
  {
    name: 'order_counts',
    title: 'How many orders in each status now',
    description: 'The number of orders in each confirmation status and each delivery status right now, the calls that are late, and the open after-sales tickets.',
    roles: null,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    input: z.object({}).strict(),
    run: async (env) => {
      const c = await env.call('orders.counts', {});
      return {
        all_orders: Number(c?.all) || 0,
        confirmation: c?.conf ?? {},
        delivery: c?.follow ?? {},
        late_calls: Number(c?.lateCalls) || 0,
        open_after_sales_tickets: Number(c?.sav) || 0,
        delivered_money_not_received_yet: Number(c?.uncashed) || 0,
        products_low_in_stock: Number(c?.lowStock) || 0,
      };
    },
  },
  {
    name: 'stats_overview',
    title: 'The numbers of a period',
    description: 'For a period (default: today): orders received, confirmed, cancelled and the confirmation rate; parcels shipped, delivered, returned and the delivery rate; money of the delivered parcels.',
    roles: ['confirmation', 'suivi', 'depot'],
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string', description: `Start. ${DAY_DOC}` }, to: { type: 'string', description: `End (included). ${DAY_DOC}` } },
      additionalProperties: false,
    },
    input: z.object({ from: day.optional(), to: day.optional() }).strict(),
    run: async (env, i) => {
      const p = period(env, i);
      const r = await env.call('stats.overview', p);
      return {
        period: p,
        received: Number(r?.received) || 0,
        received_still_to_call: Number(r?.receivedTodo) || 0,
        confirmed: Number(r?.confirmed) || 0,
        cancelled: Number(r?.cancelled) || 0,
        confirmation_rate_pct: pct(r?.confRate),
        shipped: Number(r?.shipped) || 0,
        shipped_still_on_the_road: Number(r?.shippedOnRoad) || 0,
        delivered: Number(r?.delivered) || 0,
        returned: Number(r?.returned) || 0,
        delivery_rate_pct: pct(r?.deliveryRate),
        delivered_money_da: Number(r?.cashed) || 0,
        delivered_products_money_da: Number(r?.cashedProducts) || 0,
      };
    },
  },
  {
    name: 'shop_dashboard',
    title: 'The owner’s dashboard',
    description:
      'For the owner: revenue of a period against the period before, this month against the goal, the top products, the top wilayas, the funnel (received → called → confirmed → shipped → delivered), the sales channels, and the numbers per day.',
    roles: ['vendeur'],
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string', description: `Start (default: 7 days ago). ${DAY_DOC}` }, to: { type: 'string', description: `End (included; default: today). ${DAY_DOC}` } },
      additionalProperties: false,
    },
    input: z.object({ from: day.optional(), to: day.optional() }).strict(),
    run: async (env, i) => {
      const p = period(env, i, 6);
      const r = await env.call('stats.overview2', p);
      const series: any[] = Array.isArray(r?.series) ? r.series : [];
      return {
        period: p,
        revenue_da: Number(r?.kpis?.revenue) || 0,
        revenue_period_before_da: Number(r?.kpis?.revenuePrev) || 0,
        received: Number(r?.kpis?.received) || 0,
        received_period_before: Number(r?.kpis?.receivedPrev) || 0,
        delivered: Number(r?.kpis?.delivered) || 0,
        delivery_rate_pct: pct(r?.kpis?.deliveryRate),
        delivery_rate_period_before_pct: pct(r?.kpis?.deliveryRatePrev),
        this_month: { revenue_da: Number(r?.month?.revenue) || 0, last_month_same_day_da: Number(r?.month?.prevSamePoint) || 0, goal_da: Number(r?.month?.goal) || 0 },
        top_products: (r?.products?.top ?? []).map((x: any) => ({ name: String(x.name ?? ''), qty: Number(x.qty) || 0, delivered_value_da: Number(x.value) || 0 })),
        other_products_da: Number(r?.products?.other) || 0,
        top_wilayas: (r?.wilayas ?? []).map((x: any) => ({ wilaya: wilaya(x.wilayaId), orders: Number(x.n) || 0 })),
        funnel: r?.funnel ?? null,
        channels: (r?.channels ?? []).map((x: any) => ({ channel: String(x.channel ?? ''), orders: Number(x.n) || 0 })),
        per_day: series.length <= 62 ? series.map((d: any) => ({ day: d.day, received: Number(d.received) || 0, delivered: Number(d.delivered) || 0, revenue_da: Number(d.revenue) || 0 })) : 'more than 62 days: ask a shorter period for the numbers per day',
      };
    },
  },
  {
    name: 'agent_stats',
    title: 'Confirmation agents of a period',
    description: 'For a period (default: today), each confirmation agent: orders treated, confirmed, the confirmation rate, then delivered, returned and the delivery rate of their orders.',
    roles: ['confirmation', 'suivi', 'depot'],
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string', description: `Start. ${DAY_DOC}` }, to: { type: 'string', description: `End (included). ${DAY_DOC}` } },
      additionalProperties: false,
    },
    input: z.object({ from: day.optional(), to: day.optional() }).strict(),
    run: async (env, i) => {
      const p = period(env, i);
      const rows: any[] = await env.call('stats.agents', p);
      return {
        period: p,
        agents: (Array.isArray(rows) ? rows : []).slice(0, 200).map((a) => ({
          agent: String(a.name ?? ''),
          treated: Number(a.treated) || 0,
          confirmed: Number(a.confirmed) || 0,
          confirmation_rate_pct: pct(a.confRate),
          delivered: Number(a.delivered) || 0,
          returned: Number(a.returned) || 0,
          delivery_rate_pct: pct(a.deliveryRate),
        })),
      };
    },
  },
  {
    name: 'search_products',
    title: 'Products, prices and what is left to sell',
    description: 'The boutique’s products on sale (by name or SKU): price, variants (colour, size…) and for each variant the stock and what is still available to sell (stock minus what waiting orders hold).',
    roles: null,
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: 'Part of the product’s name, or its SKU. Empty: the first products.' }, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Products at most (default 20).' } },
      additionalProperties: false,
    },
    input: z.object({ q: z.string().max(100).default(''), limit: z.number().int().min(1).max(50).default(20) }).strict(),
    run: async (env, i) => {
      const rows: any[] = await env.call('catalog.search', { q: i.q.trim(), limit: i.limit });
      return {
        products: (Array.isArray(rows) ? rows : []).map((p) => ({
          id: Number(p.id),
          name: String(p.name ?? ''),
          sku: text(p.sku, 80),
          price_da: Number(p.price) || 0,
          service: !!p.isService,
          variants: (Array.isArray(p.variants) ? p.variants : []).slice(0, 60).map((v: any) => ({
            id: Number(v.id),
            name: text(v.title, 80) ?? '(no variant)',
            sku: text(v.sku, 80),
            price_da: Number(v.price ?? p.price) || 0,
            stock: Number(v.stock) || 0,
            available: v.available === null || v.available === undefined ? null : Number(v.available),
          })),
        })),
      };
    },
  },
  {
    name: 'stock_levels',
    title: 'Stock by depot',
    description: 'The stock of each product variant in each depot: pieces in stock, held by waiting orders, available, the alert level, and pieces shipped in the last 30 days. low_only: only what is at or under its alert level.',
    roles: ['depot'],
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: 'Part of the product’s name, or a SKU.' }, low_only: { type: 'boolean', description: 'Only the lines at or under their alert level (default false).' } },
      additionalProperties: false,
    },
    input: z.object({ q: z.string().max(100).optional(), low_only: z.boolean().default(false) }).strict(),
    run: async (env, i) => {
      const rows: any[] = await env.call('catalog.stock', { ...(i.q?.trim() ? { q: i.q.trim() } : {}), missingOnly: i.low_only });
      const all = Array.isArray(rows) ? rows : [];
      return {
        lines: all.length,
        ...(all.length > 200 ? { note: 'Only the first 200 lines are shown: search a product (q) or ask low_only.' } : {}),
        stock: all.slice(0, 200).map((r) => ({
          product: String(r.productName ?? ''),
          variant: text(r.variantTitle, 80),
          sku: text(r.sku, 80),
          depot: String(r.warehouseName ?? ''),
          in_stock: Number(r.qty) || 0,
          held_by_orders: Number(r.reserved) || 0,
          available: Number(r.available) || 0,
          alert_at: Number(r.alertQty) || 0,
          broken: Number(r.broken) || 0,
          shipped_last_30_days: Number(r.sold30) || 0,
        })),
      };
    },
  },
  {
    name: 'delivery_follow_up',
    title: 'Parcels on the road, alerts and returns',
    description:
      'The delivery follow-up lists, with the count of each: on_the_road (every parcel with a courier), alerts (parcels with a problem to solve), stuck (no news for too long), treated (alerts already handled), delivered_last_30_days, coming_back (parcels on their way back).',
    roles: ['suivi', 'confirmation'],
    inputSchema: {
      type: 'object',
      properties: {
        list: { type: 'string', enum: Object.keys(FOLLOW_UP), description: 'Which list (default: alerts).' },
        q: { type: 'string', description: 'A reference, phone, tracking number or customer name.' },
        page: { type: 'integer', minimum: 1, description: 'Page number (default 1).' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Parcels per page (default 20).' },
      },
      additionalProperties: false,
    },
    input: z
      .object({
        list: z.enum(['on_the_road', 'alerts', 'stuck', 'treated', 'delivered_last_30_days', 'coming_back']).default('alerts'),
        q: z.string().max(100).optional(),
        page: z.number().int().min(1).max(100_000).default(1),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .strict(),
    run: async (env, i) => {
      const c = await env.call('suivi.counts', {});
      const p = await env.call('suivi.list', { tab: FOLLOW_UP[i.list as keyof typeof FOLLOW_UP], ...(i.q?.trim() ? { q: i.q.trim() } : {}), page: i.page, pageSize: i.limit });
      const total = Number(p?.total) || 0;
      return {
        counts: {
          on_the_road: Number(c?.enlivraison) || 0,
          alerts: Number(c?.alertes) || 0,
          alerts_nobody_called_yet: Number(c?.alertes_new) || 0,
          stuck: Number(c?.bloques) || 0,
          treated: Number(c?.traites) || 0,
          delivered_last_30_days: Number(c?.livres) || 0,
          coming_back: Number(c?.annules) || 0,
          open_claims: Number(c?.claims) || 0,
        },
        list: i.list,
        total,
        page: i.page,
        pages: Math.max(1, Math.ceil(total / i.limit)),
        parcels: (p?.rows ?? []).slice(0, i.limit).map((o: any) => ({ ...orderLine(o), shipped: o.shippedAt ?? null, delivery_attempts: Number(o.deliveryAttempts) || 0, sub_status: text(o.subStatus, 60) })),
      };
    },
  },
  {
    name: 'delivery_companies',
    title: 'Delivery companies',
    description: 'The boutique’s delivery companies (and its own couriers): name, kind, whether it is in use, and how many parcels wait to leave or are on the road with each.',
    roles: null,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    input: z.object({}).strict(),
    run: async (env) => {
      const rows: any[] = await env.call('delivery.companies', {});
      return {
        companies: (Array.isArray(rows) ? rows : []).slice(0, 100).map((c) => ({
          id: Number(c.id),
          name: String(c.name ?? ''),
          kind: text(c.kindLabel ?? c.kind, 60),
          in_use: !!c.active,
          parcels_waiting_to_leave: Number(c.toShip) || 0,
          parcels_on_the_road: Number(c.onRoad) || 0,
        })),
      };
    },
  },
  {
    name: 'customer_history',
    title: 'A customer and their orders',
    description: 'A customer found by phone number: how many orders, delivered, returned, cancelled, their score, whether they are blacklisted, and their orders (newest first).',
    roles: ['confirmation', 'suivi'],
    inputSchema: { type: 'object', properties: { phone: { type: 'string', description: 'The customer’s phone number (0661…, +213661…).' } }, required: ['phone'], additionalProperties: false },
    input: z.object({ phone: z.string().trim().min(9).max(20) }).strict(),
    run: async (env, i) => {
      const r = await env.call('customers.history', { phone: i.phone });
      const c = r?.customer ?? {};
      return {
        customer: {
          name: text(c.name, 120),
          phone: text(c.phone, 30),
          wilaya: wilaya(c.wilayaId),
          orders: Number(c.orders) || 0,
          delivered: Number(c.delivered) || 0,
          returned: Number(c.returned) || 0,
          cancelled: Number(c.cancelled) || 0,
          last_order: c.lastOrderAt ?? null,
          blacklisted: !!c.blacklisted,
          blacklist_reason: text(c.blacklistReason, 200),
          score: c.score ? { score: Number(c.score.score), level: c.score.level } : null,
        },
        orders: (Array.isArray(r?.orders) ? r.orders : []).slice(0, 50).map((o: any) => ({
          id: Number(o.id),
          ref: String(o.ref ?? ''),
          created: o.createdAt ?? null,
          items: [text(o.itemsText, 300), text(o.variantsText, 200)].filter(Boolean).join(' — '),
          total_da: Number(o.total) || 0,
          confirmation: o.confStatus ?? null,
          delivery: o.followStatus ?? null,
          call_attempts: Number(o.attempts) || 0,
        })),
      };
    },
  },
];

/** The tools this person's roles may use (an administrator: all of them). */
export const toolsFor = (who: McpEnv['who']): McpTool[] => MCP_TOOLS.filter((t) => t.roles === null || who.isAdmin || t.roles.some((r) => who.roles.includes(r)));

/** What an assistant is told of a tool (tools/list). */
export const describeTool = (t: McpTool) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: { title: t.title, ...READ_ONLY },
  _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['read'] }] },
});

/** Runs a tool: what was sent is checked, then the tool reads as the person. Errors the person can read are AppErrors. */
export async function runTool(t: McpTool, args: unknown, env: McpEnv): Promise<unknown> {
  if (t.roles !== null && !env.who.isAdmin && !t.roles.some((r) => env.who.roles.includes(r))) throw new AppError('forbidden', 'Accès refusé : votre rôle dans Pilotix ne donne pas accès à cela');
  if (!env.scope.includes('read')) throw new AppError('forbidden', 'Accès refusé : ce lien ne permet pas de lire');
  const parsed = t.input.safeParse(args ?? {});
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw bad(`Invalid arguments for ${t.name}: ${i.path.join('.') || 'input'} (${i.message})`);
  }
  return t.run(env, parsed.data);
}

// ---------------------------------------------------------------- what the log keeps of a call
/** A phone number as the log shows it: its first four digits and its last two (« 0550 •• •• 56 »). */
export const cutPhone = (v: unknown): string | undefined => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 8 ? `${d.slice(0, 4)} •• •• ${d.slice(-2)}` : undefined;
};

/**
 * What the person's log keeps of one call (Mon profil › Assistants IA › Journal): a few short facts the page turns into
 * a sentence — what was searched (cut short), the period, how many lines came back, a phone number cut — never the
 * answer itself. What the assistant sent is read as it came (it may be wrong): only well-formed facts are kept.
 */
export function callDetail(name: string, args: unknown, result: unknown): Record<string, unknown> {
  const a = (args && typeof args === 'object' && !Array.isArray(args) ? args : {}) as Record<string, unknown>;
  const r = (result && typeof result === 'object' && !Array.isArray(result) ? result : {}) as Record<string, any>;
  const d: Record<string, unknown> = {};
  const word = (v: unknown, max = 60) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
  const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 6).map((x) => x.slice(0, 30)) : undefined);
  const put = (k: string, v: unknown) => {
    if (v !== undefined && !(Array.isArray(v) && !v.length)) d[k] = v;
  };
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Array.isArray(v) ? v.length : undefined);
  switch (name) {
    case 'search_orders':
      put('q', word(a.q));
      put('confirmation', list(a.confirmation));
      put('delivery', list(a.delivery));
      put('wilaya', typeof a.wilaya === 'number' ? a.wilaya : undefined);
      put('from', day(a.from));
      put('to', day(a.to));
      put('count', count(r.total));
      break;
    case 'get_order':
      put('ref', word(r.ref, 40) ?? word(a.ref, 40) ?? (typeof a.id === 'number' ? `#${a.id}` : undefined));
      break;
    case 'stats_overview':
    case 'shop_dashboard':
    case 'agent_stats':
      put('from', day(a.from));
      put('to', day(a.to));
      break;
    case 'search_products':
      put('q', word(a.q));
      put('count', count(r.products));
      break;
    case 'stock_levels':
      put('q', word(a.q));
      if (a.low_only === true) d.low = true;
      put('count', count(r.lines));
      break;
    case 'delivery_follow_up':
      put('list', word(a.list, 30));
      put('q', word(a.q));
      put('count', count(r.total));
      break;
    case 'delivery_companies':
      put('count', count(r.companies));
      break;
    case 'customer_history':
      put('phone', cutPhone(a.phone));
      put('count', count(r.orders));
      break;
  }
  return d;
}
