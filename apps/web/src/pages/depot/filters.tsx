// The Dépôt lists' filters (Société, Wilaya, Produit): the same on the table and on the cards of each stage.
import { useState } from 'react';
import { ClearFilters, CompanyFilter, ProductFilter, WilayaFilter } from '../../ui/filters';

const NO = { company: '', wilaya: '', product: '', variant: '' };

export function useDepotFilters() {
  const [f, setF] = useState(NO);
  const set = (patch: Partial<typeof NO>) => setF((x) => ({ ...x, ...patch }));
  const on = (['company', 'wilaya', 'product'] as const).filter((k) => f[k]).length;
  const input = {
    companyId: f.company === 'none' ? ('none' as const) : f.company ? Number(f.company) : undefined,
    wilayaId: f.wilaya ? Number(f.wilaya) : undefined,
    productId: f.product ? Number(f.product) : undefined,
    variantId: f.product && f.variant ? Number(f.variant) : undefined,
  };
  const fields = (
    <>
      <CompanyFilter value={f.company} onChange={(v) => set({ company: v })} />
      <WilayaFilter value={f.wilaya} onChange={(v) => set({ wilaya: v })} />
      <ProductFilter product={f.product} variant={f.variant} onChange={(v) => set(v)} />
      <ClearFilters on={on > 0} onClear={() => setF(NO)} />
    </>
  );
  return { input, on, fields, key: JSON.stringify(f) };
}
