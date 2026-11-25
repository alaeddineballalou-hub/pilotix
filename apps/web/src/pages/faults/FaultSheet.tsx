// The report sheet (design 2, the owner's choice, 25 Nov 2026): the agent says WHAT happened — search, the reasons
// picked most, or a subject — then answers the one question the reason needs. Pilotix decides WHO (modules/faults.ts):
// the agent never picks a team. Before delivery (Suivi, a return) the customer only saw the product at the door: no
// photo, the depot checks the parcel when it comes back. After delivery (a SAV ticket) the customer's photo.
import { FAULT_ASK, FAULT_FREQUENT, FAULT_GROUPS, FAULT_SEEN, type FaultMoment, type FaultPickReason } from '@pilotix/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { GROUP_ICON } from './parts';
import './faults.css';

type Props = { orderId?: number; ticketId?: number; moment: FaultMoment; cancel?: boolean; onClose: () => void; onDone?: () => void };

const ALL: FaultPickReason[] = FAULT_GROUPS.flatMap((g) => [...g.reasons] as FaultPickReason[]);
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function FaultSheet({ orderId, ticketId, moment, cancel, onClose, onDone }: Props) {
  const { t } = useTranslation();
  const o = useRpc('faults.order', { orderId, ticketId });
  const save = useAction('faults.report', {
    success: t('faults.sheet.saved'),
    onDone: () => {
      onDone?.();
      onClose();
    },
  });
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<string | null>(null);
  const [reason, setReason] = useState<FaultPickReason | null>(null);
  const [variant, setVariant] = useState('');
  const [typed, setTyped] = useState(false);
  const [qty, setQty] = useState('');
  const [yes, setYes] = useState<boolean | null>(null);
  const [photo, setPhoto] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const sav = moment === 'sav';
  const ask = reason ? FAULT_ASK[reason] : undefined;
  const seen = !!reason && FAULT_SEEN.has(reason);
  const ready =
    !!reason &&
    (ask !== 'variant' || !!variant.trim()) &&
    (ask !== 'qty' || /^\d{1,3}$/.test(qty)) &&
    (ask !== 'sealed' || yes !== null) &&
    (!sav || !seen || !!photo);
  const label = (r: string) => t(`faults.reason.${r}`);
  const found = useMemo(() => (q.trim() ? ALL.filter((r) => fold(label(r)).includes(fold(q.trim()))) : []), [q, t]);
  const pick = (r: FaultPickReason) => {
    setReason(r);
    setVariant('');
    setTyped(false);
    setQty('');
    setYes(null);
  };
  const send = () =>
    reason &&
    o.data &&
    save.mutate({
      orderId: o.data.orderId,
      ticketId,
      moment,
      reason,
      answers: {
        ...(ask === 'variant' ? { variant: variant.trim() } : {}),
        ...(ask === 'qty' ? { qty: Number(qty) } : {}),
        ...(ask === 'sealed' && yes !== null ? { sealed: yes } : {}),
        ...(ask === 'packed' && yes !== null ? { badlyPacked: yes } : {}),
      },
      note: note.trim() || undefined,
      photo: photo ?? undefined,
    });
  const title = reason ? label(reason) : cancel ? t('faults.sheet.titleCancel') : t('faults.sheet.title');
  const sub = o.data ? [o.data.ref, o.data.customer, o.data.product].filter(Boolean).join(' · ') : '';
  return (
    <Modal
      sheet
      title={
        <span>
          {title}
          {sub && <small style={{ display: 'block', fontSize: 12.5, fontWeight: 500, color: 'var(--muted)' }}>{sub}</small>}
        </span>
      }
      onClose={onClose}
      footer={
        reason ? (
          <button type="button" className="pxf-go" disabled={!ready || save.isPending} onClick={send}>
            <Icon name="check" /> {t('faults.sheet.save')}
          </button>
        ) : undefined
      }
    >
      {o.error ? (
        <ErrorBox error={o.error} onRetry={() => o.refetch()} />
      ) : !o.data ? (
        <Loading />
      ) : o.data.decided ? (
        <p className="pxf-note">{t('faults.sheet.decided')}</p>
      ) : !reason ? (
        <div className="pxf-sheet">
          <label className="pxf-search">
            <Icon name="search" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('faults.sheet.search')} aria-label={t('faults.sheet.search')} />
          </label>
          {q.trim() ? (
            <div className="pxf-chips">
              {found.map((r) => (
                <button key={r} type="button" className="pxf-c" onClick={() => pick(r)}>
                  {label(r)}
                </button>
              ))}
              {!found.length && <p className="pxf-note">{t('faults.sheet.nothing')}</p>}
            </div>
          ) : (
            <>
              <p className="pxf-gl">{t('faults.sheet.frequent')}</p>
              <div className="pxf-chips">
                {FAULT_FREQUENT.map((r) => (
                  <button key={r} type="button" className="pxf-c" onClick={() => pick(r)}>
                    {label(r)}
                  </button>
                ))}
              </div>
              <p className="pxf-gl">{t('faults.sheet.all')}</p>
              <div>
                {FAULT_GROUPS.map((g) => (
                  <div key={g.key}>
                    <button type="button" className={`pxf-acc ${group === g.key ? 'open' : ''}`} aria-expanded={group === g.key} onClick={() => setGroup(group === g.key ? null : g.key)}>
                      <Icon name={GROUP_ICON[g.key]} />
                      {t(`faults.group.${g.key}`)}
                      <small>{t('faults.sheet.count', { n: g.reasons.length })}</small>
                      <Icon name={group === g.key ? 'chevron' : 'chevr'} />
                    </button>
                    {group === g.key && (
                      <div className="pxf-accb">
                        <div className="pxf-chips">
                          {g.reasons.map((r) => (
                            <button key={r} type="button" className="pxf-c" onClick={() => pick(r as FaultPickReason)}>
                              {label(r)}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="pxf-sheet">
          <button type="button" className="pxf-back" onClick={() => setReason(null)}>
            <Icon name="chevl" /> {t('faults.sheet.back')}
          </button>
          {(ask || seen) && o.data.product && (
            <div className="pxf-ord">
              <Icon name="package" />
              <span>
                <b>{o.data.product}</b>
                <small>
                  {o.data.variant ? (
                    <>
                      {t('faults.sheet.ordered')} <strong>{o.data.variant}</strong> ·{' '}
                    </>
                  ) : null}
                  ×{o.data.qty}
                </small>
              </span>
            </div>
          )}
          {ask === 'variant' && (
            <>
              <p className="pxf-q">{sav ? t('faults.sheet.askVariantGot') : t('faults.sheet.askVariantSeen')}</p>
              <div className="pxf-chips">
                {o.data.variants.map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`pxf-c ${!typed && variant === v ? 'on' : ''}`}
                    onClick={() => {
                      setTyped(false);
                      setVariant(v);
                    }}
                  >
                    {v}
                  </button>
                ))}
                <button
                  type="button"
                  className={`pxf-c ${typed ? 'on' : ''}`}
                  onClick={() => {
                    setTyped(true);
                    setVariant('');
                  }}
                >
                  {t('faults.sheet.other')}
                </button>
              </div>
              {typed && <input className="pxf-in" value={variant} maxLength={120} autoFocus placeholder={t('faults.sheet.typeVariant')} onChange={(e) => setVariant(e.target.value)} />}
            </>
          )}
          {ask === 'qty' && (
            <>
              <p className="pxf-q">{t('faults.sheet.askQty')}</p>
              <input className="pxf-in" inputMode="numeric" value={qty} maxLength={3} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 120 }} />
            </>
          )}
          {(ask === 'sealed' || ask === 'packed') && (
            <>
              <p className="pxf-q">{ask === 'sealed' ? t('faults.sheet.askSealed') : t('faults.sheet.askPacked')}</p>
              <div className="pxf-chips">
                <button type="button" className={`pxf-c ${yes === true ? 'on' : ''}`} onClick={() => setYes(true)}>
                  {t('faults.sheet.yes')}
                </button>
                <button type="button" className={`pxf-c ${yes === false ? 'on' : ''}`} onClick={() => setYes(false)}>
                  {t('faults.sheet.no')}
                </button>
              </div>
            </>
          )}
          {seen && sav && (
            <>
              <p className="pxf-q">
                {t('faults.sheet.photo')}
                <small>{t('faults.sheet.photoNeeded')}</small>
              </p>
              {photo && (
                <div className="pxf-photo">
                  <img src={photo} alt="" />
                  <span>{t('faults.sheet.photoOk')}</span>
                  <Icon name="check" />
                </div>
              )}
              <label className="pxf-add">
                <Icon name="camera" /> {photo ? t('faults.sheet.changePhoto') : t('faults.sheet.addPhoto')}
                <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && shrink(e.target.files[0]).then(setPhoto)} />
              </label>
            </>
          )}
          {seen && !sav && (
            <p className="pxf-info blue">
              <Icon name="package" /> {t('faults.sheet.noPhoto')}
            </p>
          )}
          <p className="pxf-q">
            {t('faults.sheet.note')}
            <small>{t('faults.sheet.optional')}</small>
          </p>
          <textarea className="pxf-in" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          <p className="pxf-info">
            <Icon name="settings" /> {t('faults.sheet.who')}
          </p>
        </div>
      )}
    </Modal>
  );
}

/** The customer's photo, made small (a JPEG at most 1280 px wide): it is kept with the line. */
function shrink(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1280 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      const g = c.getContext('2d');
      if (!g) return reject(new Error('canvas'));
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      let q = 0.82;
      let out = c.toDataURL('image/jpeg', q);
      while (out.length > 850_000 && q > 0.4) out = c.toDataURL('image/jpeg', (q -= 0.1));
      resolve(out);
    };
    img.onerror = () => reject(new Error('image'));
    img.src = url;
  });
}

/** « Signaler le problème » on a SAV ticket (after delivery: the customer's photo). */
export function SignalFault({ ticketId }: { ticketId: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="pxf-mini" onClick={() => setOpen(true)}>
        <Icon name="flag" /> {t('faults.signal')}
      </button>
      {open && <FaultSheet ticketId={ticketId} moment="sav" onClose={() => setOpen(false)} />}
    </>
  );
}
