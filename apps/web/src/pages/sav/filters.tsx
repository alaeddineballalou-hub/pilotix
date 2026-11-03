// SAV's filters (Responsable, Produit, Du / Au): the same on the table and on the cards, kept in this browser.
import { useState } from 'react';
import { store } from '../../lib/store';
import { AgentFilter, ClearFilters, DateFilters, dayIso, ProductFilter } from '../../ui/filters';

const NO = { agent: '', product: '', variant: '', from: '', to: '' };
type SavF = typeof NO;

export function useSavFilters() {
  const [f, setF] = useState<SavF>(() => ({ ...NO, ...store.json<Partial<SavF>>('sav-f', {}) }));
  const set = (patch: Partial<SavF>) =>
    setF((x) => {
      const nx = { ...x, ...patch };
      store.set('sav-f', JSON.stringify(nx));
      return nx;
    });
  const on = (['agent', 'product', 'from', 'to'] as const).filter((k) => f[k]).length;
  const input = {
    agentId: f.agent ? Number(f.agent) : undefined,
    productId: f.product ? Number(f.product) : undefined,
    variantId: f.product && f.variant ? Number(f.variant) : undefined,
    from: f.from ? dayIso(f.from) : undefined,
    to: f.to ? dayIso(f.to, true) : undefined,
  };
  const fields = (
    <>
      <AgentFilter kind="sav" none={false} value={f.agent} onChange={(v) => set({ agent: v })} />
      <ProductFilter product={f.product} variant={f.variant} onChange={(v) => set(v)} />
      <DateFilters from={f.from} to={f.to} onChange={(v) => set(v)} />
      <ClearFilters on={on > 0} onClear={() => set(NO)} />
    </>
  );
  return { input, on, fields };
}
