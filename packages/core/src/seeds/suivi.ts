import type { Db } from '../db';
import { num } from '../db';
import { login } from '../modules/users';
import { algiersDayStart, DEMO_PASSWORD } from '@pilotix/shared';

const EXT = ['Client absent', 'Client injoignable (ne répond pas)', 'Refusé par le client', 'Adresse incorrecte', 'Reporté par le client', 'Numéro erroné', 'Client demande le bureau (stop desk)', 'Commune non desservie'];
const iso = (t: number) => new Date(t).toISOString();

/** Suivi demo data: courier alert reasons, alerts already treated, claims sent to couriers and livreurs. */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  // the suivi agent who follows each shipped parcel (most of them; the newest ones are not taken yet)
  const expanded = !!users.suivi2;
  const suiviAgents = [users.suivi, users.suivi2, users.suivi3].filter((id): id is number => Number.isInteger(id));
  if (expanded) await db.query(`UPDATE orders SET follow_agent_id = ($1::bigint[])[1 + (id % $2)] WHERE shipped_at IS NOT NULL AND follow_agent_id IS NULL AND id % 5 <> 0`, [suiviAgents, suiviAgents.length]);
  else await db.query(`UPDATE orders SET follow_agent_id = $1 WHERE shipped_at IS NOT NULL AND follow_agent_id IS NULL AND id % 5 <> 0`, [users.suivi]);
  // why each parcel is in alert: the note of its "alert" event (what the courier or the livreur said)
  const alerts = await db.query(`SELECT id FROM orders WHERE follow_status = 'alert' ORDER BY id`);
  for (const [k, o] of alerts.entries()) {
    const at = iso(now - (k + 1) * 9 * 3_600_000);
    await db.query(`UPDATE order_events SET note = $2 WHERE order_id = $1 AND kind = 'follow_status' AND to_value = 'alert'`, [o.id, EXT[k % EXT.length]]);
    await db.query(`UPDATE orders SET ext_status = $2, ext_status_at = $3, updated_at = $3 WHERE id = $1`, [o.id, EXT[k % EXT.length], at]);
  }
  // why parcels were sent back: the reason given when they left for the depot (refusals first)
  const RET = ['Refusé par le client', 'Refusé par le client', 'Refusé par le client', 'Injoignable', 'Injoignable', 'Annulé par le client', 'Adresse fausse', 'Produit ne correspond pas'];
  const back = await db.query(`SELECT id FROM order_events WHERE kind = 'follow_status' AND to_value = 'returning' AND coalesce(note, '') = '' ORDER BY id`);
  for (const [k, e] of back.entries()) await db.query('UPDATE order_events SET note = $2 WHERE id = $1', [e.id, RET[(k * 5) % RET.length]]);
  // a few parcels whose alert was treated and that are back on the road
  const road = await db.query(`SELECT id, tracking FROM orders WHERE follow_status = 'out_for_delivery' AND shipped_at IS NOT NULL ORDER BY shipped_at DESC LIMIT ${expanded ? 12 : 4}`);
  for (const [k, o] of road.entries()) {
    const at = iso(now - (k + 2) * 5 * 3_600_000);
    await db.query(`UPDATE orders SET sub_status = 'alert_traitee', follow_agent_id = $2 WHERE id = $1`, [o.id, users.suivi]);
    await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value, note) VALUES ($1,$2,$3,'follow_status','out_for_delivery','alert',$4)`, [o.id, iso(Date.parse(at) - 86_400_000), null, EXT[k]]);
    await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value, note) VALUES ($1,$2,$3,'follow_status','alert','out_for_delivery',$4)`, [o.id, at, users.suivi, 'Alerte traitée — Client joint : nouvelle date de livraison']);
    await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value, note) VALUES ($1,$2,$3,'sub_status',NULL,'alert_traitee',$4)`, [o.id, at, users.suivi, 'Client joint : nouvelle date de livraison']);
  }
  // claims to the couriers and to our livreurs
  const withCompany = await db.query(
    `SELECT o.id, o.ref, o.tracking, o.customer_name, o.phone, o.company_id, o.livreur_id, co.name AS cname, co.kind FROM orders o JOIN delivery_companies co ON co.id = o.company_id
     WHERE o.follow_status IN ('alert','out_for_delivery','failed','returning') AND o.shipped_at IS NOT NULL AND (co.kind <> 'own' OR o.livreur_id IS NOT NULL) ORDER BY o.shipped_at LIMIT ${expanded ? 24 : 7}`,
  );
  const reasons: [string, string][] = [['relivrer', 'Client joint : merci de relivrer le colis'], ['late', 'Colis en retard / bloqué'], ['nocall', 'Le client dit qu’on ne l’a pas appelé']];
  for (const [k, o] of withCompany.entries()) {
    const own = o.kind === 'own';
    if (own && !o.livreur_id) continue;
    const [reason, label] = reasons[k % reasons.length];
    const created = now - (k + 1) * 20 * 3_600_000;
    const status = k < (expanded ? 8 : 3) ? 'waiting' : k < (expanded ? 16 : 5) ? 'still_waiting' : 'resolved';
    const message = [`Bonjour ${o.cname},`, `Réclamation — Pilotix Démo`, '', `N° de suivi : ${o.tracking ?? '—'}`, `Réf. commande : ${o.ref}`, `Client : ${o.customer_name} — ${o.phone}`, '', `Problème : ${label}`, '', 'Merci de nous répondre rapidement.', 'Pilotix Démo'].join('\n');
    const notes = [{ at: iso(created), userId: users.suivi, text: 'Réclamation préparée', status: 'waiting' }, { at: iso(created + 60_000), userId: users.suivi, text: 'Envoyée (WhatsApp)', status: null }];
    if (status !== 'waiting') notes.push({ at: iso(created + 30 * 3_600_000), userId: users.suivi, text: 'Toujours en attente', status: 'still_waiting' });
    if (status === 'resolved') notes.push({ at: iso(created + 40 * 3_600_000), userId: users.suivi, text: 'Réglée · la société relivre demain', status: 'resolved' });
    await db.query(
      `INSERT INTO claims (order_id, company_id, livreur_id, reason, details, message, channel, status, created_by, created_at, updated_at, sent_at, notes, resolved_at)
       VALUES ($1,$2,$3,$4,'',$5,'whatsapp',$6,$7,$8,$9,$10,$11,$12)`,
      [o.id, num(o.company_id), own ? o.livreur_id : null, reason, message, status, users.suivi, iso(created), iso(created + (status === 'waiting' ? 60_000 : 40 * 3_600_000)), iso(created + 60_000), JSON.stringify(notes), status === 'resolved' ? iso(created + 40 * 3_600_000) : null],
    );
  }
}

/** Completed examples use the real swap rules, including stock, fees and tracking transfer; then two ZR parcels whose
 *  customer cancelled (or never answered) that ZR still lets swap, each with an order asking for exactly its products. */
export async function seedSwaps(db: Db, now: number): Promise<void> {
  const { swapParcel } = await import('../modules/suivi');
  const session = await login(db, 'admin@demo.pilotix.dz', DEMO_PASSWORD);
  // one product line each, the same variant and quantity, a home delivery (ZR swaps to its own bureaus only), and never
  // out of one of ZR's southern wilayas to another wilaya (ZR refuses those)
  // the completed ones: made in Pilotix alone (another company, our livreurs — « Annuler le swap » can be tried); ZR's
  // own swaps are the two below, made by its API from the Suivi
  const pairs = (status: string, kind: 'other' | 'zr') =>
    db.query(`SELECT a.id AS src, b.id AS dst FROM orders a
      JOIN order_items ai ON ai.order_id = a.id
      JOIN order_items bi ON bi.variant_id = ai.variant_id AND bi.qty = ai.qty
      JOIN orders b ON b.id = bi.order_id
      LEFT JOIN delivery_companies c ON c.id = a.company_id
      WHERE a.follow_status = '${status}' AND a.shipped_at IS NOT NULL AND a.tracking IS NOT NULL AND NOT a.is_exchange
        AND b.conf_status = 'confirmed' AND b.shipped_at IS NULL AND b.tracking IS NULL AND NOT b.is_exchange AND NOT b.is_stopdesk
        AND b.follow_status IN ('to_prepare','prepared')
        AND (SELECT count(*) FROM order_items WHERE order_id = a.id) = 1
        AND (SELECT count(*) FROM order_items WHERE order_id = b.id) = 1
        AND (a.wilaya_id = b.wilaya_id OR NOT (a.wilaya_id = ANY('{1,8,11,30,32,45,49,52,53,54,58}'::int[])))
        ${kind === 'zr' ? `AND c.kind = 'zr'` : `AND c.kind IS DISTINCT FROM 'zr'`}
      ORDER BY (a.wilaya_id = b.wilaya_id) DESC, a.id, b.id LIMIT 40`);
  const taken = new Set<number>();
  let made = 0;
  for (const p of await pairs('returning', 'other')) {
    if (made >= 4) break;
    if (taken.has(num(p.src)) || taken.has(num(p.dst))) continue;
    try {
      await swapParcel({ db, session, now: () => now - made * 3_600_000, emit: () => {} }, num(p.src), num(p.dst), 'Démo : client annule, colis réaffecté à une commande du même produit');
      made++;
    } catch {
      // refused by the swap's rules: another pair
    }
    taken.add(num(p.src));
    taken.add(num(p.dst));
  }
  // ZR's own words on two of its parcels: « Commande annulée », « Ne répond pas 3 » — alerts of the demo's suivi agent,
  // where « Swap » shows (ZR swaps them by API); each with an order asking for exactly its products
  const words = ['Sortie en livraison · Commande annulée', 'Confirmé au bureau · Ne répond pas 3'];
  const suivi = (await db.query(`SELECT id FROM profiles WHERE email = 'nadia@demo.pilotix.dz'`))[0]?.id ?? null;
  const open = new Set<number>();
  for (const p of [...(await pairs('alert', 'zr')), ...(await pairs('out_for_delivery', 'zr'))]) {
    if (open.size >= words.length) break;
    if (open.has(num(p.src)) || taken.has(num(p.dst))) continue;
    const w = words[open.size];
    open.add(num(p.src));
    taken.add(num(p.dst));
    const at = new Date(now - (open.size + 1) * 3_600_000).toISOString();
    const was = (await db.query(`SELECT follow_status FROM orders WHERE id = $1`, [p.src]))[0]?.follow_status;
    await db.query(`UPDATE orders SET follow_status = 'alert', sub_status = NULL, ext_status = $2, ext_status_at = $3, follow_agent_id = COALESCE($4, follow_agent_id), updated_at = $3 WHERE id = $1`, [p.src, w, at, suivi]);
    if (was === 'alert') await db.query(`UPDATE order_events SET note = $2 WHERE order_id = $1 AND kind = 'follow_status' AND to_value = 'alert'`, [p.src, `ZR : ${w}`]);
    else
      await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value, note, data) VALUES ($1,$2,NULL,'follow_status',$3,'alert',$4,$5)`, [
        p.src,
        at,
        was,
        `ZR : ${w}`,
        JSON.stringify({ courier: true }),
      ]);
  }
}

/**
 * Suivi › En cours and Résolu as a real day looks (the owner, 25 Nov 2026), on the demo's suivi agents (Nadia first,
 * whose « Essayer » opens Suivi): alerts being called — no answer, busy, a call back later today or tomorrow, one whose
 * call-back time has passed, a réclamation waiting for the company — and alerts that were relivrées and then delivered
 * (Résolu: today, yesterday, older, « Sauvé par »). Runs last, once the couriers' and the swaps' data are in.
 */
export async function seedSuiviWork(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const agents = [users.suivi, users.suivi2, users.suivi3].filter((id): id is number => Number.isInteger(id));
  if (!agents.length) return;
  const H = 3_600_000;
  const M = 60_000;
  const DAY = 24 * H;
  const ev = (orderId: number, at: number, userId: number | null, kind: string, from: string | null, to: string | null, note: string | null, data?: unknown) =>
    db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value, note, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [orderId, iso(at), userId, kind, from, to, note, data === undefined ? null : JSON.stringify(data)]);
  const call = (orderId: number, at: number, userId: number, result: 'no_answer' | 'busy' | null) =>
    ev(orderId, at, userId, 'call', null, result, result === 'busy' ? 'Occupé' : result === 'no_answer' ? 'Pas de réponse' : null, result ? { result } : undefined);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const rappel = (orderId: number, at: number, userId: number, when: number) => {
    const d = new Date(when + H); // Algiers
    return ev(orderId, at, userId, 'note', null, 'suivi_rappel', `Rappel le ${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)} à ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`, { at: iso(when) });
  };
  // a time on the half hour (a call back is asked « à 16:30 », not « à 16:27 »)
  const half = (t: number) => Math.ceil(t / (30 * M)) * 30 * M;

  // ---- En cours: seven alerts being called — the other agents' first (Nadia keeps her new alerts), the oldest first
  // (room for yesterday's calls), never ZR's two that a swap can take (they stay new alerts); the réclamation goes to one
  // with no réclamation open yet
  const found = await db.query(
    `SELECT o.id, o.company_id, o.livreur_id, o.tracking, o.ref, o.customer_name, o.phone, co.kind, co.name AS cname,
            (SELECT max(e.at) FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'alert') AS alert_at,
            EXISTS (SELECT 1 FROM claims c WHERE c.order_id = o.id AND c.status NOT IN ('resolved', 'lost')) AS has_claim
       FROM orders o JOIN delivery_companies co ON co.id = o.company_id
      WHERE o.follow_status = 'alert' AND o.follow_agent_id IS NOT NULL AND o.locked_by IS NULL
        AND coalesce(o.ext_status, '') NOT LIKE '%Commande annulée%' AND coalesce(o.ext_status, '') NOT LIKE '%Ne répond pas 3%'
        AND (co.kind <> 'own' OR o.livreur_id IS NOT NULL)
      ORDER BY (o.follow_agent_id = $1), alert_at NULLS FIRST, o.id LIMIT 7`,
    [users.suivi],
  );
  // (scenario 4 is the réclamation: the first line with no réclamation open takes that place)
  const rest = [...found];
  const freeAt = rest.findIndex((o: any) => !o.has_claim);
  const claimLine = freeAt >= 0 ? rest.splice(freeAt, 1)[0] : null;
  const alerts = claimLine ? [...rest.slice(0, 4), claimLine, ...rest.slice(4)] : rest;
  for (const [k, o] of alerts.entries()) {
    const id = num(o.id);
    const me = k === 5 && agents.length > 1 ? agents[1] : users.suivi;
    const alertAt = o.alert_at ? Date.parse(new Date(o.alert_at).toISOString()) : now - 30 * H;
    // a moment after the alert and before now: `back` before now, never before the alert
    const at = (back: number) => Math.min(now - M, Math.max(alertAt + 5 * M, now - back));
    await db.query(`UPDATE orders SET follow_agent_id = $2 WHERE id = $1`, [id, me]);
    if (k === 0) await call(id, at(40 * M), me, 'no_answer');
    else if (k === 1) {
      await call(id, at(26 * H), me, 'no_answer');
      await call(id, at(3 * H), me, 'busy');
    } else if (k === 2) {
      // called back later today in the working hours (9:00–19:00), else at 14:00 the next working morning's day
      const later = half(now + 2.5 * H);
      const hourOf = (t: number) => new Date(t + H).getUTCHours();
      const today0 = algiersDayStart(now);
      const when = hourOf(later) >= 9 && hourOf(later) < 19 && later < today0 + DAY ? later : now < today0 + 9 * H ? today0 + 11 * H : today0 + DAY + 14 * H;
      await call(id, at(5 * H), me, 'no_answer');
      await rappel(id, at(5 * H - 2 * M), me, when);
    } else if (k === 3) {
      // its call-back time passed 35 minutes ago: back in « À rappeler », in red
      await call(id, at(3 * H), me, 'no_answer');
      await rappel(id, at(3 * H - 2 * M), me, now - 35 * M);
    } else if (k === 4) {
      // three calls, then a réclamation to the company (it waits for its answer: « Attend ZR »)
      await call(id, at(28 * H), me, 'no_answer');
      await call(id, at(6 * H), me, 'no_answer');
      await call(id, at(70 * M), me, 'busy');
      if (o.has_claim) continue;
      const own = o.kind === 'own';
      const created = at(30 * M);
      const message = [`Bonjour ${o.cname},`, `Réclamation — Pilotix Démo`, '', `N° de suivi : ${o.tracking ?? '—'}`, `Réf. commande : ${o.ref}`, `Client : ${o.customer_name} — ${o.phone}`, '', 'Problème : Le client dit qu’on ne l’a pas appelé', '', 'Merci de nous répondre rapidement.', 'Pilotix Démo'].join('\n');
      const notes = [{ at: iso(created), userId: me, text: 'Réclamation préparée', status: 'waiting' }, { at: iso(created + M), userId: me, text: 'Envoyée (WhatsApp)', status: null }];
      await db.query(
        `INSERT INTO claims (order_id, company_id, livreur_id, reason, details, message, channel, status, created_by, created_at, updated_at, sent_at, notes)
         VALUES ($1,$2,$3,'nocall','Le client dit qu’on ne l’a pas appelé',$4,'whatsapp','waiting',$5,$6,$7,$7,$8)`,
        [id, num(o.company_id), own ? o.livreur_id : null, message, me, iso(created), iso(created + M), JSON.stringify(notes)],
      );
    } else if (k === 5) await call(id, at(20 * M), me, 'busy');
    else {
      // tomorrow at 10:00 (Algiers), asked yesterday
      const tomorrow10 = algiersDayStart(now) + DAY + 10 * H;
      await call(id, at(22 * H), me, 'no_answer');
      await rappel(id, at(22 * H - 2 * M), me, tomorrow10);
    }
  }

  // ---- Nouvelles alertes: four parcels the company just put in alert (this last hour or so), Nadia's
  const road = await db.query(
    `SELECT o.id, o.follow_status FROM orders o JOIN delivery_companies co ON co.id = o.company_id
      WHERE o.follow_status = 'out_for_delivery' AND o.sub_status IS NULL AND o.shipped_at IS NOT NULL
        AND o.locked_by IS NULL AND NOT o.is_exchange AND (co.kind <> 'own' OR o.livreur_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.order_id = o.id)
      ORDER BY o.shipped_at, o.id LIMIT 4`,
  );
  const fresh: [number, string][] = [[18 * M, 'Client injoignable (ne répond pas)'], [55 * M, 'Numéro erroné'], [2.2 * H, 'Client absent'], [4.5 * H, 'Commune non desservie']];
  for (const [k, o] of road.entries()) {
    const [ago, why] = fresh[k];
    await db.query(`UPDATE orders SET follow_status = 'alert', ext_status = $2, ext_status_at = $3, follow_agent_id = $4, updated_at = $3 WHERE id = $1`, [num(o.id), why, iso(now - ago), users.suivi]);
    await ev(num(o.id), now - ago, null, 'follow_status', o.follow_status, 'alert', why, { courier: true });
  }

  // ---- Annulés: a delivery company's return is its own news, written with nobody's name as the couriers' sync does
  // (« ZR annulé » with its words); our livreurs' and the Suivi's own « Client annule » keep their person
  await db.query(
    `UPDATE order_events e SET user_id = NULL FROM orders o JOIN delivery_companies co ON co.id = o.company_id
      WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'returning' AND co.kind <> 'own'
        AND coalesce(e.note, '') NOT LIKE '%(suivi)%' AND coalesce(e.note, '') NOT LIKE 'Annulé trop tôt%' AND coalesce(e.note, '') NOT LIKE 'Traité%'`,
  );

  // ---- Résolu: alerts relivrées, then delivered by the company — three today, two yesterday, four older
  const dayStart = algiersDayStart(now);
  const sinceToday = now - dayStart;
  const todayAt = [0.3, 1.4, 2.6].map((h) => (sinceToday >= 4 * H ? now - h * H : dayStart + sinceToday * (0.8 - h * 0.2)));
  const yesterdayAt = [3.5 * H, 7.5 * H].map((b) => dayStart - b);
  const clean = `o.follow_status = 'delivered' AND o.shipped_at IS NOT NULL AND o.locked_by IS NULL
        AND NOT EXISTS (SELECT 1 FROM order_events e WHERE e.order_id = o.id AND e.kind = 'follow_status' AND e.to_value = 'alert')`;
  // moved to today and yesterday: parcels delivered these four days that left at least two days before yesterday
  const recent = await db.query(`SELECT o.id, o.shipped_at FROM orders o WHERE ${clean} AND o.delivered_at >= $1 AND o.shipped_at < $2 ORDER BY o.delivered_at DESC, o.id LIMIT 5`, [iso(now - 4 * DAY), iso(dayStart - 3 * DAY)]);
  const older = await db.query(`SELECT o.id, o.shipped_at, o.delivered_at FROM orders o WHERE ${clean} AND o.delivered_at BETWEEN $1 AND $2 AND NOT (o.id = ANY($3)) ORDER BY o.delivered_at DESC, o.id LIMIT 4`, [iso(now - 20 * DAY), iso(dayStart - 2 * DAY), recent.map((r: any) => num(r.id))]);
  const saved = [
    ...recent.map((r: any, k: number) => ({ id: num(r.id), shipped: Date.parse(new Date(r.shipped_at).toISOString()), at: k < 3 ? todayAt[k] : yesterdayAt[k - 3] })),
    ...older.map((r: any) => ({ id: num(r.id), shipped: Date.parse(new Date(r.shipped_at).toISOString()), at: Date.parse(new Date(r.delivered_at).toISOString()) })),
  ];
  const motifs: [string, string, string][] = [
    ['reached', 'Client joint, il attend', 'Client injoignable (ne répond pas)'],
    ['new_date', 'Nouvelle date de livraison', 'Reporté par le client'],
    ['address', 'Adresse corrigée', 'Adresse incorrecte'],
    ['phone', 'Téléphone corrigé', 'Numéro erroné'],
    ['reached', 'Client joint, il attend', 'Client absent'],
    ['desk', 'Livraison au bureau', 'Client demande le bureau (stop desk)'],
  ];
  for (const [k, p] of saved.entries()) {
    const me = k % 4 === 3 && agents.length > 1 ? agents[1] : users.suivi;
    const [key, label, why] = motifs[k % motifs.length];
    const D = p.at;
    // the alert came a day before the delivery (never before the parcel left), then two calls and « Relivrer »
    const alertAt = Math.max(p.shipped + H, D - (20 + (k % 3) * 4) * H);
    const step = (D - alertAt) / 8;
    await db.query(`UPDATE orders SET delivered_at = $2, follow_agent_id = $3, sub_status = NULL, updated_at = $2 WHERE id = $1`, [p.id, iso(D), me]);
    await db.query(`UPDATE order_events SET at = $2 WHERE order_id = $1 AND kind = 'follow_status' AND to_value = 'delivered'`, [p.id, iso(D)]);
    await ev(p.id, alertAt, null, 'follow_status', 'out_for_delivery', 'alert', why);
    await call(p.id, alertAt + step, me, 'no_answer');
    await call(p.id, alertAt + 3 * step, me, null);
    const relivrer = alertAt + 3 * step + 2 * M;
    await ev(p.id, relivrer, me, 'follow_status', 'alert', 'out_for_delivery', `Traité · Résolu · ${label}`);
    await ev(p.id, relivrer, me, 'suivi_motif', 'resolved', key, label);
    await ev(p.id, relivrer, me, 'sub_status', null, 'alert_traitee', label);
  }
}

