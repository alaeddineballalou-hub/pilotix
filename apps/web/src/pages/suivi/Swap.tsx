import type { Order } from '@pilotix/shared';
import { useTranslation } from 'react-i18next';
import { da, wilayaName } from '../../lib/format';
import { useIsPhone } from '../../lib/useMedia';
import { copyText, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { productsText, swapText } from './common';
import { trackOf } from '../../lib/items';
import { SwapCopySheet, SwapPickSheet } from './PhoneSwap';
import { Cand, SwapResult, useCopyFields, useSwapPick } from './swapKit';

export type { SwapResult } from './swapKit';

type PickProps = { o: Order; onClose: () => void; onDone: (r: SwapResult) => void };
type CopyProps = SwapResult & { fresh?: boolean; onClose: () => void };

/** Give a cancelled parcel to another confirmed order that is not shipped yet: a dialog, or a sheet on a phone. */
export function SwapModal(p: PickProps) {
  return useIsPhone() ? <SwapPickSheet {...p} /> : <SwapDesk {...p} />;
}

/** "Copier pour ZR" once swapped: a dialog, or a sheet on a phone. */
export function SwapSheetModal(p: CopyProps) {
  return useIsPhone() ? <SwapCopySheet {...p} /> : <SwapCopyDesk {...p} />;
}

function SwapDesk({ o, onClose, onDone }: PickProps) {
  const { t } = useTranslation();
  const f = useSwapPick(o, onDone);
  const opt = (x: Cand) => (
    <label key={x.id} className="bjsv-cand">
      <input type="radio" name="bjsv-pick" aria-label={t('suivi.swapM.choose', { ref: x.ref })} checked={f.pick?.id === x.id} onChange={() => f.choose(x)} />
      <div className="grow">
        <b>
          <span className="ltr">{x.ref}</span> · {x.customerName}
        </b>
        <small>
          <span className="ltr">{x.phone}</span> · {wilayaName(x.wilayaId)}
          {x.commune ? ` · ${x.commune}` : ''}
        </small>
        <small>{productsText(x)}</small>
        <div className="row">
          {x.followStatus === 'prepared' ? (
            <span className="badge t-warn">
              {t('suivi.swapM.tagPrepared')}
              {x.companyName ? ` · ${x.companyName}` : ''}
            </span>
          ) : (
            <span className="badge t-off">{t('suivi.swapM.tagToPrepare')}</span>
          )}
          {x.sameWilaya && <span className="badge t-ok">{t('suivi.swapM.tagWilaya')}</span>}
          {x.sameVariant ? (
            <span className="badge t-info">{t('suivi.swapM.tagVariant')}</span>
          ) : x.sameProduct ? (
            <span className="badge t-mid">{t('suivi.swapM.tagProduct')}</span>
          ) : (
            <span className="badge t-warn">{t('suivi.swapM.tagOther')}</span>
          )}
        </div>
      </div>
      <b className="bjsv-amt ltr">{da(x.total)}</b>
    </label>
  );
  return (
    <Modal
      wide
      title={t('suivi.swapM.title', { ref: o.ref })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={f.swap.isPending} onClick={f.submit}>
            {t('suivi.swapM.submit')}
          </button>
        </>
      }
    >
      <div className="bjsv-swap">
        <p>
          {t('suivi.swapM.intro1')}
          <b>{o.companyName || o.livreurName || t('suivi.swapM.theCompany')}</b>
          {t('suivi.swapM.intro2', { tracking: trackOf(o) || '—' })}
          <b>{productsText(o)}</b>
          {t('suivi.swapM.intro3', { name: o.customerName || t('suivi.swapM.theClient') })}
        </p>
        <h3>{t('suivi.swapM.cands')}</h3>
        <p className="muted small">{t('suivi.swapM.candsHelp')}</p>
        <div className="bjsv-cands">{f.sug.isLoading ? <Loading /> : f.sug.error ? <p className="badbox">{f.sug.error.message}</p> : f.sugRows.length ? f.sugRows.map(opt) : <p className="muted small">{t('suivi.swapM.noCands')}</p>}</div>
        <h3>{t('suivi.swapM.other')}</h3>
        <input type="search" aria-label={t('suivi.swapM.searchPh')} value={f.q} placeholder={t('suivi.swapM.searchPh')} autoComplete="off" onChange={(e) => f.setQ(e.target.value)} />
        {f.deb.length >= 2 && <div className="bjsv-cands">{f.found.isFetching && !f.found.data ? <Loading /> : f.foundRows.length ? f.foundRows.map(opt) : <p className="muted small">{t('suivi.swapM.noFound')}</p>}</div>}
        {f.pick && !f.pick.sameVariant && <p className="warnbox">{t('suivi.swapM.mismatch', { a: productsText(o), ref: f.pick.ref, b: productsText(f.pick) })}</p>}
        {f.err && <p className="form-err">{f.err}</p>}
      </div>
    </Modal>
  );
}

/** "Copier pour ZR": every field copied one by one, the window closes once everything required is copied. */
function SwapCopyDesk(p: CopyProps) {
  const { from, to, oldTracking, oldTotal, wasPrepared, fresh, onClose } = p;
  const { t } = useTranslation();
  const c = useCopyFields(p);
  const close = () => {
    if (!fresh || c.all) onClose();
  };
  return (
    <Modal
      wide
      title={t('suivi.sheet.title')}
      onClose={close}
      footer={
        <button className="btn primary" disabled={fresh && !c.all} onClick={onClose}>
          {t('suivi.sheet.done')}
        </button>
      }
    >
      <p className="okbox">{t('suivi.sheet.ok', { a: from.ref, b: to.ref })}</p>
      {wasPrepared !== undefined && (
        <p className={wasPrepared ? 'badbox' : 'warnbox'}>
          <b>{t('suivi.sheet.depot')}</b>
          {wasPrepared ? t('suivi.sheet.wasPrepared', { ref: to.ref }) : t('suivi.sheet.wasToPrepare', { ref: to.ref, from: from.ref })}
        </p>
      )}
      <p>
        <b>{t('suivi.sheet.copyEach', { who: c.who })}</b>
      </p>
      <div className="bjsv-sheet">
        {c.fields.map(([k, v, req], i) => {
          const label = t(`suivi.sheet.f.${k}`);
          return (
            <div key={k} className={`bjsv-f${v ? '' : ' empty'}${req ? '' : ' opt'}${c.done.has(k) ? ' done' : ''}`}>
              <span className="bjsv-l">
                {i + 1}. {label}
                {k === 'total' && to.total !== oldTotal && <small>{t('suivi.sheet.oldParcel', { n: Math.round(oldTotal) })}</small>}
              </span>
              <input ref={(el) => (c.refs.current[k] = el)} type="text" readOnly value={v} placeholder="—" aria-label={label} className="ltr" onCopy={() => v && c.mark(k)} />
              <button type="button" className={`btn small bjsv-cp${c.done.has(k) ? ' ok' : ''}`} title={t('suivi.sheet.copyOne', { label: label.toLowerCase() })} disabled={!v} onClick={() => c.copyOne(k, v)}>
                {!v ? '—' : c.done.has(k) ? '✓' : '📋'}
              </button>
            </div>
          );
        })}
        <div className="bjsv-prog">
          <b>{t('suivi.sheet.copied', { done: c.count, need: c.need })}</b>
          <span className="bjsv-bar">
            <i style={{ width: `${Math.round((c.count / Math.max(1, c.need)) * 100)}%` }} />
          </span>
          {c.all ? <span className="badge t-ok">{t('suivi.sheet.allCopied')}</span> : <span className="muted small">{t('suivi.sheet.copyHint')}</span>}
        </div>
        {c.own && (
          <div className="row">
            <button type="button" className="btn small" onClick={async () => (await copyText(swapText(t, from, to, oldTracking, oldTotal))) && toast(t('common.copied'), 'ok')}>
              {t('suivi.sheet.allText')}
            </button>
          </div>
        )}
      </div>
      {c.own ? <p className="muted small">{t('suivi.sheet.ownInfo', { tracking: oldTracking || '—' })}</p> : <p className="warnbox">{t('suivi.sheet.companyWarn', { company: to.companyName })}</p>}
    </Modal>
  );
}
