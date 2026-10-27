// « Agences » (the store's administrator): the store's code to give to an agency, finding an agency by its code,
// requests both ways, what the store gives each agency (tasks, products), its prices (set by the agency: accept new
// ones or end), its agents, the month's numbers and the agency's payment requests.
import { AgencyCounts, AgencyLinkInfo, AgencyTask, NO_COUNTS } from '@pilotix/shared';
import { FormEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out, rpc } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { CopyCode } from '../../ui/CopyCode';
import { Card, Empty, ErrorBox, Field, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { BillLines, BillsList, CountsLine, CountsRow, EndModal, Lead, LinkStatus, monthLabel, MonthPicker, PriceList, TaskChips, TaskPicker } from '../agency/parts';
import type { PageProps } from '../registry';
import '../agency/agency.css';

type Home = Out<'partners.home'>;
type Product = Home['products'][number];

const monthNow = () => {
  const d = new Date(Date.now() + 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export function Agences({ sub }: PageProps) {
  const id = sub && /^\d+$/.test(sub) ? Number(sub) : null;
  return id ? <AgencyDetail id={id} /> : <AgencyList />;
}

function AgencyList() {
  const { t } = useTranslation();
  const q = useRpc('partners.home', {});
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const h = q.data!;
  const received = h.links.filter((l) => l.status === 'pending' && l.requestedBy === 'agency');
  const sent = h.links.filter((l) => l.status === 'pending' && l.requestedBy === 'store');
  const active = h.links.filter((l) => l.status === 'active');
  const past = h.links.filter((l) => l.status !== 'pending' && l.status !== 'active');
  return (
    <div className="agx-page">
      <div className="agx-grid">
        <section className="card agx-hero">
          <div className="agx-hero-t">
            <small>{t('agency.store.yourCode')}</small>
            <span className="agx-code">{h.code ? <CopyCode code={h.code} /> : '—'}</span>
            <p className="muted">{t('agency.store.codeText')}</p>
          </div>
        </section>
        <FindAgency products={h.products} links={h.links} />
      </div>
      {received.length > 0 && (
        <Card title={t('agency.store.received')} badge={<span className="nav-count nc-a">{received.length}</span>}>
          <div className="agx-links">
            {received.map((l) => (
              <ReceivedFromAgency key={l.id} l={l} products={h.products} links={h.links} />
            ))}
          </div>
        </Card>
      )}
      <Card title={t('agency.store.agencies')} help={t('agency.store.agenciesHelp')}>
        {active.length ? (
          <div className="agx-links">
            {active.map((l) => (
              <AgencyCard key={l.id} l={l} c={h.counts[String(l.id)]} products={h.products} />
            ))}
          </div>
        ) : (
          <Empty>{t('agency.store.none')}</Empty>
        )}
      </Card>
      {sent.length > 0 && (
        <Card title={t('agency.sent')}>
          <div className="agx-links">
            {sent.map((l) => (
              <SentToAgency key={l.id} l={l} products={h.products} />
            ))}
          </div>
        </Card>
      )}
      {past.length > 0 && (
        <details className="card agx-past">
          <summary>
            {t('agency.past')} <span className="muted">({past.length})</span>
          </summary>
          <ul className="agx-past-list">
            {past.map((l) => (
              <li key={l.id}>
                <b>{l.agency.name}</b> <LinkStatus l={l} side="store" />
                {l.status === 'ended' && <a href={`#/agences/${l.id}`}>{t('agency.seeDetail')}</a>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** What other agencies already have, for one of these tasks: their products (they go to them), or every product. */
function takenBy(links: AgencyLinkInfo[], exceptId: number | null, tasks: AgencyTask[]) {
  const map = new Map<number, string>();
  let all: string | null = null;
  for (const l of links) {
    if (l.status !== 'active' || l.id === exceptId || !l.tasks.some((k) => tasks.includes(k))) continue;
    if (l.products === null) all = l.agency.name;
    else for (const p of l.products) map.set(p, l.agency.name);
  }
  return { map, all };
}

/** « Tous les produits (aussi les nouveaux) » or a choice of products (those of another agency are shown, not offered). */
function ProductPicker({ products, value, onChange, taken }: { products: Product[]; value: number[] | null; onChange: (v: number[] | null) => void; taken: ReturnType<typeof takenBy> }) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  // the products still free first, those of another agency after
  const shown = useMemo(
    () => products.filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => Number(taken.map.has(a.id)) - Number(taken.map.has(b.id))),
    [products, q, taken],
  );
  const sel = new Set(value ?? []);
  return (
    <div className="agx-products">
      <label className={`agx-pick-it ${value === null ? 'on' : ''} ${taken.all ? 'agx-taken' : ''}`}>
        <input type="radio" checked={value === null} disabled={!!taken.all} onChange={() => onChange(null)} />
        <Icon name="layers" />
        <span>
          <b>{t('agency.allProducts')}</b>
          <small className="muted">{taken.all ? t('agency.store.allTaken', { name: taken.all }) : t('agency.allProductsHelp')}</small>
        </span>
      </label>
      <label className={`agx-pick-it ${value !== null ? 'on' : ''}`}>
        <input type="radio" checked={value !== null} onChange={() => onChange(value ?? [])} />
        <Icon name="tag" />
        <span>
          <b>{t('agency.someProducts')}</b>
          <small className="muted">{t('agency.someProductsHelp')}</small>
        </span>
      </label>
      {value !== null && (
        <div className="agx-plist">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('agency.searchProduct')} aria-label={t('agency.searchProduct')} />
          <ul className="agx-checks">
            {shown.map((p) => {
              const other = taken.map.get(p.id);
              return (
                <li key={p.id}>
                  <label className={other ? 'agx-taken' : ''}>
                    <input type="checkbox" checked={sel.has(p.id)} disabled={!!other && !sel.has(p.id)} onChange={() => onChange(sel.has(p.id) ? [...sel].filter((x) => x !== p.id) : [...sel, p.id])} />
                    <span>
                      <b>{p.name}</b>
                      {!p.active && <small className="muted">{t('agency.inactive')}</small>}
                    </span>
                    {other && <span className="chip">{t('agency.store.takenBy', { name: other })}</span>}
                  </label>
                </li>
              );
            })}
            {!shown.length && <li className="muted small">{t('common.noResults')}</li>}
          </ul>
          <small className="muted">{t('agency.nChosen', { count: sel.size })}</small>
        </div>
      )}
    </div>
  );
}

/** The products given to an agency, in words. */
function ProductsText({ l, products }: { l: AgencyLinkInfo; products: Product[] }) {
  const { t } = useTranslation();
  if (l.products === null) return <>{t('agency.allProducts')}</>;
  const names = products.filter((p) => l.products!.includes(p.id)).map((p) => p.name);
  return <>{names.length > 3 ? t('agency.nProducts', { count: names.length }) : names.join(', ') || t('agency.nProducts', { count: l.products.length })}</>;
}

/** « Ajouter une agence »: its code, then the tasks and products given; its prices are its own. */
function FindAgency({ products, links }: { products: Product[]; links: AgencyLinkInfo[] }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [found, setFound] = useState<Out<'partners.find'> | null>(null);
  const [tasks, setTasks] = useState<AgencyTask[]>(['confirmation']);
  const [chosen, setChosen] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ask = useAction('partners.request', { success: t('agency.requestSent'), onDone: () => (setFound(null), setCode('')) });
  const find = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setFound(null);
    setBusy(true);
    try {
      setFound(await rpc('partners.find', { code }));
    } catch (x: any) {
      setErr(x?.message ?? t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('agency.store.add')} className="agx-find-card">
      <Lead>{t('agency.store.addText')}</Lead>
      <form className="agx-find" onSubmit={find}>
        <input dir="ltr" className="agx-code-in" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="AG-7K2Q" aria-label={t('agency.agencyCode')} maxLength={10} />
        <button className="btn" disabled={busy || code.replace(/[^A-Za-z0-9]/g, '').length < 4}>
          <Icon name="search" /> {busy ? '…' : t('agency.find')}
        </button>
      </form>
      {err && <p className="form-err">{err}</p>}
      {found && (
        <div className="agx-found">
          <div className="agx-found-head">
            <span className="agx-where-ic agx-ic">
              <Icon name="headset" />
            </span>
            <b>{found.agency.name}</b>
            <span className="chip agx-st agx-st-ok">
              <Icon name="shield" /> {t('agency.verified')}
            </span>
          </div>
          {found.link ? (
            <p className="agx-note">{found.link.status === 'active' ? t('agency.store.alreadyActive') : t('agency.alreadyPending')}</p>
          ) : (
            <>
              <div className="agx-sub">
                <b>{t('agency.store.theirPrices')}</b>
                <Lead>{t('agency.store.theirPricesText')}</Lead>
                {found.agency.priced ? <PriceList p={found.agency.prices} /> : <p className="agx-note warn">{t('agency.store.noPriceYet')}</p>}
              </div>
              <Field label={t('agency.store.tasksGiven')}>
                <TaskPicker value={tasks} onChange={setTasks} />
              </Field>
              <Field label={t('agency.store.productsGiven')}>
                <ProductPicker products={products} value={chosen} onChange={setChosen} taken={takenBy(links, null, tasks)} />
              </Field>
              <div className="row agx-actions">
                <button type="button" className="btn" onClick={() => setFound(null)}>
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!tasks.length || (chosen !== null && !chosen.length) || !found.agency.priced || ask.isPending}
                  onClick={() => ask.mutate({ agencyId: found.agency.id, tasks, products: chosen })}
                >
                  <Icon name="send" /> {t('agency.sendRequest')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

/** What the store gives an agency: the tasks and products (when it accepts, or later). */
function WorkModal({ l, products, links, accept, onClose }: { l: AgencyLinkInfo; products: Product[]; links: AgencyLinkInfo[]; accept?: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [tasks, setTasks] = useState<AgencyTask[]>(l.tasks);
  const [chosen, setChosen] = useState<number[] | null>(l.products);
  const done = (r: { problems: string[] }) => {
    r.problems.forEach((p) => toast(p, 'bad', 7000));
    onClose();
  };
  const answer = useAction('partners.answer', { success: t('agency.answered'), onDone: done });
  const work = useAction('partners.setWork', { success: t('agency.store.workSaved'), onDone: done });
  const busy = answer.isPending || work.isPending;
  const ok = tasks.length > 0 && (chosen === null || chosen.length > 0);
  return (
    <Modal
      wide
      title={accept ? t('agency.store.acceptTitle', { name: l.agency.name }) : t('agency.store.workTitle', { name: l.agency.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!ok || busy}
            onClick={() => (accept ? answer.mutate({ id: l.id, accept: true, tasks, products: chosen }) : work.mutate({ id: l.id, tasks, products: chosen }))}
          >
            {accept ? t('agency.accept') : t('common.save')}
          </button>
        </>
      }
    >
      {accept && (
        <div className="agx-sub">
          <b>{t('agency.store.theirPrices')}</b>
          <PriceList p={l.prices} />
        </div>
      )}
      <Field label={t('agency.store.tasksGiven')}>
        <TaskPicker value={tasks} onChange={setTasks} />
      </Field>
      <Field label={t('agency.store.productsGiven')}>
        <ProductPicker products={products} value={chosen} onChange={setChosen} taken={takenBy(links, l.id, tasks)} />
      </Field>
      {!accept && <p className="small muted">{t('agency.store.workRule')}</p>}
    </Modal>
  );
}

function ReceivedFromAgency({ l, products, links }: { l: AgencyLinkInfo; products: Product[]; links: AgencyLinkInfo[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const answer = useAction('partners.answer', { success: t('agency.answered') });
  return (
    <article className="agx-link">
      <header>
        <b>{l.agency.name}</b>
        <span className="muted ltr small">{l.agency.code}</span>
        <LinkStatus l={l} side="store" />
      </header>
      <p className="small">{t('agency.store.agencyAsks')}</p>
      <TaskChips tasks={l.tasks} />
      <div className="agx-sub">
        <small className="muted">{t('agency.store.theirPrices')}</small>
        <PriceList p={l.prices} compact />
      </div>
      <div className="row agx-actions">
        <button type="button" className="btn" disabled={answer.isPending} onClick={() => answer.mutate({ id: l.id, accept: false })}>
          {t('agency.refuse')}
        </button>
        <button type="button" className="btn primary" onClick={() => setOpen(true)}>
          <Icon name="check" /> {t('agency.accept')}
        </button>
      </div>
      {open && <WorkModal l={l} products={products} links={links} accept onClose={() => setOpen(false)} />}
    </article>
  );
}

function SentToAgency({ l, products }: { l: AgencyLinkInfo; products: Product[] }) {
  const { t } = useTranslation();
  const cancel = useAction('partners.cancel', { success: t('agency.cancelled') });
  return (
    <article className="agx-link">
      <header>
        <b>{l.agency.name}</b>
        <LinkStatus l={l} side="store" />
      </header>
      <TaskChips tasks={l.tasks} />
      <p className="small muted">
        <ProductsText l={l} products={products} />
      </p>
      <div className="row agx-actions">
        <button type="button" className="btn" disabled={cancel.isPending} onClick={() => cancel.mutate({ id: l.id })}>
          {t('agency.cancelRequest')}
        </button>
      </div>
    </article>
  );
}

function AgencyCard({ l, c, products }: { l: AgencyLinkInfo; c?: AgencyCounts & { total: number }; products: Product[] }) {
  const { t } = useTranslation();
  return (
    <a className="agx-link agx-link-go" href={`#/agences/${l.id}`}>
      <header>
        <b>{l.agency.name}</b>
        <LinkStatus l={l} side="store" />
        {l.pricesNew && <span className="chip agx-st agx-st-wait">{t('agency.store.newPrices')}</span>}
      </header>
      <TaskChips tasks={l.tasks} />
      <p className="small muted">
        <ProductsText l={l} products={products} /> · {l.agents.length ? t('agency.nAgents', { count: l.agents.length }) : t('agency.store.noAgentYet')}
      </p>
      <CountsLine c={c ?? NO_COUNTS} total={c?.total ?? 0} />
      <span className="agx-go">
        {t('agency.seeDetail')} <Icon name="chevr" />
      </span>
    </a>
  );
}

function AgencyDetail({ id }: { id: number }) {
  const { t, i18n } = useTranslation();
  const max = monthNow();
  const [month, setMonth] = useState(max);
  const q = useRpc('partners.link', { id, month });
  const home = useRpc('partners.home', {});
  const [modal, setModal] = useState<'work' | 'end' | null>(null);
  const yes = useAction('partners.acceptPrices', { success: t('agency.store.pricesAccepted') });
  const paid = useAction('partners.billPaid', { success: t('agency.store.paidSaved') });
  if (q.isLoading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const l = d.link;
  const products = home.data?.products ?? [];
  const live = l.status === 'active';
  return (
    <div className="agx-page">
      <a className="agx-back" href="#/agences">
        <Icon name="chevl" /> {t('agency.store.back')}
      </a>
      <section className="card agx-head">
        <div>
          <h1>{l.agency.name}</h1>
          <div className="row">
            <span className="muted ltr">{l.agency.code}</span>
            <LinkStatus l={l} side="store" />
          </div>
        </div>
      </section>
      {l.pricesNew && live && (
        <section className="card agx-banner" role="status">
          <Icon name="tag" />
          <div>
            <b>{t('agency.store.newPricesTitle', { name: l.agency.name })}</b>
            <p>{t('agency.store.newPricesText')}</p>
            <div className="agx-compare">
              <div>
                <small className="muted">{t('agency.store.nowPrices')}</small>
                <PriceList p={l.prices} compact />
              </div>
              <div>
                <small className="muted">{t('agency.store.nextPrices')}</small>
                <PriceList p={l.pricesNew} compact />
              </div>
            </div>
            <div className="row agx-actions">
              <button type="button" className="btn" onClick={() => setModal('end')}>
                {t('agency.end')}
              </button>
              <button type="button" className="btn primary" disabled={yes.isPending} onClick={() => yes.mutate({ id })}>
                <Icon name="check" /> {t('agency.store.acceptPrices')}
              </button>
            </div>
          </div>
        </section>
      )}
      <div className="agx-grid">
        <Card
          title={t('agency.store.given')}
          help={t('agency.store.givenHelp')}
          actions={
            live && (
              <button type="button" className="btn small" onClick={() => setModal('work')}>
                <Icon name="pencil" /> {t('common.edit')}
              </button>
            )
          }
        >
          <TaskChips tasks={l.tasks} />
          <p className="small">
            <ProductsText l={l} products={products} />
          </p>
        </Card>
        <Card title={t('agency.pricesTitle')} help={t('agency.store.pricesHelp')}>
          <PriceList p={l.prices} />
        </Card>
        <Card title={t('agency.store.theirAgents')} help={t('agency.store.theirAgentsHelp')}>
          {l.agents.length ? (
            <ul className="agx-people">
              {l.agents.map((a) => (
                <li key={a.profileId}>
                  <Icon name="user" /> {a.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{t('agency.store.noAgentYet')}</p>
          )}
        </Card>
      </div>
      <Card title={t('agency.monthTitle')} actions={<MonthPicker value={month} max={max} onChange={setMonth} />}>
        <Lead>{t('agency.store.monthText', { m: monthLabel(month, i18n.language) })}</Lead>
        <CountsRow c={d.counts} total={d.bill.total} />
        <BillLines lines={d.bill.lines} total={d.bill.total} />
      </Card>
      <Card title={t('agency.payments')} help={t('agency.store.paymentsHelp')}>
        <BillsList
          bills={d.bills}
          action={(b) =>
            b.status === 'requested' && (
              <button type="button" className="btn small primary" disabled={paid.isPending} onClick={() => paid.mutate({ billId: b.id })}>
                <Icon name="check" /> {t('agency.store.markPaid')}
              </button>
            )
          }
        />
      </Card>
      {live && (
        <section className="card agx-danger">
          <div>
            <b>{t('agency.endTitle')}</b>
            <p className="small muted">{t('agency.endTextStore')}</p>
          </div>
          <button type="button" className="btn danger" onClick={() => setModal('end')}>
            {t('agency.end')}
          </button>
        </section>
      )}
      {modal === 'work' && <WorkModal l={l} products={products} links={home.data?.links ?? []} onClose={() => setModal(null)} />}
      {modal === 'end' && <EndModal name={l.agency.name} proc="partners.end" id={l.id} back="#/agences" onClose={() => setModal(null)} text={t('agency.endTextStore')} />}
    </div>
  );
}
