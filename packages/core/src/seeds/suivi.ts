import type { Db } from '../db';
import { num } from '../db';
import { login } from '../modules/users';
import { DEMO_PASSWORD } from '@pilotix/shared';

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
