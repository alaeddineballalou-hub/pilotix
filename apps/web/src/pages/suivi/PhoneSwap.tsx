// Swap on a phone: give a cancelled parcel to another customer whose order waits at the depot — the parcel at the
// top, the customers as big cards (same wilaya, same product, ZR's swap price), « Donner le colis à … » at the thumb;
// then each line ZR must change, copied with one tap.
import type { Order } from '@pilotix/shared';
import { useTranslation } from 'react-i18next';
import { da, wilayaName } from '../../lib/format';
import { trackOf } from '../../lib/items';
import { copyText, Icon, Loading } from '../../ui/kit';
import { Sheet } from '../../ui/Sheet';
import { toast } from '../../ui/toast';
import { productsText, swapText } from './common';
import { useParcelInfo } from './CourierPanel';
import { Cand, SwapResult, useCopyFields, useSwapPick } from './swapKit';

export function SwapPickSheet({ o, onClose, onDone }: { o: Order; onClose: () => void; onDone: (r: SwapResult) => void }) {
  const { t } = useTranslation();
  const f = useSwapPick(o, onDone);
  // ZR: what the swap costs (same wilaya or another) and whether it still takes one for this parcel
  const zr = useParcelInfo(o).data;
  const sw = zr?.supported ? zr.info?.swap ?? null : null;
  const co = o.companyName || o.livreurName || t('suivi.swapM.theCompany');
  const price = (x: Cand) => (sw ? (x.wilayaId === o.wilayaId ? sw.sameCityPrice : sw.differentCityPrice) : null);
  const card = (x: Cand) => {
    const on = f.pick?.id === x.id;
    const p = price(x);
    return (
      <button key={x.id} type="button" role="radio" aria-checked={on} className={`pxw-c${on ? ' on' : ''}`} onClick={() => f.choose(x)}>
        <i aria-hidden="true" />
        <span className="pxw-cm">
          <span className="pxw-n">
            <b>{x.customerName}</b>
            <small className="ltr">{x.ref}</small>
            <b className="pxw-amt ltr">{da(x.total)}</b>
          </span>
          <small>
            {wilayaName(x.wilayaId)}
            {x.commune ? ` · ${x.commune}` : ''} · <span className="ltr">{x.phone}</span>
          </small>
          <small>{productsText(x)}</small>
          <span className="pxw-tags">
            {x.sameWilaya && <span className="ok">{t('suivi.swapM.ph.tagWilaya')}</span>}
            {x.sameVariant ? <span className="info">{t('suivi.swapM.ph.tagVariant')}</span> : x.sameProduct ? <span className="mid">{t('suivi.swapM.ph.tagProduct')}</span> : <span className="warn">{t('suivi.swapM.ph.tagOther')}</span>}
            {x.followStatus === 'prepared' ? <span className="warn">{t('suivi.swapM.ph.tagPrepared')}</span> : <span>{t('suivi.swapM.ph.tagToPrepare')}</span>}
            {p != null && <span className="zr">{t('suivi.swapM.ph.zrCost', { v: da(p) })}</span>}
          </span>
        </span>
      </button>
    );
  };
  const searching = f.deb.length >= 2;
  return (
    <Sheet
      tall
      title={t('suivi.swapM.ph.title')}
      sub={
        <>
          <span className="ltr">{o.ref}</span> · <span className="ltr">{trackOf(o) || '—'}</span> · {co}
        </>
      }
      onClose={onClose}
      foot={
        <>
          {f.pick && !f.pick.sameVariant && <p className="pxk-warn">{t('suivi.swapM.mismatch', { a: productsText(o), ref: f.pick.ref, b: productsText(f.pick) })}</p>}
          <button type="button" className="pxk-go" disabled={!f.pick || f.swap.isPending || (!!sw && !sw.eligible)} onClick={f.submit}>
            <Icon name="swap" /> {f.pick ? t('suivi.swapM.ph.give', { name: f.pick.customerName }) : t('suivi.swapM.ph.pickFirst')}
          </button>
          <p className="pxk-fnote">{t('suivi.swapM.ph.foot')}</p>
        </>
      }
    >
      <div className="pxw-from">
        <span className="pxs-th" aria-hidden="true">
          <Icon name="package" />
        </span>
        <span>
          <b>{productsText(o)}</b>
          <small>
            {t('suivi.swapM.ph.cancelledBy', { name: o.customerName || t('suivi.swapM.theClient') })} · {wilayaName(o.wilayaId)}
          </small>
        </span>
        <b className="ltr">{da(o.total)}</b>
      </div>
      {sw &&
        (sw.eligible ? (
          <p className="pxk-info">
            <Icon name="info" /> {t('suivi.swapM.ph.zrPrice', { name: co, same: da(sw.sameCityPrice), other: da(sw.differentCityPrice) })}
          </p>
        ) : (
          <p className="pxk-warn">{t('suivi.swapM.ph.zrNo', { name: co })}</p>
        ))}
      <label className="pxw-find">
        <Icon name="search" />
        <input type="search" value={f.q} placeholder={t('suivi.swapM.searchPh')} autoComplete="off" aria-label={t('suivi.swapM.other')} onChange={(e) => f.setQ(e.target.value)} />
      </label>
      {searching ? (
        <fieldset className="pxk-q">
          <legend>{t('suivi.swapM.ph.found')}</legend>
          {f.found.isFetching && !f.found.data ? (
            <Loading />
          ) : f.foundRows.length ? (
            <div className="pxw-list" role="radiogroup" aria-label={t('suivi.swapM.ph.found')}>
              {f.foundRows.map(card)}
            </div>
          ) : (
            <p className="pxk-info">{t('suivi.swapM.noFound')}</p>
          )}
        </fieldset>
      ) : (
        <fieldset className="pxk-q">
          <legend>
            {t('suivi.swapM.ph.cands')} <b className="pxw-n0">{f.sugRows.length}</b>
          </legend>
          <small>{t('suivi.swapM.ph.candsHelp')}</small>
          {f.sug.isLoading ? (
            <Loading />
          ) : f.sug.error ? (
            <p className="pxk-bad">{f.sug.error.message}</p>
          ) : f.sugRows.length ? (
            <div className="pxw-list" role="radiogroup" aria-label={t('suivi.swapM.ph.cands')}>
              {f.sugRows.map(card)}
            </div>
          ) : (
            <p className="pxk-info">{t('suivi.swapM.noCands')}</p>
          )}
        </fieldset>
      )}
    </Sheet>
  );
}

export function SwapCopySheet(p: SwapResult & { fresh?: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { from, to, oldTracking, oldTotal, wasPrepared, fresh, onClose } = p;
  const c = useCopyFields(p, true);
  // freshly swapped: the courier must be told first (each required line copied)
  const close = () => {
    if (!fresh || c.all) return onClose();
    toast(t('suivi.sheet.copyHint'), 'info');
    return false;
  };
  return (
    <Sheet
      title={t('suivi.sheet.title')}
      sub={
        <>
          <span className="ltr">{from.ref}</span> → <span className="ltr">{to.ref}</span> · {to.customerName}
        </>
      }
      onClose={close}
      foot={
        <>
          <div className="pxw-prog">
            <span className="pxw-bar" aria-hidden="true">
              <i style={{ width: `${Math.round((c.count / Math.max(1, c.need)) * 100)}%` }} />
            </span>
            <b>{t('suivi.sheet.copied', { done: c.count, need: c.need })}</b>
          </div>
          <button type="button" className="pxk-go ok" disabled={fresh && !c.all} onClick={onClose}>
            <Icon name="check" /> {t('suivi.sheet.ph.done')}
          </button>
        </>
      }
    >
      <p className="pxk-okb">{t('suivi.sheet.ok', { a: from.ref, b: to.ref })}</p>
      {wasPrepared !== undefined && (
        <p className={wasPrepared ? 'pxk-bad' : 'pxk-warn'}>
          <b>{t('suivi.sheet.depot')}</b>
          {wasPrepared ? t('suivi.sheet.wasPrepared', { ref: to.ref }) : t('suivi.sheet.wasToPrepare', { ref: to.ref, from: from.ref })}
        </p>
      )}
      <fieldset className="pxk-q">
        <legend>{t('suivi.sheet.copyEach', { who: c.who })}</legend>
        <ul className="pxw-copy">
          {c.fields.map(([k, v, req]) => {
            const label = t(`suivi.sheet.f.${k}`);
            const ok = c.done.has(k);
            return (
              <li key={k} className={`${ok ? 'ok' : ''}${req ? '' : ' opt'}`}>
                <span>
                  <small>
                    {label}
                    {k === 'total' && to.total !== oldTotal ? t('suivi.sheet.oldParcel', { n: Math.round(oldTotal) }) : ''}
                  </small>
                  <input ref={(el) => (c.refs.current[k] = el)} type="text" readOnly value={v} placeholder="—" aria-label={label} className="ltr" onCopy={() => v && c.mark(k)} />
                </span>
                <button type="button" className={`pxw-cp${ok ? ' ok' : ''}`} disabled={!v} aria-label={t('suivi.sheet.copyOne', { label: label.toLowerCase() })} onClick={() => c.copyOne(k, v)}>
                  <Icon name={ok ? 'check' : 'copy'} />
                  <span>{ok ? t('suivi.sheet.ph.copied') : t('suivi.sheet.ph.copy')}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </fieldset>
      {c.own && (
        <button type="button" className="pxk-go ghost" onClick={async () => (await copyText(swapText(t, from, to, oldTracking, oldTotal))) && toast(t('common.copied'), 'ok')}>
          <Icon name="copy" /> {t('suivi.sheet.allText')}
        </button>
      )}
      {c.own ? <p className="pxk-info">{t('suivi.sheet.ownInfo', { tracking: oldTracking || '—' })}</p> : <p className="pxk-warn">{t('suivi.sheet.companyWarn', { company: to.companyName })}</p>}
    </Sheet>
  );
}
