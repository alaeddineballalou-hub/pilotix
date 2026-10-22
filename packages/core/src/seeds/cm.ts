import { WILAYAS } from '@pilotix/shared';
import type { Db } from '../db';
import { num } from '../db';
import type { Ctx } from '../rpc';
import { answerComment } from '../modules/cm';

const iso = (t: number) => new Date(t).toISOString();
const money = (n: number) => n.toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' ');

/**
 * CM AI agent demo: three posts (an ad, a post, an Instagram post) and their comments. Most were already handled by the
 * agent (run here with its demo rules: private messages, a hidden spam, a hidden phone number, a complaint for the team);
 * a few are still new, to try "Répondre avec CM AI" in the preview. One commenter answered the private message and Dellal took
 * the order: comment → private message → conversation → order, as on a real page.
 */
export async function seed(db: Db, _users: Record<string, number>, now: number): Promise<void> {
  await db.query(`INSERT INTO settings (key, value) VALUES ('cm', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify({ enabled: true })]);
  const pid = async (sku: string) => num((await db.query('SELECT id FROM products WHERE sku = $1', [sku]))[0]?.id) || null;
  const posts = [
    { key: 'ad', channel: 'facebook', ext: '1029384756_501', isAd: true, product: await pid('PX-POU'), caption: '🔥 Poussette canne pliable : légère, elle se plie en une seconde. Livraison 58 wilayas, paiement à la livraison 🚚' },
    { key: 'post', channel: 'facebook', ext: '1029384756_502', isAd: false, product: await pid('PX-CHA'), caption: 'Chaise haute évolutive, de 6 mois à 6 ans 👶 Disponible maintenant !' },
    { key: 'ig', channel: 'instagram', ext: '17890000000000501', isAd: false, product: await pid('PX-SAC'), caption: 'Sac à langer à dos, noir ou camel ✨ Tout le nécessaire de bébé dans un seul sac.' },
  ] as const;
  const postId: Record<string, number> = {};
  for (const p of posts) {
    const r = await db.query(`INSERT INTO cm_posts (channel, external_id, account_id, caption, is_ad, product_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [
      p.channel,
      p.ext,
      p.channel === 'facebook' ? '1029384756' : '17841400000000001',
      p.caption,
      p.isAd,
      p.product,
      iso(now - 3 * 86_400_000),
    ]);
    postId[p.key] = num(r[0].id);
  }
  // the commenter who will order: a demo order of one poussette (a new one when there is one), not linked to a conversation yet
  const sale = (
    await db.query(
      `SELECT o.id, o.ref, o.total, o.delivery_fee, o.customer_name, o.phone, o.wilaya_id, o.commune, i.variant_title, i.unit_price
       FROM orders o JOIN order_items i ON i.order_id = o.id JOIN products p ON p.id = i.product_id
       WHERE o.conf_status IN ('new','confirmed','no_answer','busy','callback','postponed') AND NOT o.is_exchange AND o.conversation_id IS NULL
         AND p.sku = 'PX-POU' AND i.qty = 1 AND (SELECT count(*) FROM order_items x WHERE x.order_id = o.id) = 1
       ORDER BY (o.conf_status = 'new') DESC, o.id DESC LIMIT 1`,
    )
  )[0];
  // [post, author id, author name, text, minutes ago, handled by the agent?]
  const comments: [string, string, string, string, number, boolean][] = [
    ['ad', 'fb-u-101', sale?.customer_name ?? 'Karim Belaid', 'ch7al ?', 190, true],
    ['ad', 'fb-u-102', 'Nour El Houda', 'بشحال وكاين التوصيل لوهران؟', 170, true],
    ['ad', 'fb-u-103', 'Bébé Discount DZ', 'Promo 🔥 poussettes à 6000 DA chez nous 👉 www.bebe-discount-dz.com', 150, true],
    ['ad', 'fb-u-104', 'Samir Haddad', 'nheb wahda grise, 0661 23 45 67 Blida', 130, true],
    ['post', 'fb-u-105', 'Yacine Merabet', 'Commandit men 10 jours w ma wsalni walou !!', 110, true],
    ['post', 'fb-u-106', 'Amel Rahmani', 'Machallah sel3a chaba 😍', 95, true],
    ['ig', 'ig-u-107', '@lina.dz', 'Amina Boudiaf', 80, true],
    ['ig', 'ig-u-108', '@sarah.b', 'Bonjour, il est disponible en camel ?', 65, true],
    ['ad', 'fb-u-109', 'Anonyme 213', 'Sel3a ta3kom khra, nsabin', 50, true],
    ['ad', 'fb-u-110', 'Lamia Kaci', 'Prix svp', 26, false],
    ['post', 'fb-u-111', 'Ahmed Bey', 'kayen livraison l Tamanrasset ?', 18, false],
    ['post', 'fb-u-112', 'Fatima Zohra', 'شحال الكرسي تاع الماكلة؟', 11, false],
    ['ig', 'ig-u-113', '@yanis_dz', 'wach hiya original ?', 6, false],
  ];
  const ctx = { db, now: () => now, emit: () => {} } as unknown as Ctx;
  for (const [k, [post, author, name, text, ago, handle]] of comments.entries()) {
    const ch = posts.find((p) => p.key === post)!.channel;
    const r = await db.query(
      `INSERT INTO cm_comments (post_id, channel, external_id, author_id, author_name, body, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [postId[post], ch, `${ch === 'facebook' ? '501' : '1790'}_c${k + 1}`, author, name, text, iso(now - ago * 60_000)],
    );
    if (handle) {
      const id = num(r[0].id);
      await answerComment(ctx, id, { force: true });
      // handled about a minute after the comment, like the agent's delay
      await db.query(`UPDATE cm_comments SET handled_at = created_at + interval '70 seconds' WHERE id = $1`, [id]);
    }
  }
  // the conversations the private messages opened: dated like the comments
  await db.query(
    `UPDATE conversations v SET last_message_at = c.handled_at, created_at = c.created_at FROM cm_comments c WHERE c.conversation_id = v.id`,
  );
  await db.query(
    `UPDATE conv_messages m SET created_at = c.created_at + (CASE WHEN m.role = 'customer' THEN interval '0 seconds' ELSE interval '70 seconds' END)
     FROM cm_comments c WHERE c.conversation_id = m.conversation_id`,
  );

  // the first commenter answered in Messenger and Dellal took the order
  const first = (await db.query(`SELECT conversation_id, created_at FROM cm_comments WHERE author_id = 'fb-u-101'`))[0];
  if (!sale || !first?.conversation_id) return;
  const convId = num(first.conversation_id);
  const wilaya = WILAYAS[num(sale.wilaya_id) - 1] ?? '';
  const commune = sale.commune || wilaya;
  const fee = num(sale.delivery_fee);
  const total = num(sale.total);
  const color = String(sale.variant_title || 'gris').toLowerCase();
  const msgs: [string, string][] = [
    ['customer', commune],
    ['tool', `delivery_fee ${wilaya} → domicile ${fee} DA`],
    ['agent', `La livraison l ${commune} b ${money(fee)} DA, w tkhallsou ki testalmou. Wach men couleur t7abou : gris, bleu marine wela rose ?`],
    ['customer', `${color}. ${sale.customer_name} ${sale.phone}`],
    ['agent', `Récap : la poussette ${color} b ${money(num(sale.unit_price))} DA + ${money(fee)} DA la livraison = ${money(total)} DA, tkhallsou ki testalmou. Nconfirmilkom ?`],
    ['customer', 'wah'],
    ['tool', `create_order → ${sale.ref} · ${total} DA`],
    ['agent', `Saha 😊 Sajjelt la commande ${sale.ref}. Wa7ed men l’équipe y3ayetlkom ba3d chwiya bach yconfirmi.`],
  ];
  const t0 = Date.parse(new Date(first.created_at).toISOString()) + 6 * 60_000;
  for (const [k, [role, body]] of msgs.entries())
    await db.query('INSERT INTO conv_messages (conversation_id, role, body, meta, created_at) VALUES ($1,$2,$3,$4,$5)', [
      convId,
      role,
      body,
      role === 'agent' ? JSON.stringify({ demo: true }) : null,
      iso(t0 + k * 75_000),
    ]);
  const last = iso(t0 + (msgs.length - 1) * 75_000);
  await db.query(
    `UPDATE conversations SET order_id = $2, orders_count = 1, phone = $3, customer_id = (SELECT id FROM customers WHERE phone = $3),
       last_message_at = $4, last_customer_at = $5, last_preview = $6 WHERE id = $1`,
    [convId, sale.id, sale.phone, last, iso(t0 + 5 * 75_000), msgs[msgs.length - 1][1].slice(0, 140)],
  );
  await db.query(`UPDATE orders SET conversation_id = $2, channel = 'facebook', source = 'Dellal · messenger · Commentaire Facebook (pub)' WHERE id = $1`, [sale.id, convId]);
}
