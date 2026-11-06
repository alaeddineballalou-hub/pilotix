import type { Db } from '../db';
import { num } from '../db';

// Pilot Content demo: a week of posts around today. One went out two days ago on both networks, one went out on
// Facebook but Instagram refused it (the « Réessayer » case), four are planned (one a carousel, one a video: a Reel), one
// is a draft without a day; a story is planned, a marketer's post waits for the administrator's yes. Before them, six
// weeks of posts that went out, with Meta's numbers, the comments they got, the messages and the orders those brought,
// and the followers of each day (the Results tab). The pictures are drawn in SVG (as the demo landing pages'); all names,
// texts and numbers are invented.

const svg = (body: string, bg: string, h = 600) =>
  'data:image/svg+xml,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 ${h}"><defs><radialGradient id="g" cx=".5" cy=".42" r=".75"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="${bg}"/></radialGradient></defs><rect width="600" height="${h}" fill="url(#g)"/><ellipse cx="300" cy="${h - 80}" rx="210" ry="18" fill="#000" opacity=".08"/>${body}</svg>`,
  );
const stroller = (c: string, bg: string) =>
  svg(
    `<g fill="none" stroke="#374151" stroke-width="10" stroke-linecap="round"><path d="M150 200 L250 470 M250 470 L430 470 M430 470 L470 230 M250 330 L455 330 M470 230 L500 150"/><circle cx="250" cy="490" r="30"/><circle cx="430" cy="490" r="30"/></g><path d="M140 210 Q170 90 330 110 L300 300 Q200 300 140 210Z" fill="${c}"/><path d="M200 300 L450 300 L440 360 L230 360Z" fill="${c}" opacity=".85"/><rect x="470" y="135" width="60" height="18" rx="9" fill="#111827"/>`,
    bg,
  );
const chair = (c: string, bg: string) =>
  svg(
    `<g fill="none" stroke="#374151" stroke-width="12" stroke-linecap="round"><path d="M220 330 L170 600 M380 330 L430 600 M200 470 L400 470"/></g><rect x="200" y="140" width="200" height="200" rx="40" fill="${c}"/><rect x="170" y="300" width="260" height="40" rx="18" fill="${c}" opacity=".8"/><rect x="230" y="190" width="140" height="18" rx="9" fill="#fff" opacity=".6"/>`,
    bg,
    750,
  );
const bag = (c: string, bg: string) =>
  svg(
    `<path d="M220 200 Q220 120 300 120 Q380 120 380 200" fill="none" stroke="#374151" stroke-width="14"/><rect x="170" y="190" width="260" height="300" rx="46" fill="${c}"/><rect x="215" y="300" width="170" height="120" rx="22" fill="#000" opacity=".12"/><rect x="250" y="250" width="100" height="16" rx="8" fill="#fff" opacity=".7"/>`,
    bg,
  );

export async function seed(db: Db, now: number): Promise<void> {
  const pid = async (sku: string) => num((await db.query('SELECT id FROM products WHERE sku = $1', [sku]))[0]?.id) || null;
  const key = () => Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const pic = async (src: string, w: number, h: number) =>
    num((await db.query(`INSERT INTO cm_media (key, w, h, src, created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [key(), w, h, src, new Date(now - 3 * 86_400_000).toISOString()]))[0].id);
  // a video: its still (the file itself is not in the demo)
  const clip = async (src: string, w: number, h: number, duration: number) =>
    num(
      (
        await db.query(`INSERT INTO cm_media (key, kind, mime, duration, ready, w, h, src, bytes, created_at) VALUES ($1,'video','video/mp4',$2,true,$3,$4,$5,$6,$7) RETURNING id`, [
          key(),
          duration,
          w,
          h,
          src,
          38_500_000,
          new Date(now - 3 * 86_400_000).toISOString(),
        ])
      )[0].id,
    );
  // midnight in Algeria today (UTC+1 all year), then a day and an hour from there
  const midnight = Math.floor((now + 3_600_000) / 86_400_000) * 86_400_000 - 3_600_000;
  const at = (day: number, hour: number, min = 0) => new Date(midnight + day * 86_400_000 + hour * 3_600_000 + min * 60_000).toISOString();
  // a planned hour that already passed today moves to tomorrow (the preview opens at any time)
  const later = (hour: number) => (midnight + hour * 3_600_000 > now + 2 * 3_600_000 ? at(0, hour) : at(1, hour + 1 > 23 ? 23 : hour + 1));
  const [pou, cha, sac] = [await pid('PX-POU'), await pid('PX-CHA'), await pid('PX-SAC')];
  const m = {
    pouGris: await pic(stroller('#6B7280', '#E5E7EB'), 1080, 1080),
    pouRose: await pic(stroller('#E88FA6', '#FCE7EE'), 1080, 1080),
    cha: await pic(chair('#3B82F6', '#DBEAFE'), 1080, 1350),
    sacNoir: await pic(bag('#1F2937', '#E5E7EB'), 1080, 1080),
    sacCamel: await pic(bag('#C08A52', '#F5E6D3'), 1080, 1080),
    // a tall still (9:16), as a Reel's
    reel: await clip(
      svg(
        `<g transform="translate(0 233)"><g fill="none" stroke="#374151" stroke-width="10" stroke-linecap="round"><path d="M150 200 L250 470 M250 470 L430 470 M430 470 L470 230 M250 330 L455 330 M470 230 L500 150"/><circle cx="250" cy="490" r="30"/><circle cx="430" cy="490" r="30"/></g><path d="M140 210 Q170 90 330 110 L300 300 Q200 300 140 210Z" fill="#F7A823"/><path d="M200 300 L450 300 L440 360 L230 360Z" fill="#F7A823" opacity=".85"/><rect x="470" y="135" width="60" height="18" rx="9" fill="#111827"/></g>`,
        '#FFE7C2',
        1066,
      ),
      1080,
      1920,
      14,
    ),
  };
  const posts: { caption: string; media: number[]; channels: string[]; product: number | null; publishAt: string | null; status: string; fb?: [string, string]; ig?: [string, string]; igError?: string; lang?: string }[] = [
    {
      caption: '🔥 الپوسيت لي تتطوى في ثانية وحدة\n✅ خفيفة، تدخل في الكوفر تاع الطوموبيل\n🚚 التوصيل لـ 58 ولاية\n💵 الخلاص عند الاستلام\n📩 علّق «السعر» ولا ابعثلنا ميساج باش تطلب\n#الجزائر #dz #پوسيت',
      media: [m.pouGris, m.pouRose],
      channels: ['facebook', 'instagram'],
      product: pou,
      publishAt: at(-2, 20),
      status: 'published',
      fb: ['1029384756_90001', 'https://www.facebook.com/1029384756_90001'],
      ig: ['17890000000090001', 'https://www.instagram.com/p/DEMO1/'],
      lang: 'darija',
    },
    {
      caption: '👶 Chaise haute évolutive, de 6 mois à 6 ans\n✅ Elle grandit avec votre enfant\n🚚 Livraison dans les 58 wilayas\n💵 Paiement à la livraison\n📩 Commentez « prix » ou écrivez-nous en message\n#Algérie #dz #bébé',
      media: [m.cha],
      channels: ['facebook', 'instagram'],
      product: cha,
      publishAt: at(-1, 13),
      status: 'failed',
      fb: ['1029384756_90002', 'https://www.facebook.com/1029384756_90002'],
      igError: 'Instagram : Meta ne permet pas encore à Pilotix de publier. Ajoutez « instagram_content_publish » dans l’app Meta, puis appuyez sur « Continuer avec Facebook » dans Pilot AI › Comptes.',
    },
    {
      caption: '✨ Sac à langer à dos : tout le nécessaire de bébé dans un seul sac\n✅ Noir ou camel\n✅ Poche isotherme pour le biberon\n🚚 Livraison 58 wilayas · paiement à la livraison\n📩 Écrivez-nous en message pour commander\n#Algérie #dz #sacàlanger',
      media: [m.sacNoir, m.sacCamel],
      channels: ['instagram'],
      product: sac,
      publishAt: later(21),
      status: 'scheduled',
      lang: 'fr',
    },
    {
      caption: '🔥 الكرسي تاع الماكلة بـ 9 900 دج\n✅ يكبر مع وليدك من 6 شهور حتى 6 سنين\n🚚 التوصيل لـ 58 ولاية\n💵 الخلاص عند الاستلام\n#الجزائر #dz',
      media: [m.cha],
      channels: ['facebook', 'instagram'],
      product: cha,
      publishAt: at(2, 20, 30),
      status: 'scheduled',
      lang: 'darija',
    },
    {
      caption: '🎬 شوف كيفاش تتطوى الپوسيت في ثانية وحدة\n✅ خفيفة وتدخل في الكوفر\n🚚 التوصيل لـ 58 ولاية · الخلاص عند الاستلام\n#الجزائر #dz #پوسيت',
      media: [m.reel],
      channels: ['facebook', 'instagram'],
      product: pou,
      publishAt: at(3, 19),
      status: 'scheduled',
      lang: 'darija',
    },
    {
      caption: '🎁 Une question sur nos poussettes ? Écrivez-nous en message, l’équipe répond tous les jours de 9 h à 22 h.',
      media: [],
      channels: ['facebook'],
      product: null,
      publishAt: at(4, 12),
      status: 'scheduled',
    },
    {
      caption: 'Idée : la poussette pliée dans le coffre d’une Symbol, en photo',
      media: [m.pouRose],
      channels: ['facebook', 'instagram'],
      product: pou,
      publishAt: null,
      status: 'draft',
    },
  ];
  // a story planned for tomorrow evening (a tall photo), and a marketer's post waiting for the administrator's yes
  // the Reel's tall still, as a photo (9:16)
  const tall = await pic(String((await db.query('SELECT src FROM cm_media WHERE id = $1', [m.reel]))[0].src), 1080, 1920);
  const marketer = num((await db.query(`SELECT id FROM profiles WHERE 'marketer' = ANY(roles) AND NOT ('admin' = ANY(roles)) ORDER BY id LIMIT 1`))[0]?.id) || null;
  const extra: { kind: string; media: number[]; channels: string[]; product: number | null; at: string; status: string; caption: string; by: number | null; first?: string }[] = [
    { kind: 'story', media: [tall], channels: ['facebook', 'instagram'], product: pou, at: at(1, 18), status: 'scheduled', caption: '', by: null },
    {
      kind: 'post',
      media: [m.sacCamel, m.sacNoir],
      channels: ['facebook', 'instagram'],
      product: sac,
      at: at(5, 20),
      status: 'review',
      caption: '✨ الساك تاع الماما لي فيه كلش\n✅ كحل ولا كاميل\n✅ جيب يحفظ السخانة تاع البيبرون\n🚚 التوصيل لـ 58 ولاية · 💵 الخلاص عند الاستلام\n📩 ابعثلنا ميساج باش تطلب\n#الجزائر #dz #ساك',
      by: marketer,
      first: '📩 علّق «السعر» ولا ابعثلنا ميساج 👇',
    },
  ];
  for (const e of extra)
    await db.query(
      `INSERT INTO cm_planned (caption, media, channels, product_id, publish_at, status, kind, first_comment, ai_lang, created_by, updated_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'darija',$9,$9,$10,$10)`,
      [e.caption, e.media, e.channels, e.product, e.at, e.status, e.kind, e.first ?? null, e.by, new Date(now - 86_400_000).toISOString()],
    );
  for (const p of posts) {
    const r = await db.query(
      `INSERT INTO cm_planned (caption, media, channels, product_id, publish_at, status, fb_id, fb_url, ig_id, ig_url, ig_error, ai_lang, published_at, tries, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING id`,
      [
        p.caption,
        p.media,
        p.channels,
        p.product,
        p.publishAt,
        p.status,
        p.fb?.[0] ?? null,
        p.fb?.[1] ?? null,
        p.ig?.[0] ?? null,
        p.ig?.[1] ?? null,
        p.igError ?? null,
        p.lang ?? null,
        p.status === 'published' ? p.publishAt : null,
        p.status === 'published' || p.status === 'failed' ? 1 : 0,
        new Date(now - 3 * 86_400_000).toISOString(),
      ],
    );
    // what went out is a post CM AI knows (its comments are answered about its product)
    for (const [ch, ext] of [['facebook', p.fb], ['instagram', p.ig]] as const)
      if (ext && r[0])
        await db.query(`INSERT INTO cm_posts (channel, external_id, account_id, caption, permalink, product_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (channel, external_id) DO NOTHING`, [
          ch,
          ext[0],
          ch === 'facebook' ? '1029384756' : '17841400000000001',
          p.caption,
          ext[1],
          p.product,
          p.publishAt,
        ]);
  }

  await history(db, now, { pou, cha, sac }, m, at);
  // the manager's settings: two fixed times, the administrator's yes for a marketer's post, the first comment
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('social', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ slots: [{ days: [0, 1, 2, 3, 4, 5, 6], time: '20:00' }, { days: [5, 6], time: '13:00' }], approval: true, firstComment: { on: true, text: '📩 علّق «السعر» ولا ابعثلنا ميساج 👇' } })],
  );
}

/**
 * Six weeks of posts that went out (photos, carousels, Reels, stories, a text), with Meta's numbers, the comments under
 * them (Pilot Comments answered), the conversations those opened and the demo orders they brought (Pilot Message), and the
 * followers of each day.
 */
async function history(db: Db, now: number, pr: { pou: number | null; cha: number | null; sac: number | null }, m: Record<string, number>, at: (day: number, hour: number, min?: number) => string) {
  type H = { day: number; hour: number; min?: number; type: 'photo' | 'carousel' | 'video' | 'story' | 'text'; product: keyof typeof pr | null; nets: ('fb' | 'ig')[]; views: [number, number]; orders: number; extraComments: number; caption: string };
  const H: H[] = [
    { day: -40, hour: 20, type: 'photo', product: 'cha', nets: ['fb', 'ig'], views: [2900, 1800], orders: 2, extraComments: 3, caption: '👶 الكرسي تاع الماكلة لي يكبر مع وليدك\n✅ من 6 شهور حتى 6 سنين\n🚚 التوصيل لـ 58 ولاية · 💵 الخلاص عند الاستلام\n📩 علّق «السعر»\n#الجزائر #dz' },
    { day: -37, hour: 13, type: 'carousel', product: 'pou', nets: ['fb', 'ig'], views: [3400, 2600], orders: 3, extraComments: 4, caption: '🔥 الپوسيت بالألوان كامل\n✅ رمادي ولا روز\n🚚 التوصيل لـ 58 ولاية\n💵 الخلاص عند الاستلام\n📩 ابعثلنا ميساج\n#الجزائر #dz #پوسيت' },
    { day: -34, hour: 21, type: 'video', product: 'pou', nets: ['fb', 'ig'], views: [9800, 12400], orders: 7, extraComments: 9, caption: '🎬 شوف الپوسيت كيفاش تتطوى بيد وحدة\n✅ خفيفة وتدخل في الكوفر\n🚚 التوصيل لـ 58 ولاية · الخلاص عند الاستلام\n📩 علّق «السعر»\n#الجزائر #dz #پوسيت' },
    { day: -31, hour: 20, type: 'photo', product: 'sac', nets: ['ig'], views: [0, 2100], orders: 1, extraComments: 2, caption: '✨ Sac à langer à dos, noir ou camel\n🚚 Livraison 58 wilayas · paiement à la livraison\n📩 Écrivez-nous en message\n#Algérie #dz' },
    { day: -28, hour: 12, type: 'text', product: null, nets: ['fb'], views: [900, 0], orders: 0, extraComments: 1, caption: '🎁 L’équipe répond tous les jours de 9 h à 22 h : posez vos questions en message !' },
    { day: -26, hour: 20, min: 30, type: 'carousel', product: 'sac', nets: ['fb', 'ig'], views: [3100, 2900], orders: 3, extraComments: 3, caption: '✨ الساك تاع الماما : كلش في بلاصة وحدة\n✅ جيب يحفظ السخانة\n🚚 التوصيل لـ 58 ولاية · 💵 الخلاص عند الاستلام\n📩 ابعثلنا ميساج\n#الجزائر #dz' },
    { day: -23, hour: 19, type: 'video', product: 'pou', nets: ['fb', 'ig'], views: [11200, 15800], orders: 9, extraComments: 11, caption: '🎬 الپوسيت في الكوفر تاع سامبول : تدخل !\n✅ تتطوى في ثانية\n🚚 التوصيل لـ 58 ولاية · 💵 الخلاص عند الاستلام\n📩 علّق «السعر»\n#الجزائر #dz #پوسيت' },
    { day: -20, hour: 13, type: 'photo', product: 'cha', nets: ['fb', 'ig'], views: [2200, 1700], orders: 1, extraComments: 2, caption: '👶 Chaise haute évolutive à 9 900 DA\n🚚 Livraison 58 wilayas\n💵 Paiement à la livraison\n📩 Commentez « prix »\n#Algérie #dz' },
    { day: -17, hour: 21, type: 'story', product: 'pou', nets: ['ig'], views: [0, 1400], orders: 1, extraComments: 0, caption: '' },
    { day: -14, hour: 20, type: 'carousel', product: 'pou', nets: ['fb', 'ig'], views: [4100, 3600], orders: 4, extraComments: 5, caption: '🔥 الپوسيت : 3 حوايج لازم تعرفهم\n✅ خفيفة\n✅ تتطوى\n✅ مريحة للبيبي\n🚚 التوصيل لـ 58 ولاية · 💵 الخلاص عند الاستلام\n#الجزائر #dz' },
    { day: -11, hour: 20, type: 'photo', product: 'sac', nets: ['fb', 'ig'], views: [2600, 2300], orders: 2, extraComments: 3, caption: '✨ الساك الكحل رجع !\n🚚 التوصيل لـ 58 ولاية · 💵 الخلاص عند الاستلام\n📩 ابعثلنا ميساج\n#الجزائر #dz' },
    { day: -8, hour: 19, min: 30, type: 'video', product: 'cha', nets: ['fb', 'ig'], views: [7400, 9100], orders: 5, extraComments: 7, caption: '🎬 الكرسي يولي طابلة صغيرة : شوف !\n✅ من 6 شهور حتى 6 سنين\n🚚 التوصيل لـ 58 ولاية · 💵 الخلاص عند الاستلام\n📩 علّق «السعر»\n#الجزائر #dz' },
    { day: -5, hour: 13, type: 'photo', product: 'pou', nets: ['fb', 'ig'], views: [2400, 2000], orders: 1, extraComments: 2, caption: '🔥 Poussette pliable en une seconde\n🚚 Livraison 58 wilayas · paiement à la livraison\n📩 Commentez « prix »\n#Algérie #dz' },
    { day: -4, hour: 20, type: 'story', product: 'sac', nets: ['ig'], views: [0, 1100], orders: 1, extraComments: 0, caption: '' },
  ];
  const pics: Record<string, number[]> = { pou: [m.pouGris, m.pouRose], cha: [m.cha], sac: [m.sacNoir, m.sacCamel] };
  const names = ['Amina', 'Yacine', 'Sara', 'Karim', 'Nour', 'Walid', 'Lina', 'Sofiane', 'Meriem', 'Rania', 'Adel', 'Imane'];
  const asks = ['سومة ؟', 'Prix svp', 'شحال ؟', 'كاين التوصيل لوهران ؟', 'Disponible ?', 'نحب نطلب', 'Combien ?', 'بالخلاص عند الاستلام ؟'];
  const fetched = new Date(now - 3_600_000).toISOString();
  let k = 0;
  /** Comments under a post (Pilot Comments answered them); some opened a conversation that became one of the demo's orders. */
  const sell = async (pid: number, time: string, cmPost: Partial<Record<'fb' | 'ig', number>>, netsIn: ('fb' | 'ig')[], ordersN: number, extra: number) => {
    const t = Date.parse(time);
      // the demo's orders of the 3 days after the post: some came from its comments (a private message, then an order)
      const orders = ordersN ? await db.query(`SELECT id, customer_name, phone, created_at FROM orders WHERE conversation_id IS NULL AND created_at > $1 AND created_at < $2 ORDER BY created_at LIMIT $3`, [time, new Date(t + 3 * 86_400_000).toISOString(), ordersN]) : [];
      const nets = netsIn.filter((x) => cmPost[x]);
      for (let j = 0; j < orders.length + extra; j++) {
        const o: any = orders[j] ?? null;
        const net = nets[j % nets.length];
        const when = o ? Date.parse(String(o.created_at instanceof Date ? o.created_at.toISOString() : o.created_at)) - 40 * 60_000 : t + (j + 1) * 47 * 60_000;
        const who = o ? String(o.customer_name) : names[k % names.length];
        const channel = net === 'fb' ? 'facebook' : 'instagram';
        let conv: number | null = null;
        if (o) {
          const c = await db.query(
            `INSERT INTO conversations (channel, external_id, account_id, customer_name, phone, mode, order_id, orders_count, source, last_message_at, last_customer_at, last_preview, created_at)
             VALUES ($1,$2,$3,$4,$5,'ai',$6,1,$7,$8,$8,$9,$10) ON CONFLICT (channel, external_id) DO NOTHING RETURNING id`,
            [net === 'fb' ? 'messenger' : 'instagram', `demo-sm-${pid}-${j}`, net === 'fb' ? '1029384756' : '17841400000000001', who, o.phone, num(o.id), 'commentaire', new Date(when + 30 * 60_000).toISOString(), 'Commande confirmée ✅', new Date(when + 2 * 60_000).toISOString()],
          );
          conv = c[0] ? num(c[0].id) : null;
          if (conv) {
            await db.query(`UPDATE orders SET conversation_id = $2 WHERE id = $1`, [num(o.id), conv]);
            await db.query(
              `INSERT INTO conv_messages (conversation_id, role, body, meta, created_at) VALUES ($1,'agent',$2,'{"comment":true}'::jsonb,$3), ($1,'customer',$4,NULL,$5), ($1,'agent',$6,NULL,$7)`,
              [conv, 'مرحبا 👋 السومة والتوصيل في الميساج هذا. نحب نعرف الولاية تاعك باش نحسبلك التوصيل ؟', new Date(when + 2 * 60_000).toISOString(), 'وهران، نحب نطلب', new Date(when + 12 * 60_000).toISOString(), 'Commande confirmée ✅ L’équipe vous appelle pour confirmer.', new Date(when + 30 * 60_000).toISOString()],
            );
          }
        }
        await db.query(
          `INSERT INTO cm_comments (post_id, channel, external_id, author_id, author_name, body, status, intent, public_reply, private_reply, private_sent, conversation_id, handled_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'answered',$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (channel, external_id) DO NOTHING`,
          [cmPost[net], channel, `demo-smc-${pid}-${j}`, `u${pid}${j}`, who, asks[(k + j) % asks.length], o ? 'order' : 'price', 'بعثنالك ميساج 📩', o ? 'مرحبا 👋 السومة والتوصيل في الميساج هذا.' : null, !!o, conv, new Date(when + 60_000).toISOString(), new Date(when).toISOString()],
        );
        k++;
      }
  };
  for (const [n, h] of H.entries()) {
    const time = at(h.day, h.hour, h.min ?? 0);
    const t = Date.parse(time);
    const product = h.product ? pr[h.product] : null;
    const media = h.type === 'text' ? [] : h.type === 'video' ? [m.reel] : h.type === 'story' ? [h.product === 'sac' ? m.sacNoir : m.pouRose] : h.type === 'carousel' ? pics[h.product!] : [pics[h.product!][0]];
    const fb = h.nets.includes('fb') ? `1029384756_${80_001 + n}` : null;
    const ig = h.nets.includes('ig') ? String(17_880_000_000_000 + n) : null;
    const story = h.type === 'story';
    const r = await db.query(
      `INSERT INTO cm_planned (caption, media, channels, product_id, publish_at, status, kind, fb_id, fb_url, ig_id, ig_url, ai_lang, published_at, tries, first_comment, fb_comment_id, ig_comment_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'published',$6,$7,$8,$9,$10,'darija',$5,1,$11,$12,$13,$14,$5) RETURNING id`,
      [
        h.caption,
        media,
        h.nets.map((x) => (x === 'fb' ? 'facebook' : 'instagram')),
        product,
        time,
        story ? 'story' : 'post',
        fb,
        fb ? `https://www.facebook.com/${fb}` : null,
        ig,
        ig ? `https://www.instagram.com/p/DEMOH${n}/` : null,
        story ? null : '📩 علّق «السعر» ولا ابعثلنا ميساج 👇',
        story || !fb ? null : `c${fb}`,
        story || !ig ? null : `c${ig}`,
        new Date(t - 2 * 86_400_000).toISOString(),
      ],
    );
    const pid = num(r[0].id);
    // Meta's numbers (a story: views and reach only), the network's post that Pilot Comments knows
    const cmPost: Partial<Record<'fb' | 'ig', number>> = {};
    for (const net of h.nets) {
      const ext = net === 'fb' ? fb! : ig!;
      const views = h.views[net === 'fb' ? 0 : 1];
      const f = (x: number) => Math.round(views * x);
      await db.query(
        `INSERT INTO cm_post_stats (channel, external_id, planned_id, views, reach, likes, comments, shares, saves, insights, fetched_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10) ON CONFLICT DO NOTHING`,
        [net === 'fb' ? 'facebook' : 'instagram', ext, pid, views, f(0.72), story ? null : f(net === 'fb' ? 0.035 : 0.052), story ? null : f(0.008), f(net === 'fb' ? 0.006 : 0.004), story || net === 'fb' ? null : f(0.009), fetched],
      );
      if (!story) {
        const cp = await db.query(
          `INSERT INTO cm_posts (channel, external_id, account_id, caption, permalink, product_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (channel, external_id) DO UPDATE SET product_id = EXCLUDED.product_id RETURNING id`,
          [net === 'fb' ? 'facebook' : 'instagram', ext, net === 'fb' ? '1029384756' : '17841400000000001', h.caption, net === 'fb' ? `https://www.facebook.com/${ext}` : `https://www.instagram.com/p/DEMOH${n}/`, product, time],
        );
        cmPost[net] = num(cp[0].id);
      }
    }
    if (story) continue;
    await sell(pid, time, cmPost, h.nets, h.orders, h.extraComments);
  }
  // the posts of this week that went out (the carousel two days ago, the chair Instagram refused): their numbers and sales
  for (const w of await db.query(`SELECT id, fb_id, ig_id, publish_at FROM cm_planned WHERE fb_id IN ('1029384756_90001', '1029384756_90002')`)) {
    const pid = num(w.id);
    const time = String(w.publish_at instanceof Date ? w.publish_at.toISOString() : w.publish_at);
    const cmPost: Partial<Record<'fb' | 'ig', number>> = {};
    const nets: ('fb' | 'ig')[] = [];
    const out = String(w.fb_id).endsWith('90001');
    for (const [net, ext, views] of [['fb', w.fb_id, out ? 3800 : 2100], ['ig', w.ig_id, 4200]] as const) {
      if (!ext) continue;
      nets.push(net);
      const f = (x: number) => Math.round(views * x);
      await db.query(
        `INSERT INTO cm_post_stats (channel, external_id, planned_id, views, reach, likes, comments, shares, saves, insights, fetched_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10) ON CONFLICT DO NOTHING`,
        [net === 'fb' ? 'facebook' : 'instagram', String(ext), pid, views, f(0.7), f(net === 'fb' ? 0.036 : 0.055), f(0.009), f(0.005), net === 'fb' ? null : f(0.01), fetched],
      );
      cmPost[net] = num((await db.query(`SELECT id FROM cm_posts WHERE channel = $1 AND external_id = $2`, [net === 'fb' ? 'facebook' : 'instagram', String(ext)]))[0]?.id) || undefined;
    }
    await sell(pid, time, cmPost, nets, out ? 2 : 1, out ? 4 : 2);
  }
  // the followers of each day: the Page and the Instagram account grow a little
  for (let d = 60; d >= 0; d--) {
    const day = new Date(now + 3_600_000 - d * 86_400_000).toISOString().slice(0, 10);
    const g = 60 - d;
    await db.query(`INSERT INTO cm_follow_days (day, channel, followers) VALUES ($1,'facebook',$2), ($1,'instagram',$3) ON CONFLICT DO NOTHING`, [day, 4830 + g * 8 + Math.round(6 * Math.sin(g / 3)), 2150 + g * 9 + Math.round(9 * Math.sin(g / 4 + 1))]);
  }
}
