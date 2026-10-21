import type { Db } from '../db';
import { num } from '../db';

/**
 * Demo data for Publicité: the main seed creates two ad sets with 30 days of results; here we add three more ad sets
 * (one with tired videos, one of the owner with an exhausted audience, one not linked to a product yet), 75 days of
 * results with reach / landing page views / thruplays, the ads (copies) of each ad set and the dollar rate of past months.
 */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  let s = 777;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const prod = async (sku: string) => num((await db.query('SELECT id FROM products WHERE sku = $1', [sku]))[0]?.id);
  const lit = await prod('PX-LIT');
  const bib = await prod('PX-BIB');
  await db.query(
    `INSERT INTO adsets (id, name, campaign, product_ids, marketer_id, status) VALUES
      ('120200003','Lit parapluie — retargeting 30 j','Bébé confort',$1,$3,'ACTIVE'),
      ('120200004','Biberon — Algérie large','Puériculture',$2,NULL,'ACTIVE'),
      ('120200005','Test vidéo tapis d’éveil','Nouveautés','{}',$3,'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    [[lit], [bib], users.marketer],
  );

  // profile of each ad set: daily $ budget, CPM ($), CTR, hook rate, purchases per $, how the last week evolves
  const P: Record<string, { usd: number; cpm: number; ctr: number; hook: number; cvr: number; freq: number; tired?: boolean; saturated?: boolean }> = {
    '120200001': { usd: 22, cpm: 2.2, ctr: 0.021, hook: 0.32, cvr: 0.035, freq: 1.5 },
    '120200002': { usd: 12, cpm: 1.8, ctr: 0.019, hook: 0.27, cvr: 0.03, freq: 1.7 },
    '120200003': { usd: 15, cpm: 2.6, ctr: 0.017, hook: 0.3, cvr: 0.028, freq: 2.0, tired: true },
    '120200004': { usd: 10, cpm: 2.0, ctr: 0.016, hook: 0.25, cvr: 0.03, freq: 2.0, saturated: true },
    '120200005': { usd: 6, cpm: 1.6, ctr: 0.012, hook: 0.14, cvr: 0.01, freq: 1.3 },
  };
  const ads: { id: string; adset: string; name: string; video: boolean; w: number }[] = [];
  let n = 1;
  for (const [id, names] of Object.entries({
    '120200001': ['Vidéo maman pliage 1 main', 'Vidéo unboxing', 'Photo carrousel couleurs'],
    '120200002': ['Vidéo bébé qui dort', 'Vidéo 3 tailles'],
    '120200003': ['Vidéo montage 10 s', 'Vidéo avis client'],
    '120200004': ['Vidéo anti-colique', 'Vidéo comparaison'],
    '120200005': ['Vidéo tapis musical'],
  })) {
    names.forEach((name, k) => ads.push({ id: `1202100${String(n++).padStart(2, '0')}`, adset: id, name, video: !/photo/i.test(name), w: k === 0 ? 0.55 : (0.45 / Math.max(1, names.length - 1)) }));
  }
  for (const a of ads) await db.query(`INSERT INTO ads (id, adset_id, name, status, is_video) VALUES ($1,$2,$3,'ACTIVE',$4) ON CONFLICT (id) DO NOTHING`, [a.id, a.adset, a.name, a.video]);

  const day0 = new Date(now).toISOString().slice(0, 10);
  const dayOf = (k: number) => new Date(Date.parse(day0 + 'T00:00:00Z') - k * 86_400_000).toISOString().slice(0, 10);
  const setRows: unknown[][] = [];
  const adRows: unknown[][] = [];
  for (let k = 75; k >= 0; k--) {
    const day = dayOf(k);
    const late = k <= 6;
    for (const [id, p] of Object.entries(P)) {
      if (id === '120200005' && k > 20) continue; // a recent test
      const usd = p.usd * (0.75 + rnd() * 0.5) * (p.saturated && late ? 1.1 : 1);
      const cpm = p.cpm * (p.saturated && late ? 1.35 : 1) * (0.9 + rnd() * 0.2);
      const imp = Math.round((usd / cpm) * 1000);
      const freq = p.freq * (late && (p.saturated || p.tired) ? 1.45 : 1);
      const reach = Math.round(imp / freq);
      const hook = p.hook * (p.tired && late ? 0.6 : 1) * (0.92 + rnd() * 0.16);
      const ctr = p.ctr * (p.tired && late ? 0.7 : 1) * (0.9 + rnd() * 0.2);
      const clicks = Math.round(imp * ctr);
      const lpv = Math.round(clicks * (0.72 + rnd() * 0.12));
      const pur = Math.round(lpv * p.cvr * (p.tired && late ? 0.6 : 1) * (0.7 + rnd() * 0.6));
      const v3 = Math.round(imp * hook);
      const tp = Math.round(v3 * (0.22 + rnd() * 0.1));
      const cents = Math.round(usd * 100);
      setRows.push([day, id, cents, imp, reach, clicks, lpv, pur, v3, tp]);
      // split between its ads
      for (const a of ads.filter((x) => x.adset === id)) {
        const f = a.w;
        adRows.push([day, a.id, id, Math.round(cents * f), Math.round(imp * f), Math.round(reach * f), Math.round(clicks * f), Math.round(lpv * f), Math.round(pur * f), a.video ? Math.round(v3 * f) : 0, a.video ? Math.round(tp * f) : 0]);
      }
    }
  }
  const put = async (table: string, cols: string[], rows: unknown[][], conflict: string) => {
    for (let i = 0; i < rows.length; i += 150) {
      const chunk = rows.slice(i, i + 150);
      const params: unknown[] = [];
      const values = chunk.map((r) => `(${r.map((v) => (params.push(v), `$${params.length}`)).join(',')})`).join(',');
      await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${values} ${conflict}`, params);
    }
  };
  await put(
    'ad_insights',
    ['day', 'adset_id', 'spend_cents', 'impressions', 'reach', 'clicks', 'lpv', 'purchases', 'video_3s', 'thruplays'],
    setRows,
    `ON CONFLICT (day, adset_id) DO UPDATE SET spend_cents = EXCLUDED.spend_cents, impressions = EXCLUDED.impressions, reach = EXCLUDED.reach, clicks = EXCLUDED.clicks,
       lpv = EXCLUDED.lpv, purchases = EXCLUDED.purchases, video_3s = EXCLUDED.video_3s, thruplays = EXCLUDED.thruplays`,
  );
  await put('ad_daily', ['day', 'ad_id', 'adset_id', 'spend_cents', 'impressions', 'reach', 'clicks', 'lpv', 'purchases', 'video_3s', 'thruplays'], adRows, 'ON CONFLICT (day, ad_id) DO NOTHING');

  // dollar rate of the previous months
  const ym = (k: number) => {
    const d = new Date(now);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1)).toISOString().slice(0, 7);
  };
  await db.query('INSERT INTO fx_rates (ym, rate) VALUES ($1, 246), ($2, 248), ($3, 244) ON CONFLICT (ym) DO NOTHING', [ym(1), ym(2), ym(3)]);
}
