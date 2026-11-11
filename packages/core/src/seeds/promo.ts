import type { Db } from '../db';
import { num } from '../db';
import { DEFAULT_PROMO, fill } from '../modules/promo';

const iso = (t: number) => new Date(t).toISOString();
const DAY = 86_400_000;

/**
 * Referral › Code promo demo (Baby Joy's welcome code): on, -10 % from 3 000 DA, 90 days. The stroller ad and its
 * Facebook post are « Awareness 🎁 »; eight people got a code (from the post, the ad, an m.me ?ref= link), three used it
 * on an order (tagged « Awareness »), one Instagram person waits to follow the page, one code expired. One chat shows the
 * fixed message, then Dellal taking the order with the code.
 */
export async function seed(db: Db, _users: Record<string, number>, now: number): Promise<void> {
  const s = { ...DEFAULT_PROMO, enabled: true, prefix: 'BJ', kind: 'pct' as const, value: 10, minOrder: 3000, days: 90 };
  await db.query(`INSERT INTO settings (key, value) VALUES ('promo', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(s)]);
  const post = (await db.query(`SELECT id, external_id, caption FROM cm_posts WHERE channel = 'facebook' AND is_ad ORDER BY id LIMIT 1`))[0];
  if (post) await db.query('UPDATE cm_posts SET awareness = true WHERE id = $1', [post.id]);
  const ad = (await db.query(`SELECT id, name FROM ads ORDER BY id LIMIT 1`))[0];
  if (ad) await db.query(`INSERT INTO promo_marks (kind, ref_id, label) VALUES ('ad', $1, $2) ON CONFLICT DO NOTHING`, [ad.id, ad.name]);
  await db.query(`INSERT INTO promo_marks (kind, ref_id, label) VALUES ('ref', 'babyjoy-bienvenue', 'Story Instagram') ON CONFLICT DO NOTHING`);
  // three recent orders of the shop got their code (their discount, the « Awareness » tag)
  const orders = await db.query(`SELECT id, subtotal, total, discount FROM orders WHERE NOT is_exchange AND subtotal >= 3000 ORDER BY created_at DESC LIMIT 3`);
  const people: [string, 'messenger' | 'instagram', 'post' | 'ad' | 'ref', string, number, 'sent' | 'used' | 'waiting_follow' | 'expired'][] = [
    ['Amina B.', 'messenger', 'post', 'BJ-7K3P', 1, 'used'],
    ['Yacine M.', 'messenger', 'ad', 'BJ-Q4WD', 2, 'used'],
    ['@sara.dz', 'instagram', 'ad', 'BJ-H8NR', 3, 'used'],
    ['Lina K.', 'messenger', 'post', 'BJ-M2TX', 1, 'sent'],
    ['@nour.mama', 'instagram', 'ref', 'BJ-5ZPE', 2, 'sent'],
    ['Karim D.', 'messenger', 'ad', 'BJ-R9CV', 4, 'sent'],
    ['@meriem.dz', 'instagram', 'ad', 'BJ-T6JA', 0, 'waiting_follow'],
    ['Sofiane H.', 'messenger', 'post', 'BJ-W3KB', 95, 'expired'],
  ];
  let u = 0;
  for (const [k, [name, ch, kind, code, ago, status]] of people.entries()) {
    const src = kind === 'post' ? { id: String(post?.external_id ?? 'post'), label: post?.caption ? String(post.caption).slice(0, 80) : 'Publication' } : kind === 'ad' ? { id: String(ad?.id ?? 'ad'), label: ad?.name ?? 'Pub' } : { id: 'babyjoy-bienvenue', label: 'Story Instagram' };
    const sent = status === 'waiting_follow' ? null : now - ago * DAY - k * 3_600_000;
    const o = status === 'used' ? orders[u++] : null;
    const disc = o ? Math.round(num(o.subtotal) * 0.1) : null;
    await db.query(
      `INSERT INTO promo_codes (code, channel, external_id, author_id, name, source_kind, source_id, source_label, status, order_id, pct, min_order, discount, sends, created_at, sent_at, expires_at, used_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,10,3000,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING`,
      [
        code,
        ch,
        `demo-${k + 1}`,
        kind === 'post' ? `demo-author-${k + 1}` : null,
        name,
        kind,
        src.id,
        src.label,
        o ? 'used' : status === 'waiting_follow' ? 'waiting_follow' : 'sent',
        o ? o.id : null,
        disc,
        status === 'waiting_follow' ? 1 : 1 + (k % 2),
        iso((sent ?? now) - 60_000),
        sent ? iso(sent) : null,
        sent ? iso(sent + 90 * DAY) : null,
        o ? iso(sent! + DAY) : null,
      ],
    );
    if (o)
      await db.query(`UPDATE orders SET promo_code = $2, promo_discount = $3, discount = discount + $3, total = total - $3, awareness = true WHERE id = $1`, [o.id, code, disc]);
  }
  // a chat from the awareness ad: the fixed message (not the AI), then Dellal takes the order with the code
  const at = now - 2 * 3_600_000;
  const msg = fill(s.message.darija, { code: 'BJ-M2TX', pct: 10, min_order: 3000, expires_at: iso(now - DAY + 90 * DAY) }, 'darija', s.word);
  const r = await db.query(
    `INSERT INTO conversations (channel, external_id, customer_name, mode, source, last_message_at, last_customer_at, last_preview, unread, created_at)
     VALUES ('messenger', 'demo-4', 'Lina K.', 'ai', $1, $2, $3, $4, 1, $5) ON CONFLICT (channel, external_id) DO NOTHING RETURNING id`,
    [ad ? `pub ${ad.id}` : null, iso(at), iso(at - 60_000), 'Wakha, nchouf la poussette 😍', iso(at - 10 * 60_000)],
  );
  if (!r[0]) return;
  const cid = num(r[0].id);
  await db.query(`UPDATE promo_codes SET conversation_id = $1 WHERE code = 'BJ-M2TX'`, [cid]);
  const msgs: [string, string, unknown][] = [
    ['customer', 'Salam, chafit la pub 🎁 kayen code ?', null],
    ['agent', msg, { promo: { kind: 'code', code: 'BJ-M2TX' } }],
    ['customer', 'Wakha, nchouf la poussette 😍', null],
  ];
  for (const [k, [role, body, meta]] of msgs.entries())
    await db.query('INSERT INTO conv_messages (conversation_id, role, body, meta, created_at) VALUES ($1,$2,$3,$4,$5)', [cid, role, body, meta ? JSON.stringify(meta) : null, iso(at - (msgs.length - k) * 60_000)]);
}
