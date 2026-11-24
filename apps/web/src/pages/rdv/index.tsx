// Rendez-vous (a module: Management › Modules): the seats people booked on the boutique's website, called and confirmed
// by the team (design « A », owner's choice 24 Nov 2026: « MIX »), and the sessions the website shows (their day, place,
// seats and price). Tabs: À confirmer, Confirmés (then at the door: there or not), Annulés, Sessions.
// The actions: @pilotix/core modules/rdv.ts.
import { algiersParts, MENU_TABS, menuTabName, phoneIntl, RDV_MAX_SEATS, siteDay, type SiteLang } from '@pilotix/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { In, Out } from '../../lib/backend';
import { da, since, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { rightOn, tabOn } from '../../lib/rights';
import { useSession } from '../../lib/session';
import { useIsPhone } from '../../lib/useMedia';
import { Float } from '../../ui/Float';
import { Empty, ErrorBox, Icon, Loading, StageBar } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import { Switch } from '../admin/bits';
import type { PageProps } from '../registry';
import './rdv.css';

const TABS = MENU_TABS.rendezvous;
type Tab = (typeof TABS)[number];
type List = Exclude<Tab, 'sessions'>;
type Ses = Out<'rdv.overview'>['sessions'][number];
type Book = Out<'rdv.list'>['rows'][number];
type Act = In<'rdv.set'>['action'];

const langOf = (l: string): SiteLang => (l === 'ar' || l === 'en' ? l : 'fr');
/** « Alger · sam. 5 déc. » */
const sesName = (s: { city: string; startsAt: string }, lang: SiteLang) => `${s.city ? `${s.city} · ` : ''}${siteDay(s.startsAt, lang, true)}`;
/** « 09:00 – 16:00 » */
const hours = (s: { startsAt: string; endsAt: string | null }) => `${algiersParts(s.startsAt).time}${s.endsAt ? ` – ${algiersParts(s.endsAt).time}` : ''}`;
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
/** each person keeps the same soft colour */
const tint = (name: string) => ['a', 'b', 'c', 'd'][[...name].reduce((n, c) => n + c.charCodeAt(0), 0) % 4];

export function Rendezvous({ sub }: PageProps) {
  const { t } = useTranslation();
  const ov = useRpc('rdv.overview', {});
  const tabs = TABS.filter((k) => tabOn('rendezvous', k));
  const view: Tab = (tabs as readonly string[]).includes(sub ?? '') ? (sub as Tab) : (tabs[0] ?? 'attente');
  const counts = ov.data?.counts;
  return (
    <div className="rdv">
      <StageBar
        flow={false}
        current={view}
        items={tabs.map((k) => ({ key: k, label: t(menuTabName('rendezvous', k)), href: `#/rendezvous/${k}`, ...(counts && k !== 'sessions' ? { count: counts[k] } : {}) }))}
      />
      {ov.error ? <ErrorBox error={ov.error} onRetry={() => ov.refetch()} /> : !ov.data ? <Loading /> : view === 'sessions' ? <Sessions /> : <Bookings key={view} list={view} upcoming={ov.data.sessions} />}
    </div>
  );
}

// ---------------------------------------------------------------- the bookings
function Bookings({ list, upcoming }: { list: List; upcoming: Ses[] }) {
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.language);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const k = window.setTimeout(() => setQ(typed.trim()), 300);
    return () => window.clearTimeout(k);
  }, [typed]);
  const rows = useRpc('rdv.list', { list, ...(sessionId ? { sessionId } : {}), ...(q ? { q } : {}) });
  const [adding, setAdding] = useState(false);
  const handle = rightOn('act:rdv.handle');
  const wide = !useIsPhone();
  return (
    <div className="rdv-wrap">
      <div className="rdv-tools">
        <p className="muted rdv-intro">{t(`rdv.intro.${list}`)}</p>
        <label className="rdv-search">
          <Icon name="search" />
          <input type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t('rdv.search')} aria-label={t('rdv.search')} />
        </label>
        {handle && upcoming.some((s) => s.open && s.free > 0) && (
          <button type="button" className="btn primary" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            <span className="rdv-long">{t('rdv.add.title')}</span>
          </button>
        )}
      </div>
      {upcoming.length > 0 && (
        <div className="rdv-chips" role="group" aria-label={t('rdv.whichSession')}>
          <button type="button" className={`rdv-chip ${sessionId === null ? 'on' : ''}`} aria-pressed={sessionId === null} onClick={() => setSessionId(null)}>
            {t('rdv.all')}
          </button>
          {upcoming.map((s) => (
            <button key={s.id} type="button" className={`rdv-chip ${sessionId === s.id ? 'on' : ''}`} aria-pressed={sessionId === s.id} onClick={() => setSessionId(s.id)}>
              {sesName(s, lang)}
            </button>
          ))}
        </div>
      )}
      <div className="rdv-cols">
        <div className="rdv-list">
          {rows.error ? (
            <ErrorBox error={rows.error} onRetry={() => rows.refetch()} />
          ) : !rows.data ? (
            <Loading />
          ) : !rows.data.rows.length ? (
            <Empty>{q || sessionId ? t('rdv.emptyFilter') : t(`rdv.empty.${list}`)}</Empty>
          ) : (
            rows.data.rows.map((b) => <BookingCard key={b.id} b={b} list={list} handle={handle} sessions={upcoming} />)
          )}
        </div>
        {wide && <SessionsAside sessions={upcoming} pick={(id) => setSessionId(id === sessionId ? null : id)} on={sessionId} />}
      </div>
      {adding && <AddSheet sessions={upcoming} onClose={() => setAdding(false)} />}
    </div>
  );
}

/** what the badge says: new, no answer (how many times), call back at…, confirmed, there, not there, cancelled, listed */
function StatusPill({ b }: { b: Book }) {
  const { t } = useTranslation();
  const due = b.status === 'callback' && b.callAt && Date.parse(b.callAt) <= Date.now();
  const tone = b.status === 'new' ? 'info' : b.status === 'confirmed' || b.status === 'present' ? 'ok' : b.status === 'absent' || b.status === 'blocked' || due ? 'bad' : b.status === 'cancelled' ? 'off' : 'warn';
  const text =
    b.status === 'no_answer' && b.tries > 0
      ? t('rdv.noAnswerN', { n: b.tries })
      : b.status === 'callback' && b.callAt
        ? due
          ? t('rdv.callNow')
          : t('rdv.callAt', { when: when(b.callAt) })
        : t(`rdv.st.${b.status}`);
  return <span className={`rdv-pill ${tone}`}>{text}</span>;
}

function BookingCard({ b, list, handle, sessions }: { b: Book; list: List; handle: boolean; sessions: Ses[] }) {
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.language);
  const { session } = useSession();
  const phone = useIsPhone();
  const set = useAction('rdv.set');
  const [menu, setMenu] = useState(false);
  const [dlg, setDlg] = useState<null | 'callback' | 'move' | 'note'>(null);
  const more = useRef<HTMLButtonElement>(null);
  const started = Date.parse(b.session.startsAt) <= Date.now() + 12 * 3_600_000;
  const run = (action: Act) => set.mutate({ id: b.id, action }, { onSuccess: () => toast(t(`rdv.done.${action}`, { name: b.name }), 'ok') });
  // the main button: confirm (to call), « there » at the door (confirmed, on the day), back to call (cancelled)
  const main: { act: Act; label: string; tone: string } | null = !handle
    ? null
    : list === 'attente'
      ? { act: 'confirm', label: t('rdv.confirm'), tone: 'ok' }
      : list === 'confirmes' && b.status === 'confirmed' && started
        ? { act: 'present', label: t('rdv.act.present'), tone: 'ok' }
        : list === 'annules'
          ? { act: 'reopen', label: t('rdv.act.reopen'), tone: '' }
          : null;
  const items: { act: Act | 'callback' | 'move' | 'note'; label: string; icon: string; bad?: boolean }[] = [];
  if (handle) {
    if (list === 'attente') items.push({ act: 'no_answer', label: t('rdv.act.no_answer'), icon: 'phoneoff' }, { act: 'callback', label: t('rdv.act.callback'), icon: 'clock' });
    if (b.status === 'confirmed' && started) items.push({ act: 'absent', label: t('rdv.act.absent'), icon: 'xcircle' });
    if (b.status === 'present') items.push({ act: 'absent', label: t('rdv.act.absent'), icon: 'xcircle' });
    if (b.status === 'absent') items.push({ act: 'present', label: t('rdv.act.present'), icon: 'checkcircle' });
    if (list !== 'annules' && b.status !== 'present' && b.status !== 'absent') items.push({ act: 'move', label: t('rdv.act.move'), icon: 'swap' });
    items.push({ act: 'note', label: t('rdv.act.note'), icon: 'pencil' });
    if (list !== 'annules' && b.status !== 'present' && b.status !== 'absent') items.push({ act: 'cancel', label: t('rdv.act.cancel'), icon: 'ban', bad: true });
  }
  const shop = session?.shop?.name ?? '';
  const waText = t('rdv.wa', {
    name: b.name.split(' ')[0],
    shop,
    count: b.seats,
    title: b.session.title || shop,
    day: siteDay(b.session.startsAt, lang),
    time: algiersParts(b.session.startsAt).time,
    where: [b.session.city, b.session.place].filter(Boolean).join(', '),
    code: b.code,
  });
  const recent = Date.now() - Date.parse(b.createdAt) < 3_600_000;
  const meta: ReactNode[] = [<span key="p" className="ltr">{b.phone.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, '$1 $2 $3 $4')}</span>, recent ? t('rdv.ago', { d: since(b.createdAt) }) : when(b.createdAt), t('rdv.seats', { count: b.seats })];
  if (list === 'confirmes' && phone)
    meta.push(
      <span key="c" className="ltr rdv-codei">
        {b.code}
      </span>,
    );
  const sesChip = (
    <span className="rdv-ses">
      <Icon name="calendar" />
      {sesName(b.session, lang)}
    </span>
  );
  const pick = (k: (typeof items)[number]['act']) => {
    setMenu(false);
    if (k === 'callback' || k === 'move' || k === 'note') setDlg(k);
    else run(k);
  };
  const call = (
    <a className={`btn ${phone ? '' : 'icon'} rdv-b`} href={`tel:${b.phone}`} aria-label={t('rdv.callX', { name: b.name })} title={t('rdv.call')}>
      <Icon name="phone" />
      {phone && <span>{t('rdv.call')}</span>}
    </a>
  );
  const wa = (
    <a className={`btn ${phone ? '' : 'icon'} rdv-b`} href={`https://wa.me/${phoneIntl(b.phone)}?text=${encodeURIComponent(waText)}`} target="_blank" rel="noopener noreferrer" aria-label={t('rdv.waX', { name: b.name })} title={t('rdv.whatsapp')}>
      <Icon name="whatsapp" />
      {phone && <span>{t('rdv.whatsapp')}</span>}
    </a>
  );
  const mainBtn = main && (
    <button type="button" className={`btn rdv-b ${main.tone === 'ok' ? 'rdv-ok' : ''}`} disabled={set.isPending} onClick={() => run(main.act)}>
      <Icon name={main.act === 'reopen' ? 'undo' : 'check'} />
      <span>{main.label}</span>
    </button>
  );
  const moreBtn = items.length > 0 && (
    <button ref={more} type="button" className="btn icon rdv-b rdv-more" aria-label={t('rdv.more')} title={t('rdv.more')} aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
      <Icon name="more" />
    </button>
  );
  return (
    <article className={`rdv-card ${b.status === 'callback' && b.callAt && Date.parse(b.callAt) <= Date.now() ? 'due' : ''}`}>
      <div className="rdv-who">
        <span className={`rdv-av t-${tint(b.name)}`} aria-hidden="true">
          {initials(b.name)}
        </span>
        <div className="rdv-id">
          <div className="rdv-nm">
            <b dir="auto">{b.name}</b>
            <StatusPill b={b} />
          </div>
          <span className="muted rdv-meta">
            {meta.map((m, k) => (
              <span key={k}>
                {k > 0 && ' · '}
                {m}
              </span>
            ))}
          </span>
          {b.note && (
            <span className="rdv-note" dir="auto">
              <Icon name="pencil" />
              {b.note}
            </span>
          )}
        </div>
        {!phone && sesChip}
        {phone && moreBtn}
      </div>
      {phone && sesChip}
      <div className={`rdv-acts ${phone ? 'grid' : ''}`}>
        {call}
        {wa}
        {mainBtn}
        {!phone && moreBtn}
        {list === 'confirmes' && !phone && (
          <span className="rdv-code ltr" title={t('rdv.codeHelp')}>
            {b.code}
          </span>
        )}
      </div>
      {menu && more.current && (
        <Float anchor={more} onClose={() => setMenu(false)} minWidth={240} maxHeight={360}>
          <div className="rdv-menu" role="menu">
            {items.map((it) => (
              <button key={it.act} type="button" role="menuitem" className={it.bad ? 'bad' : ''} onClick={() => pick(it.act)}>
                <Icon name={it.icon} />
                {it.label}
              </button>
            ))}
          </div>
        </Float>
      )}
      {dlg === 'callback' && <CallbackSheet b={b} onClose={() => setDlg(null)} />}
      {dlg === 'move' && <MoveSheet b={b} sessions={sessions} onClose={() => setDlg(null)} />}
      {dlg === 'note' && <NoteSheet b={b} onClose={() => setDlg(null)} />}
    </article>
  );
}

/** the sessions to come, filled: confirmed (green), to confirm (amber), free; a tap shows its bookings only */
function SessionsAside({ sessions, pick, on }: { sessions: Ses[]; pick: (id: number) => void; on: number | null }) {
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.language);
  const titles = [...new Set(sessions.map((s) => s.title).filter(Boolean))];
  return (
    <aside className="card rdv-aside">
      <div>
        <h2>{t('rdv.upcoming')}</h2>
        {titles.length === 1 && <p className="muted">{titles[0]}</p>}
      </div>
      {!sessions.length ? (
        <p className="muted">{t('rdv.noUpcoming')}</p>
      ) : (
        sessions.map((s) => (
          <button key={s.id} type="button" className={`rdv-fill ${on === s.id ? 'on' : ''}`} aria-pressed={on === s.id} onClick={() => pick(s.id)}>
            <span className="rdv-fill-h">
              <b>{sesName(s, lang)}</b>
              {s.free <= 0 ? <span className="rdv-pill bad">{t('rdv.full')}</span> : <span className="ltr">{`${s.confirmed + s.todo}/${s.seats}`}</span>}
            </span>
            <Fill s={s} />
            <span className="muted rdv-fill-s">
              {hours(s)} · {s.free > 0 ? t('rdv.freeSeats', { count: s.free }) : `${s.confirmed + s.todo}/${s.seats}`}
            </span>
          </button>
        ))
      )}
      {sessions.length > 0 && (
        <div className="rdv-legend">
          <span>
            <i className="ok" />
            {t('rdv.legend.ok')}
          </span>
          <span>
            <i className="todo" />
            {t('rdv.legend.todo')}
          </span>
          <span>
            <i />
            {t('rdv.legend.free')}
          </span>
        </div>
      )}
    </aside>
  );
}

function Fill({ s }: { s: { seats: number; confirmed: number; todo: number; free: number } }) {
  const { t } = useTranslation();
  const w = (n: number) => `${s.seats > 0 ? Math.min(100, (n / s.seats) * 100) : 0}%`;
  return (
    <span className="rdv-bar" role="img" aria-label={t('rdv.fillLabel', { ok: s.confirmed, todo: s.todo, free: s.free, seats: s.seats })}>
      <i className="ok" style={{ width: w(s.confirmed) }} />
      <i className="todo" style={{ width: w(s.todo) }} />
    </span>
  );
}

// ---------------------------------------------------------------- the small forms
function Sheet2({ title, onClose, children, foot }: { title: string; onClose: () => void; children: ReactNode; foot: ReactNode }) {
  return (
    <Modal sheet title={title} onClose={onClose} footer={<div className="rdv-foot">{foot}</div>} className="rdv-dlg">
      <div className="rdv-form">{children}</div>
    </Modal>
  );
}

function CallbackSheet({ b, onClose }: { b: Book; onClose: () => void }) {
  const { t } = useTranslation();
  const set = useAction('rdv.set', { success: t('rdv.done.callback'), onDone: onClose });
  const now = Date.now();
  const at = (h: number, m = 0, days = 1) => {
    const p = algiersParts(new Date(now + days * 86_400_000).toISOString());
    return new Date(`${p.date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+01:00`).toISOString();
  };
  const quick = [
    { k: 'in1h', v: new Date(now + 3_600_000).toISOString() },
    { k: 'in3h', v: new Date(now + 3 * 3_600_000).toISOString() },
    { k: 'tomorrow10', v: at(10) },
    { k: 'tomorrow18', v: at(18) },
  ];
  const [pick, setPick] = useState(quick[0].v);
  const [own, setOwn] = useState('');
  const value = own ? new Date(`${own}:00+01:00`).toISOString() : pick;
  return (
    <Sheet2
      title={t('rdv.cb.title', { name: b.name })}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={set.isPending || Date.parse(value) <= Date.now()} onClick={() => set.mutate({ id: b.id, action: 'callback', callAt: value })}>
            {t('rdv.cb.save')}
          </button>
        </>
      }
    >
      <div className="rdv-opts" role="radiogroup" aria-label={t('rdv.cb.title', { name: b.name })}>
        {quick.map((x) => (
          <button key={x.k} type="button" role="radio" aria-checked={!own && pick === x.v} className={`rdv-opt ${!own && pick === x.v ? 'on' : ''}`} onClick={() => (setOwn(''), setPick(x.v))}>
            <b>{t(`rdv.cb.${x.k}`)}</b>
            <small className="muted">{when(x.v)}</small>
          </button>
        ))}
      </div>
      <label className="field">
        <span className="lab">{t('rdv.cb.other')}</span>
        <input type="datetime-local" value={own} min={algiersParts(new Date(now).toISOString()).date + 'T00:00'} onChange={(e) => setOwn(e.target.value)} />
      </label>
    </Sheet2>
  );
}

function MoveSheet({ b, sessions, onClose }: { b: Book; sessions: Ses[]; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.language);
  const set = useAction('rdv.set', { success: t('rdv.done.move'), onDone: onClose });
  const [sid, setSid] = useState(b.sessionId);
  const [seats, setSeats] = useState(b.seats);
  const list = sessions.some((s) => s.id === b.sessionId) ? sessions : [{ ...b.session, id: b.sessionId, free: 0 } as unknown as Ses, ...sessions];
  return (
    <Sheet2
      title={t('rdv.mv.title', { name: b.name })}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={set.isPending || (sid === b.sessionId && seats === b.seats)} onClick={() => set.mutate({ id: b.id, action: 'move', sessionId: sid, seats })}>
            {t('rdv.mv.save')}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="lab">{t('rdv.f.session')}</span>
        <select value={sid} onChange={(e) => setSid(Number(e.target.value))}>
          {list.map((s) => (
            <option key={s.id} value={s.id}>
              {sesName(s, lang)} · {hours(s)}
              {s.id === b.sessionId ? '' : ` · ${s.free > 0 ? t('rdv.freeSeats', { count: s.free }) : t('rdv.full')}`}
            </option>
          ))}
        </select>
      </label>
      <SeatsField value={seats} onChange={setSeats} />
    </Sheet2>
  );
}

function NoteSheet({ b, onClose }: { b: Book; onClose: () => void }) {
  const { t } = useTranslation();
  const set = useAction('rdv.set', { success: t('rdv.done.note'), onDone: onClose });
  const [note, setNote] = useState(b.note);
  return (
    <Sheet2
      title={t('rdv.nt.title', { name: b.name })}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={set.isPending || note.trim() === b.note.trim()} onClick={() => set.mutate({ id: b.id, action: 'note', note })}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="lab">{t('rdv.nt.label')}</span>
        <textarea rows={4} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('rdv.nt.ph')} dir="auto" />
      </label>
    </Sheet2>
  );
}

function SeatsField({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const { t } = useTranslation();
  return (
    <div className="field">
      <span className="lab">{t('rdv.f.seats')}</span>
      <span className="rdv-step">
        <button type="button" className="btn icon" disabled={value <= 1} onClick={() => onChange(value - 1)} aria-label={t('rdv.f.fewer')}>
          <Icon name="minus" />
        </button>
        <b className="ltr">{value}</b>
        <button type="button" className="btn icon" disabled={value >= RDV_MAX_SEATS} onClick={() => onChange(value + 1)} aria-label={t('rdv.f.more')}>
          <Icon name="plus" />
        </button>
      </span>
    </div>
  );
}

function AddSheet({ sessions, onClose }: { sessions: Ses[]; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.language);
  const open = sessions.filter((s) => s.free > 0);
  const add = useAction('rdv.add', { success: t('rdv.add.ok'), onDone: onClose });
  const [sid, setSid] = useState(open[0]?.id ?? 0);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [seats, setSeats] = useState(1);
  const [confirmed, setConfirmed] = useState(true);
  const [note, setNote] = useState('');
  const ok = sid && name.trim().length >= 2 && phone.replace(/\D/g, '').length >= 9;
  return (
    <Sheet2
      title={t('rdv.add.title')}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!ok || add.isPending} onClick={() => add.mutate({ sessionId: sid, name, phone, seats, confirmed, ...(note.trim() ? { note } : {}) })}>
            {t('rdv.add.save')}
          </button>
        </>
      }
    >
      <p className="muted rdv-help">{t('rdv.add.help')}</p>
      <label className="field">
        <span className="lab">{t('rdv.f.session')}</span>
        <select value={sid} onChange={(e) => setSid(Number(e.target.value))}>
          {open.map((s) => (
            <option key={s.id} value={s.id}>
              {sesName(s, lang)} · {hours(s)} · {t('rdv.freeSeats', { count: s.free })}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="lab">{t('rdv.f.name')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" dir="auto" />
      </label>
      <label className="field">
        <span className="lab">{t('rdv.f.phone')}</span>
        <input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={20} placeholder="05 50 12 34 56" className="ltr" />
      </label>
      <SeatsField value={seats} onChange={setSeats} />
      <div className="rdv-line">
        <span>
          <b>{t('rdv.add.confirmed')}</b>
          <small className="muted">{t('rdv.add.confirmedHint')}</small>
        </span>
        <Switch checked={confirmed} onChange={setConfirmed} label={t('rdv.add.confirmed')} />
      </div>
      <label className="field">
        <span className="lab">{t('rdv.nt.label')}</span>
        <textarea rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} dir="auto" />
      </label>
    </Sheet2>
  );
}

// ---------------------------------------------------------------- the sessions
type SesFull = Out<'rdv.sessions'>['sessions'][number];
/** the form: a session to change, a new one, or a copy of one for another day (its id and its day left out) */
type Editing = { s: Partial<SesFull>; copy?: boolean };

function Sessions() {
  const { t } = useTranslation();
  const { session } = useSession();
  const q = useRpc('rdv.sessions', {});
  const manage = !!session && (session.isAdmin || session.roles.includes('vendeur')) && rightOn('act:rdv.sessions');
  const [edit, setEdit] = useState<Editing | null>(null);
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  const all = q.data.sessions;
  const coming = all.filter((s) => !s.past).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const past = all.filter((s) => s.past).sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  const last = [...all].sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt))[0];
  const fresh = (): Partial<SesFull> => ({ title: last?.title ?? '', city: '', place: '', seats: last?.seats ?? 20, price: last?.price ?? 0, note: last?.note ?? '', open: true });
  const cards = (list: SesFull[]) => (
    <div className="rdv-sgrid">
      {list.map((s) => (
        <SessionCard key={s.id} s={s} manage={manage} onEdit={(copy) => setEdit({ s, copy })} />
      ))}
    </div>
  );
  return (
    <div className="rdv-wrap">
      <div className="rdv-tools">
        <p className="muted rdv-intro">{t('rdv.ses.help')}</p>
        {manage && (
          <button type="button" className="btn primary" onClick={() => setEdit({ s: fresh() })}>
            <Icon name="plus" />
            <span>{t('rdv.ses.add')}</span>
          </button>
        )}
      </div>
      {!all.length ? (
        <Empty>{t(manage ? 'rdv.ses.none' : 'rdv.ses.noneTeam')}</Empty>
      ) : (
        <>
          {coming.length > 0 && cards(coming)}
          {past.length > 0 && (
            <>
              <h2 className="rdv-h2">{t('rdv.ses.pastTitle')}</h2>
              {cards(past)}
            </>
          )}
        </>
      )}
      {edit && <SessionForm s={edit.s} copy={!!edit.copy} onClose={() => setEdit(null)} />}
    </div>
  );
}

function SessionCard({ s, manage, onEdit }: { s: SesFull; manage: boolean; onEdit: (copy: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.language);
  const del = useAction('rdv.sessionDelete', { success: (r) => t(r.archived ? 'rdv.ses.archived' : 'rdv.ses.removed') });
  const [menu, setMenu] = useState(false);
  const [sure, setSure] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const close = () => (setMenu(false), setSure(false));
  const day = algiersParts(s.startsAt).date;
  return (
    <article className={`card rdv-scard ${s.past ? 'past' : ''}`}>
      <div className="rdv-scard-h">
        <span className="rdv-date" aria-hidden="true">
          <b className="ltr">{Number(day.slice(8))}</b>
          <small>{new Intl.DateTimeFormat(lang === 'ar' ? 'ar-DZ' : lang === 'en' ? 'en-GB' : 'fr-DZ', { month: 'short', timeZone: 'Africa/Algiers' }).format(new Date(s.startsAt))}</small>
        </span>
        <div className="rdv-grow">
          <h3>{sesName(s, lang)}</h3>
          <p className="muted">
            {hours(s)}
            {s.place ? ` · ${s.place}` : ''}
          </p>
        </div>
        <span className={`rdv-pill ${s.past ? 'off' : !s.open ? 'warn' : s.free <= 0 ? 'bad' : 'ok'}`}>{t(s.past ? 'rdv.ses.past' : !s.open ? 'rdv.ses.closed' : s.free <= 0 ? 'rdv.full' : 'rdv.ses.openNow')}</span>
      </div>
      {(s.title || s.price > 0) && (
        <p className="rdv-what" dir="auto">
          {s.title}
          {s.title && ' · '}
          <b className="rdv-nowrap">{s.price > 0 ? da(s.price) : t('rdv.ses.free')}</b>
        </p>
      )}
      <Fill s={s} />
      <p className="muted rdv-nums">{t('rdv.ses.nums', { taken: s.confirmed + s.todo, seats: s.seats, ok: s.confirmed, todo: s.todo, free: s.free })}</p>
      {s.note && (
        <p className="rdv-note" dir="auto">
          <Icon name="info" />
          {s.note}
        </p>
      )}
      {manage && (
        <div className="rdv-acts">
          <button type="button" className="btn" onClick={() => onEdit(false)}>
            <Icon name="pencil" />
            <span>{t('rdv.ses.edit')}</span>
          </button>
          <button type="button" className="btn" onClick={() => onEdit(true)}>
            <Icon name="copy" />
            <span>{t('rdv.ses.copy')}</span>
          </button>
          <button ref={more} type="button" className="btn icon rdv-more" aria-label={t('rdv.more')} title={t('rdv.more')} aria-expanded={menu} onClick={() => (menu ? close() : setMenu(true))}>
            <Icon name="more" />
          </button>
        </div>
      )}
      {menu && (
        <Float anchor={more} onClose={close} minWidth={260} maxHeight={300}>
          <div className="rdv-menu" role="menu">
            {sure ? (
              <>
                <p className="rdv-ask">{t(s.confirmed + s.todo > 0 ? 'rdv.ses.removeAskBooked' : 'rdv.ses.removeAsk')}</p>
                <button type="button" role="menuitem" className="bad" disabled={del.isPending} onClick={() => del.mutate({ id: s.id }, { onSettled: close })}>
                  <Icon name="trash" />
                  {t('rdv.ses.removeYes')}
                </button>
                <button type="button" role="menuitem" onClick={() => setSure(false)}>
                  <Icon name="x" />
                  {t('common.cancel')}
                </button>
              </>
            ) : (
              <button type="button" role="menuitem" className="bad" onClick={() => setSure(true)}>
                <Icon name="trash" />
                {t('rdv.ses.remove')}
              </button>
            )}
          </div>
        </Float>
      )}
    </article>
  );
}

function SessionForm({ s, copy, onClose }: { s: Partial<SesFull>; copy: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const save = useAction('rdv.sessionSave', { success: t('rdv.ses.saved'), onDone: onClose });
  const start = s.startsAt ? algiersParts(s.startsAt) : null;
  const end = s.endsAt ? algiersParts(s.endsAt) : null;
  // a copy keeps everything but the day (the new session's own)
  const id = copy ? undefined : s.id;
  const [f, setF] = useState({
    title: s.title ?? '',
    city: s.city ?? '',
    place: s.place ?? '',
    date: copy ? '' : (start?.date ?? ''),
    start: start?.time ?? '09:00',
    end: s.startsAt ? (end?.time ?? '') : '16:00',
    seats: s.seats ?? 20,
    price: s.price ?? 0,
    note: s.note ?? '',
    open: s.open ?? true,
  });
  const up = (k: Partial<typeof f>) => setF((x) => ({ ...x, ...k }));
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(f.date) && /^\d{2}:\d{2}$/.test(f.start) && f.seats >= 1 && (!f.end || f.end > f.start);
  return (
    <Sheet2
      title={id ? t('rdv.ses.editTitle') : copy ? t('rdv.ses.copyTitle') : t('rdv.ses.add')}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={!ok || save.isPending} onClick={() => save.mutate({ ...(id ? { id } : {}), ...f, title: f.title.trim(), city: f.city.trim(), place: f.place.trim(), note: f.note.trim() })}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="lab">{t('rdv.ses.what')}</span>
        <input value={f.title} onChange={(e) => up({ title: e.target.value })} maxLength={120} placeholder={t('rdv.ses.whatPh')} dir="auto" />
      </label>
      <div className="rdv-two">
        <label className="field">
          <span className="lab">{t('rdv.ses.city')}</span>
          <input value={f.city} onChange={(e) => up({ city: e.target.value })} maxLength={60} placeholder={t('rdv.ses.cityPh')} dir="auto" />
        </label>
        <label className="field">
          <span className="lab">{t('rdv.ses.date')}</span>
          <input type="date" value={f.date} min={id ? undefined : algiersParts(new Date().toISOString()).date} onChange={(e) => up({ date: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span className="lab">{t('rdv.ses.place')}</span>
        <input value={f.place} onChange={(e) => up({ place: e.target.value })} maxLength={200} placeholder={t('rdv.ses.placePh')} dir="auto" />
      </label>
      <div className="rdv-two">
        <label className="field">
          <span className="lab">{t('rdv.ses.start')}</span>
          <input type="time" value={f.start} onChange={(e) => up({ start: e.target.value })} />
        </label>
        <label className="field">
          <span className="lab">{t('rdv.ses.end')}</span>
          <input type="time" value={f.end} onChange={(e) => up({ end: e.target.value })} />
        </label>
      </div>
      <div className="rdv-two">
        <label className="field">
          <span className="lab">{t('rdv.ses.seats')}</span>
          <input type="number" inputMode="numeric" min={1} max={5000} value={f.seats} onChange={(e) => up({ seats: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
        </label>
        <label className="field">
          <span className="lab">{t('rdv.ses.price')}</span>
          <input type="number" inputMode="numeric" min={0} step={100} value={f.price} onChange={(e) => up({ price: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
          <span className="hint">{t('rdv.ses.priceHint')}</span>
        </label>
      </div>
      <label className="field">
        <span className="lab">{t('rdv.ses.note')}</span>
        <input value={f.note} onChange={(e) => up({ note: e.target.value })} maxLength={500} placeholder={t('rdv.ses.notePh')} dir="auto" />
      </label>
      <div className="rdv-line">
        <span>
          <b>{t('rdv.ses.openLabel')}</b>
          <small className="muted">{t('rdv.ses.openHint')}</small>
        </span>
        <Switch checked={f.open} onChange={(open) => up({ open })} label={t('rdv.ses.openLabel')} />
      </div>
    </Sheet2>
  );
}

