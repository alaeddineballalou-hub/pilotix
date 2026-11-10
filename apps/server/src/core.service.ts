import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as core from '@pilotix/core';
import type { Ctx, Db, LiveEvent, PCtx, PlatformSettings, ServerHooks, Shop, ShopCtx, ShopStatus, StaffSession, Tenancy } from '@pilotix/core';
import type { Session } from '@pilotix/shared';
import { promises as dnsp, lookup as dnsLookup } from 'node:dns';
import * as http from 'node:http';
import * as https from 'node:https';
import { Pool, PoolClient } from 'pg';
import { config } from './config';
import { mediaHooks } from './media';
import { payAlert } from './payalert';
import { mailConfigured, sendMail } from './mail';
import { pilotRestMail } from './mails';
import { turnstileCheck, turnstileSiteKey } from './turnstile';
import { push, pushKeys } from './push';

const PATH = Symbol('pilotix.search_path');
const ROLE = Symbol('pilotix.role');
type Client = PoolClient & { [PATH]?: string; [ROLE]?: boolean };

/** A SQL error leaves the connection usable; anything else (connection lost, protocol error) destroys it. */
const broken = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return typeof code !== 'string' || /^(08|57P|53|XX)/.test(code);
};

/**
 * Every shop through one pool. Shared tables (core platform/shared.ts): a connection takes the app's role (px_app,
 * filtered by row level security) and the shop of the query (app.shop_id) before each query; it remembers both and
 * sets them again only when the next query is for another shop (outside any transaction, so a rollback never undoes
 * them). A database not moved yet keeps the old way (search_path = the shop's schema). bigint/numeric come back as
 * strings; the core converts with num().
 */
export function poolTenancy(pool: Pool): Tenancy {
  let mode: Promise<core.SharedMode> | null = null;
  const getMode = () => {
    if (!mode) {
      mode = core.detectShared(async (sql) => (await pool.query(sql)).rows);
      mode.catch(() => (mode = null)); // looked at again next time
    }
    return mode;
  };
  /** Puts the connection on this schema's shop; true: shared tables. */
  const ready = async (c: Client, schema: string): Promise<boolean> => {
    const m = await getMode();
    const key = m.shared ? `shop:${core.shopIdOf(schema, m.primary)}` : `path:${core.searchPath(schema)}`;
    if (m.shared && !c[ROLE]) {
      c[PATH] = undefined;
      await c.query('SET ROLE px_app');
      c[ROLE] = true;
    }
    if (c[PATH] === key) return m.shared;
    c[PATH] = undefined; // unknown until the query below succeeds
    if (m.shared) await c.query(core.SHARED_ENTER, [String(core.shopIdOf(schema, m.primary))]);
    else await c.query(`SELECT set_config('search_path', $1, false)`, [core.searchPath(schema)]);
    c[PATH] = key;
    return m.shared;
  };
  const scoped = (schema: string, isShop: boolean): Db => {
    const sqlOf = (shared: boolean, sql: string) => (shared && isShop ? core.sharedSql(sql) : sql);
    const inTx = (c: Client, shared: boolean): Db => {
      const db: Db = {
        async query(sql, params = []) {
          return (await c.query(sqlOf(shared, sql), params as unknown[])).rows;
        },
        async tx(fn) {
          return fn(db); // already in a transaction
        },
      };
      return db;
    };
    return {
      async query(sql, params = []) {
        const c = (await pool.connect()) as Client;
        let bad: Error | undefined;
        try {
          const shared = await ready(c, schema);
          return (await c.query(sqlOf(shared, sql), params as unknown[])).rows;
        } catch (e) {
          if (broken(e)) bad = e as Error;
          throw e;
        } finally {
          c.release(bad);
        }
      },
      async tx(fn) {
        const c = (await pool.connect()) as Client;
        let bad: Error | undefined;
        try {
          const shared = await ready(c, schema);
          await c.query('BEGIN');
          try {
            const out = await fn(inTx(c, shared));
            await c.query('COMMIT');
            return out;
          } catch (e) {
            await c.query('ROLLBACK').catch((re) => (bad = re as Error));
            throw e;
          }
        } catch (e) {
          if (!bad && broken(e)) bad = e as Error;
          throw e;
        } finally {
          c.release(bad);
        }
      },
    };
  };
  const shops = new Map<string, Db>();
  return {
    platform: scoped('platform', false),
    shop(schema) {
      core.shopIdOf(schema, 1); // checks the name
      let d = shops.get(schema);
      if (!d) shops.set(schema, (d = scoped(schema, true)));
      return d;
    },
    // migrations: as the owner (no filter), in the schema itself; afterwards the database may have changed way
    async exec(schema, sql) {
      const c = (await pool.connect()) as Client;
      let bad: Error | undefined;
      try {
        c[PATH] = undefined;
        if (c[ROLE]) await c.query('RESET ROLE');
        c[ROLE] = false;
        await c.query(`SELECT set_config('search_path', $1, false), set_config('app.shop_id', '', false)`, [core.searchPath(schema)]);
        await c.query(sql);
      } catch (e) {
        if (broken(e)) bad = e as Error;
        throw e;
      } finally {
        mode = null;
        c.release(bad);
      }
    },
  };
}

/** Loads the optional server-only modules (courier APIs, Meta Ads) built inside the core. */
function optional(path: string): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path);
  } catch {
    return null;
  }
}

/** A shop as one request sees it: its row, its subscription state, its database, what its requests carry. */
export interface ShopRef {
  shop: Shop;
  status: ShopStatus;
  db: Db;
  /** the rules the core checks (features, lock, limits) */
  rules: ShopCtx;
  /** server abilities for this shop (none for the demo shop: it simulates, like the preview) */
  hooks: ServerHooks | undefined;
}

const SHOP_TTL = 15_000;

// a team's board asked again within 20 s: the same answer (some thirty reads each time)
core.boardCache.ttlMs = Number(process.env.BOARD_CACHE_MS ?? 20_000);

/**
 * The database connections. Each one is replaced after DB_CONN_MAX_USES queries or DB_CONN_MAX_SECONDS: a connection
 * remembers every shop schema it opened (~1.5 MB each), and with hundreds of shops a long-lived one grows until
 * PostgreSQL is killed for lack of memory. A connection that breaks while idle (PostgreSQL restarting) is only written
 * in the log: without this listener the error would stop the whole server.
 */

function openPool(max = config.dbPoolMax): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max,
    maxUses: config.dbConnMaxUses,
    maxLifetimeSeconds: config.dbConnMaxSeconds,
  });
  const log = new Logger('Database');
  let last = 0;
  const lost = (e: Error) => {
    // at most one line every 10 seconds (a restart breaks every connection at once)
    if (Date.now() - last < 10_000) return;
    last = Date.now();
    log.error(`connection lost: ${e.message}`);
  };
  // idle connections (the pool's own listener) and connections in use: the query that was running fails, the request
  // answers with an error, and the broken connection is thrown away when it comes back (core.service: broken())
  pool.on('error', lost);
  pool.on('connect', (c) => c.on('error', lost));
  return pool;
}

@Injectable()
export class CoreService implements OnModuleInit, OnModuleDestroy {
  readonly pool = openPool();
  readonly t = poolTenancy(this.pool);
  /** the customers' own connections (landing pages, orders): the team's screens can be busy, a sale never waits for them */
  private readonly publicPool = config.dbPublicPoolMax ? openPool(config.dbPublicPoolMax) : null;
  private readonly tPublic = this.publicPool ? poolTenancy(this.publicPool) : null;
  private readonly log = new Logger('Core');
  private listeners = new Set<(shopId: number, e: LiveEvent) => void>();
  /** Pilot AI's daily limit: looked at most every 10 seconds (many answers can come at once), and once after the last one */
  private pilotRestAt = 0;
  private pilotRestLater: NodeJS.Timeout | null = null;

  /** Today's limit just reached: one e-mail to the owner and the managers (core.takePilotRestAlert says it once a day). */
  private async pilotRestCheck(t: Tenancy): Promise<void> {
    const wait = this.pilotRestAt + 10_000 - Date.now();
    if (wait > 0) {
      // too soon: look again when the 10 seconds are over (the answer that reached the limit may be the day's last one)
      if (!this.pilotRestLater) {
        this.pilotRestLater = setTimeout(() => ((this.pilotRestLater = null), void this.pilotRestCheck(t)), wait + 50);
        this.pilotRestLater.unref?.();
      }
      return;
    }
    this.pilotRestAt = Date.now();
    try {
      const hit = await core.takePilotRestAlert(t);
      if (!hit || !mailConfigured()) return;
      this.log.warn(`Pilot AI: today's limit reached (${hit.usd.toFixed(2)} $ of ${hit.dayUsd} $): the AI rests until midnight`);
      const staff = await t.platform.query<{ name: string; email: string }>(`SELECT name, email FROM platform.staff WHERE active AND role IN ('owner', 'manager')`);
      for (const s of staff) await sendMail(pilotRestMail({ to: s.email, name: s.name, ...hit })).catch((e) => this.log.warn(`limit e-mail to ${s.email}: ${e?.message || e}`));
    } catch (e) {
      this.log.warn(`Pilot AI limit check: ${(e as Error).message}`);
    }
  }

  readonly baseHooks: ServerHooks = {
    pushKeys,
    push,
    // « Mes boutiques »: a shop's name, link or logo changed — every request sees it at once
    platformChanged: () => this.invalidate(),
    courier: async (action, args, ctx) => {
      const m = optional('@pilotix/core/dist/couriers');
      if (!m?.runCourier) throw new core.AppError('bad_request', 'Intégration des sociétés de livraison indisponible sur ce serveur');
      return m.runCourier(action, args, ctx);
    },
    meta: async (action, args, ctx) => {
      const m = optional('@pilotix/core/dist/meta');
      if (!m?.runMeta) throw new core.AppError('bad_request', 'Connexion Meta indisponible sur ce serveur');
      return m.runMeta(action, args, ctx);
    },
    dellal: async (action, args, ctx) => {
      const m = optional('@pilotix/core/dist/dellal-server');
      if (!m?.runDellal) throw new core.AppError('bad_request', 'Dellal indisponible sur ce serveur');
      const out = await m.runDellal(action, args, ctx);
      // Pilot AI: an answer may have reached today's limit; the owner and the managers hear it (once a day)
      if (action === 'complete' && ctx.t) void this.pilotRestCheck(ctx.t);
      return out;
    },
    social: async (action, args, ctx) => {
      const m = optional('@pilotix/core/dist/social-server');
      if (!m?.runSocial) throw new core.AppError('bad_request', 'Comptes liés indisponibles sur ce serveur');
      return m.runSocial(action, args, ctx);
    },
    spy: async (action, args, ctx) => {
      const m = optional('@pilotix/core/dist/spy-server');
      if (!m?.runSpy) throw new core.AppError('bad_request', 'AI Spy indisponible sur ce serveur');
      return m.runSpy(action, args, ctx);
    },
    sheetCsv: async (url) => {
      // only Google (the link was checked by the core); a sheet that is not public answers with a Google sign-in page
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { Accept: 'text/csv,*/*' } }).catch(() => {
        throw new core.AppError('bad_request', 'Impossible de lire la feuille Google (délai dépassé ou lien faux)');
      });
      const host = new URL(res.url).hostname;
      if (!/(^|\.)(google\.com|googleusercontent\.com)$/.test(host)) throw new core.AppError('bad_request', 'La feuille Google a renvoyé vers un autre site');
      const type = res.headers.get('content-type') || '';
      if (!res.ok || /text\/html/i.test(type))
        throw new core.AppError('bad_request', 'La feuille n’est pas publique. Dans Google Sheets : Partager › « Tous les utilisateurs disposant du lien » (lecteur), ou Fichier › Partager › Publier sur le web.');
      const text = await res.text();
      if (text.length > 5_000_000) throw new core.AppError('bad_request', 'Feuille trop grande (plus de 5 Mo) : gardez les commandes récentes');
      return text;
    },
    turnstile: async (secret, token, ip) => {
      // Cloudflare's own check of the invisible widget's token (5 s at most: an order never waits for it longer)
      const body = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) });
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(5_000) }).catch(() => null);
      if (!res?.ok) return null;
      const r: any = await res.json().catch(() => null);
      return r ? !!r.success : null;
    },
    turnstileSite: (host) => turnstileSiteKey(this, host),
    turnstileCheck: (siteKey, token, ip) => turnstileCheck(this, siteKey, token, ip),
    hashPassword: (pw) => core.hashPassword(pw),
    // « J'ai payé »: Pilotix's WhatsApp tells the team (control room › Réglages › Paiement)
    payAlert: (claimId) => payAlert(this, claimId),
    publicUrl: config.publicUrl,
    // the landing pages' address in use (their own once it answers, else the site's)
    pagesUrl: () => this.landingBase(),
  };

  // ---------------------------------------------------------------- the landing pages' own address (go.<domain>)
  /** it answers (its DNS, its certificate, Caddy): checked at start and every 5 minutes */
  private landingOk = false;
  private landingFails = 0;
  private landingTimer: NodeJS.Timeout | null = null;
  private landingStopped = false;

  /** go.<domain> (lower case), null when the server has no LANDING_URL */
  landingHost(): string | null {
    try {
      return config.landingUrl ? new URL(config.landingUrl).hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  /** the pages are served at their own address now (it answered) */
  landingReady(): boolean {
    return this.landingOk && !!config.landingUrl;
  }

  /** the address of the pages in use: their own once it answers, else the site's (as before) */
  landingBase(): string {
    return this.landingReady() ? config.landingUrl : config.publicUrl;
  }

  /**
   * Asks go.<domain> who answers there: its public DNS record, its certificate, Caddy, this server. On once it answers,
   * off after 2 failures in a row (a short glitch changes nothing).
   */
  async checkLanding() {
    if (!config.landingUrl) return;
    const was = this.landingOk;
    let ok = false;
    try {
      // the name exists for visitors (through LANDING_CHECK_VIA the road below skips the public DNS)
      if (config.landingCheckVia) await dnsp.lookup(this.landingHost() ?? '');
      ok = await this.landingAsk();
    } catch {
      ok = false;
    }
    this.landingFails = ok ? 0 : this.landingFails + 1;
    if (ok) this.landingOk = true;
    else if (this.landingFails >= 2) this.landingOk = false;
    if (was !== this.landingOk) {
      this.log.log(this.landingOk ? `Landing pages: served at ${config.landingUrl}` : `Landing pages: ${config.landingUrl} does not answer, served at ${config.publicUrl}`);
      this.invalidate();
    }
  }

  /** GET <LANDING_URL>/api/landing-ready: its name, its certificate checked; connected through LANDING_CHECK_VIA when set. */
  private landingAsk(): Promise<boolean> {
    const u = new URL(`${config.landingUrl}/api/landing-ready`);
    const via = config.landingCheckVia;
    const mod = u.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
      const req = mod.request(
        u,
        {
          method: 'GET',
          headers: { Accept: 'application/json', 'User-Agent': 'Pilotix-landing-check/1' },
          timeout: 10_000,
          ...(via ? { lookup: ((_h: string, o: any, cb: any) => dnsLookup(via, o, cb)) as any } : {}),
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (d: string) => {
            if (body.length < 2000) body += d;
          });
          res.on('end', () => {
            try {
              resolve(res.statusCode === 200 && JSON.parse(body)?.landing === true);
            } catch {
              resolve(false);
            }
          });
          res.on('error', () => resolve(false));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve(false));
      req.end();
    });
  }

  /** the next check: soon after the start (the server listens by then), every 30 s while off, every minute while on */
  private nextLandingCheck(ms: number) {
    if (this.landingTimer) clearTimeout(this.landingTimer);
    if (this.landingStopped) return;
    this.landingTimer = setTimeout(() => {
      void this.checkLanding().finally(() => this.nextLandingCheck(this.landingOk ? 60_000 : 30_000));
    }, ms);
    this.landingTimer.unref?.();
  }

  onModuleInit() {
    if (config.landingUrl) this.nextLandingCheck(2_000);
  }

  // ---------------------------------------------------------------- shops
  private cache = new Map<string, { at: number; p: Promise<ShopRef | null> }>();
  private settingsCache: { at: number; p: Promise<PlatformSettings> } | null = null;

  /** The platform's settings (trial, payment details, message to shops), kept 15 s. */
  settings(): Promise<PlatformSettings> {
    if (this.settingsCache && Date.now() - this.settingsCache.at < SHOP_TTL) return this.settingsCache.p;
    const p = core.platformSettings(this.t);
    this.settingsCache = { at: Date.now(), p };
    p.catch(() => (this.settingsCache = null));
    return p;
  }

  /**
   * Raised when sessions must be read again at once (a password changed, an account switched off, an agency's agents
   * opened or closed, a change in the control room): the login guard keeps sessions 30 s otherwise.
   */
  authEpoch = 0;

  // ---------------------------------------------------------------- sessions ended with « Se déconnecter »
  /** the ids of tokens ended by their logout (until they would have ended anyway), read again every 30 s */
  private revoked = new Map<string, number>();
  private revokedAt: Date | null = null;
  private revokedRead: Promise<void> | null = null;

  private async readRevoked() {
    const since = this.revokedAt ? new Date(this.revokedAt.getTime() - 5_000) : null;
    const now = new Date();
    for (const r of await core.revokedSince(this.t, since)) this.revoked.set(r.jti, r.exp);
    this.revokedAt = now;
    const t = Date.now();
    for (const [k, exp] of this.revoked) if (exp < t) this.revoked.delete(k);
  }

  /** Is this session's token ended (« Se déconnecter » on that device)? */
  async isRevoked(jti: string | undefined): Promise<boolean> {
    if (!jti) return false;
    if (!this.revokedAt || Date.now() - this.revokedAt.getTime() > 30_000) {
      this.revokedRead ??= this.readRevoked()
        .catch((e) => this.log.warn(`ended sessions: ${(e as Error).message}`))
        .finally(() => (this.revokedRead = null));
      await this.revokedRead;
    }
    return this.revoked.has(jti);
  }

  /** Ends this token now (its id and when it would have ended). */
  async revoke(jti: string, exp: Date) {
    await core.revokeToken(this.t, jti, exp);
    this.revoked.set(jti, exp.getTime());
  }

  /** Forget what is kept (after a change in the control room: seen at once, sessions included). */
  invalidate() {
    this.cache.clear();
    this.settingsCache = null;
    this.sys.clear();
    this.authEpoch++;
  }

  /** A shop by id, address (slug) or the owner's own shop; kept 15 s. */
  shop(by: { id: number } | { slug: string } | { primary: true }): Promise<ShopRef | null> {
    const key = 'id' in by ? `i${by.id}` : 'slug' in by ? `s${by.slug}` : 'primary';
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < SHOP_TTL) return hit.p;
    const p = (async () => {
      const s = await core.loadShop(this.t, by);
      if (!s) return null;
      const set = await this.settings();
      const status = core.shopStatus(s, Date.now(), set.trial.graceDays);
      return { shop: s, status, db: this.t.shop(s.schema), rules: core.shopCtx(s, status), hooks: this.hooksFor(s) };
    })();
    this.cache.set(key, { at: Date.now(), p });
    p.catch(() => this.cache.delete(key));
    return p;
  }

  async primary(): Promise<ShopRef> {
    const r = await this.shop({ primary: true });
    if (!r) throw new Error('No primary shop: run the migrations first');
    return r;
  }

  /** The same shop, its queries on the customers' connections (a landing page, an order). */
  forPublic(ref: ShopRef): ShopRef {
    return this.tPublic ? { ...ref, db: this.tPublic.shop(ref.shop.schema) } : ref;
  }

  /** The shop of a public link: /api/s/<slug>/… (none = the owner's shop, as all the old links); a former link of a shop leads to it. */
  async fromParam(slug: string | undefined): Promise<ShopRef | null> {
    if (slug === undefined || slug === '') return this.primary();
    if (!core.SLUG_RE.test(slug)) return null;
    return (await this.shop({ slug })) ?? this.movedShop(slug);
  }

  /** The shop whose former link this is (« Mes boutiques »: its link changed), null: none. */
  async movedShop(slug: string): Promise<ShopRef | null> {
    if (!core.SLUG_RE.test(slug)) return null;
    const id = await core.shopIdByOldSlug(this.t, slug);
    return id ? this.shop({ id }) : null;
  }

  private hooksFor(s: Shop): ServerHooks | undefined {
    if (s.demo) return undefined; // the demo shop simulates couriers, messages and AI (nothing leaves the server)
    const publicApi = config.publicUrl ? `${config.publicUrl}/api${s.primary ? '' : `/s/${s.slug}`}` : undefined;
    // shop #1 choosing the store's part of its links: no other shop may have that name
    const storeTaken = (store: string) => core.slugTakenByOther(this.t, store, s.id);
    // the shop's videos on the server's disk (CM AI agent › Planner)
    return { ...this.baseHooks, publicApi, storeTaken, media: mediaHooks(s.schema) };
  }

  ctx(ref: ShopRef, session: Session, seller?: number | 'all'): Ctx {
    // t: what joins two shops (a partner and the stores it works for); seller: the partner's chosen seller
    return {
      db: ref.db,
      session,
      shop: ref.rules,
      now: () => Date.now(),
      emit: (e) => this.emitLive(ref.shop.id, e),
      server: ref.hooks,
      t: this.t,
      // a store: « Toutes les boutiques » of someone with several boutiques, or an order of another of their boutiques
      ...(ref.shop.kind !== 'store'
        ? { seller, otherShop: (id: number, profileId: number) => this.otherShop(id, profileId) }
        : seller !== undefined
          ? { boutique: seller, otherShop: (id: number, profileId: number) => this.otherShop(id, profileId) }
          : {}),
    };
  }

  /**
   * Another shop, as one of the person's accounts there (its live updates, its couriers): a store a partner works for,
   * or another of a seller's boutiques (« Toutes les boutiques »).
   */
  private async otherShop(shopId: number, profileId: number): Promise<Ctx> {
    const ref = await this.shop({ id: shopId });
    if (!ref || ref.shop.status === 'archived' || ref.shop.status === 'deleted') throw new core.AppError('not_found', 'Boutique introuvable');
    const p = await core.profileById(ref.db, profileId);
    if (!p?.active) throw new core.AppError('forbidden', 'Votre compte n’est plus actif là-bas');
    return this.ctx(ref, core.makeSession(p));
  }

  call(ref: ShopRef, name: string, session: Session, input: unknown, seller?: number | 'all') {
    return core.call(name, this.ctx(ref, session, seller), input);
  }

  /** What the app shows of a shop (plan, state, how to pay, Pilotix's message, its limits). */
  async info(ref: ShopRef, extra: core.ShopInfoExtra = core.NO_EXTRA) {
    return core.shopInfo(ref.shop, ref.status, await this.settings(), Date.now(), extra);
  }

  /**
   * A session with its shop: the plan and its limits, and what this person has there (owner, other stores, unread
   * answers from Pilotix) — `full` at login and when the app loads; the per-request check only needs the rules.
   */
  async withShop(session: Session, ref: ShopRef, full = true): Promise<Session> {
    const set = await this.settings();
    const extra = full && !ref.shop.demo ? await core.shopInfoExtra(this.t, ref.shop, session.profile.email, set).catch(() => core.NO_EXTRA) : core.NO_EXTRA;
    const platformStaff = full && ref.shop.primary && session.isAdmin ? await core.isStaffEmail(this.t, session.profile.email).catch(() => false) : false;
    return { ...session, shop: core.shopInfo(ref.shop, ref.status, set, Date.now(), extra), ...(platformStaff ? { platformStaff } : {}) };
  }

  private sys = new Map<number, { at: number; s: Promise<Session> }>();
  /**
   * A session acting as the system for a shop (webhooks, scheduled jobs, public landing pages): its first active admin.
   * Kept 30 s: every page view and every photo of a landing page needs it.
   */
  systemSession(ref: ShopRef): Promise<Session> {
    const hit = this.sys.get(ref.shop.id);
    if (hit && Date.now() - hit.at < 30_000) return hit.s;
    const s = (async () => {
      const r = (await ref.db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) AND active ORDER BY id LIMIT 1`))[0];
      if (!r) throw new Error(`No admin account in shop ${ref.shop.slug}`);
      const p = await core.profileById(ref.db, Number(r.id));
      return core.makeSession(p!);
    })();
    this.sys.set(ref.shop.id, { at: Date.now(), s });
    s.catch(() => this.sys.delete(ref.shop.id));
    return s;
  }

  /** Shops whose scheduled work runs: not archived, not suspended (and not locked unless `evenLocked`). */
  async jobShops(evenLocked = false): Promise<ShopRef[]> {
    const out: ShopRef[] = [];
    for (const s of await core.loadShops(this.t)) {
      if (s.status === 'archived') continue;
      // a partner (agency, marketer) has no orders, couriers or messages of its own: nothing to run
      if (s.kind !== 'store') continue;
      const ref = await this.shop({ id: s.id });
      if (!ref) continue;
      if (!evenLocked && ref.status.locked) continue;
      out.push(ref);
    }
    return out;
  }

  private touched = new Map<number, number>();
  /** Marks the shop as used now (at most every 5 minutes): the control room shows the last activity. */
  touch(ref: ShopRef) {
    const last = this.touched.get(ref.shop.id) ?? 0;
    if (Date.now() - last < 5 * 60_000) return;
    this.touched.set(ref.shop.id, Date.now());
    this.t.platform.query('UPDATE platform.shops SET last_active_at = now() WHERE id = $1', [ref.shop.id]).catch(() => {});
  }

  platformCtx(staff: StaffSession): PCtx {
    return {
      t: this.t,
      staff,
      now: () => Date.now(),
      // the addresses Pilotix's Meta and TikTok apps are given (Pilot AI › Réglages & coûts)
      publicUrl: config.publicUrl || undefined,
      // Pilot AI › Test & lessons: Dellal answers in a shop as for a customer (the shop's system), and Pilot AI's own
      // questions go to Claude on Pilotix's key
      shop: (id) => this.platformShop(id),
      ai: async (req) => {
        const m = optional('@pilotix/core/dist/dellal-server');
        if (!m?.pilotComplete) throw new core.AppError('bad_request', 'Pilot AI indisponible sur ce serveur');
        return m.pilotComplete(this.t, req);
      },
    };
  }

  /** A store as its own system, for the control room (Pilot AI's test chat): live, not archived or deleted. */
  private async platformShop(id: number): Promise<Ctx> {
    const ref = await this.shop({ id });
    if (!ref || ref.shop.kind !== 'store' || ref.shop.status === 'archived' || ref.shop.status === 'deleted') throw new core.AppError('not_found', 'Boutique introuvable');
    return this.ctx(ref, await this.systemSession(ref));
  }

  // ---------------------------------------------------------------- live updates (per shop)
  onLive(fn: (shopId: number, e: LiveEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emitLive(shopId: number, e: LiveEvent) {
    for (const l of this.listeners) {
      try {
        l(shopId, e);
      } catch (err) {
        this.log.warn(`live listener failed: ${(err as Error).message}`);
      }
    }
  }

  async onModuleDestroy() {
    if (this.pilotRestLater) clearTimeout(this.pilotRestLater);
    this.landingStopped = true;
    if (this.landingTimer) clearTimeout(this.landingTimer);
    this.landingTimer = null;
    await this.pool.end();
    await this.publicPool?.end();
  }
}

@Global()
@Module({ providers: [CoreService], exports: [CoreService] })
export class CoreModule {}
