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
import { promises as dns } from 'node:dns';
import { signupConfirmMail, signupExistsMail, verifyMail } from './mails';
import type { Mail } from './mail';
import { syncTurnstile } from './turnstile';

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
 * A shop's token: the person's account in that shop, its token version, its shop (missing on tokens made before the
 * server hosted several shops: shop #1).
 */
export interface ShopClaims {
  sub: number;
  tv?: number;
  shop?: number;
}

export interface ShopRequest {
  session: Session;
  shop: ShopRef;
  ip?: string;
  headers?: Record<string, unknown>;
}

const CLOSED = 'Cette boutique est fermée. Contactez Pilotix.';
/** The store picker's ticket (after the password, before a store is chosen) is signed with its own key. */
const pickSecret = () => `${config.jwtSecret}:pick`;

@Injectable()
class AuthGuard implements CanActivate {
  /** Profiles are re-read at most every 30 s, so a deactivated account loses access quickly. */
  private cache = new Map<string, { s: Session; at: number; tv: number; ep: number }>();
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
    let c: ShopClaims & { typ?: string; imp?: number };
    try {
      c = await this.jwt.verifyAsync<ShopClaims>(token);
    } catch {
      throw new UnauthorizedException('Session expirée, reconnectez-vous');
    }
    // a staff token, a picker ticket, or a support token of the past (Pilotix no longer opens stores): not a shop's
    if (!c.sub || c.typ || c.imp) throw new UnauthorizedException('Session expirée, reconnectez-vous');
    const id = Number(c.sub);
    const tv = Number(c.tv ?? 0);
    const ref = c.shop ? await this.core.shop({ id: Number(c.shop) }) : await this.core.primary();
    if (!ref || ref.shop.status === 'archived' || ref.shop.status === 'deleted') throw new UnauthorizedException(CLOSED);
    const key = `${ref.shop.id}:${id}`;
    const hit = this.cache.get(key);
    // a token of another version than the cached one (just logged in again, password just changed): read again
    if (hit && Date.now() - hit.at < 30_000 && tv === hit.tv && hit.ep === this.core.authEpoch) {
      Object.assign(req, { session: hit.s, shop: ref });
      this.core.touch(ref);
      return true;
    }
    const p = await core.profileById(ref.db, id);
    if (!p || !p.active) throw new UnauthorizedException('Compte désactivé');
    // an agency's account inside a store is used only from the agency's space (see core agencywork.ts)
    if (p.agencyId) throw new UnauthorizedException('Ouvrez l’espace de votre agence');
    // a password change raises token_version: tokens made before it stop working
    const cur = await tokenVersion(ref.db, id);
    const s = await this.core.withShop(core.makeSession(p), ref, false);
    if (this.cache.size > 20_000) this.cache.clear();
    this.cache.set(key, { s, at: Date.now(), tv: cur, ep: this.core.authEpoch });
    if (tv !== cur) throw new UnauthorizedException('Mot de passe changé : reconnectez-vous');
    Object.assign(req, { session: s, shop: ref });
    this.core.touch(ref);
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

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** The home of a shop's own domain: its name and its landing pages (from its llms.txt list). */
function storeIndexHtml(llms: string): string {
  const name = (llms.match(/^# (.+)$/m)?.[1] ?? 'Boutique').trim();
  const items = [...llms.matchAll(/^- \[(.+?)\]\((https?:\/\/[^)\s]+)\): ([^—\n]+)/gm)]
    .map((m) => `<li><a href="${escHtml(m[2])}"><b>${escHtml(m[1].replace(/\\([[\]\\])/g, '$1'))}</b><span>${escHtml(m[3].trim())}</span></a></li>`)
    .join('');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(name)}</title><meta name="description" content="${escHtml(name)} — التوصيل لجميع الولايات والدفع عند الاستلام"><style>body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif;background:#f6f7f9;color:#14213d}main{max-width:720px;margin:0 auto;padding:20px 16px}h1{font-size:24px;margin:8px 0 4px}p{color:#5b6577;margin:0 0 18px}ul{list-style:none;padding:0;margin:0;display:grid;gap:10px}a{display:flex;justify-content:space-between;gap:12px;padding:14px 16px;background:#fff;border:1px solid #e3e8f0;border-radius:12px;color:inherit;text-decoration:none}a span{color:#0f766e;font-weight:700;white-space:nowrap}</style></head><body><main><h1>${escHtml(name)}</h1><p>🚚 التوصيل لجميع الولايات · الدفع عند الاستلام</p><ul>${items || '<li>—</li>'}</ul></main></body></html>`;
}

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

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200), shop: z.number().int().positive().optional() });
const PickBody = z.object({ ticket: z.string().max(4000), shop: z.number().int().positive() });
const ForgotBody = z.object({ email: z.string().email().max(200) });
const ResetBody = z.object({ token: z.string().max(220), password: z.string().max(200) });
const TokenBody = z.object({ token: z.string().max(220) });

/** Saving these can change the store's part of shop #1's links (site/<store>/<page>). */
const STORE_NAMING = new Set(['landing.settings.save', 'admin.settings.save']);
/** The demo shop's accounts are shared by every visitor: nobody changes them (a visitor would lock the others out). */
const NOT_IN_DEMO = new Set(['me.password', 'me.delete', 'me.update', 'users.create', 'users.update', 'admin.users.resetPassword', 'archive.set', 'archive.delete']);
/** Actions on the team that the owner's protection and the password rules look at. */
const TEAM_ACTIONS = new Set(['users.update', 'admin.users.resetPassword', 'me.delete']);
/**
 * Actions after which the sessions the guard keeps (30 s) are read again at once (CoreService.authEpoch): a password
 * changes, an account is switched off, an agency's agents open or close — the old sessions stop now, not half a minute
 * later. Rare: every cached session is read once more.
 */
const AUTH_CHANGES = new Set([
  'me.password',
  'me.delete',
  'users.update',
  'admin.users.resetPassword',
  // a confirmation agency's agents: opened, closed or given other tasks in the stores it works for
  'agency.answer',
  'agency.setAgents',
  'agency.end',
  'partners.answer',
  'partners.setWork',
  'partners.end',
]);

const ipOf = (req: { ip?: string }) => core.ipNet(req.ip || '') || 'unknown';
/** The X-Seller header of an agency's space: a store's id, or « all » (anything else: none). */
const sellerOf = (v: unknown): number | 'all' | undefined => {
  const s = String(Array.isArray(v) ? v[0] : (v ?? '')).trim();
  if (s === 'all') return 'all';
  return /^[1-9]\d{0,9}$/.test(s) ? Number(s) : undefined;
};
const sendLater = (m: Mail | null, what: string) => {
  if (m) sendMail(m).catch((e) => new Logger('Mail').error(`${what} e-mail to ${m.to} failed: ${e?.message || e}`));
};

@Controller()
@UseGuards(AuthGuard)
class ApiController {
  constructor(
    private readonly core: CoreService,
    private readonly jwt: JwtService,
  ) {}

  /** A shop token: the person's account in that shop, its token version, its shop. */
  private async signShop(ref: ShopRef, id: number) {
    return this.jwt.signAsync({ sub: id, tv: await tokenVersion(ref.db, id), shop: ref.shop.id });
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

  // ---------------------------------------------------------------- login: one account, its stores
  /** A token and a session for one of the person's stores (the person must have an active account in it). */
  private async enter(shopId: number, email: string) {
    const ref = await this.core.shop({ id: shopId });
    if (!ref || ref.shop.status === 'archived' || ref.shop.status === 'deleted') throw new core.AppError('unauthorized', CLOSED);
    const m = (await core.membershipsOf(this.core.t, email)).find((x) => x.shopId === shopId);
    if (!m) throw new core.AppError('forbidden', 'Vous n’avez pas de compte dans cette boutique');
    // a confirmation agency's person works on this store's orders from the agency's space, never inside the store
    if (m.agencyId) throw new core.AppError('forbidden', 'Ouvrez l’espace de votre agence : vous y travaillez sur les commandes de ce vendeur');
    const p = await core.profileById(ref.db, m.profileId);
    if (!p?.active) throw new core.AppError('unauthorized', 'Votre compte est désactivé');
    await ref.db.query("UPDATE profiles SET last_seen_at = now(), presence = 'online' WHERE id = $1", [p.id]);
    return { token: await this.signShop(ref, p.id), session: await this.core.withShop(core.makeSession(p), ref) };
  }

  /** The store picker's ticket (15 minutes): the password is not sent again to choose a store. */
  private pickTicket(acc: core.Account) {
    return this.jwt.signAsync({ acc: acc.id, atv: acc.tokenVersion, typ: 'pick' }, { secret: pickSecret(), expiresIn: '15m' });
  }
  private async ticketAccount(ticket: string): Promise<core.Account> {
    let c: { acc?: number; atv?: number; typ?: string };
    try {
      c = await this.jwt.verifyAsync(ticket, { secret: pickSecret() });
    } catch {
      throw new core.AppError('unauthorized', 'Session expirée, reconnectez-vous');
    }
    const acc = c.typ === 'pick' && c.acc ? await core.accountById(this.core.t, Number(c.acc)) : null;
    if (!acc || acc.tokenVersion !== Number(c.atv)) throw new core.AppError('unauthorized', 'Session expirée, reconnectez-vous');
    return acc;
  }
  /** What the picker shows: the person's stores, and whether they can add one. */
  private async picker(acc: core.Account) {
    const set = await this.core.settings();
    const stores = await core.storeChoices(this.core.t, acc.email);
    const canAddStore = set.signup.open && (await core.ownedStores(this.core.t, acc.id)) < core.storeLimit(acc, set);
    const canAddAgency = set.signup.open && (await core.ownedAgencies(this.core.t, acc.id)) === 0;
    return { pick: true as const, ticket: await this.pickTicket(acc), account: { name: acc.name, email: acc.email, verified: acc.verified }, stores, canAddStore, canAddAgency };
  }

  @Public()
  @Post('auth/login')
  async login(@Body() body: unknown, @Req() req: { ip?: string; headers?: Record<string, unknown> }) {
    if (!config.trustProxy && req.headers?.['x-forwarded-for'] && !proxyWarned) {
      proxyWarned = true;
      new Logger('Pilotix').warn('Requests come through a proxy (X-Forwarded-For) but TRUST_PROXY is not set: the login limit sees every user as the proxy. Set TRUST_PROXY=1.');
    }
    const ipKey = `ip:${ipOf(req)}`;
    checkLogin(ipKey, 10);
    const b = LoginBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Email ou mot de passe manquant');
    const email = b.data.email.trim().toLowerCase();
    const mailKey = `email:${email}|${ipOf(req)}`;
    checkLogin(mailKey, 5);
    let acc: core.Account | null;
    try {
      acc = await core.checkAccountPassword(this.core.t, email, b.data.password);
      // the demo accounts of shop #1 on old installs (no account of their own): the shop's own check, as before
      if (!acc && core.NO_ACCOUNT.test(email)) {
        const ref = await this.core.primary();
        const session = await core.login(ref.db, email, b.data.password);
        clearLogin(mailKey);
        return { token: await this.signShop(ref, session.profile.id), session: await this.core.withShop(session, ref) };
      }
      if (!acc) throw new core.AppError('unauthorized', 'Email ou mot de passe incorrect');
    } catch (e) {
      failedLogin(ipKey);
      failedLogin(mailKey);
      throw e;
    }
    clearLogin(mailKey);
    const stores = await core.storeChoices(this.core.t, acc.email);
    // one store (or the one asked for): straight in; several or none: the picker
    const one = b.data.shop ? stores.find((x) => x.id === b.data.shop) : stores.length === 1 ? stores[0] : null;
    if (one) return this.enter(one.id, acc.email);
    return this.picker(acc);
  }

  /** The picker: the chosen store, with the ticket the login gave. */
  @Public()
  @Post('auth/pick')
  async pick(@Body() body: unknown) {
    const b = PickBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Choisissez une boutique');
    const acc = await this.ticketAccount(b.data.ticket);
    return this.enter(b.data.shop, acc.email);
  }

  /** « Changer de boutique »: another store of the same person, without the password again. */
  @Post('auth/switch')
  async switchStore(@Body() body: any, @Req() req: ShopRequest) {
    const shop = Number(body?.shop);
    if (!Number.isInteger(shop) || shop <= 0) throw new core.AppError('bad_request', 'Choisissez une boutique');
    return this.enter(shop, req.session.profile.email);
  }

  /** The person's stores (the account menu). */
  @Get('auth/stores')
  async myStores(@Req() req: ShopRequest) {
    return core.storeChoices(this.core.t, req.session.profile.email);
  }

  // ---------------------------------------------------------------- a shop's own domain name (landing pages)
  private platformHost() {
    try {
      return new URL(config.publicUrl).hostname;
    } catch {
      return '';
    }
  }

  /** The addresses a shop's domain must point to: PUBLIC_IP, else those of the platform's name. */
  private serverIps(): Promise<string[]> {
    return config.publicIps.length ? Promise.resolve(config.publicIps) : dns.resolve4(this.platformHost()).catch(() => [] as string[]);
  }
  /** The DNS as the domain check sees it: the platform's name answers the server's addresses. */
  private resolve = (h: string) => (h === this.platformHost() ? this.serverIps() : dns.resolve4(h));

  /** The shop's own domain: what it is, whether its DNS is ready, what to write at the domain's registrar. */
  @Post('shop/domain/get')
  async domainGet(@Req() req: ShopRequest) {
    const s = req.shop.shop;
    const ips = await this.serverIps();
    return { domain: s.domain, status: s.domainStatus, ips, host: this.platformHost(), primary: s.primary };
  }

  /** Sets or removes the shop's own domain (its administrator), then checks its DNS at once. */
  @Post('shop/domain')
  async domainSet(@Body() body: any, @Req() req: ShopRequest) {
    if (!req.session.isAdmin) throw new core.AppError('forbidden', 'Réservé à l’administrateur');
    if (req.shop.shop.demo) throw new core.AppError('forbidden', 'Pas dans la boutique démo');
    const want = body?.domain === null || body?.domain === '' ? null : String(body?.domain ?? '').slice(0, 260);
    try {
      await core.setShopDomain(this.core.t, req.shop.shop.id, want, this.platformHost());
    } catch (e) {
      if (e instanceof core.DomainError) throw new core.AppError('bad_request', e.message);
      throw e;
    }
    if (want) await core.checkShopDomain(this.core.t, req.shop.shop.id, this.platformHost(), this.resolve);
    this.core.invalidate();
    // its landing pages get Cloudflare's robot check on the new domain (or the old one is taken out), in the background
    void syncTurnstile(this.core).catch(() => null);
    const ref = (await this.core.shop({ id: req.shop.shop.id }))!;
    return { domain: ref.shop.domain, status: ref.shop.domainStatus };
  }

  /** « Vérifier »: does the domain point to this server now? (DNS changes take minutes to hours) */
  @Post('shop/domain/check')
  async domainCheck(@Req() req: ShopRequest) {
    const key = `domain:${req.shop.shop.id}`;
    checkLogin(key, 30);
    failedLogin(key);
    const r = await core.checkShopDomain(this.core.t, req.shop.shop.id, this.platformHost(), this.resolve);
    this.core.invalidate();
    if (r.ok) void syncTurnstile(this.core).catch(() => null);
    return r;
  }

  /** Caddy asks before getting an HTTPS certificate for a name: only a ready domain of an active shop. */
  @Public()
  @Get('domain-check')
  async domainAllowed(@Query('domain') domain: string, @Res() res: any) {
    const id = await core.shopIdByDomain(this.core.t, String(domain ?? ''));
    return res.status(id ? 200 : 404).send(id ? 'ok' : 'unknown');
  }

  /**
   * A shop's own domain (Caddy sends every path here, with the name asked for): https://myshop.com/<page> is the landing
   * page, / lists the shop's pages, /llms.txt and /robots.txt as on the platform.
   */
  @Public()
  @Get(['domain', 'domain/:page'])
  async domainPage(@Param('page') page: string | undefined, @Req() req: { url?: string; headers: Record<string, string | undefined> }, @Res() res: any) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    const id = await core.shopIdByDomain(this.core.t, host);
    const ref = id ? await this.core.shop({ id }) : null;
    const missing = () => res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Page introuvable');
    if (!ref || ref.shop.status !== 'active') return missing();
    const site = `https://${host.replace(/:\d+$/, '')}`;
    if (page === 'robots.txt') return res.status(200).header('Content-Type', 'text/plain; charset=utf-8').send('User-agent: *\nAllow: /\nDisallow: /api/\n');
    const shop = intake(ref);
    if (!page || page === 'llms.txt') {
      const r: any = await this.core.call(shop, 'landing.llms', await this.core.systemSession(shop), { site, pagesBase: `${site}/` });
      if (page === 'llms.txt') return sendText(req, res.status(200).header('Content-Type', 'text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=3600'), r.text);
      return sendText(req, res.status(200).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'public, max-age=300'), storeIndexHtml(r.text));
    }
    return this.sendLanding(shop, page, req, res, { api: `${site}/api${ref.shop.primary ? '' : `/s/${ref.shop.slug}`}`, url: `${site}/${page}` });
  }

  /** /api/s/<store>/llms.txt: a shop's pages for AI assistants (the platform's /llms.txt links to every shop's). */
  @Public()
  @Get('s/:store/llms.txt')
  async storeLlms(@Param('store') store: string, @Req() req: { headers: Record<string, string | undefined> }, @Res() res: any) {
    const ref = await this.publicShop(store).catch(() => null);
    if (!ref || ref.shop.demo) return res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Boutique introuvable');
    const shop = intake(ref);
    const r: any = await this.core.call(shop, 'landing.llms', await this.core.systemSession(shop), { site: config.publicUrl });
    return sendText(req, res.status(200).header('Content-Type', 'text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=3600'), r.text);
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
    const ipKey = `demo:${ipOf(req)}`;
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

  // ---------------------------------------------------------------- passwords: one account, every store
  /** Can this server send "mot de passe oublié" e-mails? (the login page shows the link only then) */
  @Public()
  @Get('auth/forgot')
  forgotAvailable() {
    return { available: mailConfigured() };
  }

  /**
   * "Mot de passe oublié": e-mails a one-time link (for every store of the person). Same answer whether the account
   * exists or not, and the e-mail leaves after the answer (no timing difference). 5 requests per 15 minutes per address.
   */
  @Public()
  @Post('auth/forgot')
  async forgot(@Body() body: unknown, @Req() req: { ip?: string }) {
    const ipKey = `forgot:${ipOf(req)}`;
    checkLogin(ipKey, 5);
    failedLogin(ipKey);
    if (!mailConfigured()) throw new HttpException({ message: 'L’envoi d’e-mails n’est pas configuré sur ce serveur. Demandez à votre administrateur.' }, 503);
    const b = ForgotBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Email invalide');
    const r = await core.accountResetRequest(this.core.t, b.data.email);
    if (r) sendLater(r.kind === 'link' ? resetMail(r) : limitMail(r), 'Reset');
    return { ok: true };
  }

  /** What a link is (an invitation says « choose your password »; null: used or too old). */
  @Public()
  @Get('auth/link/:token')
  async linkInfo(@Param('token') token: string) {
    return { kind: await core.linkKind(this.core.t, token) };
  }

  /**
   * Sets the new password with a link (« Mot de passe oublié », an invitation): for every store of the person. A link
   * sent before accounts existed (one store's) still works, and every store follows. 10 wrong links per 15 minutes.
   */
  @Public()
  @Post('auth/reset')
  async reset(@Body() body: unknown, @Req() req: { ip?: string }) {
    const ipKey = `reset:${ipOf(req)}`;
    checkLogin(ipKey, 10);
    const b = ResetBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Lien invalide');
    try {
      if (await core.linkKind(this.core.t, b.data.token)) await core.passwordFromLink(this.core.t, b.data.token, b.data.password);
      else {
        const m = b.data.token.match(/^(\d{1,9})\.(.+)$/);
        const ref = m ? await this.core.shop({ id: Number(m[1]) }) : await this.core.primary();
        if (!ref || ref.shop.demo || ref.shop.status === 'archived' || ref.shop.status === 'deleted') throw new core.AppError('bad_request', 'Ce lien n’est plus valable. Demandez un nouveau lien.');
        const r = await core.resetPassword(ref.db, m ? m[2] : b.data.token, b.data.password);
        const p = (await ref.db.query('SELECT id FROM profiles WHERE email = $1', [r.email]))[0];
        if (p) await core.propagateProfilePassword(this.core.t, ref.shop.schema, Number(p.id));
      }
    } catch (e) {
      failedLogin(ipKey);
      throw e;
    }
    this.core.authEpoch++;
    return { ok: true };
  }

  /** The e-mail check link (needed before adding a store to an account made by a store's admin). */
  @Public()
  @Post('auth/verify')
  async verify(@Body() body: unknown, @Req() req: { ip?: string }) {
    const ipKey = `verify:${ipOf(req)}`;
    checkLogin(ipKey, 10);
    const b = TokenBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Lien invalide');
    try {
      await core.verifyFromLink(this.core.t, b.data.token);
    } catch (e) {
      failedLogin(ipKey);
      throw e;
    }
    return { ok: true };
  }

  /** Sends the e-mail check link to the logged-in person (3 an hour). */
  @Post('auth/verify/send')
  async verifySend(@Req() req: ShopRequest) {
    const acc = await core.accountByEmail(this.core.t, req.session.profile.email);
    if (!acc) throw new core.AppError('bad_request', 'Compte introuvable');
    return this.sendVerify(acc);
  }
  /** The same from the store picker (a person with no store left), with the login's ticket. */
  @Public()
  @Post('auth/verify/send/ticket')
  async verifySendTicket(@Body() body: any) {
    return this.sendVerify(await this.ticketAccount(String(body?.ticket ?? '')));
  }
  private async sendVerify(acc: core.Account) {
    if (acc.verified) return { ok: true, already: true };
    if (!mailConfigured()) throw new HttpException({ message: 'L’envoi d’e-mails n’est pas configuré sur ce serveur.' }, 503);
    if ((await core.recentTokens(this.core.t, acc.id, 'verify', Date.now() - 3_600_000)) >= 3) throw new core.AppError('bad_request', 'Lien déjà envoyé : regardez vos e-mails (et les spams)');
    sendLater(verifyMail({ token: await core.makeAccountToken(this.core.t, acc.id, 'verify'), email: acc.email, name: acc.name, language: acc.language }), 'Verify');
    return { ok: true, email: acc.email };
  }

  // ---------------------------------------------------------------- « Créer ma boutique », « Ajouter une boutique »
  /** The sign-up page: open or not (needs e-mails), the trial's length. */
  @Public()
  @Get('auth/signup')
  async signupInfo() {
    const set = await this.core.settings();
    return { open: set.signup.open && mailConfigured(), trialDays: set.trial.days, site: (config.publicUrl || '').replace(/^https?:\/\//, '') };
  }

  /** Is a store name free? (the sign-up form checks while it is typed) */
  @Public()
  @Get('auth/store-name')
  async storeName(@Query('name') name: string, @Query('slug') slug: string, @Req() req: { ip?: string }) {
    const ipKey = `storename:${ipOf(req)}`;
    checkLogin(ipKey, 300);
    failedLogin(ipKey);
    return core.storeNameCheck(this.core.t, String(name ?? '').slice(0, 80), slug ? String(slug).slice(0, 40) : undefined);
  }

  /**
   * A sign-up: the e-mail with its link leaves; nothing is made before it is opened. 10 per 15 minutes per address
   * (phones share addresses), and 3 an hour per e-mail.
   */
  @Public()
  @Post('auth/signup')
  async signup(@Body() body: unknown, @Req() req: { ip?: string }) {
    const ipKey = `signup:${ipOf(req)}`;
    checkLogin(ipKey, 10);
    failedLogin(ipKey);
    if (!mailConfigured()) throw new HttpException({ message: 'Les inscriptions ne sont pas encore ouvertes sur ce serveur.' }, 503);
    const m = await core.startSignup(this.core.t, body, core.expandIp(req.ip || ''));
    if (m) sendLater(m.kind === 'confirm' ? signupConfirmMail(m) : signupExistsMail(m), 'Sign-up');
    return { ok: true };
  }

  /** The sign-up e-mail's link: the account and its store are made, the person is logged in. */
  @Public()
  @Post('auth/signup/confirm')
  async signupConfirm(@Body() body: unknown, @Req() req: { ip?: string }) {
    const ipKey = `confirm:${ipOf(req)}`;
    checkLogin(ipKey, 10);
    const b = TokenBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Lien invalide');
    let r: Awaited<ReturnType<typeof core.confirmSignup>>;
    try {
      r = await core.confirmSignup(this.core.t, b.data.token);
    } catch (e) {
      failedLogin(ipKey);
      throw e;
    }
    if ('exists' in r) return { exists: true, email: r.email };
    this.core.invalidate();
    return this.enter(r.shop.id, r.account.email);
  }

  /** « Ajouter une boutique » from the account menu: a new store this person owns (they enter it). */
  @Post('auth/add-store')
  async addStore(@Body() body: unknown, @Req() req: ShopRequest) {
    const acc = await core.accountByEmail(this.core.t, req.session.profile.email);
    if (!acc) throw new core.AppError('forbidden', 'Compte introuvable');
    return this.addFor(acc, body);
  }
  /** The same from the store picker (a person who has no store left), with the login's ticket. */
  @Public()
  @Post('auth/add-store/ticket')
  async addStoreTicket(@Body() body: any) {
    return this.addFor(await this.ticketAccount(String(body?.ticket ?? '')), body);
  }
  private async addFor(acc: core.Account, body: unknown) {
    const shop = await core.addStore(this.core.t, acc, body);
    this.core.invalidate();
    return this.enter(shop.id, acc.email);
  }

  /** Only the owner: the store and all its data are deleted (its password and the store's exact name asked). */
  @Post('auth/delete-store')
  async deleteStore(@Body() body: any, @Req() req: ShopRequest) {
    const acc = await core.accountByEmail(this.core.t, req.session.profile.email);
    if (!acc) throw new core.AppError('forbidden', 'Seul le propriétaire de la boutique peut la supprimer');
    await core.deleteStoreByOwner(this.core.t, acc, req.shop.shop.id, String(body?.password ?? ''), String(body?.name ?? ''));
    this.core.invalidate();
    const stores = await core.storeChoices(this.core.t, acc.email);
    // the session of the deleted store ends: the person goes on in another store of theirs (a working one first)
    const other = stores.find((s) => !s.locked) ?? stores[0];
    const next = other ? await this.enter(other.id, acc.email).catch(() => null) : null;
    return { ok: true, stores, next };
  }

  // ---------------------------------------------------------------- « Contacter Pilotix » (the store's administrators)
  private needAdmin(req: ShopRequest) {
    if (!req.session.isAdmin) throw new core.AppError('forbidden', 'Réservé aux administrateurs de la boutique');
    if (req.shop.shop.demo) throw new core.AppError('forbidden', 'Pas dans la boutique démo');
  }
  @Get('support')
  async supportList(@Req() req: ShopRequest) {
    this.needAdmin(req);
    return core.shopThreads(this.core.t, req.shop.shop.id);
  }
  @Get('support/:id')
  async supportGet(@Param('id') id: string, @Req() req: ShopRequest) {
    this.needAdmin(req);
    return core.shopThread(this.core.t, req.shop.shop.id, Number(id) || 0);
  }
  @Post('support')
  async supportWrite(@Body() body: unknown, @Req() req: ShopRequest) {
    this.needAdmin(req);
    return core.shopWrite(this.core.t, req.shop.shop.id, { name: req.session.profile.name, email: req.session.profile.email }, body);
  }
  @Post('support/:id')
  async supportReply(@Param('id') id: string, @Body() body: unknown, @Req() req: ShopRequest) {
    this.needAdmin(req);
    return core.shopReply(this.core.t, req.shop.shop.id, Number(id) || 0, { name: req.session.profile.name }, body);
  }

  /** The terms of use and privacy page: Pilotix's own text when it wrote one (else the app's standard text). */
  @Public()
  @Get('legal')
  async legal() {
    const set = await this.core.settings();
    return { text: set.legal.text, company: set.company.name, email: set.company.email };
  }

  // ---------------------------------------------------------------- the shops' actions
  @Post('rpc/:name')
  async rpc(@Param('name') name: string, @Body() body: unknown, @Req() req: ShopRequest) {
    // names like orders.list, and grouped ones like dellal.settings.get or cm.settings.save
    if (!/^[a-z]+(\.[a-zA-Z0-9]+){1,3}$/.test(name)) throw new core.AppError('not_found', 'Action inconnue');
    if (req.shop.shop.demo && NOT_IN_DEMO.has(name)) throw new core.AppError('forbidden', 'Pas dans la boutique démo : ses comptes sont partagés par tous les visiteurs');
    if (TEAM_ACTIONS.has(name)) await this.teamRules(name, body as any, req);
    if (name.startsWith('archive.') && !req.shop.shop.demo) return this.archive(name, body as any, req);
    // « Parrainage » on a multi-shop server: this store's code and the stores it brought
    if (name === 'me.referrals' && !req.shop.shop.demo) return this.referrals(req);
    // a confirmation agency's space: the seller chosen at the top of the page (one store, or all of them)
    let out: any = await this.core.call(req.shop, name, req.session, body ?? {}, sellerOf(req.headers?.['x-seller']));
    if (AUTH_CHANGES.has(name)) this.core.authEpoch++;
    if (!req.shop.shop.demo) out = await this.afterTeam(name, body as any, out, req);
    // shop #1's name in its links (« Lien des pages », else made from the shop's name) is its name on the platform too
    if (req.shop.shop.primary && STORE_NAMING.has(name)) {
      await core.syncPrimaryStore(this.core.t);
      this.core.invalidate();
    }
    // the app learns its shop (plan, limits, owner, other stores) with the session
    if (name === 'me.get') return this.core.withShop(out as Session, req.shop);
    // a new password logs out the other sessions (in every store of the person): this one gets a fresh token
    if (name === 'me.password') {
      await core.propagateProfilePassword(this.core.t, req.shop.shop.schema, req.session.profile.id);
      return { ...out, token: await this.signShop(req.shop, req.session.profile.id) };
    }
    return out;
  }

  /**
   * The owner's account is touched by nobody else, and the owner cannot leave the store; a store's admin sets the
   * password only of someone who works in that store alone (not the owner): otherwise they would open other stores.
   */
  private async teamRules(name: string, body: any, req: ShopRequest) {
    if (req.shop.shop.demo) return;
    const ownerId = await core.ownerProfileId(this.core.t, req.shop.shop);
    const me = req.session.profile.id;
    if (name === 'me.delete') {
      if (ownerId === me) throw new core.AppError('bad_request', 'Vous êtes le propriétaire de cette boutique : votre compte reste (vous pouvez supprimer la boutique entière dans Réglages).');
      return;
    }
    const target = Number(body?.id);
    if (!target || target === me) return;
    if (ownerId === target) throw new core.AppError('forbidden', 'Seul le propriétaire modifie son propre compte');
    const setsPassword = name === 'admin.users.resetPassword' || (name === 'users.update' && typeof body?.password === 'string' && body.password !== '');
    if (setsPassword) {
      const email = (await req.shop.db.query('SELECT email FROM profiles WHERE id = $1', [target]))[0]?.email as string | undefined;
      if (email && !(await core.adminMaySetPassword(this.core.t, req.shop.shop.id, email)))
        throw new core.AppError('forbidden', 'Cette personne utilise Pilotix dans une autre boutique : elle change son mot de passe elle-même (Mon profil, ou « Mot de passe oublié »).');
    }
  }

  /**
   * Management › Archives with the store's owner: the owner's account is never archived (the list says so), and only
   * the owner deletes for good (a store without a known owner: its administrators).
   */
  private async archive(name: string, body: any, req: ShopRequest) {
    const ownerId = await core.ownerProfileId(this.core.t, req.shop.shop);
    const ids: number[] = Array.isArray(body?.ids) ? body.ids.map(Number) : [];
    if (name === 'archive.delete' && ownerId !== null && ownerId !== req.session.profile.id) throw new core.AppError('forbidden', 'Seul le propriétaire de la boutique supprime pour toujours');
    if (name === 'archive.set' && body?.kind === 'users' && body?.archived === true && ownerId !== null && ids.includes(ownerId)) throw new core.AppError('forbidden', 'Le compte du propriétaire ne s’archive pas');
    const out: any = await this.core.call(req.shop, name, req.session, body ?? {});
    // archived or deleted accounts: their sessions end now
    if (name !== 'archive.list' && body?.kind === 'users') this.core.authEpoch++;
    if (name === 'archive.list' && body?.kind === 'users' && ownerId !== null && Array.isArray(out))
      return out.map((r: core.ArchiveRow) => (r.id === ownerId && !r.archivedAt ? { ...r, blocked: 'owner' } : r));
    return out;
  }

  /** After a team action: the person's account follows (a new person gets one; a known one keeps its password). */
  private async afterTeam(name: string, body: any, out: any, req: ShopRequest) {
    const t = this.core.t;
    const schema = req.shop.shop.schema;
    if (name === 'users.create' && out?.id) {
      const a = await core.attachProfile(t, schema, Number(out.id));
      if (a?.existing) return { ...out, existingAccount: true };
    }
    if (name === 'users.update' && body?.id) {
      if (body.email) await core.attachProfile(t, schema, Number(body.id));
      if (body.password) await core.propagateProfilePassword(t, schema, Number(body.id));
    }
    if (name === 'admin.users.resetPassword' && body?.id) await core.propagateProfilePassword(t, schema, Number(body.id));
    return out;
  }

  /** « Parrainage »: the store's code, its link, and the stores it brought (the free months they earned). */
  private async referrals(req: ShopRequest) {
    const r = await core.storeReferrals(this.core.t, req.shop.shop.id);
    const friends = r.list.map((x, i) => ({
      id: i + 1,
      name: x.name,
      email: null as string | null,
      shop: x.name,
      status: (x.paid ? 'subscribed' : 'signed_up') as 'invited' | 'signed_up' | 'subscribed',
      cash: 0,
      months: x.months,
      paid: x.paid,
      createdAt: x.at,
      subscribedAt: x.paid ? x.at : null,
    }));
    const sub = friends.filter((f) => f.status === 'subscribed');
    return {
      code: r.code,
      rules: { cash: 0, months: r.on ? r.months : 0 },
      friends,
      totals: { invited: friends.length, signedUp: friends.length, subscribed: sub.length, cashEarned: 0, cashPaid: 0, cashPending: 0, months: r.earned },
      platform: true,
      link: r.code && config.publicUrl ? `${config.publicUrl}/#/inscription/${r.code}` : null,
    };
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
  private async sendLanding(ref: ShopRef, slug: string, req: { headers: Record<string, string | undefined> }, res: any, own?: { api: string; url: string }) {
    const missing = () => res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Page introuvable');
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) return missing();
    try {
      // on the shop's own domain, the page calls that domain (Caddy forwards /api): no other site involved
      const base = `${own?.api ?? apiOf(ref)}/lp/`;
      const r: any = await this.core.call(ref, 'landing.html', await this.core.systemSession(ref), { slug, mode: 'live', post: `${base}${slug}/order`, lead: `${base}${slug}/lead`, geo: `${base}geo/`, imgBase: `${base}img/`, site: config.publicUrl, ...(own ? { url: own.url } : {}) });
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
    // the other shops of the server: each one's own list (its pages, prices, descriptions)
    const others = [];
    for (const s of await core.loadShops(this.core.t)) {
      if (s.primary || s.demo || s.status !== 'active') continue;
      const ref = await this.core.shop({ id: s.id });
      if (ref && !ref.status.locked) others.push(`- [${s.name.replace(/[[\]\\]/g, '')}](${config.publicUrl}/api/s/${s.slug}/llms.txt)`);
    }
    const text = others.length ? `${r.text.trimEnd()}\n\n## Boutiques\n\n${others.join('\n')}\n` : r.text;
    return sendText(req, res.status(200).header('Content-Type', 'text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=3600'), text);
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
