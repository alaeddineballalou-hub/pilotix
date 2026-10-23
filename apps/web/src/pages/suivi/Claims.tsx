import type { Order } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { since, when } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { copyText, Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { claimText, ClaimCompany, waLink } from './common';
import { trackOf } from '../../lib/items';

export const CLAIM_REASONS = ['relivrer', 'late', 'nocall', 'fakedeliv', 'fakeret', 'address', 'damaged', 'money', 'noreturn', 'other'] as const;
type Reason = (typeof CLAIM_REASONS)[number];
type Via = 'whatsapp' | 'email' | 'copy' | 'phone';
const STATUS_TONE: Record<string, string> = { waiting: 't-warn', still_waiting: 't-bad', resolved: 't-ok' };

interface Target {
  name: string;
  wa: string | null;
  email: string | null;
  phone: string | null;
}

/** Who receives the claim of an order: its courier's claim desk, or our own livreur. */
export function useTarget(o: Order | null, toLivreur: boolean) {
  const c = useRpc('suivi.contacts', {}).data;
  if (!o || !c) return { target: null as Target | null, shop: c?.shopName ?? '', own: false, api: false };
  const comp = c.companies.find((x: ClaimCompany) => x.id === o.companyId);
  const own = toLivreur || comp?.kind === 'own';
  if (own) {
    const lv = c.livreurs.find((l: { id: number }) => l.id === o.livreurId);
    return { target: { name: lv?.name ?? o.livreurName ?? '—', wa: lv?.phone ?? null, email: null, phone: lv?.phone ?? null }, shop: c.shopName, own, api: false };
  }
  return { target: comp ? { name: comp.name, wa: comp.wa, email: comp.email, phone: comp.phone } : null, shop: c.shopName, own, api: !!comp?.api && !!trackOf(o) };
}

/** Step 1: choose the order and the problem → the claim is saved, then step 2: send it. */
export function NewClaimModal({ pre, toLivreur = false, reason = 'late', details = '', onClose }: { pre?: Order | null; toLivreur?: boolean; reason?: Reason; details?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [o, setO] = useState<Order | null>(pre ?? null);
  const [q, setQ] = useState(pre ? trackOf(pre) || pre.ref : '');
  const [deb, setDeb] = useState('');
  const [mot, setMot] = useState<Reason>(reason);
  const [det, setDet] = useState(details);
  const [err, setErr] = useState('');
  const [made, setMade] = useState<SentClaim | null>(null);
  const [cat, setCat] = useState('');
  const { target, shop, own, api } = useTarget(o, toLivreur);
  const cats = useRpc('suivi.claimCategories', { companyId: o?.companyId ?? 0 }, { enabled: api && !!o?.companyId, staleTime: 600_000 });
  useEffect(() => {
    const h = setTimeout(() => setDeb(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);
  const res = useRpc('suivi.findOrders', { q: deb }, { enabled: deb.length >= 2 && !o });
  const list = res.data ?? [];
  const create = useAction('suivi.claimCreate', {
    onDone: (c) => {
      if (c.extId) {
        toast(t('suivi.rec.apiSent', { ref: c.ref, name: c.companyName ?? '', n: c.extRef ?? '' }), 'ok');
        onClose();
      } else setMade(c);
    },
  });

  // copy the tracking when opened from an alert (the courier desk asks for it first)
  useEffect(() => {
    if (pre && trackOf(pre) && !toLivreur) copyText(trackOf(pre)).then((ok) => ok && toast(t('suivi.rec.copiedTracking', { v: trackOf(pre) }), 'ok'));
  }, [pre, toLivreur, t]);

  if (made && o) return <SendModal claim={made} order={o} target={target ?? { name: o.companyName ?? o.livreurName ?? '—', wa: null, email: null, phone: null }} shop={shop} again={false} onClose={onClose} />;
  const prepare = () => {
    setErr('');
    if (!o) return setErr(t('suivi.rec.chooseOrder'));
    const message = claimText(t, { ref: '…', reason: mot, details: det.trim() }, o, target?.name ?? '', shop);
    create.mutate({ orderId: o.id, reason: mot, details: det.trim(), message, channel: 'whatsapp', toLivreur: own, viaApi: api, categoryId: api && cat ? cat : null });
  };
  return (
    <Modal
      wide
      title={t('suivi.rec.newTitle')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={create.isPending} onClick={prepare}>
            {api && <Icon name="send" />}
            {create.isPending && api ? t('suivi.rec.apiSending', { name: target?.name ?? '' }) : api ? t('suivi.rec.apiSend', { name: target?.name ?? '' }) : t('suivi.rec.prepare')}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label className="field">
          <span className="lab">{t('suivi.rec.order')}</span>
          <input type="search" value={q} autoComplete="off" placeholder={t('suivi.rec.orderPh')} onChange={(e) => (setQ(e.target.value), setO(null))} autoFocus />
        </label>
        {!o && deb.length >= 2 && (
          <div className="bjr-pick">
            {res.isFetching && !res.data ? (
              <Loading />
            ) : list.length ? (
              list.map((x) => (
                <button key={x.id} type="button" onClick={() => (setO(x), setQ(x.ref))}>
                  <b>
                    <span className="ltr">{x.ref}</span> · {x.customerName}
                  </b>
                  <span className="badge t-info">{x.followStatus ? t(`status.follow.${x.followStatus}`) : '—'}</span>
                  <small>
                    {t('suivi.rec.tracking', { v: trackOf(x) || '—' })} · {x.companyName || x.livreurName || ''}
                  </small>
                </button>
              ))
            ) : (
              <p className="muted small">{t('suivi.rec.noOrder')}</p>
            )}
          </div>
        )}
        {o && (
          <div className="bjr-sum">
            <b className="ltr">{o.ref}</b>
            <span>{t('suivi.rec.tracking', { v: trackOf(o) || '—' })}</span>
            <span>{own ? o.livreurName : o.companyName || t('suivi.rec.noCompany')}</span>
            <span>{o.customerName}</span>
            <span className="ltr">{o.phone}</span>
            {o.followStatus && <span className="badge t-info">{t(`status.follow.${o.followStatus}`)}</span>}
          </div>
        )}
        <label className="field">
          <span className="lab">{t('suivi.rec.problem')}</span>
          <select value={mot} onChange={(e) => setMot(e.target.value as Reason)}>
            {CLAIM_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`suivi.rec.reasons.${r}`)}
              </option>
            ))}
          </select>
        </label>
        {api && (
          <label className="field">
            <span className="lab">{t('suivi.rec.apiCategory', { name: target?.name ?? '' })}</span>
            <select value={cat} onChange={(e) => setCat(e.target.value)} disabled={cats.isLoading}>
              <option value="">{t('suivi.rec.apiCategoryAuto')}</option>
              {(cats.data ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span className="lab">{t('suivi.rec.details')}</span>
          <textarea value={det} placeholder={t('suivi.rec.detailsPh')} onChange={(e) => setDet(e.target.value)} />
        </label>
        {api && <p className="muted small">{t('suivi.rec.apiHelp', { name: target?.name ?? '' })}</p>}
        {err && <p className="form-err">{err}</p>}
      </div>
    </Modal>
  );
}

interface SentClaim {
  id: number;
  ref: string;
  reason: string;
  details: string;
  viaApi?: boolean;
  extId?: string | null;
  extRef?: string | null;
  extError?: string | null;
  companyName?: string | null;
}

/** Step 2: the message, editable, sent by WhatsApp / e-mail / copy; each way is written in the claim history. */
export function SendModal({ claim, order, target, shop, again, onClose }: { claim: SentClaim; order: Order | null; target: Target; shop: string; again: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const push = useAction('suivi.claimPush', {
    onDone: (c) => {
      if (c.extId) {
        toast(t('suivi.rec.apiSent', { ref: c.ref, name: c.companyName ?? '', n: c.extRef ?? '' }), 'ok');
        onClose();
      } else toast(c.extError ?? t('suivi.rec.apiFailed', { name: target.name }), 'bad');
    },
  });
  const [text, setText] = useState(() => claimText(t, claim, order, target.name, shop, again));
  const [done, setDone] = useState(false);
  const upd = useAction('suivi.claimUpdate', { silent: true });
  const mark = (via: Via) => {
    if (done) return;
    setDone(true);
    upd.mutate({ id: claim.id, sentVia: via, message: text }, { onSuccess: () => toast(again ? t('suivi.rec.reminded', { ref: claim.ref }) : t('suivi.rec.sent', { ref: claim.ref, name: target.name }), 'ok') });
  };
  const lines = text.split('\n');
  return (
    <Modal
      wide
      title={t('suivi.rec.sendTitle', { name: target.name })}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {claim.viaApi && !claim.extId && (
          <div className="warnbox">
            <b>{t('suivi.rec.apiRefused', { name: target.name })}</b>
            {claim.extError && <div className="small">{claim.extError}</div>}
            <div style={{ marginTop: 8 }}>
              <button type="button" className="btn primary" disabled={push.isPending} onClick={() => push.mutate({ id: claim.id })}>
                <Icon name="refresh" />
                {t('suivi.rec.apiRetry', { name: target.name })}
              </button>
            </div>
          </div>
        )}
        <p className="muted small">{t('suivi.rec.sendHelp', { name: target.name })}</p>
        <textarea className="bjr-msg" value={text} onChange={(e) => setText(e.target.value)} aria-label={t('suivi.rec.sendTitle', { name: target.name })} />
        <div className="bjr-acts">
          <a className="btn bjr-wa" href={waLink(target.wa, text)} target="_blank" rel="noopener noreferrer" onClick={() => mark('whatsapp')}>
            <Icon name="whatsapp" />
            {t('suivi.rec.wa')}
          </a>
          {target.email && (
            <a className="btn" href={`mailto:${encodeURIComponent(target.email)}?subject=${encodeURIComponent(lines[1] || 'Réclamation')}&body=${encodeURIComponent(text)}`} onClick={() => mark('email')}>
              <Icon name="message" />
              {t('suivi.rec.mail')}
            </a>
          )}
          <button type="button" className="btn" onClick={async () => (await copyText(text), toast(t('common.copied'), 'ok'), mark('copy'))}>
            <Icon name="copy" />
            {t('suivi.rec.copy')}
          </button>
          {target.phone && (
            <a className="btn" href={`tel:${target.phone}`}>
              <Icon name="phone" />
              {t('suivi.rec.callN', { v: target.phone })}
            </a>
          )}
        </div>
        {!target.wa && !target.email && <div className="warnbox">{t('suivi.rec.noContact', { name: target.name })}</div>}
      </div>
    </Modal>
  );
}

export interface ClaimRow {
  id: number;
  ref: string;
  orderId: number | null;
  orderRef: string | null;
  tracking: string | null;
  companyName: string | null;
  livreurName: string | null;
  livreurPhone: string | null;
  companyId: number | null;
  reason: string;
  details: string;
  status: 'waiting' | 'still_waiting' | 'resolved';
  notes: { at: string; text: string; status?: string | null }[];
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  viaApi: boolean;
  extId: string | null;
  extRef: string | null;
  extStatus: string | null;
  extAnswer: string | null;
  extError: string | null;
}

/** Relance of a claim created at the courier through its API: the text is added to the courier's claim as a comment. */
export function RemindApiModal({ c, onClose }: { c: ClaimRow; onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => t('suivi.rec.apiRemindText', { tracking: trackOf(c) || c.orderRef || '' }));
  const send = useAction('suivi.claimRemind', { success: t('suivi.rec.apiReminded', { name: c.companyName ?? '' }), onDone: onClose });
  return (
    <Modal
      title={t('suivi.rec.apiRemindTitle', { ref: c.ref, name: c.companyName ?? '' })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={send.isPending || !text.trim()} onClick={() => send.mutate({ id: c.id, text: text.trim() })}>
            <Icon name="send" />
            {t('suivi.rec.apiSend', { name: c.companyName ?? '' })}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {c.extAnswer && (
          <div className="bjr-ans">
            <b>{t('suivi.rec.apiLastAnswer', { name: c.companyName ?? '' })}</b>
            <div>{c.extAnswer}</div>
          </div>
        )}
        <textarea className="bjr-msg" value={text} onChange={(e) => setText(e.target.value)} aria-label={t('suivi.rec.apiRemindTitle', { ref: c.ref, name: c.companyName ?? '' })} />
        <p className="muted small">{t('suivi.rec.apiRemindHelp', { name: c.companyName ?? '' })}</p>
      </div>
    </Modal>
  );
}

function AnswerModal({ c, name, onClose }: { c: ClaimRow; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [st, setSt] = useState<ClaimRow['status']>(c.status === 'waiting' ? 'still_waiting' : c.status === 'still_waiting' ? 'resolved' : c.status);
  const upd = useAction('suivi.claimUpdate', { success: t('suivi.rec.updated'), onDone: onClose });
  return (
    <Modal
      title={t('suivi.rec.answerTitle', { ref: c.ref, name })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={upd.isPending} onClick={() => upd.mutate({ id: c.id, status: st !== c.status ? st : undefined, note: note.trim() ? `${t('suivi.rec.answerLab')} : ${note.trim()}` : undefined })}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <label className="field">
          <span className="lab">{t('suivi.rec.answerLab')}</span>
          <textarea value={note} placeholder={t('suivi.rec.answerPh')} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label className="field">
          <span className="lab">{t('suivi.rec.statusLab')}</span>
          <select value={st} onChange={(e) => setSt(e.target.value as ClaimRow['status'])}>
            {(['waiting', 'still_waiting', 'resolved'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`suivi.rec.status.${s}`)}
              </option>
            ))}
          </select>
        </label>
        <details open>
          <summary>{t('suivi.rec.history')}</summary>
          <ul className="timeline" style={{ marginTop: 8 }}>
            {[...c.notes].reverse().map((n, i) => (
              <li key={i}>
                <span className="t">{when(n.at)}</span>
                <div>{n.text}</div>
              </li>
            ))}
          </ul>
        </details>
      </div>
    </Modal>
  );
}

/** Claims to the couriers (target company) or to our livreurs (target livreur). */
export function ClaimsPanel({ target }: { target: 'company' | 'livreur' }) {
  const { t } = useTranslation();
  const [filt, setFilt] = useState<'open' | 'waiting' | 'still_waiting' | 'resolved' | 'all'>('open');
  const q = useRpc('suivi.claims', { target, status: filt });
  const contacts = useRpc('suivi.contacts', {}).data;
  const [dlg, setDlg] = useState<{ kind: 'new' } | { kind: 'answer'; c: ClaimRow } | { kind: 'send'; c: ClaimRow; order: Order } | { kind: 'remindApi'; c: ClaimRow } | null>(null);
  const sync = useAction('suivi.claimSync', { silent: true });
  const push = useAction('suivi.claimPush', { onDone: (c) => toast(c.extId ? t('suivi.rec.apiSent', { ref: c.ref, name: c.companyName ?? '', n: c.extRef ?? '' }) : c.extError ?? t('suivi.rec.apiFailed', { name: c.companyName ?? '' }), c.extId ? 'ok' : 'bad') });
  const hasApi = target === 'company' && !!contacts?.companies.some((x: ClaimCompany) => x.api);
  // read back ZR's answers once when the list opens
  useEffect(() => {
    if (hasApi) sync.mutate({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasApi]);
  const rows = (q.data?.rows ?? []) as ClaimRow[];
  const counts = q.data?.counts ?? {};
  const late = (c: ClaimRow) => c.status !== 'resolved' && Date.now() - Date.parse(c.updatedAt) > 48 * 3_600_000;
  const nameOf = (c: ClaimRow) => (target === 'livreur' ? c.livreurName : c.companyName) ?? '—';
  const remind = async (c: ClaimRow) => {
    if (c.extId) return setDlg({ kind: 'remindApi', c });
    if (!c.orderId) return;
    try {
      setDlg({ kind: 'send', c, order: await rpc('orders.get', { id: c.orderId }) });
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };
  const targetOf = (c: ClaimRow): Target => {
    if (target === 'livreur') return { name: c.livreurName ?? '—', wa: c.livreurPhone, email: null, phone: c.livreurPhone };
    const comp = contacts?.companies.find((x: ClaimCompany) => x.id === c.companyId);
    return { name: c.companyName ?? '—', wa: comp?.wa ?? null, email: comp?.email ?? null, phone: comp?.phone ?? null };
  };
  const wk = Date.now() - 7 * 86_400_000;
  const resolved7 = rows.filter((c) => c.status === 'resolved' && Date.parse(c.updatedAt) >= wk).length;
  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>{t(target === 'company' ? 'suivi.rec.companiesTitle' : 'suivi.rec.livreursTitle')}</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {hasApi && (
              <button
                className="btn"
                disabled={sync.isPending}
                onClick={() => sync.mutate({}, { onSuccess: (r) => toast(r.errors.length ? r.errors[0] : t('suivi.rec.apiSynced', { n: r.changed }), r.errors.length ? 'bad' : 'ok') })}
              >
                <Icon name="refresh" />
                {sync.isPending ? t('suivi.rec.apiSyncing') : t('suivi.rec.apiSync')}
              </button>
            )}
            <button className="btn primary" onClick={() => setDlg({ kind: 'new' })}>
              {t('suivi.rec.new')}
            </button>
          </div>
        </div>
        <p className="muted small">{t(target === 'company' ? 'suivi.rec.companiesHelp' : 'suivi.rec.livreursHelp')}</p>
      </div>
      <div className="kpis">
        <div className="kpi">
          <span className="l">{t('suivi.rec.kWaiting')}</span>
          <span className="v ltr">{counts.open ?? '—'}</span>
          <span className="s">{t('suivi.rec.kWaitingSub')}</span>
        </div>
        <div className={`kpi${rows.some(late) ? ' t-bad' : ''}`}>
          <span className="l">{t('suivi.rec.kLate')}</span>
          <span className="v ltr">{filt === 'open' || filt === 'all' ? rows.filter(late).length : '—'}</span>
          <span className="s">{t('suivi.rec.kLateSub')}</span>
        </div>
        <div className="kpi t-ok">
          <span className="l">{t('suivi.rec.kResolved')}</span>
          <span className="v ltr">{filt === 'resolved' || filt === 'all' ? resolved7 : counts.resolved ?? '—'}</span>
          <span className="s"> </span>
        </div>
      </div>
      <div className="card">
        <div className="bjp-tabs">
          {(['open', 'still_waiting', 'resolved', 'all'] as const).map((k) => (
            <button key={k} type="button" className={`tab${filt === k ? ' on' : ''}`} onClick={() => setFilt(k)}>
              {t(`suivi.rec.filters.${k}`)} <b className="ltr">{counts[k] ?? 0}</b>
            </button>
          ))}
        </div>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !rows.length ? (
          <Empty>{filt === 'open' ? t('suivi.rec.emptyOpen') : t('suivi.rec.empty')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl bjr-tbl">
              <thead>
                <tr>
                  <th>{t('suivi.rec.col.claim')}</th>
                  <th>{t('suivi.rec.col.order')}</th>
                  <th>{t(target === 'company' ? 'suivi.rec.col.company' : 'suivi.rec.col.livreur')}</th>
                  <th className="wide">{t('suivi.rec.col.problem')}</th>
                  <th>{t('suivi.rec.col.sent')}</th>
                  <th>{t('suivi.rec.col.status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => {
                  const last = c.notes[c.notes.length - 1];
                  return (
                    <tr key={c.id} className="clickable" onClick={() => c.orderId && openOrder(c.orderId)}>
                      <td data-l={t('suivi.rec.col.claim')}>
                        <b className="ltr">{c.ref}</b>
                        <small>{when(c.createdAt)}</small>
                      </td>
                      <td data-l={t('suivi.rec.col.order')}>
                        <b className="ltr">{c.orderRef ?? '—'}</b>
                        <small>{t('suivi.rec.tracking', { v: trackOf(c) || '—' })}</small>
                      </td>
                      <td data-l={t(target === 'company' ? 'suivi.rec.col.company' : 'suivi.rec.col.livreur')}>{nameOf(c)}</td>
                      <td className="wide" data-l={t('suivi.rec.col.problem')}>
                        {t(`suivi.rec.reasons.${c.reason}`, { defaultValue: c.reason })}
                        {last?.text && <small>{last.text}</small>}
                      </td>
                      <td data-l={t('suivi.rec.col.sent')}>
                        {c.sentAt ? <span className={late(c) ? 'bjr-late' : undefined}>{since(c.updatedAt)}</span> : <span className="muted small">{t('suivi.rec.notSent')}</span>}
                        {c.extId ? (
                          <small className="bjr-api" title={c.extAnswer ?? undefined}>
                            {t('suivi.rec.apiNo', { name: c.companyName ?? '', n: c.extRef || '✓' })}
                            {c.extStatus && ` · ${c.extStatus}`}
                          </small>
                        ) : (
                          c.viaApi && c.extError && <small className="bjr-api bad" title={c.extError}>{t('suivi.rec.apiRefusedShort', { name: c.companyName ?? '' })}</small>
                        )}
                      </td>
                      <td data-l={t('suivi.rec.col.status')}>
                        <span className={`badge ${STATUS_TONE[c.status]}`}>{t(`suivi.rec.status.${c.status}`)}</span>
                      </td>
                      <td className="bjr-a" onClick={(e) => e.stopPropagation()}>
                        {c.viaApi && !c.extId && c.status !== 'resolved' && (c.extError || !c.sentAt) && (
                          <button type="button" className="bjp-ib" disabled={push.isPending} title={t(c.extError ? 'suivi.rec.apiRetry' : 'suivi.rec.apiSend', { name: c.companyName ?? '' })} aria-label={t(c.extError ? 'suivi.rec.apiRetry' : 'suivi.rec.apiSend', { name: c.companyName ?? '' })} onClick={() => push.mutate({ id: c.id })}>
                            <Icon name="send" />
                          </button>
                        )}
                        {c.status !== 'resolved' &&
                          (c.extId ? (
                            <button type="button" className="bjp-ib" title={t('suivi.rec.apiRemind', { name: c.companyName ?? '' })} aria-label={t('suivi.rec.apiRemind', { name: c.companyName ?? '' })} onClick={() => remind(c)}>
                              <Icon name="chat" />
                            </button>
                          ) : (
                            <button type="button" className="bjp-ib bjr-ib-w" title={t('suivi.rec.remind')} aria-label={t('suivi.rec.remind')} onClick={() => remind(c)}>
                              <Icon name="whatsapp" />
                            </button>
                          ))}
                        <button type="button" className="bjp-ib bjp-ib-e" title={t('suivi.rec.answer')} aria-label={t('suivi.rec.answer')} onClick={() => setDlg({ kind: 'answer', c })}>
                          <Icon name="pencil" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {dlg?.kind === 'new' && <NewClaimModal toLivreur={target === 'livreur'} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'remindApi' && <RemindApiModal c={dlg.c} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'answer' && <AnswerModal c={dlg.c} name={nameOf(dlg.c)} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'send' && <SendModal claim={dlg.c} order={dlg.order} target={targetOf(dlg.c)} shop={contacts?.shopName ?? ''} again={!!dlg.c.sentAt} onClose={() => setDlg(null)} />}
    </>
  );
}
