// AI assistants (Claude, ChatGPT) linked to a Pilotix account: the link https://<site>/mcp and its sign-in door. The
// rules are in the core (packages/core/src/mcp-server.ts); this file is their HTTP side.
//   POST /mcp                                  → the link itself (deploy/Caddyfile sends it to /api/mcp): one MCP message,
//                                                 answered as the person who linked the assistant (its access key)
//   GET  /.well-known/oauth-protected-resource → /api/mcp/resource: where the link is, who gives its keys
//   GET  /.well-known/oauth-authorization-server → /api/mcp/server: the sign-in door's addresses
//   POST /api/mcp/register                      → an assistant registers (its name, where its answers go)
//   GET  /api/mcp/authorize                     → the assistant sends the person here; on to the app's « Autoriser » page
//   POST /api/mcp/token                         → the code of « Autoriser » (or a renewal key) for the keys
//   POST /api/mcp/ask | answer | links | cut    → the app's own (logged in): the « Autoriser » page, Mon profil › Sécurité
import { Body, Controller, Delete, Get, Logger, Module, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import * as core from '@pilotix/core';
import * as mcp from '@pilotix/core/dist/mcp-server';
import type { Session } from '@pilotix/shared';
import { AuthGuard, ShopRequest, tokenVersion } from './api';
import { config } from './config';
import { CoreService, ShopRef } from './core.service';
import { checkLogin, failedLogin } from './limits';
import { Public } from './public';

/** the link's own signing secret: made from the server's, never the same as the app's sessions */
const secret = () => `${config.jwtSecret}:mcp`;
const ipOf = (req: { ip?: string }) => core.ipNet(req.ip || '') || 'unknown';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** the link's version, as an assistant sees it */
const LINK_VERSION = '1.0.0';
/** calls of one link per minute (an assistant in a loop stops there) */
const CALLS_PER_MINUTE = 120;

type Req0 = { ip?: string; protocol?: string; method?: string; headers: Record<string, string | string[] | undefined> };
const header = (req: Req0, name: string) => {
  const v = req.headers[name];
  return String((Array.isArray(v) ? v[0] : v) ?? '');
};

/** « Basic <id:secret> » of an assistant that keeps a secret (each part written as in a form). */
function basicOf(h: string): { id: string; secret: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(h.trim());
  if (!m) return null;
  const raw = Buffer.from(m[1], 'base64').toString('utf8');
  const k = raw.indexOf(':');
  if (k < 1) return null;
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      return s;
    }
  };
  return { id: dec(raw.slice(0, k)), secret: dec(raw.slice(k + 1)) };
}

/** A mistake the person reads (a wrong link from an assistant): plain, nothing of the request in it. */
const mistakePage = (text: string) =>
  `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Pilotix</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f4ef;color:#1b2a47}main{max-width:420px;margin:24px;padding:28px;background:#fff;border-radius:18px;box-shadow:0 8px 30px rgba(27,42,71,.08)}h1{font-size:20px;margin:0 0 10px}p{margin:0}</style></head><body><main><h1>Pilotix</h1><p>${esc(text)}</p></main></body></html>`;

@Controller()
@UseGuards(AuthGuard)
export class McpController {
  private readonly log = new Logger('MCP');
  constructor(private readonly core: CoreService) {}

  /**
   * The door's address for this request: the site's own (PUBLIC_URL), or its backup door when the request came through
   * it (direct.<site>, reached without Cloudflare: for an assistant whose servers Cloudflare stops). No other name is
   * ever taken from a request. A test server without PUBLIC_URL: the address it was called at.
   */
  private base(req: Req0): string {
    const first = (s: string) => s.split(',')[0].trim();
    const host = (first(header(req, 'x-forwarded-host')) || header(req, 'host') || 'localhost').toLowerCase();
    if (!config.publicUrl) return `${first(header(req, 'x-forwarded-proto')) || req.protocol || 'http'}://${host}`;
    try {
      const u = new URL(config.publicUrl);
      if (host === `direct.${u.host}`) return `${u.protocol}//direct.${u.host}`;
    } catch {
      /* PUBLIC_URL as it is */
    }
    return config.publicUrl;
  }

  // ---------------------------------------------------------------- who a link acts for
  /** A boutique an assistant can be linked to: a live store (not a partner's space, not the shared demo). */
  private async store(shopId: number): Promise<ShopRef | null> {
    const ref = await this.core.shop({ id: shopId });
    return ref && mcp.mcpStoreOk(ref.shop) ? ref : null;
  }

  /** The people of the links, as the login guard keeps its sessions: read again every 30 s, and at once after a password change. */
  private people = new Map<string, { at: number; ep: number; tv: number; session: Session | null }>();
  private async person(ref: ShopRef, profileId: number): Promise<{ tv: number; session: Session } | null> {
    const key = `${ref.shop.id}:${profileId}`;
    const hit = this.people.get(key);
    if (hit && Date.now() - hit.at < 30_000 && hit.ep === this.core.authEpoch) return hit.session ? { tv: hit.tv, session: hit.session } : null;
    const ep = this.core.authEpoch;
    const p = await core.profileById(ref.db, profileId);
    // closed accounts are out; a partner's person inside a store works from the partner's space, never from here
    const ok = !!p && p.active && !p.agencyId;
    const tv = ok ? await tokenVersion(ref.db, profileId) : 0;
    const session = ok ? await this.core.withShop(core.makeSession(p!), ref, false) : null;
    if (this.people.size > 5000) this.people.clear();
    this.people.set(key, { at: Date.now(), ep, tv, session });
    return session ? { tv, session } : null;
  }
  private readonly personOf: mcp.McpPersonOf = async (shopId, profileId) => {
    const ref = await this.store(shopId);
    const p = ref ? await this.person(ref, profileId) : null;
    return p ? { tv: p.tv } : null;
  };

  /** the calls of each link in the current minute */
  private calls = new Map<number, { n: number; until: number }>();
  private tooMany(grantId: number): boolean {
    const now = Date.now();
    let c = this.calls.get(grantId);
    if (!c || c.until < now) {
      if (this.calls.size > 5000) for (const [k, v] of this.calls) if (v.until < now) this.calls.delete(k);
      this.calls.set(grantId, (c = { n: 0, until: now + 60_000 }));
    }
    return ++c.n > CALLS_PER_MINUTE;
  }

  // ---------------------------------------------------------------- the door's papers
  @Public()
  @Get('mcp/resource')
  resourceMeta(@Req() req: Req0, @Res() res: any) {
    res.status(200).header('Cache-Control', 'public, max-age=300').header('Access-Control-Allow-Origin', '*').send(mcp.mcpResourceMeta(this.base(req)));
  }

  @Public()
  @Get('mcp/server')
  serverMeta(@Req() req: Req0, @Res() res: any) {
    res.status(200).header('Cache-Control', 'public, max-age=300').header('Access-Control-Allow-Origin', '*').send(mcp.mcpServerMeta(this.base(req)));
  }

  /**
   * An assistant registers. Nothing is kept (its client id is its signed name tag), so the limit only stops a flood:
   * 300 per 15 minutes per address — Claude's and ChatGPT's servers register for all their users from a few addresses.
   */
  @Public()
  @Post('mcp/register')
  register(@Body() body: unknown, @Req() req: Req0, @Res() res: any) {
    const key = `mcpreg:${ipOf(req)}`;
    checkLogin(key, 300);
    failedLogin(key);
    const r = mcp.mcpRegister(secret(), body && typeof body === 'object' ? body : {});
    res.status(r.status).header('Cache-Control', 'no-store').send(r.json);
  }

  /** The assistant sends the person here (their browser): on to the app's « Autoriser » page, or back with what is wrong. */
  @Public()
  @Get('mcp/authorize')
  authorize(@Query() q: Record<string, unknown>, @Req() req: Req0, @Res() res: any) {
    // the person says yes on the site where they use Pilotix (already logged in there), whichever door the assistant took
    const r = mcp.mcpAuthorize(secret(), this.base(req), q ?? {}, Date.now(), config.publicUrl || this.base(req));
    if ('redirect' in r) return res.status(302).header('Location', r.redirect).header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').send();
    return res
      .status(r.status)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
      .send(mistakePage(r.show));
  }

  /**
   * The keys. A code or a renewal key cannot be guessed (256 random bits), so the limit only stops a flood: 300 wrong
   * tries per 15 minutes per address (the assistants' servers share a few addresses: a tighter one would let one person's
   * mistakes shut the others out).
   */
  @Public()
  @Post('mcp/token')
  async token(@Body() body: unknown, @Req() req: Req0, @Res() res: any) {
    const key = `mcptoken:${ipOf(req)}`;
    checkLogin(key, 300);
    const r = await mcp.mcpToken(this.core.t, secret(), this.base(req), body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}, basicOf(header(req, 'authorization')), this.personOf);
    if (r.status !== 200) failedLogin(key);
    res.status(r.status).header('Cache-Control', 'no-store').header('Pragma', 'no-cache').send(r.json);
  }

  // ---------------------------------------------------------------- the link itself
  /** The link a request's key opens; none: the answer that tells the assistant where the sign-in door is. */
  private async opened(req: Req0, res: any): Promise<mcp.McpAccess | null> {
    const base = this.base(req);
    const token = /^Bearer\s+(\S+)$/i.exec(header(req, 'authorization').trim())?.[1] ?? '';
    const access = token ? await mcp.mcpAccess(this.core.t, secret(), base, token, this.personOf) : null;
    if (access) return access;
    const why = token ? 'The access token is invalid, expired, or its link was cut' : 'Sign in with Pilotix to use this link';
    res.status(401).header('WWW-Authenticate', mcp.mcpChallenge(base, token ? 'invalid_token' : undefined, why)).header('Cache-Control', 'no-store');
    // a person opened the link in a browser: the same answer, with words for them (what the link is for)
    if (!token && req.method === 'GET' && /\btext\/html\b/i.test(header(req, 'accept')))
      res
        .header('Content-Type', 'text/html; charset=utf-8')
        .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
        .send(mistakePage(`Cette adresse sert à connecter un assistant IA (Claude, ChatGPT) à votre Pilotix : ${mcp.mcpUrls(base).resource} — copiez-la dans votre assistant, là où il propose d’ajouter un connecteur. Il vous demandera ensuite de vous connecter à Pilotix et d’autoriser.`));
    else res.send({ error: token ? 'invalid_token' : 'unauthorized', error_description: why });
    return null;
  }

  /**
   * One message of an assistant (or, for older ones, a few at once). No browser session is used here — only the key in
   * the Authorization header — so another site's page can do nothing with a visitor's Pilotix session through it.
   */
  @Public()
  @Post('mcp')
  async message(@Body() body: unknown, @Req() req: Req0, @Res() res: any) {
    const access = await this.opened(req, res);
    if (!access) return;
    const fail = (status: number, code: number, message: string) => res.status(status).header('Cache-Control', 'no-store').send({ jsonrpc: '2.0', id: null, error: { code, message } });
    if (this.tooMany(access.grantId)) return fail(429, -32000, 'Too many calls: wait a minute');
    const list = Array.isArray(body) ? body : [body];
    if (!list.length || list.length > 20) return fail(400, -32600, 'Invalid Request');
    // the version agreed at « initialize » comes with every later message (the first one may still name the assistant's own)
    const version = header(req, 'mcp-protocol-version');
    if (version && !mcp.MCP_VERSIONS.includes(version) && !list.some((m) => (m as { method?: unknown } | null)?.method === 'initialize'))
      return fail(400, -32600, `Unsupported MCP-Protocol-Version: ${version.slice(0, 20)}`);
    const ref = await this.store(access.shopId);
    const who = ref ? await this.person(ref, access.profileId) : null;
    if (!ref || !who) return fail(401, -32001, 'This account can no longer be used');
    this.core.touch(ref);
    const p = who.session.profile;
    const env: mcp.McpEnv = {
      call: (name, input) => this.core.call(ref, name, who.session, input),
      who: { name: p.name, email: p.email, roles: who.session.roles, isAdmin: who.session.isAdmin },
      shop: { name: ref.shop.name, slug: ref.shop.slug },
      scope: access.scope,
      now: Date.now(),
      version: LINK_VERSION,
      onError: (e, where) => this.log.error(`[${ref.shop.slug}] ${where}: ${(e as Error)?.stack || e}`),
    };
    const out: Record<string, unknown>[] = [];
    for (const m of list) {
      const r = await mcp.mcpMessage(m, env);
      if (r) out.push(r);
    }
    // only notifications: taken, nothing to answer
    if (!out.length) return res.status(202).header('Cache-Control', 'no-store').send();
    return res.status(200).header('Content-Type', 'application/json; charset=utf-8').header('Cache-Control', 'no-store').send(Array.isArray(body) ? out : out[0]);
  }

  /** This link sends nothing by itself (no stream to listen to), and has no session to end. */
  @Public()
  @Get('mcp')
  async noStream(@Req() req: Req0, @Res() res: any) {
    if (await this.opened(req, res)) res.status(405).header('Allow', 'POST').send({ error: 'method_not_allowed' });
  }
  @Public()
  @Delete('mcp')
  async noSession(@Req() req: Req0, @Res() res: any) {
    if (await this.opened(req, res)) res.status(405).header('Allow', 'POST').send({ error: 'method_not_allowed' });
  }

  // ---------------------------------------------------------------- the app's own: « Autoriser », Mon profil › Sécurité
  /** Why this space cannot be linked (null: it can): a partner's space, the shared demo, an unpaid boutique. */
  private cannot(req: ShopRequest): 'partner' | 'demo' | 'locked' | null {
    return mcp.mcpCannot(req.shop.shop, req.shop.status.locked, req.session.profile.agencyId);
  }

  /** The « Autoriser » page: who asks, and where the person stands (their boutique, their roles). */
  @Post('mcp/ask')
  ask(@Body() body: any, @Req() req: ShopRequest) {
    return { ...mcp.mcpAsk(secret(), body?.ticket), cannot: this.cannot(req) };
  }

  /** « Autoriser » / « Refuser »: the address the browser goes back to (the assistant's site, with the code or the no). */
  @Post('mcp/answer')
  async answer(@Body() body: any, @Req() req: ShopRequest) {
    const yes = body?.allow === true;
    const no = this.cannot(req);
    if (yes && no)
      throw new core.AppError(
        'forbidden',
        no === 'demo'
          ? 'Pas dans la boutique démo : ses comptes sont partagés par tous les visiteurs'
          : no === 'locked'
            ? 'L’abonnement de cette boutique est arrêté : un assistant ne peut pas y être connecté'
            : 'Un assistant se connecte à une boutique : ouvrez une de vos boutiques, puis relancez la connexion',
      );
    const key = `mcpyes:${req.shop.shop.id}:${req.session.profile.id}`;
    checkLogin(key, 30);
    failedLogin(key);
    const me = req.session.profile.id;
    return mcp.mcpAnswer(this.core.t, secret(), body?.ticket, { shopId: req.shop.shop.id, profileId: me, tv: await tokenVersion(req.shop.db, me) }, yes);
  }

  /** Mon profil › Sécurité: the assistants linked to my account in this boutique. */
  @Post('mcp/links')
  async links(@Req() req: ShopRequest) {
    const me = req.session.profile.id;
    return { links: await mcp.mcpLinks(this.core.t, req.shop.shop.id, me, await tokenVersion(req.shop.db, me)) };
  }

  /** « Couper »: that assistant's keys stop now. */
  @Post('mcp/cut')
  cut(@Body() body: any, @Req() req: ShopRequest) {
    const id = Number(body?.id);
    if (!Number.isSafeInteger(id) || id <= 0) throw new core.AppError('bad_request', 'Connexion inconnue');
    return mcp.mcpCut(this.core.t, req.shop.shop.id, req.session.profile.id, id);
  }
}

@Module({ controllers: [McpController], providers: [AuthGuard] })
export class McpModule {}
