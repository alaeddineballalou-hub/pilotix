// The boutique's optional modules (Management › Modules; @pilotix/core modules/shopmodules.ts): which ones are on. The
// menu shows a module's page only then (layout/nav.ts asks moduleOn). This browser keeps each boutique's last answer, so
// a module's page opens at once after a reload (its actions refuse anyway if it was turned off meanwhile).
import type { ShopModule } from '@pilotix/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { rpc } from './backend';
import { useSession } from './session';
import { store } from './store';

type Modules = Partial<Record<ShopModule, boolean>>;
/** the boutique open now (set while the app draws, before its menu reads it) */
let current: Modules = {};

/** Is this module on in the boutique open? */
export const moduleOn = (m: ShopModule) => current[m] === true;

/** Loads the open boutique's modules (the app, once); its menu and pages follow them. */
export function useShopModules(): Modules {
  const { session } = useSession();
  const inStore = !!session && (!session.shop?.kind || session.shop.kind === 'store');
  const shop = session?.shop?.id ?? 0;
  const key = `modules-${shop}`;
  // the boutique open itself (null), never « Toutes les boutiques » or the boutique of an order open on screen
  const q = useQuery({ queryKey: ['modules.get', shop], queryFn: () => rpc('modules.get', {}, null), enabled: inStore, staleTime: 60_000 });
  useEffect(() => {
    if (q.data) store.set(key, JSON.stringify(q.data));
  }, [q.data, key]);
  current = !inStore ? {} : (q.data ?? store.json<Modules>(key, {}));
  return current;
}
