// « Ma tournée » (livreur, mobile first): chat with the office, route sheet, KPIs, one card per parcel with call / WhatsApp /
// En route / Livrée / Échec / Retour. The office (admin, Suivi, Dépôt) can open any livreur's round.
import { FAIL_REASONS, FOLLOW_TONE, Order, phoneIntl, RETURN_REASONS } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { da } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Empty, ErrorBox, Icon, Kpi, Kpis, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { printRouteSheet } from '../livraison/print';
import type { PageProps } from '../registry';
import { Chat } from './Chat';

export function Tournee(_: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  const self = !!session?.roles.includes('livreur') && !session.isAdmin && !session.roles.some((r) => ['suivi', 'depot'].includes(r));
  const livreurs = useRpc('delivery.livreurs', {}, { enabled: !self });
  const [pick, setPick] = useState<number | undefined>();
  const livreurId = self ? undefined : pick ?? livreurs.data?.[0]?.id;
  const q = useRpc('delivery.tournee', { livreurId }, { enabled: self || !!livreurId, refetchInterval: 60_000 });

  const print = async () => {
    try {
      printRouteSheet(await rpc('delivery.routeSheet', { livreurId }));
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };

  if (!self && livreurs.isLoading) return <Loading />;
  if (!self && !livreurs.data?.length) return <Empty>{t('tournee.noLivreur')}</Empty>;
  const d = q.data;
  const all = d ? [...d.toDeliver, ...d.pickup] : [];

  return (
    <>
      {!self && (
        <div className="card">
          <div className="card-head">
            <h2>{t('tournee.officeTitle')}</h2>
            <select value={livreurId ?? ''} onChange={(e) => setPick(Number(e.target.value))} aria-label={t('tournee.livreur')} style={{ width: 'auto' }}>
              {livreurs.data!.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      <details className="card bjr-livcard" open>
        <summary style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 800, fontSize: 16, color: 'var(--ink)', listStyle: 'none', cursor: 'pointer' }}>
          <span className="bjr-ic" aria-hidden="true">
            <Icon name="message" />
          </span>
          {self ? t('tournee.chat.title') : t('tournee.chat.titleOffice', { name: d?.livreur.name ?? '' })}
        </summary>
        {(self || livreurId) && <Chat livreurId={livreurId} orders={all} self={self} />}
      </details>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : d ? (
        <div>
          <div className="row end">
            <button className="btn" onClick={print}>
              🖨 {self ? t('tournee.print') : t('tournee.printOf', { name: d.livreur.name })}
            </button>
          </div>
          <Kpis>
            <Kpi label={t('tournee.kpi.toDeliver')} value={d.toDeliver.length} sub={t('tournee.kpi.toCollect', { amount: da(d.toDeliverAmount) })} />
            <Kpi label={t('tournee.kpi.deliveredToday')} value={d.deliveredToday} sub={t('tournee.kpi.cashed', { amount: da(d.deliveredTodayAmount) })} tone="ok" />
            <Kpi label={t('tournee.kpi.pickup')} value={d.pickup.length} sub=" " />
          </Kpis>
          {!d.toDeliver.length && <Empty>{t('tournee.empty')}</Empty>}
          {d.toDeliver.map((o) => (
            <ParcelCard key={o.id} o={o} shop={d.shop} actions />
          ))}
          {d.pickup.length > 0 && <h2>{t('tournee.pickupTitle')}</h2>}
          {d.pickup.map((o) => (
            <ParcelCard key={o.id} o={o} shop={d.shop} />
          ))}
        </div>
      ) : null}
    </>
  );
}

function ParcelCard({ o, shop, actions }: { o: Order; shop: { name: string; whatsappTemplate: string }; actions?: boolean }) {
  const { t } = useTranslation();
  const [ask, setAsk] = useState<null | 'failed' | 'returning'>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const set = useAction('orders.setFollow', { success: (r) => (r.changed.length ? t('tournee.saved') : t('tournee.noChange')), onDone: () => setAsk(null) });
  const call = useAction('orders.logCall', { silent: true });
  const items = o.items.map((i) => `${i.qty} × ${i.name}${i.variantTitle ? ` ${i.variantTitle}` : ''}`).join(' + ');
  const wa = `https://wa.me/${phoneIntl(o.phone)}?text=${encodeURIComponent((shop.whatsappTemplate || '').replace(/\{nom\}/g, o.customerName).replace(/\{boutique\}/g, shop.name).replace(/\{ref\}/g, o.ref))}`;
  const go = (status: 'out_for_delivery' | 'delivered' | 'failed' | 'returning', why?: string) =>
    set.mutate({ ids: [o.id], status, reason: why || null, note: note.trim() || null, clientId: `tr-${o.id}-${status}-${Date.now()}` });
  const reasons = ask === 'failed' ? FAIL_REASONS : RETURN_REASONS;
  const focus = o.followStatus === 'out_for_delivery';
  return (
    <div className={`card ${actions && focus ? 'focus-card' : ''}`}>
      <div className="ord-head">
        <b className="ltr">{o.ref}</b>
        <span className={`badge t-${FOLLOW_TONE[o.followStatus!] ?? 'off'}`}>{t(`status.follow.${o.followStatus}`)}</span>
        <span className="grow" />
        <b className="ltr">{da(o.total)}</b>
      </div>
      <div>
        <b>{o.customerName}</b> · {o.commune}
        {o.address ? ` · ${o.address}` : ''}
        {o.isStopdesk ? ` · ${t('tournee.stopdesk')}` : ''}
      </div>
      <div className="muted">{items}</div>
      {o.deliveryNote && (
        <div className="small">
          <b>{t('tournee.note')}</b> {o.deliveryNote}
        </div>
      )}
      <div className="row">
        <a className="btn primary" href={`tel:${o.phone}`} onClick={() => call.mutate({ id: o.id })}>
          {t('tournee.call', { phone: o.phone })}
        </a>
        <a className="btn" href={wa} target="_blank" rel="noopener noreferrer">
          {t('tournee.whatsapp')}
        </a>
        {o.phone2 && (
          <a className="btn ghost" href={`tel:${o.phone2}`}>
            <span className="ltr">{o.phone2}</span>
          </a>
        )}
      </div>
      {actions ? (
        <>
          <div className="statusbar">
            {!focus && (
              <button className="btn" disabled={set.isPending} onClick={() => go('out_for_delivery')}>
                {t('tournee.onTheWay')}
              </button>
            )}
            <button className="btn ok big" disabled={set.isPending} onClick={() => go('delivered')}>
              <Icon name="check" /> {t('tournee.delivered')}
            </button>
            <button className={`btn warn ${ask === 'failed' ? 'on' : ''}`} onClick={() => (setAsk(ask === 'failed' ? null : 'failed'), setReason(''))}>
              {t('tournee.failed')}
            </button>
            <button className={`btn danger ${ask === 'returning' ? 'on' : ''}`} onClick={() => (setAsk(ask === 'returning' ? null : 'returning'), setReason(''))}>
              {t('tournee.return')}
            </button>
          </div>
          {ask && (
            <div className="card" style={{ background: 'var(--raise)', marginTop: 8 }}>
              <b>{ask === 'failed' ? t('tournee.failWhy') : t('tournee.returnWhy')}</b>
              <div className="bjr-qr" style={{ margin: '8px 0' }}>
                {reasons.map((r) => (
                  <button key={r} type="button" aria-pressed={reason === r} style={reason === r ? { borderColor: 'var(--navy)', background: 'var(--sky-soft)' } : undefined} onClick={() => setReason(r)}>
                    {t(`status.${ask === 'failed' ? 'failReason' : 'returnReason'}.${r}`)}
                  </button>
                ))}
              </div>
              <textarea rows={2} placeholder={t('tournee.notePh')} value={note} onChange={(e) => setNote(e.target.value)} aria-label={t('common.note')} />
              <div className="row" style={{ marginTop: 8 }}>
                <button className={`btn ${ask === 'failed' ? 'warn' : 'danger'}`} disabled={!reason || set.isPending} onClick={() => go(ask, t(`status.${ask === 'failed' ? 'failReason' : 'returnReason'}.${reason}`))}>
                  {ask === 'failed' ? t('tournee.confirmFail') : t('tournee.confirmReturn')}
                </button>
                <button className="btn" onClick={() => setAsk(null)}>
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="muted small">{t('tournee.pickupTitle')}</p>
      )}
    </div>
  );
}
