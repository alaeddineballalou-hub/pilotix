// Who is responsible for a problem (the owner's request, 25 Nov 2026): a parcel that came back (Commandes › Annulé ›
// Retours), the one the Suivi gave to another customer, a problem after delivery (SAV). The agent says WHAT happened;
// Pilotix decides WHO, with these rules, from the order's history:
//  - commune, address, phone, home or bureau wrong: who wrote it last — changed at the depot after the confirmation →
//    Dépôt (that person); else → Confirmation (the agent who confirmed it);
//  - wrong colour or size, wrong quantity: what the order says = what the customer got → Confirmation; something else →
//    Dépôt (who prepared it). Before delivery the customer only saw it at the door: no photo, the depot checks the parcel
//    when it comes back; after delivery (SAV) the customer's photo;
//  - « Numéro erroné » / « Injoignable » from the courier: an agent reached the customer on that number (confirmed it by
//    phone, the number not changed since) → the livreur; else the customer (a wrong number: whoever wrote it);
//  - a missing part: the box sealed by the factory → the supplier (Produit); else → Dépôt;
//  - broken: badly packed → Dépôt; else → the delivery company;
//  - too late: sent more than 2 days after the confirmation → Dépôt (waiting for stock → the supplier); else the company;
//  - the courier sent it back while its alert was untouched (no one called, no motif given) → Suivi.
// A parcel that comes back gets its line by itself (the courier's words, the Suivi's motif) the first time someone looks
// at the returns of its days; an agent can say more (« Préciser »). « Pas moi »: the person — or his manager — says it is
// not him; the admins or the seller decide.
// Who sees what: the admins, the seller and an agency's chiefs every name; a manager every team, but the names of his
// own team only (agent managers: Confirmation and Suivi; the depot's managers — Management › Alertes dépôt — the Dépôt);
// an agent his own errors only. Statistics only: nothing here touches the pay.
import {
  FAULT_ASK,
  FAULT_FIXED,
  FAULT_OF_SUIVI_MOTIF,
  FAULT_REASONS,
  FAULT_SEEN,
  FAULT_TEAMS,
  faultOfCourierWords,
  kfRange,
  type FaultMoment,
  type FaultReason,
  type FaultTeam,
} from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num } from '../db';
import { bad, Ctx, forbidden, notFound, proc } from '../rpc';
import { getSetting } from '../settings';
import { agencyLead, andSql, listScopeSql, rowScopeSql } from './agencyscope';
import { companyRules, FEE_COLS, noOrderAccess, parcelFees } from './orders';

const id = z.number().int().positive();
const dateStr = z.string().min(10).max(40);
const reasonZ = z.enum(FAULT_REASONS as [FaultReason, ...FaultReason[]]);
const teamZ = z.enum(FAULT_TEAMS as unknown as [FaultTeam, ...FaultTeam[]]);
const Answers = z
  .object({
    /** the colour / size the customer saw or got */
    variant: z.string().trim().max(120).optional(),
    /** how many he got */
    qty: z.number().int().min(0).max(999).optional(),
    /** a missing part: the box was sealed by the factory */
    sealed: z.boolean().optional(),
    /** broken: it was badly packed */
    badlyPacked: z.boolean().optional(),
  })
  .default({});
type Ans = z.infer<typeof Answers>;

/** the parcels that came back, on the day the Retours count them (orders.ts › cancelReport) */
const BACK_AT = 'coalesce(o.returned_at, o.returning_at, o.updated_at)';
const RETURNS = `o.follow_status IN ('returning','returned')`;
/** sent more than this after its confirmation: late at the depot */
const LATE_MS = 48 * 3_600_000;

// ---------------------------------------------------------------- what the history says about an order
type Change = { user: number | null; depot: boolean; at: number };
interface Facts {
  id: number;
  ref: string;
  customer: string;
  total: number;
  phone: string;
  wilayaId: number;
  companyKind: string | null;
  agentId: number | null;
  followAgentId: number | null;
  courier: string | null;
  product: string | null;
  variant: string | null;
  qty: number;
  confirmedAt: number | null;
  shippedAt: number | null;
  backAt: number | null;
  /** the agent who confirmed it (by phone) */
  confirmer: number | null;
  /** who prepared it at the depot */
  preparer: number | null;
  /** the last change after the confirmation of each thing */
  last: Partial<Record<'place' | 'desk' | 'address' | 'phone' | 'items', Change>>;
  /** the Suivi gave it up (« Perdu »): its motif */
  suiviLost: string | null;
  /** what the courier wrote when it came back */
  words: string | null;
  /** its last alert, and whether someone did anything after it */
  alertAt: number | null;
  acted: boolean;
  /** it waited for stock after the confirmation */
  noStock: boolean;
  /** what its return cost (the company's return fee and weight) */
  cost: number;
}

const ms = (v: unknown) => (v ? Date.parse(new Date(v as string).toISOString()) : null);
const isDepotOnly = (roles: unknown) => {
  const r = Array.isArray(roles) ? (roles as string[]) : [];
  return r.includes('depot') && !r.some((x) => ['confirmation', 'agent_manager', 'vendeur', 'admin', 'suivi'].includes(x));
};

async function loadFacts(db: Db, ids: number[]): Promise<Map<number, Facts>> {
  const out = new Map<number, Facts>();
  if (!ids.length) return out;
  const R = await companyRules(db);
  const rows = await db.query(
    `SELECT ${FEE_COLS}, o.customer_name, o.phone, o.agent_id, o.follow_agent_id, lv.name AS livreur_name, o.confirmed_at, o.shipped_at,
       ${BACK_AT} AS back_at,
       (SELECT i.name FROM order_items i WHERE i.order_id = o.id ORDER BY i.id LIMIT 1) AS product,
       (SELECT i.variant_title FROM order_items i WHERE i.order_id = o.id ORDER BY i.id LIMIT 1) AS variant,
       (SELECT coalesce(sum(i.qty), 0) FROM order_items i WHERE i.order_id = o.id) AS qty_all
     FROM orders o LEFT JOIN delivery_companies co ON co.id = o.company_id LEFT JOIN profiles lv ON lv.id = o.livreur_id
     WHERE o.id = ANY($1)`,
    [ids],
  );
  const events = await db.query(
    `SELECT e.order_id, e.at, e.user_id, e.kind, e.from_value, e.to_value, e.note, e.data, p.roles
     FROM order_events e LEFT JOIN profiles p ON p.id = e.user_id
     WHERE e.order_id = ANY($1) ORDER BY e.order_id, e.at, e.id`,
    [ids],
  );
  const byOrder = new Map<number, any[]>();
  for (const e of events) {
    const k = num(e.order_id);
    if (!byOrder.has(k)) byOrder.set(k, []);
    byOrder.get(k)!.push(e);
  }
  for (const o of rows) {
    const oid = num(o.id);
    const ev = byOrder.get(oid) ?? [];
    let confirmer: number | null = null;
    let confirmedAt = ms(o.confirmed_at);
    let preparer: number | null = null;
    let suiviLost: string | null = null;
    let words: string | null = null;
    let alertAt: number | null = null;
    let noStock = false;
    for (const e of ev) {
      const at = ms(e.at)!;
      if (e.kind === 'conf_status' && e.to_value === 'confirmed' && e.user_id) {
        confirmer = num(e.user_id);
        confirmedAt = at;
      }
      if (e.kind === 'conf_status' && e.to_value === 'no_stock') noStock = true;
      if (e.kind === 'follow_status' && e.to_value === 'prepared' && e.user_id) preparer = num(e.user_id);
      if (e.kind === 'follow_status' && e.to_value === 'alert') alertAt = at;
      if (e.kind === 'follow_status' && (e.to_value === 'returning' || e.to_value === 'returned') && e.note) words = String(e.note).split(' — ')[0] || words;
      if (e.kind === 'suivi_motif' && e.from_value === 'lost') suiviLost = e.to_value ?? null;
    }
    const last: Facts['last'] = {};
    for (const e of ev) {
      if (e.kind !== 'edit') continue;
      const at = ms(e.at)!;
      if (confirmedAt !== null && at < confirmedAt) continue;
      const fields: string[] = Array.isArray(e.data?.fields) ? e.data.fields : [];
      for (const f of fields) if (f === 'place' || f === 'desk' || f === 'address' || f === 'phone' || f === 'items') last[f] = { user: e.user_id ? num(e.user_id) : null, depot: isDepotOnly(e.roles), at };
    }
    // someone did something after the alert (a call, a note, a motif, a claim, a status): a person's event, not the courier's
    const acted = alertAt !== null && ev.some((e) => e.user_id && ms(e.at)! > alertAt!);
    const fee = parcelFees(o, R);
    out.set(oid, {
      id: oid,
      ref: o.ref,
      customer: o.customer_name ?? '',
      total: num(o.total),
      phone: o.phone ?? '',
      wilayaId: num(o.wilaya_id),
      companyKind: o.company_kind ?? null,
      agentId: o.agent_id ? num(o.agent_id) : null,
      followAgentId: o.follow_agent_id ? num(o.follow_agent_id) : null,
      courier: o.company ?? o.livreur_name ?? null,
      product: o.product ?? null,
      variant: o.variant ?? null,
      qty: num(o.qty_all),
      confirmedAt,
      shippedAt: ms(o.shipped_at),
      backAt: ms(o.back_at),
      confirmer: confirmer ?? (o.agent_id ? num(o.agent_id) : null),
      preparer,
      last,
      suiviLost,
      words,
      alertAt,
      acted,
      noStock,
      cost: Math.max(0, Math.round((fee.ret || 0) + (fee.extraRet || 0))),
    });
  }
  return out;
}

// ---------------------------------------------------------------- the rules
export interface Decision {
  team: FaultTeam;
  personId: number | null;
  personLabel: string | null;
}

/** Who is responsible for `reason` on this order (the owner's rules, see the top of this file). */
export function decide(reason: FaultReason, f: Facts, a: Ans = {}): Decision {
  const conf = (): Decision => ({ team: 'confirmation', personId: f.confirmer, personLabel: null });
  const depot = (who = f.preparer): Decision => ({ team: 'depot', personId: who, personLabel: null });
  const courier = (team: 'livreur' | 'societe'): Decision => ({ team, personId: null, personLabel: f.courier });
  const product = (): Decision => ({ team: 'produit', personId: null, personLabel: f.product });
  /** who wrote this last: changed at the depot after the confirmation → Dépôt, else the confirmation */
  const writer = (...fields: (keyof Facts['last'])[]): Decision => {
    const c = fields.map((k) => f.last[k]).filter((x): x is Change => !!x).sort((x, y) => y.at - x.at)[0];
    if (c?.depot) return depot(c.user);
    return conf();
  };
  switch (reason) {
    case 'wrong_commune':
      return writer('place');
    case 'wrong_address':
      return writer('address', 'place');
    case 'home_desk':
      return writer('desk');
    case 'wrong_phone':
      return writer('phone');
    case 'bad_number':
    case 'unreachable': {
      // reached on this number by an agent (he confirmed it by phone) and the number not changed since: the number works
      const reached = f.confirmer !== null && !f.last.phone;
      if (reached) return courier('livreur');
      return reason === 'bad_number' ? writer('phone') : { team: 'client', personId: null, personLabel: null };
    }
    case 'wrong_variant': {
      if (!a.variant) return { team: 'unknown', personId: null, personLabel: null };
      const same = norm(a.variant) === norm(f.variant ?? '');
      if (same) return f.last.items?.depot ? depot(f.last.items.user) : conf();
      return depot();
    }
    case 'wrong_qty': {
      if (a.qty === undefined) return { team: 'unknown', personId: null, personLabel: null };
      return a.qty === f.qty ? conf() : depot();
    }
    case 'missing_part':
      if (a.sealed === undefined) return { team: 'unknown', personId: null, personLabel: null };
      return a.sealed ? product() : depot();
    case 'broken':
      return a.badlyPacked ? depot() : courier('societe');
    case 'too_late': {
      const late = f.confirmedAt !== null && f.shippedAt !== null && f.shippedAt - f.confirmedAt > LATE_MS;
      if (!late) return courier('societe');
      return f.noStock ? product() : { team: 'depot', personId: null, personLabel: null };
    }
    case 'alert_ignored':
      return { team: 'suivi', personId: f.followAgentId, personLabel: null };
    default: {
      const team = FAULT_FIXED[reason] ?? 'unknown';
      if (team === 'confirmation') return conf();
      if (team === 'depot') return depot();
      if (team === 'livreur' || team === 'societe') return courier(team);
      if (team === 'produit') return product();
      if (team === 'suivi') return { team, personId: f.followAgentId, personLabel: null };
      return { team, personId: null, personLabel: null };
    }
  }
}
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9؀-ۿ]+/g, ' ').trim();

/** The reason of a parcel that came back, nobody having said more: the Suivi's motif, else the courier's words; its
 *  alert untouched → the Suivi. */
export function autoReason(f: Facts): FaultReason {
  const r = f.suiviLost ? FAULT_OF_SUIVI_MOTIF[f.suiviLost] ?? 'other' : faultOfCourierWords(f.words);
  const quiet = !f.suiviLost && f.alertAt !== null && !f.acted;
  if (quiet && ['refused', 'unreachable', 'client_cancelled', 'other', 'changed_mind'].includes(r)) return 'alert_ignored';
  return r;
}

/** The parcels of `ids` that came back and have no line yet get one, decided by the rules (by itself, once). */
export async function ensureFaults(db: Db, ids: number[]) {
  if (!ids.length) return;
  const missing = (
    await db.query(`SELECT o.id FROM orders o WHERE o.id = ANY($1) AND ${RETURNS} AND NOT EXISTS (SELECT 1 FROM order_faults f WHERE f.order_id = o.id)`, [ids])
  ).map((r: any) => num(r.id));
  if (!missing.length) return;
  const facts = await loadFacts(db, missing);
  for (const f of facts.values()) {
    const reason = autoReason(f);
    const d = decide(reason, f);
    await db.query(
      `INSERT INTO order_faults (order_id, moment, reason, team, person_id, person_label, cost, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (order_id) DO NOTHING`,
      [f.id, f.suiviLost ? 'swap' : 'return', reason, d.team, d.personId, d.personLabel, f.cost, iso(f.backAt ?? Date.now())],
    );
  }
}

/** The returns of a period (the Retours of Commandes › Annulé), in the user's scope: the same orders as his list (an
 *  agent manager: his team's, listScopeSql), so the card's numbers match the page's. */
async function returnsOf(ctx: Ctx, from: string, to: string): Promise<number[]> {
  return (
    await ctx.db.query(`SELECT o.id FROM sales o WHERE ${RETURNS} AND ${BACK_AT} >= $1 AND ${BACK_AT} < $2${andSql(listScopeSql(ctx))}`, [from, to])
  ).map((r: any) => num(r.id));
}

// ---------------------------------------------------------------- who sees what
interface Scope {
  all: boolean;
  /** the teams whose names this manager sees */
  teams: Set<FaultTeam>;
  me: number;
}
async function scopeOf(ctx: Ctx): Promise<Scope> {
  const me = ctx.session.profile.id;
  const all = ctx.session.isAdmin || ctx.session.roles.includes('vendeur') || agencyLead(ctx);
  const teams = new Set<FaultTeam>();
  if (!all) {
    if (ctx.session.roles.includes('agent_manager')) {
      teams.add('confirmation');
      teams.add('suivi');
    }
    if (ctx.session.roles.includes('depot')) {
      const to: number[] = (await getSetting(ctx.db, 'depotAlerts')).to ?? [];
      if (to.includes(me)) teams.add('depot');
    }
  }
  return { all, teams, me };
}
const manages = (s: Scope) => s.all || s.teams.size > 0;
const seesName = (s: Scope, team: string, personId: number | null) => s.all || s.teams.has(team as FaultTeam) || (personId !== null && personId === s.me);

async function namesOf(db: Db, ids: (number | null)[]) {
  const list = [...new Set(ids.filter((x): x is number => !!x))];
  if (!list.length) return new Map<number, string>();
  return new Map<number, string>((await db.query('SELECT id, name FROM profiles WHERE id = ANY($1)', [list])).map((p: any) => [num(p.id), p.name as string]));
}

/** How many orders each person handled in the period (their own share): confirmed by him, prepared by him, followed. */
async function handledBy(db: Db, from: string, to: string) {
  const rows = await db.query(
    `SELECT e.user_id, e.kind, e.to_value, count(DISTINCT e.order_id)::int AS n FROM order_events e
     WHERE e.at >= $1 AND e.at < $2 AND e.user_id IS NOT NULL
       AND ((e.kind = 'conf_status' AND e.to_value = 'confirmed') OR (e.kind = 'follow_status' AND e.to_value = 'prepared'))
     GROUP BY 1, 2, 3`,
    [from, to],
  );
  const conf = new Map<number, number>();
  const prep = new Map<number, number>();
  for (const r of rows) (r.kind === 'conf_status' ? conf : prep).set(num(r.user_id), num(r.n));
  const fol = new Map<number, number>(
    (await db.query(`SELECT follow_agent_id AS u, count(*)::int AS n FROM orders WHERE shipped_at >= $1 AND shipped_at < $2 AND follow_agent_id IS NOT NULL GROUP BY 1`, [from, to])).map((r: any) => [
      num(r.u),
      num(r.n),
    ]),
  );
  return (team: string, u: number) => (team === 'confirmation' ? conf.get(u) : team === 'depot' ? prep.get(u) : team === 'suivi' ? fol.get(u) : undefined) ?? 0;
}

type Row = {
  id: number;
  order_id: number;
  moment: FaultMoment;
  reason: FaultReason;
  team: FaultTeam;
  person_id: number | null;
  person_label: string | null;
  cost: number;
  contest_at: string | null;
  contest_note: string | null;
  contest_by: number | null;
  decided_at: string | null;
  at: string;
  answers: Ans | null;
  note: string | null;
};
const toRow = (r: any): Row => ({
  id: num(r.id),
  order_id: num(r.order_id),
  moment: r.moment,
  reason: r.reason,
  team: r.team,
  person_id: r.person_id ? num(r.person_id) : null,
  person_label: r.person_label ?? null,
  cost: num(r.cost),
  contest_at: r.contest_at ? iso(r.contest_at) : null,
  contest_note: r.contest_note ?? null,
  contest_by: r.contest_by ? num(r.contest_by) : null,
  decided_at: r.decided_at ? iso(r.decided_at) : null,
  at: iso(r.at),
  answers: r.answers ?? null,
  note: r.note ?? null,
});
const pending = (r: Row) => !!r.contest_at && !r.decided_at;

/** A line as the user may see it: the person's name only for his own team (or himself, or every name for the chiefs). */
function shown(s: Scope, r: Row, names: Map<number, string>) {
  const named = seesName(s, r.team, r.person_id);
  return {
    id: r.id,
    orderId: r.order_id,
    moment: r.moment,
    reason: r.reason,
    team: r.team,
    who: named ? (r.person_id ? names.get(r.person_id) ?? null : r.person_label) : null,
    mine: r.person_id !== null && r.person_id === s.me,
    hidden: !named && (r.person_id !== null || !!r.person_label),
    cost: r.cost,
    contested: pending(r),
    contestNote: pending(r) && named ? r.contest_note : null,
    at: r.at,
  };
}

const ORDER_COLS = `o.id, o.ref, o.customer_name, o.total, o.wilaya_id, o.company_id, co.kind AS company_kind, co.name AS company,
  (SELECT string_agg(CASE WHEN i.qty > 1 THEN i.qty || ' × ' ELSE '' END || i.name, ' + ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items`;
async function ordersOf(db: Db, ids: number[]) {
  if (!ids.length) return new Map<number, any>();
  return new Map<number, any>(
    (await db.query(`SELECT ${ORDER_COLS} FROM orders o LEFT JOIN delivery_companies co ON co.id = o.company_id WHERE o.id = ANY($1)`, [ids])).map((o: any) => [
      num(o.id),
      { ref: o.ref, customer: o.customer_name ?? '', total: num(o.total), wilayaId: num(o.wilaya_id), companyId: o.company_id ? num(o.company_id) : null, companyKind: o.company_kind ?? null, company: o.company ?? null, items: o.items ?? '' },
    ]),
  );
}

// ---------------------------------------------------------------- the procedures
const Period = z.object({ from: dateStr, to: dateStr });

// ---------------------------------------------------------------- Dépôt › Statistiques (the owner's design, 28 Nov 2026)
// One page for the whole depot (the agreed PDF « Dépôt — Statistiques »): the orders that left it in the period, the
// median time from reaching the depot to leaving it, the late ones (over 48 h, LATE_MS above), and the depot's errors —
// the same lines as « Erreurs de livraison », found in the period — ÷ the orders sent, what they cost, by type, by
// person. Who sees it: whoever sees the depot's names here (the administrators, the seller, an agency's chiefs, the
// depot's managers of Management › Alertes dépôt). A tap opens « Erreurs de livraison » with the same filters.
const PER = z.enum(['today', 'yesterday', '7', '30', 'month', 'custom']);
const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/** Statistiques' filters: the period (Algiers days, as Confirmation › Confirmées), who prepared, the product */
const DepotIn = z.object({ per: PER.default('30'), from: DAY.optional(), to: DAY.optional(), agent: id.optional(), product: id.optional() });
/** « Erreurs de livraison »: a period given as from / to, or Statistiques' (per); then a person, a product, a type */
const DepotErrIn = z.object({
  from: dateStr.optional(),
  to: dateStr.optional(),
  /** Statistiques' period; with « custom », `from` / `to` are its days */
  per: PER.optional(),
  agent: id.optional(),
  product: id.optional(),
  reason: reasonZ.optional(),
  /** the depot's errors without a person (« Sans nom ») */
  none: z.boolean().optional(),
});

/** [from, to) of a request: Statistiques' period, else the `from` / `to` given. */
function bounds(ctx: Ctx, i: { per?: z.infer<typeof PER>; from?: string; to?: string }) {
  if (i.per) {
    const r = kfRange(ctx.now(), { per: i.per, from: i.from, to: i.to });
    return { from: new Date(r.a).toISOString(), to: new Date(r.b).toISOString() };
  }
  if (!i.from || !i.to) throw bad('Choisissez une période');
  return { from: i.from, to: i.to };
}

const msOf = (v: unknown) => (v ? new Date(v as string).getTime() : null);
function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The orders that left the depot in [from, to): when they reached it (their confirmation; for one confirmed without
 *  stock, the moment the stock came back — that wait is not the depot's) and who prepared them (the last « Préparée »,
 *  the pay's person). */
async function sentOf(db: Db, from: string, to: string) {
  const rows = await db.query(
    `SELECT o.id, o.ref, o.customer_name, o.shipped_at,
            GREATEST(o.confirmed_at, (SELECT max(e.at) FROM order_events e WHERE e.order_id = o.id AND e.kind = 'conf_status' AND e.from_value = 'no_stock' AND e.to_value = 'confirmed')) AS start,
            (SELECT e.user_id FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'prepared' ORDER BY e.at DESC LIMIT 1) AS prep
       FROM sales o WHERE o.shipped_at >= $1 AND o.shipped_at < $2`,
    [from, to],
  );
  return rows.map((r: any) => {
    const start = msOf(r.start);
    const sent = msOf(r.shipped_at) ?? 0;
    return { id: num(r.id), ref: String(r.ref), customer: String(r.customer_name ?? ''), start, sent, wait: start !== null && sent >= start ? sent - start : null, prep: r.prep ? num(r.prep) : null };
  });
}

/** Each order's products (the « Produit » filter and its choices). */
async function productsOf(db: Db, ids: number[]) {
  const by = new Map<number, Set<number>>();
  const names = new Map<number, string>();
  if (!ids.length) return { by, names };
  for (const r of await db.query('SELECT DISTINCT i.order_id, p.id, p.name FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ANY($1)', [ids])) {
    const o = num(r.order_id);
    if (!by.has(o)) by.set(o, new Set());
    by.get(o)!.add(num(r.id));
    names.set(num(r.id), String(r.name));
  }
  return { by, names };
}
const productChoices = (names: Map<number, string>) => [...names.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

/** The depot's errors found in [from, to): the lines of « Erreurs de livraison », newest first. */
async function depotFaults(db: Db, from: string, to: string) {
  return (await db.query(`SELECT * FROM order_faults WHERE team = 'depot' AND at >= $1 AND at < $2 ORDER BY at DESC`, [from, to])).map(toRow);
}

/** The people of the « Agent » filter: the depot's, and whoever else prepared or made an error in the period. */
async function depotPeople(db: Db, ids: number[]) {
  return (await db.query(`SELECT id, name FROM profiles WHERE ('depot' = ANY(roles) AND active) OR id = ANY($1) ORDER BY lower(name)`, [ids])).map((r: any) => ({ id: num(r.id), name: String(r.name) }));
}

/** Statistiques and its « En retard » list: the period's orders sent and errors, with the filters applied. */
async function depotData(ctx: Ctx, i: z.infer<typeof DepotIn>) {
  const { from, to } = bounds(ctx, i);
  await ensureFaults(ctx.db, await returnsOf(ctx, from, to));
  const sent0 = await sentOf(ctx.db, from, to);
  const faults0 = await depotFaults(ctx.db, from, to);
  const prods = await productsOf(ctx.db, [...new Set([...sent0.map((o) => o.id), ...faults0.map((r) => r.order_id)])]);
  const kept = (orderId: number) => !i.product || !!prods.by.get(orderId)?.has(i.product);
  return {
    sent: sent0.filter((o) => kept(o.id) && (!i.agent || o.prep === i.agent)),
    faults: faults0.filter((r) => kept(r.order_id) && (!i.agent || r.person_id === i.agent)),
    sent0,
    faults0,
    prods,
  };
}
const late = (o: { wait: number | null }) => o.wait !== null && o.wait > LATE_MS;

export const faultsProcs = {
  /** Commandes › Annulé › Retours: who is responsible for the parcels that came back in the period, team by team. */
  'faults.summary': proc(['confirmation', 'suivi', 'depot', 'agent_manager'], Period, async (ctx, i) => {
    const s = await scopeOf(ctx);
    if (!manages(s)) return { scope: 'mine' as const };
    const ids = await returnsOf(ctx, i.from, i.to);
    await ensureFaults(ctx.db, ids);
    const rows = ids.length ? (await ctx.db.query('SELECT * FROM order_faults WHERE order_id = ANY($1)', [ids])).map(toRow) : [];
    const names = await namesOf(ctx.db, rows.map((r) => r.person_id));
    const handled = await handledBy(ctx.db, i.from, i.to);
    const teams = FAULT_TEAMS.filter((t) => t !== 'client' && t !== 'unknown').map((team) => {
      const mine = rows.filter((r) => r.team === team);
      const reasons = count(mine.map((r) => r.reason)).map(([reason, n]) => ({ reason: reason as FaultReason, n }));
      const named = s.all || s.teams.has(team);
      const people = named
        ? count(mine.map((r) => (r.person_id ? `u${r.person_id}` : r.person_label ? `l${r.person_label}` : ''))).filter(([k]) => k).map(([k, n]) => {
            const u = k.startsWith('u') ? Number(k.slice(1)) : null;
            const h = u ? handled(team, u) : 0;
            return { name: u ? names.get(u) ?? '—' : k.slice(1), n, of: h || null };
          })
        : null;
      return { team, n: mine.length, cost: sum(mine.map((r) => r.cost)), reasons, people };
    });
    const client = rows.filter((r) => r.team === 'client');
    const unknown = rows.filter((r) => r.team === 'unknown');
    // « Pas moi » waiting: every one for the chiefs (they decide), his teams' ones for a manager
    const waits = (
      await ctx.db.query(
        `SELECT f.* FROM order_faults f JOIN orders o ON o.id = f.order_id WHERE f.contest_at IS NOT NULL AND f.decided_at IS NULL${andSql(listScopeSql(ctx))} ORDER BY f.contest_at DESC LIMIT 50`,
      )
    )
      .map(toRow)
      .filter((r) => s.all || s.teams.has(r.team));
    const wNames = await namesOf(ctx.db, [...waits.map((r) => r.person_id), ...waits.map((r) => r.contest_by)]);
    const wOrders = await ordersOf(ctx.db, waits.map((r) => r.order_id));
    return {
      scope: s.all ? ('all' as const) : ('manager' as const),
      returns: ids.length,
      cost: sum(rows.map((r) => r.cost)),
      teams,
      client: { n: client.length, cost: sum(client.map((r) => r.cost)), reasons: count(client.map((r) => r.reason)).map(([reason, n]) => ({ reason: reason as FaultReason, n })) },
      unknown: unknown.length,
      waiting: waits.map((r) => ({ ...shown(s, r, wNames), by: r.contest_by ? wNames.get(r.contest_by) ?? null : null, note: r.contest_note, order: wOrders.get(r.order_id) ?? null })),
      canDecide: s.all && !agencyLead(ctx),
    };
  }),

  /** The responsible of each order of a list (Commandes › Annulé): the team, and a name only where the user may see it. */
  'faults.forOrders': proc(['confirmation', 'suivi', 'depot', 'agent_manager'], z.object({ ids: z.array(id).max(500) }), async (ctx, i) => {
    const out: Record<string, ReturnType<typeof shown>> = {};
    if (!i.ids.length || noOrderAccess(ctx)) return out;
    const ok = (await ctx.db.query(`SELECT o.id FROM orders o WHERE o.id = ANY($1)${andSql(rowScopeSql(ctx))}`, [i.ids])).map((r: any) => num(r.id));
    await ensureFaults(ctx.db, ok);
    if (!ok.length) return out;
    const s = await scopeOf(ctx);
    const rows = (await ctx.db.query('SELECT * FROM order_faults WHERE order_id = ANY($1)', [ok])).map(toRow);
    const names = await namesOf(ctx.db, rows.map((r) => r.person_id));
    for (const r of rows) out[String(r.order_id)] = shown(s, r, names);
    return out;
  }),

  /** An agent's own errors (his dashboard, the depot's « Mes erreurs »): never anyone else's. */
  'faults.mine': proc(null, Period, async (ctx, i) => {
    const me = ctx.session.profile.id;
    await ensureFaults(ctx.db, (await ctx.db.query(`SELECT o.id FROM sales o WHERE ${RETURNS} AND ${BACK_AT} >= $1 AND ${BACK_AT} < $2`, [i.from, i.to])).map((r: any) => num(r.id)));
    const rows = (await ctx.db.query('SELECT * FROM order_faults WHERE person_id = $1 AND at >= $2 AND at < $3 ORDER BY at DESC', [me, i.from, i.to])).map(toRow);
    const orders = await ordersOf(ctx.db, rows.map((r) => r.order_id));
    const handled = await handledBy(ctx.db, i.from, i.to);
    const team = rows[0]?.team ?? (ctx.session.roles.includes('confirmation') ? 'confirmation' : ctx.session.roles.includes('depot') ? 'depot' : ctx.session.roles.includes('suivi') ? 'suivi' : null);
    const mineN = team ? handled(team, me) : 0;
    // the team's share, to compare with (no one's name)
    let teamRate: number | null = null;
    if (team === 'confirmation' || team === 'depot' || team === 'suivi') {
      const t = num((await ctx.db.query('SELECT count(*)::int n FROM order_faults WHERE team = $1 AND at >= $2 AND at < $3', [team, i.from, i.to]))[0]?.n);
      const all = num(
        (
          await ctx.db.query(
            team === 'suivi'
              ? 'SELECT count(*)::int n FROM orders WHERE shipped_at >= $1 AND shipped_at < $2 AND follow_agent_id IS NOT NULL'
              : `SELECT count(DISTINCT order_id)::int n FROM order_events WHERE at >= $1 AND at < $2 AND user_id IS NOT NULL AND kind = $3 AND to_value = $4`,
            team === 'suivi' ? [i.from, i.to] : [i.from, i.to, team === 'confirmation' ? 'conf_status' : 'follow_status', team === 'confirmation' ? 'confirmed' : 'prepared'],
          )
        )[0]?.n,
      );
      teamRate = all ? t / all : null;
    }
    return {
      n: rows.length,
      handled: mineN || null,
      rate: mineN ? rows.length / mineN : null,
      teamRate,
      list: rows.slice(0, 30).map((r) => ({ id: r.id, orderId: r.order_id, moment: r.moment, reason: r.reason, team: r.team, at: r.at, contested: pending(r), decided: !!r.decided_at, order: orders.get(r.order_id) ?? null })),
    };
  }),

  /** Dépôt › Erreurs de livraison: the depot's errors (the returns and the SAV after delivery). Its managers (and the
   *  chiefs) see the depot's names; a depot agent his own errors only. */
  'faults.depot': proc(['depot'], DepotErrIn, async (ctx, i) => {
    const s = await scopeOf(ctx);
    const boss = s.all || s.teams.has('depot');
    const { from, to } = bounds(ctx, i);
    await ensureFaults(ctx.db, await returnsOf(ctx, from, to));
    // an agent: his own errors only; the depot's chiefs: a person (or « Sans nom »), a product, a type
    const all = (await depotFaults(ctx.db, from, to)).filter((r) => boss || r.person_id === s.me);
    const prods = await productsOf(ctx.db, all.map((r) => r.order_id));
    const rows = all.filter(
      (r) =>
        (!i.product || !!prods.by.get(r.order_id)?.has(i.product)) &&
        (!i.reason || r.reason === i.reason) &&
        (!boss || ((!i.agent || r.person_id === i.agent) && (!i.none || r.person_id === null))),
    );
    const names = await namesOf(ctx.db, rows.map((r) => r.person_id));
    const orders = await ordersOf(ctx.db, rows.slice(0, 300).map((r) => r.order_id));
    const handled = await handledBy(ctx.db, from, to);
    const people = boss
      ? count(rows.map((r) => (r.person_id ? String(r.person_id) : ''))).filter(([k]) => k).map(([k, n]) => ({ name: names.get(Number(k)) ?? '—', n, of: handled('depot', Number(k)) || null }))
      : null;
    return {
      scope: boss ? ('team' as const) : ('mine' as const),
      n: rows.length,
      returns: rows.filter((r) => r.moment !== 'sav').length,
      sav: rows.filter((r) => r.moment === 'sav').length,
      cost: sum(rows.map((r) => r.cost)),
      reasons: count(rows.map((r) => r.reason)).map(([reason, n]) => ({ reason: reason as FaultReason, n })),
      people,
      mineRate: !boss && handled('depot', s.me) ? rows.length / handled('depot', s.me) : null,
      // the filters' choices (the chiefs): the depot's people, the products of the period's errors
      agents: boss ? await depotPeople(ctx.db, [...new Set(all.map((r) => r.person_id).filter((x): x is number => x !== null))]) : null,
      products: boss ? productChoices(prods.names) : null,
      list: rows.slice(0, 300).map((r) => ({ ...shown(s, r, names), order: orders.get(r.order_id) ?? null, contestNote: pending(r) && (boss || r.person_id === s.me) ? r.contest_note : null })),
    };
  }),

  /** Does this person see Dépôt › Statistiques (its tab in the depot's bar)? The ones who see the depot's names. */
  'depot.statsOn': proc(['depot'], z.object({}), async (ctx) => {
    const s = await scopeOf(ctx);
    return { on: s.all || s.teams.has('depot') };
  }),

  /** Dépôt › Statistiques: the cards, the errors by type, each person (« Sans nom »: the errors without a person, and
   *  orders sent with nobody's « Préparée »). */
  'depot.stats': proc(['depot'], DepotIn, async (ctx, i) => {
    const s = await scopeOf(ctx);
    if (!(s.all || s.teams.has('depot'))) throw forbidden();
    const { sent, faults, sent0, faults0, prods } = await depotData(ctx, i);
    const ids = [...new Set([...sent.map((o) => o.prep), ...faults.map((r) => r.person_id)])].filter((x): x is number => x !== null);
    const names = await namesOf(ctx.db, ids);
    const people = ids
      .map((pid) => ({ id: pid, name: names.get(pid) ?? '—', prepared: sent.filter((o) => o.prep === pid).length, errors: faults.filter((r) => r.person_id === pid).length }))
      .sort((a, b) => b.prepared - a.prepared || b.errors - a.errors || a.name.localeCompare(b.name));
    const none = { prepared: sent.filter((o) => o.prep === null).length, errors: faults.filter((r) => r.person_id === null).length };
    const everyone = [...new Set([...sent0.map((o) => o.prep), ...faults0.map((r) => r.person_id)])].filter((x): x is number => x !== null);
    return {
      sent: sent.length,
      medianMs: median(sent.map((o) => o.wait).filter((x): x is number => x !== null)),
      late: sent.filter(late).length,
      errors: faults.length,
      cost: sum(faults.map((r) => r.cost)),
      reasons: count(faults.map((r) => r.reason)).map(([reason, n]) => ({ reason: reason as FaultReason, n })),
      people,
      none: none.prepared || none.errors ? none : null,
      agents: await depotPeople(ctx.db, everyone),
      products: productChoices(prods.names),
    };
  }),

  /** « En retard »: the orders sent more than 48 h after reaching the depot, the slowest first. */
  'depot.late': proc(['depot'], DepotIn, async (ctx, i) => {
    const s = await scopeOf(ctx);
    if (!(s.all || s.teams.has('depot'))) throw forbidden();
    const { sent } = await depotData(ctx, i);
    const rows = sent.filter(late).sort((a, b) => b.wait! - a.wait!);
    const names = await namesOf(ctx.db, rows.map((o) => o.prep));
    return {
      total: rows.length,
      rows: rows.slice(0, 300).map((o) => ({ orderId: o.id, ref: o.ref, customer: o.customer, start: new Date(o.start!).toISOString(), sent: new Date(o.sent).toISOString(), wait: o.wait!, by: o.prep ? names.get(o.prep) ?? null : null })),
    };
  }),

  /** What the report sheet shows of an order: its first product, the colour or size ordered and that product's others. */
  'faults.order': proc(['confirmation', 'suivi', 'sav', 'depot', 'agent_manager'], z.object({ orderId: id.optional(), ticketId: id.optional() }), async (ctx, i) => {
    let orderId = i.orderId ?? null;
    if (i.ticketId) {
      const t = (await ctx.db.query('SELECT order_id FROM complaints WHERE id = $1', [i.ticketId]))[0];
      if (!t) throw notFound('Ticket introuvable');
      orderId = t.order_id ? num(t.order_id) : null;
    }
    if (!orderId) throw bad('Choisissez la commande');
    const o = (
      await ctx.db.query(
        `SELECT o.id, o.ref, o.customer_name,
           (SELECT i.product_id FROM order_items i WHERE i.order_id = o.id ORDER BY i.id LIMIT 1) AS product_id,
           (SELECT i.name FROM order_items i WHERE i.order_id = o.id ORDER BY i.id LIMIT 1) AS product,
           (SELECT i.variant_title FROM order_items i WHERE i.order_id = o.id ORDER BY i.id LIMIT 1) AS variant,
           (SELECT coalesce(sum(i.qty), 0) FROM order_items i WHERE i.order_id = o.id) AS qty
         FROM orders o WHERE o.id = $1${andSql(rowScopeSql(ctx))}`,
        [orderId],
      )
    )[0];
    if (!o) throw notFound('Commande introuvable');
    const variants = o.product_id ? (await ctx.db.query(`SELECT title FROM product_variants WHERE product_id = $1 AND title <> '' ORDER BY id LIMIT 24`, [o.product_id])).map((r: any) => String(r.title)) : [];
    const cur = (await ctx.db.query('SELECT reason, decided_at FROM order_faults WHERE order_id = $1', [orderId]))[0];
    return {
      orderId,
      ref: String(o.ref),
      customer: String(o.customer_name ?? ''),
      product: o.product ? String(o.product) : null,
      variant: o.variant ? String(o.variant) : null,
      qty: num(o.qty),
      variants: [...new Set([...(o.variant ? [String(o.variant)] : []), ...variants])],
      /** already decided by the admins: a report changes nothing any more */
      decided: !!cur?.decided_at,
    };
  }),

  /** An agent says what happened (Suivi « Client annule », Annulé « Préciser », a SAV ticket): Pilotix decides who. */
  'faults.report': proc(
    ['confirmation', 'suivi', 'sav', 'depot', 'agent_manager'],
    z.object({
      orderId: id.optional(),
      ticketId: id.optional(),
      moment: z.enum(['return', 'swap', 'sav']),
      reason: reasonZ,
      answers: Answers,
      note: z.string().trim().max(1000).optional(),
      /** after delivery: the customer's photo (a small JPEG, data URL) */
      photo: z.string().max(900_000).regex(/^data:image\/(jpeg|png|webp);base64,/).optional(),
    }),
    async (ctx, i) => {
      let orderId = i.orderId ?? null;
      if (i.ticketId) {
        const t = (await ctx.db.query('SELECT order_id FROM complaints WHERE id = $1', [i.ticketId]))[0];
        if (!t) throw notFound('Ticket introuvable');
        orderId = t.order_id ? num(t.order_id) : null;
      }
      if (!orderId) throw bad('Choisissez la commande');
      const seen = (await ctx.db.query(`SELECT o.id FROM orders o WHERE o.id = $1${andSql(rowScopeSql(ctx))}`, [orderId]))[0];
      if (!seen) throw notFound('Commande introuvable');
      const ask = FAULT_ASK[i.reason];
      if (ask === 'variant' && !i.answers.variant) throw bad('Quelle couleur ou taille le client a-t-il ?');
      if (ask === 'qty' && i.answers.qty === undefined) throw bad('Combien le client en a-t-il reçu ?');
      if (ask === 'sealed' && i.answers.sealed === undefined) throw bad('La boîte était-elle fermée d’usine ?');
      // after delivery the customer has the product: his photo shows it (before it, the depot checks the parcel back)
      if (i.moment === 'sav' && FAULT_SEEN.has(i.reason) && !i.photo) throw bad('Ajoutez la photo du client');
      const facts = (await loadFacts(ctx.db, [orderId])).get(orderId);
      if (!facts) throw notFound('Commande introuvable');
      const d = decide(i.reason, facts, i.answers);
      const cur = (await ctx.db.query('SELECT decided_at FROM order_faults WHERE order_id = $1', [orderId]))[0];
      // an admin's decision stands: a new report after it changes nothing
      if (cur?.decided_at) throw bad('Déjà décidé par l’admin');
      await ctx.db.query(
        `INSERT INTO order_faults (order_id, moment, reason, team, person_id, person_label, reported_by, answers, note, photo, ticket_id, cost, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         ON CONFLICT (order_id) DO UPDATE SET moment = EXCLUDED.moment, reason = EXCLUDED.reason, team = EXCLUDED.team, person_id = EXCLUDED.person_id,
           person_label = EXCLUDED.person_label, reported_by = EXCLUDED.reported_by, answers = EXCLUDED.answers, note = EXCLUDED.note,
           photo = coalesce(EXCLUDED.photo, order_faults.photo), ticket_id = coalesce(EXCLUDED.ticket_id, order_faults.ticket_id),
           contest_by = NULL, contest_note = NULL, contest_at = NULL, updated_at = now()`,
        [orderId, i.moment, i.reason, d.team, d.personId, d.personLabel, ctx.session.profile.id, JSON.stringify(i.answers ?? {}), i.note || null, i.photo ?? null, i.ticketId ?? null, i.moment === 'sav' ? 0 : facts.cost],
      );
      // the agent never learns who it is: only that it is noted
      return { ok: true };
    },
  ),

  /** « Pas moi »: the person — or a manager of his team — says it is not him. The admins or the seller decide. */
  'faults.contest': proc(null, z.object({ id, note: z.string().trim().min(3).max(500) }), async (ctx, i) => {
    const r = (await ctx.db.query('SELECT * FROM order_faults WHERE id = $1', [i.id])).map(toRow)[0];
    if (!r) throw notFound('Introuvable');
    const s = await scopeOf(ctx);
    if (r.person_id !== s.me && !s.teams.has(r.team) && !s.all) throw forbidden('Ce n’est pas votre équipe');
    if (r.decided_at) throw bad('Déjà décidé');
    await ctx.db.query('UPDATE order_faults SET contest_by = $2, contest_note = $3, contest_at = now(), updated_at = now() WHERE id = $1', [i.id, s.me, i.note]);
    return { ok: true };
  }),

  /** The admins or the seller decide a « Pas moi »: keep it, give it to another team, or nobody's fault (the customer). */
  'faults.decide': proc(['vendeur'], z.object({ id, action: z.enum(['keep', 'team', 'none']), team: teamZ.optional() }), async (ctx, i) => {
    if (agencyLead(ctx) && !ctx.session.isAdmin) throw forbidden('Le vendeur décide');
    const r = (await ctx.db.query('SELECT * FROM order_faults WHERE id = $1', [i.id])).map(toRow)[0];
    if (!r) throw notFound('Introuvable');
    let team: FaultTeam = r.team;
    let personId = r.person_id;
    let label = r.person_label;
    if (i.action === 'none') {
      team = 'client';
      personId = null;
      label = null;
    }
    if (i.action === 'team') {
      if (!i.team || i.team === r.team) throw bad('Choisissez une autre équipe');
      team = i.team;
      // the person in the new team: what the history says (who confirmed, who prepared…)
      const facts = (await loadFacts(ctx.db, [r.order_id])).get(r.order_id);
      const d = facts ? decide(teamReason(team), facts) : null;
      personId = d && d.team === team ? d.personId : null;
      label = d && d.team === team ? d.personLabel : null;
    }
    await ctx.db.query('UPDATE order_faults SET team = $2, person_id = $3, person_label = $4, decided_by = $5, decided_at = now(), updated_at = now() WHERE id = $1', [
      i.id,
      team,
      personId,
      label,
      ctx.session.profile.id,
    ]);
    return { ok: true };
  }),
};

/** a reason that gives this team (to find its person when an admin moves a line to it) */
function teamReason(team: FaultTeam): FaultReason {
  const fixed = (Object.entries(FAULT_FIXED) as [FaultReason, FaultTeam][]).find(([, t]) => t === team);
  if (fixed) return fixed[0];
  return team === 'confirmation' ? 'price_call' : 'other';
}

function count(keys: string[]): [string, number][] {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** For the tests: the rules on a hand-made order. */
export const _test = { decide, autoReason, loadFacts };
