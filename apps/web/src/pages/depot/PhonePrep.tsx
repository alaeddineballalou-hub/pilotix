// Dépôt on phones, first stage: products first, then orders.
// « À préparer »: only the products and how many to take (no customer, no order). "J'ai pris n" + OK.
//   Fewer than needed: "Mettre en rupture" puts what is missing on « À ramener au dépôt » (Prévenir on WhatsApp).
// « En préparation »: the orders that have all their products. Tick the packed ones, choose the delivery partner
//   last, then « Envoyer au dispatch ».
import type { Order } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { wilayaName } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { useToDispatch } from './Depot';
import '../confirmation/phone.css';
import '../suivi/phone.css';
import './phone.css';

type Row = { productId: number; variantId: number | null; name: string; variant: string; need: number; orders: number; stock: number; pool: number; restock: number };
type Restock = { productId: number; variantId: number | null; name: string; variant: string; qty: number };
const keyOf = (r: { productId: number; variantId: number | null }) => `${r.productId}:${r.variantId ?? 0}`;

export function PhonePrep() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'pick' | 'ready'>('pick');
  const list = useRpc('depot.pickList', {});
  const ready = useRpc('depot.ready', {});
  const pieces = (list.data ?? []).reduce((s, r) => s + r.need, 0);
  return (
    <div className="pxd">
      <div className="pxd-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'pick'} className={tab === 'pick' ? 'on' : ''} onClick={() => setTab('pick')}>
          {t('depot.ph.toPick')} <b>{list.data ? pieces : '…'}</b>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'ready'} className={tab === 'ready' ? 'on' : ''} onClick={() => setTab('ready')}>
          {t('depot.ph.preparing')} <b>{ready.data ? ready.data.length : '…'}</b>
        </button>
      </div>
      {tab === 'pick' ? <PickTab rows={list.data} error={list.error} retry={() => list.refetch()} onReady={() => setTab('ready')} /> : <ReadyTab rows={ready.data} error={ready.error} retry={() => ready.refetch()} />}
    </div>
  );
}

// ---------------------------------------------------------------- À préparer
function PickTab({ rows, error, retry, onReady }: { rows?: Row[]; error: Error | null; retry: () => void; onReady: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const restock = useRpc('depot.restock', {});
  const [open, setOpen] = useState<string | null>(null);
  const [took, setTook] = useState(0);
  const [ask, setAsk] = useState<Row | null>(null);
  const [rupture, setRupture] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notify, setNotify] = useState(false);
  const [showList, setShowList] = useState(false);
  const done = useAction('depot.restockDone', { success: t('depot.ph.received') });

  if (error) return <ErrorBox error={error} onRetry={retry} />;
  if (!rows) return <Loading />;

  const send = async (r: Row, qty: number, rup: boolean) => {
    setBusy(true);
    try {
      const res = await rpc('depot.pick', { productId: r.productId, variantId: r.variantId, qty, rupture: rup });
      const name = `${r.name}${r.variant ? ` ${r.variant}` : ''}`;
      toast(
        [
          t('depot.ph.taken', { n: qty, name }),
          res.readyNow ? t('depot.ph.readyNow', { count: res.readyNow }) : '',
          res.missing && rup ? t('depot.ph.toBring', { n: res.missing }) : res.missing ? t('depot.ph.stillToTake', { n: res.missing }) : '',
        ]
          .filter(Boolean)
          .join(' · '),
        'ok',
      );
      setOpen(null);
      setAsk(null);
      qc.invalidateQueries();
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const ok = (r: Row) => {
    if (took < r.need) {
      setRupture(true);
      setAsk(r);
    } else send(r, took, false);
  };
  const rs = (restock.data ?? []) as Restock[];

  return (
    <>
      {rs.length > 0 && (
        <section className="pxd-bring">
          <div className="pxd-bh">
            <Icon name="package" />
            <b>{t('depot.ph.bringTitle')}</b>
            <span className="badge t-bad">{t('depot.ph.nProducts', { count: rs.length })}</span>
          </div>
          <p className="pxd-bl">
            {rs.map((x, i) => (
              <span key={keyOf(x)}>
                {i > 0 && ' · '}
                {x.name}
                {x.variant ? ` ${x.variant}` : ''} <b className="ltr">×{x.qty}</b>
              </span>
            ))}
          </p>
          {showList && (
            <ul className="pxd-blist">
              {rs.map((x) => (
                <li key={keyOf(x)}>
                  <span>
                    {x.name}
                    {x.variant ? ` · ${x.variant}` : ''}
                  </span>
                  <b className="ltr">×{x.qty}</b>
                  <button type="button" className="pxs-chip ok" disabled={done.isPending} onClick={() => done.mutate({ productId: x.productId, variantId: x.variantId })}>
                    <Icon name="check" /> {t('depot.ph.gotIt')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="pxd-ba">
            <button type="button" className="pxd-btn" onClick={() => setShowList(!showList)}>
              {showList ? t('depot.ph.hideList') : t('depot.ph.seeList')}
            </button>
            <button type="button" className="pxd-btn wa" onClick={() => setNotify(true)}>
              <Icon name="whatsapp" /> {t('depot.ph.notify')}
            </button>
          </div>
        </section>
      )}

      {rows.length === 0 ? (
        <div className="pxd-empty">
          <p className="muted">{t('depot.ph.nothingToPick')}</p>
          <button type="button" className="pxd-btn" onClick={onReady}>
            {t('depot.ph.preparing')} ›
          </button>
        </div>
      ) : (
        <ul className="pxd-list">
          {rows.map((r) => {
            const k = keyOf(r);
            const isOpen = open === k;
            const low = r.stock < r.need;
            return (
              <li key={k}>
                <div className={`pxd-card${isOpen ? ' open' : ''}`}>
                  <button
                    type="button"
                    className="pxd-top"
                    aria-expanded={isOpen}
                    onClick={() => {
                      setOpen(isOpen ? null : k);
                      setTook(Math.min(r.need, Math.max(0, r.stock)) || r.need);
                    }}
                  >
                    <span className="pxd-th" aria-hidden="true">
                      <Icon name="package" />
                    </span>
                    <span className="pxd-pn">
                      <b>{r.name}</b>
                      {r.variant && <small>{r.variant}</small>}
                      <em className={r.stock <= 0 ? 'bad' : low ? 'warn' : ''}>
                        {r.stock <= 0 ? t('depot.ph.noStock') : low ? t('depot.ph.lowStock', { n: r.stock }) : t('depot.ph.inStock', { n: r.stock })}
                        {r.restock > 0 && ` · ${t('depot.ph.onBring', { n: r.restock })}`}
                        {r.pool > 0 && ` · ${t('depot.ph.pool', { n: r.pool })}`}
                      </em>
                    </span>
                    <span className="pxd-need">
                      <b className="ltr">{r.need}</b>
                      <small>{t('depot.ph.toTake')}</small>
                    </span>
                  </button>
                  {isOpen && (
                    <div className="pxd-took">
                      <span className="pxd-tl">{t('depot.ph.iTook')}</span>
                      <span className="pxd-step">
                        <button type="button" aria-label="−1" disabled={took <= 0} onClick={() => setTook(Math.max(0, took - 1))}>
                          −
                        </button>
                        <input
                          className="ltr"
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={r.need}
                          value={took}
                          aria-label={t('depot.ph.iTook')}
                          onFocus={(e) => e.target.select()}
                          onChange={(e) => setTook(Math.max(0, Math.min(r.need, Math.round(Number(e.target.value) || 0))))}
                        />
                        <button type="button" aria-label="+1" disabled={took >= r.need} onClick={() => setTook(Math.min(r.need, took + 1))}>
                          +
                        </button>
                      </span>
                      <button type="button" className="pxd-ok" disabled={busy} onClick={() => ok(r)}>
                        <Icon name="check" /> OK
                      </button>
                      <div className="pxd-quick">
                        <button type="button" className="pxs-chip" onClick={() => setTook(r.need)}>
                          {t('depot.ph.all', { n: r.need })}
                        </button>
                        <button type="button" className="pxs-chip" onClick={() => setTook(0)}>
                          {t('depot.ph.none')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {ask && (
        <Modal
          title={t('depot.ph.missingTitle', { n: ask.need - took, name: `${ask.name}${ask.variant ? ` ${ask.variant}` : ''}` })}
          onClose={() => setAsk(null)}
          footer={
            <button type="button" className="btn ok pxd-mfull" disabled={busy} onClick={() => send(ask, took, rupture)}>
              <Icon name="check" /> {rupture ? t('depot.ph.okRupture', { took, n: ask.need - took }) : t('depot.ph.okLater', { took })}
            </button>
          }
        >
          <p className="muted small">{t('depot.ph.tookOf', { took, need: ask.need })}</p>
          <div className="pxd-opts" role="radiogroup">
            <button type="button" role="radio" aria-checked={rupture} className={`pxd-opt bad${rupture ? ' on' : ''}`} onClick={() => setRupture(true)}>
              <Icon name="package" />
              <span>
                <b>{t('depot.ph.rupture')}</b>
                <small>{t('depot.ph.ruptureHint')}</small>
              </span>
            </button>
            <button type="button" role="radio" aria-checked={!rupture} className={`pxd-opt${!rupture ? ' on' : ''}`} onClick={() => setRupture(false)}>
              <Icon name="hourglass" />
              <span>
                <b>{t('depot.ph.later')}</b>
                <small>{t('depot.ph.laterHint')}</small>
              </span>
            </button>
          </div>
        </Modal>
      )}
      {notify && <NotifyModal rows={rs} onClose={() => setNotify(false)} />}
    </>
  );
}

/** « Prévenir »: the list of what to bring, ready for WhatsApp (the person is chosen in WhatsApp) or to copy. */
function NotifyModal({ rows, onClose }: { rows: Restock[]; onClose: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => [t('depot.ph.msgHead'), ...rows.map((x) => `• ${x.name}${x.variant ? ` ${x.variant}` : ''} × ${x.qty}`), t('depot.ph.msgEnd')].join('\n'));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t('depot.ph.copied'), 'ok');
    } catch {
      toast(t('depot.ph.copyFail'), 'bad');
    }
  };
  return (
    <Modal
      title={t('depot.ph.notifyTitle')}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={copy}>
            <Icon name="copy" /> {t('depot.ph.copy')}
          </button>
          <a className="btn pxd-wa" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener">
            <Icon name="whatsapp" /> {t('depot.ph.sendWa')}
          </a>
        </>
      }
    >
      <p className="muted small">{t('depot.ph.notifyHint')}</p>
      <textarea className="pxd-msg" rows={8} value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  );
}

// ---------------------------------------------------------------- En préparation
function ReadyTab({ rows, error, retry }: { rows?: Order[]; error: Error | null; retry: () => void }) {
  const { t } = useTranslation();
  const companies = useRpc('depot.companies', {});
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [company, setCompany] = useState<number | null>(null);
  const go = useToDispatch();
  if (error) return <ErrorBox error={error} onRetry={retry} />;
  if (!rows) return <Loading />;
  const ids = rows.map((o) => o.id).filter((x) => sel.has(x));
  const toggle = (oid: number) => setSel((s) => (s.has(oid) ? (s.delete(oid), new Set(s)) : new Set(s).add(oid)));
  return (
    <>
      <p className="muted small pxd-help">{t('depot.ph.readyHelp')}</p>
      {rows.length === 0 ? (
        <p className="pxd-empty muted">{t('depot.ph.noneReady')}</p>
      ) : (
        <ul className="pxd-list" style={{ paddingBottom: ids.length ? 230 : 20 }}>
          {rows.map((o) => {
            const on = sel.has(o.id);
            return (
              <li key={o.id}>
                <button type="button" className={`pxd-ord${on ? ' on' : ''}`} aria-pressed={on} onClick={() => toggle(o.id)}>
                  <span className="pxd-cb" aria-hidden="true">
                    {on && <Icon name="check" />}
                  </span>
                  <span className="pxd-pn">
                    <b>
                      <span className="ltr">{o.ref}</span> · {wilayaName(o.wilayaId)}
                    </b>
                    <small>{o.items.map((i) => `${i.name}${i.variantTitle ? ` ${i.variantTitle}` : ''} ×${i.qty}`).join(' + ')}</small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {ids.length > 0 && (
        <div className="pxd-bar">
          <div className="pxd-brow">
            <b>{t('depot.ph.ticked', { count: ids.length })}</b>
            <button type="button" className="linkish" onClick={() => setSel(ids.length === rows.length ? new Set() : new Set(rows.map((o) => o.id)))}>
              {ids.length === rows.length ? t('depot.ph.untickAll') : t('depot.ph.tickAll')}
            </button>
          </div>
          <span className="pxd-lbl">{t('depot.ph.partner')}</span>
          <div className="pxd-parts">
            {(companies.data ?? []).map((c) => (
              <button key={c.id} type="button" className={`pxs-chip${company === c.id ? ' sel' : ''}`} aria-pressed={company === c.id} onClick={() => setCompany(c.id)}>
                {company === c.id && <Icon name="check" />}
                {c.name}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="pxd-send"
            disabled={!company || go.busy}
            onClick={() =>
              go.run(ids, company, () => {
                setSel(new Set());
                setCompany(null);
              })
            }
          >
            <Icon name="truck" /> {t('depot.ph.send', { count: ids.length })}
            {company ? ` · ${(companies.data ?? []).find((c) => c.id === company)?.name ?? ''}` : ''}
          </button>
        </div>
      )}
    </>
  );
}
