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
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Logger,
  Module,
  Param,
  Post,
  Put,
  Query,
  RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { APP_FILTER, Reflector, REQUEST } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as core from '@pilotix/core';
import { maskPhone, normalizePhone, ProCard, Session } from '@pilotix/shared';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { brotliCompressSync, constants as zlibConst, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { config } from './config';
import { CoreService, ShopRef } from './core.service';
import { checkLogin, clearLogin, failedLogin, settleLogin } from './limits';
import { mailConfigured, sendMail } from './mail';
import { PlatformController, PlatformGuard } from './platform';
import { PUBLIC, Public } from './public';
import { limitMail, resetMail } from './resetMail';
import { promises as dns } from 'node:dns';
import { domainLookup } from './domainDns';
import { domainEcho, echoNonceOk, reachDomain } from './domainEcho';
import { referralSignupMail, signupConfirmMail, signupExistsMail, verifyMail } from './mails';
import { fcmHooks } from './fcm';
import { push as webPush, pushKeys as webPushKeys } from './push';
import type { Mail } from './mail';
import { syncTurnstile } from './turnstile';
import { robotGate } from './robot';
import { doctorState } from './doctor';
import { recordCut } from './cuts';
import { sendSpyVideo, sendVideo, writePart } from './media';

/** the Pilotix icon (apps/web/public/icon.svg): the pages' tab icon when the shop has no logo */
const PILOTIX_ICON_SVG = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'><mask id='m' maskUnits='userSpaceOnUse' x='0' y='0' width='512' height='512'><rect width='512' height='512' rx='112' fill='#fff'/></mask><g mask='url(#m)'><rect width='512' height='512' fill='#1B2A47'/><path d='M0,250 C120,200 200,320 300,280 C380,248 440,230 512,250 V512 H0 Z' fill='#F7A823'/></g><path d='M146.00,296.00 C217.40,372.00 324.50,364.40 384.00,272.00 C324.50,319.18 217.40,326.78 146.00,296.00 Z' fill='#1B2A47'/><circle cx='186' cy='186' r='50' fill='#F7A823'/><path d='M290,186 H364' stroke='#F7A823' stroke-width='44' stroke-linecap='round' fill='none'/></svg>`;
import { otpOn, sendOtp } from './otp';

/**
 * Shop #1's demo e-mails (…@demo.pilotix.dz) logging in with the public demo password: only on a test server (not
 * production, or ALLOW_DEMO_SEED=1 like the demo data itself). On a live server they would open the real shop #1.
 */
const demoShortcutOn = () => process.env.NODE_ENV !== 'production' || process.env.ALLOW_DEMO_SEED === '1';

// ---------------------------------------------------------------- errors → HTTP
const STATUS: Record<string, number> = { bad_request: 400, unauthorized: 401, payment_required: 402, forbidden: 403, not_found: 404, conflict: 409 };

@Catch()
class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('API');
  catch(e: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    let status = 500;
    let message = 'Erreur du serveur';
    // a login's robot check (robot.ts): the site key goes with the answer, for the page to do it
    let challenge: string | undefined;
    if (e instanceof core.AppError) {
      status = STATUS[e.code] ?? 400;
      message = e.message;
    } else if (e instanceof HttpException) {
      status = e.getStatus();
      const r = e.getResponse() as any;
      message = typeof r === 'string' ? r : r?.message ?? e.message;
      if (typeof r?.challenge === 'string') challenge = r.challenge;
    } else {
      this.log.error(e?.stack || e);
    }
    res.status(status).send(challenge ? { message, challenge } : { message });
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
/** What a screen tells the Doctor (web lib/watch). */
const ClientReports = z.object({
  items: z
    .array(
      z.object({
        kind: z.enum(['error', 'loop', 'slow', 'cut', 'door']),
        page: z.string().max(40),
        message: z.string().min(1).max(300),
        device: z.enum(['phone', 'computer']),
        // a cut or a move to the backup door: what still answered from the screen (web lib/roads) and when
        roads: z.object({ edge: z.boolean().nullable(), cf: z.boolean().nullable(), direct: z.boolean().nullable(), net: z.boolean().nullable(), app: z.boolean().nullable() }).optional(),
        start: z.number().optional(),
        end: z.number().optional(),
      }),
    )
    .min(1)
    .max(10),
});
/** The store picker's ticket (after the password, before a store is chosen) is signed with its own key. */
const pickSecret = () => `${config.jwtSecret}:pick`;
/** The backup door's ticket (a session carried from one address of the server to the other) has its own key too. */
const doorSecret = () => `${config.jwtSecret}:door`;
/** How long a door ticket lives: the time to open the other address, no more (it is in that address for a moment). */
const DOOR_TICKET_LIFE = '2m';

@Injectable()
export class AuthGuard implements CanActivate {
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
    // ended with « Se déconnecter » on that device
    if (await this.core.isRevoked((c as { jti?: string }).jti)) throw new UnauthorizedException('Session terminée, reconnectez-vous');
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
    if (p.agencyId) throw new UnauthorizedException('Ouvrez l’espace de votre agence (ou votre espace marketer)');
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

/**
 * A team browser (Landing pages › Réglages › « Team et fournisseurs »): it sent a test with a team number, so the page
 * shows it no pixel and counts it nowhere for a year. Only on the page's own address; it never changes how an order is
 * judged (that goes by the number).
 */
const TEAM_COOKIE = 'pxtm=1; Max-Age=31536000; Path=/; SameSite=Lax; Secure; HttpOnly';
const teamBrowser = (req: { headers: Record<string, string | undefined> }) => /(?:^|;\s*)pxtm=1(?:;|$)/.test(String(req.headers.cookie ?? ''));
/** robots that ask for pages (search engines, Meta's and TikTok's checks of an ad's page, scripts): never a visitor */
const isRobot = (req: { headers: Record<string, string | undefined> }) =>
  /facebookexternalhit|facebot|meta-externalagent|bytespider|bot\b|crawler|spider|headless/i.test(String(req.headers['user-agent'] ?? ''));
/** a landing page visitor's anonymous code (the pxv cookie the page's address gave the browser), if it has one */
const visitorCode = (req: { headers: Record<string, string | undefined> }) => /(?:^|;\s*)pxv=([a-z0-9]{12,40})(?:;|$)/.exec(String(req.headers.cookie ?? ''))?.[1];
/** the visitor cookie: a year, on the page's own address, nothing but a random code */
const visitorCookie = (code: string) => `pxv=${code}; Max-Age=31536000; Path=/; SameSite=Lax; Secure; HttpOnly`;

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
    asn: h['x-visitor-asn'] || h['cf-visitor-asn'] || '',
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

/**
 * A shop's own domain sends the customer to another of its addresses (its home, a page: core.domainFallback). 302,
 * never 301: browsers keep a 301 forever, and an old link may later lead to its own product.
 */
const toOwnPage = (res: any, to: string) => res.status(302).header('Location', to).header('Cache-Control', 'no-store').send();

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
/** Linked accounts (Pilot AI › Comptes): the login tabs' end, server only. */
function optionalSocial(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@pilotix/core/dist/social-server');
  } catch {
    return null;
  }
}
/** Meta signs its webhook calls with the app's secret: the body as it came, checked in constant time. */
function metaSigned(req: RawBodyRequest<any>, body: unknown, sig: string | undefined, secret: string): boolean {
  const raw: Buffer | undefined = req.rawBody;
  const want = 'sha256=' + createHmac('sha256', secret).update(raw ?? Buffer.from(JSON.stringify(body ?? {}))).digest('hex');
  return !!sig && sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

/** The shop's public API address (links given to customers and to other services). */
const apiOf = (ref: ShopRef, site = config.publicUrl) => `${site}/api${ref.shop.primary ? '' : `/s/${ref.shop.slug}`}`;
/** The address a request came to (Caddy passes it on), lower case, without the port. */
const hostOf = (req: { headers: Record<string, string | undefined> }) =>
  String(req.headers['x-forwarded-host'] || req.headers.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '');
/** The reactivation link's page: never kept by a cache, never indexed, nothing runs (its photo and its own button only). */
const reorderHead = (res: any) =>
  res
    .header('Cache-Control', 'no-store')
    .header('Referrer-Policy', 'no-referrer')
    .header('X-Robots-Tag', 'noindex, nofollow')
    .header('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
    .type('text/html; charset=utf-8');
const REORDER_GONE = 'هذا الرابط غير متاح.';
const REORDER_DONE = 'تمت إعادة تفعيل طلبك. سنتواصل معك لتأكيده.';
const REORDER_USED = 'لم يعد بإمكانك إعادة تفعيل هذا الطلب عبر هذا الرابط.';
/** What follows the path of a request (?fbclid=…): kept when a page moves. */
const queryOf = (req: { url?: string }) => {
  const q = String(req.url ?? '').indexOf('?');
  return q >= 0 ? String(req.url).slice(q) : '';
};

/**
 * Orders, landing pages and parcel statuses keep coming in while a shop is unpaid (locked): no customer order is lost,
 * the shop sees them once it pays. Everything else of a locked shop stays closed.
 */
const intake = (ref: ShopRef): ShopRef => (ref.status.state === 'expired' ? { ...ref, rules: { ...ref.rules, locked: false } } : ref);

const LoginBody = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200), shop: z.number().int().positive().optional(), turnstile: z.string().max(4000).optional() });
const PickBody = z.object({ ticket: z.string().max(4000), shop: z.number().int().positive() });
/** « Vérifiez votre numéro »: the number (and the WhatsApp code when it is asked), with the login's ticket */
const PhoneBody = z.object({ ticket: z.string().max(4000), phone: z.string().trim().min(1).max(30), code: z.string().trim().max(12).optional(), shop: z.number().int().positive().optional() });
const ForgotBody = z.object({ email: z.string().email().max(200) });
const ResetBody = z.object({ token: z.string().max(220), password: z.string().max(200) });
const TokenBody = z.object({ token: z.string().max(220) });
/** `kind`: 'access' from Pilotix's own plain button (Google's window), 'id' (or none) from Google's old button */
const SocialBody = z.object({ provider: z.enum(['google']), token: z.string().min(20).max(4000), kind: z.enum(['id', 'access']).optional(), language: z.enum(['fr', 'en', 'ar']).optional() });

/**
 * Who Google says this is: their proven e-mail and name, from the proof the button gave the page (checked here with
 * Google, and that it was made for Pilotix's own app: core › googleIdentity). null: not a valid proof for this app.
 */
async function socialIdentity(provider: 'google', token: string, set: core.PlatformSettings, kind: core.GoogleProof = 'id'): Promise<{ email: string; name: string } | null> {
  if (provider === 'google') return core.googleIdentity(token, kind, set.social.googleClientId);
  return null;
}

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
    @Inject(REQUEST) private readonly httpRequest: { headers: Record<string, string | undefined> },
    private readonly core: CoreService,
    private readonly jwt: JwtService,
  ) {}

  /** A shop token: the person's account in that shop, its token version, its shop, and its own id (« Se déconnecter »). */
  private async signShop(ref: ShopRef, id: number) {
    const phone = /\bPilotixApp\b/.test(this.httpRequest.headers['user-agent'] || '');
    return this.jwt.signAsync({ sub: id, tv: await tokenVersion(ref.db, id), shop: ref.shop.id, jti: randomUUID() },
      phone ? { expiresIn: '30d' } : {});
  }

  /** The shop of a public link (/api/s/<slug>/…; none = shop #1). A suspended or closed shop answers as unknown. */
  private async publicShop(slug: string | undefined): Promise<ShopRef> {
    const ref = await this.core.fromParam(slug);
    if (!ref || ref.shop.status !== 'active') throw new core.AppError('not_found', 'Boutique introuvable');
    return this.core.forPublic(ref);
  }

  /** An older long link of the cancel message (before 25 Nov 2026): /reorder/<order>/<64 hex>. It keeps working. */
  @Public()
  @Get(['reorder/:id/:token', 's/:shop/reorder/:id/:token'])
  reorderPage(@Param('token') token: string, @Res() res: any) {
    const valid = /^[a-f0-9]{64}$/.test(token);
    return reorderHead(res.code(valid ? 200 : 404)).send(core.reorderPageHtml({ message: valid ? null : REORDER_GONE }));
  }

  @Public()
  @Post(['reorder/:id/:token', 's/:shop/reorder/:id/:token'])
  async reorder(@Param('shop') shop: string | undefined, @Param('id') id: string, @Param('token') token: string, @Res() res: any) {
    const ref = await this.publicShop(shop);
    const restored = await core.reactivateCancelledOrder(ref.db, Number(id), token);
    if (restored) this.core.emitLive(ref.shop.id, { type: 'orders' });
    return reorderHead(res.code(restored ? 200 : 410)).send(core.reorderPageHtml({ message: restored ? REORDER_DONE : REORDER_USED }));
  }

  /**
   * The cancel message's short link (since 25 Nov 2026): https://<the shop's own domain>/r/<code> (Caddy sends it to
   * /api/domain/r/<code>), or on the platform's address /api/s/<store>/r/<code>. Its page shows the product's main
   * photo, which WhatsApp shows in its preview; its button restores the order (only the latest cancellation's link);
   * under the button, the shop's « Pourquoi nous » picture.
   */
  @Public()
  @Get(['r/:code', 's/:shop/r/:code'])
  async reorderShortPage(@Param('shop') shop: string | undefined, @Param('code') code: string, @Res() res: any) {
    return this.sendReorderPage(await this.publicShop(shop).catch(() => null), code, res, null);
  }

  @Public()
  @Post(['r/:code', 's/:shop/r/:code'])
  async reorderShort(@Param('shop') shop: string | undefined, @Param('code') code: string, @Res() res: any) {
    return this.reactivateShort(await this.publicShop(shop).catch(() => null), code, res);
  }

  @Public()
  @Get('domain/r/:code')
  async domainReorderPage(@Param('code') code: string, @Req() req: { headers: Record<string, string | undefined> }, @Res() res: any) {
    const host = hostOf(req);
    return this.sendReorderPage(await this.ownDomainShop(host), code, res, host ? `https://${host}` : null);
  }

  @Public()
  @Post('domain/r/:code')
  async domainReorder(@Param('code') code: string, @Req() req: { headers: Record<string, string | undefined> }, @Res() res: any) {
    return this.reactivateShort(await this.ownDomainShop(hostOf(req)), code, res);
  }

  /** The active shop whose own domain (ready) this is, on the customers' connections; null: none. */
  private async ownDomainShop(host: string): Promise<ShopRef | null> {
    const id = host ? await core.shopIdByDomain(this.core.t, host).catch(() => null) : null;
    const ref = id ? await this.core.shop({ id }) : null;
    return ref && ref.shop.status === 'active' ? this.core.forPublic(ref) : null;
  }

  /** `site`: the shop's own domain the page was opened on: its photo is read there too (never the platform's address). */
  private async sendReorderPage(ref: ShopRef | null, code: string, res: any, site: string | null) {
    if (!ref || !core.REORDER_CODE_RE.test(code)) return reorderHead(res.code(404)).send(core.reorderPageHtml({ message: REORDER_GONE }));
    const shop = intake(ref);
    // (the server failing for a moment: the page without its photo, its button still answers the truth)
    const p: any = await this.core.call(shop, 'orders.reorderPage', await this.core.systemSession(shop), { code }).catch(() => ({ found: true, photo: null, product: null }));
    if (!p?.found) return reorderHead(res.code(404)).send(core.reorderPageHtml({ message: REORDER_GONE }));
    // on the shop's own domain, its pictures are read there too (the page never needs the platform's address)
    const base = config.publicUrl.replace(/\/+$/, '');
    const here = (u: unknown) => (typeof u === 'string' && site && base && u.startsWith(`${base}/api/`) ? `${site}${u.slice(base.length)}` : u);
    const why = p.why && typeof p.why.src === 'string'
      ? { ...p.why, src: here(p.why.src), srcset: typeof p.why.srcset === 'string' ? p.why.srcset.split(', ').map((x: string) => { const [u, w] = x.split(' '); return `${here(u)} ${w}`; }).join(', ') : undefined }
      : null;
    return reorderHead(res.code(200)).send(core.reorderPageHtml({ photo: here(p.photo) as string | null, product: p.product, why }));
  }

  private async reactivateShort(ref: ShopRef | null, code: string, res: any) {
    const restored = !!ref && (await core.reactivateByCode(ref.db, code));
    if (ref && restored) this.core.emitLive(ref.shop.id, { type: 'orders' });
    return reorderHead(res.code(restored ? 200 : 410)).send(core.reorderPageHtml({ message: restored ? REORDER_DONE : REORDER_USED }));
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
    // every account has its own number (proven by the WhatsApp code when it is on) before entering any store
    const acc = await core.accountByEmail(this.core.t, email);
    if (acc && (await core.phoneStep(this.core.t, acc, await otpOn(this.core)))) throw new core.AppError('forbidden', 'Votre numéro de téléphone doit d’abord être vérifié : déconnectez-vous puis reconnectez-vous');
    // a partner's person (agency, marketer) works for this store from the partner's space, never inside the store
    if (m.agencyId) throw new core.AppError('forbidden', 'Ouvrez l’espace de votre agence (ou votre espace marketer) : vous y travaillez pour ce vendeur');
    // a password a store's admin chose opens that seller's stores only: another one needs the person's own password
    if (acc && !(await core.passwordOpens(this.core.t, acc, shopId)))
      throw new core.AppError('forbidden', 'Votre mot de passe a été choisi par l’administrateur d’une autre boutique : pour ouvrir celle-ci, choisissez le vôtre avec « Mot de passe oublié » (un lien arrive par e-mail).');
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
    const canAddStore = set.signup.open && (await core.ownedStores(this.core.t, acc.id)) < (await core.accountStoreLimit(this.core.t, acc, set));
    const canAddAgency = set.signup.open && (await core.ownedAgencies(this.core.t, acc.id)) === 0;
    const canAddMarketer = set.signup.open && (await core.ownedMarketers(this.core.t, acc.id)) === 0;
    return { pick: true as const, ticket: await this.pickTicket(acc), account: { name: acc.name, email: acc.email, verified: acc.verified }, stores, canAddStore, canAddAgency, canAddMarketer };
  }

  /**
   * After the person is proven (password, Google, sign-up link): their number first when the account has none (with its
   * WhatsApp code when it is on: checked once, when the account gets its number), then the store asked for, their only
   * store, or the picker.
   */
  private async proceed(acc: core.Account, shop?: number) {
    const step = await core.phoneStep(this.core.t, acc, await otpOn(this.core));
    if (step) return { phone: true as const, ticket: await this.pickTicket(acc), account: { name: acc.name, email: acc.email }, current: step.current, otp: step.otp, shop: shop ?? null };
    const stores = await core.storeChoices(this.core.t, acc.email);
    const one = shop ? stores.find((x) => x.id === shop) : stores.length === 1 ? stores[0] : null;
    if (one) return this.enter(one.id, acc.email);
    return this.picker(acc);
  }

  /**
   * « Vérifiez votre numéro »: code off → the number is saved and the person goes on. Code on → without `code`, a code
   * is sent by WhatsApp; with it, the number is proven and the person goes on. 20 codes and 20 wrong codes per 15
   * minutes per address (and per account: 1 a minute, 5 an hour, 5 tries each).
   */
  @Public()
  @Post('auth/phone')
  async phone(@Body() body: unknown, @Req() req: { ip?: string }) {
    const b = PhoneBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Numéro de téléphone manquant');
    const acc = await this.ticketAccount(b.data.ticket);
    if (!(await otpOn(this.core))) {
      const done = await core.setAccountPhone(this.core.t, acc.id, b.data.phone, false);
      return this.proceed(done, b.data.shop);
    }
    if (!b.data.code) {
      const ipKey = `otp:${ipOf(req)}`;
      checkLogin(ipKey, 20);
      failedLogin(ipKey);
      const c = await core.newPhoneCode(this.core.t, acc, b.data.phone);
      try {
        await sendOtp(this.core, c.phone, c.code);
      } catch (e) {
        await core.dropPhoneCode(this.core.t, c.id);
        throw new core.AppError('bad_request', (e as Error).message);
      }
      return { sent: true, phone: c.phone, masked: maskPhone(c.phone), wait: Math.round(core.PHONE_CODE.gapMs / 1000), ttl: Math.round(core.PHONE_CODE.ttlMs / 1000) };
    }
    const ipKey = `otpcheck:${ipOf(req)}`;
    checkLogin(ipKey, 20);
    let done: core.Account;
    try {
      done = await core.checkPhoneCode(this.core.t, acc, b.data.phone, b.data.code);
    } catch (e) {
      failedLogin(ipKey);
      throw e;
    }
    return this.proceed(done, b.data.shop);
  }

  @Public()
  @Post('auth/login')
  async login(@Body() body: unknown, @Req() req: { ip?: string; headers?: Record<string, unknown> }) {
    if (!config.trustProxy && req.headers?.['x-forwarded-for'] && !proxyWarned) {
      proxyWarned = true;
      new Logger('Pilotix').warn('Requests come through a proxy (X-Forwarded-For) but TRUST_PROXY is not set: the login limit sees every user as the proxy. Set TRUST_PROXY=1.');
    }
    const ipKey = `ip:${ipOf(req)}`;
    // counted the moment they arrive (many tries sent at once with different e-mails never pass together)
    checkLogin(ipKey, 10, true);
    const b = LoginBody.safeParse(body);
    if (!b.success) {
      settleLogin(ipKey);
      throw new core.AppError('bad_request', 'Email ou mot de passe manquant');
    }
    const email = b.data.email.trim().toLowerCase();
    const mailKey = `email:${email}|${ipOf(req)}`;
    // this account's failures from every address (someone changing address every two tries)
    const acctKey = `acct:${email}`;
    // after 3 failures: Cloudflare's robot check too (robot.ts); 5 for the account from any address
    try {
      await robotGate(this.core, req, [ipKey, mailKey], b.data.turnstile, acctKey);
    } catch (e) {
      settleLogin(ipKey);
      throw e;
    }
    // this account's tries, counted the moment they arrive (many at once never pass together)
    try {
      checkLogin(mailKey, 5, true);
    } catch (e) {
      settleLogin(ipKey);
      throw e;
    }
    let acc: core.Account | null;
    try {
      acc = await core.checkAccountPassword(this.core.t, email, b.data.password);
      // the demo accounts of shop #1 on test servers (no account of their own: GitHub's checks, npm run seed:demo): the
      // shop's own check, as before. Never on a live server: the demo password is public (the demo lives only in the
      // Pilotix artifact, 25 Nov 2026).
      if (!acc && core.NO_ACCOUNT.test(email) && demoShortcutOn()) {
        const ref = await this.core.primary();
        const session = await core.login(ref.db, email, b.data.password);
        settleLogin(ipKey);
        clearLogin(mailKey);
        clearLogin(acctKey);
        return { token: await this.signShop(ref, session.profile.id), session: await this.core.withShop(session, ref) };
      }
      if (!acc) throw new core.AppError('unauthorized', 'Email ou mot de passe incorrect');
    } catch (e) {
      failedLogin(ipKey);
      failedLogin(mailKey);
      failedLogin(acctKey);
      throw e;
    }
    settleLogin(ipKey);
    clearLogin(mailKey);
    clearLogin(acctKey);
    // the number first (when missing); then one store (or the one asked for): straight in; several or none: the picker
    return this.proceed(acc, b.data.shop);
  }

  /**
   * « Continuer avec Google »: the person is proven by Google. An account: they enter (their store,
   * or the picker). None: it is made now (a sign-up, when sign-ups are open), then the picker where they create their
   * first store.
   */
  @Public()
  @Post('auth/social')
  async social(@Body() body: unknown, @Req() req: { ip?: string }) {
    const ipKey = `social:${ipOf(req)}`;
    checkLogin(ipKey, 20);
    const b = SocialBody.safeParse(body);
    if (!b.success) throw new core.AppError('bad_request', 'Connexion refusée');
    const set = await this.core.settings();
    const who = await socialIdentity(b.data.provider, b.data.token, set, b.data.kind ?? 'id');
    if (!who) {
      failedLogin(ipKey);
      throw new core.AppError('unauthorized', 'Google n’a pas confirmé ce compte. Réessayez.');
    }
    const { account } = await core.socialAccount(this.core.t, { email: who.email, name: who.name, language: b.data.language });
    return this.proceed(account);
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

  // ---------------------------------------------------------------- the backup door (direct.<platform>)
  /**
   * Is the automatic backup door on (control room › Réglages)? Asked by the site at its main address: on, the browser's
   * door keeper (web public/sw.js, lib/door.ts) moves the person to the backup door when the main address gives no answer.
   */
  @Public()
  @Get('door')
  async doorState() {
    return { on: (await this.core.settings()).door.on };
  }

  /**
   * The backup door's ticket: this session, carried to the other address of the same server (pilotix.online ↔
   * direct.pilotix.online keep their logins apart, each address its own). It lives 2 minutes and opens once; it carries
   * no password and no token, and it stops working when the session it came from ends (« Se déconnecter », a new password).
   */
  @Post('auth/door/ticket')
  async doorTicket(@Req() req: ShopRequest) {
    const h = String(this.httpRequest.headers.authorization || '');
    const from = await this.jwt.verifyAsync<{ jti?: string; tv?: number }>(h.startsWith('Bearer ') ? h.slice(7) : '').catch(() => null);
    if (!from) throw new core.AppError('unauthorized', 'Session expirée, reconnectez-vous');
    const ticket = await this.jwt.signAsync(
      { typ: 'door', sub: req.session.profile.id, shop: req.shop.shop.id, tv: Number(from.tv ?? 0), from: from.jti ?? null, jti: randomUUID() },
      { secret: doorSecret(), expiresIn: DOOR_TICKET_LIFE },
    );
    return { ticket };
  }

  /** The other side of the backup door: the ticket gives this address its own session for the same person and store. */
  @Public()
  @Post('auth/door')
  async doorEnter(@Body() body: any, @Req() req: { ip?: string }) {
    const ipKey = `door:${ipOf(req)}`;
    checkLogin(ipKey, 30);
    const refused = () => {
      failedLogin(ipKey);
      return new core.AppError('unauthorized', 'Session expirée, reconnectez-vous');
    };
    const ticket = typeof body?.ticket === 'string' ? body.ticket : '';
    if (!ticket || ticket.length > 2000) throw refused();
    let c: { typ?: string; sub?: number; shop?: number; tv?: number; from?: string | null; jti?: string; exp?: number };
    try {
      c = await this.jwt.verifyAsync(ticket, { secret: doorSecret() });
    } catch {
      throw refused();
    }
    if (c.typ !== 'door' || !c.sub || !c.shop || !c.jti || !c.exp) throw refused();
    // once: a ticket already used (or the session it came from, ended since) opens nothing
    if ((await this.core.isRevoked(c.jti)) || (c.from && (await this.core.isRevoked(c.from)))) throw refused();
    // what the session itself still needs (as AuthGuard checks it): its store open, its account on, its password the same
    const ref = await this.core.shop({ id: Number(c.shop) });
    if (!ref || ref.shop.status === 'archived' || ref.shop.status === 'deleted') throw refused();
    const p = await core.profileById(ref.db, Number(c.sub));
    if (!p?.active || p.agencyId || (await tokenVersion(ref.db, p.id)) !== Number(c.tv ?? 0)) throw refused();
    await this.core.revoke(c.jti, new Date(c.exp * 1000));
    await ref.db.query("UPDATE profiles SET last_seen_at = now(), presence = 'online' WHERE id = $1", [p.id]);
    return { token: await this.signShop(ref, p.id), session: await this.core.withShop(core.makeSession(p), ref) };
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
  /** Shop domains are looked up on public DNS services first: the hosting DNS can keep old addresses (domainDns.ts). */
  private readonly domainDns = domainLookup();
  /** A name's TXT texts (the proof that a domain is the shop's: core.domainProof). */
  private resolveTxt = async (h: string) => (await this.domainDns.resolveTxt(h)).map((parts) => parts.join(''));
  /**
   * What the domain check asks: the TXT proof, then the site opened in HTTPS through the domain (domainEcho.ts), which
   * works straight to this server or through Cloudflare. 20 s: the first visit makes the certificate. The addresses
   * found are only shown to the owner.
   */
  private domainLook = (): core.DomainLookups => ({
    resolveTxt: this.resolveTxt,
    reaches: (d) => reachDomain(d, 20_000),
    resolve: (h) => this.domainDns.resolve4(h),
  });

  /** The shop's own domain: what it is, whether its DNS is ready, what to write at the domain's registrar. */
  @Post('shop/domain/get')
  async domainGet(@Req() req: ShopRequest) {
    const s = req.shop.shop;
    const ips = await this.serverIps();
    return {
      domain: s.domain,
      status: s.domainStatus,
      ips,
      host: this.platformHost(),
      primary: s.primary,
      // the TXT record that proves the domain is this shop's
      proof: s.domain ? { name: core.proofName(s.domain), value: core.domainProof(s.id, s.domain) } : null,
    };
  }

  /** Sets or removes the shop's own domain (its administrator), then checks its DNS at once. */
  @Post('shop/domain')
  async domainSet(@Body() body: any, @Req() req: ShopRequest) {
    if (!req.session.isAdmin) throw new core.AppError('forbidden', 'Réservé à l’administrateur');
    if (req.shop.shop.demo) throw new core.AppError('forbidden', 'Pas dans la boutique démo');
    // an unpaid (locked) store keeps its pages where they are
    if (req.shop.status.locked) throw new core.AppError('payment_required', core.SHOP_LOCKED);
    const want = body?.domain === null || body?.domain === '' ? null : String(body?.domain ?? '').slice(0, 260);
    try {
      await core.setShopDomain(this.core.t, req.shop.shop.id, want, this.platformHost());
    } catch (e) {
      if (e instanceof core.DomainError) throw new core.AppError('bad_request', e.message);
      throw e;
    }
    if (want) await core.checkShopDomain(this.core.t, req.shop.shop.id, this.domainLook());
    this.core.invalidate();
    // its landing pages get Cloudflare's robot check on the new domain (or the old one is taken out), in the background
    void syncTurnstile(this.core).catch(() => null);
    const ref = (await this.core.shop({ id: req.shop.shop.id }))!;
    const d = ref.shop.domain;
    return { domain: d, status: ref.shop.domainStatus, proof: d ? { name: core.proofName(d), value: core.domainProof(ref.shop.id, d) } : null };
  }

  /**
   * The browser watcher (web lib/watch): an error, a loop or a slow action on someone's screen, kept with the server's
   * own errors for Control room › Doctor (personal data hidden, the same problem grouped). At most 10 a send and 60
   * sends per 15 minutes per person: a broken screen never floods the server.
   */
  @Post('client-report')
  clientReport(@Body() body: any, @Req() req: ShopRequest) {
    const key = `client-report:${req.shop.shop.id}:${req.session.profile.id}`;
    checkLogin(key, 60);
    failedLogin(key);
    const items = ClientReports.safeParse(body);
    if (!items.success) throw new core.AppError('bad_request', 'Rapport illisible');
    const role = (req.session.roles ?? []).join('+') || '—';
    for (const r of items.data.items) {
      const what = r.kind === 'loop' ? 'Boucle' : r.kind === 'slow' ? 'Lent' : r.kind === 'cut' ? 'Coupure' : r.kind === 'door' ? 'Porte de secours' : 'Erreur';
      const source = r.kind === 'cut' ? 'Navigateur · coupures' : r.kind === 'door' ? 'Navigateur · porte de secours' : `Navigateur · ${r.page}`;
      doctorState.record(r.kind === 'error' || r.kind === 'loop' ? 'error' : 'warn', source, `[${req.shop.shop.slug}] ${what} : ${r.message} (${role}, ${r.device === 'phone' ? 'téléphone' : 'ordinateur'})`);
      // Doctor › Coupures: a cut that ended, or the opening of the backup door (a cut that began), with its internet company
      if ((r.kind === 'cut' || r.kind === 'door') && r.start !== undefined) {
        const seen = { start: r.start, end: r.kind === 'cut' ? (r.end ?? null) : null, shop: req.shop.shop.slug, device: r.device, page: r.page, roads: r.roads ?? null, via: r.kind };
        void recordCut(this.core, seen, req.ip).catch(() => null);
      }
    }
    return { ok: true };
  }

  /** « Vérifier »: does the domain point to this server now? (DNS changes take minutes to hours) */
  @Post('shop/domain/check')
  async domainCheck(@Req() req: ShopRequest) {
    const key = `domain:${req.shop.shop.id}`;
    checkLogin(key, 30);
    failedLogin(key);
    const r = await core.checkShopDomain(this.core.t, req.shop.shop.id, this.domainLook());
    this.core.invalidate();
    if (r.ok) void syncTurnstile(this.core).catch(() => null);
    return r;
  }

  /**
   * Caddy asks before getting an HTTPS certificate for a name: a ready domain of an active shop, or one still pending
   * whose TXT record already proves it is the shop's (the HTTPS test of « Vérifier » needs the certificate first).
   */
  @Public()
  @Get('domain-check')
  async domainAllowed(@Query('domain') domain: string, @Res() res: any) {
    // the backup door (direct.<platform>, deploy/Caddyfile): the same app without Cloudflare, its certificate made at its first visit
    const host = this.platformHost();
    const asked = String(domain ?? '').trim().toLowerCase();
    if (host && asked === `direct.${host}`) return res.status(200).send('ok');
    // the landing pages' own address (go.<platform>, LANDING_URL): its certificate made at its first visit too
    if (asked && asked === this.core.landingHost()) return res.status(200).send('ok');
    const id = await core.shopIdForCertificate(this.core.t, String(domain ?? ''), this.resolveTxt);
    return res.status(id ? 200 : 404).send(id ? 'ok' : 'unknown');
  }

  /**
   * The HTTPS test of a shop's own domain (domainEcho.ts): the server opens https://<domain>/api/domain-echo?n=<random>
   * through the domain and expects this answer, which only it can compute. On every name: the test reaches it before
   * the domain is ready. Never kept by a cache (Cloudflare or the browser).
   */
  @Public()
  @Get('domain-echo')
  domainEchoAnswer(@Query('n') n: string, @Req() req: { headers: Record<string, string | undefined> }, @Res() res: any) {
    if (!echoNonceOk(n)) return res.status(400).header('Cache-Control', 'no-store').send('bad');
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0];
    return res.status(200).header('Content-Type', 'text/plain; charset=utf-8').header('Cache-Control', 'no-store').send(domainEcho(host, n));
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
    // every public file of the pages (photos, videos, the catalogue's pictures, Dellal's photos): Meta downloads them
    if (page === 'robots.txt') return res.status(200).header('Content-Type', 'text/plain; charset=utf-8').send('User-agent: *\nAllow: /\nAllow: /api/lp/\nAllow: /api/s/*/lp/\nDisallow: /api/\n');
    const shop = intake(ref);
    if (!page) {
      // the boutique's website (Landing pages › Website) once it is published; else the simple list of its pages below.
      // ?lang=fr / ?lang=en: the same page in another of the site's languages. A service's site (Rendez-vous): ?s=<id>
      // chooses a session in the booking form, ?err=… says why the last booking was refused, ?billet=… is a ticket.
      const api = `${site}/api${ref.shop.primary ? '' : `/s/${ref.shop.slug}`}`;
      const q = String(req.url ?? '');
      const lang = /[?&]lang=(ar|fr|en)(?:&|$)/.exec(q)?.[1];
      const billet = /[?&]billet=([a-f0-9]{32})(?:&|$)/.exec(q)?.[1];
      const err = /[?&]err=(full|phone|name|closed|retry)(?:&|$)/.exec(q)?.[1];
      const pick = Number(/[?&]s=(\d{1,12})(?:&|$)/.exec(q)?.[1]) || undefined;
      const at = (l: string) => (billet ? `${site}/?billet=${billet}&lang=${l}` : `${site}/?lang=${l}`);
      const w: any = await this.core
        .call(shop, 'site.html', await this.core.systemSession(shop), {
          imgBase: `${api}/lp/img/`, base: '/', url: billet ? `${site}/?billet=${billet}` : `${site}/${lang ? `?lang=${lang}` : ''}`, ...(lang ? { lang } : {}),
          langHref: { ar: at('ar'), fr: at('fr'), en: at('en') },
          bookUrl: `${api}/site/book`, ...(err ? { err } : {}), ...(pick ? { pick } : {}), ...(billet ? { ticket: billet } : {}),
        })
        .catch(() => null);
      // a ticket carries a person's name: never kept by a cache
      if (w?.html) return sendText(req, res.status(200).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', billet || err ? 'private, no-store' : 'public, max-age=60'), w.html);
    }
    if (!page || page === 'llms.txt') {
      const r: any = await this.core.call(shop, 'landing.llms', await this.core.systemSession(shop), { site, pagesBase: `${site}/` });
      if (page === 'llms.txt') return sendText(req, res.status(200).header('Content-Type', 'text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=3600'), r.text);
      return sendText(req, res.status(200).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'public, max-age=300'), storeIndexHtml(r.text));
    }
    return this.sendLanding(shop, page, req, res, { api: `${site}/api${ref.shop.primary ? '' : `/s/${ref.shop.slug}`}`, url: `${site}/${page}` });
  }

  /**
   * A deeper address on a shop's own domain (https://myshop.com/product/28026: an old link from the site the domain came
   * from, in old posts and chats): the customer lands on the shop's home, never on an error; a file stays « not found »
   * (core.domainFallback). Caddy sends every path of the domain to /api/domain…; one part is domainPage's.
   */
  @Public()
  @Get('domain/*')
  async domainDeep(@Req() req: { url?: string; headers: Record<string, string | undefined> }, @Res() res: any) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    const id = await core.shopIdByDomain(this.core.t, host);
    const ref = id ? await this.core.shop({ id }) : null;
    const to = ref && ref.shop.status === 'active' ? core.domainFallback(String(req.url ?? '').replace(/^\/api\/domain(?=\/)/, '')) : null;
    if (!to) return res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Page introuvable');
    return toOwnPage(res, to);
  }

  /** /api/s/<store>/llms.txt: a shop's pages for AI assistants (the platform's /llms.txt links to every shop's). */
  @Public()
  @Get('s/:store/llms.txt')
  async storeLlms(@Param('store') store: string, @Req() req: { headers: Record<string, string | undefined> }, @Res() res: any) {
    const ref = await this.publicShop(store).catch(() => null);
    if (!ref || ref.shop.demo) return res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Boutique introuvable');
    const shop = intake(ref);
    const r: any = await this.core.call(shop, 'landing.llms', await this.core.systemSession(shop), { site: this.core.landingBase() });
    return sendText(req, res.status(200).header('Content-Type', 'text/plain; charset=utf-8').header('Cache-Control', 'public, max-age=3600'), r.text);
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
  /**
   * « Se déconnecter »: this device's session ends on the server too (its token is refused from now on, by the API and
   * the live updates). The person's other devices stay logged in. Always answers ok (an unknown or old token: nothing).
   */
  @Public()
  @Post('auth/logout')
  async logout(@Req() req: { headers?: Record<string, string | undefined> }) {
    const h = String(req.headers?.authorization || '');
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return { ok: true };
    try {
      const c = await this.jwt.verifyAsync<{ jti?: string; exp?: number; typ?: string }>(token);
      if (c.jti && !c.typ && c.exp) await this.core.revoke(String(c.jti), new Date(c.exp * 1000));
    } catch {
      // an old or broken token: nothing to end
    }
    return { ok: true };
  }

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
        // a link sent to the e-mail: the person's own password
        if (p) await core.propagateProfilePassword(this.core.t, ref.shop.schema, Number(p.id), 'self');
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
    return {
      open: set.signup.open && mailConfigured(),
      trialDays: set.trial.days,
      site: (config.publicUrl || '').replace(/^https?:\/\//, ''),
      // the « Besoin d'aide ? WhatsApp » link of the sign-in pages
      whatsapp: (set.payment.whatsapp || set.company.phone || '').trim(),
      // the sign-in page designs turned on in the control room (one is drawn at random on each visit)
      designs: [...new Set(set.login.designs)].filter((n) => n >= 1 && n <= 20),
      // « Continuer avec Google » (public id; empty: no button)
      // the sign-up form asks the WhatsApp code of the number (control room › Réglages › Code WhatsApp)
      phoneCode: await otpOn(this.core),
      googleClientId: set.social.googleClientId,
    };
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
    const m = await core.startSignup(this.core.t, body, core.expandIp(req.ip || ''), Date.now(), { otp: await otpOn(this.core) });
    if (m) sendLater(m.kind === 'confirm' ? signupConfirmMail(m) : signupExistsMail(m), 'Sign-up');
    return { ok: true };
  }

  /**
   * While a phone is typed (sign-up form, « Votre numéro »): « invalid » (not a mobile), « taken » (another account's), or
   * free. With the login's ticket, the person's own number is free for them. 60 per 15 minutes per address.
   */
  @Public()
  @Post('auth/phone-check')
  async phoneCheck(@Body() body: any, @Req() req: { ip?: string }) {
    const ipKey = `phonecheck:${ipOf(req)}`;
    checkLogin(ipKey, 60);
    failedLogin(ipKey);
    const acc = body?.ticket ? await this.ticketAccount(String(body.ticket)).catch(() => null) : null;
    if (acc) {
      // and 30 per 15 minutes per account, whatever the address
      const accKey = `phonecheck:acc:${acc.id}`;
      checkLogin(accKey, 30);
      failedLogin(accKey);
    }
    const r = await core.phoneProblem(this.core.t, String(body?.phone ?? '').slice(0, 30), acc?.id ?? null);
    // « another account's » only to a person who logged in (the ticket): to anyone else, the same answer as a free
    // number (the sign-up form cannot be used to learn which numbers have a Pilotix account)
    return acc ? r : { ...r, problem: r.problem === 'taken' ? null : r.problem };
  }

  /**
   * « Recevoir le code » in the sign-up form: a WhatsApp code to the number typed (nobody's yet), proven before the
   * account exists. 10 per 15 minutes per address; 1 a minute and 5 an hour per number.
   */
  @Public()
  @Post('auth/signup/code')
  async signupCode(@Body() body: any, @Req() req: { ip?: string }) {
    const ipKey = `signupcode:${ipOf(req)}`;
    checkLogin(ipKey, 10);
    failedLogin(ipKey);
    if (!(await otpOn(this.core))) throw new core.AppError('bad_request', 'Pas de code à recevoir : continuez');
    const c = await core.newSignupCode(this.core.t, String(body?.phone ?? '').slice(0, 30));
    try {
      await sendOtp(this.core, c.phone, c.code);
    } catch (e) {
      await core.dropPhoneCode(this.core.t, c.id);
      throw new core.AppError('bad_request', (e as Error).message);
    }
    return { sent: true, phone: c.phone, masked: maskPhone(c.phone), wait: Math.round(core.PHONE_CODE.gapMs / 1000), ttl: Math.round(core.PHONE_CODE.ttlMs / 1000) };
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
    if (r.shop) this.core.invalidate();
    if (r.shop) void this.toldReferrer(r.shop.id);
    // the number's WhatsApp code first (when it is on); then the new store, or (account-only sign-up) the picker where
    // the person creates their first store
    return this.proceed(r.account, r.shop?.id);
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
    void this.toldReferrer(shop.id);
    // « Commencer avec les réglages de … »: one of the person's own boutiques; a failed copy never stops the new one
    // (the app says so: « Copier des réglages » in « Mes boutiques » does it again)
    const from = Number((body as { copyFrom?: unknown } | null)?.copyFrom) || 0;
    let copied: boolean | null = null;
    if (from && shop.kind === 'store') {
      try {
        await core.copyIntoNewBoutique(this.core.t, acc, from, shop);
        copied = true;
      } catch (e: any) {
        copied = false;
        new Logger('Boutiques').warn(`[${shop.slug}] settings not copied from shop ${from}: ${e?.message ?? e}`);
      }
    }
    return { ...(await this.enter(shop.id, acc.email)), copied };
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

  /**
   * The terms of use and privacy page: Pilotix's own text when it wrote one (else the app's standard text), and the
   * company that publishes Pilotix (control room › Réglages › Société: its legal name, its name in Arabic for the pages
   * in Arabic, address, phone and tax number), shown on that page and under the login page, the way Meta checks a
   * business against its papers.
   */
  @Public()
  @Get('legal')
  async legal() {
    const set = await this.core.settings();
    const c = set.company;
    return { text: set.legal.text, company: c.name, companyAr: c.nameAr ?? '', email: c.email, address: c.address, phone: c.phone, taxId: c.taxId };
  }

  /**
   * The phone app (mobile/): the latest app GitHub made and the oldest build still allowed (control room › App Android ›
   * « Mise à jour obligatoire »). The app's pages ask it to offer « Nouvelle version de l'app ». Open to everyone: nothing
   * in it is private.
   */
  @Public()
  @Get('app')
  async app() {
    const [latest, set] = await Promise.all([core.latestApp(), this.core.settings()]);
    return { latest, minBuild: set.app.minBuild };
  }

  /**
   * Pilotix's list of Pro marketers, open to everyone (the public page #/pro): their cards, the best rate first. Kept a
   * minute (each card's numbers are counted again only every few hours).
   */
  private static prosCache: { at: number; p: Promise<ProCard[]> } | null = null;
  @Public()
  @Get('pro')
  async pros() {
    if (!ApiController.prosCache || Date.now() - ApiController.prosCache.at > 60_000) {
      const p = core.listPros(this.core.t, Date.now());
      ApiController.prosCache = { at: Date.now(), p };
      p.catch(() => (ApiController.prosCache = null));
    }
    return { pros: await ApiController.prosCache.p };
  }

  /** One Pro marketer's card by its code (MK-7K2Q): its public page (#/pro/MK-7K2Q). */
  @Public()
  @Get('pro/:code')
  async pro(@Param('code') code: string) {
    const c = await core.proByCode(this.core.t, String(code ?? '').slice(0, 20), Date.now());
    if (!c) throw new HttpException({ message: 'Aucun marketer Pro avec ce code' }, 404);
    return c;
  }

  /**
   * A photo or video of the shop's library: the Planner's (CM AI agent), else Pilot Ads' own (its ads' photos and
   * videos, for a plan with Publicité and no Planner). The first the shop's plan allows that knows it answers.
   */
  private async mediaFile(ref: ShopRef, kind: 'video' | 'image', input: Record<string, unknown>): Promise<unknown> {
    const session = await this.core.systemSession(ref);
    let last: unknown = new core.AppError('not_found', 'Introuvable');
    for (const name of kind === 'video' ? ['cm.plan.videoFile', 'ads.media.videoFile'] : ['cm.plan.image', 'ads.media.image']) {
      if (!core.shopAllows(ref.rules, name).ok) continue;
      try {
        return await this.core.call(ref, name, session, input);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  /**
   * A piece of a planned post's video (CM AI agent › Planner): the original file's bytes, 8 MB at a time
   * (application/octet-stream), after cm.plan.videoStart and before cm.plan.videoDone.
   */
  @Put('cm/video/:id/:key')
  async videoPart(@Param('id') idp: string, @Param('key') key: string, @Query('part') part: string, @Body() body: unknown, @Req() req: ShopRequest) {
    if (!/^\d+$/.test(idp) || !/^[a-f0-9]{24}$/.test(key) || !/^\d{1,4}$/.test(String(part ?? ''))) throw new core.AppError('not_found', 'Vidéo inconnue');
    if (!Buffer.isBuffer(body) || !body.length) throw new core.AppError('bad_request', 'Morceau de vidéo vide');
    if (req.shop.shop.demo) throw new core.AppError('forbidden', 'Pas dans la boutique démo');
    // the Planner's videos, or Pilot Ads' (a plan with Publicité and no Planner)
    const allowed = core.shopAllows(req.shop.rules, 'cm.plan.videoStart');
    if (!allowed.ok && !core.shopAllows(req.shop.rules, 'ads.media.videoStart').ok) throw allowed.error;
    if (!core.hasRole(req.session, 'marketer')) throw new core.AppError('forbidden', 'Accès refusé');
    const v: any = await this.mediaFile(req.shop, 'video', { id: Number(idp), key });
    if (v.ready) return { received: v.size };
    return writePart(req.shop.shop.schema, { id: Number(idp), key, ext: v.ext, size: v.size, chunk: v.chunk }, Number(part), body);
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
    if (name === 'me.referrals' && !req.shop.shop.demo) {
      // Referral › Referral is the owner's: the store's administrators
      if (!req.session.isAdmin) throw new core.AppError('forbidden', 'Réservé à l’administrateur de la boutique');
      return this.referrals(req);
    }
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
      // chosen in Mon profil: whoever chose the old one decides (only a link sent to the e-mail makes it the person's own)
      await core.propagateProfilePassword(this.core.t, req.shop.shop.schema, req.session.profile.id, 'keep');
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
      // the e-mail it has now, and the one it gets (an e-mail changed in the same request)
      const old = (await req.shop.db.query('SELECT email FROM profiles WHERE id = $1', [target]))[0]?.email as string | undefined;
      const next = typeof body?.email === 'string' && body.email.trim() ? body.email.trim().toLowerCase() : undefined;
      for (const email of [old, next])
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
    // a password the store's admin chose: it opens this seller's stores only
    if (name === 'users.update' && body?.id) {
      if (body.email) await core.attachProfile(t, schema, Number(body.id));
      if (body.password) await core.propagateProfilePassword(t, schema, Number(body.id), 'admin');
    }
    if (name === 'admin.users.resetPassword' && body?.id) await core.propagateProfilePassword(t, schema, Number(body.id), 'admin');
    return out;
  }

  /** Referral › Referral: the store's code, its link, and the stores it brought (the free months earned and used). */
  private async referrals(req: ShopRequest) {
    const r = await core.storeReferrals(this.core.t, req.shop.shop.id);
    const friends = r.list.map((x, i) => ({
      id: i + 1,
      name: x.name,
      email: null as string | null,
      shop: x.stage === 'started' ? null : x.name,
      status: (x.stage === 'paying' ? 'subscribed' : x.stage === 'signed_up' ? 'signed_up' : 'invited') as 'invited' | 'signed_up' | 'subscribed',
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
      totals: {
        invited: friends.length,
        signedUp: friends.filter((f) => f.status !== 'invited').length,
        subscribed: sub.length,
        cashEarned: 0,
        cashPaid: 0,
        cashPending: 0,
        months: r.earned,
        monthsUsed: r.used,
        monthsLeft: r.left,
      },
      platform: true,
      on: r.on,
      link: r.code && config.publicUrl ? `${config.publicUrl}/signup?ref=${r.code}` : null,
    };
  }

  /** Referral: a store just signed up with another one's link: that one is told (e-mail + its admins' phones), once. */
  private async toldReferrer(shopId: number) {
    try {
      const n = await core.referralSignupNotice(this.core.t, shopId);
      if (!n) return;
      const set = await core.platformSettings(this.core.t);
      const months = set.referral.on ? set.referral.months : 0;
      if (n.to) sendLater(referralSignupMail({ to: n.to, name: n.name, language: n.language, shop: n.shop, friend: n.friend, months }), 'Referral');
      await core.pushShopAdmins(this.core.t, { push: webPush, pushKeys: webPushKeys, ...fcmHooks() }, n.referrerShopId, {
        title: '🎉 Parrainage',
        body: `« ${n.friend} » s’est inscrite avec votre lien${months ? ` : ${months} mois offert${months > 1 ? 's' : ''} à son premier paiement` : ''}.`,
        url: '#/parrainage',
        tag: `referral-${shopId}`,
      });
    } catch (e: any) {
      new Logger('Referral').warn(`notice for store ${shopId} failed: ${e?.message ?? e}`);
    }
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
      // its code now, else a code it had before (a code changed in Pilotix while the site still sends the old one)
      const hit = await core.findBySku(db, sku);
      if (!hit) {
        if (ch?.sku_required) throw new core.AppError('bad_request', `SKU inconnu : ${sku}`);
        continue;
      }
      items.push({ productId: hit.productId, variantId: hit.variantId, qty: Math.max(1, Number(it.qty) || 1), unitPrice: it.price !== undefined ? Math.round(Number(it.price)) : undefined });
    }
    if (!items.length) throw new core.AppError('bad_request', 'Aucun produit reconnu (vérifiez les SKU)');
    const phone = normalizePhone(String(body?.phone ?? ''));
    if (!phone) throw new core.AppError('bad_request', 'Téléphone invalide');
    const session = await this.core.systemSession(ref);
    const order: any = await this.core.call(ref, 'orders.create', session, {
      via: 'api',
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
  private async sendLanding(ref: ShopRef, slug: string, req: { url?: string; headers: Record<string, string | undefined> }, res: any, own?: { api: string; url: string }) {
    // on the shop's own domain (own), a page that is not there (an old link, a page taken offline) leads to its home
    const missing = () => {
      const to = own ? core.domainFallback(`/${slug}`) : null;
      return to ? toOwnPage(res, to) : res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Page introuvable');
    };
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) return missing();
    try {
      // a page calls the address it was opened at: the shop's own domain (Caddy forwards /api), the pages' own address
      // (go.<domain>, whose /api/lp Caddy forwards too) or the app's site. No other site involved, nothing cross-site.
      const atPages = !!this.core.landingHost() && hostOf(req) === this.core.landingHost();
      const base = `${own?.api ?? apiOf(ref, atPages ? config.landingUrl : config.publicUrl)}/lp/`;
      // opened from a group page (?g=<group>): the product page shows « back to all the products »
      const g = /[?&]g=([a-z0-9-]{2,60})(?:&|$)/.exec(String(req.url ?? ''))?.[1];
      // serving the page counts nothing (Facebook loads an ad's page before the tap; robots and link previews ask for
      // pages too): the page itself says when it is in front of a person (« …/seen », landingSeen below)
      const robot = isRobot(req);
      // a unique visitor (Landing pages › conversion): the browser's anonymous code, kept a year in a cookie of the
      // page's own address (no name, no number, nothing else in it); robots get none and are not counted
      const had = visitorCode(req);
      const visitor = robot ? undefined : (had ?? randomBytes(10).toString('hex'));
      // a team browser (it sent a test: Réglages › « Team et fournisseurs »): no pixel, its visit counts nowhere
      const team = teamBrowser(req);
      const r: any = await this.core.call(ref, 'landing.html', await this.core.systemSession(ref), {
        slug, mode: 'live', post: `${base}${slug}/order`, lead: `${base}${slug}/lead`, seen: `${base}${slug}/seen`, me: `${base}${slug}/me`, geo: `${base}geo/`, imgBase: `${base}img/`, site: atPages ? config.landingUrl : this.core.landingBase(), ...(own ? { url: own.url } : {}), ...(g ? { group: g } : {}),
        ...(team ? { team: true } : {}),
      });
      res.status(200).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store');
      if (visitor && !had) res.header('Set-Cookie', visitorCookie(visitor));
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
    // a boutique's former link (« Mes boutiques »: its link changed): its pages moved to the new one
    const moved = core.SLUG_RE.test(store) && !(await this.core.shop({ slug: store }).catch(() => null)) ? await this.core.movedShop(store).catch(() => null) : null;
    if (moved && moved.shop.status === 'active' && /^[a-z0-9-]{2,60}$/.test(slug)) return this.movePage(res, moved.shop.slug, slug, req);
    const ref = await this.core.fromParam(store).then((r) => r && this.core.forPublic(r)).catch(() => null);
    if (ref) {
      // a suspended or closed shop: its pages are gone
      if (ref.shop.status !== 'active') return res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Page introuvable');
      // the pages live at their own address (go.<domain>): never on the app's (the links in ads follow)
      if (this.offPages(req) && /^[a-z0-9-]{2,60}$/.test(slug)) return this.movePage(res, store, slug, req);
      return this.sendLanding(intake(ref), slug, req, res);
    }
    const p = await this.core.primary();
    const r: any = await this.core.call(p, 'landing.store', await this.core.systemSession(p), {});
    if ((store !== r.store || this.offPages(req)) && /^[a-z0-9-]{2,60}$/.test(slug)) return this.movePage(res, r.store, slug, req);
    return this.sendLanding(p, slug, req, res);
  }

  /**
   * The editor's preview of a page (inside the app): a blank page that shows the HTML the app sends it. The app's own
   * pages only run Pilotix's scripts (Content-Security-Policy), so the page's scripts run here instead: in a frame of
   * its own, sandboxed (no access to the app, its storage or its session), whether it is framed or opened directly.
   */
  @Public()
  @Get('lp/preview-host')
  previewHost(@Res() res: any) {
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>' +
      '<script>addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||typeof d.lpHtml!=="string")return;document.open();document.write(d.lpHtml);document.close()});parent.postMessage({lpHost:1},"*")</script></body></html>';
    return res
      .status(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'public, max-age=3600')
      .header('Content-Security-Policy', 'sandbox allow-scripts allow-forms')
      .header('X-Content-Type-Options', 'nosniff')
      .send(html);
  }

  /** The first addresses of the pages (links already in ads keep working; the page names site/<store>/<page> as its own). */
  @Public()
  @Get(['lp/:slug', 's/:shop/lp/:slug'])
  async landingPage(@Param('shop') shop: string | undefined, @Param('slug') slug: string, @Req() req: { url?: string; headers: Record<string, string | undefined> }, @Res() res: any) {
    const ref = await this.publicShop(shop).catch(() => null);
    if (!ref) return res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Page introuvable');
    // an old address on the app's site: the page at its own address (go.<domain>/<store>/<page>)
    if (this.offPages(req) && /^[a-z0-9-]{2,60}$/.test(slug)) {
      // the store's part of the address: a platform shop's name, or the one shop #1 chose in Réglages
      const store = ref.shop.primary ? String(((await this.core.call(ref, 'landing.store', await this.core.systemSession(ref), {})) as any).store) : ref.shop.slug;
      return this.movePage(res, store, slug, req);
    }
    return this.sendLanding(intake(ref), slug, req, res);
  }

  /** The pages have their own address now, and this request came to another one (the app's site, its backup door). */
  private offPages(req: { headers: Record<string, string | undefined> }): boolean {
    return this.core.landingReady() && hostOf(req) !== this.core.landingHost();
  }

  /** A page's address now (its store's current link, at the pages' address), what followed it kept (?fbclid=…). */
  private movePage(res: any, store: string, slug: string, req: { url?: string }) {
    return res.status(301).header('Location', `${this.core.landingBase()}/${store}/${slug}${queryOf(req)}`).header('Cache-Control', 'no-store').send();
  }

  /** Answers « yes » only at the pages' own address: the server checks with it that go.<domain> really reaches it. */
  @Public()
  @Get('landing-ready')
  landingReadyCheck(@Req() req: { headers: Record<string, string | undefined> }) {
    return { landing: !!this.core.landingHost() && hostOf(req) === this.core.landingHost() };
  }

  /** /llms.txt (Caddy sends it here): shop #1 and its live landing pages, for AI assistants (cached an hour). */
  @Public()
  @Get('llms.txt')
  async llmsTxt(@Req() req: { headers: Record<string, string | undefined> }, @Res() res: any) {
    const p = await this.core.primary();
    const r: any = await this.core.call(p, 'landing.llms', await this.core.systemSession(p), { site: this.core.landingBase() });
    // the other shops of the server: each one's own list (its pages, prices, descriptions)
    const others = [];
    for (const s of await core.loadShops(this.core.t)) {
      if (s.primary || s.demo || s.status !== 'active') continue;
      const ref = await this.core.shop({ id: s.id });
      if (ref && !ref.status.locked) others.push(`- [${s.name.replace(/[[\]\\]/g, '')}](${this.core.landingBase()}/api/s/${s.slug}/llms.txt)`);
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

  /**
   * An HD product photo on the landing pages: /lp/hd/<photo>/<160|480|720|960>-<tag>.webp, a light copy the server makes
   * the first time and keeps. A photo never changes under its address (a new photo is a new one): cached a year.
   */
  @Public()
  @Get(['lp/hd/:id/:file', 's/:shop/lp/hd/:id/:file'])
  async landingHdPhoto(@Param('shop') shop: string | undefined, @Param('id') idp: string, @Param('file') file: string, @Res() res: any) {
    const m = file.match(/^(160|480|720|960)-([a-z0-9]{1,12})\.webp$/);
    if (!/^\d{1,12}$/.test(idp) || !m) return res.status(404).send();
    try {
      const ref = intake(await this.publicShop(shop));
      const r: any = await this.core.call(ref, 'landing.hdPhoto', await this.core.systemSession(ref), { id: Number(idp), w: Number(m[1]), tag: m[2] });
      if (!r) return res.status(404).send();
      const cache = r.type === 'image/webp' ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
      return res.status(200).header('Content-Type', r.type).header('Cache-Control', cache).send(Buffer.from(r.base64, 'base64'));
    } catch {
      return res.status(404).send();
    }
  }

  /**
   * A product's photo on its landing pages: /lp/pp/<product>/<m|v<variant>>-<version>.<ext> (m: its main photo, v: a
   * variant's). The version changes with the photo, so browsers keep it a year.
   */
  @Public()
  @Get(['lp/pp/:id/:file', 's/:shop/lp/pp/:id/:file'])
  async landingProductPhoto(@Param('shop') shop: string | undefined, @Param('id') idp: string, @Param('file') file: string, @Res() res: any) {
    const m = file.match(/^(m|v\d{1,12})-[a-z0-9]{1,20}\.(jpg|png|webp|gif)$/);
    if (!/^\d{1,12}$/.test(idp) || !m) return res.status(404).send();
    try {
      const ref = intake(await this.publicShop(shop));
      const r: any = await this.core.call(ref, 'landing.productPhoto', await this.core.systemSession(ref), { productId: Number(idp), key: m[1] });
      if (!r) return res.status(404).send();
      return res.status(200).header('Content-Type', r.type).header('Cache-Control', 'public, max-age=31536000, immutable').send(Buffer.from(r.base64, 'base64'));
    } catch {
      return res.status(404).send();
    }
  }

  /**
   * The tab's icon of the shop's pages: /lp/icon/<version>, the shop's logo, or the Pilotix icon when it has none. The
   * version changes with the logo, so the browser keeps it a long time.
   */
  @Public()
  @Get(['lp/icon/:v', 's/:shop/lp/icon/:v'])
  async landingIcon(@Param('shop') shop: string | undefined, @Param('v') v: string, @Res() res: any) {
    if (!/^[a-z0-9]{1,20}$/.test(v)) return res.status(404).send();
    const pilotix = () => res.status(200).header('Content-Type', 'image/svg+xml').header('Cache-Control', 'public, max-age=604800').send(PILOTIX_ICON_SVG);
    try {
      const ref = intake(await this.publicShop(shop));
      const r: any = await this.core.call(ref, 'landing.icon', await this.core.systemSession(ref), {});
      if (!r) return pilotix();
      return res.status(200).header('Content-Type', r.type).header('Cache-Control', 'public, max-age=604800').send(Buffer.from(r.base64, 'base64'));
    } catch {
      return pilotix();
    }
  }

  /** A page's picture in WebP: /lp/img/<id>/<160|320|480|720|960>.webp (never changes: cached a year), and meta.jpg its JPEG copy for Meta's catalog. */
  @Public()
  @Get(['lp/img/:id/:file', 's/:shop/lp/img/:id/:file'])
  async landingImage(@Param('shop') shop: string | undefined, @Param('id') idp: string, @Param('file') file: string, @Res() res: any) {
    const m = file.match(/^(160|320|480|720|960)\.webp$/);
    // Marketing › Catalogue: the JPEG copy Meta downloads (/lp/img/<id>/meta.jpg)
    if (/^\d+$/.test(idp) && file === 'meta.jpg') {
      try {
        const ref = intake(await this.publicShop(shop));
        const r: any = await this.core.call(ref, 'metacatalog.image', await this.core.systemSession(ref), { id: Number(idp) });
        return res.status(200).header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=31536000, immutable').send(Buffer.from(r.base64, 'base64'));
      } catch {
        return res.status(404).send();
      }
    }
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
   * A planned post's video (CM AI agent › Planner), downloaded by Meta when the post goes out and played in the editor:
   * /lp/vid/<id>/<key>.mp4 (or .mov), the original file, with byte ranges. The random key keeps it unguessable.
   */
  @Public()
  @Get(['lp/vid/:id/:file', 's/:shop/lp/vid/:id/:file'])
  async planVideo(@Param('shop') shop: string | undefined, @Param('id') idp: string, @Param('file') file: string, @Req() req: { headers: Record<string, string | undefined> }, @Res() res: any) {
    const m = file.match(/^([a-f0-9]{24})\.(mp4|mov)$/);
    if (!/^\d+$/.test(idp) || !m) return res.status(404).send();
    try {
      const ref = intake(await this.publicShop(shop));
      const v: any = await this.mediaFile(ref, 'video', { id: Number(idp), key: m[1] });
      if (!v.ready || v.ext !== m[2]) return res.status(404).send();
      return await sendVideo(ref.shop.schema, { id: Number(idp), key: m[1], ext: v.ext, mime: v.mime }, req.headers.range, res);
    } catch {
      return res.status(404).send();
    }
  }

  /**
   * AI Spy: a competitor's video Pilotix keeps (the ads of a followed shop, the ads a person tagged), played in AI Spy:
   * /lp/spyvid/<key>.mp4, with byte ranges. The random key keeps it unguessable; it never changes.
   */
  @Public()
  @Get(['lp/spyvid/:file', 's/:shop/lp/spyvid/:file'])
  async spyVideo(@Param('shop') shop: string | undefined, @Param('file') file: string, @Req() req: { headers: Record<string, string | undefined> }, @Res() res: any) {
    const m = file.match(/^([a-f0-9]{24})\.mp4$/);
    if (!m) return res.status(404).send();
    try {
      const ref = intake(await this.publicShop(shop));
      return await sendSpyVideo(ref.shop.schema, m[1], req.headers.range, res);
    } catch {
      return res.status(404).send();
    }
  }

  /**
   * A planned post's photo (CM AI agent › Planner), downloaded by Meta when the post goes out: /lp/pic/<id>/<key>.jpg, and
   * /lp/pic/<id>/<key>-s.jpg its small copy (the calendar). The random key keeps it unguessable; it never changes.
   */
  @Public()
  @Get(['lp/pic/:id/:file', 's/:shop/lp/pic/:id/:file'])
  async planPhoto(@Param('shop') shop: string | undefined, @Param('id') idp: string, @Param('file') file: string, @Res() res: any) {
    const m = file.match(/^([a-f0-9]{24})(-s)?\.jpg$/);
    if (!/^\d+$/.test(idp) || !m) return res.status(404).send();
    try {
      const ref = intake(await this.publicShop(shop));
      const r: any = await this.mediaFile(ref, 'image', { id: Number(idp), key: m[1], small: !!m[2] });
      return res.status(200).header('Content-Type', 'image/jpeg').header('Cache-Control', 'public, max-age=31536000, immutable').send(Buffer.from(r.base64, 'base64'));
    } catch {
      return res.status(404).send();
    }
  }

  /**
   * A product photo Dellal sends to a customer, downloaded by Meta (WhatsApp, Messenger, Instagram): /lp/dp/<id>/<key>.jpg.
   * The random key keeps it unguessable; a picture's JPEG never changes (cached a year).
   */
  @Public()
  @Get(['lp/dp/:id/:file', 's/:shop/lp/dp/:id/:file'])
  async dellalPhoto(@Param('shop') shop: string | undefined, @Param('id') idp: string, @Param('file') file: string, @Res() res: any) {
    const m = file.match(/^([a-f0-9]{24})\.jpg$/);
    if (!/^\d+$/.test(idp) || !m) return res.status(404).send();
    try {
      const ref = intake(await this.publicShop(shop));
      const r: any = await this.core.call(ref, 'dellal.photoFile', await this.core.systemSession(ref), { id: Number(idp), key: m[1] });
      const type = /^image\/(jpeg|png)$/.test(String(r.mime)) ? String(r.mime) : 'image/jpeg';
      return res.status(200).header('Content-Type', type).header('Cache-Control', 'public, max-age=31536000, immutable').send(Buffer.from(r.base64, 'base64'));
    } catch {
      return res.status(404).send();
    }
  }

  /**
   * « Envoyer des photos » (Confirmation): the page a customer opens from the agent's WhatsApp message (and WhatsApp reads
   * for its preview: the first photo): /lp/ph/<id>/<key>. The random key keeps it unguessable; the shop's name and the
   * products' photos only. Plain HTML: nothing runs, only the photos load.
   */
  @Public()
  @Get(['lp/ph/:id/:key', 's/:shop/lp/ph/:id/:key'])
  async photoPage(@Param('shop') shop: string | undefined, @Param('id') idp: string, @Param('key') key: string, @Req() req: { headers: Record<string, string | undefined> }, @Res() res: any) {
    if (!/^\d{1,15}$/.test(idp) || !/^[a-f0-9]{24}$/.test(key)) return res.status(404).send();
    try {
      const ref = intake(await this.publicShop(shop));
      const p: any = await this.core.call(ref, 'photos.page', await this.core.systemSession(ref), { id: Number(idp), key });
      return sendText(
        req,
        res
          .status(200)
          .header('Content-Type', 'text/html; charset=utf-8')
          .header('Cache-Control', 'public, max-age=300')
          .header('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
          .header('X-Robots-Tag', 'noindex, nofollow')
          .header('Referrer-Policy', 'no-referrer'),
        core.photoPageHtml(p),
      );
    } catch {
      return res.status(404).header('Content-Type', 'text/plain; charset=utf-8').send('Page introuvable');
    }
  }

  /**
   * An order from a page. The answer is the same whether the order passed or was blocked as fake (the customer must not
   * be able to tell); only a page that does not exist (404) or a server failure (500, the page asks to try again) differ.
   */
  @Public()
  @Post(['lp/:slug/order', 's/:shop/lp/:slug/order'])
  async landingOrder(
    @Param('shop') shop: string | undefined,
    @Param('slug') slug: string,
    @Body() body: any,
    @Req() req: { ip?: string; headers: Record<string, string | undefined> },
    @Res({ passthrough: true }) res: any,
  ) {
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) throw new core.AppError('not_found', 'Page introuvable');
    const ref = intake(await this.publicShop(shop));
    const start = Date.now();
    let team = false;
    // a post from another site, or a flood from one address: the same answer, nothing done
    if (!crossSite(req) && !limitLanding(req.ip || 'unknown', 'order', 30)) {
      const r: any = await this.core.call(ref, 'landing.submit', await this.core.systemSession(ref), { ...(body && typeof body === 'object' ? body : {}), slug, meta: visitorMeta(req) });
      team = !!r?.team;
      noteSubmit(Date.now() - start);
    }
    // the answer never comes faster for a blocked order than for a real one (its timing would tell a fraudster)
    await new Promise((r) => setTimeout(r, Math.max(0, orderFloor() + Math.floor(Math.random() * 200) - (Date.now() - start))));
    // a team test (Réglages › « Team et fournisseurs »): this browser is the team's, its next visits fire no pixel and
    // count nowhere (the answer itself stays the same)
    if (team) res.header('Set-Cookie', TEAM_COOKIE);
    return { ok: true };
  }

  /**
   * A booking from the website's Sessions block (Rendez-vous). A plain form (the live site has no script): the answer is a
   * redirect, to the ticket (/?billet=…) or back to the form with the reason. A robot gets the home page and nothing is
   * done: the hidden field filled, no time or a time too short, a post from another site; too many from one address wait.
   */
  @Public()
  @Post(['site/book', 's/:shop/site/book'])
  async siteBook(@Param('shop') shop: string | undefined, @Body() body: any, @Req() req: { ip?: string; headers: Record<string, string | undefined> }, @Res() res: any) {
    const b = body && typeof body === 'object' ? body : {};
    const lang = ['ar', 'fr', 'en'].includes(String(b.lang)) ? String(b.lang) : '';
    const L = lang ? `&lang=${lang}` : '';
    const go = (to: string) => res.status(303).header('Location', to).header('Cache-Control', 'no-store').send('');
    const t = Number(b.t);
    const age = Date.now() - t;
    if (crossSite(req) || String(b.website ?? '') !== '' || !Number.isFinite(t) || age < 1500 || age > 7 * 86_400_000) return go('/');
    const sessionId = Math.max(0, Math.trunc(Number(b.session)) || 0);
    if (limitLanding(req.ip || 'unknown', 'book', 12)) return go(`/?err=retry&s=${sessionId}${L}#reserver`);
    const ref = await this.core.fromParam(shop).then((r) => r && this.core.forPublic(r)).catch(() => null);
    if (!ref || ref.shop.status !== 'active') return go('/');
    const r = intake(ref);
    const out: any = await this.core
      .call(r, 'site.book', await this.core.systemSession(r), {
        sessionId,
        name: String(b.name ?? '').slice(0, 200),
        phone: String(b.phone ?? '').slice(0, 40),
        seats: Math.trunc(Number(b.seats)) || 1,
        ...(lang ? { lang } : {}),
        ip: core.expandIp(req.ip || '').slice(0, 80),
      })
      .catch(() => null);
    if (out?.ok && out.token) return go(`/?billet=${out.token}${L}`);
    return go(`/?err=${/^(full|phone|name|closed)$/.test(String(out?.reason)) ? out.reason : 'retry'}&s=${sessionId}${L}#reserver`);
  }

  /** Referral › Code promo: the page's « code » field (does it work, what it takes off). 20 checks per 10 minutes per address. */
  @Public()
  @Post(['lp/:slug/code', 's/:shop/lp/:slug/code'])
  async landingCode(@Param('shop') shop: string | undefined, @Param('slug') slug: string, @Body() body: any, @Req() req: { ip?: string; headers: Record<string, string | undefined> }) {
    if (!/^[a-z0-9-]{2,60}$/.test(slug) || crossSite(req) || limitLanding(req.ip || 'unknown', 'code', 20)) return { ok: false, reason: 'unknown' };
    const ref = await this.core.fromParam(shop).then((r) => r && this.core.forPublic(r)).catch(() => null);
    if (!ref || ref.shop.status !== 'active') return { ok: false, reason: 'unknown' };
    const b = body && typeof body === 'object' ? body : {};
    return this.core
      .call(intake(ref), 'landing.code', await this.core.systemSession(intake(ref)), { slug, code: String(b.code ?? '').slice(0, 30), total: Math.max(0, Math.min(100_000_000, Math.round(Number(b.total) || 0))) })
      .catch(() => ({ ok: false, reason: 'unknown' }));
  }

  /** « Offers on WhatsApp » ticked on the thank-you screen. Same answer whatever happens. */
  @Public()
  @Post(['lp/:slug/optin', 's/:shop/lp/:slug/optin'])
  async landingOptin(@Param('shop') shop: string | undefined, @Param('slug') slug: string, @Body() body: any, @Req() req: { ip?: string; headers: Record<string, string | undefined> }) {
    if (!/^[a-z0-9-]{2,60}$/.test(slug) || crossSite(req) || limitLanding(req.ip || 'unknown', 'optin', 30)) return { ok: true };
    const ref = await this.core.fromParam(shop).then((r) => r && this.core.forPublic(r)).catch(() => null);
    if (!ref || ref.shop.status !== 'active') return { ok: true };
    const r = intake(ref);
    const b = body && typeof body === 'object' ? body : {};
    await this.core.call(r, 'landing.optin', await this.core.systemSession(r), { slug, ch: String(b.ch ?? ''), phone: String(b.phone ?? '') }).catch(() => null);
    return { ok: true };
  }

  /**
   * A client coming back to the shop's pages: the page keeps a mark that this device ordered here (no name, no number)
   * and asks here about it. If that order was confirmed by an agent, the answer carries the client's scrambled details
   * for the shop's own pixels (Meta's advanced matching, landing.me); a fake, blocked or not yet confirmed order, a team
   * browser, a post from another site or a flood: the plain answer anyone gets.
   */
  @Public()
  @Post(['lp/:slug/me', 's/:shop/lp/:slug/me'])
  async landingMe(@Param('shop') shop: string | undefined, @Param('slug') slug: string, @Body() body: any, @Req() req: { ip?: string; headers: Record<string, string | undefined> }) {
    if (!/^[a-z0-9-]{2,60}$/.test(slug)) return { ok: true };
    const did = String((body && typeof body === 'object' ? body.did : '') ?? '');
    if (!/^[0-9a-f]{8,64}$/.test(did) || crossSite(req) || limitLanding(req.ip || 'unknown', 'me', 300) || teamBrowser(req)) return { ok: true };
    const ref = await this.core.fromParam(shop).then((r) => r && this.core.forPublic(r)).catch(() => null);
    if (!ref || ref.shop.status !== 'active') return { ok: true };
    const r = intake(ref);
    return this.core.call(r, 'landing.me', await this.core.systemSession(r), { slug, did }).catch(() => ({ ok: true }));
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
    // a team browser (Réglages › « Team et fournisseurs ») typing is no customer: never an abandoned order
    if (crossSite(req) || limitLanding(req.ip || 'unknown', 'lead', 120) || teamBrowser(req)) return { ok: true };
    const ref = await this.core.fromParam(shop).then((r) => r && this.core.forPublic(r)).catch(() => null);
    if (!ref || ref.shop.status !== 'active') return { ok: true };
    const r = intake(ref);
    await this.core.call(r, 'landing.capture', await this.core.systemSession(r), { ...(b && typeof b === 'object' ? b : {}), slug, meta: visitorMeta(req) }).catch(() => null);
    return { ok: true };
  }

  /**
   * A page (or a group page) says it is in front of a person: its script, when it shows (not hidden, not loaded in
   * advance by Facebook before the tap). The visit is counted then — views, the unique visitor of the day, a catalog
   * ad's visit, a group's click — and the server sends it to Meta too (landing.seen). Same answer whatever happens.
   * Many people can share one address (mobile networks): a generous limit, only against floods.
   */
  @Public()
  @Post(['lp/:slug/seen', 's/:shop/lp/:slug/seen'])
  async landingSeen(
    @Param('shop') shop: string | undefined,
    @Param('slug') slug: string,
    @Body() body: any,
    @Req() req: { ip?: string; headers: Record<string, string | undefined> },
    @Res({ passthrough: true }) res: any,
  ) {
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
    // another site, a flood from one address, a robot or a team browser (Réglages › « Team et fournisseurs »): nothing
    if (crossSite(req) || limitLanding(req.ip || 'unknown', 'seen', 600) || isRobot(req) || teamBrowser(req)) return { ok: true };
    const ref = await this.core.fromParam(shop).then((r) => r && this.core.forPublic(r)).catch(() => null);
    if (!ref || ref.shop.status !== 'active') return { ok: true };
    // the browser's anonymous code: the one the page gave it, else a new one (a browser that did not keep it then)
    let visitor = visitorCode(req);
    if (!visitor) {
      visitor = randomBytes(10).toString('hex');
      res.header('Set-Cookie', visitorCookie(visitor));
    }
    const x = b && typeof b === 'object' ? b : {};
    const r = intake(ref);
    await this.core
      .call(r, 'landing.seen', await this.core.systemSession(r), { slug, vid: x.vid, ch: x.ch, url: x.url, fbp: x.fbp, fbc: x.fbc, visitor, meta: visitorMeta(req) })
      .catch(() => null);
    return { ok: true };
  }

  /**
   * A phone says a notification reached it (Confirmation › « Bloquer jusqu'à l'appel »): its worker (sw.js) posts back
   * the one-time code the server put in it (push.ts › ringPhones), so the agent's phone counts as ringing. No session:
   * the code is the proof. Same answer whatever happens.
   */
  @Public()
  @Post(['push/ack/:code', 's/:shop/push/ack/:code'])
  async pushAck(@Param('shop') shop: string | undefined, @Param('code') code: string, @Req() req: { ip?: string }) {
    if (!/^[a-f0-9]{32}$/.test(code) || limitLanding(req.ip || 'unknown', 'ack', 120)) return { ok: true };
    const ref = await this.core.fromParam(shop).then((r) => r && this.core.forPublic(r)).catch(() => null);
    if (!ref || ref.shop.status !== 'active') return { ok: true };
    const r = intake(ref);
    await this.core.call(r, 'push.ack', await this.core.systemSession(r), { code }).catch(() => null);
    return { ok: true };
  }

  /**
   * A courier says a parcel's status changed (ZR webhook, registered from Pilotix with its key in ?key= and the
   * X-Pilotix-Key header). The parcel numbers are picked from the body, whatever its shape; their state is then read
   * again from the courier itself, so the body is only a hint.
   */
  /** A courier checks the webhook address once (Yalidine: GET ?crc_token=… must be answered with the same token). */
  @Public()
  @Get(['hooks/courier/:companyId', 's/:shop/hooks/courier/:companyId'])
  courierHookCheck(@Query('crc_token') crc: string) {
    return String(crc ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 200);
  }

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
    if (!metaSigned(req, body, sig, secret)) throw new core.AppError('unauthorized', 'Signature Meta invalide');
    const m = optionalDellal();
    // a boutique whose Page comes from a linked account (Pilot AI › Comptes) gets its Page's messages and comments from
    // Pilotix's own webhook (hooks/meta-app): here, only WhatsApp (its own Meta app), so nothing is answered twice
    const linked = (await this.core.t.platform.query(`SELECT 1 FROM platform.social_uses WHERE shop_id = $1 AND kind = 'page'`, [ref.shop.id]).catch(() => [])).length > 0;
    const all: any[] = m?.parseMetaWebhook ? m.parseMetaWebhook(body) : [];
    const list = linked ? all.filter((x) => x?.channel === 'whatsapp') : all;
    // comments make the page act in public (reply, hide): only from a webhook signed with the Meta app secret
    const comments: any[] = !linked && m?.parseMetaComments ? m.parseMetaComments(body) : [];
    // Delivery AI agent: what became of its WhatsApp messages (delivered, read, failed → SMS)
    const statuses: any[] = m?.parseWhatsAppStatuses ? m.parseWhatsAppStatuses(body) : [];
    // the ads' lead forms of a Page linked by hand (its own Meta app)
    const leads: any[] = !linked && m?.parseMetaLeads ? m.parseMetaLeads(body) : [];
    // Instagram: a customer took a message back (« unsend »): its words go from Pilotix too
    const unsends: any[] = !linked && m?.parseMetaUnsends ? m.parseMetaUnsends(body) : [];
    void this.handleIncoming(ref, list);
    void this.handleComments(ref, comments);
    void this.handleStatuses(ref, statuses);
    void this.handleLeads(ref, leads);
    void this.handleEdits(ref, [], [], unsends);
    return { ok: true, received: list.length + comments.length + statuses.length + leads.length + unsends.length };
  }

  // ---------------------------------------------------------------- linked accounts (Pilot AI › Comptes)
  /** The Facebook login tab comes back: its code becomes the account's token, the boutique's page turns green. */
  @Public()
  @Get('oauth/meta/callback')
  async oauthMeta(@Query() q: Record<string, string>, @Res() res: any) {
    return this.loginEnd('meta', q, res);
  }

  /** The TikTok for Business login tab comes back (?auth_code). */
  @Public()
  @Get('oauth/tiktok/callback')
  async oauthTiktok(@Query() q: Record<string, string>, @Res() res: any) {
    return this.loginEnd('tiktok', q, res);
  }

  /**
   * « Oui, c'est ma boutique » / « Non » in the login's tab (a form, with that page's one-time key): the account goes to
   * the boutique, or nothing happens. 20 per 15 minutes per address.
   */
  @Public()
  @Post('oauth/confirm')
  async oauthConfirm(@Body() body: any, @Req() req: { ip?: string }, @Res() res: any) {
    const ipKey = `oauthconfirm:${ipOf(req)}`;
    checkLogin(ipKey, 20);
    failedLogin(ipKey);
    const m = optionalSocial();
    // the ad accounts ticked in the tab (one box: a word; several: a list)
    const ads = ([] as unknown[])
      .concat(body?.ad ?? [])
      .map((x) => String(x).trim())
      .filter((x) => /^(act_)?\d{1,25}$/.test(x))
      .slice(0, 200);
    const r = m?.confirmLogin
      ? await m
          .confirmLogin(this.core.t, String(body?.state ?? '').slice(0, 100), String(body?.key ?? '').slice(0, 100), body?.choice === 'yes', String(body?.page ?? '').slice(0, 40), ads)
          .catch((e: any) => ({ ok: false, message: String(e?.message ?? 'Erreur') }))
      : { ok: false, message: 'Indisponible sur ce serveur.' };
    if (!r.ok) new Logger('Comptes').warn(`link not confirmed: ${r.message}`);
    const html = m?.loginPage ? m.loginPage(r) : `<!DOCTYPE html><meta charset="utf-8"><p>${r.ok ? 'OK' : 'Erreur'}</p>`;
    return res.status(200).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(html);
  }

  private async loginEnd(provider: 'meta' | 'tiktok', q: Record<string, string>, res: any) {
    const m = optionalSocial();
    const r = m?.finishLogin ? await m.finishLogin(this.core.t, provider, q ?? {}, config.publicUrl).catch((e: any) => ({ ok: false, message: String(e?.message ?? 'Erreur') })) : { ok: false, message: 'Indisponible sur ce serveur.' };
    if (!r.ok) new Logger('Comptes').warn(`${provider} login not finished: ${r.message}`);
    const html = m?.loginPage ? m.loginPage(r) : `<!DOCTYPE html><meta charset="utf-8"><p>${r.ok ? 'OK' : 'Erreur'}</p>`;
    return res.status(200).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(html);
  }

  /** Pilotix's own Meta app: Meta checks its webhook once with the verify token of Pilot AI › Réglages & coûts. */
  @Public()
  @Get('hooks/meta-app')
  async metaAppVerify(@Query() q: Record<string, string>, @Res() res: any) {
    const apps = await core.socialApps(this.core.t);
    if (q['hub.mode'] === 'subscribe' && sameKey(q['hub.verify_token'], apps.verifyToken)) return res.status(200).header('Content-Type', 'text/plain').send(String(q['hub.challenge'] ?? ''));
    return res.status(403).send({ message: 'Jeton de vérification invalide' });
  }

  /**
   * The linked Pages' messages and comments (Messenger, Instagram, Facebook and Instagram comments), and the WhatsApp numbers
   * connected with « Connecter WhatsApp », all through Pilotix's Meta app: each entry goes to the boutique that uses its
   * Page / number; Dellal and the CM AI agent answer there as usual.
   */
  @Public()
  @Post('hooks/meta-app')
  async metaAppHook(@Req() req: RawBodyRequest<any>, @Headers('x-hub-signature-256') sig: string, @Body() body: any) {
    const secret = await core.socialSecret(this.core.t, 'meta');
    // 200 so Meta does not retry in a loop: nothing is taken before Pilotix's app secret is in
    if (!secret) return { ok: false, received: 0, error: 'App Meta de Pilotix manquante' };
    // Instagram's own login signs its webhooks with its own secret (the control room keeps it too)
    if (!metaSigned(req, body, sig, secret)) {
      const ig = await core.socialIgSecret(this.core.t);
      if (!ig || !metaSigned(req, body, sig, ig)) {
        await core.noteBadSignature(this.core.t, body?.object).catch(() => undefined);
        throw new core.AppError('unauthorized', 'Signature Meta invalide');
      }
    }
    const m = optionalDellal();
    let received = 0;
    for (const r of await core.routeMeta(this.core.t, body)) {
      const ref = await this.core.shop({ id: r.shopId });
      if (!ref || ref.shop.status !== 'active') continue;
      const list: any[] = m?.parseMetaWebhook ? m.parseMetaWebhook(r.body) : [];
      const comments: any[] = m?.parseMetaComments ? m.parseMetaComments(r.body) : [];
      // Marketing › Formulaires: a form of the Page's ads was sent
      const leads: any[] = m?.parseMetaLeads ? m.parseMetaLeads(r.body) : [];
      // a customer changed a message, or reacted to one (❤️ 👍); an ad account's ad was rejected or has a problem
      const edits: any[] = m?.parseMetaEdits ? m.parseMetaEdits(r.body) : [];
      const reactions: any[] = m?.parseMetaReactions ? m.parseMetaReactions(r.body) : [];
      // Instagram: a customer took a message back (« unsend »): its words go from Pilotix too
      const unsends: any[] = m?.parseMetaUnsends ? m.parseMetaUnsends(r.body) : [];
      const adIssues: any[] = m?.parseMetaAdIssues ? m.parseMetaAdIssues(r.body) : [];
      // « Connecter WhatsApp »: what became of the boutique's WhatsApp messages (delivered, read, failed → SMS)
      const statuses: any[] = m?.parseWhatsAppStatuses ? m.parseWhatsAppStatuses(r.body) : [];
      void this.handleIncoming(ref, list);
      void this.handleComments(ref, comments);
      void this.handleLeads(ref, leads);
      void this.handleEdits(ref, edits, reactions, unsends);
      void this.handleAdIssues(ref, adIssues);
      void this.handleStatuses(ref, statuses);
      received += list.length + comments.length + leads.length + edits.length + reactions.length + unsends.length + adIssues.length + statuses.length;
    }
    return { ok: true, received };
  }

  /**
   * Meta's data deletion request (Facebook Login for Business › Settings › Data Deletion Request URL): a person removed
   * Pilotix from Facebook and asked for their data to go. The signed_request is checked with Pilotix's Meta app secret;
   * the person's linked accounts go, and Meta gets the code and the page of the request (only those two).
   */
  @Public()
  @Post('hooks/meta-deletion')
  @HttpCode(200)
  async metaDeletion(@Body() body: any) {
    const m = optionalSocial();
    if (!m?.metaDeletion) throw new core.AppError('bad_request', 'Indisponible sur ce serveur.');
    const r = await m.metaDeletion(this.core.t, String(body?.signed_request ?? ''), config.publicUrl);
    new Logger('Comptes').log(`Meta data deletion request ${r.confirmation_code}: ${r.removed} linked account(s) removed`);
    return { url: r.url, confirmation_code: r.confirmation_code };
  }

  /** The page of a deletion request, by its code: done, when, how many accounts went. Nothing about who asked. */
  @Public()
  @Get('hooks/meta-deletion/:code')
  async metaDeletionPage(@Param('code') code: string, @Res() res: any) {
    const m = optionalSocial();
    const r = m?.deletionPage ? await m.deletionPage(this.core.t, code) : { found: false, html: '<!DOCTYPE html><meta charset="utf-8"><p>Pilotix</p>' };
    return res.status(r.found ? 200 : 404).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(r.html);
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
    for (const st of list) {
      // a campaign's message (Marketing › Campagnes), else Delivery AI's
      const c: any = await this.core.call(ref, 'campaigns.waStatus', session, st).catch(() => null);
      if (c?.ok) continue;
      await this.core.call(ref, 'notify.waStatus', session, st).catch((e) => new Logger('Delivery AI').warn(`[${ref.shop.slug}] status ${st?.id}: ${e?.message ?? e}`));
    }
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
    for (const raw of list) {
      let msg = raw;
      try {
        const session = await this.core.systemSession(ref);
        // Marketing › Campagnes: « Stop » ends the offers (said back to the customer, nothing for Dellal); « Je commande »
        // goes to Dellal with the campaign's product; any answer counts for the campaign
        if (msg?.channel === 'whatsapp') {
          const c: any = await this.core.call(ref, 'campaigns.reply', session, { phone: String(msg.externalId), payload: msg.payload ?? null, text: msg.text ?? null, accountId: msg.accountId ?? null }).catch(() => null);
          if (c?.stop) continue;
          if (c?.text) msg = { ...msg, text: c.text };
        }
        // Referral › Code promo: someone opened the chat again from an ad or an m.me ?ref= link, without a message
        // (where they come from is kept; the welcome code goes by itself when that ad is « Awareness 🎁 »)
        if (msg?.referral) {
          await this.core.call(ref, 'dellal.referral', session, { channel: msg.channel, externalId: msg.externalId, accountId: msg.accountId ?? null, source: msg.source ?? null });
          continue;
        }
        const r: any = await this.core.call(ref, 'dellal.receive', session, msg);
        if (!r) continue;
        // a Messenger or Instagram chat that came without the customer's name: Meta's user profile gives it (in the
        // background: Dellal's answer does not wait for it)
        if ((msg?.channel === 'messenger' || msg?.channel === 'instagram') && !msg?.name)
          void this.core.call(ref, 'dellal.metaName', session, { id: r.conversationId }).catch((e: any) => log.warn(`[${ref.shop.slug}] conversation ${r.conversationId}, name: ${e?.message ?? e}`));
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

  /**
   * Edited messages and reactions: the conversation shows them. An edited message nobody answered yet is answered with its
   * new text (the waiting answer reads it); one already answered changes what Dellal reads next time. A message the
   * customer took back (unsend) loses its words, photo and voice note; a waiting answer to it does not go.
   */
  private async handleEdits(ref: ShopRef, edits: any[], reactions: any[], unsends: any[] = []) {
    if (!edits.length && !reactions.length && !unsends.length) return;
    const log = new Logger('Dellal');
    const session = await this.core.systemSession(ref);
    for (const e of edits) await this.core.call(ref, 'dellal.edited', session, e).catch((x: any) => log.warn(`[${ref.shop.slug}] edited message: ${x?.message ?? x}`));
    for (const r of reactions) await this.core.call(ref, 'dellal.reacted', session, r).catch((x: any) => log.warn(`[${ref.shop.slug}] reaction: ${x?.message ?? x}`));
    for (const u of unsends) await this.core.call(ref, 'dellal.unsent', session, u).catch((x: any) => log.warn(`[${ref.shop.slug}] unsent message: ${x?.message ?? x}`));
  }

  /** Co-Pilot › Publicités: what Meta said about the boutique's ads (rejected, a problem, fine again). */
  private async handleAdIssues(ref: ShopRef, list: any[]) {
    if (!list.length) return;
    const log = new Logger('Co-Pilot');
    const session = await this.core.systemSession(ref);
    for (const a of list)
      await this.core.call(ref, 'ads.issue', session, a).catch((e: any) => {
        if (!String(e?.message ?? '').includes(core.FEATURE_OFF)) log.warn(`[${ref.shop.slug}] ad ${a?.objectId}: ${e?.message ?? e}`);
      });
  }

  /** Marketing › Formulaires: each lead is read from Meta and becomes an order (or waits on the page), one after the other. */
  private async handleLeads(ref: ShopRef, list: any[]) {
    if (!list.length) return;
    const log = new Logger('Formulaires');
    const session = await this.core.systemSession(ref);
    for (const l of list) {
      await this.core.call(ref, 'leads.receive', session, l).catch((e: any) => {
        // a boutique whose plan has no « Formulaires »: its leads are not taken, without a line in the log each time
        if (!String(e?.message ?? '').includes(core.FEATURE_OFF)) log.warn(`[${ref.shop.slug}] lead ${l?.leadgenId}: ${e?.message ?? e}`);
      });
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
    bg('cm.plan.run'); // CM AI agent › Planner: the posts whose time has come go out (in the background)
    bg('landing.run'); // landing pages: abandoned orders, Meta events (in the background)
    bg('notify.run'); // Delivery AI agent: messages due (in the background)
    bg('auto.run'); // Pilot Automations: no stock → ads paused, the evening report, slow queue alerts, come-back offers (in the background)
    bg('dellal.autoOrders'); // Message AI agent: quiet chats with the customer's number become orders (in the background)
    bg('dellal.catchUp'); // Message AI agent: the safety net, messages Meta did not send (in the background)
    bg('depot.pushRun'); // dépôt alerts: ring the phones again (in the background)
    bg('confirmation.pushRun'); // « Bloquer jusqu'à l'appel »: a new order waiting rings its agent's devices (in the background)
    bg('pilot.run'); // Pilot Auto Assign: private orders waiting too long go to the backup company (in the background)
    bg('assign.run'); // Affectation automatique: the waiting orders and alerts get their agent (in the background)
    bg('spy.scan'); // AI Spy: the daily scan of competitors' ads, once a day (in the background)
    bg('spy.videos'); // AI Spy: copies of the videos of followed shops and tagged ads, while Facebook's links work (in the background)
    bg('channels.sheet.syncAll'); // Google Sheets channels: new lines become orders (in the background)
    bg('leads.catchUp'); // Marketing › Formulaires: the ads' leads Meta did not send (in the background)
    bg('campaigns.run'); // Marketing › Campagnes: the WhatsApp offers due, at the shop's pace (in the background)
    bg('metacatalog.run'); // Marketing › Catalogue: what changed goes to Meta, Meta's answers come back (in the background)
    return this.core.call(ref, 'delivery.sync', session, {}).catch((e) => ({ ok: false, message: e.message }));
  }
}

@Module({
  imports: [JwtModule.register({ global: true, secret: config.jwtSecret, signOptions: { expiresIn: config.jwtExpires } })],
  controllers: [ApiController, PlatformController],
  providers: [AuthGuard, PlatformGuard, { provide: APP_FILTER, useClass: ErrorFilter }],
})
export class ApiModule {}
