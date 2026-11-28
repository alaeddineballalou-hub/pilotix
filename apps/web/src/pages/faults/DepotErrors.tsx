// Dépôt › Erreurs de livraison (the owner's request, 25 Nov 2026): the depot's errors — a parcel that came back for
// them (Commandes › Annulé) and a problem after delivery (SAV) — each error as a card, who prepared it (the depot's
// managers and the chiefs see the names). Since Dépôt › Statistiques (28 Nov 2026, the owner's choice) the numbers live
// there: this tab keeps the filters, the « Pas moi » waiting for a decision and the cards; a tap there opens this tab
// with the same filters, the type or the person tapped, and « ‹ Statistiques ». A depot agent sees his own errors only
// (« Mes erreurs », with his one line: how many and his rate), with « Pas moi ».
import type { FaultReason } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateOnly, n, pct, wilayaName } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useRpc } from '../../lib/query';
import { CoChip } from '../../ui/CoIcon';
import { ErrorBox, Icon, Loading, RemovableChip } from '../../ui/kit';
import { DepotF, DepotFilters, depotIn, loadDepotF, saveDepotF, takeDepotTap } from '../depot/DepotStats';
import { ContestButton } from './parts';
import './faults.css';

export function DepotErrors() {
  const { t } = useTranslation();
  // a tap from Statistiques: its filters, read once, and the way back
  const [tap] = useState(takeDepotTap);
  const [f, setF0] = useState<DepotF>(() => ({ ...loadDepotF(), agent: tap?.agent ?? null, product: tap?.product ?? null }));
  const [reason, setReason] = useState<FaultReason | null>(tap?.reason ?? null);
  const [none, setNone] = useState(!!tap?.none);
  const setF = (p: Partial<DepotF>) => {
    // one person picked: « Sans nom » no longer applies
    if (p.agent) setNone(false);
    setF0((x) => {
      const nx = { ...x, ...p };
      saveDepotF(nx);
      return nx;
    });
  };
  const q = useRpc('faults.depot', { ...depotIn(f), ...(reason ? { reason } : {}), ...(none ? { none: true } : {}) }, { refetchInterval: 120_000 });
  const d = q.data;
  const boss = d?.scope === 'team';
  return (
    <div className="pxfa-dp2">
      {/* the chiefs: dates, agent and product; an agent: his dates */}
      <DepotFilters f={f} setF={setF} agents={boss ? d?.agents : null} products={boss ? d?.products : null} />
      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !d ? (
        <Loading />
      ) : (
        <>
          {boss ? (
            <div className="px-sx-sec first pxfa-head">
              {tap && (
                <button type="button" className="px-sx-back" onClick={() => (location.hash = '#/depot/stats')}>
                  ‹ {t('faults.depot.back')}
                </button>
              )}
              <span>{t('faults.depot.errTitle', { count: d.n })}</span>
              {reason && <RemovableChip name={t(`faults.reason.${reason}`)} onRemove={() => setReason(null)} />}
              {none && <RemovableChip name={t('faults.depot.chipNone')} onRemove={() => setNone(false)} />}
            </div>
          ) : (
            <p className="pxfa-big pxfa-mine">
              <b className="ltr">{n(d.n)}</b>
              <span>
                {t('faults.depot.mine')} · {d.mineRate !== null ? t('faults.depot.mineRate', { count: d.n, v: pct(d.mineRate, 1) }) : t('faults.depot.countMine', { count: d.n })}
              </span>
            </p>
          )}
          {boss &&
            d.list
              .filter((x) => x.contested)
              .map((w) => (
                <div key={w.id} className="pxfa-w">
                  <b>
                    <Icon name="flag" />
                    {w.order?.ref} · {w.who ?? t('faults.team.depot')} · {t('faults.contest.button')}
                  </b>
                  {/* the person's own words, in their own direction (a French note in Arabic) */}
                  {w.contestNote && (
                    <q>
                      <bdi>« {w.contestNote} »</bdi>
                    </q>
                  )}
                  <span className="pxfa-note">{t('faults.depot.sentToSeller')}</span>
                </div>
              ))}
          {d.n === 0 ? (
            <p className="pxn-empty">{t('faults.depot.noneP')}</p>
          ) : (
            <div className="pxfa-ecs">
              {d.list.map((x) => (
                <div key={x.id} className="pxfa-ec" role="button" tabIndex={0} onClick={() => openOrder(x.orderId)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openOrder(x.orderId))}>
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
                    <span className={`pxfa-pill ${x.moment}`}>{t(`faults.moment.${x.moment}`)}</span>
                    {boss && x.who && (
                      <span className="pxfa-chip">
                        <Icon name="package" /> {t('faults.depot.preparedBy', { who: x.who })}
                      </span>
                    )}
                    <span>{dateOnly(x.at)}</span>
                    {x.mine && <ContestButton id={x.id} sent={x.contested} />}
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className="pxfa-note">
            <Icon name="lock" /> {boss ? t('faults.depot.noteTeam') : t('faults.depot.noteMine')}
          </p>
        </>
      )}
    </div>
  );
}
