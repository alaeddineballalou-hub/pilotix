import { Global, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import * as core from '@pilotix/core';
import type { Ctx, Db, LiveEvent, ServerHooks } from '@pilotix/core';
import type { Session } from '@pilotix/shared';
import { Pool, PoolClient } from 'pg';
import { config } from './config';

/** PostgreSQL as a core Db. bigint/numeric come back as strings; the core converts with num(). */
export function poolDb(pool: Pool): Db {
  const wrap = (q: (sql: string, p: unknown[]) => Promise<{ rows: any[] }>, client?: PoolClient): Db => ({
    async query(sql, params = []) {
      return (await q(sql, params as unknown[])).rows;
    },
    async tx(fn) {
      if (client) return fn(wrap(q, client)); // already in a transaction
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(wrap((s, p) => c.query(s, p as any[]), c));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
  });
  return wrap((s, p) => pool.query(s, p as any[]));
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

@Injectable()
export class CoreService implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: config.databaseUrl, max: config.dbPoolMax });
  readonly db = poolDb(this.pool);
  private readonly log = new Logger('Core');
  private listeners = new Set<(e: LiveEvent) => void>();

  readonly hooks: ServerHooks = {
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

  ctx(session: Session): Ctx {
    return { db: this.db, session, now: () => Date.now(), emit: (e) => this.emitLive(e), server: this.hooks };
  }

  call(name: string, session: Session, input: unknown) {
    return core.call(name, this.ctx(session), input);
  }

  onLive(fn: (e: LiveEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emitLive(e: LiveEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch (err) {
        this.log.warn(`live listener failed: ${(err as Error).message}`);
      }
    }
  }

  private sys: { at: number; s: Promise<Session> } | null = null;
  /**
   * A session acting as the system (webhooks, scheduled jobs, public landing pages): the first active admin. Kept 30 s:
   * every page view and every photo of a landing page needs it (2 queries saved each time).
   */
  systemSession(): Promise<Session> {
    if (this.sys && Date.now() - this.sys.at < 30_000) return this.sys.s;
    const s = this.loadSystemSession();
    this.sys = { at: Date.now(), s };
    s.catch(() => (this.sys = null));
    return s;
  }

  private async loadSystemSession(): Promise<Session> {
    const r = (await this.db.query(`SELECT id FROM profiles WHERE 'admin' = ANY(roles) AND active ORDER BY id LIMIT 1`))[0];
    if (!r) throw new Error('No admin account: run the seed first');
    const p = await core.profileById(this.db, Number(r.id));
    return core.makeSession(p!);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

@Global()
@Module({ providers: [CoreService], exports: [CoreService] })
export class CoreModule {}
