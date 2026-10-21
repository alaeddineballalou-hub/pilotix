import { EXCHANGE_KINDS, SAV_STATUSES, SAV_WISHES } from '@pilotix/shared';
import type { Order } from '@pilotix/shared';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, when } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Loading, StatusBadge } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { useStaff } from './staff';

type Kind = (typeof EXCHANGE_KINDS)[number];

/** One ticket: where it stands, its order, status, responsable, note, history — and the exchange. */
export function TicketModal({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('sav.get', { id });
  const staff = useStaff();
  const [status, setStatus] = useState<string | null>(null);
  const [owner, setOwner] = useState<string | null>(null);
  const [wish, setWish] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [exch, setExch] = useState(false);
  const upd = useAction('sav.update', { success: t('sav.t.saved'), onDone: onClose });

  if (q.isLoading || !q.data)
    return (
      <Modal title="SAV" onClose={onClose}>
        {q.error ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : <Loading />}
      </Modal>
    );
  const { ticket: x, order, exchange, parts } = q.data;
  if (exch && order) return <ExchangeModal ticketId={x.id} ticketRef={x.ref} order={order} parts={parts} suggestedFee={q.data?.suggestedFee ?? 0} onBack={() => setExch(false)} onClose={onClose} />;

  const openT = x.status === 'open' || x.status === 'progress';
  const st = status ?? x.status;
  const ow = owner ?? (x.assignedTo ? String(x.assignedTo) : '');
  const wi = wish ?? (x.wish ?? '');
  const save = () => {
    const changed = st !== x.status || ow !== (x.assignedTo ? String(x.assignedTo) : '') || wi !== (x.wish ?? '') || note.trim();
    if (!changed) return onClose();
    upd.mutate({
      id: x.id,
      status: st !== x.status ? (st as (typeof SAV_STATUSES)[number]) : undefined,
      assignedTo: ow !== (x.assignedTo ? String(x.assignedTo) : '') ? (ow ? Number(ow) : null) : undefined,
      wish: wi !== (x.wish ?? '') ? ((wi || null) as (typeof SAV_WISHES)[number] | null) : undefined,
      note: note.trim() || undefined,
    });
  };
  return (
    <Modal
      wide
      title={`${x.ref} · ${t(`sav.type.${x.type}`)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
          {openT && order && !(exchange && exchange.followStatus !== 'cancelled') && (
            <button className="btn" onClick={() => setExch(true)}>
              {t('sav.t.exchange')}
            </button>
          )}
          <button className="btn primary" disabled={upd.isPending} onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {exchange ? (
          <div className="okbox">
            <div className="row">
              <span>{t(`sav.kind.${x.exchangeKind ?? 'same'}`)} </span>
              <button type="button" className="linkish ltr" onClick={() => openOrder(exchange.id)}>
                {exchange.ref}
              </button>
              <StatusBadge kind="follow" status={exchange.followStatus} />
              <span className="muted small">{t('sav.t.toCash', { v: da(exchange.total) })}</span>
            </div>
            <small>{t('sav.t.autoResolve')}</small>
          </div>
        ) : openT && order ? (
          <div className="warnbox">{t('sav.t.notYet')}</div>
        ) : openT ? (
          <p className="muted small">{t('sav.t.noOrder')}</p>
        ) : null}
        <dl className="kv">
          <dt>{t('sav.t.order')}</dt>
          <dd>
            {order ? (
              <button type="button" className="linkish ltr" onClick={() => openOrder(order.id)}>
                {order.ref}
              </button>
            ) : (
              '—'
            )}
          </dd>
          <dt>{t('sav.t.client')}</dt>
          <dd>
            {x.customerName ?? '—'} · <span className="ltr">{x.phone ?? ''}</span>
          </dd>
          <dt>{t('sav.t.details')}</dt>
          <dd>{x.details || '—'}</dd>
          <dt>{t('sav.t.created')}</dt>
          <dd>
            {when(x.createdAt)}
            {x.createdByName ? ` · ${t('sav.t.by', { v: x.createdByName })}` : ''}
          </dd>
        </dl>
        {order && (
          <>
            <h3>{t('sav.t.products')}</h3>
            <ul className="small" style={{ margin: 0, paddingInlineStart: 18 }}>
              {order.items.map((i) => (
                <li key={i.id}>
                  {i.qty} × {i.name}
                  {i.variantTitle ? ` ${i.variantTitle}` : ''} · <span className="ltr">{da(i.unitPrice)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="grid3">
          <label className="field">
            <span className="lab">{t('sav.t.status')}</span>
            <select value={st} onChange={(e) => setStatus(e.target.value)}>
              {SAV_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`sav.status.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('sav.t.owner')}</span>
            <select value={ow} onChange={(e) => setOwner(e.target.value)}>
              <option value="">{t('sav.nobodyShort')}</option>
              {staff.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="lab">{t('sav.t.wish')}</span>
            <select value={wi} onChange={(e) => setWish(e.target.value)}>
              <option value="">{t('sav.wish.none')}</option>
              {SAV_WISHES.map((w) => (
                <option key={w} value={w}>
                  {t(`sav.wish.${w}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          <span className="lab">{t('sav.t.note')}</span>
          <textarea rows={2} value={note} placeholder={t('sav.t.notePh')} onChange={(e) => setNote(e.target.value)} />
        </label>
        <h3>{t('sav.t.history')}</h3>
        <ul className="timeline">
          {[...x.notes].reverse().map((n, i) => (
            <li key={i}>
              <span className="t">{when(n.at)}</span>
              <div>
                <b>{n.userName ?? '—'}</b>
                {n.status && (
                  <>
                    {' '}
                    <StatusBadge kind="sav" status={n.status} />
                  </>
                )}
                {n.text && <div>{n.text}</div>}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}

interface LineState {
  on: boolean;
  qty: number;
  variantId: number | null;
}

/** Exchange: lines concerned, how each is replaced, parts, delivery paid → order straight to the depot. */
function ExchangeModal({ ticketId, ticketRef, order, parts, suggestedFee, onBack, onClose }: { ticketId: number; ticketRef: string; order: Order; parts: Record<number, { name: string; max?: number }[]>; suggestedFee: number; onBack: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const items = order.items.filter((i) => i.id).map((i) => ({ ...i, id: i.id as number }));
  const cat = useRpc('sav.catalog', {}).data ?? [];
  const [kind, setKind] = useState<Kind>('same');
  const [lines, setLines] = useState<Record<number, LineState>>(() => Object.fromEntries(items.map((i) => [i.id, { on: items.length === 1, qty: i.qty, variantId: null }])));
  const [partSel, setPartSel] = useState<Record<string, number>>({});
  const [freePart, setFreePart] = useState('');
  // pre-filled from the SAV tariff (Management › Prix › Tickets SAV), can be changed here
  const [fee, setFee] = useState(suggestedFee);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const ex = useAction('sav.exchange', {
    onDone: (r) => {
      toast(t('sav.ex.done', { ref: r.order.ref }), 'ok');
      onClose();
    },
  });
  const byVariant = useMemo(() => new Map(cat.map((v) => [v.variantId, v])), [cat]);
  const allParts = [...new Set(items.flatMap((i) => (parts[i.productId] ?? []).map((p) => p.name)))];
  const setLine = (iid: number, patch: Partial<LineState>) => setLines((s) => ({ ...s, [iid]: { ...s[iid], ...patch } }));
  const diff = items.reduce((sum, i) => {
    const l = lines[i.id];
    if (!l?.on || kind === 'same' || kind === 'parts' || !l.variantId) return sum;
    const v = byVariant.get(l.variantId);
    return sum + Math.max(0, (v?.price ?? 0) - i.unitPrice) * l.qty;
  }, 0);
  const submit = () => {
    setErr('');
    const chosen = items.filter((i) => lines[i.id]?.on);
    if (!chosen.length) return setErr(t('sav.ex.pickLine'));
    const ps = Object.entries(partSel).map(([name, qty]) => ({ name, qty }));
    if (freePart.trim()) ps.push({ name: freePart.trim(), qty: 1 });
    ex.mutate({
      id: ticketId,
      kind,
      lines: chosen.map((i) => ({ itemId: i.id, qty: lines[i.id].qty, variantId: kind === 'variant' || kind === 'other_product' ? lines[i.id].variantId : null })),
      parts: kind === 'parts' ? ps : [],
      deliveryFee: fee,
      note: note.trim() || null,
    });
  };
  return (
    <Modal
      wide
      title={t('sav.ex.title', { ref: ticketRef })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onBack}>
            {t('sav.ex.back')}
          </button>
          <button className="btn primary" disabled={ex.isPending} onClick={submit}>
            {t('sav.ex.submit')}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label className="field">
          <span className="lab">{t('sav.ex.kind')}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {EXCHANGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`sav.kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <h3>{t('sav.ex.lines')}</h3>
        {items.map((i) => {
          const l = lines[i.id];
          const sib = cat.filter((v) => v.productId === i.productId && v.variantId !== i.variantId);
          const others = cat.filter((v) => v.productId !== i.productId);
          return (
            <div key={i.id} className={`bjsav-line${l.on ? ' on' : ''}`} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 10 }}>
              <div className="row">
                <label className="check grow">
                  <input type="checkbox" checked={l.on} onChange={(e) => setLine(i.id, { on: e.target.checked })} />
                  <b>
                    {i.name}
                    {i.variantTitle ? ` ${i.variantTitle}` : ''}
                  </b>
                  <span className="muted small"> · {t('sav.ex.ordered', { n: i.qty, p: da(i.unitPrice) })}</span>
                </label>
                {i.qty > 1 && (
                  <label className="row small">
                    <span className="muted">{t('sav.ex.qty')}</span>
                    <input type="number" min={1} max={i.qty} value={l.qty} style={{ width: 70 }} onChange={(e) => setLine(i.id, { qty: Math.min(i.qty, Math.max(1, Number(e.target.value) || 1)) })} />
                  </label>
                )}
              </div>
              {l.on && kind === 'same' && <p className="muted small">{t('sav.ex.sameInfo')}</p>}
              {l.on && kind === 'variant' &&
                (sib.length ? (
                  <label className="field">
                    <span className="lab">{t('sav.ex.newVariant')}</span>
                    <select value={l.variantId ?? ''} onChange={(e) => setLine(i.id, { variantId: Number(e.target.value) || null })}>
                      <option value="">—</option>
                      {sib.map((v) => (
                        <option key={v.variantId} value={v.variantId}>
                          {v.title || v.name} · {da(v.price)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="muted small">{t('sav.ex.noVariant')}</p>
                ))}
              {l.on && kind === 'other_product' && (
                <label className="field">
                  <span className="lab">{t('sav.ex.newProduct')}</span>
                  <select value={l.variantId ?? ''} onChange={(e) => setLine(i.id, { variantId: Number(e.target.value) || null })}>
                    <option value="">—</option>
                    {others.map((v) => (
                      <option key={v.variantId} value={v.variantId}>
                        {v.name}
                        {v.title ? ` ${v.title}` : ''} · {da(v.price)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          );
        })}
        {kind === 'parts' && (
          <div className="field">
            <span className="lab">{t('sav.ex.parts')}</span>
            {allParts.map((p) => (
              <div key={p} className="row">
                <label className="check grow">
                  <input
                    type="checkbox"
                    checked={p in partSel}
                    onChange={(e) =>
                      setPartSel((s) => {
                        const n = { ...s };
                        if (e.target.checked) n[p] = 1;
                        else delete n[p];
                        return n;
                      })
                    }
                  />
                  {p}
                </label>
                <input type="number" min={1} max={99} value={partSel[p] ?? 1} style={{ width: 70 }} onChange={(e) => setPartSel((s) => ({ ...s, [p]: Math.max(1, Number(e.target.value) || 1) }))} />
              </div>
            ))}
            <input value={freePart} placeholder={t('sav.ex.partName')} onChange={(e) => setFreePart(e.target.value)} />
          </div>
        )}
        <div className="grid2">
          <label className="field">
            <span className="lab">{t('sav.ex.fee')}</span>
            <input type="number" min={0} step={50} value={fee} className="ltr" onChange={(e) => setFee(Math.max(0, Number(e.target.value) || 0))} />
            <small className="muted">{fee === suggestedFee ? t('sav.ex.feeTariff') : t('sav.ex.feeChanged', { v: da(suggestedFee) })}</small>
          </label>
          <label className="field">
            <span className="lab">{t('sav.ex.note')}</span>
            <input value={note} placeholder={t('sav.ex.notePh')} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        <div className="totals">
          <span>{t('sav.ex.diff', { v: da(diff) })}</span>
          <span>{t('sav.ex.feeL', { v: da(fee) })}</span>
          <span className="grand">{t('sav.ex.total', { v: da(diff + fee) })}</span>
        </div>
        {err && <p className="form-err">{err}</p>}
      </div>
    </Modal>
  );
}
