// « Toutes les boutiques »: someone with several boutiques (the owner, or an agent of two of them) sees them together on
// the screens that can (Accueil, Dashboard, Commandes, Confirmation, Suivi); the other pages stay boutique by boutique
// and say so. Chosen at the bottom of the menu, kept in this browser. The « Boutique » filter keeps some of them; a
// person, a product or a company is not the same thing in every boutique (each has its own ids), so the filters list
// them boutique by boutique and the request carries each boutique's own ids (byShop; null: that boutique is left out).
import type { Boutique } from '@pilotix/shared';
import { ReactNode, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { WILAYAS, SALES_CHANNELS } from '@pilotix/shared';
import { wilaya } from '../lib/format';
import { useRpcFor } from '../lib/query';
import { useSession } from '../lib/session';
import { allOnRaw, initAll, keptShops, pingAll, setAllOn, setShopFilter, subscribeAll } from '../lib/allMode';
import { store } from '../lib/store';
import { BoutiqueLogo, useBoutiques } from './Boutiques';

// ---------------------------------------------------------------- on / off, and the boutiques kept (lib/allMode.ts)
export { setAllOn, setShopFilter };

/** The stores of the person (not a partner's space): two or more make « Toutes les boutiques » possible. */
export function useAllMode(): { on: boolean; can: boolean; boutiques: Boutique[] } {
  const { session } = useSession();
  initAll(session?.profile.email);
  const v = useSyncExternalStore(subscribeAll, allOnRaw);
  const list = (useBoutiques().data ?? []).filter((b) => b.kind === 'store' && (!b.locked || b.current));
  const space = session?.shop?.kind;
  const can = list.length >= 2 && space !== 'agency' && space !== 'marketer';
  return { on: can && v, can, boutiques: list };
}

/** The « Boutique » filter: the boutiques kept (null: all of them). */
export function useShopFilter(): number[] | null {
  return useSyncExternalStore(subscribeAll, keptShops);
}

/** Several logos, one over the other: « Toutes les boutiques ». */
export function StackLogo({ list, size = 32 }: { list: Boutique[]; size?: number }) {
  const few = list.slice(0, 3);
  const s = Math.round(size * 0.72);
  return (
    <span className="bq-stack" style={{ width: size + (few.length - 1) * Math.round(s * 0.42), height: size }} aria-hidden="true">
      {few.map((b, i) => (
        <span key={b.id} className="bq-stack-i" style={{ insetInlineStart: i * Math.round(s * 0.42), top: i % 2 ? size - s : 0, zIndex: 3 - i }}>
          <BoutiqueLogo name={b.name} logo={b.logo} size={s} />
        </span>
      ))}
    </span>
  );
}

/** « Toutes » then each boutique: a tap keeps it (several can be kept); « Toutes » brings every one back. */
export function BoutiqueChips() {
  const { t } = useTranslation();
  const all = useAllMode();
  const kept = useShopFilter();
  if (!all.on) return null;
  const toggle = (id: number) => {
    const cur = kept ?? [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    setShopFilter(next.length === all.boutiques.length ? null : next);
  };
  return (
    <div className="bq-chips" role="group" aria-label={t('boutiques.all.filter')}>
      <button type="button" className={`bq-chip${!kept ? ' on' : ''}`} aria-pressed={!kept} onClick={() => setShopFilter(null)}>
        <StackLogo list={all.boutiques} size={22} />
        {t('boutiques.all.every')}
      </button>
      {all.boutiques.map((b) => {
        const k = !!kept?.includes(b.id);
        return (
          <button key={b.id} type="button" className={`bq-chip${k ? ' on' : ''}`} aria-pressed={k} onClick={() => toggle(b.id)}>
            <BoutiqueLogo name={b.name} logo={b.logo} size={22} />
            {b.name}
          </button>
        );
      })}
    </div>
  );
}

/** A row's boutique: its logo and its name (« Toutes les boutiques » lists). */
export function BoutiqueTag({ id, name }: { id: number; name?: string }) {
  const list = useBoutiques().data ?? [];
  const b = list.find((x) => x.id === id);
  const label = b?.name ?? name ?? '';
  return (
    <span className="bq-tag" title={label}>
      <BoutiqueLogo name={label} logo={b?.logo ?? null} size={20} />
      <span>{label}</span>
    </span>
  );
}

/** On a page that stays boutique by boutique: which boutique it shows. */
export function AllBanner() {
  const { t } = useTranslation();
  const all = useAllMode();
  if (!all.on) return null;
  const cur = all.boutiques.find((b) => b.current);
  return (
    <div className="bq-banner" role="note">
      <StackLogo list={all.boutiques} size={24} />
      <span>{t('boutiques.all.pageOne', { name: cur?.name ?? '' })}</span>
      <button type="button" className="btn small ghost" onClick={() => setAllOn(false)}>
        {t('boutiques.all.leave')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- the filters over several boutiques
type Opt = {
  agents: { id: number; name: string; roles: string[]; active: boolean; key?: string }[];
  teams: { id: string; name: string }[];
  products: { id: number; name: string; active: boolean; variants: { id: number; title: string }[] }[];
  companies: { id: number; name: string; kind: string; active: boolean }[];
  livreurs: { id: number; name: string; active: boolean; key?: string }[];
  reasons: { conf: { text: string; n: number }[]; back: { text: string; n: number }[] };
};
export type AllOptions = { boutiques: { id: number; name: string; options: Opt }[] };

/** Every boutique's lists (filters.options, boutique by boutique). */
export function useAllOptions(): AllOptions | undefined {
  return useRpcFor('all', 'filters.options', {}, { staleTime: 5 * 60_000 }).data as unknown as AllOptions | undefined;
}

/** What the filters hold: a person and a company by their key (the same in every boutique), a team and a product as « boutique:id ». */
export interface AllF {
  agent: string;
  team: string;
  product: string;
  variant: string;
  company: string;
  livreur: string;
  wilaya: string;
  channel: string;
  reason: string;
  from: string;
  to: string;
}
export const NO_ALLF: AllF = { agent: '', team: '', product: '', variant: '', company: '', livreur: '', wilaya: '', channel: '', reason: '', from: '', to: '' };

type Group = { name: string; ids: Record<number, number>; active: boolean; roles: Set<string>; where: string[] };
/** One entry per person / company over the boutiques kept, with its id in each of them. */
function grouped(o: AllOptions | undefined, kept: number[] | null) {
  const people = new Map<string, Group>();
  const livreurs = new Map<string, Group>();
  const companies = new Map<string, Group>();
  const add = (m: Map<string, Group>, k: string, b: { id: number; name: string }, x: { id: number; name: string; active: boolean }, roles: string[] = []) => {
    const g = m.get(k) ?? { name: x.name, ids: {}, active: false, roles: new Set<string>(), where: [] };
    g.ids[b.id] = x.id;
    g.active ||= x.active;
    roles.forEach((r) => g.roles.add(r));
    if (!g.where.includes(b.name)) g.where.push(b.name);
    m.set(k, g);
  };
  const bs = (o?.boutiques ?? []).filter((b) => !kept || kept.includes(b.id));
  for (const b of bs) {
    for (const a of b.options.agents) add(people, a.key ?? `${b.id}:${a.id}`, b, a, a.roles);
    for (const l of b.options.livreurs) add(livreurs, l.key ?? `${b.id}:${l.id}`, b, l);
    for (const c of b.options.companies) add(companies, `${c.kind}:${c.name.trim().toLowerCase()}`, b, c);
  }
  const sorted = (m: Map<string, Group>) => [...m.entries()].sort((a, b) => Number(b[1].active) - Number(a[1].active) || a[1].name.localeCompare(b[1].name));
  return { bs, people: sorted(people), livreurs: sorted(livreurs), companies: sorted(companies), maps: { people, livreurs, companies } };
}

const ROLES_OF = { conf: ['confirmation', 'agent_manager', 'vendeur', 'admin'], follow: ['suivi', 'vendeur', 'admin'] } as const;
export type AllKey = 'agent' | 'team' | 'product' | 'company' | 'livreur' | 'wilaya' | 'channel' | 'reason' | 'dates';

/**
 * The request of a list over the boutiques kept: each boutique's own ids (byShop), and the boutiques kept (shops).
 * `agentField`: whose agent the « Agent » filter is (confirmation: agentId, suivi: followAgentId).
 */
export function allScope(f: AllF, o: AllOptions | undefined, kept: number[] | null, agentField: 'agentId' | 'followAgentId' = 'agentId') {
  const g = grouped(o, kept);
  const out: { shops?: number[]; byShop?: Record<string, Record<string, unknown> | null> } = kept ? { shops: kept } : {};
  if (!o || !(f.agent || f.team || f.product || f.company || f.livreur)) return out;
  const byShop: Record<string, Record<string, unknown> | null> = {};
  for (const b of g.bs) {
    const x: Record<string, unknown> = {};
    let left = false;
    if (f.agent === 'none') x[agentField] = 'none';
    else if (f.agent) {
      const id = g.maps.people.get(f.agent)?.ids[b.id];
      if (id) x[agentField] = id;
      else left = true;
    }
    if (f.team) {
      const [s, tid] = f.team.split(':');
      if (Number(s) === b.id) x.teamId = tid;
      else left = true;
    }
    if (f.product) {
      const [s, pid] = f.product.split(':');
      if (Number(s) === b.id) {
        x.productId = Number(pid);
        if (f.variant) x.variantId = Number(f.variant);
      } else left = true;
    }
    if (f.company === 'none') x.companyId = 'none';
    else if (f.company) {
      const id = g.maps.companies.get(f.company)?.ids[b.id];
      if (id) x.companyId = id;
      else left = true;
    }
    if (f.livreur) {
      const id = g.maps.livreurs.get(f.livreur)?.ids[b.id];
      if (id) x.livreurId = id;
      else left = true;
    }
    byShop[String(b.id)] = left ? null : x;
  }
  return { ...out, byShop };
}

/** The filter fields over several boutiques (`.filters` grid fields). */
export function AllFields({ f, set, show, agentKind = 'conf', reasonOf }: { f: AllF; set: (p: Partial<AllF>) => void; show: AllKey[]; agentKind?: 'conf' | 'follow'; reasonOf?: 'conf' | 'back' }) {
  const { t } = useTranslation();
  const o = useAllOptions();
  const kept = useShopFilter();
  const g = grouped(o, kept);
  const many = g.bs.length > 1;
  const where = (x: Group) => (many && x.where.length < g.bs.length ? ` · ${x.where.join(', ')}` : '');
  const off = (x: { active: boolean }) => (x.active ? '' : ` ${t('filters.off')}`);
  const sel = (label: string, value: string, onChange: (v: string) => void, all: string, children: ReactNode) => (
    <label className="field more-f">
      <span className="lab">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{all}</option>
        {children}
      </select>
    </label>
  );
  const prod = f.product ? g.bs.find((b) => b.id === Number(f.product.split(':')[0]))?.options.products.find((p) => p.id === Number(f.product.split(':')[1])) : undefined;
  const reasons = reasonOf ? [...new Set(g.bs.flatMap((b) => b.options.reasons[reasonOf].map((r) => r.text)))] : [];
  return (
    <>
      {show.includes('agent') &&
        sel(t(agentKind === 'follow' ? 'filters.agentFollow' : 'filters.agent'), f.agent, (v) => set({ agent: v }), t('filters.all'), (
          <>
            <option value="none">{t('filters.noAgent')}</option>
            {g.people
              .filter(([k, x]) => [...x.roles].some((r) => (ROLES_OF[agentKind] as readonly string[]).includes(r)) || k === f.agent)
              .map(([k, x]) => (
                <option key={k} value={k}>
                  {x.name}
                  {off(x)}
                  {where(x)}
                </option>
              ))}
          </>
        ))}
      {show.includes('team') &&
        g.bs.some((b) => b.options.teams.length) &&
        sel(t('filters.team'), f.team, (v) => set({ team: v }), t('filters.allF'), (
          <>
            {g.bs
              .filter((b) => b.options.teams.length)
              .map((b) => (
                <optgroup key={b.id} label={b.name}>
                  {b.options.teams.map((x) => (
                    <option key={x.id} value={`${b.id}:${x.id}`}>
                      {x.name}
                    </option>
                  ))}
                </optgroup>
              ))}
          </>
        ))}
      {show.includes('product') && (
        <>
          {sel(t('filters.product'), f.product, (v) => set({ product: v, variant: '' }), t('filters.allProducts'), (
            <>
              {g.bs.map((b) => (
                <optgroup key={b.id} label={b.name}>
                  {b.options.products.map((p) => (
                    <option key={p.id} value={`${b.id}:${p.id}`}>
                      {p.name}
                      {off(p)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </>
          ))}
          {!!prod?.variants.length &&
            sel(t('filters.variant'), f.variant, (v) => set({ variant: v }), t('filters.allF'), (
              <>
                {prod.variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title}
                  </option>
                ))}
              </>
            ))}
        </>
      )}
      {show.includes('company') &&
        sel(t('filters.company'), f.company, (v) => set({ company: v }), t('filters.allF'), (
          <>
            <option value="none">{t('filters.noCompany')}</option>
            {g.companies.map(([k, x]) => (
              <option key={k} value={k}>
                {x.name}
                {off(x)}
                {where(x)}
              </option>
            ))}
          </>
        ))}
      {show.includes('livreur') &&
        g.livreurs.length > 0 &&
        sel(t('filters.livreur'), f.livreur, (v) => set({ livreur: v }), t('filters.all'), (
          <>
            {g.livreurs.map(([k, x]) => (
              <option key={k} value={k}>
                {x.name}
                {off(x)}
                {where(x)}
              </option>
            ))}
          </>
        ))}
      {show.includes('wilaya') &&
        sel(t('filters.wilaya'), f.wilaya, (v) => set({ wilaya: v }), t('filters.allF'), (
          <>
            {WILAYAS.map((_, i) => (
              <option key={i + 1} value={i + 1}>
                {wilaya(i + 1)}
              </option>
            ))}
          </>
        ))}
      {show.includes('channel') &&
        sel(t('orders.f.source'), f.channel, (v) => set({ channel: v }), t('filters.allF'), (
          <>
            {SALES_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {t(`status.channel.${c}`)}
              </option>
            ))}
          </>
        ))}
      {show.includes('reason') &&
        reasonOf &&
        sel(t('filters.reason'), f.reason, (v) => set({ reason: v }), t('filters.all'), (
          <>
            <option value="__none">{t('filters.noReason')}</option>
            {reasons.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </>
        ))}
      {show.includes('dates') && (
        <>
          <label className="field more-f">
            <span className="lab">{t('filters.from')}</span>
            <input type="date" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label className="field more-f">
            <span className="lab">{t('filters.to')}</span>
            <input type="date" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} />
          </label>
        </>
      )}
    </>
  );
}

/** How many filters are on (the boutiques kept apart). */
export const allCount = (f: AllF) => (Object.keys(NO_ALLF) as (keyof AllF)[]).filter((k) => k !== 'variant' && k !== 'to' && f[k]).length + (f.to && !f.from ? 1 : 0);

/** The filters of one « Toutes les boutiques » list, kept in this browser. */
export function useAllFilters(id: string): [AllF, (p: Partial<AllF>) => void, () => void] {
  const k = `all-f-${id}`;
  const v = useSyncExternalStore(subscribeAll, () => store.get(k) ?? '');
  const f: AllF = { ...NO_ALLF, ...(v ? (JSON.parse(v) as Partial<AllF>) : {}) };
  const set = (p: Partial<AllF>) => {
    store.set(k, JSON.stringify({ ...f, ...p }));
    pingAll();
  };
  return [f, set, () => (store.set(k, null), pingAll())];
}

