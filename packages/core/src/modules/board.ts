// Team boards (Dashboard › Confirmation, Suivi, Dépôt, Livreurs, SAV, and the Accueil): for a period, each member's
// numbers next to the team's and to the period before, day by day, the reasons given, and what is late right now — so a
// manager sees where the team stands, who needs help and on what; and an agent sees their own day next to the team's.
import { CONF_TODO, FOLLOW_ON_ROAD, nextDue } from '@pilotix/shared';
import { z } from 'zod';
import { iso, num } from '../db';
import { Ctx, proc } from '../rpc';
import { getSetting } from '../settings';
import { REASON_SQL } from './orders';
import { AREAS, confirmationStats, needArea, prevOf, Range, seesAll, teamViews, visibleTeams } from './stats';

type Area = (typeof AREAS)[number];
type R = { from: string; to: string };
/** numbers of a member or of the team; `<rate>_n` is how many the rate is out of */
export type V = Record<string, number | null>;
export interface Day {
  d: string;
  /** the day's volume (confirmed, delivered, packed, settled) */
  n: number;
  /** the day's rate: ok out of of */
  ok: number;
  of: number;
}
export interface Reason {
  reason: string;
  n: number;
}

const H = 3_600_000;
const DAY = 24 * H;
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
/** the Algiers day of a timestamp column */
const dayOf = (col: string) => `to_char((${col}) + interval '1 hour', 'YYYY-MM-DD')`;
const CONFIRMED = ['confirmed', 'no_stock'];
const INVALID = ['duplicate', 'wrong_number', 'fake'];
const DONE = ['delivered', 'exchanged'];
const BACK = ['returning', 'returned'];
/** a return the depot can learn from: the wrong product, or one that arrived broken */
const WRONG = /correspond|erreur|mauvais|abîm|abim|cass|défect|defect|wrong|broken/i;

export { prevOf };

/** Every Algiers day of a period, in order. */
function daysOf(r: R): string[] {
  const out: string[] = [];
  const a = Date.parse(r.from);
  const b = Date.parse(r.to);
  for (let t = a; t < b && out.length < 400; t += DAY) out.push(new Date(t + H).toISOString().slice(0, 10));
  const last = new Date(b - 1 + H).toISOString().slice(0, 10);
  if (out[out.length - 1] !== last && out.length < 400) out.push(last);
  return [...new Set(out)];
}

// ---------------------------------------------------------------- what is counted for one member
interface Parts {
  c: Record<string, number>;
  ms: Record<string, number[]>;
  days: Map<string, { n: number; ok: number; of: number }>;
  reasons: Map<string, number>;
}
const parts = (): Parts => ({ c: {}, ms: {}, days: new Map(), reasons: new Map() });
const add = (p: Parts, k: string, n = 1) => void (p.c[k] = (p.c[k] ?? 0) + n);
const push = (p: Parts, k: string, x: number) => void (p.ms[k] ??= []).push(x);
const onDay = (p: Parts, d: string, n: number, ok: number, of: number) => {
  const x = p.days.get(d) ?? { n: 0, ok: 0, of: 0 };
  x.n += n;
  x.ok += ok;
  x.of += of;
  p.days.set(d, x);
};
/** an empty reason is "none given" */
const because = (p: Parts, r: string | null | undefined) => void p.reasons.set(r ?? '', (p.reasons.get(r ?? '') ?? 0) + 1);
function merge(list: Parts[]): Parts {
  const out = parts();
  for (const p of list) {
    for (const [k, n] of Object.entries(p.c)) add(out, k, n);
    for (const [k, xs] of Object.entries(p.ms)) for (const x of xs) push(out, k, x);
    for (const [d, x] of p.days) onDay(out, d, x.n, x.ok, x.of);
    for (const [r, n] of p.reasons) out.reasons.set(r, (out.reasons.get(r) ?? 0) + n);
  }
  return out;
}
const C = (p: Parts, k: string) => p.c[k] ?? 0;
const rate = (v: V, key: string, ok: number, of: number) => {
  v[key] = ratio(ok, of);
  v[`${key}_n`] = of;
};

/** The numbers of an area, from what was counted. */
const FINISH: Record<Area, (p: Parts) => V> = {
  confirmation: (p) => {
    const v: V = { treated: C(p, 'treated'), confirmed: C(p, 'confirmed'), cancelled: C(p, 'cancelled'), invalid: C(p, 'invalid'), calls: C(p, 'calls') };
    rate(v, 'confRate', C(p, 'confirmed'), C(p, 'confirmed') + C(p, 'cancelled'));
    v.callsPerConf = C(p, 'confirmed') ? C(p, 'calls') / C(p, 'confirmed') : null;
    v.delivered = C(p, 'delivered');
    v.returned = C(p, 'returned');
    rate(v, 'deliveryRate', C(p, 'delivered'), C(p, 'delivered') + C(p, 'returned'));
    rate(v, 'firstRate', C(p, 'firstOk'), C(p, 'firstAll'));
    v.firstMs = median(p.ms.firstMs ?? []);
    rate(v, 'triesRate', C(p, 'triesOk'), C(p, 'triesOk') + C(p, 'triesMiss'));
    rate(v, 'upsellRate', C(p, 'upYes'), C(p, 'upN'));
    v.basket = C(p, 'upN') ? Math.round(C(p, 'basket') / C(p, 'upN')) : null;
    v.inProgress = C(p, 'inProgress');
    v.lateCallbacks = C(p, 'lateCallbacks');
    return v;
  },
  suivi: (p) => {
    const v: V = { outcomes: C(p, 'delivered') + C(p, 'returned'), delivered: C(p, 'delivered'), returned: C(p, 'returned'), treated: C(p, 'treated'), calls: C(p, 'calls') };
    rate(v, 'deliveryRate', C(p, 'delivered'), C(p, 'delivered') + C(p, 'returned'));
    v.treatMs = median(p.ms.treatMs ?? []);
    rate(v, 'savedRate', C(p, 'saved'), C(p, 'saved') + C(p, 'lost'));
    v.alertsNow = C(p, 'alertsNow');
    v.alertsOld = C(p, 'alertsOld');
    return v;
  },
  depot: (p) => {
    const v: V = { packed: C(p, 'packed'), shipped: C(p, 'shipped'), returnsIn: C(p, 'returnsIn'), wrong: C(p, 'wrong') };
    v.prepMs = median(p.ms.prepMs ?? []);
    rate(v, 'prep24Rate', C(p, 'prep24'), C(p, 'prepTimed'));
    rate(v, 'wrongRate', C(p, 'wrong'), C(p, 'packed'));
    return v;
  },
  livreurs: (p) => {
    const v: V = { delivered: C(p, 'delivered'), returned: C(p, 'returned'), inHand: C(p, 'inHand'), late: C(p, 'late'), toBring: C(p, 'toBring'), uncashed: C(p, 'uncashed'), uncashedCount: C(p, 'uncashedCount') };
    rate(v, 'deliveryRate', C(p, 'delivered'), C(p, 'delivered') + C(p, 'returned'));
    rate(v, 'lateRate', C(p, 'late'), C(p, 'inHand'));
    return v;
  },
  sav: (p) => {
    const v: V = { settled: C(p, 'settled'), todo: C(p, 'todo'), old48: C(p, 'old48') };
    v.settleMs = median(p.ms.settleMs ?? []);
    rate(v, 'settled48Rate', C(p, 'settled48'), C(p, 'settled'));
    rate(v, 'satRate', C(p, 'satOk'), C(p, 'satAll'));
    return v;
  },
};

/** the reasons given, most frequent first, the rest as one line (none given: "") */
function topReasons(m: Map<string, number>, k = 6): Reason[] {
  const all = [...m.entries()].filter(([r]) => r).sort((a, b) => b[1] - a[1]);
  const out = all.slice(0, k).map(([reason, n]) => ({ reason, n }));
  const rest = all.slice(k).reduce((s, [, n]) => s + n, 0);
  if (rest) out.push({ reason: '…', n: rest });
  const none = m.get('') ?? 0;
  if (none) out.push({ reason: '', n: none });
  return out;
}

// ---------------------------------------------------------------- counting, area by area
type Count = { per: Map<number, Parts>; none: Parts };
const counter = (): Count => ({ per: new Map(), none: parts() });
/** a null id is work that belongs to nobody yet (parcels without a suivi agent, tickets without anyone) */
const of = (x: Count, id: unknown) => {
  if (id === null || id === undefined) return x.none;
  const k = num(id);
  if (!x.per.has(k)) x.per.set(k, parts());
  return x.per.get(k)!;
};

async function countConfirmation(ctx: Ctx, r: R, ids: number[], detail: boolean): Promise<Count> {
  const x = counter();
  if (!ids.length) return x;
  const P = [r.from, r.to, ids];
  // the last status each agent gave each order in the period: what they treated, confirmed, lost
  const dec = await ctx.db.query(
    `SELECT DISTINCT ON (e.order_id, e.user_id) e.order_id AS o, e.user_id AS u, e.to_value AS s, ${dayOf('e.at')} AS d
     FROM order_events e JOIN sales o ON o.id = e.order_id
     WHERE e.kind = 'conf_status' AND e.at >= $1 AND e.at < $2 AND e.user_id = ANY($3)
     ORDER BY e.order_id, e.user_id, e.at DESC`,
    P,
  );
  const cancelledBy = new Map<number, number>();
  for (const e of dec) {
    const p = of(x, e.u);
    add(p, 'treated');
    if (CONFIRMED.includes(e.s)) {
      add(p, 'confirmed');
      onDay(p, e.d, 1, 1, 1);
    } else if (e.s === 'cancelled') {
      add(p, 'cancelled');
      onDay(p, e.d, 0, 0, 1);
      cancelledBy.set(num(e.o), num(e.u));
    } else if (INVALID.includes(e.s)) add(p, 'invalid');
  }
  for (const c of await ctx.db.query(`SELECT e.user_id AS u, count(*)::int AS n FROM order_events e JOIN sales o ON o.id = e.order_id WHERE e.kind = 'conf_status' AND e.at >= $1 AND e.at < $2 AND e.user_id = ANY($3) GROUP BY 1`, P))
    add(of(x, c.u), 'calls', num(c.n));
  // what came of the orders they confirmed: delivered or back
  for (const q of await ctx.db.query(
    `SELECT agent_id AS u,
       count(*) FILTER (WHERE follow_status = ANY($4) AND delivered_at >= $1 AND delivered_at < $2)::int AS dl,
       count(*) FILTER (WHERE follow_status = ANY($5) AND coalesce(returned_at, updated_at) >= $1 AND coalesce(returned_at, updated_at) < $2)::int AS rt
     FROM sales WHERE agent_id = ANY($3) GROUP BY 1`,
    [...P, DONE, BACK],
  )) {
    add(of(x, q.u), 'delivered', num(q.dl));
    add(of(x, q.u), 'returned', num(q.rt));
  }
  // the basket and the upsell of what they confirmed
  for (const q of await ctx.db.query(
    `SELECT agent_id AS u, count(*)::int AS n, count(*) FILTER (WHERE has_upsell)::int AS up, COALESCE(sum(total), 0)::bigint AS v
     FROM sales WHERE confirmed_at >= $1 AND confirmed_at < $2 AND conf_status = ANY($4) AND agent_id = ANY($3) GROUP BY 1`,
    [...P, CONFIRMED],
  )) {
    add(of(x, q.u), 'upN', num(q.n));
    add(of(x, q.u), 'upYes', num(q.up));
    add(of(x, q.u), 'basket', num(q.v));
  }
  // how fast the first call came, and the tries made in their slot (the confirmation teams' rules)
  const cs = await confirmationStats(ctx, { from: r.from, to: r.to, dateType: 'created', rateType: 'taux', chart: 'conf' });
  for (const id of ids) {
    const a = cs.per.get(id);
    if (!a) continue;
    const p = of(x, id);
    add(p, 'firstOk', a.firstOnTime);
    add(p, 'firstAll', a.firstTotal);
    for (const ms of a.firstDelays) push(p, 'firstMs', ms);
    add(p, 'triesOk', a.triesOnTime);
    add(p, 'triesMiss', a.triesMissed);
  }
  if (detail) {
    // what they have to call now, and the callbacks already late
    for (const q of await ctx.db.query(
      `SELECT agent_id AS u, count(*) FILTER (WHERE conf_status = ANY($2))::int AS todo,
         count(*) FILTER (WHERE conf_status IN ('callback','postponed') AND next_call_at < $3)::int AS late
       FROM sales WHERE agent_id = ANY($1) GROUP BY 1`,
      [ids, CONF_TODO, new Date(ctx.now()).toISOString()],
    )) {
      add(of(x, q.u), 'inProgress', num(q.todo));
      add(of(x, q.u), 'lateCallbacks', num(q.late));
    }
    // why they were cancelled (the reason typed or chosen)
    if (cancelledBy.size)
      for (const q of await ctx.db.query(`SELECT o.id, ${REASON_SQL.conf} AS reason FROM sales o WHERE o.id = ANY($1)`, [[...cancelledBy.keys()]]))
        because(of(x, cancelledBy.get(num(q.id))), q.reason);
  }
  return x;
}

async function countSuivi(ctx: Ctx, r: R, detail: boolean): Promise<Count> {
  const x = counter();
  const P = [r.from, r.to];
  for (const q of await ctx.db.query(`SELECT follow_agent_id AS u, ${dayOf('delivered_at')} AS d, count(*)::int AS n FROM sales WHERE follow_status = ANY($3) AND delivered_at >= $1 AND delivered_at < $2 GROUP BY 1, 2`, [...P, DONE])) {
    add(of(x, q.u), 'delivered', num(q.n));
    onDay(of(x, q.u), q.d, num(q.n), num(q.n), num(q.n));
  }
  const back = await ctx.db.query(
    `SELECT id, follow_agent_id AS u, ${dayOf('coalesce(returned_at, updated_at)')} AS d${detail ? `, ${REASON_SQL.back} AS reason` : ''}
     FROM sales o WHERE follow_status = ANY($3) AND coalesce(returned_at, updated_at) >= $1 AND coalesce(returned_at, updated_at) < $2`,
    [...P, BACK],
  );
  for (const q of back) {
    add(of(x, q.u), 'returned');
    onDay(of(x, q.u), q.d, 0, 0, 1);
    if (detail) because(of(x, q.u), q.reason);
  }
  // alerts treated: how fast (from the alert), and whether the parcel was saved in the end
  const treated = await ctx.db.query(
    `SELECT DISTINCT ON (e.order_id, e.user_id) e.order_id AS o, e.user_id AS u, e.at, o.follow_status AS st,
       (SELECT max(a.at) FROM order_events a WHERE a.order_id = e.order_id AND a.kind = 'follow_status' AND a.to_value = 'alert' AND a.at <= e.at) AS alert_at
     FROM order_events e JOIN sales o ON o.id = e.order_id
     WHERE e.kind = 'sub_status' AND e.to_value = 'alert_traitee' AND e.at >= $1 AND e.at < $2 AND e.user_id IS NOT NULL
     ORDER BY e.order_id, e.user_id, e.at`,
    P,
  );
  for (const q of treated) {
    const p = of(x, q.u);
    add(p, 'treated');
    if (q.alert_at) push(p, 'treatMs', Math.max(0, Date.parse(iso(q.at)) - Date.parse(iso(q.alert_at))));
    if (DONE.includes(q.st)) add(p, 'saved');
    else if ([...BACK, 'cancelled', 'lost'].includes(q.st)) add(p, 'lost');
  }
  // calls to customers whose parcel had already left (the confirmation's calls are not the suivi's)
  for (const q of await ctx.db.query(
    `SELECT e.user_id AS u, count(*)::int AS n FROM order_events e JOIN sales o ON o.id = e.order_id
     WHERE e.kind = 'call' AND e.at >= $1 AND e.at < $2 AND e.user_id IS NOT NULL AND o.shipped_at IS NOT NULL AND e.at >= o.shipped_at GROUP BY 1`,
    P,
  ))
    add(of(x, q.u), 'calls', num(q.n));
  if (detail)
    for (const q of await ctx.db.query(
      `SELECT follow_agent_id AS u, count(*)::int AS n, count(*) FILTER (WHERE updated_at < $1)::int AS old
       FROM sales WHERE follow_status = 'alert' AND COALESCE(sub_status, '') <> 'alert_traitee' GROUP BY 1`,
      [new Date(ctx.now() - DAY).toISOString()],
    )) {
      add(of(x, q.u), 'alertsNow', num(q.n));
      add(of(x, q.u), 'alertsOld', num(q.old));
    }
  return x;
}

async function countDepot(ctx: Ctx, r: R, detail: boolean): Promise<Count> {
  const x = counter();
  const ev = await ctx.db.query(
    `SELECT DISTINCT ON (e.order_id, e.to_value) e.order_id AS o, e.user_id AS u, e.to_value AS s, e.at, o.confirmed_at AS c, ${dayOf('e.at')} AS d
     FROM order_events e JOIN sales o ON o.id = e.order_id
     WHERE e.kind = 'follow_status' AND e.to_value IN ('prepared','shipped','returned') AND e.at >= $1 AND e.at < $2 AND e.user_id IS NOT NULL
     ORDER BY e.order_id, e.to_value, e.at`,
    [r.from, r.to],
  );
  const packedBy = new Map<number, number>();
  for (const q of ev) {
    const p = of(x, q.u);
    if (q.s === 'prepared') {
      add(p, 'packed');
      packedBy.set(num(q.o), num(q.u));
      let fast = 0;
      if (q.c) {
        const ms = Date.parse(iso(q.at)) - Date.parse(iso(q.c));
        if (ms >= 0) {
          push(p, 'prepMs', ms);
          add(p, 'prepTimed');
          if (ms <= DAY) {
            add(p, 'prep24');
            fast = 1;
          }
        }
      }
      onDay(p, q.d, 1, fast, q.c ? 1 : 0);
    } else if (q.s === 'shipped') add(p, 'shipped');
    else add(p, 'returnsIn');
  }
  // what came back of what they packed, and why (the wrong product, a broken one: something to learn from)
  if (packedBy.size)
    for (const q of await ctx.db.query(`SELECT o.id, ${REASON_SQL.back} AS reason FROM sales o WHERE o.id = ANY($1) AND o.follow_status = ANY($2)`, [[...packedBy.keys()], BACK])) {
      const p = of(x, packedBy.get(num(q.id)));
      if (!q.reason || !WRONG.test(q.reason)) continue;
      add(p, 'wrong');
      if (detail) because(p, q.reason);
    }
  return x;
}

async function countLivreurs(ctx: Ctx, r: R, detail: boolean): Promise<Count> {
  const x = counter();
  const P = [r.from, r.to];
  for (const q of await ctx.db.query(`SELECT livreur_id AS u, ${dayOf('delivered_at')} AS d, count(*)::int AS n FROM sales WHERE livreur_id IS NOT NULL AND follow_status = ANY($3) AND delivered_at >= $1 AND delivered_at < $2 GROUP BY 1, 2`, [...P, DONE])) {
    add(of(x, q.u), 'delivered', num(q.n));
    onDay(of(x, q.u), q.d, num(q.n), num(q.n), num(q.n));
  }
  for (const q of await ctx.db.query(
    `SELECT livreur_id AS u, ${dayOf('coalesce(returned_at, updated_at)')} AS d${detail ? `, ${REASON_SQL.back} AS reason` : ''}
     FROM sales o WHERE livreur_id IS NOT NULL AND follow_status = ANY($3) AND coalesce(returned_at, updated_at) >= $1 AND coalesce(returned_at, updated_at) < $2`,
    [...P, BACK],
  )) {
    add(of(x, q.u), 'returned');
    onDay(of(x, q.u), q.d, 0, 0, 1);
    if (detail) because(of(x, q.u), q.reason);
  }
  if (detail)
    for (const q of await ctx.db.query(
      `SELECT livreur_id AS u,
         count(*) FILTER (WHERE follow_status = ANY($1))::int AS hand,
         count(*) FILTER (WHERE follow_status = ANY($1) AND COALESCE(shipped_at, updated_at) < $2)::int AS late,
         count(*) FILTER (WHERE follow_status = 'returning')::int AS bring,
         count(*) FILTER (WHERE follow_status = 'delivered' AND NOT cashed)::int AS un_n,
         COALESCE(sum(total) FILTER (WHERE follow_status = 'delivered' AND NOT cashed), 0)::bigint AS un
       FROM sales WHERE livreur_id IS NOT NULL GROUP BY 1`,
      [FOLLOW_ON_ROAD, new Date(ctx.now() - 2 * DAY).toISOString()],
    )) {
      const p = of(x, q.u);
      add(p, 'inHand', num(q.hand));
      add(p, 'late', num(q.late));
      add(p, 'toBring', num(q.bring));
      add(p, 'uncashedCount', num(q.un_n));
      add(p, 'uncashed', num(q.un));
    }
  return x;
}

async function countSav(ctx: Ctx, r: R, detail: boolean): Promise<Count> {
  const x = counter();
  const P = [r.from, r.to];
  for (const q of await ctx.db.query(`SELECT assigned_to AS u, created_at, resolved_at, ${dayOf('resolved_at')} AS d FROM complaints WHERE status = 'resolved' AND resolved_at >= $1 AND resolved_at < $2`, P)) {
    const p = of(x, q.u);
    const ms = Math.max(0, Date.parse(iso(q.resolved_at)) - Date.parse(iso(q.created_at)));
    add(p, 'settled');
    push(p, 'settleMs', ms);
    if (ms <= 48 * H) add(p, 'settled48');
    onDay(p, q.d, 1, ms <= 48 * H ? 1 : 0, 1);
  }
  for (const q of await ctx.db.query(`SELECT assigned_to AS u, satisfaction AS s FROM complaints WHERE satisfaction IS NOT NULL AND satisfaction_at >= $1 AND satisfaction_at < $2`, P)) {
    const p = of(x, q.u);
    add(p, 'satAll');
    if (num(q.s) >= 3) add(p, 'satOk');
  }
  if (detail)
    for (const q of await ctx.db.query(
      `SELECT assigned_to AS u, count(*) FILTER (WHERE status IN ('open','progress'))::int AS todo,
         count(*) FILTER (WHERE status IN ('open','progress') AND created_at < $1)::int AS old
       FROM complaints GROUP BY 1`,
      [new Date(ctx.now() - 48 * H).toISOString()],
    )) {
      add(of(x, q.u), 'todo', num(q.todo));
      add(of(x, q.u), 'old48', num(q.old));
    }
  return x;
}

// ---------------------------------------------------------------- the board
const BoardInput = Range.and(z.object({ area: z.enum(AREAS), teamId: z.string().max(60).optional() }));

async function profileNames(ctx: Ctx) {
  const rows = await ctx.db.query('SELECT id, name, roles, active FROM profiles');
  return new Map(rows.map((r: any) => [num(r.id), { name: r.name as string, roles: (r.roles ?? []) as string[], active: !!r.active }]));
}

/** The people of an area beyond the confirmation teams: who holds the role (still active), or did the work. */
const AREA_ROLE: Partial<Record<Area, string>> = { suivi: 'suivi', depot: 'depot', livreurs: 'livreur' };

export async function board(ctx: Ctx, i: z.infer<typeof BoardInput>) {
  const now = ctx.now();
  const R: R = { from: i.from, to: i.to };
  const P = prevOf(R, now);
  const people = await profileNames(ctx);
  const nameOf = (id: number) => people.get(id)?.name ?? '?';

  // teams (confirmation): the manager's own, or every team for admin / vendeur, or the one chosen
  let teams: { id: string; name: string; managerName: string | null; agentIds: number[] }[] = [];
  let memberIds: number[] = [];
  if (i.area === 'confirmation') {
    teams = (await visibleTeams(ctx)).map((t) => ({ id: t.id, name: t.name, managerName: t.managerName, agentIds: t.agentIds }));
    const chosen = i.teamId ? teams.filter((t) => t.id === i.teamId) : teams;
    memberIds = [...new Set((chosen.length ? chosen : teams).flatMap((t) => t.agentIds))];
  }

  const count = (r: R, detail: boolean) =>
    i.area === 'confirmation' ? countConfirmation(ctx, r, memberIds, detail) : i.area === 'suivi' ? countSuivi(ctx, r, detail) : i.area === 'depot' ? countDepot(ctx, r, detail) : i.area === 'livreurs' ? countLivreurs(ctx, r, detail) : countSav(ctx, r, detail);
  const cur = await count(R, true);
  const prev = await count(P, false);
  const fin = FINISH[i.area];

  // the members: the team's agents, or whoever holds the role or did the work
  if (i.area !== 'confirmation') {
    const role = AREA_ROLE[i.area];
    const ids = new Set<number>([...cur.per.keys(), ...prev.per.keys()]);
    if (role) for (const [id, p] of people) if (p.active && p.roles.includes(role)) ids.add(id);
    memberIds = [...ids].filter((id) => people.has(id));
  }
  const days = daysOf(R);
  const dayList = (p: Parts) => days.map((d) => ({ d, ...(p.days.get(d) ?? { n: 0, ok: 0, of: 0 }) }));
  type Member = { id: number | null; name: string; none: boolean; v: V; p: V; days: Day[]; reasons: Reason[] };
  const members: Member[] = memberIds.map((id) => {
    const c = cur.per.get(id) ?? parts();
    return { id, name: nameOf(id), none: false, v: fin(c), p: fin(prev.per.get(id) ?? parts()), days: dayList(c), reasons: topReasons(c.reasons, 3) };
  });
  // work that belongs to nobody yet is shown apart (it counts in the team)
  const noneVol = Object.values(cur.none.c).reduce((s, n) => s + n, 0);
  if (noneVol && i.area !== 'confirmation') members.push({ id: null, name: '', none: true, v: fin(cur.none), p: fin(prev.none), days: dayList(cur.none), reasons: topReasons(cur.none.reasons, 3) });

  const inTeam = (x: Count) => merge([...memberIds.map((id) => x.per.get(id) ?? parts()), ...(i.area === 'confirmation' ? [] : [x.none])]);
  const teamCur = inTeam(cur);
  const teamPrev = inTeam(prev);
  const groups =
    i.area === 'confirmation' && !i.teamId && teams.length > 1
      ? teams.map((t) => ({ id: t.id, name: t.name, managerName: t.managerName, size: t.agentIds.length, v: fin(merge(t.agentIds.map((id) => cur.per.get(id) ?? parts()))), p: fin(merge(t.agentIds.map((id) => prev.per.get(id) ?? parts()))) }))
      : [];

  return {
    area: i.area,
    range: R,
    prevRange: P,
    teams: teams.map(({ id, name, managerName, agentIds }) => ({ id, name, managerName, size: agentIds.length })),
    teamId: i.teamId ?? null,
    members: members.sort((a, b) => Number(a.none) - Number(b.none) || volume(i.area, b.v) - volume(i.area, a.v) || a.name.localeCompare(b.name)),
    team: fin(teamCur),
    prev: fin(teamPrev),
    groups,
    days: dayList(teamCur),
    reasons: topReasons(teamCur.reasons),
    now: await nowOf(ctx, i.area, memberIds, teamCur),
  };
}

/** how much work a member's numbers stand for (to order the team) */
function volume(area: Area, v: V) {
  return num(area === 'confirmation' ? v.treated : area === 'suivi' ? v.outcomes : area === 'depot' ? v.packed : area === 'livreurs' ? num(v.delivered) + num(v.returned) : v.settled);
}

/** What is late right now, for the team (counts link to where it is done). */
async function nowOf(ctx: Ctx, area: Area, ids: number[], team: Parts): Promise<{ key: string; n: number }[]> {
  const q1 = async (sql: string, p: unknown[] = []) => (await ctx.db.query(sql, p))[0] ?? {};
  if (area === 'confirmation') {
    const calls = await getSetting(ctx.db, 'calls');
    const waiting = ids.length
      ? await ctx.db.query(`SELECT created_at, COALESCE(assigned_at, created_at) AS start FROM sales WHERE conf_status IN ('new','to_check') AND attempts = 0 AND agent_id = ANY($1)`, [ids])
      : [];
    const firstLate = waiting.filter((r: any) => nextDue({ createdAt: iso(r.start), attempts: 0, nextCallAt: null, done: false }, calls, ctx.now()).kind === 'first_late').length;
    const unassigned = seesAll(ctx) ? num((await q1(`SELECT count(*)::int AS n FROM sales WHERE agent_id IS NULL AND conf_status = 'new'`)).n) : 0;
    return [
      { key: 'firstLate', n: firstLate },
      { key: 'lateCallbacks', n: C(team, 'lateCallbacks') },
      { key: 'unassigned', n: unassigned },
      { key: 'inProgress', n: C(team, 'inProgress') },
    ];
  }
  if (area === 'suivi') {
    const r = await q1(
      `SELECT count(*) FILTER (WHERE follow_status = 'alert' AND COALESCE(sub_status, '') <> 'alert_traitee')::int AS alerts,
              count(*) FILTER (WHERE follow_status = 'alert' AND COALESCE(sub_status, '') <> 'alert_traitee' AND updated_at < $1)::int AS old,
              count(*) FILTER (WHERE follow_status = ANY($2) AND follow_agent_id IS NULL)::int AS orphan
       FROM sales`,
      [new Date(ctx.now() - DAY).toISOString(), FOLLOW_ON_ROAD],
    );
    const claims = num((await q1(`SELECT count(*)::int AS n FROM claims WHERE status <> 'resolved' AND created_at < $1`, [new Date(ctx.now() - 48 * H).toISOString()])).n);
    return [
      { key: 'alertsOld', n: num(r.old) },
      { key: 'alerts', n: num(r.alerts) },
      { key: 'claimsLate', n: claims },
      { key: 'orphan', n: num(r.orphan) },
    ];
  }
  if (area === 'depot') {
    const r = await q1(
      `SELECT count(*) FILTER (WHERE follow_status = 'to_prepare')::int AS todo,
              count(*) FILTER (WHERE follow_status = 'to_prepare' AND confirmed_at < $1)::int AS late,
              count(*) FILTER (WHERE follow_status = 'prepared' AND COALESCE(prepared_at, updated_at) < $1)::int AS waiting,
              count(*) FILTER (WHERE follow_status = 'returning')::int AS back
       FROM sales`,
      [new Date(ctx.now() - DAY).toISOString()],
    );
    return [
      { key: 'late24', n: num(r.late) },
      { key: 'waitingPickup', n: num(r.waiting) },
      { key: 'toPrepare', n: num(r.todo) },
      { key: 'toReceive', n: num(r.back) },
    ];
  }
  if (area === 'livreurs')
    return [
      { key: 'late', n: C(team, 'late') },
      { key: 'toBring', n: C(team, 'toBring') },
      { key: 'uncashed', n: C(team, 'uncashed') },
    ];
  const r = await q1(`SELECT count(*) FILTER (WHERE status IN ('open','progress') AND created_at < $1)::int AS old, count(*) FILTER (WHERE status = 'open' AND assigned_to IS NULL)::int AS nobody FROM complaints`, [
    new Date(ctx.now() - 48 * H).toISOString(),
  ]);
  return [
    { key: 'old48', n: num(r.old) },
    { key: 'nobody', n: num(r.nobody) },
    { key: 'todo', n: C(team, 'todo') },
  ];
}

// ---------------------------------------------------------------- one agent's own day (Accueil)
/** The areas a user works in, and the board of their own team there: their row, the team's, the period before. */
async function myDay(ctx: Ctx, r: R) {
  const me = ctx.session.profile.id;
  const s = ctx.session;
  const out: { area: Area; me: { v: V; p: V; days: Day[]; reasons: Reason[] } | null; team: V; prev: V; avg: V; teamDays: Day[]; size: number; rank: number | null; rankOf: string }[] = [];
  const areas: Area[] = [];
  if (s.roles.includes('confirmation')) areas.push('confirmation');
  if (s.roles.includes('suivi')) areas.push('suivi');
  if (s.roles.includes('depot')) areas.push('depot');
  for (const area of areas) {
    let teamId: string | undefined;
    if (area === 'confirmation') {
      // the team they belong to (the average they are compared with)
      const t = (await teamViews(ctx)).find((x) => x.agentIds.includes(me));
      teamId = t?.id;
    }
    const b = await boardForTeam(ctx, { ...r, area, teamId }, me);
    const mine = b.members.find((m) => m.id === me) ?? null;
    const key = area === 'confirmation' ? 'confRate' : area === 'suivi' ? 'deliveryRate' : 'packed';
    const ranked = b.members.filter((m) => !m.none && m.v[key] !== null).sort((a, x) => num(x.v[key]) - num(a.v[key]));
    const idx = ranked.findIndex((m) => m.id === me);
    out.push({
      area,
      me: mine && { v: mine.v, p: mine.p, days: mine.days, reasons: mine.reasons },
      team: b.team,
      prev: b.prev,
      avg: avgOf(area, b.members),
      teamDays: b.days,
      size: b.members.filter((m) => !m.none).length,
      rank: idx >= 0 ? idx + 1 : null,
      rankOf: key,
    });
  }
  return out;
}

/** A board limited to one team whatever the viewer's own rights (to compare an agent with their own team). */
async function boardForTeam(ctx: Ctx, i: z.infer<typeof BoardInput>, me: number) {
  if (i.area !== 'confirmation') return board(ctx, i);
  const teams = await teamViews(ctx);
  const t = teams.find((x) => x.id === i.teamId);
  const ids = t ? t.agentIds : [me];
  // count with the agents of that team only (as a manager would see it)
  const now = ctx.now();
  const R: R = { from: i.from, to: i.to };
  const P = prevOf(R, now);
  const cur = await countConfirmation(ctx, R, ids, true);
  const prev = await countConfirmation(ctx, P, ids, false);
  const fin = FINISH.confirmation;
  const days = daysOf(R);
  const dayList = (p: Parts) => days.map((d) => ({ d, ...(p.days.get(d) ?? { n: 0, ok: 0, of: 0 }) }));
  const members = ids.map((id) => {
    const c = cur.per.get(id) ?? parts();
    return { id, name: '', none: false, v: fin(c), p: fin(prev.per.get(id) ?? parts()), days: dayList(c), reasons: topReasons(c.reasons, 3) };
  });
  const team = merge(ids.map((id) => cur.per.get(id) ?? parts()));
  return { members, team: fin(team), prev: fin(merge(ids.map((id) => prev.per.get(id) ?? parts()))), days: dayList(team) };
}

/** A count per person in the team: the average of those who worked (nobody's names leave the server). */
function avgOf(area: Area, members: { none: boolean; v: V }[]): V {
  const active = members.filter((m) => !m.none && volume(area, m.v) > 0);
  const out: V = {};
  if (!active.length) return out;
  for (const k of Object.keys(active[0].v)) out[k] = active.reduce((s, m) => s + num(m.v[k]), 0) / active.length;
  return out;
}

export const boardProcs = {
  /** A team's board for one area and a period: members, team, period before, days, reasons, what is late now. */
  'stats.board': proc(['agent_manager', 'vendeur'], BoardInput, async (ctx, i) => {
    await needArea(ctx, i.area);
    return board(ctx, i);
  }),
  /** The user's own day in each area they work in, next to their team's (Accueil of an agent). */
  'stats.me': proc(['confirmation', 'suivi', 'depot'], Range, (ctx, r) => myDay(ctx, r)),
};
