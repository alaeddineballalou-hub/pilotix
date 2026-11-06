import type { Db } from '../db';
import { num } from '../db';
import { addDays, dayStart } from '../modules/ads';
import { dayReport } from '../modules/automations';
import { DEFAULT_SETTINGS, setSetting } from '../settings';

const H = 3_600_000;
const D = 24 * H;
const algDay = (ms: number) => new Date(ms + H).toISOString().slice(0, 10);

/**
 * Pilot Automations demo: the automations on, and what they did these last days — the evening reports of the last three
 * evenings (the demo's own numbers), an ad set paused when its product ran out and put back on with the stock, two slow
 * queue alerts, and the come-back offer (its own campaign, approved by Meta) filled each morning with the customers
 * delivered 30 days before. Its messages are older than 3 days: the customers can get the demo's other campaigns.
 */
export async function seed(db: Db, users: Record<string, number>, now: number): Promise<void> {
  const iso = (t: number) => new Date(t).toISOString();
  // a moment of an Algiers day (k days ago, at this hour)
  const dayAt = (k: number, hour: number) => Date.parse(dayStart(addDays(algDay(now), -k))) + hour * H;
  const line = (kind: string, at: number, data: object, n = 1) => db.query(`INSERT INTO auto_log (kind, at, data, n) VALUES ($1,$2,$3,$4)`, [kind, iso(at), JSON.stringify(data), n]);

  // « Offre de retour »: a campaign Meta approved; two customers each morning, 4 to 8 days ago
  const reach = await db.query(`SELECT id, phone, name FROM customers WHERE wa_optin_at IS NOT NULL AND wa_optout_at IS NULL AND NOT blacklisted ORDER BY id DESC LIMIT 10`);
  let campaignId: number | null = null;
  const NAME = 'Offre de retour −10 %';
  if (reach.length) {
    campaignId = num(
      (
        await db.query(
          `INSERT INTO wa_campaigns (name, status, audience, lang, body, order_button, template_name, started_at, finished_at, created_at, updated_at)
           VALUES ($1,'done',$2,'dz',$3,true,'pilotix_offre_3_v1',$4,$5,$6,$5) RETURNING id`,
          [
            NAME,
            JSON.stringify({ productIds: [], wilayas: [], delivered: true, noReturns: true, minDays: null, maxDays: null }),
            'Salam {nom} 👋 {boutique} y9ollkom saha 3la la commande. -10 % 3la la commande jaya, 7 jours brk. Nab3atoulkom el jdid ?',
            iso(dayAt(8, 10)),
            iso(dayAt(4, 10.2)),
            iso(dayAt(9, 15)),
          ],
        )
      )[0].id,
    );
    for (const [j, c] of reach.entries()) {
      const at = dayAt(8 - Math.floor(j / 2), 10) + (j % 2) * 7 * 60_000;
      const read = j % 4 !== 3;
      await db.query(
        `INSERT INTO wa_campaign_sends (campaign_id, customer_id, phone, name, status, wa_id, sent_at, delivered_at, read_at, replied_at, tapped) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          campaignId,
          c.id,
          c.phone,
          c.name,
          read ? 'read' : 'delivered',
          `wamid.demoback${j}`,
          iso(at),
          iso(at + 40_000),
          read ? iso(at + (8 + j * 11) * 60_000) : null,
          j === 1 || j === 6 ? iso(at + (30 + j * 9) * 60_000) : null,
          j === 1 ? 'order' : null,
        ],
      );
    }
    for (let k = 8; k >= 4; k--) {
      const n = reach.filter((_: unknown, j: number) => 8 - Math.floor(j / 2) === k).length;
      if (n) await line('comeback', dayAt(k, 10), { campaign: NAME, days: 30 }, n);
    }
  }

  // « Plus de stock → stop »: the feeding bottle ran out three days ago (its ad set paused), its stock came back the next morning
  const set = (await db.query(`SELECT id, name, product_ids FROM adsets WHERE id = '120200004'`))[0];
  const pid = set ? num((set.product_ids ?? [])[0]) : 0;
  const product = pid ? (await db.query(`SELECT name FROM products WHERE id = $1`, [pid]))[0]?.name : null;
  if (set && product) {
    const pages = num((await db.query(`SELECT count(*)::int AS n FROM landing_pages WHERE active AND product_id = $1`, [pid]))[0]?.n);
    const out = dayAt(3, 15.3);
    const back = dayAt(2, 9.6);
    for (const [op, at, why, before, after] of [
      ['pause', out, `Plus de stock : ${product}`, 'ACTIVE', 'PAUSED'],
      ['resume', back, `Stock revenu : ${product}`, 'PAUSED', 'ACTIVE'],
    ] as const)
      await db.query(
        `INSERT INTO ad_actions (level, object_id, object_name, op, before, after, source, status, why, by_user, created_at, done_at) VALUES ('adset',$1,$2,$3,$4,$5,'auto','done',$6,$7,$8,$8)`,
        [set.id, set.name, op, JSON.stringify({ status: before, budgetCents: 1000 }), JSON.stringify({ status: after, budgetCents: 1000 }), why, users.admin, iso(at)],
      );
    await line('nostock', out, { product, pages, paused: [String(set.name)] });
    await line('stockback', back, { product, pages, resumed: [String(set.name)] });
  }

  // « File d'attente lente »: yesterday morning orders waited, yesterday afternoon an agent stopped calling
  await line('queue', dayAt(1, 10.7), { what: 'wait', n: 7, hours: 3, sent: 2 }, 1);
  await line('queue', dayAt(1, 15.2), { what: 'idle', agent: 'Samira', minutes: 34, n: 6, sent: 3 }, 1);

  // « Rapport du soir »: the last three evenings (and tonight's once it is past 21:00), with the demo's real numbers
  const hourNow = new Date(now + H).getUTCHours();
  for (let k = 3; k >= (hourNow >= 21 ? 0 : 1); k--) {
    const r = await dayReport(db, addDays(algDay(now), -k));
    await line('evening', Math.min(now, dayAt(k, 21)), { ...r, people: 1, sent: 1 });
  }

  await setSetting(db, 'automations', {
    ...DEFAULT_SETTINGS.automations,
    noStock: { on: true },
    evening: { on: true, hour: 21, to: [] },
    queue: { on: true, waitHours: 2, idleMin: 30, to: [] },
    comeBack: { on: !!campaignId, days: 30, campaignId },
  });
}
