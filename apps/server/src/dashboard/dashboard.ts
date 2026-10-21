import { Controller, Get, Module, Query } from '@nestjs/common';
import { DashboardStats, OrderStatus } from '@pilotix/shared';
import { z } from 'zod';
import { Public, Roles } from '../auth/auth';
import { ZodPipe } from '../common/zod';
import { DbService } from '../db/db.service';

const Range = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

@Controller()
export class DashboardController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Get('health')
  async health() {
    await this.db.query('SELECT 1');
    return { ok: true, time: new Date().toISOString() };
  }

  @Get('dashboard')
  @Roles('manager', 'confirmation', 'suivi', 'depot')
  async stats(@Query(new ZodPipe(Range)) r: z.infer<typeof Range>): Promise<DashboardStats> {
    const from = r.from ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
    const to = r.to ?? new Date(Date.now() + 86_400_000).toISOString();

    // "Today" in Algeria (UTC+1).
    const today = await this.db.one(
      `SELECT
         count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Algiers') AT TIME ZONE 'Africa/Algiers')::int AS created,
         count(*) FILTER (WHERE e_conf)::int AS confirmed,
         count(*) FILTER (WHERE e_del)::int AS delivered,
         count(*) FILTER (WHERE e_ret)::int AS returned
       FROM (
         SELECT o.created_at,
           EXISTS (SELECT 1 FROM order_events e WHERE e.order_id=o.id AND e.to_value='confirmed' AND e.created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Algiers') AT TIME ZONE 'Africa/Algiers') AS e_conf,
           EXISTS (SELECT 1 FROM order_events e WHERE e.order_id=o.id AND e.to_value='delivered' AND e.created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Algiers') AT TIME ZONE 'Africa/Algiers') AS e_del,
           EXISTS (SELECT 1 FROM order_events e WHERE e.order_id=o.id AND e.to_value='returned' AND e.created_at >= date_trunc('day', now() AT TIME ZONE 'Africa/Algiers') AT TIME ZONE 'Africa/Algiers') AS e_ret
         FROM orders o WHERE o.updated_at >= now() - interval '2 days'
       ) t`,
    );

    const rows = await this.db.query<{ status: OrderStatus; n: number; amount: number }>(
      `SELECT status, count(*)::int AS n, COALESCE(sum(total),0)::bigint AS amount
       FROM orders WHERE created_at >= $1 AND created_at < $2 GROUP BY status`,
      [from, to],
    );
    const byStatus: Partial<Record<OrderStatus, number>> = {};
    let total = 0;
    for (const r of rows) {
      byStatus[r.status] = r.n;
      total += r.n;
    }
    const n = (s: OrderStatus) => byStatus[s] ?? 0;
    const decided = n('confirmed') + n('assigned') + n('shipped') + n('delivered') + n('returning') + n('returned') + n('cancelled');
    const confirmedish = decided - n('cancelled');
    const finished = n('delivered') + n('returned');

    return {
      today: today ?? { created: 0, confirmed: 0, delivered: 0, returned: 0 },
      byStatus,
      confirmationRate: decided ? confirmedish / decided : 0,
      deliveryRate: finished ? n('delivered') / finished : 0,
      revenueDelivered: Number(rows.find((r) => r.status === 'delivered')?.amount ?? 0),
    };
  }
}

@Module({ controllers: [DashboardController] })
export class DashboardModule {}
