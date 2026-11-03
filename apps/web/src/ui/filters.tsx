// The fields of the filter bars shared by the lists (Commandes, Suivi, SAV, Dépôt, Caisse): the agent, the team, the
// product and its variant, the company, the livreur, the wilaya, the reason, cashed or not, the period. Each one is a
// `field more-f` of a `.filters` grid (on a phone they fold under « Filtres »). Their lists come from one call
// (filters.options), kept a few minutes.
import { WILAYAS } from '@pilotix/shared';
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { wilaya } from '../lib/format';
import { useRpc } from '../lib/query';
import { Icon } from './kit';

export const useFilterOptions = () => useRpc('filters.options', {}, { staleTime: 5 * 60_000 }).data;

/** Who an agent filter lists: confirmation agents, suivi agents, or anyone who works on SAV tickets. */
export type AgentKind = 'conf' | 'follow' | 'sav';
const KIND_ROLES: Record<AgentKind, string[]> = {
  conf: ['confirmation', 'agent_manager', 'vendeur', 'admin'],
  follow: ['suivi', 'vendeur', 'admin'],
  sav: ['confirmation', 'suivi', 'depot', 'vendeur', 'admin'],
};

function Sel({ label, value, onChange, all, children, disabled, title }: { label: string; value: string; onChange: (v: string) => void; all: string; children: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label className="field more-f">
      <span className="lab">{label}</span>
      <select value={value} disabled={disabled} title={title} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>
        {children}
      </select>
    </label>
  );
}

export function AgentFilter({ value, onChange, kind, label, none = true }: { value: string; onChange: (v: string) => void; kind: AgentKind; label?: string; none?: boolean }) {
  const { t } = useTranslation();
  const o = useFilterOptions();
  const roles = KIND_ROLES[kind];
  const list = (o?.agents ?? []).filter((a) => a.roles.some((r) => roles.includes(r)) || String(a.id) === value);
  return (
    <Sel label={label ?? t(kind === 'follow' ? 'filters.agentFollow' : kind === 'sav' ? 'filters.owner' : 'filters.agent')} value={value} onChange={onChange} all={t('filters.all')}>
      {none && <option value="none">{t('filters.noAgent')}</option>}
      {list.map((a) => (
        <option key={a.id} value={a.id}>
          {a.active ? a.name : `${a.name} ${t('filters.off')}`}
        </option>
      ))}
    </Sel>
  );
}

/** Hidden while the shop has no team. */
export function TeamFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const teams = useFilterOptions()?.teams ?? [];
  if (!teams.length) return null;
  return (
    <Sel label={t('filters.team')} value={value} onChange={onChange} all={t('filters.allF')}>
      {teams.map((x) => (
        <option key={x.id} value={x.id}>
          {x.name}
        </option>
      ))}
    </Sel>
  );
}

/** The product, then its variant (only for a product with colours or sizes). */
export function ProductFilter({ product, variant, onChange }: { product: string; variant: string; onChange: (v: { product: string; variant: string }) => void }) {
  const { t } = useTranslation();
  const products = useFilterOptions()?.products ?? [];
  const cur = products.find((p) => String(p.id) === product);
  return (
    <>
      <Sel label={t('filters.product')} value={product} onChange={(v) => onChange({ product: v, variant: '' })} all={t('filters.allProducts')}>
        {products.map((p) => (
          <option key={p.id} value={p.id}>
            {p.active ? p.name : `${p.name} ${t('filters.off')}`}
          </option>
        ))}
      </Sel>
      {!!cur?.variants.length && (
        <Sel label={t('filters.variant')} value={variant} onChange={(v) => onChange({ product, variant: v })} all={t('filters.allF')}>
          {cur.variants.map((v) => (
            <option key={v.id} value={v.id}>
              {v.title}
            </option>
          ))}
        </Sel>
      )}
    </>
  );
}

export function CompanyFilter({ value, onChange, none = true }: { value: string; onChange: (v: string) => void; none?: boolean }) {
  const { t } = useTranslation();
  const list = useFilterOptions()?.companies ?? [];
  return (
    <Sel label={t('filters.company')} value={value} onChange={onChange} all={t('filters.allF')}>
      {none && <option value="none">{t('filters.noCompany')}</option>}
      {list.map((c) => (
        <option key={c.id} value={c.id}>
          {c.active ? c.name : `${c.name} ${t('filters.off')}`}
        </option>
      ))}
    </Sel>
  );
}

/** Hidden while the shop has no livreur of its own. */
export function LivreurFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const list = useFilterOptions()?.livreurs ?? [];
  if (!list.length && !value) return null;
  return (
    <Sel label={t('filters.livreur')} value={value} onChange={onChange} all={t('filters.all')}>
      {list.map((l) => (
        <option key={l.id} value={l.id}>
          {l.active ? l.name : `${l.name} ${t('filters.off')}`}
        </option>
      ))}
    </Sel>
  );
}

export function WilayaFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <Sel label={t('filters.wilaya')} value={value} onChange={onChange} all={t('filters.allF')}>
      {WILAYAS.map((_, i) => (
        <option key={i + 1} value={i + 1}>
          {wilaya(i + 1)}
        </option>
      ))}
    </Sel>
  );
}

/** Why the orders were cancelled at the confirmation (conf) or came back (back); « Sans motif »: none given. */
export const NO_REASON = '__none';
export function ReasonFilter({ of, value, onChange }: { of: 'conf' | 'back'; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const list = useFilterOptions()?.reasons[of] ?? [];
  return (
    <Sel label={t('filters.reason')} value={value} onChange={onChange} all={t('filters.all')}>
      <option value={NO_REASON}>{t('filters.noReason')}</option>
      {list.map((r) => (
        <option key={r.text} value={r.text}>
          {r.text}
        </option>
      ))}
      {value && value !== NO_REASON && !list.some((r) => r.text === value) && <option value={value}>{value}</option>}
    </Sel>
  );
}

export function CashedFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <Sel label={t('filters.cashed')} value={value} onChange={onChange} all={t('filters.all')}>
      <option value="yes">{t('filters.cashedYes')}</option>
      <option value="no">{t('filters.cashedNo')}</option>
    </Sel>
  );
}

export function DateFilters({ from, to, onChange }: { from: string; to: string; onChange: (v: { from?: string; to?: string }) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <label className="field more-f">
        <span className="lab">{t('filters.from')}</span>
        <input type="date" value={from} max={to || undefined} onChange={(e) => onChange({ from: e.target.value })} />
      </label>
      <label className="field more-f">
        <span className="lab">{t('filters.to')}</span>
        <input type="date" value={to} min={from || undefined} onChange={(e) => onChange({ to: e.target.value })} />
      </label>
    </>
  );
}

/** « Effacer les filtres », at the end of the grid while a filter is on. */
export function ClearFilters({ on, onClear }: { on: boolean; onClear: () => void }) {
  const { t } = useTranslation();
  if (!on) return null;
  return (
    <div className="field more-f px-f-clear">
      <button type="button" className="btn ghost" onClick={onClear}>
        {t('filters.clear')}
      </button>
    </div>
  );
}

/** A day (yyyy-mm-dd, Algiers time) as the lists read it: its first moment, or the first moment of the next day (`end`). */
export const dayIso = (d: string, end = false) => new Date(Date.parse(`${d}T00:00:00+01:00`) + (end ? 86_400_000 : 0)).toISOString();

/** The cards views (phones, and « Cartes » on a computer): « Filtres · 2 » under the search, the fields when opened. */
export function FiltersPanel({ on, children }: { on: number; children: ReactNode }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`px-fbtn${on ? ' on' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="sliders" /> {t('filters.toggle')}
        {on > 0 && <b className="ltr">{on}</b>}
      </button>
      {open && <div className="filters open px-fpanel">{children}</div>}
    </>
  );
}
