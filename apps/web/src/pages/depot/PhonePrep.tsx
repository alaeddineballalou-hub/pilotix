// Dépôt on phones, first stage: products first, then orders.
// « À préparer »: only the products and how many to take (no customer, no order). "J'ai pris n" + OK.
//   Fewer than needed: "Mettre en rupture" puts what is missing on « À ramener au dépôt » (Prévenir on WhatsApp).
// « À attribuer »: the orders picked whole that have no company yet (or « Livraison privée » without a livreur) — a
//   table on computers. Only managers (ticked in Utilisateurs) and admins choose; the order then goes to « En dispatch »
//   by itself. An order picked whole that has a company goes there by itself, without this tab.
// « Sans stock »: the orders confirmed while a product had nothing left, oldest first, with how long each waits (late
//   after the shop's number of days). When stock comes back the oldest go to « À préparer » by themselves.
// The cards are one per variant: the product photo, the product name, then the variant in a pill of its colour (the
// card's edge has that colour too) — the picker takes by colour.
import type { Order } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CSSProperties, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { rpc } from '../../lib/backend';
import { n, wilayaName } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { useIsPhone } from '../../lib/useMedia';
import '../confirmation/phone.css';
import '../suivi/phone.css';
import './phone.css';
import './dispatch.css';
import { waitWhy } from '../../lib/pilot';

type Row = Out<'depot.pickList'>[number];
type Restock = { productId: number; variantId: number | null; name: string; variant: string; qty: number };
const keyOf = (r: { productId: number; variantId: number | null }) => `${r.productId}:${r.variantId ?? 0}`;

export function PhonePrep() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'pick' | 'assign' | 'nostock'>('pick');
  const list = useRpc('depot.pickList', {});
  const assign = useRpc('depot.toAssign', {}, { refetchInterval: 60_000 });
  const counts = useRpc('depot.counts', {}, { refetchInterval: 60_000 });
  const ns = counts.data;
  const pieces = (list.data ?? []).reduce((s, r) => s + r.need, 0);
  return (
    <div className="pxd">
      <div className="pxd-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'pick'} className={tab === 'pick' ? 'on' : ''} onClick={() => setTab('pick')}>
          {t('depot.ph.toPick')} <b>{list.data ? pieces : '…'}</b>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'assign'} className={tab === 'assign' ? 'on' : ''} onClick={() => setTab('assign')}>
          {t('depot.as.tab')} <b>{assign.data ? assign.data.rows.length : '…'}</b>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'nostock'} className={tab === 'nostock' ? 'on' : ''} onClick={() => setTab('nostock')}>
          {t('depot.ns.tab')} <b className={ns?.noStockLate ? 'late' : ''}>{ns ? ns.noStock : '…'}</b>
        </button>
      </div>
      {tab === 'pick' ? (
        <PickTab rows={list.data} error={list.error} retry={() => list.refetch()} onReady={() => setTab('assign')} />
      ) : tab === 'assign' ? (
        <AssignTab data={assign.data} error={assign.error} retry={() => assign.refetch()} />
      ) : (
        <NoStockTab />
      )}
    </div>
  );
}

/** What the picker reads first: the colour (and size), or the size, or the other values; '' = a product without variants. */
function bigOf(r: Row): string {
  const l = r.look;
  return [l.color?.name, l.size, ...l.other].filter(Boolean).join(' · ') || r.variant;
}
/** How light a colour is (0 black … 1 white, WCAG relative luminance). */
function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
/** Black or white words on a colour: the one that reads best (WCAG contrast with white vs our ink). */
const inkOn = (hex: string): 'dark' | 'light' => (1.05 / (lum(hex) + 0.05) >= (lum(hex) + 0.05) / 0.074 ? 'light' : 'dark');
/** The variant in a pill of its colour (a size, or a colour we do not know: a plain pill). */
function VariantPill({ r }: { r: Row }) {
  const hex = r.look.color?.hex ?? null;
  return (
    <span className={`pk-var${hex ? ` has ${inkOn(hex)}` : ''}${hex && lum(hex) > 0.75 ? ' edge' : ''}`} style={hex ? ({ '--sw': hex } as CSSProperties) : undefined}>
      {bigOf(r)}
    </span>
  );
}

// ---------------------------------------------------------------- Sans stock
function NoStockTab() {
  const { t } = useTranslation();
  const q = useRpc('depot.noStock', {}, { refetchInterval: 60_000 });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  const { list, days } = q.data;
  return (
    <>
      <p className="ns-intro">
        <Icon name="clock" />
        <span>{t('depot.ns.intro', { count: days })}</span>
      </p>
      {!list.length ? (
        <div className="pxd-empty">
          <p className="muted">{t('depot.ns.empty')}</p>
        </div>
      ) : (
        <ul className="pxd-list ns-list">
          {list.map((o) => (
            <li key={o.id} className={`ns-card${o.late ? ' late' : ''}`}>
              <div className="ns-top">
                <span className="ns-who">
                  <b className="ltr">{o.ref}</b>
                  <span>
                    {o.customerName} · {wilayaName(o.wilayaId)}
                  </span>
                </span>
                <span className={`ns-wait${o.late ? ' late' : ''}`}>
                  {o.late && <Icon name="alert" />}
                  {o.days === 0 ? t('depot.ns.today') : t('depot.ns.days', { count: o.days })}
                </span>
              </div>
              <ul className="ns-items">
                {o.items.map((i, k) => (
                  <li key={k} className={i.missing ? 'miss' : ''}>
                    <span>
                      {i.name}
                      {i.variant ? ` · ${i.variant}` : ''} <b className="ltr">×{i.qty}</b>
                    </span>
                    <em>{i.off ? t('depot.ns.off') : i.missing ? t('depot.ns.left', { n: i.left }) : t('depot.ns.ok')}</em>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </>
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
  // « Vous avez pris … ? » before counting
  const [sure, setSure] = useState<Row | null>(null);
  // « Annuler » for 3 seconds after « J'ai pris »
  const [undo, setUndo] = useState<{ id: number; text: string } | null>(null);
  // a quick double tap would count the same units twice (the button is disabled only after the next render)
  const running = useRef(false);
  const done = useAction('depot.restockDone', { success: t('depot.ph.received') });

  // the « Annuler » time is over: the orders picked whole go on (« En dispatch », or « À attribuer »)
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(async () => {
      setUndo(null);
      try {
        const d = await rpc('depot.pickDone', { id: undo.id });
        const parts = [
          d.dispatched ? t('depot.as.sentNow', { count: d.dispatched }) : '',
          d.toAssign ? t('depot.as.waitNow', { count: d.toAssign }) : '',
          d.refused ? t('depot.as.refusedNow', { count: d.refused }) : '',
        ].filter(Boolean);
        if (parts.length) toast(parts.join(' · '), d.refused ? 'bad' : 'ok');
      } catch (e: any) {
        toast(e.message, 'bad');
      } finally {
        qc.invalidateQueries();
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, [undo]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <ErrorBox error={error} onRetry={retry} />;
  if (!rows) return <Loading />;

  const send = async (r: Row, qty: number, rup: boolean) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      const res = await rpc('depot.pick', { productId: r.productId, variantId: r.variantId, qty, rupture: rup, undo: true });
      const name = `${r.name}${r.variant ? ` ${r.variant}` : ''}`;
      setUndo({
        id: res.logId,
        text: [
          t('depot.ph.taken', { n: qty, name }),
          res.missing && rup ? t('depot.ph.toBring', { n: res.missing }) : res.missing ? t('depot.ph.stillToTake', { n: res.missing }) : '',
        ]
          .filter(Boolean)
          .join(' · '),
      });
      setOpen(null);
      setAsk(null);
      setSure(null);
      qc.invalidateQueries();
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const cancelPick = async () => {
    if (!undo || running.current) return;
    running.current = true;
    const id = undo.id;
    setUndo(null);
    try {
      await rpc('depot.pickUndo', { id });
      toast(t('depot.ph.undone'), 'ok');
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      running.current = false;
      qc.invalidateQueries();
    }
  };
  const ok = (r: Row) => {
    if (took < r.need) {
      setRupture(true);
      setAsk(r);
    } else setSure(r);
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
            {t('depot.as.tab')} ›
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
                <div className={`pxd-card pk-card${isOpen ? ' open' : ''}`} style={r.look.color?.hex ? ({ '--sw': r.look.color.hex } as CSSProperties) : undefined}>
                  <button
                    type="button"
                    className="pxd-top"
                    aria-expanded={isOpen}
                    onClick={() => {
                      setOpen(isOpen ? null : k);
                      setTook(Math.min(r.need, Math.max(0, r.stock)) || r.need);
                    }}
                  >
                    <span className="pk-ph" aria-hidden="true">
                      {r.photo ? <img src={r.photo} alt="" loading="lazy" /> : <Icon name="package" />}
                    </span>
                    <span className="pxd-pn pk">
                      <b className="pk-big">{r.name}</b>
                      {bigOf(r) && <VariantPill r={r} />}
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
      {sure && (
        <Modal
          title={t('depot.ph.sureTitle', { n: took, name: `${sure.name}${sure.variant ? ` ${sure.variant}` : ''}` })}
          onClose={() => setSure(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setSure(null)}>
                {t('depot.ph.sureNo')}
              </button>
              <button type="button" className="btn ok" disabled={busy} onClick={() => send(sure, took, false)}>
                <Icon name="check" /> {t('depot.ph.sureYes')}
              </button>
            </>
          }
        >
          <p className="muted small">{t('depot.ph.sureHint')}</p>
        </Modal>
      )}
      {undo && (
        <div className="pxd-undo" role="status">
          <span>{undo.text}</span>
          <button type="button" className="btn small" onClick={cancelPick}>
            {t('depot.ph.undo')}
          </button>
          <i className="pxd-undo-bar" aria-hidden="true" />
        </div>
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
type Assign = Out<'depot.toAssign'>;

/** « À attribuer »: a table on computers (cards on phones); managers and admins tick orders and choose who delivers. */
function AssignTab({ data, error, retry }: { data?: Assign; error: Error | null; retry: () => void }) {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const companies = useRpc('depot.companies', {});
  const livreurs = useRpc('delivery.livreurs', {});
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  if (error) return <ErrorBox error={error} onRetry={retry} />;
  if (!data) return <Loading />;
  const { rows, canAct } = data;
  const ids = rows.map((o) => o.id).filter((x) => sel.has(x));
  const toggle = (oid: number) => setSel((s) => (s.has(oid) ? (s.delete(oid), new Set(s)) : new Set(s).add(oid)));
  const all = ids.length === rows.length && rows.length > 0;
  const cos = (companies.data ?? []).filter((c) => c.kind !== 'own');
  const own = (companies.data ?? []).find((c) => c.kind === 'own');
  const lvs = (livreurs.data ?? []).filter((l) => l.active && (l.companyId ?? own?.id));
  const since = (o: Order) => {
    const h = Math.max(0, Math.floor((Date.now() - new Date(o.confirmedAt ?? o.createdAt).getTime()) / 3_600_000));
    return h < 24 ? t('depot.as.hours', { count: h }) : t('depot.as.days', { count: Math.floor(h / 24) });
  };
  const go = async () => {
    const [kind, a, b] = who.split(':');
    if (!kind || !ids.length) return;
    // a livreur who did not say « Je travaille aujourd'hui »: asked once (he still gets a notification)
    const lv = kind === 'l' ? lvs.find((l) => l.id === Number(a)) : undefined;
    if (lv && !lv.checkedInAt && !window.confirm(t('depot.as.askNotIn', { name: lv.name }))) return;
    setBusy(true);
    try {
      const r = await rpc('depot.assign', kind === 'l' ? { ids, companyId: Number(b), livreurId: Number(a) } : { ids, companyId: Number(a) });
      toast([t('depot.as.done', { count: r.assigned }), r.failed.length ? t('depot.as.refusedNow', { count: r.failed.length }) : ''].filter(Boolean).join(' · '), r.failed.length ? 'bad' : 'ok');
      setSel(new Set());
      setWho('');
      qc.invalidateQueries();
    } catch (e: any) {
      toast(e.message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const privateTag = (o: Order) => o.companyId && own && o.companyId === own.id;
  return (
    <>
      <p className="muted small pxd-help">{t(canAct ? 'depot.as.help' : 'depot.as.helpRead')}</p>
      {rows.length === 0 ? (
        <p className="pxd-empty muted">{t('depot.as.none')}</p>
      ) : !phone ? (
        <div className="tbl-wrap as-wrap">
          <table className="tbl as-tbl">
            <thead>
              <tr>
                {canAct && (
                  <th className="as-ck">
                    <input type="checkbox" checked={all} aria-label={t('depot.ph.tickAll')} onChange={() => setSel(all ? new Set() : new Set(rows.map((o) => o.id)))} />
                  </th>
                )}
                <th>{t('depot.as.colRef')}</th>
                <th>{t('depot.as.colClient')}</th>
                <th>{t('depot.as.colPlace')}</th>
                <th>{t('depot.as.colProducts')}</th>
                <th className="num">{t('depot.as.colTotal')}</th>
                <th>{t('depot.as.colWait')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className={sel.has(o.id) ? 'on' : ''} onClick={canAct ? () => toggle(o.id) : undefined}>
                  {canAct && (
                    <td className="as-ck" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={sel.has(o.id)} aria-label={o.ref} onChange={() => toggle(o.id)} />
                    </td>
                  )}
                  <td className="ltr">
                    <b>{o.ref}</b>
                  </td>
                  <td>{o.customerName}</td>
                  <td>
                    {wilayaName(o.wilayaId)}
                    {o.commune ? ` · ${o.commune}` : ''}
                    {privateTag(o) && <span className="as-tag">{t('depot.as.private')}</span>}
                    {!o.companyId && waitWhy(t, o.pilotWhy) && <span className="as-tag why">{waitWhy(t, o.pilotWhy)}</span>}
                  </td>
                  <td className="as-prod">{o.items.map((i) => `${i.name}${i.variantTitle ? ` ${i.variantTitle}` : ''} ×${i.qty}`).join(' + ')}</td>
                  <td className="num ltr">{n(o.total)} DA</td>
                  <td>{since(o)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="pxd-list" style={{ paddingBottom: ids.length ? 200 : 20 }}>
          {rows.map((o) => {
            const on = sel.has(o.id);
            return (
              <li key={o.id}>
                <button type="button" className={`pxd-ord${on ? ' on' : ''}`} aria-pressed={on} disabled={!canAct} onClick={() => toggle(o.id)}>
                  {canAct && (
                    <span className="pxd-cb" aria-hidden="true">
                      {on && <Icon name="check" />}
                    </span>
                  )}
                  <span className="pxd-pn">
                    <b>
                      <span className="ltr">{o.ref}</span> · {wilayaName(o.wilayaId)}
                      {privateTag(o) && <span className="as-tag">{t('depot.as.private')}</span>}
                      {!o.companyId && waitWhy(t, o.pilotWhy) && <span className="as-tag why">{waitWhy(t, o.pilotWhy)}</span>}
                    </b>
                    <small>{o.items.map((i) => `${i.name}${i.variantTitle ? ` ${i.variantTitle}` : ''} ×${i.qty}`).join(' + ')}</small>
                    <small>
                      {o.customerName} · {since(o)}
                    </small>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {canAct && ids.length > 0 && (
        <div className="pxd-bar as-bar">
          <div className="pxd-brow">
            <b>{t('depot.ph.ticked', { count: ids.length })}</b>
          </div>
          <label className="as-pick">
            <span className="pxd-lbl">{t('depot.as.who')}</span>
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">{t('depot.as.pick')}</option>
              {cos.length > 0 && (
                <optgroup label={t('depot.as.companies')}>
                  {cos.map((c) => (
                    <option key={c.id} value={`c:${c.id}`}>
                      {c.name}
                    </option>
                  ))}
                </optgroup>
              )}
              {lvs.length > 0 && (
                <optgroup label={t('depot.as.private')}>
                  {lvs.map((l) => (
                    <option key={l.id} value={`l:${l.id}:${l.companyId ?? own?.id}`}>
                      {l.checkedInAt ? `✓ ${l.name}` : `${l.name} — ${t('depot.as.notIn')}`}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          <button type="button" className="pxd-send" disabled={!who || busy} onClick={go}>
            <Icon name="truck" /> {t('depot.as.go', { count: ids.length })}
          </button>
        </div>
      )}
    </>
  );
}
