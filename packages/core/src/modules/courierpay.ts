// Courier payments (ZR first): Pilotix asks the company to pay as soon as it holds money ready for us (« demande de
// paiement »), and every payment the company makes is imported by itself — its details (parcels delivered / cancelled,
// refunds, labeling, office holding, storage) and its parcels — as one versement into a caisse: the parcels it pays are
// marked « argent reçu », and the versement's net is the company's own amount. Runs with the courier sync (every 30 min).
// A payment the company has not handed over yet waits as « à récupérer »: « Reçu » confirms it at ZR and imports it.
import { FOLLOW_ON_ROAD } from '@pilotix/shared';
import { z } from 'zod';
import { ADAPTERS } from '../couriers/adapters';
import type { PayBalance, PayLine, PayRequest, PayStatement } from '../couriers/types';
import { iso, isoOrNull, num } from '../db';
import { bad, Ctx, notFound, proc, withActionLock } from '../rpc';
import { CAISSE_KEY_RE, CaisseKey, caisseLabelOf, checkCaisse, receive } from './cash';
import { setFollow } from './orders';

const isDemo = (ctx: Ctx) => !ctx.server;
const sys = (ctx: Ctx): Ctx => ({ ...ctx, session: { ...ctx.session, roles: [...ctx.session.roles, 'admin'], isAdmin: true } });
const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v ?? {});
/** Tomorrow in Algiers (ZR wants a date ≥ tomorrow). */
const tomorrow = (now: number) => new Date(now + 3_600_000 + 86_400_000).toISOString().slice(0, 10);

export interface PayCfg {
  /** ask for the payment by itself (default on) */
  auto: boolean;
  /** caisse the payments go into */
  into: string;
}
const cfgOf = (config: unknown): PayCfg => {
  const p = (parse(config) as any).pay ?? {};
  return { auto: p.auto !== false, into: typeof p.into === 'string' && CAISSE_KEY_RE.test(p.into) ? p.into : 'main' };
};

async function company(ctx: Ctx, id: number) {
  const c = (await ctx.db.query('SELECT id, name, kind, active, config, credentials FROM delivery_companies WHERE id = $1', [id]))[0];
  if (!c) throw notFound('Société introuvable');
  const keys = parse(c.credentials) as Record<string, string>;
  return { id: num(c.id), name: c.name as string, kind: c.kind as string, active: !!c.active, cfg: cfgOf(c.config), hasKeys: Object.values(keys).some((v) => !!String(v ?? '').trim()) };
}
type Company = Awaited<ReturnType<typeof company>>;
/** Companies whose payments come through their API (ZR); in the browser preview, ZR without keys too. */
export const paySupported = (ctx: Ctx, c: { kind: string; hasKeys: boolean; active: boolean }) => c.active && !!(ADAPTERS as any)[c.kind]?.payments && (c.hasKeys || isDemo(ctx));

const courier = (ctx: Ctx, action: string, args: Record<string, unknown>) => ctx.server!.courier(action, args, ctx);

// ---------------------------------------------------------------- browser preview: a ZR that pays
async function demoRun(ctx: Ctx, c: Company) {
  const del = await ctx.db.query(
    `SELECT o.id, o.tracking, o.customer_name, o.total, o.delivered_at FROM orders o
     WHERE o.company_id = $1 AND o.follow_status = 'delivered' AND NOT o.cashed AND o.tracking IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM courier_payments p WHERE p.company_id = $1 AND p.lines @> jsonb_build_array(jsonb_build_object('tracking', o.tracking)))
     ORDER BY o.delivered_at NULLS FIRST, o.id`,
    [c.id],
  );
  const fee = (t: number) => Math.min(t, 450);
  const ready = del.slice(0, Math.ceil(del.length / 2));
  const later = del.slice(ready.length);
  const sum = (l: any[]) => l.reduce((s, o) => s + num(o.total) - fee(num(o.total)), 0);
  // one payment waiting at the ZR office (made from the oldest parcels), if none waits yet
  const waiting = (await ctx.db.query('SELECT 1 FROM courier_payments WHERE company_id = $1 AND NOT done', [c.id]))[0];
  let pay = ready;
  if (!waiting && ready.length >= 3) {
    const take = ready.slice(0, Math.min(14, ready.length));
    pay = ready.slice(take.length);
    const lines: PayLine[] = take.map((o: any) => ({ tracking: o.tracking, customer: o.customer_name, type: 'Livré', amount: num(o.total) - fee(num(o.total)), costs: 0, comment: null }));
    const amount = lines.reduce((s, l) => s + l.amount, 0) - 150 * 2;
    const n = num((await ctx.db.query('SELECT count(*) AS n FROM courier_payments WHERE company_id = $1', [c.id]))[0].n) + 1;
    await ctx.db.query(
      `INSERT INTO courier_payments (company_id, ext_id, ref, amount, status, done, at, place, details, lines) VALUES ($1,$2,$3,$4,'Prêt',false,$5,$6,$7,$8)`,
      [c.id, `demo-${c.id}-${n}`, `PAY-${String(240 + n).padStart(5, '0')}`, amount, new Date(ctx.now() - 3_600_000).toISOString(), 'ZR Hub Alger', JSON.stringify({ parcelsDelivered: take.length, parcelsCancelled: 0, refundsCredited: 0, refundsDebited: 0, labelingItems: 2, labeling: 300, officeHoldingItems: 0, officeHolding: 0, storage: 0 }), JSON.stringify(lines)],
    );
  }
  await saveBalance(ctx, c.id, { paid: num((await ctx.db.query('SELECT COALESCE(sum(amount),0) AS v FROM courier_payments WHERE company_id = $1 AND done', [c.id]))[0].v), ready: sum(pay), delivered: sum(del), notReady: sum(later) });
  if (c.cfg.auto && sum(pay) > 0 && !(await pendingRequest(ctx, c.id))) {
    await ctx.db.query('INSERT INTO courier_pay_requests (company_id, ext_id, date, at, auto) VALUES ($1,$2,$3,now(),true) ON CONFLICT DO NOTHING', [c.id, `demo-req-${ctx.now()}`, tomorrow(ctx.now())]);
    return { requested: true };
  }
  return { requested: false };
}

// ---------------------------------------------------------------- the sync
async function saveBalance(ctx: Ctx, companyId: number, b: PayBalance, error: string | null = null) {
  await ctx.db.query(
    `INSERT INTO courier_balances (company_id, paid, ready, delivered, not_ready, error, at) VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (company_id) DO UPDATE SET paid=$2, ready=$3, delivered=$4, not_ready=$5, error=$6, at=now()`,
    [companyId, b.paid, b.ready, b.delivered, b.notReady, error],
  );
}
const pendingRequest = async (ctx: Ctx, companyId: number) =>
  (await ctx.db.query(`SELECT id FROM courier_pay_requests WHERE company_id = $1 AND approved IS NULL AND (date IS NULL OR date >= (now() AT TIME ZONE 'Africa/Algiers')::date - 3) LIMIT 1`, [companyId]))[0];

/** One company: balance, requests, payments (new ones imported), and a payment request when money is ready. */
export async function payRun(ctx: Ctx, companyId: number) {
  const c = await company(ctx, companyId);
  if (!paySupported(ctx, c)) return { company: c.name, imported: 0, requested: false };
  let imported = 0;
  if (isDemo(ctx)) {
    const r = await demoRun(ctx, c);
    return { company: c.name, imported, requested: r.requested };
  }
  let bal: PayBalance;
  try {
    bal = (await courier(ctx, 'payBalance', { companyId })) as PayBalance;
  } catch (e: any) {
    await ctx.db.query(`INSERT INTO courier_balances (company_id, error) VALUES ($1,$2) ON CONFLICT (company_id) DO UPDATE SET error=$2, at=now()`, [companyId, String(e?.message ?? e).slice(0, 300)]);
    throw e;
  }
  await saveBalance(ctx, companyId, bal);
  const reqs = (await courier(ctx, 'payRequests', { companyId })) as PayRequest[];
  for (const r of reqs)
    await ctx.db.query(
      `INSERT INTO courier_pay_requests (company_id, ext_id, date, approved, comment, at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id, ext_id) DO UPDATE SET date=$3, approved=$4, comment=$5`,
      [companyId, r.extId, r.date, r.approved, r.comment, r.at],
    );
  const pays = (await courier(ctx, 'payments', { companyId })) as PayStatement[];
  for (const p of pays) {
    await ctx.db.query(
      `INSERT INTO courier_payments (company_id, ext_id, ref, amount, status, done, at, done_at, place, request_id, details) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (company_id, ext_id) DO UPDATE SET ref=$3, amount=$4, status=$5, done=courier_payments.done OR $6, done_at=COALESCE($8, courier_payments.done_at), place=$9, details=$11`,
      [companyId, p.extId, p.ref, p.amount, p.status, p.done, p.at, p.doneAt, p.place, p.requestId, JSON.stringify(p.details)],
    );
  }
  // still to pick up: its parcels known now, so each order shows « Payé par ZR · à récupérer » (the next run tries again)
  for (const w of await ctx.db.query('SELECT id, ext_id FROM courier_payments WHERE company_id = $1 AND NOT done AND lines IS NULL ORDER BY at DESC LIMIT 5', [companyId])) {
    try {
      const lines = (await courier(ctx, 'payLines', { companyId, extId: w.ext_id })) as PayLine[];
      await ctx.db.query('UPDATE courier_payments SET lines = $2 WHERE id = $1 AND lines IS NULL', [w.id, JSON.stringify(lines)]);
    } catch {
      // not now
    }
  }
  // handed over and not in a caisse yet → imported now
  const todo = await ctx.db.query('SELECT id FROM courier_payments WHERE company_id = $1 AND done AND imported_at IS NULL ORDER BY at', [companyId]);
  for (const t of todo) {
    try {
      await importPayment(ctx, num(t.id), c.cfg.into);
      imported++;
    } catch (e: any) {
      // someone is importing it by hand right now: it is theirs
      if (e?.code === 'conflict') continue;
      throw e;
    }
  }
  let requested = false;
  const pending = reqs.some((r) => r.approved === null);
  if (c.cfg.auto && bal.ready > 0 && !pending) {
    const date = tomorrow(ctx.now());
    const r = (await courier(ctx, 'payRequest', { companyId, date })) as { extId: string };
    await ctx.db.query('INSERT INTO courier_pay_requests (company_id, ext_id, date, at, auto) VALUES ($1,$2,$3,now(),true) ON CONFLICT DO NOTHING', [companyId, r.extId, date]);
    requested = true;
  }
  return { company: c.name, imported, requested };
}

/** Every company that pays through its API (called by the courier sync). */
export async function payRunAll(ctx: Ctx) {
  const rows = await ctx.db.query('SELECT id FROM delivery_companies WHERE active ORDER BY id');
  const out: { company: string; imported: number; requested: boolean; error?: string }[] = [];
  for (const r of rows) {
    const c = await company(ctx, num(r.id));
    if (!paySupported(ctx, c)) continue;
    try {
      out.push(await payRun(ctx, c.id));
    } catch (e: any) {
      out.push({ company: c.name, imported: 0, requested: false, error: e?.message ?? 'Erreur' });
    }
  }
  return out;
}

/**
 * A payment into a caisse: its parcels marked « argent reçu » (delivered first if we did not know yet), net = its amount
 * minus the parcels already received by hand (their money is already in a caisse: counted once, not twice).
 * One import at a time per payment (the « Reçu » click and the 30-minute job), and all or nothing: a crash halfway
 * leaves the payment not imported, never half in a caisse.
 */
async function importPayment(ctx: Ctx, payId: number, into: string) {
  await checkCaisse(ctx.db, into);
  return withActionLock(ctx.db, `payimport:${payId}`, ctx.session.profile.id, 'Ce paiement est déjà en cours d’import', () =>
    ctx.db.tx((tx) => importPaymentTx({ ...ctx, db: tx }, payId, into)),
  );
}

async function importPaymentTx(ctx: Ctx, payId: number, into: string) {
  const p = (await ctx.db.query('SELECT * FROM courier_payments WHERE id = $1 FOR UPDATE', [payId]))[0];
  if (!p) throw notFound('Paiement introuvable');
  const live = p.handover_id && (await ctx.db.query('SELECT 1 FROM cash_handovers WHERE id = $1 AND cancelled_at IS NULL', [p.handover_id]))[0];
  const liveMove = p.move_id && (await ctx.db.query('SELECT 1 FROM cash_moves WHERE id = $1 AND cancelled_at IS NULL', [p.move_id]))[0];
  if (live || liveMove) throw bad('Ce paiement est déjà dans une caisse');
  const companyId = num(p.company_id);
  let lines = (parse(p.lines ?? null) as PayLine[] | null) ?? null;
  if (!Array.isArray(lines)) {
    lines = isDemo(ctx) ? [] : ((await courier(ctx, 'payLines', { companyId, extId: p.ext_id })) as PayLine[]);
    await ctx.db.query('UPDATE courier_payments SET lines = $2 WHERE id = $1', [payId, JSON.stringify(lines)]);
  }
  const tracks = [...new Set(lines.filter((l) => l.tracking && l.amount > 0).map((l) => l.tracking!))];
  const orders = tracks.length ? await ctx.db.query('SELECT id, tracking, follow_status, cashed FROM orders WHERE company_id = $1 AND tracking = ANY($2) FOR UPDATE', [companyId, tracks]) : [];
  const unpaid = orders.filter((o: any) => !o.cashed);
  // parcels already received by hand: their part of this payment is already in a caisse
  const cashedTracks = new Set(orders.filter((o: any) => o.cashed).map((o: any) => String(o.tracking)));
  const already = lines.filter((l) => l.tracking && l.amount > 0 && cashedTracks.has(l.tracking)).reduce((s, l) => s + Math.round(num(l.amount)), 0);
  const net = Math.max(0, num(p.amount) - already);
  // ZR paid them: they were delivered, even if its status did not reach us yet
  const late = unpaid.filter((o: any) => o.follow_status !== 'delivered' && ([...FOLLOW_ON_ROAD, 'failed', 'alert'] as string[]).includes(o.follow_status)).map((o: any) => num(o.id));
  if (late.length) await setFollow(sys(ctx), { ids: late, status: 'delivered', note: `Payé par la société (paiement ${p.ref ?? p.ext_id})` } as any, { system: true });
  const ids = unpaid.filter((o: any) => o.follow_status === 'delivered' || late.includes(num(o.id))).map((o: any) => num(o.id));
  const note = `Paiement ${p.ref ?? String(p.ext_id).slice(0, 8)}${already ? ` (dont ${already} DA déjà reçus à la main)` : ''}`;
  let handoverId: number | null = null;
  let moveId: number | null = null;
  if (ids.length) {
    const r = await receive(sys(ctx), ids, note, false, into, { net });
    handoverId = r.handovers[0] ?? null;
  } else if (net > 0) {
    const m = await ctx.db.query(`INSERT INTO cash_moves (caisse, amount, kind, note, created_by) VALUES ($1,$2,'income',$3,$4) RETURNING id`, [into, net, note, ctx.session.profile.id]);
    moveId = num(m[0].id);
  }
  await ctx.db.query(
    'UPDATE courier_payments SET handover_id=$2, move_id=$3, caisse=$4, matched=$5, unmatched=$6, imported_at=now(), imported_by=$7 WHERE id=$1',
    [payId, handoverId, moveId, into, ids.length, tracks.length - orders.length, ctx.session.profile.id],
  );
  ctx.emit({ type: 'orders' });
  return { handoverId, moveId, matched: ids.length, alreadyCashed: already };
}

const caisseLabel = (ctx: Ctx, key: string | null) => caisseLabelOf(ctx.db, key);

// ---------------------------------------------------------------- procedures (owner)
const id = z.number().int().positive();
export const courierPayProcs = {
  /** A company's money at the courier: balance, payment requests, payments (with where each one went). */
  'caisse.pay': proc([], z.object({ companyId: id }), async (ctx, i) => {
    const c = await company(ctx, i.companyId);
    if (!paySupported(ctx, c)) return { supported: false as const, name: c.name };
    if (isDemo(ctx) && !(await ctx.db.query('SELECT 1 FROM courier_balances WHERE company_id = $1', [c.id]))[0]) await payRun(ctx, c.id);
    const b = (await ctx.db.query('SELECT * FROM courier_balances WHERE company_id = $1', [c.id]))[0];
    const reqs = await ctx.db.query('SELECT * FROM courier_pay_requests WHERE company_id = $1 ORDER BY COALESCE(at, created_at) DESC LIMIT 8', [c.id]);
    const pays = await ctx.db.query(
      `SELECT p.*, (h.id IS NOT NULL AND h.cancelled_at IS NULL) OR (m.id IS NOT NULL AND m.cancelled_at IS NULL) AS in_caisse
       FROM courier_payments p LEFT JOIN cash_handovers h ON h.id = p.handover_id LEFT JOIN cash_moves m ON m.id = p.move_id
       WHERE p.company_id = $1 ORDER BY p.done, COALESCE(p.at, p.created_at) DESC LIMIT 40`,
      [c.id],
    );
    const names = new Map<string, string | null>();
    for (const p of pays) if (p.caisse && !names.has(p.caisse)) names.set(p.caisse, await caisseLabel(ctx, p.caisse));
    return {
      supported: true as const,
      name: c.name,
      cfg: c.cfg,
      cfgName: await caisseLabel(ctx, c.cfg.into),
      balance: b ? { paid: num(b.paid), ready: num(b.ready), delivered: num(b.delivered), notReady: num(b.not_ready), at: iso(b.at), error: (b.error ?? null) as string | null } : null,
      requests: reqs.map((r: any) => ({ id: num(r.id), date: r.date ? String(iso(r.date)).slice(0, 10) : null, approved: r.approved === null || r.approved === undefined ? null : !!r.approved, comment: (r.comment ?? null) as string | null, at: isoOrNull(r.at ?? r.created_at), auto: !!r.auto })),
      payments: pays.map((p: any) => ({
        id: num(p.id),
        ref: (p.ref ?? null) as string | null,
        amount: num(p.amount),
        status: p.status as string,
        done: !!p.done,
        at: isoOrNull(p.at),
        doneAt: isoOrNull(p.done_at),
        place: (p.place ?? null) as string | null,
        details: parse(p.details) as Record<string, number>,
        inCaisse: !!p.in_caisse,
        caisse: p.in_caisse ? names.get(p.caisse) ?? null : null,
        matched: num(p.matched),
        unmatched: num(p.unmatched),
        importedAt: isoOrNull(p.imported_at),
        lines: Array.isArray(parse(p.lines ?? null)) ? (parse(p.lines) as PayLine[]).length : null,
      })),
    };
  }),

  /** Refresh now (also runs every 30 minutes with the courier sync). */
  'caisse.paySync': proc([], z.object({ companyId: id }), async (ctx, i) => payRun(ctx, i.companyId)),

  /** « Demander le paiement » by hand (ZR: date ≥ tomorrow). */
  'caisse.payRequest': proc([], z.object({ companyId: id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), async (ctx, i) => {
    const c = await company(ctx, i.companyId);
    if (!paySupported(ctx, c)) throw bad(`${c.name} : pas de demande de paiement par API`);
    const date = i.date && i.date >= tomorrow(ctx.now()) ? i.date : tomorrow(ctx.now());
    if (await pendingRequest(ctx, c.id)) throw bad('Une demande de paiement est déjà en attente');
    const extId = isDemo(ctx) ? `demo-req-${ctx.now()}` : ((await courier(ctx, 'payRequest', { companyId: c.id, date })) as { extId: string }).extId;
    await ctx.db.query('INSERT INTO courier_pay_requests (company_id, ext_id, date, at) VALUES ($1,$2,$3,now())', [c.id, extId, date]);
    return { ok: true, date };
  }),

  /** A payment request still waiting: another date (ZR: ≥ tomorrow), at the courier too. */
  'caisse.payRequestDate': proc([], z.object({ id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), async (ctx, i) => {
    const r = (await ctx.db.query('SELECT * FROM courier_pay_requests WHERE id = $1', [i.id]))[0];
    if (!r) throw notFound('Demande introuvable');
    if (r.approved !== null && r.approved !== undefined) throw bad('La société a déjà répondu à cette demande');
    if (i.date < tomorrow(ctx.now())) throw bad('La date doit être demain ou plus tard');
    if (!isDemo(ctx)) await courier(ctx, 'payRequestDate', { companyId: num(r.company_id), extId: r.ext_id, date: i.date });
    await ctx.db.query('UPDATE courier_pay_requests SET date = $2 WHERE id = $1', [r.id, i.date]);
    return { ok: true, date: i.date };
  }),

  /** Withdraws a payment request still waiting (at the courier too). */
  'caisse.payRequestCancel': proc([], z.object({ id }), async (ctx, i) => {
    const r = (await ctx.db.query('SELECT * FROM courier_pay_requests WHERE id = $1', [i.id]))[0];
    if (!r) throw notFound('Demande introuvable');
    if (r.approved !== null && r.approved !== undefined) throw bad('La société a déjà répondu à cette demande');
    if (!isDemo(ctx)) await courier(ctx, 'payRequestCancel', { companyId: num(r.company_id), extId: r.ext_id });
    await ctx.db.query('DELETE FROM courier_pay_requests WHERE id = $1', [r.id]);
    return { ok: true };
  }),

  /** « Reçu »: the payment waiting at the courier was handed to us — confirmed at the courier, then into the caisse. */
  'caisse.payReceive': proc([], z.object({ id, into: CaisseKey.optional() }), async (ctx, i) => {
    const p = (await ctx.db.query('SELECT * FROM courier_payments WHERE id = $1', [i.id]))[0];
    if (!p) throw notFound('Paiement introuvable');
    const c = await company(ctx, num(p.company_id));
    if (!p.done) {
      if (!isDemo(ctx)) await courier(ctx, 'payAccept', { companyId: c.id, extId: p.ext_id });
      await ctx.db.query('UPDATE courier_payments SET done = true, done_at = now() WHERE id = $1', [i.id]);
    }
    const r = await importPayment(ctx, i.id, i.into ?? c.cfg.into);
    if (isDemo(ctx)) await payRun(ctx, c.id); // the preview's balance follows
    return r;
  }),

  /** The parcels of a payment, with our order when we know it. */
  'caisse.payLines': proc([], z.object({ id }), async (ctx, i) => {
    const p = (await ctx.db.query('SELECT * FROM courier_payments WHERE id = $1', [i.id]))[0];
    if (!p) throw notFound('Paiement introuvable');
    let lines = parse(p.lines ?? null) as PayLine[] | null;
    if (!Array.isArray(lines)) {
      lines = isDemo(ctx) ? [] : ((await courier(ctx, 'payLines', { companyId: num(p.company_id), extId: p.ext_id })) as PayLine[]);
      await ctx.db.query('UPDATE courier_payments SET lines = $2 WHERE id = $1', [i.id, JSON.stringify(lines)]);
    }
    const tracks = lines.map((l) => l.tracking).filter(Boolean);
    const orders = tracks.length ? await ctx.db.query('SELECT id, ref, tracking, total FROM orders WHERE company_id = $1 AND tracking = ANY($2)', [num(p.company_id), tracks]) : [];
    const by = new Map(orders.map((o: any) => [o.tracking as string, o]));
    return lines.map((l) => {
      const o: any = l.tracking ? by.get(l.tracking) : null;
      return { ...l, orderId: o ? num(o.id) : null, ref: o ? (o.ref as string) : null, total: o ? num(o.total) : null };
    });
  }),

  /** Ask by itself + the caisse the payments go into. */
  'caisse.payConfig': proc([], z.object({ companyId: id, auto: z.boolean(), into: CaisseKey }), async (ctx, i) => {
    await checkCaisse(ctx.db, i.into);
    await ctx.db.query(`UPDATE delivery_companies SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{pay}', $2::jsonb) WHERE id = $1`, [i.companyId, JSON.stringify({ auto: i.auto, into: i.into })]);
    return { ok: true };
  }),
};
