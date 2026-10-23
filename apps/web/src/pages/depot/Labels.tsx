// « En dispatch »: print the parcel labels (all the ready ones, a selection, or one), and send to its company a parcel
// still waiting for the company's own tracking number. Rules and the Pilotix label itself: labelPrint.ts.
// A parcel sent to a company with an API gets that company's own label (asked from the company); own livreurs and
// companies without an API get the Pilotix label. Several company labels open from a list, one by one (each company
// gives its own file).
import type { Order } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, rpc } from '../../lib/backend';
import { useRpc } from '../../lib/query';
import { Help, Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { LabelItem, labelBy, labelHref, labelState, loadQr, printLabelItems } from './labelPrint';
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
/** Whose label a parcel gets: its company's own, or Pilotix's. */
export const byOf = (o: Order, c: Couriers) => labelBy(o.companyId ? c.kindOf(o.companyId) : undefined);
const codeOf = (o: Order) => o.tracking || o.ownTracking || o.ref;

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

/** One file of a company: one parcel's label, or (ZR) the labels of many parcels in one PDF. */
type CompanyLabel = { os: Order[]; href: string };

/**
 * Prints labels: the Pilotix ones in one go; the companies' own ones asked from each company. One company label opens
 * at once; several open from a list (`modal`), one tap each. In the browser preview the couriers are simulated: the
 * server answers with a stand-in for each company label, printed with the Pilotix ones and marked as such.
 */
export function useLabelPrinter() {
  const { t } = useTranslation();
  const c = useCouriers();
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<CompanyLabel[] | null>(null);
  const [opened, setOpened] = useState<Set<number>>(new Set());
  const fail = (e: unknown) => toast((e as Error)?.message || String(e), 'bad');

  const pilotixItem = (o: Order): LabelItem => ({ o, code: codeOf(o) });

  /** Any mix of parcels: each gets the label it should have, in one print job for everything Pilotix prints (its own
   *  labels, and in the preview the companies' stand-ins); the companies' own files open from a list. The parcels not
   *  ready are counted. */
  const print = async (orders: Order[]) => {
    if (!c) return;
    setBusy(true);
    try {
      const ready = orders.filter((o) => stateOf(o, c).ok);
      if (ready.length < orders.length) toast(t('depot.labels.skipped', { count: orders.length - ready.length }), 'bad', 6000);
      const ours = ready.filter((o) => byOf(o, c) === 'pilotix');
      const companies = ready.filter((o) => byOf(o, c) === 'company');
      const standIns: Order[] = [];
      const theirs: CompanyLabel[] = [];
      const errors: string[] = [];
      let missed = 0;
      if (companies.length) {
        const byId = new Map(companies.map((o) => [o.id, o]));
        for (const r of await rpc('delivery.labels', { ids: companies.map((o) => o.id) })) {
          const os = r.ids.map((x) => byId.get(x)).filter((o): o is Order => !!o);
          if (!os.length) continue;
          const href = labelHref(r.label);
          if (href) theirs.push({ os, href });
          else if (r.label?.demo) standIns.push(...os); // the preview: the courier is simulated
          else if (r.error) {
            missed += os.length;
            errors.push(`${os.map((o) => o.ref).join(', ')} ${r.error}`);
          } else ours.push(...os); // the company gives no label of its own: Pilotix prints one
        }
      }
      await printLabelItems(t, [...ours.map(pilotixItem), ...standIns.map((o): LabelItem => ({ o, code: codeOf(o), demo: true }))], c.shop);
      if (errors.length) toast(`${t('depot.labels.notGot', { count: missed })} : ${errors.join(' · ')}`, 'bad', 9000);
      if (theirs.length) {
        setOpened(new Set());
        // by company, as the printed labels: each company's labels come together
        const first = (x: CompanyLabel) => x.os[0];
        setList(theirs.sort((a, b) => (first(a).companyName ?? '').localeCompare(first(b).companyName ?? '') || first(a).ref.localeCompare(first(b).ref, undefined, { numeric: true })));
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  /** One parcel from its row: the company's own label opens in a new tab (opened right away, so it is not blocked). */
  const printOne = async (o: Order) => {
    if (!c) return;
    if (byOf(o, c) === 'pilotix' || backend.kind === 'demo') return print([o]);
    const w = window.open('', '_blank');
    setBusy(true);
    try {
      const href = labelHref(await rpc('delivery.label', { orderId: o.id }));
      if (href) {
        if (w) w.location.href = href;
        else window.open(href, '_blank');
      } else {
        w?.close();
        await printLabelItems(t, [pilotixItem(o)], c.shop); // the company gives no label of its own
      }
    } catch (e) {
      w?.close();
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const modal: ReactNode = list && (
    <Modal
      title={t('depot.labels.companyTitle', { count: list.reduce((n, x) => n + x.os.length, 0) })}
      onClose={() => setList(null)}
      footer={
        <button type="button" className="btn primary" onClick={() => setList(null)}>
          {t('common.close')}
        </button>
      }
    >
      <p className="muted small">{t('depot.labels.companyHelp')}</p>
      <ul className="pxl-list">
        {list.map(({ os, href }) => {
          const o = os[0];
          const done = opened.has(o.id);
          return (
            <li key={o.id}>
              {os.length > 1 ? (
                <span>
                  <span>
                    <b>{o.companyName}</b> · {t('depot.labels.fileN', { count: os.length })}
                  </span>
                  <small className="ltr">{os.length > 4 ? `${os.slice(0, 4).map((x) => x.ref).join(', ')} +${os.length - 4}` : os.map((x) => x.ref).join(', ')}</small>
                </span>
              ) : (
                <span>
                  <span>
                    <b className="ltr">{o.ref}</b> · {o.companyName}
                  </span>
                  <small className="ltr">{o.tracking}</small>
                </span>
              )}
              <button
                type="button"
                className={`btn small ${done ? '' : 'primary'}`}
                onClick={() => {
                  window.open(href, '_blank');
                  setOpened((s) => new Set(s).add(o.id));
                }}
              >
                <Icon name={done ? 'check' : 'printer'} /> {done ? t('depot.labels.opened') : t('depot.labels.open')}
              </button>
            </li>
          );
        })}
      </ul>
    </Modal>
  );

  return { ready: !!c, busy, print, printOne, modal };
}

/** The top of « En dispatch »: print every ready label at once (the Pilotix ones, the companies' own ones); the parcels
 *  still waiting for their company's number (send them again) and the ones without a company. */
export function LabelsBar({ phone }: { phone?: boolean }) {
  const { t } = useTranslation();
  const c = useCouriers();
  const all = useRpc('orders.list', { follow: ['prepared'], conf: ['confirmed'], sort: 'updated_at', dir: 'asc', page: 1, pageSize: 1000, tickets: 'include' });
  const sender = useSendToCompany();
  const printer = useLabelPrinter();
  useEffect(() => void loadQr(), []);
  if (!c || !all.data) return null;
  const rows = all.data.rows;
  const ready = rows.filter((o) => stateOf(o, c).ok);
  const ours = ready.filter((o) => byOf(o, c) === 'pilotix');
  const theirs = ready.filter((o) => byOf(o, c) === 'company');
  const waiting = rows.filter((o) => {
    const s = stateOf(o, c);
    return !s.ok && s.why === 'waiting';
  });
  const none = rows.filter((o) => {
    const s = stateOf(o, c);
    return !s.ok && s.why === 'noCompany';
  }).length;
  return (
    <section className={`pxl-bar ${phone ? 'pxl-phone' : ''}`} aria-label={t('depot.labels.title')}>
      {phone && (
        <div className="pxl-head">
          <b>{t('depot.labels.title')}</b>
          <Help text={t('depot.labels.help')} label={t('depot.labels.title')} />
        </div>
      )}
      <div className="pxl-btns">
        {theirs.length > 0 && (
          <button type="button" className="btn primary pxl-print" disabled={printer.busy} onClick={() => printer.print(theirs)}>
            <Icon name="printer" /> {t('depot.labels.printCompanies', { n: theirs.length })}
          </button>
        )}
        {ours.length > 0 && (
          <button type="button" className={`btn ${theirs.length ? '' : 'primary'} pxl-print`} disabled={printer.busy} onClick={() => printer.print(ours)}>
            <Icon name="printer" /> {t('depot.labels.printPilotix', { n: ours.length })}
          </button>
        )}
        {!ready.length && (
          <button type="button" className="btn primary pxl-print" disabled>
            <Icon name="printer" /> {t('depot.labels.printAll', { n: 0 })}
          </button>
        )}
        {!phone && <Help text={t('depot.labels.help')} label={t('depot.labels.title')} />}
      </div>
      {waiting.length > 0 && (
        <div className="pxl-warn">
          <Icon name="clock" />
          <span className="pxl-wt">{t('depot.labels.waitingN', { count: waiting.length })}</span>
          <button type="button" className="btn small" disabled={sender.busy} onClick={() => sender.send(waiting.map((o) => o.id))}>
            <Icon name="send" /> {t('depot.labels.sendAll')}
          </button>
        </div>
      )}
      {none > 0 && <span className="pxl-none">{t('depot.labels.noneN', { count: none })}</span>}
      {printer.modal}
    </section>
  );
}

/** One parcel: its label (the company's own, or Pilotix's), or send it to its company first, or nothing to print yet. */
export function LabelAction({ o, phone }: { o: Order; phone?: boolean }) {
  const { t } = useTranslation();
  const c = useCouriers();
  const sender = useSendToCompany();
  const printer = useLabelPrinter();
  if (!c) return null;
  const s = stateOf(o, c);
  const cls = phone ? 'pxl-act' : 'btn small';
  if (s.ok)
    return (
      <>
        <button type="button" className={cls} disabled={printer.busy} onClick={(e) => (e.stopPropagation(), printer.printOne(o))}>
          <Icon name="printer" /> {byOf(o, c) === 'company' ? t('depot.labels.oneOf', { name: o.companyName ?? '' }) : t('depot.labels.one')}
        </button>
        {printer.modal}
      </>
    );
  if (s.why === 'waiting')
    return (
      <button type="button" className={`${cls} pxl-send`} disabled={sender.busy} onClick={(e) => (e.stopPropagation(), sender.send([o.id]))}>
        <Icon name="send" /> {t('depot.labels.sendTo', { name: o.companyName ?? '' })}
      </button>
    );
  return <span className="muted small">{t('depot.labels.noCompany')}</span>;
}

/** The selection's labels (bulk bar): each ready parcel gets its label, the others are counted. */
export function PrintSelected({ ids }: { ids: number[] }) {
  const { t } = useTranslation();
  const printer = useLabelPrinter();
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn small"
        disabled={!printer.ready || busy || printer.busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await rpc('orders.list', { ids, page: 1, pageSize: Math.min(3000, ids.length), tickets: 'include' });
            await printer.print(r.rows);
          } catch (e: any) {
            toast(e.message, 'bad');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Icon name="printer" /> {t('depot.labels.printSel')}
      </button>
      {printer.modal}
    </>
  );
}
