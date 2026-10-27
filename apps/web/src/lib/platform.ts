// The control room's link to the server (Pilotix staff, not a shop account): its own login and token.
import type { PlatformRegistry, StaffSession } from '@pilotix/core';
import type { ServerDoctorReport } from '@pilotix/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient, UseQueryOptions } from '@tanstack/react-query';
import type { z } from 'zod';
import { toast } from '../ui/toast';
import { ApiError, serverUrl } from './backend';
import { store } from './store';

type Reg = PlatformRegistry;
export type PName = keyof Reg;
export type PIn<N extends PName> = z.input<Reg[N]['input']>;
export type POut<N extends PName> = Awaited<ReturnType<Reg[N]['run']>>;
export type Staff = StaffSession;

let token = store.get('ptoken');
let onLogout: () => void = () => {};
export const setOnStaffLogout = (fn: () => void) => (onLogout = fn);

const base = () => (serverUrl() || window.location.origin).replace(/\/+$/, '');

async function req<T>(path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}/api/platform${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError(0, 'Serveur injoignable. Vérifiez votre connexion.');
  }
  const data = await res.json().catch(() => undefined);
  if (res.status === 401 && token && !path.startsWith('/auth/')) {
    staffLogout();
    onLogout();
  }
  if (!res.ok) throw new ApiError(res.status, (data as any)?.message || res.statusText);
  return data as T;
}

export const savedStaff = (): Staff | null => (token ? store.json<Staff | null>('pstaff', null) : null);

function keep(r: { token: string; staff: Staff; device?: string }) {
  token = r.token;
  store.set('ptoken', r.token);
  store.set('pstaff', JSON.stringify(r.staff));
  if (r.device) store.set('pdevice', r.device);
  return r.staff;
}

/** The password; then, with the two-step login, the code e-mailed to the staff member (`step: 'code'`). */
export async function staffLogin(email: string, password: string): Promise<Staff | { step: 'code'; ticket: string; email: string }> {
  const r = await req<{ token: string; staff: Staff } | { step: 'code'; ticket: string; email: string }>('/auth/login', { email, password, device: store.get('pdevice') || undefined });
  return 'step' in r ? r : keep(r);
}
/** The code of the two-step login (« remember this device »: 30 days without it on this browser). */
export async function staffCode(ticket: string, code: string, remember: boolean): Promise<Staff> {
  return keep(await req<{ token: string; staff: Staff; device?: string }>('/auth/code', { ticket, code, remember }));
}

/** The server's health (sizes, backups, disk): GET /api/platform/health. */
export type Health = {
  db: { total: number; platform: number; shops: { id: number; name: string; bytes: number }[] };
  backups: { count: number; last: { name: string; bytes: number; at: string } | null; bytes: number; recent: { name: string; bytes: number; at: string }[] };
  disk: { total: number; free: number } | null;
  server: { startedAt: string; node: string; memory: number; mail: boolean; jobs: boolean };
};
export const serverHealth = () => req<Health>('/health', undefined, 'GET');

/** Doctor: the server's health (owner and managers). */
export const serverDoctor = () => req<ServerDoctorReport>('/doctor');
/** Cloudflare Turnstile for every shop: connect the account (owner; token '' keeps the saved one), remove it, sync now. */
export const turnstileSave = (body: { accountId: string; token: string } | { remove: true }) => req<NonNullable<ServerDoctorReport['turnstile']>>('/turnstile/save', body);
export const turnstileSync = () => req<NonNullable<ServerDoctorReport['turnstile']>>('/turnstile/sync', {});

export function staffLogout() {
  token = null;
  store.set('ptoken', null);
  store.set('pstaff', null);
}

export async function prpc<N extends PName>(name: N, input: PIn<N>): Promise<POut<N>> {
  const out = await req<POut<N>>(`/rpc/${name}`, input ?? {});
  // a new password: the server hands this session a fresh token
  if (name === 'p.me.password' && typeof (out as any)?.token === 'string') {
    token = (out as any).token;
    store.set('ptoken', token);
  }
  return out;
}

export function usePRpc<N extends PName>(name: N, input: PIn<N>, opts: Partial<UseQueryOptions<POut<N>, Error>> = {}) {
  return useQuery<POut<N>, Error>({ queryKey: ['p', name, input], queryFn: () => prpc(name, input), placeholderData: keepPreviousData, ...opts });
}

export function usePAction<N extends PName>(name: N, opts: { success?: string | ((r: POut<N>) => string); onDone?: (r: POut<N>) => void; silent?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation<POut<N>, Error, PIn<N>>({
    mutationFn: (input) => prpc(name, input),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['p'] });
      if (opts.success) toast(typeof opts.success === 'function' ? opts.success(r) : opts.success, 'ok');
      opts.onDone?.(r);
    },
    onError: (e) => {
      if (!opts.silent) toast(e.message, 'bad');
    },
  });
}
