import type { Db } from '../db';
import { num } from '../db';

const EXT = ['Client absent', 'Client injoignable (ne répond pas)', 'Refusé par le client', 'Adresse incorrecte', 'Reporté par le client', 'Numéro erroné', 'Client demande le bureau (stop desk)', 'Commune non desservie'];
const iso = (t: number) => new Date(t).toISOString();

/** Suivi demo data: courier alert reasons, alerts already treated, claims sent to couriers and livreurs. */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  // why each parcel is in alert: the note of its "alert" event (what the courier or the livreur said)
  const alerts = await db.query(`SELECT id FROM orders WHERE follow_status = 'alert' ORDER BY id`);
  for (const [k, o] of alerts.entries()) {
    const at = iso(now - (k + 1) * 9 * 3_600_000);
    await db.query(`UPDATE order_events SET note = $2 WHERE order_id = $1 AND kind = 'follow_status' AND to_value = 'alert'`, [o.id, EXT[k % EXT.length]]);
    await db.query(`UPDATE orders SET ext_status = $2, ext_status_at = $3, updated_at = $3 WHERE id = $1`, [o.id, EXT[k % EXT.length], at]);
  }
  // a few parcels whose alert was treated and that are back on the road
  const road = await db.query(`SELECT id, tracking FROM orders WHERE follow_status = 'out_for_delivery' AND shipped_at IS NOT NULL ORDER BY shipped_at DESC LIMIT 4`);
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
     WHERE o.follow_status IN ('alert','out_for_delivery','failed','returning') AND o.shipped_at IS NOT NULL ORDER BY o.shipped_at LIMIT 7`,
  );
  const reasons: [string, string][] = [['relivrer', 'Client joint : merci de relivrer le colis'], ['late', 'Colis en retard / bloqué'], ['nocall', 'Le client dit qu’on ne l’a pas appelé']];
  for (const [k, o] of withCompany.entries()) {
    const own = o.kind === 'own';
    if (own && !o.livreur_id) continue;
    const [reason, label] = reasons[k % reasons.length];
    const created = now - (k + 1) * 20 * 3_600_000;
    const status = k < 3 ? 'waiting' : k < 5 ? 'still_waiting' : 'resolved';
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
