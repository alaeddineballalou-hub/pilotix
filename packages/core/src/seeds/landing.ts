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

/** a variant id by position (null when the product has fewer) */
const v0 = (vars: any[], k: number): number | null => (vars[k] ? num(vars[k].id) : null);

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
  const UA = 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
  for (const [k, o] of brought.entries()) {
    const utm = k % 3 === 0 ? { utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'Poussette octobre', adset_id: '120210000000001' } : null;
    await db.query(`UPDATE orders SET channel = 'landing', landing_id = $2, source = 'Landing · poussette-canne-pliable', utm = $3, adset_id = $4 WHERE id = $1`, [o.id, p1, utm ? JSON.stringify(utm) : null, utm?.adset_id ?? null]);
    await db.query(
      `INSERT INTO landing_submits (landing_id, product_id, phone, ip, fp, verdict, score, order_id, at, ua, fbp, url) VALUES ($1,$2,$3,'105.235.0.1','d:demo','allow',0,$4,$5,$6,$7,$8)`,
      [p1, pouId, o.phone, o.id, o.created_at, UA, `fb.1.${Date.parse(String(o.created_at))}.${1000 + k}`, 'https://demo.pilotix.app/api/lp/poussette-canne-pliable'],
    );
  }

  // the shop's Meta pixel; a real sale is reported when an agent confirms it
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('landing', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ pixelId: '1234567890123456', testEventCode: '', purchaseAt: 'confirmed', abandonAfterMin: 20, autoCreate: false, ignored: [] })],
  );
  // what the server sent to Meta (simulated in the demo): Purchase for the confirmed ones, never for a fake one
  const confirmed = await db.query(`SELECT id, ref, total, conf_status, confirmed_at, created_at FROM orders WHERE landing_id = $1 ORDER BY created_at DESC LIMIT 14`, [p1]);
  for (const o of confirmed) {
    const fake = ['fake', 'duplicate', 'wrong_number', 'cancelled'].includes(o.conf_status);
    const real = ['confirmed', 'no_stock'].includes(o.conf_status) || fake;
    if (!real) continue;
    const t0 = o.confirmed_at ?? o.created_at;
    await db.query(
      `INSERT INTO meta_events (pixel_id, event_name, event_id, order_id, landing_id, value, at, send_after, status, sent_at, error) VALUES ('1234567890123456','Purchase',$1,$2,$3,$4,$5,$5,$6,$7,$8)`,
      [`purchase-${o.ref}`, o.id, p1, num(o.total), t0, fake ? 'skipped' : 'simulated', fake ? null : t0, fake ? 'Commande annulée ou fausse : pas de Purchase' : null],
    );
  }

  // abandoned orders: typed their number and left. Most were added to Commandes by Pilotix 20 minutes later; two had no
  // wilaya (waiting for a call); one came back and ordered herself; one was set aside.
  const wh = await db.query(`SELECT id FROM warehouses ORDER BY is_default DESC, id LIMIT 1`);
  const leads: [string, string, number | null, string, number | null, number, string][] = [
    ['Lina Mansouri', '0662104455', 16, 'Bab Ezzouar', v0(vars, 1), 35 * 60_000, 'auto'],
    ['Riad Kaci', '0770551230', 31, 'Bir El Djir', v0(vars, 0), 3 * 3600_000, 'auto'],
    ['Meriem', '0551908877', 9, 'Boufarik', v0(vars, 2), 26 * 3600_000, 'auto'],
    ['Imane Lounis', '0698223344', null, '', v0(vars, 2), 50 * 60_000, 'todo'],
    ['', '0779004411', null, '', null, 4 * 3600_000, 'todo'],
    ['Sofiane Touati', '0661889900', 25, 'El Khroub', v0(vars, 0), 2 * day, 'came'],
    ['Nassim', '0540667788', 19, 'El Eulma', v0(vars, 1), 3 * day, 'dismissed'],
  ];
  for (const [name, phone, w, commune, vid, ago, kind] of leads) {
    const lastAt = at(ago);
    let orderId: number | null = null;
    if (kind === 'auto' || kind === 'came') {
      const cust = num(
        (
          await db.query(
            `INSERT INTO customers (phone, name, wilaya_id, orders, last_order_at) VALUES ($1,$2,$3,1,$4) ON CONFLICT (phone) DO UPDATE SET orders = customers.orders + 1 RETURNING id`,
            [phone, name || 'Client', w, lastAt],
          )
        )[0].id,
      );
      const created = at(ago - (kind === 'auto' ? 20 * 60_000 : 3600_000));
      const auto = kind === 'auto';
      const o = (
        await db.query(
          `INSERT INTO orders (ref, created_by, customer_id, customer_name, phone, wilaya_id, commune, channel, source, conf_status, warehouse_id, subtotal, delivery_fee, total, internal_note, landing_id, created_at, updated_at, orig_items, orig_discount)
           VALUES ('PX' || nextval('order_ref_seq'), $1, $2, $3, $4, $5, $6, 'landing', $7, 'new', $8, 9950, 500, 10450, $9, $10, $11, $11, '[]', 0) RETURNING id`,
          [users.admin ?? null, cust, name || 'Client', phone, w, commune, auto ? 'Landing · poussette-canne-pliable · abandonnée' : 'Landing · poussette-canne-pliable', num(wh[0]?.id) || null,
            auto ? 'Commande abandonnée : le client a laissé son numéro sans valider. Appelez-le pour confirmer.' : null, p1, created],
        )
      )[0];
      orderId = num(o.id);
      const title = vars.find((x: any) => num(x.id) === vid)?.title ?? '';
      await db.query(`INSERT INTO order_items (order_id, product_id, variant_id, name, variant_title, qty, unit_price, purchase_price) VALUES ($1,$2,$3,'Poussette canne pliable',$4,1,9950,7200)`, [orderId, pouId, vid, title]);
      await db.query(`INSERT INTO order_events (order_id, at, user_id, kind, from_value, to_value, note) VALUES ($1,$2,NULL,'created',NULL,'new',$3)`, [orderId, created, auto ? 'Commande abandonnée ajoutée par Pilotix' : null]);
    }
    const status = kind === 'auto' || kind === 'came' ? 'converted' : kind === 'dismissed' ? 'dismissed' : 'abandoned';
    const lead = (
      await db.query(
        `INSERT INTO landing_leads (at, last_at, landing_id, product_id, variant_id, qty, unit_price, customer_name, phone, wilaya_id, commune, device, ip, ua, utm, view_id, status, abandoned_at, order_id, auto_order, handled_by, handled_at)
         VALUES ($1,$2,$3,$4,$5,1,9950,$6,$7,$8,$9,'d:demo','105.235.0.1',$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
        [at(ago + 4 * 60_000), lastAt, p1, pouId, vid, name, phone, w, commune, UA, JSON.stringify({ utm_source: 'facebook', adset_id: '120210000000001' }), `demo${phone.slice(-4)}`,
          status, at(ago - 20 * 60_000), orderId, kind === 'auto', kind === 'dismissed' ? users.conf1 ?? null : null, kind === 'abandoned' || kind === 'todo' ? null : at(ago - 25 * 60_000)],
      )
    )[0];
    await db.query(
      `INSERT INTO meta_events (pixel_id, event_name, event_id, lead_id, landing_id, value, at, send_after, status, sent_at) VALUES ('1234567890123456','InitiateCheckout',$1,$2,$3,9950,$4,$4,'simulated',$4)`,
      [`ic-demo${phone.slice(-4)}`, lead.id, p1, at(ago)],
    );
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
    // a bot's start of checkout was dropped before reaching Meta
    if (status !== 'restored')
      await db.query(
        `INSERT INTO meta_events (pixel_id, event_name, event_id, landing_id, value, at, send_after, status, error) VALUES ('1234567890123456','InitiateCheckout',$1,$2,$3,$4,$4,'skipped','Commande bloquée (fausse)')`,
        [`ic-blocked-${r.id}`, lid, price(lid), at(ago)],
      );
  }
  // two weeks of what the pages received (Protection): most orders pass, a few are put to review or blocked, and two
  // attacks — a competitor's team (one phone, numbers in a row, the same name, at night) and a device agents marked
  const pid = (lid: number) => (lid === p1 ? pouId : num(sac.id));
  const R = (...x: [string, number][]) => JSON.stringify(x.map(([code, points]) => ({ code, points })));
  const UAm = 'Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
  let seq = 0;
  const rnd = (k: number) => {
    const x = Math.sin(++seq * 9301 + k * 49297) * 233280;
    return x - Math.floor(x);
  };
  const submits: unknown[][] = [];
  for (let d = 13; d >= 0; d--) {
    const allowed = 18 + Math.floor(rnd(d) * 22);
    const review = 1 + Math.floor(rnd(d + 50) * 5);
    const blocked = Math.floor(rnd(d + 90) * 4);
    for (let k = 0; k < allowed + review + blocked; k++) {
      const verdict = k < allowed ? 'allow' : k < allowed + review ? 'review' : 'block';
      // customers order in the day and the evening; robots at night
      const hour = verdict === 'block' ? [1, 2, 3, 3, 4, 23][Math.floor(rnd(k) * 6)] : 9 + Math.floor(rnd(k + 7) * 13);
      // that day at that hour, Algiers time (UTC+1)
      const midnight = Math.floor((now + 3600_000) / day) * day - 3600_000;
      const t = midnight - d * day + hour * 3600_000 + Math.floor(rnd(k + 3) * 3600_000);
      if (t > now) continue;
      const lid = rnd(k + 11) < 0.7 ? p1 : p2;
      const reasons =
        verdict === 'allow'
          ? R(['from_ad', -10])
          : verdict === 'review'
            ? [R(['duplicate', 40]), R(['returns_many', 35], ['not_from_ad', 10]), R(['device_two', 15], ['no_browse', 15], ['phone_pasted', 10]), R(['blacklisted', 60])][k % 4]
            : [R(['honeypot', 100], ['ua_bot', 50]), R(['too_fast', 100], ['no_typing', 15]), R(['webdriver', 100], ['pow_missing', 30])][k % 3];
      submits.push([lid, pid(lid), `0${['661', '770', '550', '696'][k % 4]}${String(100000 + Math.floor(rnd(k + 23) * 899999))}`, `105.10${k % 10}.${d}.${k % 250}`, `d:s${d}x${k}`, verdict, verdict === 'block' ? 100 : verdict === 'review' ? 45 : 0, new Date(t).toISOString(), reasons]);
    }
  }
  // the competitor's team: one phone, 7 numbers in a row, « Mohamed Ali », Alger, between 1 and 3 at night two days ago
  for (let k = 0; k < 7; k++)
    submits.push([p1, pouId, `05551234${String(10 + k * 3)}`, '105.235.44.12', 'd:team7a', k < 3 ? 'review' : 'block', k < 3 ? 70 : 100, at(2 * day + (3 - k * 0.3) * 3600_000),
      k < 3 ? R(['phone_near', 40], ['device_two', 15], ['no_browse', 15], ['phone_pasted', 10]) : R(['device_numbers', 100], ['phone_near', 40], ['name_reused', 30])]);
  // a device agents marked « concurrent » after its first fake order: everything after it is blocked
  for (let k = 0; k < 4; k++)
    submits.push([p2, num(sac.id), `0770${String(220000 + k * 1111)}`, '41.97.10.8', 'd:x92k', 'block', 100, at(5 * day - k * 7200_000), R(['device_competitor', 100], ['not_from_ad', 10])]);
  for (const r of submits)
    await db.query(`INSERT INTO landing_submits (landing_id, product_id, phone, ip, fp, verdict, score, at, reasons, ua) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [...r, UAm]);
  // the same orders in « Commandes bloquées », with their reasons
  for (const r of submits.filter((x) => x[5] === 'block' && (x[4] === 'd:team7a' || x[4] === 'd:x92k')))
    await db.query(
      `INSERT INTO landing_blocked (landing_id, product_id, qty, unit_price, customer_name, phone, wilaya_id, commune, score, reasons, ip, user_agent, fp, at)
       VALUES ($1,$2,1,$3,$4,$5,16,'Bab Ezzouar',100,$6,$7,$8,$9,$10)`,
      [r[0], r[1], price(r[0] as number), r[4] === 'd:team7a' ? 'Mohamed Ali' : 'Rachid B', r[2], r[8], r[3], UAm, r[4], r[7]],
    );
  await db.query(`INSERT INTO fraud_marks (at, kind, value, reason, device, phone, by_user) VALUES ($1,'device','d:x92k','competitor','d:x92k','0770219999',$2)`, [at(5 * day + 3600_000), users.conf1 ?? null]);
  await db.query(`INSERT INTO fraud_marks (at, kind, value, reason, device, phone, by_user) VALUES ($1,'device','d:s3x41','fake','d:s3x41','0661448210',$2)`, [at(3 * day), users.conf1 ?? null]);
  // the demo's other customers each have their own phone (one device for all of them would look like an attack)
  await db.query(`UPDATE landing_submits SET fp = 'd:demo' || id WHERE fp = 'd:demo'`);
  await db.query(`UPDATE landing_blocked SET fp = 'd:demo' || id WHERE fp = 'd:demo'`);
  await db.query(`UPDATE landing_leads SET device = 'd:demo' || id WHERE device = 'd:demo'`);
  // the ad each landing order came from (what Meta puts in the link when the ad's « URL parameters » are set)
  await db.query(
    `UPDATE orders o SET utm = COALESCE(o.utm, '{}'::jsonb) || jsonb_build_object('utm_source', 'facebook', 'utm_medium', 'paid', 'utm_campaign', 'Bébé · Conversions', 'utm_content', a.name, 'ad_id', a.id, 'adset_id', a.adset_id, 'campaign_id', '120210000000000777')
     FROM (SELECT id, adset_id, name, row_number() OVER (ORDER BY id) - 1 AS k, count(*) OVER () AS n FROM ads) a
     WHERE o.channel = 'landing' AND a.k = o.id % a.n`,
  );
  // the shop's pixels (Réglages › Pixels): a Meta one by default, a TikTok one
  await db.query(
    `INSERT INTO tracking_pixels (platform, name, pixel_id, is_default) VALUES ('meta', 'Pixel principal', '1234567890123456', true), ('meta', 'Pixel bébé (2e compte)', '6543210987654321', false), ('tiktok', 'TikTok bébé', 'CQDEMO1ABC2DEF3GHI4J', true)
     ON CONFLICT (platform, pixel_id) DO NOTHING`,
  );
  // a group page: several products on one page (each opens its landing page)
  const pages = await db.query('SELECT id FROM landing_pages WHERE active ORDER BY id LIMIT 6');
  if (pages.length >= 2) {
    const g = (
      await db.query(
        `INSERT INTO landing_groups (slug, title, subtitle, color, theme, best_page_id, items, views, created_by) VALUES ('bebe', 'كل ما يحتاجه طفلك 👶', 'اختر المنتج واطلب في دقيقة', '#0f766e', 'grid', $1, $2, 412, $3) RETURNING id`,
        [pages[0].id, JSON.stringify(pages.map((p: any) => ({ pageId: Number(p.id), tab: '', note: '' }))), users.marketer ?? users.admin ?? null],
      )
    )[0];
    for (const [k, p] of pages.entries()) await db.query('INSERT INTO landing_group_clicks (group_id, page_id, clicks) VALUES ($1,$2,$3)', [g.id, p.id, 90 - k * 13]);
  }
  void p2;
}
