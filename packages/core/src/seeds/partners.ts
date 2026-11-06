import type { Db } from '../db';
import { num } from '../db';
import { demoThumb } from '../modules/partners';

/**
 * Demo data for Marketing › Influenceurs: four creators (two who said yes on Instagram, one
 * request waiting, one Facebook Page), their posts that tag the shop (ready for an ad, to check, refused by Meta, one of
 * a creator the shop does not know yet), two ads in two names that ran (a new ad of the stroller with Amina, Rym's reel
 * boosted) with their days and the orders they brought, and a draft with the waiting creator.
 */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const H = 3_600_000;
  const D = 24 * H;
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const dayOf = (k: number) => new Date(now + 3_600_000 - k * D).toISOString().slice(0, 10);
  const prod = async (sku: string) => num((await db.query('SELECT id FROM products WHERE sku = $1', [sku]))[0]?.id) || null;
  const pous = num((await db.query("SELECT product_ids[1] AS p FROM adsets WHERE id = '120200001'"))[0]?.p) || null;
  const ens = (await prod('PX-ENS')) ?? (num((await db.query("SELECT product_ids[1] AS p FROM adsets WHERE id = '120200002'"))[0]?.p) || null);
  const lit = await prod('PX-LIT');

  // the creators
  const P = await db.query(
    `INSERT INTO ad_partners (ig_username, ig_id, fb_page_id, name, status, permission_id, note, requested_by, requested_at, checked_at, created_at) VALUES
      ('amina.style','178419900000011','104900000000011','Amina Style','approved','17890000000000011','1 500 DA par vidéo · 2 vidéos par mois',$1,$3,$5,$3),
      ('rym.beauty.dz','178419900000022',NULL,'Rym Beauty','approved','17890000000000022','',$1,$4,$5,$4),
      ('yasmine.mamans',NULL,NULL,'@yasmine.mamans','pending','17890000000000033','Contactée sur WhatsApp',$2,$6,$5,$6),
      (NULL,NULL,'104900000000044','Lina Maman DZ','page',NULL,'',$1,NULL,$5,$7)
     RETURNING id, ig_username, fb_page_id`,
    [users.vendeur, users.marketer, iso(41 * D), iso(25 * D), iso(2 * H), iso(2 * D), iso(9 * D)],
  );
  const pid = (k: string) => num(P.find((r: any) => r.ig_username === k || r.fb_page_id === k)?.id);
  const amina = pid('amina.style');
  const rym = pid('rym.beauty.dz');
  const yasmine = pid('yasmine.mamans');
  const lina = pid('104900000000044');

  // their posts that tag the shop (Meta's Advertisable Content API)
  type Post = [
    id: string,
    partner: number | null,
    platform: string,
    media: string,
    post: string,
    caption: string,
    author: object,
    daysAgo: number,
    eligibility: string,
    permission: string,
    errors: object[],
    usage: string,
    insights: object,
  ];
  const author = (name: string, ig: string | null, page: string | null) => ({ name, igId: ig, pageId: page, picture: null });
  const posts: Post[] = [
    [
      '17901000000000101',
      amina,
      'INSTAGRAM',
      'VIDEO',
      'REEL',
      'Ma poussette pour les sorties 🛒 Elle se plie d’une main, même avec bébé dans les bras. Merci @bebeconfort.dz 💛 #maman #dz',
      author('amina.style', '178419900000011', '104900000000011'),
      6,
      'AD_READY',
      'APPROVED',
      [],
      'ACTIVE',
      { likes: 4210, comments: 188, views: 96400, reach: 71200, shares: 240, saves: 610 },
    ],
    [
      '17901000000000102',
      amina,
      'INSTAGRAM',
      'IMAGE',
      'FEED',
      'Sortie au parc avec la nouvelle poussette 🌿 légère et solide. Livraison partout en Algérie avec @bebeconfort.dz',
      author('amina.style', '178419900000011', '104900000000011'),
      15,
      'AD_READY',
      'APPROVED',
      [],
      'NEVER_USED',
      { likes: 1980, comments: 64, views: null, reach: 22800, shares: 31, saves: 140 },
    ],
    [
      '17901000000000103',
      amina,
      'INSTAGRAM',
      'VIDEO',
      'STORY',
      'Code -10 % chez @bebeconfort.dz 👶',
      author('amina.style', '178419900000011', '104900000000011'),
      2,
      'NEEDS_ATTENTION',
      'APPROVED',
      [{ code: 'STORY_LINK_STICKER', message: 'Le sticker lien de la story ne passe pas dans une pub : il sera enlevé.', severity: 'warning' }],
      'NEVER_USED',
      { likes: null, comments: null, views: 12900, reach: 12100, shares: null, saves: null },
    ],
    [
      '17901000000000201',
      rym,
      'INSTAGRAM',
      'VIDEO',
      'REEL',
      'طقم البيبي من عند @bebeconfort.dz 😍 القماش رطب بزاف و الألوان شابين. الخلاص عند الاستلام ✅',
      author('rym.beauty.dz', '178419900000022', null),
      19,
      'AD_READY',
      'APPROVED',
      [],
      'ACTIVE',
      { likes: 2650, comments: 143, views: 58300, reach: 44100, shares: 96, saves: 380 },
    ],
    [
      '17901000000000202',
      rym,
      'INSTAGRAM',
      'CAROUSEL',
      'FEED',
      'Mes 3 coups de cœur bébé du mois 🧸 avec la musique du moment 🎶',
      author('rym.beauty.dz', '178419900000022', null),
      26,
      'INELIGIBLE',
      'APPROVED',
      [{ code: 'REEL_CAN_NOT_BE_BOOSTED_COPY_RIGHTED_MUSIC', message: 'Une musique protégée empêche cette publication de devenir une pub.', severity: 'error' }],
      'NEVER_USED',
      { likes: 1430, comments: 52, views: null, reach: 19800, shares: 12, saves: 95 },
    ],
    [
      '17901000000000301',
      yasmine,
      'INSTAGRAM',
      'VIDEO',
      'REEL',
      'Le lit parapluie qui m’a sauvée en vacances 🙏 merci @bebeconfort.dz',
      author('yasmine.mamans', '178419900000033', null),
      4,
      'AD_READY',
      'PENDING',
      [],
      'NEVER_USED',
      { likes: 980, comments: 41, views: 23700, reach: 18200, shares: 22, saves: 77 },
    ],
    [
      '104900000000044_901',
      lina,
      'FACEBOOK',
      'VIDEO',
      'FEED',
      'Mon avis sur l’ensemble naissance de Bébé Confort DZ : doux, bien cousu, et livré en 48 h à Oran.',
      author('Lina Maman DZ', null, '104900000000044'),
      8,
      'AD_READY',
      'APPROVED',
      [],
      'NEVER_USED',
      { likes: 760, comments: 58, views: 15400, reach: 13900, shares: 34, saves: null },
    ],
    [
      '17901000000000901',
      null,
      'INSTAGRAM',
      'IMAGE',
      'FEED',
      'Petit déballage 📦 @bebeconfort.dz livré à Sétif en 2 jours, très contente !',
      author('sara.dz.home', '178419900000099', null),
      3,
      'AD_READY',
      'PENDING',
      [],
      'NEVER_USED',
      { likes: 310, comments: 19, views: null, reach: 4100, shares: 3, saves: 12 },
    ],
  ];
  for (const [id, partner, platform, media, post, caption, a, daysAgo, eligibility, permission, errors, usage, insights] of posts)
    await db.query(
      `INSERT INTO ad_partner_content (content_id, partner_id, platform, media_type, post_type, caption, permalink, author, posted_on, eligibility, permission, errors, ad_usage, insights, thumb, seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (content_id) DO NOTHING`,
      [id, partner, platform, media, post, caption, null, JSON.stringify(a), dayOf(daysAgo), eligibility, permission, JSON.stringify(errors), usage, JSON.stringify(insights), demoThumb(id), iso(2 * H)],
    );
  await db.query(`INSERT INTO settings (key, value) VALUES ('partners', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify({ at: iso(2 * H), error: null })]);

  // two ads in two names that ran (a campaign of their own, with a budget for its whole life: it does not add to the shop's
  // spending per day, which the owner's limit checks), and a draft with the creator who has not answered yet
  await db.query(
    `INSERT INTO ad_campaigns (id, account_id, name, objective, status, daily_budget_cents, bid_strategy, changed_at) VALUES ('120330006','120211887','Influenceurs','OUTCOME_SALES','ACTIVE',NULL,NULL,NULL) ON CONFLICT (id) DO NOTHING`,
  );
  const spec = (name: string, productId: number | null, usd: number, extra: object) =>
    JSON.stringify({
      goal: 'sales',
      productId,
      name,
      mediaIds: [],
      text: { primary: '', headline: '' },
      channels: ['messenger'],
      welcome: null,
      phone: null,
      formId: null,
      newForm: null,
      postId: null,
      budgetUsd: usd,
      budgetLevel: 'adset',
      split: 'one',
      excludeWilayas: [],
      ageMin: 18,
      ageMax: 65,
      genders: [],
      advantageAudience: true,
      useAudiences: true,
      bid: null,
      start: null,
      pixelId: null,
      partnerId: null,
      partnerContentId: null,
      ...extra,
    });
  const L = await db.query(
    `INSERT INTO ad_launches (mode, goal, product_id, name, spec, budget_cents, status, step, campaign_id, adset_ids, ad_ids, by_user, partner_id, partner_content_id, created_at, updated_at, live_at) VALUES
      ('simple','sales',$1,'Poussette × Amina Style',$3,800,'live','done','120330006','{120200010}','{120210000101,120210000102}',$5,$6,NULL,$8,$8,$8),
      ('simple','sales',$2,'Ensemble bébé — reel de Rym',$4,600,'live','done','120330006','{120200011}','{120210000111}',$5,$7,'17901000000000201',$9,$9,$9)
     RETURNING id`,
    [
      pous,
      ens,
      spec('Poussette × Amina Style', pous, 8, { partnerId: amina }),
      spec('Ensemble bébé — reel de Rym', ens, 6, { partnerId: rym, partnerContentId: '17901000000000201' }),
      users.vendeur,
      amina,
      rym,
      iso(21 * D),
      iso(18 * D),
    ],
  );
  await db.query(
    `INSERT INTO ad_launches (mode, goal, product_id, name, spec, budget_cents, status, by_user, partner_id, created_at, updated_at) VALUES ('simple','sales',$1,'Lit parapluie × Yasmine',$2,500,'draft',$3,$4,$5,$5)`,
    [lit, spec('Lit parapluie × Yasmine', lit, 5, { partnerId: yasmine }), users.marketer, yasmine, iso(20 * H)],
  );
  await db.query(
    `INSERT INTO adsets (id, name, campaign, campaign_id, account_id, product_ids, marketer_id, status, daily_budget_cents, goal, currency, launch_id) VALUES
      ('120200010','Poussette × Amina Style','Influenceurs','120330006','120211887',$1,NULL,'ACTIVE',NULL,'sales','USD',$3),
      ('120200011','Ensemble bébé — reel de Rym','Influenceurs','120330006','120211887',$2,NULL,'ACTIVE',NULL,'sales','USD',$4)
     ON CONFLICT (id) DO NOTHING`,
    [pous ? [pous] : [], ens ? [ens] : [], num(L[0].id), num(L[1].id)],
  );
  await db.query(
    `INSERT INTO ads (id, adset_id, name, status, is_video) VALUES ('120210000101','120200010','Poussette × Amina · Vidéo 1','ACTIVE',true), ('120210000102','120200010','Poussette × Amina · Photo 1','ACTIVE',false),
      ('120210000111','120200011','Reel de Rym','ACTIVE',true) ON CONFLICT (id) DO NOTHING`,
  );
  await db.query(`UPDATE ad_campaigns SET launch_id = $1 WHERE id = '120330006'`, [num(L[0].id)]);

  // their days: the stroller with Amina for 21 days, Rym's reel for 18
  let s = 4242;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const runs: [adset: string, ads: [string, number][], days: number, usd: number, cvr: number][] = [
    [
      '120200010',
      [
        ['120210000101', 0.7],
        ['120210000102', 0.3],
      ],
      21,
      8,
      0.042,
    ],
    ['120200011', [['120210000111', 1]], 18, 6, 0.05],
  ];
  for (const [adset, ads, days, usd, cvr] of runs)
    for (let k = days; k >= 1; k--) {
      const day = dayOf(k);
      const cents = Math.round(usd * (0.8 + rnd() * 0.4) * 100);
      const imp = Math.round((cents / 100 / 1.9) * 1000);
      const clicks = Math.round(imp * (0.021 + rnd() * 0.006));
      const lpv = Math.round(clicks * 0.78);
      const pur = Math.round(lpv * cvr * (0.7 + rnd() * 0.6));
      const v3 = Math.round(imp * 0.34);
      await db.query(
        `INSERT INTO ad_insights (day, adset_id, spend_cents, impressions, reach, clicks, lpv, purchases, video_3s, thruplays) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (day, adset_id) DO NOTHING`,
        [day, adset, cents, imp, Math.round(imp / 1.4), clicks, lpv, pur, v3, Math.round(v3 * 0.3)],
      );
      for (const [ad, f] of ads)
        await db.query(
          `INSERT INTO ad_daily (day, ad_id, adset_id, spend_cents, impressions, reach, clicks, lpv, purchases, video_3s, thruplays) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (day, ad_id) DO NOTHING`,
          [day, ad, adset, Math.round(cents * f), Math.round(imp * f), Math.round((imp / 1.4) * f), Math.round(clicks * f), Math.round(lpv * f), Math.round(pur * f), Math.round(v3 * f), Math.round(v3 * 0.3 * f)],
        );
    }

  // the orders they brought: the ad's ids on the order (what the ad's link gives the sales page)
  const tag = async (productId: number | null, n: number, days: number, ad: string, adset: string) => {
    if (!productId) return;
    await db.query(
      `UPDATE orders o SET utm = jsonb_build_object('utm_source', 'instagram', 'utm_medium', 'paid', 'utm_campaign', 'Influenceurs', 'ad_id', $3::text, 'adset_id', $4::text, 'campaign_id', '120330006'), adset_id = $4
       WHERE o.id IN (SELECT o2.id FROM orders o2 JOIN order_items i ON i.order_id = o2.id AND i.product_id = $1 AND NOT i.is_upsell
                      WHERE o2.utm IS NULL AND o2.channel <> 'landing' AND NOT o2.is_exchange AND o2.created_at >= $2 ORDER BY o2.created_at DESC LIMIT $5)`,
      [productId, iso(days * D), ad, adset, n],
    );
  };
  await tag(pous, 14, 21, '120210000101', '120200010');
  // (the set's last 10 days of chat orders are the messages campaign's already)
  await tag(ens, 9, 18, '120210000111', '120200011');
}
