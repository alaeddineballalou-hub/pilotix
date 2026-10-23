// A parcel at its courier (ZR Express), from Pilotix: where it is (ZR's journey, hubs, SMS), its livreur, the customer's
// return risk, an exchange's return parcel, and the modification requests — price, home ↔ stop desk, address, phone —
// sent to ZR and applied to the order once ZR accepts. Shown in the order card (computer) and the parcel page (phone).
import type { Order } from '@pilotix/shared';
import { communesOf } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import type { Out } from '../../lib/backend';
import { da, when, wilaya, wilayaName } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { CopyCode } from '../../ui/CopyCode';
import { Field, Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { WilayaOptions } from '../admin/bits';
import './courier.css';

type Info = Out<'parcel.info'>;
type Change = Info['changes'][number];
type Kind = Change['kind'];
type Values = Change['new'];

const TONE: Record<Change['status'], string> = { pending: 't-warn', approved: 't-ok', refused: 't-bad', cancelled: 't-off', failed: 't-bad' };

/** "Prix : 5 150 DA → 4 800 DA", "Livraison : Domicile → Stop desk ZR Kouba"… */
function changeText(t: (k: string, o?: any) => string, c: { kind: Kind; old: Values; new: Values }) {
  const o = c.old;
  const n = c.new;
  const place = (v: Values) =>
    v.stopdesk ? `${t('suivi.courier.desk')} ${v.stopdeskName ?? ''}`.trim() : [t('suivi.courier.home'), [wilayaName(v.wilayaId ?? null), v.commune, v.address].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const amount = n.amount != null && n.amount !== o.amount ? ` · ${t('suivi.courier.k.amount')} ${da(o.amount ?? null)} → ${da(n.amount)}` : '';
  switch (c.kind) {
    case 'amount':
      return `${t('suivi.courier.k.amount')} : ${da(o.amount ?? null)} → ${da(n.amount ?? null)}`;
    case 'phone':
      return `${t('suivi.courier.k.phone')} : ${o.phone ?? '—'} → ${n.phone ?? '—'}${n.phone2 ? ` (${n.phone2})` : ''}`;
    case 'delivery':
      return `${t('suivi.courier.k.delivery')} : ${place(o)} → ${place(n)}${amount}`;
    default:
      return `${t('suivi.courier.k.address')} : ${[wilayaName(o.wilayaId ?? null), o.commune, o.address].filter(Boolean).join(', ')} → ${[wilayaName(n.wilayaId ?? null), n.commune, n.address].filter(Boolean).join(', ')}${amount}`;
  }
}

/** The request form: what to change, the new values, a note for the history. */
function ChangeDialog({ o, d, onClose }: { o: Order; d: Info; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const info = d.info!;
  const name = d.companyName ?? '';
  const can = (k: Kind) => (k === 'phone' ? info.canChangePhone : info.canModify && !info.pendingChange);
  const kinds: Kind[] = ['amount', 'delivery', 'address', 'phone'];
  const [kind, setKind] = useState<Kind>(kinds.find(can) ?? 'phone');
  const [amount, setAmount] = useState(String(o.total));
  const [desk, setDesk] = useState(!o.isStopdesk);
  const [w, setW] = useState(o.wilayaId);
  const [commune, setCommune] = useState(o.commune ?? '');
  const [address, setAddress] = useState(o.address ?? '');
  const [sd, setSd] = useState<number | null>(null);
  const [phone, setPhone] = useState(o.phone);
  const [phone2, setPhone2] = useState(o.phone2 ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const desks = useRpc('delivery.stopdesks', { companyId: d.companyId ?? 0, wilayaId: w }, { enabled: !!d.companyId && kind === 'delivery' && desk });
  const communes = communesOf(w);
  const amt = Number(amount);
  const amountOk = amount.trim() !== '' && Number.isFinite(amt) && amt >= 0;

  const send = async () => {
    setBusy(true);
    try {
      const base = { orderId: o.id, kind, note: note.trim() || null };
      const extra = amountOk && amt !== o.total ? { amount: Math.round(amt) } : {};
      const input =
        kind === 'amount'
          ? { ...base, amount: Math.round(amt) }
          : kind === 'phone'
            ? { ...base, phone, phone2: phone2.trim() || null }
            : kind === 'delivery'
              ? desk
                ? { ...base, ...extra, stopdesk: true, stopdeskId: sd }
                : { ...base, ...extra, stopdesk: false, wilayaId: w, commune, address }
              : { ...base, ...extra, wilayaId: w, commune, address };
      const r = await rpc('parcel.change', input);
      toast(r.status === 'approved' ? t('suivi.courier.appliedNow', { name }) : t('suivi.courier.sent', { name }), 'ok');
      qc.invalidateQueries();
      onClose();
    } catch (e: any) {
      toast(e.message, 'bad', 8000);
    } finally {
      setBusy(false);
    }
  };
  const ready =
    kind === 'amount'
      ? amountOk && amt !== o.total
      : kind === 'phone'
        ? phone.replace(/\D/g, '').length >= 9
        : kind === 'delivery' && desk
          ? !!sd
          : !!commune.trim();

  return (
    <Modal
      title={t('suivi.courier.askTitle', { name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={busy || !ready || !can(kind)} onClick={send}>
            <Icon name="send" /> {t('suivi.courier.sendTo', { name })}
          </button>
        </>
      }
    >
      <div className="pxz-kinds" role="radiogroup" aria-label={t('suivi.courier.what')}>
        {kinds.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={`pxz-kind${kind === k ? ' on' : ''}`} disabled={!can(k)} onClick={() => setKind(k)}>
            <Icon name={k === 'amount' ? 'coins' : k === 'delivery' ? 'home' : k === 'address' ? 'navigation' : 'phone'} />
            {t(`suivi.courier.k.${k}`)}
          </button>
        ))}
      </div>
      {info.pendingChange && kind !== 'phone' && <p className="pxz-warn">{t('suivi.courier.pendingOne', { name })}</p>}
      {kind === 'amount' && (
        <Field label={t('suivi.courier.newAmount')} hint={t('suivi.courier.nowAmount', { v: da(o.total) })}>
          <input type="number" inputMode="numeric" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
      )}
      {kind === 'delivery' && (
        <>
          <p className="muted small">{t('suivi.courier.nowPlace', { v: o.isStopdesk ? t('suivi.courier.desk') : t('suivi.courier.home') })}</p>
          <div className="pxz-seg">
            <button type="button" className={desk ? 'on' : ''} onClick={() => setDesk(true)}>
              {t('suivi.courier.toDesk')}
            </button>
            <button type="button" className={!desk ? 'on' : ''} onClick={() => setDesk(false)}>
              {t('suivi.courier.toHome')}
            </button>
          </div>
        </>
      )}
      {(kind === 'address' || kind === 'delivery') && (
        <div className="grid2">
          <Field label={t('suivi.courier.wilaya')}>
            <select
              value={w}
              onChange={(e) => {
                setW(Number(e.target.value));
                setCommune('');
                setSd(null);
              }}
            >
              <WilayaOptions />
            </select>
          </Field>
          {kind === 'delivery' && desk ? (
            <Field label={t('suivi.courier.deskPick')}>
              <select value={sd ?? ''} onChange={(e) => setSd(e.target.value ? Number(e.target.value) : null)}>
                <option value="">{desks.data && !desks.data.length ? t('suivi.courier.noDesk', { w: wilaya(w) }) : '—'}</option>
                {(desks.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                    {x.commune ? ` · ${x.commune}` : ''}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <>
              <Field label={t('suivi.courier.commune')}>
                <input list="pxz-communes" value={commune} maxLength={120} onChange={(e) => setCommune(e.target.value)} />
                <datalist id="pxz-communes">
                  {communes.map((c) => (
                    <option key={c[1]} value={c[1]} />
                  ))}
                </datalist>
              </Field>
              <Field label={t('suivi.courier.address')} wide>
                <input value={address} maxLength={300} onChange={(e) => setAddress(e.target.value)} />
              </Field>
            </>
          )}
          <Field label={t('suivi.courier.amountWith')} hint={t('suivi.courier.amountWithHint')}>
            <input type="number" inputMode="numeric" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
        </div>
      )}
      {kind === 'phone' && (
        <>
          <div className="grid2">
            <Field label={t('suivi.courier.phone')}>
              <input type="tel" inputMode="tel" value={phone} maxLength={30} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label={t('suivi.courier.phone2')}>
              <input type="tel" inputMode="tel" value={phone2} maxLength={30} onChange={(e) => setPhone2(e.target.value)} />
            </Field>
          </div>
          <p className="muted small">
            {t('suivi.courier.phoneNow', { name })}
            {info.phoneChangeLimit != null ? ` · ${t('suivi.courier.quota', { n: info.phoneChanges ?? 0, max: info.phoneChangeLimit })}` : ''}
            {info.phoneChangePrice ? ` · ${t('suivi.courier.cost', { v: da(info.phoneChangePrice) })}` : ''}
          </p>
        </>
      )}
      {kind !== 'phone' && info.modificationLimit != null && <p className="muted small">{t('suivi.courier.quotaMod', { n: info.modifications ?? 0, max: info.modificationLimit })}</p>}
      <Field label={t('suivi.courier.note')}>
        <input value={note} maxLength={500} placeholder={t('suivi.courier.notePh')} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

/** Everything ZR says about this parcel, and the requests made to it. Nothing for other couriers. */
export function CourierPanel({ o, phone }: { o: Order; phone?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useRpc('parcel.info', { orderId: o.id }, { enabled: !!o.tracking && !!o.companyId, staleTime: 30_000 });
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const pending = d?.changes.some((c) => c.status === 'pending') ?? false;
  // requests waiting for ZR: read its answers when the parcel opens
  useEffect(() => {
    if (!pending) return;
    rpc('parcel.changeSync', { orderId: o.id })
      .then((r) => {
        if (r.changed) qc.invalidateQueries();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, o.id]);
  if (!d?.supported) return null;
  const info = d.info;
  const name = d.companyName ?? '';
  const refresh = async () => {
    setBusy(true);
    try {
      await rpc('parcel.changeSync', { orderId: o.id });
      await qc.invalidateQueries();
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const withdraw = async (c: Change) => {
    setBusy(true);
    try {
      await rpc('parcel.changeCancel', { id: c.id });
      toast(t('suivi.courier.withdrawn'), 'ok');
      qc.invalidateQueries();
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const risk = info?.risk;
  const level = risk ? (risk.level && /high|élev|eleve|fort/i.test(risk.level) ? 'high' : risk.level && /med|moy/i.test(risk.level) ? 'medium' : risk.score >= 40 ? 'high' : risk.score >= 15 ? 'medium' : 'low') : null;
  const Title = phone ? 'h4' : 'h3';

  return (
    <section className={`${phone ? 'pxs-sec' : 'card'} pxz`}>
      <Title className="pxz-h">
        <Icon name="truck" /> <span>{t('suivi.courier.title', { name })}</span>
        <button type="button" className="icon-btn pxz-sync" disabled={busy || q.isFetching} onClick={refresh} aria-label={t('suivi.courier.refresh')} title={t('suivi.courier.refresh')}>
          <Icon name="refresh" />
        </button>
      </Title>
      {d.error && <p className="badbox">{d.error}</p>}
      {info && (
        <>
          <div className="pxz-state">
            <i style={{ background: info.color ?? 'var(--muted)' }} aria-hidden="true" />
            <b>{info.state ?? '—'}</b>
            {info.situation && <span> · {info.situation}</span>}
          </div>
          {info.livreur && (
            <div className="pxz-row">
              <Icon name="bike" />
              <span>
                {t('suivi.courier.livreur', { name })} <b>{info.livreur.name}</b>
                {info.livreur.hub ? <small> · {info.livreur.hub}</small> : null}
              </span>
              {info.livreur.phone && (
                <a className="btn small" href={`tel:${info.livreur.phone.replace(/\s/g, '')}`}>
                  <Icon name="phone" /> <bdi dir="ltr">{info.livreur.phone}</bdi>
                </a>
              )}
            </div>
          )}
          {risk && level && (
            <div className="pxz-row">
              <span className={`badge ${level === 'high' ? 't-bad' : level === 'medium' ? 't-warn' : 't-ok'}`}>{t(`suivi.courier.risk_${level}`)}</span>
              <span className="muted small">{t('suivi.courier.riskText', { name, returns: risk.returns, orders: risk.orders })}</span>
            </div>
          )}
        </>
      )}
      {d.returnTracking && (
        <div className="pxz-row">
          <Icon name="swap" />
          <span>{t('suivi.courier.returnParcel')}</span>
          <CopyCode code={d.returnTracking} small />
        </div>
      )}
      {d.changes.length > 0 && (
        <ul className="pxz-ch">
          {d.changes.slice(0, 5).map((c) => (
            <li key={c.id}>
              <span className={`badge ${TONE[c.status]}`}>{t(`suivi.courier.st.${c.status}`, { name })}</span>
              <span className="pxz-ct">
                {changeText(t, c)}
                <small>
                  {when(c.createdAt)}
                  {c.createdBy ? ` · ${c.createdBy}` : ''}
                  {c.note ? ` · « ${c.note} »` : ''}
                </small>
                {c.answer && <q>{c.answer}</q>}
                {c.error && <q className="bad">{c.error}</q>}
              </span>
              {c.status === 'pending' && (
                <button type="button" className="btn small ghost" disabled={busy} onClick={() => withdraw(c)}>
                  {t('suivi.courier.withdraw')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {info && (
        <div className="pxz-acts">
          <button type="button" className="btn small primary" disabled={!(info.canModify || info.canChangePhone)} onClick={() => setAsk(true)}>
            <Icon name="pencil" /> {t('suivi.courier.ask')}
          </button>
          {!(info.canModify || info.canChangePhone) && <small className="muted">{t('suivi.courier.noChange', { name })}</small>}
        </div>
      )}
      {info && info.history.length > 0 && (
        <details className="pxz-more">
          <summary>{t('suivi.courier.journey', { name, n: info.history.length })}</summary>
          <ol className="pxz-tl">
            {info.history.map((h, k) => (
              <li key={k}>
                <i style={{ background: h.color ?? 'var(--muted)' }} aria-hidden="true" />
                <b>{h.status}</b>
                <small>
                  {when(h.at)}
                  {h.hub ? ` · ${h.hub}` : ''}
                  {h.by ? ` · ${h.by}` : ''}
                </small>
                {h.situations.map((s, j) => (
                  <span key={j} className="pxz-sit">
                    {s.name}
                    {s.at ? ` · ${when(s.at)}` : ''}
                  </span>
                ))}
                {h.comment && <q>{h.comment}</q>}
              </li>
            ))}
          </ol>
        </details>
      )}
      {info && info.sms.length > 0 && (
        <details className="pxz-more">
          <summary>{t('suivi.courier.sms', { name, n: info.sms.length })}</summary>
          <ul className="pxz-sms">
            {info.sms.map((s, k) => (
              <li key={k}>
                <small>
                  {when(s.at)} · <bdi dir="ltr">{s.phone}</bdi> · {t(`suivi.courier.smsSt.${s.status ?? 'sent'}`)}
                </small>
                <span>{s.message}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {ask && d.info && <ChangeDialog o={o} d={d} onClose={() => setAsk(false)} />}
    </section>
  );
}
