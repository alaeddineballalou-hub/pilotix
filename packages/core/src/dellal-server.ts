// Dellal on the server — SERVER ONLY (loaded as '@pilotix/core/dist/dellal-server', called through ctx.server.dellal).
// Calls the AI (Anthropic Messages API) and sends messages to WhatsApp (Cloud API), Messenger and Instagram (Graph API);
// for Delivery AI agent, WhatsApp templates and SMS (SMS Gateway for Android, or any HTTP SMS service).
// Keys are read from the settings table (written by dellal.settings.save / notify.settings.save) and never leave the server.
import { AppError, Ctx } from './rpc';
import { AiRequest, AiResponse, DellalChannel, dellalSecret } from './modules/dellal';
import { NOTIFY_SMS_SECRET, notifySettings } from './modules/notify';

import { pilotKey } from './platform/pilotai';
import type { PilotAiReq } from './modules/pilotlearn';

const GRAPH = 'https://graph.facebook.com/v21.0';
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

async function postJson(url: string, body: unknown, headers: Record<string, string>, who: string, method: 'POST' | 'GET' = 'POST', timeoutMs = 30_000): Promise<any> {
  let res: Response;
  // a service that hangs must not hold the sending job (or the courier sync that shares its worker)
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    res = await fetch(url, method === 'GET' ? { headers: { Accept: 'application/json', ...headers }, signal } : { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch {
    throw new AppError('bad_request', `${who} injoignable. Réessayez plus tard.`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const e = data?.error;
    const m = (typeof e === 'string' ? e : e?.error_user_msg ?? e?.message) ?? data?.message ?? res.statusText;
    // Meta's error code travels with the error (Delivery AI agent decides: try again, or SMS)
    const fail = (code: AppError['code'], text: string) => Object.assign(new AppError(code, text), { metaCode: typeof e?.code === 'number' ? e.code : null, status: res.status });
    if (res.status === 401 || e?.code === 190) throw fail('bad_request', `${who} : clé ou jeton refusé (${m}). Vérifiez les réglages.`);
    if (res.status === 429) throw fail('conflict', `${who} limite les demandes pour l’instant.`);
    throw fail('bad_request', `${who} : ${m}`);
  }
  return data;
}

/**
 * Pilot AI's night work as one Message Batch (half the normal price): sends the requests, checks the batch every minute
 * (at most `maxWaitMs`, 6 hours by default), then returns the answers in the same order (null = that request failed;
 * a batch that did not end in time is cancelled and every answer is null: those requests are not billed).
 */
export function pilotBatch(key: string, o: { maxWaitMs?: number; everyMs?: number } = {}) {
  const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const who = 'IA (Anthropic, lot de nuit)';
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return async (reqs: PilotAiReq[]): Promise<(string | null)[]> => {
    if (!reqs.length) return [];
    const requests = reqs.map((r, i) => ({ custom_id: `r${i}`, params: { model: r.model, max_tokens: r.maxTokens, system: r.system, messages: [{ role: 'user', content: r.user }] } }));
    let b = await postJson(`${ANTHROPIC}/batches`, { requests }, headers, who, 'POST', 120_000);
    const until = Date.now() + (o.maxWaitMs ?? 6 * 3_600_000);
    while (b?.processing_status !== 'ended') {
      if (Date.now() > until) {
        await postJson(`${ANTHROPIC}/batches/${b.id}/cancel`, {}, headers, who).catch(() => null);
        return reqs.map(() => null);
      }
      await wait(o.everyMs ?? 60_000);
      b = await postJson(`${ANTHROPIC}/batches/${b.id}`, null, headers, who, 'GET').catch(() => b);
    }
    const out: (string | null)[] = reqs.map(() => null);
    const res = await fetch(b.results_url, { headers, signal: AbortSignal.timeout(120_000) }).catch(() => null);
    if (!res?.ok) return out;
    for (const line of (await res.text()).split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        const i = Number(String(j.custom_id).slice(1));
        if (j.result?.type === 'succeeded' && i >= 0 && i < out.length)
          out[i] = (j.result.message?.content ?? []).map((c: any) => (c.type === 'text' ? c.text : '')).join('').trim() || null;
      } catch {
        // a broken line: that answer stays null
      }
    }
    return out;
  };
}

/** Splits a long reply on paragraph / sentence ends (Messenger: 2000 characters, WhatsApp: 4096). */
export function chunks(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('. ', max) + 1;
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

async function send(ctx: Ctx, a: { channel: DellalChannel; externalId: string; accountId?: string | null; text: string }) {
  if (a.channel === 'whatsapp') {
    const token = await dellalSecret(ctx.db, 'waToken');
    const phoneId = a.accountId || (await ctx.db.query(`SELECT value->>'whatsappPhoneId' AS v FROM settings WHERE key = 'dellal'`))[0]?.v;
    if (!token || !phoneId) throw new AppError('bad_request', 'WhatsApp n’est pas connecté (jeton ou ID du numéro manquant).');
    for (const t of chunks(a.text, 4000))
      await postJson(`${GRAPH}/${phoneId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to: a.externalId, type: 'text', text: { body: t, preview_url: false } }, { Authorization: `Bearer ${token}` }, 'WhatsApp');
    return { ok: true };
  }
  if (a.channel === 'messenger' || a.channel === 'instagram') {
    const token = await dellalSecret(ctx.db, 'pageToken');
    if (!token) throw new AppError('bad_request', 'La page Facebook n’est pas connectée (jeton de page manquant).');
    for (const t of chunks(a.text, 1900))
      await postJson(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, { recipient: { id: a.externalId }, messaging_type: 'RESPONSE', message: { text: t } }, {}, a.channel === 'instagram' ? 'Instagram' : 'Messenger');
    return { ok: true };
  }
  if (a.channel === 'tiktok') throw new AppError('bad_request', 'TikTok : l’envoi direct sera actif quand TikTok aura approuvé votre compte pour la messagerie.');
  return { ok: true };
}

async function complete(ctx: Ctx, req: AiRequest): Promise<AiResponse> {
  // Pilot AI: Pilotix's own key for every shop (the control room); otherwise, on an install without it, the shop's key
  const key = (ctx.t ? await pilotKey(ctx.t).catch(() => null) : null) || (await dellalSecret(ctx.db, 'ai'));
  if (!key) throw new AppError('bad_request', 'Clé API de l’IA manquante (Messages › Réglages).');
  // Dellal's instructions are long: each block is cached on its own (the part every shop shares, this shop's part, this
  // conversation's part), so a new chat reuses the first two and each following message is billed mostly at the cached rate.
  const { tools, systemBlocks, ...rest } = req;
  const blocks = (systemBlocks ?? []).filter((b) => b.trim()).slice(0, 4);
  const system = (blocks.length ? blocks : [req.system]).map((text) => ({ type: 'text', text, cache_control: { type: 'ephemeral' } }));
  const body = { ...rest, ...(tools?.length ? { tools } : {}), system };
  const data = await postJson(ANTHROPIC, body, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, 'IA (Anthropic)', 'POST', 180_000);
  return { content: data.content ?? [], stop_reason: data.stop_reason ?? 'end_turn', usage: data.usage };
}

// ---------------------------------------------------------------- CM AI agent: comments (Graph API, the page token)
type CmArgs = { channel: 'facebook' | 'instagram' | 'tiktok'; commentId?: string; postId?: string; text?: string; hidden?: boolean };
const enc = encodeURIComponent;

async function pageToken(ctx: Ctx): Promise<string> {
  const token = await dellalSecret(ctx.db, 'pageToken');
  if (!token) throw new AppError('bad_request', 'La page Facebook n’est pas connectée (jeton de page manquant dans Message AI agent › Réglages).');
  return token;
}

/** Answers a comment in public: Facebook /{comment}/comments, Instagram /{comment}/replies. */
async function cmReply(ctx: Ctx, a: CmArgs) {
  if (a.channel === 'tiktok') throw new AppError('bad_request', 'TikTok : la réponse aux commentaires arrive bientôt.');
  const token = await pageToken(ctx);
  const path = a.channel === 'instagram' ? 'replies' : 'comments';
  const r = await postJson(`${GRAPH}/${enc(String(a.commentId))}/${path}?access_token=${enc(token)}`, { message: String(a.text ?? '').slice(0, 2000) }, {}, a.channel === 'instagram' ? 'Instagram' : 'Facebook');
  return { id: r?.id ? String(r.id) : null };
}

/** The private reply to a comment (one per comment, within 7 days): opens a Messenger / Instagram conversation. */
async function cmPrivate(ctx: Ctx, a: CmArgs) {
  if (a.channel === 'tiktok') throw new AppError('bad_request', 'TikTok : le message privé depuis un commentaire arrive bientôt.');
  const token = await pageToken(ctx);
  const r = await postJson(`${GRAPH}/me/messages?access_token=${enc(token)}`, { recipient: { comment_id: String(a.commentId) }, message: { text: String(a.text ?? '').slice(0, 1900) } }, {}, a.channel === 'instagram' ? 'Instagram' : 'Messenger');
  return { recipientId: r?.recipient_id ? String(r.recipient_id) : null, messageId: r?.message_id ? String(r.message_id) : null };
}

/** Hides (or shows again) a comment: Facebook is_hidden, Instagram hide. */
async function cmHide(ctx: Ctx, a: CmArgs) {
  if (a.channel === 'tiktok') throw new AppError('bad_request', 'TikTok : masquer un commentaire arrive bientôt.');
  const token = await pageToken(ctx);
  await postJson(`${GRAPH}/${enc(String(a.commentId))}?access_token=${enc(token)}`, a.channel === 'instagram' ? { hide: !!a.hidden } : { is_hidden: !!a.hidden }, {}, a.channel === 'instagram' ? 'Instagram' : 'Facebook');
  return { ok: true };
}

/** A post's text and link (the comment webhook does not carry them). */
async function cmPost(ctx: Ctx, a: CmArgs) {
  const token = await pageToken(ctx);
  const fields = a.channel === 'instagram' ? 'caption,permalink' : 'message,permalink_url';
  const r = await postJson(`${GRAPH}/${enc(String(a.postId))}?fields=${fields}&access_token=${enc(token)}`, null, {}, a.channel === 'instagram' ? 'Instagram' : 'Facebook', 'GET');
  return { caption: (r?.caption ?? r?.message ?? null) as string | null, permalink: (r?.permalink ?? r?.permalink_url ?? null) as string | null };
}

// ---------------------------------------------------------------- Delivery AI agent: WhatsApp templates, SMS
async function waNumber(ctx: Ctx): Promise<{ token: string; phoneId: string }> {
  const token = await dellalSecret(ctx.db, 'waToken');
  const phoneId = (await ctx.db.query(`SELECT value->>'whatsappPhoneId' AS v FROM settings WHERE key = 'dellal'`))[0]?.v;
  if (!token || !phoneId) throw new AppError('bad_request', 'WhatsApp n’est pas connecté (Message AI agent › Réglages : jeton et ID du numéro).');
  return { token, phoneId };
}

/** A message from an approved template (the only kind a business may send first): { to: '2136…', name, lang, params }. */
async function waTemplate(ctx: Ctx, a: { to: string; name: string; lang: string; params: string[] }) {
  const { token, phoneId } = await waNumber(ctx);
  const template = {
    name: a.name,
    language: { code: a.lang },
    ...(a.params.length ? { components: [{ type: 'body', parameters: a.params.map((t) => ({ type: 'text', text: String(t).slice(0, 1000) })) }] } : {}),
  };
  const r = await postJson(`${GRAPH}/${phoneId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to: a.to, type: 'template', template }, { Authorization: `Bearer ${token}` }, 'WhatsApp');
  return { id: r?.messages?.[0]?.id ? String(r.messages[0].id) : null };
}

/** The account's templates and their approval (APPROVED, PENDING, REJECTED, PAUSED, DISABLED). */
async function waTemplates(ctx: Ctx, a: { wabaId: string }) {
  const { token } = await waNumber(ctx);
  const out: { name: string; status: string; language: string; reason: string | null }[] = [];
  let url: string | null = `${GRAPH}/${enc(a.wabaId)}/message_templates?fields=name,status,language,rejected_reason&limit=100`;
  for (let page = 0; url && page < 10; page++) {
    const r: any = await postJson(url, null, { Authorization: `Bearer ${token}` }, 'WhatsApp', 'GET');
    for (const t of Array.isArray(r?.data) ? r.data : [])
      out.push({ name: String(t.name), status: String(t.status), language: String(t.language), reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? String(t.rejected_reason) : null });
    url = typeof r?.paging?.next === 'string' ? r.paging.next : null;
  }
  return out;
}

/** Sends a text to Meta for approval as a Utility template (order updates). */
async function waCreateTemplate(ctx: Ctx, a: { wabaId: string; name: string; lang: string; body: string; example: string[] }) {
  const { token } = await waNumber(ctx);
  const component = { type: 'BODY', text: a.body, ...(a.example.length ? { example: { body_text: [a.example] } } : {}) };
  const r = await postJson(`${GRAPH}/${enc(a.wabaId)}/message_templates`, { name: a.name, language: a.lang, category: 'UTILITY', components: [component] }, { Authorization: `Bearer ${token}` }, 'WhatsApp');
  return { id: r?.id ? String(r.id) : null, status: r?.status ? String(r.status) : 'PENDING' };
}

/** SMS Gateway for Android: the cloud (api.sms-gate.app) or a private server, or the phone itself on the local network. */
async function smsGateway(ctx: Ctx) {
  const s = await notifySettings(ctx.db);
  const secret = String((await ctx.db.query(`SELECT value FROM settings WHERE key = $1`, [NOTIFY_SMS_SECRET]))[0]?.value ?? '');
  const base = (s.smsUrl || 'https://api.sms-gate.app').replace(/\/+$/, '');
  const local = /:8080$/.test(base) || /^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(base);
  return { s, secret, base, local };
}
const plus213 = (p: string) => '+213' + String(p).replace(/^0/, '');

async function sms(ctx: Ctx, a: { to: string; text: string; validUntil?: string | null }) {
  const { s, secret, base, local } = await smsGateway(ctx);
  if (s.smsProvider === 'android') {
    if (!s.smsUser || !secret) throw new AppError('bad_request', 'SMS : identifiant ou mot de passe de SMS Gateway manquant (Delivery AI agent › Réglages).');
    const auth = `Basic ${Buffer.from(`${s.smsUser}:${secret}`).toString('base64')}`;
    // an SMS the phone could not send in time (offline) expires instead of leaving in the night
    const body = { textMessage: { text: a.text }, phoneNumbers: [plus213(a.to)], ...(a.validUntil ? { validUntil: a.validUntil.replace(/\.\d{3}Z$/, 'Z') } : {}) };
    const r = await postJson(`${base}${local ? '/message' : '/3rdparty/v1/messages'}`, body, { Authorization: auth }, 'SMS Gateway');
    return { id: r?.id ? String(r.id) : null, status: r?.state ? String(r.state) : null };
  }
  // any HTTP SMS service: POST { to, text } (and the token as Bearer)
  if (!s.smsUrl) throw new AppError('bad_request', 'SMS : adresse du service manquante (Delivery AI agent › Réglages).');
  const r = await postJson(s.smsUrl, { to: plus213(a.to), text: a.text }, secret ? { Authorization: `Bearer ${secret}` } : {}, 'Service SMS');
  const id = r?.id ?? r?.messageId ?? r?.message_id ?? null;
  return { id: id === null ? null : String(id), status: null };
}

/** Points the gateway's reports (sent, delivered, failed) and the customers' SMS answers to this server. */
async function smsHooks(ctx: Ctx, a: { url: string }) {
  const { s, secret, base, local } = await smsGateway(ctx);
  if (!s.smsUser || !secret) throw new AppError('bad_request', 'SMS : identifiant ou mot de passe de SMS Gateway manquant (Delivery AI agent › Réglages).');
  const auth = { Authorization: `Basic ${Buffer.from(`${s.smsUser}:${secret}`).toString('base64')}` };
  const path = `${base}${local ? '/webhooks' : '/3rdparty/v1/webhooks'}`;
  const have: any[] = await postJson(path, null, auth, 'SMS Gateway', 'GET').catch(() => []);
  const events = ['sms:sent', 'sms:delivered', 'sms:failed', 'sms:received'];
  for (const event of events)
    if (!(Array.isArray(have) ? have : []).some((h) => h?.url === a.url && h?.event === event)) await postJson(path, { url: a.url, event }, auth, 'SMS Gateway');
  return { ok: true, events };
}

/**
 *  - 'complete' → AiRequest: one call to the AI
 *  - 'send'     → { channel, externalId, accountId, text }: sends a message to the customer
 *  - 'ping'     → checks the AI key
 *  - 'cmReply' / 'cmPrivate' / 'cmHide' / 'cmPost' → the CM AI agent's actions on comments
 *  - 'waTemplate' / 'waTemplates' / 'waCreateTemplate' / 'sms' / 'smsHooks' → Delivery AI agent
 */
export async function runDellal(action: string, args: unknown, ctx: Ctx): Promise<unknown> {
  if (action === 'complete') return complete(ctx, args as AiRequest);
  if (action === 'send') return send(ctx, args as any);
  if (action === 'waTemplate') return waTemplate(ctx, args as any);
  if (action === 'waTemplates') return waTemplates(ctx, args as any);
  if (action === 'waCreateTemplate') return waCreateTemplate(ctx, args as any);
  if (action === 'sms') return sms(ctx, args as any);
  if (action === 'smsHooks') return smsHooks(ctx, args as any);
  if (action === 'cmReply') return cmReply(ctx, args as CmArgs);
  if (action === 'cmPrivate') return cmPrivate(ctx, args as CmArgs);
  if (action === 'cmHide') return cmHide(ctx, args as CmArgs);
  if (action === 'cmPost') return cmPost(ctx, args as CmArgs);
  if (action === 'ping') {
    await complete(ctx, { model: 'claude-haiku-5-5', system: 'Réponds OK.', messages: [{ role: 'user', content: 'ping' }], tools: [] as any, max_tokens: 5 });
    return { ok: true };
  }
  throw new AppError('bad_request', `Action Dellal inconnue : ${action}`);
}

// ---------------------------------------------------------------- incoming webhooks
export interface Incoming {
  channel: DellalChannel;
  externalId: string;
  accountId: string | null;
  name: string | null;
  text: string;
  messageId: string | null;
  source: string | null;
}

const MEDIA: Record<string, string> = {
  image: '[photo envoyée]',
  audio: '[message vocal envoyé]',
  video: '[vidéo envoyée]',
  sticker: '[sticker]',
  document: '[document envoyé]',
  location: '[position envoyée]',
  file: '[fichier envoyé]',
};

/** Reads a Meta webhook (Messenger page, Instagram, WhatsApp Business) into plain customer messages. */
export function parseMetaWebhook(body: any): Incoming[] {
  const out: Incoming[] = [];
  const obj = body?.object;
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    if (obj === 'page' || obj === 'instagram') {
      for (const ev of Array.isArray(entry?.messaging) ? entry.messaging : []) {
        const m = ev?.message;
        if (!m || m.is_echo || !ev?.sender?.id) continue;
        const att = Array.isArray(m.attachments) ? m.attachments[0] : null;
        const text = String(m.text ?? (att ? MEDIA[att.type] ?? '[pièce jointe]' : '')).trim();
        if (!text) continue;
        const ref = m.referral ?? ev.referral;
        out.push({
          channel: obj === 'page' ? 'messenger' : 'instagram',
          externalId: String(ev.sender.id),
          accountId: ev?.recipient?.id ? String(ev.recipient.id) : null,
          name: null,
          text: text.slice(0, 4000),
          messageId: m.mid ? String(m.mid) : null,
          source: ref?.ad_id ? `pub ${ref.ad_id}` : ref?.source ? String(ref.source).toLowerCase() : null,
        });
      }
    }
    if (obj === 'whatsapp_business_account') {
      for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
        const v = ch?.value;
        const names = new Map<string, string>((Array.isArray(v?.contacts) ? v.contacts : []).map((c: any) => [String(c.wa_id), String(c?.profile?.name ?? '')]));
        for (const m of Array.isArray(v?.messages) ? v.messages : []) {
          if (!m?.from) continue;
          const text = String(
            m.type === 'text'
              ? m.text?.body ?? ''
              : m.type === 'button'
                ? m.button?.text ?? ''
                : m.type === 'interactive'
                  ? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? ''
                  : m.type === 'image' && m.image?.caption
                    ? `${MEDIA.image} ${m.image.caption}`
                    : MEDIA[m.type] ?? '[message]',
          ).trim();
          if (!text) continue;
          out.push({
            channel: 'whatsapp',
            externalId: String(m.from),
            accountId: v?.metadata?.phone_number_id ? String(v.metadata.phone_number_id) : null,
            name: names.get(String(m.from)) || null,
            text: text.slice(0, 4000),
            messageId: m.id ? String(m.id) : null,
            source: m.referral?.headline ? `pub « ${String(m.referral.headline).slice(0, 80)} »` : m.referral?.source_id ? `pub ${m.referral.source_id}` : null,
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- delivery statuses (Delivery AI agent)
/** WhatsApp message statuses in a Meta webhook (sent, delivered, read, failed with its error). */
export function parseWhatsAppStatuses(body: any): { id: string; status: string; code: number | null; title: string | null }[] {
  const out: { id: string; status: string; code: number | null; title: string | null }[] = [];
  if (body?.object !== 'whatsapp_business_account') return out;
  for (const entry of Array.isArray(body?.entry) ? body.entry : [])
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : [])
      for (const st of Array.isArray(ch?.value?.statuses) ? ch.value.statuses : []) {
        if (!st?.id || !st?.status) continue;
        const err = Array.isArray(st.errors) ? st.errors[0] : null;
        out.push({
          id: String(st.id),
          status: String(st.status),
          code: typeof err?.code === 'number' ? err.code : null,
          title: err ? String(err.error_data?.details ?? err.title ?? err.message ?? '').slice(0, 300) || null : null,
        });
      }
  return out;
}

/** An SMS gateway webhook: SMS Gateway for Android's envelope, or a plain { event, id, phone, text, reason }. */
export function parseSmsEvent(body: any): { event: 'sent' | 'delivered' | 'failed' | 'received'; id: string | null; phone: string | null; text: string | null; reason: string | null } | null {
  const raw = String(body?.event ?? '').toLowerCase();
  const p = body?.payload && typeof body.payload === 'object' ? body.payload : body;
  const event = raw.replace(/^sms:/, '');
  if (!['sent', 'delivered', 'failed', 'received'].includes(event)) return null;
  const s = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v));
  return {
    event: event as 'sent' | 'delivered' | 'failed' | 'received',
    id: s(p?.messageId ?? p?.id ?? p?.message_id),
    phone: s(event === 'received' ? p?.sender ?? p?.phoneNumber ?? p?.phone ?? p?.from : p?.recipient ?? p?.phoneNumber ?? p?.phone),
    text: s(p?.message ?? p?.text)?.slice(0, 2000) ?? null,
    reason: s(p?.reason)?.slice(0, 300) ?? null,
  };
}

// ---------------------------------------------------------------- incoming comments (CM AI agent)
export interface IncomingComment {
  channel: 'facebook' | 'instagram';
  externalId: string;
  postId: string;
  accountId: string | null;
  parentId: string | null;
  authorId: string | null;
  authorName: string | null;
  text: string;
  caption: string | null;
  permalink: string | null;
  isAd: boolean;
}

/**
 * Reads the comments of a Meta webhook: the page's "feed" field (comments on posts and ads) and Instagram's "comments".
 * Only new comments with text; the page's own comments are left out.
 */
export function parseMetaComments(body: any): IncomingComment[] {
  const out: IncomingComment[] = [];
  const obj = body?.object;
  for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
    const own = entry?.id ? String(entry.id) : null;
    for (const ch of Array.isArray(entry?.changes) ? entry.changes : []) {
      const v = ch?.value;
      if (!v) continue;
      if (obj === 'page' && ch.field === 'feed' && v.item === 'comment' && v.verb === 'add') {
        const text = String(v.message ?? '').trim();
        const from = v.from?.id ? String(v.from.id) : null;
        if (!text || !v.comment_id || !v.post_id || (own && from === own)) continue;
        out.push({
          channel: 'facebook',
          externalId: String(v.comment_id),
          postId: String(v.post_id),
          accountId: own,
          parentId: v.parent_id && String(v.parent_id) !== String(v.post_id) ? String(v.parent_id) : null,
          authorId: from,
          authorName: v.from?.name ? String(v.from.name).slice(0, 200) : null,
          text: text.slice(0, 4000),
          caption: null,
          permalink: v.post?.permalink_url ? String(v.post.permalink_url) : null,
          // a boosted post or an ad (promotion running, ended or extendable)
          isAd: ['active', 'extendable', 'finished'].includes(String(v.post?.promotion_status ?? '')),
        });
      }
      if (obj === 'instagram' && ch.field === 'comments') {
        const text = String(v.text ?? '').trim();
        const id = v.id ?? v.comment_id;
        const from = v.from?.id ? String(v.from.id) : null;
        if (!text || !id || !v.media?.id || (own && from === own) || v.from?.self_ig_scoped_id) continue;
        out.push({
          channel: 'instagram',
          externalId: String(id),
          postId: String(v.media.id),
          accountId: own,
          parentId: v.parent_id ? String(v.parent_id) : null,
          authorId: from,
          authorName: v.from?.username ? `@${String(v.from.username).slice(0, 120)}` : null,
          text: text.slice(0, 4000),
          caption: null,
          permalink: null,
          isAd: v.media?.media_product_type === 'AD',
        });
      }
    }
  }
  return out;
}
