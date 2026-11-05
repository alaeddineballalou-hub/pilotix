import type { Db } from '../db';
import { num } from '../db';

const iso = (t: number) => new Date(t).toISOString();
const H = 3_600_000;

/**
 * Marketing › Campagnes demo: about half of the customers whose parcel arrived said yes to the shop's WhatsApp offers
 * (the box of the landing pages, the agent during the call, a list), a few said « Stop ». Three campaigns: a promo sent
 * last week (read, answered, « Je commande », the orders it brought), a new product being sent now, and a draft.
 */
export async function seed(db: Db, _users: Record<string, number>, now: number): Promise<void> {
  let k = 0;
  const rnd = () => {
    // a fixed little sequence (the demo looks the same every night)
    k = (k * 9301 + 49297) % 233280;
    return k / 233280;
  };
  await db.query(`INSERT INTO settings (key, value) VALUES ('campaigns', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify({ perDay: 200, formOptin: true })]);
  const delivered = await db.query(
    `SELECT c.id, c.phone, c.name, min(o.created_at) AS first_at FROM customers c JOIN orders o ON o.customer_id = c.id
     WHERE o.follow_status IN ('delivered','exchanged') AND NOT c.blacklisted GROUP BY c.id ORDER BY c.id`,
  );
  for (const c of delivered) {
    const r = rnd();
    const at = iso(Date.parse(new Date(c.first_at).toISOString()) + 2 * 60_000);
    if (r < 0.32) await db.query(`UPDATE customers SET wa_optin_at = $2, wa_optin_source = 'form' WHERE id = $1`, [c.id, at]);
    else if (r < 0.47) await db.query(`UPDATE customers SET wa_optin_at = $2, wa_optin_source = 'call' WHERE id = $1`, [c.id, at]);
    else if (r < 0.52) await db.query(`UPDATE customers SET wa_optin_at = $2, wa_optin_source = 'import' WHERE id = $1`, [c.id, at]);
  }
  const pid = async (sku: string) => num((await db.query('SELECT id FROM products WHERE sku = $1', [sku]))[0]?.id) || null;
  const reachable = await db.query(`SELECT id, phone, name FROM customers WHERE wa_optin_at IS NOT NULL AND wa_optout_at IS NULL AND NOT blacklisted ORDER BY id`);
  if (!reachable.length) return;

  const promo = await db.query(
    `INSERT INTO wa_campaigns (name, status, audience, lang, body, product_id, order_button, template_name, started_at, finished_at, created_at, updated_at)
     VALUES ($1,'done',$2,'dz',$3,$4,true,'pilotix_offre_1_v1',$5,$6,$7,$6) RETURNING id`,
    [
      'Promo poussette −15 %',
      JSON.stringify({ productIds: [], wilayas: [], delivered: true, noReturns: true, minDays: 15, maxDays: null }),
      'Salam {nom} 👋 m3akom {boutique}. Promo 3 jours brk : la poussette canne b 10 900 DA blast 12 900 DA, livraison l 58 wilayas w tkhallsou ki testalmou. T7ebbou nab3atoulkom wa7da ?',
      await pid('PX-POU'),
      iso(now - 6 * 24 * H),
      iso(now - 5 * 24 * H),
      iso(now - 7 * 24 * H),
    ],
  );
  const promoId = num(promo[0].id);
  // the customers who ordered these last days got the promo a little before (their order counts for it)
  const buyers = await db.query(
    `SELECT DISTINCT ON (c.id) c.id, c.phone, c.name, o.created_at FROM customers c JOIN sales o ON o.customer_id = c.id
     WHERE c.wa_optin_at IS NOT NULL AND c.wa_optout_at IS NULL AND o.created_at > $1 AND o.created_at < $2 ORDER BY c.id, o.created_at`,
    [iso(now - 5 * 24 * H), iso(now - 2 * H)],
  );
  const chosen = new Map<number, { phone: string; name: string; at: number; buyer: boolean }>();
  for (const b of buyers.slice(0, 9)) chosen.set(num(b.id), { phone: String(b.phone), name: String(b.name), at: Date.parse(new Date(b.created_at).toISOString()) - (3 + Math.floor(rnd() * 30)) * H, buyer: true });
  for (const c of reachable) {
    if (chosen.size >= 120) break;
    if (!chosen.has(num(c.id))) chosen.set(num(c.id), { phone: String(c.phone), name: String(c.name), at: now - 6 * 24 * H + Math.floor(rnd() * 10 * H), buyer: false });
  }
  let n = 0;
  for (const [cid, c] of chosen) {
    n++;
    const r = rnd();
    const failed = !c.buyer && r < 0.05;
    const read = !failed && (c.buyer || r < 0.72);
    const replied = c.buyer || (read && r < 0.16);
    const stop = !c.buyer && read && r > 0.7 && r < 0.72;
    const tapped = stop ? 'stop' : c.buyer && n % 3 !== 0 ? 'order' : null;
    await db.query(
      `INSERT INTO wa_campaign_sends (campaign_id, customer_id, phone, name, status, wa_id, error, sent_at, delivered_at, read_at, replied_at, tapped)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        promoId,
        cid,
        c.phone,
        c.name,
        failed ? 'failed' : read ? 'read' : 'delivered',
        failed ? null : `wamid.demo${promoId}x${n}`,
        failed ? 'WhatsApp : ce numéro n’a pas WhatsApp (131026)' : null,
        failed ? null : iso(c.at),
        failed ? null : iso(c.at + 40_000),
        read ? iso(c.at + (5 + Math.floor(rnd() * 120)) * 60_000) : null,
        replied ? iso(c.at + (20 + Math.floor(rnd() * 180)) * 60_000) : null,
        tapped,
      ],
    );
    if (stop) await db.query(`UPDATE customers SET wa_optout_at = $2 WHERE id = $1`, [cid, iso(c.at + H)]);
  }

  // a new product, going out now (half of it sent)
  const chair = await db.query(
    `INSERT INTO wa_campaigns (name, status, audience, lang, body, product_id, order_button, template_name, started_at, created_at, updated_at)
     VALUES ($1,'sending',$2,'dz',$3,$4,true,'pilotix_offre_2_v1',$5,$6,$5) RETURNING id`,
    [
      'Nouveauté : chaise haute évolutive',
      JSON.stringify({ productIds: [], wilayas: [], delivered: true, noReturns: true, minDays: null, maxDays: null }),
      'Salam {nom}, m3akom {boutique} 😊 Wslatna la chaise haute évolutive : men 6 mois l 6 ans, tetbeddel en chaise w bureau. 8 900 DA, livraison l 58 wilayas. Nkommandiwelkom wa7da ?',
      await pid('PX-CHA'),
      iso(now - 3 * H),
      iso(now - 26 * H),
    ],
  );
  const chairId = num(chair[0].id);
  const rest = reachable.filter((c: any) => !chosen.has(num(c.id))).slice(0, 140);
  for (const [j, c] of rest.entries()) {
    const sent = j < 62;
    const at = now - 3 * H + j * 90_000;
    const read = sent && j % 3 !== 2;
    await db.query(
      `INSERT INTO wa_campaign_sends (campaign_id, customer_id, phone, name, status, wa_id, sent_at, delivered_at, read_at, replied_at, tapped)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        chairId,
        c.id,
        c.phone,
        c.name,
        !sent ? 'queued' : read ? 'read' : 'delivered',
        sent ? `wamid.demo${chairId}x${j}` : null,
        sent ? iso(at) : null,
        sent ? iso(at + 30_000) : null,
        read ? iso(at + 12 * 60_000) : null,
        sent && j % 9 === 0 ? iso(at + 25 * 60_000) : null,
        sent && j % 18 === 0 ? 'order' : null,
      ],
    );
  }

  // a draft for the next one
  await db.query(
    `INSERT INTO wa_campaigns (name, status, audience, lang, body, product_id, order_button, created_at, updated_at) VALUES ($1,'draft',$2,'dz',$3,$4,true,$5,$5)`,
    [
      'Rentrée : sac à langer',
      JSON.stringify({ productIds: [], wilayas: [16, 9, 35, 42], delivered: true, noReturns: true, minDays: 30, maxDays: null }),
      'Salam {nom} 👋 m3akom {boutique}. Le sac à langer à dos wslna f noir w camel : tout le nécessaire ta3 bébé f sac wa7ed. 5 900 DA, livraison l 58 wilayas.',
      await pid('PX-SAC'),
      iso(now - 2 * H),
    ],
  );
}
