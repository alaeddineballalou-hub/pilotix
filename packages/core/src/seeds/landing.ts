import type { Db } from '../db';
import { num } from '../db';

// Demo landing pages: the stroller (pictures drawn in SVG, one per colour) and the diaper bag, the orders their pages
// brought, and a few orders the fake-order check held back. All people and numbers are invented.

const svg = (body: string, bg: string) =>
  'data:image/svg+xml,' +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><defs><radialGradient id="g" cx=".5" cy=".4" r=".7"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${bg}"/></radialGradient></defs><rect width="600" height="600" fill="url(#g)"/><ellipse cx="300" cy="520" rx="210" ry="18" fill="#000" opacity=".08"/>${body}</svg>`);

const stroller = (c: string, bg: string) =>
  svg(
    `<g fill="none" stroke="#374151" stroke-width="10" stroke-linecap="round"><path d="M150 200 L250 470 M250 470 L430 470 M430 470 L470 230 M250 330 L455 330 M470 230 L500 150"/><circle cx="250" cy="490" r="30"/><circle cx="430" cy="490" r="30"/></g>` +
      `<path d="M140 210 Q170 90 330 110 L300 300 Q200 300 140 210Z" fill="${c}"/><path d="M200 300 L450 300 L440 360 L230 360Z" fill="${c}" opacity=".85"/><rect x="470" y="135" width="60" height="18" rx="9" fill="#111827"/>`,
    bg,
  );
const folded = (c: string, bg: string) =>
  svg(
    `<g fill="none" stroke="#374151" stroke-width="10" stroke-linecap="round"><path d="M260 120 L300 470 M340 120 L300 470"/><circle cx="270" cy="490" r="26"/><circle cx="330" cy="490" r="26"/></g><rect x="262" y="160" width="76" height="230" rx="30" fill="${c}"/><rect x="255" y="100" width="90" height="20" rx="10" fill="#111827"/>`,
    bg,
  );
const bag = (c: string, bg: string) =>
  svg(
    `<path d="M220 200 Q220 120 300 120 Q380 120 380 200" fill="none" stroke="#374151" stroke-width="14"/><rect x="170" y="190" width="260" height="300" rx="46" fill="${c}"/><rect x="215" y="300" width="170" height="120" rx="22" fill="#000" opacity=".12"/><rect x="250" y="250" width="100" height="16" rx="8" fill="#fff" opacity=".7"/>`,
    bg,
  );

const STROLLER_TEXT = `# عربة أطفال خفيفة وقابلة للطي بيد واحدة
- **وزن خفيف:** 6 كغ فقط، سهلة الحمل في الحافلة والسيارة
- طي سريع بيد واحدة في ثانيتين
- مظلة واسعة تحمي طفلك من الشمس
- حزام أمان بخمس نقاط وفرامل خلفية
- تناسب الأطفال من 6 أشهر حتى 15 كغ

✅ الدفع عند الاستلام في جميع الولايات
✅ ضمان 6 أشهر`;

const BAG_TEXT = `حقيبة ظهر واسعة لكل أغراض طفلك، يداك تبقيان حرتين.
- 12 جيب منظم، منها جيب حافظ للحرارة للرضاعات
- قماش مقاوم للماء وسهل التنظيف
- فرشة لتغيير الحفاظات مرفقة
- أحزمة لتعليقها على العربة`;

export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const day = 86_400_000;
  const at = (ms: number) => new Date(now - ms).toISOString();
  const prod = async (sku: string) => (await db.query('SELECT id FROM products WHERE sku = $1', [sku]))[0];
  const pou = await prod('PX-POU');
  const sac = await prod('PX-SAC');
  if (!pou || !sac) return;
  const pouId = num(pou.id);
  const vars = await db.query(`SELECT id, title FROM product_variants WHERE product_id = $1 AND title <> '' ORDER BY id`, [pouId]);
  const img = (url: string) => ({ url, w: 600, h: 600 });
  const page = async (productId: number, slug: string, title: string, color: string, price: number, oldPrice: number | null, text: string, images: object[], views: number, ago: number) =>
    num(
      (
        await db.query(
          `INSERT INTO landing_pages (product_id, slug, title, color, price, old_price, description, images, views, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id`,
          [productId, slug, title, color, price, oldPrice, text, JSON.stringify(images), views, users.marketer ?? null, at(ago)],
        )
      )[0].id,
    );
  const p1 = await page(
    pouId,
    'poussette-canne-pliable',
    'عربة أطفال قابلة للطي — خفيفة وعملية',
    '#db2777',
    9950,
    12900,
    STROLLER_TEXT,
    [img(stroller('#9ca3af', '#f3f4f6')), img(stroller('#1e3a8a', '#e0e7ff')), img(stroller('#f472b6', '#fce7f3')), img(folded('#6b7280', '#f3f4f6'))],
    1843,
    2 * 3600_000,
  );
  const p2 = await page(num(sac.id), 'sac-a-langer-a-dos', 'حقيبة ظهر لأغراض الطفل', '#0f766e', 4500, null, BAG_TEXT, [img(bag('#1f2937', '#e5e7eb')), img(bag('#b45309', '#fef3c7'))], 612, 9 * day);

  // orders the stroller page brought (the demo's recent stroller orders, now marked as coming from it)
  const brought = await db.query(
    `SELECT o.id, o.phone, o.created_at FROM orders o WHERE NOT o.is_exchange AND o.created_at > $2 AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.product_id = $1) ORDER BY o.created_at DESC LIMIT 40`,
    [pouId, at(10 * day)],
  );
  for (const o of brought) {
    await db.query(`UPDATE orders SET channel = 'site', source = 'Landing · poussette-canne-pliable' WHERE id = $1`, [o.id]);
    await db.query(`INSERT INTO landing_submits (landing_id, product_id, phone, ip, fp, verdict, score, order_id, at) VALUES ($1,$2,$3,'105.235.0.1','d:demo','allow',0,$4,$5)`, [p1, pouId, o.phone, o.id, o.created_at]);
  }

  // what the fake-order check held back
  const v = (k: number) => (vars[k] ? num(vars[k].id) : null);
  const blocked: [number, string, string, number | null, string, number | null, number, [string, number][], string, string, number, string?][] = [
    [p1, 'aaaaaa', '0555555555', 16, 'Hydra', v(0), 100, [['honeypot', 100], ['phone_repeat', 35], ['name_repeat', 25], ['too_fast', 45]], '41.111.0.7', 'python-requests/2.31.0', 25 * 60_000],
    [p1, 'qsdfgh', '0661234567', 31, 'Oran', v(1), 100, [['ua_bot', 50], ['pow_missing', 30], ['name_keyboard', 30], ['phone_sequence', 30]], '197.200.4.10', 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/129.0 Safari/537.36', 70 * 60_000],
    [p1, 'Karim Bouzid', '0770418822', 25, 'El Khroub', v(2), 85, [['blacklisted', 60], ['returns_many', 35], ['fast', 15]], '105.98.12.4', 'Mozilla/5.0 (Linux; Android 12; SM-A125F) Chrome/128.0 Mobile', 3 * 3600_000],
    [p1, 'Test test', '0699000001', 9, 'Blida', v(0), 75, [['duplicate', 40], ['phone_burst', 35], ['device_burst', 30], ['good_customer', -25]], '105.101.7.33', 'Mozilla/5.0 (Linux; Android 13; Redmi Note 12) Chrome/129.0 Mobile', 5 * 3600_000],
    [p2, 'Sara 2024', '0540112233', 19, 'Sétif', null, 80, [['name_digits', 25], ['too_fast', 45], ['no_typing', 15], ['ip_abroad', 15]], '89.2.10.4', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0', 26 * 3600_000],
    [p1, 'Yasmine Haddad', '0662887411', 16, 'Kouba', v(1), 72, [['too_fast', 45], ['no_typing', 15], ['ip_wilaya', 8], ['qty_some', 10]], '105.235.8.2', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Mobile/15E148 Safari/604.1', 2 * day, 'restored'],
    [p1, 'xkcdfgh', '0500000000', 2, 'Chlef', v(2), 100, [['honeypot', 100], ['phone_repeat', 35], ['name_gibberish', 25]], '41.200.0.9', 'curl/8.4.0', 3 * day, 'dismissed'],
  ];
  const price = (lid: number) => (lid === p1 ? 9950 : 4500);
  for (const [lid, name, phone, w, commune, vid, score, reasons, ip, ua, ago, status] of blocked) {
    const r = (
      await db.query(
        `INSERT INTO landing_blocked (landing_id, product_id, variant_id, qty, unit_price, customer_name, phone, wilaya_id, commune, score, reasons, ip, user_agent, fp, status, handled_by, handled_at, at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'d:demo',$14,$15,$16,$17) RETURNING id`,
        [lid, lid === p1 ? pouId : num(sac.id), vid, name === 'Yasmine Haddad' ? 6 : 1, price(lid), name, phone, w, commune, score, JSON.stringify(reasons.map(([code, points]) => ({ code, points }))), ip, ua, status ?? 'blocked',
          status ? users.conf1 ?? null : null, status ? at(ago - 3600_000) : null, at(ago)],
      )
    )[0];
    await db.query(`INSERT INTO landing_submits (landing_id, product_id, phone, ip, fp, verdict, score, blocked_id, at) VALUES ($1,$2,$3,$4,'d:demo','block',$5,$6,$7)`, [lid, lid === p1 ? pouId : num(sac.id), phone, ip, score, r.id, at(ago)]);
  }
  void p2;
}
