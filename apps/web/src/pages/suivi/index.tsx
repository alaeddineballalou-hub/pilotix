import type { Order } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { when, wilayaName } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { Empty, ErrorBox, Icon, Loading, StatusBadge } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import type { PageProps } from '../registry';
import { ConfirmModal, daysSince, productsText } from './common';
import { namesOf, variantsOf, trackOf } from '../../lib/items';
import { NewClaimModal } from './Claims';
import { Reclamation } from './Reclamation';
import { SwapModal, SwapResult, SwapSheetModal } from './Swap';
import './suivi.css';
import { colDrag, ColumnMenu, DensitySwitch, useDensity, useTableColumns } from '../../ui/ColumnMenu';
import { HistoryButton, PhoneCell } from '../confirmation/History';
import { store } from '../../lib/store';
import { CopyCode } from '../../ui/CopyCode';

const LIST_TABS = ['alertes', 'traites', 'livres', 'annules', 'swap'] as const;
type ListTab = (typeof LIST_TABS)[number];
type Sub = ListTab | 'reclamation';

export function Suivi({ sub }: PageProps) {
  const tab: Sub = sub === 'reclamation' || (LIST_TABS as readonly string[]).includes(sub ?? '') ? (sub as Sub) : 'alertes';
  return (
    <>
      <SuiviBar tab={tab} />
      {tab === 'reclamation' ? (
        <Reclamation />
      ) : (
        <>
          <Head tab={tab} />
          <List tab={tab} />
          {tab === 'swap' && <SwappedList />}
        </>
      )}
    </>
  );
}

/** "Alertes › Traités | Annulés  Réclamation  Swap" — same markup as the original stage bar. */
function SuiviBar({ tab }: { tab: Sub }) {
  const { t } = useTranslation();
  const c = useRpc('suivi.counts', {}, { refetchInterval: 60_000 }).data;
  const item = (k: Sub, count?: number, x = false) => (
    <a className={`bjm-p ${tab === k ? 'on' : ''} ${x ? 'x' : ''}`} href={`#/suivi/${k}`} data-k={k} aria-current={tab === k ? 'page' : undefined}>
      <span className="bjm-l">{t(`suivi.tabs.${k}`)}</span>
      {count !== undefined && <b className="bjm-n ltr">{count}</b>}
    </a>
  );
  return (
    <nav className="bjm-bar flow" aria-label="Étapes" data-g="suivi">
      {item('alertes', c?.alertes ?? 0)}
      <span className="bjm-ar" aria-hidden="true">
        ›
      </span>
      {item('traites', c?.traites ?? 0)}
      <span className="bjm-sep" aria-hidden="true" />
      {item('annules', c?.annules ?? 0, true)}
      {item('reclamation', undefined, true)}
      {item('swap', c?.swap ?? 0, true)}
    </nav>
  );
}

function Head({ tab }: { tab: ListTab }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const c = useRpc('suivi.counts', {}).data;
  const [busy, setBusy] = useState(false);
  const sync = async () => {
    setBusy(true);
    try {
      // built by the delivery feature; the demo simulates the couriers
      const r = (await (rpc as unknown as (n: string, i: unknown) => Promise<any>)('delivery.sync', {})) ?? {};
      toast(t('suivi.syncDone', { checked: r.checked ?? 0, changed: r.changed ?? 0 }), 'ok');
      qc.invalidateQueries();
    } catch (e: any) {
      toast(t('suivi.syncFail', { msg: e?.message ?? '' }), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const kpis: [ListTab, 'warn' | ''][] = [
    ['alertes', c?.alertes ? 'warn' : ''],
    ['traites', ''],
    ['livres', ''],
    ['annules', ''],
  ];
  return (
    <div className="card">
      <div className="card-head">
        <h2>{t('suivi.title')}</h2>
        <button className="btn" onClick={sync} disabled={busy}>
          <Icon name="refresh" /> {t('suivi.sync')}
        </button>
      </div>
      <div className="kpis bjsv-kpis">
        {kpis.map(([k, tone]) => (
          <a key={k} className={`kpi${k === tab ? ' bjsv-on' : ''}${tone ? ` t-${tone}` : ''}`} href={`#/suivi/${k}`}>
            <span className="l">{t(`suivi.tabs.${k}`)}</span>
            <span className="v ltr">{c ? c[k] : '—'}</span>
            <span className="s">{t(`suivi.kpiSub.${k}`)}</span>
          </a>
        ))}
      </div>
      <p className="muted small">{t(`suivi.help.${tab}`)}</p>
    </div>
  );
}

type Extra = { companyKind: string | null; livreurPhone: string | null; alertReason: string | null; claim: { id: number; status: string; createdAt: string; sentAt: string | null } | null };

/** What the courier or the livreur said: the alert note while in alert, else the courier's own status. */
const reasonOf = (o: Order, x?: Extra) => (o.followStatus === 'alert' ? x?.alertReason || o.extStatus : o.extStatus);

/** Suivi columns. Keys shared with Confirmation, so one saved preset works in both. */
type SCol = 'order' | 'name' | 'phone' | 'wilaya' | 'product' | 'variant' | 'tracking' | 'follow' | 'agent' | 'fagent' | 'since' | 'passed' | 'status';
const SCOLS: SCol[] = ['order', 'name', 'phone', 'wilaya', 'product', 'variant', 'tracking', 'follow', 'agent', 'fagent', 'since', 'passed', 'status'];
const SDEFAULT: SCol[] = ['order', 'name', 'phone', 'wilaya', 'product', 'variant', 'follow', 'agent', 'fagent', 'since', 'passed', 'status'];
const SKEY = 'suivi-cols';

/** The table shared by every Suivi list, with the column menu and the shared presets. */
export function ParcelTable({ rows, actions, empty, extra = {} }: { rows: Order[]; actions?: (o: Order) => ReactNode; empty: string; extra?: Record<number, Extra> }) {
  const { t } = useTranslation();
  // columns saved with the account; a chosen preset is used by every list until the columns are changed by hand
  const tc = useTableColumns<SCol>('suivi', SCOLS, { defaults: SDEFAULT, legacy: () => ({ cols: store.json<SCol[] | null>(SKEY, null), order: store.json<SCol[] | null>('suivi-order', null) }) });
  const visible = tc.visible;
  const [menu, setMenu] = useState(false);
  const label: Record<SCol, string> = {
    order: t('suivi.col.order'), name: t('suivi.col.client'), phone: t('suivi.col.phone'), wilaya: t('suivi.col.wilaya'), product: t('suivi.col.products'), variant: t('suivi.col.variant'),
    tracking: t('suivi.col.tracking'), follow: t('suivi.col.delivery'), agent: t('suivi.col.agent'), fagent: t('suivi.col.fagent'), since: t('suivi.col.since'), passed: t('confirmation.col.passed'), status: t('suivi.col.status'),
  };
  const { order, setOrder } = tc;
  const cols = order.filter((k) => visible.has(k));
  const drag = colDrag(order, setOrder);
  const [dens, setDens] = useDensity();
  const cell = (o: Order, k: SCol): ReactNode => {
    switch (k) {
      case 'order':
        return (
          <>
            <b className="ltr">{o.ref}</b>
            <small>{when(o.createdAt)}</small>
          </>
        );
      case 'name':
        return o.customerName;
      case 'phone':
        return <PhoneCell order={o} />;
      case 'wilaya':
        return (
          <>
            {wilayaName(o.wilayaId)}
            <small>{o.commune}</small>
          </>
        );
      case 'product':
        return <div className="px-clamp">{namesOf(o.items)}</div>;
      case 'variant':
        return <div className="px-clamp">{variantsOf(o.items)}</div>;
      case 'tracking':
        return <CopyCode code={trackOf(o)} />;
      case 'follow':
        return (
          <>
            {o.companyName || o.livreurName || '—'}
            <small>
              {trackOf(o) && <CopyCode code={trackOf(o)} />}
              {reasonOf(o, extra[o.id]) ? ` · ${reasonOf(o, extra[o.id])}` : ''}
            </small>
          </>
        );
      case 'agent':
        return o.agentName ?? '—';
      case 'fagent':
        return o.followAgentName ?? '—';
      case 'since': {
        const d = daysSince(o.shippedAt);
        return d === null ? '—' : <span className={`badge ${d >= 10 ? 't-bad' : d >= 5 ? 't-warn' : 't-info'} ltr`}>{t('suivi.days', { n: d })}</span>;
      }
      case 'passed':
        return (
          <HistoryButton orderId={o.id} refLabel={o.ref} className="px-histcell" title={t('confirmation.hist.open', { ref: o.ref })}>
            <Icon name="history" />
            <span className="muted">{t('confirmation.hist.see')}</span>
          </HistoryButton>
        );
      case 'status':
        return <StatusBadge kind="follow" status={o.followStatus} />;
    }
  };
  return (
    <>
      <div className="px-scols">
        <DensitySwitch value={dens} onChange={setDens} />
        <ColumnMenu
          order={order}
          onOrder={setOrder}
          cols={SCOLS.map((k) => ({ k, label: label[k] }))}
          visible={visible}
          onChange={tc.setVisible}
          onReset={tc.reset}
          presetId={tc.presetId}
          onPreset={tc.applyPreset}
          open={menu}
          onToggle={() => setMenu((v) => !v)}
        />
      </div>
      {!rows.length ? (
        <Empty>{empty}</Empty>
      ) : (
        <div className={`tbl-wrap px-d-${dens}`}>
          <table className="tbl">
            <thead>
              <tr>
                {cols.map((k) => (
                  <th key={k} {...drag(k)} title={t('common.dragCol')} className={`px-drag ${k === 'product' ? 'wide' : k === 'since' ? 'num' : ''}`}>
                    {label[k]}
                  </th>
                ))}
                {actions && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className="clickable" onClick={() => openOrder(o.id)}>
                  {cols.map((k) => (
                    <td key={k} data-l={label[k]} className={k === 'product' ? 'wide px-cw' : k === 'since' ? 'num' : undefined}>
                      {cell(o, k)}
                    </td>
                  ))}
                  {actions && (
                    <td data-l="" onClick={(e) => e.stopPropagation()}>
                      {actions(o)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type Dialog =
  | { kind: 'treat'; o: Order }
  | { kind: 'cancel'; o: Order }
  | { kind: 'swap'; o: Order }
  | { kind: 'claim'; o: Order; toLivreur: boolean }
  | { kind: 'sheet'; data: SwapResult & { fresh?: boolean } }
  | null;

function List({ tab }: { tab: ListTab }) {
  const { t } = useTranslation();
  const q = useRpc('suivi.list', { tab });
  const [dlg, setDlg] = useState<Dialog>(null);
  const act = useAction('suivi.act');
  const run = (o: Order, action: 'cancel' | 'delivered' | 'realert') =>
    act.mutate({ id: o.id, action }, { onSuccess: () => toast(t(`suivi.msg.${action === 'cancel' ? 'cancelled' : action}`, { ref: o.ref }), 'ok') });

  const extra = (q.data?.extra ?? {}) as Record<number, Extra>;
  let actions: ((o: Order) => ReactNode) | undefined;
  if (tab === 'alertes')
    actions = (o) => (
      <div className="row nowrap px-sv-acts">
        <AlertClaim o={o} x={extra[o.id]} onClaim={(toLivreur) => setDlg({ kind: 'claim', o, toLivreur })} />
        <button type="button" className="btn small primary" onClick={() => setDlg({ kind: 'treat', o })}>
          {t('suivi.act.treat')}
        </button>
        <button type="button" className="btn small ghost danger" onClick={() => setDlg({ kind: 'cancel', o })}>
          {t('suivi.act.cancel')}
        </button>
      </div>
    );
  if (tab === 'traites')
    actions = (o) => (
      <div className="row nowrap px-sv-acts">
        <button type="button" className="btn small ok" disabled={act.isPending} onClick={() => run(o, 'delivered')}>
          {t('suivi.act.delivered')}
        </button>
        <button type="button" className="btn small ghost danger" disabled={act.isPending} onClick={() => run(o, 'cancel')}>
          {t('suivi.act.cancelled')}
        </button>
        <button type="button" className="btn small" disabled={act.isPending} onClick={() => run(o, 'realert')}>
          {t('suivi.act.realert')}
        </button>
      </div>
    );
  if (tab === 'swap')
    actions = (o) => (
      <button type="button" className="btn small primary nowrap" style={{ whiteSpace: 'nowrap' }} onClick={() => setDlg({ kind: 'swap', o })}>
        {t('suivi.act.swap')}
      </button>
    );

  return (
    <div className="card">
      <div className="card-head">
        <h2>{tab === 'swap' ? t('suivi.toSwap') : t(`suivi.tabs.${tab}`)}</h2>
        <span className="muted small">{q.data ? t('suivi.parcels', { count: q.data.rows.length }) : ''}</span>
      </div>
      {q.isLoading ? <Loading /> : q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : <ParcelTable rows={q.data?.rows ?? []} extra={extra} actions={actions} empty={t(`suivi.empty.${tab}`)} />}
      {dlg?.kind === 'treat' && <TreatModal o={dlg.o} reason={reasonOf(dlg.o, extra[dlg.o.id])} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'cancel' && (
        <ConfirmModal
          title={t('suivi.cancelAsk', { ref: dlg.o.ref })}
          text={t('suivi.cancelText')}
          ok={t('suivi.act.cancel')}
          danger
          busy={act.isPending}
          onClose={() => setDlg(null)}
          onOk={() => {
            run(dlg.o, 'cancel');
            setDlg(null);
          }}
        />
      )}
      {dlg?.kind === 'swap' && <SwapModal o={dlg.o} onClose={() => setDlg(null)} onDone={(data) => setDlg({ kind: 'sheet', data: { ...data, fresh: true } })} />}
      {dlg?.kind === 'sheet' && <SwapSheetModal {...dlg.data} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'claim' && <NewClaimModal pre={dlg.o} toLivreur={dlg.toLivreur} reason="relivrer" details={reasonOf(dlg.o, extra[dlg.o.id]) ? t('suivi.rec.alertDetails', { v: reasonOf(dlg.o, extra[dlg.o.id]) }) : ''} onClose={() => setDlg(null)} />}
    </div>
  );
}

/** Next to an alert: claim to the courier (copies the tracking), or call / write to our own livreur. */
function AlertClaim({ o, x, onClaim }: { o: Order; x?: Extra; onClaim: (toLivreur: boolean) => void }) {
  const { t } = useTranslation();
  if (!x) return null;
  if (x.companyKind === 'own') {
    return (
      <span className="bjr-al">
        {x.livreurPhone && (
          <a className="bjr-call c" href={`tel:${x.livreurPhone}`}>
            <Icon name="phone" />
            <span>
              <b>{t('suivi.act.call')} </b>
              <span className="ltr">{x.livreurPhone}</span>
            </span>
          </a>
        )}
        <button type="button" className="bjp-ib bjp-ib-e" title={t('suivi.act.write', { name: o.livreurName ?? '' })} aria-label={t('suivi.act.write', { name: o.livreurName ?? '' })} onClick={() => onClaim(true)}>
          <Icon name="message" />
        </button>
      </span>
    );
  }
  if (!o.companyId) return null;
  const sentAfterAlert = x.claim && x.claim.status !== 'resolved' && x.claim.sentAt && Date.parse(x.claim.createdAt) >= Date.parse(o.updatedAt) - 7 * 86_400_000;
  if (sentAfterAlert)
    return (
      <span className="bjr-al">
        <span className="badge t-ok bjr-sent">{t('suivi.act.claimSent')}</span>
        <small className="muted">{when(x.claim!.sentAt)}</small>
      </span>
    );
  return (
    <span className="bjr-al">
      <button type="button" className="btn small bjr-recb" onClick={() => onClaim(false)}>
        <span className="bjr-ic">
          <Icon name="copy" />
        </span>
        {t('suivi.act.claim')}
      </button>
    </span>
  );
}

function TreatModal({ o, reason, onClose }: { o: Order; reason: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [what, setWhat] = useState<'date' | 'adresse' | 'injoignable' | 'autre'>('date');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const treat = useAction('suivi.treat', {
    onDone: () => {
      toast(t('suivi.treat.done', { ref: o.ref }), 'ok');
      onClose();
    },
  });
  return (
    <Modal
      title={t('suivi.treat.title', { ref: o.ref })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={treat.isPending} onClick={() => treat.mutate({ id: o.id, what, date: date || null, note: note.trim() || null })}>
            {t('suivi.treat.submit')}
          </button>
        </>
      }
    >
      <p className="muted small">
        {o.customerName} · <span className="ltr">{o.phone}</span> · {reason || t('status.follow.alert')}
      </p>
      <label className="field">
        <span className="lab">{t('suivi.treat.what')}</span>
        <select value={what} onChange={(e) => setWhat(e.target.value as typeof what)}>
          {(['date', 'adresse', 'injoignable', 'autre'] as const).map((k) => (
            <option key={k} value={k}>
              {t(`suivi.treat.whats.${k}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="lab">{t('suivi.treat.date')}</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="field">
        <span className="lab">{t('suivi.treat.note')}</span>
        <textarea rows={2} value={note} placeholder={t('suivi.treat.notePh')} onChange={(e) => setNote(e.target.value)} />
      </label>
    </Modal>
  );
}

/** Below the swap list: parcels already swapped, with « Copier pour ZR ». */
function SwappedList() {
  const { t } = useTranslation();
  const q = useRpc('suivi.list', { tab: 'swapped' });
  const [sheet, setSheet] = useState<SwapResult | null>(null);
  const extra = (q.data?.extra ?? {}) as Record<number, Extra>;
  if (!q.data?.rows.length) return null;
  const open = async (o: Order) => {
    try {
      setSheet(await rpc('suivi.swapTarget', { id: o.id }));
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>{t('suivi.swapped')}</h2>
        <span className="muted small">{t('suivi.parcels', { count: q.data.rows.length })}</span>
      </div>
      <ParcelTable
        rows={q.data.rows}
        extra={extra}
        empty=""
        actions={(o) => (
          <button type="button" className="btn small" onClick={() => open(o)}>
            {t('suivi.act.copyFor', { who: extra[o.id]?.companyKind === 'own' ? t('suivi.theLivreur') : t('suivi.zr') })}
          </button>
        )}
      />
      {sheet && <SwapSheetModal {...sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
