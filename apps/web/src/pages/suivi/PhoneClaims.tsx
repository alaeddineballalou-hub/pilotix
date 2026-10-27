// Réclamations on a phone: the new claim as a sheet (the problem in one tap, « Envoyer à ZR » at the thumb), the message
// to send for couriers without an API (WhatsApp first), the relance, the answer — and Suivi › Réclamation as an inbox
// of cards with ZR's answers and one-tap actions.
import type { Order } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { since, when } from '../../lib/format';
import { trackOf } from '../../lib/items';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { Icon, Loading } from '../../ui/kit';
import { Options, Seg, Sheet } from '../../ui/Sheet';
import { toast } from '../../ui/toast';
import { CLAIM_REASONS, ClaimFormProps, ClaimRow, REASON_ICON, SentClaim, Target, useClaimForm, useSendClaim } from './claimKit';
import { ClaimCompany, waLink } from './common';
import { ChangeSheet, useParcelInfo } from './CourierPanel';

const sub = (o: Order) => (
  <>
    <span className="ltr">{o.ref}</span>
    {trackOf(o) ? (
      <>
        {' '}
        · <span className="ltr">{trackOf(o)}</span>
      </>
    ) : null}{' '}
    · {o.customerName}
  </>
);

/** A new réclamation on a phone. Opened from a parcel the order is known; from the inbox it is searched first. */
export function ClaimSheet(p: ClaimFormProps) {
  const { t } = useTranslation();
  const f = useClaimForm(p);
  const [zr, setZr] = useState(false);
  const { o, target, api, own } = f;
  // « Changer l'adresse ou le téléphone » at ZR: it is a modification request, made right here
  const zrInfo = useParcelInfo(o ?? ({ id: 0 } as Order), !!o && api && f.mot === 'address').data;
  if (f.made && o) return <SendSheet claim={f.made} order={o} target={target ?? { name: o.companyName ?? o.livreurName ?? '—', wa: null, email: null, phone: null }} shop={f.shop} again={false} onClose={p.onClose} />;
  if (zr && o) return <ChangeSheet o={o} kind={o.isStopdesk ? 'phone' : 'address'} onClose={p.onClose} />;
  const name = target?.name ?? o?.companyName ?? o?.livreurName ?? '';
  const busy = f.create.isPending;
  return (
    <Sheet
      tall={!o}
      title={!o ? t('suivi.rec.newTitle') : own ? t('suivi.rec.ph.titleLivreur', { name }) : t('suivi.rec.ph.title', { name })}
      sub={o ? sub(o) : undefined}
      onClose={p.onClose}
      foot={
        <>
          <button type="button" className="pxk-go" disabled={busy || !o} onClick={f.prepare}>
            <Icon name={api ? 'send' : 'message'} className="flip" />
            {busy && api ? t('suivi.rec.apiSending', { name }) : api ? t('suivi.rec.apiSend', { name }) : t('suivi.rec.prepare')}
          </button>
          {o && <p className="pxk-fnote">{api ? t('suivi.rec.apiHelp', { name }) : t('suivi.rec.ph.footMsg')}</p>}
        </>
      }
    >
      {!p.pre &&
        (o ? (
          <div className="pxk-pc">
            <span>
              <b>
                <span className="ltr">{o.ref}</span> · {o.customerName}
              </b>
              <small>
                <span className="ltr">{trackOf(o) || '—'}</span> · {o.companyName || o.livreurName || t('suivi.rec.noCompany')}
              </small>
            </span>
            <button type="button" className="pxk-chip" onClick={() => f.search('')}>
              {t('suivi.rec.ph.otherOrder')}
            </button>
          </div>
        ) : (
          <label className="pxk-q">
            <b>{t('suivi.rec.order')}</b>
            <input className="pxk-in" type="search" aria-label={t('suivi.rec.orderPh')} value={f.q} autoComplete="off" placeholder={t('suivi.rec.orderPh')} onChange={(e) => f.search(e.target.value)} />
          </label>
        ))}
      {!o && f.deb.length >= 2 && (
        <div className="pxk-opts">
          {f.searching ? (
            <Loading />
          ) : f.found.length ? (
            f.found.map((x) => (
              <button key={x.id} type="button" className="pxk-opt" onClick={() => f.choose(x)}>
                <Icon name="package" />
                <span>
                  <span>
                    <b className="ltr">{x.ref}</b> · {x.customerName}
                  </span>
                  <small>
                    <span className="ltr">{trackOf(x) || '—'}</span> · {x.companyName || x.livreurName || ''} · {x.followStatus ? t(`status.follow.${x.followStatus}`) : '—'}
                  </small>
                </span>
              </button>
            ))
          ) : (
            <p className="pxk-info" style={{ padding: 12 }}>
              {t('suivi.rec.noOrder')}
            </p>
          )}
        </div>
      )}
      {o && (
        <>
          <fieldset className="pxk-q">
            <legend>{t('suivi.rec.ph.problemQ')}</legend>
            <Options value={f.mot} onChange={f.setMot} label={t('suivi.rec.ph.problemQ')} items={CLAIM_REASONS.map((r) => ({ k: r, icon: REASON_ICON[r], label: t(`suivi.rec.reasons.${r}`) }))} />
          </fieldset>
          {f.mot === 'address' && zrInfo?.supported && zrInfo.info && (zrInfo.info.canModify || zrInfo.info.canChangePhone) && (
            <div className="pxk-hint">
              <span>{t('suivi.rec.ph.addressHint', { name })}</span>
              <button type="button" onClick={() => setZr(true)}>
                <Icon name="pencil" /> {t('suivi.rec.ph.addressGo', { name })}
              </button>
            </div>
          )}
          {api && (f.catsLoading || f.cats.length > 0) && (
            <fieldset className="pxk-q">
              <legend>{t('suivi.rec.apiCategory', { name })}</legend>
              <div className="pxk-chips">
                <button type="button" className={`pxk-chip${!f.cat ? ' on' : ''}`} aria-pressed={!f.cat} onClick={() => f.setCat('')}>
                  {t('suivi.rec.ph.auto')}
                </button>
                {f.cats.map((x) => (
                  <button key={x.id} type="button" className={`pxk-chip${f.cat === x.id ? ' on' : ''}`} aria-pressed={f.cat === x.id} onClick={() => f.setCat(x.id)}>
                    {x.name}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <label className="pxk-q">
            <b>{t('suivi.rec.details')}</b>
            <textarea className="pxk-in" rows={3} value={f.det} placeholder={t('suivi.rec.detailsPh')} onChange={(e) => f.setDet(e.target.value)} />
          </label>
        </>
      )}
      {f.err && <p className="pxk-bad">{f.err}</p>}
    </Sheet>
  );
}

/** The message for a courier without an API (or a refused one): checked, then WhatsApp, copy, e-mail or a call. */
export function SendSheet(p: { claim: SentClaim; order: Order | null; target: Target; shop: string; again: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { claim, order, target, onClose } = p;
  const f = useSendClaim(p);
  return (
    <Sheet
      title={t('suivi.rec.sendTitle', { name: target.name })}
      sub={
        <>
          <span className="ltr">{claim.ref}</span>
          {order ? (
            <>
              {' '}
              · <span className="ltr">{order.ref}</span> · {order.customerName}
            </>
          ) : null}
        </>
      }
      onClose={onClose}
      foot={
        <>
          <a className="pxk-go wa" href={waLink(target.wa, f.text)} target="_blank" rel="noopener noreferrer" onClick={() => f.mark('whatsapp')}>
            <Icon name="whatsapp" /> {t('suivi.rec.wa')}
          </a>
          <div className="pxk-row">
            <button type="button" className="pxk-go ghost" onClick={f.copy}>
              <Icon name="copy" /> {t('suivi.rec.ph.copy')}
            </button>
            {f.mail && (
              <a className="pxk-go ghost" href={f.mail} onClick={() => f.mark('email')}>
                <Icon name="mail" /> {t('suivi.rec.ph.mail')}
              </a>
            )}
            {target.phone && (
              <a className="pxk-go ghost" href={`tel:${target.phone}`}>
                <Icon name="phone" /> {t('suivi.rec.ph.call')}
              </a>
            )}
          </div>
        </>
      }
    >
      {claim.viaApi && !claim.extId && (
        <div className="pxk-bad">
          <b>{t('suivi.rec.apiRefused', { name: target.name })}</b>
          {claim.extError && <div>{claim.extError}</div>}
          <button type="button" className="pxk-chip" style={{ marginTop: 8 }} disabled={f.push.isPending} onClick={() => f.push.mutate({ id: claim.id })}>
            <Icon name="refresh" /> {t('suivi.rec.apiRetry', { name: target.name })}
          </button>
        </div>
      )}
      {f.done ? (
        <p className="pxk-okb">
          <Icon name="check" /> {t('suivi.rec.ph.marked')}
        </p>
      ) : (
        <p className="pxk-info">
          <Icon name="info" /> {t('suivi.rec.sendHelp', { name: target.name })}
        </p>
      )}
      <textarea className="pxk-msg" value={f.text} onChange={(e) => f.setText(e.target.value)} aria-label={t('suivi.rec.sendTitle', { name: target.name })} />
      {!target.wa && !target.email && <p className="pxk-warn">{t('suivi.rec.noContact', { name: target.name })}</p>}
    </Sheet>
  );
}

/** Relance of a claim created at ZR: the text goes on ZR's claim as a comment. */
export function RemindSheet({ c, onClose }: { c: ClaimRow; onClose: () => void }) {
  const { t } = useTranslation();
  const name = c.companyName ?? '';
  const [text, setText] = useState(() => t('suivi.rec.apiRemindText', { tracking: trackOf(c) || c.orderRef || '' }));
  const send = useAction('suivi.claimRemind', { success: t('suivi.rec.apiReminded', { name }), onDone: onClose });
  return (
    <Sheet
      title={t('suivi.rec.apiRemindTitle', { ref: c.ref, name })}
      sub={
        <>
          <span className="ltr">{c.orderRef ?? '—'}</span> · <span className="ltr">{trackOf(c) || '—'}</span>
          {c.extRef ? ` · ${t('suivi.rec.apiNo', { name, n: c.extRef })}` : ''}
        </>
      }
      onClose={onClose}
      foot={
        <button type="button" className="pxk-go" disabled={send.isPending || !text.trim()} onClick={() => send.mutate({ id: c.id, text: text.trim() })}>
          <Icon name="send" className="flip" /> {t('suivi.rec.apiSend', { name })}
        </button>
      }
    >
      {c.extAnswer && (
        <p className="pxk-ans">
          <b>{t('suivi.rec.apiLastAnswer', { name })}</b>
          <bdi>{c.extAnswer}</bdi>
        </p>
      )}
      <textarea className="pxk-msg" style={{ minHeight: 120 }} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('suivi.rec.apiRemindTitle', { ref: c.ref, name })} />
      <p className="pxk-info">
        <Icon name="info" /> {t('suivi.rec.apiRemindHelp', { name })}
      </p>
    </Sheet>
  );
}

/** What the courier answered, and where the claim stands; its history below. */
export function AnswerSheet({ c, name, onClose }: { c: ClaimRow; name: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [st, setSt] = useState<ClaimRow['status']>(c.status === 'waiting' ? 'still_waiting' : c.status === 'still_waiting' ? 'resolved' : c.status);
  const upd = useAction('suivi.claimUpdate', { success: t('suivi.rec.updated'), onDone: onClose });
  return (
    <Sheet
      title={t('suivi.rec.answerTitle', { ref: c.ref, name })}
      sub={
        <>
          <span className="ltr">{c.orderRef ?? '—'}</span> · {t(`suivi.rec.reasons.${c.reason}`, { defaultValue: c.reason })}
        </>
      }
      onClose={onClose}
      foot={
        <button type="button" className="pxk-go nv" disabled={upd.isPending} onClick={() => upd.mutate({ id: c.id, status: st !== c.status ? st : undefined, note: note.trim() ? `${t('suivi.rec.answerLab')} : ${note.trim()}` : undefined })}>
          <Icon name="check" /> {t('common.save')}
        </button>
      }
    >
      <label className="pxk-q">
        <b>{t('suivi.rec.answerLab')}</b>
        <textarea className="pxk-in" rows={3} value={note} placeholder={t('suivi.rec.answerPh')} onChange={(e) => setNote(e.target.value)} />
      </label>
      <fieldset className="pxk-q">
        <legend>{t('suivi.rec.statusLab')}</legend>
        <Seg value={st} onChange={setSt} label={t('suivi.rec.statusLab')} items={(['waiting', 'still_waiting', 'resolved'] as const).map((s) => ({ k: s, label: t(`suivi.rec.ph.st.${s}`) }))} />
      </fieldset>
      {c.notes.length > 0 && (
        <fieldset className="pxk-q">
          <legend>{t('suivi.rec.history')}</legend>
          <ol className="pxs-tl">
            {[...c.notes].reverse().map((n, i) => (
              <li key={i} className={n.status === 'resolved' ? '' : 'nt'}>
                <b>{n.text}</b>
                <small>{when(n.at)}</small>
              </li>
            ))}
          </ol>
        </fieldset>
      )}
    </Sheet>
  );
}

type Filt = 'open' | 'still_waiting' | 'resolved' | 'all';
const LATE_MS = 48 * 3_600_000;

/** Suivi › Réclamation on a phone: the claims as cards — the problem, ZR's answer, and Relancer / Réglée / Réponse. */
export function PhoneClaims({ target }: { target: 'company' | 'livreur' }) {
  const { t } = useTranslation();
  const [filt, setFilt] = useState<Filt>('open');
  const q = useRpc('suivi.claims', { target, status: filt });
  const contacts = useRpc('suivi.contacts', {}).data;
  const [dlg, setDlg] = useState<{ kind: 'new' } | { kind: 'answer'; c: ClaimRow } | { kind: 'send'; c: ClaimRow; order: Order } | { kind: 'remindApi'; c: ClaimRow } | null>(null);
  const sync = useAction('suivi.claimSync', { silent: true });
  const push = useAction('suivi.claimPush', { onDone: (c) => toast(c.extId ? t('suivi.rec.apiSent', { ref: c.ref, name: c.companyName ?? '', n: c.extRef ?? '' }) : c.extError ?? t('suivi.rec.apiFailed', { name: c.companyName ?? '' }), c.extId ? 'ok' : 'bad') });
  const upd = useAction('suivi.claimUpdate', { success: t('suivi.rec.updated') });
  const hasApi = target === 'company' && !!contacts?.companies.some((x: ClaimCompany) => x.api);
  // ZR's answers, read once when the inbox opens
  useEffect(() => {
    if (hasApi) sync.mutate({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasApi]);
  const rows = (q.data?.rows ?? []) as ClaimRow[];
  const counts = (q.data?.counts ?? {}) as Record<string, number>;
  const late = (c: ClaimRow) => c.status !== 'resolved' && Date.now() - Date.parse(c.updatedAt) > LATE_MS;
  const nLate = rows.filter(late).length;
  const nameOf = (c: ClaimRow) => (target === 'livreur' ? c.livreurName : c.companyName) ?? '—';
  const kindOf = (c: ClaimRow) => (target === 'livreur' ? 'own' : contacts?.companies.find((x: ClaimCompany) => x.id === c.companyId)?.kind ?? 'other');
  const targetOf = (c: ClaimRow): Target => {
    if (target === 'livreur') return { name: c.livreurName ?? '—', wa: c.livreurPhone, email: null, phone: c.livreurPhone };
    const comp = contacts?.companies.find((x: ClaimCompany) => x.id === c.companyId);
    return { name: c.companyName ?? '—', wa: comp?.wa ?? null, email: comp?.email ?? null, phone: comp?.phone ?? null };
  };
  const remind = async (c: ClaimRow) => {
    if (c.extId) return setDlg({ kind: 'remindApi', c });
    if (!c.orderId) return;
    try {
      setDlg({ kind: 'send', c, order: await rpc('orders.get', { id: c.orderId }) });
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };
  return (
    <div className="pxr">
      <div className="pxr-top">
        <button type="button" className="pxk-go" onClick={() => setDlg({ kind: 'new' })}>
          <Icon name="plus" /> {t('suivi.rec.ph.new')}
        </button>
        {hasApi && (
          <button
            type="button"
            className="pxr-sync"
            disabled={sync.isPending}
            aria-label={t('suivi.rec.apiSync')}
            title={t('suivi.rec.apiSync')}
            onClick={() => sync.mutate({}, { onSuccess: (r) => toast(r.errors.length ? r.errors[0] : t('suivi.rec.apiSynced', { n: r.changed }), r.errors.length ? 'bad' : 'ok') })}
          >
            <Icon name="refresh" />
          </button>
        )}
      </div>
      <div className="pxr-f" role="tablist">
        {(['open', 'still_waiting', 'resolved', 'all'] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={filt === k} className={filt === k ? 'on' : ''} onClick={() => setFilt(k)}>
            {t(`suivi.rec.filters.${k}`)} <b className="ltr">{counts[k] ?? 0}</b>
          </button>
        ))}
      </div>
      {nLate > 0 && (
        <p className="pxr-late">
          <Icon name="clock" /> {t('suivi.rec.ph.late', { count: nLate })}
        </p>
      )}
      {q.isLoading ? (
        <Loading />
      ) : !rows.length ? (
        <p className="pxp-empty muted">{filt === 'open' ? t('suivi.rec.emptyOpen') : t('suivi.rec.empty')}</p>
      ) : (
        <ul className="pxr-list">
          {rows.map((c) => {
            const name = nameOf(c);
            const k = kindOf(c);
            return (
              <li key={c.id} className={`pxr-c${late(c) ? ' late' : ''}${c.status === 'resolved' ? ' done' : ''}`}>
                <button type="button" className="pxr-cm" onClick={() => c.orderId && openOrder(c.orderId)}>
                  <span className="pxr-h">
                    <span className={`pxs-co k-${k}`} aria-hidden="true">
                      {(k === 'own' ? name.slice(0, 2) : name.replace(/express|livraison/gi, '').trim().slice(0, 3)).toUpperCase()}
                    </span>
                    <b>
                      <span className="ltr">{c.ref}</span> · <span className="ltr">{c.orderRef ?? '—'}</span>
                    </b>
                    <span className={`pxr-age ltr${late(c) ? ' l' : ''}`}>{since(c.sentAt ?? c.createdAt)}</span>
                  </span>
                  <span className="pxr-p">{t(`suivi.rec.reasons.${c.reason}`, { defaultValue: c.reason })}</span>
                  <small>
                    {name} · <span className="ltr">{trackOf(c) || '—'}</span> · {c.sentAt ? t(`suivi.rec.status.${c.status}`) : t('suivi.rec.notSent')}
                  </small>
                </button>
                {c.extId ? (
                  <div className="pxr-zr">
                    <b>
                      {t('suivi.rec.apiNo', { name, n: c.extRef || '✓' })}
                      {c.extStatus ? ` · ${c.extStatus}` : ''}
                    </b>
                    {c.extAnswer && <q dir="auto">{c.extAnswer}</q>}
                  </div>
                ) : (
                  c.viaApi && c.extError && <p className="pxk-bad">{t('suivi.rec.apiRefusedShort', { name })} · {c.extError}</p>
                )}
                {c.status !== 'resolved' && (
                  <div className="pxr-a">
                    {c.viaApi && !c.extId && (c.extError || !c.sentAt) ? (
                      <button type="button" className="pxs-chip or" disabled={push.isPending} onClick={() => push.mutate({ id: c.id })}>
                        <Icon name="send" /> {t('suivi.rec.apiSend', { name })}
                      </button>
                    ) : (
                      <button type="button" className="pxs-chip" onClick={() => remind(c)}>
                        <Icon name={c.extId ? 'chat' : 'whatsapp'} /> {t('suivi.rec.ph.remind')}
                      </button>
                    )}
                    <button type="button" className="pxs-chip ok" disabled={upd.isPending} onClick={() => upd.mutate({ id: c.id, status: 'resolved' })}>
                      <Icon name="check" /> {t('suivi.ph.resolved')}
                    </button>
                    <button type="button" className="pxs-chip" onClick={() => setDlg({ kind: 'answer', c })}>
                      <Icon name="pencil" /> {t('suivi.rec.ph.answer')}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {dlg?.kind === 'new' && <ClaimSheet toLivreur={target === 'livreur'} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'remindApi' && <RemindSheet c={dlg.c} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'answer' && <AnswerSheet c={dlg.c} name={nameOf(dlg.c)} onClose={() => setDlg(null)} />}
      {dlg?.kind === 'send' && <SendSheet claim={dlg.c} order={dlg.order} target={targetOf(dlg.c)} shop={contacts?.shopName ?? ''} again={!!dlg.c.sentAt} onClose={() => setDlg(null)} />}
    </div>
  );
}
