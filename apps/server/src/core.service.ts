import { Global, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import * as core from '@pilotix/core';
import type { Ctx, Db, LiveEvent, PCtx, PlatformSettings, ServerHooks, Shop, ShopCtx, ShopStatus, StaffSession, Tenancy } from '@pilotix/core';
import type { Session } from '@pilotix/shared';
import { Pool, PoolClient } from 'pg';
import { config } from './config';

const PATH = Symbol('pilotix.search_path');
type Client = PoolClient & { [PATH]?: string };

/** A SQL error leaves the connection usable; anything else (connection lost, protocol error) destroys it. */
const broken = (e: unknown) => {
  const code = (e as { code?: unknown })?.code;
  return typeof code !== 'string' || /^(08|57P|53|XX)/.test(code);
};

/**
 * Every shop through one pool. Each connection remembers the search path it was given and changes it only when the
 * next query is for another schema (outside any transaction, so a rollback never undoes it). bigint/numeric come back
 * as strings; the core converts with num().
 */
export function poolTenancy(pool: Pool): Tenancy {
  const ready = async (c: Client, path: string) => {
    if (c[PATH] === path) return;
    c[PATH] = undefined;
    await c.query(`SELECT set_config('search_path', $1, false)`, [path]);
    c[PATH] = path;
  };
  const scoped = (path: string): Db => {
    const inTx = (c: Client): Db => {
      const db: Db = {
        async query(sql, params = []) {
          return (await c.query(sql, params as unknown[])).rows;
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
          await ready(c, path);
          return (await c.query(sql, params as unknown[])).rows;
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
          await ready(c, path);
          await c.query('BEGIN');
          try {
            const out = await fn(inTx(c));
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
    platform: scoped(core.searchPath('platform')),
    shop(schema) {
      let d = shops.get(schema);
      if (!d) shops.set(schema, (d = scoped(core.searchPath(schema))));
      return d;
    },
    async exec(schema, sql) {
      const c = (await pool.connect()) as Client;
      let bad: Error | undefined;
      try {
        await ready(c, core.searchPath(schema));
        await c.query(sql);
      } catch (e) {
        if (broken(e)) bad = e as Error;
        throw e;
      } finally {
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

@Injectable()
export class CoreService implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  readonly t = poolTenancy(this.pool);
  private readonly log = new Logger('Core');
  private listeners = new Set<(shopId: number, e: LiveEvent) => void>();

  readonly baseHooks: ServerHooks = {
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
      return m.runDellal(action, args, ctx);
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
    hashPassword: (pw) => core.hashPassword(pw),
    publicUrl: config.publicUrl,
  };

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

  /** Forget what is kept (after a change in the control room: seen at once). */
  invalidate() {
    this.cache.clear();
    this.settingsCache = null;
    this.sys.clear();
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

  /** The shop of a public link: /api/s/<slug>/… (none = the owner's shop, as all the old links). */
  async fromParam(slug: string | undefined): Promise<ShopRef | null> {
    if (slug === undefined || slug === '') return this.primary();
    if (!core.SLUG_RE.test(slug)) return null;
    return this.shop({ slug });
  }

  private hooksFor(s: Shop): ServerHooks | undefined {
    if (s.demo) return undefined; // the demo shop simulates couriers, messages and AI (nothing leaves the server)
    const publicApi = config.publicUrl ? `${config.publicUrl}/api${s.primary ? '' : `/s/${s.slug}`}` : undefined;
    // shop #1 choosing the store's part of its links: no other shop may have that name
    const storeTaken = async (store: string) => (await this.t.platform.query('SELECT 1 FROM platform.shops WHERE slug = $1 AND id <> $2', [store, s.id])).length > 0;
    return { ...this.baseHooks, publicApi, storeTaken };
  }

  ctx(ref: ShopRef, session: Session): Ctx {
    return { db: ref.db, session, shop: ref.rules, now: () => Date.now(), emit: (e) => this.emitLive(ref.shop.id, e), server: ref.hooks };
  }

  call(ref: ShopRef, name: string, session: Session, input: unknown) {
    return core.call(name, this.ctx(ref, session), input);
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
    return { t: this.t, staff, now: () => Date.now() };
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
    await this.pool.end();
  }
}

@Global()
@Module({ providers: [CoreService], exports: [CoreService] })
export class CoreModule {}
