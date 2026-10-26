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
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { APP_FILTER, Reflector } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as core from '@pilotix/core';
import { DEMO_ACCOUNTS, DEMO_PASSWORD, normalizePhone, Session } from '@pilotix/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { brotliCompressSync, constants as zlibConst, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { config } from './config';
import { CoreService, ShopRef } from './core.service';
import { checkLogin, clearLogin, failedLogin } from './limits';
import { mailConfigured, sendMail } from './mail';
import { PlatformController, PlatformGuard } from './platform';
import { PUBLIC, Public } from './public';
import { limitMail, resetMail } from './resetMail';

// ---------------------------------------------------------------- errors → HTTP
const STATUS: Record<string, number> = { bad_request: 400, unauthorized: 401, payment_required: 402, forbidden: 403, not_found: 404, conflict: 409 };

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

/**
 * A shop's token: the account, its token version, its shop (missing on tokens made before the server hosted several
 * shops: shop #1), and — when Pilotix support opened the shop — the staff member.
 */
export interface ShopClaims {
  sub: number;
  tv?: number;
  shop?: number;
  imp?: number;
}

export interface ShopRequest {
  session: Session;
  shop: ShopRef;
  /** Pilotix support opened the shop (staff id) */
  imp?: number;
  ip?: string;
  headers?: Record<string, unknown>;
}

const CLOSED = 'Cette boutique est fermée. Contactez Pilotix.';

@Injectable()
class AuthGuard implements CanActivate {
  /** Profiles are re-read at most every 30 s, so a deactivated account loses access quickly. */
  private cache = new Map<string, { s: Session; at: number; tv: number }>();
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
    let c: ShopClaims;
    try {
      c = await this.jwt.verifyAsync<ShopClaims>(token);
    } catch {
      throw new UnauthorizedException('Session expirée, reconnectez-vous');
    }
    if (!c.sub || (c as { typ?: string }).typ) throw new UnauthorizedException('Session expirée, reconnectez-vous');
    const id = Number(c.sub);
    const tv = Number(c.tv ?? 0);
    let ref = c.shop ? await this.core.shop({ id: Number(c.shop) }) : await this.core.primary();
    if (!ref || ref.shop.status === 'archived') throw new UnauthorizedException(CLOSED);
    const imp = c.imp ? Number(c.imp) : undefined;
    // Pilotix support sees a shop even when it is unpaid (to help it)
    if (imp) ref = { ...ref, status: { ...ref.status, locked: false }, rules: { ...ref.rules, locked: false } };
    const key = `${ref.shop.id}:${id}:${imp ?? ''}`;
    const hit = this.cache.get(key);
    // a token of another version than the cached one (just logged in again, password just changed): read again
    if (hit && Date.now() - hit.at < 30_000 && tv === hit.tv) {
      Object.assign(req, { session: hit.s, shop: ref, imp });
      if (!imp) this.core.touch(ref);
      return true;
    }
    const p = await core.profileById(ref.db, id);
    if (!p || !p.active) throw new UnauthorizedException('Compte désactivé');
    // a password change raises token_version: tokens made before it stop working
    const cur = await tokenVersion(ref.db, id);
    let support: string | null = null;
    if (imp) {
      // support access ends when the staff member leaves Pilotix
      const st = (await this.core.t.platform.query('SELECT name, active FROM platform.staff WHERE id = $1', [imp]))[0];
      if (!st?.active) throw new UnauthorizedException('Accès support terminé');
      support = st.name;
    }
    const s = await this.core.withShop(core.makeSession(p), ref, support);
    if (this.cache.size > 20_000) this.cache.clear();
    this.cache.set(key, { s, at: Date.now(), tv: cur });
    if (tv !== cur) throw new UnauthorizedException('Mot de passe changé : reconnectez-vous');
    Object.assign(req, { session: s, shop: ref, imp });
    if (!imp) this.core.touch(ref);
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
/**
 * A landing page's text (HTML, communes) compressed when the phone accepts it — Brotli (HTTPS browsers), else gzip:
 * the 23 KB page becomes ~8 KB, small enough to arrive in the first round trip of a new connection (≈ one round trip
 * less on 2G / 3G). A front server (nginx, Cloudflare) passes it on as it is.
 */
function sendText(req: { headers: Record<string, string | undefined> }, res: any, body: string) {
  res.header('Vary', 'Accept-Encoding');
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (body.length < 1024) return res.send(body);
  if (/\bbr\b/.test(accept)) return res.header('Content-Encoding', 'br').send(brotliCompressSync(body, { params: { [zlibConst.BROTLI_PARAM_QUALITY]: 5, [zlibConst.BROTLI_PARAM_SIZE_HINT]: body.length } }));
  if (/\bgzip\b/.test(accept)) return res.header('Content-Encoding', 'gzip').send(gzipSync(body, { level: 6 }));
  return res.send(body);
}

/**
 * How long the answer to a landing order waits at least: twice the slowest recent orders (95th percentile of the last
 * 200), between 250 and 600 ms (600 until 10 orders were seen), then up to 200 ms more at random. A blocked order,
 * quicker to handle, is so never answered faster than a real one — without every customer waiting a fixed 0.6–0.9 s.
 */
const submitTimes: number[] = [];
function noteSubmit(ms: number) {
  submitTimes.push(ms);
  if (submitTimes.length > 200) submitTimes.shift();
}
function orderFloor(): number {
  if (submitTimes.length < 10) return 600;
  const s = [...submitTimes].sort((a, b) => a - b);
  return Math.min(600, Math.max(250, 2 * s[Math.floor((s.length - 1) * 0.95)]));
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

let proxyWarned = false;

/** Dellal: newest message per conversation and the answer running for it (per shop). */
const latest = new Map<string, number>();
const running = new Map<string, Promise<unknown>>();
/** CM AI agent: one answer at a time per shop (comments arrive in bursts under an ad). */
const cmQueues = new Map<number, Promise<unknown>>();
function optionalDellal(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@pilotix/core/dist/dellal-server');
  } catch {
    return null;
  }
}

/** The shop's public API address (links given to customers and to other services). */
const apiOf = (ref: ShopRef) => `${config.publicUrl}/api${ref.shop.primary ? '' : `/s/${ref.shop.slug}`}`;

/**
 * Orders, landing pages and parcel statuses keep coming in while a shop is unpaid (locked): no customer order is lost,
 * the shop sees them once it pays. Everything else of a locked shop stays closed.
 */
const intake = (ref: ShopRef): ShopRef => (ref.status.state === 'expired' ? { ...ref, rules: { ...ref.rules, locked: false } } : ref);

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });
const ForgotBody = z.object({ email: z.string().email().max(200) });
const ResetBody = z.object({ token: z.string().max(220), password: z.string().max(200) });

/** Actions refused when Pilotix support opened the shop: they belong to the shop's own administrator. */
const NOT_FOR_SUPPORT = new Set(['me.password', 'me.delete', 'me.update']);
/** Saving these can change the store's part of shop #1's links (site/<store>/<page>). */
const STORE_NAMING = new Set(['landing.settings.save', 'admin.settings.save']);
/** The demo shop's accounts are shared by every visitor: nobody changes them (a visitor would lock the others out). */
const NOT_IN_DEMO = new Set(['me.password', 'me.delete', 'me.update', 'users.create', 'users.update', 'admin.users.resetPassword']);

@Controller()
@UseGuards(AuthGuard)
class ApiController {
  constructor(
    private readonly core: CoreService,
    private readonly jwt: JwtService,
  ) {}

  /** A shop token: the account, its token version, its shop (and the staff member when support opened it). */
  private async signShop(ref: ShopRef, id: number, imp?: number) {
    return this.jwt.signAsync({ sub: id, tv: await tokenVersion(ref.db, id), shop: ref.shop.id, ...(imp ? { imp } : {}) });
  }

  /** The shop of a public link (/api/s/<slug>/…; none = shop #1). A suspended or closed shop answers as unknown. */
  private async publicShop(slug: string | undefined): Promise<ShopRef> {
    const ref = await this.core.fromParam(slug);
    if (!ref || ref.shop.status !== 'active') throw new core.AppError('not_found', 'Boutique introuvable');
    return ref;
  }

  @Public()
  @Get('health')
  async health() {
    await this.core.t.platform.query('SELECT 1');
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
    // the shop of this e-mail (an unknown e-mail is checked against shop #1: same answer, same time)
    const sid = await core.shopIdOfEmail(this.core.t, b.data.email);
    const ref = (sid ? await this.core.shop({ id: sid }) : null) ?? (await this.core.primary());
    let session: Session;
    try {
      session = await core.login(ref.db, b.data.email, b.data.password);
    } catch (e) {
      failedLogin(ipKey);
      failedLogin(mailKey);
      throw e;
    }
    clearLogin(mailKey);
    if (ref.shop.status === 'archived') throw new core.AppError('unauthorized', CLOSED);
    return { token: await this.signShop(ref, session.profile.id), session: await this.core.withShop(session, ref) };
  }

  /** The demo shop's button on the login page: shown when Pilotix turned it on. */
  @Public()
  @Get('auth/demo')
  async demoInfo() {
    const ref = (await this.core.settings()).demo.public ? await this.demoShop() : null;
    return { available: !!ref, accounts: ref ? DEMO_ACCOUNTS.map((a) => ({ key: a.key, name: a.name, role: a.roles[0] })) : [] };
  }

  /** Opens the demo shop as one of its accounts (fake data; nothing leaves the server). */
  @Public()
  @Post('auth/demo')
  async demoLogin(@Body() body: any, @Req() req: { ip?: string }) {
    const ipKey = `demo:${core.ipNet(req.ip || '') || 'unknown'}`;
    checkLogin(ipKey, 30);
    failedLogin(ipKey);
    const acc = DEMO_ACCOUNTS.find((a) => a.key === String(body?.key ?? ''));
    if (!acc) throw new core.AppError('bad_request', 'Compte démo inconnu');
    const ref = (await this.core.settings()).demo.public ? await this.demoShop() : null;
    if (!ref) throw new core.AppError('not_found', 'Démo indisponible');
    const session = await core.login(ref.db, acc.email, DEMO_PASSWORD);
    return { token: await this.signShop(ref, session.profile.id), session: await this.core.withShop(session, ref) };
  }

  private async demoShop(): Promise<ShopRef | null> {
    const s = (await core.loadShops(this.core.t)).find((x) => x.demo && !x.primary && x.status === 'active');
    return s ? this.core.shop({ id: s.id }) : null;
  }

  /** Can this server send "mot de passe oublié" e-mails? (the login page shows the link only then) */
  @Public()
  @Get('auth/forgot')
  forgotAvailable() {
    return { available: mailConfigured() };
  }

  /**
   * "Mot de passe oublié": e-mails a one-time link. Same answer whether the account exists or not, and the e-mail
   * leaves after the answer (no timing difference). 5 requests per 15 minutes per address.
   */
  @Public()
  @Post('auth/forgot')
  async forgot(@Body() body: unknown, @Req() req: { ip?: string }) {
    const ipKey = `forgot:${core.ipNet(req.ip || '') || 'unknown'}`;
    checkLogin(ipKey, 5);
    failedLogin(ipKey);
    if (!mailConfigured()) throw new HttpException({ message: 'L’envoi d’e-mails n’est pas configuré sur ce serveur. Demandez à votre administrateur.' }, 503);
    const b = ForgotBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Email invalide');
    const sid = await core.shopIdOfEmail(this.core.t, b.data.email);
    const ref = (sid ? await this.core.shop({ id: sid }) : null) ?? (await this.core.primary());
    if (ref.shop.demo || ref.shop.status === 'archived') return { ok: true };
    const r = await core.createPasswordReset(ref.db, b.data.email);
    // the link carries its shop (shop #1: as before, so links already sent keep working)
    if (r)
      sendMail(r.kind === 'link' ? resetMail({ ...r, token: ref.shop.primary ? r.token : `${ref.shop.id}.${r.token}` }) : limitMail(r)).catch((e) =>
        new Logger('Mail').error(`Reset e-mail to ${r.email} failed: ${e?.message || e}`),
      );
    return { ok: true };
  }

  /** Sets the new password with the link's secret. 10 wrong links per 15 minutes per address. */
  @Public()
  @Post('auth/reset')
  async reset(@Body() body: unknown, @Req() req: { ip?: string }) {
    const ipKey = `reset:${core.ipNet(req.ip || '') || 'unknown'}`;
    checkLogin(ipKey, 10);
    const b = ResetBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Lien invalide');
    const m = b.data.token.match(/^(\d{1,9})\.(.+)$/);
    try {
      const ref = m ? await this.core.shop({ id: Number(m[1]) }) : await this.core.primary();
      if (!ref || ref.shop.demo || ref.shop.status === 'archived') throw new core.AppError('bad_request', 'Ce lien n’est plus valable. Demandez un nouveau lien.');
      await core.resetPassword(ref.db, m ? m[2] : b.data.token, b.data.password);
    } catch (e) {
      failedLogin(ipKey);
      throw e;
    }
    return { ok: true };
  }

  @Post('rpc/:name')
  async rpc(@Param('name') name: string, @Body() body: unknown, @Req() req: ShopRequest) {
    // names like orders.list, and grouped ones like dellal.settings.get or cm.settings.save
    if (!/^[a-z]+(\.[a-zA-Z]+){1,3}$/.test(name)) throw new core.AppError('not_found', 'Action inconnue');
    if (req.imp && NOT_FOR_SUPPORT.has(name)) throw new core.AppError('forbidden', 'Réservé à l’administrateur de la boutique (pas en mode support)');
    if (req.shop.shop.demo && NOT_IN_DEMO.has(name)) throw new core.AppError('forbidden', 'Pas dans la boutique démo : ses comptes sont partagés par tous les visiteurs');
    const out: any = await this.core.call(req.shop, name, req.session, body ?? {});
    // shop #1's name in its links (« Lien des pages », else made from the shop's name) is its name on the platform too
    if (req.shop.shop.primary && STORE_NAMING.has(name)) {
      await core.syncPrimaryStore(this.core.t);
      this.core.invalidate();
    }
    // the app learns its shop (plan, state, how to pay) with the session
    if (name === 'me.get') return this.core.withShop(out as Session, req.shop, req.session.shop?.support ?? null);
    // a new password logs out the other sessions: this one gets a fresh token and stays in
    if (name === 'me.password') return { ...out, token: await this.signShop(req.shop, req.session.profile.id) };
    return out;
  }

  /**
   * Orders from a website or a store. Body: { name|customer_name, phone, phone2?, wilaya (code), commune?, address?, stopdesk?,
   *   items: [{ sku, qty, price? }], note?, source?, utm? }. Key: ?key= or header x-webhook-key.
   */
  @Public()
  @Post(['hooks/orders/:channel', 's/:shop/hooks/orders/:channel'])
  async orderHook(@Param('shop') shop: string | undefined, @Param('channel') channel: string, @Query('key') qkey: string, @Headers('x-webhook-key') hkey: string, @Body() body: any) {
    const ref = intake(await this.publicShop(shop));
    const key = qkey || hkey || '';
    const db = ref.db;
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
        const made = await this.createFromHook(ref, ch, channel, body);
        await db.query('UPDATE orders SET ext_order_id = $2 WHERE id = $1', [made.id, ext]);
        return made;
      });
    }
    return this.createFromHook(ref, ch, channel, body);
  }

  private async createFromHook(ref: ShopRef, ch: any, channel: string, body: any) {
    const db = ref.db;
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
    const session = await this.core.systemSession(ref);
    const order: any = await this.core.call(ref, 'orders.create', session, {
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
  private async sendLanding(ref: ShopRef, slug: string, req: { headers: Record<string, string | undefined> }, res: any) {
    const missing = () => res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Page introuvable');
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) return missing();
    try {
      const base = `${apiOf(ref)}/lp/`;
      const r: any = await this.core.call(ref, 'landing.html', await this.core.systemSession(ref), { slug, mode: 'live', post: `${base}${slug}/order`, lead: `${base}${slug}/lead`, geo: `${base}geo/`, imgBase: `${base}img/`, site: config.publicUrl });
      res.status(200).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store');
      // the main photo asked for as soon as these headers arrive, before the page itself
      if (r.link) res.header('Link', r.link);
      return sendText(req, res, r.html);
    } catch (e: any) {
      // no such page, or landing pages not in the shop's plan
      if (e instanceof core.AppError && (e.code === 'not_found' || e.code === 'forbidden')) return missing();
      throw e;
    }
  }

  /**
   * The address given to customers: site/<store>/<page> (Caddy sends it here). The store is a shop's name on the
   * platform (unique); a name no shop has (shop #1's former name): shop #1's address for that page.
   */
  @Public()
  @Get('s/:store/:slug')
  async storePage(@Param('store') store: string, @Param('slug') slug: string, @Req() req: { url?: string; headers: Record<string, string | undefined> }, @Res() res: any) {
    const ref = await this.core.fromParam(store).catch(() => null);
    if (ref) {
      // a suspended or closed shop: its pages are gone
      if (ref.shop.status !== 'active') return res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Page introuvable');
      return this.sendLanding(intake(ref), slug, req, res);
    }
    const p = await this.core.primary();
    const r: any = await this.core.call(p, 'landing.store', await this.core.systemSession(p), {});
    if (store !== r.store && /^[a-z0-9-]{2,60}$/.test(slug)) {
      const q = String(req.url ?? '').indexOf('?');
      return res.status(301).header('Location', `${config.publicUrl}/${r.store}/${slug}${q >= 0 ? String(req.url).slice(q) : ''}`).send();
    }
    return this.sendLanding(p, slug, req, res);
  }

  /** The first addresses of the pages (links already in ads keep working; the page names site/<store>/<page> as its own). */
  @Public()
  @Get(['lp/:slug', 's/:shop/lp/:slug'])
  async landingPage(@Param('shop') shop: string | undefined, @Param('slug') slug: string, @Req() req: { headers: Record<string, string | undefined> }, @Res() res: any) {
    const ref = await this.publicShop(shop).catch(() => null);
    if (!ref) return res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Page introuvable');
    return this.sendLanding(intake(ref), slug, req, res);
  }

  /** /llms.txt (Caddy sends it here): shop #1 and its live landing pages, for AI assistants (cached an hour). */
  @Public()
  @Get('llms.txt')
  async llmsTxt(@Req() req: { headers: Record<string, string | undefined> }, @Res() res: any) {
    const p = await this.core.primary();
    const r: any = await this.core.call(p, 'landing.llms', await this.core.systemSession(p), { site: config.publicUrl });
    return sendText(req, res.status(200).header('Content-Type', 'text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=3600'), r.text);
  }

  /** Communes of a wilaya, [French name, Arabic name] (asked when the customer picks a wilaya; cached a month). */
  @Public()
  @Get(['lp/geo/:wilaya', 's/:shop/lp/geo/:wilaya'])
  landingGeo(@Param('wilaya') w: string, @Req() req: { headers: Record<string, string | undefined> }, @Res() res: any) {
    const id = Number(w);
    if (!Number.isInteger(id) || id < 1 || id > 69) return res.status(404).send([]);
    return sendText(req, res.status(200).header('Content-Type', 'application/json; charset=utf-8').header('Cache-Control', 'public, max-age=2592000, immutable'), JSON.stringify(core.landingCommunes(id)));
  }

  /** A page's picture in WebP: /lp/img/<id>/<160|480|720|960>.webp (never changes: cached a year). */
  @Public()
  @Get(['lp/img/:id/:file', 's/:shop/lp/img/:id/:file'])
  async landingImage(@Param('shop') shop: string | undefined, @Param('id') idp: string, @Param('file') file: string, @Res() res: any) {
    const m = file.match(/^(160|480|720|960)\.webp$/);
    if (!/^\d+$/.test(idp) || !m) return res.status(404).send();
    try {
      const ref = intake(await this.publicShop(shop));
      const r: any = await this.core.call(ref, 'landing.image', await this.core.systemSession(ref), { id: Number(idp), size: m[1] });
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
  @Post(['lp/:slug/order', 's/:shop/lp/:slug/order'])
  async landingOrder(@Param('shop') shop: string | undefined, @Param('slug') slug: string, @Body() body: any, @Req() req: { ip?: string; headers: Record<string, string | undefined> }) {
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) throw new core.AppError('not_found', 'Page introuvable');
    const ref = intake(await this.publicShop(shop));
    const start = Date.now();
    // a post from another site, or a flood from one address: the same answer, nothing done
    if (!crossSite(req) && !limitLanding(req.ip || 'unknown', 'order', 30)) {
      await this.core.call(ref, 'landing.submit', await this.core.systemSession(ref), { ...(body && typeof body === 'object' ? body : {}), slug, meta: visitorMeta(req) });
      noteSubmit(Date.now() - start);
    }
    // the answer never comes faster for a blocked order than for a real one (its timing would tell a fraudster)
    await new Promise((r) => setTimeout(r, Math.max(0, orderFloor() + Math.floor(Math.random() * 200) - (Date.now() - start))));
    return { ok: true };
  }

  /** What a customer typed so far (a valid phone): their abandoned order if they leave. Same answer whatever happens. */
  @Public()
  @Post(['lp/:slug/lead', 's/:shop/lp/:slug/lead'])
  async landingLead(@Param('shop') shop: string | undefined, @Param('slug') slug: string, @Body() body: any, @Req() req: { ip?: string; headers: Record<string, string | undefined> }) {
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
    const ref = await this.core.fromParam(shop).catch(() => null);
    if (!ref || ref.shop.status !== 'active') return { ok: true };
    const r = intake(ref);
    await this.core.call(r, 'landing.capture', await this.core.systemSession(r), { ...(b && typeof b === 'object' ? b : {}), slug, meta: visitorMeta(req) }).catch(() => null);
    return { ok: true };
  }

  /**
   * A courier says a parcel's status changed (ZR webhook, registered from Pilotix with its key in ?key= and the
   * X-Pilotix-Key header). The parcel numbers are picked from the body, whatever its shape; their state is then read
   * again from the courier itself, so the body is only a hint.
   */
  @Public()
  @Post(['hooks/courier/:companyId', 's/:shop/hooks/courier/:companyId'])
  async courierHook(@Param('shop') shop: string | undefined, @Param('companyId') companyId: string, @Query('key') qkey: string, @Headers('x-pilotix-key') hkey: string, @Body() body: unknown) {
    if (!/^\d+$/.test(companyId)) throw new core.AppError('not_found', 'Société inconnue');
    const ref = intake(await this.publicShop(shop));
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
    const session = await this.core.systemSession(ref);
    return this.core.call(ref, 'delivery.hook', session, { companyId: Number(companyId), key: String(qkey || hkey || ''), trackings: [...trackings].slice(0, 200), extIds: [...extIds].slice(0, 200) });
  }

  // ---------------------------------------------------------------- Dellal (AI sales agent) webhooks
  /** Meta checks the webhook once: answer hub.challenge when the verify token matches. */
  @Public()
  @Get(['hooks/meta', 's/:shop/hooks/meta'])
  async metaVerify(@Param('shop') shop: string | undefined, @Query() q: Record<string, string>, @Res() res: any) {
    const ref = await this.publicShop(shop);
    const r: any = await this.core.call(ref, 'dellal.routing', await this.core.systemSession(ref), {});
    if (q['hub.mode'] === 'subscribe' && sameKey(q['hub.verify_token'], r.verifyToken)) return res.status(200).header('Content-Type', 'text/plain').send(String(q['hub.challenge'] ?? ''));
    return res.status(403).send({ message: 'Jeton de vérification invalide' });
  }

  /** WhatsApp, Messenger and Instagram messages, and comments on posts and ads. Answers 200 at once; Dellal and the CM AI agent reply in the background. */
  @Public()
  @Post(['hooks/meta', 's/:shop/hooks/meta'])
  async metaHook(@Param('shop') shop: string | undefined, @Req() req: RawBodyRequest<any>, @Headers('x-hub-signature-256') sig: string, @Body() body: any) {
    const ref = await this.publicShop(shop);
    const db = ref.db;
    const secret = String((await db.query(`SELECT value FROM settings WHERE key = 'secret_dellal_meta_app_secret'`))[0]?.value ?? '');
    // without the Meta app secret nobody can tell a real Meta call from a fake one (anyone could inject messages
    // "from" a customer, make Dellal answer and spend): nothing is taken until the secret is set. 200 so Meta
    // does not retry in a loop.
    if (!secret) {
      new Logger('Meta').warn(`[${ref.shop.slug}] webhook ignored: add the Meta app secret (Message AI agent › Réglages) so Pilotix can check it comes from Meta`);
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
    const comments: any[] = m?.parseMetaComments ? m.parseMetaComments(body) : [];
    // Delivery AI agent: what became of its WhatsApp messages (delivered, read, failed → SMS)
    const statuses: any[] = m?.parseWhatsAppStatuses ? m.parseWhatsAppStatuses(body) : [];
    void this.handleIncoming(ref, list);
    void this.handleComments(ref, comments);
    void this.handleStatuses(ref, statuses);
    return { ok: true, received: list.length + comments.length + statuses.length };
  }

  /** Delivery AI agent: the SMS gateway's reports (sent, delivered, failed) and the customers' SMS answers. Key in ?key=. */
  @Public()
  @Post(['hooks/sms', 's/:shop/hooks/sms'])
  async smsHook(@Param('shop') shop: string | undefined, @Query('key') key: string, @Body() body: any) {
    const ref = await this.publicShop(shop);
    const session = await this.core.systemSession(ref);
    const r: any = await this.core.call(ref, 'notify.hookKey', session, {});
    const want = String(r?.hookKey ?? '');
    const got = String(key ?? '');
    if (!want || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw new core.AppError('unauthorized', 'Clé invalide');
    const m = optionalDellal();
    const ev = m?.parseSmsEvent ? m.parseSmsEvent(body) : null;
    if (!ev) return { ok: true, ignored: true };
    return this.core.call(ref, 'notify.smsEvent', session, ev);
  }

  private async handleStatuses(ref: ShopRef, list: any[]) {
    if (!list.length) return;
    const session = await this.core.systemSession(ref);
    for (const st of list) await this.core.call(ref, 'notify.waStatus', session, st).catch((e) => new Logger('Delivery AI').warn(`[${ref.shop.slug}] status ${st?.id}: ${e?.message ?? e}`));
  }

  /** TikTok messages (from TikTok's business messaging or a bridge): { user_id, name?, text, message_id? }. Key = Dellal verify token. */
  @Public()
  @Post(['hooks/tiktok', 's/:shop/hooks/tiktok'])
  async tiktokHook(@Param('shop') shop: string | undefined, @Query('key') key: string, @Body() body: any) {
    const ref = await this.publicShop(shop);
    const r: any = await this.core.call(ref, 'dellal.routing', await this.core.systemSession(ref), {});
    if (!sameKey(key, r.verifyToken)) throw new core.AppError('unauthorized', 'Clé invalide');
    const text = String(body?.text ?? body?.content?.text ?? '').trim();
    const user = String(body?.user_id ?? body?.sender?.id ?? '').trim();
    if (!text || !user) throw new core.AppError('bad_request', 'user_id et text requis');
    void this.handleIncoming(ref, [{ channel: 'tiktok', externalId: user, accountId: null, name: body?.name ? String(body.name) : null, text: text.slice(0, 4000), messageId: body?.message_id ? String(body.message_id) : null, source: null }]);
    return { ok: true };
  }

  /** Stores each message, then lets Dellal answer once the customer stops typing (2 s), one answer at a time per conversation. */
  private async handleIncoming(ref: ShopRef, list: any[]) {
    const log = new Logger('Dellal');
    for (const msg of list) {
      try {
        const session = await this.core.systemSession(ref);
        const r: any = await this.core.call(ref, 'dellal.receive', session, msg);
        if (!r) continue;
        const conv = `${ref.shop.id}:${r.conversationId}`;
        latest.set(conv, r.messageId);
        setTimeout(() => {
          if (latest.get(conv) !== r.messageId) return; // a newer message will be answered instead
          const prev = running.get(conv) ?? Promise.resolve();
          const next = prev
            .then(() => this.core.call(ref, 'dellal.answer', session, { id: r.conversationId }))
            .catch((e) => log.warn(`[${ref.shop.slug}] conversation ${r.conversationId}: ${e?.message ?? e}`))
            .finally(() => {
              if (running.get(conv) === next) running.delete(conv);
              if (latest.get(conv) === r.messageId) latest.delete(conv);
            });
          running.set(conv, next);
        }, 2000);
      } catch (e: any) {
        log.warn(`[${ref.shop.slug}] incoming ${msg?.channel} message refused: ${e?.message ?? e}`);
      }
    }
  }

  /** Stores each comment, then lets the CM AI agent handle it after the shop's delay (the sweep job catches missed ones). */
  private async handleComments(ref: ShopRef, list: any[]) {
    const log = new Logger('CM');
    for (const c of list) {
      try {
        const session = await this.core.systemSession(ref);
        const r: any = await this.core.call(ref, 'cm.receive', session, c);
        if (!r?.enabled) continue;
        setTimeout(() => {
          const prev = cmQueues.get(ref.shop.id) ?? Promise.resolve();
          const next = prev.then(() => this.core.call(ref, 'cm.run', session, { id: r.commentId })).catch((e) => log.warn(`[${ref.shop.slug}] comment ${r.commentId}: ${e?.message ?? e}`));
          cmQueues.set(ref.shop.id, next);
          void next.finally(() => cmQueues.get(ref.shop.id) === next && cmQueues.delete(ref.shop.id));
        }, Math.max(0, Number(r.delaySec) || 0) * 1000);
      } catch (e: any) {
        log.warn(`[${ref.shop.slug}] incoming ${c?.channel} comment refused: ${e?.message ?? e}`);
      }
    }
  }

  /** Called by an external scheduler (e.g. every 30 minutes) to refresh courier statuses. */
  @Public()
  @Post(['hooks/cron', 's/:shop/hooks/cron'])
  async cron(@Param('shop') shop: string | undefined, @Query('key') key: string) {
    const ref = await this.publicShop(shop);
    const ck = (await core.getSetting(ref.db, 'cron')).key;
    if (!sameKey(key, ck)) throw new core.AppError('unauthorized', 'Clé cron invalide');
    if (ref.status.locked) return { ok: false, message: 'Abonnement inactif' };
    const session = await this.core.systemSession(ref);
    const bg = (name: string) => void this.core.call(ref, name, session, {}).catch(() => null);
    bg('cm.sweep'); // comments the CM AI agent has not answered yet (in the background)
    bg('landing.run'); // landing pages: abandoned orders, Meta events (in the background)
    bg('notify.run'); // Delivery AI agent: messages due (in the background)
    bg('spy.scan'); // AI Spy: the daily scan of competitors' ads, once a day (in the background)
    bg('channels.sheet.syncAll'); // Google Sheets channels: new lines become orders (in the background)
    return this.core.call(ref, 'delivery.sync', session, {}).catch((e) => ({ ok: false, message: e.message }));
  }
}

@Module({
  imports: [JwtModule.register({ global: true, secret: config.jwtSecret, signOptions: { expiresIn: config.jwtExpires } })],
  controllers: [ApiController, PlatformController],
  providers: [AuthGuard, PlatformGuard, { provide: APP_FILTER, useClass: ErrorFilter }],
})
export class ApiModule {}
