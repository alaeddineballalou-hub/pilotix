// A parcel at its courier (ZR Express), from Pilotix: where it is (ZR's journey, hubs, SMS), its livreur, the customer's
// return risk, an exchange's two parcels (the new product out, the old one back), and the modification requests —
// price, home ↔ stop desk, address, phone — sent to ZR and applied to the order once ZR accepts. Computer: a card in
// the order and a dialog; phone: a block of the parcel page and a sheet with big tiles.
import type { Order } from '@pilotix/shared';
import { communesOf } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import type { Out } from '../../lib/backend';
import { da, when, wilaya, wilayaName } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { useIsPhone } from '../../lib/useMedia';
import { CopyCode } from '../../ui/CopyCode';
import { Field, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { Options, Seg, Sheet, Tiles } from '../../ui/Sheet';
import { toast } from '../../ui/toast';
import { WilayaOptions } from '../admin/bits';
import './phone.css';
import './courier.css';

type Info = Out<'parcel.info'>;
type Change = Info['changes'][number];
export type ChangeKind = Change['kind'];
type Values = Change['new'];
type T = (k: string, o?: any) => string;

const KINDS: ChangeKind[] = ['amount', 'delivery', 'address', 'phone'];
const KIND_ICON: Record<ChangeKind, string> = { amount: 'coins', delivery: 'home', address: 'navigation', phone: 'phone' };
const TONE: Record<Change['status'], string> = { pending: 't-warn', approved: 't-ok', refused: 't-bad', cancelled: 't-off', failed: 't-bad' };

/** ZR's view of the parcel; one query shared by the block, the sheets and the order card. */
export const useParcelInfo = (o: Order, on = true) => useRpc('parcel.info', { orderId: o.id }, { enabled: on && !!o.tracking && !!o.companyId, staleTime: 30_000 });

const placeOf = (t: T, v: Values) =>
  v.stopdesk ? `${t('suivi.courier.desk')} ${v.stopdeskName ?? ''}`.trim() : [t('suivi.courier.home'), [wilayaName(v.wilayaId ?? null), v.commune, v.address].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
const addressOf = (v: Values) => [wilayaName(v.wilayaId ?? null), v.commune, v.address].filter(Boolean).join(', ');

/** What a request changes: [before, after] ("5 150 DA", "4 800 DA"). */
function fromTo(t: T, c: { kind: ChangeKind; old: Values; new: Values }): [string, string] {
  const o = c.old;
  const n = c.new;
  const amount = n.amount != null && n.amount !== o.amount ? ` · ${da(n.amount)}` : '';
  switch (c.kind) {
    case 'amount':
      return [da(o.amount ?? null), da(n.amount ?? null)];
    case 'phone':
      return [o.phone ?? '—', `${n.phone ?? '—'}${n.phone2 ? ` (${n.phone2})` : ''}`];
    case 'delivery':
      return [placeOf(t, o), placeOf(t, n) + amount];
    default:
      return [addressOf(o), addressOf(n) + amount];
  }
}
/** "Prix : 5 150 DA → 4 800 DA", "Livraison : Domicile → Stop desk ZR Kouba"… */
const changeText = (t: T, c: { kind: ChangeKind; old: Values; new: Values }) => {
  const [a, b] = fromTo(t, c);
  return `${t(`suivi.courier.k.${c.kind}`)} : ${a} → ${b}`;
};

const riskLevel = (risk: NonNullable<Info['info']>['risk']) =>
  !risk ? null : risk.level && /high|élev|eleve|fort/i.test(risk.level) ? 'high' : risk.level && /med|moy/i.test(risk.level) ? 'medium' : risk.score >= 40 ? 'high' : risk.score >= 15 ? 'medium' : 'low';

// ---------------------------------------------------------------- the request, shared by the dialog and the sheet
function useChangeForm(o: Order, d: Info, initial: ChangeKind | null | undefined, onDone: () => void, priceShown: boolean) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const info = d.info!;
  const name = d.companyName ?? '';
  /** why this can not be asked now (null: it can) */
  const off = (k: ChangeKind): string | null =>
    k === 'phone'
      ? info.canChangePhone
        ? null
        : t('suivi.courier.ph.offNo', { name })
      : !info.canModify
        ? t('suivi.courier.ph.offNo', { name })
        : info.pendingChange
          ? t('suivi.courier.ph.offPending')
          : k === 'address' && o.isStopdesk
            ? t('suivi.courier.ph.offDesk')
            : null;
  const [kind, setKind] = useState<ChangeKind>(() => (initial && !off(initial) ? initial : KINDS.find((k) => !off(k)) ?? 'phone'));
  const [amount, setAmount] = useState(String(o.total));
  const [priceToo, setPriceToo] = useState(priceShown);
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
  const priceChanges = (kind === 'amount' || priceToo) && amountOk && amt !== o.total;

  const send = async () => {
    setBusy(true);
    try {
      const base = { orderId: o.id, kind, note: note.trim() || null };
      const extra = priceChanges ? { amount: Math.round(amt) } : {};
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
      onDone();
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
        ? phone.replace(/\D/g, '').length >= 9 && phone.trim() !== o.phone
        : kind === 'delivery' && desk
          ? !!sd
          : !!commune.trim() && (!priceToo || amountOk);
  const deskName = (desks.data ?? []).find((x) => x.id === sd)?.name ?? '';
  return { info, name, off, kind, setKind, amount, setAmount, amt, amountOk, priceToo, setPriceToo, priceChanges, desk, setDesk, w, setW, commune, setCommune, address, setAddress, sd, setSd, deskName, phone, setPhone, phone2, setPhone2, note, setNote, busy, desks, communes, send, ready };
}

/** The request form on a computer: what to change, the new values, a note for the history. */
function ChangeDialog({ o, d, initial, onClose }: { o: Order; d: Info; initial?: ChangeKind | null; onClose: () => void }) {
  const { t } = useTranslation();
  const f = useChangeForm(o, d, initial, onClose, true);
  const { info, name, kind } = f;
  return (
    <Modal
      title={t('suivi.courier.askTitle', { name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={f.busy || !f.ready || !!f.off(kind)} onClick={f.send}>
            <Icon name="send" /> {t('suivi.courier.sendTo', { name })}
          </button>
        </>
      }
    >
      <div className="pxz-kinds" role="radiogroup" aria-label={t('suivi.courier.what')}>
        {KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={`pxz-kind${kind === k ? ' on' : ''}`} disabled={!!f.off(k)} title={f.off(k) ?? undefined} onClick={() => f.setKind(k)}>
            <Icon name={KIND_ICON[k]} />
            {t(`suivi.courier.k.${k}`)}
          </button>
        ))}
      </div>
      {info.pendingChange && kind !== 'phone' && <p className="pxz-warn">{t('suivi.courier.pendingOne', { name })}</p>}
      {kind === 'amount' && (
        <Field label={t('suivi.courier.newAmount')} hint={t('suivi.courier.nowAmount', { v: da(o.total) })}>
          <input type="number" inputMode="numeric" min={0} value={f.amount} onChange={(e) => f.setAmount(e.target.value)} />
        </Field>
      )}
      {kind === 'delivery' && (
        <>
          <p className="muted small">{t('suivi.courier.nowPlace', { v: o.isStopdesk ? t('suivi.courier.desk') : t('suivi.courier.home') })}</p>
          <div className="pxz-seg">
            <button type="button" className={f.desk ? 'on' : ''} onClick={() => f.setDesk(true)}>
              {t('suivi.courier.toDesk')}
            </button>
            <button type="button" className={!f.desk ? 'on' : ''} onClick={() => f.setDesk(false)}>
              {t('suivi.courier.toHome')}
            </button>
          </div>
        </>
      )}
      {(kind === 'address' || kind === 'delivery') && (
        <div className="grid2">
          <Field label={t('suivi.courier.wilaya')}>
            <select
              value={f.w}
              onChange={(e) => {
                f.setW(Number(e.target.value));
                f.setCommune('');
                f.setSd(null);
              }}
            >
              <WilayaOptions />
            </select>
          </Field>
          {kind === 'delivery' && f.desk ? (
            <Field label={t('suivi.courier.deskPick')}>
              <select value={f.sd ?? ''} onChange={(e) => f.setSd(e.target.value ? Number(e.target.value) : null)}>
                <option value="">{f.desks.data && !f.desks.data.length ? t('suivi.courier.noDesk', { w: wilaya(f.w) }) : '—'}</option>
                {(f.desks.data ?? []).map((x) => (
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
                <input list="pxz-communes" value={f.commune} maxLength={120} onChange={(e) => f.setCommune(e.target.value)} />
                <datalist id="pxz-communes">
                  {f.communes.map((c) => (
                    <option key={c[1]} value={c[1]} />
                  ))}
                </datalist>
              </Field>
              <Field label={t('suivi.courier.address')} wide>
                <input value={f.address} maxLength={300} onChange={(e) => f.setAddress(e.target.value)} />
              </Field>
            </>
          )}
          <Field label={t('suivi.courier.amountWith')} hint={t('suivi.courier.amountWithHint')}>
            <input type="number" inputMode="numeric" min={0} value={f.amount} onChange={(e) => f.setAmount(e.target.value)} />
          </Field>
        </div>
      )}
      {kind === 'phone' && (
        <>
          <div className="grid2">
            <Field label={t('suivi.courier.phone')}>
              <input type="tel" inputMode="tel" value={f.phone} maxLength={30} onChange={(e) => f.setPhone(e.target.value)} />
            </Field>
            <Field label={t('suivi.courier.phone2')}>
              <input type="tel" inputMode="tel" value={f.phone2} maxLength={30} onChange={(e) => f.setPhone2(e.target.value)} />
            </Field>
          </div>
          <p className="muted small">
            {t('suivi.courier.phoneNow', { name })}
            {info.phoneChangeLimit != null ? ` · ${t('suivi.courier.quota', { n: info.phoneChanges ?? 0, max: info.phoneChangeLimit })}` : ''}
            {info.phoneChangePrice ? ` · ${t('suivi.courier.cost', { v: da(info.phoneChangePrice) })}` : ''}
          </p>
        </>
      )}
      {kind !== 'phone' && !info.direct && info.modificationLimit != null && <p className="muted small">{t('suivi.courier.quotaMod', { n: info.modifications ?? 0, max: info.modificationLimit })}</p>}
      <Field label={t('suivi.courier.note')}>
        <input value={f.note} maxLength={500} placeholder={t('suivi.courier.notePh')} onChange={(e) => f.setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

/** "▮▮▯ 1/2 modifications utilisées" */
function Quota({ n, max, label }: { n: number; max: number; label: string }) {
  return (
    <span>
      <i aria-hidden="true">
        {Array.from({ length: Math.min(Math.max(max, 0), 6) }, (_, k) => (
          <b key={k} className={k < n ? 'on' : ''} />
        ))}
      </i>
      {label}
    </span>
  );
}

function BeforeAfter({ before, after, delta }: { before: string; after: string; delta?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="pxk-ba">
      <span className="now">
        <small>{t('suivi.courier.ph.before')}</small>
        <b>{before}</b>
      </span>
      <Icon name="arrow" />
      <span className="new">
        <small>{t('suivi.courier.ph.after')}</small>
        <b>{after}</b>
        {delta}
      </span>
    </div>
  );
}

const WHY = ['a', 'b', 'c'] as const;

/** The request on a phone: four big tiles (each with what it is today), then only what that change needs; the
 *  before → after, a reason in one tap, and « Envoyer à ZR » at the thumb. */
function ChangeSheetForm({ o, d, initial, onClose }: { o: Order; d: Info; initial?: ChangeKind | null; onClose: () => void }) {
  const { t } = useTranslation();
  const f = useChangeForm(o, d, initial, onClose, false);
  const { info, name, kind } = f;
  const hub = info.delivery.hub;
  const nowOf = (k: ChangeKind) =>
    k === 'amount' ? da(o.total) : k === 'phone' ? o.phone : k === 'delivery' ? (o.isStopdesk ? `${t('suivi.courier.desk')}${hub ? ` · ${hub}` : ''}` : t('suivi.courier.home')) : [wilayaName(o.wilayaId), o.commune].filter(Boolean).join(', ');
  const diff = f.amountOk ? Math.round(f.amt) - o.total : 0;
  const delta = f.priceChanges ? diff < 0 ? <em>−{da(-diff)}</em> : <em className="up">+{da(diff)}</em> : null;
  const priceAfter = f.priceChanges && kind !== 'amount' ? ` · ${da(Math.round(f.amt))}` : '';
  const ba: [string, string] | null = !f.ready
    ? null
    : kind === 'amount'
      ? [da(o.total), da(Math.round(f.amt))]
      : kind === 'phone'
        ? [o.phone, `${f.phone.trim()}${f.phone2.trim() ? ` (${f.phone2.trim()})` : ''}`]
        : kind === 'delivery'
          ? [nowOf('delivery'), (f.desk ? `${t('suivi.courier.desk')} · ${f.deskName}` : `${t('suivi.courier.home')} · ${[wilayaName(f.w), f.commune.trim()].filter(Boolean).join(', ')}`) + priceAfter]
          : [[wilayaName(o.wilayaId), o.commune, o.address].filter(Boolean).join(', '), [wilayaName(f.w), f.commune.trim(), f.address.trim()].filter(Boolean).join(', ') + priceAfter];
  const wilayaPick = (
    <select
      className="pxk-in"
      value={f.w}
      aria-label={t('suivi.courier.wilaya')}
      onChange={(e) => {
        f.setW(Number(e.target.value));
        f.setCommune('');
        f.setSd(null);
      }}
    >
      <WilayaOptions />
    </select>
  );
  const priceToo = (
    <div className="pxk-q">
      <button type="button" className={`pxk-chip${f.priceToo ? ' on' : ''}`} aria-pressed={f.priceToo} onClick={() => (f.setPriceToo(!f.priceToo), f.setAmount(String(o.total)))}>
        <Icon name="coins" /> {t('suivi.courier.ph.priceToo')}
      </button>
      {f.priceToo && (
        <label className="pxk-money">
          <input type="number" inputMode="numeric" min={0} value={f.amount} aria-label={t('suivi.courier.amountWith')} onChange={(e) => f.setAmount(e.target.value)} />
          <span>{t('suivi.courier.ph.da')}</span>
        </label>
      )}
    </div>
  );
  return (
    <Sheet
      title={t('suivi.courier.ph.sheetTitle', { name })}
      sub={
        <>
          <span className="ltr">{o.ref}</span> · <span className="ltr">{o.tracking}</span> · {o.customerName}
        </>
      }
      onClose={onClose}
      foot={
        <>
          <button type="button" className="pxk-go" disabled={f.busy || !f.ready || !!f.off(kind)} onClick={f.send}>
            <Icon name="send" className="flip" /> {f.busy ? t('suivi.courier.ph.sending', { name }) : t('suivi.courier.sendTo', { name })}
          </button>
          <p className="pxk-fnote">{info.direct ? t('suivi.courier.ph.footDirect', { name }) : kind === 'phone' ? t('suivi.courier.ph.footPhone', { name }) : t('suivi.courier.ph.footAsk', { name })}</p>
        </>
      }
    >
      <fieldset className="pxk-q">
        <legend>{t('suivi.courier.what')}</legend>
        <Tiles value={kind} onChange={f.setKind} label={t('suivi.courier.what')} items={KINDS.map((k) => ({ k, icon: KIND_ICON[k], label: t(`suivi.courier.k.${k}`), now: nowOf(k), off: f.off(k) }))} />
      </fieldset>
      {info.pendingChange && kind !== 'phone' && <p className="pxk-warn">{t('suivi.courier.pendingOne', { name })}</p>}

      {kind === 'amount' && (
        <fieldset className="pxk-q">
          <legend>{t('suivi.courier.newAmount')}</legend>
          <label className="pxk-money">
            <input type="number" inputMode="numeric" min={0} value={f.amount} aria-label={t('suivi.courier.newAmount')} onChange={(e) => f.setAmount(e.target.value)} />
            <span>{t('suivi.courier.ph.da')}</span>
          </label>
          <div className="pxk-chips">
            {[200, 500, 1000].map((x) => (
              <button key={x} type="button" className={`pxk-chip${f.amt === o.total - x ? ' on' : ''}`} disabled={o.total - x < 0} onClick={() => f.setAmount(String(o.total - x))}>
                −{da(x)}
              </button>
            ))}
            {o.deliveryFee > 0 && (
              <button type="button" className={`pxk-chip${f.amt === o.total - o.deliveryFee ? ' on' : ''}`} onClick={() => f.setAmount(String(o.total - o.deliveryFee))}>
                {t('suivi.courier.ph.freeDelivery')}
              </button>
            )}
          </div>
        </fieldset>
      )}

      {kind === 'delivery' && (
        <>
          <Seg
            value={f.desk ? 'desk' : 'home'}
            onChange={(k) => (f.setDesk(k === 'desk'), f.setSd(null))}
            label={t('suivi.courier.k.delivery')}
            items={[
              { k: 'desk', label: t('suivi.courier.ph.toDesk'), icon: 'building' },
              { k: 'home', label: t('suivi.courier.ph.toHome'), icon: 'home' },
            ]}
          />
          <label className="pxk-q">
            <b>{t('suivi.courier.wilaya')}</b>
            {wilayaPick}
          </label>
          {f.desk ? (
            <fieldset className="pxk-q">
              <legend>{t('suivi.courier.ph.deskPick', { name })}</legend>
              {f.desks.isLoading ? (
                <Loading />
              ) : !(f.desks.data ?? []).length ? (
                <p className="pxk-warn">{t('suivi.courier.noDesk', { w: wilaya(f.w) })}</p>
              ) : (
                <Options
                  value={f.sd ? String(f.sd) : null}
                  onChange={(k) => f.setSd(Number(k))}
                  label={t('suivi.courier.ph.deskPick', { name })}
                  items={(f.desks.data ?? []).map((x) => ({ k: String(x.id), icon: 'building', label: x.name, hint: [x.commune, x.address].filter(Boolean).join(' · ') }))}
                />
              )}
            </fieldset>
          ) : (
            <>
              <label className="pxk-q">
                <b>{t('suivi.courier.commune')}</b>
                <input className="pxk-in" list="pxz-communes-ph" value={f.commune} maxLength={120} onChange={(e) => f.setCommune(e.target.value)} />
              </label>
              <label className="pxk-q">
                <b>{t('suivi.courier.address')}</b>
                <textarea className="pxk-in" rows={2} value={f.address} maxLength={300} onChange={(e) => f.setAddress(e.target.value)} />
              </label>
            </>
          )}
          {priceToo}
        </>
      )}

      {kind === 'address' && (
        <>
          <div className="pxk-g2">
            <label>
              {t('suivi.courier.wilaya')}
              {wilayaPick}
            </label>
            <label>
              {t('suivi.courier.commune')}
              <input className="pxk-in" list="pxz-communes-ph" value={f.commune} maxLength={120} onChange={(e) => f.setCommune(e.target.value)} />
            </label>
          </div>
          <label className="pxk-q">
            <b>{t('suivi.courier.address')}</b>
            <textarea className="pxk-in" rows={2} value={f.address} maxLength={300} placeholder={t('suivi.courier.ph.addressPh')} onChange={(e) => f.setAddress(e.target.value)} />
          </label>
          {priceToo}
        </>
      )}
      <datalist id="pxz-communes-ph">
        {f.communes.map((c) => (
          <option key={c[1]} value={c[1]} />
        ))}
      </datalist>

      {kind === 'phone' && (
        <>
          <label className="pxk-q">
            <b>{t('suivi.courier.phone')}</b>
            <input className="pxk-in" type="tel" inputMode="tel" autoComplete="off" value={f.phone} maxLength={30} onChange={(e) => f.setPhone(e.target.value)} />
          </label>
          <label className="pxk-q">
            <b>{t('suivi.courier.phone2')}</b>
            <input className="pxk-in" type="tel" inputMode="tel" autoComplete="off" value={f.phone2} maxLength={30} onChange={(e) => f.setPhone2(e.target.value)} />
          </label>
          <p className="pxk-info ok">
            <Icon name="check" /> {t('suivi.courier.phoneNow', { name })}
          </p>
        </>
      )}

      {ba && <BeforeAfter before={ba[0]} after={ba[1]} delta={kind === 'amount' ? delta : null} />}

      <fieldset className="pxk-q">
        <legend>{t('suivi.courier.ph.why')}</legend>
        <div className="pxk-chips">
          {WHY.map((k) => {
            const v = t(`suivi.courier.why.${kind}.${k}`);
            return (
              <button key={k} type="button" className={`pxk-chip${f.note === v ? ' on' : ''}`} aria-pressed={f.note === v} onClick={() => f.setNote(f.note === v ? '' : v)}>
                {v}
              </button>
            );
          })}
        </div>
        <input className="pxk-in" value={f.note} maxLength={500} placeholder={t('suivi.courier.notePh')} aria-label={t('suivi.courier.note')} onChange={(e) => f.setNote(e.target.value)} />
      </fieldset>

      <div className="pxk-quota">
        {kind === 'phone' ? (
          <>
            {info.phoneChangeLimit != null && <Quota n={info.phoneChanges ?? 0} max={info.phoneChangeLimit} label={t('suivi.courier.quota', { n: info.phoneChanges ?? 0, max: info.phoneChangeLimit })} />}
            {!!info.phoneChangePrice && <span>{t('suivi.courier.cost', { v: da(info.phoneChangePrice) })}</span>}
          </>
        ) : (
          !info.direct && info.modificationLimit != null && <Quota n={info.modifications ?? 0} max={info.modificationLimit} label={t('suivi.courier.quotaMod', { n: info.modifications ?? 0, max: info.modificationLimit })} />
        )}
      </div>
    </Sheet>
  );
}

/** The request sheet, from anywhere on a phone (the parcel page, its tip, the order). */
export function ChangeSheet({ o, kind, onClose }: { o: Order; kind?: ChangeKind | null; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useParcelInfo(o);
  const d = q.data;
  if (d?.info) return <ChangeSheetForm o={o} d={d} initial={kind} onClose={onClose} />;
  const name = d?.companyName ?? o.companyName ?? '';
  return (
    <Sheet title={t('suivi.courier.ph.sheetTitle', { name })} sub={<span className="ltr">{o.ref}</span>} onClose={onClose}>
      {q.error || d?.error ? <p className="pxk-bad">{q.error?.message ?? d?.error}</p> : d && !d.supported ? <p className="pxk-info">{t('suivi.courier.noChange', { name })}</p> : <Loading />}
    </Sheet>
  );
}

// ---------------------------------------------------------------- an exchange: two parcels at ZR
/** The new product going to the customer, the old one coming back (ZR's return parcel, leaving at the delivery). */
export function ExchangeLegs({ o, d }: { o: Order; d: Info }) {
  const { t } = useTranslation();
  const name = d.companyName ?? '';
  const r = d.returnInfo;
  return (
    <div className="pxz-ex">
      <b className="pxz-exh">
        <Icon name="swap" /> {t('suivi.courier.ph.exchange', { name })}
      </b>
      <div className="pxz-leg">
        <span className="pxz-lg out" aria-hidden="true">
          <Icon name="arrow" />
        </span>
        <span>
          <b>
            {t('suivi.courier.ph.legOut')} <CopyCode code={o.tracking ?? ''} small />
          </b>
          <small>{t('suivi.courier.ph.legOutText', { name: o.customerName })}</small>
          {d.info?.state && (
            <span className="pxz-lst">
              <i style={{ background: d.info.color ?? 'var(--muted)' }} aria-hidden="true" />
              {d.info.state}
            </span>
          )}
        </span>
      </div>
      <div className="pxz-leg">
        <span className="pxz-lg back" aria-hidden="true">
          <Icon name="undo" />
        </span>
        <span>
          <b>
            {t('suivi.courier.ph.legBack')} <CopyCode code={d.returnTracking ?? ''} small />
          </b>
          <small>{t('suivi.courier.ph.legBackText')}</small>
          {r?.state && (
            <span className="pxz-lst">
              <i style={{ background: r.color ?? 'var(--muted)' }} aria-hidden="true" />
              {r.state}
              {r.waiting ? ` · ${t('suivi.courier.ph.legWaits')}` : ''}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/** In an SAV ticket: the exchange at ZR and its two parcels. Nothing for the other couriers. */
export function ZrExchange({ o }: { o: Order }) {
  const q = useParcelInfo(o);
  const d = q.data;
  if (!d?.supported || !d.returnTracking) return null;
  return (
    <section className="pxs-sec pxz-exs">
      <ExchangeLegs o={o} d={d} />
    </section>
  );
}

// ---------------------------------------------------------------- the block / the card
/** Everything ZR says about this parcel, and the requests made to it. Nothing for other couriers.
 *  `onModify`: the parcel page opens the request sheet itself (its tip opens it too). */
export function CourierPanel({ o, phone, onModify }: { o: Order; phone?: boolean; onModify?: (k: ChangeKind | null) => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const isPhone = useIsPhone();
  const q = useParcelInfo(o);
  const [ask, setAsk] = useState<ChangeKind | null | false>(false);
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
  const open = onModify ?? ((k: ChangeKind | null) => setAsk(k));
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
  const sheet = ask !== false && d.info && (isPhone ? <ChangeSheet o={o} kind={ask} onClose={() => setAsk(false)} /> : <ChangeDialog o={o} d={d} initial={ask} onClose={() => setAsk(false)} />);
  if (phone)
    return (
      <>
        <CourierBlock o={o} d={d} busy={busy || q.isFetching} refresh={refresh} withdraw={withdraw} onModify={open} />
        {sheet}
      </>
    );

  const risk = info?.risk;
  const level = riskLevel(risk ?? null);
  return (
    <section className="card pxz">
      <h3 className="pxz-h">
        <Icon name="truck" /> <span>{t('suivi.courier.title', { name })}</span>
        <button type="button" className="icon-btn pxz-sync" disabled={busy || q.isFetching} onClick={refresh} aria-label={t('suivi.courier.refresh')} title={t('suivi.courier.refresh')}>
          <Icon name="refresh" />
        </button>
      </h3>
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
      {d.returnTracking && <ExchangeLegs o={o} d={d} />}
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
          <button type="button" className="btn small primary" disabled={!(info.canModify || info.canChangePhone)} onClick={() => open(null)}>
            <Icon name="pencil" /> {t('suivi.courier.ask')}
          </button>
          {!(info.canModify || info.canChangePhone) && <small className="muted">{t('suivi.courier.noChange', { name })}</small>}
        </div>
      )}
      {info && info.history.length > 0 && (
        <details className="pxz-more">
          <summary>{t('suivi.courier.journey', { name, n: info.history.length })}</summary>
          <Journey info={info} />
        </details>
      )}
      {info && info.sms.length > 0 && (
        <details className="pxz-more">
          <summary>{t('suivi.courier.sms', { name, n: info.sms.length })}</summary>
          <SmsList info={info} />
        </details>
      )}
      {sheet}
    </section>
  );
}

function Journey({ info }: { info: NonNullable<Info['info']> }) {
  return (
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
  );
}

function SmsList({ info }: { info: NonNullable<Info['info']> }) {
  const { t } = useTranslation();
  return (
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
  );
}

const initials = (s: string) =>
  s
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

/** The parcel page's block on a phone: ZR's state, its livreur to call, the return risk as a meter, an exchange's two
 *  parcels, the requests as cards, « Modifier chez ZR », and the journey / SMS one tap away. */
function CourierBlock({ o, d, busy, refresh, withdraw, onModify }: { o: Order; d: Info; busy: boolean; refresh: () => void; withdraw: (c: Change) => void; onModify: (k: ChangeKind | null) => void }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'hist' | 'sms' | null>(null);
  const info = d.info;
  const name = d.companyName ?? '';
  const risk = info?.risk ?? null;
  const level = riskLevel(risk);
  const last = info?.history[0];
  return (
    <section className="pxs-sec pxz pxz-ph">
      <h4 className="pxz-h">
        <Icon name="truck" /> <span>{t('suivi.courier.title', { name })}</span>
        <button type="button" className="pxz-sync" disabled={busy} onClick={refresh} aria-label={t('suivi.courier.refresh')} title={t('suivi.courier.refresh')}>
          <Icon name="refresh" />
        </button>
      </h4>
      {d.error && <p className="pxk-bad">{d.error}</p>}
      {info && (
        <div className="pxz-now">
          <i style={{ background: info.color ?? 'var(--muted)' }} aria-hidden="true" />
          <span>
            <b>{info.state ?? '—'}</b>
            {(info.situation || last) && <small>{[info.situation, last ? when(last.at) : null].filter(Boolean).join(' · ')}</small>}
          </span>
        </div>
      )}
      {info?.livreur && (
        <div className="pxz-lv">
          <span className="pxz-av" aria-hidden="true">
            {initials(info.livreur.name)}
          </span>
          <span>
            <b>{info.livreur.name}</b>
            <small>
              {t('suivi.courier.ph.livreurOf', { name })}
              {info.livreur.hub ? ` · ${info.livreur.hub}` : ''}
            </small>
          </span>
          {info.livreur.phone && (
            <a className="pxz-call" href={`tel:${info.livreur.phone.replace(/\s/g, '')}`} aria-label={t('suivi.courier.ph.callLivreur', { name: info.livreur.name })}>
              <Icon name="phone" />
            </a>
          )}
        </div>
      )}
      {risk && level && (
        <div className={`pxz-risk r-${level}`}>
          <span className="pxz-m" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <b>{t(`suivi.courier.risk_${level}`)}</b>
          <small>{t('suivi.courier.ph.riskShort', { returns: risk.returns, orders: risk.orders })}</small>
        </div>
      )}
      {d.returnTracking && <ExchangeLegs o={o} d={d} />}
      {d.changes.length > 0 && (
        <ul className="pxz-req" aria-label={t('suivi.courier.ph.requests', { name })}>
          {d.changes.slice(0, 4).map((c) => {
            const [a, b] = fromTo(t, c);
            return (
              <li key={c.id} className={`s-${c.status}`}>
                <span className="pxz-rqi" aria-hidden="true">
                  <Icon name={KIND_ICON[c.kind]} />
                </span>
                <span className="pxz-rqt">
                  <span className="pxz-rqh">
                    <b>{t(`suivi.courier.k.${c.kind}`)}</b>
                    <span className={`badge ${TONE[c.status]}`}>{t(`suivi.courier.st.${c.status}`, { name })}</span>
                  </span>
                  <span className="pxz-rqv">
                    <s>{a}</s> <Icon name="arrow" className="pxk-flip" /> <b>{b}</b>
                  </span>
                  <small>
                    {when(c.createdAt)}
                    {c.createdBy ? ` · ${c.createdBy}` : ''}
                    {c.note ? ` · « ${c.note} »` : ''}
                  </small>
                  {c.answer && <q dir="auto">{c.answer}</q>}
                  {c.error && <q dir="auto" className="bad">{c.error}</q>}
                </span>
                {c.status === 'pending' && (
                  <button type="button" className="pxs-chip" disabled={busy} onClick={() => withdraw(c)}>
                    {t('suivi.courier.withdraw')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {info &&
        (info.canModify || info.canChangePhone ? (
          <button type="button" className="pxz-mod" onClick={() => onModify(null)}>
            <span className="pxz-mi" aria-hidden="true">
              <Icon name="pencil" />
            </span>
            <span>
              <b>{t('suivi.courier.ph.modify', { name })}</b>
              <small>{t('suivi.courier.ph.modifySub')}</small>
            </span>
            <Icon name="chevr" className="pxk-flip" />
          </button>
        ) : (
          <p className="pxk-info">
            <Icon name="lock" /> {t('suivi.courier.noChange', { name })}
          </p>
        ))}
      {info && (info.history.length > 0 || info.sms.length > 0) && (
        <>
          <div className="pxz-tabs" role="group">
            <button type="button" aria-expanded={tab === 'hist'} className={tab === 'hist' ? 'on' : ''} disabled={!info.history.length} onClick={() => setTab(tab === 'hist' ? null : 'hist')}>
              <Icon name="route" /> {t('suivi.courier.ph.journey', { name })} <b>{info.history.length}</b>
            </button>
            <button type="button" aria-expanded={tab === 'sms'} className={tab === 'sms' ? 'on' : ''} disabled={!info.sms.length} onClick={() => setTab(tab === 'sms' ? null : 'sms')}>
              <Icon name="message" /> {t('suivi.courier.ph.sms')} <b>{info.sms.length}</b>
            </button>
          </div>
          {tab === 'hist' && <Journey info={info} />}
          {tab === 'sms' && <SmsList info={info} />}
        </>
      )}
    </section>
  );
}
