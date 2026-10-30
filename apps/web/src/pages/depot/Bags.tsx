// « Dispatchées »: the pickup bags (sacs de ramassage) of the companies that take them from Pilotix (ZR Express). The
// parcels handed over go in a bag made here; its label is printed from here; the company says how many it has processed.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, rpc } from '../../lib/backend';
import type { Out } from '../../lib/backend';
import { when } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { CopyCode } from '../../ui/CopyCode';
import { Help, Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { labelHref, loadQr, printBagSheet } from './labelPrint';
import './stages.css';

type Company = Out<'pickup.overview'>[number];
type Bag = Company['bags'][number];

const demo = () => backend.kind === 'demo';

/** Prints a bag's label: the company's A4 PDF (opened in a new tab), or in the preview a stand-in sheet. Call `prepare`
 *  in the click itself (it opens the tab at once, so the browser does not block it), then `open` once the bag exists. */
function useBagLabel() {
  const { t } = useTranslation();
  const prepare = () => (demo() ? null : window.open('', '_blank'));
  const open = async (bagId: number, company: string, w: Window | null) => {
    try {
      const r = await rpc('pickup.label', { bagId });
      if (r?.demo || demo()) {
        w?.close();
        const p = await rpc('pickup.parcels', { bagId });
        await printBagSheet(t, { tracking: p.bag.tracking ?? '', company, createdAt: p.bag.createdAt, parcels: p.parcels }, true);
        return;
      }
      const href = labelHref(r);
      if (!href) {
        w?.close();
        toast(t('depot.bags.noLabel', { name: company }), 'bad');
      } else if (w) w.location.href = href;
      else window.open(href, '_blank');
    } catch (e: any) {
      w?.close();
      toast(e.message, 'bad');
    }
  };
  return { prepare, open };
}

/** What a bag says about its parcels at the company: processed, being processed, or not seen yet. */
function Progress({ b, name }: { b: Bag; name: string }) {
  const { t } = useTranslation();
  if (b.unprocessed === null) return <span className="badge t-off">{t('depot.bags.notSeen', { name })}</span>;
  if (b.unprocessed <= 0)
    return (
      <span className="badge t-ok">
        <Icon name="check" /> {t('depot.bags.processed', { name })}
      </span>
    );
  return <span className="badge t-warn">{t('depot.bags.processing', { name, done: Math.max(0, b.parcels - b.unprocessed), n: b.parcels })}</span>;
}

function BagParcels({ b, name, onClose }: { b: Bag; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useRpc('pickup.parcels', { bagId: b.id });
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(false);
  const editable = b.unprocessed === null || b.unprocessed > 0;
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, 'ok');
      qc.invalidateQueries();
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      sheet
      title={`${t('depot.bags.bag')} ${b.tracking ?? ''}`}
      onClose={onClose}
      footer={
        <>
          {(b.unprocessed === null || b.unprocessed >= b.parcels) && (
            <button type="button" className="btn danger" disabled={busy} onClick={() => setAsk(true)}>
              <Icon name="trash" /> {t('depot.bags.drop')}
            </button>
          )}
          <button type="button" className="btn primary" onClick={onClose}>
            {t('common.close')}
          </button>
        </>
      }
    >
      <p className="muted small">
        {t('depot.bags.parcelsN', { count: b.parcels })} · {when(b.createdAt)}
        {b.createdBy ? ` · ${t('depot.bags.by', { name: b.createdBy })}` : ''} · <Progress b={b} name={name} />
      </p>
      {ask && (
        <div className="pxb-ask">
          <span>{t('depot.bags.dropConfirm', { bag: b.tracking ?? '' })}</span>
          <button type="button" className="btn small" onClick={() => setAsk(false)}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn small danger"
            disabled={busy}
            onClick={() =>
              act(async () => {
                await rpc('pickup.drop', { bagId: b.id });
                onClose();
              }, t('depot.bags.dropped', { bag: b.tracking ?? '' }))
            }
          >
            {t('depot.bags.drop')}
          </button>
        </div>
      )}
      <ul className="pxl-list">
        {(q.data?.parcels ?? []).map((p) => (
          <li key={p.id}>
            <span>
              <span>
                <b className="ltr">{p.ref}</b> · {p.customer}
              </span>
              <small className="ltr">{p.tracking}</small>
            </span>
            {editable && (
              <button type="button" className="btn small" disabled={busy} onClick={() => act(() => rpc('pickup.remove', { bagId: b.id, orderId: p.id }), t('depot.bags.removed', { ref: p.ref }))}>
                <Icon name="x" /> {t('depot.bags.remove')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function CompanyBags({ c, phone }: { c: Company; phone?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const label = useBagLabel();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [open, setOpen] = useState<Bag | null>(null);
  const [all, setAll] = useState(false);
  // a bag made today that the company has not started: new parcels can go in it
  const fresh = c.bags.find((b) => Date.now() - Date.parse(b.createdAt) < 12 * 3_600_000 && (b.unprocessed === null || b.unprocessed >= b.parcels));
  const shown = all ? c.bags : c.bags.slice(0, phone ? 2 : 4);

  const make = async (into: Bag | null) => {
    // a quick double click would ask for two bags (the button is disabled only after the next render)
    if (running.current) return;
    running.current = true;
    const w = label.prepare();
    setBusy(true);
    try {
      const r = into ? await rpc('pickup.add', { bagId: into.id }) : await rpc('pickup.create', { companyId: c.companyId });
      toast(into ? t('depot.bags.addedTo', { count: r.added, bag: r.bag.tracking ?? '' }) : t('depot.bags.made', { count: r.added, bag: r.bag.tracking ?? '' }), 'ok');
      if (r.failed.length) toast(`${t('depot.bags.refusedN', { count: r.failed.length })} : ${r.failed.map((f) => `${f.ref} ${f.error}`).join(' · ')}`, 'bad', 9000);
      qc.invalidateQueries();
      await label.open(r.bag.id, c.name, w);
    } catch (e: any) {
      w?.close();
      toast(e.message, 'bad');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const sync = async () => {
    setBusy(true);
    try {
      await rpc('pickup.sync', { companyId: c.companyId });
      qc.invalidateQueries();
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`pxb ${phone ? 'pxb-phone' : ''}`} aria-label={t('depot.bags.title', { name: c.name })}>
      <div className="pxb-head">
        <Icon name="package" />
        <b>{t('depot.bags.title', { name: c.name })}</b>
        <Help text={t('depot.bags.help', { name: c.name })} label={t('depot.bags.title', { name: c.name })} />
        <button type="button" className="icon-btn pxb-sync" disabled={busy} onClick={sync} aria-label={t('depot.bags.sync')} title={t('depot.bags.sync')}>
          <Icon name="refresh" />
        </button>
      </div>
      {c.waiting > 0 ? (
        <div className="pxb-wait">
          <span className="pxb-wt">
            <Icon name="clock" /> {t('depot.bags.waitingN', { count: c.waiting })}
          </span>
          <div className="pxb-btns">
            <button type="button" className="btn primary" disabled={busy} onClick={() => make(null)}>
              <Icon name="package" /> {t('depot.bags.create', { n: c.waiting })}
            </button>
            {fresh && (
              <button type="button" className="btn" disabled={busy} onClick={() => make(fresh)}>
                <Icon name="plus" /> {t('depot.bags.addTo', { bag: fresh.tracking ?? '' })}
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className="pxb-none">
          <Icon name="check" /> {t('depot.bags.noneWaiting')}
        </p>
      )}
      {shown.length > 0 && (
        <ul className="pxb-list">
          {shown.map((b) => (
            <li key={b.id}>
              <div className="pxb-id">
                {b.tracking ? <CopyCode code={b.tracking} small /> : <b>—</b>}
                <small>
                  {t('depot.bags.parcelsN', { count: b.parcels })} · {when(b.createdAt)}
                  {b.createdBy && !phone ? ` · ${t('depot.bags.by', { name: b.createdBy })}` : ''}
                </small>
              </div>
              <Progress b={b} name={c.name} />
              <div className="pxb-act">
                <button type="button" className="btn small" disabled={busy} onClick={() => label.open(b.id, c.name, label.prepare())}>
                  <Icon name="printer" /> {t('depot.bags.label')}
                </button>
                <button type="button" className="btn small" onClick={() => setOpen(b)}>
                  <Icon name="list" /> {t('depot.bags.parcels')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {c.bags.length > shown.length && (
        <button type="button" className="btn small ghost pxb-more" onClick={() => setAll(true)}>
          {t('depot.bags.older', { n: c.bags.length - shown.length })}
        </button>
      )}
      {open && <BagParcels b={open} name={c.name} onClose={() => setOpen(null)} />}
    </section>
  );
}

/** The bags of every company that takes them from Pilotix (nothing when none does). */
export function BagsCard({ phone }: { phone?: boolean }) {
  const q = useRpc('pickup.overview', {}, { refetchInterval: 60_000 });
  useEffect(() => void loadQr(), []);
  if (!q.data?.length) return null;
  return (
    <>
      {q.data.map((c) => (
        <CompanyBags key={c.companyId} c={c} phone={phone} />
      ))}
    </>
  );
}

/** Bulk bar of « Dispatchées »: the selected parcels in a new bag (one per company). */
export function BagBulk({ ids, done }: { ids: number[]; done: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const label = useBagLabel();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  return (
    <button
      type="button"
      className="btn small"
      disabled={busy}
      onClick={async () => {
        if (running.current) return;
        running.current = true;
        const w = label.prepare();
        setBusy(true);
        try {
          const r = await rpc('pickup.createMany', { ids });
          if (!r.made.length) {
            w?.close();
            toast(t('depot.bags.bulkNone'), 'bad', 7000);
            return;
          }
          for (const m of r.made) toast(t('depot.bags.made', { count: m.added, bag: m.bag.tracking ?? '' }), 'ok');
          const failed = r.made.flatMap((m) => m.failed);
          if (failed.length) toast(`${t('depot.bags.refusedN', { count: failed.length })} : ${failed.map((f) => `${f.ref} ${f.error}`).join(' · ')}`, 'bad', 9000);
          if (r.skipped) toast(t('depot.bags.skippedN', { count: r.skipped }), 'bad', 7000);
          qc.invalidateQueries();
          done();
          const first = r.made[0];
          const names = await rpc('pickup.overview', {});
          await label.open(first.bag.id, names.find((c) => c.companyId === first.bag.companyId)?.name ?? '', w);
          // the other companies' bags: their labels from the card
        } catch (e: any) {
          w?.close();
          toast(e.message, 'bad');
        } finally {
          running.current = false;
          setBusy(false);
        }
      }}
    >
      <Icon name="package" /> {t('depot.bags.bulk')}
    </button>
  );
}
