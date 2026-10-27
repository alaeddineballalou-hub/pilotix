// « Commandes bloquées »: what the fake-order check held back from the landing pages, with its score and its reasons.
// The customer saw the normal thank-you screen; here an agent restores a real one (it becomes a new order) or rejects it.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateTime, n, pct, wilaya } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { Empty, ErrorBox, Icon, Kpi, Kpis, Loading, Pager } from '../../ui/kit';
import { Filters, SearchBox } from '../ai/agent';
import { useDebounced } from '../depot/OrderList';
import { UtmAdChip } from '../orders/AdSource';

type Status = 'blocked' | 'restored' | 'dismissed' | 'all';

const tone = (s: number) => (s >= 85 ? 'hi' : s >= 70 ? 'mid' : 'lo');

export function Blocked() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>('blocked');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const dq = useDebounced(q, 300);
  const list = useRpc('landing.blocked', { status, q: dq.trim() || undefined, page, pageSize: size });
  const restore = useAction('landing.restore', { success: (r) => t('landing.bl.restored', { ref: r.ref }) });
  const dismiss = useAction('landing.dismiss', { success: t('landing.bl.dismissed') });
  const s = list.data?.stats;
  return (
    <>
      <Kpis>
        <Kpi label={t('landing.bl.kWaiting')} value={n(s?.blocked)} sub={t('landing.bl.kWaitingSub')} icon="ban" tone={s?.blocked ? 'bad' : undefined} />
        <Kpi label={t('landing.bl.kWeek')} value={n(s?.week)} sub={t('landing.bl.kWeekSub', { rate: s?.submits ? pct(s.week / s.submits) : '—' })} icon="calendar" />
        <Kpi label={t('landing.bl.kRestored')} value={n(s?.restored)} sub={t('landing.bl.kRestoredSub')} icon="undo" />
        <Kpi label={t('landing.bl.kDismissed')} value={n(s?.dismissed)} sub={t('landing.bl.kDismissedSub')} icon="xcircle" />
      </Kpis>
      <section className="card pd-card">
        <div className="pd-tools">
          <div className="pd-tools-f">
            <SearchBox
              value={q}
              onChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              placeholder={t('landing.bl.searchPh')}
            />
            <Filters<Status>
              value={status}
              onChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
              label={t('landing.bl.filters')}
              items={[
                { value: 'blocked', label: t('landing.bl.fBlocked'), count: s?.blocked, alert: true },
                { value: 'restored', label: t('landing.bl.fRestored'), count: s?.restored },
                { value: 'dismissed', label: t('landing.bl.fDismissed'), count: s?.dismissed },
                { value: 'all', label: t('landing.bl.fAll') },
              ]}
            />
          </div>
        </div>
        <p className="pd-note">{t('landing.bl.note')}</p>
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} onRetry={() => list.refetch()} />
        ) : !list.data?.rows.length ? (
          <Empty>{t(`landing.bl.empty_${status}`)}</Empty>
        ) : (
          <div className="pd-list">
            <div className="pd-row pd-head lp-bl" aria-hidden="true">
              <span>{t('landing.bl.customer')}</span>
              <span>{t('landing.bl.order')}</span>
              <span>{t('landing.bl.score')}</span>
              <span>{t('landing.bl.reasons')}</span>
              <span />
            </div>
            <div className="pd-rows">
              {list.data.rows.map((r) => (
                <div key={r.id} className={`pd-row lp-bl ${r.status !== 'blocked' ? 'dim' : ''}`}>
                  <span className="pd-name">
                    <b dir="auto">{r.customerName || '—'}</b>
                    <small>
                      <span className="ltr">{r.phone}</span>
                      <span>{r.wilayaId ? wilaya(r.wilayaId) : '—'}{r.commune ? ` · ${r.commune}` : ''}</span>
                    </small>
                    <small className="muted">{dateTime(r.at)}</small>
                    <UtmAdChip utm={r.utm} />
                  </span>
                  <span className="pd-name">
                    <b>
                      {r.qty > 1 ? `${r.qty} × ` : ''}
                      {r.productName}
                    </b>
                    <small>
                      {r.variantTitle && <span>{r.variantTitle}</span>}
                      <span className="ltr">{da(r.unitPrice * r.qty)}</span>
                      {r.slug && <span className="ltr">/{r.slug}</span>}
                    </small>
                  </span>
                  <span className={`lp-score ${tone(r.score)}`} title={t('landing.bl.scoreHelp')}>
                    <b className="ltr">{r.score}</b>
                    <i style={{ width: `${r.score}%` }} />
                  </span>
                  <span className="lp-reasons">
                    {r.reasons.map((x) => (
                      <span key={x.code} className={`lp-rs ${x.points < 0 ? 'good' : x.points >= 40 ? 'hi' : ''}`}>
                        {t(`landing.reasons.${x.code}`, { defaultValue: x.code })} <b className="ltr">{x.points > 0 ? `+${x.points}` : x.points}</b>
                      </span>
                    ))}
                    {(r.ip || r.userAgent) && (
                      <small className="lp-ua ltr" title={r.userAgent ?? ''}>
                        {r.ip}
                        {r.ip && r.userAgent ? ' · ' : ''}
                        {r.userAgent}
                      </small>
                    )}
                  </span>
                  <span className="lp-bl-a">
                    {r.status === 'blocked' ? (
                      <>
                        <button className="btn small primary" disabled={restore.isPending} onClick={() => restore.mutate({ id: r.id })} title={t('landing.bl.restoreHelp')}>
                          <Icon name="undo" /> {t('landing.bl.restore')}
                        </button>
                        <button className="btn small" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ id: r.id, blacklist: false })} title={t('landing.bl.dismissHelp')}>
                          {t('landing.bl.dismiss')}
                        </button>
                        <button className="btn small" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ id: r.id, blacklist: true })} title={t('landing.bl.blacklist')} aria-label={t('landing.bl.blacklist')}>
                          <Icon name="ban" />
                        </button>
                      </>
                    ) : (
                      <span className="lp-done">
                        <span className={`chip ${r.status === 'restored' ? 'lp-on' : ''}`}>{t(`landing.bl.st_${r.status}`)}</span>
                        {r.orderId && (
                          <button className="lp-link ltr" onClick={() => openOrder(r.orderId!)}>
                            {r.orderRef}
                          </button>
                        )}
                        {r.handledBy && <small className="muted">{r.handledBy}</small>}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {!!list.data && list.data.total > size && <Pager page={page} pageSize={size} total={list.data.total} onPage={setPage} onSize={setSize} />}
      </section>
    </>
  );
}
