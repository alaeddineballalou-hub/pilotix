// A delivery company's small badge (Suivi, Dépôt, Livré, Annulé, Caisse, Réclamations): the company's OWN icon — its app
// icon or its website's icon, never a piece cut from its logo (the owner's rule, 24 Nov 2026) — else its letters, as
// before. The icons: apps/web/public/couriers/icon/<logo>.webp, made by scripts/courier-logos-icon.py, which also
// writes COURIER_ICONS. Which logo a company has comes from the server (delivery.icons: its card in « API Livraison »),
// so a new company shows its icon as soon as its icon file is added.
import { useMemo, useState, type HTMLAttributes, type ReactNode } from 'react';
import { useRpc } from '../lib/query';
import { COURIER_ICONS } from './courierIcons';

/** The address of a company's own icon, or null (none yet, or one of the shop's own livreurs: its letters). */
export function useCoIcon(companyId: number | null | undefined, kind: string | null | undefined): string | null {
  const q = useRpc('delivery.icons', {}, { staleTime: 10 * 60_000 });
  const byId = useMemo(() => new Map((q.data?.companies ?? []).map((c) => [c.id, c.logo])), [q.data]);
  if (kind === 'own') return null;
  // not in the list (another shop's company): the logo of its kind, when the kind is one company only (ZR, NOEST…)
  const logo = companyId != null && byId.has(companyId) ? byId.get(companyId) : kind ? q.data?.kinds[kind] : null;
  return logo && COURIER_ICONS.has(logo) ? `${import.meta.env.BASE_URL}couriers/icon/${logo}.webp` : null;
}

type Props = { companyId: number | null | undefined; kind: string | null | undefined; className: string; children: ReactNode } & Omit<HTMLAttributes<HTMLSpanElement>, 'className' | 'children'>;

/** The badge with the look of its place (`className`): the company's icon when there is one, else `children` (its letters). */
export function CoChip({ companyId, kind, className, children, ...rest }: Props) {
  const src = useCoIcon(companyId, kind);
  const [broken, setBroken] = useState<string | null>(null);
  if (src && broken !== src)
    return (
      <span className={`${className} has-ic`} {...rest}>
        <img src={src} alt="" decoding="async" draggable={false} onError={() => setBroken(src)} />
      </span>
    );
  return (
    <span className={className} {...rest}>
      {children}
    </span>
  );
}
