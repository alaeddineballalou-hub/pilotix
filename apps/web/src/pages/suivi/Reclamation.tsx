import { CONF_STATUSES, CONF_TODO, FOLLOW_STATUSES, SALES_CHANNELS, WILAYAS } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, when, wilaya } from '../../lib/format';
import { openOrder, openOrderForm } from '../../lib/modals';
import { useRpc } from '../../lib/query';
import { Empty, ErrorBox, Icon, Loading, Pager, StatusBadge } from '../../ui/kit';
import { ClaimsPanel } from './Claims';
import { namesOf, variantsOf, trackOf } from '../../lib/items';
import { productsText } from './common';
import { CopyCode } from '../../ui/CopyCode';
import { useIsPhone } from '../../lib/useMedia';
import { PhoneClaims } from './PhoneClaims';

type RTab = 'search' | 'companies' | 'livreurs';

export function Reclamation() {
  const { t } = useTranslation();
  const phone = useIsPhone();
  // a phone opens on the claims to the couriers (the inbox); a computer on the search
  const [tab, setTab] = useState<RTab>(() => {
    const first: RTab = window.matchMedia('(max-width: 760px)').matches ? 'companies' : 'search';
    try {
      return (sessionStorage.getItem('px-rec-tab') as RTab) || first;
    } catch {
      return first;
    }
  });
  const choose = (k: RTab) => {
    setTab(k);
    try {
      sessionStorage.setItem('px-rec-tab', k);
    } catch {
      /* private mode */
    }
  };
  const comp = useRpc('suivi.claims', { target: 'company', status: 'open', pageSize: 1 }).data?.counts?.open;
  const liv = useRpc('suivi.claims', { target: 'livreur', status: 'open', pageSize: 1 }).data?.counts?.open;
  return (
    <>
      {phone ? (
        <div className="pxr-tabs" role="tablist">
          {(['companies', 'livreurs', 'search'] as const).map((k) => {
            const n = k === 'companies' ? comp : k === 'livreurs' ? liv : 0;
            return (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => choose(k)}>
                {k === 'search' && <Icon name="search" />}
                {t(`suivi.rec.ph.tabs.${k}`)}
                {!!n && <b className="ltr">{n}</b>}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="bjp-tabs bjr-tabs" role="tablist">
          {(['search', 'companies', 'livreurs'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' on' : ''}`} onClick={() => choose(k)}>
              {t(`suivi.rec.tabs.${k}`)}
              {k !== 'search' && <b className="bjr-n ltr">{(k === 'companies' ? comp : liv) || ''}</b>}
            </button>
          ))}
        </div>
      )}
      {tab === 'search' ? <SearchOrders /> : phone ? <PhoneClaims target={tab === 'companies' ? 'company' : 'livreur'} /> : <ClaimsPanel target={tab === 'companies' ? 'company' : 'livreur'} />}
    </>
  );
}

/** "Rechercher une commande": every order, any status or date. */
function SearchOrders() {
  const { t } = useTranslation();
  // SAV hands over an order not delivered yet (no SAV before delivery: it is a réclamation)
  const [q, setQ] = useState(() => {
    try {
      const v = sessionStorage.getItem('px-rec-q') ?? '';
      sessionStorage.removeItem('px-rec-q');
      return v;
    } catch {
      return '';
    }
  });
  const [deb, setDeb] = useState(q);
  const [f, setF] = useState({ conf: '', follow: '', company: '', wilaya: '', channel: '', agent: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  useEffect(() => {
    const h = setTimeout(() => (setDeb(q.trim()), setPage(1)), 300);
    return () => clearTimeout(h);
  }, [q]);
  const contacts = useRpc('suivi.contacts', {}).data;
  const agents = useRpc('users.list', { role: 'confirmation' }).data ?? [];
  const confF = f.conf === 'todo' ? CONF_TODO : f.conf ? [f.conf] : undefined;
  const followF =
    f.follow === 'depot' ? ['to_prepare', 'prepared'] : f.follow === 'road' ? ['shipped', 'out_for_delivery', 'failed', 'alert', 'in_exchange'] : f.follow === 'returns' ? ['returning', 'returned'] : f.follow ? [f.follow] : undefined;
  const list = useRpc('orders.list', {
    q: deb || undefined,
    conf: confF as any,
    follow: followF as any,
    companyId: f.company === 'none' ? 'none' : f.company ? Number(f.company) : undefined,
    wilayaId: f.wilaya ? Number(f.wilaya) : undefined,
    channel: (f.channel || undefined) as any,
    agentId: f.agent ? Number(f.agent) : undefined,
    from: f.from ? new Date(f.from).toISOString() : undefined,
    to: f.to ? new Date(Date.parse(f.to) + 86_400_000).toISOString() : undefined,
    page,
    pageSize: size,
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => (setF({ ...f, [k]: e.target.value }), setPage(1));
  const rows = list.data?.rows ?? [];
  return (
    <>
      <div className="card bjf">
        <div className="bjf-row">
          <span className="bjf-ic" aria-hidden="true">
            <Icon name="search" />
          </span>
          <input type="search" className="bjf-in" value={q} placeholder={t('suivi.rec.searchPh')} aria-label={t('suivi.rec.tabs.search')} autoComplete="off" enterKeyHint="search" onChange={(e) => setQ(e.target.value)} />
        </div>
        <p className="muted small bjf-info">{t('suivi.rec.searchInfo')}</p>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>{t('suivi.rec.allOrders')}</h2>
          <button className="btn primary" onClick={() => openOrderForm({})}>
            {t('suivi.rec.newOrder')}
          </button>
        </div>
        <div className="filters">
          <label className="field">
            <span className="lab">{t('suivi.col.conf')}</span>
            <select value={f.conf} onChange={set('conf')}>
              <option value="">{t('common.all')}</option>
              <option value="todo">{t('suivi.rec.f.todo')}</option>
              {CONF_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`status.conf.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('suivi.col.delivery')}</span>
            <select value={f.follow} onChange={set('follow')}>
              <option value="">{t('common.all')}</option>
              <option value="depot">{t('suivi.rec.f.depot')}</option>
              <option value="road">{t('suivi.rec.f.road')}</option>
              <option value="returns">{t('suivi.rec.f.returns')}</option>
              {FOLLOW_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`status.follow.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('suivi.col.company')}</span>
            <select value={f.company} onChange={set('company')}>
              <option value="">{t('common.all')}</option>
              <option value="none">{t('suivi.rec.f.noCompany')}</option>
              {contacts?.companies.map((c: { id: number; name: string }) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('suivi.col.wilaya')}</span>
            <select value={f.wilaya} onChange={set('wilaya')}>
              <option value="">{t('common.all')}</option>
              {WILAYAS.map((_, i) => (
                <option key={i + 1} value={i + 1}>
                  {wilaya(i + 1)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('suivi.rec.f.source')}</span>
            <select value={f.channel} onChange={set('channel')}>
              <option value="">{t('common.all')}</option>
              {SALES_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {t(`status.channel.${c}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('suivi.rec.f.agent')}</span>
            <select value={f.agent} onChange={set('agent')}>
              <option value="">{t('common.all')}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('common.from')}</span>
            <input type="date" value={f.from} onChange={set('from')} />
          </label>
          <label className="field">
            <span className="lab">{t('common.to')}</span>
            <input type="date" value={f.to} onChange={set('to')} />
          </label>
        </div>
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} onRetry={() => list.refetch()} />
        ) : !rows.length ? (
          <Empty>{t('common.noData')}</Empty>
        ) : (
          <>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('suivi.col.order')}</th>
                    <th>{t('suivi.col.client')}</th>
                    <th>{t('suivi.col.address')}</th>
                    <th className="wide">{t('suivi.col.products')}</th>
                    <th>{t('suivi.col.variant')}</th>
                    <th className="num">{t('suivi.col.total')}</th>
                    <th>{t('suivi.col.conf')}</th>
                    <th>{t('suivi.col.agent')}</th>
                    <th>{t('suivi.col.fagent')}</th>
                    <th>{t('suivi.col.delivery')}</th>
                    <th>{t('suivi.col.tracking')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={o.id} className={`clickable${['cancelled', 'duplicate', 'fake', 'wrong_number'].includes(o.confStatus) ? ' muted' : ''}`} onClick={() => openOrder(o.id)}>
                      <td data-l={t('suivi.col.order')}>
                        <b className="ltr">{o.ref}</b>
                        <small>{when(o.createdAt)}</small>
                      </td>
                      <td data-l={t('suivi.col.client')}>
                        {o.customerName}
                        <small className="ltr">{o.phone}</small>
                      </td>
                      <td data-l={t('suivi.col.address')}>
                        {wilaya(o.wilayaId)}
                        <small>{o.commune}</small>
                      </td>
                      <td className="wide px-cw" data-l={t('suivi.col.products')}>
                        <div className="px-clamp">{namesOf(o.items)}</div>
                      </td>
                      <td data-l={t('suivi.col.variant')}>
                        <div className="px-clamp">{variantsOf(o.items)}</div>
                      </td>
                      <td className="num ltr" data-l={t('suivi.col.total')}>
                        {da(o.total)}
                      </td>
                      <td data-l={t('suivi.col.conf')}>
                        <StatusBadge kind="conf" status={o.confStatus} />
                      </td>
                      <td data-l={t('suivi.col.agent')}>{o.agentName ?? '—'}</td>
                      <td data-l={t('suivi.col.fagent')}>{o.followAgentName ?? '—'}</td>
                      <td data-l={t('suivi.col.delivery')}>
                        <StatusBadge kind="follow" status={o.followStatus} />
                      </td>
                      <td data-l={t('suivi.col.tracking')}>
                        <CopyCode code={trackOf(o)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={size} total={list.data?.total ?? 0} onPage={setPage} onSize={(s) => (setSize(s), setPage(1))} />
          </>
        )}
      </div>
    </>
  );
}
