import type { OfflineAction } from '@pilotix/shared';
import { createStore, get, set } from 'idb-keyval';
import { useSyncExternalStore } from 'react';
import { api, ApiError } from './api';

/**
 * Actions made while the network is down are kept on the phone (IndexedDB) and replayed in order
 * when it comes back. Each action has a unique clientId, so the server never applies one twice.
 */
const idb = (() => {
  try {
    return createStore('pilotix', 'offline');
  } catch {
    return null;
  }
})();

let queue: OfflineAction[] = [];
let online = typeof navigator === 'undefined' ? true : navigator.onLine;
let syncing = false;
const listeners = new Set<() => void>();
let snapshot = { online, pending: 0, syncing: false };

function notify() {
  snapshot = { online, pending: queue.length, syncing };
  listeners.forEach((l) => l());
}

async function persist() {
  if (!idb) return;
  try {
    await set('queue', queue, idb);
  } catch {
    /* storage full or blocked: queue stays in memory */
  }
}

export const newClientId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export async function enqueue(action: Omit<OfflineAction, 'clientId' | 'at'>) {
  queue.push({ ...action, clientId: newClientId(), at: new Date().toISOString() });
  await persist();
  notify();
}

export async function flush(): Promise<void> {
  if (syncing || !queue.length || !online) return;
  syncing = true;
  notify();
  try {
    const batch = queue.slice(0, 100);
    const { results } = await api.sync(batch);
    // Applied or refused for good (e.g. not allowed): remove. Network errors keep the action for later.
    const done = new Set(results.map((r) => r.clientId));
    queue = queue.filter((a) => !done.has(a.clientId));
    await persist();
  } catch {
    // Network down or server error for the whole batch: keep everything and retry later.
  } finally {
    syncing = false;
    notify();
  }
  if (queue.length && online) setTimeout(flush, 2000);
}

export async function initOffline() {
  if (idb) {
    try {
      queue = ((await get('queue', idb)) as OfflineAction[] | undefined) ?? [];
    } catch {
      queue = [];
    }
  }
  window.addEventListener('online', () => {
    online = true;
    notify();
    flush();
  });
  window.addEventListener('offline', () => {
    online = false;
    notify();
  });
  notify();
  flush();
  setInterval(flush, 30_000);
}

export function useNetwork() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

/** True when an error means "couldn't reach the server" (so the action should be queued). */
export const isNetworkError = (e: unknown) => e instanceof ApiError && e.status === 0 && e.message === 'NETWORK';
