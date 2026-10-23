// Fournisseurs & achats: what was bought, from whom, into which depot, and what is still to pay; the suppliers with
// their phone, what was bought from each and what is owed. A purchase opens with its lines and its payment.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, dateOnly, dateTime, n } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Empty, ErrorBox, Field, Icon, Kpi, Kpis, Loading, Pager } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { Filters, SearchBox } from '../ai/agent';
import { useDebounced } from './OrderList';
import { PurchaseForm } from './PurchaseForm';
import { bidi, MoneyInput, Toolbar, useDepots } from './stockui';

type View = 'all' | 'unpaid' | 'suppliers';
type Supplier = Out<'suppliers.list'>[number];

export function Achats({ open }: { open?: number }) {
  const { t } = useTranslation();
  const { many } = useDepots();
  const [view, setView] = useState<View>('all');
  const [q, setQ] = useState('');
  const [sup, setSup] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, sup, view, size]);
  const list = useRpc('purchases.list', { q: dq || undefined, supplierId: sup ? Number(sup) : undefined, unpaid: view === 'unpaid', page, pageSize: size });
  const sups = useRpc('suppliers.list', { all: true });
  const [detail, setDetail] = useState<number | null>(open ?? null);
  const [form, setForm] = useState(false);
  const [supEdit, setSupEdit] = useState<Supplier | 'new' | null>(null);
  useEffect(() => setDetail(open ?? null), [open]);
  const sum = list.data?.summary;
  const activeSups = (sups.data ?? []).filter((s) => s.active);
  const closeDetail = () => {
    setDetail(null);
    if (open) history.replaceState(null, '', '#/produits/achats');
  };
  return (
    <>
      <Kpis>
        <Kpi label={t('produits.buys.kDue')} value={da(sum?.due ?? 0)} sub={t('produits.buys.kDueSub', { count: sum?.unpaid ?? 0 })} icon="wallet" tone={sum?.due ? 'bad' : undefined} onClick={() => setView('unpaid')} />
        <Kpi label={t('produits.buys.kMonth')} value={da(sum?.monthTotal ?? 0)} sub={t('produits.buys.kMonthSub', { count: sum?.monthCount ?? 0 })} icon="receipt" />
        <Kpi label={t('produits.buys.kSuppliers')} value={n(activeSups.length)} sub={t('produits.buys.kSuppliersSub')} icon="briefcase" onClick={() => setView('suppliers')} />
      </Kpis>
      <section className="card pd-card">
        <Toolbar
          action={
            view === 'suppliers' ? (
              <button type="button" className="btn primary" onClick={() => setSupEdit('new')}>
                <Icon name="plus" />
                {t('produits.sup.new')}
              </button>
            ) : (
              <button type="button" className="btn primary" onClick={() => setForm(true)}>
                <Icon name="plus" />
                {t('produits.buys.new')}
              </button>
            )
          }
        >
          <Filters<View>
            value={view}
            onChange={setView}
            label={t('produits.buys.views')}
            items={[
              { value: 'all', label: t('produits.buys.vAll'), count: sum?.count },
              { value: 'unpaid', label: t('produits.buys.vUnpaid'), count: sum?.unpaid, alert: true },
              { value: 'suppliers', label: t('produits.buys.vSuppliers'), count: activeSups.length },
            ]}
          />
          {view !== 'suppliers' && (
            <>
              <SearchBox value={q} onChange={setQ} placeholder={t('produits.buys.searchPh')} />
              <div className="pd-sels">
                <select className={`pd-sel ${sup ? 'on' : ''}`} aria-label={t('produits.buys.supplier')} value={sup} onChange={(e) => setSup(e.target.value)}>
                  <option value="">{t('produits.buys.allSuppliers')}</option>
                  {(sups.data ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
        </Toolbar>
        {view === 'suppliers' ? (
          <Suppliers
            list={sups.data}
            loading={sups.isLoading}
            error={sups.error}
            retry={() => sups.refetch()}
            onEdit={setSupEdit}
            onBuys={(id) => {
              setSup(String(id));
              setView('all');
            }}
          />
        ) : list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} onRetry={() => list.refetch()} />
        ) : !list.data?.rows.length ? (
          <Empty>{dq || sup ? t('produits.ui.noMatch') : view === 'unpaid' ? t('produits.buys.allPaid') : t('produits.buys.empty')}</Empty>
        ) : (
          <>
            <div className="pd-list">
              <div className={`pd-row pd-head pd-buy ${many ? 'many' : ''}`} aria-hidden="true">
                <span className="a-ref">{t('produits.buys.ref')}</span>
                <span className="a-sup">{t('produits.buys.supplier')}</span>
                {many && <span className="a-depot">{t('produits.buys.depot')}</span>}
                <span className="a-pieces num">{t('produits.buys.pieces')}</span>
                <span className="a-total num">{t('produits.buys.total')}</span>
                <span className="a-paid num">{t('produits.buys.paid')}</span>
                <span className="a-state">{t('produits.buys.state')}</span>
              </div>
              {list.data.rows.map((r) => (
                <div
                  key={r.id}
                  className={`pd-row pd-buy pd-click ${many ? 'many' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${r.ref} · ${r.supplierName ?? t('produits.buy.noSupplier')}`}
                  onClick={() => setDetail(r.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setDetail(r.id))}
                >
                  <span className="a-ref pd-buyref">
                    <b className="ltr">{r.ref}</b>
                    <small>{dateOnly(r.at)}</small>
                  </span>
                  <span className="a-sup pd-name">
                    <b>{r.supplierName ?? t('produits.buy.noSupplier')}</b>
                    {r.note && <small className="pd-ell">{r.note}</small>}
                  </span>
                  <span className="pd-sub">
                    {many && (
                      <span className="a-depot">{r.warehouseName}</span>
                    )}
                    <span className="a-pieces num" data-l={t('produits.buys.pieces')}>
                      <span className="ltr">{n(r.pieces)}</span>
                    </span>
                    <span className="a-total num" data-l={t('produits.buys.total')}>
                      <b className="ltr">{da(r.total)}</b>
                    </span>
                    <span className="a-paid num" data-l={t('produits.buys.paid')}>
                      <span className="ltr">{da(r.paid)}</span>
                    </span>
                  </span>
                  <span className="a-state">
                    <PayBadge due={r.due} paid={r.paid} />
                  </span>
                </div>
              ))}
            </div>
            <Pager page={page} pageSize={size} total={list.data.total} onPage={setPage} onSize={setSize} />
          </>
        )}
      </section>
      {form && <PurchaseForm onClose={() => setForm(false)} />}
      {detail !== null && <PurchaseDetail id={detail} onClose={closeDetail} />}
      {supEdit && <SupplierForm s={supEdit === 'new' ? null : supEdit} onClose={() => setSupEdit(null)} />}
    </>
  );
}

function PayBadge({ due, paid }: { due: number; paid: number }) {
  const { t } = useTranslation();
  if (due <= 0) return <span className="badge t-ok">{t('produits.buys.isPaid')}</span>;
  return <span className={`badge ${paid > 0 ? 't-warn' : 't-bad'}`}>{t('produits.buys.left', { amount: bidi(da(due)) })}</span>;
}

function Suppliers({ list, loading, error, retry, onEdit, onBuys }: { list?: Supplier[]; loading: boolean; error: Error | null; retry: () => void; onEdit: (s: Supplier) => void; onBuys: (id: number) => void }) {
  const { t } = useTranslation();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={retry} />;
  if (!list?.length) return <Empty>{t('produits.sup.empty')}</Empty>;
  return (
    <ul className="pd-sups">
      {list.map((s) => (
        <li key={s.id} className={`pd-sup ${s.active ? '' : 'dim'}`}>
          <div className="pd-sup-top">
            <span className="pd-sup-av" aria-hidden="true">
              <Icon name="briefcase" />
            </span>
            <span className="pd-name">
              <b>{s.name}</b>
              <small>
                {s.address || t('produits.sup.noAddress')}
                {!s.active && <span className="chip">{t('produits.sup.archived')}</span>}
              </small>
            </span>
            {s.phone && (
              <a className="btn small pd-call" href={`tel:${s.phone.replace(/\s/g, '')}`} aria-label={t('produits.sup.call', { name: s.name })}>
                <Icon name="phone" />
                <span className="ltr">{s.phone}</span>
              </a>
            )}
          </div>
          {s.note && <p className="pd-sup-note">{s.note}</p>}
          <dl className="pd-sup-kv">
            <div>
              <dt>{t('produits.sup.bought')}</dt>
              <dd className="ltr">{da(s.total)}</dd>
            </div>
            <div>
              <dt>{t('produits.sup.purchases')}</dt>
              <dd>{s.purchases ? t('produits.sup.purchasesN', { count: s.purchases, when: dateOnly(s.lastAt) }) : '—'}</dd>
            </div>
            <div className={s.due > 0 ? 'due' : ''}>
              <dt>{t('produits.sup.due')}</dt>
              <dd className="ltr">{s.due > 0 ? da(s.due) : t('produits.buys.isPaid')}</dd>
            </div>
          </dl>
          <div className="pd-sup-acts">
            <button type="button" className="btn small" disabled={!s.purchases} onClick={() => onBuys(s.id)}>
              <Icon name="receipt" />
              {t('produits.sup.seeBuys')}
            </button>
            <button type="button" className="btn small" onClick={() => onEdit(s)}>
              <Icon name="pencil" />
              {t('common.edit')}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function SupplierForm({ s, onClose }: { s: Supplier | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [v, setV] = useState({ name: s?.name ?? '', phone: s?.phone ?? '', address: s?.address ?? '', note: s?.note ?? '', active: s?.active ?? true });
  const save = useAction('suppliers.save', { success: t('produits.sup.saved'), onDone: onClose });
  const submit = () => {
    if (!v.name.trim()) return toast(t('produits.sup.nameRequired'), 'bad');
    save.mutate({ id: s?.id, ...v, name: v.name.trim() });
  };
  return (
    <Modal
      title={s ? t('produits.sup.editTitle', { name: bidi(s.name) }) : t('produits.sup.newTitle')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={save.isPending} onClick={submit}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <form
        className="pd-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="pd-grid2">
          <Field label={t('produits.sup.name')}>
            <input value={v.name} maxLength={120} onChange={(e) => setV({ ...v, name: e.target.value })} />
          </Field>
          <Field label={t('produits.sup.phone')}>
            <input value={v.phone} maxLength={40} inputMode="tel" className="ltr" onChange={(e) => setV({ ...v, phone: e.target.value })} />
          </Field>
        </div>
        <Field label={t('produits.sup.address')}>
          <input value={v.address} maxLength={300} onChange={(e) => setV({ ...v, address: e.target.value })} />
        </Field>
        <Field label={t('produits.sup.note')}>
          <textarea value={v.note} maxLength={500} rows={3} placeholder={t('produits.sup.notePh')} onChange={(e) => setV({ ...v, note: e.target.value })} />
        </Field>
        {s && (
          <label className="dl-switch">
            <input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} />
            <span>
              <b>{t('produits.sup.active')}</b>
              <small>{t('produits.sup.activeHint')}</small>
            </span>
          </label>
        )}
      </form>
    </Modal>
  );
}

function PurchaseDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useTranslation();
  const p = useRpc('purchases.get', { id });
  const [paid, setPaid] = useState<number | ''>('');
  useEffect(() => {
    if (p.data) setPaid(p.data.paid);
  }, [p.data]);
  const pay = useAction('purchases.pay', { success: t('produits.buys.paySaved') });
  const d = p.data;
  return (
    <Modal title={d ? `${d.ref} · ${d.supplierName ?? t('produits.buy.noSupplier')}` : t('common.loading')} onClose={onClose} wide className="pd-sheet">
      {p.isLoading ? (
        <Loading />
      ) : p.error || !d ? (
        <ErrorBox error={p.error} onRetry={() => p.refetch()} />
      ) : (
        <div className="pd-form">
          <dl className="ai-kv pd-kv">
            <dt>{t('produits.buys.date')}</dt>
            <dd>{dateTime(d.at)}</dd>
            <dt>{t('produits.buys.depot')}</dt>
            <dd>{d.warehouseName}</dd>
            {d.userName && (
              <>
                <dt>{t('produits.buys.by')}</dt>
                <dd>{d.userName}</dd>
              </>
            )}
            {d.note && (
              <>
                <dt>{t('produits.buys.note')}</dt>
                <dd>{d.note}</dd>
              </>
            )}
          </dl>
          <ul className="pd-lines-l pd-ro">
            {d.lineItems.map((l) => (
              <li key={l.variantId} className="pd-line">
                <span className="pd-name">
                  <b>{l.label}</b>
                  <small className="ltr">{l.sku}</small>
                </span>
                <span className="pd-ro-q ltr">
                  {n(l.qty)} × {da(l.unitCost)}
                </span>
                <b className="pd-amount ltr">{da(l.amount)}</b>
              </li>
            ))}
          </ul>
          <div className="pd-total">
            <span>
              <small>{t('produits.buy.total', { count: d.pieces })}</small>
              <b className="ltr">{da(d.total)}</b>
            </span>
            <label className="pd-in">
              <small className="pd-lab">{t('produits.buys.paidSoFar')}</small>
              <span className="pd-paid">
                <MoneyInput value={paid} label={t('produits.buys.paidSoFar')} onChange={setPaid} />
                <button type="button" className="btn small" onClick={() => setPaid(d.total)}>
                  {t('produits.buy.payAll')}
                </button>
              </span>
            </label>
            <span className={d.total - (paid === '' ? 0 : paid) > 0 ? 'due' : ''}>
              <small>{t('produits.buy.due')}</small>
              <b className="ltr">{da(Math.max(0, d.total - (paid === '' ? 0 : paid)))}</b>
            </span>
          </div>
          <div className="pd-detail-acts">
            <a className="btn" href={`#/produits/mouvements/${d.ref}`}>
              <Icon name="swap" />
              {t('produits.buys.seeMoves')}
            </a>
            <span className="grow" />
            <button
              type="button"
              className="btn primary"
              disabled={pay.isPending || paid === '' || paid === d.paid}
              onClick={() => {
                if (paid === '' || paid > d.total) return toast(t('produits.buy.paidTooMuch'), 'bad');
                pay.mutate({ id: d.id, paid });
              }}
            >
              <Icon name="wallet" />
              {t('produits.buys.savePay')}
            </button>
          </div>
          {d.paidAt && <p className="pd-note">{t('produits.buys.lastPay', { when: dateTime(d.paidAt) })}</p>}
        </div>
      )}
    </Modal>
  );
}
