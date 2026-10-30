// The order card of the original app: a drawer on the right with Client, Produits, Livraison, Historique and every action.
import { API_COURIER_KINDS, canSetFollow, CANCEL_REASONS, CONF_TONE, FAKE_REASONS, CONF_NEEDS_DATE, CONF_NEEDS_REASON, ConfStatus, FAIL_REASONS, FOLLOW_FINAL, FOLLOW_STATUSES, FollowStatus, Order, OrderEvent, RETURN_REASONS } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { da, dateOnly, fromLocalInput, toLocalInput, when, wilaya } from '../../lib/format';
import { closeModal, openOrder, openOrderForm } from '../../lib/modals';
import { startTicketFor } from '../sav/NewTicket';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { ErrorBox, Field, Icon, Loading, StatusBadge, TicketTag } from '../../ui/kit';
import { askRisk, ScoreCard } from '../../ui/clientScore';
import { toast } from '../../ui/toast';
import { confLabel, printOrder, telHref, waHref } from './shared';
import './orders.css';
import { trackOf } from '../../lib/items';
import { CopyCode } from '../../ui/CopyCode';
import { useLabelPrinter } from '../depot/Labels';
import { CourierPanel } from '../suivi/CourierPanel';
import { useIsPhone } from '../../lib/useMedia';
import { TrustFlags } from './TrustFlags';
import { AdSection } from './AdSource';

/** Courier kinds with an API (send / label / status / cancel go through the delivery procedures). */
export const API_KINDS: readonly string[] = API_COURIER_KINDS;
const SHIPPED: (FollowStatus | null)[] = ['shipped', 'out_for_delivery', 'delivered', 'returning', 'returned', 'exchanged', 'lost', 'in_exchange'];
const CONF_CHOICES: ConfStatus[] = ['confirmed', 'callback', 'postponed', 'no_stock', 'cancelled', 'wrong_number', 'fake', 'duplicate'];

/** Calls a procedure that another feature provides (may not exist yet): errors are returned, not thrown. */
export async function callOptional(name: string, input: unknown): Promise<{ ok: true; data: any } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await (rpc as unknown as (n: string, i: unknown) => Promise<unknown>)(name, input) };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

type Panel = null | { kind: 'conf'; status: ConfStatus } | { kind: 'follow'; status: FollowStatus } | { kind: 'company' } | { kind: 'note' } | { kind: 'blacklist' } | { kind: 'cancelParcel' };

/** The payment of a delivered parcel: waiting (grey) → the company has it (blue) → paid, to pick up (orange) → received (green). */
const PAY_TONE = { waiting: 'off', collected: 'info', ready: 'warn', received: 'ok' } as const;

export default function OrderCard({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('orders.get', { id }, { placeholderData: undefined });
  const ev = useRpc('orders.events', { id }, { placeholderData: undefined });
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.modal-wrap') && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const o = q.data;
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer oc-drawer" role="dialog" aria-modal="true" aria-label={o?.ref ?? ''}>
        <div className="drawer-head">
          <div className="grow">
            {o && (
              <>
                <div className="ord-head">
                  <span className="ord-ref ltr">{o.ref}</span>
                  <span className={`badge t-${o.confStatus === 'no_answer' ? 'mid' : CONF_TONE[o.confStatus]}`}>{confLabel(t, o)}</span>
                  {o.followStatus ? <StatusBadge kind="follow" status={o.followStatus} /> : <span className="muted">—</span>}
                  {o.possibleDuplicate && <span className="flag dup">{t('orders.flag.dup')}</span>}
                  {o.blacklisted && <span className="flag">{t('orders.flag.black')}</span>}
            <TrustFlags o={o} />
                </div>
                <div className="muted small">
                  {t('orders.card.created', { when: when(o.createdAt) })} · {t(`status.channel.${o.channel}`)}
                  {o.agentName ? ` · ${t('orders.card.agent', { name: o.agentName })}` : ''}
                </div>
              </>
            )}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body">{q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !o ? <Loading /> : <Body o={o} events={ev.data} onClose={onClose} />}</div>
      </aside>
    </>
  );
}

function Body({ o, events, onClose }: { o: Order; events?: OrderEvent[]; onClose: () => void }) {
  const { t } = useTranslation();
  const isPhone = useIsPhone();
  const { has, session } = useSession();
  const qc = useQueryClient();
  const look = useRpc('orders.lookups', {}, { staleTime: 5 * 60_000 });
  const users = useRpc('users.list', {}, { staleTime: 5 * 60_000 });
  const hist = useRpc('customers.history', { id: o.customerId }, { enabled: has('confirmation', 'suivi'), placeholderData: undefined });
  const [panel, setPanel] = useState<Panel>(null);
  const [showHist, setShowHist] = useState(false);
  const [busy, setBusy] = useState(false);
  // the company's own label (a parcel sent to it), opened in a new tab
  const printer = useLabelPrinter();
  const companies = look.data?.companies ?? [];
  const company = companies.find((c) => c.id === o.companyId);
  const apiKind = !!company && API_KINDS.includes(company.kind);
  const sent = !!o.tracking && apiKind;
  const shipped = SHIPPED.includes(o.followStatus);
  const roles = session!.roles;

  const refresh = () => qc.invalidateQueries();
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast(ok, 'ok');
      setPanel(null);
      refresh();
    } catch (e: any) {
      toast(e?.message ?? String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const optional = async (name: string, input: unknown, ok: (d: any) => string | null, fail: (m: string) => string) => {
    setBusy(true);
    const r = await callOptional(name, input);
    setBusy(false);
    if (r.ok) {
      const m = ok(r.data);
      if (m) toast(m, 'ok');
      refresh();
    } else toast(fail(r.error), 'bad');
    return r;
  };
  const send = () =>
    optional(
      'delivery.send',
      { ids: [o.id] },
      (d) => {
        const res = (d?.results ?? []) as { ok: boolean; error?: string }[];
        const bad = res.filter((x) => !x.ok);
        if (bad.length) {
          toast(`${t('orders.bulk.notSent', { count: bad.length })} : ${bad[0].error ?? ''}`, 'bad');
          return null;
        }
        return t('orders.bulk.sent', { count: res.length || 1 });
      },
      (m) => t('orders.bulk.unavailable', { msg: m }),
    );

  const followChoices = (FOLLOW_STATUSES as readonly FollowStatus[]).filter((s) => s !== o.followStatus && canSetFollow(roles, s));
  const userName = (v: string | null) => (v ? users.data?.find((u) => String(u.id) === v)?.name ?? v : '—');
  const companyName = (v: string | null) => (v ? companies.find((c) => String(c.id) === v)?.name ?? v : '—');

  const actions: ReactNode[] = [];
  if (has('confirmation', 'suivi') && !shipped)
    actions.push(
      <button key="edit" className="btn small" onClick={() => openOrderForm({ orderId: o.id, onSaved: (id) => openOrder(id) })}>
        {t('orders.card.edit')}
      </button>,
    );
  if (has('confirmation') && !shipped)
    actions.push(
      <select
        key="conf"
        className="oc-sel"
        value=""
        aria-label={t('orders.card.changeConf')}
        onChange={(e) => {
          const s = e.target.value as ConfStatus;
          if (!s) return;
          if (s === 'confirmed' && !o.commune && !o.isStopdesk) {
            toast(t('orders.card.needAddress'), 'bad');
            return;
          }
          if (CONF_NEEDS_DATE.includes(s) || CONF_NEEDS_REASON.includes(s)) setPanel({ kind: 'conf', status: s });
          else if (s === 'confirmed' || s === 'no_stock') askRisk(o).then((ok) => {
              if (ok) run(() => rpc('orders.setConf', { ids: [o.id], status: s }), t(`status.conf.${s}`));
            });
          else run(() => rpc('orders.setConf', { ids: [o.id], status: s }), t(`status.conf.${s}`));
        }}
      >
        <option value="">{t('orders.card.changeConf')}</option>
        {CONF_CHOICES.filter((s) => s !== o.confStatus).map((s) => (
          <option key={s} value={s}>
            {t(`status.conf.${s}`)}
          </option>
        ))}
      </select>,
    );
  if (has('confirmation', 'suivi', 'depot') && o.confStatus === 'confirmed' && ['to_prepare', 'prepared', 'failed'].includes(o.followStatus ?? '') && !sent)
    actions.push(
      <button key="co" className="btn small primary" onClick={() => setPanel({ kind: 'company' })}>
        {o.companyId ? t('orders.card.changeCompany') : t('orders.card.chooseCompany')}
      </button>,
    );
  if (has('suivi', 'depot') && apiKind && !sent && o.confStatus === 'confirmed')
    actions.push(
      <button key="send" className="btn small ok" disabled={busy} onClick={send}>
        {t('orders.card.sendTo', { name: company!.name })}
      </button>,
    );
  if (sent && has('suivi', 'depot')) {
    actions.push(
      <button key="label" className="btn small" disabled={busy || printer.busy} onClick={() => printer.printOne(o)}>
        {t('orders.card.label')}
      </button>,
      <button
        key="st"
        className="btn small"
        disabled={busy}
        onClick={() => optional('delivery.sync', { ids: [o.id] }, (d) => (d?.changed ? t('orders.card.updated') : t('orders.card.noChange')), (m) => t('orders.syncUnavailable', { msg: m }))}
      >
        {t('orders.card.statusAt', { name: company!.name })}
      </button>,
    );
    if (has('suivi') && ['to_prepare', 'prepared', 'shipped'].includes(o.followStatus ?? ''))
      actions.push(
        <button key="cx" className="btn small danger ghost" onClick={() => setPanel({ kind: 'cancelParcel' })}>
          {t('orders.card.cancelParcel')}
        </button>,
      );
  }
  if (['confirmed', 'no_stock'].includes(o.confStatus) && followChoices.length && (has('suivi', 'depot') || roles.includes('livreur')))
    actions.push(
      <select
        key="follow"
        className="oc-sel"
        value=""
        aria-label={t('orders.card.changeFollow')}
        onChange={(e) => {
          const s = e.target.value as FollowStatus;
          if (!s) return;
          // a finished order (livrée, retournée…) only changes with a reason: the panel asks for it
          const finished = !!o.followStatus && o.followStatus !== 'cancelled' && FOLLOW_FINAL.includes(o.followStatus);
          if (finished || ['failed', 'returning', 'alert', 'lost'].includes(s)) setPanel({ kind: 'follow', status: s });
          else run(() => rpc('orders.setFollow', { ids: [o.id], status: s }), t(`status.follow.${s}`));
        }}
      >
        <option value="">{t('orders.card.changeFollow')}</option>
        {followChoices.map((s) => (
          <option key={s} value={s}>
            {t(`status.follow.${s}`)}
          </option>
        ))}
      </select>,
    );
  actions.push(
    <button key="note" className="btn small" onClick={() => setPanel({ kind: 'note' })}>
      {t('orders.card.note')}
    </button>,
  );
  if (has('confirmation', 'suivi'))
    actions.push(
      <button
        key="bl"
        className={`btn small ${o.blacklisted ? '' : 'warn'}`}
        disabled={busy}
        onClick={() => (o.blacklisted ? run(() => rpc('customers.setBlacklist', { id: o.customerId, on: false }), t('orders.card.blOff')) : setPanel({ kind: 'blacklist' }))}
      >
        {o.blacklisted ? t('orders.card.unblacklist') : t('orders.card.blacklist')}
      </button>,
    );
  if (has('confirmation', 'suivi') && ['delivered', 'exchanged'].includes(o.followStatus ?? ''))
    actions.push(
      <button key="ex" className="btn small" onClick={() => (closeModal(), startTicketFor(o.id))}>
        {t('orders.card.exchange')}
      </button>,
    );
  if (o.isExchange)
    actions.push(
      o.savRef ? (
        <TicketTag key="exc" savRef={o.savRef} />
      ) : (
        <span key="exc" className="chip">
          {t('orders.card.exchangeOf', { ref: o.originalOrderId ? `#${o.originalOrderId}` : '' })}
        </span>
      ),
    );
  actions.push(
    <button key="print" className="btn small" onClick={() => printOrder(t, o, look.data?.shopName ?? '')}>
      {t('orders.card.print')}
    </button>,
  );

  const tpl = look.data?.whatsappTemplate ?? '';
  const wa = waHref(o.phone, tpl, { nom: o.customerName, boutique: look.data?.shopName ?? '', ref: o.ref });
  const h = hist.data?.customer;

  return (
    <>
      <div className="statusbar">{actions}</div>
      {panel && (
        <ActionPanel
          o={o}
          panel={panel}
          busy={busy}
          companies={companies}
          onCancel={() => setPanel(null)}
          run={run}
          onSendAfter={async () => {
            await send();
          }}
        />
      )}

      <section className="card">
        <h3>{t('orders.card.client')}</h3>
        <div className="phone-row">
          <span className="phone-big ltr">{o.phone}</span>
          <a className="btn small primary" href={telHref(o.phone)} onClick={() => has('confirmation', 'suivi') && rpc('orders.logCall', { id: o.id }).catch(() => {})}>
            {t('orders.card.call')}
          </a>
          <a className="btn small" href={wa} target="_blank" rel="noopener noreferrer">
            {t('orders.card.message')}
          </a>
        </div>
        {o.phone2 && (
          <div className="phone-row">
            <span className="ltr">{o.phone2}</span>
            <a className="btn small" href={telHref(o.phone2)}>
              {t('orders.card.call')}
            </a>
          </div>
        )}
        <dl className="kv">
          <dt>{t('orders.card.name')}</dt>
          <dd>{o.customerName || '—'}</dd>
          <dt>{t('orders.card.address')}</dt>
          <dd>{[wilaya(o.wilayaId), o.commune, o.address].filter(Boolean).join(' · ') || '—'}</dd>
          {o.isStopdesk && (
            <>
              <dt>{t('orders.card.desk')}</dt>
              <dd>{t('common.yes')}</dd>
            </>
          )}
        </dl>
        {h && (
          <div className="oc-score">
            <ScoreCard s={h.score} compact />
          </div>
        )}
        {h && h.orders > 1 && (
          <>
            <div className={h.returned > 0 ? 'badbox' : 'okbox'} style={{ marginTop: 10, cursor: 'default' }}>
              {t('orders.card.history', { orders: h.orders, delivered: h.delivered, returned: h.returned, cancelled: h.cancelled })}
            </div>
            <button type="button" className="linkish oc-histmore" onClick={() => setShowHist((v) => !v)} aria-expanded={showHist}>
              {showHist ? t('orders.card.historyLess') : t('orders.card.historyMore', { n: hist.data?.orders.length ?? h.orders })}
              <Icon name="chevron" className={showHist ? 'flip' : ''} />
            </button>
            {showHist && (
              <ul className="oc-hist">
                {(hist.data?.orders ?? []).map((x) => (
                  <li key={x.id}>
                    <button type="button" className={x.id === o.id ? 'on' : ''} disabled={x.id === o.id} onClick={() => openOrder(x.id)}>
                      <span className="oc-hist-top">
                        <b className="ltr">{x.ref}</b>
                        <span className="muted small">{when(x.createdAt)}</span>
                        {x.id === o.id && <span className="chip">{t('orders.card.historyThis')}</span>}
                        <span className="grow" />
                        <span className="ltr">{da(x.total)}</span>
                      </span>
                      <span className="oc-hist-items small">{[x.itemsText, x.variantsText].filter(Boolean).join(' — ')}</span>
                      <span className="oc-hist-st">
                        <StatusBadge kind="conf" status={x.confStatus} />
                        {x.followStatus && <StatusBadge kind="follow" status={x.followStatus} />}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h3>{t('orders.card.products')}</h3>
        <div className="tbl-wrap">
          <table className="tbl oc-items">
            <tbody>
              {o.items.map((i) => (
                <tr key={i.id ?? `${i.productId}-${i.variantId}`}>
                  <td>
                    {i.name}
                    {i.variantTitle ? ` ${i.variantTitle}` : ''}
                    {i.isUpsell && <span className="chip" style={{ marginInlineStart: 6 }}>{t('orders.card.upsell')}</span>}
                  </td>
                  <td className="num ltr">
                    {i.qty} × {da(i.unitPrice)}
                  </td>
                  <td className="num ltr">{da(i.qty * i.unitPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="totals">
          <span className="muted">
            {t('orders.card.sum', { sub: da(o.subtotal), fee: da(o.deliveryFee) })}
            {o.discount ? t('orders.card.sumDiscount', { v: da(o.discount) }) : ''}
          </span>
          <span className="grand">{t('orders.card.toCollect', { v: da(o.total) })}</span>
        </div>
      </section>

      <AdSection o={o} />

      <section className="card">
        <h3>{t('orders.card.delivery')}</h3>
        <dl className="kv">
          <dt>{t('orders.card.company')}</dt>
          <dd>{o.companyName ?? t('orders.card.noCompany')}</dd>
          {o.livreurName && (
            <>
              <dt>{t('orders.card.livreur')}</dt>
              <dd>{o.livreurName}</dd>
            </>
          )}
          <dt>{t('orders.card.tracking')}</dt>
          <dd>
            <CopyCode code={trackOf(o)} />
          </dd>
          {o.extStatus && (
            <>
              <dt>{t('orders.card.extStatus')}</dt>
              <dd>{o.extStatus}</dd>
            </>
          )}
          {o.pay && (
            <>
              <dt>{t('orders.card.pay')}</dt>
              <dd>
                <span className="px-pay">
                  <span className={`badge t-${PAY_TONE[o.pay.step]}`}>{t(`orders.pay.${o.pay.step}`, { name: o.companyName ?? '' })}</span>
                  {(o.pay.at || o.pay.ref) && <small className="muted">{[o.pay.at ? dateOnly(o.pay.at) : null, o.pay.ref ? t('orders.pay.ref', { ref: o.pay.ref }) : null].filter(Boolean).join(' · ')}</small>}
                </span>
              </dd>
            </>
          )}
          {o.deliveryAttempts > 0 && (
            <>
              <dt>{t('orders.card.attempts')}</dt>
              <dd>{o.deliveryAttempts}</dd>
            </>
          )}
          {o.deliveryNote && (
            <>
              <dt>{t('orders.card.noteLivreur')}</dt>
              <dd>
                <b>{o.deliveryNote}</b>
              </dd>
            </>
          )}
          {o.customerNote && (
            <>
              <dt>{t('orders.card.noteClient')}</dt>
              <dd>{o.customerNote}</dd>
            </>
          )}
          {o.internalNote && (
            <>
              <dt>{t('orders.card.noteTeam')}</dt>
              <dd>{o.internalNote}</dd>
            </>
          )}
        </dl>
      </section>

      {sent && <CourierPanel o={o} phone={isPhone} />}

      <section className="card">
        <h3>{t('orders.card.timeline')}</h3>
        {!events ? (
          <Loading />
        ) : (
          <ul className="timeline">
            {[...events].reverse().map((e) => (
              <li key={e.id}>
                <span className="t">{when(e.at)}</span>
                <span>
                  {eventText(t, e, userName, companyName)}
                  {e.userName && <span className="muted"> — {e.userName}</span>}
                  {e.note && <div className="muted">{e.note}</div>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export function eventText(t: (k: string, o?: any) => string, e: OrderEvent, user: (v: string | null) => string, company: (v: string | null) => string): string {
  const conf = (v: string | null) => (v ? t(`status.conf.${v}`, { defaultValue: v }) : '');
  const fol = (v: string | null) => (v ? t(`status.follow.${v}`, { defaultValue: v }) : '');
  switch (e.kind) {
    case 'created':
      return t('orders.card.ev.created');
    case 'conf_status':
      return t('orders.card.ev.conf_status') + (e.fromValue ? `${conf(e.fromValue)} → ` : '') + conf(e.toValue);
    case 'follow_status':
      return t('orders.card.ev.follow_status') + (e.fromValue ? `${fol(e.fromValue)} → ` : '') + fol(e.toValue);
    case 'assign':
      return `${t('orders.card.ev.assign')} : ${user(e.toValue)}`;
    case 'company':
      return `${t('orders.card.ev.company')} : ${e.fromValue ? `${company(e.fromValue)} → ` : ''}${company(e.toValue)}`;
    case 'sub_status':
      return t('orders.card.ev.sub_status') + (e.toValue ?? '—');
    case 'suivi_stuck':
      return e.note ?? t('orders.card.ev.suivi_stuck');
    case 'suivi_motif':
      return t(`orders.card.ev.motif_${e.fromValue === 'lost' ? 'lost' : 'resolved'}`, { m: e.note ?? e.toValue ?? '' });
    case 'chat': {
      // Delivery AI agent: what was sent to the customer (channel → case), or the customer's answer
      if (!e.fromValue) return t('orders.card.ev.chat');
      const via = t(`notify.via.${e.fromValue}`, { defaultValue: e.fromValue });
      return e.toValue === 'reply' ? t('notify.ev.reply', { via }) : t('notify.ev.sent', { via, kind: t(`notify.kind.${e.toValue}`, { defaultValue: e.toValue ?? '' }) });
    }
    default:
      return t(`orders.card.ev.${e.kind}`, { defaultValue: e.kind });
  }
}

/** The small step shown under the action bar (date, reason, company, note…), instead of a browser prompt. */
function ActionPanel({ o, panel, busy, companies, onCancel, run, onSendAfter }: {
  o: Order;
  panel: Exclude<Panel, null>;
  busy: boolean;
  companies: { id: number; name: string; kind: string; active: boolean }[];
  onCancel: () => void;
  run: (fn: () => Promise<unknown>, ok?: string) => Promise<void>;
  onSendAfter: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [date, setDate] = useState(() => {
    if (panel.kind === 'conf' && panel.status === 'callback') return toLocalInput(Date.now() + 2 * 3_600_000);
    return `${toLocalInput(Date.now() + 86_400_000).slice(0, 10)}T10:00`;
  });
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [co, setCo] = useState<string>(o.companyId ? String(o.companyId) : '');
  const [sendNow, setSendNow] = useState(true);
  const coKind = companies.find((c) => String(c.id) === co)?.kind;
  const reasons = useMemo(() => {
    if (panel.kind === 'conf' && panel.status === 'cancelled') return CANCEL_REASONS.map((r) => t(`status.cancelReason.${r}`));
    if (panel.kind === 'conf' && panel.status === 'fake') return FAKE_REASONS.map((r) => t(`status.fakeReason.${r}`));
    if (panel.kind === 'follow' && panel.status === 'failed') return FAIL_REASONS.map((r) => t(`status.failReason.${r}`));
    if (panel.kind === 'follow' && panel.status === 'returning') return RETURN_REASONS.map((r) => t(`status.returnReason.${r}`));
    return [];
  }, [panel, t]);

  let title = '';
  let body: ReactNode = null;
  let submit: (() => void) | null = null;
  let okLabel = t('common.save');
  let danger = false;
  if (panel.kind === 'conf') {
    title = `${t(`status.conf.${panel.status}`)} — ${o.ref}`;
    const needsDate = CONF_NEEDS_DATE.includes(panel.status);
    body = (
      <>
        {needsDate && (
          <Field label={t(`orders.card.when.${panel.status}`)}>
            <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        )}
        {reasons.length > 0 && (
          <Field label={t('orders.card.cancelReason')}>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">{t('orders.card.choose')}</option>
              {reasons.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('common.note')}>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={needsDate ? t('orders.card.notePh') : t('orders.card.detail')} />
        </Field>
      </>
    );
    danger = !needsDate;
    okLabel = needsDate ? t('common.save') : t(`status.conf.${panel.status}`);
    submit = () => {
      if (reasons.length && !reason) return toast(t('orders.card.cancelReason'), 'bad');
      const r = reason || (CONF_NEEDS_REASON.includes(panel.status) ? note.trim() || t(`status.conf.${panel.status}`) : null);
      run(() => rpc('orders.setConf', { ids: [o.id], status: panel.status, nextCallAt: needsDate ? fromLocalInput(date) : null, reason: r, note: reason ? note.trim() || null : null }), t(`status.conf.${panel.status}`));
    };
  } else if (panel.kind === 'follow') {
    title = `${t(`status.follow.${panel.status}`)} — ${o.ref}`;
    body = (
      <>
        {reasons.length > 0 && (
          <Field label={t('orders.card.reason')}>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">{t('orders.card.choose')}</option>
              {reasons.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('common.note')}>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('orders.card.detail')} />
        </Field>
      </>
    );
    submit = () => {
      const finished = !!o.followStatus && o.followStatus !== 'cancelled' && FOLLOW_FINAL.includes(o.followStatus);
      if (finished && !reason && !note.trim()) return toast(t('orders.card.finishedReason'), 'bad');
      run(() => rpc('orders.setFollow', { ids: [o.id], status: panel.status, reason: reason || null, note: note.trim() || null }), t(`status.follow.${panel.status}`));
    };
  } else if (panel.kind === 'company') {
    title = t('orders.card.companyTitle');
    okLabel = t('orders.card.assign');
    body = (
      <>
        <Field label={t('orders.card.companyField')}>
          <select value={co} onChange={(e) => setCo(e.target.value)}>
            <option value="">{t('orders.card.choose')}</option>
            {companies
              .filter((c) => c.active)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </Field>
        {coKind && API_KINDS.includes(coKind) && (
          <label className="check">
            <input type="checkbox" checked={sendNow} onChange={(e) => setSendNow(e.target.checked)} />
            {t('orders.card.sendNow')}
          </label>
        )}
      </>
    );
    submit = () => {
      if (!co) return;
      run(async () => {
        await rpc('orders.assignCompany', { ids: [o.id], companyId: Number(co) });
        if (coKind && API_KINDS.includes(coKind) && sendNow) await onSendAfter();
      }, t('orders.bulk.assigned', { count: 1 }));
    };
  } else if (panel.kind === 'note') {
    title = t('orders.card.addNote');
    okLabel = t('orders.card.add');
    body = (
      <Field label={t('common.note')}>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      </Field>
    );
    submit = () => note.trim() && run(() => rpc('orders.note', { id: o.id, note: note.trim() }), t('orders.card.noteSaved'));
  } else if (panel.kind === 'blacklist') {
    title = `${t('orders.card.blacklist')} — ${o.phone}`;
    okLabel = t('orders.card.blacklist');
    danger = true;
    body = (
      <Field label={t('orders.card.blReason')}>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('orders.card.blReasonPh')} autoFocus />
      </Field>
    );
    submit = () => run(() => rpc('customers.setBlacklist', { id: o.customerId, on: true, reason: note.trim() || null }), t('orders.card.blOn'));
  } else if (panel.kind === 'cancelParcel') {
    const name = o.companyName ?? '';
    title = `${t('orders.card.cancelParcel')} ${o.tracking ?? ''} ?`;
    okLabel = t('orders.card.cancelParcel');
    danger = true;
    body = <p className="muted">{t('orders.card.cancelConfirm', { co: name })}</p>;
    submit = () =>
      run(async () => {
        const r = await callOptional('delivery.cancel', { orderId: o.id });
        if (!r.ok) throw new Error(t('orders.bulk.unavailable', { msg: r.error }));
        const first = (r.data?.results ?? [])[0];
        if (first && !first.ok) throw new Error(first.error);
      }, t('orders.card.cancelled', { co: name }));
  }

  return (
    <section className="card" style={{ borderColor: 'var(--navy)' }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit?.();
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <h3 style={{ margin: 0 }}>{title}</h3>
        {body}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn small" onClick={onCancel}>
            {t('orders.card.back')}
          </button>
          <button type="submit" className={`btn small ${danger ? 'danger' : 'primary'}`} disabled={busy}>
            {okLabel}
          </button>
        </div>
      </form>
    </section>
  );
}

