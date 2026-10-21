import { Module, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { config } from './config';
import { CoreService } from './core.service';

/**
 * Live updates: when anything changes, every logged-in screen gets a small event and refreshes what it shows.
 * With several server instances, add the Socket.IO Redis adapter (REDIS_URL) — see README.
 */
@WebSocketGateway({ path: '/live', cors: { origin: config.corsOrigins, credentials: true } })
export class LiveGateway implements OnGatewayConnection, OnModuleInit {
  @WebSocketServer() server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly core: CoreService,
  ) {}

  onModuleInit() {
    this.core.onLive((e) => this.server?.to('staff').emit('event', e));
  }

  async handleConnection(socket: Socket) {
    try {
      const p = await this.jwt.verifyAsync<{ sub: number }>(String(socket.handshake.auth?.token || ''));
      socket.data.userId = Number(p.sub);
      socket.join('staff');
    } catch {
      socket.disconnect(true);
    }
  }
}

@Module({ providers: [LiveGateway] })
export class LiveModule {}
