import { MENU_TABS, menuTabName } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useIsPhone } from '../../lib/useMedia';
import { useViewMode, ViewSwitch } from '../../ui/ViewSwitch';
import { useTranslation } from 'react-i18next';
import { dur, when } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { useScope } from '../../lib/seller';
import { ChooseSavSeller, TicketScope, ticketKey, type TicketRowScope } from './scope';
import { Empty, ErrorBox, Help, Icon, KpiBody, Loading, Pager, StageBar, StatusBadge } from '../../ui/kit';
import { PhoneOf } from '../../ui/PhoneOf';
import type { PageProps } from '../registry';
import { NewTicketModal } from './NewTicket';
import { PhoneSav } from './PhoneSav';
import { SavStats } from './Stats';
import { useSavFilters } from './filters';
import { TicketModal } from './Ticket';
import { tabOn } from '../../lib/rights';
import { SavSettings } from './Settings';
import { TableColumnMenu, useTableColumns } from '../../ui/ColumnMenu';

/** The columns of the SAV list (its own names: a preset made in an order list leaves them as they are). */
const SAV_COLS = ['no', 'sorder', 'problem', 'wish', 'tstatus', 'depot', 'owner', 'age'] as const;
type SavCol = (typeof SAV_COLS)[number];

/** the page's tabs: the menu's list (packages/shared/src/menu.ts), shared with Utilisateurs › Rôles */
const VIEWS = MENU_TABS.sav;
type View = (typeof VIEWS)[number];
export function Sav({ sub }: PageProps) {
  const { t } = useTranslation();
  // phones: SAV is built around the call (Nouvel appel → réglé au téléphone or échange → dépôt)
  const phone = useIsPhone();
  // SAV › Réglages (the gear, last in the bar): the SAV phone number and the SAV statuses
  if (sub === 'reglages' && tabOn('sav', 'reglages'))
    return phone ? (
      <div className="pxv">
        <a className="pxv-backl" href="#/sav/tickets">
          <Icon name="chevl" /> {t('sav.title')}
        </a>
        <SavSettings />
      </div>
    ) : (
      <>
        <SavBar view="reglages" />
        <SavSettings />
      </>
    );
  if (phone && sub === 'stats')
    return (
      <div className="pxv">
        <a className="pxv-backl" href="#/sav/tickets">
          <Icon name="chevl" /> {t('sav.title')}
        </a>
        <SavStats />
      </div>
    );
  if (phone) return <PhoneSav sub={sub} />;
  return <SavWide sub={sub} />;
}

/** Computers: the phone's SAV laid out wide (built around the call), or the desktop screens (« Tableau »). */
function SavWide({ sub }: PageProps) {
  const [mode, setMode] = useViewMode('sav');
  return (
    <>
      <div className="px-vsw-row">
        <ViewSwitch mode={mode} onChange={setMode} />
      </div>
      {mode === 'cards' && sub !== 'stats' ? (
        <div className="px-wide">
          <PhoneSav sub={sub} />
        </div>
      ) : (
        <SavDesktop sub={sub} />
      )}
    </>
  );
}

/** the bar of the SAV page (its tabs with their counts), the gear « Réglages » last */
function SavBar({ view }: { view: View }) {
  const { t } = useTranslation();
  const agency = useSession().session?.shop?.kind === 'agency';
  const k = useRpc('sav.kpis', {}, { refetchInterval: 60_000 }).data;
  const stageCount = (v: View): number | undefined => (k && (v === 'attente' || v === 'depot' || v === 'livraison' || v === 'livres' || v === 'annules' || v === 'satisfaction') ? k[v] : undefined);
  const cfg = tabOn('sav', 'reglages') ? { key: 'reglages', label: t(menuTabName('sav', 'reglages')), href: '#/sav/reglages' } : null;
  return <StageBar flow={false} current={view} items={VIEWS.filter((v) => v !== 'reglages' && (!agency || v !== 'stats') && tabOn('sav', v)).map((v) => ({ key: v, label: t(menuTabName('sav', v)), href: `#/sav/${v}`, count: stageCount(v) }))} end={cfg} />;
}

function SavDesktop({ sub }: PageProps) {
  const { t } = useTranslation();
  const combined = useScope() === 'all';
  const [page, setPage] = useState(1);
  const view: Exclude<View, 'reglages'> = sub !== 'reglages' && (VIEWS as readonly string[]).includes(sub ?? '') ? (sub as Exclude<View, 'reglages'>) : 'tickets';
  const [tab, setTab] = useState<'todo' | 'all'>(() => {
    try {
      return (localStorage.getItem('px-sav-tab') as 'todo' | 'all') || 'todo';
    } catch {
      return 'todo';
    }
  });
  const [q, setQ] = useState('');
  const [deb, setDeb] = useState('');
  // Responsable, Produit, Du / Au (kept in this browser)
  const sfl = useSavFilters();
  const [fOpen, setFOpen] = useState(false);
  const [open, setOpen] = useState<{ id: number; seller?: TicketRowScope['seller'] } | null>(null);
  const [creating, setCreating] = useState(view === 'nouveau');
  useEffect(() => {
    setCreating(view === 'nouveau');
    setOpen(null);
  }, [view]);
  useEffect(() => {
    const h = setTimeout(() => setDeb(q.trim()), 300);
    return () => clearTimeout(h);
  }, [q]);
  const chooseTab = (k: 'todo' | 'all') => {
    setTab(k);
    try {
      localStorage.setItem('px-sav-tab', k);
    } catch {
      /* private mode */
    }
  };
  const apiView = view === 'tickets' || view === 'nouveau' || view === 'stats' ? tab : view;
  const kp = useRpc('sav.kpis', {}, { refetchInterval: 60_000 });
  const filterKey = JSON.stringify(sfl.input);
  useEffect(() => setPage(1), [apiView, deb, filterKey]);
  const list = useRpc('sav.list', { view: apiView, q: deb || undefined, page, ...(combined ? {} : sfl.input) });
  const rows: TicketRowScope[] = list.data?.rows ?? [];
  const k = kp.data;
  // the columns each user sees (the column menu of every list)
  const tc = useTableColumns<SavCol>('sav', [...SAV_COLS]);
  const [colMenu, setColMenu] = useState(false);
  const shown = tc.order.filter((c) => tc.visible.has(c));
  const colLabel: Record<SavCol, string> = {
    no: t('sav.col.no'),
    sorder: t('sav.col.order'),
    problem: t('sav.col.problem'),
    wish: t('sav.col.wish'),
    tstatus: t('sav.col.ticket'),
    depot: t('sav.col.depot'),
    owner: t('sav.col.owner'),
    age: t('sav.col.since'),
  };
  const cell = (c: SavCol, x: TicketRowScope) => {
    switch (c) {
      case 'no':
        return (
          <td key={c} data-l={colLabel[c]}>
            <b className="ltr">{x.ref}</b>
            {x.seller && <small>{x.seller.name}</small>}
            <small>{when(x.createdAt)}</small>
          </td>
        );
      case 'sorder':
        return (
          <td key={c} data-l={colLabel[c]}>
            <b className="ltr">{x.orderRef ?? '—'}</b>
            <small>
              {x.customerName} · <PhoneOf o={x} />
            </small>
          </td>
        );
      case 'problem':
        return (
          <td key={c} className="wide px-cw" data-l={colLabel[c]} title={`${t(`sav.type.${x.type}`)} — ${x.details}`}>
            <div className="px-clamp">
              {t(`sav.type.${x.type}`)}
              {x.details && <small>{x.details}</small>}
            </div>
          </td>
        );
      case 'wish':
        return (
          <td key={c} data-l={colLabel[c]}>
            {x.wish ? t(`sav.wish.${x.wish}`) : '—'}
          </td>
        );
      case 'tstatus':
        return (
          <td key={c} data-l={colLabel[c]}>
            <StatusBadge kind="sav" status={x.status} />
          </td>
        );
      case 'depot':
        return (
          <td key={c} data-l={colLabel[c]} onClick={(e) => x.exchangeOrderId && (e.stopPropagation(), openOrder(x.exchangeOrderId))}>
            {x.exchangeOrderId ? (
              <>
                <StatusBadge kind="follow" status={x.exchangeFollow} />
                <small className="ltr">{x.exchangeRef}</small>
              </>
            ) : (
              <small>{t('sav.notTreated')}</small>
            )}
          </td>
        );
      case 'owner':
        return (
          <td key={c} data-l={colLabel[c]}>
            {x.assignedName ?? '—'}
          </td>
        );
      case 'age': {
        const active = x.status === 'open' || x.status === 'progress';
        const age = (x.resolvedAt ? Date.parse(x.resolvedAt) : Date.now()) - Date.parse(x.createdAt);
        return (
          <td key={c} className="num" data-l={colLabel[c]}>
            <span className={`badge ${active && age > 48 * 3_600_000 ? 't-bad' : 't-off'} ltr`}>{dur(age)}</span>
          </td>
        );
      }
    }
  };
  const closeNew = () => {
    setCreating(false);
    if (view === 'nouveau') location.hash = '#/sav/tickets';
  };

  return (
    <>
      <SavBar view={view} />
      <div className="bjt">
        <div className="card">
          <div className="card-head">
            <h2>
              {t('sav.title')}
              <Help text={t('sav.help')} label={t('sav.title')} />
            </h2>
            <button className="btn primary" onClick={() => setCreating(true)}>
              {t('sav.new')}
            </button>
          </div>
        </div>
        {/* the ticket's road: En attente → Au dépôt → En livraison → Livré / Annulé (a return always comes back to the depot first) */}
        <div className="px-sav-flow">
          <a className={`kpi${k?.attente ? ' t-bad' : ''}${view === 'attente' ? ' on' : ''}`} href="#/sav/attente">
            <KpiBody icon="hourglass" alert={!!k?.attente} label={t('sav.k.attente')} value={k?.attente ?? '—'} sub={k?.attenteLate ? t('sav.k.attenteLate', { count: k.attenteLate }) : t('sav.k.attenteSub')} go />
          </a>
          <span className="px-sav-ar" aria-hidden="true">›</span>
          <a className={`kpi${view === 'depot' ? ' on' : ''}`} href="#/sav/depot">
            <KpiBody icon="package" label={t('sav.k.depot')} value={k?.depot ?? '—'} sub={k?.returning ? t('sav.k.depotReturns', { count: k.returning }) : t('sav.k.depotSub')} go />
          </a>
          <span className="px-sav-ar" aria-hidden="true">›</span>
          <a className={`kpi${view === 'livraison' ? ' on' : ''}`} href="#/sav/livraison">
            <KpiBody icon="truck" label={t('sav.k.livraison')} value={k?.livraison ?? '—'} sub={t('sav.k.livraisonSub')} go />
          </a>
          <span className="px-sav-ar" aria-hidden="true">›</span>
          <div className="px-sav-end">
            <a className={`kpi t-ok${view === 'livres' ? ' on' : ''}`} href="#/sav/livres">
            <KpiBody icon="checkcircle" label={t('sav.k.livresAll')} value={k?.livres ?? '—'} sub={`${t('sav.k.livres7', { count: k?.livres7 ?? 0 })}${k?.avgMs ? ` · ${t('sav.k.livresSub', { v: dur(k.avgMs) })}` : ''}`} go />
          </a>
            <a className={`kpi${k?.annules ? ' t-bad' : ''}${view === 'annules' ? ' on' : ''}`} href="#/sav/annules">
            <KpiBody icon="xcircle" alert={!!k?.annules} label={t('sav.k.annules')} value={k?.annules ?? '—'} sub={k?.annulesRetour ? t('sav.k.annulesRetour', { count: k.annulesRetour }) : t('sav.k.annulesSub')} go />
          </a>
          </div>
        </div>
        {view === 'stats' ? (
          <SavStats />
        ) : (
        <div className="card">
          {(view === 'tickets' || view === 'nouveau') && (
            <div className="tabs" role="tablist">
              {(['todo', 'all'] as const).map((x) => (
                <button key={x} type="button" role="tab" aria-selected={tab === x} className={`tab ${tab === x ? 'on' : ''}`} onClick={() => chooseTab(x)}>
                  {t(`sav.tabs.${x}`)}
                  <b className="ltr">{list.data?.counts[x] ?? ''}</b>
                </button>
              ))}
            </div>
          )}
          <div className={`filters${fOpen ? ' open' : ''}`}>
            <label className="field search-f">
              <span className="lab">{t('filters.search')}</span>
              <input type="search" value={q} placeholder={t('sav.searchPh')} aria-label={t('sav.search')} onChange={(e) => setQ(e.target.value)} />
            </label>
            <button type="button" className="btn filters-toggle" aria-expanded={fOpen} onClick={() => setFOpen(!fOpen)}>
              {t('filters.toggle')}
              {sfl.on > 0 && <b className="ltr"> · {sfl.on}</b>}
            </button>
            {!combined && sfl.fields}
            <div className="field more-f px-f-clear">
              <button type="button" className="btn" onClick={() => (list.refetch(), kp.refetch())}>
                <Icon name="refresh" /> {t('sav.refresh')}
              </button>
            </div>
          </div>
          {!list.isLoading && !list.error && (
            <div className="px-scols">
              <TableColumnMenu tc={tc} cols={SAV_COLS.map((c) => ({ k: c, label: colLabel[c] }))} open={colMenu} onToggle={() => setColMenu((v) => !v)} />
            </div>
          )}
          {list.isLoading ? (
            <Loading />
          ) : list.error ? (
            <ErrorBox error={list.error} onRetry={() => list.refetch()} />
          ) : !list.data?.rows.length ? (
            <Empty>{t('sav.empty')}</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    {shown.map((c) => (
                      <th key={c} className={c === 'age' ? 'num' : undefined}>
                        {colLabel[c]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x) => (
                    <tr key={ticketKey(x)} className="clickable" onClick={() => setOpen(x)}>
                      {shown.map((c) => cell(c, x))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )}
      </div>
      {view !== 'stats' && list.data && <Pager page={page} pageSize={list.data.pageSize} total={list.data.total} onPage={setPage} />}
      {creating && (combined ? <ChooseSavSeller /> : <NewTicketModal onClose={closeNew} onCreated={(id) => (closeNew(), setOpen({ id }))} />)}
      {open && <TicketScope seller={open.seller}><TicketModal id={open.id} onClose={() => setOpen(null)} /></TicketScope>}
    </>
  );
}

