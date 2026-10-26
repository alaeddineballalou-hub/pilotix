// Pilotix Doctor (Dashboard › Pilotix Doctor, admin / vendeur): looks at the shop and warns before a problem grows —
// stock running out, orders nobody called, parcels stuck, returns going up, agents slowing down, cash not collected.
// Each check gives an item (bad / warn / ok); the app writes the sentences (doctor.c.<id>).
import { algiersDayStart, CONF_DONE_BAD, CONF_TODO, DoctorItem, DoctorLine, doctorScore, doctorSort, FOLLOW_ON_ROAD, ShopDoctorReport } from '@pilotix/shared';
import { z } from 'zod';
import { iso, num } from '../db';
import { Ctx, proc } from '../rpc';

const H = 3_600_000;
const D = 24 * H;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const pts = (x: number) => Math.round(x * 1000) / 10; // 0.123 → 12.3

export async function shopDoctor(ctx: Ctx): Promise<ShopDoctorReport> {
  const now = ctx.now();
  const at = (ms: number) => new Date(now - ms).toISOString();
  const q = (sql: string, params: unknown[] = []) => ctx.db.query(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0] ?? {};
  const items: DoctorItem[] = [];
  const money = ctx.session.isAdmin;

  // ------------------------------------------------------------ stock
  // sold per day = quantities of the orders confirmed in the last 7 days; days left = (stock − what confirmed orders still
  // need) ÷ sold per day. Stock leaves the shelves when the parcel is shipped: to_prepare and prepared orders still need it.
  const stock = await q(
    `WITH sold AS (
       SELECT i.variant_id, sum(i.qty)::numeric / 7 AS per_day
         FROM order_items i JOIN sales o ON o.id = i.order_id
        WHERE o.confirmed_at >= $1 AND o.conf_status IN ('confirmed','no_stock') AND i.variant_id IS NOT NULL
        GROUP BY i.variant_id),
     waiting AS (
       SELECT i.variant_id, sum(i.qty)::int AS qty
         FROM order_items i JOIN sales o ON o.id = i.order_id
        WHERE (o.conf_status = 'no_stock' OR (o.conf_status = 'confirmed' AND COALESCE(o.follow_status, 'to_prepare') IN ('to_prepare','prepared')))
          AND i.variant_id IS NOT NULL
        GROUP BY i.variant_id),
     have AS (SELECT variant_id, sum(qty)::int AS qty FROM stock GROUP BY variant_id)
     SELECT v.id, p.name, v.title, COALESCE(h.qty, 0) AS qty, COALESCE(s.per_day, 0) AS per_day, COALESCE(w.qty, 0) AS waiting
       FROM product_variants v JOIN products p ON p.id = v.product_id
       LEFT JOIN have h ON h.variant_id = v.id LEFT JOIN sold s ON s.variant_id = v.id LEFT JOIN waiting w ON w.variant_id = v.id
      WHERE v.active AND p.active AND NOT p.is_service AND (COALESCE(s.per_day, 0) > 0 OR COALESCE(w.qty, 0) > 0)`,
    [at(7 * D)],
  );
  const vname = (r: any) => (r.title ? `${r.name} · ${r.title}` : (r.name as string));
  const out = stock.filter((r: any) => num(r.waiting) > num(r.qty)).map((r: any) => ({ label: vname(r), n: num(r.waiting) - num(r.qty), unit: 'n' as const }));
  out.sort((a, b) => b.n - a.n);
  items.push(
    out.length
      ? { id: 'stockOut', level: 'bad', area: 'stock', params: { count: out.length, orders: out.reduce((s, x) => s + x.n, 0) }, list: out.slice(0, 6), href: '#/produits/stock' }
      : { id: 'stockOut', level: 'ok', area: 'stock', href: '#/produits/stock' },
  );
  const soon: DoctorLine[] = stock
    .filter((r: any) => num(r.per_day) > 0 && num(r.qty) >= num(r.waiting))
    .map((r: any) => ({ label: vname(r), n: Math.max(1, Math.floor((num(r.qty) - num(r.waiting)) / Number(r.per_day))), unit: 'days' as const }))
    .filter((x: DoctorLine) => x.n <= 5)
    .sort((a: DoctorLine, b: DoctorLine) => a.n - b.n);
  items.push(
    soon.length
      ? { id: 'stockSoon', level: soon[0].n <= 2 ? 'bad' : 'warn', area: 'stock', params: { count: soon.length, days: soon[0].n }, list: soon.slice(0, 6), href: '#/produits/achats' }
      : { id: 'stockSoon', level: 'ok', area: 'stock', href: '#/produits/achats' },
  );

  // ------------------------------------------------------------ confirmation
  const nc = await one(
    `SELECT count(*)::int AS n, min(created_at) AS oldest FROM sales WHERE conf_status IN ('new','to_check') AND attempts = 0 AND created_at < $1`,
    [at(2 * H)],
  );
  const ncN = num(nc.n);
  const ncH = nc.oldest ? Math.floor((now - Date.parse(iso(nc.oldest))) / H) : 0;
  items.push(
    ncN
      ? { id: 'notCalled', level: ncN >= 20 || ncH >= 24 ? 'bad' : 'warn', area: 'confirmation', params: { count: ncN, hours: ncH }, href: '#/confirmation/nouvelles' }
      : { id: 'notCalled', level: 'ok', area: 'confirmation', href: '#/confirmation/nouvelles' },
  );
  const cb = num((await one(`SELECT count(*)::int AS n FROM sales WHERE conf_status = ANY($1) AND next_call_at IS NOT NULL AND next_call_at < $2`, [CONF_TODO, at(H)])).n);
  items.push(cb ? { id: 'lateCallbacks', level: cb >= 30 ? 'bad' : 'warn', area: 'confirmation', params: { count: cb }, href: '#/confirmation/attente' } : { id: 'lateCallbacks', level: 'ok', area: 'confirmation', href: '#/confirmation/attente' });

  // confirmation rate: orders received in the last 7 days vs the 7 days before (decided ones only)
  const rate = async (from: string, to: string) => {
    const r = await one(
      `SELECT count(*) FILTER (WHERE conf_status IN ('confirmed','no_stock'))::int AS ok, count(*) FILTER (WHERE conf_status = ANY($3))::int AS ko
         FROM sales WHERE created_at >= $1 AND created_at < $2`,
      [from, to, CONF_DONE_BAD],
    );
    return { ok: num(r.ok), all: num(r.ok) + num(r.ko) };
  };
  const c1 = await rate(at(7 * D), at(0));
  const c0 = await rate(at(14 * D), at(7 * D));
  const r1 = ratio(c1.ok, c1.all);
  const r0 = ratio(c0.ok, c0.all);
  if (r1 === null || r0 === null || c1.all < 20 || c0.all < 20) items.push({ id: 'confRate', level: 'info', area: 'confirmation', href: '#/dashboard/confirmation' });
  else {
    const drop = r0 - r1;
    items.push({ id: drop >= 0.05 ? 'confRateDrop' : 'confRate', level: drop >= 0.15 ? 'bad' : drop >= 0.05 ? 'warn' : 'ok', area: 'confirmation', params: { now: pts(r1), before: pts(r0), drop: pts(Math.max(drop, 0)) }, href: '#/dashboard/confirmation' });
  }

  // fake / wrong numbers: more than 1 order in 7 → bad ads or someone playing
  const fk = await one(`SELECT count(*) FILTER (WHERE conf_status IN ('fake','wrong_number'))::int AS f, count(*)::int AS n FROM sales WHERE created_at >= $1`, [at(7 * D)]);
  const fr = ratio(num(fk.f), num(fk.n));
  items.push(
    fr !== null && num(fk.n) >= 20 && fr >= 0.08
      ? { id: 'fakeOrders', level: fr >= 0.15 ? 'bad' : 'warn', area: 'confirmation', params: { pct: pts(fr), count: num(fk.f) }, href: '#/commandes/tout' }
      : { id: 'fakeOrders', level: 'ok', area: 'confirmation', params: { pct: fr === null ? 0 : pts(fr) } },
  );

  // agents far below the team (7 days, at least 20 orders decided)
  const ag = await q(
    `SELECT o.agent_id AS id, p.name, count(*) FILTER (WHERE o.conf_status IN ('confirmed','no_stock'))::int AS ok, count(*) FILTER (WHERE o.conf_status = ANY($2))::int AS ko
       FROM sales o JOIN profiles p ON p.id = o.agent_id
      WHERE o.created_at >= $1 AND o.agent_id IS NOT NULL GROUP BY o.agent_id, p.name`,
    [at(7 * D), CONF_DONE_BAD],
  );
  const team = ratio(
    ag.reduce((s: number, a: any) => s + num(a.ok), 0),
    ag.reduce((s: number, a: any) => s + num(a.ok) + num(a.ko), 0),
  );
  const weak: DoctorLine[] =
    team === null
      ? []
      : ag
          .filter((a: any) => num(a.ok) + num(a.ko) >= 20)
          .map((a: any) => ({ label: a.name as string, n: pts(num(a.ok) / (num(a.ok) + num(a.ko))), unit: 'pct' as const }))
          .filter((a: DoctorLine) => a.n <= pts(team) - 12)
          .sort((a: DoctorLine, b: DoctorLine) => a.n - b.n);
  items.push(
    weak.length
      ? { id: 'weakAgents', level: 'warn', area: 'team', params: { count: weak.length, team: pts(team!) }, list: weak.slice(0, 5), href: '#/dashboard/confirmation' }
      : { id: 'weakAgents', level: team === null ? 'info' : 'ok', area: 'team', params: { team: team === null ? 0 : pts(team) }, href: '#/dashboard/confirmation' },
  );

  // ------------------------------------------------------------ depot
  const st = await one(`SELECT count(*)::int AS n, min(confirmed_at) AS oldest FROM sales WHERE follow_status IN ('to_prepare','prepared') AND confirmed_at < $1`, [at(2 * D)]);
  const stN = num(st.n);
  items.push(
    stN
      ? { id: 'notShipped', level: stN >= 30 ? 'bad' : 'warn', area: 'depot', params: { count: stN, days: st.oldest ? Math.floor((now - Date.parse(iso(st.oldest))) / D) : 2 }, href: '#/depot/preparer' }
      : { id: 'notShipped', level: 'ok', area: 'depot', href: '#/depot/preparer' },
  );

  // ------------------------------------------------------------ delivery
  const road = num(
    (await one(`SELECT count(*)::int AS n FROM sales WHERE follow_status = ANY($1) AND shipped_at < $2 AND COALESCE(ext_status_at, shipped_at) < $3`, [FOLLOW_ON_ROAD, at(8 * D), at(3 * D)])).n,
  );
  items.push(road ? { id: 'stuckParcels', level: road >= 20 ? 'bad' : 'warn', area: 'delivery', params: { count: road }, href: '#/suivi' } : { id: 'stuckParcels', level: 'ok', area: 'delivery', href: '#/suivi' });

  const al = num((await one(`SELECT count(*)::int AS n FROM sales WHERE follow_status = 'alert' AND COALESCE(sub_status,'') <> 'alert_traitee'`)).n);
  items.push(al ? { id: 'openAlerts', level: al >= 15 ? 'bad' : 'warn', area: 'delivery', params: { count: al }, href: '#/suivi/alertes' } : { id: 'openAlerts', level: 'ok', area: 'delivery', href: '#/suivi/alertes' });

  // delivery rate: last 14 days vs the 14 before (delivered ÷ delivered + returned)
  const dr = async (from: string, to: string) => {
    const r = await one(
      `SELECT count(*) FILTER (WHERE follow_status IN ('delivered','exchanged') AND delivered_at >= $1 AND delivered_at < $2)::int AS d,
              count(*) FILTER (WHERE follow_status IN ('returning','returned') AND COALESCE(returning_at, returned_at, updated_at) >= $1 AND COALESCE(returning_at, returned_at, updated_at) < $2)::int AS r
         FROM sales`,
      [from, to],
    );
    return { d: num(r.d), all: num(r.d) + num(r.r) };
  };
  const d1 = await dr(at(14 * D), at(0));
  const d0 = await dr(at(28 * D), at(14 * D));
  const e1 = ratio(d1.d, d1.all);
  const e0 = ratio(d0.d, d0.all);
  if (e1 === null || d1.all < 20) items.push({ id: 'returns', level: 'info', area: 'delivery', href: '#/dashboard/suivi' });
  else {
    const drop = e0 === null || d0.all < 20 ? 0 : e0 - e1;
    const level = e1 < 0.55 || drop >= 0.12 ? 'bad' : e1 < 0.7 || drop >= 0.05 ? 'warn' : 'ok';
    items.push({ id: level === 'ok' ? 'returns' : 'returnsUp', level, area: 'delivery', params: { now: pts(e1), before: e0 === null ? pts(e1) : pts(e0), back: pts(1 - e1) }, href: '#/dashboard/suivi' });
  }
  // wilayas that send many parcels back (30 days, at least 12 parcels)
  const wl = await q(
    `SELECT wilaya_id AS w,
            count(*) FILTER (WHERE follow_status IN ('delivered','exchanged'))::int AS d,
            count(*) FILTER (WHERE follow_status IN ('returning','returned'))::int AS r
       FROM sales WHERE shipped_at >= $1 AND follow_status IN ('delivered','exchanged','returning','returned') GROUP BY 1`,
    [at(30 * D)],
  );
  const badW: DoctorLine[] = wl
    .filter((x: any) => num(x.d) + num(x.r) >= 12)
    .map((x: any) => ({ label: '', wilaya: num(x.w), n: pts(num(x.r) / (num(x.d) + num(x.r))), unit: 'pct' as const }))
    .filter((x: DoctorLine) => x.n >= 40)
    .sort((a: DoctorLine, b: DoctorLine) => b.n - a.n);
  items.push(
    badW.length
      ? { id: 'badWilayas', level: badW[0].n >= 55 ? 'bad' : 'warn', area: 'delivery', params: { count: badW.length }, list: badW.slice(0, 5), href: '#/dashboard/suivi' }
      : { id: 'badWilayas', level: 'ok', area: 'delivery' },
  );

  // ------------------------------------------------------------ sales
  // yesterday (Algeria day) vs the 7 days before it
  const today0 = algiersDayStart(now);
  const y0 = new Date(today0 - D).toISOString();
  const yN = num((await one(`SELECT count(*)::int AS n FROM sales WHERE created_at >= $1 AND created_at < $2`, [y0, new Date(today0).toISOString()])).n);
  const wkN = num((await one(`SELECT count(*)::int AS n FROM sales WHERE created_at >= $1 AND created_at < $2`, [new Date(today0 - 8 * D).toISOString(), y0])).n);
  const avg = wkN / 7;
  if (avg < 5) items.push({ id: 'ordersDrop', level: 'info', area: 'sales', params: { yesterday: yN, avg: Math.round(avg) } });
  else {
    const fall = 1 - yN / avg;
    items.push({ id: fall >= 0.3 ? 'ordersDrop' : 'ordersOk', level: fall >= 0.5 ? 'bad' : fall >= 0.3 ? 'warn' : 'ok', area: 'sales', params: { yesterday: yN, avg: Math.round(avg), drop: pts(Math.max(fall, 0)) }, href: '#/marketing' });
  }

  // ------------------------------------------------------------ cash
  const cash = await one(`SELECT count(*)::int AS n, COALESCE(sum(total),0)::bigint AS v FROM sales WHERE follow_status = 'delivered' AND NOT cashed AND delivered_at < $1`, [at(10 * D)]);
  const cN = num(cash.n);
  items.push(
    cN
      ? { id: 'cashLate', level: cN >= 50 ? 'bad' : 'warn', area: 'cash', params: money ? { count: cN, amount: num(cash.v) } : { count: cN }, href: '#/caisse/due' }
      : { id: 'cashLate', level: 'ok', area: 'cash', href: '#/caisse/due' },
  );

  const sorted = doctorSort(items);
  return { checkedAt: new Date(now).toISOString(), score: doctorScore(sorted), items: sorted };
}

export const doctorProcs = {
  'stats.doctor': proc(['vendeur'], z.object({}), (ctx) => shopDoctor(ctx)),
};
