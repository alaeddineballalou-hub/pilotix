// A confirmation agency's work on its sellers' orders, with the seller picker at the top of the page:
// - one seller: the store's own Confirmation and Suivi screens, as the agency's agents see them there;
// - « Tous les vendeurs »: every seller's orders in one list (each with its seller), opened one at a time inside its
//   store; « Commande suivante » takes the customer who waits the most, whatever the seller.
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { useRpc, useRpcFor } from '../../lib/query';
import { SellerScope, setSeller, useSeller } from '../../lib/seller';
import { useSellers } from '../../lib/sellers';
import { AgentView, useSession } from '../../lib/session';
import { Empty, Icon, Loading, StageBar } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { Confirmation, Queue } from '../confirmation';
import { Focus } from '../confirmation/Focus';
import type { PageProps } from '../registry';
import { Commandes, DoneScreen } from '../orders';
import { Sav } from '../sav';
import { ClairList, List as SuiviList, Suivi } from '../suivi';

/** « Confirmation » of an agency: one seller's screen, or every seller's orders together. */
export function AgencyConfirmation(props: PageProps) {
  const seller = useSeller();
  return (
    <SellerScope seller={seller}>
      <AgentView>
        <NotGiven task="confirmation">{seller === 'all' ? <AllConfirmation {...props} /> : <Confirmation key={seller} {...props} />}</NotGiven>
      </AgentView>
    </SellerScope>
  );
}

/** « Suivi » of an agency: one seller's screen, or every seller's parcels together. */
export function AgencySuivi(props: PageProps) {
  const seller = useSeller();
  const work = useSellers();
  return (
    <SellerScope seller={seller}>
      <AgentView tasks={[...work.tasks]}>
        <NotGiven task="suivi">
          {seller !== 'all' ? <Suivi key={seller} {...props} /> : props.sub === 'swap' || props.sub === 'reclamation' ? <PickSeller what={props.sub} /> : <AllSuivi {...props} />}
        </NotGiven>
      </AgentView>
    </SellerScope>
  );
}

/**
 * « Livré », « Annulé », « Toutes les commandes » of an agency: the store's own Commandes screens (the same everywhere,
 * owner's choice, 24 Nov 2026), on the agency's orders — each agent his own, its chiefs all of them; one seller's, or
 * every seller's together.
 */
export function AgencyCommandes(props: PageProps) {
  const seller = useSeller();
  const work = useSellers();
  return (
    <SellerScope seller={seller}>
      <AgentView tasks={[...work.tasks]}>
        <NotGiven task="suivi">
          <Commandes key={seller} {...props} sub={props.sub || 'tout'} />
        </NotGiven>
      </AgentView>
    </SellerScope>
  );
}

export function AgencySav(props: PageProps) {
  const { t } = useTranslation();
  const seller = useSeller();
  const work = useSellers();
  if (!work.loaded) return <Loading />;
  if (!work.tasks.has('sav')) return <Empty>{t('agency.alerts.pickSav')}</Empty>;
  return <SellerScope seller={seller}><AgentView tasks={['sav']}><Sav key={seller} {...props} sub={props.sub === 'stats' ? 'tickets' : props.sub} /></AgentView></SellerScope>;
}

/** Réclamations and Swap are done in one seller's store at a time: choose it at the top. */
function PickSeller({ what }: { what: string }) {
  const { t } = useTranslation();
  const w = useSellers();
  const c = useRpc('suivi.counts', {}, { refetchInterval: 60_000 }).data as Record<string, number> | undefined;
  const links = what === 'reclamation' ? stepLinks('traites') : ['annules', 'swap'];
  return (
    <>
      <StageBar
        flow={false}
        items={links.map((k) => ({ key: k, label: t(k === 'traites' ? 'suivi.tabs.traitesAlert' : `suivi.tabs.${k}`), href: `#/suivi/${k}`, count: k === 'reclamation' || k === 'swap' ? undefined : c?.[k] }))}
        current={what}
      />
      <Empty>
      <p>{t('agency.work.pickSeller', { what: t(`suivi.tabs.${what}`) })}</p>
      {w.list.length === 1 && (
        <button type="button" className="btn primary" onClick={() => setSeller(w.list[0].id)}>
          <Icon name="store" /> {w.list[0].name}
        </button>
      )}
      </Empty>
    </>
  );
}

/** The seller chosen does not give this work to the agency (or no seller yet): say so, and offer all the sellers. */
function NotGiven({ task, children }: { task: 'confirmation' | 'suivi'; children: ReactNode }) {
  const { t } = useTranslation();
  const w = useSellers();
  if (!w.loaded) return <Loading />;
  if (!w.list.length) return <Empty>{t('agency.home.noWhere')}</Empty>;
  if (w.tasks.has(task) || (task === 'suivi' && w.tasks.has('confirmation'))) return <>{children}</>;
  return (
    <Empty>
      <p>{w.one ? t(`agency.work.notGiven.${task}`, { seller: w.one.name }) : t(`agency.work.noneGives.${task}`)}</p>
      {w.one && (
        <button type="button" className="btn primary" onClick={() => setSeller('all')}>
          <Icon name="store" /> {t('agency.pick.all')}
        </button>
      )}
    </Empty>
  );
}

// ---------------------------------------------------------------- what a seller's « Toutes les boutiques » changes
/**
 * A seller's « Toutes les boutiques » (pages/boutiques/all.tsx) uses these lists too: its words, its filters, each
 * row's boutique. Missing: an agency's « Tous les vendeurs ».
 */
export interface AllScope {
  /** the column of the shop, and the chip saying « all of them » */
  label: string;
  chip: ReactNode;
  /** a row's shop */
  tag: (s: { id: number; name: string }) => ReactNode;
  /** the filters above the list, and what they add to its request */
  bar?: ReactNode;
  input?: Record<string, unknown>;
  /** what the counts are asked (the boutiques kept) */
  counts?: Record<string, unknown>;
  /** a shop's name (« Commande suivante ») */
  nameOf?: (id: number) => string;
  /** Suivi: the tabs of the bar (default: the step of the agency's menu) */
  tabs?: string[];
}

// ---------------------------------------------------------------- Confirmation, every seller
type Sub = 'nouvelles' | 'attente' | 'confirmees';
const SUBS: Sub[] = ['nouvelles', 'attente', 'confirmees'];

export function AllConfirmation({ sub: raw, scope }: PageProps & { scope?: AllScope }) {
  const { t } = useTranslation();
  const sub: Sub = SUBS.includes(raw as Sub) ? (raw as Sub) : 'nouvelles';
  const c = useRpc('confirmation.counts', (scope?.counts ?? {}) as never, { refetchInterval: 60_000 }).data;
  return (
    <>
      <StageBar items={SUBS.map((k) => ({ key: k, label: t(`confirmation.sub.${k}`), href: `#/confirmation/${k}`, count: c?.[k] }))} current={sub} />
      <Queue key={sub} sub={sub} focusId={null} combined={{
        agency: !scope, chip: scope?.chip ?? <span className="chip agx-all-chip"><Icon name="store" /> {t('agency.pick.allShort')}</span>,
        bar: scope?.bar, input: scope?.input, source: scope?.tag,
        next: (onClose) => <FocusAll onClose={onClose} scope={scope} />,
      }} />
    </>
  );
}

function FocusAll({ onClose, scope }: { onClose: () => void; scope?: AllScope }) {
  const { t } = useTranslation();
  const [cur, setCur] = useState<{ seller: number; id: number } | null>(null);
  const [done, setDone] = useState(false);
  const skip = useRef<{ s: number; id: number }[]>([]);
  const sellers = useRpcFor(null, 'agency.sellers', {}, { staleTime: 60_000, enabled: !scope });
  const next = async () => {
    try {
      if (cur) await rpc('confirmation.release', { id: cur.id }, cur.seller).catch(() => {});
      const r = (await rpc('orders.next', { skip: [], skipAll: skip.current.slice(-400), ...(scope?.input ?? {}) } as never, 'all')) as unknown as { id: number | null; seller: number | null };
      if (r.id && r.seller) {
        skip.current.push({ s: r.seller, id: r.id });
        setCur({ seller: r.seller, id: r.id });
        setDone(false);
      } else {
        setCur(null);
        setDone(true);
      }
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    }
  };
  // the first order at once
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void next();
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const name = (cur && scope?.nameOf?.(cur.seller)) || ((sellers.data ?? []).find((s) => s.id === cur?.seller)?.name ?? '');
  if (!cur)
    return (
      <div className="card">
        <div className="card-head">
          <h2>{t('confirmation.focus.title')}</h2>
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
        <div className="empty-box">{done ? t('confirmation.focus.none') : t('common.loading')}</div>
      </div>
    );
  return (
    <SellerScope key={`${cur.seller}:${cur.id}`} seller={cur.seller}>
      <Focus initialId={cur.id} onClose={onClose} onNext={next} seller={name} allSellers />
    </SellerScope>
  );
}

// ---------------------------------------------------------------- Suivi, every seller
type Tab = 'enlivraison' | 'alertes' | 'alertes_new' | 'alertes_encours' | 'traites' | 'livres' | 'annules';
const TABS: Tab[] = ['enlivraison', 'alertes', 'alertes_new', 'alertes_encours', 'traites', 'livres', 'annules'];
/** the tabs of the step chosen in the agency's menu: En livraison · Alertes (new, in progress, handled) · Livré · Annulé */
const stepTabs = (tab: Tab): Tab[] => (['alertes', 'alertes_new', 'alertes_encours', 'traites'].includes(tab) ? ['alertes_new', 'alertes_encours', 'traites'] : [tab]);
/** the step's links: Alertes also has « Réclamation » (with one seller chosen) */
const stepLinks = (tab: Tab): string[] => (stepTabs(tab).includes('traites') ? [...stepTabs(tab), 'reclamation'] : stepTabs(tab));
export function AllSuivi({ sub, scope }: PageProps & { scope?: AllScope }) {
  const { t } = useTranslation();
  const { has } = useSession();
  const work = useSellers(!scope);
  // « alertes-new » is « alertes_new » (the Deploy page's « Essayer » links carry dashes)
  const sub_ = sub?.replace(/-/g, '_');
  const asked: Tab = TABS.includes(sub_ as Tab) ? (sub_ as Tab) : 'enlivraison';
  const tab: Tab = !has('suivi') && !['enlivraison', 'livres', 'annules'].includes(asked) ? 'enlivraison' : asked;
  const c = useRpc('suivi.counts', (scope?.counts ?? {}) as never, { refetchInterval: 60_000 }).data;
  return (
    <>
      <StageBar flow={false} items={(scope?.tabs ?? stepLinks(tab)).map((k) => ({ key: k, label: t(k === 'traites' && !scope ? 'suivi.tabs.traitesAlert' : `suivi.tabs.${k}`), href: `#/suivi/${k}`, count: k === 'reclamation' || k === 'swap' ? undefined : c?.[k as Tab] }))} current={tab === 'alertes' ? 'alertes_new' : tab} />
      {tab === 'annules' ? (
        // « Annulé » is the same screen everywhere (owner's choice, 24 Nov 2026), on its returns
        <DoneScreen sub="annulees" start="back" />
      ) : !scope && (tab === 'alertes' || tab === 'alertes_new' || tab === 'alertes_encours') ? (
        // the alerts in a store's « Clair » design (owner's choice, 27 Nov 2026): every seller in one list, « Alerte
        // suivante » takes the most urgent alert of any seller the agency follows
        <ClairList key={tab} tab={tab === 'alertes_encours' ? 'alertes_encours' : 'alertes_new'} allSellers={{ canWork: (id) => !!work.list.find((s) => s.id === id)?.tasks.includes('suivi') }} />
      ) : (
        <SuiviList key={tab} tab={tab} combined={{
          input: scope?.input, bar: scope?.bar,
          chip: scope?.chip ?? <span className="chip agx-all-chip"><Icon name="store" /> {t('agency.pick.allShort')}</span>,
          canWork: scope ? undefined : (id) => !!work.list.find((s) => s.id === id)?.tasks.includes('suivi'),
        }} />
      )}
    </>
  );
}
