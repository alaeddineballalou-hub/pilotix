// Demande de modification of a parcel already at ZR: new amount, home ↔ stop desk, right commune.
// Sent to ZR's API; the order keeps its values until ZR accepts (then Pilotix applies them).
import { communesOf, Order, WILAYAS } from '@pilotix/shared';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';

type Kind = 'price' | 'type' | 'commune';

export interface ModRow {
  id: number;
  ref: string;
  orderId: number;
  companyName: string | null;
  kinds: string[];
  summary: string;
  note: string;
  status: 'pending' | 'approved' | 'refused' | 'error' | 'cancelled';
  extError: string | null;
  extComment: string | null;
  createdAt: string;
  decidedAt: string | null;
}

const TONE: Record<ModRow['status'], string> = { pending: 't-warn', approved: 't-ok', refused: 't-bad', error: 't-bad', cancelled: 't-info' };

/** The requests of one order, with Annuler (waiting) / Renvoyer (refused at sending). */
export function ModHistory({ orderId, compact = false }: { orderId: number; compact?: boolean }) {
  const { t } = useTranslation();
  const q = useRpc('suivi.mods', { orderId });
  const cancel = useAction('suivi.modCancel', { success: t('suivi.mod.cancelled') });
  const push = useAction('suivi.modPush', { onDone: (m) => toast(m.status === 'pending' ? t('suivi.mod.sent', { ref: m.ref, name: m.companyName ?? '' }) : m.extError ?? '', m.status === 'pending' ? 'ok' : 'bad') });
  const rows = ((q.data ?? []) as ModRow[]).slice(0, compact ? 1 : 5);
  if (!rows.length) return null;
  return (
    <div className="pxm-hist">
      {rows.map((m) => (
        <div key={m.id} className="pxm-h">
          <div className="pxm-hh">
            <b className="ltr">{m.ref}</b>
            <span className={`badge ${TONE[m.status]}`}>{t(`suivi.mod.status.${m.status}`, { name: m.companyName ?? '' })}</span>
            <small className="muted">{when(m.decidedAt ?? m.createdAt)}</small>
          </div>
          <div className="small">{m.summary}</div>
          {(m.extError || m.extComment) && <div className={`xs ${m.status === 'error' || m.status === 'refused' ? 'pxm-bad' : 'muted'}`}>{m.extError || m.extComment}</div>}
          {(m.status === 'pending' || m.status === 'error') && (
            <div className="pxm-ha">
              {m.status === 'error' && (
                <button type="button" className="btn small primary" disabled={push.isPending} onClick={() => push.mutate({ id: m.id })}>
                  <Icon name="refresh" />
                  {t('suivi.mod.retry', { name: m.companyName ?? '' })}
                </button>
              )}
              <button type="button" className="btn small ghost danger" disabled={cancel.isPending} onClick={() => cancel.mutate({ id: m.id })}>
                {t('suivi.mod.cancel')}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ModModal({ o, onClose }: { o: Order; onClose: () => void }) {
  const { t } = useTranslation();
  const info = useRpc('suivi.modInfo', { orderId: o.id });
  const sync = useAction('suivi.modSync', { silent: true });
  // ZR's answers to earlier requests first
  useEffect(() => {
    sync.mutate({ orderId: o.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.id]);
  const d = info.data;
  const cur = d?.current;
  const [kind, setKind] = useState<Kind>('price');
  const [desk, setDesk] = useState<boolean | null>(null);
  const [deskId, setDeskId] = useState<number | ''>('');
  const [wil, setWil] = useState<number | ''>('');
  const [com, setCom] = useState('');
  const [addr, setAddr] = useState<string | null>(null);
  const [total, setTotal] = useState<string>('');
  const [touched, setTouched] = useState(false);
  const [note, setNote] = useState('');
  const isDesk = desk ?? cur?.isStopdesk ?? false;
  const w = wil === '' ? cur?.wilayaId ?? 0 : wil;
  const desks = useRpc('delivery.stopdesks', { companyId: d?.companyId ?? 0, wilayaId: w || undefined }, { enabled: !!d?.companyId && isDesk && kind !== 'price' });
  const communes = useMemo(() => (w ? communesOf(w) : []), [w]);

  // the amount follows the new delivery fee until the user types one
  const placeChanged = kind !== 'price' && cur && (isDesk !== cur.isStopdesk || w !== cur.wilayaId || (!isDesk && com !== '' && com !== cur.commune) || (isDesk && deskId !== '' && deskId !== cur.stopdeskId));
  const fee = useMemo(() => {
    if (!d || !cur) return 0;
    if (!placeChanged) return cur.deliveryFee;
    const f = d.fees.find((x) => x.wilayaId === w);
    const v = f ? (isDesk ? f.desk : f.home) : null;
    return v ?? cur.deliveryFee;
  }, [d, cur, placeChanged, w, isDesk]);
  const suggested = cur ? cur.total - cur.deliveryFee + fee : 0;
  useEffect(() => {
    if (!touched && cur) setTotal(String(kind === 'price' ? cur.total : suggested));
  }, [kind, suggested, touched, cur]);

  const create = useAction('suivi.modCreate', {
    onDone: (m) => {
      if (m.status === 'pending') {
        toast(t('suivi.mod.sent', { ref: m.ref, name: m.companyName ?? '' }), 'ok');
        onClose();
      } else toast(m.extError ?? t('suivi.mod.failed', { name: m.companyName ?? '' }), 'bad');
    },
  });

  const submit = () => {
    if (!cur) return;
    const n = Number(total);
    const amount = Number.isFinite(n) && total.trim() !== '' ? Math.round(n) : undefined;
    if (kind === 'price') return create.mutate({ orderId: o.id, total: amount, note: note.trim() });
    if (isDesk) return create.mutate({ orderId: o.id, total: amount, isStopdesk: true, stopdeskId: deskId === '' ? cur.stopdeskId : deskId, note: note.trim() });
    create.mutate({ orderId: o.id, total: amount, isStopdesk: false, wilayaId: w || cur.wilayaId, commune: com || cur.commune, address: addr ?? cur.address, note: note.trim() });
  };

  const name = d?.companyName ?? o.companyName ?? '';
  return (
    <Modal
      wide
      title={t('suivi.mod.title', { ref: o.ref })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={!d?.api || create.isPending} onClick={submit}>
            <Icon name="send" />
            {create.isPending ? t('suivi.rec.apiSending', { name }) : t('suivi.rec.apiSend', { name })}
          </button>
        </>
      }
    >
      {info.isLoading ? (
        <Loading />
      ) : info.error ? (
        <ErrorBox error={info.error} onRetry={() => info.refetch()} />
      ) : !d || !cur ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="bjr-sum">
            <b className="ltr">{o.ref}</b>
            <span>{name}</span>
            <span>{da(cur.total)}</span>
            <span>{cur.isStopdesk ? `${t('orders.form.desk')} · ${cur.stopdeskName ?? ''}` : `${t('orders.form.home')} · ${cur.commune}, ${WILAYAS[cur.wilayaId - 1] ?? ''}`}</span>
          </div>
          {!d.api && <div className="warnbox">{t('suivi.mod.noApi', { name: name || '—' })}</div>}
          <ModHistory orderId={o.id} />
          <div className="field">
            <span className="lab">{t('suivi.mod.what')}</span>
            <div className="pxo-seg pxm-seg" role="radiogroup" aria-label={t('suivi.mod.what')}>
              {(['price', 'type', 'commune'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kind === k}
                  className={kind === k ? 'on' : ''}
                  onClick={() => {
                    setKind(k);
                    setTouched(false);
                    if (k === 'type') setDesk(!cur.isStopdesk);
                    if (k === 'commune') setDesk(false);
                    if (k === 'price') setDesk(null);
                  }}
                >
                  {t(`suivi.mod.kinds.${k}`)}
                </button>
              ))}
            </div>
          </div>

          {kind === 'type' && (
            <div className="field">
              <span className="lab">{t('orders.form.type')}</span>
              <div className="pxo-seg" role="radiogroup" aria-label={t('orders.form.type')}>
                {([false, true] as const).map((k) => (
                  <button key={String(k)} type="button" role="radio" aria-checked={isDesk === k} className={isDesk === k ? 'on' : ''} onClick={() => (setDesk(k), setTouched(false))}>
                    {k ? t('orders.form.desk') : t('orders.form.home')}
                  </button>
                ))}
              </div>
            </div>
          )}

          {kind !== 'price' && (
            <div className="pxm-grid">
              <label className="field">
                <span className="lab">{t('orders.form.wilaya')}</span>
                <select value={w || ''} onChange={(e) => (setWil(Number(e.target.value) || ''), setCom(''), setDeskId(''), setTouched(false))}>
                  {WILAYAS.map((x, k) => (
                    <option key={k} value={k + 1}>
                      {String(k + 1).padStart(2, '0')} · {x}
                    </option>
                  ))}
                </select>
              </label>
              {isDesk ? (
                <label className="field">
                  <span className="lab">{t('suivi.mod.desk', { name })}</span>
                  <select value={deskId === '' ? (w === cur.wilayaId && cur.stopdeskId ? cur.stopdeskId : '') : deskId} onChange={(e) => (setDeskId(Number(e.target.value) || ''), setTouched(false))}>
                    <option value="">{desks.isLoading ? t('common.loading') : t('suivi.mod.deskPh')}</option>
                    {((desks.data ?? []) as { id: number; name: string; commune: string | null }[]).map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.commune ? ` · ${s.commune}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className="field">
                  <span className="lab">{t('orders.form.commune')}</span>
                  <select value={com || (w === cur.wilayaId ? cur.commune : '')} onChange={(e) => (setCom(e.target.value), setTouched(false))}>
                    <option value="">{t('orders.form.communePh')}</option>
                    {w === cur.wilayaId && cur.commune && !communes.some((c) => c[1] === cur.commune) && <option value={cur.commune}>{cur.commune}</option>}
                    {communes.map((c) => (
                      <option key={c[1]} value={c[1]}>
                        {c[1]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {!isDesk && (
                <label className="field pxm-wide">
                  <span className="lab">{t('suivi.mod.address')}</span>
                  <input value={addr ?? cur.address} maxLength={300} onChange={(e) => setAddr(e.target.value)} />
                </label>
              )}
            </div>
          )}

          <label className="field">
            <span className="lab">{t('suivi.mod.amount')}</span>
            <input type="number" inputMode="numeric" min={0} value={total} onChange={(e) => (setTotal(e.target.value), setTouched(true))} />
            {kind !== 'price' && fee !== cur.deliveryFee && (
              <small className="muted">{t('suivi.mod.feeHint', { old: da(cur.deliveryFee), new: da(fee) })}</small>
            )}
          </label>
          <label className="field">
            <span className="lab">{t('suivi.mod.note')}</span>
            <input value={note} maxLength={500} placeholder={t('suivi.mod.notePh')} onChange={(e) => setNote(e.target.value)} />
          </label>
          <p className="muted small">{t('suivi.mod.help', { name })}</p>
        </div>
      )}
    </Modal>
  );
}
