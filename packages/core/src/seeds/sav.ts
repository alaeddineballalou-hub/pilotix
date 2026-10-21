import type { Db } from '../db';
import { num } from '../db';

const iso = (t: number) => new Date(t).toISOString();

/** SAV demo data: spreads the tickets of the main seed over managers, adds history and two exchanges. */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const tickets = await db.query(`SELECT id, ref, order_id, status, created_at FROM complaints ORDER BY id`);
  const owners = [null, null, users.manager2, users.vendeur, null, null, users.manager1, users.manager2, users.manager1, users.conf1, users.manager2, users.manager1];
  const details = [
    'La roue avant est arrivée voilée, photos envoyées sur WhatsApp.',
    'Il manque un body dans le lot de 6.',
    'Couleur reçue rose au lieu de gris.',
    'Toujours pas reçu après 6 jours, le livreur ne répond pas.',
    'Demande l’échange contre la taille 6-12 mois.',
    'Ne sait pas monter la chaise haute, demande une vidéo.',
  ];
  for (const [k, t] of tickets.entries()) {
    const created = Date.parse(t.created_at);
    const owner = owners[k % owners.length] ?? null;
    const notes: unknown[] = [{ at: iso(created), userId: users.suivi, text: 'Ticket créé', status: 'open' }];
    if (owner) notes.push({ at: iso(created + 600_000), userId: users.suivi, text: 'Confié au responsable' });
    let resolved: string | null = null;
    if (t.status === 'progress') notes.push({ at: iso(created + 2 * 3_600_000), userId: owner, text: 'Client rappelé, solution en cours', status: 'progress' });
    if (t.status === 'resolved' || t.status === 'closed') {
      resolved = iso(Math.min(now - 60_000, created + (6 + k * 3) * 3_600_000));
      notes.push({ at: resolved, userId: owner ?? users.suivi, text: t.status === 'resolved' ? 'Échange livré au client' : 'Le client ne veut plus rien', status: t.status });
    }
    await db.query(`UPDATE complaints SET assigned_to = $2, notes = $3, resolved_at = $4, updated_at = COALESCE($4, created_at), details = $5 WHERE id = $1`, [
      t.id, owner, JSON.stringify(notes), resolved, details[k % details.length],
    ]);
  }
  // SAV delivery tariff (its own grid): about 60 % of the standard client price
  const std = ((await db.query(`SELECT value FROM settings WHERE key = 'clientFees'`))[0]?.value ?? {}) as Record<string, Record<string, { home: number; desk: number }>>;
  const base = std.Standard ?? Object.values(std)[0] ?? {};
  const r50 = (v: number) => Math.round(v / 50) * 50;
  const savFees = Object.fromEntries(Object.entries(base).map(([w, f]) => [w, { home: Math.max(200, r50(f.home * 0.6)), desk: Math.max(150, r50(f.desk * 0.6)) }]));
  await db.query(`INSERT INTO settings (key, value) VALUES ('savFees', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(savFees)]);

  // ticket parcels (exchanges): two at the depot / on the road, the settled tickets delivered, two cancelled ones came back
  const plan: { t: any; follow: string; paid: boolean }[] = [];
  const prog = tickets.filter((t: any) => t.status === 'progress' && t.order_id).slice(0, 3);
  prog.forEach((t: any, k: number) => plan.push({ t, follow: ['to_prepare', 'out_for_delivery', 'shipped'][k], paid: k === 1 }));
  tickets.filter((t: any) => t.status === 'resolved' && t.order_id).forEach((t: any) => plan.push({ t, follow: 'delivered', paid: true }));
  tickets.filter((t: any) => t.status === 'closed' && t.order_id).slice(0, 2).forEach((t: any) => plan.push({ t, follow: 'returned', paid: true }));
  for (const [k, { t, follow, paid }] of plan.entries()) {
    const o = (await db.query(`SELECT * FROM orders WHERE id = $1`, [t.order_id]))[0];
    const items = await db.query(`SELECT * FROM order_items WHERE order_id = $1 LIMIT 1`, [o.id]);
    if (!items.length) continue;
    const ref = (await db.query(`SELECT 'PX' || nextval('order_ref_seq') AS r`))[0].r;
    const t0 = Date.parse(t.created_at);
    const at = iso(t0 + 3 * 3_600_000);
    const left = follow === 'to_prepare' ? null : iso(t0 + 20 * 3_600_000);
    const done = (await db.query(`SELECT resolved_at FROM complaints WHERE id = $1`, [t.id]))[0]?.resolved_at;
    const end = done ? new Date(done).toISOString() : iso(Math.min(now - 3_600_000, t0 + 50 * 3_600_000));
    const fee = paid ? num(savFees[String(o.wilaya_id)]?.[o.is_stopdesk ? 'desk' : 'home'] ?? 300) : 0;
    const kind = k % 4 === 1 ? 'variant' : k % 4 === 3 ? 'parts' : 'same';
    const ex = (
      await db.query(
        `INSERT INTO orders (ref, created_at, updated_at, created_by, customer_id, customer_name, phone, wilaya_id, commune, address, is_stopdesk, channel, source,
           conf_status, agent_id, confirmed_at, follow_status, company_id, warehouse_id, subtotal, delivery_fee, total, delivery_cost, is_exchange, original_order_id, internal_note,
           prepared_at, shipped_at, tracking, delivered_at, returned_at, cashed, cashed_at)
         VALUES ($1,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'sav','confirmed',$3,$2,$12,$13,$14,0,$15,$15,$16,true,$17,$18,$19,$19,$20,$21,$22,$23,$24) RETURNING id`,
        [ref, at, users.suivi, o.customer_id, o.customer_name, o.phone, o.wilaya_id, o.commune, o.address, o.is_stopdesk, o.channel, follow, o.company_id, o.warehouse_id,
          fee, paid ? Math.round(fee * 0.7) : num(o.delivery_cost ?? 0), o.id, `SAV ${t.ref} — ${kind === 'variant' ? 'Autre couleur / taille' : kind === 'parts' ? 'Pièces seulement' : 'Même article (neuf)'}`,
          left, left ? `ECH-${200000 + num(o.id)}` : null,
          follow === 'delivered' ? end : null, follow === 'returned' ? end : null, follow === 'delivered' && k % 3 === 0, follow === 'delivered' && k % 3 === 0 ? end : null],
      )
    )[0];
    const it = items[0];
    await db.query(`INSERT INTO order_items (order_id, product_id, variant_id, name, variant_title, qty, unit_price, purchase_price) VALUES ($1,$2,$3,$4,$5,1,0,$6)`, [ex.id, it.product_id, kind === 'parts' ? null : it.variant_id, it.name, it.variant_title, it.purchase_price]);
    await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value, note) VALUES ($1,$2,$3,'created',NULL,'confirmed',$4)`, [ex.id, at, users.suivi, `SAV ${t.ref}`]);
    if (follow === 'delivered') await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value, note) VALUES ($1,$2,$3,'follow_status','out_for_delivery','delivered',NULL)`, [ex.id, end, users.suivi]);
    await db.query(`UPDATE complaints SET exchange_order_id = $2, exchange_kind = $3, wish = 'exchange' WHERE id = $1`, [t.id, ex.id, kind]);
  }
}
