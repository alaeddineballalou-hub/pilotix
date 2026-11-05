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
  // the high chair's sales guide (seeds/catalog.ts): Dellal reads it before answering a question about the product
  const chair = num((await db.query(`SELECT id FROM products WHERE sku = 'PX-CHA'`))[0]?.id);
  const price = p ? p.price : 12900;
  const convs: { channel: string; ext: string; name: string; phone?: string | null; mode: string; reason?: string; orderId?: number | null; source?: string; at: number; msgs: [string, string, number?, object?][] }[] = [
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
        // she changed her message (Messenger « message_edits »): Dellal answered the new text; she liked the answer ❤️
        ['customer', 'Bonsoir, vous livrez à Tamanrasset ?', undefined, { edited: { before: 'Bonsoir, vous livrez à Ouargla ?', count: 1, at: iso(now - 12 * 60_000) } }],
        ['tool', 'delivery_fee Tamanrasset → domicile 1400 DA · bureau 900 DA'],
        ['agent', 'Bonsoir 👋 Oui ! Livraison à Tamanrasset : 1400 DA à domicile ou 900 DA au bureau, paiement à la livraison. Quel produit t’intéresse ?', undefined, { reaction: { emoji: '❤️', at: iso(now - 11 * 60_000) } }],
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
    // voice notes: Gemini wrote the first one as text before Dellal read it; the second one it could not understand
    {
      channel: 'whatsapp', ext: '213770445566', name: 'Sofiane K.', phone: '0770445566', mode: 'ai', at: now - 8 * 60_000,
      msgs: [
        ['customer', 'Salam, wesh kayna la chaise haute f l couleur grise ? w ch7al tousel l Blida ?', undefined, { voice: { status: 'done', seconds: 7, lang: 'dz', model: 'gemini-flash-latest' } }],
        ['tool', 'delivery_fee Blida → domicile 500 DA · bureau 350 DA'],
        ['agent', 'Wa 3likoum salam 😊 Ih, la chaise haute kayna f gris. La livraison l Blida 500 DA l dar wela 350 DA f l bureau, w tkhalass ki testalem. Nsajjelhalek ?'],
        ['customer', '[message vocal envoyé]', undefined, { voice: { status: 'failed', error: 'audio pas clair' } }],
        ['agent', 'Smahli, ma 9dertch nesma3 l vocal mlih 🙏 Tqder tktebli wach t7eb ?'],
      ],
    },
    // the product's sales guide: the age, the harness and « ghali » answered with the team's own words
    {
      channel: 'messenger', ext: 'psid-demo-2', name: 'Lina R.', mode: 'ai', at: now - 3 * 60_000,
      msgs: [
        ['customer', 'Salam, la chaise haute évolutive tsla7 men 9eddach ? w fiha ceinture ?'],
        ['tool', `product_guide #${chair} → guide de vente lu`],
        ['agent', 'Wa 3likoum salam 😊 Tsla7 men 6 chhour, ki yweli bébé y9e3ed wa7dou, 7ta l 3 snin. Men ba3d tweli korsi w tabla 7ta 6 snin. W fiha harnais 5 points. Mnin nti ?'],
        ['customer', 'ghalia chwiya 8900'],
        ['tool', `product_guide #${chair} → guide de vente lu`],
        ['agent', 'Nfahmek 🙏 Bessah hiya tkhdem fi blasset 3 : chaise haute, korsi sghir w tabla. W tkhalsi ghir ki testalmi. Nsajjelhalek ?'],
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
    for (const [k, [role, body, uid, meta]] of c.msgs.entries())
      await db.query('INSERT INTO conv_messages (conversation_id, role, body, user_id, meta, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [cid, role, body, uid ?? null, meta ? JSON.stringify(meta) : null, iso(c.at - (c.msgs.length - k) * 45_000)]);
    if (c.orderId) await db.query('UPDATE orders SET conversation_id = $2 WHERE id = $1', [c.orderId, cid]);
  }
}

/**
 * Photos (after the landing pages, whose drawn pictures it shows): a customer sends a screenshot of the stroller's ad,
 * Pilot AI reads it (the product, the colour), Dellal answers about it, then sends the grey one's real photos when asked.
 */
export async function seedPhotoChat(db: Db, now: number): Promise<void> {
  const pou = (await db.query(`SELECT id, name FROM products WHERE sku = 'PX-POU'`))[0];
  if (!pou) return;
  const page = (await db.query(`SELECT images, price FROM landing_pages WHERE product_id = $1 ORDER BY id LIMIT 1`, [pou.id]))[0];
  const pics: string[] = (typeof page?.images === 'string' ? JSON.parse(page.images) : page?.images ?? []).map((x: any) => String(x?.url ?? '')).filter((u: string) => u.startsWith('data:image/svg+xml'));
  if (pics.length < 4) return;
  const vars = await db.query(`SELECT id, title FROM product_variants WHERE product_id = $1 AND title <> '' ORDER BY id`, [pou.id]);
  const grey = vars[0] ? { id: num(vars[0].id), title: String(vars[0].title) } : null;
  const price = num(page.price) || 9950;
  const name = String(pou.name);
  const label = `${name}${grey ? ` — ${grey.title}` : ''}`;
  const at = now - 2 * 60_000;
  const msgs: [string, string, object?][] = [
    ['customer', '[photo] Capture d’écran d’une publicité : une poussette bleue pliable · Message : 3andkom hadi ?', { photo: { status: 'done', thumb: pics[1], what: 'Capture d’écran d’une publicité : une poussette bleue pliable', productId: num(pou.id), productName: name, sure: true, variant: 'bleu', kind: 'ad', model: 'claude-haiku-5-5' } }],
    ['agent', `Ih 3andna 😊 Hadi ${name}, b ${price} DA w tkhalssi ghir ki testalmi. Kayna f ${vars.map((v: any) => String(v.title).toLowerCase()).join(', ') || 'plusieurs couleurs'}. Men ayya wilaya ?`, { model: 'claude-haiku-5-5' }],
    ['customer', `ab3athli tswira ta3 ${grey ? grey.title.toLowerCase() : 'lokhra'} stp`],
    ['tool', `send_photos #${num(pou.id)} → 2 photo(s) envoyée(s)`, { tool: 'send_photos', input: { product_id: num(pou.id), ...(grey ? { variant_id: grey.id } : {}) }, result: { ok: true, sent: 2, of: label } }],
    ['agent', `📷 ${label} (2)`, { photos: [pics[0], pics[3]].map((thumb, i) => ({ src: `svg:demo${i}`, productId: num(pou.id), variantId: grey?.id ?? null, label, thumb })) }],
    ['agent', `Ha hiya ${grey ? `la ${grey.title.toLowerCase()}` : ''} 👆 Tetwa fi thania w tet7mel fel bus. T7ebbiha l dar wela f l bureau ?`, { model: 'claude-haiku-5-5' }],
  ];
  const r = await db.query(
    `INSERT INTO conversations (channel, external_id, customer_name, mode, source, last_message_at, last_customer_at, last_preview, unread, created_at)
     VALUES ('instagram', 'ig-demo-photo', '@meriem.dz', 'ai', 'pub « Poussette pliable »', $1, $2, $3, 0, $4) RETURNING id`,
    [iso(at), iso(at - 90_000), msgs[msgs.length - 1][1].slice(0, 140), iso(at - 10 * 60_000)],
  );
  const cid = num(r[0].id);
  for (const [k, [role, body, meta]] of msgs.entries())
    await db.query('INSERT INTO conv_messages (conversation_id, role, body, meta, created_at) VALUES ($1,$2,$3,$4,$5)', [cid, role, body, meta ? JSON.stringify(meta) : null, iso(at - (msgs.length - k) * 40_000)]);
}

/**
 * HD photos (Produits › Photos HD pour Dellal): the baby bodysuit's size chart, drawn, so the preview shows Dellal
 * sending it when a customer asks which size to take (« chhal men taille ? »). A real shop adds a photo of its own.
 */
export async function seedSizeChart(db: Db): Promise<void> {
  const bod = (await db.query(`SELECT id FROM products WHERE sku = 'PX-BOD'`))[0];
  if (!bod) return;
  const rows: [string, string, string][] = [
    ['Naissance', '50 – 56 cm', '2,5 – 4 kg'],
    ['3 mois', '56 – 62 cm', '4 – 6 kg'],
    ['6 mois', '62 – 68 cm', '6 – 8 kg'],
    ['12 mois', '74 – 80 cm', '9 – 11 kg'],
  ];
  const line = (r: [string, string, string], k: number) => {
    const y = 210 + k * 120;
    return (
      `<rect x="60" y="${y - 70}" width="1080" height="110" rx="18" fill="${k % 2 ? '#f8fafc' : '#eef2ff'}"/>` +
      `<text x="110" y="${y}" font-size="46" font-weight="700" fill="#1e293b">${r[0]}</text>` +
      `<text x="520" y="${y}" font-size="44" fill="#334155">${r[1]}</text>` +
      `<text x="860" y="${y}" font-size="44" fill="#334155">${r[2]}</text>`
    );
  };
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 760" font-family="Arial, sans-serif"><rect width="1200" height="760" fill="#ffffff"/>` +
    `<text x="60" y="90" font-size="56" font-weight="700" fill="#0f172a">Guide des tailles · Body bébé</text>` +
    `<text x="520" y="150" font-size="30" fill="#64748b">Taille du bébé</text><text x="860" y="150" font-size="30" fill="#64748b">Poids</text>` +
    rows.map(line).join('') +
    `</svg>`;
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  await db.query(`INSERT INTO product_photos (product_id, kind, store, w, h, bytes, thumb, position) VALUES ($1, 'sizes', 'local', 1200, 760, $2, $3, 0)`, [bod.id, url.length, url]);
}
