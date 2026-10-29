// Single-order mode: "Commande suivante →" takes the next order to call (orders.next), one at a time.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { da, n, when } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useRpc, useRpcFor } from '../../lib/query';
import { useScope } from '../../lib/seller';
import { store } from '../../lib/store';
import { Kpi, Loading, StatusBadge } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { Detail } from './Detail';
import { choiceLabel, currentLabel, StatusChoice, telHref, waHref } from './shared';
import { useStatusChange } from './StatusDialog';
import { TrustFlags } from '../orders/TrustFlags';
import { ScoreChip } from '../../ui/clientScore';

const CHOICES: StatusChoice[] = ['confirmed', 'try1', 'callback', 'postponed', 'no_stock', 'cancelled', 'wrong_number', 'fake', 'duplicate'];
const CLS: Partial<Record<StatusChoice, string>> = { confirmed: 'ok big', try1: 'big', no_stock: 'warn', cancelled: 'danger' };

/**
 * onNext: « Commande suivante » given by the page (an agency's « Tous les vendeurs »: the next order of any seller);
 * seller: the order's seller, shown in the title.
 */
export function Focus({ initialId, onClose, onNext, seller, allSellers }: { initialId: number | null; onClose: () => void; onNext?: () => Promise<void>; seller?: string; allSellers?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [id, setId] = useState<number | null>(initialId);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(() => store.get('conf-auto') !== '0');
  const skip = useRef<number[]>([]);
  // an agency's « Tous les vendeurs »: the numbers of every seller
  const scope = useScope();
  const mine = useRpcFor(allSellers ? 'all' : scope, 'confirmation.mine', {}, { refetchInterval: 60_000 });
  const meta = useRpc('confirmation.meta', {}, { staleTime: 5 * 60_000 });
  const order = useRpc('orders.get', { id: id ?? 0 }, { enabled: !!id });
  const others = useRpc('orders.list', { q: order.data?.phone ?? '', pageSize: 10 }, { enabled: !!order.data?.phone });
  const { change, dialog } = useStatusChange();

  const next = async () => {
    setBusy(true);
    try {
      if (onNext) return await onNext();
      if (id) await rpc('confirmation.release', { id }).catch(() => {});
      const r = await rpc('orders.next', { skip: skip.current.slice(-200) });
      setId(r.id);
      setDone(!r.id);
      if (r.id) skip.current.push(r.id);
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (initialId) skip.current.push(initialId);
  }, [initialId]);

  const after = async () => {
    qc.invalidateQueries();
    if (auto) await next();
  };
  const o = order.data;
  const other = (others.data?.rows ?? []).filter((x) => x.id !== o?.id);
  const returns = other.filter((x) => x.followStatus === 'returning' || x.followStatus === 'returned').length;
  const shop = meta.data?.shopName ?? 'Pilotix';
  const items = o?.items.map((i) => `${i.qty} × ${i.name}${i.variantTitle ? ` ${i.variantTitle}` : ''}`).join(', ') ?? '';
  const waText = o ? waHref(o.phone, meta.data?.whatsappTemplate ?? '', { nom: o.customerName, boutique: shop, ref: o.ref }) : '';

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>
            {t('confirmation.focus.title')}
            {seller && <span className="chip agx-seller-chip">{seller}</span>}
          </h2>
          <div className="row">
            <label className="check">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => {
                  setAuto(e.target.checked);
                  store.set('conf-auto', e.target.checked ? '1' : '0');
                }}
              />
              {t('confirmation.focus.auto')}
            </label>
            <button type="button" className="btn primary big" disabled={busy} onClick={next}>
              {t('confirmation.next')}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>
        <div className="kpis">
          <Kpi tone={mine.data?.due ? 'warn' : undefined} label={t('confirmation.focus.due')} value={n(mine.data?.due ?? 0)} sub={t('confirmation.focus.dueSub')} />
          <Kpi label={t('confirmation.focus.later')} value={n(mine.data?.later ?? 0)} sub={t('confirmation.focus.laterSub')} />
          <Kpi tone="ok" label={t('confirmation.focus.mine')} value={n(mine.data?.confirmed ?? 0)} sub={t('confirmation.focus.mineSub', { n: mine.data?.cancelled ?? 0 })} />
        </div>
      </div>
      {done && <div className="card empty-box">{t('confirmation.focus.none')}</div>}
      {!id && !done && <div className="card empty-box">{t('confirmation.focus.start')}</div>}
      {id && !o && <Loading />}
      {o && (
        <div className="card focus-card">
          <div className="ord-head">
            <span className="ord-ref ltr">{o.ref}</span>
            <StatusBadge kind="conf" status={o.confStatus} />
            {o.confStatus === 'no_answer' && <span className="badge t-mid">{currentLabel(t, o.confStatus, o.attempts)}</span>}
            {o.followStatus && <StatusBadge kind="follow" status={o.followStatus} />}
            {o.possibleDuplicate && <span className="flag dup">{t('confirmation.dup')}</span>}
            {o.blacklisted && <span className="flag">{t('confirmation.blacklist')}</span>}
            <TrustFlags o={o} />
            {o.clientScore && <ScoreChip s={o.clientScore} />}
            <span className="muted small">
              {t('confirmation.focus.received', { when: when(o.createdAt), channel: t(`status.channel.${o.channel}`) })}
              {o.attempts ? ` · ${t('confirmation.focus.calls', { n: o.attempts })}` : ''}
            </span>
          </div>
          <div className="row">
            <span className="phone-big ltr">{o.phone}</span>
            <a className="btn primary big" href={telHref(o.phone)} onClick={() => rpc('orders.logCall', { id: o.id }).catch(() => {})}>
              {t('confirmation.call')}
            </a>
            <a className="btn big" href={waText} target="_blank" rel="noopener">
              WhatsApp
            </a>
            {o.phone2 && (
              <a className="btn" href={telHref(o.phone2)}>
                {t('confirmation.call')} <span className="ltr">{o.phone2}</span>
              </a>
            )}
          </div>
          {other.length > 0 && (
            <div className={returns ? 'badbox' : 'okbox'}>
              <div>
                {t('confirmation.focus.others', { n: other.length })}
                {returns ? ` · ${t('confirmation.focus.returns', { n: returns })}` : ''}
              </div>
              <div className="small">
                {other.map((x) => (
                  <button key={x.id} type="button" className="linkish" style={{ marginInlineEnd: 10 }} onClick={() => openOrder(x.id)}>
                    {x.ref} ({x.followStatus ? t(`status.follow.${x.followStatus}`) : t(`status.conf.${x.confStatus}`)})
                  </button>
                ))}
              </div>
            </div>
          )}
          {o.customerNote && <div className="warnbox">{t('confirmation.focus.clientNote', { note: o.customerNote })}</div>}
          <p className="muted small">
            {items} · <span className="ltr">{da(o.total)}</span>
          </p>
          <Detail order={o} />
          <div className="statusbar">
            {CHOICES.map((c) => (
              <button
                key={c}
                type="button"
                className={`btn ${CLS[c] ?? ''}`}
                onClick={async () => {
                  const ch: StatusChoice = c === 'try1' ? (`try${Math.min(3, o.attempts + 1)}` as StatusChoice) : c;
                  if (c === 'confirmed' || c === 'no_stock') {
                    await change([o], ch, { onSaved: after });
                    return;
                  }
                  if (await change([o], ch)) await after();
                }}
              >
                {c === 'try1' ? t('status.conf.no_answer') : choiceLabel(t, c, true)}
              </button>
            ))}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn ghost"
              onClick={async () => {
                await rpc('confirmation.release', { id: o.id }).catch(() => {});
                setId(null);
              }}
            >
              {t('confirmation.focus.release')}
            </button>
            <button type="button" className="btn ghost" onClick={() => openOrder(o.id)}>
              {t('confirmation.focus.history')}
            </button>
          </div>
        </div>
      )}
      {dialog}
    </>
  );
}
