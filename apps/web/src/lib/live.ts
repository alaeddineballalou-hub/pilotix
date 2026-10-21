import type { LiveEvent, Order, Page } from '@pilotix/shared';
import type { QueryClient } from '@tanstack/react-query';
import { io, Socket } from 'socket.io-client';
import { serverUrl } from './api';

export type Presence = Record<number, 'online' | 'idle' | 'offline'>;
let socket: Socket | null = null;
let presence: Presence = {};
const presenceListeners = new Set<(p: Presence) => void>();

export function onPresence(fn: (p: Presence) => void) {
  presenceListeners.add(fn);
  fn(presence);
  return () => presenceListeners.delete(fn);
}
const emitPresence = () => presenceListeners.forEach((l) => l({ ...presence }));

/** Connects to live updates; patches cached order lists in place so screens update without reloading. */
export function connectLive(token: string, qc: QueryClient) {
  disconnectLive();
  const base = serverUrl();
  if (!base) return;
  socket = io(base, { path: '/live', auth: { token }, transports: ['websocket', 'polling'], reconnectionDelayMax: 10_000 });

  socket.on('presence.snapshot', (list: { userId: number; state: 'online' | 'idle' }[]) => {
    presence = Object.fromEntries(list.map((p) => [p.userId, p.state]));
    emitPresence();
  });

  socket.on('event', (ev: LiveEvent) => {
    if (ev.type === 'presence') {
      presence[ev.userId] = ev.state;
      emitPresence();
      return;
    }
    if (ev.type === 'order.updated') {
      qc.setQueriesData<{ pages: Page<Order>[] }>({ queryKey: ['orders'] }, (data) =>
        data && { ...data, pages: data.pages.map((p) => ({ ...p, rows: p.rows.map((o) => (o.id === ev.order.id ? { ...o, ...ev.order } : o)) })) },
      );
      qc.setQueryData(['order', ev.order.id], ev.order);
    }
    if (ev.type === 'order.created') qc.invalidateQueries({ queryKey: ['orders'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  });

  if (!activityBound) {
    activityBound = true;
    ['pointerdown', 'keydown'].forEach((e) => window.addEventListener(e, markActive, { passive: true }));
  }
  markActive();
}

// Idle after 5 minutes without touching the screen or keyboard.
let activityBound = false;
let idle = false;
let idleTimer: number | undefined;
function markActive() {
  if (idle) socket?.emit('presence', 'online');
  idle = false;
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    idle = true;
    socket?.emit('presence', 'idle');
  }, 5 * 60_000);
}

export function disconnectLive() {
  socket?.disconnect();
  socket = null;
}
