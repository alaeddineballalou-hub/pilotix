import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { canSetStatus, normalizePhone, OfflineAction, OPEN_STATUSES, Order, OrderEvent, OrderItem, OrderStatus, Page } from '@pilotix/shared';
import { PoolClient } from 'pg';
import { AuthUser } from '../auth/auth';
import { DbService } from '../db/db.service';
import { JobsService } from '../jobs/jobs.service';
import { LiveGateway } from '../live/live.gateway';

export interface OrderFilters {
  status?: OrderStatus[];
  q?: string;
  wilaya?: number;
  agentId?: number;
  livreurId?: number;
  from?: string;
  to?: string;
  callbackDue?: boolean;
  page: number;
  pageSize: number;
  sort: 'created_desc' | 'created_asc' | 'callback_asc' | 'total_desc';
}

export type NewItem = Omit<OrderItem, 'unitPrice'> & { unitPrice?: number };

export interface NewOrder {
  customerName: string;
  phone: string;
  wilaya: number;
  commune: string;
  address: string;
  items: NewItem[];
  deliveryFee: number;
  discount: number;
  note?: string | null;
}

export interface StatusChange {
  status: OrderStatus;
  note?: string | null;
  callbackAt?: string | null;
  livreurId?: number | null;
  tracking?: string | null;
  clientId?: string;
}

const SELECT = `
  o.id, o.reference, o.created_at, o.updated_at, o.status, o.customer_name, o.phone, o.wilaya, o.commune, o.address,
  o.items, o.delivery_fee, o.discount, o.total, o.note, o.agent_id, o.livreur_id, o.callback_at, o.tracking, o.attempts, o.version,
  c.delivered AS c_delivered, c.returned AS c_returned`;

function toOrder(r: any): Order {
  return {
    id: Number(r.id),
    reference: r.reference,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    status: r.status,
    customerName: r.customer_name,
    phone: r.phone,
    wilaya: Number(r.wilaya),
    commune: r.commune,
    address: r.address,
    items: r.items || [],
    deliveryFee: r.delivery_fee,
    discount: r.discount,
    total: r.total,
    note: r.note,
    agentId: r.agent_id === null ? null : Number(r.agent_id),
    livreurId: r.livreur_id === null ? null : Number(r.livreur_id),
    callbackAt: r.callback_at ? new Date(r.callback_at).toISOString() : null,
    tracking: r.tracking,
    attempts: r.attempts,
    version: r.version,
    possibleDuplicate: r.possible_duplicate ?? undefined,
    customerDelivered: r.c_delivered ?? undefined,
    customerReturned: r.c_returned ?? undefined,
  };
}

const isStaffOnlyOwn = (u: AuthUser) => u.roles.length === 1 && u.roles[0] === 'livreur';

@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DbService,
    private readonly live: LiveGateway,
    private readonly jobs: JobsService,
  ) {}

  async list(f: OrderFilters, user: AuthUser): Promise<Page<Order>> {
    const where: string[] = [];
    const p: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      p.push(v);
      where.push(sql.replace('?', `$${p.length}`));
    };

    if (isStaffOnlyOwn(user)) add('o.livreur_id = ?', user.id);
    if (f.status?.length) add('o.status = ANY(?)', f.status);
    if (f.wilaya) add('o.wilaya = ?', f.wilaya);
    if (f.agentId) add('o.agent_id = ?', f.agentId);
    if (f.livreurId) add('o.livreur_id = ?', f.livreurId);
    if (f.from) add('o.created_at >= ?', f.from);
    if (f.to) add('o.created_at < ?', f.to);
    if (f.callbackDue) where.push(`o.callback_at IS NOT NULL AND o.callback_at <= now() AND o.status IN ('callback','postponed','no_answer')`);
    if (f.q) {
      const q = f.q.trim();
      const digits = q.replace(/\D/g, '');
      const phone = normalizePhone(q);
      if (phone) add('o.phone = ?', phone);
      else if (digits.length >= 4 && digits.length === q.replace(/[\s+-]/g, '').length) add('o.phone LIKE ?', `%${digits.slice(-8)}%`);
      else {
        p.push(q);
        const n = p.length;
        where.push(`(o.reference = $${n} OR o.tracking = $${n} OR o.customer_name % $${n} OR o.customer_name ILIKE '%' || $${n} || '%')`);
      }
    }

    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = {
      created_desc: 'o.created_at DESC',
      created_asc: 'o.created_at ASC',
      callback_asc: 'o.callback_at ASC NULLS LAST',
      total_desc: 'o.total DESC',
    }[f.sort];

    const totalRow = await this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM orders o ${w}`, p);
    p.push(f.pageSize, (f.page - 1) * f.pageSize);
    const rows = await this.db.query(
      `SELECT ${SELECT},
         EXISTS (SELECT 1 FROM orders d WHERE d.phone = o.phone AND d.id <> o.id AND d.status = ANY('{${OPEN_STATUSES.join(',')}}'::text[])
                 AND d.created_at > now() - interval '15 days') AS possible_duplicate
       FROM orders o JOIN customers c ON c.id = o.customer_id
       ${w} ORDER BY ${order} LIMIT $${p.length - 1} OFFSET $${p.length}`,
      p,
    );
    return { rows: rows.map(toOrder), total: totalRow?.n ?? 0, page: f.page, pageSize: f.pageSize };
  }

  async get(id: number, user: AuthUser, client?: Pick<PoolClient, 'query'>): Promise<Order> {
    const q = client ?? this.db.pool;
    const { rows } = await q.query(`SELECT ${SELECT} FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('Order not found');
    const o = toOrder(rows[0]);
    if (isStaffOnlyOwn(user) && o.livreurId !== user.id) throw new ForbiddenException();
    return o;
  }

  async events(id: number, user: AuthUser): Promise<OrderEvent[]> {
    await this.get(id, user);
    const rows = await this.db.query(
      `SELECT e.*, u.name AS user_name FROM order_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.order_id = $1 ORDER BY e.created_at`,
      [id],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      orderId: Number(r.order_id),
      userId: r.user_id === null ? null : Number(r.user_id),
      userName: r.user_name,
      type: r.type,
      fromValue: r.from_value,
      toValue: r.to_value,
      note: r.note,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  private async priceItems(client: PoolClient, items: NewItem[]): Promise<OrderItem[]> {
    const ids = [...new Set(items.map((i) => i.productId))];
    const { rows } = await client.query('SELECT id, price, active FROM products WHERE id = ANY($1)', [ids]);
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    return items.map((i) => {
      const prod = byId.get(i.productId);
      if (!prod || !prod.active) throw new BadRequestException(`Unknown product ${i.productId}`);
      return { productId: i.productId, variant: i.variant ?? null, quantity: i.quantity, unitPrice: i.unitPrice ?? prod.price };
    });
  }

  async create(input: NewOrder, user: AuthUser): Promise<Order> {
    const phone = normalizePhone(input.phone);
    if (!phone) throw new BadRequestException('Invalid Algerian phone number');

    const order = await this.db.tx(async (client) => {
      const items = await this.priceItems(client, input.items);
      const subtotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
      const discount = Math.min(input.discount, subtotal);
      const total = subtotal - discount + input.deliveryFee;

      const cust = await client.query(
        `INSERT INTO customers (phone, name, orders) VALUES ($1, $2, 1)
         ON CONFLICT (phone) DO UPDATE SET orders = customers.orders + 1, name = EXCLUDED.name
         RETURNING id, blocked`,
        [phone, input.customerName],
      );
      if (cust.rows[0].blocked) throw new BadRequestException('This customer is blocked');

      const ref = await client.query(`SELECT 'PX-' || nextval('order_reference_seq') AS r`);
      const ins = await client.query(
        `INSERT INTO orders (reference, customer_id, customer_name, phone, wilaya, commune, address, items, delivery_fee, discount, total, note, agent_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [ref.rows[0].r, cust.rows[0].id, input.customerName, phone, input.wilaya, input.commune, input.address, JSON.stringify(items),
          input.deliveryFee, discount, total, input.note ?? null, null],
      );
      const id = Number(ins.rows[0].id);
      await client.query(`INSERT INTO order_events (order_id, user_id, type, to_value) VALUES ($1,$2,'created','new')`, [id, user.id]);
      return this.get(id, user, client);
    });

    this.live.emit({ type: 'order.created', order });
    return order;
  }

  async update(id: number, patch: Partial<NewOrder> & { version: number }, user: AuthUser): Promise<Order> {
    const order = await this.db.tx(async (client) => {
      const cur = await this.get(id, user, client);
      if (cur.version !== patch.version) throw new ConflictException('This order was changed by someone else. Reload it.');
      if (!OPEN_STATUSES.includes(cur.status) || cur.status === 'assigned') {
        throw new BadRequestException('Only orders not yet handed to delivery can be edited');
      }
      const phone = patch.phone !== undefined ? normalizePhone(patch.phone) : cur.phone;
      if (!phone) throw new BadRequestException('Invalid Algerian phone number');
      const items = patch.items ? await this.priceItems(client, patch.items) : cur.items;
      const fee = patch.deliveryFee ?? cur.deliveryFee;
      const subtotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
      const discount = Math.min(patch.discount ?? cur.discount, subtotal);

      await client.query(
        `UPDATE orders SET customer_name=$2, phone=$3, wilaya=$4, commune=$5, address=$6, items=$7, delivery_fee=$8, discount=$9, total=$10,
           note=$11, updated_at=now(), version=version+1 WHERE id=$1`,
        [id, patch.customerName ?? cur.customerName, phone, patch.wilaya ?? cur.wilaya, patch.commune ?? cur.commune, patch.address ?? cur.address,
          JSON.stringify(items), fee, discount, subtotal - discount + fee, patch.note !== undefined ? patch.note : cur.note],
      );
      await client.query(`INSERT INTO order_events (order_id, user_id, type) VALUES ($1,$2,'edit')`, [id, user.id]);
      return this.get(id, user, client);
    });
    this.live.emit({ type: 'order.updated', order });
    return order;
  }

  async setStatus(id: number, change: StatusChange, user: AuthUser): Promise<Order> {
    const order = await this.db.tx(async (client) => {
      if (change.clientId) {
        const seen = await client.query(
          'INSERT INTO applied_actions (client_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING client_id',
          [change.clientId, user.id],
        );
        if (!seen.rows.length) return this.get(id, user, client); // already applied: retry is harmless
      }
      const lock = await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [id]);
      if (!lock.rows[0]) throw new NotFoundException('Order not found');
      const cur = await this.get(id, user, client);
      const to = change.status;
      // canSetStatus checks both the allowed flow and the roles allowed to set "to".
      if (!canSetStatus(['admin'], cur.status, to)) {
        throw new BadRequestException(`An order cannot go from "${cur.status}" to "${to}"`);
      }
      const boss = user.roles.includes('admin') || user.roles.includes('manager');
      if (!boss && !canSetStatus(user.roles, cur.status, to)) {
        throw new ForbiddenException(`You cannot move an order to "${to}"`);
      }
      if (to === 'assigned' && !change.livreurId) throw new BadRequestException('Choose a livreur');

      const isConfirmStep = ['confirmed', 'callback', 'no_answer', 'postponed', 'cancelled', 'duplicate'].includes(to);
      await client.query(
        `UPDATE orders SET status=$2, updated_at=now(), version=version+1,
           callback_at = CASE WHEN $2 IN ('callback','postponed','no_answer') THEN $3::timestamptz ELSE NULL END,
           livreur_id = COALESCE($4, livreur_id),
           tracking = COALESCE($5, tracking),
           agent_id = CASE WHEN $6 THEN COALESCE(agent_id, $7) ELSE agent_id END,
           attempts = attempts + CASE WHEN $2 = 'no_answer' THEN 1 ELSE 0 END
         WHERE id=$1`,
        [id, to, change.callbackAt ?? null, change.livreurId ?? null, change.tracking ?? null, isConfirmStep, user.id],
      );
      await client.query(
        `INSERT INTO order_events (order_id, user_id, type, from_value, to_value, note) VALUES ($1,$2,'status',$3,$4,$5)`,
        [id, user.id, cur.status, to, change.note ?? null],
      );

      // Stock leaves the depot when shipped, and comes back when returned.
      if (to === 'shipped' || to === 'returned') {
        const sign = to === 'shipped' ? -1 : 1;
        for (const it of cur.items) {
          await client.query('UPDATE products SET stock = stock + $2 WHERE id = $1', [it.productId, sign * it.quantity]);
          await client.query(
            'INSERT INTO stock_movements (product_id, variant, delta, reason, order_id, user_id) VALUES ($1,$2,$3,$4,$5,$6)',
            [it.productId, it.variant ?? null, sign * it.quantity, to, id, user.id],
          );
        }
      }
      if (to === 'delivered') await client.query('UPDATE customers SET delivered = delivered + 1 WHERE phone = $1', [cur.phone]);
      if (to === 'returned') await client.query('UPDATE customers SET returned = returned + 1 WHERE phone = $1', [cur.phone]);
      return this.get(id, user, client);
    });

    this.live.emit({ type: 'order.updated', order });
    if (order.status === 'confirmed' || order.status === 'shipped' || order.status === 'delivered') {
      const template = order.status === 'confirmed' ? 'order_confirmed' : order.status === 'shipped' ? 'order_shipped' : 'order_delivered';
      await this.jobs.notify({ orderId: order.id, phone: order.phone, template, language: 'fr' });
    }
    return order;
  }

  async addNote(id: number, note: string, kind: 'call' | 'note', user: AuthUser, clientId?: string) {
    await this.db.tx(async (client) => {
      if (clientId) {
        const seen = await client.query(
          'INSERT INTO applied_actions (client_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING client_id',
          [clientId, user.id],
        );
        if (!seen.rows.length) return;
      }
      await this.get(id, user, client);
      await client.query(`INSERT INTO order_events (order_id, user_id, type, note) VALUES ($1,$2,$3,$4)`, [id, user.id, kind, note || null]);
    });
    return { ok: true };
  }

  /** Replays actions made offline, in order. Each one succeeds or reports its own error. */
  async sync(actions: OfflineAction[], user: AuthUser) {
    const results: { clientId: string; ok: boolean; error?: string; order?: Order }[] = [];
    for (const a of actions) {
      try {
        if (a.kind === 'status' && a.status) {
          const order = await this.setStatus(a.orderId, { status: a.status, note: a.note, callbackAt: a.callbackAt, clientId: a.clientId }, user);
          results.push({ clientId: a.clientId, ok: true, order });
        } else {
          await this.addNote(a.orderId, a.note || '', a.kind === 'call' ? 'call' : 'note', user, a.clientId);
          results.push({ clientId: a.clientId, ok: true });
        }
      } catch (e: any) {
        results.push({ clientId: a.clientId, ok: false, error: e?.message || 'Failed' });
      }
    }
    return { results };
  }
}
