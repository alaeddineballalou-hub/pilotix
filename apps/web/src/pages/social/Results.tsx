// Pilot Content › Results: what the posts did. Meta's numbers (views, reach, likes, comments, shares, saves) and
// Pilotix's own (the comments Pilot Comments answered, the conversations they opened, the orders and the money they
// brought); this week against the one before with what to do next; the best posts (« Post again »); the best hours,
// days and kinds; the followers; every post. The numbers come from cm.plan.stats (modules/cmsocial.ts).
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out, rpc } from '../../lib/backend';
import { da, n, when } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { Card, ErrorBox, Icon, Kpi, Kpis, Loading, Trend } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { PeriodSwitch } from '../ai/agent';

type Stats = Out<'cm.plan.stats'>;
type Row = Stats['posts'][number];
type Days = 1 | 7 | 30 | 90;
const MARK = { facebook: { cls: 'dl-messenger', short: 'FB' }, instagram: { cls: 'dl-instagram', short: 'IG' } } as const;
const TYPE_ICON: Record<string, string> = { photo: 'image', carousel: 'layers', video: 'film', story: 'phone', text: 'message' };
const inter = (r: Row['results']) => r.likes + r.comments + r.shares + r.saves;
const ch = (a: number, b: number) => (b ? (a - b) / b : a ? 1 : null);

/** The calendar opens this draft when it loads (« Post again » from here). */
export const OPEN_KEY = 'px.social.open';

export function Results({ admin }: { admin: boolean }) {
  const { t, i18n } = useTranslation();
  const [days, setDays] = useState<Days>(30);
  const q = useRpc('cm.plan.stats', { days });
  const s = q.data;
  const [sort, setSort] = useState<'new' | 'orders' | 'views'>('new');
  const rows = useMemo(() => {
    const all = [...(s?.posts ?? [])];
    if (sort === 'orders') all.sort((a, b) => b.results.orders - a.results.orders || b.results.revenue - a.results.revenue);
    if (sort === 'views') all.sort((a, b) => b.results.views - a.results.views);
    return all;
  }, [s, sort]);
  if (q.isLoading) return <Loading />;
  if (q.error || !s) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const T = s.totals;
  const lng = i18n.language;
  const again = async (id: number) => {
    try {
      const r = await rpc('cm.plan.again', { id });
      try {
        sessionStorage.setItem(OPEN_KEY, String(r.post.id));
      } catch {
        // the calendar shows it on its day anyway
      }
      toast(r.mediaKept ? t('social.plan.ed.againOk') : t('social.plan.ed.againNoMedia'), 'ok');
      location.hash = '#/social/calendrier';
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    }
  };
  const fol = (['facebook', 'instagram'] as const).map((c) => ({ c, f: s.followers[c] })).filter((x) => x.f);
  const newFollowers = fol.reduce((a, x) => a + (x.f?.change ?? 0), 0);
  const day = (k: number) => new Intl.DateTimeFormat(lng === 'ar' ? 'ar-DZ' : lng === 'en' ? 'en-GB' : 'fr-FR', { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2026, 0, 4 + k));
  const W = s.week;
  return (
    <div className="sr">
      <Card title={t('social.res.title')} help={t('social.res.help')} actions={<PeriodSwitch value={days} onChange={(d) => setDays(d as Days)} />}>
        {!s.insights && s.posts.length > 0 && (
          <p className="sr-perm" role="note">
            <Icon name="info" />
            <span>{admin ? t('social.res.permAdmin') : t('social.res.noInsights')}</span>
          </p>
        )}
        <Kpis>
          <Kpi icon="send" label={t('social.res.k.posts')} value={n(T.posts)} sub={t('social.res.sub.posts', { n: s.posts.filter((p) => p.type === 'story').length })} />
          <Kpi icon="eye" label={t('social.res.k.views')} value={n(T.views)} sub={t('social.res.sub.reach', { n: n(T.reach) })} />
          <Kpi icon="heart" label={t('social.res.k.interactions')} value={n(T.interactions)} sub={t('social.res.sub.inter', { l: n(T.likes), c: n(T.comments), s: n(T.shares), v: n(T.saves) })} />
          <Kpi icon="users" label={t('social.res.k.followers')} value={`${newFollowers >= 0 ? '+' : ''}${n(newFollowers)}`} sub={fol.map((x) => `${MARK[x.c].short} ${n(x.f!.now)}`).join(' · ')} tone={newFollowers > 0 ? 'ok' : undefined} />
        </Kpis>
        <Kpis>
          <Kpi icon="comments" label={t('social.res.k.cmComments')} value={n(T.cmComments)} />
          <Kpi icon="mail" label={t('social.res.k.messages')} value={n(T.messages)} rate={T.cmComments ? T.messages / T.cmComments : null} />
          <Kpi icon="receipt" label={t('social.res.k.orders')} value={n(T.orders)} sub={t('social.res.sub.delivered', { n: n(T.delivered) })} tone={T.orders ? 'ok' : undefined} />
          <Kpi icon="coins" label={t('social.res.k.revenue')} value={da(T.revenue)} sub={T.orders ? t('social.res.sub.basket', { v: da(Math.round(T.revenue / T.orders)) }) : undefined} />
        </Kpis>
        <p className="muted small">{t('social.res.note')}</p>
      </Card>

      <div className="sr-two">
        <Card title={t('social.res.week')} help={t('social.res.vsWeek')} className="sr-week">
          <div className="sr-cmp">
            {(
              [
                ['posts', W.now.posts, W.prev.posts, n],
                ['views', W.now.views, W.prev.views, n],
                ['orders', W.now.orders, W.prev.orders, n],
                ['revenue', W.now.revenue, W.prev.revenue, da],
              ] as const
            ).map(([k, a, b, f]) => (
              <div key={k}>
                <small>{t(`social.res.k.${k}`)}</small>
                <b className="ltr">{f(a)}</b>
                <Trend v={ch(a, b)} />
              </div>
            ))}
          </div>
          {W.best && (
            <div className="sr-best1">
              <span className="pl-lab">{t('social.res.bestWeek')}</span>
              <PostLine p={W.best} lng={lng} onAgain={again} />
            </div>
          )}
          <span className="pl-lab">{t('social.res.todo')}</span>
          <ul className="sr-tips">
            {W.tips.map((x, k) => (
              <li key={k}>
                <Icon name={x.key === 'again' ? 'refresh' : x.key === 'hour' ? 'clock' : x.key === 'type' ? 'film' : x.key === 'event' ? 'calendar' : x.key === 'insights' ? 'key' : 'sparkles'} />
                <span>
                  {t(`social.res.tip.${x.key}`, {
                    hour: x.hour === undefined ? '' : `${String(x.hour).padStart(2, '0')}:00`,
                    type: x.type ? t(`social.res.type.${x.type}`) : '',
                    caption: x.caption ?? '',
                    n: x.n ?? 0,
                    event: x.event ? t(`social.ev.name.${x.event}`) : '',
                    days: x.inDays ?? 0,
                  })}
                </span>
                {x.key === 'again' && x.id && (
                  <button type="button" className="btn small" onClick={() => void again(x.id!)}>
                    {t('social.plan.ed.again')}
                  </button>
                )}
                {(x.key === 'quiet' || x.key === 'more') && (
                  <a className="btn small" href="#/social/calendrier">
                    {t('social.fill.button')}
                  </a>
                )}
              </li>
            ))}
            {!W.tips.length && <li className="muted">{t('social.res.allGood')}</li>}
          </ul>
        </Card>

        <Card title={t('social.res.top')}>
          {s.best.length ? s.best.map((p, k) => <PostLine key={p.id} p={p} lng={lng} rank={k + 1} onAgain={again} />) : <p className="muted">{t('social.res.none')}</p>}
        </Card>
      </div>

      <div className="sr-two">
        <Card title={t('social.res.when')} help={t('social.res.whenHelp')}>
          <Bars
            title={t('social.res.byHour')}
            rows={s.byHour.map((g) => ({ key: String(g.key), label: `${String(g.key).padStart(2, '0')}:00`, v: g.interactions, sub: t('social.res.nPosts', { n: g.posts }), best: g.key === s.bestHour, orders: g.orders }))}
          />
          <Bars title={t('social.res.byDay')} rows={s.byDay.map((g) => ({ key: String(g.key), label: day(g.key), v: g.interactions, sub: t('social.res.nPosts', { n: g.posts }), best: g.key === s.bestDay, orders: g.orders }))} />
        </Card>
        <Card title={t('social.res.kinds')}>
          <table className="sr-table">
            <thead>
              <tr>
                <th>{t('social.res.kind')}</th>
                <th>{t('social.res.k.posts')}</th>
                <th>{t('social.res.avgViews')}</th>
                <th>{t('social.res.avgInter')}</th>
                <th>{t('social.res.k.orders')}</th>
              </tr>
            </thead>
            <tbody>
              {s.byType.map((g) => (
                <tr key={g.key} className={g.key === s.bestType ? 'best' : ''}>
                  <td>
                    <Icon name={TYPE_ICON[g.key] ?? 'image'} />
                    {t(`social.res.type.${g.key}`)}
                    {g.key === s.bestType && <span className="sr-win">{t('social.res.winner')}</span>}
                  </td>
                  <td className="ltr">{n(g.posts)}</td>
                  <td className="ltr">{n(g.views)}</td>
                  <td className="ltr">{n(g.interactions)}</td>
                  <td className="ltr">{n(g.orders)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      {fol.length > 0 && (
        <Card title={t('social.res.followers')}>
          <Followers series={fol.map((x) => ({ c: x.c, pts: x.f!.series }))} lng={lng} />
          <div className="sr-legend">
            {fol.map((x) => (
              <span key={x.c}>
                <i className={`sr-dot ${x.c}`} />
                {t(`cm.ch.${x.c}`)} <b className="ltr">{n(x.f!.now)}</b> <Trend v={ch(x.f!.now, x.f!.now - x.f!.change)} />
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card
        title={t('social.res.all', { n: s.posts.length })}
        actions={
          <select className="sr-sort" value={sort} aria-label={t('social.res.sort')} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="new">{t('social.res.sortNew')}</option>
            <option value="orders">{t('social.res.sortOrders')}</option>
            <option value="views">{t('social.res.sortViews')}</option>
          </select>
        }
      >
        <div className="sr-scroll">
          <table className="sr-table sr-posts">
            <thead>
              <tr>
                <th>{t('social.res.post')}</th>
                <th>{t('social.res.k.views')}</th>
                <th>{t('social.res.k.reach')}</th>
                <th>{t('social.res.k.likes')}</th>
                <th>{t('social.res.k.comments')}</th>
                <th>{t('social.res.k.shares')}</th>
                <th>{t('social.res.k.saves')}</th>
                <th>{t('social.res.k.messages')}</th>
                <th>{t('social.res.k.orders')}</th>
                <th>{t('social.res.k.revenue')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="sr-post">
                      <Pic p={p} />
                      <span>
                        <b dir="auto">{p.kind === 'story' ? t('social.plan.ed.story') : p.caption.split('\n')[0] || t('social.plan.noCaption')}</b>
                        <small>
                          {p.publishedAt || p.publishAt ? when((p.publishedAt ?? p.publishAt)!) : ''} · {t(`social.res.type.${p.type}`)}
                          {p.channels.map((c) => (
                            <span key={c} className={`dl-ch pl-mini ${MARK[c].cls}`}>
                              {MARK[c].short}
                            </span>
                          ))}
                        </small>
                      </span>
                    </span>
                  </td>
                  <td className="ltr">{n(p.results.views)}</td>
                  <td className="ltr">{n(p.results.reach)}</td>
                  <td className="ltr">{n(p.results.likes)}</td>
                  <td className="ltr">{n(p.results.comments)}</td>
                  <td className="ltr">{n(p.results.shares)}</td>
                  <td className="ltr">{n(p.results.saves)}</td>
                  <td className="ltr">{n(p.results.messages)}</td>
                  <td className={`ltr${p.results.orders ? ' sr-ok' : ''}`}>{n(p.results.orders)}</td>
                  <td className="ltr">{p.results.revenue ? da(p.results.revenue) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="muted">{t('social.res.none')}</p>}
        </div>
        {s.updatedAt && <p className="muted small">{t('social.res.updated', { when: when(s.updatedAt) })}</p>}
      </Card>
    </div>
  );
}

function Pic({ p }: { p: Row }) {
  const src = p.photos[0]?.url;
  return src ? (
    <span className={`sr-pic${p.photos[0]?.kind === 'video' ? ' v' : ''}`}>
      <img src={src} alt="" loading="lazy" decoding="async" />
      {p.photos[0]?.kind === 'video' && <Icon name="play" />}
    </span>
  ) : (
    <span className="sr-pic none">
      <Icon name="message" />
    </span>
  );
}

/** One post with what it did, and « Post again ». */
function PostLine({ p, lng, rank, onAgain }: { p: Row; lng: string; rank?: number; onAgain: (id: number) => void }) {
  const { t } = useTranslation();
  const r = p.results;
  return (
    <div className="sr-line">
      {rank && <span className="sr-rank ltr">{rank}</span>}
      <Pic p={p} />
      <span className="sr-line-main">
        <b dir="auto">{p.kind === 'story' ? t('social.plan.ed.story') : p.caption.split('\n')[0] || t('social.plan.noCaption')}</b>
        <small>
          {p.publishedAt || p.publishAt ? new Intl.DateTimeFormat(lng === 'ar' ? 'ar-DZ' : lng === 'en' ? 'en-GB' : 'fr-FR', { day: 'numeric', month: 'short', timeZone: 'Africa/Algiers', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions).format(Date.parse((p.publishedAt ?? p.publishAt)!)) : ''} · {t(`social.res.type.${p.type}`)}
        </small>
        <span className="sr-nums">
          <span>
            <Icon name="eye" />
            <b className="ltr">{n(r.views)}</b>
          </span>
          <span>
            <Icon name="heart" />
            <b className="ltr">{n(inter(r))}</b>
          </span>
          <span className={r.orders ? 'win' : ''}>
            <Icon name="receipt" />
            <b className="ltr">{n(r.orders)}</b>
          </span>
          {r.revenue > 0 && <span className="ltr">{da(r.revenue)}</span>}
        </span>
      </span>
      <button type="button" className="btn small" onClick={() => onAgain(p.id)} title={t('social.plan.ed.againHint')}>
        <Icon name="refresh" />
        {t('social.plan.ed.again')}
      </button>
    </div>
  );
}

/** Horizontal bars (the average interactions per post), the best one marked; the orders beside. */
function Bars({ title, rows }: { title: string; rows: { key: string; label: string; v: number; sub: string; best: boolean; orders: number }[] }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...rows.map((r) => r.v));
  return (
    <div className="sr-bars">
      <span className="pl-lab">{title}</span>
      {rows.map((r) => (
        <div key={r.key} className={`sr-bar-row${r.best ? ' best' : ''}`}>
          <span className="sr-bar-l ltr">{r.label}</span>
          <span className="sr-bar" title={r.sub}>
            <i style={{ width: `${Math.max(3, Math.round((100 * r.v) / max))}%` }} />
          </span>
          <b className="ltr">{n(r.v)}</b>
          <small className="ltr" title={t('social.res.k.orders')}>
            {r.orders ? t('social.res.nOrders', { n: r.orders }) : ''}
          </small>
        </div>
      ))}
      {!rows.length && <p className="muted small">{t('social.res.none')}</p>}
    </div>
  );
}

/** The followers of each day, one line a network (a scale per line: the networks differ in size). */
function Followers({ series, lng }: { series: { c: 'facebook' | 'instagram'; pts: { day: string; n: number }[] }[]; lng: string }) {
  const W = 640;
  const H = 150;
  const P = 8;
  const days = [...new Set(series.flatMap((s) => s.pts.map((p) => p.day)))].sort();
  if (days.length < 2) return null;
  const x = (d: string) => P + ((W - 2 * P) * days.indexOf(d)) / (days.length - 1);
  const f = new Intl.DateTimeFormat(lng === 'ar' ? 'ar-DZ' : lng === 'en' ? 'en-GB' : 'fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions);
  return (
    <div className="sr-chart">
    <svg className="sr-line-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={series.map((s) => `${s.c} ${s.pts[s.pts.length - 1]?.n ?? ''}`).join(', ')}>
      {[0, 0.5, 1].map((k) => (
        <line key={k} x1={P} x2={W - P} y1={P + k * (H - 2 * P)} y2={P + k * (H - 2 * P)} className="sr-grid" vectorEffect="non-scaling-stroke" />
      ))}
      {series.map((s) => {
        const lo = Math.min(...s.pts.map((p) => p.n));
        const hi = Math.max(...s.pts.map((p) => p.n));
        const y = (v: number) => H - P - ((H - 2 * P) * (v - lo)) / Math.max(1, hi - lo);
        return <polyline key={s.c} className={`sr-pl ${s.c}`} fill="none" vectorEffect="non-scaling-stroke" points={s.pts.map((p) => `${x(p.day).toFixed(1)},${y(p.n).toFixed(1)}`).join(' ')} />;
      })}
    </svg>
      <div className="sr-ax ltr">
        <span>{f.format(Date.parse(days[0]))}</span>
        <span>{f.format(Date.parse(days[days.length - 1]))}</span>
      </div>
    </div>
  );
}
