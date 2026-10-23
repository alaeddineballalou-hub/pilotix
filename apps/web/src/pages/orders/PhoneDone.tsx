// Commandes › Livré and › Annulé on phones. The road of the orders on top, one period for both pages, then what that
// period adds up to — the money (delivered, cashed, fees, net, what the companies still owe) or why orders were lost
// (statuses, reasons, agents, companies) — where every line is a tap that shows its orders in the list below; then the
// list as cards, with a search and a sheet of filters that says how many orders it will show.
import { CONF_DONE_BAD, Order, SALES_CHANNELS, WILAYAS } from '@pilotix/shared';
import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, dayRange, n, pct, periodRange, when, wilaya, wilayaName } from '../../lib/format';
import { namesOf } from '../../lib/items';
import { openOrder } from '../../lib/modals';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { store } from '../../lib/store';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Seg, Sheet } from '../../ui/Sheet';
import { useCounts } from './counts';
import type { ListFilter } from './shared';
import './phone.css';

type DRep = Out<'orders.deliveredReport'>;
type Agg = DRep['total'];
type CRep = Out<'orders.cancelReport'>;
type Kind = 'livre' | 'conf' | 'back';

// ---------------------------------------------------------------- the period (one for both pages)
type PerKey = 'month' | 'lastmonth' | '30d' | '7d' | 'all' | 'custom';
interface PerState {
  k: PerKey;
  /** the chosen days (YYYY-MM-DD) when k is custom */
  from: string;
  to: string;
}
const PER_KEYS: PerKey[] = ['month', 'lastmonth', '30d', '7d', 'all'];
const PER_STORE = 'orders-ph-period';
/** the day in Algiers (YYYY-MM-DD) */
const algDay = (t: number) => new Date(t + 3_600_000).toISOString().slice(0, 10);
const dayStart = (s: string, plus = 0) => new Date(Date.parse(`${s}T00:00:00+01:00`) + plus * 86_400_000).toISOString();

function rangeOf(p: PerState): { from: string; to: string } {
  if (p.k === 'custom' && p.from && p.to) return { from: dayStart(p.from), to: dayStart(p.to, 1) };
  if (p.k === 'all') return { from: dayStart('2000-01-01'), to: periodRange('today').to };
  return periodRange(p.k === 'custom' ? 'month' : p.k);
}

function usePeriod() {
  const [p, setP] = useState<PerState>(() => {
    const x = store.json<Partial<PerState>>(PER_STORE, {});
    const k = x.k && ([...PER_KEYS, 'custom'] as string[]).includes(x.k) ? x.k : 'month';
    return { k, from: x.from ?? '', to: x.to ?? '' };
  });
  const set = (x: PerState) => {
    setP(x);
    store.set(PER_STORE, JSON.stringify(x));
  };
  const range = rangeOf(p);
  return { p, set, range, label: p.k === 'all' ? null : dayRange(range.from, range.to) };
}
type Period = ReturnType<typeof usePeriod>;

// ---------------------------------------------------------------- the filters of the list
interface PF {
  company: string;
  wilaya: string;
  channel: string;
  agent: string;
  cashed: '' | 'yes' | 'no';
  conf: string;
  follow: '' | 'returning' | 'returned';
  /** the reason given; null: none given */
  reason?: string | null;
  sort: 'new' | 'old' | 'amount';
}
const NO_F: PF = { company: '', wilaya: '', channel: '', agent: '', cashed: '', conf: '', follow: '', sort: 'new' };
const PAGE = 30;
const activeCount = (f: PF) => (['company', 'wilaya', 'channel', 'agent', 'cashed', 'conf', 'follow'] as const).filter((k) => f[k]).length + (f.reason !== undefined ? 1 : 0);

function listInput(kind: Kind, range: { from: string; to: string }, f: PF, q: string, size: number): ListFilter {
  const x: ListFilter =
    kind === 'livre' ? { follow: ['delivered'], dateField: 'delivered_at' } : kind === 'conf' ? { conf: [...CONF_DONE_BAD], dateField: 'updated_at' } : { follow: ['returning', 'returned'], dateField: 'back_at' };
  // a search looks at every date
  if (q) x.q = q;
  else {
    x.from = range.from;
    x.to = range.to;
  }
  if (f.company) x.companyId = f.company === 'none' ? 'none' : Number(f.company);
  if (f.wilaya) x.wilayaId = Number(f.wilaya);
  if (f.channel) x.channel = f.channel as ListFilter['channel'];
  if (f.agent) x.agentId = f.agent === 'none' ? 'none' : Number(f.agent);
  if (kind === 'livre' && f.cashed) x.cashed = f.cashed === 'yes';
  if (kind === 'conf' && f.conf) x.conf = [f.conf as (typeof CONF_DONE_BAD)[number]];
  if (kind === 'back' && f.follow) x.follow = [f.follow];
  if (kind !== 'livre' && f.reason !== undefined) x.reason = { of: kind, text: f.reason };
  x.sort = f.sort === 'amount' ? 'total' : kind === 'livre' ? 'delivered_at' : 'updated_at';
  x.dir = f.sort === 'old' ? 'asc' : 'desc';
  x.page = 1;
  x.pageSize = size;
  return x;
}

function useDebounced<T>(v: T, ms = 300): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const id = window.setTimeout(() => setD(v), ms);
    return () => window.clearTimeout(id);
  }, [v, ms]);
  return d;
}

/** A line of the stats was tapped: its orders in the list (the same line again: all of them), and the list in view. */
function useShow(f: PF, setF: (f: PF) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const show = (patch: Partial<PF>) => {
    const next: PF = { ...NO_F, sort: f.sort, ...patch };
    const same = JSON.stringify({ ...f, sort: '' }) === JSON.stringify({ ...next, sort: '' });
    setF(same ? { ...NO_F, sort: f.sort } : next);
    if (same) return;
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => ref.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }));
  };
  return { ref, show };
}

// ---------------------------------------------------------------- small parts
/** The road of the orders: Confirmation › Dépôt › Suivi, then the two ends (Livré, Annulé). Counts of now. */
function Road({ on }: { on: 'livrees' | 'annulees' }) {
  const { t } = useTranslation();
  const c = useCounts();
  const step = (key: string, href: string, label: string, v: number | undefined, tone = '') => (
    <a key={key} href={href} className={`pxn-st${tone ? ` ${tone}` : ''}${on === key ? ' on' : ''}`} aria-current={on === key ? 'page' : undefined}>
      <small>{label}</small>
      <b className="ltr">{v === undefined ? '…' : n(v)}</b>
    </a>
  );
  return (
    <nav className="pxn-road" aria-label={t('orders.title')}>
      <div className="pxn-run">
        {step('confirmation', '#/confirmation', t('orders.kpi.confirmation'), c?.todo)}
        {step('depot', '#/depot', t('orders.kpi.depot'), c?.depot)}
        {step('suivi', '#/suivi', t('orders.kpi.suivi'), c?.suivi)}
      </div>
      <div className="pxn-end">
        {step('livrees', '#/commandes/livrees', t('orders.kpi.livre'), c?.delivered, 'ok')}
        {step('annulees', '#/commandes/annulees', t('orders.kpi.annule'), c ? c.cancelledConf + c.back : undefined, 'bad')}
      </div>
    </nav>
  );
}

function PeriodBar({ per }: { per: Period }) {
  const { t } = useTranslation();
  const [pick, setPick] = useState(false);
  return (
    <>
      <div className="pxn-per" role="radiogroup" aria-label={t('orders.ph.per.label')}>
        {PER_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={per.p.k === k}
            className={per.p.k === k ? 'on' : ''}
            onClick={(e) => {
              per.set({ ...per.p, k });
              e.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            }}
          >
            {t(`orders.ph.per.${k}`)}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={per.p.k === 'custom'} className={per.p.k === 'custom' ? 'on' : ''} onClick={() => setPick(true)}>
          <Icon name="calendar" />
          {per.p.k === 'custom' && per.label ? per.label : t('orders.ph.per.custom')}
        </button>
      </div>
      {pick && <DatesSheet per={per} onClose={() => setPick(false)} />}
    </>
  );
}

function DatesSheet({ per, onClose }: { per: Period; onClose: () => void }) {
  const { t } = useTranslation();
  const today = algDay(Date.now());
  const [from, setFrom] = useState(per.p.from || algDay(Date.parse(per.range.from)));
  const [to, setTo] = useState(per.p.to || algDay(Date.parse(per.range.to) - 1));
  const ok = !!from && !!to && from <= to;
  return (
    <Sheet
      title={t('orders.ph.per.title')}
      sub={ok ? dayRange(dayStart(from), dayStart(to, 1)) : undefined}
      onClose={onClose}
      foot={
        <button
          type="button"
          className="pxk-go"
          disabled={!ok}
          onClick={() => {
            per.set({ k: 'custom', from, to });
            onClose();
          }}
        >
          <Icon name="check" /> {t('orders.ph.per.apply')}
        </button>
      }
    >
      <div className="pxk-g2">
        <label>
          {t('orders.ph.per.from')}
          <input className="pxk-in" type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          {t('orders.ph.per.to')}
          <input className="pxk-in" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
    </Sheet>
  );
}

/** The delivery company's little badge: its first letters, in its colour. */
function CoTag({ kind, name }: { kind: string | null | undefined; name: string | null | undefined }) {
  const nm = name || '';
  const short = kind === 'own' ? nm.slice(0, 2) : nm.replace(/express|livraison/gi, '').trim().slice(0, 3);
  return (
    <span className={`pxn-co k-${kind || 'other'}`} role="img" aria-label={nm || '—'}>
      {short.toUpperCase() || '—'}
    </span>
  );
}

/** The confirmation agent: initials in a circle. */
function Who({ name }: { name: string | null | undefined }) {
  const ini = (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  return (
    <span className="pxn-who" role="img" aria-label={name || '—'}>
      {ini || '—'}
    </span>
  );
}

interface BarItem {
  key: string;
  label: ReactNode;
  n: number;
  on?: boolean;
  tap?: () => void;
}
/** Why, as bars: each line its count and its share; a line with orders behind it is a button. */
function Bars({ items, total, soft }: { items: BarItem[]; total: number; soft?: boolean }) {
  const max = Math.max(1, ...items.map((x) => x.n));
  return (
    <ul className={`pxn-bars${soft ? ' soft' : ''}`}>
      {items.map((x) => {
        const body = (
          <>
            <span className="pxn-bl">
              <span dir="auto">{x.label}</span>
              <b className="ltr">{n(x.n)}</b>
              <small className="ltr">{pct(total ? x.n / total : null)}</small>
            </span>
            <span className="pxn-bt" aria-hidden="true">
              <i style={{ width: `${Math.max(2, (x.n / max) * 100)}%` }} />
            </span>
          </>
        );
        return (
          <li key={x.key}>
            {x.tap ? (
              <button type="button" className={x.on ? 'on' : ''} aria-pressed={!!x.on} onClick={x.tap}>
                {body}
              </button>
            ) : (
              <div>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Head({ title, aside, id }: { title: ReactNode; aside?: ReactNode; id?: string }) {
  return (
    <header className="pxn-h">
      <h3 id={id}>{title}</h3>
      {aside && <span>{aside}</span>}
    </header>
  );
}

// ---------------------------------------------------------------- Livré
function Ledger({ rep, label, f, show }: { rep: DRep; label: string | null; f: PF; show: (p: Partial<PF>) => void }) {
  const { t } = useTranslation();
  const T = rep.total;
  const fees = T.fees + T.overweight;
  const ret = T.returnFees + T.returnOverweight;
  const share = T.amount ? T.cashed / T.amount : 0;
  return (
    <section className="pxn-card pxn-led" aria-labelledby="pxn-led-h">
      <Head id="pxn-led-h" title={t('orders.ph.ledger')} aside={label} />
      <div className="pxn-big">
        <b className="ltr">{da(T.amount)}</b>
        <small>{t('orders.ph.deliveredN', { count: T.n })}</small>
      </div>
      {T.n > 0 && (
        <div className="pxn-split" role="img" aria-label={t('orders.ph.cashedShare', { pct: pct(share) })}>
          {share > 0 && <i className="ok" style={{ width: `${share * 100}%` }} />}
          {share < 1 && <i className="wn" style={{ flex: 1 }} />}
        </div>
      )}
      {T.n > 0 && (
        <div className="pxn-two">
          <button type="button" className={`ok${f.cashed === 'yes' ? ' on' : ''}`} aria-pressed={f.cashed === 'yes'} onClick={() => show({ cashed: 'yes' })}>
            <small>
              <i /> {t('orders.cashedYes')} · <span className="ltr">{pct(share)}</span>
            </small>
            <b className="ltr">{da(T.cashed)}</b>
            <small>{t('orders.ph.parcels', { count: T.cashedN })}</small>
          </button>
          <button type="button" className={`wn${f.cashed === 'no' ? ' on' : ''}`} aria-pressed={f.cashed === 'no'} onClick={() => show({ cashed: 'no' })}>
            <small>
              <i /> {t('orders.cashedNo')}
            </small>
            <b className="ltr">{da(T.uncashed)}</b>
            <small>{t('orders.ph.parcels', { count: T.uncashedN })}</small>
          </button>
        </div>
      )}
      <dl className="pxn-lines">
        <div>
          <dt>{t('orders.ph.lDelivered')}</dt>
          <dd className="ltr">{da(T.amount)}</dd>
        </div>
        <div className="m">
          <dt>
            {t('orders.ph.lFees')}
            {T.overweight > 0 && <small>{t('orders.ph.lOver', { v: da(T.overweight) })}</small>}
          </dt>
          <dd className="ltr">− {da(fees)}</dd>
        </div>
        <div className="m">
          <dt>
            <a href="#/commandes/annulees" onClick={() => store.set('orders-ph-view', 'back')}>
              {t('orders.ph.lReturns', { count: T.returns })}
              <Icon name="chevr" />
            </a>
          </dt>
          <dd className="ltr">− {da(ret)}</dd>
        </div>
        <div className="eq">
          <dt>{t('orders.ph.lNet')}</dt>
          <dd className="ltr">{da(T.amount - fees - ret)}</dd>
        </div>
      </dl>
      <button type="button" className={`pxn-recv${f.cashed === 'no' ? ' on' : ''}`} onClick={() => show({ cashed: 'no' })}>
        <span>
          <b>{t('orders.ph.recv')}</b>
          <small>{t('orders.ph.recvS')}</small>
        </span>
        <b className="ltr">{da(T.netToReceive)}</b>
        <Icon name="chevr" />
      </button>
      {T.noTariff > 0 && <p className="pxn-note">{t('orders.bilan.noTariff', { n: T.noTariff })}</p>}
      {rep.noOverweightRule.length > 0 && <p className="pxn-note">{t('orders.bilan.noRule', { list: rep.noOverweightRule.join(', ') })}</p>}
    </section>
  );
}

const coKey = (m: { companyId: number | null }) => (m.companyId === null ? 'none' : String(m.companyId));

function CompanyTable({ rep, label, f, show }: { rep: DRep; label: string | null; f: PF; show: (p: Partial<PF>) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Agg | null>(null);
  const rows = rep.companies;
  if (!rows.length) return null;
  const max = Math.max(1, ...rows.map((m) => m.amount));
  const T = rep.total;
  const name = (m: Agg) => (m.companyId === null ? t('orders.bilan.noCompanyName') : m.name);
  return (
    <section className="pxn-card" aria-labelledby="pxn-co-h">
      <Head id="pxn-co-h" title={t('orders.ph.byCompany')} aside={t('orders.ph.inDa')} />
      <div className="pxn-tb">
        <div className="pxn-tr pxn-th" aria-hidden="true">
          <span>{t('orders.ph.colCompany')}</span>
          <span>{t('orders.ph.colN')}</span>
          <span>{t('orders.ph.colUncashed')}</span>
          <span>{t('orders.ph.colRecv')}</span>
        </div>
        {rows.map((m) => (
          <button
            key={coKey(m)}
            type="button"
            className={`pxn-tr${f.company === coKey(m) ? ' on' : ''}`}
            aria-label={t('orders.ph.coAria', { name: name(m), n: n(m.n), u: da(m.uncashed), r: da(m.netToReceive) })}
            onClick={() => setOpen(m)}
          >
            <span className="pxn-nm">
              <CoTag kind={m.kind} name={m.name} />
              <span>
                <b>{name(m)}</b>
                <i style={{ width: `${(m.amount / max) * 100}%` }} />
              </span>
            </span>
            <span className="ltr">{n(m.n)}</span>
            <span className={`ltr${m.uncashed ? ' wn' : ''}`}>{n(m.uncashed)}</span>
            <b className="ltr">{n(m.netToReceive)}</b>
          </button>
        ))}
        {rows.length > 1 && (
          <div className="pxn-tr pxn-tot">
            <span>{t('common.total')}</span>
            <span className="ltr">{n(T.n)}</span>
            <span className="ltr">{n(T.uncashed)}</span>
            <b className="ltr">{n(T.netToReceive)}</b>
          </div>
        )}
      </div>
      {open && (
        <CompanySheet
          m={open}
          name={name(open)}
          label={label}
          onClose={() => setOpen(null)}
          onShow={(p) => {
            const k = coKey(open);
            setOpen(null);
            show({ company: k, ...p });
          }}
        />
      )}
    </section>
  );
}

function CompanySheet({ m, name, label, onClose, onShow }: { m: Agg; name: string; label: string | null; onClose: () => void; onShow: (p: Partial<PF>) => void }) {
  const { t } = useTranslation();
  const line = (l: ReactNode, v: string, cls = '') => (
    <div className={cls}>
      <dt>{l}</dt>
      <dd className="ltr">{v}</dd>
    </div>
  );
  return (
    <Sheet
      title={
        <span className="pxn-sht">
          <CoTag kind={m.kind} name={m.name} /> {name}
        </span>
      }
      sub={label ?? t('orders.ph.per.sinceStart')}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="pxk-go" onClick={() => onShow({})}>
            <Icon name="list" /> {t('orders.ph.seeAll', { count: m.n })}
          </button>
          {m.uncashedN > 0 && (
            <button type="button" className="pxk-go ghost" onClick={() => onShow({ cashed: 'no' })}>
              {t('orders.ph.seeUncashed', { count: m.uncashedN })}
            </button>
          )}
        </>
      }
    >
      <dl className="pxn-lines">
        {line(t('orders.ph.cDelivered', { count: m.n }), da(m.amount))}
        {line(t('orders.ph.cCashed', { count: m.cashedN }), da(m.cashed), 'ok')}
        {line(t('orders.ph.cUncashed', { count: m.uncashedN }), da(m.uncashed), m.uncashed ? 'wn' : '')}
      </dl>
      <dl className="pxn-lines">
        {line(t('orders.ph.lFees'), `− ${da(m.fees)}`, 'm')}
        {m.overweight + m.returnOverweight > 0 && line(t('orders.ph.cOver'), `− ${da(m.overweight + m.returnOverweight)}`, 'm')}
        {line(t('orders.ph.lReturns', { count: m.returns }), `− ${da(m.returnFees)}`, 'm')}
      </dl>
      <div className="pxn-recv st">
        <span>
          <b>{t('orders.ph.recvOne', { name })}</b>
          <small>{t('orders.ph.recvS')}</small>
        </span>
        <b className="ltr">{da(m.netToReceive)}</b>
      </div>
      {m.kind === 'own' && (
        <p className="pxk-info">
          <Icon name="bike" /> {t('orders.ph.ownInfo')}
        </p>
      )}
    </Sheet>
  );
}

export function PhoneLivre() {
  const { t } = useTranslation();
  const { has } = useSession();
  const per = usePeriod();
  const [f, setF] = useState<PF>(NO_F);
  const { ref, show } = useShow(f, setF);
  const money = has('suivi', 'depot');
  const rep = useRpc('orders.deliveredReport', per.range, { enabled: money });
  return (
    <div className="pxn">
      <Road on="livrees" />
      <PeriodBar per={per} />
      {money &&
        (rep.error ? (
          <ErrorBox error={rep.error} onRetry={() => rep.refetch()} />
        ) : !rep.data ? (
          <section className="pxn-card">
            <Loading />
          </section>
        ) : rep.data.total.n === 0 && rep.data.total.returns === 0 ? (
          <section className="pxn-card pxn-none">
            <p>{t('orders.bilan.none')}</p>
            {per.p.k !== 'all' && (
              <button type="button" className="pxk-go ghost" onClick={() => per.set({ ...per.p, k: 'all' })}>
                {t('orders.ph.seeSinceStart')}
              </button>
            )}
          </section>
        ) : (
          <>
            <Ledger rep={rep.data} label={per.label} f={f} show={show} />
            <CompanyTable rep={rep.data} label={per.label} f={f} show={show} />
          </>
        ))}
      <div ref={ref} className="pxn-anchor">
        <PhoneList kind="livre" title={t('orders.delivered')} per={per} f={f} setF={setF} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Annulé
const rateTone = (r: number | null) => (r === null ? '' : r >= 0.3 ? 'bad' : r >= 0.2 ? 'wn' : 'ok');

function ConfStats({ r, label, f, show }: { r: CRep['conf']; label: string | null; f: PF; show: (p: Partial<PF>) => void }) {
  const { t } = useTranslation();
  const statuses = CONF_DONE_BAD.map((s) => ({ s, n: r.byStatus[s] ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  const reasons: BarItem[] = [
    ...r.reasons.top.map((x) => ({ key: `r-${x.reason}`, label: x.reason, n: x.n, on: f.reason === x.reason, tap: () => show({ reason: x.reason }) })),
    ...(r.reasons.others ? [{ key: '_o', label: t('orders.ph.others'), n: r.reasons.others }] : []),
    ...(r.reasons.none ? [{ key: '_n', label: t('orders.ph.none'), n: r.reasons.none, on: f.reason === null, tap: () => show({ reason: null }) }] : []),
  ];
  return (
    <>
      <section className="pxn-card" aria-labelledby="pxn-why-h">
        <Head id="pxn-why-h" title={t('orders.ph.whyConf')} aside={label} />
        {r.n === 0 ? (
          <p className="pxn-empty">{t('orders.ph.noneConf')}</p>
        ) : (
          <>
            <h4 className="pxn-sub">{t('orders.ph.byStatus')}</h4>
            <Bars total={r.n} items={statuses.map((x) => ({ key: x.s, label: t(`status.conf.${x.s}`), n: x.n, on: f.conf === x.s, tap: () => show({ conf: x.s }) }))} />
            <h4 className="pxn-sub">{t('orders.ph.reasons')}</h4>
            <Bars soft total={r.n} items={reasons} />
            <p className="pxn-foot">
              <span>{t('orders.ph.lostValue')}</span>
              <b className="ltr">{da(r.amount)}</b>
            </p>
          </>
        )}
      </section>
      {r.agents.length > 0 && (
        <section className="pxn-card" aria-labelledby="pxn-ag-h">
          <Head id="pxn-ag-h" title={t('orders.ph.byAgent')} aside={label} />
          <div className="pxn-tb">
            <div className="pxn-tr pxn-th" aria-hidden="true">
              <span>{t('orders.ph.colAgent')}</span>
              <span>{t('orders.ph.colCancelled')}</span>
              <span>{t('orders.ph.colConfirmed')}</span>
              <span>{t('orders.ph.colRate')}</span>
            </div>
            {r.agents.map((a) => {
              const k = a.id === null ? 'none' : String(a.id);
              const nm = a.name ?? t('orders.ph.noAgent');
              return (
                <button
                  key={k}
                  type="button"
                  className={`pxn-tr${f.agent === k ? ' on' : ''}`}
                  aria-label={t('orders.ph.agentAria', { name: nm, n: n(a.n), c: n(a.confirmed), pct: pct(a.rate) })}
                  onClick={() => show({ agent: k })}
                >
                  <span className="pxn-nm">
                    <Who name={a.name} />
                    <b>{nm}</b>
                  </span>
                  <span className="ltr">{n(a.n)}</span>
                  <span className="ltr">{n(a.confirmed)}</span>
                  <span className={`pxn-rt ${rateTone(a.rate)}`}>
                    <b className="ltr">{pct(a.rate)}</b>
                    <i style={{ width: `${Math.round((a.rate ?? 0) * 100)}%` }} />
                  </span>
                </button>
              );
            })}
          </div>
          <p className="pxn-note">{t('orders.ph.rateHow')}</p>
        </section>
      )}
    </>
  );
}

function BackStats({ r, label, f, show }: { r: CRep['returns']; label: string | null; f: PF; show: (p: Partial<PF>) => void }) {
  const { t } = useTranslation();
  const share = r.n ? r.returned / r.n : 0;
  const reasons: BarItem[] = [
    ...r.reasons.top.map((x) => ({ key: `r-${x.reason}`, label: x.reason, n: x.n, on: f.reason === x.reason, tap: () => show({ reason: x.reason }) })),
    ...(r.reasons.others ? [{ key: '_o', label: t('orders.ph.others'), n: r.reasons.others }] : []),
    ...(r.reasons.none ? [{ key: '_n', label: t('orders.ph.none'), n: r.reasons.none, on: f.reason === null, tap: () => show({ reason: null }) }] : []),
  ];
  return (
    <>
      <section className="pxn-card" aria-labelledby="pxn-back-h">
        <Head id="pxn-back-h" title={t('orders.ph.whyBack')} aside={label} />
        {r.n === 0 ? (
          <p className="pxn-empty">{t('orders.ph.noneBack')}</p>
        ) : (
          <>
            <div className="pxn-split" aria-hidden="true">
              {share > 0 && <i className="bad" style={{ width: `${share * 100}%` }} />}
              {share < 1 && <i className="wn" style={{ flex: 1 }} />}
            </div>
            <div className="pxn-two">
              <button type="button" className={`bad${f.follow === 'returned' ? ' on' : ''}`} aria-pressed={f.follow === 'returned'} onClick={() => show({ follow: 'returned' })}>
                <small>
                  <i /> {t('status.follow.returned')}
                </small>
                <b className="ltr">{n(r.returned)}</b>
                <small>{t('orders.ph.atDepot')}</small>
              </button>
              <button type="button" className={`wn${f.follow === 'returning' ? ' on' : ''}`} aria-pressed={f.follow === 'returning'} onClick={() => show({ follow: 'returning' })}>
                <small>
                  <i /> {t('status.follow.returning')}
                </small>
                <b className="ltr">{n(r.returning)}</b>
                <small>{t('orders.ph.onTheWay')}</small>
              </button>
            </div>
            <h4 className="pxn-sub">{t('orders.ph.reasons')}</h4>
            <Bars total={r.n} items={reasons} />
            <dl className="pxn-lines">
              <div className="m">
                <dt>{t('orders.ph.cost')}</dt>
                <dd className="ltr">− {da(r.fees)}</dd>
              </div>
              <div>
                <dt>{t('orders.ph.backValue')}</dt>
                <dd className="ltr">{da(r.amount)}</dd>
              </div>
            </dl>
          </>
        )}
      </section>
      {r.companies.length > 0 && (
        <section className="pxn-card" aria-labelledby="pxn-bco-h">
          <Head id="pxn-bco-h" title={t('orders.ph.byCompany')} aside={label} />
          <div className="pxn-tb">
            <div className="pxn-tr pxn-th" aria-hidden="true">
              <span>{t('orders.ph.colCompany')}</span>
              <span>{t('orders.ph.colReturns')}</span>
              <span>{t('orders.ph.colRate')}</span>
              <span>{t('orders.ph.colCost')}</span>
            </div>
            {r.companies.map((c) => {
              const k = coKey(c);
              const nm = c.companyId === null ? t('orders.bilan.noCompanyName') : c.name;
              return (
                <button
                  key={k}
                  type="button"
                  className={`pxn-tr${f.company === k ? ' on' : ''}`}
                  aria-label={t('orders.ph.backCoAria', { name: nm, n: n(c.returns), d: n(c.delivered), pct: pct(c.rate), v: da(c.fees) })}
                  onClick={() => show({ company: k })}
                >
                  <span className="pxn-nm">
                    <CoTag kind={c.kind} name={c.name} />
                    <b>{nm}</b>
                  </span>
                  <span className="ltr">{n(c.returns)}</span>
                  <span className={`pxn-rt ${c.rate === null ? '' : c.rate >= 0.25 ? 'bad' : c.rate >= 0.12 ? 'wn' : 'ok'}`}>
                    <b className="ltr">{pct(c.rate)}</b>
                    <i style={{ width: `${Math.round((c.rate ?? 0) * 100)}%` }} />
                  </span>
                  <span className="ltr">{n(c.fees)}</span>
                </button>
              );
            })}
          </div>
          <p className="pxn-note">{t('orders.ph.backHow')}</p>
        </section>
      )}
    </>
  );
}

/** How many orders the list would show (for someone who cannot see the stats). */
function useTotal(input: ListFilter, enabled: boolean) {
  return useRpc('orders.list', { ...input, pageSize: 1 }, { enabled }).data?.total;
}

export function PhoneAnnule() {
  const { t } = useTranslation();
  const { has } = useSession();
  const per = usePeriod();
  const [view, setView] = useState<'conf' | 'back'>(() => (store.get('orders-ph-view') === 'back' ? 'back' : 'conf'));
  const [f, setF] = useState<PF>(NO_F);
  const { ref, show } = useShow(f, setF);
  const can = has('suivi', 'depot', 'agent_manager');
  const rep = useRpc('orders.cancelReport', per.range, { enabled: can });
  const r = can ? rep.data : undefined;
  const nConf = useTotal(listInput('conf', per.range, NO_F, '', 1), !can);
  const nBack = useTotal(listInput('back', per.range, NO_F, '', 1), !can);
  const pick = (v: 'conf' | 'back') => {
    setView(v);
    store.set('orders-ph-view', v);
    setF({ ...NO_F, sort: f.sort });
  };
  const tile = (v: 'conf' | 'back', icon: string, label: string, count: number | undefined, rate: number | null | undefined, rateKey: string) => (
    <button type="button" role="tab" id={`pxn-v-${v}`} aria-selected={view === v} aria-controls="pxn-vp" className={`${v}${view === v ? ' on' : ''}`} onClick={() => pick(v)}>
      <span>
        <Icon name={icon} /> {label}
      </span>
      <b className="ltr">{count === undefined ? '…' : n(count)}</b>
      <small>{rate !== undefined && rate !== null ? t(rateKey, { pct: pct(rate) }) : per.label ?? t('orders.ph.per.sinceStart')}</small>
    </button>
  );
  return (
    <div className="pxn">
      <Road on="annulees" />
      <PeriodBar per={per} />
      <div className="pxn-views" role="tablist" aria-label={t('orders.kpi.annule')}>
        {tile('conf', 'ban', t('orders.ph.atConf'), r ? r.conf.n : nConf, r?.conf.rate, 'orders.ph.confRate')}
        {tile('back', 'undo', t('orders.ph.returns'), r ? r.returns.n : nBack, r?.returns.rate, 'orders.ph.backRate')}
      </div>
      <div id="pxn-vp" role="tabpanel" aria-labelledby={`pxn-v-${view}`} className="pxn-vp">
        {can &&
          (rep.error ? (
            <ErrorBox error={rep.error} onRetry={() => rep.refetch()} />
          ) : !r ? (
            <section className="pxn-card">
              <Loading />
            </section>
          ) : view === 'conf' ? (
            <ConfStats r={r.conf} label={per.label} f={f} show={show} />
          ) : (
            <BackStats r={r.returns} label={per.label} f={f} show={show} />
          ))}
        <div ref={ref} className="pxn-anchor">
          <PhoneList key={view} kind={view} title={view === 'conf' ? t('orders.cancelledConf') : t('orders.ph.listBack')} per={per} f={f} setF={setF} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the list
type Company = Out<'orders.lookups'>['companies'][number];
type Agent = Out<'users.list'>[number];

function OrderRow({ o, kind, coKind, fee, why }: { o: Order; kind: Kind; coKind: string | null; fee?: number; why?: string | null }) {
  const { t } = useTranslation();
  const date = kind === 'livre' ? o.deliveredAt : kind === 'back' ? o.returnedAt ?? o.updatedAt : o.updatedAt;
  const status =
    kind === 'livre' ? (
      <span className={`pxn-pill ${o.cashed ? 'ok' : 'wn'}`}>{o.cashed ? t('orders.cashedYes') : t('orders.cashedNo')}</span>
    ) : kind === 'conf' ? (
      <span className={`pxn-pill ${o.confStatus === 'duplicate' ? 'off' : 'bad'}`}>{t(`status.conf.${o.confStatus}`)}</span>
    ) : (
      <span className={`pxn-pill ${o.followStatus === 'returned' ? 'bad' : 'wn'}`}>{t(`status.follow.${o.followStatus ?? 'returning'}`)}</span>
    );
  return (
    <button type="button" className="pxn-o" onClick={() => openOrder(o.id)}>
      {kind === 'conf' ? <Who name={o.agentName} /> : <CoTag kind={coKind} name={o.companyName || o.livreurName} />}
      <span className="pxn-om">
        <span className="pxn-o1">
          <b>{o.customerName}</b>
          <b className="ltr pxn-amt">{da(o.total)}</b>
        </span>
        <span className="pxn-o2">
          <span>
            <span className="ltr">{o.ref}</span> · {wilayaName(o.wilayaId)} · {namesOf(o.items)}
          </span>
          {fee ? <small>{t('orders.ph.fee', { v: da(fee) })}</small> : null}
        </span>
        {why && (
          <span className="pxn-why" dir="auto">
            {t('orders.ph.quote', { v: why })}
          </span>
        )}
        <span className="pxn-o3">
          {status}
          <small>
            {kind === 'conf' && o.agentName ? `${o.agentName} · ` : ''}
            {when(date)}
          </small>
        </span>
      </span>
    </button>
  );
}

function PhoneList({ kind, title, per, f, setF }: { kind: Kind; title: string; per: Period; f: PF; setF: (f: PF) => void }) {
  const { t } = useTranslation();
  const { has } = useSession();
  const hid = useId();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 300);
  const [size, setSize] = useState(PAGE);
  const [sheet, setSheet] = useState(false);
  const fk = JSON.stringify(f);
  useEffect(() => setSize(PAGE), [fk, dq, per.range.from, per.range.to, kind]);
  const look = useRpc('orders.lookups', {}, { staleTime: 5 * 60_000 });
  const agents = useRpc('users.list', { role: 'confirmation' }, { staleTime: 5 * 60_000 });
  const list = useRpc('orders.list', listInput(kind, per.range, f, dq, size));
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const ids = rows.map((o) => o.id);
  const fees = useRpc('orders.companyFees', { ids }, { enabled: kind === 'livre' && ids.length > 0 && has('confirmation', 'suivi', 'depot') });
  const why = useRpc('orders.reasons', { ids, of: kind === 'conf' ? 'conf' : 'back' }, { enabled: kind !== 'livre' && ids.length > 0 });
  const companies: Company[] = look.data?.companies ?? [];
  const coKind = (id: number | null) => companies.find((c) => c.id === id)?.kind ?? null;
  const active = activeCount(f);

  const chips: { k: keyof PF; label: string }[] = [];
  if (f.cashed) chips.push({ k: 'cashed', label: f.cashed === 'yes' ? t('orders.cashedYes') : t('orders.cashedNo') });
  if (f.conf) chips.push({ k: 'conf', label: t(`status.conf.${f.conf}`) });
  if (f.follow) chips.push({ k: 'follow', label: t(`status.follow.${f.follow}`) });
  if (f.reason !== undefined) chips.push({ k: 'reason', label: f.reason === null ? t('orders.ph.none') : t('orders.ph.quote', { v: f.reason }) });
  if (f.company) chips.push({ k: 'company', label: f.company === 'none' ? t('orders.bilan.noCompanyName') : companies.find((c) => String(c.id) === f.company)?.name ?? '…' });
  if (f.agent) chips.push({ k: 'agent', label: f.agent === 'none' ? t('orders.ph.noAgent') : (agents.data ?? []).find((u) => String(u.id) === f.agent)?.name ?? '…' });
  if (f.wilaya) chips.push({ k: 'wilaya', label: wilaya(Number(f.wilaya)) });
  if (f.channel) chips.push({ k: 'channel', label: t(`status.channel.${f.channel}`) });
  const drop = (k: keyof PF) => setF({ ...f, [k]: k === 'reason' ? undefined : '' });

  return (
    <section className="pxn-list" aria-labelledby={hid}>
      <header className="pxn-lh">
        <h3 id={hid}>{title}</h3>
        <span>
          <b className="ltr">{list.data ? n(total) : '…'}</b> · {dq ? t('orders.ph.allDates') : per.label ?? t('orders.ph.per.sinceStart')}
        </span>
      </header>
      <div className="pxn-find">
        <label className="pxn-q">
          <Icon name="search" />
          <input type="search" value={q} placeholder={t('orders.ph.searchPh')} aria-label={t('orders.f.searchPh')} enterKeyHint="search" autoComplete="off" onChange={(e) => setQ(e.target.value)} />
        </label>
        <button type="button" className={`pxn-fb${active ? ' on' : ''}`} onClick={() => setSheet(true)}>
          <Icon name="sliders" />
          <span>{t('orders.f.filters')}</span>
          {active > 0 && <b>{active}</b>}
        </button>
      </div>
      {chips.length > 0 && (
        <div className="pxn-chips">
          {chips.map((c) => (
            <button key={c.k} type="button" className="pxn-chip" aria-label={t('orders.ph.removeF', { f: c.label })} onClick={() => drop(c.k)}>
              <span dir="auto">{c.label}</span>
              <Icon name="x" />
            </button>
          ))}
          {chips.length > 1 && (
            <button type="button" className="pxn-chip clr" onClick={() => setF({ ...NO_F, sort: f.sort })}>
              {t('orders.ph.clearAll')}
            </button>
          )}
        </div>
      )}
      {list.error ? (
        <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data ? (
        <Loading />
      ) : rows.length === 0 ? (
        <div className="pxn-none">
          <p>{dq ? t('orders.ph.noFound', { q: dq }) : active ? t('orders.ph.emptyF') : t(`orders.ph.empty.${kind}`)}</p>
          {active > 0 && (
            <button type="button" className="pxk-go ghost" onClick={() => setF({ ...NO_F, sort: f.sort })}>
              {t('orders.ph.clearAll')}
            </button>
          )}
        </div>
      ) : (
        <ul className={`pxn-cards${list.isFetching && list.isPlaceholderData ? ' busy' : ''}`}>
          {rows.map((o) => (
            <li key={o.id}>
              <OrderRow o={o} kind={kind} coKind={coKind(o.companyId)} fee={fees.data?.[String(o.id)]?.fee} why={why.data?.[String(o.id)]} />
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && rows.length < total && (
        <button type="button" className="pxn-more" disabled={list.isFetching} onClick={() => setSize(size + PAGE)}>
          {t('orders.ph.more', { count: Math.min(PAGE, total - rows.length) })}
          <small>{t('orders.ph.shown', { shown: n(rows.length), total: n(total) })}</small>
        </button>
      )}
      {sheet && (
        <FilterSheet
          kind={kind}
          title={title}
          per={per}
          q={dq}
          f={f}
          companies={companies}
          agents={agents.data ?? []}
          onClose={() => setSheet(false)}
          onApply={(x) => {
            setF(x);
            setSheet(false);
          }}
        />
      )}
    </section>
  );
}

function FilterSheet({ kind, title, per, q, f, companies, agents, onClose, onApply }: { kind: Kind; title: string; per: Period; q: string; f: PF; companies: Company[]; agents: Agent[]; onClose: () => void; onApply: (f: PF) => void }) {
  const { t } = useTranslation();
  const [d, setD] = useState<PF>(f);
  const set = (p: Partial<PF>) => setD({ ...d, ...p });
  const count = useRpc('orders.list', listInput(kind, per.range, d, q, 1));
  const total = count.data?.total;
  const chip = (on: boolean, label: ReactNode, tap: () => void, key: string) => (
    <button key={key} type="button" className={`pxk-chip${on ? ' on' : ''}`} aria-pressed={on} onClick={tap}>
      {label}
    </button>
  );
  const cos = companies.filter((c) => c.active || String(c.id) === d.company);
  return (
    <Sheet
      title={t('orders.f.filters')}
      sub={`${title} · ${q ? t('orders.ph.allDates') : per.label ?? t('orders.ph.per.sinceStart')}`}
      onClose={onClose}
      foot={
        <div className="pxk-row pxn-ff">
          <button type="button" className="pxk-go ghost" disabled={!activeCount(d) && d.sort === 'new'} onClick={() => setD(NO_F)}>
            {t('orders.ph.clearAll')}
          </button>
          <button type="button" className="pxk-go" disabled={total === undefined} onClick={() => onApply(d)}>
            {total === undefined ? '…' : t('orders.ph.showN', { count: total })}
          </button>
        </div>
      }
    >
      {kind === 'livre' && (
        <fieldset className="pxk-q">
          <legend>{t('orders.ph.fCashed')}</legend>
          <Seg
            value={d.cashed || 'all'}
            label={t('orders.ph.fCashed')}
            onChange={(v) => set({ cashed: v === 'all' ? '' : v })}
            items={[
              { k: 'all', label: t('orders.f.allM') },
              { k: 'yes', label: t('orders.cashedYes') },
              { k: 'no', label: t('orders.cashedNo') },
            ]}
          />
        </fieldset>
      )}
      {kind === 'conf' && (
        <fieldset className="pxk-q">
          <legend>{t('orders.ph.fStatus')}</legend>
          <div className="pxk-chips">
            {chip(!d.conf, t('orders.f.all'), () => set({ conf: '' }), 'all')}
            {CONF_DONE_BAD.map((s) => chip(d.conf === s, t(`status.conf.${s}`), () => set({ conf: d.conf === s ? '' : s }), s))}
          </div>
        </fieldset>
      )}
      {kind === 'back' && (
        <fieldset className="pxk-q">
          <legend>{t('orders.ph.fStatus')}</legend>
          <Seg
            value={d.follow || 'all'}
            label={t('orders.ph.fStatus')}
            onChange={(v) => set({ follow: v === 'all' ? '' : v })}
            items={[
              { k: 'all', label: t('orders.f.allM') },
              { k: 'returning', label: t('status.follow.returning') },
              { k: 'returned', label: t('status.follow.returned') },
            ]}
          />
        </fieldset>
      )}
      {d.reason !== undefined && (
        <fieldset className="pxk-q">
          <legend>{t('orders.ph.fReason')}</legend>
          <div className="pxk-chips">
            <button type="button" className="pxk-chip on" aria-label={t('orders.ph.removeF', { f: d.reason ?? t('orders.ph.none') })} onClick={() => set({ reason: undefined })}>
              <span dir="auto">{d.reason === null ? t('orders.ph.none') : t('orders.ph.quote', { v: d.reason })}</span>
              <Icon name="x" />
            </button>
          </div>
        </fieldset>
      )}
      {(kind !== 'conf' || cos.length > 0) && (
        <fieldset className="pxk-q">
          <legend>{t('orders.f.company')}</legend>
          <div className="pxk-chips">
            {chip(!d.company, t('orders.f.all'), () => set({ company: '' }), 'all')}
            {cos.map((c) => chip(d.company === String(c.id), c.name, () => set({ company: d.company === String(c.id) ? '' : String(c.id) }), String(c.id)))}
            {kind === 'conf' && chip(d.company === 'none', t('orders.f.noCompany'), () => set({ company: d.company === 'none' ? '' : 'none' }), 'none')}
          </div>
        </fieldset>
      )}
      <div className="pxk-g2">
        <label>
          {t('orders.f.agent')}
          <select className="pxk-in" value={d.agent} onChange={(e) => set({ agent: e.target.value })}>
            <option value="">{t('orders.f.allM')}</option>
            {agents.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.name}
              </option>
            ))}
            <option value="none">{t('orders.ph.noAgent')}</option>
          </select>
        </label>
        <label>
          {t('orders.f.wilaya')}
          <select className="pxk-in" value={d.wilaya} onChange={(e) => set({ wilaya: e.target.value })}>
            <option value="">{t('orders.f.all')}</option>
            {WILAYAS.map((_, i) => (
              <option key={i} value={String(i + 1)}>
                {wilaya(i + 1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="pxk-q">
        <legend>{t('orders.f.source')}</legend>
        <div className="pxk-chips">
          {chip(!d.channel, t('orders.f.all'), () => set({ channel: '' }), 'all')}
          {SALES_CHANNELS.map((c) => chip(d.channel === c, t(`status.channel.${c}`), () => set({ channel: d.channel === c ? '' : c }), c))}
        </div>
      </fieldset>
      <fieldset className="pxk-q">
        <legend>{t('orders.ph.fSort')}</legend>
        <Seg
          value={d.sort}
          label={t('orders.ph.fSort')}
          onChange={(v) => set({ sort: v })}
          items={[
            { k: 'new', label: t('orders.ph.sort.new') },
            { k: 'old', label: t('orders.ph.sort.old') },
            { k: 'amount', label: t('orders.ph.sort.amount') },
          ]}
        />
      </fieldset>
    </Sheet>
  );
}
