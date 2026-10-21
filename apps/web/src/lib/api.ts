import type { DashboardStats, OfflineAction, Order, OrderEvent, OrderStatus, Page, Product, User } from '@pilotix/shared';
import { store } from './store';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function serverUrl(): string {
  return (store.get('server') || import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
}
export function setServerUrl(url: string) {
  store.set('server', url.trim().replace(/\/+$/, '') || null);
}

let token: string | null = store.get('token');
export const getToken = () => token;
export function setToken(t: string | null) {
  token = t;
  store.set('token', t);
}

let onUnauthorized: () => void = () => {};
export const setOnUnauthorized = (fn: () => void) => (onUnauthorized = fn);

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const base = serverUrl();
  if (!base) throw new ApiError(0, 'NO_SERVER');
  let res: Response;
  try {
    res = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  if (res.status === 401 && token) onUnauthorized();
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, (data as any)?.message || res.statusText);
  return data as T;
}

const qs = (params: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface OrderQuery {
  status?: OrderStatus[];
  q?: string;
  wilaya?: number;
  callbackDue?: boolean;
  page?: number;
  pageSize?: number;
  sort?: string;
}

export const api = {
  login: (email: string, password: string) => request<{ token: string; user: User }>('POST', '/auth/login', { email, password }),
  me: () => request<User>('GET', '/auth/me'),
  setMyLanguage: (language: string) => request<User>('PATCH', '/users/me', { language }),
  orders: (q: OrderQuery) => request<Page<Order>>('GET', `/orders${qs(q as Record<string, unknown>)}`),
  order: (id: number) => request<Order>('GET', `/orders/${id}`),
  orderEvents: (id: number) => request<OrderEvent[]>('GET', `/orders/${id}/events`),
  createOrder: (body: unknown) => request<Order>('POST', '/orders', body),
  setStatus: (id: number, body: { status: OrderStatus; note?: string; callbackAt?: string | null; livreurId?: number; tracking?: string; clientId?: string }) =>
    request<Order>('POST', `/orders/${id}/status`, body),
  sync: (actions: OfflineAction[]) => request<{ results: { clientId: string; ok: boolean; error?: string }[] }>('POST', '/orders/sync', { actions }),
  products: (q?: string) => request<Product[]>('GET', `/products${qs({ q })}`),
  users: () => request<(User & { lastSeenAt: string | null })[]>('GET', '/users'),
  dashboard: () => request<DashboardStats>('GET', '/dashboard'),
};
