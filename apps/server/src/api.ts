import {
  ArgumentsHost,
  Body,
  CanActivate,
  Catch,
  Controller,
  ExceptionFilter,
  ExecutionContext,
  Get,
  Headers,
  HttpException,
  Injectable,
  Logger,
  Module,
  Param,
  Post,
  Query,
  RawBodyRequest,
  Req,
  Res,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { APP_FILTER, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as core from '@pilotix/core';
import { normalizePhone, Session } from '@pilotix/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from './config';
import { CoreService } from './core.service';

// ---------------------------------------------------------------- errors → HTTP
const STATUS: Record<string, number> = { bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409 };

@Catch()
class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('API');
  catch(e: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    let status = 500;
    let message = 'Erreur du serveur';
    if (e instanceof core.AppError) {
      status = STATUS[e.code] ?? 400;
      message = e.message;
    } else if (e instanceof HttpException) {
      status = e.getStatus();
      const r = e.getResponse() as any;
      message = typeof r === 'string' ? r : r?.message ?? e.message;
    } else {
      this.log.error(e?.stack || e);
    }
    res.status(status).send({ message });
  }
}

// ---------------------------------------------------------------- auth
const PUBLIC = 'px:public';
const Public = () => SetMetadata(PUBLIC, true);

@Injectable()
class AuthGuard implements CanActivate {
  /** Profiles are re-read at most every 30 s, so a deactivated account loses access quickly. */
  private cache = new Map<number, { s: Session; at: number; tv: number }>();
  constructor(
    private readonly jwt: JwtService,
    private readonly core: CoreService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const h: string = req.headers?.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) throw new UnauthorizedException('Connectez-vous');
    let id: number;
    let tv = 0;
    try {
      const claims = await this.jwt.verifyAsync<{ sub: number; tv?: number }>(token);
      id = Number(claims.sub);
      tv = Number(claims.tv ?? 0);
    } catch {
      throw new UnauthorizedException('Session expirée, reconnectez-vous');
    }
    const hit = this.cache.get(id);
    // a token of another version than the cached one (just logged in again, password just changed): read again
    if (hit && Date.now() - hit.at < 30_000 && tv === hit.tv) {
      req.session = hit.s;
      return true;
    }
    const p = await core.profileById(this.core.db, id);
    if (!p || !p.active) throw new UnauthorizedException('Compte désactivé');
    // a password change raises token_version: tokens made before it stop working
    const cur = await tokenVersion(this.core.db, id);
    const s = core.makeSession(p);
    this.cache.set(id, { s, at: Date.now(), tv: cur });
    if (tv !== cur) throw new UnauthorizedException('Mot de passe changé : reconnectez-vous');
    req.session = s;
    return true;
  }
}

/** What the server knows of a landing page's visitor: address, browser, Meta cookies, and the host's geolocation (a soft signal). */
function visitorMeta(req: { ip?: string; headers: Record<string, string | undefined> }) {
  const h = req.headers;
  const decode = (v: string) => {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  };
  const cookie = (name: string) => (h.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? '';
  return {
    ip: core.expandIp(req.ip || ''),
    ua: h['user-agent'] || '',
    country: h['cf-ipcountry'] || h['x-vercel-ip-country'] || h['x-geo-country'] || '',
    city: decode(h['cf-ipcity'] || h['x-vercel-ip-city'] || h['x-geo-city'] || ''),
    region: h['cf-region'] || h['x-vercel-ip-country-region'] || h['x-geo-region'] || '',
    fbp: cookie('_fbp'),
    fbc: cookie('_fbc'),
    url: h.referer || '',
  };
}

/** Landing pages: requests per address and kind over 10 minutes; true = over the limit (handled silently). */
const lpHits = new Map<string, { n: number; until: number }>();
function limitLanding(ip: string, kind: string, max: number): boolean {
  const now = Date.now();
  if (lpHits.size > 50_000) for (const [k, v] of lpHits) if (v.until < now) lpHits.delete(k);
  const key = `${kind}:${core.ipNet(ip)}`; // an IPv6 /64 is one visitor
  const a = lpHits.get(key);
  if (!a || a.until < now) {
    lpHits.set(key, { n: 1, until: now + 10 * 60_000 });
    return false;
  }
  return ++a.n > max;
}
/** A browser posting from another site (a page that makes its visitors send fake leads): not our page. */
const crossSite = (req: { headers: Record<string, string | undefined> }) => req.headers['sec-fetch-site'] === 'cross-site';

/** Compares two secrets in constant time (no timing hint on how much of a key was right). */
function sameKey(given: unknown, want: unknown): boolean {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(String(want ?? ''));
  return a.length > 0 && b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

/** The token version of an account (raised when its password changes). */
export async function tokenVersion(db: core.Db, id: number): Promise<number> {
  return Number((await db.query('SELECT token_version FROM profiles WHERE id = $1', [id]))[0]?.token_version ?? 0);
}

/**
 * Failed logins: 10 per 15 minutes per address, and 5 per account from one address. Never per account alone: a stranger
 * sending wrong passwords from a few addresses would keep the owner out of the shop. Only failures count, and a
 * good password clears the counter.
 */
const attempts = new Map<string, { n: number; until: number }>();
function checkLogin(key: string, max: number) {
  const a = attempts.get(key);
  if (a && a.until >= Date.now() && a.n >= max) throw new HttpException({ message: 'Trop de tentatives, réessayez dans quelques minutes' }, 429);
}
function failedLogin(key: string) {
  const now = Date.now();
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  const a = attempts.get(key);
  if (!a || a.until < now) attempts.set(key, { n: 1, until: now + 15 * 60_000 });
  else a.n++;
}
let proxyWarned = false;

/** Dellal: newest message per conversation and the answer running for it. */
const latest = new Map<number, number>();
const running = new Map<number, Promise<unknown>>();
/** CM AI agent: one answer at a time (comments arrive in bursts under an ad). */
let cmQueue: Promise<unknown> = Promise.resolve();
function optionalDellal(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@pilotix/core/dist/dellal-server');
  } catch {
    return null;
  }
}

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

@Controller()
@UseGuards(AuthGuard)
class ApiController {
  constructor(
    private readonly core: CoreService,
    private readonly jwt: JwtService,
  ) {}

  @Public()
  @Get('health')
  async health() {
    await this.core.db.query('SELECT 1');
    return { ok: true, time: new Date().toISOString() };
  }

  @Public()
  @Post('auth/login')
  async login(@Body() body: unknown, @Req() req: { ip?: string; headers?: Record<string, unknown> }) {
    if (!config.trustProxy && req.headers?.['x-forwarded-for'] && !proxyWarned) {
      proxyWarned = true;
      new Logger('Pilotix').warn('Requests come through a proxy (X-Forwarded-For) but TRUST_PROXY is not set: the login limit sees every user as the proxy. Set TRUST_PROXY=1.');
    }
    const ipKey = `ip:${core.ipNet(req.ip || '') || 'unknown'}`;
    checkLogin(ipKey, 10);
    const b = LoginBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Email ou mot de passe manquant');
    const mailKey = `email:${b.data.email.trim().toLowerCase()}|${core.ipNet(req.ip || '') || 'unknown'}`;
    checkLogin(mailKey, 5);
    let session: Session;
    try {
      session = await core.login(this.core.db, b.data.email, b.data.password);
    } catch (e) {
      failedLogin(ipKey);
      failedLogin(mailKey);
      throw e;
    }
    attempts.delete(mailKey);
    const token = await this.jwt.signAsync({ sub: session.profile.id, tv: await tokenVersion(this.core.db, session.profile.id) });
    return { token, session };
  }

  @Post('rpc/:name')
  async rpc(@Param('name') name: string, @Body() body: unknown, @Req() req: { session: Session }) {
    // names like orders.list, and grouped ones like dellal.settings.get or cm.settings.save
    if (!/^[a-z]+(\.[a-zA-Z]+){1,3}$/.test(name)) throw new core.AppError('not_found', 'Action inconnue');
    const out: any = await this.core.call(name, req.session, body ?? {});
    // a new password logs out the other sessions: this one gets a fresh token and stays in
    if (name === 'me.password') {
      const id = req.session.profile.id;
      return { ...out, token: await this.jwt.signAsync({ sub: id, tv: await tokenVersion(this.core.db, id) }) };
    }
    return out;
  }

  /**
   * Orders from a website or a store. Body: { name|customer_name, phone, phone2?, wilaya (code), commune?, address?, stopdesk?,
   *   items: [{ sku, qty, price? }], note?, source?, utm? }. Key: ?key= or header x-webhook-key.
   */
  @Public()
  @Post('hooks/orders/:channel')
  async orderHook(@Param('channel') channel: string, @Query('key') qkey: string, @Headers('x-webhook-key') hkey: string, @Body() body: any) {
    const key = qkey || hkey || '';
    const db = this.core.db;
    let ch: any = null;
    if (/^\d+$/.test(channel)) ch = (await db.query('SELECT * FROM sales_channels WHERE id = $1 AND active', [Number(channel)]))[0];
    const shopKey = (await core.getSetting(db, 'webhook')).key;
    const ok = ch ? sameKey(key, ch.webhook_key) : channel === 'site' && sameKey(key, shopKey);
    if (!ok) throw new core.AppError('unauthorized', 'Clé webhook invalide');
    // the store's own order number: when the store sends the same order again (retry after a timeout), the order
    // already made is answered instead of creating a second one
    const extId = String(body?.order_id ?? body?.external_id ?? body?.id ?? '').trim().slice(0, 120) || null;
    const chKey = ch ? `ch${ch.id}` : 'site';
    if (extId) {
      const ext = `${chKey}:${extId}`; // unique per store (two stores may both have an order n° 1001)
      const seen = (await db.query('SELECT id, ref FROM orders WHERE ext_order_id = $1', [ext]))[0];
      if (seen) return { ok: true, id: Number(seen.id), ref: seen.ref, duplicate: true };
      return core.withActionLock(db, `hook:${chKey}:${extId}`, null, 'Commande déjà en cours de réception', async () => {
        const again = (await db.query('SELECT id, ref FROM orders WHERE ext_order_id = $1', [ext]))[0];
        if (again) return { ok: true, id: Number(again.id), ref: again.ref, duplicate: true };
        const made = await this.createFromHook(ch, channel, body);
        await db.query('UPDATE orders SET ext_order_id = $2 WHERE id = $1', [made.id, ext]);
        return made;
      });
    }
    return this.createFromHook(ch, channel, body);
  }

  private async createFromHook(ch: any, channel: string, body: any) {
    const db = this.core.db;

    const items: { productId: number; variantId: number | null; qty: number; unitPrice?: number }[] = [];
    for (const it of Array.isArray(body?.items) ? body.items : []) {
      const sku = String(it.sku ?? '').trim();
      const v = (await db.query('SELECT v.id, v.product_id FROM product_variants v WHERE v.sku = $1', [sku]))[0];
      const p = v ? null : (await db.query('SELECT id FROM products WHERE sku = $1', [sku]))[0];
      if (!v && !p) {
        if (ch?.sku_required) throw new core.AppError('bad_request', `SKU inconnu : ${sku}`);
        continue;
      }
      items.push({ productId: Number(v?.product_id ?? p.id), variantId: v ? Number(v.id) : null, qty: Math.max(1, Number(it.qty) || 1), unitPrice: it.price !== undefined ? Math.round(Number(it.price)) : undefined });
    }
    if (!items.length) throw new core.AppError('bad_request', 'Aucun produit reconnu (vérifiez les SKU)');
    const phone = normalizePhone(String(body?.phone ?? ''));
    if (!phone) throw new core.AppError('bad_request', 'Téléphone invalide');
    const session = await this.core.systemSession();
    const order: any = await this.core.call('orders.create', session, {
      customerName: String(body?.customer_name ?? body?.name ?? '').slice(0, 120) || 'Client',
      phone,
      phone2: body?.phone2 ? String(body.phone2) : null,
      wilayaId: Number(body?.wilaya ?? body?.wilaya_id),
      commune: String(body?.commune ?? ''),
      address: String(body?.address ?? ''),
      isStopdesk: !!body?.stopdesk,
      channel: (['site', 'facebook', 'instagram', 'tiktok', 'appel', 'whatsapp', 'autre'].includes(body?.channel) ? body.channel : 'site') as any,
      source: ch ? ch.name : String(body?.source ?? 'site'),
      utm: body?.utm && typeof body.utm === 'object' ? body.utm : null,
      items,
      customerNote: body?.note ? String(body.note).slice(0, 1000) : null,
    });
    if (ch) await db.query('UPDATE sales_channels SET last_sync_at = now() WHERE id = $1', [ch.id]);
    return { ok: true, id: order.id, ref: order.ref };
  }

  // ---------------------------------------------------------------- landing pages (public, no login)
  /** The page of one product: a single small HTML file (no app bundle), never cached (it carries a fresh challenge). */
  @Public()
  @Get('lp/:slug')
  async landingPage(@Param('slug') slug: string, @Res() res: any) {
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) return res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Page introuvable');
    const base = `${config.publicUrl}/api/lp/`;
    try {
      const r: any = await this.core.call('landing.html', await this.core.systemSession(), { slug, mode: 'live', post: `${base}${slug}/order`, lead: `${base}${slug}/lead`, geo: `${base}geo/`, imgBase: `${base}img/` });
      return res.status(200).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(r.html);
    } catch (e: any) {
      if (e instanceof core.AppError && e.code === 'not_found') return res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Page introuvable');
      throw e;
    }
  }

  /** Communes of a wilaya, [French name, Arabic name] (asked when the customer picks a wilaya; cached a month). */
  @Public()
  @Get('lp/geo/:wilaya')
  landingGeo(@Param('wilaya') w: string, @Res() res: any) {
    const id = Number(w);
    if (!Number.isInteger(id) || id < 1 || id > 69) return res.status(404).send([]);
    return res.status(200).header('Cache-Control', 'public, max-age=2592000, immutable').send(core.landingCommunes(id));
  }

  /** A page's picture in WebP: /lp/img/<id>/<160|480|960>.webp (never changes: cached a year). */
  @Public()
  @Get('lp/img/:id/:file')
  async landingImage(@Param('id') idp: string, @Param('file') file: string, @Res() res: any) {
    const m = file.match(/^(160|480|960)\.webp$/);
    if (!/^\d+$/.test(idp) || !m) return res.status(404).send();
    try {
      const r: any = await this.core.call('landing.image', await this.core.systemSession(), { id: Number(idp), size: m[1] });
      const buf = Buffer.from(r.base64, 'base64');
      const type = buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/webp'; // browsers that cannot write WebP gave JPEG
      return res.status(200).header('Content-Type', type).header('Cache-Control', 'public, max-age=31536000, immutable').send(buf);
    } catch {
      return res.status(404).send();
    }
  }

  /**
   * An order from a page. The answer is the same whether the order passed or was blocked as fake (the customer must not
   * be able to tell); only a page that does not exist (404) or a server failure (500, the page asks to try again) differ.
   */
  @Public()
  @Post('lp/:slug/order')
  async landingOrder(@Param('slug') slug: string, @Body() body: any, @Req() req: { ip?: string; headers: Record<string, string | undefined> }) {
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) throw new core.AppError('not_found', 'Page introuvable');
    const start = Date.now();
    // a post from another site, or a flood from one address: the same answer, nothing done
    if (!crossSite(req) && !limitLanding(req.ip || 'unknown', 'order', 30))
      await this.core.call('landing.submit', await this.core.systemSession(), { ...(body && typeof body === 'object' ? body : {}), slug, meta: visitorMeta(req) });
    // the answer never comes faster for a blocked order than for a real one (its timing would tell a fraudster)
    await new Promise((r) => setTimeout(r, Math.max(0, 600 + Math.floor(Math.random() * 300) - (Date.now() - start))));
    return { ok: true };
  }

  /** What a customer typed so far (a valid phone): their abandoned order if they leave. Same answer whatever happens. */
  @Public()
  @Post('lp/:slug/lead')
  async landingLead(@Param('slug') slug: string, @Body() body: any, @Req() req: { ip?: string; headers: Record<string, string | undefined> }) {
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) return { ok: true };
    // sendBeacon posts text/plain: the body may arrive as a string
    let b = body;
    if (typeof b === 'string') {
      try {
        b = JSON.parse(b);
      } catch {
        b = {};
      }
    }
    if (crossSite(req) || limitLanding(req.ip || 'unknown', 'lead', 120)) return { ok: true };
    await this.core.call('landing.capture', await this.core.systemSession(), { ...(b && typeof b === 'object' ? b : {}), slug, meta: visitorMeta(req) }).catch(() => null);
    return { ok: true };
  }

  /**
   * A courier says a parcel's status changed (ZR webhook, registered from Pilotix with its key in ?key= and the
   * X-Pilotix-Key header). The parcel numbers are picked from the body, whatever its shape; their state is then read
   * again from the courier itself, so the body is only a hint.
   */
  @Public()
  @Post('hooks/courier/:companyId')
  async courierHook(@Param('companyId') companyId: string, @Query('key') qkey: string, @Headers('x-pilotix-key') hkey: string, @Body() body: unknown) {
    if (!/^\d+$/.test(companyId)) throw new core.AppError('not_found', 'Société inconnue');
    const trackings = new Set<string>();
    const extIds = new Set<string>();
    const walk = (v: unknown, depth: number) => {
      if (depth > 5 || v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) return v.slice(0, 200).forEach((x) => walk(x, depth + 1));
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (typeof x === 'string' && x.length <= 80) {
          if (/tracking/i.test(k)) trackings.add(x);
          else if (/^(parcel_?id|parcelId|id)$/i.test(k)) extIds.add(x);
        } else walk(x, depth + 1);
      }
    };
    walk(body, 0);
    const session = await this.core.systemSession();
    return this.core.call('delivery.hook', session, { companyId: Number(companyId), key: String(qkey || hkey || ''), trackings: [...trackings].slice(0, 200), extIds: [...extIds].slice(0, 200) });
  }

  // ---------------------------------------------------------------- Dellal (AI sales agent) webhooks
  /** Meta checks the webhook once: answer hub.challenge when the verify token matches. */
  @Public()
  @Get('hooks/meta')
  async metaVerify(@Query() q: Record<string, string>, @Res() res: any) {
    const r: any = await this.core.call('dellal.routing', await this.core.systemSession(), {});
    if (q['hub.mode'] === 'subscribe' && sameKey(q['hub.verify_token'], r.verifyToken)) return res.status(200).header('Content-Type', 'text/plain').send(String(q['hub.challenge'] ?? ''));
    return res.status(403).send({ message: 'Jeton de vérification invalide' });
  }

  /** WhatsApp, Messenger and Instagram messages, and comments on posts and ads. Answers 200 at once; Dellal and the CM AI agent reply in the background. */
  @Public()
  @Post('hooks/meta')
  async metaHook(@Req() req: RawBodyRequest<any>, @Headers('x-hub-signature-256') sig: string, @Body() body: any) {
    const db = this.core.db;
    const secret = String((await db.query(`SELECT value FROM settings WHERE key = 'secret_dellal_meta_app_secret'`))[0]?.value ?? '');
    // without the Meta app secret nobody can tell a real Meta call from a fake one (anyone could inject messages
    // "from" a customer, make Dellal answer and spend): nothing is taken until the secret is set. 200 so Meta
    // does not retry in a loop.
    if (!secret) {
      new Logger('Meta').warn('webhook ignored: add the Meta app secret (Message AI agent › Réglages) so Pilotix can check it comes from Meta');
      return { ok: false, received: 0, error: 'Meta app secret manquant' };
    }
    {
      const raw: Buffer | undefined = req.rawBody;
      const want = 'sha256=' + createHmac('sha256', secret).update(raw ?? Buffer.from(JSON.stringify(body ?? {}))).digest('hex');
      const ok = !!sig && sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
      if (!ok) throw new core.AppError('unauthorized', 'Signature Meta invalide');
    }
    const m = optionalDellal();
    const list: any[] = m?.parseMetaWebhook ? m.parseMetaWebhook(body) : [];
    // comments make the page act in public (reply, hide): only from a webhook signed with the Meta app secret
    let comments: any[] = m?.parseMetaComments ? m.parseMetaComments(body) : [];
    if (comments.length && !secret) {
      new Logger('CM').warn('comments ignored: add the Meta app secret (Message AI agent › Réglages) so webhooks are signed');
      comments = [];
    }
    // Delivery AI agent: what became of its WhatsApp messages (delivered, read, failed → SMS). A "failed" sends an SMS:
    // only from a webhook signed with the Meta app secret (without it, the 1-hour fallback still works)
    let statuses: any[] = m?.parseWhatsAppStatuses ? m.parseWhatsAppStatuses(body) : [];
    if (statuses.length && !secret) {
      new Logger('Delivery AI').warn('WhatsApp statuses ignored: add the Meta app secret (Message AI agent › Réglages) so webhooks are signed');
      statuses = [];
    }
    void this.handleIncoming(list);
    void this.handleComments(comments);
    void this.handleStatuses(statuses);
    return { ok: true, received: list.length + comments.length + statuses.length };
  }

  /** Delivery AI agent: the SMS gateway's reports (sent, delivered, failed) and the customers' SMS answers. Key in ?key=. */
  @Public()
  @Post('hooks/sms')
  async smsHook(@Query('key') key: string, @Body() body: any) {
    const session = await this.core.systemSession();
    const r: any = await this.core.call('notify.hookKey', session, {});
    const want = String(r?.hookKey ?? '');
    const got = String(key ?? '');
    if (!want || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw new core.AppError('unauthorized', 'Clé invalide');
    const m = optionalDellal();
    const ev = m?.parseSmsEvent ? m.parseSmsEvent(body) : null;
    if (!ev) return { ok: true, ignored: true };
    return this.core.call('notify.smsEvent', session, ev);
  }

  private async handleStatuses(list: any[]) {
    if (!list.length) return;
    const session = await this.core.systemSession();
    for (const st of list) await this.core.call('notify.waStatus', session, st).catch((e) => new Logger('Delivery AI').warn(`status ${st?.id}: ${e?.message ?? e}`));
  }

  /** TikTok messages (from TikTok's business messaging or a bridge): { user_id, name?, text, message_id? }. Key = Dellal verify token. */
  @Public()
  @Post('hooks/tiktok')
  async tiktokHook(@Query('key') key: string, @Body() body: any) {
    const r: any = await this.core.call('dellal.routing', await this.core.systemSession(), {});
    if (!sameKey(key, r.verifyToken)) throw new core.AppError('unauthorized', 'Clé invalide');
    const text = String(body?.text ?? body?.content?.text ?? '').trim();
    const user = String(body?.user_id ?? body?.sender?.id ?? '').trim();
    if (!text || !user) throw new core.AppError('bad_request', 'user_id et text requis');
    void this.handleIncoming([{ channel: 'tiktok', externalId: user, accountId: null, name: body?.name ? String(body.name) : null, text: text.slice(0, 4000), messageId: body?.message_id ? String(body.message_id) : null, source: null }]);
    return { ok: true };
  }

  /** Stores each message, then lets Dellal answer once the customer stops typing (2 s), one answer at a time per conversation. */
  private async handleIncoming(list: any[]) {
    const log = new Logger('Dellal');
    for (const msg of list) {
      try {
        const session = await this.core.systemSession();
        const r: any = await this.core.call('dellal.receive', session, msg);
        if (!r) continue;
        latest.set(r.conversationId, r.messageId);
        setTimeout(() => {
          if (latest.get(r.conversationId) !== r.messageId) return; // a newer message will be answered instead
          const prev = running.get(r.conversationId) ?? Promise.resolve();
          const next = prev
            .then(() => this.core.call('dellal.answer', session, { id: r.conversationId }))
            .catch((e) => log.warn(`conversation ${r.conversationId}: ${e?.message ?? e}`))
            .finally(() => {
              if (running.get(r.conversationId) === next) running.delete(r.conversationId);
            });
          running.set(r.conversationId, next);
        }, 2000);
      } catch (e: any) {
        log.warn(`incoming ${msg?.channel} message refused: ${e?.message ?? e}`);
      }
    }
  }

  /** Stores each comment, then lets the CM AI agent handle it after the shop's delay (the sweep job catches missed ones). */
  private async handleComments(list: any[]) {
    const log = new Logger('CM');
    for (const c of list) {
      try {
        const session = await this.core.systemSession();
        const r: any = await this.core.call('cm.receive', session, c);
        if (!r?.enabled) continue;
        setTimeout(() => {
          cmQueue = cmQueue
            .then(() => this.core.call('cm.run', session, { id: r.commentId }))
            .catch((e) => log.warn(`comment ${r.commentId}: ${e?.message ?? e}`));
        }, Math.max(0, Number(r.delaySec) || 0) * 1000);
      } catch (e: any) {
        log.warn(`incoming ${c?.channel} comment refused: ${e?.message ?? e}`);
      }
    }
  }

  /** Called by an external scheduler (e.g. every 30 minutes) to refresh courier statuses. */
  @Public()
  @Post('hooks/cron')
  async cron(@Query('key') key: string) {
    const ck = (await core.getSetting(this.core.db, 'cron')).key;
    if (!sameKey(key, ck)) throw new core.AppError('unauthorized', 'Clé cron invalide');
    const session = await this.core.systemSession();
    void this.core.call('cm.sweep', session, {}).catch(() => null); // comments the CM AI agent has not answered yet (in the background)
    void this.core.call('landing.run', session, {}).catch(() => null); // landing pages: abandoned orders, Meta events (in the background)
    void this.core.call('notify.run', session, {}).catch(() => null); // Delivery AI agent: messages due (in the background)
    return this.core.call('delivery.sync', session, {}).catch((e) => ({ ok: false, message: e.message }));
  }
}

@Module({
  imports: [JwtModule.register({ global: true, secret: config.jwtSecret, signOptions: { expiresIn: config.jwtExpires } })],
  controllers: [ApiController],
  providers: [AuthGuard, { provide: APP_FILTER, useClass: ErrorFilter }],
})
export class ApiModule {}
