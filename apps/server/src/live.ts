import { Module, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { config } from './config';
import { CoreService } from './core.service';

/**
 * Live updates: when anything changes in a shop, every logged-in screen of that shop (and only of that shop) gets a
 * small event and refreshes what it shows. With several server instances, add the Socket.IO Redis adapter — see README.
 */
@WebSocketGateway({ path: '/live', cors: { origin: config.corsOrigins, credentials: true } })
export class LiveGateway implements OnGatewayConnection, OnModuleInit {
  @WebSocketServer() server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly core: CoreService,
  ) {}

  onModuleInit() {
    this.core.onLive((shopId, e) => this.server?.to(`shop:${shopId}`).emit('event', e));
  }

  async handleConnection(socket: Socket) {
    try {
      const c = await this.jwt.verifyAsync<{ sub: number; tv?: number; shop?: number; typ?: string }>(String(socket.handshake.auth?.token || ''));
      if (!c.sub || c.typ) throw new Error('refused');
      const ref = c.shop ? await this.core.shop({ id: Number(c.shop) }) : await this.core.primary();
      if (!ref || ref.shop.status === 'archived') throw new Error('refused');
      // the same checks as the API: an active account, a token made after the last password change
      const r = (await ref.db.query('SELECT active, token_version FROM profiles WHERE id = $1', [Number(c.sub)]))[0];
      if (!r || !r.active || Number(r.token_version ?? 0) !== Number(c.tv ?? 0)) throw new Error('refused');
      socket.data.userId = Number(c.sub);
      socket.data.shopId = ref.shop.id;
      socket.join(`shop:${ref.shop.id}`);
    } catch {
      socket.disconnect(true);
    }
  }
}

@Module({ providers: [LiveGateway] })
export class LiveModule {}
