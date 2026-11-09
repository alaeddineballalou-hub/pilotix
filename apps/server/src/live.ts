import { Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import * as core from '@pilotix/core';
import { config } from './config';
import { CoreService } from './core.service';

/**
 * Live updates: when anything changes in a shop, every logged-in screen of that shop (and only of that shop) gets a
 * small event and refreshes what it shows. With several server instances, add the Socket.IO Redis adapter — see README.
 */
@WebSocketGateway({ path: '/live', cors: { origin: config.corsOrigins, credentials: true } })
export class LiveGateway implements OnGatewayConnection, OnModuleInit, OnModuleDestroy {
  @WebSocketServer() server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly core: CoreService,
  ) {}

  private recheck: NodeJS.Timeout | null = null;

  onModuleInit() {
    // each event says its boutique: a screen also listening to the person's other boutiques tells them apart
    this.core.onLive((shopId, e) => this.server?.to(`shop:${shopId}`).emit('event', { ...e, shop: shopId }));
    // every minute, each open screen is checked again like a request: an account switched off, a password changed or a
    // session ended (« Se déconnecter ») stops receiving at once
    this.recheck = setInterval(() => void this.checkAll(), 60_000);
    this.recheck.unref?.();
  }

  onModuleDestroy() {
    if (this.recheck) clearInterval(this.recheck);
  }

  /** Still allowed: an active account, the same token version, a session not ended. */
  private async stillOk(d: { userId?: number; shopId?: number; tv?: number; jti?: string }): Promise<boolean> {
    if (!d.userId || !d.shopId) return false;
    if (await this.core.isRevoked(d.jti)) return false;
    const ref = await this.core.shop({ id: d.shopId });
    if (!ref || ref.shop.status === 'archived' || ref.shop.status === 'deleted') return false;
    const r = (await ref.db.query('SELECT active, token_version FROM profiles WHERE id = $1', [d.userId]))[0];
    return !!r && !!r.active && Number(r.token_version ?? 0) === Number(d.tv ?? 0);
  }

  private async checkAll() {
    const sockets = await this.server?.fetchSockets().catch(() => []);
    for (const s of sockets ?? []) {
      const ok = await this.stillOk(s.data ?? {}).catch(() => true);
      if (!ok) s.disconnect(true);
    }
  }

  async handleConnection(socket: Socket) {
    try {
      const c = await this.jwt.verifyAsync<{ sub: number; tv?: number; shop?: number; typ?: string; jti?: string }>(String(socket.handshake.auth?.token || ''));
      if (!c.sub || c.typ) throw new Error('refused');
      if (await this.core.isRevoked(c.jti)) throw new Error('refused');
      const ref = c.shop ? await this.core.shop({ id: Number(c.shop) }) : await this.core.primary();
      // a closed or deleted store: no live updates (the same as the API)
      if (!ref || ref.shop.status === 'archived' || ref.shop.status === 'deleted') throw new Error('refused');
      // the same checks as the API: an active account, a token made after the last password change
      const r = (await ref.db.query('SELECT active, token_version FROM profiles WHERE id = $1', [Number(c.sub)]))[0];
      if (!r || !r.active || Number(r.token_version ?? 0) !== Number(c.tv ?? 0)) throw new Error('refused');
      socket.data.userId = Number(c.sub);
      socket.data.shopId = ref.shop.id;
      socket.data.tv = Number(c.tv ?? 0);
      socket.data.jti = c.jti;
      socket.join(`shop:${ref.shop.id}`);
      // a store: the person's other boutiques too (their own active account there), so a new order or a change in any
      // of them reaches this screen (« Toutes les boutiques », the new-order toast with its boutique's name)
      if (ref.shop.kind === 'store' && !ref.shop.demo) {
        const email = String((await ref.db.query('SELECT email FROM profiles WHERE id = $1', [Number(c.sub)]))[0]?.email ?? '');
        const acc = email ? await core.accountByEmail(this.core.t, email).catch(() => null) : null;
        if (email)
          for (const m of await core.membershipsOf(this.core.t, email).catch(() => []))
            // a password a store's admin chose opens that seller's stores only (core: passwordOpens)
            if (m.shopId !== ref.shop.id && !m.agencyId && (!acc || (await core.passwordOpens(this.core.t, acc, m.shopId)))) {
              const other = await this.core.shop({ id: m.shopId });
              if (other && other.shop.kind === 'store' && !other.status.locked) socket.join(`shop:${m.shopId}`);
            }
      }
    } catch {
      socket.disconnect(true);
    }
  }
}

@Module({ providers: [LiveGateway] })
export class LiveModule {}
