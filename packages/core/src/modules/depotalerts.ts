// Dépôt alerts: when someone outside the depot changes (products, address, phone, amount…) or cancels an order the depot
// already prepared (préparée — « à préparer » was not picked yet: the change just applies), the depot manager — or whoever the owner chose in Management › Alertes dépôt — gets
// a red alert, with a sound, that blocks the app until the parcel is fixed, proven by scanning:
//  - cancelled: scan the parcel's label once (it was found and taken out);
//  - changed: scan the old label (the parcel was found), print the new label (a new Pilotix code: the old one no longer
//    exists), scan it (the new label is on the parcel). A parcel already at a courier keeps the courier's code: one scan.
// A parcel going with a company that has an API (ZR…) always gets that company's own label, never a Pilotix one (the
// owner's rule, 22 Nov 2026): sent to the company first when it has no tracking number yet, then its label printed and
// scanned. A parcel that never had a label (its company had not given one: refused by the courier, or not sent) has no
// « old label » step — a cancelled one is just taken out.
// Edits made by the depot itself don't alert.
import { API_COURIER_KINDS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, num } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { getSetting, setSetting } from '../settings';
import { sendPush } from './push';
import { ScanLang, scanT } from './scantext';

/** only a parcel already prepared alerts: « à préparer » was not picked yet, the change just applies */
export const DEPOT_STAGES = ['prepared'];
export interface DepotChange {
  field: 'items' | 'customer' | 'phone' | 'phone2' | 'place' | 'address' | 'company' | 'total' | 'note';
  from: string;
  to: string;
}

/** Does this change concern the depot? (the order is still there, and the change comes from outside the depot) */
export const alertsDepot = (ctx: Ctx, followStatus: string | null) => !!followStatus && DEPOT_STAGES.includes(followStatus) && (ctx.session.isAdmin || !ctx.session.roles.includes('depot'));

export const itemsText = (rows: { name: string; variant_title?: string; variantTitle?: string; qty: number | string }[]) =>
  rows.map((r) => `${Number(r.qty) > 1 ? `${r.qty} × ` : ''}${r.name}${(r.variant_title ?? r.variantTitle) ? ` (${r.variant_title ?? r.variantTitle})` : ''}`).join(' + ') || '—';

const norm = (c: string) => String(c || '').trim().replace(/\s+/g, '').toUpperCase();

/**
 * Could the parcel carry a label (the order as it was)? Yes when its company gave it a tracking number (its own label,
 * or a Pilotix one with that number), or when the depot printed a Pilotix label (label_code: the printing writes it).
 * A company with an API prints only its own label, with its tracking number: none yet = nothing was ever printed
 * (PX1226). Own livreurs and companies without an API: only a printed Pilotix label (they print it in « En dispatch »: an
 * order changed before that had none); an order from before that record (label_known false) may carry one.
 */
export async function mayHaveLabel(db: Db, o: { company_id?: unknown; tracking?: unknown; label_code?: unknown; label_known?: unknown } | null | undefined): Promise<boolean> {
  if (!o) return true;
  if (o.tracking || o.label_code) return true;
  if (o.company_id) {
    const kind = (await db.query('SELECT kind FROM delivery_companies WHERE id = $1', [o.company_id]))[0]?.kind;
    if (API_COURIER_KINDS.includes(String(kind ?? ''))) return false;
  }
  return o.label_known !== true;
}

/**
 * What closes an alert now (`r`: the alert with its order's tracking, own_tracking and company kind). First the label on
 * the parcel (oldCode), when it ever had one. Then, for a changed order: a company with an API → always that company's
 * own label (`send` while it has no tracking number yet; one scan when the parcel already carries it), never a Pilotix
 * one; own livreurs and companies without an API → the new Pilotix label (new_code).
 */
function stepsOf(r: any) {
  const noOld = !!r.no_label;
  const oldCode = noOld ? null : ((r.old_code ?? r.tracking ?? r.own_tracking ?? null) as string | null);
  const api = !!r.company_kind && API_COURIER_KINDS.includes(String(r.company_kind));
  let newCode: string | null = null;
  let send = false;
  if (r.kind !== 'cancel') {
    if (!api) newCode = (r.new_code ?? null) as string | null;
    else if (!r.tracking) send = true;
    else if (!oldCode || norm(oldCode) !== norm(r.tracking)) newCode = r.tracking as string;
  }
  return { noOld, oldCode, api, newCode, send, found: noOld || !!r.old_scanned_at };
}

/** An alert with what its steps need: its order's codes and company. */
const ALERT_SQL = `SELECT a.*, o.tracking, o.own_tracking, o.company_id, c.kind AS company_kind, c.name AS company_name
  FROM depot_alerts a JOIN orders o ON o.id = a.order_id LEFT JOIN delivery_companies c ON c.id = o.company_id WHERE a.id = $1`;

async function closeAlert(ctx: Ctx, a: any, note: string) {
  await ctx.db.query('UPDATE depot_alerts SET resolved_at = now(), resolved_by = $2, old_scanned_at = COALESCE(old_scanned_at, now()) WHERE id = $1', [a.id, ctx.session.profile.id]);
  const { addEvent } = await import('./orders');
  await addEvent(ctx.db, num(a.order_id), ctx.session.profile.id, 'note', null, null, note);
  ctx.emit({ type: 'orders' });
  return { step: 'done' as const };
}

/**
 * One open alert per order: new changes are added to it (an older change to the same thing keeps its first « avant »).
 * A changed order without a courier's code gets a new Pilotix code (its new label); the code on the parcel is kept.
 * `labelled`: could the parcel carry a label before this change (the caller knows the order as it was; default: as it is)
 */
export async function addDepotAlert(db: Db, ctx: Ctx, orderId: number, stage: string, kind: 'edit' | 'cancel', changes: DepotChange[], cancelledCode?: string | null, labelled?: boolean) {
  if (kind === 'edit' && !changes.length) return;
  const o = (await db.query('SELECT tracking, own_tracking, company_id, label_code, label_known FROM orders WHERE id = $1', [orderId]))[0];
  const open = (await db.query('SELECT id, kind, changes, old_code FROM depot_alerts WHERE order_id = $1 AND resolved_at IS NULL ORDER BY id DESC LIMIT 1', [orderId]))[0];
  // a parcel just cancelled at its company still carries that company's label
  const hadLabel = !!cancelledCode || (labelled ?? (await mayHaveLabel(db, o)));
  // the code printed on the parcel now (an open alert already knows it: the parcel has not been relabelled yet)
  // (a parcel just cancelled at its old company still carries that company's label)
  const onParcel = (open?.old_code as string | null) ?? (cancelledCode || o?.tracking || o?.label_code || o?.own_tracking || null);
  let newCode: string | null = null;
  // (a parcel moved to another company: one scan of the old label is enough — the new company's label is then stuck on)
  if (kind === 'edit' && !o?.tracking && !cancelledCode) {
    newCode = (await db.query('UPDATE orders SET own_tracking = px_next_tracking(), updated_at = now() WHERE id = $1 RETURNING own_tracking', [orderId]))[0]?.own_tracking ?? null;
  }
  if (open) {
    const was = (typeof open.changes === 'string' ? JSON.parse(open.changes) : open.changes ?? []) as DepotChange[];
    const merged = [...was];
    for (const c of changes) {
      const k = merged.findIndex((x) => x.field === c.field);
      if (k >= 0) merged[k] = { ...merged[k], to: c.to };
      else merged.push(c);
    }
    const kept = merged.filter((c) => c.from !== c.to);
    const cancel = kind === 'cancel' || open.kind === 'cancel';
    await db.query('UPDATE depot_alerts SET kind = $2, changes = $3, created_by = $4, created_at = now(), new_code = $5 WHERE id = $1', [
      open.id,
      cancel ? 'cancel' : 'edit',
      JSON.stringify(kept),
      ctx.session.profile.id,
      cancel ? null : newCode,
    ]);
  } else {
    await db.query('INSERT INTO depot_alerts (order_id, kind, stage, changes, created_by, old_code, new_code, no_label) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [
      orderId,
      kind,
      stage,
      JSON.stringify(changes),
      ctx.session.profile.id,
      hadLabel ? onParcel : null,
      newCode,
      !hadLabel,
    ]);
  }
}

/** The people who get the alerts: those chosen in Management, else every depot agent (never the owner). */
export async function recipients(db: Db) {
  const to = (await getSetting(db, 'depotAlerts')).to ?? [];
  const rows = await db.query(`SELECT id FROM profiles WHERE active AND 'depot' = ANY(roles) AND NOT ('admin' = ANY(roles))`);
  const all = rows.map((r: any) => num(r.id));
  return to.length ? all.filter((x: number) => to.includes(x)) : all;
}

/** Who gets the alerts: the people chosen in Management; nobody chosen = every depot agent. */
async function isRecipient(ctx: Ctx) {
  if (ctx.session.isAdmin) return true;
  const to = (await getSetting(ctx.db, 'depotAlerts')).to ?? [];
  return !to.length || to.includes(ctx.session.profile.id);
}

const id = z.number().int().positive();
export const depotAlertProcs = {
  /** The open alerts for me (the depot app shows them in red, above everything, until they are scanned). */
  'depot.alerts': proc(['depot'], z.object({}), async (ctx) => {
    if (!(await isRecipient(ctx))) return [];
    const rows = await ctx.db.query(
      `SELECT a.*, o.ref, o.customer_name, o.phone, o.follow_status, o.total, o.tracking, o.own_tracking, o.company_id,
              c.kind AS company_kind, c.name AS company_name, p.name AS by_name,
              (SELECT string_agg(CASE WHEN i.qty > 1 THEN i.qty || ' × ' ELSE '' END || i.name || CASE WHEN i.variant_title <> '' THEN ' (' || i.variant_title || ')' ELSE '' END, ' + ' ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id) AS items
       FROM depot_alerts a JOIN orders o ON o.id = a.order_id LEFT JOIN delivery_companies c ON c.id = o.company_id LEFT JOIN profiles p ON p.id = a.created_by
       WHERE a.resolved_at IS NULL ORDER BY a.created_at`,
    );
    return rows.map((r: any) => {
      const s = stepsOf(r);
      return {
        id: num(r.id),
        orderId: num(r.order_id),
        ref: r.ref as string,
        kind: r.kind as 'edit' | 'cancel',
        stage: (r.stage ?? null) as string | null,
        status: (r.follow_status ?? null) as string | null,
        customer: r.customer_name as string,
        phone: r.phone as string,
        items: (r.items ?? '') as string,
        total: num(r.total),
        /** the code on the parcel now (to scan first); null: the parcel never had a label (`noOld`) */
        oldCode: s.oldCode,
        noOld: s.noOld,
        /** the new label's code (changed order); null: one scan is enough (or, with `send`, not known yet) */
        newCode: s.newCode,
        /** the parcel must first be sent to its company: it has no tracking number (so no label) yet */
        send: s.send,
        /** its company prints its own label (ZR…): that label, never a Pilotix one */
        api: s.api,
        companyName: (r.company_name ?? null) as string | null,
        /** the parcel was found (old label scanned, or it never had one): the new label is next */
        found: s.found,
        changes: (typeof r.changes === 'string' ? JSON.parse(r.changes) : r.changes ?? []) as DepotChange[],
        byName: (r.by_name ?? null) as string | null,
        at: iso(r.created_at),
      };
    });
  }),

  /** A scan on the alert: the old label (parcel found), then the new label (changed order) — the alert closes. */
  'depot.alertScan': proc(['depot'], z.object({ id, code: z.string().trim().min(1).max(120) }), async (ctx, i) => {
    if (!(await isRecipient(ctx))) throw bad('Ces alertes sont réglées par le responsable du dépôt');
    const a = (await ctx.db.query(ALERT_SQL, [i.id]))[0];
    if (!a) throw notFound('Alerte introuvable');
    if (a.resolved_at) return { step: 'done' as const };
    const s = stepsOf(a);
    const code = norm(i.code);
    const oldCode = s.oldCode ? norm(s.oldCode) : null;
    const newCode = s.newCode ? norm(s.newCode) : null;
    const co = (a.company_name as string | null) || 'la société';
    if (!s.found) {
      if (code !== oldCode) throw bad(newCode && code === newCode ? 'Scannez d’abord l’ancienne étiquette (celle qui est sur le colis)' : 'Ce n’est pas ce colis : scannez l’étiquette de la commande en alerte');
      if (!newCode && !s.send) return closeAlert(ctx, a, a.kind === 'cancel' ? 'Dépôt : colis annulé retiré (scanné)' : 'Dépôt : changement pris en compte (colis scanné)');
      await ctx.db.query('UPDATE depot_alerts SET old_scanned_at = now() WHERE id = $1', [i.id]);
      return { step: 'found' as const };
    }
    if (s.send) throw bad(`Ce colis n’a pas encore son étiquette ${co} : appuyez sur « Envoyer à ${co} », puis imprimez-la`);
    if (!newCode) throw bad('Ce colis n’a jamais eu d’étiquette : rien à scanner. Appuyez sur « Colis retiré »');
    if (oldCode && code === oldCode) throw bad('C’est encore l’ancienne étiquette : collez la nouvelle sur le colis, puis scannez-la');
    if (code !== newCode) throw bad(s.api ? `Ce n’est pas l’étiquette ${co} de cette commande : imprimez-la ici, collez-la, puis scannez-la` : 'Ce n’est pas la nouvelle étiquette de cette commande');
    return closeAlert(ctx, a, s.api ? `Dépôt : colis corrigé, étiquette ${co} collée (scannée)` : 'Dépôt : colis corrigé, nouvelle étiquette collée (scannée)');
  }),

  /** A cancelled parcel that never had a label (its company had not given one yet): nothing to scan, the depot says it took it out. */
  /**
   * The depot printed these Pilotix labels: each order keeps the code it printed (a change later asks for that label,
   * and only when one was printed). A code that is not the order's own (tracking, Pilotix code, reference) is ignored.
   */
  'depot.labelsPrinted': proc(['depot'], z.object({ items: z.array(z.object({ id, code: z.string().trim().min(1).max(80) })).min(1).max(500) }), async (ctx, i) => {
    let n = 0;
    for (const it of i.items)
      n += (
        await ctx.db.query(
          `UPDATE orders SET label_code = $2 WHERE id = $1 AND upper($2) IN (upper(coalesce(tracking, '')), upper(coalesce(own_tracking, '')), upper(ref)) RETURNING id`,
          [it.id, it.code],
        )
      ).length;
    return { recorded: n };
  }),

  'depot.alertNoLabel': proc(['depot'], z.object({ id }), async (ctx, i) => {
    if (!(await isRecipient(ctx))) throw bad('Ces alertes sont réglées par le responsable du dépôt');
    const a = (await ctx.db.query(ALERT_SQL, [i.id]))[0];
    if (!a) throw notFound('Alerte introuvable');
    if (a.resolved_at) return { step: 'done' as const };
    if (a.kind !== 'cancel' || !a.no_label) throw bad('Cette alerte se règle en scannant le colis');
    return closeAlert(ctx, a, 'Dépôt : colis annulé retiré (il n’avait pas d’étiquette)');
  }),

  /**
   * Every minute (scheduled job): an open alert rings on the phones of the people who get it — again and again until they
   * open the app (someone seen in the app this last minute hears the alarm there; no notification for them).
   */
  'depot.pushRun': proc([], z.object({}), async (ctx) => {
    const open = await ctx.db.query(
      `SELECT a.id, a.kind, o.ref, o.customer_name FROM depot_alerts a JOIN orders o ON o.id = a.order_id
       WHERE a.resolved_at IS NULL AND (a.pushed_at IS NULL OR a.pushed_at < now() - interval '50 seconds') ORDER BY a.created_at`,
    );
    if (!open.length) return { sent: 0 };
    const who = await recipients(ctx.db);
    const away = who.length
      ? (await ctx.db.query(`SELECT id FROM profiles WHERE id = ANY($1) AND (last_seen_at IS NULL OR last_seen_at < now() - interval '75 seconds' OR presence = 'idle')`, [who])).map((r: any) => num(r.id))
      : [];
    let sent = 0;
    for (const a of open) {
      const cancel = a.kind === 'cancel';
      sent += await sendPush(ctx, away, {
        title: cancel ? `🚨 ${a.ref} ANNULÉE — ne l’envoyez pas` : `🚨 ${a.ref} MODIFIÉE — corrigez le colis`,
        body: `${a.customer_name} · ouvrez Pilotix et scannez le colis`,
        tag: `depot-alert-${a.id}`,
        url: '#/accueil',
        alarm: true,
      });
      await ctx.db.query('UPDATE depot_alerts SET pushed_at = now(), pushes = pushes + 1 WHERE id = $1', [a.id]);
    }
    return { sent, alerts: open.length };
  }),

  /** Do I get the dépôt alerts? (then my phone is asked to ring for them) */
  'depot.alertMine': proc(['depot'], z.object({}), async (ctx) => ({ mine: !ctx.session.isAdmin && (await isRecipient(ctx)) })),

  /** Management › Alertes dépôt: who gets them (the depot agents to choose from). */
  'depot.alertConfig': proc([], z.object({}), async (ctx) => {
    const to = (await getSetting(ctx.db, 'depotAlerts')).to ?? [];
    const people = await ctx.db.query(`SELECT id, name, roles FROM profiles WHERE active AND 'depot' = ANY(roles) AND NOT ('admin' = ANY(roles)) ORDER BY name`);
    return { to, people: people.map((p: any) => ({ id: num(p.id), name: p.name as string })) };
  }),
  'depot.alertConfigSet': proc([], z.object({ to: z.array(id).max(100) }), async (ctx, i) => {
    await setSetting(ctx.db, 'depotAlerts', { to: i.to }, ctx.session.profile.id);
    return { ok: true };
  }),
};

/**
 * Someone tried to send (dispatch scan) or take (livreur) a parcel whose red alert is still open: refused, and the
 * people who get the alerts are told at once. Returns the refusal text, or null when no alert is open.
 */
export async function blockedByAlert(ctx: Ctx, orderId: number, ref: string, how: 'dispatch' | 'livreur', lang: ScanLang = 'fr'): Promise<string | null> {
  const a = (await ctx.db.query('SELECT kind FROM depot_alerts WHERE order_id = $1 AND resolved_at IS NULL ORDER BY id DESC LIMIT 1', [orderId]))[0];
  if (!a) return null;
  const who = ctx.session.profile.name;
  const to = (await recipients(ctx.db)).filter((x) => x !== ctx.session.profile.id);
  await sendPush(ctx, to, {
    title: `🚨 ${ref} : ${who} a essayé de ${how === 'livreur' ? 'le prendre' : 'l’expédier'}`,
    body: a.kind === 'cancel' ? 'Commande annulée : retirez le colis et scannez son étiquette.' : 'Commande modifiée : réglez l’alerte rouge avant qu’il parte.',
    tag: `depot-alert-try-${orderId}`,
    url: '#/accueil',
    alarm: true,
  });
  return scanT(lang, a.kind === 'cancel' ? 'alertCancel' : 'alertEdit', { ref });
}
