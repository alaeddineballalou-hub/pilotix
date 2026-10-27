// A marketer's own space (it runs the ads of the stores it works for), like a store's Marketing:
// - Accueil: its ad sets now (running, « réussis », « ratés », spend, net profit) and, for its chief, this month for
//   each seller (what its prices make) and what Pilotix still has to check;
// - Marketing › Publicité and « Mes ad sets »: the store's own screens, as the marketer's people see them there (their
//   ad sets only), with the seller picker at the top of the page. « Tous les vendeurs »: every ad set of every seller
//   in one list (a click opens it in its seller), or the sellers to choose for Publicité.
// Its Vendeurs, Facturation, Utilisateurs and Réglages are the agency's pages (../agency), with a marketer's words.
import { hasPrice, NO_COUNTS } from '@pilotix/shared';
import { ReactNode, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, n } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { SellerScope, setSeller, useSeller } from '../../lib/seller';
import { useSellers } from '../../lib/sellers';
import { AgentView, useSession } from '../../lib/session';
import { useIsPhone } from '../../lib/useMedia';
import { Card, Empty, ErrorBox, Icon, Kpis, Loading, StageBar } from '../../ui/kit';
import { Publicite } from '../ads';
import { Marketer } from '../ads/Marketer';
import { PhoneMarketing } from '../ads/PhoneAds';
import { sumCounts, useHome } from '../agency';
import { monthLabel, useTp } from '../agency/parts';
import { KpiBox } from '../dashboard/util';
import type { PageProps } from '../registry';
import '../ads/ads.css';
import '../agency/agency.css';
import './marketer.css';

type MkRow = Out<'mk.overview'>['rows'][number] & { seller?: { id: number; name: string } };

/** this month (Algeria) */
const monthNow = () => {
  const d = new Date(Date.now() + 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
/** An ad set's result: running (not judged yet), « réussi », « raté ». */
const resultOf = (r: MkRow): 'run' | 'ok' | 'ko' => (!r.final ? 'run' : r.ok ? 'ok' : 'ko');

// ---------------------------------------------------------------- Accueil
export function MarketerHome(_: PageProps) {
  const seller = useSeller();
  // the seller chosen at the top: the ad sets below are that seller's (or every seller's)
  return (
    <SellerScope seller={seller}>
      <HomeBody />
    </SellerScope>
  );
}

function HomeBody() {
  const { t, i18n } = useTranslation();
  const tp = useTp('marketer');
  const { session } = useSession();
  const s = session!;
  const work = useSellers();
  // the person's ad sets: one seller, or every one of them (the server asks as the person's account in each store)
  const q = useRpc('mk.overview', {}, { enabled: work.loaded && work.list.length > 0, refetchInterval: 120_000 });
  const rows = (q.data?.rows ?? []) as MkRow[];
  const k = useMemo(() => {
    const run = rows.filter((r) => resultOf(r) === 'run');
    return {
      run: run.length,
      ok: rows.filter((r) => resultOf(r) === 'ok').length,
      ko: rows.filter((r) => resultOf(r) === 'ko').length,
      spend: run.reduce((x, r) => x + r.spDa, 0),
      net: run.reduce((x, r) => x + r.net, 0),
    };
  }, [rows]);
  return (
    <div className="tb hm agx-home mkx-home">
      <header className="tb-head hm-head">
        <div className="tb-ht">
          <h2>{t('home.hello', { name: s.profile.name })}</h2>
          <p className="tb-cap">
            {work.one ? work.one.name : t('agency.pick.all', { count: work.list.length })} · {monthLabel(monthNow(), i18n.language)}
          </p>
        </div>
      </header>
      <OwnerTop />
      <section className="card hm-now">
        <div className="card-head">
          <h2>{tp('home.adsetsNow')}</h2>
          <a className="btn small" href="#/marketing/marketer">
            <Icon name="megaphone" /> {tp('adsets')}
          </a>
        </div>
        {work.loaded && !work.list.length ? (
          <Empty>{s.isAdmin ? tp('home.noSeller') : tp('home.noWhere')}</Empty>
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <Kpis>
            <KpiBox icon="timer" label={tp('home.running')} value={n(k.run)} sub={tp('home.runningSub')} href="#/marketing/marketer" />
            <KpiBox icon="coins" label={tp('home.runSpend')} value={da(Math.round(k.spend))} sub={tp('home.runSpendSub')} />
            <KpiBox icon="trend" label={tp('home.runNet')} value={da(Math.round(k.net))} sub={tp('home.runNetSub')} tone={k.net < 0 ? 'bad' : k.net > 0 ? 'ok' : undefined} />
            <KpiBox icon="trophy" label={tp('home.won')} value={n(k.ok)} sub={tp('home.wonSub', { n: n(k.ko) })} tone="ok" href="#/marketing/marketer" />
          </Kpis>
        )}
      </section>
      {s.isAdmin && <OwnerMonth />}
    </div>
  );
}

/** The chief: Pilotix's check (and what is left to do before it), the sellers who asked. */
function OwnerTop() {
  const tp = useTp('marketer');
  const { session } = useSession();
  const q = useHome();
  const team = useRpc('agency.team', {}, { enabled: !!session?.isAdmin });
  if (!session?.isAdmin || !q.data) return null;
  const h = q.data;
  const priced = !!h.agency.prices && hasPrice(h.agency.prices);
  const people = (team.data ?? []).filter((p) => p.roles.includes('marketer')).length;
  const waiting = h.links.filter((l) => l.status === 'pending' && l.requestedBy === 'store');
  return (
    <>
      {!h.agency.verified && (
        <section className="card agx-banner" role="status">
          <Icon name="hourglass" />
          <div>
            <b>{tp('home.waitTitle')}</b>
            <p>{tp('home.waitText')}</p>
            <ol className="agx-steps">
              <li className="done">
                <Icon name="checkcircle" /> {tp('home.step1')}
              </li>
              <li className={priced ? 'done' : ''}>
                <Icon name={priced ? 'checkcircle' : 'tag'} /> <a href="#/reglages">{tp('home.step2')}</a>
              </li>
              <li className={people > 0 ? 'done' : ''}>
                <Icon name={people > 0 ? 'checkcircle' : 'users'} /> <a href="#/utilisateurs">{tp('home.step3')}</a>
              </li>
              <li>
                <Icon name="shield" /> {tp('home.step4')}
              </li>
            </ol>
          </div>
        </section>
      )}
      {waiting.length > 0 && (
        <a className="card agx-alert" href="#/vendeurs">
          <Icon name="inbox" />
          <span>{tp('home.waiting', { count: waiting.length })}</span>
          <Icon name="chevr" />
        </a>
      )}
    </>
  );
}

/** The chief: this month, every seller (or the one chosen): its ad sets, what they brought, what the prices make. */
function OwnerMonth() {
  const { t, i18n } = useTranslation();
  const tp = useTp('marketer');
  const seller = useSeller();
  const q = useHome();
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const h = q.data!;
  const rows = h.links.filter((l) => l.status === 'active' && (seller === 'all' || l.store.id === seller)).map((l) => ({ l, c: h.counts[String(l.id)] ?? { ...NO_COUNTS, total: 0 } }));
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
        <KpiBox icon="coins" label={t('agency.c.spend')} value={da(c.spend)} sub={tp('home.spendSub', { n: n(c.adsets) })} />
        <KpiBox icon="truck" label={t('agency.c.delivered')} value={n(c.delivered)} sub={t('agency.c.ofOrders', { n: n(c.orders) })} tone="ok" />
        <KpiBox icon="trend" label={t('agency.c.net')} value={da(c.net)} sub={tp('home.netSub')} tone={c.net < 0 ? 'bad' : 'ok'} />
        <KpiBox icon="receipt" label={t('agency.c.amount')} value={da(total)} sub={tp('home.amountSub')} href="#/facturation" />
      </Kpis>
      {seller === 'all' &&
        (rows.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('agency.seller')}</th>
                  <th className="num">{t('agency.c.adsets')}</th>
                  <th className="num">{t('agency.c.spend')}</th>
                  <th className="num">{t('agency.c.delivered')}</th>
                  <th className="num">{t('agency.c.net')}</th>
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
                    <td className="num ltr" data-l={t('agency.c.adsets')}>{n(c.adsets)}</td>
                    <td className="num ltr" data-l={t('agency.c.spend')}>{da(c.spend)}</td>
                    <td className="num ltr" data-l={t('agency.c.delivered')}>{n(c.delivered)}</td>
                    <td className={`num ltr ${c.net < 0 ? 'agx-bad' : ''}`} data-l={t('agency.c.net')}>{da(c.net)}</td>
                    <td className="num ltr" data-l={t('agency.c.amount')}>{da(c.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{tp('home.noSeller')}</Empty>
        ))}
    </section>
  );
}

// ---------------------------------------------------------------- Marketing: Publicité, Mes ad sets
export function MarketerAds({ sub, rest }: PageProps) {
  const { t } = useTranslation();
  const tp = useTp('marketer');
  const seller = useSeller();
  // the chief (outside AgentView: there everyone is one of the marketer's people in the store)
  const chief = !!useSession().session?.isAdmin;
  const phone = useIsPhone();
  const cur = sub === 'marketer' ? 'marketer' : 'publicite';
  return (
    <SellerScope seller={seller}>
      <AgentView>
        {(!phone || seller === 'all') && (
          <StageBar
            flow={false}
            current={cur}
            items={[
              { key: 'publicite', label: t('nav.publicite'), href: '#/marketing/publicite' },
              { key: 'marketer', label: tp('adsets'), href: '#/marketing/marketer' },
            ]}
          />
        )}
        <Sellers chief={chief}>
          {seller === 'all' ? (
            cur === 'marketer' ? (
              <AllAdsets />
            ) : (
              <PickSeller />
            )
          ) : phone ? (
            <PhoneMarketing key={seller} sub={cur} rest={rest} noSpy mkLabel={tp('adsets')} />
          ) : cur === 'marketer' ? (
            <Marketer key={seller} rest={rest} />
          ) : (
            <Publicite key={seller} />
          )}
        </Sellers>
      </AgentView>
    </SellerScope>
  );
}

/** No seller yet: say so (the chief adds them in Vendeurs). */
function Sellers({ chief, children }: { chief: boolean; children: ReactNode }) {
  const tp = useTp('marketer');
  const w = useSellers();
  if (!w.loaded) return <Loading />;
  if (!w.list.length) return <Empty>{chief ? tp('home.noSeller') : tp('home.noWhere')}</Empty>;
  return <>{children}</>;
}

/** Publicité with « Tous les vendeurs »: the sellers, to open one. */
function PickSeller() {
  const tp = useTp('marketer');
  const w = useSellers();
  return (
    <Card title={tp('pickTitle')}>
      <p className="agx-lead muted">{tp('pickText')}</p>
      <div className="mkx-sellers">
        {w.list.map((s) => (
          <button key={s.id} type="button" className="mkx-seller" onClick={() => setSeller(s.id)}>
            <span className="agx-where-ic">
              <Icon name="store" />
            </span>
            <span className="mkx-seller-t">
              <b>{s.name}</b>
              {s.code && <small className="muted ltr">{s.code}</small>}
            </span>
            <Icon name="chevr" />
          </button>
        ))}
      </div>
    </Card>
  );
}

type St = '' | 'run' | 'ok' | 'ko';

/** « Mes ad sets » with « Tous les vendeurs »: every ad set of every seller (a click opens it in its seller). */
function AllAdsets() {
  const { t } = useTranslation();
  const tp = useTp('marketer');
  const q = useRpc('mk.overview', {});
  const [st, setSt] = useState<St>('');
  const [search, setSearch] = useState('');
  if (q.isLoading && !q.data) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const rows = (q.data?.rows ?? []) as MkRow[];
  const ql = search.trim().toLowerCase();
  const shown = rows.filter((r) => (!st || resultOf(r) === st) && (!ql || r.name.toLowerCase().includes(ql) || r.prod.toLowerCase().includes(ql) || (r.seller?.name ?? '').toLowerCase().includes(ql)));
  const sum = (f: (r: MkRow) => number) => shown.reduce((x, r) => x + f(r), 0);
  const open = (r: MkRow) => {
    if (r.seller) setSeller(r.seller.id);
    location.hash = `#/marketing/marketer/adset/${encodeURIComponent(r.id)}`;
  };
  return (
    <div className="mkx-all">
      <Kpis>
        <KpiBox icon="megaphone" label={t('agency.c.adsets')} value={n(shown.length)} sub={tp('all.sellers', { count: new Set(shown.map((r) => r.seller?.id)).size })} />
        <KpiBox icon="coins" label={t('agency.c.spend')} value={da(Math.round(sum((r) => r.spDa)))} sub={tp('all.life')} />
        <KpiBox icon="trend" label={t('agency.c.net')} value={da(Math.round(sum((r) => r.net)))} sub={tp('all.netSub')} tone={sum((r) => r.net) < 0 ? 'bad' : 'ok'} />
        <KpiBox icon="trophy" label={tp('home.won')} value={n(shown.filter((r) => resultOf(r) === 'ok').length)} sub={tp('home.wonSub', { n: n(shown.filter((r) => resultOf(r) === 'ko').length) })} tone="ok" />
      </Kpis>
      <section className="card">
        <div className="card-head">
          <h2>
            {tp('adsets')}
            <span className="count">{n(shown.length)}</span>
          </h2>
        </div>
        <div className="mk-filters">
          <div className="search">
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tp('all.search')} aria-label={tp('all.search')} />
          </div>
          <select className={`mk-fsel ${st ? 'on' : ''}`} value={st} onChange={(e) => setSt(e.target.value as St)} aria-label={t('marketer.filterSt')}>
            {(['', 'run', 'ok', 'ko'] as St[]).map((k) => (
              <option key={k} value={k}>{`${t(`marketer.st.${k || 'all'}`)} · ${n(k ? rows.filter((r) => resultOf(r) === k).length : rows.length)}`}</option>
            ))}
          </select>
        </div>
        {!shown.length ? (
          <Empty>{rows.length ? t('common.noResults') : tp('all.none')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl mkx-tbl">
              <thead>
                <tr>
                  <th>{t('agency.seller')}</th>
                  <th>{tp('all.adset')}</th>
                  <th className="num">{t('agency.c.spend')}</th>
                  <th className="num">{t('agency.c.orders')}</th>
                  <th className="num">{t('agency.c.delivered')}</th>
                  <th className="num">{t('agency.c.net')}</th>
                  <th>{tp('all.result')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const res = resultOf(r);
                  return (
                    <tr key={`${r.seller?.id ?? 0}:${r.id}`} className="clickable" tabIndex={0} onClick={() => open(r)} onKeyDown={(e) => e.key === 'Enter' && open(r)}>
                      <td data-l={t('agency.seller')}>
                        <b>{r.seller?.name ?? '—'}</b>
                      </td>
                      <td data-l={tp('all.adset')} className="mkx-adset">
                        <b>{r.name}</b>
                        <small className="muted">{r.prod || tp('all.noProduct')}</small>
                      </td>
                      <td className="num ltr" data-l={t('agency.c.spend')}>{da(Math.round(r.spDa))}</td>
                      <td className="num ltr" data-l={t('agency.c.orders')}>{n(Math.round(r.n))}</td>
                      <td className="num ltr" data-l={t('agency.c.delivered')}>{n(Math.round(r.d))}</td>
                      <td className={`num ltr ${r.net < 0 ? 'agx-bad' : ''}`} data-l={t('agency.c.net')}>{da(r.net)}</td>
                      <td data-l={tp('all.result')}>
                        <span className={`badge t-${res === 'ok' ? 'ok' : res === 'ko' ? 'bad' : 'warn'}`}>{tp(`all.res.${res}`)}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
