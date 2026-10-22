// Dellal on the server — SERVER ONLY (loaded as '@pilotix/core/dist/dellal-server', called through ctx.server.dellal).
// Calls the AI (Anthropic Messages API) and sends messages to WhatsApp (Cloud API), Messenger and Instagram (Graph API).
// Keys are read from the settings table (written by dellal.settings.save) and never leave the server.
import { AppError, Ctx } from './rpc';
import { AiRequest, AiResponse, DellalChannel, dellalSecret } from './modules/dellal';

const GRAPH = 'https://graph.facebook.com/v21.0';
const ANTHROPIC = 'https://api.anthropic.com/v1/messages';

async function postJson(url: string, body: unknown, headers: Record<string, string>, who: string, method: 'POST' | 'GET' = 'POST'): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, method === 'GET' ? { headers: { Accept: 'application/json', ...headers } } : { method, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body: JSON.stringify(body) });
  } catch {
    throw new AppError('bad_request', `${who} injoignable. Réessayez plus tard.`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error) {
    const m = data?.error?.message ?? res.statusText;
    if (res.status === 401 || data?.error?.code === 190) throw new AppError('bad_request', `${who} : clé ou jeton refusé (${m}). Vérifiez Messages › Réglages.`);
    if (res.status === 429) throw new AppError('conflict', `${who} limite les demandes pour l’instant.`);
    throw new AppError('bad_request', `${who} : ${m}`);
  }
  return data;
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
  const key = await dellalSecret(ctx.db, 'ai');
  if (!key) throw new AppError('bad_request', 'Clé API de l’IA manquante (Messages › Réglages).');
  // Dellal's instructions are long and identical for every message of a conversation: cache them (tools + system),
  // so each following message is billed mostly at the cached rate.
  const { tools, ...rest } = req;
  const body = { ...rest, ...(tools?.length ? { tools } : {}), system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }] };
  const data = await postJson(ANTHROPIC, body, { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, 'IA (Anthropic)');
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

/**
 *  - 'complete' → AiRequest: one call to the AI
 *  - 'send'     → { channel, externalId, accountId, text }: sends a message to the customer
 *  - 'ping'     → checks the AI key
 *  - 'cmReply' / 'cmPrivate' / 'cmHide' / 'cmPost' → the CM AI agent's actions on comments
 */
export async function runDellal(action: string, args: unknown, ctx: Ctx): Promise<unknown> {
  if (action === 'complete') return complete(ctx, args as AiRequest);
  if (action === 'send') return send(ctx, args as any);
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
