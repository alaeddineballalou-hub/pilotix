// Dépôts & transferts: each depot with what it holds (products, pieces, value at purchase price), the administrator's
// way to add, change, hide (masquer) or delete one, and stock moved between depots — several products in one transfer, all or nothing.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateTime, n, wilayaName } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Empty, ErrorBox, Field, Icon, Loading, Pager } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { ConfirmButton } from '../admin/bits';
import { DepotForm, Wh } from '../admin/DepotForm';
import { bidi, nameOf, PickItem, ProductPicker, Stepper, Toolbar, useDepots } from './stockui';

export function Depots() {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const dep = useRpc('catalog.depots', {});
  const [edit, setEdit] = useState<Wh | 'new' | null>(null);
  const [move, setMove] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const tr = useRpc('catalog.transfers', { page, pageSize: 20 });
  const show = useAction('admin.warehouses.save', { success: (r) => t(r.active ? 'produits.depots.shown' : 'produits.depots.hidden') });
  const del = useAction('admin.warehouses.delete', { success: t('produits.depots.deleted') });
  const toggle = (d: Wh) => show.mutate({ id: d.id, name: d.name, wilayaId: d.wilayaId, commune: d.commune, address: d.address, isDefault: d.isDefault, active: !d.active });
  const active = (dep.data ?? []).filter((d) => d.active);
  const canMove = active.length > 1;
  return (
    <>
      <section className="card pd-card">
        <Toolbar
          action={
            <>
              {admin && (
                <button type="button" className="btn" onClick={() => setEdit('new')}>
                  <Icon name="plus" />
                  {t('produits.depots.new')}
                </button>
              )}
              <button type="button" className="btn primary" disabled={!canMove} title={canMove ? undefined : t('produits.depots.needTwo')} onClick={() => setMove(active[0]?.id ?? null)}>
                <Icon name="swap" />
                {t('produits.depots.transfer')}
              </button>
            </>
          }
        >
          <p className="pd-tools-t">{t('produits.depots.count', { count: active.length })}</p>
        </Toolbar>
        {dep.isLoading ? (
          <Loading />
        ) : dep.error ? (
          <ErrorBox error={dep.error} onRetry={() => dep.refetch()} />
        ) : (
          <ul className="pd-depots">
            {(dep.data ?? []).map((d) => (
              <li key={d.id} className={`pd-depot-c ${d.active ? '' : 'dim'}`}>
                <div className="pd-depot-top">
                  <span className="pd-depot-ic" aria-hidden="true">
                    <Icon name="building" />
                  </span>
                  <span className="pd-name">
                    <b>{d.name}</b>
                    <small>
                      <span>
                        {d.commune && (
                          <>
                            <bdi>{d.commune}</bdi>,{' '}
                          </>
                        )}
                        {wilayaName(d.wilayaId)}
                      </span>
                    </small>
                  </span>
                  {d.isDefault && <span className="pd-lvl def">{t('produits.depots.default')}</span>}
                  {!d.active && <span className="pd-lvl off">{t('produits.depots.inactive')}</span>}
                </div>
                {d.address && <p className="pd-sup-note">{d.address}</p>}
                <dl className="pd-sup-kv">
                  <div>
                    <dt>{t('produits.depots.products')}</dt>
                    <dd className="ltr">{n(d.products)}</dd>
                  </div>
                  <div>
                    <dt>{t('produits.depots.pieces')}</dt>
                    <dd className="ltr">{n(d.pieces)}</dd>
                  </div>
                  <div>
                    <dt>{t('produits.depots.value')}</dt>
                    <dd className="ltr">{da(d.value)}</dd>
                  </div>
                </dl>
                <div className="pd-sup-acts">
                  {d.active && canMove && (
                    <button type="button" className="btn small" onClick={() => setMove(d.id)}>
                      <Icon name="swap" />
                      {t('produits.depots.moveFrom')}
                    </button>
                  )}
                  {admin && (
                    <button type="button" className="btn small" onClick={() => setEdit(d)}>
                      <Icon name="pencil" />
                      {t('common.edit')}
                    </button>
                  )}
                  {admin && !d.isDefault && (
                    <button type="button" className="btn small" disabled={show.isPending} onClick={() => toggle(d)}>
                      <Icon name={d.active ? 'eyeoff' : 'eye'} />
                      {d.active ? t('produits.depots.hide') : t('produits.depots.show')}
                    </button>
                  )}
                  {admin && !d.isDefault && (
                    <ConfirmButton className="btn small ghost danger" disabled={del.isPending} question={t('produits.depots.deleteConfirm')} onConfirm={() => del.mutate({ id: d.id })}>
                      <Icon name="trash" />
                      {t('produits.depots.delete')}
                    </ConfirmButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {admin && !dep.isLoading && <p className="pd-note">{t('produits.depots.hideHelp')}</p>}
        {!canMove && !dep.isLoading && <p className="pd-note">{admin ? t('produits.depots.oneAdmin') : t('produits.depots.one')}</p>}
      </section>

      <section className="card pd-card">
        <div className="card-head">
          <h2>{t('produits.depots.transfers')}</h2>
        </div>
        {tr.isLoading ? (
          <Loading />
        ) : tr.error ? (
          <ErrorBox error={tr.error} onRetry={() => tr.refetch()} />
        ) : !tr.data?.rows.length ? (
          <Empty>{t('produits.depots.noTransfers')}</Empty>
        ) : (
          <>
            <div className="pd-list">
              <div className="pd-row pd-head pd-tr" aria-hidden="true">
                <span className="a-when">{t('produits.moves.when')}</span>
                <span className="a-name">{t('produits.moves.product')}</span>
                <span className="a-qty num">{t('produits.moves.qty')}</span>
                <span className="a-route">{t('produits.depots.route')}</span>
              </div>
              {tr.data.rows.map((r) => (
                <div key={r.id} className="pd-row pd-tr">
                  <span className="a-name pd-name">
                    <b>{r.label}</b>
                    <small className="ltr">{r.sku}</small>
                  </span>
                  <span className="a-qty num">
                    <b className="pd-qty ltr">{n(r.qty)}</b>
                  </span>
                  <span className="pd-sub">
                    <span className="a-route">
                      <span className="pd-path">
                        <span>{r.fromName}</span>
                        <Icon name="arrow" className="pd-arrow" />
                        <span>{r.toName}</span>
                      </span>
                      {r.note && !r.note.includes('→') && <small className="pd-muted">{r.note}</small>}
                    </span>
                    <span className="a-when pd-muted">
                      <span className="ltr">{dateTime(r.at)}</span>
                      {r.userName && <small>{r.userName}</small>}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            <Pager page={page} pageSize={20} total={tr.data.total} onPage={setPage} />
          </>
        )}
      </section>
      {edit && <DepotForm w={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {move !== null && <TransferForm from={move} onClose={() => setMove(null)} />}
    </>
  );
}

type TLine = { variantId: number; label: string; sku: string; have: number; qty: number | '' };

/** Several products from one depot to another, in one go. */
function TransferForm({ from: start, onClose }: { from: number; onClose: () => void }) {
  const { t } = useTranslation();
  const { depots } = useDepots();
  const [from, setFrom] = useState(start);
  const [to, setTo] = useState<number>(() => depots.find((d) => d.id !== start)?.id ?? 0);
  const [lines, setLines] = useState<TLine[]>([]);
  const [note, setNote] = useState('');
  const st = useRpc('catalog.stock', { warehouseId: from });
  const items: PickItem[] = useMemo(() => (st.data ?? []).filter((r) => r.qty > 0).map((r) => ({ variantId: r.variantId, label: nameOf(r), sku: r.sku, cost: r.cost, stock: r.qty, note: t('produits.depots.have', { n: r.qty }) })), [st.data, t]);
  const go = useAction('catalog.transferMany', { success: (r) => t('produits.depots.done', { count: r.pieces, from: bidi(depots.find((d) => d.id === from)?.name), to: bidi(depots.find((d) => d.id === to)?.name) }), onDone: onClose });
  const pieces = lines.reduce((s, l) => s + (l.qty === '' ? 0 : l.qty), 0);
  const changeFrom = (id: number) => {
    setFrom(id);
    setLines([]);
    if (id === to) setTo(depots.find((d) => d.id !== id)?.id ?? 0);
  };
  const submit = () => {
    if (!lines.length) return toast(t('produits.depots.noLines'), 'bad');
    const bad = lines.find((l) => l.qty === '' || l.qty < 1 || l.qty > l.have);
    if (bad) return toast(t('produits.depots.badLine', { name: bad.label, n: bad.have }), 'bad');
    go.mutate({ from, to, lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qty as number })), note: note.trim() });
  };
  return (
    <Modal
      title={t('produits.depots.transferTitle')}
      onClose={onClose}
      wide
      className="pd-sheet"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={go.isPending || !lines.length || !to} onClick={submit}>
            <Icon name="swap" />
            {t('produits.depots.transferN', { count: pieces })}
          </button>
        </>
      }
    >
      <div className="pd-form">
        <div className="pd-route">
          <label>
            <small>{t('produits.stock.from')}</small>
            <select value={from} onChange={(e) => changeFrom(Number(e.target.value))}>
              {depots.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <Icon name="arrow" className="pd-arrow" />
          <label>
            <small>{t('produits.stock.toDepot')}</small>
            <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
              {depots
                .filter((w) => w.id !== from)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="pd-lines">
          <h3>{t('produits.depots.products')}</h3>
          <ProductPicker
            items={items}
            taken={new Set(lines.map((l) => l.variantId))}
            placeholder={t('produits.depots.addPh')}
            onPick={(it) => setLines((ls) => (ls.some((l) => l.variantId === it.variantId) ? ls : [...ls, { variantId: it.variantId, label: it.label, sku: it.sku, have: it.stock ?? 0, qty: 1 }]))}
          />
          {lines.length ? (
            <ul className="pd-lines-l">
              {lines.map((l) => (
                <li key={l.variantId} className="pd-line pd-tline">
                  <span className="pd-name">
                    <b>{l.label}</b>
                    <small>
                      <span className="ltr">{l.sku}</span>
                      <span>{t('produits.depots.have', { n: l.have })}</span>
                    </small>
                  </span>
                  <label className="pd-in">
                    <small className="pd-lab">{t('produits.buy.qty')}</small>
                    <Stepper value={l.qty} min={1} max={l.have} label={t('produits.buy.qtyOf', { name: l.label })} onChange={(v) => setLines((ls) => ls.map((x) => (x.variantId === l.variantId ? { ...x, qty: v } : x)))} />
                  </label>
                  <button type="button" className="btn small" onClick={() => setLines((ls) => ls.map((x) => (x.variantId === l.variantId ? { ...x, qty: x.have } : x)))}>
                    {t('produits.depots.all')}
                  </button>
                  <button type="button" className="icon-btn pd-x" aria-label={t('produits.buy.removeOf', { name: l.label })} onClick={() => setLines((ls) => ls.filter((x) => x.variantId !== l.variantId))}>
                    <Icon name="x" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pd-lines-empty">{t('produits.depots.empty')}</p>
          )}
        </div>
        <Field label={t('produits.stock.note')}>
          <input value={note} maxLength={300} placeholder={t('produits.depots.notePh')} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
