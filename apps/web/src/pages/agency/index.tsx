// A confirmation agency's space, like a store's: its Accueil (what waits now, this month), its sellers (the stores it
// works for: requests both ways, who works for each, prices, numbers), its Facturation (each seller's month, the
// payment asked, paid, received), its Utilisateurs (the store's page, with each person's sellers and products) and its
// Réglages (its code, its usual prices). The confirmation and suivi work is in work.tsx.
// A marketer's space uses the same Vendeurs, Facturation, Utilisateurs and Réglages (its own words, prices and
// numbers); its Accueil and its ads are in ../marketer.
import { AgencyCounts, AgencyLinkInfo, AgencyPrices, AgencyTask, confirmRate, deliveryRate, hasPrice, NO_AGENCY_PRICES, NO_COUNTS } from '@pilotix/shared';
import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out, rpc } from '../../lib/backend';
import { da, dateOnly, n, pct } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { SellerScope, useSeller } from '../../lib/seller';
import { useSellers } from '../../lib/sellers';
import { useSession } from '../../lib/session';
import { CopyCode } from '../../ui/CopyCode';
import { Card, Empty, ErrorBox, Field, Icon, Kpis, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { UsersPage } from '../admin/Users';
import { KpiBox } from '../dashboard/util';
import type { PageProps } from '../registry';
import { BillLines, billOf, BillsList, CountsLine, CountsRow, EndModal, Lead, LinkStatus, monthLabel, MonthPicker, PriceEditor, PriceList, TaskChips, TaskPicker, usePartnerKind, useTp } from './parts';
import './agency.css';

type Home = Out<'agency.home'>;

/** this month (Algeria) */
const monthNow = () => {
  const d = new Date(Date.now() + 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const sumCounts = (xs: AgencyCounts[]) => xs.reduce((a, c) => Object.fromEntries(Object.keys(NO_COUNTS).map((k) => [k, (a as any)[k] + ((c as any)[k] ?? 0)])) as unknown as AgencyCounts, { ...NO_COUNTS });
export { sumCounts };

export function useHome() {
  return useRpc('agency.home', {}, { refetchInterval: 60_000 });
}

// ---------------------------------------------------------------- Accueil
export function AgencyHome(_: PageProps) {
  const seller = useSeller();
  return (
    <SellerScope seller={seller}>
      <HomeBody />
    </SellerScope>
  );
}

function HomeBody() {
  const { t, i18n } = useTranslation();
  const { session } = useSession();
  const seller = useSeller();
  const s = session!;
  const roles = s.roles;
  const lead = s.isAdmin || roles.includes('agent_manager');
  // the work of the seller chosen (all of them: any seller's), as far as the person does it
  const work = useSellers();
  const conf = (lead || roles.includes('confirmation')) && work.tasks.has('confirmation');
  const follow = (lead || roles.includes('suivi')) && work.tasks.has('suivi');
  const sellers = { data: work.loaded ? work.list : undefined };
  const cc = useRpc('confirmation.counts', {}, { refetchInterval: 60_000, enabled: conf });
  const sc = useRpc('suivi.counts', {}, { refetchInterval: 60_000, enabled: follow });
  const one = work.one;
  return (
    <div className="tb hm agx-home">
      <header className="tb-head hm-head">
        <div className="tb-ht">
          <h2>{t('home.hello', { name: s.profile.name })}</h2>
          <p className="tb-cap">
            {one ? one.name : t('agency.pick.all', { count: sellers.data?.length ?? 0 })} · {monthLabel(monthNow(), i18n.language)}
          </p>
        </div>
      </header>
      {s.isAdmin && <ChiefTop />}
      <section className="card hm-now">
        <div className="card-head">
          <h2>{t('home.now')}</h2>
        </div>
        {sellers.data && !sellers.data.length ? (
          <Empty>{s.isAdmin ? t('agency.home.noSeller') : t('agency.home.noWhere')}</Empty>
        ) : (
          <Kpis>
            {conf && <KpiBox icon="phone" label={t('agency.home.toCall')} value={n((cc.data?.nouvelles ?? 0) + (cc.data?.attente ?? 0))} sub={t('agency.home.toCallSub', { n: cc.data?.nouvelles ?? 0 })} tone={cc.data?.nouvelles ? 'warn' : undefined} href="#/confirmation/nouvelles" />}
            {conf && <KpiBox icon="timer" label={t('confirmation.sub.attente')} value={n(cc.data?.attente ?? 0)} sub={t('agency.home.waitingSub')} href="#/confirmation/attente" />}
            {conf && <KpiBox icon="check" label={t('confirmation.sub.confirmees')} value={n(cc.data?.confirmees ?? 0)} sub={t('agency.home.confirmedSub')} tone="ok" href="#/confirmation/confirmees" />}
            {follow && <KpiBox icon="alert" label={t('suivi.tabs.alertes')} value={n(sc.data?.alertes ?? 0)} sub={t('agency.home.alertsSub')} tone={sc.data?.alertes ? 'bad' : undefined} zero={!sc.data?.alertes} href="#/suivi/alertes" />}
          </Kpis>
        )}
      </section>
      {s.isAdmin && <ChiefMonth />}
    </div>
  );
}

/** The chief: Pilotix's check (and what is left to do before it), the agency's code, the sellers who asked. */
function ChiefTop() {
  const { t } = useTranslation();
  const q = useHome();
  const team = useRpc('agency.team', {});
  if (!q.data) return null;
  const h = q.data;
  const priced = !!h.agency.prices && hasPrice(h.agency.prices);
  const agents = (team.data ?? []).filter((p) => p.roles.some((r) => r === 'confirmation' || r === 'suivi')).length;
  const waiting = h.links.filter((l) => l.status === 'pending' && l.requestedBy === 'store');
  return (
    <>
      <div className="card agx-hero"><div className="agx-hero-t"><b>{h.agency.name}</b><span className="agx-code">{h.agency.code ? <CopyCode code={h.agency.code} /> : '—'}</span></div></div>
      {!h.agency.verified && (
        <section className="card agx-banner" role="status">
          <Icon name="hourglass" />
          <div>
            <b>{t('agency.home.waitTitle')}</b>
            <p>{t('agency.home.waitText')}</p>
            <ol className="agx-steps">
              <li className="done">
                <Icon name="checkcircle" /> {t('agency.home.step1')}
              </li>
              <li className={priced ? 'done' : ''}>
                <Icon name={priced ? 'checkcircle' : 'tag'} /> <a href="#/facturation">{t('agency.home.step2')}</a>
              </li>
              <li className={agents > 0 ? 'done' : ''}>
                <Icon name={agents > 0 ? 'checkcircle' : 'users'} /> <a href="#/utilisateurs">{t('agency.home.step3')}</a>
              </li>
              <li>
                <Icon name="shield" /> {t('agency.home.step4')}
              </li>
            </ol>
          </div>
        </section>
      )}
      {waiting.length > 0 && (
        <a className="card agx-alert" href="#/vendeurs">
          <Icon name="inbox" />
          <span>{t('agency.home.waiting', { count: waiting.length })}</span>
          <Icon name="chevr" />
        </a>
      )}
    </>
  );
}

/** The chief: this month, every seller (or the one chosen), and what it makes. */
function ChiefMonth() {
  const { t, i18n } = useTranslation();
  const seller = useSeller();
  const q = useHome();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const h = q.data!;
  const rows = h.links
    .filter((l) => l.status === 'active' && (seller === 'all' || l.store.id === seller))
    .map((l) => ({ l, c: h.counts[String(l.id)] ?? { ...NO_COUNTS, total: 0 } }));
  const c = sumCounts(rows.map((r) => r.c));
  const total = rows.reduce((s, r) => s + r.c.total, 0);
  return (
    <section className="card hm-per">
      <div className="card-head">
        <h2>{t('agency.home.month', { m: monthLabel(h.month, i18n.language) })}</h2>
        <a className="btn small" href="#/facturation">
          <Icon name="receipt" /> {t('agency.nav.facturation')}
        </a>
      </div>
      <Kpis>
        <KpiBox icon="list" label={t('agency.c.received')} value={n(c.received)} sub={t('agency.home.receivedSub')} />
        <KpiBox icon="check" label={t('agency.c.confirmed')} value={n(c.confirmed)} sub={t('home.rate', { v: pct(confirmRate(c) === null ? null : confirmRate(c)! / 100) })} rate={confirmRate(c) === null ? null : confirmRate(c)! / 100} tone="ok" />
        <KpiBox icon="truck" label={t('agency.c.delivered')} value={n(c.delivered)} sub={t('home.deliveryRate', { v: pct(deliveryRate(c) === null ? null : deliveryRate(c)! / 100) })} rate={deliveryRate(c) === null ? null : deliveryRate(c)! / 100} tone="ok" />
        <KpiBox icon="coins" label={t('agency.c.amount')} value={da(total)} sub={t('agency.home.amountSub')} href="#/facturation" />
      </Kpis>
      {seller === 'all' &&
        (rows.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('agency.seller')}</th>
                  <th className="num">{t('agency.c.received')}</th>
                  <th className="num">{t('agency.c.confirmed')}</th>
                  <th className="num">{t('agency.c.delivered')}</th>
                  <th className="num">{t('agency.c.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ l, c }) => (
                  <tr key={l.id}>
                    <td data-l={t('agency.seller')}>
                      <a href={`#/vendeurs/${l.id}`}>
                        <b>{l.store.name}</b>
                      </a>
                    </td>
                    <td className="num ltr" data-l={t('agency.c.received')}>{n(c.received)}</td>
                    <td className="num ltr" data-l={t('agency.c.confirmed')}>{n(c.confirmed)}</td>
                    <td className="num ltr" data-l={t('agency.c.delivered')}>{n(c.delivered)}</td>
                    <td className="num ltr" data-l={t('agency.c.amount')}>{da(c.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{t('agency.home.noSeller')}</Empty>
        ))}
    </section>
  );
}

// ---------------------------------------------------------------- Vendeurs
export function Vendeurs({ sub }: PageProps) {
  const id = sub && /^\d+$/.test(sub) ? Number(sub) : null;
  return id ? <SellerDetail id={id} /> : <SellerList />;
}

function SellerList() {
  const { t } = useTranslation();
  const tp = useTp();
  const q = useHome();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const h = q.data!;
  const received = h.links.filter((l) => l.status === 'pending' && l.requestedBy === 'store');
  const sent = h.links.filter((l) => l.status === 'pending' && l.requestedBy === 'agency');
  const active = h.links.filter((l) => l.status === 'active');
  const past = h.links.filter((l) => l.status !== 'pending' && l.status !== 'active');
  return (
    <div className="agx-page">
      <FindStore h={h} />
      {received.length > 0 && (
        <Card title={t('agency.received')} badge={<span className="nav-count nc-a">{received.length}</span>}>
          <div className="agx-links">
            {received.map((l) => (
              <ReceivedFromStore key={l.id} l={l} />
            ))}
          </div>
        </Card>
      )}
      <Card title={tp('sellers')} help={tp('sellersHelp')}>
        {active.length ? (
          <div className="agx-links">
            {active.map((l) => (
              <SellerCard key={l.id} l={l} c={h.counts[String(l.id)]} />
            ))}
          </div>
        ) : (
          <Empty>{tp('home.noSeller')}</Empty>
        )}
      </Card>
      {sent.length > 0 && (
        <Card title={t('agency.sent')}>
          <div className="agx-links">
            {sent.map((l) => (
              <SentToStore key={l.id} l={l} />
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
                <b>{l.store.name}</b> <LinkStatus l={l} side="agency" />
                {l.status === 'ended' && <a href={`#/vendeurs/${l.id}`}>{t('agency.seeDetail')}</a>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** « Ajouter un vendeur »: use the rates saved under Facturation, never ask for rates in invitations. */
function FindStore({ h }: { h: Home }) {
  const { t } = useTranslation();
  const tp = useTp();
  const kind = usePartnerKind();
  const [code, setCode] = useState('');
  const [found, setFound] = useState<Out<'agency.find'> | null>(null);
  const [tasks, setTasks] = useState<AgencyTask[]>(kind === 'marketer' ? ['marketing'] : ['confirmation']);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ask = useAction('agency.request', { success: t('agency.requestSent'), onDone: () => (setFound(null), setCode('')) });
  const find = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setFound(null);
    setBusy(true);
    try {
      setFound(await rpc('agency.find', { code }));
    } catch (x: any) {
      setErr(x?.message ?? t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('agency.addSeller')} className="agx-find-card">
      <Lead>{tp('addSellerText')}</Lead>
      {!h.agency.verified && <p className="agx-note warn">{tp('notVerifiedYet')}</p>}
      <form className="agx-find" onSubmit={find}>
        <input dir="ltr" className="agx-code-in" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="K7Q-29X" aria-label={t('agency.storeCode')} maxLength={12} />
        <button className="btn" disabled={busy || code.replace(/[^A-Za-z0-9]/g, '').length < 6}>
          <Icon name="search" /> {busy ? '…' : t('agency.find')}
        </button>
      </form>
      {err && <p className="form-err">{err}</p>}
      {found && (
        <div className="agx-found">
          <div className="agx-found-head">
            <span className="agx-where-ic">
              <Icon name="store" />
            </span>
            <b>{found.store.name}</b>
            <span className="muted ltr">{found.store.code}</span>
          </div>
          {found.link ? (
            <p className="agx-note">{found.link.status === 'active' ? tp('alreadyActive') : t('agency.alreadyPending')}</p>
          ) : (
            <>
              {kind === 'agency' && (
                <Field label={t('agency.tasks')}>
                  <TaskPicker value={tasks} onChange={setTasks} />
                </Field>
              )}
              {!hasPrice(h.agency.prices ?? NO_AGENCY_PRICES) && <p className="agx-note warn">{t('agency.store.noPriceYet')} <a href="#/facturation">{t('agency.mnav.facturation')}</a></p>}
              <div className="row agx-actions">
                <button type="button" className="btn" onClick={() => setFound(null)}>
                  {t('common.cancel')}
                </button>
                <button type="button" className="btn primary" disabled={!tasks.length || !hasPrice(h.agency.prices ?? NO_AGENCY_PRICES) || ask.isPending || !h.agency.verified} onClick={() => ask.mutate({ storeId: found.store.id, tasks })}>
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

function ReceivedFromStore({ l }: { l: AgencyLinkInfo }) {
  const { t } = useTranslation();
  const tp = useTp(l.kind);
  const answer = useAction('agency.answer', { success: t('agency.answered') });
  return (
    <article className="agx-link">
      <header>
        <b>{l.store.name}</b>
        <LinkStatus l={l} side="agency" />
      </header>
      <p className="small">{tp('storeAsks')}</p>
      {l.kind === 'agency' && <TaskChips tasks={l.tasks} />}
      <p className="small muted">{l.products === null ? t('agency.allProducts') : t('agency.nProducts', { count: l.products.length })}</p>
      <div className="agx-sub">
        <small className="muted">{t('agency.yourPrices')}</small>
        <PriceList p={l.prices} compact />
      </div>
      <div className="row agx-actions">
        <button type="button" className="btn" disabled={answer.isPending} onClick={() => answer.mutate({ id: l.id, accept: false })}>
          {t('agency.refuse')}
        </button>
        <button type="button" className="btn primary" disabled={answer.isPending} onClick={() => answer.mutate({ id: l.id, accept: true })}>
          <Icon name="check" /> {t('agency.accept')}
        </button>
      </div>
    </article>
  );
}

function SentToStore({ l }: { l: AgencyLinkInfo }) {
  const { t } = useTranslation();
  const cancel = useAction('agency.cancel', { success: t('agency.cancelled') });
  return (
    <article className="agx-link">
      <header>
        <b>{l.store.name}</b>
        <LinkStatus l={l} side="agency" />
      </header>
      {l.kind === 'agency' && <TaskChips tasks={l.tasks} />}
      <PriceList p={l.prices} compact />
      <div className="row agx-actions">
        <button type="button" className="btn" disabled={cancel.isPending} onClick={() => cancel.mutate({ id: l.id })}>
          {t('agency.cancelRequest')}
        </button>
      </div>
    </article>
  );
}

function SellerCard({ l, c }: { l: AgencyLinkInfo; c?: AgencyCounts & { total: number } }) {
  const { t } = useTranslation();
  const tp = useTp(l.kind);
  return (
    <a className="agx-link agx-link-go" href={`#/vendeurs/${l.id}`}>
      <header>
        <b>{l.store.name}</b>
        <LinkStatus l={l} side="agency" />
        {l.pricesNew && <span className="chip agx-st agx-st-wait">{t('agency.newPricesWaiting')}</span>}
      </header>
      {l.kind === 'agency' && <TaskChips tasks={l.tasks} />}
      <p className="small muted">
        {l.products === null ? t('agency.allProducts') : t('agency.nProducts', { count: l.products.length })} · {l.agents.length ? tp('nAgents', { count: l.agents.length }) : <span className="agx-bad">{tp('noAgent')}</span>}
      </p>
      <CountsLine c={c ?? NO_COUNTS} total={c?.total ?? 0} />
      <span className="agx-go">
        {t('agency.seeDetail')} <Icon name="chevr" />
      </span>
    </a>
  );
}

/** One seller: its agents, the prices, a month's numbers and bill, the payment requests, the end. */
function SellerDetail({ id }: { id: number }) {
  const { t, i18n } = useTranslation();
  const tp = useTp();
  const max = monthNow();
  const [month, setMonth] = useState(max);
  const q = useRpc('agency.link', { id, month });
  const [modal, setModal] = useState<'agents' | 'prices' | 'end' | null>(null);
  const ask = useAction('agency.billRequest', { success: t('agency.billAsked') });
  const got = useAction('agency.billReceived', { success: t('agency.billGot') });
  if (q.isLoading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const l = d.link;
  const billed = d.bills.find((b) => b.month === month);
  const live = l.status === 'active';
  return (
    <div className="agx-page">
      <a className="agx-back" href="#/vendeurs">
        <Icon name="chevl" /> {t('agency.backSellers')}
      </a>
      <section className="card agx-head">
        <div>
          <h1>{l.store.name}</h1>
          <div className="row">
            <LinkStatus l={l} side="agency" />
            {l.kind === 'agency' && <TaskChips tasks={l.tasks} />}
          </div>
          <p className="small muted">{l.products === null ? t('agency.allProductsLong') : t('agency.nProducts', { count: l.products.length })}</p>
        </div>
      </section>
      <div className="agx-grid">
        <Card
          title={tp('agents')}
          help={tp('agentsHelp')}
          actions={
            (live || l.status === 'pending') && (
              <button type="button" className="btn small" onClick={() => setModal('agents')}>
                <Icon name="users" /> {t('agency.chooseAgents')}
              </button>
            )
          }
        >
          {l.agents.length ? (
            <ul className="agx-people">
              {l.agents.map((a) => (
                <li key={a.profileId}>
                  <Icon name="user" /> {a.name}
                  <small className="muted">{a.products === null ? t('agency.allProducts') : t('agency.nProducts', { count: a.products.length })}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="agx-note warn">{tp('noAgentText')}</p>
          )}
        </Card>
        <Card
          title={t('agency.pricesTitle')}
          help={t('agency.pricesHelpAgency')}
          actions={
            (live || (l.status === 'pending' && l.requestedBy === 'agency')) && (
              <button type="button" className="btn small" onClick={() => setModal('prices')}>
                <Icon name="pencil" /> {t('agency.changePrices')}
              </button>
            )
          }
        >
          <PriceList p={l.prices} />
          {l.pricesNew && (
            <div className="agx-note warn">
              <b>{t('agency.newPricesSent')}</b>
              <PriceList p={l.pricesNew} compact />
            </div>
          )}
        </Card>
      </div>
      <Card title={t('agency.monthTitle')} actions={<MonthPicker value={month} max={max} onChange={setMonth} />}>
        {l.kind === 'marketer' && <Lead>{tp('monthLead')}</Lead>}
        <CountsRow c={d.counts} total={d.bill.total} kind={l.kind} />
        <BillLines lines={d.bill.lines} total={d.bill.total} kind={l.kind} />
        <div className="row agx-actions">
          {billed && billed.status !== 'requested' ? (
            <span className="chip agx-st agx-st-ok">{t(`agency.bill.${billed.status}`)}</span>
          ) : (
            <button type="button" className="btn primary" disabled={d.bill.total <= 0 || ask.isPending || !l.startedAt} onClick={() => ask.mutate({ id, month })}>
              <Icon name="receipt" /> {billed ? t('agency.billAskAgain') : t('agency.billAsk', { m: monthLabel(month, i18n.language) })}
            </button>
          )}
        </div>
      </Card>
      <Card title={t('agency.payments')} help={t('agency.paymentsHelpAgency')}>
        <BillsList
          bills={d.bills}
          action={(b) =>
            b.status !== 'received' && (
              <button type="button" className="btn small" disabled={got.isPending} onClick={() => got.mutate({ billId: b.id })}>
                <Icon name="check" /> {t('agency.markReceived')}
              </button>
            )
          }
        />
      </Card>
      {live && (
        <section className="card agx-danger">
          <div>
            <b>{t('agency.endTitle')}</b>
            <p className="small muted">{tp('endTextAgency')}</p>
          </div>
          <button type="button" className="btn danger" onClick={() => setModal('end')}>
            {t('agency.end')}
          </button>
        </section>
      )}
      {modal === 'agents' && <AgentsModal l={l} onClose={() => setModal(null)} />}
      {modal === 'prices' && <PricesModal l={l} onClose={() => setModal(null)} />}
      {modal === 'end' && <EndModal name={l.store.name} proc="agency.end" id={l.id} back="#/vendeurs" onClose={() => setModal(null)} text={tp('endTextAgency')} />}
    </div>
  );
}

/** Does this person work for this seller? (no list: every seller) */
const worksFor = (p: { sellers: { store: number }[] | null }, store: number) => p.sellers === null || p.sellers.some((w) => w.store === store);

function AgentsModal({ l, onClose }: { l: AgencyLinkInfo; onClose: () => void }) {
  const { t } = useTranslation();
  const tp = useTp(l.kind);
  const team = useRpc('agency.team', {});
  const [sel, setSel] = useState<Set<number> | null>(null);
  const save = useAction('agency.setAgents', {
    onDone: (r) => {
      if (r.problems.length) r.problems.forEach((p) => toast(p, 'bad', 7000));
      else toast(tp('agentsSaved'), 'ok');
      onClose();
    },
  });
  // who can work for this store: their role fits one of its tasks (the chief and team leads: every task); a
  // marketer's people: the marketer role
  const people = (team.data ?? []).filter((p) => p.roles.includes('admin') || p.roles.includes('agent_manager') || (l.kind === 'marketer' ? p.roles.includes('marketer') : l.tasks.some((k) => p.roles.includes(k))));
  useEffect(() => {
    if (team.data && sel === null) setSel(new Set(team.data.filter((p) => worksFor(p, l.store.id)).map((p) => p.id)));
  }, [team.data, sel, l.id]);
  const s = sel ?? new Set<number>();
  return (
    <Modal
      title={t('agency.chooseAgentsFor', { store: l.store.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={save.isPending || sel === null} onClick={() => save.mutate({ id: l.id, people: [...s] })}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <Lead>{tp('chooseAgentsText')}</Lead>
      {team.isLoading ? (
        <Loading />
      ) : people.length ? (
        <ul className="agx-checks">
          {people.map((p) => (
            <li key={p.id}>
              <label>
                <input type="checkbox" checked={s.has(p.id)} onChange={() => setSel(new Set(s.has(p.id) ? [...s].filter((x) => x !== p.id) : [...s, p.id]))} />
                <span>
                  <b>{p.name}</b>
                  <small className="muted">{p.roles.map((r) => tp(`team.r.${r}`, { defaultValue: t(`roles.${r}`) })).join(' · ')}</small>
                </span>
                {p.sellers === null ? <span className="chip">{t('agency.users.allSellers')}</span> : p.sellers.length > 0 && <span className="chip">{t('agency.worksFor', { count: p.sellers.length })}</span>}
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>
          {tp('noTeamYet')} <a href="#/utilisateurs">{t('agency.nav.utilisateurs')}</a>
        </Empty>
      )}
    </Modal>
  );
}

function PricesModal({ l, onClose }: { l: AgencyLinkInfo; onClose: () => void }) {
  const { t } = useTranslation();
  const [p, setP] = useState<AgencyPrices>(l.pricesNew ?? l.prices);
  const save = useAction('agency.linkPrices', { success: l.status === 'active' ? t('agency.pricesProposed') : t('agency.pricesSaved'), onDone: onClose });
  return (
    <Modal
      wide
      title={t('agency.pricesFor', { store: l.store.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!hasPrice(p) || save.isPending} onClick={() => save.mutate({ id: l.id, prices: p })}>
            {l.status === 'active' ? t('agency.proposePrices') : t('common.save')}
          </button>
        </>
      }
    >
      {l.status === 'active' && <p className="agx-note">{t('agency.pricesChangeRule')}</p>}
      <PriceEditor value={p} onChange={setP} kind={l.kind} />
    </Modal>
  );
}

/** Agency-wide tariff editor: the only place to set the default rate used for new invitations. */
function AgencyRates() {
  const { t } = useTranslation();
  const q = useHome();
  const [p, setP] = useState<AgencyPrices | null>(null);
  const save = useAction('agency.prices', { success: t('agency.pricesSaved') });
  useEffect(() => { if (q.data && p === null) setP(q.data.agency.prices ?? NO_AGENCY_PRICES); }, [q.data, p]);
  if (!q.data || !p) return null;
  return <Card title={t('agency.tarifs.title')} help={t('agency.tarifs.help')}>
    <Lead>{t('agency.tarifs.text')}</Lead>
    <PriceEditor value={p} onChange={setP} />
    <div className="row agx-actions">
      <button type="button" className="btn primary" disabled={save.isPending || !hasPrice(p)} onClick={() => save.mutate({ prices: p })}>{t('common.save')}</button>
    </div>
  </Card>;
}

// ---------------------------------------------------------------- Facturation
/** Each seller's month: its numbers, what they make, and the payment: asked → paid (the seller) → received (us). */
export function Facturation(_: PageProps) {
  const { t, i18n } = useTranslation();
  const tp = useTp();
  const mk = usePartnerKind() === 'marketer';
  const seller = useSeller();
  const max = monthNow();
  const [month, setMonth] = useState(max);
  const q = useRpc('agency.billing', { month });
  const ask = useAction('agency.billRequest', { success: t('agency.billAsked') });
  const got = useAction('agency.billReceived', { success: t('agency.billGot') });
  const rows = (q.data?.rows ?? []).filter((r) => seller === 'all' || r.link.store.id === seller);
  const sum = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((s, r) => s + (r.request?.amount ?? r.bill.total), 0);
  const total = rows.reduce((s, r) => s + r.bill.total, 0);
  return (
    <div className="agx-page">
      {!mk && <AgencyRates />}
      <Card title={t('agency.fact.title', { m: monthLabel(month, i18n.language) })} help={tp('fact.help')} actions={<MonthPicker value={month} max={max} onChange={setMonth} />}>
        <Kpis>
          <KpiBox icon="coins" label={t('agency.fact.total')} value={da(total)} sub={t('agency.fact.totalSub', { count: rows.length })} />
          <KpiBox icon="send" label={t('agency.fact.asked')} value={da(sum((r) => r.request?.status === 'requested'))} sub={t('agency.fact.askedSub')} tone={sum((r) => r.request?.status === 'requested') ? 'warn' : undefined} />
          <KpiBox icon="wallet" label={t('agency.fact.paid')} value={da(sum((r) => r.request?.status === 'paid'))} sub={t('agency.fact.paidSub')} tone={sum((r) => r.request?.status === 'paid') ? 'info' : undefined} />
          <KpiBox icon="checkcircle" label={t('agency.fact.received')} value={da(sum((r) => r.request?.status === 'received'))} sub={t('agency.fact.receivedSub')} tone="ok" />
        </Kpis>
      </Card>
      <section className="card">
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !rows.length ? (
          <Empty>{t('agency.fact.none')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl agx-fact">
              <thead>
                <tr>
                  <th>{t('agency.seller')}</th>
                  {mk ? (
                    <>
                      <th className="num">{t('agency.c.adsets')}</th>
                      <th className="num">{t('agency.c.spend')}</th>
                      <th className="num">{t('agency.c.delivered')}</th>
                      <th className="num">{t('agency.c.net')}</th>
                      <th className="num">{t('agency.c.successes')}</th>
                    </>
                  ) : (
                    <>
                      <th className="num">{t('agency.c.confirmed')}</th>
                      <th className="num">{t('agency.c.delivered')}</th>
                      <th className="num">{t('agency.c.upsells')}</th>
                    </>
                  )}
                  <th className="num">{t('agency.c.amount')}</th>
                  <th>{t('agency.fact.state')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ link: l, counts: c, bill, request: b }) => (
                  <tr key={l.id}>
                    <td data-l={t('agency.seller')}>
                      <a href={`#/vendeurs/${l.id}`}>
                        <b>{l.store.name}</b>
                      </a>
                      {l.status !== 'active' && <small className="muted">{t(`agency.st.${l.status}`)}</small>}
                    </td>
                    {mk ? (
                      <>
                        <td className="num ltr" data-l={t('agency.c.adsets')}>{n(c.adsets)}</td>
                        <td className="num ltr" data-l={t('agency.c.spend')}>{da(c.spend)}</td>
                        <td className="num ltr" data-l={t('agency.c.delivered')}>{n(c.delivered)}</td>
                        <td className={`num ltr ${c.net < 0 ? 'agx-bad' : ''}`} data-l={t('agency.c.net')}>{da(c.net)}</td>
                        <td className="num ltr" data-l={t('agency.c.successes')}>{n(c.successes)}</td>
                      </>
                    ) : (
                      <>
                        <td className="num ltr" data-l={t('agency.c.confirmed')}>{n(c.confirmed)}</td>
                        <td className="num ltr" data-l={t('agency.c.delivered')}>{n(c.delivered)}</td>
                        <td className="num ltr" data-l={t('agency.c.upsells')}>{n(c.upsells)}</td>
                      </>
                    )}
                    <td className="num" data-l={t('agency.c.amount')}>
                      <b className="ltr">{da(b && b.status !== 'requested' ? b.amount : bill.total)}</b>
                    </td>
                    <td data-l={t('agency.fact.state')}>
                      {!b ? (
                        <span className="badge t-off">{t('agency.fact.st.none')}</span>
                      ) : (
                        <>
                          <span className={`badge t-${b.status === 'received' ? 'ok' : b.status === 'paid' ? 'info' : 'warn'}`}>{t(`agency.bill.${b.status}`)}</span>
                          <small className="muted ltr">{dateOnly(b.receivedAt ?? b.paidAt ?? b.requestedAt)}</small>
                        </>
                      )}
                    </td>
                    <td className="agx-row-act">
                      {(!b || b.status === 'requested') && (
                        <button type="button" className={`btn small ${b ? '' : 'primary'}`} disabled={bill.total <= 0 || ask.isPending} onClick={() => ask.mutate({ id: l.id, month })}>
                          <Icon name="send" /> {b ? t('agency.billAskAgain') : t('agency.fact.ask')}
                        </button>
                      )}
                      {b && b.status === 'paid' && (
                        <button type="button" className="btn small primary" disabled={got.isPending} onClick={() => got.mutate({ billId: b.id })}>
                          <Icon name="check" /> {t('agency.markReceived')}
                        </button>
                      )}
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

// ---------------------------------------------------------------- Utilisateurs
/** The store's Utilisateurs page, for the agency's people: their roles, and the sellers and products of each one. */
export function AgencyUsers({ sub, rest }: PageProps) {
  return <UsersPage sub={sub} rest={rest} agency />;
}

// ---------------------------------------------------------------- Réglages
/** An example month, to see what the prices give. */
const EXAMPLE: AgencyCounts = { ...NO_COUNTS, received: 300, confirmed: 210, delivered: 150, returned: 40, upsells: 30 };
/** A marketer's example month: its ad sets, their spend, the orders they brought, the profit left. */
const MK_EXAMPLE: AgencyCounts = { ...NO_COUNTS, adsets: 12, spend: 420_000, orders: 380, delivered: 240, returned: 70, net: 310_000, successes: 4 };

/** The partner's code (sellers add it with it) and its usual prices. */
export function AgencySettings(_: PageProps) {
  const { t } = useTranslation();
  const tp = useTp();
  const kind = usePartnerKind();
  const q = useHome();
  const [p, setP] = useState<AgencyPrices | null>(null);
  useEffect(() => {
    if (q.data && p === null) setP(q.data.agency.prices ?? NO_AGENCY_PRICES);
  }, [q.data, p]);
  if (q.isLoading || (!p && !q.error)) return <Loading />;
  if (q.error || !p) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const sample = kind === 'marketer' ? MK_EXAMPLE : EXAMPLE;
  const ex = billOf(p, sample, kind);
  return (
    <div className="agx-page">
      <section className="card agx-hero">
        <div className="agx-hero-t">
          <strong>{q.data!.agency.name}</strong>
          <small>{tp('home.yourCode')}</small>
          <span className="agx-code">{q.data!.agency.code ? <CopyCode code={q.data!.agency.code} /> : '—'}</span>
          <p className="muted">{tp('home.codeText')}</p>
        </div>
        <a className="btn" href="#/vendeurs">
          <Icon name="plus" /> {t('agency.addSeller')}
        </a>
      </section>
      <div className="agx-grid-2">
        <Card title={t('agency.tarifs.title')}><p><a href="#/facturation">{t('agency.mnav.facturation')}</a></p></Card>
        <Card title={t('agency.tarifs.example')} help={t('agency.tarifs.exampleHelp')}>
          <Lead>
            {kind === 'marketer'
              ? tp('tarifs.exampleText', { a: n(sample.adsets), s: da(sample.spend), d: n(sample.delivered), w: n(sample.successes), net: da(sample.net) })
              : t('agency.tarifs.exampleText', { r: n(sample.received), c: n(sample.confirmed), d: n(sample.delivered), u: n(sample.upsells) })}
          </Lead>
          <CountsRow c={sample} total={ex.total} />
          <BillLines lines={ex.lines} total={ex.total} />
        </Card>
      </div>
    </div>
  );
}
