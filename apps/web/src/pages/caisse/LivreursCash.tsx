// Livreurs' cash: parcels in hand, delivered (cashed or not), their share ("Ta part" for a livreur), what to collect.
// Shown in Caisse and in Sociétés de livraison → Livreurs (admin), and to a livreur for himself.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Empty, ErrorBox, Kpi, Kpis, Loading } from '../../ui/kit';
import { useIsPhone } from '../../lib/useMedia';
import { LivreursCashPhone } from './LivreursCashPhone';

export function LivreursCash({ livreurId }: { livreurId?: number }) {
  const phone = useIsPhone();
  return phone ? <LivreursCashPhone livreurId={livreurId} /> : <LivreursCashDesktop livreurId={livreurId} />;
}

function LivreursCashDesktop({ livreurId: fixed }: { livreurId?: number }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const self = !admin && !!session?.roles.includes('livreur') && !session.roles.includes('suivi');
  const [pick, setPick] = useState<number | undefined>(fixed);
  const q = useRpc('cash.livreurs', { livreurId: fixed ?? pick });
  const people = useRpc('delivery.livreurs', {}, { enabled: !self && !fixed });
  const [filter, setFilter] = useState<'non' | 'enc' | 'tous'>('non');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState<null | { all: boolean }>(null);
  const collect = useAction('cash.livreurCollect', { success: (r) => t('caisse.lv.collected', { count: r.orders }), onDone: () => (setSel(new Set()), setConfirm(null)) });

  const data = q.data;
  const one = data && data.livreurs.length === 1 ? data.livreurs[0] : null;
  const delivered = useMemo(() => (data?.delivered ?? []).filter((o) => (filter === 'non' ? !o.cashed : filter === 'enc' ? o.cashed : true)), [data, filter]);
  const notCashed = (data?.delivered ?? []).filter((o) => !o.cashed);
  const selList = notCashed.filter((o) => sel.has(o.id));
  const selSum = selList.reduce((s, o) => s + o.total, 0);
  const selShare = selList.reduce((s, o) => s + o.share, 0);

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!data) return null;
  const tot = data.livreurs.reduce(
    (a, l) => ({ inHand: a.inHand + l.inHand, inHandValue: a.inHandValue + l.inHandValue, delivered: a.delivered + l.delivered, cashed: a.cashed + l.cashed, cashedAmount: a.cashedAmount + l.cashedAmount, notCashed: a.notCashed + l.notCashed, notCashedAmount: a.notCashedAmount + l.notCashedAmount, share: a.share + l.share, net: a.net + l.net }),
    { inHand: 0, inHandValue: 0, delivered: 0, cashed: 0, cashedAmount: 0, notCashed: 0, notCashedAmount: 0, share: 0, net: 0 },
  );
  const k = one ?? tot;

  return (
    <div className="bjliv" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section className="card">
        <div className="card-head">
          <h2>{self ? t('caisse.lv.myTitle') : one ? t('caisse.lv.titleOne', { name: one.name }) : t('caisse.lv.title')}</h2>
          {!fixed && !self && (
            <select value={pick ?? ''} onChange={(e) => (setPick(e.target.value ? Number(e.target.value) : undefined), setSel(new Set()))} aria-label={t('caisse.lv.livreur')} style={{ width: 'auto' }}>
              <option value="">{t('caisse.lv.all')}</option>
              {(people.data ?? data.livreurs).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <Kpis>
          <Kpi label={t('caisse.lv.inHand')} value={k.inHand} sub={t('caisse.lv.value', { amount: da(k.inHandValue) })} />
          <Kpi label={t('caisse.lv.delivered')} value={k.delivered} sub={t('caisse.lv.deliveredSub')} />
          <Kpi label={t('caisse.lv.cashed')} value={da(k.cashedAmount)} sub={t('caisse.lv.parcels', { count: k.cashed })} tone="ok" />
          <Kpi label={t('caisse.lv.notCashed')} value={da(k.notCashedAmount)} sub={t('caisse.lv.parcels', { count: k.notCashed })} tone={k.notCashed ? 'warn' : undefined} />
          <Kpi label={self ? t('caisse.lv.yourShare') : t('caisse.lv.share')} value={da(k.share)} sub={t('caisse.lv.shareSub', { light: da(data.pay.light), heavy: da(data.pay.heavy) })} />
          <Kpi label={t('caisse.lv.net')} value={da(k.net)} sub={self ? t('caisse.lv.netSubSelf') : t('caisse.lv.netSub')} tone="ok" />
        </Kpis>
        {!one && data.livreurs.length > 1 && (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('caisse.lv.livreur')}</th>
                  <th className="num">{t('caisse.lv.inHand')}</th>
                  <th className="num">{t('caisse.lv.delivered')}</th>
                  <th className="num">{t('caisse.lv.notCashed')}</th>
                  <th className="num">{t('caisse.lv.share')}</th>
                  <th className="num">{t('caisse.lv.net')}</th>
                </tr>
              </thead>
              <tbody>
                {data.livreurs.map((l) => (
                  <tr key={l.id} className="clickable" onClick={() => setPick(l.id)}>
                    <td data-l={t('caisse.lv.livreur')}>
                      <b>{l.name}</b>
                    </td>
                    <td className="num" data-l={t('caisse.lv.inHand')}>
                      {l.inHand}
                    </td>
                    <td className="num" data-l={t('caisse.lv.delivered')}>
                      {l.delivered}
                    </td>
                    <td className="num" data-l={t('caisse.lv.notCashed')}>
                      {da(l.notCashedAmount)}
                    </td>
                    <td className="num" data-l={t('caisse.lv.share')}>
                      {da(l.share)}
                    </td>
                    <td className="num" data-l={t('caisse.lv.net')}>
                      <b>{da(l.net)}</b>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>
            {t('caisse.lv.deliveredTitle')} <span className="count ltr">{delivered.length}</span>
          </h2>
          <div className="seg" role="group" aria-label={t('common.filters')}>
            {(['non', 'enc', 'tous'] as const).map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {t(`caisse.lv.f.${f}`)}
              </button>
            ))}
          </div>
        </div>
        {admin && one && notCashed.length > 0 && (
          <div className="row" style={{ marginBottom: 10 }}>
            <button className="btn primary" disabled={!selList.length} onClick={() => setConfirm({ all: false })}>
              {t('caisse.lv.collectSel', { count: selList.length, amount: da(selSum) })}
            </button>
            <button className="btn" onClick={() => setConfirm({ all: true })}>
              {t('caisse.lv.collectAll', { count: notCashed.length, amount: da(one.notCashedAmount) })}
            </button>
            <span className="note muted small">{t('caisse.lv.collectNote', { light: da(data.pay.light), heavy: da(data.pay.heavy) })}</span>
          </div>
        )}
        {confirm && one && (
          <div className="confirm card" style={{ background: 'var(--raise)' }} role="alertdialog">
            <p>
              {confirm.all
                ? t('caisse.lv.confirmAll', { name: one.name, amount: da(one.notCashedAmount), share: da(one.share), net: da(one.net) })
                : t('caisse.lv.confirmSel', { name: one.name, amount: da(selSum), share: da(selShare), net: da(selSum - selShare) })}
            </p>
            <div className="row">
              <button className="btn ok" disabled={collect.isPending} onClick={() => collect.mutate(confirm.all ? { livreurId: one.id, all: true } : { livreurId: one.id, ids: selList.map((o) => o.id) })}>
                {t('caisse.lv.confirmBtn')}
              </button>
              <button className="btn" onClick={() => setConfirm(null)}>
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}
        {!delivered.length ? (
          <Empty>{filter === 'non' ? t('caisse.lv.allCashed') : t('common.noData')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  {admin && one && (
                    <th className="chk">
                      <input
                        type="checkbox"
                        aria-label={t('caisse.selectAll')}
                        checked={notCashed.length > 0 && notCashed.every((o) => sel.has(o.id))}
                        onChange={(e) => setSel(e.target.checked ? new Set(notCashed.map((o) => o.id)) : new Set())}
                      />
                    </th>
                  )}
                  <th>{t('caisse.col.order')}</th>
                  <th>{t('caisse.col.customer')}</th>
                  <th className="wide">{t('caisse.col.products')}</th>
                  <th>{t('caisse.col.variant')}</th>
                  {!one && <th>{t('caisse.lv.livreur')}</th>}
                  <th className="num">{t('caisse.col.amount')}</th>
                  <th className="num">{self ? t('caisse.lv.yourShare') : t('caisse.lv.share')}</th>
                  <th className="num">{t('caisse.lv.state')}</th>
                </tr>
              </thead>
              <tbody>
                {delivered.map((o) => (
                  <tr key={o.id}>
                    {admin && one && (
                      <td className="chk">
                        {!o.cashed && (
                          <input
                            type="checkbox"
                            aria-label={t('caisse.select')}
                            checked={sel.has(o.id)}
                            onChange={(e) => {
                              const n = new Set(sel);
                              e.target.checked ? n.add(o.id) : n.delete(o.id);
                              setSel(n);
                            }}
                          />
                        )}
                      </td>
                    )}
                    <td data-l={t('caisse.col.order')}>
                      <b className="ltr">{o.ref}</b>
                      <small>{when(o.deliveredAt)}</small>
                    </td>
                    <td data-l={t('caisse.col.customer')}>
                      {o.customerName}
                      <small>{o.commune}</small>
                    </td>
                    <td className="wide px-cw" data-l={t('caisse.col.products')}>
                      <div className="px-clamp">{o.products}</div>
                    </td>
                    <td data-l={t('caisse.col.variant')}>
                      <div className="px-clamp">{o.variants || '—'}</div>
                    </td>
                    {!one && <td data-l={t('caisse.lv.livreur')}>{o.livreurName}</td>}
                    <td className="num" data-l={t('caisse.col.amount')}>
                      {da(o.total)}
                    </td>
                    <td className="num" data-l={t('caisse.lv.share')}>
                      {da(o.share)}
                      <small>{o.heavy ? t('caisse.lv.heavy') : t('caisse.lv.light')}</small>
                    </td>
                    <td className="num" data-l={t('caisse.lv.state')}>
                      <span className={`badge t-${o.cashed ? 'ok' : 'warn'}`}>{o.cashed ? t('caisse.lv.isCashed') : t('caisse.lv.isNotCashed')}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>
            {t('caisse.lv.inHandTitle')} <span className="count ltr">{data.inHand.length}</span>
          </h2>
        </div>
        {!data.inHand.length ? (
          <Empty>{t('caisse.lv.noneInHand')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('caisse.col.order')}</th>
                  <th>{t('caisse.col.customer')}</th>
                  <th className="wide">{t('caisse.col.products')}</th>
                  <th>{t('caisse.col.variant')}</th>
                  {!one && <th>{t('caisse.lv.livreur')}</th>}
                  <th className="num">{t('caisse.col.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {data.inHand.map((o) => (
                  <tr key={o.id}>
                    <td data-l={t('caisse.col.order')}>
                      <b className="ltr">{o.ref}</b>
                    </td>
                    <td data-l={t('caisse.col.customer')}>
                      {o.customerName}
                      <small>
                        {o.commune} · <span className="ltr">{o.phone}</span>
                      </small>
                    </td>
                    <td className="wide px-cw" data-l={t('caisse.col.products')}>
                      <div className="px-clamp">{o.products}</div>
                    </td>
                    <td data-l={t('caisse.col.variant')}>
                      <div className="px-clamp">{o.variants || '—'}</div>
                    </td>
                    {!one && <td data-l={t('caisse.lv.livreur')}>{o.livreurName}</td>}
                    <td className="num" data-l={t('caisse.col.amount')}>
                      {da(o.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
