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

async function req<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base()}/api/platform${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError(0, 'Serveur injoignable. Vérifiez votre connexion.');
  }
  const data = await res.json().catch(() => undefined);
  if (res.status === 401 && token && path !== '/auth/login') {
    staffLogout();
    onLogout();
  }
  if (!res.ok) throw new ApiError(res.status, (data as any)?.message || res.statusText);
  return data as T;
}

export const savedStaff = (): Staff | null => (token ? store.json<Staff | null>('pstaff', null) : null);

export async function staffLogin(email: string, password: string): Promise<Staff> {
  const r = await req<{ token: string; staff: Staff }>('/auth/login', { email, password });
  token = r.token;
  store.set('ptoken', r.token);
  store.set('pstaff', JSON.stringify(r.staff));
  return r.staff;
}

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

/** Doctor: the server's health (owner and managers). */
export const serverDoctor = () => req<ServerDoctorReport>('/doctor');

/** Support: opens the shop in a new tab, as its administrator, for 2 hours (written in the journal). */
export async function openShop(id: number) {
  const tab = window.open('about:blank', '_blank');
  try {
    const r = await req<{ token: string }>(`/open/${id}`);
    const url = `${window.location.origin}${window.location.pathname}#/support/${r.token}`;
    if (tab) tab.location.href = url;
    else window.location.href = url;
  } catch (e) {
    tab?.close();
    throw e;
  }
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
