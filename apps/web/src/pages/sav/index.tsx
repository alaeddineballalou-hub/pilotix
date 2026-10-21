import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dur, when } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useRpc } from '../../lib/query';
import { Empty, ErrorBox, Help, Icon, Loading, StageBar, StatusBadge } from '../../ui/kit';
import type { PageProps } from '../registry';
import { NewTicketModal } from './NewTicket';
import { TicketModal } from './Ticket';

const VIEWS = ['tickets', 'nouveau', 'attente', 'depot', 'livraison', 'livres', 'annules'] as const;
type View = (typeof VIEWS)[number];
export function Sav({ sub }: PageProps) {
  const { t } = useTranslation();
  const view: View = (VIEWS as readonly string[]).includes(sub ?? '') ? (sub as View) : 'tickets';
  const [tab, setTab] = useState<'todo' | 'all'>(() => {
    try {
      return (localStorage.getItem('px-sav-tab') as 'todo' | 'all') || 'todo';
    } catch {
      return 'todo';
    }
  });
  const [q, setQ] = useState('');
  const [deb, setDeb] = useState('');
  const [open, setOpen] = useState<number | null>(null);
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
  const apiView = view === 'tickets' || view === 'nouveau' ? tab : view;
  const kp = useRpc('sav.kpis', {}, { refetchInterval: 60_000 });
  const list = useRpc('sav.list', { view: apiView, q: deb || undefined });
  const k = kp.data;
  const closeNew = () => {
    setCreating(false);
    if (view === 'nouveau') location.hash = '#/sav/tickets';
  };

  return (
    <>
      <StageBar flow={false} current={view} items={VIEWS.map((v) => ({ key: v, label: t(`sav.views.${v}`), href: `#/sav/${v}` }))} />
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
        <div className="kpis">
          <a className={`kpi${k?.attente ? ' t-bad' : ''}`} href="#/sav/attente">
            <span className="l">{t('sav.k.attente')}</span>
            <span className="v ltr">{k?.attente ?? '—'}</span>
            <span className="s">{t('sav.k.attenteSub')}</span>
          </a>
          <a className="kpi" href="#/sav/depot">
            <span className="l">{t('sav.k.depot')}</span>
            <span className="v ltr">{k?.depot ?? '—'}</span>
            <span className="s">{t('sav.k.depotSub')}</span>
          </a>
          <a className="kpi" href="#/sav/livraison">
            <span className="l">{t('sav.k.livraison')}</span>
            <span className="v ltr">{k?.livraison ?? '—'}</span>
            <span className="s">{t('sav.k.livraisonSub')}</span>
          </a>
          <a className={`kpi${k?.late ? ' t-bad' : ''}`} href="#/sav/tickets">
            <span className="l">{t('sav.k.late')}</span>
            <span className="v ltr">{k?.late ?? '—'}</span>
            <span className="s">{t('sav.k.lateSub')}</span>
          </a>
          <a className="kpi t-ok" href="#/sav/livres">
            <span className="l">{t('sav.k.livres')}</span>
            <span className="v ltr">{k?.livres7 ?? '—'}</span>
            <span className="s">{k?.avgMs ? t('sav.k.livresSub', { v: dur(k.avgMs) }) : t('sav.k.noAvg')}</span>
          </a>
        </div>
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
          <div className="row">
            <div className="grow">
              <input type="search" value={q} placeholder={t('sav.searchPh')} aria-label={t('sav.search')} onChange={(e) => setQ(e.target.value)} />
            </div>
            <button type="button" className="btn small" onClick={() => (list.refetch(), kp.refetch())}>
              <Icon name="refresh" /> {t('sav.refresh')}
            </button>
          </div>
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
                    <th>{t('sav.col.no')}</th>
                    <th>{t('sav.col.order')}</th>
                    <th>{t('sav.col.problem')}</th>
                    <th>{t('sav.col.wish')}</th>
                    <th>{t('sav.col.ticket')}</th>
                    <th>{t('sav.col.depot')}</th>
                    <th>{t('sav.col.owner')}</th>
                    <th className="num">{t('sav.col.since')}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.rows.map((x) => {
                    const active = x.status === 'open' || x.status === 'progress';
                    const age = (x.resolvedAt ? Date.parse(x.resolvedAt) : Date.now()) - Date.parse(x.createdAt);
                    return (
                      <tr key={x.id} className="clickable" onClick={() => setOpen(x.id)}>
                        <td data-l={t('sav.col.no')}>
                          <b className="ltr">{x.ref}</b>
                          <small>{when(x.createdAt)}</small>
                        </td>
                        <td data-l={t('sav.col.order')}>
                          <b className="ltr">{x.orderRef ?? '—'}</b>
                          <small>
                            {x.customerName} · <span className="ltr">{x.phone}</span>
                          </small>
                        </td>
                        <td className="wide px-cw" data-l={t('sav.col.problem')} title={`${t(`sav.type.${x.type}`)} — ${x.details}`}>
                          <div className="px-clamp">
                            {t(`sav.type.${x.type}`)}
                            {x.details && <small>{x.details}</small>}
                          </div>
                        </td>
                        <td data-l={t('sav.col.wish')}>{x.wish ? t(`sav.wish.${x.wish}`) : '—'}</td>
                        <td data-l={t('sav.col.ticket')}>
                          <StatusBadge kind="sav" status={x.status} />
                        </td>
                        <td data-l={t('sav.col.depot')} onClick={(e) => x.exchangeOrderId && (e.stopPropagation(), openOrder(x.exchangeOrderId))}>
                          {x.exchangeOrderId ? (
                            <>
                              <StatusBadge kind="follow" status={x.exchangeFollow} />
                              <small className="ltr">{x.exchangeRef}</small>
                            </>
                          ) : (
                            <small>{t('sav.notTreated')}</small>
                          )}
                        </td>
                        <td data-l={t('sav.col.owner')}>{x.assignedName ?? '—'}</td>
                        <td className="num" data-l={t('sav.col.since')}>
                          <span className={`badge ${active && age > 48 * 3_600_000 ? 't-bad' : 't-off'} ltr`}>{dur(age)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {creating && <NewTicketModal onClose={closeNew} onCreated={(id) => (closeNew(), setOpen(id))} />}
      {open && <TicketModal id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

