// Landing pages › Protection: what the fake-order check did over a period — orders received, passed, put to review,
// blocked, merged (sent again) — day by day and hour by hour, the reasons that weigh most, the pages attacked, the
// attacks themselves (one device sending many numbers, numbers in a row) with a one-click « block this device », and
// the devices agents marked « fausse commande » / « concurrent ».
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type Out } from '../../lib/backend';
import { dateTime, n, pct, when } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { Empty, ErrorBox, Icon, Kpi, Kpis, Loading } from '../../ui/kit';
import { PeriodSwitch } from '../ai/agent';

type Data = Out<'landing.protection'>;

export function Protection() {
  const { t } = useTranslation();
  const [days, setDays] = useState(7);
  const q = useRpc('landing.protection', { days });
  const d = q.data;
  const tt = d?.totals;
  const held = (tt?.blocked ?? 0) + (tt?.review ?? 0);
  /** real orders: received, minus the fake ones (blocked) and the ones sent twice (merged) */
  const real = (tt?.allowed ?? 0) + (tt?.review ?? 0);
  return (
    <>
      <div className="lp-pr-top">
        <p className="pd-note">{t('landing.pr.intro')}</p>
        <PeriodSwitch value={days} onChange={setDays} />
      </div>
      <Kpis>
        <Kpi
          label={t('landing.pr.kQuality')}
          value={tt?.submits ? pct(real / tt.submits) : '—'}
          sub={t('landing.pr.kQualitySub', { real: n(real), total: n(tt?.submits) })}
          icon="medal"
          tone={tt?.submits ? (real / tt.submits >= 0.85 ? 'ok' : real / tt.submits >= 0.7 ? 'warn' : 'bad') : undefined}
          big
        />
        <Kpi label={t('landing.pr.kSubmits')} value={n(tt?.submits)} sub={t('landing.pr.kSubmitsSub')} icon="cart" />
        <Kpi label={t('landing.pr.kAllowed')} value={n(tt?.allowed)} sub={t('landing.pr.kAllowedSub')} icon="checkcircle" />
        <Kpi label={t('landing.pr.kReview')} value={n(tt?.review)} sub={t('landing.pr.kReviewSub')} icon="eye" />
        <Kpi
          label={t('landing.pr.kBlocked')}
          value={n(tt?.blocked)}
          sub={t('landing.pr.kBlockedSub', { rate: tt?.submits ? pct((tt.blocked ?? 0) / tt.submits) : '—' })}
          icon="shield"
          tone={tt?.waiting ? 'bad' : undefined}
          href="#/landing/bloquees"
        />
        <Kpi label={t('landing.pr.kConfirmed')} value={n(tt?.confirmed)} sub={t('landing.pr.kConfirmedSub', { rate: real ? pct((tt?.confirmed ?? 0) / real) : '—' })} icon="check" />
        <Kpi label={t('landing.pr.kMerged')} value={n(tt?.merged)} sub={t('landing.pr.kMergedSub')} icon="layers" />
        <Kpi label={t('landing.pr.kMarked')} value={n(tt?.marked)} sub={t('landing.pr.kMarkedSub', { count: tt?.competitor ?? 0 })} icon="flag" />
      </Kpis>
      {q.isLoading ? (
        <Loading />
      ) : q.error || !d ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="lp-pr-grid">
            <section className="card pd-card">
              <h2 className="lp-h2">
                <Icon name="chart" /> {t('landing.pr.byDay')}
              </h2>
              <DayBars series={d.series} days={d.days} />
            </section>
            <section className="card pd-card">
              <h2 className="lp-h2">
                <Icon name="clock" /> {t('landing.pr.byHour')}
              </h2>
              <p className="pd-note">{t('landing.pr.byHourHelp')}</p>
              <HourBars hours={d.hours} />
            </section>
          </div>
          <Attacks attacks={d.attacks} />
          <div className="lp-pr-grid">
            <Reasons reasons={d.reasons} total={held} />
            <Pages pages={d.pages} />
          </div>
          <Marks marks={d.marks} />
          <AttackTest />
        </>
      )}
    </>
  );
}

/** stacked bars: passed (green), to check (amber), blocked (coral), one per day */
function DayBars({ series, days }: { series: Data['series']; days: number }) {
  const { t } = useTranslation();
  // every day of the period, the empty ones too
  const all: Data['series'] = [];
  const by = new Map(series.map((s) => [s.day, s]));
  for (let k = Math.min(days, 30) - 1; k >= 0; k--) {
    const day = new Date(Date.now() - k * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Africa/Algiers' });
    all.push(by.get(day) ?? { day, allowed: 0, review: 0, blocked: 0 });
  }
  const max = Math.max(1, ...all.map((s) => s.allowed + s.review + s.blocked));
  if (!all.some((s) => s.allowed + s.review + s.blocked)) return <Empty>{t('landing.pr.none')}</Empty>;
  return (
    <>
      <div className="lp-bars" role="img" aria-label={t('landing.pr.byDay')}>
        {all.map((s) => {
          const tot = s.allowed + s.review + s.blocked;
          return (
            <div key={s.day} className="lp-bar" title={`${s.day} — ${t('landing.pr.lAllowed')} ${s.allowed} · ${t('landing.pr.lReview')} ${s.review} · ${t('landing.pr.lBlocked')} ${s.blocked}`}>
              <div className="lp-bar-s" style={{ height: `${(tot / max) * 100}%` }}>
                {!!s.blocked && <i className="b" style={{ flexGrow: s.blocked }} />}
                {!!s.review && <i className="r" style={{ flexGrow: s.review }} />}
                {!!s.allowed && <i className="a" style={{ flexGrow: s.allowed }} />}
              </div>
              <small className="ltr">{s.day.slice(8)}</small>
            </div>
          );
        })}
      </div>
      <div className="lp-legend">
        <span>
          <i className="a" /> {t('landing.pr.lAllowed')}
        </span>
        <span>
          <i className="r" /> {t('landing.pr.lReview')}
        </span>
        <span>
          <i className="b" /> {t('landing.pr.lBlocked')}
        </span>
      </div>
    </>
  );
}

function HourBars({ hours }: { hours: number[] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...hours);
  if (!hours.some(Boolean)) return <Empty>{t('landing.pr.noBlocked')}</Empty>;
  const peak = hours.indexOf(Math.max(...hours));
  return (
    <>
      <div className="lp-bars hours" role="img" aria-label={t('landing.pr.byHour')}>
        {hours.map((v, h) => (
          <div key={h} className="lp-bar" title={`${String(h).padStart(2, '0')}h — ${v}`}>
            <div className="lp-bar-s" style={{ height: `${(v / max) * 100}%` }}>
              {!!v && <i className={h === peak ? 'b' : 'r'} style={{ flexGrow: 1 }} />}
            </div>
            <small className="ltr">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</small>
          </div>
        ))}
      </div>
      <p className="pd-note">{t('landing.pr.peak', { h: `${String(peak).padStart(2, '0')}h`, count: hours[peak] })}</p>
    </>
  );
}

/** the attacks: a device that sent many numbers, or numbers in a row; a device can be blocked (« concurrent ») in one click */
function Attacks({ attacks }: { attacks: Data['attacks'] }) {
  const { t } = useTranslation();
  const mark = useAction('landing.markDevice', { success: (r) => (r.on ? t('landing.pr.markedOn') : t('landing.pr.markedOff')) });
  return (
    <section className="card pd-card">
      <h2 className="lp-h2">
        <Icon name="alert" /> {t('landing.pr.attacks')}
      </h2>
      <p className="pd-note">{t('landing.pr.attacksHelp')}</p>
      {!attacks.length ? (
        <Empty>{t('landing.pr.noAttack')}</Empty>
      ) : (
        <div className="lp-atk-list">
          {attacks.map((a) => (
            <article key={`${a.kind}-${a.key}`} className={`lp-atk ${a.competitor ? 'on' : ''}`}>
              <header>
                <span className="lp-atk-i" aria-hidden="true">
                  <Icon name={a.kind === 'device' ? 'phone' : 'list'} />
                </span>
                <span className="pd-name">
                  <b>
                    {a.kind === 'device' ? t('landing.pr.aDevice') : t('landing.pr.aNumbers')} <span className="ltr">{a.label}</span>
                  </b>
                  <small>
                    {t('landing.pr.aWhen', { first: when(a.first), last: when(a.last) })}
                    {a.pages.map((p) => (
                      <span key={p} className="ltr">
                        /{p}
                      </span>
                    ))}
                  </small>
                </span>
                {a.competitor && <span className="chip lp-rs hi">🕵️ {t('landing.pr.competitor')}</span>}
                {!a.competitor && a.fakes > 0 && <span className="chip lp-warn">{t('landing.pr.fakes', { count: a.fakes })}</span>}
              </header>
              <div className="lp-atk-n">
                <span>
                  <b className="ltr">{a.orders}</b> {t('landing.pr.aOrders')}
                </span>
                <span>
                  <b className="ltr">{a.phones}</b> {t('landing.pr.aPhones')}
                </span>
                <span className="hi">
                  <b className="ltr">{a.blocked}</b> {t('landing.pr.lBlocked')}
                </span>
                <span className="mid">
                  <b className="ltr">{a.review}</b> {t('landing.pr.lReview')}
                </span>
              </div>
              {!!a.sample.length && (
                <div className="lp-atk-ph">
                  {a.sample.map((p, k) => (
                    <span key={k} className="lp-rs ltr">
                      {p}
                    </span>
                  ))}
                  {a.phones > a.sample.length && <span className="muted small">+{a.phones - a.sample.length}</span>}
                </div>
              )}
              <footer>
                <a className="btn small ghost" href="#/landing/bloquees">
                  <Icon name="eye" /> {t('landing.pr.see')}
                </a>
                {a.kind === 'device' &&
                  (a.competitor ? (
                    <button type="button" className="btn small" disabled={mark.isPending} onClick={() => mark.mutate({ device: a.key, on: false })}>
                      <Icon name="undo" /> {t('landing.pr.unblock')}
                    </button>
                  ) : (
                    <button type="button" className="btn small lp-blockbtn" disabled={mark.isPending} onClick={() => window.confirm(t('landing.pr.blockAsk')) && mark.mutate({ device: a.key, on: true })}>
                      <Icon name="ban" /> {t('landing.pr.block')}
                    </button>
                  ))}
              </footer>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function Reasons({ reasons, total }: { reasons: Data['reasons']; total: number }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...reasons.map((r) => r.blocked + r.review));
  return (
    <section className="card pd-card">
      <h2 className="lp-h2">
        <Icon name="info" /> {t('landing.pr.why')}
      </h2>
      <p className="pd-note">{t('landing.pr.whyHelp', { count: total })}</p>
      {!reasons.length ? (
        <Empty>{t('landing.pr.none')}</Empty>
      ) : (
        <div className="lp-why">
          {reasons.map((r) => (
            <div key={r.code} className="lp-why-r">
              <span>{t(`landing.reasons.${r.code}`, { defaultValue: r.code })}</span>
              <span className="lp-why-b" aria-hidden="true">
                <i className="b" style={{ width: `${(r.blocked / max) * 100}%` }} />
                <i className="r" style={{ width: `${(r.review / max) * 100}%` }} />
              </span>
              <b className="ltr">{r.blocked + r.review}</b>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Pages({ pages }: { pages: Data['pages'] }) {
  const { t } = useTranslation();
  return (
    <section className="card pd-card">
      <h2 className="lp-h2">
        <Icon name="globe" /> {t('landing.pr.byPage')}
      </h2>
      {!pages.length ? (
        <Empty>{t('landing.pr.none')}</Empty>
      ) : (
        <div className="pd-list">
          <div className="pd-row pd-head lp-pg" aria-hidden="true">
            <span>{t('landing.pr.page')}</span>
            <span>{t('landing.pr.kSubmits')}</span>
            <span>{t('landing.pr.lReview')}</span>
            <span>{t('landing.pr.lBlocked')}</span>
          </div>
          {pages.map((p) => (
            <div key={p.slug} className="pd-row lp-pg">
              <span className="pd-name">
                <b dir="auto">{p.title}</b>
                <small className="ltr">/{p.slug}</small>
              </span>
              <span className="ltr">{n(p.submits)}</span>
              <span className="ltr lp-mid">{n(p.review)}</span>
              <span className="ltr lp-hi">
                {n(p.blocked)} <small className="muted">{p.submits ? pct(p.blocked / p.submits) : ''}</small>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Marks({ marks }: { marks: Data['marks'] }) {
  const { t } = useTranslation();
  return (
    <section className="card pd-card">
      <h2 className="lp-h2">
        <Icon name="flag" /> {t('landing.pr.marks')}
      </h2>
      <p className="pd-note">{t('landing.pr.marksHelp')}</p>
      {!marks.length ? (
        <Empty>{t('landing.pr.noMarks')}</Empty>
      ) : (
        <div className="pd-list">
          {marks.map((m) => (
            <div key={m.id} className="pd-row lp-mk">
              <span className={`chip ${m.reason === 'competitor' ? 'lp-rs hi' : 'lp-warn'}`}>{m.reason === 'competitor' ? `🕵️ ${t('landing.pr.competitor')}` : t('landing.pr.fake')}</span>
              <span className="pd-name">
                <b>
                  {t('landing.pr.aDevice')} <span className="ltr">{m.device}</span>
                </b>
                <small>
                  {m.phone && <span className="ltr">{m.phone}</span>}
                  {m.orderRef && (
                    <button type="button" className="lp-link ltr" onClick={() => openOrder(m.orderId!)}>
                      {m.orderRef}
                    </button>
                  )}
                  {m.by && <span>{m.by}</span>}
                </small>
              </span>
              <span className="muted small">{dateTime(m.at)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}


/** « Lancer un test d'attaque »: real attacks on a page (robots, pranks, competitors, refusers) + 100 real customers,
 * run safely (nothing is saved), to see how much the protection catches. */
function AttackTest() {
  const { t } = useTranslation();
  const pages = useRpc('landing.list', {});
  const [slug, setSlug] = useState('');
  const [cf, setCf] = useState(true);
  const run = useAction('landing.attackTest', {});
  const rep = run.data;
  const go = () => run.mutate({ slug: slug || undefined, turnstile: cf ? 'on' : 'off' });
  const grp = (g: string) => (rep ? rep.rows.filter((x) => x.group === g) : []);
  const groups = rep ? [...new Set(rep.rows.map((x) => x.group))] : [];
  const bar = (x: { sent: number; blocked: number; review: number; passed: number }) => (
    <span className="lp-at-bar" title={`${x.blocked} bloquées · ${x.review} à vérifier · ${x.passed} passées`}>
      {x.blocked > 0 && <i className="b" style={{ flexGrow: x.blocked }} />}
      {x.review > 0 && <i className="r" style={{ flexGrow: x.review }} />}
      {x.passed > 0 && <i className="p" style={{ flexGrow: x.passed }} />}
    </span>
  );
  return (
    <section className="card pd-card lp-at">
      <h2 className="lp-h2">
        <Icon name="shield" /> {t('landing.at.title')}
      </h2>
      <p className="pd-note">{t('landing.at.help')}</p>
      <div className="lp-at-tools">
        <select value={slug} onChange={(e) => setSlug(e.target.value)} disabled={run.isPending}>
          <option value="">{t('landing.at.firstPage')}</option>
          {(pages.data ?? []).map((p) => (
            <option key={p.id} value={p.slug}>
              {p.title || p.productName} · /{p.slug}
            </option>
          ))}
        </select>
        <button type="button" className="btn primary" onClick={go} disabled={run.isPending}>
          <Icon name="play" /> {run.isPending ? t('landing.at.running') : t('landing.at.run')}
        </button>
      </div>
      <label className="check lp-at-cf">
        <input type="checkbox" checked={cf} disabled={run.isPending} onChange={(e) => setCf(e.target.checked)} />
        {t('landing.at.cf')}
      </label>
      {run.isPending && <p className="pd-note">{t('landing.at.wait')}</p>}
      {run.error && <ErrorBox error={run.error} />}
      {rep && (
        <>
          <div className="lp-at-head">
            <span className={`chip ${rep.real.blocked === 0 ? 'lp-on' : 'lp-warn'}`}>
              {t('landing.at.real', { passed: rep.real.sent - rep.real.blocked, total: rep.real.sent })}
            </span>
            <span className="chip">{t('landing.at.caught', { pct: pct((rep.total.blocked + rep.total.review) / Math.max(1, rep.total.sent)) })}</span>
            <span className={`chip ${rep.turnstileOn ? 'lp-on' : ''}`}>{rep.turnstileOn ? t('landing.at.cfOn') : t('landing.at.cfOff')}</span>
          </div>
          <div className="lp-at-legend">
            <span><i className="b" /> {t('landing.at.blocked')}</span>
            <span><i className="r" /> {t('landing.at.review')}</span>
            <span><i className="p" /> {t('landing.at.passed')}</span>
          </div>
          {groups.map((g) => (
            <div key={g} className="lp-at-grp">
              <h3>{g}</h3>
              <table className="lp-at-tbl">
                <tbody>
                  {grp(g).map((x) => (
                    <tr key={x.name}>
                      <td className="lp-at-nm">
                        <b dir="auto">{x.name}</b>
                        <small>{x.how}</small>
                      </td>
                      <td className="lp-at-ct">{x.sent}</td>
                      <td className="lp-at-bc">{bar(x)}</td>
                      <td className="lp-at-pc">{x.attack ? `${Math.round(((x.blocked + x.review) / Math.max(1, x.sent)) * 100)} %` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <p className="pd-note lp-at-foot">{t('landing.at.foot')}</p>
        </>
      )}
    </section>
  );
}
