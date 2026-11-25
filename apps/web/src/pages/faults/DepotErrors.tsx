// Dépôt › Erreurs de livraison (the owner's request, 25 Nov 2026): the depot's errors — a parcel that came back for
// them (Commandes › Annulé) and a problem after delivery (SAV): what happened, who (the depot's managers and the chiefs
// see the names), and each error as a card. A depot agent sees his own errors only (« Mes erreurs »), with « Pas moi ».
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateOnly, n, pct, periodRange, wilayaName } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useRpc } from '../../lib/query';
import { CoChip } from '../../ui/CoIcon';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { ContestButton } from './parts';
import './faults.css';

export function DepotErrors() {
  const { t } = useTranslation();
  const range = useMemo(() => periodRange('month'), []);
  const q = useRpc('faults.depot', range, { refetchInterval: 120_000 });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  const d = q.data;
  const boss = d.scope === 'team';
  const top = Math.max(1, ...d.reasons.map((r) => r.n));
  const people = d.people ?? [];
  const pTop = Math.max(1, ...people.map((p) => p.n));
  const waiting = d.list.filter((x) => x.contested);
  return (
    <div className="pxf-dp">
      <section className="pxn-card pxf-card" aria-labelledby="pxf-dh">
        <header className="pxn-h">
          <h3 id="pxf-dh">{boss ? t('faults.depot.title') : t('faults.depot.mine')}</h3>
          <span>{t('faults.depot.month')}</span>
        </header>
        <div className="pxf-big">
          <b className="ltr">{n(d.n)}</b>
          <span>{boss ? t('faults.depot.count', { v: da(d.cost) }) : d.mineRate !== null ? t('faults.depot.mineRate', { v: pct(d.mineRate, 1) }) : t('faults.depot.countMine')}</span>
        </div>
        <p className="pxf-sub">{t('faults.depot.sub', { ret: d.returns, sav: d.sav })}</p>
        {d.n === 0 ? (
          <p className="pxn-empty">{t('faults.depot.none')}</p>
        ) : (
          <div className="pxf-rows">
            {d.reasons.map((r, i) => (
              <div key={r.reason} className={`pxf-r static`} style={{ gridTemplateColumns: '1fr 90px 30px', borderTopColor: i ? undefined : 'transparent' }}>
                <span className="pxf-n" style={{ fontWeight: 600 }}>
                  {t(`faults.reason.${r.reason}`)}
                </span>
                <span className="pxf-t" aria-hidden="true">
                  <i style={{ width: `${Math.max(4, (r.n / top) * 100)}%` }} />
                </span>
                <b className="ltr">{n(r.n)}</b>
              </div>
            ))}
          </div>
        )}
        {boss && people.length > 0 && (
          <div>
            <header className="pxn-h">
              <h3 style={{ fontSize: 14 }}>{t('faults.depot.who')}</h3>
              <span>{t('faults.depot.whoSub')}</span>
            </header>
            {people.map((p) => (
              <div key={p.name} className="pxf-p" style={{ gridTemplateColumns: 'minmax(56px, 96px) 1fr auto', minHeight: 28 }}>
                <span>{p.name}</span>
                <span className="pxf-t" aria-hidden="true">
                  <i style={{ width: `${Math.max(4, (p.n / pTop) * 100)}%` }} />
                </span>
                <span className="ltr">{p.of ? t('faults.depot.of', { n: p.n, of: p.of, v: pct(p.n / p.of, 1) }) : n(p.n)}</span>
              </div>
            ))}
          </div>
        )}
        {boss &&
          waiting.map((w) => (
            <div key={w.id} className="pxf-w">
              <b>
                <Icon name="flag" />
                {w.order?.ref} · {w.who ?? t('faults.team.depot')} · {t('faults.contest.button')}
              </b>
              {w.contestNote && <q>« {w.contestNote} »</q>}
              <span className="pxf-note">{t('faults.depot.sentToSeller')}</span>
            </div>
          ))}
        <p className="pxf-note">
          <Icon name="lock" /> {boss ? t('faults.depot.noteTeam') : t('faults.depot.noteMine')}
        </p>
      </section>
      <div className="pxf-ecs">
        {d.list.map((x) => (
          <div key={x.id} className="pxf-ec" role="button" tabIndex={0} onClick={() => openOrder(x.orderId)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openOrder(x.orderId))}>
            <span className="l1">
              <CoChip companyId={x.order?.companyId} kind={x.order?.companyKind} className={`pxn-co k-${x.order?.companyKind || 'other'}`} role="img" aria-label={x.order?.company ?? '—'}>
                {(x.order?.company ?? '').slice(0, 2).toUpperCase() || '—'}
              </CoChip>
              <b>{x.order?.customer}</b>
              <b className="ltr">{da(x.order?.total ?? null)}</b>
            </span>
            <span className="l2">
              <span className="ltr">{x.order?.ref}</span> · {wilayaName(x.order?.wilayaId)} · {x.order?.items}
            </span>
            <span className="why" dir="auto">
              « {t(`faults.reason.${x.reason}`)} »
            </span>
            <span className="l3">
              <span className={`pxf-pill ${x.moment}`}>{t(`faults.moment.${x.moment}`)}</span>
              {boss && x.who && (
                <span className="pxf-chip">
                  <Icon name="package" /> {t('faults.depot.preparedBy', { who: x.who })}
                </span>
              )}
              <span>{dateOnly(x.at)}</span>
              {x.mine && <ContestButton id={x.id} sent={x.contested} />}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
