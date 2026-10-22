// Marketing › Marketer: paying marketers per ad set (ported from the BabyJoy DZ "Marketeurs" tab).
// Every figure and result comes from core (mk.*); this page shows them, lets the owner give ad sets to marketers,
// set a result by hand, set prices and rules, and mark ad sets paid. A marketer sees his own ad sets, read only.
// Views (address): #/marketing/marketer · …/gerer (marketers) · …/produit/<key> · …/adset/<id>
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateOnly, n, pct } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Empty, ErrorBox, Loading } from '../../ui/kit';
import { ConfirmButton } from '../admin/bits';
import './marketer.css';

type Overview = NonNullable<ReturnType<typeof useRpc<'mk.overview'>>['data']>;
type Row = Overview['rows'][number];
type St = '' | 'ok' | 'pay' | 'paid' | 'ko' | 'run';
const ST: St[] = ['', 'ok', 'pay', 'paid', 'ko', 'run'];

const usd = (v: number | null | undefined) => (v === null || v === undefined || !isFinite(v) ? '—' : `${v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`);
const r0 = (v: number) => Math.round(v);
const monthName = (ym: string) => {
  const l = document.documentElement.lang || 'fr';
  return new Date(ym + '-15T00:00:00Z').toLocaleDateString(l === 'ar' ? 'ar-DZ' : l, { month: 'long', year: 'numeric' });
};
/** Result tags a row carries (one row can be "réussi" and "à payer"). */
function stOf(a: Row): Set<St> {
  const s = new Set<St>();
  s.add(!a.final ? 'run' : a.ok ? 'ok' : 'ko');
  if (a.paid) s.add('paid');
  else if (a.owe) s.add('pay');
  return s;
}
/** Order: réussi, then en cours, then raté. */
const rank = (a: Row) => (!a.final ? 1 : a.ok ? 0 : 2);
const go = (path: string) => (location.hash = `#/marketing/marketer${path}`);

/** Product key of every row: ad sets sharing a product end up in the same box. */
function groupKeys(rows: Row[]): Map<string, string> {
  const par = new Map<string, string>();
  const find = (x: string): string => {
    while (par.get(x) !== x) x = par.get(x)!;
    return x;
  };
  const first = new Map<string, string>();
  for (const a of rows) {
    const ks = a.productIds.length ? a.productIds.map((p) => `p${p}`) : ['none'];
    ks.forEach((k) => !par.has(k) && par.set(k, k));
    for (let i = 1; i < ks.length; i++) {
      const x = find(ks[0]);
      const y = find(ks[i]);
      if (x !== y) par.set(y, x);
    }
    first.set(a.id, ks[0]);
  }
  return new Map(rows.map((a) => [a.id, find(first.get(a.id)!)]));
}

export function Marketer({ rest }: { rest?: string[] }) {
  const { t } = useTranslation();
  const q = useRpc('mk.overview', {});
  const view = rest?.[0] === 'gerer' ? 'manage' : rest?.[0] === 'produit' && rest[1] ? 'prod' : rest?.[0] === 'adset' && rest[1] ? 'adset' : 'list';
  const [who, setWho] = useState(''); // '' all · id · '-' without marketer
  const [st, setSt] = useState<St>('');
  const [search, setSearch] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => setSel(new Set()), [who, st, search, view]);

  const d = q.data;
  const rows = d?.rows ?? [];
  const keys = useMemo(() => groupKeys(rows), [rows]);
  const people = d?.marketers ?? [];
  const name = (id: number | null) => (id ? people.find((m) => m.id === id)?.name ?? rows.find((r) => r.marketerId === id)?.marketerName ?? `#${id}` : '');

  if (q.isLoading && !d) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!d) return null;
  const owner = d.owner;

  // who the figures are about ("Tous" = every ad set given to a marketer)
  const inWho = (a: Row) => (!who ? !!a.marketerId : who === '-' ? !a.marketerId : String(a.marketerId) === who);
  const ql = search.trim().toLowerCase();
  const byWho = rows.filter((a) => (!who || inWho(a)) && (!ql || a.prod.toLowerCase().includes(ql) || a.name.toLowerCase().includes(ql) || a.id.includes(ql)));
  const show = byWho.filter((a) => !st || stOf(a).has(st)).sort((x, y) => rank(x) - rank(y) || y.net - x.net);

  return (
    <div id="mk" className="view">
      {view === 'adset' ? (
        <AdsetView id={rest![1]} back={rest?.[2]} d={d} list={rest?.[2] ? rows.filter((a) => keys.get(a.id) === rest[2]).sort((x, y) => rank(x) - rank(y) || y.net - x.net) : show} name={name} />
      ) : view === 'prod' ? (
        <ProductView d={d} k={rest![1]} rows={rows.filter((a) => keys.get(a.id) === rest![1])} name={name} sel={sel} setSel={setSel} />
      ) : (
        <>
          <Head d={d} rows={rows} who={who} setWho={setWho} st={st} setSt={setSt} inWho={inWho} refetch={() => q.refetch()} busy={q.isFetching} />
          {view === 'manage' && owner ? (
            <Manage d={d} rows={rows} who={who} onPick={(id) => (setWho(String(id)), go(''))} />
          ) : (
            <>
              {owner && <Ask d={d} rows={rows} />}
              <section className="card">
                <div className="card-head">
                  <h2>
                    {t('marketer.adsets')}
                    <span className="count">{show.length !== rows.length ? `${n(show.length)} / ${n(rows.length)}` : n(rows.length)}</span>
                  </h2>
                </div>
                <div className="mk-filters">
                  <div className="search">
                    <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('marketer.search')} aria-label={t('marketer.search')} />
                  </div>
                  {owner && (
                    <select className={`mk-fsel ${who ? 'on' : ''}`} value={who} onChange={(e) => setWho(e.target.value)} aria-label={t('marketer.filterWho')}>
                      <option value="">{`${t('marketer.allMarketers')} · ${n(rows.length)}`}</option>
                      {people.map((m) => (
                        <option key={m.id} value={String(m.id)}>{`${m.name} · ${n(rows.filter((a) => a.marketerId === m.id).length)}`}</option>
                      ))}
                      {rows.some((a) => !a.marketerId) && <option value="-">{`${t('marketer.noMarketer')} · ${n(rows.filter((a) => !a.marketerId).length)}`}</option>}
                    </select>
                  )}
                  <select className={`mk-fsel ${st ? 'on' : ''}`} value={st} onChange={(e) => setSt(e.target.value as St)} aria-label={t('marketer.filterSt')}>
                    {ST.map((k) => (
                      <option key={k} value={k}>{`${t(`marketer.st.${k || 'all'}`)} · ${n(k ? byWho.filter((a) => stOf(a).has(k)).length : byWho.length)}`}</option>
                    ))}
                  </select>
                </div>
                {owner && <Bulk d={d} rows={rows} sel={sel} setSel={setSel} />}
                <AdsetTable d={d} groups={groupRows(show, keys)} sel={sel} setSel={setSel} open={open} setOpen={setOpen} forceOpen={!!ql} name={name} showAll={show} />
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- header: KPIs and rules
function Head({ d, rows, who, setWho, st, setSt, inWho, refetch, busy }: { d: Overview; rows: Row[]; who: string; setWho: (v: string) => void; st: St; setSt: (v: St) => void; inWho: (a: Row) => boolean; refetch: () => void; busy: boolean }) {
  const { t } = useTranslation();
  let tPay = 0, tPaid = 0, tOk = 0, tRun = 0, nPay = 0, nFinal = 0, nPaid = 0, nLines = 0, tNet = 0, tSp = 0;
  for (const a of rows) {
    if (!inWho(a)) continue;
    nLines++;
    tNet += a.net;
    tSp += a.sp;
    if (!a.final) tRun++;
    else {
      nFinal++;
      if (a.ok) tOk++;
    }
    if (a.paid) (tPaid += a.paid.amount), nPaid++;
    else if (a.owe) (tPay += a.owe), nPay++;
  }
  const cost = tPaid + tPay;
  const kpi = (k: St | null, lab: string, val: ReactNode, sub: ReactNode, extra?: ReactNode, cls = '') => {
    const body = (
      <>
        <span className="lab">{lab}</span>
        <span className={`val ltr ${cls}`}>{val}</span>
        <span className="sub">{sub}</span>
        {extra}
      </>
    );
    return k ? (
      <button type="button" className={`kpi mk-go ${k === 'pay' ? 'pay' : ''} ${st === k ? 'on' : ''}`} onClick={() => setSt(st === k ? '' : k)}>
        {body}
      </button>
    ) : (
      <div className="kpi">{body}</div>
    );
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2>{d.owner ? t('marketer.title') : t('marketer.titleMine')}</h2>
        <div className="mk-head-r">
          {d.owner && (
            <label className="mk-who">
              <span>{t('marketer.marketer')}</span>
              <select className={who ? 'on' : ''} value={who} onChange={(e) => setWho(e.target.value)} aria-label={t('marketer.whoStats')}>
                <option value="">{t('marketer.all')}</option>
                {d.marketers.map((m) => (
                  <option key={m.id} value={String(m.id)}>
                    {m.name}
                  </option>
                ))}
                {rows.some((a) => !a.marketerId) && <option value="-">{t('marketer.noMarketer')}</option>}
              </select>
            </label>
          )}
          {d.owner && (
            <a className="btn-mini" href="#/marketing/marketer/gerer">
              👥 {t('marketer.manage')}
              {!!d.marketers.length && <b className="ltr"> {d.marketers.length}</b>}
            </a>
          )}
          <button className="btn-mini" type="button" disabled={busy} onClick={refetch}>
            ↻ {t('marketer.refresh')}
          </button>
        </div>
      </div>
      <div className="kpis mk-kpis">
        {kpi('pay', t('marketer.k.pay'), da(tPay), nPay ? t('marketer.k.paySub', { count: nPay }) : t('marketer.k.payNone'))}
        {kpi('paid', t('marketer.k.paid'), da(tPaid), t('marketer.k.paidSub', { count: nPaid }))}
        {kpi(
          'ok',
          t('marketer.k.ok'),
          nLines ? pct(tOk / nLines) : '—',
          t('marketer.k.okSub', { ok: n(tOk), count: nLines, final: n(nFinal) }),
          <span className="mk-bar">
            <i style={{ width: nLines ? `${Math.round((100 * tOk) / nLines)}%` : 0 }} />
          </span>,
        )}
        {kpi(null, t('marketer.k.cpa'), nLines ? da(r0(cost / nLines)) : '—', `${da(cost)} ÷ ${n(nLines)}`)}
        {kpi(null, t('marketer.k.net'), da(tNet), `${t('marketer.k.netSub', { usd: usd(tSp) })}${cost && tNet > 0 ? ' · ' + t('marketer.k.share', { pct: pct(cost / tNet) }) : ''}`, undefined, tNet < 0 ? 'neg' : '')}
        {kpi('run', t('marketer.k.run'), n(tRun), t('marketer.k.runSub'))}
      </div>
      {!!d.fxMissing.length && <p className="mk-warn">⚠ {t('marketer.fxMissing', { months: d.fxMissing.map(monthName).join(', ') })}</p>}
      <Rules d={d} />
    </section>
  );
}

function Rules({ d }: { d: Overview }) {
  const { t } = useTranslation();
  const save = useAction('mk.rules', { success: t('marketer.rulesSaved') });
  const [seuil, setSeuil] = useState(String(Math.round(d.rules.seuil * 100)));
  const [mult, setMult] = useState(String(d.rules.mult));
  useEffect(() => {
    setSeuil(String(Math.round(d.rules.seuil * 100)));
    setMult(String(d.rules.mult));
  }, [d.rules.seuil, d.rules.mult]);
  const commit = () => {
    const s = Number(seuil);
    const m = Number(String(mult).replace(',', '.'));
    if (!(s > 0 && s <= 100) || !(m >= 0)) {
      setSeuil(String(Math.round(d.rules.seuil * 100)));
      setMult(String(d.rules.mult));
      return;
    }
    if (s / 100 !== d.rules.seuil || m !== d.rules.mult) save.mutate({ seuil: s / 100, mult: m });
  };
  return (
    <details className="mk-rules">
      <summary>{t('marketer.rules')}</summary>
      <p className="note">{t('marketer.rulesText', { seuil: Math.round(d.rules.seuil * 100), mult: d.rules.mult })}</p>
      {d.owner && (
        <div className="mk-add">
          <label className="field">
            {t('marketer.seuil')}
            <input type="number" min={1} max={100} step={1} value={seuil} onChange={(e) => setSeuil(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
          </label>
          <span className="mk-or">{t('marketer.or')}</span>
          <label className="field">
            {t('marketer.mult')}
            <input type="number" min={0} step={0.5} value={mult} onChange={(e) => setMult(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
          </label>
        </div>
      )}
    </details>
  );
}

// ---------------------------------------------------------------- ad sets without a marketer
function Ask({ d, rows }: { d: Overview; rows: Row[] }) {
  const { t } = useTranslation();
  const un = rows.filter((a) => !a.marketerId);
  const [mid, setMid] = useState('');
  const assign = useAction('mk.assign', { success: (r) => t('marketer.linked', { count: r.n }) });
  if (!un.length) return null;
  return (
    <section className="card mk-ask">
      <h2>{t('marketer.askTitle', { count: un.length })}</h2>
      <ul>
        {un.slice(0, 8).map((a) => (
          <li key={a.id}>
            {a.prod || t('marketer.noProduct')} · {a.name}
          </li>
        ))}
        {un.length > 8 && <li>{t('marketer.andMore', { count: un.length - 8 })}</li>}
      </ul>
      <div className="row">
        <label className="field">
          {t('marketer.allTo')}
          <select value={mid} onChange={(e) => setMid(e.target.value)}>
            <option value="">{t('marketer.choose')}</option>
            {d.marketers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <button className="fix-copy" type="button" disabled={!mid || assign.isPending} onClick={() => assign.mutate({ ids: un.map((a) => a.id), marketerId: Number(mid) })}>
          {t('marketer.linkAll', { count: un.length })}
        </button>
        {!d.marketers.length && <NewMarketerHint d={d} />}
      </div>
    </section>
  );
}

function NewMarketerHint({ d }: { d: Overview }) {
  const { t } = useTranslation();
  return d.admin ? (
    <a className="btn-mini" href="#/utilisateurs/marketeurs">
      {t('marketer.newMarketer')}
    </a>
  ) : (
    <span className="note">{t('marketer.newAskAdmin')}</span>
  );
}

// ---------------------------------------------------------------- marketers: cards with price and "pay all"
function Manage({ d, rows, who, onPick }: { d: Overview; rows: Row[]; who: string; onPick: (id: number) => void }) {
  const { t } = useTranslation();
  const price = useAction('mk.price', { success: t('marketer.priceSaved') });
  const pay = useAction('mk.pay', { success: (r) => t('marketer.paidOk', { amount: da(r.total), count: r.n }) });
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <a className="mk-back" href="#/marketing/marketer">
            ← {t('marketer.back')}
          </a>
          {t('marketer.marketers')}
          <span className="count">{n(d.marketers.length)}</span>
        </h2>
        <NewMarketerHint d={d} />
      </div>
      <p className="note">{t('marketer.manageNote')}</p>
      {!d.marketers.length ? (
        <Empty>{t('marketer.noneYet')}</Empty>
      ) : (
        <div className="mk-cards">
          {d.marketers.map((m) => {
            const mine = rows.filter((a) => a.marketerId === m.id);
            const due = mine.filter((a) => !a.paid && a.owe);
            const x = { n: mine.length, ok: mine.filter((a) => a.final && a.ok).length, ko: mine.filter((a) => a.final && !a.ok).length, run: mine.filter((a) => !a.final).length, pay: due.reduce((s, a) => s + (a.owe ?? 0), 0), paid: mine.reduce((s, a) => s + (a.paid?.amount ?? 0), 0) };
            return (
              <div key={m.id} className={`mk-card ${who === String(m.id) ? 'on' : ''}`} tabIndex={0} title={t('marketer.seeHis')} onClick={(e) => !(e.target as HTMLElement).closest('input,button,label') && onPick(m.id)} onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onPick(m.id)}>
                <div className="top">
                  <b>{m.name}</b>
                  {!m.active && <span className="pill">{t('marketer.inactive')}</span>}
                  <label className="field">
                    <input
                      type="number"
                      min={0}
                      step={500}
                      defaultValue={m.price}
                      key={m.price}
                      aria-label={t('marketer.priceOf', { name: m.name })}
                      onBlur={(e) => {
                        const v = Math.round(Number(e.target.value));
                        if (v >= 0 && v !== m.price) price.mutate({ marketerId: m.id, price: v });
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    />
                    <small> {t('marketer.perSuccess')}</small>
                  </label>
                </div>
                <div className="stats">
                  {(['n', 'ok', 'ko', 'run'] as const).map((k) => (
                    <span key={k}>
                      {t(`marketer.cardStat.${k}`)} <b className="ltr">{n(x[k])}</b>
                    </span>
                  ))}
                </div>
                <div className="money">
                  <span>
                    {t('marketer.toPay')} <b className="due ltr">{da(x.pay)}</b>
                  </span>
                  <span>{t('marketer.alreadyPaid', { amount: da(x.paid) })}</span>
                </div>
                {!!due.length && (
                  <ConfirmButton className="fix-copy ok" question={t('marketer.payAllQ', { count: due.length })} onConfirm={() => pay.mutate({ ids: due.map((a) => a.id) })} disabled={pay.isPending}>
                    {t('marketer.payAll', { name: m.name, amount: da(x.pay) })}
                  </ConfirmButton>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- bulk actions on the selected ad sets
function Bulk({ d, rows, sel, setSel }: { d: Overview; rows: Row[]; sel: Set<string>; setSel: (s: Set<string>) => void }) {
  const { t } = useTranslation();
  const [mid, setMid] = useState('');
  const [res, setRes] = useState('#');
  const clear = () => setSel(new Set());
  const assign = useAction('mk.assign', { success: (r) => t('marketer.linked', { count: r.n }), onDone: clear });
  const force = useAction('mk.force', { success: (r) => t('marketer.forced', { count: r.n }), onDone: clear });
  const pay = useAction('mk.pay', { success: (r) => t('marketer.paidOk', { amount: da(r.total), count: r.n }), onDone: clear });
  if (!sel.size) return null;
  const list = rows.filter((a) => sel.has(a.id));
  const payable = list.filter((a) => !a.paid && a.owe);
  const ids = [...sel];
  return (
    <div className="mk-bulk" role="toolbar">
      <span className="n">{t('marketer.selected', { count: sel.size })}</span>
      <label className="field">
        {t('marketer.marketer')}
        <select value={mid} onChange={(e) => setMid(e.target.value)}>
          <option value="">{t('marketer.choose')}</option>
          {d.marketers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
          <option value="-">{t('marketer.removeMarketer')}</option>
        </select>
      </label>
      <button className="fix-copy" type="button" disabled={!mid || assign.isPending} onClick={() => assign.mutate({ ids, marketerId: mid === '-' ? null : Number(mid) })}>
        {t('marketer.applyTo', { count: sel.size })}
      </button>
      <label className="field">
        {t('marketer.result')}
        <select value={res} onChange={(e) => setRes(e.target.value)}>
          <option value="#">{t('marketer.choose')}</option>
          <option value="ok">{t('marketer.res.ok')}</option>
          <option value="ko">{t('marketer.res.ko')}</option>
          <option value="run">{t('marketer.res.run')}</option>
          <option value="">{t('marketer.res.auto')}</option>
        </select>
      </label>
      <button className="fix-copy" type="button" disabled={res === '#' || force.isPending} onClick={() => force.mutate({ ids, st: res === '' ? null : (res as 'ok' | 'ko' | 'run') })}>
        {t('marketer.changeResult')}
      </button>
      {!!payable.length && (
        <ConfirmButton className="fix-copy ok" question={t('marketer.payQ', { count: payable.length })} onConfirm={() => pay.mutate({ ids: payable.map((a) => a.id) })} disabled={pay.isPending}>
          {t('marketer.markPaid', { count: payable.length, amount: da(payable.reduce((s, a) => s + (a.owe ?? 0), 0)) })}
        </ConfirmButton>
      )}
      <button className="btn-mini" type="button" onClick={clear}>
        {t('marketer.unselect')}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- the table: one box per product, its ad sets inside
type Group = { key: string; label: string; rows: Row[]; rank: number; net: number };
function groupRows(show: Row[], keys: Map<string, string>): Group[] {
  const by = new Map<string, Row[]>();
  for (const a of show) {
    const k = keys.get(a.id)!;
    (by.get(k) ?? by.set(k, []).get(k)!).push(a);
  }
  return [...by.entries()]
    .map(([key, l]) => ({ key, label: l.map((a) => a.prod).filter(Boolean).sort((x, y) => x.length - y.length)[0] ?? '', rows: l, rank: Math.min(...l.map(rank)), net: l.reduce((s, a) => s + a.net, 0) }))
    .sort((x, y) => x.rank - y.rank || y.net - x.net);
}

function AdsetTable({ d, groups, sel, setSel, open, setOpen, forceOpen, name, showAll, flat }: { d: Overview; groups: Group[]; sel: Set<string>; setSel: (s: Set<string>) => void; open?: Set<string>; setOpen?: (s: Set<string>) => void; forceOpen?: boolean; name: (id: number | null) => string; showAll: Row[]; flat?: string }) {
  const { t } = useTranslation();
  const owner = d.owner;
  const all = showAll.length > 0 && showAll.every((a) => sel.has(a.id));
  const toggle = (ids: string[], on: boolean) => {
    const s = new Set(sel);
    ids.forEach((id) => (on ? s.add(id) : s.delete(id)));
    setSel(s);
  };
  const cols = [t('marketer.col.result'), flat ? t('marketer.col.adset') : t('marketer.col.product'), t('marketer.col.spend'), t('marketer.col.delivered'), t('marketer.col.net'), t('marketer.col.cpd'), t('marketer.col.share'), t('marketer.col.pay'), t('marketer.col.marketer'), t('marketer.col.status')];
  if (!showAll.length) return <Empty>{t('marketer.empty')}</Empty>;
  return (
    <div className="tbl-wrap">
      <table className="mk-tbl">
        <thead>
          <tr>
            {owner && (
              <th className="ck">
                <input type="checkbox" checked={all} ref={(el) => el && (el.indeterminate = sel.size > 0 && !all)} onChange={(e) => toggle(showAll.map((a) => a.id), e.target.checked)} aria-label={t('marketer.selectAll')} />
              </th>
            )}
            {cols.map((c, i) => (
              <th key={i} className={i >= 2 && i <= 7 ? 'num' : ''}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {flat
            ? groups.flatMap((g) => g.rows.map((a) => <AdsetRow key={a.id} d={d} a={a} kid sel={sel} toggle={toggle} name={name} back={flat} />))
            : groups.flatMap((g) => {
                const isOpen = forceOpen || open!.has(g.key);
                return [
                  <GroupRow key={`g${g.key}`} d={d} g={g} open={isOpen} sel={sel} toggle={toggle} name={name} onToggle={() => {
                    const s = new Set(open);
                    s.has(g.key) ? s.delete(g.key) : s.add(g.key);
                    setOpen!(s);
                  }} />,
                  ...(isOpen ? g.rows.map((a) => <AdsetRow key={a.id} d={d} a={a} kid sel={sel} toggle={toggle} name={name} />) : []),
                ];
              })}
        </tbody>
      </table>
    </div>
  );
}

const statusLabel = (s: string | null, t: (k: string) => string) => (s === 'ACTIVE' ? t('marketer.status.active') : s === 'PAUSED' ? t('marketer.status.paused') : s === 'ARCHIVED' ? t('marketer.status.archived') : (s ?? '—').toLowerCase());

function GroupRow({ d, g, open, sel, toggle, name, onToggle }: { d: Overview; g: Group; open: boolean; sel: Set<string>; toggle: (ids: string[], on: boolean) => void; name: (id: number | null) => string; onToggle: () => void }) {
  const { t } = useTranslation();
  const L = g.rows;
  const sum = (f: (a: Row) => number) => L.reduce((s, a) => s + f(a), 0);
  const sp = sum((a) => a.sp), spDa = sum((a) => a.spDa), pu = sum((a) => a.pu), dl = sum((a) => a.d), nn = sum((a) => a.n), net = sum((a) => a.net), rev = sum((a) => a.rev), marge = sum((a) => a.marge);
  const c = { ok: 0, run: 0, ko: 0 };
  for (const a of L) c[!a.final ? 'run' : a.ok ? 'ok' : 'ko']++;
  let owe = 0, paid = 0;
  for (const a of L) a.paid ? (paid += a.paid.amount) : (owe += a.owe ?? 0);
  const nSel = L.filter((a) => sel.has(a.id)).length;
  const who = [...new Set(L.map((a) => name(a.marketerId)).filter(Boolean))];
  const act = L.some((a) => a.status === 'ACTIVE');
  return (
    <tr className={`mk-ghead ${open ? 'open' : ''}`}>
      {d.owner && (
        <td className="ck">
          <input type="checkbox" checked={nSel === L.length} ref={(el) => el && (el.indeterminate = nSel > 0 && nSel < L.length)} onChange={(e) => toggle(L.map((a) => a.id), e.target.checked)} aria-label={t('marketer.selectGroup', { name: g.label })} />
        </td>
      )}
      <td>
        <div className="mk-gres">{(['ok', 'run', 'ko'] as const).map((k) => !!c[k] && <span key={k} className={`mk-gst st-${k}`}>{t(`marketer.gst.${k}`, { count: c[k] })}</span>)}</div>
      </td>
      <td className="mk-prod mk-gname">
        <button type="button" className="mk-gtog" aria-expanded={open} aria-label={open ? t('marketer.close') : t('marketer.openHere')} onClick={onToggle}>
          ›
        </button>
        <a className="mk-glink" href={`#/marketing/marketer/produit/${encodeURIComponent(g.key)}`} title={t('marketer.openProduct')}>
          {g.label || t('marketer.noProduct')}
        </a>
        <small>{t('marketer.nAdsets', { count: L.length })}</small>
      </td>
      <td className="num" data-l={t('marketer.col.spend')}>
        {usd(sp)}
        <small>{pu ? t('marketer.perPurchase', { v: usd(sp / pu) }) : t('marketer.noPurchase')}</small>
      </td>
      <td className="num" data-l={t('marketer.col.delivered')}>
        {nn >= 0.5 ? pct(dl / nn) : '—'}
        <small className="ltr">
          {n(r0(dl))} / {n(r0(nn))}
        </small>
      </td>
      <td className={`num ${net < 0 ? 'neg' : ''}`} data-l={t('marketer.col.net')}>
        {da(net)}
        <small>{t('marketer.sales', { v: da(rev) })}</small>
      </td>
      <td className="num" data-l={t('marketer.col.cpd')}>
        {dl >= 0.5 ? da(r0(spDa / dl)) : '—'}
      </td>
      <td className={`num ${marge > 0 && net / marge < d.rules.seuil ? 'neg' : ''}`} data-l={t('marketer.col.share')}>
        {marge > 0 ? pct(net / marge) : '—'}
      </td>
      <td className="num paycell" data-l={t('marketer.col.pay')}>
        {owe ? da(owe) : paid ? da(paid) : '—'}
        {owe ? <small className="mk-owe">{t('marketer.toPayLow')}</small> : paid ? <small className="mk-paid">{t('marketer.paidLow')}</small> : null}
      </td>
      <td className="mk-gwho" data-l={t('marketer.col.marketer')}>
        {who.length ? who.join(', ') : '—'}
      </td>
      <td data-l={t('marketer.col.status')}>
        <span className={`mk-dot ${act ? 'on' : 'off'}`}>{act ? t('marketer.status.active') : t('marketer.status.stopped')}</span>
      </td>
    </tr>
  );
}

function AdsetRow({ d, a, kid, sel, toggle, name, back }: { d: Overview; a: Row; kid?: boolean; sel: Set<string>; toggle: (ids: string[], on: boolean) => void; name: (id: number | null) => string; back?: string }) {
  const { t } = useTranslation();
  const force = useAction('mk.force', { success: t('marketer.resultSaved') });
  const assign = useAction('mk.assign', { success: t('marketer.ownerSaved') });
  const pay = useAction('mk.pay', { success: (r) => t('marketer.paidOk', { amount: da(r.total), count: r.n }) });
  const unpay = useAction('mk.unpay', { success: t('marketer.unpaid') });
  const owner = d.owner;
  const calc = a.paid && !a.manual ? t('marketer.calc.paid') : !a.finalAuto ? (a.unlinked ? t('marketer.calc.unlinked') : a.fxMissing.length ? t('marketer.calc.fx') : a.stopped ? t('marketer.calc.road') : t('marketer.calc.run')) : a.okAuto ? t('marketer.calc.ok') : t('marketer.calc.ko');
  const eff = !a.final ? 'run' : a.ok ? 'ok' : 'ko';
  const why: string[] = [];
  if (a.manual) why.push(t('marketer.why.manual', { calc }));
  if (a.okAuto) why.push(a.okShare ? t('marketer.why.share', { pct: Math.round(d.rules.seuil * 100) }) : t('marketer.why.big', { mult: d.rules.mult }));
  else if (!a.finalAuto) why.push(t('marketer.why.notYet'));
  if (a.fxMissing.length) why.push(t('marketer.why.fx', { months: a.fxMissing.map(monthName).join(', ') }));
  if (a.open >= 0.5) why.push(t('marketer.why.open', { open: n(r0(a.open)), n: n(r0(a.n)) }));
  const mPer = a.d >= 0.5 && a.marge > 0 ? a.marge / a.d : null;
  const cPer = a.d >= 0.5 ? a.spDa / a.d : null;
  const cShare = mPer && cPer !== null ? cPer / mPer : null;
  const href = `#/marketing/marketer/adset/${encodeURIComponent(a.id)}${back ? `/${encodeURIComponent(back)}` : ''}`;
  return (
    <tr className={`${a.paid ? 'paid' : ''} ${sel.has(a.id) ? 'sel' : ''} ${kid ? 'mk-kid' : ''}`}>
      {owner && (
        <td className="ck">
          <input type="checkbox" checked={sel.has(a.id)} onChange={(e) => toggle([a.id], e.target.checked)} aria-label={t('marketer.selectOne', { name: a.name })} />
        </td>
      )}
      <td className="mk-res">
        {owner ? (
          <select className={`mk-st st-${eff} ${a.manual ? 'man' : ''}`} value={a.manual ?? ''} title={why.join(' · ')} aria-label={t('marketer.result')} onChange={(e) => force.mutate({ ids: [a.id], st: e.target.value ? (e.target.value as 'ok' | 'ko' | 'run') : null })}>
            <option value="">{calc + (a.manual ? ` (${t('marketer.calcWord')})` : '')}</option>
            <option value="ok">{t('marketer.res.ok')} ✎</option>
            <option value="ko">{t('marketer.res.ko')} ✎</option>
            <option value="run">{t('marketer.res.run')} ✎</option>
          </select>
        ) : (
          <span className={`mk-pill st-${eff}`} title={why.join(' · ')}>
            {a.manual ? t(`marketer.res.${a.manual}`) : calc}
          </span>
        )}
      </td>
      <td className="mk-prod" title={t('marketer.adsetTip', { name: a.name, id: a.id })}>
        {a.bid && <span className="bid">BID</span>}
        <a href={href}>{kid ? a.name : a.prod}</a>
        <span className="mk-open">›</span>
        {mPer !== null && <small>{t('marketer.marginPer', { v: da(r0(mPer)) })}</small>}
      </td>
      <td className="num" data-l={t('marketer.col.spend')} title={`${da(a.spDa)} · ${n(a.pu)}`}>
        {usd(a.sp)}
        <small>{a.pu ? t('marketer.perPurchase', { v: usd(a.sp / a.pu) }) : t('marketer.noPurchase')}</small>
      </td>
      <td className="num" data-l={t('marketer.col.delivered')}>
        {a.n >= 0.5 ? pct(a.d / a.n) : '—'}
        <small className="ltr">
          {n(r0(a.d))} / {n(r0(a.n))}
        </small>
        {!!a.pu && <small className={`mk-meta ${a.n >= 0.5 && a.pu / a.n >= 1.5 ? 'hi' : ''}`}>Meta {n(a.pu)}</small>}
      </td>
      <td className={`num ${a.net < 0 ? 'neg' : ''}`} data-l={t('marketer.col.net')}>
        {da(a.net)}
        <small>{t('marketer.sales', { v: da(a.rev) })}</small>
      </td>
      <td className="num" data-l={t('marketer.col.cpd')} title={t('marketer.cpdTip')}>
        {cPer === null ? (
          '—'
        ) : (
          <>
            <span className={`cbadge ${cShare === null ? '' : cShare > 0.7 ? 'bad' : 'good'}`}>{da(r0(cPer))}</span>
            <small>{cShare === null ? usd(a.sp / a.d) : t('marketer.ofMargin', { pct: pct(cShare) })}</small>
          </>
        )}
      </td>
      <td className={`num ${a.ratio === null || a.ratio < d.rules.seuil ? 'neg' : ''}`} data-l={t('marketer.col.share')} title={t('marketer.shareTip', { net: da(a.net), marge: da(a.marge), pub: da(a.spDa) })}>
        {a.ratio === null ? '—' : pct(a.ratio)}
      </td>
      <td className="num paycell" data-l={t('marketer.col.pay')}>
        {a.paid ? (
          <>
            {da(a.paid.amount)}
            <small className="mk-paid">
              {t('marketer.paidOn', { date: dateOnly(a.paid.at) })}
              {owner && (
                <>
                  {' · '}
                  <button type="button" className="mk-undo" disabled={unpay.isPending} onClick={() => unpay.mutate({ id: a.id })}>
                    {t('marketer.undo')}
                  </button>
                </>
              )}
            </small>
          </>
        ) : a.owe ? (
          owner ? (
            <button type="button" className="fix-copy ok mk-paybtn" disabled={pay.isPending} onClick={() => pay.mutate({ ids: [a.id] })}>
              <span>{t('marketer.pay')}</span> <span className="amt ltr">{da(a.owe)}</span>
            </button>
          ) : (
            da(a.owe)
          )
        ) : a.owe === 0 ? (
          '—'
        ) : a.fxMissing.length && !a.paid && a.final && a.ok ? (
          <small className="mk-fxwait">{t('marketer.fxWait')}</small>
        ) : !a.marketerId && a.final && a.ok ? (
          <small>{t('marketer.chooseMarketer')}</small>
        ) : (
          ''
        )}
      </td>
      <td data-l={t('marketer.col.marketer')}>
        {owner ? (
          <select className={`mk-mk ${a.marketerId ? '' : 'none'}`} value={a.marketerId ?? ''} aria-label={t('marketer.marketer')} onChange={(e) => assign.mutate({ ids: [a.id], marketerId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">{t('marketer.pick')}</option>
            {d.marketers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        ) : (
          name(a.marketerId) || '—'
        )}
      </td>
      <td data-l={t('marketer.col.status')}>
        <span className={`mk-dot ${a.status === 'ACTIVE' ? 'on' : 'off'}`}>{statusLabel(a.status, t)}</span>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------- product page
function ProductView({ d, k, rows, name, sel, setSel }: { d: Overview; k: string; rows: Row[]; name: (id: number | null) => string; sel: Set<string>; setSel: (s: Set<string>) => void }) {
  const { t } = useTranslation();
  const L = [...rows].sort((x, y) => rank(x) - rank(y) || y.net - x.net);
  const first = L[0];
  const det = useRpc('mk.adset', { id: first?.id ?? '' }, { enabled: !!first });
  if (!L.length)
    return (
      <section className="card">
        <a className="mk-back" href="#/marketing/marketer">
          ← {t('marketer.back')}
        </a>
        <Empty>{t('marketer.empty')}</Empty>
      </section>
    );
  const lab = L.map((a) => a.prod).filter(Boolean).sort((x, y) => x.length - y.length)[0] || t('marketer.noProduct');
  const sum = (f: (a: Row) => number) => L.reduce((s, a) => s + f(a), 0);
  const sp = sum((a) => a.sp), spDa = sum((a) => a.spDa), pu = sum((a) => a.pu), dl = sum((a) => a.d), nn = sum((a) => a.n), net = sum((a) => a.net), rev = sum((a) => a.rev), marge = sum((a) => a.marge);
  const c = { ok: 0, run: 0, ko: 0 };
  for (const a of L) c[!a.final ? 'run' : a.ok ? 'ok' : 'ko']++;
  let owe = 0, paid = 0;
  for (const a of L) a.paid ? (paid += a.paid.amount) : (owe += a.owe ?? 0);
  const who = [...new Set(L.map((a) => name(a.marketerId)).filter(Boolean))];
  const act = L.filter((a) => a.status === 'ACTIVE').length;
  const days = det.data?.orders30 ?? null;
  const tr = days ? trend(days) : null;
  // advice: no active ad set, demand dropping, or healthy
  let kk = 'good', title = t('marketer.p.healthy'), txt = t('marketer.p.healthyTxt');
  if (!act) (kk = 'mid'), (title = t('marketer.p.noActive')), (txt = t('marketer.p.noActiveTxt'));
  else if (tr && tr.prev >= 2 && tr.last <= 0.6 * tr.prev) (kk = 'bad'), (title = t('marketer.p.drop')), (txt = t('marketer.p.dropTxt', { a: tr.last.toFixed(1), b: tr.prev.toFixed(1) }));
  const kpi = (l: string, v: ReactNode, s: ReactNode, cls = '') => (
    <div className="kpi">
      <span className="lab">{l}</span>
      <span className={`val ltr ${cls}`}>{v}</span>
      <span className="sub">{s}</span>
    </div>
  );
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <a className="mk-back" href="#/marketing/marketer">
            ← {t('marketer.back')}
          </a>
          {lab}
        </h2>
        <span className="note">
          {t('marketer.nAdsets', { count: L.length })} · {t('marketer.nActive', { count: act })}
          {who.length ? ` · ${who.join(', ')}` : ''}
        </span>
      </div>
      <div className="kpis mk-d-kpis">
        {kpi(t('marketer.d.results'), t('marketer.gst.ok', { count: c.ok }), `${t('marketer.gst.run', { count: c.run })} · ${t('marketer.gst.ko', { count: c.ko })}`, c.ok ? 'pos' : '')}
        {kpi(t('marketer.col.spend'), usd(sp), pu ? t('marketer.d.cpaSub', { v: usd(sp / pu), n: n(pu) }) : t('marketer.noPurchase'))}
        {kpi(t('marketer.col.delivered'), nn >= 0.5 ? pct(dl / nn) : '—', t('marketer.d.ofOrders', { d: n(r0(dl)), n: n(r0(nn)) }))}
        {kpi(t('marketer.col.net'), da(net), t('marketer.sales', { v: da(rev) }), net < 0 ? 'neg' : 'pos')}
        {kpi(t('marketer.col.cpd'), dl >= 0.5 ? da(r0(spDa / dl)) : '—', dl >= 0.5 && marge > 0 ? t('marketer.ofMargin', { pct: pct(spDa / marge) }) : '')}
        {kpi(t('marketer.col.share'), marge > 0 ? pct(net / marge) : '—', t('marketer.d.ofMarginLong'), marge > 0 && net / marge < d.rules.seuil ? 'neg' : '')}
        {kpi(t('marketer.col.pay'), da(owe), paid ? t('marketer.alreadyPaid', { amount: da(paid) }) : t('marketer.nothingPaid'), owe ? 'pos' : '')}
      </div>
      <div className={`mk-d-adv ${kk}`}>
        <b>💡 {title}</b>
        <p>{txt}</p>
      </div>
      <h3 className="mk-d-h">
        {t('marketer.d.orders30')} {tr && <span className="count">{t('marketer.d.orders30Sub', { n: n(tr.total), a: tr.last.toFixed(1), b: tr.prev ? tr.prev.toFixed(1) : '—' })}</span>}
      </h3>
      {days ? <OrdersChart days={days} /> : <Loading />}
      <h3 className="mk-d-h">
        {t('marketer.p.adsets')} <span className="count">{n(L.length)}</span>
      </h3>
      <p className="note">{t('marketer.p.adsetsNote')}</p>
      <AdsetTable d={d} groups={[{ key: k, label: lab, rows: L, rank: 0, net }]} sel={sel} setSel={setSel} name={name} showAll={L} flat={k} />
      {d.owner && <Bulk d={d} rows={L} sel={sel} setSel={setSel} />}
    </section>
  );
}

/** Orders per day this week against the days before (since the first order of the 30 days). */
function trend(days: { day: string; n: number; d: number }[]) {
  const first = Math.max(0, days.findIndex((x) => x.n > 0));
  const last7 = days.slice(-7);
  const prev = days.slice(first, -7);
  const avg = (l: typeof days) => (l.length ? l.reduce((s, x) => s + x.n, 0) / l.length : 0);
  return { total: days.reduce((s, x) => s + x.n, 0), last: avg(last7), prev: avg(prev) };
}

function OrdersChart({ days }: { days: { day: string; n: number; d: number }[] }) {
  const { t } = useTranslation();
  const W = 640, H = 170, pl = 24, pb = 18, pt = 8;
  const max = Math.max(4, ...days.map((x) => x.n));
  const bw = (W - pl) / days.length;
  const y = (v: number) => H - pb - (v / max) * (H - pb - pt);
  const step = max <= 8 ? 2 : max <= 20 ? 5 : max <= 60 ? 10 : 25;
  const grid: number[] = [];
  for (let v = 0; v <= max; v += step) grid.push(v);
  return (
    <div className="mk-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('marketer.d.orders30')}>
        {grid.map((v) => (
          <g key={v}>
            <line className="grid" x1={pl} x2={W} y1={y(v)} y2={y(v)} />
            <text x={pl - 5} y={y(v) + 3} textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {days.map((x, i) => {
          const gx = pl + i * bw + bw * 0.15;
          const w = bw * 0.7;
          return (
            <g key={x.day}>
              <title>{t('marketer.d.dayTip', { day: dateOnly(x.day + 'T12:00:00Z'), n: x.n, d: x.d })}</title>
              <rect className="b-all" x={gx} y={y(x.n)} width={w} height={Math.max(0, H - pb - y(x.n))} rx={2} />
              {!!x.d && <rect className="b-del" x={gx} y={y(x.d)} width={w} height={Math.max(0, H - pb - y(x.d))} rx={2} />}
              <rect x={pl + i * bw} y={0} width={bw} height={H} fill="transparent" />
              {(i % 5 === 0 || i === days.length - 1) && (
                <text x={gx + w / 2} y={H - 4} textAnchor="middle">
                  {`${Number(x.day.slice(8))}/${Number(x.day.slice(5, 7))}`}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="lg">
        <span>
          <i className="i-all" />
          {t('marketer.d.lgOrders')}
        </span>
        <span>
          <i className="i-del" />
          {t('marketer.d.lgDelivered')}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- ad set page
/** Colour thresholds (common Meta benchmarks for COD video ads): [good at least, bad below]. */
const BM = { hook: [0.3, 0.2], hold: [0.25, 0.15], lpv: [0.75, 0.6], conv: [0.03, 0.015] } as const;
function Rate({ v, k }: { v: number | null; k: keyof typeof BM }) {
  if (v === null || v === undefined) return <>—</>;
  return <span className={`cbadge ${v >= BM[k][0] ? 'good' : v < BM[k][1] ? 'bad' : ''}`}>{pct(v, 1)}</span>;
}

function AdsetView({ id, back, d, list, name }: { id: string; back?: string; d: Overview; list: Row[]; name: (id: number | null) => string }) {
  const { t } = useTranslation();
  const q = useRpc('mk.adset', { id });
  const a = d.rows.find((x) => x.id === id);
  const pos = list.findIndex((x) => x.id === id);
  const backTo = back ? `#/marketing/marketer/produit/${encodeURIComponent(back)}` : '#/marketing/marketer';
  const nav = (k: number) => {
    const b = list[pos + k];
    if (b) location.replace(`#/marketing/marketer/adset/${encodeURIComponent(b.id)}${back ? `/${encodeURIComponent(back)}` : ''}`);
  };
  if (!a)
    return (
      <section className="card">
        <a className="mk-back" href="#/marketing/marketer">
          ← {t('marketer.back')}
        </a>
        <Empty>{t('marketer.notFound')}</Empty>
      </section>
    );
  const res = !a.final ? (a.fxMissing.length ? t('marketer.calc.fx') : a.stopped ? t('marketer.calc.road') : t('marketer.calc.run')) : a.ok ? t('marketer.calc.ok') : t('marketer.calc.ko');
  const kpi = (l: string, v: ReactNode, s: ReactNode, cls = '') => (
    <div className="kpi">
      <span className="lab">{l}</span>
      <span className={`val ltr ${cls}`}>{v}</span>
      <span className="sub">{s}</span>
    </div>
  );
  const det = q.data;
  const ads = det?.ads ?? [];
  const fat = ads.filter((r) => r.advice.k === 'fatigue' && r.status === 'ACTIVE');
  const weak = ads.filter((r) => (r.advice.k === 'hook' || r.advice.k === 'hold') && r.status === 'ACTIVE');
  const good = ads.filter((r) => r.advice.k === 'good');
  let kk = 'good', title = t('marketer.d.healthy'), txt = good.length ? t('marketer.d.best', { name: good[0].name }) : t('marketer.d.nothing');
  if (det) {
    const D = det.diag;
    if (!ads.length) (kk = ''), (title = t('marketer.d.noAds')), (txt = '');
    else if (fat.length) (kk = 'bad'), (title = t('marketer.d.tired', { count: fat.length })), (txt = t('marketer.d.tiredTxt', { names: fat.map((r) => r.name).join(', ') }));
    else if (weak.length) (kk = 'mid'), (title = t('marketer.d.weak')), (txt = weak.map((r) => `${r.name} (${t(`ads.adAdvice.${r.advice.k}`).toLowerCase()})`).join(', '));
    if (a.status === 'ACTIVE' && D.k !== 'wait' && D.k !== 'ok') (kk = D.tone === 'bad' ? 'bad' : D.tone === 'mid' ? 'mid' : 'good'), (title = t(`ads.diag.${D.k}`)), (txt = `→ ${t(`ads.diagDo.${D.k}`)}${ads.length ? ' ' + txt : ''}`);
  }
  const w = det?.week;
  const wk = (lab: string, v0: number | null | undefined, v1: number | null | undefined, fmt: (v: number) => string, worseUp: boolean | null) => {
    let cls = '';
    if (v0 != null && v1 && worseUp !== null) {
      const ch = v0 / v1 - 1;
      if (Math.abs(ch) >= 0.15) cls = ch > 0 === worseUp ? 'bad' : 'good';
    }
    return (
      <div className={`hl-k ${cls}`} key={lab}>
        <span className="l">{lab}</span>
        <b className="ltr">{v0 == null ? '—' : fmt(v0)}</b>
        <span className="s">{t('marketer.d.weekBefore', { v: v1 == null ? '—' : fmt(v1) })}</span>
      </div>
    );
  };
  const p1 = (v: number) => pct(v, 1);
  const maxSp = Math.max(0.01, ...(det?.days ?? []).map((x) => x.spendUsd));
  const tr = det ? trend(det.orders30) : null;
  return (
    <section className="card">
      <div className="card-head">
        <h2>
          <a className="mk-back" href={backTo}>
            ← {t('marketer.back')}
          </a>
          {a.prod || t('marketer.noProduct')}
        </h2>
        <div className="mk-d-nav">
          <button className="btn-mini" type="button" disabled={pos <= 0} onClick={() => nav(-1)} aria-label={t('marketer.prev')}>
            ‹
          </button>
          <span className="ltr">{pos >= 0 ? `${pos + 1} / ${list.length}` : ''}</span>
          <button className="btn-mini" type="button" disabled={pos < 0 || pos >= list.length - 1} onClick={() => nav(1)} aria-label={t('marketer.next')}>
            ›
          </button>
        </div>
      </div>
      <div className="mk-d-sets">
        <a className="mk-setlk" href={`https://adsmanager.facebook.com/adsmanager/manage/ads?selected_adset_ids=${encodeURIComponent(a.id)}`} target="_blank" rel="noopener noreferrer" title={`ID ${a.id}`}>
          {a.bid && <span className="bid">BID</span>}
          {a.name} ↗
        </a>
        <span>
          {t('marketer.marketer')} : {name(a.marketerId) || '—'}
        </span>
        <span>{statusLabel(a.status, t)}</span>
      </div>
      <div className="kpis mk-d-kpis">
        {kpi(t('marketer.d.result'), res, a.paid ? t('marketer.d.paidX', { v: da(a.paid.amount) }) : a.owe ? t('marketer.d.oweX', { v: da(a.owe) }) : '', !a.final ? '' : a.ok ? 'pos' : 'neg')}
        {kpi(t('marketer.col.spend'), usd(a.sp), a.pu ? t('marketer.d.cpaSub', { v: usd(a.sp / a.pu), n: n(a.pu) }) : t('marketer.noPurchase'))}
        {kpi(t('marketer.col.delivered'), a.n >= 0.5 ? pct(a.d / a.n) : '—', t('marketer.d.ofOrders', { d: n(r0(a.d)), n: n(r0(a.n)) }))}
        {kpi(t('marketer.col.net'), da(a.net), t('marketer.sales', { v: da(a.rev) }), a.net < 0 ? 'neg' : '')}
        {kpi(t('marketer.col.cpd'), a.d >= 0.5 ? da(r0(a.spDa / a.d)) : '—', a.d >= 0.5 && a.marge > 0 ? t('marketer.ofMargin', { pct: pct(a.spDa / a.marge) }) : '')}
        {kpi(t('marketer.col.share'), a.ratio === null ? '—' : pct(a.ratio), t('marketer.d.ofMarginLong'), a.ratio !== null && a.ratio < d.rules.seuil ? 'neg' : '')}
        {kpi(t('marketer.d.metaVs'), `${n(a.pu)} / ${n(r0(a.n))}`, a.pu && a.n >= 0.5 ? (a.pu > a.n ? t('marketer.d.metaMore', { pct: pct(a.pu / a.n - 1) }) : t('marketer.d.metaLess')) : t('marketer.d.metaVsSub'), a.pu && a.n >= 0.5 && a.pu / a.n >= 1.5 ? 'neg' : '')}
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : det ? (
        <>
          <div className={`mk-d-adv ${kk}`}>
            <b>💡 {title}</b>
            {txt && <p>{txt}</p>}
          </div>
          {w && (
            <div className="hl-ks">
              {wk(t('marketer.d.w.spend'), w.now.spend, w.before.spend, usd, null)}
              {wk(t('marketer.d.w.pur'), w.now.pur, w.before.pur, (v) => n(v), false)}
              {wk(t('marketer.d.w.cpa'), w.now.cpa, w.before.cpa, usd, true)}
              {wk(t('marketer.d.w.freq'), w.now.freq, w.before.freq, (v) => v.toFixed(2), true)}
              {wk(t('marketer.d.w.hook'), w.now.hook, w.before.hook, p1, false)}
              {wk(t('marketer.d.w.ctr'), w.now.ctr, w.before.ctr, p1, false)}
              {wk(t('marketer.d.w.cpm'), w.now.cpm, w.before.cpm, usd, true)}
            </div>
          )}
          <h3 className="mk-d-h">
            {t('marketer.d.meta')} <span className="count">{t('marketer.d.metaSub', { days: det.days.length, usd: usd(a.sp) })}</span>
          </h3>
          <div className="mk-spark" aria-label={t('marketer.d.meta')}>
            {det.days.map((x) => (
              <span key={x.day} style={{ height: `${Math.max(2, (x.spendUsd / maxSp) * 100)}%` }} title={`${dateOnly(x.day + 'T12:00:00Z')} · ${usd(x.spendUsd)} · ${n(x.purchases)} ${t('marketer.d.purchases')}`} />
            ))}
          </div>
          <h3 className="mk-d-h">
            {t('marketer.d.orders30')} {tr && <span className="count">{t('marketer.d.orders30Sub', { n: n(tr.total), a: tr.last.toFixed(1), b: tr.prev ? tr.prev.toFixed(1) : '—' })}</span>}
          </h3>
          <OrdersChart days={det.orders30} />
          <h3 className="mk-d-h">
            {t('marketer.d.ads')} <span className="count">{n(ads.length)}</span>
          </h3>
          <p className="note">{t('marketer.d.adsNote')}</p>
          {!ads.length ? (
            <Empty>{t('marketer.d.noAds')}</Empty>
          ) : (
            <div className="tbl-wrap">
              <table className="mk-tbl mk-ads-tbl">
                <thead>
                  <tr>
                    <th>{t('marketer.d.colAd')}</th>
                    <th className="num">{t('marketer.col.spend')}</th>
                    <th className="num">{t('marketer.d.purchases')}</th>
                    <th className="num">Hook rate</th>
                    <th className="num">Hold rate</th>
                    <th className="num">{t('marketer.d.lpv')}</th>
                    <th className="num">{t('marketer.d.conv')}</th>
                    <th>{t('marketer.d.advice')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ads.map((r) => (
                    <tr key={r.id}>
                      <td className="mk-ad">
                        <b>{r.name}</b>
                        <small>
                          {r.isVideo ? t('marketer.d.video') : t('marketer.d.photo')} · {statusLabel(r.status, t)}
                        </small>
                      </td>
                      <td className="num" data-l={t('marketer.col.spend')}>
                        {usd(r.spendUsd)}
                      </td>
                      <td className="num" data-l={t('marketer.d.purchases')}>
                        {n(r.purchases)}
                        <small>{r.cpa !== null ? t('marketer.perPurchase', { v: usd(r.cpa) }) : ''}</small>
                      </td>
                      <td className="num" data-l="Hook rate">
                        <Rate v={r.hook} k="hook" />
                      </td>
                      <td className="num" data-l="Hold rate">
                        <Rate v={r.hold} k="hold" />
                      </td>
                      <td className="num" data-l={t('marketer.d.lpv')}>
                        <Rate v={r.lpvRate} k="lpv" />
                      </td>
                      <td className="num" data-l={t('marketer.d.conv')}>
                        <Rate v={r.conv} k="conv" />
                      </td>
                      <td className="mk-advc" data-l={t('marketer.d.advice')}>
                        <span className={`mk-adv ${r.advice.tone === 'ok' ? 'good' : r.advice.tone}`}>{t(`ads.adAdvice.${r.advice.k}`)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mk-d-end">
            <a className="btn-mini" href={backTo}>
              ← {t('marketer.backList')}
            </a>
          </div>
        </>
      ) : null}
    </section>
  );
}
