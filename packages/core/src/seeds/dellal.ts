import type { Db } from '../db';
import { num } from '../db';

const iso = (t: number) => new Date(t).toISOString();

/** Dellal demo: a few conversations on each channel (one order taken, one waiting for a person, one taken over). */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  // the WhatsApp example ends with a real order of the demo shop (one product line), so the chat and the order agree
  const order = (await db.query(
    `SELECT o.id, o.ref, o.total, o.delivery_fee, o.customer_name, o.phone, o.wilaya_id, o.commune FROM orders o
     WHERE o.conf_status = 'new' AND NOT o.is_exchange AND (SELECT count(*) FROM order_items i WHERE i.order_id = o.id) = 1 ORDER BY o.id DESC LIMIT 1`,
  ))[0];
  const item = order ? (await db.query('SELECT name, variant_title AS title, unit_price, qty FROM order_items WHERE order_id = $1', [order.id]))[0] : null;
  const p = item ? { name: item.name, title: item.title, price: num(item.unit_price) * num(item.qty) } : null;
  const fee = order ? num(order.delivery_fee) : 400;
  const place = order ? `${order.commune || 'votre commune'}` : 'Kouba';
  await db.query(`INSERT INTO settings (key, value) VALUES ('dellal', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify({ enabled: true, verifyToken: 'dellal-demo-verify-token' })]);
  const name = p ? `${p.name}${p.title ? ` ${p.title}` : ''}` : 'la poussette';
  const price = p ? p.price : 12900;
  const convs: { channel: string; ext: string; name: string; phone?: string | null; mode: string; reason?: string; orderId?: number | null; source?: string; at: number; msgs: [string, string, number?][] }[] = [
    {
      channel: 'whatsapp', ext: order ? '213' + String(order.phone).slice(1) : '213661234518', name: order?.customer_name ?? 'Karim', phone: order?.phone ?? null, mode: 'ai', orderId: order ? num(order.id) : null, source: 'pub « Bébé confort »', at: now - 25 * 60_000,
      msgs: [
        ['customer', `Salam, ch7al ${name} ?`],
        ['tool', `search_products "${p?.name ?? ''}" → 1 produit(s)`],
        ['agent', `Wa alikoum salam 👋 ${name} est à ${price} DA, disponible ✅ Tu es de quelle wilaya ?`],
        ['customer', place],
        ['tool', `delivery_fee ${place} → domicile ${fee} DA`],
        ['agent', `Livraison à ${place} : ${fee} DA à domicile. Total ${price + fee} DA, paiement à la livraison. Je te le réserve ? Envoie-moi ton nom et ton numéro.`],
        ['customer', `${order?.customer_name ?? 'Karim'} ${order?.phone ?? '0661234518'}`],
        ['agent', `Récap : ${name}, livraison comprise = ${order ? num(order.total) : price + fee} DA. Je confirme ?`],
        ['customer', 'wah'],
        ['tool', `create_order → ${order?.ref ?? 'PX'} · ${order ? num(order.total) : price + fee} DA`],
        ['agent', `C'est noté ✅ Commande ${order?.ref ?? ''}. Un conseiller va t'appeler pour confirmer. Saha !`],
      ],
    },
    {
      channel: 'messenger', ext: 'psid-demo-1', name: 'Nesrine B.', mode: 'ai', at: now - 12 * 60_000,
      msgs: [
        ['customer', 'Bonsoir, vous livrez à Tamanrasset ?'],
        ['tool', 'delivery_fee Tamanrasset → domicile 1400 DA · bureau 900 DA'],
        ['agent', 'Bonsoir 👋 Oui ! Livraison à Tamanrasset : 1400 DA à domicile ou 900 DA au bureau, paiement à la livraison. Quel produit t’intéresse ?'],
      ],
    },
    {
      channel: 'instagram', ext: 'ig-demo-1', name: '@amel.store', mode: 'handoff', reason: 'Achat en gros : 30 pièces', at: now - 40 * 60_000,
      msgs: [
        ['customer', 'Salam, je veux 30 pièces pour ma boutique, vous faites un prix de gros ?'],
        ['tool', 'handoff → Achat en gros : 30 pièces'],
        ['agent', 'Wa alikoum salam ! Pour les achats en gros, je passe ta demande à un conseiller de l’équipe, il te répond très vite 🙏'],
      ],
    },
    {
      channel: 'whatsapp', ext: '213550987654', name: 'Yacine M.', phone: '0550987654', mode: 'human', at: now - 3 * 3_600_000,
      msgs: [
        ['customer', 'Ma commande n’est toujours pas arrivée, ça fait 6 jours'],
        ['tool', 'handoff → Réclamation : colis en retard'],
        ['agent', 'Je suis désolé pour le retard 😕 Je passe ta demande à l’équipe du suivi, quelqu’un te répond tout de suite.'],
        ['staff', 'Bonjour Yacine, j’ai appelé le livreur : votre colis passe demain matin. Désolée pour l’attente.', users.suivi],
      ],
    },
    {
      channel: 'tiktok', ext: 'tt-demo-1', name: 'yacine_dz', mode: 'ai', at: now - 5 * 60_000,
      msgs: [['customer', 'chhal livraison l Oran ?']],
    },
  ];
  for (const c of convs) {
    const last = c.msgs.filter((m) => m[0] !== 'tool').pop()!;
    const r = await db.query(
      `INSERT INTO conversations (channel, external_id, customer_name, phone, mode, handoff_reason, assigned_to, order_id, orders_count, source, last_message_at, last_customer_at, last_preview, unread, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14) RETURNING id`,
      [c.channel, c.ext, c.name, c.phone ?? null, c.mode, c.reason ?? null, c.mode === 'human' ? users.suivi : null, c.orderId ?? null, c.orderId ? 1 : 0, c.source ?? null, iso(c.at), last[1].slice(0, 140), last[0] === 'customer' ? 1 : 0, iso(c.at - c.msgs.length * 60_000)],
    );
    const cid = num(r[0].id);
    for (const [k, [role, body, uid]] of c.msgs.entries())
      await db.query('INSERT INTO conv_messages (conversation_id, role, body, user_id, created_at) VALUES ($1,$2,$3,$4,$5)', [cid, role, body, uid ?? null, iso(c.at - (c.msgs.length - k) * 45_000)]);
    if (c.orderId) await db.query('UPDATE orders SET conversation_id = $2 WHERE id = $1', [c.orderId, cid]);
  }
}
