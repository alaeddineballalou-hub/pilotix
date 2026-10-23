// « En dispatch »: print the parcel labels (all the ready ones, a selection, or one), and send to its company a parcel
// still waiting for the company's own tracking number. Rules and the label itself: labelPrint.ts.
import type { Order } from '@pilotix/shared';
import type { TFunction } from 'i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { useRpc } from '../../lib/query';
import { Help, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { labelState, loadQr, printLabels } from './labelPrint';
import './stages.css';

/** The delivery companies' kinds, and the shop (name, after-sales number) for the labels; null while they load. */
export function useCouriers() {
  const q = useRpc('orders.lookups', {}, { staleTime: 5 * 60_000 });
  if (!q.data) return null;
  const kinds = new Map(q.data.companies.map((c) => [c.id, c.kind]));
  return { kindOf: (id: number) => kinds.get(id), shop: { name: q.data.shopName, sav: q.data.savPhone ?? '' } };
}
type Couriers = NonNullable<ReturnType<typeof useCouriers>>;
export const stateOf = (o: Order, c: Couriers) => labelState(o, o.companyId ? c.kindOf(o.companyId) : undefined);

/** Prints, and says it when the printing could not start. */
const print = (t: TFunction, orders: Order[], c: Couriers) => printLabels(t, orders, c.kindOf, c.shop).catch((e: Error) => (toast(e.message, 'bad'), { printed: 0, skipped: 0 }));

/** Sends parcels to their company: each gets the company's own tracking number (the label can be printed then). */
export function useSendToCompany() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const send = async (ids: number[]) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      const r = await rpc('delivery.send', { ids });
      const bad = r.results.filter((x) => !x.ok);
      if (r.sent) toast(t('depot.labels.sent', { count: r.sent }), 'ok');
      if (bad.length) toast(`${t('depot.labels.notSent', { count: bad.length })} : ${bad.map((x) => `${x.ref} ${x.error ?? ''}`).join(' · ')}`, 'bad', 8000);
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
      qc.invalidateQueries();
    }
  };
  return { send, busy };
}

/** The top of « En dispatch »: print every ready label at once; the parcels still waiting for their company's number
 *  (send them again) and the ones without a company. */
export function LabelsBar({ phone }: { phone?: boolean }) {
  const { t } = useTranslation();
  const c = useCouriers();
  const all = useRpc('orders.list', { follow: ['prepared'], conf: ['confirmed'], sort: 'updated_at', dir: 'asc', page: 1, pageSize: 1000, tickets: 'include' });
  const sender = useSendToCompany();
  useEffect(() => void loadQr(), []);
  if (!c || !all.data) return null;
  const rows = all.data.rows;
  const states = rows.map((o) => ({ o, s: stateOf(o, c) }));
  const ready = states.filter((x) => x.s.ok).length;
  const waiting = states.filter((x) => !x.s.ok && x.s.why === 'waiting').map((x) => x.o.id);
  const none = states.filter((x) => !x.s.ok && x.s.why === 'noCompany').length;
  return (
    <section className={`pxl-bar ${phone ? 'pxl-phone' : ''}`} aria-label={t('depot.labels.title')}>
      {phone && (
        <div className="pxl-head">
          <b>{t('depot.labels.title')}</b>
          <Help text={t('depot.labels.help')} label={t('depot.labels.title')} />
        </div>
      )}
      <button type="button" className="btn primary pxl-print" disabled={!ready} onClick={() => print(t, rows, c)}>
        <Icon name="printer" /> {t('depot.labels.printAll', { n: ready })}
      </button>
      {waiting.length > 0 && (
        <div className="pxl-warn">
          <Icon name="clock" />
          <span className="pxl-wt">{t('depot.labels.waitingN', { count: waiting.length })}</span>
          <button type="button" className="btn small" disabled={sender.busy} onClick={() => sender.send(waiting)}>
            <Icon name="send" /> {t('depot.labels.sendAll')}
          </button>
        </div>
      )}
      {none > 0 && <span className="pxl-none">{t('depot.labels.noneN', { count: none })}</span>}
      {!phone && <Help text={t('depot.labels.help')} label={t('depot.labels.title')} />}
    </section>
  );
}

/** One parcel: print its label, or send it to its company first, or nothing to print yet. */
export function LabelAction({ o, phone }: { o: Order; phone?: boolean }) {
  const { t } = useTranslation();
  const c = useCouriers();
  const sender = useSendToCompany();
  if (!c) return null;
  const s = stateOf(o, c);
  const cls = phone ? 'pxl-act' : 'btn small';
  if (s.ok)
    return (
      <button type="button" className={cls} onClick={(e) => (e.stopPropagation(), print(t, [o], c))}>
        <Icon name="printer" /> {t('depot.labels.one')}
      </button>
    );
  if (s.why === 'waiting')
    return (
      <button type="button" className={`${cls} pxl-send`} disabled={sender.busy} onClick={(e) => (e.stopPropagation(), sender.send([o.id]))}>
        <Icon name="send" /> {t('depot.labels.sendTo', { name: o.companyName ?? '' })}
      </button>
    );
  return <span className="muted small">{t('depot.labels.noCompany')}</span>;
}

/** The selection's labels (bulk bar): the ready ones are printed, the others are counted. */
export function PrintSelected({ ids }: { ids: number[] }) {
  const { t } = useTranslation();
  const c = useCouriers();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      disabled={!c || busy}
      onClick={async () => {
        if (!c) return;
        setBusy(true);
        try {
          const r = await rpc('orders.list', { ids, page: 1, pageSize: Math.min(3000, ids.length), tickets: 'include' });
          const out = await print(t, r.rows, c);
          if (out.skipped) toast(t('depot.labels.skipped', { count: out.skipped }), 'bad', 6000);
        } catch (e: any) {
          toast(e.message, 'bad');
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name="printer" /> {t('depot.labels.printSel')}
    </button>
  );
}
