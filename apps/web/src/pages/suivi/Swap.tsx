import type { Order } from '@pilotix/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, wilayaName } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { copyText, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { productsText, swapText } from './common';

type Cand = Order & { sameWilaya: boolean; sameVariant: boolean; sameProduct: boolean };
export type SwapResult = { from: Order; to: Order; oldTracking: string | null; oldTotal: number; wasPrepared?: boolean; companyKind: string | null };

/** Give a cancelled parcel to another confirmed order that is not shipped yet. */
export function SwapModal({ o, onClose, onDone }: { o: Order; onClose: () => void; onDone: (r: SwapResult) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [deb, setDeb] = useState('');
  const [pick, setPick] = useState<Cand | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setDeb(q.trim()), 350);
    return () => clearTimeout(h);
  }, [q]);
  const sug = useRpc('suivi.swapCandidates', { fromId: o.id });
  const found = useRpc('suivi.swapCandidates', { fromId: o.id, q: deb }, { enabled: deb.length >= 2 });
  const swap = useAction('suivi.swap', { onDone: (r) => onDone(r as SwapResult) });

  const opt = (x: Cand) => (
    <label key={x.id} className="bjsv-cand">
      <input type="radio" name="bjsv-pick" aria-label={t('suivi.swapM.choose', { ref: x.ref })} checked={pick?.id === x.id} onChange={() => (setPick(x), setErr(''))} />
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

  const sugRows = (sug.data?.rows ?? []) as Cand[];
  const foundRows = (found.data?.rows ?? []) as Cand[];
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
          <button className="btn primary" disabled={swap.isPending} onClick={() => (pick ? swap.mutate({ fromId: o.id, toId: pick.id }) : setErr(t('suivi.swapM.pick')))}>
            {t('suivi.swapM.submit')}
          </button>
        </>
      }
    >
      <div className="bjsv-swap">
        <p>
          {t('suivi.swapM.intro1')}
          <b>{o.companyName || o.livreurName || t('suivi.swapM.theCompany')}</b>
          {t('suivi.swapM.intro2', { tracking: o.tracking || '—' })}
          <b>{productsText(o)}</b>
          {t('suivi.swapM.intro3', { name: o.customerName || t('suivi.swapM.theClient') })}
        </p>
        <h3>{t('suivi.swapM.cands')}</h3>
        <p className="muted small">{t('suivi.swapM.candsHelp')}</p>
        <div className="bjsv-cands">{sug.isLoading ? <Loading /> : sug.error ? <p className="badbox">{sug.error.message}</p> : sugRows.length ? sugRows.map(opt) : <p className="muted small">{t('suivi.swapM.noCands')}</p>}</div>
        <h3>{t('suivi.swapM.other')}</h3>
        <input type="search" value={q} placeholder={t('suivi.swapM.searchPh')} autoComplete="off" onChange={(e) => setQ(e.target.value)} />
        {deb.length >= 2 && <div className="bjsv-cands">{found.isFetching && !found.data ? <Loading /> : foundRows.length ? foundRows.map(opt) : <p className="muted small">{t('suivi.swapM.noFound')}</p>}</div>}
        {pick && !pick.sameVariant && <p className="warnbox">{t('suivi.swapM.mismatch', { a: productsText(o), ref: pick.ref, b: productsText(pick) })}</p>}
        {err && <p className="form-err">{err}</p>}
      </div>
    </Modal>
  );
}

/** "Copier pour ZR": every field copied one by one, the window closes once everything required is copied. */
export function SwapSheetModal({ from, to, oldTracking, oldTotal, wasPrepared, companyKind, fresh, onClose }: SwapResult & { fresh?: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const own = companyKind === 'own' || !to.companyName;
  const fields: [string, string, boolean][] = (
    [
      ['old', oldTracking || '', true],
      ['name', to.customerName || '', true],
      ['phone', to.phone || '', true],
      ['phone2', to.phone2 || '', false],
      ['wilaya', to.wilayaId ? wilayaName(to.wilayaId) : '', false],
      ['commune', to.commune || '', false],
      ['total', String(Math.round(to.total)), true],
    ] as [string, string, boolean][]
  ).filter(([, v, req]) => req || v);
  const need = fields.filter(([, v, req]) => req && v).length;
  const [done, setDone] = useState<Set<string>>(new Set());
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const count = fields.filter(([k, , req]) => req && done.has(k)).length;
  const all = count >= need;
  const mark = (k: string) => setDone((s) => new Set(s).add(k));
  const copyOne = async (k: string, v: string) => {
    if (await copyText(v)) {
      mark(k);
      toast(t('suivi.sheet.copiedVal', { v }), 'ok');
    } else {
      refs.current[k]?.focus();
      refs.current[k]?.select();
      toast(t('suivi.sheet.selected'), 'info');
    }
  };
  const close = () => {
    if (!fresh || all) onClose();
  };
  const who = own ? t('suivi.theLivreur') : to.companyName!;
  return (
    <Modal
      wide
      title={t('suivi.sheet.title')}
      onClose={close}
      footer={
        <button className="btn primary" disabled={fresh && !all} onClick={onClose}>
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
        <b>{t('suivi.sheet.copyEach', { who })}</b>
      </p>
      <div className="bjsv-sheet">
        {fields.map(([k, v, req], i) => {
          const label = t(`suivi.sheet.f.${k}`);
          return (
            <div key={k} className={`bjsv-f${v ? '' : ' empty'}${req ? '' : ' opt'}${done.has(k) ? ' done' : ''}`}>
              <span className="bjsv-l">
                {i + 1}. {label}
                {k === 'total' && to.total !== oldTotal && <small>{t('suivi.sheet.oldParcel', { n: Math.round(oldTotal) })}</small>}
              </span>
              <input ref={(el) => (refs.current[k] = el)} type="text" readOnly value={v} placeholder="—" aria-label={label} className="ltr" onCopy={() => v && mark(k)} />
              <button type="button" className={`btn small bjsv-cp${done.has(k) ? ' ok' : ''}`} title={t('suivi.sheet.copyOne', { label: label.toLowerCase() })} disabled={!v} onClick={() => copyOne(k, v)}>
                {!v ? '—' : done.has(k) ? '✓' : '📋'}
              </button>
            </div>
          );
        })}
        <div className="bjsv-prog">
          <b>{t('suivi.sheet.copied', { done: count, need })}</b>
          <span className="bjsv-bar">
            <i style={{ width: `${Math.round((count / Math.max(1, need)) * 100)}%` }} />
          </span>
          {all ? <span className="badge t-ok">{t('suivi.sheet.allCopied')}</span> : <span className="muted small">{t('suivi.sheet.copyHint')}</span>}
        </div>
        {own && (
          <div className="row">
            <button type="button" className="btn small" onClick={async () => (await copyText(swapText(t, from, to, oldTracking, oldTotal))) && toast(t('common.copied'), 'ok')}>
              {t('suivi.sheet.allText')}
            </button>
          </div>
        )}
      </div>
      {own ? <p className="muted small">{t('suivi.sheet.ownInfo', { tracking: oldTracking || '—' })}</p> : <p className="warnbox">{t('suivi.sheet.companyWarn', { company: to.companyName })}</p>}
    </Modal>
  );
}
