// Pilot Content › Calendar: the shop's posts on a calendar. A month on a computer (the posts to approve and to fix,
// the next posts, the drafts and the Algerian calendar's days coming beside it, or the post being edited); on a phone the
// days with dots and the chosen day's posts under them. A post: a feed post or a story, its photos (made JPEG in the
// browser, ./jpeg.ts) or its video, Facebook and / or Instagram, the product it sells, a caption the AI can write and fix,
// its score out of 10, its first comment, its day and hour (the shop's fixed times, its best hours from its orders).
// Pilotix posts it then (the 'cm-plan' job), or at once; a post that went out can be deleted everywhere, its Facebook
// text changed, and « Post again ». A post is dragged to another day; « Fill my week » prepares a week of drafts.
import { DzEvent, dzEvents, nextSlot, postScore, SCORE_FIX, ScoreKey } from '@pilotix/shared';
import { DragEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, Out, rpc } from '../../lib/backend';
import { clock, da, fromLocalInput, toLocalInput, when } from '../../lib/format';
import { webHref } from '../../lib/safeHref';
import { useRpc } from '../../lib/query';
import { useIsPhone, useMedia } from '../../lib/useMedia';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { SHARP_W, toPlanPhoto } from './jpeg';
import { OPEN_KEY } from './Results';
import { readVideo, sendPieces, videoBody, VideoError } from './video';
import './planner.css';

type ListOut = Out<'cm.plan.list'>;
type Post = ListOut['rows'][number];
type Photo = Post['photos'][number];
type Channel = 'facebook' | 'instagram';
type Lang = 'darija' | 'fr' | 'ar';
type Status = Post['status'];
type Kind = Post['kind'];
/** a post not out yet can be moved to another day */
const MOVABLE: Status[] = ['draft', 'review', 'scheduled', 'failed'];

const CHANNELS: Channel[] = ['facebook', 'instagram'];
/** the videos picked in this browser (their player in the editor before the server has them, and in the preview) */
const localVideo = new Map<number, string>();
const mmss = (s: number | null | undefined) => (s == null ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const MARK: Record<Channel, { cls: string; short: string }> = { facebook: { cls: 'dl-messenger', short: 'FB' }, instagram: { cls: 'dl-instagram', short: 'IG' } };

// ---------------------------------------------------------------- days in Algeria (UTC+1 all year)
const DAY = 86_400_000;
const OFF = 3_600_000;
const dayOf = (t: number) => Math.floor((t + OFF) / DAY);
const startOf = (d: number) => d * DAY - OFF;
const ymdOf = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
const loc = (lng: string) => (lng === 'ar' ? 'ar-DZ' : lng === 'en' ? 'en-GB' : 'fr-FR');
const fmt = (lng: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(loc(lng), { timeZone: 'UTC', numberingSystem: 'latn', ...o } as Intl.DateTimeFormatOptions);
/** « 20:00 » in a day of the calendar: 24 hours in every language (it stays short) */
const hm = (iso: string | null) => (iso ? new Intl.DateTimeFormat('fr-FR', { timeZone: 'Africa/Algiers', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Date.parse(iso)) : '');

interface Grid {
  y: number;
  m: number;
  first: number;
  last: number;
  start: number;
  cells: number;
  from: string;
  to: string;
}

/** A month's weeks, Saturday first (Algeria's week). */
function monthGrid(y: number, m: number): Grid {
  const first = Date.UTC(y, m, 1) / DAY;
  const last = Date.UTC(y, m + 1, 0) / DAY;
  const lead = (new Date(first * DAY).getUTCDay() + 1) % 7;
  const start = first - lead;
  const cells = Math.ceil((lead + last - first + 1) / 7) * 7;
  return { y, m, first, last, start, cells, from: new Date(startOf(start)).toISOString(), to: new Date(startOf(start + cells)).toISOString() };
}

const hashtags = (s: string) => (s.match(/(^|[^\p{L}\p{N}_&])#[\p{L}\p{N}_]+/gu) ?? []).length;

/** the post's day: its time, or none (a draft without a day) */
const dayOfPost = (p: Post) => (p.publishAt ? dayOf(Date.parse(p.publishAt)) : null);

// ---------------------------------------------------------------- the editor's post
interface Draft {
  /** a new key each time the editor opens on another post */
  key: string;
  id?: number;
  post?: Post;
  caption: string;
  photos: Photo[];
  channels: Channel[];
  productId: number | null;
  /** <input type="datetime-local"> in Algeria's time; '' = no day */
  at: string;
  lang: Lang;
  idea: string;
  kind: Kind;
  /** the first comment under the post (feed posts), on or not */
  commentOn: boolean;
  comment: string;
  /** the Algerian calendar's day it is made for */
  eventKey: string | null;
}

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** A day's first posting time: its fixed time (Réglages), else the shop's best hour, else 20:00. */
function dayTime(data: ListOut, day: number): number {
  const wd = new Date(day * DAY).getUTCDay();
  const slots = data.settings.slots.filter((x) => x.days.includes(wd)).map((x) => minutesOf(x.time)).sort((a, b) => a - b);
  const future = slots.find((m) => startOf(day) + m * 60_000 > Date.now() + 10 * 60_000);
  let t = startOf(day) + (future ?? slots[0] ?? (data.bestHours[0]?.hour ?? 20) * 60) * 60_000;
  // a time already past today: the next full hour
  if (t < Date.now() + 10 * 60_000) t = Math.ceil((Date.now() + 10 * 60_000) / 3_600_000) * 3_600_000;
  return t;
}

/** the good hours for the score: the shop's best hours from its orders and its fixed times */
const goodHours = (data: ListOut) => [...new Set([...data.bestHours.map((h) => h.hour), ...data.settings.slots.map((x) => Number(x.time.slice(0, 2)))])];

/** the planned times already taken (the next free fixed time skips them) */
const takenOf = (data: ListOut, except?: number) =>
  [...data.rows, ...data.drafts, ...data.next, ...data.review].filter((p) => p.id !== except && p.publishAt && p.status !== 'failed').map((p) => Date.parse(p.publishAt!));

function newDraft(data: ListOut, day: number | null, lng: string, extra: Partial<Draft> = {}): Draft {
  return {
    key: `new-${Date.now()}`,
    caption: '',
    photos: [],
    channels: CHANNELS.filter((c) => (c === 'facebook' ? data.accounts.facebook : data.accounts.instagram)),
    productId: null,
    at: day === null ? '' : toLocalInput(dayTime(data, day)),
    lang: lng === 'ar' ? 'ar' : 'darija',
    idea: '',
    kind: 'post',
    commentOn: data.settings.firstComment.on,
    comment: data.settings.firstComment.text,
    eventKey: null,
    ...extra,
  };
}

const draftOf = (p: Post, lang: Lang): Draft => ({
  key: `p-${p.id}-${p.updatedAt}`,
  id: p.id,
  post: p,
  caption: p.caption,
  photos: p.photos,
  channels: p.channels,
  productId: p.productId,
  at: p.publishAt ? toLocalInput(Date.parse(p.publishAt)) : '',
  lang: p.aiLang ?? lang,
  idea: '',
  kind: p.kind,
  commentOn: !!p.firstComment,
  comment: p.firstComment ?? '',
  eventKey: p.eventKey,
});

// ---------------------------------------------------------------- the page
/** `onLinked`: told whether a Facebook Page or an Instagram account is linked (the page's « on » mark). */
export function Planner({ onLinked }: { onLinked?: (linked: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const phone = useIsPhone();
  // the post beside the calendar on a big screen; above it (a window, a sheet on a phone) elsewhere
  const wide = useMedia('(min-width: 1360px)');
  const [month, setMonth] = useState(() => {
    const d = new Date(Date.now() + OFF);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
  });
  const [net, setNet] = useState<'' | Channel>('');
  const [sel, setSel] = useState(() => dayOf(Date.now()));
  const [open, setOpen] = useState<Draft | null>(null);
  const [fill, setFill] = useState(false);
  const grid = useMemo(() => monthGrid(month.y, month.m), [month]);
  // the Algerian calendar's days in the month shown, and the ones coming (45 days)
  const events = useMemo(() => {
    const m = new Map<number, DzEvent[]>();
    for (const e of dzEvents(ymdOf(grid.start), ymdOf(grid.start + grid.cells - 1))) {
      const d = Date.parse(e.date) / DAY;
      m.set(d, [...(m.get(d) ?? []), e]);
    }
    return m;
  }, [grid]);
  const coming = useMemo(() => dzEvents(ymdOf(dayOf(Date.now())), ymdOf(dayOf(Date.now()) + 45)).slice(0, 4), []);
  const q = useRpc('cm.plan.list', { from: grid.from, to: grid.to }, { refetchInterval: 30_000 });
  const data = q.data;
  const linked = data ? !!(data.accounts.facebook || data.accounts.instagram) : undefined;
  useEffect(() => {
    if (linked !== undefined) onLinked?.(linked);
  }, [linked]); // eslint-disable-line react-hooks/exhaustive-deps
  // « Post again » from Results: the new draft opens here
  useEffect(() => {
    if (!data) return;
    let id = 0;
    try {
      id = Number(sessionStorage.getItem(OPEN_KEY)) || 0;
      if (id) sessionStorage.removeItem(OPEN_KEY);
    } catch {
      // nothing to open
    }
    if (!id) return;
    const lang: Lang = lng === 'ar' ? 'ar' : 'darija';
    const p = [...data.rows, ...data.drafts, ...data.review, ...data.next, ...data.failed].find((x) => x.id === id);
    if (p) setOpen(draftOf(p, lang));
    else
      rpc('cm.plan.get', { id })
        .then((x) => setOpen(draftOf(x as Post, lang)))
        .catch(() => null);
  }, [!!data]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = dayOf(Date.now());
  const shown = (p: Post) => !net || p.channels.includes(net);
  const rows = (data?.rows ?? []).filter(shown);
  const byDay = useMemo(() => {
    const m = new Map<number, Post[]>();
    for (const p of rows) {
      const d = dayOfPost(p);
      if (d !== null) m.set(d, [...(m.get(d) ?? []), p]);
    }
    return m;
  }, [rows]);
  const go = (k: number) => {
    const d = new Date(Date.UTC(month.y, month.m + k, 1));
    setMonth({ y: d.getUTCFullYear(), m: d.getUTCMonth() });
    if (k === 0) setSel(today);
  };
  const goToday = () => {
    const d = new Date(Date.now() + OFF);
    setMonth({ y: d.getUTCFullYear(), m: d.getUTCMonth() });
    setSel(today);
  };
  if (q.isLoading) return <Loading />;
  if (q.error || !data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const inMonth = rows.filter((p) => {
    const d = dayOfPost(p);
    return d !== null && d >= grid.first && d <= grid.last;
  });
  const count = (s: Status) => inMonth.filter((p) => p.status === s).length;
  const fix = data.failed.filter(shown);
  const next = data.next.filter(shown);
  const drafts = data.drafts.filter(shown);
  const review = data.review.filter(shown);
  const fallback: Lang = lng === 'ar' ? 'ar' : 'darija';
  const openPost = (p: Post) => setOpen(draftOf(p, fallback));
  const openNew = (day: number | null) => setOpen(newDraft(data, day, lng));
  // a day of the Algerian calendar: a post with its idea, planned before it (customers buy ahead)
  const openEvent = (e: DzEvent) => {
    const day = Math.max(today, Date.parse(e.date) / DAY - e.lead);
    setOpen(newDraft(data, day, lng, { idea: t(`social.ev.idea.${e.key}`), eventKey: e.key }));
  };
  const done = () => {
    setOpen(null);
    void q.refetch();
  };
  // a post dragged to another day: its hour stays (a draft without a day takes the day's first time)
  const moveTo = async (id: number, day: number) => {
    const p = [...data.rows, ...data.drafts, ...data.review, ...data.failed].find((x) => x.id === id);
    if (!p || !MOVABLE.includes(p.status)) return;
    const at = p.publishAt ? startOf(day) + ((Date.parse(p.publishAt) + OFF) % DAY) : dayTime(data, day);
    if (at < Date.now() + 60_000) return toast(t('social.plan.mv.past'), 'bad');
    if (p.publishAt && Math.abs(Date.parse(p.publishAt) - at) < 60_000) return;
    try {
      await rpc('cm.plan.move', { id, publishAt: new Date(at).toISOString() });
      toast(t('social.plan.mv.done', { when: when(new Date(at).toISOString()) }), 'ok');
      void q.refetch();
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    }
  };
  const title = fmt(lng, { month: 'long', year: 'numeric' }).format(Date.UTC(month.y, month.m, 1));
  const lists = (
    <>
      {review.length > 0 && (
        <section className="pl-box pl-box-review">
          <h3>
            <Icon name="checkcircle" />
            {data.isAdmin ? t('social.plan.review') : t('social.plan.reviewMine')}
          </h3>
          {review.map((p) => (
            <PostRow key={p.id} p={p} onOpen={openPost} withDay drag={!phone} />
          ))}
        </section>
      )}
      {fix.length > 0 && (
        <section className="pl-box pl-box-fix">
          <h3>
            <Icon name="alert" />
            {t('social.plan.fix')}
          </h3>
          {fix.map((p) => (
            <PostRow key={p.id} p={p} onOpen={openPost} />
          ))}
        </section>
      )}
      <section className="pl-box">
        <h3>
          <Icon name="clock" />
          {t('social.plan.upcoming')}
        </h3>
        {next.length ? next.map((p) => <PostRow key={p.id} p={p} onOpen={openPost} withDay />) : <p className="pl-hint">{t('social.plan.upcomingNone')}</p>}
      </section>
      {drafts.length > 0 && (
        <section className="pl-box">
          <h3>
            <Icon name="pencil" />
            {t('social.plan.drafts')}
          </h3>
          {drafts.map((p) => (
            <PostRow key={p.id} p={p} onOpen={openPost} drag={!phone} />
          ))}
          {!phone && <p className="pl-hint">{t('social.plan.dragHint')}</p>}
        </section>
      )}
      {coming.length > 0 && (
        <section className="pl-box pl-box-ev">
          <h3>
            <Icon name="calendar" />
            {t('social.ev.coming')}
          </h3>
          {coming.map((e) => (
            <div key={e.key + e.date} className="pl-evrow">
              <span className="pl-evrow-t">
                <b>
                  {t(`social.ev.name.${e.key}`)}
                  {e.approx ? ' ≈' : ''}
                </b>
                <small>{t('social.ev.when', { date: fmt(lng, { weekday: 'short', day: 'numeric', month: 'long' }).format(Date.parse(e.date)), n: Math.round(Date.parse(e.date) / DAY - today) })}</small>
              </span>
              <button type="button" className="btn small" onClick={() => openEvent(e)}>
                <Icon name="sparkles" />
                {t('social.ev.prepare')}
              </button>
            </div>
          ))}
        </section>
      )}
    </>
  );
  const selPosts = byDay.get(sel) ?? [];
  return (
    <div className="pl">
      <div className="pl-bar">
        <div className="pl-nav">
          <button type="button" className="btn ghost pl-ico" aria-label={t('social.plan.prev')} onClick={() => go(-1)}>
            <Icon name="chevl" />
          </button>
          <h2 aria-live="polite">{title}</h2>
          <button type="button" className="btn ghost pl-ico" aria-label={t('social.plan.next')} onClick={() => go(1)}>
            <Icon name="chevr" />
          </button>
          <button type="button" className="btn small" onClick={goToday}>
            {t('social.plan.today')}
          </button>
        </div>
        <div className="pl-seg" role="group" aria-label={t('social.plan.network')}>
          {(['', ...CHANNELS] as const).map((c) => (
            <button key={c || 'all'} type="button" aria-pressed={net === c} onClick={() => setNet(c)}>
              {c ? <span className={`dl-ch pl-mini ${MARK[c].cls}`}>{MARK[c].short}</span> : null}
              {c ? t(`cm.ch.${c}`) : t('social.plan.all')}
            </button>
          ))}
        </div>
        <span className="pl-tools">
          <button type="button" className="btn pl-fillbtn" onClick={() => setFill(true)}>
            <Icon name="sparkles" />
            {t('social.fill.button')}
          </button>
          <button type="button" className="btn primary pl-new" onClick={() => openNew(phone ? sel : today)}>
            <Icon name="plus" />
            {t('social.plan.new')}
          </button>
        </span>
      </div>
      <p className="pl-sum">
        <span>{t('social.plan.sumPlanned', { n: count('scheduled') })}</span>
        <span>{t('social.plan.sumOut', { n: count('published') })}</span>
        {fix.length > 0 && <span className="pl-fixn">{t('social.plan.sumFix', { n: fix.length })}</span>}
        {data.accounts.demo && <span>{t('social.plan.demo')}</span>}
      </p>
      <div className={`pl-main${wide ? '' : ' one'}`}>
        <div className="pl-left">
          <MonthGrid grid={grid} byDay={byDay} events={events} today={today} compact={phone} sel={sel} onSel={setSel} onAdd={openNew} onOpen={openPost} onEvent={openEvent} onMove={(id, d) => void moveTo(id, d)} lng={lng} />
          {phone && (
            <section className="pl-box pl-dayposts">
              <h3>{fmt(lng, { weekday: 'long', day: 'numeric', month: 'long' }).format(sel * DAY)}</h3>
              {(events.get(sel) ?? []).map((e) => (
                <button key={e.key} type="button" className="pl-evchip big" onClick={() => openEvent(e)}>
                  <Icon name="sparkles" />
                  {t(`social.ev.name.${e.key}`)}
                  {e.approx ? ' ≈' : ''}
                  <span>{t('social.ev.prepare')}</span>
                </button>
              ))}
              {selPosts.map((p) => (
                <PostRow key={p.id} p={p} onOpen={openPost} />
              ))}
              {sel >= today && (
                <button type="button" className="btn pl-addday" onClick={() => openNew(sel)}>
                  <Icon name="plus" />
                  {t('social.plan.addHere')}
                </button>
              )}
              {!selPosts.length && sel < today && <p className="pl-hint">{t('social.plan.nothing')}</p>}
            </section>
          )}
          {!wide && lists}
        </div>
        {wide && <aside className="pl-side">{open ? <EditorHost key={open.key} start={open} data={data} wide onClose={() => setOpen(null)} onDone={done} onOpen={(p) => { void q.refetch(); openPost(p); }} /> : lists}</aside>}
      </div>
      {!wide && open && <EditorHost key={open.key} start={open} data={data} wide={false} onClose={() => setOpen(null)} onDone={done} onOpen={(p) => { void q.refetch(); openPost(p); }} />}
      {fill && <FillWeek data={data} lng={lng} onClose={() => setFill(false)} onDone={() => void q.refetch()} onOpen={(p) => { setFill(false); openPost(p); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- the calendar
function MonthGrid({
  grid,
  byDay,
  events,
  today,
  compact,
  sel,
  onSel,
  onAdd,
  onOpen,
  onEvent,
  onMove,
  lng,
}: {
  grid: Grid;
  byDay: Map<number, Post[]>;
  events: Map<number, DzEvent[]>;
  today: number;
  compact: boolean;
  sel: number;
  onSel: (d: number) => void;
  onAdd: (d: number) => void;
  onOpen: (p: Post) => void;
  onEvent: (e: DzEvent) => void;
  onMove: (id: number, day: number) => void;
  lng: string;
}) {
  const { t } = useTranslation();
  const [over, setOver] = useState<number | null>(null);
  // 3 Jan 2026 is a Saturday: the 7 day names from there
  const names = Array.from({ length: 7 }, (_, k) => fmt(lng, { weekday: compact ? 'narrow' : 'short' }).format(Date.UTC(2026, 0, 3 + k)));
  const long = fmt(lng, { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <div className={`pl-cal${compact ? ' compact' : ''}`}>
      <div className="pl-wd" aria-hidden="true">
        {names.map((n, k) => (
          <span key={k}>{n}</span>
        ))}
      </div>
      <div className="pl-weeks">
        {Array.from({ length: grid.cells }, (_, k) => {
          const d = grid.start + k;
          const posts = byDay.get(d) ?? [];
          const evs = events.get(d) ?? [];
          const cls = ['pl-day', d < grid.first || d > grid.last ? 'out' : '', d === today ? 'today' : '', d < today ? 'past' : '', compact && d === sel ? 'sel' : '', over === d ? 'drop' : '', evs.length ? 'ev' : ''].filter(Boolean).join(' ');
          const n = new Date(d * DAY).getUTCDate();
          if (compact)
            return (
              <button key={d} type="button" className={cls} aria-pressed={d === sel} aria-label={`${long.format(d * DAY)}${posts.length ? ` · ${t('social.plan.posts', { n: posts.length })}` : ''}`} onClick={() => onSel(d)}>
                <span className="pl-dn">{n}</span>
                {evs.length > 0 && <i className="pl-evdot" aria-hidden="true" />}
                <span className="pl-dots" aria-hidden="true">
                  {posts.slice(0, 3).map((p) => (
                    <i key={p.id} className={`pl-dot s-${p.status}`} />
                  ))}
                </span>
              </button>
            );
          const extra = posts.length > 3 ? posts.length - 2 : 0;
          const drop =
            d >= today
              ? {
                  onDragOver: (e: DragEvent) => {
                    if (!e.dataTransfer.types.includes('text/plain')) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (over !== d) setOver(d);
                  },
                  onDragLeave: () => setOver((o) => (o === d ? null : o)),
                  onDrop: (e: DragEvent) => {
                    e.preventDefault();
                    setOver(null);
                    const id = Number(e.dataTransfer.getData('text/plain'));
                    if (id) onMove(id, d);
                  },
                }
              : {};
          return (
            <div key={d} className={cls} {...drop}>
              {d >= today ? (
                <button type="button" className="pl-dn" aria-label={t('social.plan.addOn', { day: long.format(d * DAY) })} onClick={() => onAdd(d)}>
                  {n}
                </button>
              ) : (
                <span className="pl-dn">{n}</span>
              )}
              {d >= today && (
                <button type="button" className="pl-add" tabIndex={-1} aria-hidden="true" onClick={() => onAdd(d)}>
                  <Icon name="plus" />
                </button>
              )}
              {evs.map((e) => (
                <button key={e.key} type="button" className="pl-evchip" title={`${t(`social.ev.name.${e.key}`)}${e.approx ? ` · ${t('social.ev.approx')}` : ''}`} onClick={() => onEvent(e)}>
                  <Icon name="sparkles" />
                  <span>{t(`social.ev.short.${e.key}`)}</span>
                </button>
              ))}
              {(extra ? posts.slice(0, 2) : posts).map((p) => (
                <Chip key={p.id} p={p} onOpen={onOpen} />
              ))}
              {extra > 0 && (
                <button type="button" className="pl-more" onClick={() => onOpen(posts[2])}>
                  {t('social.plan.more', { n: extra })}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Thumb({ p, cls }: { p: Post; cls?: string }) {
  const src = p.photos[0]?.url;
  if (!src)
    return (
      <span className={`pl-noimg ${cls ?? ''}`} aria-hidden="true">
        <Icon name="message" />
      </span>
    );
  if (p.photos[0]?.kind !== 'video') return <img className={cls} src={src} alt="" loading="lazy" decoding="async" />;
  return (
    <span className={`pl-thumbv ${cls ?? ''}`}>
      <img src={src} alt="" loading="lazy" decoding="async" />
      <Icon name="play" />
    </span>
  );
}

function Nets({ p }: { p: Post }) {
  return (
    <span className="pl-nets">
      {p.channels.map((c) => {
        const st = c === 'facebook' ? p.facebook : p.instagram;
        return (
          <span key={c} className={`dl-ch pl-mini ${MARK[c].cls}${st?.error ? ' bad' : ''}`}>
            {MARK[c].short}
          </span>
        );
      })}
    </span>
  );
}

/** what lets a post be dragged to another day */
const dragOf = (p: Post, on = true) =>
  on && MOVABLE.includes(p.status)
    ? {
        draggable: true,
        onDragStart: (e: DragEvent) => {
          e.dataTransfer.setData('text/plain', String(p.id));
          e.dataTransfer.effectAllowed = 'move';
        },
      }
    : {};

function Chip({ p, onOpen }: { p: Post; onOpen: (p: Post) => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className={`pl-chip s-${p.status}${p.kind === 'story' ? ' story' : ''}`} title={`${t(`social.plan.status.${p.status}`)}${p.kind === 'story' ? ` · ${t('social.plan.ed.story')}` : ''} · ${p.caption.slice(0, 80)}`} onClick={() => onOpen(p)} {...dragOf(p)}>
      <Thumb p={p} />
      <time dateTime={p.publishAt ?? undefined}>{hm(p.publishAt)}</time>
      <Nets p={p} />
    </button>
  );
}

function StatusChip({ s }: { s: Status }) {
  const { t } = useTranslation();
  return <span className={`pl-st s-${s}`}>{t(`social.plan.status.${s}`)}</span>;
}

function PostRow({ p, onOpen, withDay, drag }: { p: Post; onOpen: (p: Post) => void; withDay?: boolean; drag?: boolean }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="pl-row" onClick={() => onOpen(p)} {...dragOf(p, !!drag)}>
      <Thumb p={p} />
      <span className="pl-row-main">
        <span className="pl-row-top">
          <time dateTime={p.publishAt ?? undefined}>{p.publishAt ? (withDay ? when(p.publishAt) : clock(p.publishAt)) : t('social.plan.noDay')}</time>
          <Nets p={p} />
          <StatusChip s={p.status} />
        </span>
        <span className="pl-row-cap" dir="auto">
          {p.kind === 'story' ? <i>{t('social.plan.ed.story')}</i> : p.caption || <i>{t('social.plan.noCaption')}</i>}
        </span>
        {p.status === 'failed' && <FailWhy p={p} />}
      </span>
    </button>
  );
}

/** A post that did not go out: its file(s), as named on the device they were picked on, and why (in a few words). */
function FailWhy({ p }: { p: Post }) {
  const { t } = useTranslation();
  const names = p.photos.map((x) => x.name).filter(Boolean);
  const missed = p.channels.filter((c) => !(c === 'facebook' ? p.facebook : p.instagram)?.done);
  const why = missed.map((c) => (c === 'facebook' ? p.facebook : p.instagram)?.error ?? '').find(Boolean) ?? '';
  return (
    <span className="pl-row-why">
      <b className="pl-file" dir="ltr">
        <Icon name={p.photos[0]?.kind === 'video' ? 'film' : 'image'} />
        {names.length ? names.join(', ') : t('social.plan.noName')}
      </b>
      {missed.length > 0 && (
        <span>
          {t('social.plan.notOn', { nets: missed.map((c) => t(`cm.ch.${c}`)).join(' + ') })}
          {why ? ` · ${why.split(' (')[0]}` : ''}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- the editor
function EditorHost({ start, data, wide, onClose, onDone, onOpen }: { start: Draft; data: ListOut; wide: boolean; onClose: () => void; onDone: () => void; onOpen: (p: Post) => void }) {
  const ed = useEditor(start, data, onDone, onOpen);
  if (wide)
    return (
      <section className="pl-box pl-ed" aria-label={ed.title}>
        <div className="pl-ed-head">
          <h3>{ed.title}</h3>
          {ed.status && <StatusChip s={ed.status} />}
          {ed.badge}
          <button type="button" className="btn ghost pl-ico" aria-label={ed.closeLabel} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="pl-ed-body">{ed.body}</div>
        <div className="pl-foot">{ed.foot}</div>
      </section>
    );
  return (
    <Modal
      sheet
      wide
      className="pl-modal"
      title={
        <span className="pl-mtitle">
          {ed.title} {ed.status && <StatusChip s={ed.status} />} {ed.badge}
        </span>
      }
      onClose={onClose}
      footer={<div className="pl-foot">{ed.foot}</div>}
    >
      <div className="pl-ed-body">{ed.body}</div>
    </Modal>
  );
}

function useEditor(start: Draft, data: ListOut, onDone: () => void, onOpen: (p: Post) => void): { title: string; status: Status | null; body: ReactNode; foot: ReactNode; closeLabel: string; badge: ReactNode } {
  const { t, i18n } = useTranslation();
  const [d, setD] = useState<Draft>(start);
  const [busy, setBusy] = useState<'' | 'draft' | 'schedule' | 'now' | 'ai' | 'photo' | 'video' | 'delete' | 'fb' | 'fix' | 'again' | 'back'>('');
  const [note, setNote] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const [sure, setSure] = useState(false);
  const [tried, setTried] = useState<'' | 'draft' | 'schedule' | 'now'>('');
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!sure) return;
    const k = window.setTimeout(() => setSure(false), 4000);
    return () => window.clearTimeout(k);
  }, [sure]);
  const set = (patch: Partial<Draft>) => setD((o) => ({ ...o, ...patch }));
  const post = d.post;
  const status = post?.status ?? null;
  const out = status === 'published';
  const going = status === 'publishing';
  const locked = out || going;
  const ig = d.channels.includes('instagram');
  const fbOut = !!post?.facebook?.done;
  const lim = data.limits;
  const max = ig ? lim.igCaption : lim.fbCaption;
  const tags = hashtags(d.caption);
  const over = d.caption.length > max || (ig && tags > lim.hashtags);
  const story = d.kind === 'story';
  const admin = data.isAdmin;
  // a marketer's post waits for the administrator's yes (Réglages)
  const ask = data.settings.approval && !admin;
  // the same rules as the server (modules/cmplan.ts), in the person's language
  const clip = d.photos.find((p) => p.kind === 'video') ?? null;
  const problems: string[] = [];
  if (!d.channels.length) problems.push(t('social.plan.pb.channels'));
  if (story) {
    if (d.photos.length !== 1) problems.push(t('social.plan.pb.storyOne'));
    if (clip && (clip.duration ?? 0) > lim.storyVideoMax) problems.push(t('social.plan.pb.storyLong', { max: lim.storyVideoMax }));
  } else {
    if (!d.caption.trim() && !d.photos.length) problems.push(t('social.plan.pb.empty'));
    if (clip && d.photos.length > 1) problems.push(t('social.plan.pb.mix'));
    if (ig && !d.photos.length) problems.push(t('social.plan.pb.igPhoto'));
    if (ig && d.photos.some((p) => p.kind !== 'video' && p.w / Math.max(1, p.h) < 0.795)) problems.push(t('social.plan.pb.tall'));
    if (ig && d.caption.length > lim.igCaption) problems.push(t('social.plan.pb.igLong', { max: lim.igCaption }));
    if (ig && tags > lim.hashtags) problems.push(t('social.plan.pb.igTags', { max: lim.hashtags }));
  }
  const whenProblem = !d.at ? t('social.plan.pb.when') : Date.parse(fromLocalInput(d.at)) < Date.now() + 60_000 ? t('social.plan.pb.past') : null;
  const fields = () => ({
    caption: story ? '' : d.caption,
    photos: d.photos.map((p) => p.id),
    channels: d.channels,
    productId: d.productId,
    publishAt: d.at ? fromLocalInput(d.at) : null,
    lang: d.lang,
    kind: d.kind,
    firstComment: !story && d.commentOn && d.comment.trim() ? d.comment.trim() : null,
    eventKey: d.eventKey,
  });
  // the score out of 10, as the post is now
  const product = data.products.find((p) => p.id === d.productId) ?? null;
  const hours = goodHours(data);
  const sc = postScore({ kind: d.kind, caption: d.caption, media: d.photos.map((p) => ({ kind: p.kind, w: p.w, h: p.h })), price: product ? product.price : null, at: d.at ? fromLocalInput(d.at) : null, hours });
  const failed = sc.checks.filter((c) => !c.ok).map((c) => c.key);
  const fixable = failed.filter((k) => SCORE_FIX[k] === 'caption' || SCORE_FIX[k] === 'hour');
  const free = nextSlot(data.settings.slots, Date.now() + 5 * 60_000, takenOf(data, d.id));

  const save = async (mode: 'draft' | 'schedule' | 'now') => {
    setTried(mode);
    if (mode !== 'draft' && problems.length) return;
    if (mode === 'schedule' && whenProblem) return;
    setBusy(mode);
    try {
      const r = await rpc('cm.plan.save', { id: d.id, ...fields(), schedule: mode === 'schedule' });
      if (mode === 'schedule' && r.status === 'review') {
        toast(t('social.plan.ed.asked'), 'ok');
        onDone();
        return;
      }
      if (mode === 'now') {
        const p = await rpc('cm.plan.publishNow', { id: r.id });
        if (p.status === 'published' || p.status === 'publishing') {
          toast(p.status === 'published' ? t('social.plan.ed.posted') : t('social.plan.ed.preparingIg'), 'ok');
          onDone();
        } else {
          toast(t('social.plan.ed.notPosted'), 'bad');
          setD(draftOf(p.post, d.lang));
        }
      } else {
        toast(mode === 'schedule' ? t('social.plan.ed.planned', { when: when(fromLocalInput(d.at)) }) : t('social.plan.ed.saved'), 'ok');
        onDone();
      }
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy('');
    }
  };
  const retry = async () => {
    if (!d.id) return;
    setBusy('now');
    try {
      // the edits first (a post not out yet), then it goes
      if (!locked) await rpc('cm.plan.save', { id: d.id, ...fields(), schedule: false });
      const p = await rpc('cm.plan.publishNow', { id: d.id });
      if (p.status === 'published' || p.status === 'publishing') {
        toast(p.status === 'published' ? t('social.plan.ed.posted') : t('social.plan.ed.preparingIg'), 'ok');
        onDone();
      } else {
        toast(t('social.plan.ed.notPosted'), 'bad');
        setD(draftOf(p.post, d.lang));
      }
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy('');
    }
  };
  const remove = async () => {
    if (!d.id) return onDone();
    if (!sure) return setSure(true);
    setBusy('delete');
    try {
      await rpc('cm.plan.delete', { id: d.id });
      toast(t('social.plan.ed.deleted'), 'ok');
      onDone();
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
      setSure(false);
    } finally {
      setBusy('');
    }
  };
  const saveFb = async () => {
    if (!d.id) return;
    setBusy('fb');
    try {
      await rpc('cm.plan.editPosted', { id: d.id, caption: d.caption });
      toast(t('social.plan.ed.saved'), 'ok');
      onDone();
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy('');
    }
  };
  const write = async () => {
    setBusy('ai');
    try {
      const r = await rpc('cm.plan.caption', { productId: d.productId, idea: d.idea, lang: d.lang, channels: d.channels.length ? d.channels : CHANNELS, current: d.caption });
      set({ caption: r.caption });
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy('');
    }
  };
  // « Fix it »: the AI adds what the caption misses (keeping the rest), and the next good time when the hour is not one
  const fixIt = async () => {
    setBusy('fix');
    try {
      const patch: Partial<Draft> = {};
      const words = fixable.filter((k) => SCORE_FIX[k] === 'caption') as ScoreKey[];
      if (words.length && !story) {
        const r = await rpc('cm.plan.caption', { productId: d.productId, idea: d.idea, lang: d.lang, channels: d.channels.length ? d.channels : CHANNELS, current: d.caption, fix: words });
        patch.caption = r.caption;
      }
      if (fixable.includes('hour')) {
        const at = free ?? dayTime(data, d.at ? dayOf(Date.parse(fromLocalInput(d.at))) : dayOf(Date.now()));
        patch.at = toLocalInput(at);
      }
      set(patch);
      toast(t('social.score.fixed'), 'ok');
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy('');
    }
  };
  // « Post again »: a new draft from this post, opened at once
  const again = async () => {
    if (!d.id) return;
    setBusy('again');
    try {
      const r = await rpc('cm.plan.again', { id: d.id, lang: d.lang });
      toast(r.mediaKept ? t('social.plan.ed.againOk') : t('social.plan.ed.againNoMedia'), 'ok');
      onOpen(r.post);
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy('');
    }
  };
  // the administrator sends a post back to its writer, with a word
  const sendBack = async () => {
    if (!d.id) return;
    if (note === null) return setNote('');
    setBusy('back');
    try {
      await rpc('cm.plan.review', { id: d.id, approve: false, note: note.trim() });
      toast(t('social.plan.ed.sentBack'), 'ok');
      onDone();
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy('');
    }
  };
  // a video: the original file, its index first, sent in pieces (./video.ts), then ready on the server
  const addVideo = async (f: File) => {
    if (f.size > lim.videoBytes) return toast(t('social.plan.ed.videoBig'), 'bad');
    const longest = story ? lim.storyVideoMax : lim.videoMax;
    setBusy('video');
    setPct(0);
    try {
      let meta;
      try {
        meta = await readVideo(f);
      } catch (e) {
        toast(t(e instanceof VideoError && e.code === 'type' ? 'social.plan.ed.videoType' : 'social.plan.ed.videoBad'), 'bad');
        return;
      }
      if (meta.duration < lim.videoMin || meta.duration > longest) {
        URL.revokeObjectURL(meta.local);
        toast(meta.duration < lim.videoMin ? t('social.plan.ed.videoShort') : story ? t('social.plan.pb.storyLong', { max: lim.storyVideoMax }) : t('social.plan.ed.videoLong'), 'bad');
        return;
      }
      const r = await rpc('cm.plan.videoStart', { mime: meta.mime, size: f.size, w: meta.w, h: meta.h, duration: meta.duration, thumb: meta.thumb, name: f.name });
      localVideo.set(r.id, meta.local);
      let item: Photo = { id: r.id, kind: r.kind, w: r.w, h: r.h, url: r.url, video: r.video, duration: r.duration, ready: r.ready, name: r.name };
      if (r.upload) {
        if (!backend.upload) throw new Error(t('social.plan.ed.videoLost'));
        const body = await videoBody(f, meta.mime);
        await sendPieces(body, r.chunk, (part, piece) => backend.upload!(`/cm/video/${r.id}/${r.key}?part=${part}`, piece), setPct);
        item = await rpc('cm.plan.videoDone', { id: r.id });
      }
      setD((o) => ({ ...o, photos: [item] }));
    } catch (e: any) {
      // the file's name, to pick the same one again
      toast(`${t('social.plan.ed.videoLostName', { name: f.name })}${e?.message ? ` (${e.message})` : ''}`, 'bad');
    } finally {
      setBusy('');
      setPct(0);
    }
  };
  const addPhotos = async (files: FileList | null) => {
    const all = Array.from(files ?? []);
    if (file.current) file.current.value = '';
    const isVid = (f: File) => f.type.startsWith('video/') || /\.(mp4|m4v|mov)$/i.test(f.name);
    const vids = all.filter(isVid);
    // a post holds photos or one video
    if (vids.length && (vids.length < all.length || d.photos.length)) return toast(t('social.plan.ed.mixNo'), 'bad');
    if (!vids.length && clip) return toast(t('social.plan.ed.mixNo'), 'bad');
    if (vids.length) {
      if (vids.length > 1) toast(t('social.plan.ed.oneVideo'), 'bad');
      return addVideo(vids[0]);
    }
    // a story holds one photo
    const list = all.slice(0, Math.max(0, (story ? 1 : lim.photos) - d.photos.length));
    if (!list.length) return;
    setBusy('photo');
    let cut = false;
    try {
      for (const f of list) {
        let ph;
        try {
          ph = await toPlanPhoto(f, { story });
        } catch {
          toast(t('social.plan.ed.photoBad'), 'bad');
          continue;
        }
        cut ||= ph.cropped;
        const r = await rpc('cm.plan.photo', { jpeg: ph.jpeg, thumb: ph.thumb, w: ph.w, h: ph.h, story, name: f.name });
        setD((o) => ({ ...o, photos: [...o.photos, r] }));
      }
      if (cut) toast(t('social.plan.ed.cropped'), 'ok');
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy('');
    }
  };
  const move = (k: number, by: number) =>
    setD((o) => {
      const ps = [...o.photos];
      const j = k + by;
      if (j < 0 || j >= ps.length) return o;
      [ps[k], ps[j]] = [ps[j], ps[k]];
      return { ...o, photos: ps };
    });
  const toggle = (c: Channel) => set({ channels: d.channels.includes(c) ? d.channels.filter((x) => x !== c) : CHANNELS.filter((x) => x === c || d.channels.includes(x)) });
  const atHour = (h: number) => {
    const day = d.at ? dayOf(Date.parse(fromLocalInput(d.at))) : dayOf(Date.now());
    let t0 = startOf(day) + h * 3_600_000;
    if (t0 < Date.now() + 60_000) t0 += DAY;
    set({ at: toLocalInput(t0) });
  };
  const acc = data.accounts;
  const nets = post ? CHANNELS.filter((c) => d.channels.includes(c) && (c === 'facebook' ? post.facebook : post.instagram)) : [];

  const res = post?.results ?? null;
  const scorePanel = (
    <div className={`pl-sec pl-score s${sc.score >= 8 ? 'ok' : sc.score >= 5 ? 'mid' : 'low'}`}>
      <div className="pl-score-top">
        <span className="pl-score-n" aria-label={t('social.score.label', { n: sc.score })}>
          <b>{sc.score}</b>
          <small>/10</small>
        </span>
        <span className="pl-score-t">
          <b>{t('social.score.title')}</b>
          <small>{sc.score === 10 ? t('social.score.perfect') : t('social.score.sub', { n: failed.length })}</small>
        </span>
        {!locked && fixable.length > 0 && (
          <button type="button" className={`btn small primary${busy === 'fix' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void fixIt()}>
            <Icon name="sparkles" />
            {t('social.score.fix')}
          </button>
        )}
      </div>
      <ul className="pl-checks">
        {sc.checks.map((c) => (
          <li key={c.key} className={c.ok ? 'ok' : 'no'}>
            <Icon name={c.ok ? 'checkcircle' : 'xcircle'} />
            <span>{t(`social.score.k.${c.key}`)}</span>
            {!c.ok && <small>{t(`social.score.how.${SCORE_FIX[c.key]}`)}</small>}
          </li>
        ))}
      </ul>
    </div>
  );
  const body = (
    <>
      {post?.reviewNote && status === 'draft' && (
        <div className="pl-sec pl-note" role="note">
          <Icon name="message" />
          <span>
            <b>{t('social.plan.ed.noteFrom')}</b> {post.reviewNote}
          </span>
        </div>
      )}
      {status === 'review' && (
        <div className="pl-sec pl-note wait" role="note">
          <Icon name="clock" />
          <span>{admin ? t('social.plan.ed.reviewAdmin') : t('social.plan.ed.reviewWait')}</span>
        </div>
      )}
      {res && (out || post?.facebook?.done || post?.instagram?.done) && (
        <div className="pl-sec pl-res">
          <span className="pl-lab">{t('social.plan.ed.results')}</span>
          <div className="pl-res-grid">
            {(
              [
                ['eye', 'views', res.views],
                ['users', 'reach', res.reach],
                ['heart', 'likes', res.likes],
                ['comments', 'comments', res.comments],
                ['share', 'shares', res.shares],
                ['bookmark', 'saves', res.saves],
                ['mail', 'messages', res.messages],
                ['receipt', 'orders', res.orders],
              ] as const
            ).map(([icon, k, v]) => (
              <span key={k} className={k === 'orders' && v ? 'win' : ''}>
                <Icon name={icon} />
                <b className="ltr">{v.toLocaleString('fr-FR')}</b>
                <small>{t(`social.res.k.${k}`)}</small>
              </span>
            ))}
          </div>
          {res.revenue > 0 && <p className="pl-hint">{t('social.plan.ed.revenue', { amount: da(res.revenue) })}</p>}
          {!res.insights && <p className="pl-hint">{t('social.res.noInsights')}</p>}
        </div>
      )}
      {!locked && (
        <div className="pl-sec">
          <span className="pl-lab">{t('social.plan.ed.format')}</span>
          <div className="pl-kind" role="radiogroup" aria-label={t('social.plan.ed.format')}>
            {(['post', 'story'] as Kind[]).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={d.kind === k} onClick={() => set({ kind: k })}>
                <Icon name={k === 'post' ? 'image' : 'phone'} />
                <span>
                  <b>{t(`social.plan.ed.kind.${k}`)}</b>
                  <small>{t(`social.plan.ed.kindHint.${k}`)}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {post && nets.length > 0 && (status === 'published' || status === 'failed' || post.facebook?.done || post.instagram?.done) && (
        <div className="pl-sec">
          {nets.map((c) => {
            const st = (c === 'facebook' ? post.facebook : post.instagram)!;
            const href = webHref(st.url);
            return (
              <div key={c} className={`pl-net-st ${st.done ? 'ok' : st.error ? 'bad' : ''}`}>
                <span className={`dl-ch pl-mini ${MARK[c].cls}`}>{MARK[c].short}</span>
                <span>
                  {st.done ? t('social.plan.ed.isOut', { net: t(`cm.ch.${c}`) }) : st.error ?? t('social.plan.ed.waiting')}
                  {st.done && href && (
                    <>
                      {' · '}
                      <a href={href} target="_blank" rel="noreferrer">
                        {t('social.plan.ed.open')}
                        <Icon name="external" />
                      </a>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="pl-sec">
        <span className="pl-lab">{t('social.plan.ed.where')}</span>
        <div className="pl-netpick">
          {CHANNELS.map((c) => {
            const a = c === 'facebook' ? acc.facebook : acc.instagram;
            const name = c === 'facebook' ? acc.facebook?.name : acc.instagram?.username ? `@${acc.instagram.username}` : '';
            const on = d.channels.includes(c);
            return (
              <button key={c} type="button" className="pl-net" aria-pressed={on} disabled={locked || !a} title={!a ? t(`social.plan.ed.${c === 'facebook' ? 'fbOff' : 'igOff'}`) : undefined} onClick={() => toggle(c)}>
                <span className={`dl-ch pl-mini ${MARK[c].cls}`}>{MARK[c].short}</span>
                <span className="pl-net-t">
                  <b>{t(`cm.ch.${c}`)}</b>
                  <small dir="auto">{a ? name || t('social.plan.ed.linked') : t('social.plan.ed.notLinked')}</small>
                </span>
                <Icon name={on ? 'checkcircle' : 'plus'} className="pl-net-i" />
              </button>
            );
          })}
        </div>
        {(!acc.facebook || !acc.instagram) && (
          <p className="pl-hint">
            {t('social.plan.ed.linkHint')} <a href="#/comptes">{t('social.plan.ed.linkGo')}</a>
          </p>
        )}
      </div>
      <div className="pl-sec">
        <span className="pl-lab">{t('social.plan.ed.media')}</span>
        <div className="pl-photos">
          {d.photos.map((p, k) => (
            <figure key={p.id} className={`pl-ph${p.kind === 'video' ? ' pl-vid' : ''}`}>
              {p.url ? <img src={p.url} alt={p.kind === 'video' ? t('social.plan.ed.video') : t('social.plan.ed.photoN', { n: k + 1 })} /> : <span className="pl-noimg" />}
              {k === 0 && d.photos.length > 1 && <span className="pl-ph-first">{t('social.plan.ed.first')}</span>}
              {p.kind === 'video' ? (
                <>
                  <span className="pl-ph-play" aria-hidden="true">
                    <Icon name="play" />
                  </span>
                  <span className="pl-ph-q" title={t('social.plan.ed.size', { w: p.w, h: p.h })}>
                    {mmss(p.duration)}
                  </span>
                </>
              ) : (
                <span className={`pl-ph-q${p.w < SHARP_W ? ' low' : ''}`} title={t('social.plan.ed.size', { w: p.w, h: p.h })}>
                  {p.w < SHARP_W ? <Icon name="alert" /> : 'HD'}
                </span>
              )}
              {!locked && (
                <span className="pl-ph-tools">
                  {p.kind !== 'video' && (
                    <button type="button" aria-label={t('social.plan.ed.left')} disabled={k === 0} onClick={() => move(k, -1)}>
                      <Icon name="chevl" />
                    </button>
                  )}
                  <button type="button" aria-label={t('social.plan.ed.remove')} onClick={() => set({ photos: d.photos.filter((x) => x.id !== p.id) })}>
                    <Icon name="trash" />
                  </button>
                  {p.kind !== 'video' && (
                    <button type="button" aria-label={t('social.plan.ed.right')} disabled={k === d.photos.length - 1} onClick={() => move(k, 1)}>
                      <Icon name="chevr" />
                    </button>
                  )}
                </span>
              )}
            </figure>
          ))}
          {!locked && !clip && d.photos.length < (story ? 1 : lim.photos) && (
            <label className={`pl-ph-add${busy === 'photo' || busy === 'video' ? ' busy' : ''}`}>
              <input ref={file} type="file" accept="image/*,video/mp4,video/quicktime,.mp4,.m4v,.mov" multiple hidden disabled={busy === 'photo' || busy === 'video'} onChange={(e) => void addPhotos(e.target.files)} />
              <Icon name={busy === 'photo' || busy === 'video' ? 'refresh' : 'upload'} />
              <span>{busy === 'video' ? t('social.plan.ed.videoUp', { pct: Math.round(pct * 100) }) : busy === 'photo' ? t('social.plan.ed.preparing') : d.photos.length ? t('social.plan.ed.addMore') : t('social.plan.ed.addPhotos')}</span>
              {busy === 'video' && (
                <span className="pl-bar-up" aria-hidden="true">
                  <i style={{ width: `${Math.round(pct * 100)}%` }} />
                </span>
              )}
            </label>
          )}
        </div>
        {d.photos.some((x) => x.name) && (
          <p className="pl-files" dir="ltr">
            <Icon name={clip ? 'film' : 'image'} />
            {d.photos
              .map((x) => x.name)
              .filter(Boolean)
              .join(', ')}
          </p>
        )}
        {!locked && clip && !clip.ready && busy !== 'video' && (
          <div className="pl-again">
            <span>{t('social.plan.ed.notWhole', { name: clip.name || t('social.plan.ed.video') })}</span>
            <button
              type="button"
              className="btn small primary"
              onClick={() => {
                // the video comes out of the post, and the picker opens for the same file
                set({ photos: d.photos.filter((x) => x.id !== clip.id) });
                setTimeout(() => file.current?.click(), 0);
              }}
            >
              <Icon name="upload" />
              {clip.name ? t('social.plan.ed.pickAgainName', { name: clip.name }) : t('social.plan.ed.pickAgain')}
            </button>
          </div>
        )}
        {clip && (clip.video || localVideo.get(clip.id)) && (
          <video className="pl-player" controls preload="metadata" playsInline poster={clip.url ?? undefined} src={clip.video ?? localVideo.get(clip.id)} />
        )}
        {!locked && <p className="pl-hint">{story ? t('social.plan.ed.storyHint') : clip ? t('social.plan.ed.videoHint') : t('social.plan.ed.photosHint')}</p>}
        {!locked && d.photos.some((p) => p.kind !== 'video' && p.w < SHARP_W) && <p className="pl-hint pl-lowq">{t('social.plan.ed.small', { w: SHARP_W })}</p>}
      </div>
      <div className="pl-sec">
        <label className="pl-lab" htmlFor={`pl-prod-${d.key}`}>
          {t('social.plan.ed.product')}
        </label>
        <select id={`pl-prod-${d.key}`} value={d.productId ?? ''} disabled={locked} onChange={(e) => set({ productId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">{t('social.plan.ed.noProduct')}</option>
          {data.products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {da(p.price)}
            </option>
          ))}
        </select>
        <p className="pl-hint">{t('social.plan.ed.productHint')}</p>
      </div>
      {story && scorePanel}
      {!story && (
      <div className="pl-sec pl-cap">
        <label className="pl-lab" htmlFor={`pl-cap-${d.key}`}>
          {t('social.plan.ed.caption')}
        </label>
        {!out && !going && (
          <div className="pl-ai">
            <input type="text" value={d.idea} maxLength={500} placeholder={t('social.plan.ed.ideaPh')} aria-label={t('social.plan.ed.idea')} onChange={(e) => set({ idea: e.target.value })} />
            <select aria-label={t('social.plan.ed.lang')} value={d.lang} onChange={(e) => set({ lang: e.target.value as Lang })}>
              {(['darija', 'fr', 'ar'] as Lang[]).map((l) => (
                <option key={l} value={l}>
                  {t(`social.plan.ed.langs.${l}`)}
                </option>
              ))}
            </select>
            <button type="button" className={`btn pl-aibtn${busy === 'ai' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void write()}>
              <Icon name="sparkles" />
              {data.ai ? (d.caption.trim() ? t('social.plan.ed.rewrite') : t('social.plan.ed.write')) : t('social.plan.ed.example')}
            </button>
          </div>
        )}
        {!data.ai && !locked && <p className="pl-hint">{t('social.plan.ed.exampleHint')}</p>}
        <textarea id={`pl-cap-${d.key}`} dir="auto" value={d.caption} maxLength={lim.fbCaption} readOnly={going || (out && !fbOut)} onChange={(e) => set({ caption: e.target.value })} placeholder={t('social.plan.ed.capPh')} />
        <span className={`pl-count${over ? ' over' : ''}`}>{t('social.plan.ed.count', { n: d.caption.length, max, tags })}</span>
        {out && post?.instagram?.done && <p className="pl-hint">{t('social.plan.ed.igNoEdit')}</p>}
      </div>
      )}
      {!story && scorePanel}
      {!story && (!locked || post?.comment) && (
        <div className="pl-sec pl-fc">
          <label className="pl-check">
            <input type="checkbox" checked={d.commentOn} disabled={locked} onChange={(e) => set({ commentOn: e.target.checked })} />
            <span>
              <b>{t('social.plan.ed.fc')}</b>
              <small>{t('social.plan.ed.fcHint')}</small>
            </span>
          </label>
          {d.commentOn && <input type="text" dir="auto" value={d.comment} maxLength={lim.firstComment} readOnly={locked} aria-label={t('social.plan.ed.fc')} onChange={(e) => set({ comment: e.target.value })} />}
          {post?.comment && (post.comment.facebook || post.comment.instagram) && (
            <p className="pl-hint pl-ok">
              <Icon name="checkcircle" />
              {t('social.plan.ed.fcOut', { nets: CHANNELS.filter((c) => (c === 'facebook' ? post.comment!.facebook : post.comment!.instagram)).map((c) => t(`cm.ch.${c}`)).join(' · ') })}
            </p>
          )}
          {post?.comment?.error && <p className="pl-hint pl-lowq">{post.comment.error}</p>}
        </div>
      )}
      {!locked && (
        <div className="pl-sec">
          <label className="pl-lab" htmlFor={`pl-at-${d.key}`}>
            {t('social.plan.ed.when')}
          </label>
          <input id={`pl-at-${d.key}`} type="datetime-local" className="ltr" value={d.at} min={toLocalInput(Date.now() + 60_000)} onChange={(e) => set({ at: e.target.value })} />
          {free !== null && (
            <div className="pl-hours">
              <span>{t('social.plan.ed.free')}</span>
              <button type="button" onClick={() => set({ at: toLocalInput(free) })}>
                {fmt(i18n.language, { weekday: 'short', day: 'numeric' }).format(free + OFF)} · {hm(new Date(free).toISOString())}
              </button>
            </div>
          )}
          {data.bestHours.length > 0 && (
            <div className="pl-hours">
              <span>{t('social.plan.ed.best')}</span>
              {data.bestHours.map((h) => (
                <button key={h.hour} type="button" title={t('social.plan.ed.bestN', { n: h.orders })} onClick={() => atHour(h.hour)}>
                  {String(h.hour).padStart(2, '0')}:00
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );

  const del = d.id ? (
    <button type="button" className={`btn ghost danger${busy === 'delete' ? ' busy' : ''}`} disabled={!!busy || going} onClick={() => void remove()}>
      <Icon name="trash" />
      {sure ? t('social.plan.ed.sure') : post?.facebook?.done || post?.instagram?.done ? t('social.plan.ed.deleteAll') : t('social.plan.ed.delete')}
    </button>
  ) : null;
  // what stops it, next to the buttons (the time only matters when it is planned)
  const shownProblems = tried === 'schedule' ? [...problems, ...(whenProblem ? [whenProblem] : [])] : tried === 'now' ? problems : [];
  const probs =
    !locked && shownProblems.length > 0 ? (
      <ul className="pl-probs" role="alert">
        {shownProblems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    ) : null;
  const againBtn = (
    <button type="button" className={`btn${fbOut && !story ? '' : ' primary'}${busy === 'again' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void again()}>
      <Icon name="refresh" />
      {t('social.plan.ed.again')}
    </button>
  );
  const acts = out ? (
    <>
      {fbOut && !story && (
        <button type="button" className={`btn primary${busy === 'fb' ? ' busy' : ''}`} disabled={!!busy || !d.caption.trim() || d.caption === post?.caption} onClick={() => void saveFb()}>
          {t('social.plan.ed.saveFb')}
        </button>
      )}
      {againBtn}
      <span className="grow" />
      {del}
    </>
  ) : status === 'review' && admin ? (
    <>
      <button type="button" className={`btn primary${busy === 'schedule' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void save('schedule')}>
        <Icon name="checkcircle" />
        {t('social.plan.ed.approve')}
      </button>
      {note !== null && <input className="pl-noteinp" type="text" dir="auto" autoFocus value={note} maxLength={300} placeholder={t('social.plan.ed.notePh')} aria-label={t('social.plan.ed.notePh')} onChange={(e) => setNote(e.target.value)} />}
      <button type="button" className={`btn${busy === 'back' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void sendBack()}>
        <Icon name="undo" />
        {note === null ? t('social.plan.ed.sendBack') : t('social.plan.ed.sendBackGo')}
      </button>
      <span className="grow" />
      {del}
    </>
  ) : going ? (
    <p className="pl-hint">{t('social.plan.ed.going')}</p>
  ) : status === 'failed' ? (
    <>
      <button type="button" className={`btn primary${busy === 'now' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void retry()}>
        <Icon name="refresh" />
        {t('social.plan.ed.retry')}
      </button>
      <button type="button" className={`btn${busy === 'schedule' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void save('schedule')}>
        {t('social.plan.ed.schedule')}
      </button>
      <span className="grow" />
      {del}
    </>
  ) : (
    <>
      <button type="button" className={`btn primary${busy === 'schedule' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void save('schedule')}>
        <Icon name={ask ? 'send' : 'calendar'} />
        {ask ? (status === 'review' ? t('social.plan.ed.saveReview') : t('social.plan.ed.ask')) : t('social.plan.ed.schedule')}
      </button>
      {!ask && (
        <button type="button" className={`btn${busy === 'now' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void save('now')}>
          <Icon name="send" />
          {t('social.plan.ed.postNow')}
        </button>
      )}
      <button type="button" className={`btn ghost${busy === 'draft' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void save('draft')}>
        {status === 'review' ? t('social.plan.ed.backDraft') : t('social.plan.ed.saveDraft')}
      </button>
      <span className="grow" />
      {del}
    </>
  );
  const foot = (
    <>
      {probs}
      <div className="pl-acts">{acts}</div>
    </>
  );
  const badge = (
    <span className={`pl-score-b s${sc.score >= 8 ? 'ok' : sc.score >= 5 ? 'mid' : 'low'}`} title={t('social.score.title')}>
      {sc.score}/10
    </span>
  );
  return { title: d.id ? (story ? t('social.plan.ed.editStory') : t('social.plan.ed.edit')) : story ? t('social.plan.ed.newStory') : t('social.plan.ed.new'), status, body, foot, closeLabel: t('common.close'), badge };
}

// ---------------------------------------------------------------- « Fill my week »
/** The AI prepares a week of drafts (cm.plan.fillWeek); the person looks at them, then plans them at once. */
function FillWeek({ data, lng, onClose, onDone, onOpen }: { data: ListOut; lng: string; onClose: () => void; onDone: () => void; onOpen: (p: Post) => void }) {
  const { t } = useTranslation();
  const [count, setCount] = useState(5);
  const [lang, setLang] = useState<Lang>(lng === 'ar' ? 'ar' : 'darija');
  const [busy, setBusy] = useState<'' | 'write' | 'plan'>('');
  const [made, setMade] = useState<{ posts: Post[]; why: string[] } | null>(null);
  const hours = goodHours(data);
  const write = async () => {
    setBusy('write');
    try {
      const r = await rpc('cm.plan.fillWeek', { count, lang });
      setMade({ posts: r.posts as Post[], why: r.why });
      onDone();
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy('');
    }
  };
  const planAll = async () => {
    if (!made) return;
    setBusy('plan');
    try {
      const r = await rpc('cm.plan.planMany', { ids: made.posts.map((p) => p.id) });
      toast(r.review ? t('social.fill.asked', { n: r.review }) : t('social.fill.planned', { n: r.planned }), 'ok');
      if (r.skipped.length) toast(t('social.fill.skipped', { n: r.skipped.length, why: r.skipped[0].problem }), 'bad');
      onDone();
      onClose();
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy('');
    }
  };
  const slots = data.settings.slots;
  const footer = made ? (
    <div className="pl-acts">
      <button type="button" className={`btn primary${busy === 'plan' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void planAll()}>
        <Icon name="calendar" />
        {data.settings.approval && !data.isAdmin ? t('social.fill.askAll') : t('social.fill.planAll')}
      </button>
      <button type="button" className="btn ghost" onClick={onClose}>
        {t('social.fill.later')}
      </button>
    </div>
  ) : (
    <div className="pl-acts">
      <button type="button" className={`btn primary${busy === 'write' ? ' busy' : ''}`} disabled={!!busy} onClick={() => void write()}>
        <Icon name="sparkles" />
        {busy === 'write' ? t('social.fill.writing', { n: count }) : t('social.fill.go', { n: count })}
      </button>
      <button type="button" className="btn ghost" onClick={onClose}>
        {t('common.cancel')}
      </button>
    </div>
  );
  return (
    <Modal title={t('social.fill.title')} onClose={onClose} className="pl-fillm" footer={footer}>
      {!made ? (
        <div className="pl-fill">
          <p className="pl-fill-intro">{t('social.fill.intro')}</p>
          <ul className="pl-fill-how">
            {(['best', 'new', 'quiet', 'event'] as const).map((k) => (
              <li key={k}>
                <Icon name={k === 'best' ? 'trophy' : k === 'new' ? 'sparkles' : k === 'quiet' ? 'history' : 'calendar'} />
                <span>{t(`social.fill.how.${k}`)}</span>
              </li>
            ))}
          </ul>
          <div className="pl-fill-pick">
            <span className="pl-lab">{t('social.fill.count')}</span>
            <div className="pl-seg" role="radiogroup" aria-label={t('social.fill.count')}>
              {[3, 5, 7].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={count === n} aria-pressed={count === n} onClick={() => setCount(n)}>
                  {t('social.fill.posts', { n })}
                </button>
              ))}
            </div>
            <label className="pl-lab" htmlFor="pl-fill-lang">
              {t('social.plan.ed.lang')}
            </label>
            <select id="pl-fill-lang" value={lang} onChange={(e) => setLang(e.target.value as Lang)}>
              {(['darija', 'fr', 'ar'] as Lang[]).map((l) => (
                <option key={l} value={l}>
                  {t(`social.plan.ed.langs.${l}`)}
                </option>
              ))}
            </select>
          </div>
          <p className="pl-hint">
            {slots.length ? t('social.fill.onSlots', { times: [...new Set(slots.map((x) => x.time))].join(' · ') }) : t('social.fill.onBest', { h: `${String(hours[0] ?? 20).padStart(2, '0')}:00` })}
          </p>
        </div>
      ) : (
        <div className="pl-fill">
          <p className="pl-fill-intro">{t('social.fill.done', { n: made.posts.length })}</p>
          {made.posts.map((p, k) => {
            const product = data.products.find((x) => x.id === p.productId) ?? null;
            const sc = postScore({ kind: p.kind, caption: p.caption, media: p.photos.map((m) => ({ kind: m.kind, w: m.w, h: m.h })), price: product ? product.price : null, at: p.publishAt, hours });
            const why = made.why[k] ?? '';
            return (
              <button key={p.id} type="button" className="pl-row pl-fillrow" onClick={() => onOpen(p)}>
                <Thumb p={p} />
                <span className="pl-row-main">
                  <span className="pl-row-top">
                    <time dateTime={p.publishAt ?? undefined}>{p.publishAt ? when(p.publishAt) : t('social.plan.noDay')}</time>
                    <span className="pl-why">{why.startsWith('event:') ? t(`social.ev.short.${why.slice(6)}`) : t(`social.fill.why.${why}`)}</span>
                    <span className={`pl-score-b s${sc.score >= 8 ? 'ok' : sc.score >= 5 ? 'mid' : 'low'}`}>{sc.score}/10</span>
                  </span>
                  <span className="pl-row-cap" dir="auto">
                    {product ? <b>{product.name} · </b> : null}
                    {p.caption.split('\n')[0]}
                  </span>
                </span>
              </button>
            );
          })}
          {made.posts.some((p) => !p.photos.length) && <p className="pl-hint pl-lowq">{t('social.fill.noPhotos')}</p>}
        </div>
      )}
    </Modal>
  );
}
