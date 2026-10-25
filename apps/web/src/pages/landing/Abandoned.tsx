// « Abandonnées »: customers who typed their number on a landing page and left without ordering. After the chosen
// time Pilotix adds each one to Commandes as « Nouvelle » by itself (the agents call; no message to the customer).
// What could not be added (no wilaya chosen) waits here: call, then complete the order in one click.
import { communesOf, phoneIntl, WILAYAS_AR } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, n, when, wilaya } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { Empty, ErrorBox, Field, Icon, Kpi, Kpis, Loading, Pager } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { Filters, SearchBox } from '../ai/agent';
import { useDebounced } from '../depot/OrderList';

type Status = 'abandoned' | 'converted' | 'dismissed' | 'all';

export function Abandoned() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>('abandoned');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(50);
  const dq = useDebounced(q, 300);
  const list = useRpc('landing.leads', { status, q: dq.trim() || undefined, page, pageSize: size });
  const convert = useAction('landing.convertLead', { success: (r) => t('landing.ab.converted', { ref: r.ref }), onDone: () => setPick(null) });
  // a lead without wilaya: the agent asks it on the phone, then completes it here (no message to the customer)
  const [pick, setPick] = useState<{ id: number; name: string; wilayaId: number | ''; commune: string } | null>(null);
  const dismiss = useAction('landing.dismissLead', { success: t('landing.ab.dismissed') });
  const s = list.data?.stats;
  return (
    <>
      <Kpis>
        <Kpi label={t('landing.ab.kTodo')} value={n(s?.abandoned)} sub={t('landing.ab.kTodoSub')} icon="phone" tone={s?.abandoned ? 'warn' : undefined} />
        <Kpi label={t('landing.ab.kAdded')} value={n(s?.converted)} sub={t('landing.ab.kAddedSub')} icon="cart" />
        <Kpi label={t('landing.ab.kRecovered')} value={n(s?.recovered)} sub={t('landing.ab.kRecoveredSub')} icon="undo" />
        <Kpi label={t('landing.ab.kValue')} value={da(s?.value ?? 0)} sub={t('landing.ab.kValueSub')} icon="coins" />
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
                { value: 'abandoned', label: t('landing.ab.fTodo'), count: s?.abandoned, alert: true },
                { value: 'converted', label: t('landing.ab.fAdded'), count: s?.converted },
                { value: 'dismissed', label: t('landing.ab.fDismissed'), count: s?.dismissed },
                { value: 'all', label: t('landing.bl.fAll') },
              ]}
            />
          </div>
        </div>
        <p className="pd-note">{t('landing.ab.note', { min: list.data?.abandonAfterMin ?? 20 })}</p>
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} onRetry={() => list.refetch()} />
        ) : !list.data?.rows.length ? (
          <Empty>{t(`landing.ab.empty_${status}`)}</Empty>
        ) : (
          <div className="pd-list">
            <div className="pd-row pd-head lp-ab" aria-hidden="true">
              <span>{t('landing.bl.customer')}</span>
              <span>{t('landing.bl.order')}</span>
              <span>{t('landing.ab.where')}</span>
              <span />
            </div>
            <div className="pd-rows">
              {list.data.rows.map((r) => {
                const total = r.unitPrice * r.qty;
                const missing = !r.wilayaId;
                return (
                  <div key={r.id} className={`pd-row lp-ab ${r.status === 'dismissed' ? 'dim' : ''}`}>
                    <span className="pd-name">
                      <b dir="auto">{r.customerName || t('landing.ab.noName')}</b>
                      <small>
                        <a className="ltr lp-tel" href={`tel:${r.phone}`}>
                          {r.phone}
                        </a>
                        <a className="lp-wa" href={`https://wa.me/${phoneIntl(r.phone)}`} target="_blank" rel="noreferrer" aria-label="WhatsApp">
                          <Icon name="whatsapp" />
                        </a>
                      </small>
                      <small className="muted">{t('landing.ab.left', { when: when(r.lastAt) })}</small>
                    </span>
                    <span className="pd-name">
                      <b>
                        {r.qty > 1 ? `${r.qty} × ` : ''}
                        {r.productName}
                      </b>
                      <small>
                        {r.variantTitle && <span>{r.variantTitle}</span>}
                        <span className="ltr">{da(total)}</span>
                        {r.slug && <span className="ltr">/{r.slug}</span>}
                        {r.utm?.utm_source && <span className="chip">{r.utm.utm_source}</span>}
                      </small>
                    </span>
                    <span className="pd-name">
                      {missing ? <span className="chip lp-warn">{t('landing.ab.noWilaya')}</span> : <b>{wilaya(r.wilayaId)}</b>}
                      {r.commune && <small>{r.commune}</small>}
                      {r.note && r.status === 'abandoned' && <small className="lp-lnote">{r.note}</small>}
                    </span>
                    <span className="lp-bl-a">
                      {r.status === 'abandoned' ? (
                        <>
                          {missing ? (
                            <button className="btn small primary" onClick={() => setPick({ id: r.id, name: r.customerName || r.phone, wilayaId: '', commune: '' })} title={t('landing.ab.completeHelp')}>
                              <Icon name="pencil" /> {t('landing.ab.complete')}
                            </button>
                          ) : (
                            <button className="btn small primary" disabled={convert.isPending} onClick={() => convert.mutate({ id: r.id })}>
                              <Icon name="cart" /> {t('landing.ab.toOrder')}
                            </button>
                          )}
                          <button className="btn small" disabled={dismiss.isPending} onClick={() => dismiss.mutate({ id: r.id })} title={t('landing.ab.dismissHelp')}>
                            {t('landing.bl.dismiss')}
                          </button>
                        </>
                      ) : (
                        <span className="lp-done">
                          <span className={`chip ${r.status === 'converted' ? 'lp-on' : ''}`}>{t(`landing.ab.st_${r.status}${r.status === 'converted' && r.auto ? '_auto' : ''}`)}</span>
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
                );
              })}
            </div>
          </div>
        )}
        {!!list.data && list.data.total > size && <Pager page={page} pageSize={size} total={list.data.total} onPage={setPage} onSize={setSize} />}
      </section>
      {pick && (
        <Modal
          title={t('landing.ab.completeTitle', { name: pick.name })}
          onClose={() => setPick(null)}
          footer={
            <>
              <button className="btn" onClick={() => setPick(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn primary" disabled={!pick.wilayaId || !pick.commune || convert.isPending} onClick={() => convert.mutate({ id: pick.id, wilayaId: Number(pick.wilayaId), commune: pick.commune })}>
                <Icon name="cart" /> {t('landing.ab.toOrder')}
              </button>
            </>
          }
        >
          <p className="muted small">{t('landing.ab.completeHelp')}</p>
          <div className="grid2">
            <Field label={t('landing.ab.wilaya')}>
              <select value={pick.wilayaId} onChange={(e) => setPick({ ...pick, wilayaId: e.target.value ? Number(e.target.value) : '', commune: '' })}>
                <option value="">—</option>
                {Object.keys(WILAYAS_AR).map((k) => (
                  <option key={k} value={k}>
                    {wilaya(Number(k))}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('landing.ab.commune')}>
              <select value={pick.commune} disabled={!pick.wilayaId} onChange={(e) => setPick({ ...pick, commune: e.target.value })}>
                <option value="">—</option>
                {pick.wilayaId &&
                  communesOf(Number(pick.wilayaId)).map((c) => (
                    <option key={`${c[1]}`} value={c[1]}>
                      {c[1]}
                      {c[2] ? ` · ${c[2]}` : ''}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}
