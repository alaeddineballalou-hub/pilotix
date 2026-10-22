// Dashboard › Vue d'ensemble (admin / vendeur): the whole shop on one screen.
// KPIs · orders per day · this month vs the goal · top products · wilayas · funnel · sales channels · recent orders · activity.
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da, n, pct, when, wilayaName } from '../../lib/format';
import { openOrder } from '../../lib/modals';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { ErrorBox, Icon, Loading, StatusBadge } from '../../ui/kit';
import { AnyPeriod, inputsOf, rangeOf, useStored } from './util';

const PERIODS: AnyPeriod[] = ['today', 'yesterday', '7d', '30d', 'month', 'lastmonth', 'custom'];
// one orange family for the parts of a whole (top products / channels); "other" is neutral
const SHADES = ['#E8730C', '#F59E2B', '#F9C06A', '#FCDDAE'];
const OTHER = '#E6DED4';
const ORANGE = '#F28C1B';
const NAVY = '#1B2A47';

const delta = (cur: number | null, prev: number | null) => (cur === null || prev === null || prev === 0 ? null : (cur - prev) / prev);

function Delta({ v, pts }: { v: number | null; pts?: boolean }) {
  const { t } = useTranslation();
  if (v === null) return <span className="ov-delta">—</span>;
  const up = v >= 0;
  return (
    <span className={`ov-delta ${up ? 'up' : 'down'}`}>
      {up ? '▲' : '▼'} {pts ? `${Math.abs(v * 100).toFixed(1).replace('.', ',')} pts` : pct(Math.abs(v), 1)}
      <small>{t('dashboard.ov.vsPrev')}</small>
    </span>
  );
}

export function Overview() {
  const { t } = useTranslation();
  const [period, setPeriod] = useStored<AnyPeriod>('dash.ov.period', '30d');
  const p = PERIODS.includes(period) ? period : '30d';
  const [custom, setCustom] = useStored<{ from: string; to: string }>('dash.ov.custom', inputsOf(rangeOf('7d')));
  const range = useMemo(() => rangeOf(p, custom), [p, custom.from, custom.to]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = useRpc('stats.overview2', range, { refetchInterval: 60_000 });
  const D = q.data;
  return (
    <div className="ov">
      <div className="ov-head">
        <h2>{t('dashboard.ov.title')}</h2>
        <span className="ov-grow" />
        <select className="ov-sel" aria-label={t('dashboard.period')} value={p} onChange={(e) => setPeriod(e.target.value as AnyPeriod)}>
          {PERIODS.map((x) => (
            <option key={x} value={x}>
              {t(`dashboard.periods.${x}`)}
            </option>
          ))}
        </select>
        {p === 'custom' && (
          <span className="ov-dates">
            <input type="date" value={custom.from} max={custom.to} aria-label={t('common.from')} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
            <span className="muted">→</span>
            <input type="date" value={custom.to} min={custom.from} aria-label={t('common.to')} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
          </span>
        )}
      </div>
      {q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !D ? (
        <Loading />
      ) : (
        <div className="ov-grid">
          <section className="ov-card ov-k1 ov-hot">
            <div className="ov-kh">
              <span>{t('dashboard.ov.revenue')}</span>
              <span className="ov-ic">
                <Icon name="wallet" />
              </span>
            </div>
            <b className="ov-big ltr">{da(D.kpis.revenue)}</b>
            <Delta v={delta(D.kpis.revenue, D.kpis.revenuePrev)} />
          </section>
          <section className="ov-card ov-k2">
            <div className="ov-kh">
              <span>{t('dashboard.ov.received')}</span>
              <span className="ov-ic">
                <Icon name="list" />
              </span>
            </div>
            <b className="ov-big ltr">{n(D.kpis.received)}</b>
            <Delta v={delta(D.kpis.received, D.kpis.receivedPrev)} />
          </section>
          <section className="ov-card ov-k3">
            <div className="ov-kh">
              <span>{t('dashboard.ov.rate')}</span>
              <span className="ov-ic">
                <Icon name="truck" />
              </span>
            </div>
            <b className="ov-big ltr">{pct(D.kpis.deliveryRate)}</b>
            <Delta v={D.kpis.deliveryRate === null || D.kpis.deliveryRatePrev === null ? null : D.kpis.deliveryRate - D.kpis.deliveryRatePrev} pts />
          </section>

          <section className="ov-card ov-line">
            <div className="ov-ch">
              <h3>{t('dashboard.ov.perDay')}</h3>
              <span className="ov-leg">
                <i style={{ background: ORANGE }} /> {t('dashboard.ov.sReceived')}
                <i style={{ background: NAVY }} /> {t('dashboard.ov.sDelivered')}
              </span>
            </div>
            <LineChart data={D.series} />
          </section>

          <section className="ov-card ov-goal">
            <GoalCard month={D.month} />
          </section>

          <section className="ov-card ov-top">
            <div className="ov-ch">
              <h3>{t('dashboard.ov.topProducts')}</h3>
            </div>
            <Donut
              total={D.products.total}
              parts={[...D.products.top.map((x, i) => ({ label: x.name, value: x.value, color: SHADES[i] })), ...(D.products.other ? [{ label: t('dashboard.ov.other'), value: D.products.other, color: OTHER }] : [])]}
              centerLabel={t('dashboard.ov.deliveredValue')}
            />
          </section>

          <section className="ov-card ov-wil">
            <div className="ov-ch">
              <h3>{t('dashboard.ov.wilayas')}</h3>
              <span className="muted small">{t('dashboard.ov.ofReceived')}</span>
            </div>
            <div className="ov-bars">
              {D.wilayas.map((w) => (
                <div key={w.wilayaId} className="ov-bar">
                  <div className="ov-bar-l">
                    <span>{wilayaName(w.wilayaId)}</span>
                    <b className="ltr">{pct(D.kpis.received ? w.n / D.kpis.received : null)}</b>
                  </div>
                  <div className="ov-bar-t" title={`${wilayaName(w.wilayaId)} : ${n(w.n)}`}>
                    <i style={{ width: `${D.kpis.received ? (w.n / D.kpis.received) * 100 : 0}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="ov-card ov-fun">
            <div className="ov-ch">
              <h3>{t('dashboard.ov.funnel')}</h3>
              <span className="muted small">{t('dashboard.ov.funnelSub')}</span>
            </div>
            <Funnel f={D.funnel} />
          </section>

          <section className="ov-card ov-chan">
            <div className="ov-ch">
              <h3>{t('dashboard.ov.channels')}</h3>
            </div>
            <Channels list={D.channels} />
          </section>

          <section className="ov-card ov-rec">
            <div className="ov-ch">
              <h3>{t('dashboard.ov.recent')}</h3>
              <a className="ov-link" href="#/commandes">
                {t('dashboard.ov.seeAll')}
              </a>
            </div>
            <div className="tbl-wrap">
              <table className="tbl ov-tbl">
                <thead>
                  <tr>
                    <th>{t('dashboard.ov.cOrder')}</th>
                    <th>{t('dashboard.ov.cCustomer')}</th>
                    <th>{t('dashboard.ov.cProduct')}</th>
                    <th className="num">{t('dashboard.ov.cQty')}</th>
                    <th className="num">{t('dashboard.ov.cTotal')}</th>
                    <th>{t('dashboard.ov.cStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {D.recent.map((o) => (
                    <tr key={o.id} className="clickable" onClick={() => openOrder(o.id)}>
                      <td data-l={t('dashboard.ov.cOrder')}>
                        <b className="ltr">{o.ref}</b>
                        <small>{when(o.at)}</small>
                      </td>
                      <td data-l={t('dashboard.ov.cCustomer')}>{o.customer}</td>
                      <td data-l={t('dashboard.ov.cProduct')} className="px-cw">
                        <div className="px-clamp">{o.product || '—'}</div>
                      </td>
                      <td className="num" data-l={t('dashboard.ov.cQty')}>
                        {o.qty}
                      </td>
                      <td className="num ltr" data-l={t('dashboard.ov.cTotal')}>
                        {da(o.total)}
                      </td>
                      <td data-l={t('dashboard.ov.cStatus')}>{o.follow ? <StatusBadge kind="follow" status={o.follow} /> : <StatusBadge kind="conf" status={o.conf} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="ov-card ov-act">
            <div className="ov-ch">
              <h3>{t('dashboard.ov.activity')}</h3>
            </div>
            <ol className="ov-tl">
              {D.activity.map((e, i) => (
                <li key={i}>
                  <span className="ov-dot">
                    <Icon name={e.kind === 'created' ? 'plus' : e.kind === 'follow_status' ? 'truck' : 'phone'} />
                  </span>
                  <div>
                    <p>
                      {e.kind === 'created'
                        ? t('dashboard.ov.aCreated', { ref: e.ref })
                        : t('dashboard.ov.aStatus', {
                            who: e.who ?? t('dashboard.ov.system'),
                            ref: e.ref,
                            st: t(`${e.kind === 'follow_status' ? 'status.follow' : 'status.conf'}.${e.to}`, { defaultValue: e.to }),
                          })}
                    </p>
                    <small>{when(e.at)}</small>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- line chart (orders received / delivered per day, one axis)
function LineChart({ data }: { data: { day: string; received: number; delivered: number }[] }) {
  const { t, i18n } = useTranslation();
  const [hov, setHov] = useState<number | null>(null);
  const W = 640;
  const H = 220;
  const L = 34;
  const B = 24;
  const top = Math.max(4, ...data.map((d) => Math.max(d.received, d.delivered)));
  const step = Math.ceil(top / 4);
  const max = step * 4;
  const x = (i: number) => L + (i * (W - L - 8)) / Math.max(1, data.length - 1);
  const y = (v: number) => 8 + (H - B - 8) * (1 - v / max);
  const path = (k: 'received' | 'delivered') => {
    const pts = data.map((d, i) => [x(i), y(d[k])] as const);
    return pts.reduce((s, [px, py], i) => {
      if (!i) return `M${px},${py}`;
      const [qx, qy] = pts[i - 1];
      const mx = (qx + px) / 2;
      return `${s} C${mx},${qy} ${mx},${py} ${px},${py}`;
    }, '');
  };
  const every = Math.ceil(data.length / 7);
  const fmt = (d: string) => new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar-DZ' : i18n.language === 'en' ? 'en-GB' : 'fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions).format(Date.parse(d));
  const h = hov === null ? null : data[hov];
  return (
    <div className="ov-chart" onMouseLeave={() => setHov(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('dashboard.ov.perDay')}>
        {[0, 1, 2, 3, 4].map((k) => (
          <g key={k}>
            <line x1={L} x2={W - 8} y1={y(step * k)} y2={y(step * k)} className="ov-grid-l" />
            <text x={L - 6} y={y(step * k) + 4} textAnchor="end" className="ov-ax">
              {step * k}
            </text>
          </g>
        ))}
        {data.map((d, i) =>
          i % every === 0 ? (
            <text key={d.day} x={x(i)} y={H - 6} textAnchor="middle" className="ov-ax">
              {fmt(d.day)}
            </text>
          ) : null,
        )}
        {hov !== null && <rect x={x(hov) - 10} y={8} width={20} height={H - B - 8} rx={6} className="ov-hl" />}
        <path d={path('received')} fill="none" stroke={ORANGE} strokeWidth={2.5} strokeLinecap="round" />
        <path d={path('delivered')} fill="none" stroke={NAVY} strokeWidth={2} strokeLinecap="round" strokeDasharray="5 4" />
        {h && hov !== null && (
          <>
            <circle cx={x(hov)} cy={y(h.received)} r={5} fill={ORANGE} stroke="#fff" strokeWidth={2} />
            <circle cx={x(hov)} cy={y(h.delivered)} r={5} fill={NAVY} stroke="#fff" strokeWidth={2} />
          </>
        )}
        {data.map((d, i) => (
          <rect key={d.day} x={x(i) - (W - L) / data.length / 2} y={0} width={(W - L) / data.length} height={H} fill="transparent" onMouseEnter={() => setHov(i)} />
        ))}
      </svg>
      {h && hov !== null && (
        <div className="ov-tip" style={{ left: `${(x(hov) / W) * 100}%` }}>
          <b>{fmt(h.day)}</b>
          <span>
            <i style={{ background: ORANGE }} /> {t('dashboard.ov.sReceived')} <b className="ltr">{h.received}</b>
          </span>
          <span>
            <i style={{ background: NAVY }} /> {t('dashboard.ov.sDelivered')} <b className="ltr">{h.delivered}</b>
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- this month vs the goal (half gauge)
function GoalCard({ month }: { month: { revenue: number; prevSamePoint: number; goal: number } }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const [edit, setEdit] = useState(false);
  const [val, setVal] = useState(String(month.goal));
  const save = useAction('stats.setGoal', { success: t('dashboard.ov.goalSaved'), onDone: () => setEdit(false) });
  const r = month.goal > 0 ? Math.min(1, month.revenue / month.goal) : 0;
  const up = delta(month.revenue, month.prevSamePoint);
  const R = 80;
  const C = Math.PI * R;
  return (
    <>
      <div className="ov-ch">
        <h3>{t('dashboard.ov.goal')}</h3>
        {session?.isAdmin && (
          <button type="button" className="ov-mini" aria-label={t('dashboard.ov.editGoal')} title={t('dashboard.ov.editGoal')} onClick={() => setEdit(!edit)}>
            <Icon name="pencil" />
          </button>
        )}
      </div>
      {edit ? (
        <form
          className="ov-goalf"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ monthlyRevenue: Math.max(0, Math.round(Number(val) || 0)) });
          }}
        >
          <label className="field">
            <span className="lab">{t('dashboard.ov.goalLabel')}</span>
            <input type="number" min={0} step={10000} value={val} className="ltr" onChange={(e) => setVal(e.target.value)} />
          </label>
          <button className="btn primary" disabled={save.isPending}>
            {t('common.save')}
          </button>
        </form>
      ) : (
        <>
          <svg viewBox="0 0 200 116" className="ov-gauge" role="img" aria-label={`${t('dashboard.ov.goal')} ${pct(r)}`}>
            <defs>
              <linearGradient id="ovg" x1="0" x2="1">
                <stop offset="0" stopColor="#F7A823" />
                <stop offset="1" stopColor="#E8730C" />
              </linearGradient>
            </defs>
            <path d={`M20,100 A${R},${R} 0 0 1 180,100`} fill="none" stroke="#FCE3C6" strokeWidth={18} strokeLinecap="round" />
            <path d={`M20,100 A${R},${R} 0 0 1 180,100`} fill="none" stroke="url(#ovg)" strokeWidth={18} strokeLinecap="round" strokeDasharray={`${C * r} ${C}`} />
            <text x={100} y={88} textAnchor="middle" className="ov-gv">
              {pct(r)}
            </text>
          </svg>
          <p className="ov-gsub">{up === null ? t('dashboard.ov.goalNoPrev') : t(up >= 0 ? 'dashboard.ov.goalUp' : 'dashboard.ov.goalDown', { v: pct(Math.abs(up)) })}</p>
          <div className="ov-gfoot">
            <span>
              <small>{t('dashboard.ov.goalTarget')}</small>
              <b className="ltr">{da(month.goal)}</b>
            </span>
            <span>
              <small>{t('dashboard.ov.goalDone')}</small>
              <b className="ltr">{da(month.revenue)}</b>
            </span>
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- donut (parts of a whole, named in the legend)
function Donut({ parts, total, centerLabel }: { parts: { label: string; value: number; color: string }[]; total: number; centerLabel: string }) {
  const { t } = useTranslation();
  const [hov, setHov] = useState<number | null>(null);
  const R = 70;
  const C = 2 * Math.PI * R;
  let acc = 0;
  if (!total) return <p className="muted small">{t('dashboard.ov.none')}</p>;
  return (
    <>
      <div className="ov-donut">
        <svg viewBox="0 0 200 200" role="img" aria-label={centerLabel}>
          <circle cx={100} cy={100} r={R} fill="none" stroke="#F4EEE7" strokeWidth={26} />
          {parts.map((p, i) => {
            const len = (p.value / total) * C;
            const seg = (
              <circle
                key={i}
                cx={100}
                cy={100}
                r={R}
                fill="none"
                stroke={p.color}
                strokeWidth={hov === i ? 32 : 26}
                strokeDasharray={`${Math.max(0, len - 3)} ${C}`}
                strokeDashoffset={-acc}
                transform="rotate(-90 100 100)"
                onMouseEnter={() => setHov(i)}
                onMouseLeave={() => setHov(null)}
              >
                <title>{`${p.label} : ${da(p.value)}`}</title>
              </circle>
            );
            acc += len;
            return seg;
          })}
        </svg>
        <div className="ov-dc">
          <small>{hov === null ? centerLabel : parts[hov].label}</small>
          <b className="ltr">{da(hov === null ? total : parts[hov].value)}</b>
        </div>
      </div>
      <ul className="ov-legend">
        {parts.map((p, i) => (
          <li key={i} className={hov === i ? 'on' : ''} onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(null)}>
            <i style={{ background: p.color }} />
            <span className="px-clamp">{p.label}</span>
            <b className="ltr">{da(p.value)}</b>
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------- funnel (orders received in the period, how far they went)
function Funnel({ f }: { f: { received: number; called: number; confirmed: number; shipped: number; delivered: number } }) {
  const { t } = useTranslation();
  const steps = (['received', 'called', 'confirmed', 'shipped', 'delivered'] as const).map((k) => ({ k, v: f[k] }));
  const max = Math.max(1, f.received);
  return (
    <div className="ov-fun-g">
      {steps.map((s, i) => {
        const prev = i ? steps[i - 1].v : null;
        return (
          <div key={s.k} className="ov-fun-c" title={`${t(`dashboard.ov.f.${s.k}`)} : ${n(s.v)}`}>
            <small>{t(`dashboard.ov.f.${s.k}`)}</small>
            <b className="ltr">{n(s.v)}</b>
            <span className="ov-pill ltr">{i ? pct(prev ? s.v / prev : null) : '100 %'}</span>
            <div className="ov-fun-b">
              <i style={{ height: `${Math.max(4, (s.v / max) * 100)}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- sales channels (one stacked bar + list)
function Channels({ list }: { list: { channel: string; n: number }[] }) {
  const { t } = useTranslation();
  const total = list.reduce((s, c) => s + c.n, 0);
  const shown = list.slice(0, 4);
  const rest = list.slice(4).reduce((s, c) => s + c.n, 0);
  const parts = [...shown.map((c, i) => ({ label: t(`status.channel.${c.channel}`, { defaultValue: c.channel }), n: c.n, color: SHADES[i] })), ...(rest ? [{ label: t('dashboard.ov.other'), n: rest, color: OTHER }] : [])];
  if (!total) return <p className="muted small">{t('dashboard.ov.none')}</p>;
  return (
    <>
      <div className="ov-stack">
        {parts.map((p) => (
          <i key={p.label} style={{ flex: p.n, background: p.color }} title={`${p.label} : ${n(p.n)}`} />
        ))}
      </div>
      <ul className="ov-legend">
        {parts.map((p) => (
          <li key={p.label}>
            <i style={{ background: p.color }} />
            <span>{p.label}</span>
            <b className="ltr">{pct(p.n / total)}</b>
          </li>
        ))}
      </ul>
    </>
  );
}
