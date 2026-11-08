// « Caisse » (admin): Vue d'ensemble (main caisse, bank, companies with ZR payments, livreurs, employees' caisses) ·
// À recevoir (delivered, money not received yet, by company / livreur) · Déjà reçu (versements) · Livreurs · Journal.
// With « Toutes les boutiques »: every boutique's money added up, then boutique by boutique (boutiques/all.tsx).
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { downloadCsv } from '../../lib/files';
import { pageIsOn, payOn } from '../../lib/features';
import { da, dateTime, n, wilayaName, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { openOrder } from '../../lib/modals';
import { Empty, ErrorBox, Help, Kpi, Kpis, Loading, TicketTag } from '../../ui/kit';
import type { PageProps } from '../registry';
import { LivreursCash } from './LivreursCash';
import { useIsPhone } from '../../lib/useMedia';
import { useViewMode, ViewSwitch } from '../../ui/ViewSwitch';
import { PhoneCaisse } from './PhoneCaisse';
import { CaisseJournal, CaisseOverview } from './Overview';
import { PaieBoard } from './PaieBoard';
export { MaCaisse } from './MaPaie';
import { CopyCode } from '../../ui/CopyCode';
import { ClearFilters, CompanyFilter, DateFilters, dayIso, LivreurFilter } from '../../ui/filters';
import { useAllMode } from '../../layout/AllBoutiques';

/** « Caisse »: this boutique's, or every boutique's money with « Toutes les boutiques ». */
export function Caisse(p: PageProps) {
  const phone = useIsPhone();
  const all = useAllMode();
  if (all.on)
    return (
      <Suspense fallback={<Loading />}>
        <AllCaissePage {...p} />
      </Suspense>
    );
  // Caisse › Paie: the agents' pay (its own page, on phones as on computers)
  if (p.sub === 'paie' && payOn())
    return phone ? (
      <div className="pxk">
        <PhonePayTabs />
        <PaieBoard />
      </div>
    ) : (
      <>
        <CaisseHead current="paie" />
        <PaieBoard />
      </>
    );
  if (phone) return <PhoneCaisse sub={p.sub} />;
  return <CaisseWide sub={p.sub} />;
}

/** The phone's caisse tabs with « Paie » open (PhoneCaisse draws the same row on its own pages). */
function PhonePayTabs() {
  const { t } = useTranslation();
  return (
    <div className="pxv-own" role="tablist">
      <a role="tab" aria-selected={false} href="#/caisse/due">
        {t('caisse.ph.view')}
      </a>
      <a role="tab" aria-selected={false} href="#/caisse/done">
        {t('caisse.ph.journal')}
      </a>
      <a role="tab" aria-selected className="on" href="#/caisse/paie">
        {t('caisse.tabs.paie')}
      </a>
    </div>
  );
}
const AllCaissePage = lazy(() => import('../boutiques/all').then((m) => ({ default: m.BoutiquesCaisse })));

/** Computers: the phone's caisse laid out wide (the money outside at a glance, a tap opens it), or the tables. */
function CaisseWide({ sub }: PageProps) {
  const [mode, setMode] = useViewMode('caisse');
  return (
    <>
      <div className="px-vsw-row">
        <ViewSwitch mode={mode} onChange={setMode} />
      </div>
      {mode === 'cards' ? (
        <div className="px-wide">
          <PhoneCaisse sub={sub} />
        </div>
      ) : (
        <CaisseDesktop sub={sub} />
      )}
    </>
  );
}

/** The computer's caisse title and its tabs (Vue d'ensemble · À recevoir · Déjà reçu · Livreurs · Journal · Paie). */
function CaisseHead({ current }: { current: string }) {
  const { t } = useTranslation();
  const tabs = [
    { key: 'overview', label: t('caisse.dk.tabs.overview') },
    { key: 'due', label: t('caisse.tabs.due') },
    { key: 'done', label: t('caisse.tabs.done') },
    { key: 'livreurs', label: t('caisse.tabs.livreurs') },
    { key: 'journal', label: t('caisse.ph.journal') },
    { key: 'paie', label: t('caisse.tabs.paie') },
  ].filter((x) => (x.key === 'paie' ? payOn() : pageIsOn('caisse', x.key)));
  return (
    <div className="card">
      <div className="card-head">
        <h2>
          {t('caisse.title')}
          <Help text={t('caisse.help')} label={t('caisse.title')} />
        </h2>
        <div className="tabs" role="tablist">
          {tabs.map((x) => (
            <a key={x.key} role="tab" aria-selected={current === x.key} className={`tab ${current === x.key ? 'on' : ''}`} href={`#/caisse/${x.key}`} style={{ textDecoration: 'none' }}>
              {x.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

function CaisseDesktop({ sub }: PageProps) {
  const current = sub === 'done' || sub === 'livreurs' || sub === 'due' || sub === 'journal' ? sub : 'overview';
  return (
    <>
      <CaisseHead current={current} />
      {current === 'overview' && <CaisseOverview onOpenDue={() => (location.hash = '#/caisse/due')} onOpenLivreurs={() => (location.hash = '#/caisse/livreurs')} />}
      {current === 'journal' && <CaisseJournal />}
      {current === 'due' && <Due />}
      {current === 'done' && <Done />}
      {current === 'livreurs' && <LivreursCash />}
    </>
  );
}

type Group = NonNullable<ReturnType<typeof useRpc<'cash.due'>>['data']>['groups'][number];

function Due() {
  const { t } = useTranslation();
  const q = useRpc('cash.due', {});
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const groups = q.data?.groups ?? [];
  const tk = q.data?.tickets;
  return (
    <div>
      <div className="card">
        <h2>{t('caisse.due.title')}</h2>
        {!groups.length ? (
          <Empty>{t('caisse.due.empty')}</Empty>
        ) : (
          <>
            <Kpis>
              {groups.map((g) => (
                <Kpi key={g.key} label={g.name} value={da(g.net)} sub={t('caisse.due.kpiSub', { count: g.count, amount: da(g.collected) })} onClick={() => document.getElementById(`cash-${g.key}`)?.scrollIntoView({ behavior: 'smooth' })} />
              ))}
            </Kpis>
            <p className="muted small">{t('caisse.due.note')}</p>
          </>
        )}
      </div>
      {groups.map((g) => (
        <GroupCard key={g.key} g={g} />
      ))}
      {/* SAV tickets: their money is a separate line, never mixed with orders */}
      <div className="card px-tk-card">
        <div className="card-head">
          <h2>
            {t('caisse.tickets.title')}
            <Help text={t('caisse.tickets.help')} label={t('caisse.tickets.title')} />
          </h2>
          <b className="ltr">{da(tk?.total ?? 0)}</b>
        </div>
        {!tk?.groups.length ? (
          <Empty>{t('caisse.tickets.empty')}</Empty>
        ) : (
          <Kpis>
            {tk.groups.map((g) => (
              <Kpi key={g.key} label={g.name} value={da(g.net)} sub={t('caisse.due.kpiSub', { count: g.count, amount: da(g.collected) })} onClick={() => document.getElementById(`cash-${g.key}`)?.scrollIntoView({ behavior: 'smooth' })} />
            ))}
          </Kpis>
        )}
      </div>
      {tk?.groups.map((g) => (
        <GroupCard key={g.key} g={g} ticket />
      ))}
    </div>
  );
}

function GroupCard({ g, ticket }: { g: Group; ticket?: boolean }) {
  const { t } = useTranslation();
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const receive = useAction('cash.receive', { success: (r) => t('caisse.due.received', { count: r.orders }), onDone: () => (setSel(new Set()), setConfirm(false)) });
  const chosen = g.orders.filter((o) => sel.has(o.id));
  const sum = chosen.reduce((s, o) => s + o.net, 0);
  const csv = () =>
    downloadCsv(`caisse-${g.name.replace(/[^\w-]+/g, '_')}`, [
      [t('caisse.col.order'), t('caisse.col.tracking'), t('caisse.col.delivered'), t('caisse.col.customer'), t('caisse.col.phone'), t('caisse.col.wilaya'), t('caisse.col.commune'), t('caisse.col.products'), t('caisse.col.variant'), t('caisse.col.paid'), t('caisse.col.fee'), t('caisse.col.net')],
      ...(chosen.length ? chosen : g.orders).map((o) => [o.ref, o.tracking, dateTime(o.deliveredAt), o.customerName, o.phone, wilayaName(o.wilayaId), o.commune, o.products, o.variants, o.total, o.deliveryCost, o.net]),
    ]);
  return (
    <div className="card" id={`cash-${g.key}`}>
      <div className="card-head">
        <h2>{t(ticket ? 'caisse.tickets.groupTitle' : 'caisse.due.groupTitle', { name: g.name, count: g.count })}</h2>
        <div className="row">
          <b className="ltr">{chosen.length ? `${n(chosen.length)} · ${da(sum)}` : ''}</b>
          <button className="btn ok" disabled={!chosen.length} onClick={() => setConfirm(true)}>
            {t('caisse.due.received_btn')}
          </button>
          <button className="btn" onClick={csv}>
            {t('common.export')}
          </button>
        </div>
      </div>
      {confirm && (
        <div className="card" role="alertdialog" style={{ background: 'var(--raise)' }}>
          <p>{t('caisse.due.confirm', { count: chosen.length, amount: da(sum), name: g.name })}</p>
          <div className="row">
            <button className="btn ok" disabled={receive.isPending} onClick={() => receive.mutate({ ids: chosen.map((o) => o.id) })}>
              {t('caisse.due.confirmBtn')}
            </button>
            <button className="btn" onClick={() => setConfirm(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th className="ck">
                <input type="checkbox" aria-label={t('caisse.selectAll')} checked={sel.size > 0 && sel.size === g.orders.length} onChange={(e) => setSel(e.target.checked ? new Set(g.orders.map((o) => o.id)) : new Set())} />
              </th>
              <th>{t('caisse.col.order')}</th>
              <th>{t('caisse.col.delivered')}</th>
              <th>{t('caisse.col.customer')}</th>
              <th className="wide">{t('caisse.col.products')}</th>
                  <th>{t('caisse.col.variant')}</th>
              <th className="num">{t('caisse.col.paid')}</th>
              <th className="num">{t('caisse.col.net')}</th>
            </tr>
          </thead>
          <tbody>
            {g.orders.map((o) => (
              <tr key={o.id}>
                <td className="ck">
                  <input
                    type="checkbox"
                    aria-label={t('caisse.select')}
                    checked={sel.has(o.id)}
                    onChange={(e) => {
                      const s = new Set(sel);
                      e.target.checked ? s.add(o.id) : s.delete(o.id);
                      setSel(s);
                    }}
                  />
                </td>
                <td data-l={t('caisse.col.order')} className="clickable" onClick={() => openOrder(o.id)}>
                  <b className="ltr">{o.ref}</b> <TicketTag savRef={o.savRef} />
                  {o.tracking && <CopyCode code={o.tracking} small />}
                </td>
                <td data-l={t('caisse.col.delivered')}>{when(o.deliveredAt)}</td>
                <td data-l={t('caisse.col.customer')}>
                  {o.customerName}
                  <small>
                    {wilayaName(o.wilayaId)} · {o.commune}
                  </small>
                </td>
                <td className="wide px-cw" data-l={t('caisse.col.products')}>
                  <div className="px-clamp">{o.products}</div>
                </td>
                <td data-l={t('caisse.col.variant')}>
                  <div className="px-clamp">{o.variants || '—'}</div>
                </td>
                <td className="num" data-l={t('caisse.col.paid')}>
                  {da(o.total)}
                </td>
                <td className="num" data-l={t('caisse.col.net')}>
                  <b>{da(o.net)}</b>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Done() {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(30);
  // Du / Au, Société, Livreur
  const [f, setF] = useState({ from: '', to: '', company: '', livreur: '' });
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<typeof f>) => (setF((x) => ({ ...x, ...patch })), setLimit(30));
  const on = !!(f.from || f.to || f.company || f.livreur);
  const q = useRpc('cash.history', {
    limit,
    from: f.from ? dayIso(f.from) : undefined,
    to: f.to ? dayIso(f.to, true) : undefined,
    companyId: f.company && f.company !== 'none' ? Number(f.company) : undefined,
    livreurId: f.livreur ? Number(f.livreur) : undefined,
  });
  const filters = (
    <div className={`filters${open ? ' open' : ''}`}>
      <button type="button" className="btn filters-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t('filters.toggle')}
      </button>
      <DateFilters from={f.from} to={f.to} onChange={(v) => set(v)} />
      <CompanyFilter none={false} value={f.company} onChange={(v) => set({ company: v })} />
      <LivreurFilter value={f.livreur} onChange={(v) => set({ livreur: v })} />
      <ClearFilters on={on} onClear={() => set({ from: '', to: '', company: '', livreur: '' })} />
    </div>
  );
  const [ask, setAsk] = useState<number | null>(null);
  const cancel = useAction('cash.cancel', { success: t('caisse.done.cancelled'), onDone: () => setAsk(null) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const list = q.data ?? [];
  const amount = (h: (typeof list)[number], o: (typeof list)[number]['orders'][number]) => (h.livreurId ? o.total - o.share : o.net);
  const csv = () =>
    downloadCsv('caisse-recu', [
      [t('caisse.col.receivedAt'), t('caisse.col.order'), t('caisse.col.company'), t('caisse.col.customer'), t('caisse.col.amount')],
      ...list.flatMap((h) => h.orders.map((o) => [dateTime(h.at), o.ref, h.name, o.customerName, amount(h, o)])),
    ]);
  return (
    <div className="card">
      <div className="card-head">
        <h2>{t('caisse.done.title')}</h2>
        <button className="btn" onClick={csv} disabled={!list.length}>
          {t('common.export')}
        </button>
      </div>
      {filters}
      {!list.length ? (
        <Empty>{t('caisse.done.empty')}</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('caisse.col.receivedAt')}</th>
                <th>{t('caisse.col.order')}</th>
                <th>{t('caisse.col.company')}</th>
                <th>{t('caisse.col.customer')}</th>
                <th className="num">{t('caisse.col.amount')}</th>
              </tr>
            </thead>
            {list.map((h) => (
              <tbody key={h.id}>
                <tr style={{ background: 'var(--raise)' }}>
                  <td colSpan={5} data-l="">
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <span>
                        {h.tickets && <span className="px-ticket">{t('caisse.tickets.badge')}</span>} <b>{h.name}</b> · {dateTime(h.at)} · {t('caisse.done.summary', { count: h.orders.length, amount: da(h.net) })}
                        {h.fees > 0 && <span className="muted small"> ({t('caisse.done.fees', { amount: da(h.fees) })})</span>}
                      </span>
                      {ask === h.id ? (
                        <span className="row">
                          <span className="small">{t('caisse.done.confirmCancel')}</span>
                          <button className="btn small danger" disabled={cancel.isPending} onClick={() => cancel.mutate({ handoverId: h.id })}>
                            {t('common.confirm')}
                          </button>
                          <button className="btn small" onClick={() => setAsk(null)}>
                            {t('common.cancel')}
                          </button>
                        </span>
                      ) : (
                        <button className="btn small ghost" onClick={() => setAsk(h.id)}>
                          {t('caisse.done.cancel')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                {h.orders.map((o) => (
                  <tr key={o.id} className="clickable" onClick={() => openOrder(o.id)}>
                    <td data-l={t('caisse.col.receivedAt')}>{when(h.at)}</td>
                    <td data-l={t('caisse.col.order')}>
                      <b className="ltr">{o.ref}</b> <TicketTag savRef={o.savRef} />
                      {o.tracking && <CopyCode code={o.tracking} small />}
                    </td>
                    <td data-l={t('caisse.col.company')}>{h.name}</td>
                    <td data-l={t('caisse.col.customer')}>{o.customerName}</td>
                    <td className="num" data-l={t('caisse.col.amount')}>
                      {da(amount(h, o))}
                    </td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}
      {list.length >= limit && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 10 }}>
          <button className="btn" onClick={() => setLimit(limit + 30)}>
            {t('caisse.done.more')}
          </button>
        </div>
      )}
    </div>
  );
}
