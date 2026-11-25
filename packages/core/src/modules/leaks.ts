// Contrôle (the owner's ask, 25 Nov 2026): « always everything matched between the depot, Pilotix and each delivery
// company, anything wrong we know ». Every full courier sync (30 minutes, after the companies' news and payments came
// in) reads the facts, finds each disagreement with the rules (leaks/rules.ts: each company alone, with its own delays)
// and keeps it as a case:
// - a new case is told once to who acts (the depot's people, the suivi, the owners), grouped by company — never on the
//   very first check of a shop (what was already there is shown, not rung);
// - what Pilotix can do alone, it does: a parcel the company stopped (« Commande annulée », « Ne répond pas 3 », a return)
//   while Pilotix still said « En livraison » goes to Suivi › Alertes at once (PX1254, PX1276 on 24 Nov 2026);
// - a case closes by itself as soon as they agree again (the scan came, the money came, the words were followed);
//   « C'est vu » sets one aside while it lasts (it is not counted or rung again).
// The money cases are for the people with Contrôle › Argent (the owners by default).
import { LEAK_AREAS, LEAK_KINDS, leakArea, leakQuiet, leakWho, type CourierKind, type FollowStatus, type LeakArea, type LeakKind } from '@pilotix/shared';
import { z } from 'zod';
import { iso, isoOrNull, num } from '../db';
import { findLeaks, type LeakFacts, type LeakFinding, type LeakHealth, type LeakKnown, type LeakParcel, type LeakPayout } from '../leaks/rules';
import { bad, Ctx, forbidden, notFound, proc, withActionLock } from '../rpc';
import { agencyOf } from './agencyscope';
import { recipients as depotPeople } from './depotalerts';
import { addEvent, setFollow } from './orders';
import { sendPush } from './push';
import { can } from './rights';

const isDemo = (ctx: Ctx) => !ctx.server;
const sys = (ctx: Ctx): Ctx => ({ ...ctx, session: { ...ctx.session, roles: [...ctx.session.roles, 'admin'], isAdmin: true } });
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : (v ?? null));
const at = (ctx: Ctx) => new Date(ctx.now()).toISOString();
/** the same object, written the same way whatever the order of its keys (jsonb keeps its own order) */
const stable = (v: unknown): string =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? `{${Object.keys(v as object)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`)
        .join(',')}}`
    : JSON.stringify(v ?? null);

// ---------------------------------------------------------------- how each company answered
/** Kept after each full sync: since when a company fails (a good answer clears it). */
export async function saveHealth(ctx: Ctx, list: { companyId: number; error: string | null }[]) {
  for (const h of list)
    await ctx.db.query(
      `INSERT INTO courier_health (company_id, ok_at, error, error_since, checked_at) VALUES ($1, CASE WHEN $2::text IS NULL THEN $3::timestamptz END, $2, CASE WHEN $2::text IS NULL THEN NULL ELSE $3::timestamptz END, $3)
       ON CONFLICT (company_id) DO UPDATE SET ok_at = CASE WHEN EXCLUDED.error IS NULL THEN $3::timestamptz ELSE courier_health.ok_at END, error = EXCLUDED.error,
         error_since = CASE WHEN EXCLUDED.error IS NULL THEN NULL ELSE COALESCE(courier_health.error_since, $3::timestamptz) END, checked_at = $3::timestamptz`,
      [h.companyId, h.error ? String(h.error).slice(0, 300) : null, at(ctx)],
    );
}

// ---------------------------------------------------------------- the facts
const EV = (where: string, agg = 'max') => `(SELECT ${agg}(e.at) FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND ${where})`;
const DEPOT_OUT = EV(`e.note LIKE '%scan dispatch%'`, 'min');
const DEPOT_BACK = EV(`e.to_value = 'returned' AND coalesce(e.data->>'courier', '') <> 'true'`);
const COURIER_BACK = EV(`e.to_value = 'returned' AND e.data->>'courier' = 'true'`);
const SWAPPED = `EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.data ? 'swap_from')`;

export async function readFacts(ctx: Ctx): Promise<LeakFacts> {
  const now = at(ctx);
  const companies = (await ctx.db.query('SELECT id, name, kind, active FROM delivery_companies ORDER BY id')).map((c: any) => ({ id: num(c.id), name: c.name as string, kind: c.kind as CourierKind, active: !!c.active }));
  const parcels: LeakParcel[] = (
    await ctx.db.query(
      `SELECT o.id, o.ref, o.tracking, o.company_id, o.conf_status, o.follow_status, o.sub_status, o.total, o.delivery_cost, o.is_exchange,
         o.prepared_at, o.taken_at, o.delivered_at, o.returning_at, o.cashed, o.send_error, o.updated_at,
         o.ext_status, o.ext_status_at, o.ext_meaning, o.ext_meaning_of,
         ${DEPOT_OUT} AS depot_out_at, ${DEPOT_BACK} AS depot_back_at, ${COURIER_BACK} AS courier_back_at, ${EV(`e.to_value = 'alert'`)} AS alert_at, ${SWAPPED} AS swapped
       FROM orders o
       WHERE o.company_id IS NOT NULL AND (
         o.follow_status IN ('prepared','shipped','out_for_delivery','failed','alert','in_exchange','returning')
         OR (o.follow_status IN ('delivered','exchanged') AND (NOT o.cashed OR o.delivered_at > $1::timestamptz - interval '30 days'))
         OR (o.follow_status = 'returned' AND o.returned_at > $1::timestamptz - interval '45 days')
         OR (o.follow_status = 'cancelled' AND (o.taken_at IS NOT NULL OR o.shipped_at IS NOT NULL) AND o.updated_at > $1::timestamptz - interval '60 days')
         OR o.id IN (SELECT order_id FROM leak_cases WHERE closed_at IS NULL AND order_id IS NOT NULL))
       ORDER BY o.id DESC LIMIT 20000`,
      [now],
    )
  ).map((r: any) => ({
    id: num(r.id),
    ref: r.ref,
    tracking: r.tracking ?? null,
    companyId: num(r.company_id),
    conf: r.conf_status,
    follow: (r.follow_status ?? null) as FollowStatus | null,
    sub: r.sub_status ?? null,
    total: num(r.total),
    cost: num(r.delivery_cost),
    isExchange: !!r.is_exchange,
    preparedAt: isoOrNull(r.prepared_at),
    takenAt: isoOrNull(r.taken_at),
    deliveredAt: isoOrNull(r.delivered_at),
    returningAt: isoOrNull(r.returning_at),
    cashed: !!r.cashed,
    sendError: r.send_error ?? null,
    updatedAt: isoOrNull(r.updated_at),
    words: r.ext_status ?? null,
    wordsAt: isoOrNull(r.ext_status_at),
    meaning: r.ext_meaning ?? null,
    meaningWords: r.ext_meaning_of ?? null,
    depotOutAt: isoOrNull(r.depot_out_at),
    depotBackAt: isoOrNull(r.depot_back_at),
    courierBackAt: isoOrNull(r.courier_back_at),
    alertAt: isoOrNull(r.alert_at),
    swapped: !!r.swapped,
  }));
  const payouts: LeakPayout[] = (
    await ctx.db.query(
      `SELECT p.id, p.company_id, p.ref, p.ext_id, p.amount, p.done, p.at, p.done_at, p.imported_at, p.lines,
         CASE WHEN p.handover_id IS NULL AND p.move_id IS NULL THEN true
              ELSE COALESCE((SELECT h.cancelled_at IS NULL FROM cash_handovers h WHERE h.id = p.handover_id), false) OR COALESCE((SELECT m.cancelled_at IS NULL FROM cash_moves m WHERE m.id = p.move_id), false) END AS in_caisse
       FROM courier_payments p WHERE COALESCE(p.at, p.created_at) > $1::timestamptz - interval '120 days' ORDER BY p.id`,
      [now],
    )
  ).map((p: any) => {
    const lines = parse(p.lines);
    return {
      id: num(p.id),
      companyId: num(p.company_id),
      ref: p.ref ?? String(p.ext_id).slice(0, 12),
      amount: num(p.amount),
      done: !!p.done,
      at: isoOrNull(p.at),
      doneAt: isoOrNull(p.done_at),
      importedAt: isoOrNull(p.imported_at),
      inCaisse: !!p.in_caisse,
      lines: Array.isArray(lines)
        ? lines.map((l: any) => ({ tracking: l?.tracking ? String(l.tracking) : null, amount: Math.round(num(l?.amount)), costs: Math.round(num(l?.costs)), delivery: typeof l?.fees?.delivery === 'number' ? l.fees.delivery : null }))
        : null,
    };
  });
  // the orders the payments name that are not followed any more (delivered and received long ago, back at the depot…)
  const followed = new Set(parcels.filter((p) => p.tracking).map((p) => `${p.companyId}:${p.tracking}`));
  const want = new Map<number, Set<string>>();
  for (const p of payouts) for (const l of p.lines ?? []) if (l.tracking && l.amount > 0 && !followed.has(`${p.companyId}:${l.tracking}`)) want.set(p.companyId, (want.get(p.companyId) ?? new Set()).add(l.tracking));
  const known: LeakKnown[] = [];
  for (const [companyId, tracks] of want)
    for (const r of await ctx.db.query(
      `SELECT o.id, o.ref, o.company_id, o.tracking, o.follow_status, o.conf_status, o.total, o.delivery_cost, o.taken_at, o.is_exchange,
         ${DEPOT_BACK} AS depot_back_at, ${DEPOT_OUT} AS depot_out_at, ${SWAPPED} AS swapped
       FROM orders o WHERE o.company_id = $1 AND o.tracking = ANY($2)`,
      [companyId, [...tracks]],
    ))
      known.push({
        id: num(r.id),
        ref: r.ref,
        companyId: num(r.company_id),
        tracking: r.tracking,
        follow: r.follow_status ?? null,
        total: num(r.total),
        cost: num(r.delivery_cost),
        depotBack: !!r.depot_back_at,
        neverLeft: (r.follow_status === 'cancelled' || ['cancelled', 'duplicate', 'wrong_number', 'fake'].includes(r.conf_status)) && !r.taken_at && !r.depot_out_at,
        isExchange: !!r.is_exchange,
        swapped: !!r.swapped,
      });
  const health: LeakHealth[] = (await ctx.db.query('SELECT company_id, ok_at, error, error_since FROM courier_health')).map((h: any) => ({
    companyId: num(h.company_id),
    okAt: isoOrNull(h.ok_at),
    error: h.error ?? null,
    errorSince: isoOrNull(h.error_since),
  }));
  return { now: ctx.now(), companies, parcels, payouts, health, known };
}

// ---------------------------------------------------------------- the cases
const RUN_KEY = 'leaksRun';
async function lastRun(ctx: Ctx): Promise<{ at: string; found: number; opened: number; closed: number; acted: number } | null> {
  const v = parse((await ctx.db.query('SELECT value FROM settings WHERE key = $1', [RUN_KEY]))[0]?.value);
  return v && typeof v.at === 'string' ? v : null;
}

/** One check: the facts read, each disagreement kept as a case (new ones told and acted on), the agreed ones closed. */
export async function leakRun(ctx: Ctx, sync?: { companyId: number; error: string | null }[]) {
  return withActionLock(ctx.db, 'leaks:run', ctx.session.profile.id, 'Un contrôle est déjà en cours', async () => {
    if (sync?.length) await saveHealth(ctx, sync);
    const first = !(await lastRun(ctx));
    const facts = await readFacts(ctx);
    const found = findLeaks(facts);
    const now = at(ctx);
    const live = await ctx.db.query('SELECT id, key, amount, details, since FROM leak_cases WHERE closed_at IS NULL');
    const byKey = new Map<string, any>(live.map((r: any) => [r.key as string, r]));
    const keys = new Set(found.map((x) => x.key));
    // agreed again: closed by itself
    const gone = live.filter((r: any) => !keys.has(r.key)).map((r: any) => num(r.id));
    if (gone.length) await ctx.db.query(`UPDATE leak_cases SET closed_at = $2::timestamptz, closed_by = 'auto' WHERE id = ANY($1) AND closed_at IS NULL`, [gone, now]);
    if (found.length) await ctx.db.query('UPDATE leak_cases SET last_seen = $2::timestamptz WHERE closed_at IS NULL AND key = ANY($1)', [[...keys], now]);
    const fresh: (LeakFinding & { id: number })[] = [];
    for (const x of found) {
      const had = byKey.get(x.key);
      if (had) {
        if (num(had.amount) !== x.amount || stable(parse(had.details)) !== stable(x.details) || isoOrNull(had.since) !== (x.since ? new Date(x.since).toISOString() : null))
          await ctx.db.query('UPDATE leak_cases SET amount = $2, details = $3, since = $4 WHERE id = $1', [had.id, x.amount, JSON.stringify(x.details), x.since]);
        continue;
      }
      const r = await ctx.db.query(
        `INSERT INTO leak_cases (key, kind, area, company_id, order_id, payment_id, amount, details, since, first_seen, last_seen, notified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11) RETURNING id`,
        [x.key, x.kind, leakArea(x.kind), x.companyId, x.orderId, x.paymentId, x.amount, JSON.stringify(x.details), x.since, now, first || leakQuiet(x.kind) ? now : null],
      );
      fresh.push({ ...x, id: num(r[0].id) });
    }
    const acted = await actAlone(ctx, facts, fresh);
    const told = first ? 0 : await tell(ctx, facts);
    const summary = { at: now, found: found.length, opened: fresh.length, closed: gone.length, acted, told };
    await ctx.db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [RUN_KEY, JSON.stringify(summary)],
    );
    if (fresh.length || gone.length) ctx.emit({ type: 'orders' });
    return summary;
  });
}

/** What Pilotix does alone: the parcels the company stopped go to Suivi › Alertes (each parcel once, from the status it
 *  had when its words were read: a person who moved it meanwhile is never overwritten). */
async function actAlone(ctx: Ctx, facts: LeakFacts, fresh: (LeakFinding & { id: number })[]) {
  const stop = fresh.filter((x) => x.kind === 'stop_words' && x.orderId);
  if (!stop.length) return 0;
  const name = new Map(facts.companies.map((c) => [c.id, c.name]));
  const parcel = new Map(facts.parcels.map((p) => [p.id, p]));
  let n = 0;
  for (const x of stop.slice(0, 100)) {
    const p = parcel.get(x.orderId!);
    if (!p) continue;
    const r = await setFollow(
      sys(ctx),
      { ids: [p.id], status: 'alert', subStatus: null, note: `Contrôle : ${name.get(p.companyId) ?? 'la société'} dit « ${String(p.words ?? '').slice(0, 160)} » — le colis ne sera pas livré tel quel` } as any,
      { system: true, by: 'Contrôle', expect: new Map([[p.id, p.follow]]) },
    ).catch(() => null);
    if (r?.changed?.length) {
      n++;
      await ctx.db.query(`UPDATE leak_cases SET action = 'alert' WHERE id = $1`, [x.id]);
    }
  }
  return n;
}

const WHO_URL: Record<string, string> = { depot: '#/controle/dispatch', suivi: '#/controle/statuts', owner: '#/controle/argent' };
const AREA_FR: Record<LeakArea, string> = { argent: 'argent', retours: 'retour', dispatch: 'dispatch', statuts: 'statut' };

/** The new cases, told once to who acts: one notification per company and per team, whatever their number. */
async function tell(ctx: Ctx, facts: LeakFacts) {
  const rows = await ctx.db.query('SELECT id, kind, company_id, amount FROM leak_cases WHERE closed_at IS NULL AND dismissed_at IS NULL AND notified_at IS NULL ORDER BY id LIMIT 500');
  if (!rows.length) return 0;
  const name = new Map(facts.companies.map((c) => [c.id, c.name]));
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const g = `${leakWho(r.kind as LeakKind)}:${num(r.company_id)}`;
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  const people = {
    depot: await depotPeople(ctx.db),
    suivi: (await ctx.db.query(`SELECT id FROM profiles WHERE active AND 'suivi' = ANY(roles) AND NOT ('admin' = ANY(roles)) AND agency_id IS NULL`)).map((r: any) => num(r.id)),
    owner: (await ctx.db.query(`SELECT id FROM profiles WHERE active AND 'admin' = ANY(roles)`)).map((r: any) => num(r.id)),
  };
  let n = 0;
  for (const [g, list] of groups) {
    const [who, cid] = g.split(':');
    const to = people[who as keyof typeof people] ?? [];
    const co = name.get(Number(cid)) ?? 'Société';
    const areas = [...new Set(list.map((r) => AREA_FR[leakArea(r.kind as LeakKind)]))].join(', ');
    const money = list.reduce((s, r) => s + num(r.amount), 0);
    if (to.length)
      await sendPush(ctx, to, {
        title: `${who === 'owner' ? '💰' : who === 'depot' ? '📦' : '🔎'} Contrôle ${co} : ${list.length === 1 ? '1 problème' : `${list.length} problèmes`}`,
        body: `${areas}${who === 'owner' && money ? ` · ${money.toLocaleString('fr-FR')} DA à vérifier` : ''} · ouvrez Contrôle.`,
        tag: `${who === 'depot' ? 'depot-' : ''}leak-${who}-${cid}`,
        url: WHO_URL[who] ?? '#/controle',
      }).catch(() => 0);
    n += list.length;
  }
  await ctx.db.query('UPDATE leak_cases SET notified_at = $2::timestamptz WHERE id = ANY($1)', [rows.map((r: any) => num(r.id)), at(ctx)]);
  return n;
}

// ---------------------------------------------------------------- the page
/** Contrôle is the shop's own page: an agency's people do not see the shop's other parcels. */
function noAgency(ctx: Ctx) {
  if (agencyOf(ctx) !== null) throw forbidden('Le Contrôle est réservé à l’équipe de la boutique');
}
const seesMoney = (ctx: Ctx) => can(ctx, 'tab:controle/argent');
const STATES = ['open', 'seen', 'closed'] as const;

async function overview(ctx: Ctx) {
  noAgency(ctx);
  // the browser preview has no server: its check runs when the page opens (a minute apart at most)
  const run = await lastRun(ctx);
  if (isDemo(ctx) && (!run || ctx.now() - Date.parse(run.at) > 60_000)) await leakRun(ctx).catch(() => null);
  const money = await seesMoney(ctx);
  const companies = await ctx.db.query(
    `SELECT c.id, c.name, c.kind, c.active, h.ok_at, h.error, h.error_since,
       (SELECT count(*) FROM orders o WHERE o.company_id = c.id AND o.follow_status IN ('prepared','shipped','out_for_delivery','failed','alert','in_exchange','returning')) AS road
     FROM delivery_companies c LEFT JOIN courier_health h ON h.company_id = c.id ORDER BY c.active DESC, c.id`,
  );
  const cases = await ctx.db.query(`SELECT company_id, area, kind, amount, dismissed_at FROM leak_cases WHERE closed_at IS NULL ${money ? '' : `AND area <> 'argent'`}`);
  const today = await ctx.db.query(
    `SELECT count(*) FILTER (WHERE closed_by = 'auto') AS agreed, count(*) FILTER (WHERE action IS NOT NULL) AS acted FROM leak_cases
     WHERE closed_at > $1::timestamptz - interval '24 hours' ${money ? '' : `AND area <> 'argent'`}`,
    [at(ctx)],
  );
  const zero = () => Object.fromEntries(LEAK_AREAS.map((a) => [a, 0])) as Record<LeakArea, number>;
  const list = companies
    .map((c: any) => {
      const mine = cases.filter((x: any) => num(x.company_id) === num(c.id));
      const open = mine.filter((x: any) => !x.dismissed_at);
      const byArea = zero();
      for (const x of open) byArea[x.area as LeakArea]++;
      return {
        id: num(c.id),
        name: c.name as string,
        kind: c.kind as CourierKind,
        active: !!c.active,
        road: num(c.road),
        open: open.length,
        seen: mine.length - open.length,
        atRisk: money ? open.reduce((s: number, x: any) => s + num(x.amount), 0) : null,
        byArea,
        health: c.ok_at || c.error ? { okAt: isoOrNull(c.ok_at), error: (c.error ?? null) as string | null, errorSince: isoOrNull(c.error_since) } : null,
      };
    })
    // a company Pilotix does not use any more, with nothing open: not shown
    .filter((c: any) => c.active || c.open || c.road);
  const totals = zero();
  for (const c of list) for (const a of LEAK_AREAS) totals[a] += c.byArea[a];
  return {
    lastRun: run ? { at: run.at } : null,
    money,
    companies: list,
    totals,
    open: list.reduce((s: number, c: any) => s + c.open, 0),
    agreedToday: num(today[0]?.agreed),
    actedToday: num(today[0]?.acted),
  };
}

const ListIn = z.object({
  area: z.enum(LEAK_AREAS).optional(),
  companyId: z.number().int().positive().optional(),
  state: z.enum(STATES).default('open'),
});

async function list(ctx: Ctx, i: z.infer<typeof ListIn>) {
  noAgency(ctx);
  const money = await seesMoney(ctx);
  if (i.area === 'argent' && !money) throw forbidden('Contrôle › Argent n’est pas dans votre rôle');
  const where = [
    i.state === 'open' ? 'k.closed_at IS NULL AND k.dismissed_at IS NULL' : i.state === 'seen' ? 'k.closed_at IS NULL AND k.dismissed_at IS NOT NULL' : `k.closed_at > $1::timestamptz - interval '7 days'`,
    i.area ? `k.area = '${i.area}'` : '',
    i.companyId ? `k.company_id = ${Number(i.companyId)}` : '',
    money ? '' : `k.area <> 'argent'`,
  ].filter(Boolean);
  const rows = await ctx.db.query(
    `SELECT k.*, c.name AS company_name, c.kind AS company_kind, o.ref, o.customer_name, o.phone, o.tracking, o.follow_status, o.total, o.ext_status,
       p.ref AS pay_ref, p.amount AS pay_amount
     FROM leak_cases k LEFT JOIN delivery_companies c ON c.id = k.company_id LEFT JOIN orders o ON o.id = k.order_id LEFT JOIN courier_payments p ON p.id = k.payment_id
     WHERE ${where.join(' AND ')} ORDER BY ${i.state === 'closed' ? 'k.closed_at DESC' : 'k.amount DESC, k.since NULLS LAST, k.id'} LIMIT 300`,
    i.state === 'closed' ? [at(ctx)] : [],
  );
  return {
    money,
    rows: rows.map((r: any) => ({
      id: num(r.id),
      kind: r.kind as LeakKind,
      area: r.area as LeakArea,
      who: leakWho(r.kind as LeakKind),
      companyId: r.company_id === null ? null : num(r.company_id),
      company: (r.company_name ?? null) as string | null,
      companyKind: (r.company_kind ?? null) as CourierKind | null,
      orderId: r.order_id === null ? null : num(r.order_id),
      ref: (r.ref ?? null) as string | null,
      customer: (r.customer_name ?? null) as string | null,
      tracking: (r.tracking ?? null) as string | null,
      follow: (r.follow_status ?? null) as FollowStatus | null,
      words: (r.ext_status ?? null) as string | null,
      payRef: (r.pay_ref ?? null) as string | null,
      amount: num(r.amount),
      details: (parse(r.details) ?? {}) as Record<string, unknown>,
      since: isoOrNull(r.since) ?? iso(r.first_seen),
      firstSeen: iso(r.first_seen),
      action: (r.action ?? null) as string | null,
      seenBy: (r.dismissed_by ?? null) as string | null,
      seenAt: isoOrNull(r.dismissed_at),
      closedAt: isoOrNull(r.closed_at),
      closedBy: (r.closed_by ?? null) as string | null,
      /** the depot can say « reçu » for a return the company marked « Retourné » that it never scanned */
      canReceive: r.kind === 'return_not_scanned' && r.follow_status === 'returned' && !r.closed_at,
    })),
  };
}

async function caseOf(ctx: Ctx, id: number) {
  noAgency(ctx);
  const k = (await ctx.db.query('SELECT * FROM leak_cases WHERE id = $1', [id]))[0];
  if (!k) throw notFound('Ce problème n’existe plus');
  if (k.area === 'argent' && !(await seesMoney(ctx))) throw forbidden('Contrôle › Argent n’est pas dans votre rôle');
  return k;
}

const id = z.number().int().positive();
export const leakProcs = {
  'leaks.overview': proc(['suivi', 'depot'], z.object({}), (ctx) => overview(ctx)),
  'leaks.list': proc(['suivi', 'depot'], ListIn, (ctx, i) => list(ctx, i)),
  /** « Contrôler maintenant »: the same check as every 30 minutes, at once (the companies are not asked again). */
  'leaks.run': proc(['suivi', 'depot'], z.object({}), async (ctx) => {
    noAgency(ctx);
    return leakRun(ctx);
  }),
  /** « C'est vu » (or undone): set aside while it lasts — not counted, not told again; it still closes by itself. */
  'leaks.seen': proc(['suivi', 'depot'], z.object({ id, undo: z.boolean().optional() }), async (ctx, i) => {
    const k = await caseOf(ctx, i.id);
    if (k.closed_at) throw bad('Ce problème est déjà réglé');
    await ctx.db.query('UPDATE leak_cases SET dismissed_at = $2, dismissed_by = $3 WHERE id = $1', [i.id, i.undo ? null : at(ctx), i.undo ? null : ctx.session.profile.name]);
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),
  /** « Reçu au dépôt »: a return the company marked given back (Pilotix put it back in stock) that the depot never
   *  scanned — the depot has it in hand: said in its history, and the problem is closed. */
  'leaks.received': proc(['depot'], z.object({ id }), async (ctx, i) => {
    const k = await caseOf(ctx, i.id);
    if (k.kind !== 'return_not_scanned' || k.closed_at || !k.order_id) throw bad('Rien à recevoir ici');
    const o = (await ctx.db.query('SELECT follow_status FROM orders WHERE id = $1', [k.order_id]))[0];
    if (o?.follow_status !== 'returned') throw bad('Scannez ce retour dans Dépôt › Retours');
    await addEvent(ctx.db, num(k.order_id), ctx.session.profile.id, 'follow_status', 'returned', 'returned', 'reçu au dépôt (Contrôle)', { depot: true });
    await ctx.db.query(`UPDATE leak_cases SET closed_at = $2::timestamptz, closed_by = $3 WHERE id = $1`, [i.id, at(ctx), ctx.session.profile.name]);
    ctx.emit({ type: 'orders' });
    return { ok: true };
  }),
};

/** The menu's count: the problems open for this person (the money ones for those who see them). */
export async function leakMenuCount(ctx: Ctx): Promise<number | undefined> {
  if (agencyOf(ctx) !== null) return undefined;
  if (!ctx.session.isAdmin && !ctx.session.roles.some((r) => r === 'suivi' || r === 'depot')) return undefined;
  const money = await seesMoney(ctx);
  return num((await ctx.db.query(`SELECT count(*) AS n FROM leak_cases WHERE closed_at IS NULL AND dismissed_at IS NULL ${money ? '' : `AND area <> 'argent'`}`))[0]?.n);
}

// ---------------------------------------------------------------- the demo
/**
 * The browser preview's shop, made true first (its parcels left the depot with a scan, the companies' words read), then
 * one of each kind of problem on ZR, Yalidine and our livreurs — so Contrôle shows what it finds, company by company.
 */
export async function seedLeaks(db: Ctx['db'], now = Date.now()) {
  const t = (h: number) => new Date(now - h * 3_600_000).toISOString();
  const co = async (kind: string) => num((await db.query('SELECT id FROM delivery_companies WHERE kind = $1 ORDER BY id LIMIT 1', [kind]))[0]?.id);
  const zr = await co('zr');
  const yal = await co('yalidine');
  const own = await co('own');
  if (!zr || !yal) return;
  // the demo's parcels left with the depot's scan (its « Expédiée » lines are the depot's: they say so now), a little
  // before the company took them; its returns are already received at the depot by a person
  await db.query(`UPDATE order_events SET note = 'scan dispatch' WHERE kind = 'follow_status' AND to_value = 'shipped' AND note IS NULL`);
  const depot = num((await db.query(`SELECT id FROM profiles WHERE 'depot' = ANY(roles) AND NOT ('admin' = ANY(roles)) ORDER BY id LIMIT 1`))[0]?.id) || null;
  await db.query(
    `INSERT INTO order_events (order_id, user_id, kind, from_value, to_value, note, at)
     SELECT o.id, $1, 'follow_status', 'prepared', 'shipped', 'scan dispatch', COALESCE(o.taken_at - interval '2 hours', o.shipped_at)
     FROM orders o WHERE o.shipped_at IS NOT NULL AND o.company_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'shipped')`,
    [depot],
  );
  // what the companies' words mean (as their sync reads them)
  await db.query(
    `UPDATE orders SET ext_meaning = CASE WHEN follow_status = 'returned' THEN 'returning' WHEN follow_status = 'exchanged' THEN 'delivered' ELSE follow_status END, ext_meaning_of = left(ext_status, 200)
     WHERE ext_status IS NOT NULL AND follow_status IS NOT NULL`,
  );
  // money: what was delivered more than a week ago is received (the demo's caisse keeps the recent ones)
  await db.query(`UPDATE orders SET cashed = true, cashed_at = COALESCE(delivered_at, updated_at) + interval '3 days' WHERE follow_status IN ('delivered','exchanged') AND NOT cashed AND delivered_at < $1::timestamptz`, [t(24 * 7)]);
  const pick = async (sql: string, args: unknown[] = []) => (await db.query(`${sql} ORDER BY id DESC LIMIT 1`, args))[0];
  const set = async (oid: unknown, sets: string, args: unknown[]) => db.query(`UPDATE orders SET ${sets} WHERE id = $1`, [oid, ...args]);
  // ZR: « Sortie en livraison · Commande annulée » while Pilotix says « En livraison » (24 Nov 2026)
  const a = await pick(`SELECT id FROM orders WHERE company_id = $1 AND follow_status = 'out_for_delivery' AND tracking IS NOT NULL`, [zr]);
  if (a) await set(a.id, `ext_status = $2, ext_status_at = $3, ext_meaning = 'out_for_delivery', ext_meaning_of = $2`, ['Sortie en livraison · Commande annulée', t(3)]);
  // ZR: words Pilotix does not know
  const b = await pick(`SELECT id FROM orders WHERE company_id = $1 AND follow_status = 'shipped' AND tracking IS NOT NULL`, [zr]);
  if (b) await set(b.id, `ext_status = $2, ext_status_at = $3, ext_meaning = '?', ext_meaning_of = $2`, ['En attente de dédouanement · Contrôle hub', t(20)]);
  // ZR: « Récupéré par le fournisseur » five days ago, never scanned at the depot
  const c = await pick(`SELECT id FROM orders WHERE company_id = $1 AND follow_status = 'returning' AND tracking IS NOT NULL`, [zr]);
  if (c) await set(c.id, `ext_status = $2, ext_status_at = $3, ext_meaning = 'returned', ext_meaning_of = $2`, ['Récupéré par le fournisseur', t(24 * 5)]);
  // Yalidine: coming back for 18 days
  const d = await pick(`SELECT id FROM orders WHERE company_id = $1 AND follow_status = 'returning'`, [yal]);
  if (d) await set(d.id, `returning_at = $2, ext_status_at = $2`, [t(24 * 18)]);
  // ZR: scanned out by the depot two days ago, ZR never took it
  const e = await pick(`SELECT id FROM orders WHERE company_id = $1 AND follow_status = 'shipped' AND tracking IS NOT NULL AND id <> $2`, [zr, num(b?.id)]);
  if (e) {
    await set(e.id, `taken_at = NULL, shipped_at = $2, ext_status = 'Prêt à expédier', ext_meaning = '', ext_meaning_of = 'Prêt à expédier'`, [t(50)]);
    await db.query(`UPDATE order_events SET at = $2 WHERE order_id = $1 AND note = 'scan dispatch'`, [e.id, t(50)]);
  }
  // Yalidine: delivered 16 days ago, its money never came
  const f = await pick(`SELECT id FROM orders WHERE company_id = $1 AND follow_status = 'delivered' AND total > 0`, [yal]);
  if (f) await set(f.id, `cashed = false, cashed_at = NULL, delivered_at = $2`, [t(24 * 16)]);
  // our livreurs: delivered three days ago, the cash still with the livreur
  const g = own ? await pick(`SELECT id FROM orders WHERE company_id = $1 AND follow_status = 'delivered' AND total > 0`, [own]) : null;
  if (g) await set(g.id, `cashed = false, cashed_at = NULL, delivered_at = $2`, [t(24 * 3)]);
  // ZR: a payment with a line for a parcel Pilotix does not have, and one paid 700 DA short
  const h = await pick(`SELECT id, tracking, total, delivery_cost FROM orders WHERE company_id = $1 AND follow_status = 'delivered' AND tracking IS NOT NULL AND total > 2000`, [zr]);
  if (h) {
    const fee = num(h.delivery_cost) || 400;
    const lines = [
      { tracking: h.tracking, customer: null, type: 'Livré', amount: num(h.total) - fee - 700, costs: 0, comment: null, fees: { delivery: fee, ret: null, kg: null, weight: 0 } },
      { tracking: 'ZR-48210937', customer: 'Client inconnu', type: 'Livré', amount: 3900, costs: 0, comment: null, fees: { delivery: 400, ret: null, kg: null, weight: 0 } },
    ];
    await db.query(
      `INSERT INTO courier_payments (company_id, ext_id, ref, amount, status, done, at, done_at, place, details, lines, imported_at) VALUES ($1,'demo-ctl-1','PAY-00318',$2,'Accepté',true,$3,$3,'ZR Hub Alger','{}',$4,$3)`,
      [zr, lines.reduce((s, l) => s + l.amount, 0), t(30), JSON.stringify(lines)],
    );
  }
  // Yalidine has not answered for three hours (its key changed)
  await db.query(`INSERT INTO courier_health (company_id, ok_at, error, error_since, checked_at) VALUES ($1, $2, 'Yalidine refuse les clés API (code 401)', $3, $4)`, [yal, t(3.5), t(3), t(0.2)]);
  await db.query(`INSERT INTO courier_health (company_id, ok_at, error, error_since, checked_at) VALUES ($1, $2, NULL, NULL, $2)`, [zr, t(0.2)]);
}

export const LEAK_KIND_INFO = LEAK_KINDS;
