// Co-Pilot of a confirmation agency (its own space). The agency's orders stay in each seller's store (conf_agency_id: the
// agency confirms them; follow_agency_id: it follows their parcels), so its Co-Pilot reads them there, store by store
// (the seller chosen at the top of the page: his only), with the same checks and limits as a store's Co-Pilot.
// Each person sees the part that is theirs:
//   - the chief (administrators): the whole agency — orders not called, late callbacks, the confirmation rate, agents
//     far below the team, orders given to nobody, parcels stuck, alerts not handled, returns, and the agents' pay
//     (no plan, a payment not received);
//   - an agent manager: the team's calls and parcels (no pay, no assignment: the chief's);
//   - a confirmation agent: his own orders (not called, late callbacks, his rate, him next to the team);
//   - a suivi agent: his own parcels (stuck, alerts, his delivery rate).
import { CONF_DONE_BAD, CONF_TODO, DoctorItem, DoctorLine, doctorScore, doctorSort, FOLLOW_ON_ROAD, ShopDoctorReport } from '@pilotix/shared';
import { iso, num } from '../db';
import { Ctx } from '../rpc';
import { accountsIn, storesInView, team } from './agencystats';
import { payAlerts, paySpace } from './pay';

const H = 3_600_000;
const D = 24 * H;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const pts = (x: number) => Math.round(x * 1000) / 10; // 0.123 → 12.3
const OK = ['confirmed', 'no_stock'];
const DONE = ['delivered', 'exchanged'];
const BACK = ['returning', 'returned'];

export async function agencyDoctor(ctx: Ctx): Promise<ShopDoctorReport> {
  const s = ctx.session;
  const now = ctx.now();
  const agencyId = ctx.shop!.id;
  const chief = s.isAdmin;
  const lead = chief || s.roles.includes('agent_manager');
  const conf = lead || s.roles.includes('confirmation');
  const follow = lead || s.roles.includes('suivi');
  const me = Number(s.profile.id);
  const at = (ms: number) => new Date(now - ms).toISOString();
  const people = await team(ctx, now);
  const names = new Map(people.map((p) => [p.id, p.name]));

  // the agency's orders, added up over the stores in view
  let notCalled = 0;
  let oldest: number | null = null;
  let late = 0;
  let unassigned = 0;
  let stuck = 0;
  let alerts = 0;
  // confirmation: the last 7 days and the 7 before (this person's orders, or the team's), each agent's last 7 days
  const rate = { now: { ok: 0, all: 0 }, before: { ok: 0, all: 0 } };
  const teamWeek = { ok: 0, all: 0 };
  const byAgent = new Map<number, { ok: number; all: number }>();
  // delivery: the last 14 days and the 14 before
  const deliv = { now: { d: 0, all: 0 }, before: { d: 0, all: 0 } };

  for (const st of await storesInView(ctx)) {
    const db = ctx.t!.shop(st.schema);
    try {
      const acc = await accountsIn(db, agencyId, people);
      // an agent: his accounts in this store (none: nothing of his here, the team's numbers still count)
      const who = lead ? null : [...acc.entries()].filter(([, a]) => a.person === me).map(([sid]) => sid);
      const r = (
        await db.query(
          `SELECT
             count(*) FILTER (WHERE conf_agency_id = $1 AND conf_status IN ('new','to_check') AND attempts = 0 AND created_at < $2 AND created_at > $3 AND ($8::bigint[] IS NULL OR agent_id = ANY($8)))::int AS not_called,
             min(created_at) FILTER (WHERE conf_agency_id = $1 AND conf_status IN ('new','to_check') AND attempts = 0 AND created_at < $2 AND created_at > $3 AND ($8::bigint[] IS NULL OR agent_id = ANY($8))) AS oldest,
             count(*) FILTER (WHERE conf_agency_id = $1 AND conf_status = ANY($4) AND next_call_at IS NOT NULL AND next_call_at < $5 AND created_at > $3 AND ($8::bigint[] IS NULL OR agent_id = ANY($8)))::int AS late,
             count(*) FILTER (WHERE conf_agency_id = $1 AND conf_status = ANY($4) AND agent_id IS NULL AND created_at > $3)::int AS unassigned,
             count(*) FILTER (WHERE follow_agency_id = $1 AND follow_status = ANY($6) AND shipped_at < $7 AND COALESCE(ext_status_at, shipped_at) < $9 AND ($8::bigint[] IS NULL OR follow_agent_id = ANY($8)))::int AS stuck,
             count(*) FILTER (WHERE follow_agency_id = $1 AND follow_status = 'alert' AND COALESCE(sub_status, '') <> 'alert_traitee' AND ($8::bigint[] IS NULL OR follow_agent_id = ANY($8)))::int AS alerts
           FROM sales WHERE conf_agency_id = $1 OR follow_agency_id = $1`,
          [agencyId, at(2 * H), at(30 * D), CONF_TODO, at(H), FOLLOW_ON_ROAD, at(8 * D), who, at(3 * D)],
        )
      )[0];
      notCalled += num(r?.not_called);
      if (r?.oldest) oldest = Math.min(oldest ?? Infinity, Date.parse(iso(r.oldest)));
      late += num(r?.late);
      unassigned += num(r?.unassigned);
      stuck += num(r?.stuck);
      alerts += num(r?.alerts);

      // confirmation, agent by agent (decided orders only), over 14 days
      const ag = !conf ? [] : await db.query(
        `SELECT agent_id,
                count(*) FILTER (WHERE created_at >= $2 AND conf_status = ANY($4))::int AS ok1,
                count(*) FILTER (WHERE created_at >= $2 AND conf_status = ANY($5))::int AS ko1,
                count(*) FILTER (WHERE created_at < $2 AND conf_status = ANY($4))::int AS ok0,
                count(*) FILTER (WHERE created_at < $2 AND conf_status = ANY($5))::int AS ko0
           FROM sales WHERE conf_agency_id = $1 AND created_at >= $3 GROUP BY agent_id`,
        [agencyId, at(7 * D), at(14 * D), OK, CONF_DONE_BAD],
      );
      for (const a of ag as any[]) {
        const sid = a.agent_id === null || a.agent_id === undefined ? null : num(a.agent_id);
        const ok1 = num(a.ok1);
        const all1 = ok1 + num(a.ko1);
        teamWeek.ok += ok1;
        teamWeek.all += all1;
        const person = sid === null ? null : acc.get(sid)?.person ?? null;
        if (person !== null) {
          const x = byAgent.get(person) ?? { ok: 0, all: 0 };
          x.ok += ok1;
          x.all += all1;
          byAgent.set(person, x);
        }
        // the rate this person looks at: his own orders (an agent), or the team's
        if (who && (sid === null || !who.includes(sid))) continue;
        rate.now.ok += ok1;
        rate.now.all += all1;
        rate.before.ok += num(a.ok0);
        rate.before.all += num(a.ok0) + num(a.ko0);
      }

      // delivery: the leads the agency's parcels (confirmed or followed by it), a suivi agent the parcels he follows
      if (follow) {
        const dr = (
          await db.query(
            `SELECT
               count(*) FILTER (WHERE follow_status = ANY($5) AND delivered_at >= $2 AND delivered_at < $4)::int AS d1,
               count(*) FILTER (WHERE follow_status = ANY($6) AND COALESCE(returning_at, returned_at, updated_at) >= $2 AND COALESCE(returning_at, returned_at, updated_at) < $4)::int AS r1,
               count(*) FILTER (WHERE follow_status = ANY($5) AND delivered_at >= $3 AND delivered_at < $2)::int AS d0,
               count(*) FILTER (WHERE follow_status = ANY($6) AND COALESCE(returning_at, returned_at, updated_at) >= $3 AND COALESCE(returning_at, returned_at, updated_at) < $2)::int AS r0
             FROM sales
            WHERE ${lead ? '(conf_agency_id = $1 OR follow_agency_id = $1)' : 'follow_agency_id = $1 AND follow_agent_id = ANY($7)'}`,
            lead ? [agencyId, at(14 * D), at(28 * D), at(0), DONE, BACK] : [agencyId, at(14 * D), at(28 * D), at(0), DONE, BACK, who],
          )
        )[0];
        deliv.now.d += num(dr?.d1);
        deliv.now.all += num(dr?.d1) + num(dr?.r1);
        deliv.before.d += num(dr?.d0);
        deliv.before.all += num(dr?.d0) + num(dr?.r0);
      }
    } catch {
      // a store being moved or repaired: looked at next time
    }
  }

  const items: DoctorItem[] = [];
  // ------------------------------------------------------------ confirmation
  if (conf) {
    const hours = oldest === null ? 0 : Math.floor((now - oldest) / H);
    items.push(
      notCalled
        ? { id: 'notCalled', level: notCalled >= 20 || hours >= 24 ? 'bad' : 'warn', area: 'confirmation', params: { count: notCalled, hours }, href: '#/confirmation/nouvelles' }
        : { id: 'notCalled', level: 'ok', area: 'confirmation', href: '#/confirmation/nouvelles' },
    );
    items.push(late ? { id: 'lateCallbacks', level: late >= 30 ? 'bad' : 'warn', area: 'confirmation', params: { count: late }, href: '#/confirmation/attente' } : { id: 'lateCallbacks', level: 'ok', area: 'confirmation', href: '#/confirmation/attente' });
    // the rate of the last 7 days next to the 7 before (at least 20 orders decided in each)
    const r1 = ratio(rate.now.ok, rate.now.all);
    const r0 = ratio(rate.before.ok, rate.before.all);
    if (r1 === null || r0 === null || rate.now.all < 20 || rate.before.all < 20) items.push({ id: 'confRate', level: 'info', area: 'confirmation', href: '#/dashboard' });
    else {
      const drop = r0 - r1;
      items.push({ id: drop >= 0.05 ? 'confRateDrop' : 'confRate', level: drop >= 0.15 ? 'bad' : drop >= 0.05 ? 'warn' : 'ok', area: 'confirmation', params: { now: pts(r1), before: pts(r0), drop: pts(Math.max(drop, 0)) }, href: '#/dashboard' });
    }
  }
  const teamRate = ratio(teamWeek.ok, teamWeek.all);
  if (lead && conf) {
    // agents far below the team (7 days, at least 20 orders decided)
    const weak: DoctorLine[] =
      teamRate === null
        ? []
        : [...byAgent.entries()]
            .filter(([, x]) => x.all >= 20)
            .map(([id, x]) => ({ label: names.get(id) ?? '', n: pts(x.ok / x.all), unit: 'pct' as const }))
            .filter((x) => x.n <= pts(teamRate) - 12)
            .sort((a, b) => a.n - b.n);
    items.push(
      weak.length
        ? { id: 'weakAgents', level: 'warn', area: 'team', params: { count: weak.length, team: pts(teamRate!) }, list: weak.slice(0, 5), href: '#/dashboard' }
        : { id: 'weakAgents', level: teamRate === null ? 'info' : 'ok', area: 'team', params: { team: teamRate === null ? 0 : pts(teamRate) }, href: '#/dashboard' },
    );
  }
  if (!lead && s.roles.includes('confirmation')) {
    // an agent: his own rate next to the team's (7 days, at least 20 orders decided)
    const mine = ratio(rate.now.ok, rate.now.all);
    if (mine === null || teamRate === null || rate.now.all < 20) items.push({ id: 'meVsTeam', level: 'info', area: 'team', params: { me: mine === null ? 0 : pts(mine), team: teamRate === null ? 0 : pts(teamRate) }, href: '#/confirmation' });
    else {
      const gap = teamRate - mine;
      items.push({ id: 'meVsTeam', level: gap >= 0.2 ? 'bad' : gap >= 0.1 ? 'warn' : 'ok', area: 'team', params: { me: pts(mine), team: pts(teamRate), gap: pts(Math.max(gap, 0)) }, href: '#/confirmation' });
    }
  }
  // the chief: orders nobody was given (nobody calls them)
  if (chief)
    items.push(
      unassigned
        ? { id: 'agUnassigned', level: unassigned >= 20 ? 'bad' : 'warn', area: 'team', params: { count: unassigned }, href: '#/equipe/repartition' }
        : { id: 'agUnassigned', level: 'ok', area: 'team', href: '#/equipe/repartition' },
    );

  // ------------------------------------------------------------ delivery
  if (follow) {
    items.push(stuck ? { id: 'stuckParcels', level: stuck >= 20 ? 'bad' : 'warn', area: 'delivery', params: { count: stuck }, href: '#/suivi/enlivraison' } : { id: 'stuckParcels', level: 'ok', area: 'delivery', href: '#/suivi/enlivraison' });
    items.push(alerts ? { id: 'openAlerts', level: alerts >= 15 ? 'bad' : 'warn', area: 'delivery', params: { count: alerts }, href: '#/suivi/alertes_new' } : { id: 'openAlerts', level: 'ok', area: 'delivery', href: '#/suivi/alertes_new' });
    // delivery rate: the last 14 days next to the 14 before (delivered ÷ delivered + back)
    const e1 = ratio(deliv.now.d, deliv.now.all);
    const e0 = ratio(deliv.before.d, deliv.before.all);
    if (e1 === null || deliv.now.all < 20) items.push({ id: 'returns', level: 'info', area: 'delivery', href: '#/dashboard' });
    else {
      const drop = e0 === null || deliv.before.all < 20 ? 0 : e0 - e1;
      const level = e1 < 0.55 || drop >= 0.12 ? 'bad' : e1 < 0.7 || drop >= 0.05 ? 'warn' : 'ok';
      items.push({ id: level === 'ok' ? 'returns' : 'returnsUp', level, area: 'delivery', params: { now: pts(e1), before: e0 === null ? pts(e1) : pts(e0), back: pts(1 - e1) }, href: '#/dashboard' });
    }
  }

  // ------------------------------------------------------------ the agents' pay (the chief: it is about money)
  if (chief) {
    paySpace(ctx);
    const pa = await payAlerts(ctx.db, now);
    items.push(
      pa.noPlan.length
        ? { id: 'agPayNoPlan', level: 'bad', area: 'cash', params: { count: pa.noPlan.length }, list: pa.noPlan.slice(0, 6).map((x) => ({ label: x.name, n: 0, unit: 'text' as const })), href: '#/equipe/paie' }
        : { id: 'agPayNoPlan', level: 'ok', area: 'cash', href: '#/equipe/paie' },
    );
    items.push(
      pa.notReceived.length
        ? { id: 'agPayNotReceived', level: 'bad', area: 'cash', params: { count: pa.notReceived.length, amount: pa.notReceived.reduce((n, x) => n + x.amount, 0) }, list: pa.notReceived.slice(0, 6).map((x) => ({ label: x.name, n: x.amount, unit: 'da' as const })), href: '#/equipe/paie' }
        : { id: 'agPayNotReceived', level: 'ok', area: 'cash', href: '#/equipe/paie' },
    );
  }

  const sorted = doctorSort(items);
  return { checkedAt: new Date(now).toISOString(), score: doctorScore(sorted), items: sorted, scope: { whole: chief, mine: !lead, agency: true } };
}
