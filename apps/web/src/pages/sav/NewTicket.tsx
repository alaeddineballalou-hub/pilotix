import { SAV_TYPES, SAV_WISHES } from '@pilotix/shared';
import type { Order } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { when, wilayaName } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Loading, StatusBadge } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { useStaff } from './staff';

/** Order to start the next new ticket with (set by "Ticket SAV" on an order card, read once). */
let pendingOrder: { id: number; wish: string } | null = null;
export function startTicketFor(orderId: number, wish = 'exchange') {
  pendingOrder = { id: orderId, wish };
  location.hash = '#/sav/nouveau';
}
/** The order a new ticket starts with (read once). */
export function takePendingOrder() {
  const p = pendingOrder;
  pendingOrder = null;
  return p;
}
/** SAV is after delivery (cash on delivery: the customer paid when he got it). A late or missing parcel is a réclamation in Suivi. */
export const NEW_TYPES = SAV_TYPES.filter((x) => x !== 'late' && x !== 'notdelivered');

/** "Nouveau ticket SAV": find the order (or none), type, wish, details, responsable. */
export function NewTicketModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const { t } = useTranslation();
  const staff = useStaff();
  const [q, setQ] = useState('');
  const [deb, setDeb] = useState('');
  const [pick, setPick] = useState<Order | null>(null);
  const [without, setWithout] = useState(false);
  const [askWithout, setAskWithout] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [type, setType] = useState<(typeof SAV_TYPES)[number]>('defect');
  const [wish, setWish] = useState<string>('');
  const [details, setDetails] = useState('');
  const [owner, setOwner] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setDeb(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);
  const [preId] = useState(() => {
    const p = takePendingOrder();
    if (p) setTimeout(() => setWish(p.wish), 0);
    return p?.id ?? null;
  });
  const pre = useRpc('orders.get', { id: preId ?? 0 }, { enabled: !!preId });
  useEffect(() => {
    if (pre.data && !pick) setPick(pre.data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pre.data]);
  const found = useRpc('sav.findOrder', { q: deb }, { enabled: deb.length >= 2 && !pick });
  const create = useAction('sav.create', {
    onDone: (r) => {
      toast(t('sav.form.created', { ref: r.ref }), 'ok');
      onCreated(r.id);
    },
  });
  const submit = () => {
    setErr('');
    if (!pick && !without) return setAskWithout(true);
    if (!details.trim()) return setErr(t('sav.form.needDetails'));
    create.mutate({
      orderId: pick?.id ?? null,
      customerName: pick ? null : name.trim() || null,
      phone: pick ? null : phone.trim() || null,
      type,
      wish: (wish || null) as (typeof SAV_WISHES)[number] | null,
      details: details.trim(),
      assignedTo: owner ? Number(owner) : null,
    });
  };
  return (
    <Modal
      wide
      title={t('sav.form.title')}
      onClose={onClose}
      footer={
        askWithout ? (
          <>
            <span className="muted small grow">{t('sav.form.askWithout')}</span>
            <button className="btn" onClick={() => setAskWithout(false)}>
              {t('common.cancel')}
            </button>
            <button className="btn primary" onClick={() => (setWithout(true), setAskWithout(false))}>
              {t('sav.form.yesWithout')}
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              {t('common.cancel')}
            </button>
            <button className="btn primary" disabled={create.isPending} onClick={submit}>
              {t('sav.form.create')}
            </button>
          </>
        )
      }
    >
      <label className="field">
        <span className="lab">{t('sav.form.order')}</span>
        {pick ? (
          <div className="bjr-sum">
            <b className="ltr">{pick.ref}</b>
            <span>{pick.customerName}</span>
            <span className="ltr">{pick.phone}</span>
            <span>{wilayaName(pick.wilayaId)}</span>
            <StatusBadge kind="follow" status={pick.followStatus} />
            <button type="button" className="linkish" onClick={() => (setPick(null), setQ(''))}>
              {t('sav.form.change')}
            </button>
          </div>
        ) : (
          <input type="search" aria-label={t('sav.form.orderPh')} value={q} autoComplete="off" placeholder={t('sav.form.orderPh')} disabled={without} onChange={(e) => setQ(e.target.value)} autoFocus />
        )}
      </label>
      {!pick && !without && deb.length >= 2 && (
        <div className="bjr-pick">
          {found.isFetching && !found.data ? (
            <Loading />
          ) : found.data?.length ? (
            found.data.map((o) => (
              <button key={o.id} type="button" onClick={() => (setPick(o), setWithout(false))}>
                <b>
                  <span className="ltr">{o.ref}</span> · {o.customerName}
                </b>
                <StatusBadge kind="follow" status={o.followStatus ?? null} />
                <small>
                  <span className="ltr">{o.phone}</span> · {wilayaName(o.wilayaId)} · {when(o.createdAt)}
                </small>
              </button>
            ))
          ) : (
            <p className="muted small">{t('sav.form.noOrder')}</p>
          )}
        </div>
      )}
      <p className="muted small">
        {t('sav.form.orderHint')}{' '}
        {!pick && (
          <label className="check" style={{ display: 'inline-flex', gap: 6 }}>
            <input type="checkbox" checked={without} onChange={(e) => setWithout(e.target.checked)} />
            {t('sav.form.without')}
          </label>
        )}
      </p>
      {without && !pick && (
        <div className="grid2">
          <label className="field">
            <span className="lab">{t('sav.form.name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span className="lab">{t('sav.form.phone')}</span>
            <input type="tel" className="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
        </div>
      )}
      <div className="grid2">
        <label className="field">
          <span className="lab">{t('sav.form.problem')}</span>
          <select value={type} onChange={(e) => setType(e.target.value as (typeof SAV_TYPES)[number])}>
            {NEW_TYPES.map((x) => (
              <option key={x} value={x}>
                {t(`sav.type.${x}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lab">{t('sav.form.wish')}</span>
          <select value={wish} onChange={(e) => setWish(e.target.value)}>
            <option value="">{t('sav.wish.none')}</option>
            {SAV_WISHES.map((x) => (
              <option key={x} value={x}>
                {t(`sav.wish.${x}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="field">
        <span className="lab">{t('sav.form.details')}</span>
        <textarea rows={3} value={details} placeholder={t('sav.form.detailsPh')} onChange={(e) => setDetails(e.target.value)} />
      </label>
      <label className="field">
        <span className="lab">{t('sav.form.owner')}</span>
        <select value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">{t('sav.nobody')}</option>
          {staff.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
      {err && <p className="form-err">{err}</p>}
    </Modal>
  );
}
