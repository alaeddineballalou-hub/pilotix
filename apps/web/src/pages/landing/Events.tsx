// Landing pages › Événements: what the server sent to Meta and TikTok, one card per page (its sales, forms, started
// orders, fake orders, and a small line of the last days). A card opens the page's own view: its days by type and
// its last events, with why one was skipped or failed. Above the cards: what Meta says of each pixel (match quality).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { da, dateTime, n } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Axis, DateLabels, ticksFor, useBox } from '../../ui/chart';
import { Empty, ErrorBox, Icon, Loading } from '../../ui/kit';

type Card = Out<'landing.eventStats'>['cards'][number];
type Platform = 'all' | 'meta' | 'tiktok';
const DAYS = [1, 7, 14, 30] as const;
const KINDS = ['delivered', 'purchase', 'lead', 'checkout', 'fake'] as const;
const EVENT_LABEL: Record<string, string> = { Purchase: 'purchase', Confirmed: 'confirmed', InitiateCheckout: 'checkout', Lead: 'lead', Delivered: 'delivered', FakeOrder: 'fake', Competitor: 'competitor' };
/** many fake orders for what the page sells: worth a look */
const risky = (c: Card) => c.fake >= 5 && c.fake * 4 >= c.purchase + c.fake;
/** the period and platform chosen: kept while moving between the cards and a page */
const keep: { days: number; platform: Platform } = { days: 14, platform: 'all' };

export function Events({ page }: { page?: string }) {
  const { t } = useTranslation();
  const [days, setDays] = useState(keep.days);
  const [platform, setPlatform] = useState<Platform>(keep.platform);
  keep.days = days;
  keep.platform = platform;
  const q = useRpc('landing.eventStats', { days, platform });
  const id = page !== undefined && /^\d+$/.test(page) ? Number(page) : null;
  const one = id === null ? null : q.data?.cards.find((c) => c.id === id) ?? null;
  return (
    <div className="lp-evs">
      <div className="lp-evs-bar">
        {id !== null && (
          <a className="btn small" href="#/landing/evenements">
            <Icon name="chevl" /> {t('landing.evs.back')}
          </a>
        )}
        <div className="px-seg" role="group" aria-label={t('landing.evs.period')}>
          {DAYS.map((d) => (
            <button key={d} type="button" className={d === days ? 'on' : ''} aria-pressed={d === days} onClick={() => setDays(d)}>
              {d === 1 ? t('landing.evs.today') : t('landing.evs.days', { count: d })}
            </button>
          ))}
        </div>
        <div className="px-seg" role="group" aria-label={t('landing.evs.platform')}>
          {(['all', 'meta', 'tiktok'] as const).map((p) => (
            <button key={p} type="button" className={p === platform ? 'on' : ''} aria-pressed={p === platform} onClick={() => setPlatform(p)}>
              {p === 'all' ? t('landing.evs.all') : p === 'meta' ? 'Meta' : 'TikTok'}
            </button>
          ))}
        </div>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : id !== null ? (
        <One card={one} id={id} days={days} platform={platform} />
      ) : !q.data?.cards.length ? (
        <Empty>{t('landing.evs.empty')}</Empty>
      ) : (
        <>
          {platform !== 'tiktok' && <Quality />}
          <div className="lp-evs-grid">
            {q.data.cards.map((c) => (
              <PageCard key={c.id} c={c} />
            ))}
          </div>
          <p className="pd-note">{t('landing.evs.note')}</p>
          <Guide />
        </>
      )}
    </div>
  );
}

const nameOf = (c: Card, t: (k: string) => string) => c.title ?? (c.id === 0 ? t('landing.evs.noPage') : t('landing.evs.gone'));

function Platforms({ c }: { c: Card }) {
  return (
    <span className="lp-evs-pl">
      {c.meta && <span className="lp-evs-b meta">Meta</span>}
      {c.tiktok && <span className="lp-evs-b tiktok">TikTok</span>}
    </span>
  );
}

function Numbers({ c }: { c: Card }) {
  const { t } = useTranslation();
  const all = c.sent + c.skipped + c.failed;
  return (
    <div className="lp-evs-nums">
      {(['visits', 'checkout', 'lead', 'purchase', 'delivered'] as const).map((k) => (
        <div key={k}>
          <b className="ltr">{n(c[k])}</b>
          <small>{t(`landing.evs.k.${k}`)}</small>
        </div>
      ))}
      <div className="lp-evs-ok">
        <b className="ltr">{all ? `${Math.round((c.sent * 100) / all)} %` : '—'}</b>
        <small>{t('landing.evs.sentPct')}</small>
      </div>
    </div>
  );
}

function PageCard({ c }: { c: Card }) {
  const { t } = useTranslation();
  const total = c.series.map((s) => s.purchase + s.lead + s.checkout + s.fake + s.delivered);
  return (
    <a className="card lp-evs-card" href={`#/landing/evenements/${c.id}`}>
      <div className="lp-evs-top">
        <span className="pd-name">
          <b dir="auto">{nameOf(c, t)}</b>
          {c.slug && <small className="ltr">/{c.slug}</small>}
        </span>
        <Platforms c={c} />
      </div>
      <Spark values={total} label={t('landing.evs.sparkLabel', { count: c.sent })} />
      <Numbers c={c} />
      {(risky(c) || c.failed > 0) && (
        <div className="lp-evs-warn">
          {risky(c) && (
            <span>
              <Icon name="alert" /> {t('landing.evs.fakeWarn', { count: c.fake })}
            </span>
          )}
          {c.failed > 0 && (
            <span>
              <Icon name="alert" /> {t('landing.evs.failedWarn', { count: c.failed })}
            </span>
          )}
        </div>
      )}
    </a>
  );
}

function Spark({ values, label }: { values: number[]; label: string }) {
  const W = 240;
  const H = 44;
  const max = Math.max(1, ...values);
  const x = (i: number) => (values.length > 1 ? (i * W) / (values.length - 1) : W / 2);
  const y = (v: number) => H - 3 - ((H - 6) * v) / max;
  return (
    <svg className="lp-evs-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {values.length > 1 ? <polyline points={values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} /> : <line x1={0} x2={W} y1={y(values[0] ?? 0)} y2={y(values[0] ?? 0)} />}
    </svg>
  );
}

/** one page: its numbers, its days by type, its last events */
function One({ card, id, days, platform }: { card: Card | null; id: number; days: number; platform: Platform }) {
  const { t } = useTranslation();
  const q = useRpc('landing.events', { limit: 100, landingId: id, days, platform });
  const retry = useAction('landing.retryEvents', { success: (r) => t('landing.ev.retried', { count: r.requeued }) });
  return (
    <>
      {card ? (
        <section className="card pd-card lp-evs-one">
          <div className="lp-evs-top">
            <span className="pd-name">
              <b dir="auto">{nameOf(card, t)}</b>
              {card.slug && <small className="ltr">/{card.slug}</small>}
            </span>
            <Platforms c={card} />
          </div>
          <Numbers c={card} />
          <div className="lp-evs-more">
            <span>
              {t('landing.evs.k.fake')} <b className="ltr">{n(card.fake)}</b>
            </span>
            <span>
              {t('landing.ev.st.skipped')} <b className="ltr">{n(card.skipped)}</b>
            </span>
            <span className={card.failed ? 'bad' : ''}>
              {t('landing.ev.st.failed')} <b className="ltr">{n(card.failed)}</b>
            </span>
            {card.waiting > 0 && (
              <span>
                {t('landing.ev.st.queued')} <b className="ltr">{n(card.waiting)}</b>
              </span>
            )}
          </div>
          {days > 1 && card.visits > 0 && <Visits series={card.series} />}
          {days > 1 && <Bars series={card.series} />}
        </section>
      ) : (
        <Empty>{t('landing.evs.emptyOne')}</Empty>
      )}
      <section className="card pd-card">
        <div className="pd-tools">
          <h2 className="lp-h2">
            <Icon name="send" /> {t('landing.evs.last')}
          </h2>
          {!!card?.failed && (
            <button type="button" className="btn small" disabled={retry.isPending} onClick={() => retry.mutate({})}>
              <Icon name="refresh" /> {t('landing.ev.retry')}
            </button>
          )}
        </div>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.rows.length ? (
          <Empty>{t('landing.evs.emptyOne')}</Empty>
        ) : (
          <div className="pd-list">
            {q.data.rows.map((e) => (
              <div key={e.id} className="pd-row lp-evr">
                <span className={`lp-ev st-${e.status}`}>{t(`landing.ev.st.${e.status}`)}</span>
                <span className="pd-name">
                  <b>{t(`landing.ev.${EVENT_LABEL[e.name] ?? 'checkout'}`)}</b>
                  <small>
                    <span className={`lp-evs-b ${e.platform}`}>{e.platform === 'tiktok' ? 'TikTok' : 'Meta'}</span>
                    {e.ref && <span className="ltr">{e.ref}</span>}
                    {e.customer && <span dir="auto">{e.customer}</span>}
                    {e.value !== null && <span className="ltr">{da(e.value)}</span>}
                  </small>
                  {e.error && <small className="lp-everr">{e.error}</small>}
                </span>
                <span className="muted small">{dateTime(e.sentAt ?? e.at)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

/** the page's days, one bar a day, a colour per type (time runs left to right in every language) */
function Bars({ series }: { series: Card['series'] }) {
  const { t } = useTranslation();
  const [ref, box] = useBox();
  const W = Math.max(280, box.w);
  const H = 210;
  const L = 34;
  const R = 6;
  const T = 8;
  const B = 24;
  const iw = W - L - R;
  const ticks = ticksFor(Math.max(...series.map((s) => s.purchase + s.lead + s.checkout + s.fake + s.delivered)));
  const top = ticks[ticks.length - 1];
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const slot = iw / series.length;
  const bw = Math.min(34, slot * 0.66);
  const x = (i: number) => L + slot * (i + 0.5);
  return (
    <div className="lp-evs-chart">
      <div className="lp-evs-legend">
        {KINDS.map((k) => (
          <span key={k}>
            <i className={`k-${k}`} /> {t(`landing.evs.k.${k}`)}
          </span>
        ))}
      </div>
      <div ref={ref} dir="ltr">
        <svg className="pp-chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('landing.evs.chartLabel')}>
          <Axis ticks={ticks} y={y} L={L} R={R} W={W} />
          {series.map((s, i) => {
            let acc = 0;
            return (
              <g key={s.day}>
                {KINDS.map((k) => {
                  const v = s[k];
                  if (!v) return null;
                  const y1 = y(acc + v);
                  const h = y(acc) - y1;
                  acc += v;
                  return <rect key={k} className={`k-${k}`} x={x(i) - bw / 2} y={y1} width={bw} height={Math.max(1, h - 1)} rx={2} />;
                })}
              </g>
            );
          })}
          <DateLabels days={series} x={x} iw={iw} L={L} R={R} W={W} Hy={H - 6} />
        </svg>
      </div>
    </div>
  );
}

/** the page's visitors, day by day (one per device and day) */
function Visits({ series }: { series: Card['series'] }) {
  const { t } = useTranslation();
  const [ref, box] = useBox();
  const W = Math.max(280, box.w);
  const H = 150;
  const L = 34;
  const R = 6;
  const T = 8;
  const B = 24;
  const iw = W - L - R;
  const ticks = ticksFor(Math.max(...series.map((s) => s.visits)));
  const top = ticks[ticks.length - 1];
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const x = (i: number) => L + (iw / series.length) * (i + 0.5);
  return (
    <div className="lp-evs-chart">
      <div className="lp-evs-legend">
        <span>
          <i className="k-visits" /> {t('landing.evs.visitsChart')}
        </span>
      </div>
      <div ref={ref} dir="ltr">
        <svg className="pp-chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('landing.evs.visitsChart')}>
          <Axis ticks={ticks} y={y} L={L} R={R} W={W} />
          <polyline className="lp-evs-line" points={series.map((s, i) => `${x(i).toFixed(1)},${y(s.visits).toFixed(1)}`).join(' ')} />
          {series.map((s, i) => (
            <circle key={s.day} className="lp-evs-dot" cx={x(i)} cy={y(s.visits)} r={3} />
          ))}
          <DateLabels days={series} x={x} iw={iw} L={L} R={R} W={W} Hy={H - 6} />
        </svg>
      </div>
    </div>
  );
}

/**
 * Good from 7, medium from 5, bad under 5 (a rule of thumb, not Meta's own words). FakeOrder and Competitor are low on
 * purpose (the browser only, never the number typed): « normal », never « bad ».
 */
const grade = (e: { name: string; score: number | null }) =>
  e.score === null ? 'none' : e.name === 'FakeOrder' || e.name === 'Competitor' ? 'normal' : e.score >= 7 ? 'good' : e.score >= 5 ? 'medium' : 'bad';

/** what Meta says of each Meta pixel: the match quality of its events (0–10), and the share the server also sent */
function Quality() {
  const { t } = useTranslation();
  const q = useRpc('landing.eventQuality', {}, { staleTime: 10 * 60_000 });
  const refresh = useAction('landing.eventQuality', { success: () => t('landing.evs.q.refreshed') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.sets.length) return null;
  return (
    <section className="card pd-card lp-evs-q">
      <div className="pd-tools">
        <h2 className="lp-h2">
          <Icon name="chart" /> {t('landing.evs.q.title')}
        </h2>
        <button type="button" className="btn small" disabled={refresh.isPending} onClick={() => refresh.mutate({ refresh: true })}>
          <Icon name="refresh" /> {t('landing.evs.q.refresh')}
        </button>
      </div>
      <p className="pd-note">
        {q.data.demo ? t('landing.evs.q.demo') : t('landing.evs.q.help', { at: dateTime(q.data.at) })}
      </p>
      <p className="pd-note">{t('landing.evs.q.legend')}</p>
      <div className="lp-evs-qsets">
        {q.data.sets.map((s) => (
          <div key={s.pixelId} className="lp-evs-qset">
            <div className="pd-name">
              <b dir="auto">{s.name}</b>
              <small className="ltr">{s.pixelId}</small>
            </div>
            {s.error ? (
              <p className="lp-everr">{s.error}</p>
            ) : !s.events.length ? (
              <p className="muted small">{t('landing.evs.q.none')}</p>
            ) : (
              <div className="lp-evs-qrows">
                {s.events.map((e) => (
                  <div key={e.name} className="lp-evs-qrow">
                    <span className="lp-evs-qname ltr">{e.name}</span>
                    <span className={`lp-evs-qbar g-${grade(e)}`} aria-hidden="true">
                      <i style={{ width: `${Math.max(0, Math.min(100, (e.score ?? 0) * 10))}%` }} />
                    </span>
                    <b className="ltr">{e.score === null ? '—' : `${e.score.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}/10`}</b>
                    <span className={`lp-evs-qg g-${grade(e)}`}>{t(`landing.evs.q.g.${grade(e)}`)}</span>
                    <small className="muted">{e.coverage === null ? '' : t('landing.evs.q.coverage', { pct: Math.round(e.coverage) })}</small>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** which events exist, in the order a customer goes through them; `tiktok`: Pilotix also sends it to TikTok */
const GUIDE = [
  { key: 'view', tech: 'PageView · ViewContent', tiktok: true },
  { key: 'checkout', tech: 'InitiateCheckout', tiktok: true },
  { key: 'lead', tech: 'Lead', tiktok: true },
  { key: 'purchase', tech: 'Purchase', tiktok: true },
  { key: 'confirmed', tech: 'Confirmed', tiktok: false },
  { key: 'delivered', tech: 'Delivered', tiktok: true },
  { key: 'fake', tech: 'FakeOrder · Competitor', tiktok: true },
] as const;

/** Read-only: what each event is for and when it leaves (nothing can be switched off here) */
function Guide() {
  const { t } = useTranslation();
  const at = useRpc('landing.settings.get', {}, { staleTime: 60_000 }).data?.settings.purchaseAt ?? 'confirmed';
  // « Confirmed » only exists when Purchase leaves at the order; « Delivered » not when Purchase itself waits for the delivery
  const list = GUIDE.filter((g) => (g.key === 'confirmed' ? at === 'order' : g.key === 'delivered' ? at !== 'delivered' : true));
  return (
    <details className="card pd-card lp-evs-guide" open>
      <summary>
        <Icon name="info" /> {t('landing.evs.g.title')}
      </summary>
      <p className="pd-note">{t('landing.evs.g.help')}</p>
      <div className="lp-evs-gs">
        {list.map((g) => (
          <div key={g.key} className="lp-evs-g">
            <div className="lp-evs-top">
              <span className="pd-name">
                <b>{t(`landing.evs.g.${g.key}.name`)}</b>
                <small className="ltr">{g.tech}</small>
              </span>
              <span className="lp-evs-pl">
                <span className="lp-evs-b meta">Meta</span>
                {g.tiktok && <span className="lp-evs-b tiktok">TikTok</span>}
              </span>
            </div>
            <p>{t(`landing.evs.g.${g.key}.why`)}</p>
            <p className="muted">
              <b>{t('landing.evs.g.when')}</b> {g.key === 'purchase' ? t(`landing.evs.g.purchase.at.${at}`) : t(`landing.evs.g.${g.key}.when`)}
            </p>
          </div>
        ))}
      </div>
    </details>
  );
}
