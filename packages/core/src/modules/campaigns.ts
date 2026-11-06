// Marketing › Campagnes: WhatsApp messages to the shop's own customers — a new product, a promo — only to those who said
// yes (the box on the landing pages, the agent during the call, a list the shop pastes), never again after « Stop », and
// never to a blacklisted number. A campaign is one WhatsApp template (category Marketing) Meta approves, with its
// buttons: « Je commande » (the conversation goes to Pilot Message: Dellal takes the order), « Stop », and a link to
// the product's page. Pilotix sends slowly: a number of messages a day (Meta's own limit is 250 customers a day before
// the business is verified, order messages included), never at night, never twice in 3 days to the same customer. Each
// message keeps what became of it (received, read, a reply, a button) and the orders its customer made in the 7 days
// after it.
import { CONF_DONE_BAD, normalizePhone, phoneIntl, WILAYAS } from '@pilotix/shared';
import { z } from 'zod';
import { Db, iso, isoOrNull, num, numOrNull, Where } from '../db';
import { bad, Ctx, notFound, proc } from '../rpc';
import { getSetting } from '../settings';
import { dellalSecret, dellalSettings } from './dellal';
import { landingStore } from './landingquery';
import { firstName, NOTIFY_LANGS, NotifyLang, notifySettings, render, sendTime, simulatedHasWhatsApp, TEMPLATE_LANG, templateBody, templateParams } from './notify';

export const CAMPAIGN_STATUSES = ['draft', 'pending', 'rejected', 'ready', 'sending', 'paused', 'done', 'canceled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const OPTIN_SOURCES = ['form', 'call', 'import'] as const;
export type OptinSource = (typeof OPTIN_SOURCES)[number];
/** What a campaign's text may contain. */
export const CAMPAIGN_VARS = ['nom', 'boutique'] as const;
/** A customer gets one campaign message at most every 3 days. */
const GAP_DAYS = 3;
/** Orders a customer made in these days after a message count for the campaign. */
const ORDER_DAYS = 7;
/** At most this many messages a minute (Meta's own pace is far above: a campaign still spreads over the day). */
const PER_RUN = 25;
const DAY = 86_400_000;

export interface CampaignSettings {
  /** messages a day, all campaigns together (Meta allows 250 customers a day before the business is verified) */
  perDay: number;
  /** the box « Recevoir nos offres sur WhatsApp » on the landing pages */
  formOptin: boolean;
}
const DEFAULT_SETTINGS: CampaignSettings = { perDay: 200, formOptin: false };

export async function campaignSettings(db: Db): Promise<CampaignSettings> {
  const v = (await db.query(`SELECT value FROM settings WHERE key = 'campaigns'`))[0]?.value;
  return { ...DEFAULT_SETTINGS, ...(v && typeof v === 'object' ? v : {}) };
}

// ---------------------------------------------------------------- consent
/** A customer may get offers: said yes, never « Stop » since, not blacklisted. */
/** A customer who said yes to offers, never « Stop », not blacklisted (on `c`, a customers row). */
export const REACHABLE = `c.wa_optin_at IS NOT NULL AND c.wa_optout_at IS NULL AND NOT c.blacklisted`;

/** The customer said yes (the box of a landing page, the agent during the call, a list): offers may come on WhatsApp. */
export async function giveConsent(db: Db, phone: string, source: OptinSource, at: string): Promise<boolean> {
  const p = normalizePhone(phone);
  if (!p) return false;
  const r = await db.query(`UPDATE customers SET wa_optin_at = $2, wa_optin_source = $3, wa_optout_at = NULL WHERE phone = $1 RETURNING id`, [p, at, source]);
  return !!r[0];
}

/** « Stop »: no offer any more (the customer can say yes again later, on a landing page or to an agent). */
async function stopOffers(db: Db, phone: string, at: string) {
  await db.query(`UPDATE customers SET wa_optout_at = $2 WHERE phone = $1`, [phone, at]);
}

/** An Algerian mobile number written any way (spaces, dots, dashes, +213): WhatsApp is on mobiles. */
const MOBILE = /(?:(?:\+|00)?213)?[\s.-]*0?[\s.-]*[5-7](?:[\s.-]*\d){8}/g;
/** « Stop » written by hand (the button aside): stop, arrêt, توقف… */
const STOP_WORDS = /^\s*(stop+|arr[eê]t(ez)?|unsubscribe|d[ée]sabonner|baraka|ma\s*t?b3athoulich|توقف|ايقاف|إيقاف|أوقف|اوقف|لا\s*اريد|لا\s*أريد)\s*[.!]*\s*$/i;

// ---------------------------------------------------------------- the customers a campaign reaches
export const AudienceInput = z.object({
  /** bought one of these products */
  productIds: z.array(z.number().int().positive()).max(50).default([]),
  /** ordered for one of these wilayas */
  wilayas: z.array(z.number().int().min(1).max(69)).max(69).default([]),
  /** at least one order delivered */
  delivered: z.boolean().default(true),
  /** never sent a parcel back */
  noReturns: z.boolean().default(true),
  /** the last order is at least / at most this many days old */
  minDays: z.number().int().min(0).max(3650).nullable().default(null),
  maxDays: z.number().int().min(0).max(3650).nullable().default(null),
});
export type Audience = z.infer<typeof AudienceInput>;

function audienceWhere(a: Audience, now: number): Where {
  const w = new Where();
  w.add(REACHABLE);
  if (a.delivered) w.add(`EXISTS (SELECT 1 FROM sales o WHERE o.customer_id = c.id AND o.follow_status IN ('delivered','exchanged'))`);
  if (a.noReturns) w.add(`NOT EXISTS (SELECT 1 FROM sales o WHERE o.customer_id = c.id AND o.follow_status IN ('returning','returned'))`);
  if (a.productIds.length) w.add(`EXISTS (SELECT 1 FROM sales o JOIN order_items i ON i.order_id = o.id WHERE o.customer_id = c.id AND i.product_id = ANY(?))`, a.productIds);
  if (a.wilayas.length) w.add(`EXISTS (SELECT 1 FROM sales o WHERE o.customer_id = c.id AND o.wilaya_id = ANY(?))`, a.wilayas);
  if (a.minDays !== null) w.add(`(SELECT max(o.created_at) FROM sales o WHERE o.customer_id = c.id) <= ?`, new Date(now - a.minDays * DAY).toISOString());
  if (a.maxDays !== null) w.add(`(SELECT max(o.created_at) FROM sales o WHERE o.customer_id = c.id) >= ?`, new Date(now - a.maxDays * DAY).toISOString());
  return w;
}

export async function audienceCount(db: Db, a: Audience, now: number): Promise<{ count: number; sample: string[] }> {
  const w = audienceWhere(a, now);
  const n = num((await db.query(`SELECT count(*)::int AS n FROM customers c ${w.sql}`, w.params))[0]?.n);
  const sample = n ? (await db.query(`SELECT c.name FROM customers c ${w.sql} ORDER BY c.id DESC LIMIT 4`, w.params)).map((r: any) => String(r.name ?? '')) : [];
  return { count: n, sample };
}

// ---------------------------------------------------------------- the message
const BUTTONS: Record<NotifyLang, { order: string; stop: string; link: string }> = {
  dz: { order: 'Nkommandi', stop: 'Stop', link: 'Chouf le produit' },
  fr: { order: 'Je commande', stop: 'Stop', link: 'Voir le produit' },
  ar: { order: 'أطلب الآن', stop: 'إيقاف', link: 'شاهد المنتج' },
};
const STOPPED: Record<NotifyLang, string> = {
  dz: 'Saha, ma nb3atoulkomch les offres men daba. Choukran 🙏',
  fr: 'C’est noté : vous ne recevrez plus nos offres sur WhatsApp. Merci 🙏',
  ar: 'تم: لن تصلك عروضنا على واتساب بعد الآن. شكراً 🙏',
};
export const campaignButtons = (lang: NotifyLang) => BUTTONS[lang] ?? BUTTONS.fr;

/** What is wrong with a campaign's text (WhatsApp refuses a variable at the very start or end). */
export function campaignProblems(text: string): string[] {
  const out: string[] = [];
  const t = text.trim();
  for (const m of t.matchAll(/\{(\w*)\}/g)) if (!(CAMPAIGN_VARS as readonly string[]).includes(m[1])) out.push(`Variable inconnue {${m[1]}} : seulement {nom} et {boutique}`);
  if (/^\{\w+\}/.test(t) || /\{\w+\}$/.test(t)) out.push('Le texte ne peut pas commencer ou finir par une variable (WhatsApp le refuse) : ajoutez un mot ou un point');
  if (t.length < 20) out.push('Texte trop court (20 caractères au moins)');
  if (t.length > 900) out.push('Texte trop long (900 caractères au plus)');
  return out;
}

const langOf = (v: unknown): NotifyLang => ((NOTIFY_LANGS as readonly string[]).includes(String(v)) ? (v as NotifyLang) : 'dz');
/** The buttons of the template, in Meta's order: the quick replies first, then the link. */
function templateButtons(c: any): ({ type: 'QUICK_REPLY'; text: string } | { type: 'URL'; text: string; url: string })[] {
  const b = campaignButtons(langOf(c.lang));
  return [...(c.order_button ? [{ type: 'QUICK_REPLY' as const, text: b.order }] : []), { type: 'QUICK_REPLY' as const, text: b.stop }, ...(c.link ? [{ type: 'URL' as const, text: b.link, url: String(c.link) }] : [])];
}
/** What comes back with each quick reply (« Je commande », « Stop »). */
const payloadsOf = (c: any) => [...(c.order_button ? [`pxc:order:${num(c.id)}`] : []), `pxc:stop:${num(c.id)}`];

// ---------------------------------------------------------------- reading
const simulated = (ctx: Ctx) => !ctx.server?.dellal;

async function readiness(ctx: Ctx) {
  const d = await dellalSettings(ctx.db);
  const n = await notifySettings(ctx.db);
  return { whatsapp: !!(await dellalSecret(ctx.db, 'waToken')) && !!d.whatsappPhoneId, waba: !!n.wabaId, live: !simulated(ctx) };
}

const STATS_SQL = `SELECT campaign_id, count(*)::int AS total, count(*) FILTER (WHERE status = 'queued')::int AS queued,
    count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent, count(*) FILTER (WHERE delivered_at IS NOT NULL OR read_at IS NOT NULL)::int AS delivered,
    count(*) FILTER (WHERE read_at IS NOT NULL)::int AS read, count(*) FILTER (WHERE status = 'failed')::int AS failed,
    count(*) FILTER (WHERE status = 'skipped')::int AS skipped, count(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replied,
    count(*) FILTER (WHERE tapped = 'order')::int AS ordered, count(*) FILTER (WHERE tapped = 'stop')::int AS stopped
  FROM wa_campaign_sends WHERE campaign_id = ANY($1) GROUP BY 1`;
const ORDERS_SQL = `SELECT s.campaign_id, count(DISTINCT o.id)::int AS orders,
    COALESCE(sum(o.total) FILTER (WHERE NOT (o.conf_status = ANY($2))), 0)::bigint AS revenue
  FROM wa_campaign_sends s JOIN sales o ON o.phone = s.phone AND o.created_at > s.sent_at AND o.created_at <= s.sent_at + interval '${ORDER_DAYS} days'
  WHERE s.campaign_id = ANY($1) AND s.sent_at IS NOT NULL GROUP BY 1`;

async function statsOf(db: Db, ids: number[]) {
  const empty = { total: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, replied: 0, ordered: 0, stopped: 0, orders: 0, revenue: 0 };
  const out = new Map<number, typeof empty>();
  if (!ids.length) return out;
  for (const r of await db.query(STATS_SQL, [ids]))
    out.set(num(r.campaign_id), { ...empty, total: num(r.total), queued: num(r.queued), sent: num(r.sent), delivered: num(r.delivered), read: num(r.read), failed: num(r.failed), skipped: num(r.skipped), replied: num(r.replied), ordered: num(r.ordered), stopped: num(r.stopped) });
  for (const r of await db.query(ORDERS_SQL, [ids, CONF_DONE_BAD])) {
    const cur = out.get(num(r.campaign_id)) ?? { ...empty };
    out.set(num(r.campaign_id), { ...cur, orders: num(r.orders), revenue: num(r.revenue) });
  }
  return out;
}

function toCampaign(r: any, stats: Awaited<ReturnType<typeof statsOf>>) {
  const audience = AudienceInput.safeParse(r.audience ?? {});
  return {
    id: num(r.id),
    name: String(r.name ?? ''),
    status: r.status as CampaignStatus,
    audience: audience.success ? audience.data : AudienceInput.parse({}),
    lang: langOf(r.lang),
    body: String(r.body ?? ''),
    productId: numOrNull(r.product_id),
    productName: (r.product_name as string | null) ?? null,
    link: (r.link as string | null) ?? null,
    orderButton: !!r.order_button,
    templateName: (r.template_name as string | null) ?? null,
    templateReason: (r.template_reason as string | null) ?? null,
    sendAt: isoOrNull(r.send_at),
    startedAt: isoOrNull(r.started_at),
    finishedAt: isoOrNull(r.finished_at),
    createdAt: iso(r.created_at),
    stats: stats.get(num(r.id)) ?? { total: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, replied: 0, ordered: 0, stopped: 0, orders: 0, revenue: 0 },
  };
}

async function campaignOf(db: Db, cid: number) {
  const r = (await db.query(`SELECT k.*, p.name AS product_name FROM wa_campaigns k LEFT JOIN products p ON p.id = k.product_id WHERE k.id = $1`, [cid]))[0];
  if (!r) throw notFound('Campagne introuvable');
  return toCampaign(r, await statsOf(db, [cid]));
}

// ---------------------------------------------------------------- sending
/** Sends what is due: the campaigns started, at their pace, outside the quiet hours. The preview sends at once (simulated). */
export async function runCampaigns(ctx: Ctx, o: { campaignId?: number } = {}): Promise<{ sent: number; failed: number; skipped: number; checked?: boolean }> {
  const db = ctx.db;
  const now = ctx.now();
  const out = { sent: 0, failed: 0, skipped: 0, checked: false };
  // Meta's answer about the templates waiting, every 10 minutes
  if (!simulated(ctx)) {
    const last = (await db.query(`SELECT value->>'checkedAt' AS at FROM settings WHERE key = 'campaigns_check'`))[0]?.at;
    if ((!last || now - Date.parse(last) > 10 * 60_000) && (await db.query(`SELECT 1 FROM wa_campaigns WHERE status = 'pending' LIMIT 1`)).length) {
      await checkTemplates(ctx).catch(() => null);
      out.checked = true;
    }
  }
  const n = await notifySettings(db);
  if (!simulated(ctx) && sendTime(now, n) !== now) return out;
  const s = await campaignSettings(db);
  const day = new Date(now - DAY).toISOString();
  const used = num((await db.query(`SELECT count(*)::int AS n FROM wa_campaign_sends WHERE sent_at > $1`, [day]))[0]?.n);
  let budget = simulated(ctx) ? 10_000 : Math.min(PER_RUN, Math.max(0, s.perDay - used));
  const campaigns = await db.query(
    `SELECT * FROM wa_campaigns WHERE status = 'sending' AND (send_at IS NULL OR send_at <= $1)${o.campaignId ? ' AND id = $2' : ''} ORDER BY started_at, id`,
    o.campaignId ? [new Date(now).toISOString(), o.campaignId] : [new Date(now).toISOString()],
  );
  const shop = (await getSetting(db, 'shop')).name;
  const gap = new Date(now - GAP_DAYS * DAY).toISOString();
  for (const c of campaigns) {
    const lang = langOf(c.lang);
    while (budget > 0) {
      // two runs never take the same message: the first one marks it
      const batch = await db.query(
        `UPDATE wa_campaign_sends SET status = 'sending' WHERE id IN (SELECT id FROM wa_campaign_sends WHERE campaign_id = $1 AND status = 'queued' ORDER BY id LIMIT $2) RETURNING *`,
        [c.id, Math.min(budget, 50)],
      );
      if (!batch.length) break;
      for (const m of batch) {
        // the customer said « Stop » (or was blacklisted) since the campaign started, or got another one these days
        const cur = (await db.query(`SELECT c.name FROM customers c WHERE c.phone = $1 AND ${REACHABLE}`, [m.phone]))[0];
        const recent = (await db.query(`SELECT 1 FROM wa_campaign_sends WHERE phone = $1 AND campaign_id <> $2 AND sent_at > $3 LIMIT 1`, [m.phone, c.id, gap])).length;
        if (!cur || recent) {
          await db.query(`UPDATE wa_campaign_sends SET status = 'skipped', error = $2 WHERE id = $1`, [m.id, !cur ? 'N’accepte plus les offres' : `A déjà reçu une campagne ces ${GAP_DAYS} derniers jours`]);
          out.skipped++;
          continue;
        }
        budget--;
        const vars = { nom: firstName(cur.name ?? m.name, lang), boutique: shop };
        try {
          let waId: string | null;
          if (simulated(ctx)) {
            if (!simulatedHasWhatsApp(String(m.phone))) throw new Error('Ce numéro n’a pas WhatsApp');
            waId = `sim-${num(c.id)}-${num(m.id)}`;
          } else {
            const r = (await ctx.server!.dellal!('waTemplate', { to: phoneIntl(String(m.phone)), name: c.template_name, lang: TEMPLATE_LANG[lang], params: templateParams(String(c.body), vars), payloads: payloadsOf(c) }, ctx)) as { id: string | null };
            waId = r?.id ?? null;
          }
          await db.query(`UPDATE wa_campaign_sends SET status = $2, wa_id = $3, sent_at = $4, delivered_at = $5, error = NULL WHERE id = $1`, [
            m.id,
            simulated(ctx) ? 'delivered' : 'sent',
            waId,
            new Date(now).toISOString(),
            simulated(ctx) ? new Date(now).toISOString() : null,
          ]);
          out.sent++;
        } catch (e: any) {
          const why = String(e?.message ?? e).slice(0, 300);
          await db.query(`UPDATE wa_campaign_sends SET status = 'failed', error = $2, sent_at = NULL WHERE id = $1`, [m.id, why]);
          out.failed++;
          // Meta's limit reached (or the number paused): the rest waits for the next run
          if (/131048|131056|limit|limite/i.test(why)) {
            await db.query(`UPDATE wa_campaign_sends SET status = 'queued', error = $2 WHERE id = $1`, [m.id, why]);
            out.failed--;
            budget = 0;
          }
        }
        if (budget <= 0) break;
      }
      // the messages taken but not sent this run (the budget ran out) go back to the queue
      await db.query(`UPDATE wa_campaign_sends SET status = 'queued' WHERE campaign_id = $1 AND status = 'sending'`, [c.id]);
    }
    const left = num((await db.query(`SELECT count(*)::int AS n FROM wa_campaign_sends WHERE campaign_id = $1 AND status IN ('queued','sending')`, [c.id]))[0]?.n);
    if (!left) await db.query(`UPDATE wa_campaigns SET status = 'done', finished_at = $2, updated_at = now() WHERE id = $1 AND status = 'sending'`, [c.id, new Date(now).toISOString()]);
    if (budget <= 0) break;
  }
  if (out.sent || out.failed) ctx.emit({ type: 'settings', data: { campaigns: true } });
  return out;
}

/** Meta's answer about the templates sent for approval (in the preview, Meta « approves » at once). */
async function checkTemplates(ctx: Ctx): Promise<number> {
  const db = ctx.db;
  const pending = await db.query(`SELECT id, template_name FROM wa_campaigns WHERE status = 'pending'`);
  if (!pending.length) return 0;
  let list: { name: string; status: string; reason?: string | null }[];
  if (simulated(ctx)) list = pending.map((p: any) => ({ name: String(p.template_name), status: 'APPROVED' }));
  else {
    const n = await notifySettings(db);
    if (!n.wabaId) throw bad('Ajoutez l’ID du compte WhatsApp Business (Pilot Automations › Réglages)');
    list = (await ctx.server!.dellal!('waTemplates', { wabaId: n.wabaId }, ctx)) as typeof list;
  }
  let changed = 0;
  for (const p of pending) {
    const t = list.find((x) => x.name === p.template_name);
    if (!t) continue;
    if (t.status === 'APPROVED') {
      await db.query(`UPDATE wa_campaigns SET status = 'ready', template_reason = NULL, updated_at = now() WHERE id = $1 AND status = 'pending'`, [p.id]);
      changed++;
    } else if (['REJECTED', 'DISABLED', 'PAUSED'].includes(t.status)) {
      await db.query(`UPDATE wa_campaigns SET status = 'rejected', template_reason = $2, updated_at = now() WHERE id = $1 AND status = 'pending'`, [p.id, t.reason ?? t.status]);
      changed++;
    }
  }
  await db.query(`INSERT INTO settings (key, value) VALUES ('campaigns_check', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ checkedAt: new Date(ctx.now()).toISOString() })]);
  return changed;
}

/** What Meta says became of a message (sent, delivered, read, failed). */
export async function onCampaignStatus(db: Db, ev: { id: string; status: string; code?: number | null; title?: string | null }, at: string): Promise<boolean> {
  const m = (await db.query(`SELECT id FROM wa_campaign_sends WHERE wa_id = $1`, [ev.id]))[0];
  if (!m) return false;
  if (ev.status === 'delivered') await db.query(`UPDATE wa_campaign_sends SET status = CASE WHEN status = 'read' THEN 'read' ELSE 'delivered' END, delivered_at = COALESCE(delivered_at, $2) WHERE id = $1`, [m.id, at]);
  else if (ev.status === 'read') await db.query(`UPDATE wa_campaign_sends SET status = 'read', read_at = COALESCE(read_at, $2), delivered_at = COALESCE(delivered_at, $2) WHERE id = $1`, [m.id, at]);
  else if (ev.status === 'failed')
    await db.query(`UPDATE wa_campaign_sends SET status = 'failed', error = $2 WHERE id = $1`, [m.id, `WhatsApp : ${ev.title || 'non livré'}${ev.code ? ` (${ev.code})` : ''}`.slice(0, 300)]);
  return true;
}

/**
 * A customer wrote on WhatsApp: a campaign's button (« Stop »: no more offers, said back to them; « Je commande »: the
 * conversation goes on with Dellal, who knows the product), « stop » typed by hand, or any answer to a recent campaign.
 */
export async function onCampaignReply(ctx: Ctx, i: { phone: string; payload?: string | null; text?: string | null; accountId?: string | null }): Promise<{ stop?: boolean; text?: string }> {
  const db = ctx.db;
  const phone = normalizePhone(i.phone);
  if (!phone) return {};
  const at = new Date(ctx.now()).toISOString();
  const m = /^pxc:(order|stop):(\d+)$/.exec(String(i.payload ?? ''));
  const last = (
    await db.query(
      `SELECT s.id, s.campaign_id, k.lang, k.name, p.name AS product FROM wa_campaign_sends s JOIN wa_campaigns k ON k.id = s.campaign_id LEFT JOIN products p ON p.id = k.product_id
       WHERE s.phone = $1 AND s.sent_at IS NOT NULL ${m ? 'AND s.campaign_id = $2' : `AND s.sent_at > $2`} ORDER BY s.sent_at DESC LIMIT 1`,
      [phone, m ? Number(m[2]) : new Date(ctx.now() - GAP_DAYS * DAY).toISOString()],
    )
  )[0];
  const stop = m?.[1] === 'stop' || (!!last && STOP_WORDS.test(String(i.text ?? '')));
  if (stop) {
    await stopOffers(db, phone, at);
    if (last) await db.query(`UPDATE wa_campaign_sends SET tapped = 'stop', replied_at = COALESCE(replied_at, $2) WHERE id = $1`, [last.id, at]);
    // said back to the customer (the conversation is open: a plain message is allowed)
    if (ctx.server?.dellal) await ctx.server.dellal('send', { channel: 'whatsapp', externalId: phoneIntl(phone), accountId: i.accountId ?? null, text: STOPPED[langOf(last?.lang)] }, ctx).catch(() => null);
    return { stop: true };
  }
  if (!last) return {};
  if (m?.[1] === 'order') {
    await db.query(`UPDATE wa_campaign_sends SET tapped = 'order', replied_at = COALESCE(replied_at, $2) WHERE id = $1`, [last.id, at]);
    // Dellal reads which product the customer wants
    return { text: `${String(i.text ?? '').trim() || campaignButtons(langOf(last.lang)).order}${last.product ? ` — ${last.product}` : ''}`.slice(0, 400) };
  }
  await db.query(`UPDATE wa_campaign_sends SET replied_at = COALESCE(replied_at, $2) WHERE id = $1`, [last.id, at]);
  return {};
}

// ---------------------------------------------------------------- actions
const ROLES = ['marketer'] as const;
const id = z.number().int().positive();
const me = (ctx: Ctx) => ctx.session.profile.id;

const CampaignInput = z.object({
  id: id.optional(),
  name: z.string().trim().min(2, 'Donnez un nom à la campagne').max(120),
  audience: AudienceInput,
  lang: z.enum(NOTIFY_LANGS).default('dz'),
  body: z.string().max(1000),
  productId: id.nullable().default(null),
  link: z
    .string()
    .trim()
    .max(500)
    .refine((v) => !v || /^https:\/\/[^\s]+$/.test(v), 'Le lien doit commencer par https://')
    .nullable()
    .default(null),
  orderButton: z.boolean().default(true),
  sendAt: z.string().datetime().nullable().default(null),
});

export const campaignsProcs = {
  /** The campaigns with their results, the customers who say yes, the pace, and what WhatsApp still needs. */
  'campaigns.list': proc([...ROLES], z.object({}), async (ctx) => {
    const db = ctx.db;
    const rows = await db.query(`SELECT k.*, p.name AS product_name FROM wa_campaigns k LEFT JOIN products p ON p.id = k.product_id ORDER BY k.created_at DESC, k.id DESC LIMIT 100`);
    const stats = await statsOf(db, rows.map((r: any) => num(r.id)));
    const k = (
      await db.query(
        `SELECT count(*) FILTER (WHERE ${REACHABLE})::int AS yes, count(*) FILTER (WHERE c.wa_optout_at IS NOT NULL)::int AS stop,
           count(*) FILTER (WHERE ${REACHABLE} AND c.wa_optin_source = 'form')::int AS form, count(*) FILTER (WHERE ${REACHABLE} AND c.wa_optin_source = 'call')::int AS call,
           count(*) FILTER (WHERE ${REACHABLE} AND c.wa_optin_source = 'import')::int AS import, count(*)::int AS customers
         FROM customers c`,
      )
    )[0];
    const used = num((await db.query(`SELECT count(*)::int AS n FROM wa_campaign_sends WHERE sent_at > $1`, [new Date(ctx.now() - DAY).toISOString()]))[0]?.n);
    const n = await notifySettings(db);
    return {
      campaigns: rows.map((r: any) => toCampaign(r, stats)),
      consent: { yes: num(k.yes), stop: num(k.stop), form: num(k.form), call: num(k.call), import: num(k.import), customers: num(k.customers) },
      settings: await campaignSettings(db),
      sentToday: used,
      quiet: { from: n.quietFrom, to: n.quietTo },
      lang: n.lang,
      shopName: String((await getSetting(db, 'shop')).name ?? ''),
      ready: await readiness(ctx),
    };
  }),

  /** One campaign: its results and each message (the last 300). */
  'campaigns.get': proc([...ROLES], z.object({ id }), async (ctx, i) => {
    const c = await campaignOf(ctx.db, i.id);
    const sends = await ctx.db.query(
      `SELECT s.*, (SELECT o.ref FROM sales o WHERE o.phone = s.phone AND o.created_at > s.sent_at AND o.created_at <= s.sent_at + interval '${ORDER_DAYS} days' ORDER BY o.created_at LIMIT 1) AS order_ref
       FROM wa_campaign_sends s WHERE s.campaign_id = $1 ORDER BY COALESCE(s.replied_at, s.read_at, s.delivered_at, s.sent_at) DESC NULLS LAST, s.id LIMIT 300`,
      [i.id],
    );
    return {
      campaign: c,
      sends: sends.map((s: any) => ({
        id: num(s.id),
        name: (s.name as string | null) ?? null,
        phone: String(s.phone),
        status: String(s.status),
        error: (s.error as string | null) ?? null,
        sentAt: isoOrNull(s.sent_at),
        readAt: isoOrNull(s.read_at),
        repliedAt: isoOrNull(s.replied_at),
        tapped: (s.tapped as 'order' | 'stop' | null) ?? null,
        orderRef: (s.order_ref as string | null) ?? null,
      })),
    };
  }),

  /** How many customers a choice reaches (and a few of their names). */
  'campaigns.audience': proc([...ROLES], z.object({ audience: AudienceInput }), (ctx, i) => audienceCount(ctx.db, i.audience, ctx.now())),

  /** The products and the landing pages a campaign can point to. */
  'campaigns.options': proc([...ROLES], z.object({}), async (ctx) => {
    const products = await ctx.db.query(`SELECT id, name FROM products WHERE active AND NOT is_service AND archived_at IS NULL ORDER BY lower(name), id LIMIT 500`);
    const pages = await ctx.db.query(`SELECT slug, title, product_id FROM landing_pages WHERE active ORDER BY id DESC LIMIT 200`).catch(() => []);
    const base = ctx.server?.pagesUrl?.() ?? ctx.server?.publicUrl ?? '';
    const store = await landingStore(ctx.db);
    return {
      products: products.map((p: any) => ({ id: num(p.id), name: String(p.name) })),
      pages: pages.map((p: any) => ({ slug: String(p.slug), title: String(p.title ?? p.slug), productId: numOrNull(p.product_id), url: base ? `${base.replace(/\/+$/, '')}/${store ? `${store}/` : ''}${p.slug}` : '' })),
      wilayas: WILAYAS.map((name, k) => ({ id: k + 1, name })),
    };
  }),

  /** A campaign written or changed (a draft; a refused one comes back to a draft). */
  'campaigns.save': proc([...ROLES], CampaignInput, async (ctx, i) => {
    const db = ctx.db;
    if (i.id) {
      const cur = (await db.query(`SELECT status FROM wa_campaigns WHERE id = $1`, [i.id]))[0];
      if (!cur) throw notFound('Campagne introuvable');
      if (!['draft', 'rejected', 'ready'].includes(cur.status)) throw bad('Cette campagne est déjà partie : elle ne change plus');
    }
    if (i.productId && !(await db.query(`SELECT 1 FROM products WHERE id = $1`, [i.productId])).length) throw bad('Produit introuvable');
    const v = [i.name, JSON.stringify(i.audience), i.lang, i.body.trim(), i.productId, i.link || null, i.orderButton, i.sendAt];
    if (i.id) {
      // a text changed after Meta's approval: it must be approved again
      const cur = (await db.query(`SELECT body, lang, link, order_button, status FROM wa_campaigns WHERE id = $1`, [i.id]))[0];
      const again = cur.status !== 'draft' && (cur.body !== i.body.trim() || cur.lang !== i.lang || (cur.link ?? null) !== (i.link || null) || !!cur.order_button !== i.orderButton);
      await db.query(
        `UPDATE wa_campaigns SET name = $2, audience = $3, lang = $4, body = $5, product_id = $6, link = $7, order_button = $8, send_at = $9, updated_at = now(),
           status = CASE WHEN $10::boolean OR status = 'rejected' THEN 'draft' ELSE status END WHERE id = $1`,
        [i.id, ...v, again],
      );
      return campaignOf(db, i.id);
    }
    const r = await db.query(
      `INSERT INTO wa_campaigns (name, audience, lang, body, product_id, link, order_button, send_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [...v, me(ctx)],
    );
    return campaignOf(db, num(r[0].id));
  }),

  /** « Envoyer à Meta »: the text and its buttons go for approval (a Marketing template). */
  'campaigns.submit': proc([...ROLES], z.object({ id }), async (ctx, i) => {
    const db = ctx.db;
    const c = (await db.query(`SELECT * FROM wa_campaigns WHERE id = $1`, [i.id]))[0];
    if (!c) throw notFound('Campagne introuvable');
    if (!['draft', 'rejected'].includes(c.status)) throw bad('Cette campagne est déjà chez Meta');
    const problems = campaignProblems(String(c.body));
    if (problems.length) throw bad(problems[0]);
    const lang = langOf(c.lang);
    const n = await notifySettings(db);
    // a new name each time (Meta keeps a refused name a while)
    const version = (String(c.template_name ?? '').match(/_v(\d+)$/)?.[1] ? Number(String(c.template_name).match(/_v(\d+)$/)![1]) : 0) + 1;
    const name = `pilotix_offre_${num(c.id)}_v${version}`;
    if (!simulated(ctx)) {
      const r = await readiness(ctx);
      if (!r.whatsapp) throw bad('WhatsApp n’est pas connecté : ajoutez le jeton et l’ID du numéro (Pilot Message › Réglages)');
      if (!n.wabaId) throw bad('Ajoutez l’ID du compte WhatsApp Business (Pilot Automations › Réglages)');
      const shop = (await getSetting(db, 'shop')).name;
      const example = templateParams(String(c.body), { nom: firstName('Amina', lang), boutique: shop });
      await ctx.server!.dellal!('waCreateTemplate', { wabaId: n.wabaId, name, lang: TEMPLATE_LANG[lang], body: templateBody(String(c.body)), example, category: 'MARKETING', buttons: templateButtons(c) }, ctx);
    }
    await db.query(`UPDATE wa_campaigns SET status = 'pending', template_name = $2, template_reason = NULL, updated_at = now() WHERE id = $1`, [i.id, name]);
    if (simulated(ctx)) await checkTemplates(ctx);
    return campaignOf(db, i.id);
  }),

  /** « Actualiser »: Meta's answer about the campaigns waiting for approval. */
  'campaigns.check': proc([...ROLES], z.object({}), async (ctx) => ({ changed: await checkTemplates(ctx) })),

  /** « Lancer »: the customers chosen now are the list (said yes, no « Stop »); the messages leave at the shop's pace. */
  'campaigns.start': proc([...ROLES], z.object({ id }), async (ctx, i) => {
    const db = ctx.db;
    const c = (await db.query(`SELECT * FROM wa_campaigns WHERE id = $1`, [i.id]))[0];
    if (!c) throw notFound('Campagne introuvable');
    if (c.status !== 'ready') throw bad(c.status === 'pending' ? 'Meta n’a pas encore approuvé ce message' : 'Cette campagne ne peut pas être lancée maintenant');
    const audience = AudienceInput.parse(c.audience ?? {});
    const w = audienceWhere(audience, ctx.now());
    const r = await db.query(
      `INSERT INTO wa_campaign_sends (campaign_id, customer_id, phone, name) SELECT ${w.p(i.id)}::bigint, c.id, c.phone, c.name FROM customers c ${w.sql} ON CONFLICT (campaign_id, phone) DO NOTHING RETURNING id`,
      w.params,
    );
    if (!r.length) throw bad('Aucun client ne correspond (ou aucun n’a accepté les offres)');
    await db.query(`UPDATE wa_campaigns SET status = 'sending', started_at = $2, updated_at = now() WHERE id = $1`, [i.id, new Date(ctx.now()).toISOString()]);
    // the preview has no background job: it « sends » at once
    if (simulated(ctx)) await runCampaigns(ctx, { campaignId: i.id });
    return campaignOf(db, i.id);
  }),

  /** « Pause », « Reprendre », « Arrêter ». */
  'campaigns.state': proc([...ROLES], z.object({ id, action: z.enum(['pause', 'resume', 'cancel']) }), async (ctx, i) => {
    const db = ctx.db;
    const from = i.action === 'pause' ? ['sending'] : i.action === 'resume' ? ['paused'] : ['sending', 'paused', 'ready', 'pending'];
    const to = i.action === 'pause' ? 'paused' : i.action === 'resume' ? 'sending' : 'canceled';
    const r = await db.query(`UPDATE wa_campaigns SET status = $2, updated_at = now(), finished_at = CASE WHEN $2 = 'canceled' THEN $4 ELSE finished_at END WHERE id = $1 AND status = ANY($3) RETURNING id`, [
      i.id,
      to,
      from,
      new Date(ctx.now()).toISOString(),
    ]);
    if (!r[0]) throw bad('Impossible maintenant');
    if (i.action === 'cancel') await db.query(`UPDATE wa_campaign_sends SET status = 'skipped', error = 'Campagne arrêtée' WHERE campaign_id = $1 AND status = 'queued'`, [i.id]);
    if (i.action === 'resume' && simulated(ctx)) await runCampaigns(ctx, { campaignId: i.id });
    return campaignOf(db, i.id);
  }),

  /** A campaign that sent nothing yet goes away. */
  'campaigns.remove': proc([...ROLES], z.object({ id }), async (ctx, i) => {
    const sent = (await ctx.db.query(`SELECT 1 FROM wa_campaign_sends WHERE campaign_id = $1 AND sent_at IS NOT NULL LIMIT 1`, [i.id])).length;
    if (sent) throw bad('Cette campagne a envoyé des messages : elle reste dans l’historique (arrêtez-la si besoin)');
    await ctx.db.query(`DELETE FROM wa_campaigns WHERE id = $1`, [i.id]);
    return { ok: true };
  }),

  /** The pace (messages a day) and the box on the landing pages. */
  'campaigns.settings': proc([...ROLES], z.object({ perDay: z.number().int().min(10).max(100_000), formOptin: z.boolean() }), async (ctx, i) => {
    await ctx.db.query(`INSERT INTO settings (key, value) VALUES ('campaigns', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(i)]);
    return campaignSettings(ctx.db);
  }),

  /** The agent asked during the call: the customer wants (or not) the offers on WhatsApp. */
  'campaigns.optin': proc(['marketer', 'confirmation', 'suivi'], z.object({ customerId: id, on: z.boolean() }), async (ctx, i) => {
    const c = (await ctx.db.query(`SELECT phone FROM customers WHERE id = $1`, [i.customerId]))[0];
    if (!c) throw notFound('Client introuvable');
    const at = new Date(ctx.now()).toISOString();
    if (i.on) await giveConsent(ctx.db, String(c.phone), 'call', at);
    else await ctx.db.query(`UPDATE customers SET wa_optin_at = NULL, wa_optin_source = NULL WHERE id = $1`, [i.customerId]);
    return { on: i.on };
  }),

  /** « Ajouter des numéros »: customers who said yes elsewhere (the shop's own list); unknown numbers are only counted. */
  'campaigns.import': proc([...ROLES], z.object({ phones: z.string().max(100_000) }), async (ctx, i) => {
    const at = new Date(ctx.now()).toISOString();
    // one number per line (or comma), written any way: « 0555 12 34 56 », « +213 555-12-34-56 »
    const phones = new Set<string>();
    let invalid = 0;
    for (const part of i.phones.split(/[\n,;]+/).map((t) => t.trim()).filter(Boolean)) {
      const hits = (part.match(MOBILE) ?? []).map((h) => normalizePhone(h)).filter((p): p is string => !!p);
      if (!hits.length) invalid++;
      for (const p of hits) phones.add(p);
    }
    let added = 0;
    let unknown = 0;
    for (const p of [...phones].slice(0, 5000)) {
      if (await giveConsent(ctx.db, p, 'import', at)) added++;
      else unknown++;
    }
    return { added, unknown, invalid };
  }),

  /** Server: send what is due (every minute). */
  'campaigns.run': proc([], z.object({}), (ctx) => runCampaigns(ctx)),
  /** Server: a WhatsApp status from Meta's webhook. */
  'campaigns.waStatus': proc([], z.object({ id: z.string().min(1).max(200), status: z.string().max(20), code: z.number().int().nullable().optional(), title: z.string().max(300).nullable().optional() }), async (ctx, i) => ({
    ok: await onCampaignStatus(ctx.db, i, new Date(ctx.now()).toISOString()),
  })),
  /** Server: a customer's WhatsApp message (a campaign button, « stop », an answer). */
  'campaigns.reply': proc(
    [],
    z.object({ phone: z.string().max(30), payload: z.string().max(200).nullable().optional(), text: z.string().max(4000).nullable().optional(), accountId: z.string().max(40).nullable().optional() }),
    (ctx, i) => onCampaignReply(ctx, i),
  ),
};

/** For the demo and the tests: what a campaign's message looks like for one customer. */
export const campaignText = (body: string, name: string, shop: string, lang: NotifyLang) => render(body, { nom: firstName(name, lang), boutique: shop });
