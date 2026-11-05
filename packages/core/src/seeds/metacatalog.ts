import type { Db } from '../db';
import { num } from '../db';

// Demo of Marketing › Catalogue: a few more landing pages (pictures drawn in SVG; the travel cot's is too small for
// Meta), the shop's catalog at Meta, and four lists: three sent (one with products to fix), one not sent yet.

const svg = (body: string, bg: string) =>
  'data:image/svg+xml,' +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600"><defs><radialGradient id="g" cx=".5" cy=".4" r=".7"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${bg}"/></radialGradient></defs><rect width="600" height="600" fill="url(#g)"/><ellipse cx="300" cy="520" rx="210" ry="18" fill="#000" opacity=".08"/>${body}</svg>`);

const PICS: Record<string, [string, string]> = {
  ensemble: ['#FCE7F3', `<path d="M215 170 L265 150 Q300 185 335 150 L385 170 L440 230 L400 265 L375 245 L375 420 Q375 460 335 470 L265 470 Q225 460 225 420 L225 245 L200 265 L160 230Z" fill="#F9A8D4"/><path d="M265 150 Q300 185 335 150" fill="none" stroke="#DB2777" stroke-width="8"/><circle cx="300" cy="300" r="10" fill="#fff"/><circle cx="300" cy="340" r="10" fill="#fff"/><path d="M430 120 Q470 70 510 120 L510 160 L430 160Z" fill="#FBCFE8"/><circle cx="470" cy="70" r="14" fill="#F472B6"/>`],
  biberon: ['#DBEAFE', `<rect x="245" y="110" width="110" height="40" rx="14" fill="#93C5FD"/><path d="M270 110 Q300 40 330 110Z" fill="#FDE68A"/><rect x="230" y="150" width="140" height="330" rx="46" fill="#DBEAFE" stroke="#60A5FA" stroke-width="8"/><g stroke="#3B82F6" stroke-width="6" stroke-linecap="round"><path d="M240 250h30M240 310h30M240 370h30M240 430h30"/></g><rect x="240" y="300" width="120" height="170" rx="36" fill="#BFDBFE" opacity=".8"/>`],
  lit: ['#E7E5E4', `<rect x="120" y="190" width="360" height="250" rx="26" fill="#D6D3D1"/><rect x="150" y="220" width="300" height="190" rx="14" fill="#F5F5F4"/><g stroke="#A8A29E" stroke-width="5"><path d="M180 220v190M210 220v190M240 220v190M270 220v190M300 220v190M330 220v190M360 220v190M390 220v190M420 220v190"/></g><rect x="120" y="180" width="360" height="26" rx="13" fill="#57534E"/><g fill="#57534E"><rect x="130" y="440" width="24" height="50" rx="8"/><rect x="446" y="440" width="24" height="50" rx="8"/></g>`],
  chaise: ['#FFEDD5', `<g stroke="#374151" stroke-width="10" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M220 300 L170 500 M380 300 L430 500 M200 420 L400 420"/></g><rect x="215" y="120" width="170" height="200" rx="40" fill="#FDBA74"/><rect x="190" y="280" width="220" height="40" rx="18" fill="#FB923C"/><rect x="150" y="250" width="110" height="22" rx="11" fill="#EA580C"/>`],
  bodies: ['#EEF2FF', `<g><path d="M200 330 L240 316 Q270 340 300 316 L340 330 L380 370 L352 394 L336 380 L336 470 L204 470 L204 380 L188 394 L160 370Z" fill="#E0E7FF"/><path d="M240 250 L280 236 Q310 260 340 236 L380 250 L420 290 L392 314 L376 300 L376 390 L244 390 L244 300 L228 314 L200 290Z" fill="#FDE68A"/><path d="M280 170 L320 156 Q350 180 380 156 L420 170 L460 210 L432 234 L416 220 L416 310 L284 310 L284 220 L268 234 L240 210Z" fill="#BBF7D0"/></g>`],
};

const PAGES: { sku: string; pic: keyof typeof PICS; slug: string; title: string; label: string; text: string; size?: number }[] = [
  { sku: 'PX-ENS', pic: 'ensemble', slug: 'ensemble-bebe-3-pieces', title: 'طقم أطفال 3 قطع قطن ناعم', label: 'المقاس', text: '# طقم أطفال 3 قطع\n- قطن 100٪ ناعم على بشرة طفلك\n- 3 مقاسات من الولادة حتى 12 شهر\n\n✅ الدفع عند الاستلام في جميع الولايات' },
  { sku: 'PX-BIB', pic: 'biberon', slug: 'biberon-anti-colique', title: 'رضاعة ضد المغص 260 مل', label: 'اللون', text: '# رضاعة ضد المغص\n- صمام يمنع دخول الهواء\n- سهلة التنظيف\n\n✅ الدفع عند الاستلام' },
  { sku: 'PX-LIT', pic: 'lit', slug: 'lit-parapluie', title: 'سرير أطفال قابل للطي', label: 'اللون', text: '# سرير أطفال قابل للطي\n- يطوى في حقيبة\n- مرتبة مريحة\n\n✅ الدفع عند الاستلام', size: 400 },
  { sku: 'PX-CHA', pic: 'chaise', slug: 'chaise-haute-evolutive', title: 'كرسي طعام للأطفال قابل للتعديل', label: 'اللون', text: '# كرسي طعام يكبر مع طفلك\n- من 6 أشهر حتى 6 سنوات\n- يتحول إلى كرسي ومكتب\n\n✅ الدفع عند الاستلام' },
  { sku: 'PX-BOD', pic: 'bodies', slug: 'lot-6-bodies-coton', title: 'مجموعة 6 بوديات قطن', label: 'المقاس', text: '# 6 بوديات قطن\n- أزرار سهلة\n- 4 مقاسات\n\n✅ الدفع عند الاستلام' },
];

const LISTS: { name: string; skus: string[]; sent: number | null; changed?: number }[] = [
  { name: 'Sortie et balade', skus: ['PX-POU', 'PX-SAC', 'PX-LIT', 'PX-ECH'], sent: 0.2 },
  { name: 'Bébé 0-6 mois', skus: ['PX-ENS', 'PX-BIB', 'PX-BOD'], sent: 1 },
  { name: 'Promo de la semaine', skus: ['PX-POU'], sent: 3 },
  { name: 'Nouveautés', skus: ['PX-CHA', 'PX-BOD'], sent: null },
];

/** users: demo account key → id. */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const H = 3_600_000;
  const at = (h: number) => new Date(now - h * H).toISOString();
  const pid = async (sku: string) => num((await db.query(`SELECT id FROM products WHERE sku = $1`, [sku]))[0]?.id);
  for (const [k, p] of PAGES.entries()) {
    const id = await pid(p.sku);
    if (!id || (await db.query(`SELECT 1 FROM landing_pages WHERE product_id = $1`, [id])).length) continue;
    const [bg, body] = PICS[p.pic];
    const s = p.size ?? 900;
    await db.query(
      `INSERT INTO landing_pages (product_id, slug, title, color, description, variant_label, images, views, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [id, p.slug, p.title, '#0f766e', p.text, p.label, JSON.stringify([{ url: svg(body, bg), w: s, h: s }]), 120 + k * 37, users.marketer ?? null, at(240 + k * 30)],
    );
  }
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('metacatalog', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ catalogId: 'demo-catalog', businessName: 'BabyJoy DZ', pixelsLinked: true, at: at(30) })],
  );
  for (const [k, l] of LISTS.entries()) {
    const sent = l.sent === null ? null : at(l.sent);
    const id = num(
      (
        await db.query(`INSERT INTO meta_catalog_lists (name, position, set_id, sent_at, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`, [
          l.name,
          k + 1,
          null,
          sent,
          users.marketer ?? null,
          at(30 - k),
        ])
      )[0].id,
    );
    if (sent) await db.query(`UPDATE meta_catalog_lists SET set_id = $2 WHERE id = $1`, [id, `demo-set-${id}`]);
    for (const [j, sku] of l.skus.entries()) {
      const p = await pid(sku);
      if (p) await db.query(`INSERT INTO meta_catalog_list_products (list_id, product_id, position, added_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [id, p, j + 1, at(30 - k)]);
    }
  }
  // what Meta holds: every colour / size of the sent lists' products that can go (a page and a big enough picture)
  const ok = await db.query(
    `SELECT DISTINCT v.id AS vid, v.product_id AS pid FROM meta_catalog_list_products lp
     JOIN meta_catalog_lists l ON l.id = lp.list_id AND l.sent_at IS NOT NULL
     JOIN product_variants v ON v.product_id = lp.product_id AND v.active
     JOIN landing_pages g ON g.product_id = lp.product_id AND g.active
     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(g.images) e WHERE (e->>'w')::int < 500)`,
  );
  for (const r of ok)
    await db.query(`INSERT INTO meta_catalog_items (retailer_id, product_id, variant_id, status, sent_at, checked_at) VALUES ($1,$2,$3,'ok',$4,$4) ON CONFLICT DO NOTHING`, [
      `${num(r.pid)}-${num(r.vid)}`,
      num(r.pid),
      num(r.vid),
      at(0.2),
    ]);
}
