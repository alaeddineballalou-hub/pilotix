import type { Db } from '../db';
import { num } from '../db';
import { makeSession } from '../rpc';
import { pilotRun } from '../modules/adsmgr';
import { toProfile } from '../modules/users';

/**
 * Demo data for Pilot Ads (Marketing › Publicité): the campaigns of the demo ad sets with their daily budgets (one
 * campaign holds its budget itself: Advantage+), a messages campaign whose orders came from the chats, the log of the
 * last changes (one raise of the marketer waiting for the owner's yes), launches (two live, one waiting, one draft),
 * the audiences built from the shop's own customers, and Pilote auto's suggestions, worked out by its own rules.
 */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const H = 3_600_000;
  const D = 24 * H;
  const acct = '120211887';
  const ens = num((await db.query("SELECT product_ids[1] AS p FROM adsets WHERE id = '120200002'"))[0]?.p);
  const pous = num((await db.query("SELECT product_ids[1] AS p FROM adsets WHERE id = '120200001'"))[0]?.p);

  // the campaigns: three with their ad sets' own budgets, « Puériculture » with the campaign's (Advantage+)
  await db.query(
    `INSERT INTO ad_campaigns (id, account_id, name, objective, status, daily_budget_cents, bid_strategy, changed_at) VALUES
      ('120330001',$1,'Bébé confort','OUTCOME_SALES','ACTIVE',NULL,NULL,NULL),
      ('120330002',$1,'Vêtements','OUTCOME_SALES','ACTIVE',NULL,NULL,NULL),
      ('120330003',$1,'Puériculture','OUTCOME_SALES','ACTIVE',1800,'LOWEST_COST_WITHOUT_CAP',$2),
      ('120330004',$1,'Nouveautés','OUTCOME_SALES','ACTIVE',NULL,NULL,NULL),
      ('120330005',$1,'Ensemble bébé — messages','OUTCOME_ENGAGEMENT','ACTIVE',NULL,NULL,$3)
     ON CONFLICT (id) DO NOTHING`,
    [acct, iso(9 * D), iso(11 * D)],
  );
  const sets: [string, string, number | null, string, string | null][] = [
    ['120200001', '120330001', 2200, 'sales', iso(30 * H)],
    ['120200003', '120330001', 1500, 'sales', iso(52 * H)],
    ['120200006', '120330001', 900, 'sales', iso(4 * D)],
    ['120200007', '120330001', 2600, 'sales', null],
    ['120200002', '120330002', 1200, 'sales', iso(6 * D)],
    ['120200004', '120330003', null, 'sales', null],
    ['120200008', '120330003', null, 'sales', null],
    ['120200005', '120330004', 600, 'sales', iso(20 * D)],
  ];
  for (const [id, camp, cents, goal, changed] of sets)
    await db.query(`UPDATE adsets SET campaign_id = $2, account_id = $3, daily_budget_cents = $4, goal = $5, currency = 'USD', changed_at = $6 WHERE id = $1`, [id, camp, acct, cents, goal, changed]);

  // a messages campaign (Messenger + WhatsApp): its orders came from Dellal's chats, each knowing its ad
  await db.query(
    `INSERT INTO adsets (id, name, campaign, campaign_id, account_id, daily_budget_cents, goal, product_ids, marketer_id, status, currency, changed_at)
     VALUES ('120200009','Ensemble bébé — Messenger + WhatsApp','Ensemble bébé — messages','120330005',$1,1000,'messages',$2,$3,'ACTIVE','USD',$4) ON CONFLICT (id) DO NOTHING`,
    [acct, ens ? [ens] : [], users.marketer, iso(11 * D)],
  );
  await db.query(`INSERT INTO ads (id, adset_id, name, status, is_video) VALUES ('120210000090','120200009','Vidéo ensemble — écrivez-nous','ACTIVE',true) ON CONFLICT (id) DO NOTHING`);
  let s = 4242;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const day0 = new Date(now).toISOString().slice(0, 10);
  for (let k = 10; k >= 0; k--) {
    const day = new Date(Date.parse(day0 + 'T00:00:00Z') - k * D).toISOString().slice(0, 10);
    const cents = Math.round((8 + rnd() * 4) * 100);
    const imp = Math.round((cents / 100 / 1.7) * 1000);
    const reach = Math.round(imp / 1.4);
    const clicks = Math.round(imp * 0.018);
    const v3 = Math.round(imp * 0.3);
    await db.query(
      `INSERT INTO ad_insights (day, adset_id, spend_cents, impressions, reach, clicks, lpv, purchases, video_3s, thruplays) VALUES ($1,'120200009',$2,$3,$4,$5,0,0,$6,$7) ON CONFLICT (day, adset_id) DO NOTHING`,
      [day, cents, imp, reach, clicks, v3, Math.round(v3 * 0.25)],
    );
    await db.query(
      `INSERT INTO ad_daily (day, ad_id, adset_id, spend_cents, impressions, reach, clicks, lpv, purchases, video_3s, thruplays) VALUES ($1,'120210000090','120200009',$2,$3,$4,$5,0,0,$6,$7) ON CONFLICT (day, ad_id) DO NOTHING`,
      [day, cents, imp, reach, clicks, v3, Math.round(v3 * 0.25)],
    );
  }
  if (ens)
    await db.query(
      `UPDATE orders o SET utm = COALESCE(o.utm, '{}'::jsonb) || '{"utm_source":"facebook","utm_medium":"chat","ad_id":"120210000090","adset_id":"120200009"}'::jsonb, adset_id = '120200009'
       WHERE o.id IN (SELECT o2.id FROM orders o2 JOIN order_items i ON i.order_id = o2.id AND i.product_id = $1
                      WHERE o2.created_at >= $2 AND o2.channel <> 'landing' AND NOT o2.is_exchange ORDER BY o2.created_at DESC LIMIT 24)`,
      [ens, iso(10 * D)],
    );

  // the log of the last changes: a raise of the owner, a trim of Pilote auto, a pause of the marketer, and a raise the
  // marketer asked for that waits for the owner (66 %: above the 30 % the owner allows without a yes)
  const log: [string, string, string, string, object, object, string, string | null, string, string | null, number | null, number][] = [
    ['adset', '120200001', 'Poussette — Algérie 25-45', 'budget', { status: 'ACTIVE', budgetCents: 1800 }, { status: 'ACTIVE', budgetCents: 2200 }, 'person', null, 'done', null, users.vendeur, 30 * H],
    ['adset', '120200003', 'Lit parapluie — retargeting 30 j', 'budget', { status: 'ACTIVE', budgetCents: 1900 }, { status: 'ACTIVE', budgetCents: 1500 }, 'rule', 'trim', 'done', 'trim', null, 52 * H],
    ['adset', '120200006', 'Poussette — avis mamans', 'pause', { status: 'ACTIVE', budgetCents: 900 }, { status: 'PAUSED', budgetCents: 900 }, 'person', null, 'done', null, users.marketer, 4 * D],
    ['adset', '120200002', 'Ensemble bébé — mamans', 'budget', { status: 'ACTIVE', budgetCents: 1200 }, { budgetCents: 2000 }, 'person', null, 'waiting_yes', 'Hausse de 67 % : au-dessus de 30 %, le propriétaire dit oui.', users.marketer, 5 * H],
  ];
  for (const [level, id, name, op, before, after, source, rule, status, why, by, ago] of log)
    await db.query(
      `INSERT INTO ad_actions (level, object_id, object_name, op, before, after, source, rule_key, status, why, by_user, created_at, done_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [level, id, name, op, JSON.stringify(before), JSON.stringify(after), source, rule, status, why, by, iso(ago), status === 'done' ? iso(ago) : null],
    );

  // the launches: two live (made with « Lancer une pub »), a marketer's waiting for the owner, a draft
  const spec = (goal: string, name: string, productId: number | null, usd: number, extra: object = {}) =>
    JSON.stringify({ goal, productId, name, mediaIds: [], text: { primary: '', headline: '' }, channels: ['messenger'], welcome: null, phone: null, formId: null, newForm: null, postId: null, budgetUsd: usd, budgetLevel: 'adset', split: 'one', excludeWilayas: [], ageMin: 18, ageMax: 65, genders: [], advantageAudience: true, useAudiences: true, bid: null, start: null, pixelId: null, ...extra });
  const L = await db.query(
    `INSERT INTO ad_launches (mode, goal, product_id, name, spec, budget_cents, status, step, campaign_id, adset_ids, by_user, approved_by, created_at, updated_at, live_at) VALUES
      ('simple','sales',$1,'Poussette — Algérie 25-45',$3,2200,'live','done','120330001','{120200001}',$5,NULL,$7,$7,$7),
      ('pro','messages',$2,'Ensemble bébé — messages',$4,1000,'live','done','120330005','{120200009}',$5,$6,$8,$8,$8)
     RETURNING id`,
    [pous || null, ens || null, spec('sales', 'Poussette — Algérie 25-45', pous || null, 22), spec('messages', 'Ensemble bébé — messages', ens || null, 10, { channels: ['messenger', 'whatsapp'] }), users.marketer, users.vendeur, iso(28 * D), iso(11 * D)],
  );
  await db.query(`UPDATE adsets SET launch_id = $1 WHERE id = '120200001'`, [num(L[0].id)]);
  await db.query(`UPDATE adsets SET launch_id = $1 WHERE id = '120200009'`, [num(L[1].id)]);
  await db.query(`UPDATE ad_campaigns SET launch_id = $1 WHERE id = '120330001'`, [num(L[0].id)]);
  await db.query(`UPDATE ad_campaigns SET launch_id = $1 WHERE id = '120330005'`, [num(L[1].id)]);
  await db.query(
    `INSERT INTO ad_launches (mode, goal, product_id, name, spec, budget_cents, status, by_user, created_at, updated_at) VALUES
      ('simple','calls',$1,'Poussette — appels',$2,1500,'waiting_yes',$4,$5,$5),
      ('simple','form',$1,'Poussette — formulaire',$3,800,'draft',$4,$6,$6)`,
    [pous || null, spec('calls', 'Poussette — appels', pous || null, 15, { phone: '+213661223344' }), spec('form', 'Poussette — formulaire', pous || null, 8), users.marketer, iso(3 * H), iso(26 * H)],
  );

  // the audiences from the shop's own customers: returners and fake orders left out of the ads (owner's choice)
  const count = async (where: string) => num((await db.query(`SELECT count(DISTINCT phone) AS n FROM sales WHERE ${where}`))[0]?.n);
  await db.query(
    `INSERT INTO ad_audiences (kind, is_on, meta_id, size, status, synced_at) VALUES
      ('returners', true, '23851000000000001', $1, 'ready', $4),
      ('fake', true, '23851000000000002', $2, 'ready', $4),
      ('buyers', false, NULL, $3, 'off', NULL)
     ON CONFLICT (kind) DO NOTHING`,
    [await count(`follow_status IN ('returned','lost')`), await count(`conf_status IN ('fake','wrong_number')`), await count(`follow_status IN ('delivered','exchanged')`), iso(5 * H)],
  );

  // Pilote auto's suggestions: its own rules on these numbers, as the job does every 15 minutes
  const admin = (await db.query('SELECT * FROM profiles WHERE id = $1', [users.admin]))[0];
  if (admin) await pilotRun({ db, session: makeSession(toProfile(admin)), now: () => now, emit: () => undefined });
}
