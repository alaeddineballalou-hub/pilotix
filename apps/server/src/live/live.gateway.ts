import { Global, Logger, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { LiveEvent, Role } from '@pilotix/shared';
import { Server, Socket } from 'socket.io';
import { config } from '../config';

/**
 * Live updates: order changes and who is online.
 * Clients connect with { auth: { token } }. Only small "what changed" messages are sent.
 */
@WebSocketGateway({ path: '/live', cors: { origin: config.corsOrigins, credentials: true } })
export class LiveGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly log = new Logger('Live');
  private readonly online = new Map<number, { sockets: number; state: 'online' | 'idle' }>();

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(socket: Socket) {
    try {
      const token = String(socket.handshake.auth?.token || '');
      const p = await this.jwt.verifyAsync<{ sub: number; roles: Role[] }>(token);
      const userId = Number(p.sub);
      socket.data.userId = userId;
      socket.join('staff');
      socket.join(`user:${userId}`);
      const cur = this.online.get(userId);
      this.online.set(userId, { sockets: (cur?.sockets || 0) + 1, state: 'online' });
      this.emit({ type: 'presence', userId, state: 'online' });
      socket.emit('presence.snapshot', [...this.online.entries()].map(([id, v]) => ({ userId: id, state: v.state })));
    } catch {
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket) {
    const userId: number | undefined = socket.data.userId;
    if (!userId) return;
    const cur = this.online.get(userId);
    if (!cur) return;
    if (cur.sockets <= 1) {
      this.online.delete(userId);
      this.emit({ type: 'presence', userId, state: 'offline' });
    } else {
      this.online.set(userId, { ...cur, sockets: cur.sockets - 1 });
    }
  }

  @SubscribeMessage('presence')
  setPresence(socket: Socket, state: 'online' | 'idle') {
    const userId: number | undefined = socket.data.userId;
    if (!userId || (state !== 'online' && state !== 'idle')) return;
    const cur = this.online.get(userId);
    if (cur) this.online.set(userId, { ...cur, state });
    this.emit({ type: 'presence', userId, state });
  }

  emit(event: LiveEvent) {
    if (!this.server) return;
    try {
      this.server.to('staff').emit('event', event);
    } catch (e) {
      this.log.warn(`Live emit failed: ${(e as Error).message}`);
    }
  }
}

@Global()
@Module({ providers: [LiveGateway], exports: [LiveGateway] })
export class LiveModule {}
