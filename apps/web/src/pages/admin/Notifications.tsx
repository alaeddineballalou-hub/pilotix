// Management › Notifications (owner's ask, 22 Nov 2026; design « 1 · Liste + détail »): Pilotix's own notifications in
// the bell (core modules/inbox.ts › notifyRules). Each kind: on or off, who gets it — the order's own person in their
// words, the others (the team's manager, the owners, the depot, chosen people) in the third person — and when the phones
// ring with Pilotix closed. The sounds are Pilotix's own: they are listened to here, never changed. « Écran bloqué » (the
// agent's new order) is set in Confirmation › « Bloquer jusqu'à l'appel » and only shown here.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { bellSound, BellSound, unlockAudio } from '../../lib/sound';
import { useMedia } from '../../lib/useMedia';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import './notifications.css';

type Data = Out<'notify.get'>;
type Kind = keyof Data['rules'];
type Rule = Data['rules'][Kind];
type Who = Rule['who'][number];
type Phone = Rule['phone'];

const ICON: Record<Kind | 'info', string> = { order: 'cart', callback: 'phone', delivered: 'coins', returned: 'undo', cancelled: 'xcircle', taken: 'swap', alert: 'alert', depot: 'package', message: 'message', info: 'bell' };
const ORDER: (Kind | 'info')[] = ['order', 'callback', 'delivered', 'returned', 'cancelled', 'taken', 'alert', 'depot', 'message', 'info'];
const LOUD = new Set<string>(['order', 'callback', 'alert']);
const PHONES: Phone[] = ['work', 'always', 'never'];
/** a sample line's leading emoji (the bell shows its icon instead) */
const plain = (s: string) => s.replace(/^\p{Extended_Pictographic}️?\s*/u, '');
const same = (a: Rule, b: Rule) => a.on === b.on && a.phone === b.phone && a.who.join() === b.who.join() && [...a.people].sort().join() === [...b.people].sort().join();
const hh = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;

export function NotificationsCfg() {
  const { t } = useTranslation();
  const q = useRpc('notify.get', {});
  const save = useAction('notify.set', { success: t('notifs.saved') });
  // a phone or a tablet: the list, then the chosen one (with a way back)
  const narrow = useMedia('(max-width: 1000px)');
  const grid = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Kind | 'info'>('order');
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Partial<Record<Kind, Rule>>>({});
  const data = q.data;
  const rules = useMemo(() => (data ? ({ ...data.rules, ...draft } as Data['rules']) : null), [data, draft]);
  const changed = useMemo(() => (data ? (Object.keys(draft) as Kind[]).filter((k) => !same(draft[k]!, data.rules[k])) : []), [data, draft]);
  // on a phone, the list and the chosen one take turns: each starts at its top
  useEffect(() => {
    if (narrow && grid.current && grid.current.getBoundingClientRect().top < 0) grid.current.scrollIntoView({ block: 'start' });
  }, [open, sel, narrow]);
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!data || !rules) return <Loading />;

  const edit = (k: Kind, f: (r: Rule) => Rule) => setDraft((d) => ({ ...d, [k]: f({ ...rules[k], who: [...rules[k].who], people: [...rules[k].people] }) }));
  const names = new Map(data.people.map((p) => [p.id, p.name]));
  const hours = data.slots.length ? `${hh(Math.min(...data.slots.map((s) => s.from)))} – ${hh(Math.max(...data.slots.map((s) => s.to)))}` : '';
  const pick = (k: Kind | 'info') => {
    setSel(k);
    setOpen(true);
  };
  const summary = (k: Kind) => {
    const r = rules[k];
    if (!r.on) return t('notifs.off');
    const parts = r.who.map((w) => (k === 'order' && w === 'agent' && data.block ? t('notifs.shortBlock') : t(`notifs.short.${w}`)));
    if (r.people.length) parts.push(t('notifs.peopleN', { count: r.people.length }));
    return parts.length ? parts.join(' · ') : t('notifs.nobody');
  };
  const doSave = () => {
    const out: Partial<Record<Kind, Rule>> = {};
    for (const k of changed) out[k] = draft[k]!;
    save.mutate({ rules: out }, { onSuccess: () => setDraft({}) });
  };
  const showList = !narrow || !open;
  const showDetail = !narrow || open;

  return (
    <div className="px-nt">
      <div className="px-nt-head">
        <div>
          <h2>{t('notifs.title')}</h2>
          <p className="muted">{t('notifs.help')}</p>
        </div>
        <div className="px-nt-actions">
          {changed.length > 0 && <span className="px-nt-unsaved">{t('notifs.unsaved', { count: changed.length })}</span>}
          {changed.length > 0 && (
            <button type="button" className="btn" disabled={save.isPending} onClick={() => setDraft({})}>
              {t('notifs.cancel')}
            </button>
          )}
          <button type="button" className="btn primary" disabled={save.isPending || !changed.length} onClick={doSave}>
            {t('notifs.save')}
          </button>
        </div>
      </div>

      <div className="px-nt-strip">
        <div className="px-nt-card">
          <span className="px-nt-cic">
            <Icon name="clock" />
          </span>
          <span className="px-nt-ctx">
            <b>{t('notifs.hours')}</b>
            <small>{hours ? t('notifs.hoursText', { hours }) : t('notifs.hoursNone')}</small>
          </span>
          <a className="px-nt-chip" href="#/reglages">
            {t('notifs.hoursEdit')}
          </a>
        </div>
        <div className="px-nt-card">
          <span className="px-nt-cic">
            <Icon name="volume" />
          </span>
          <span className="px-nt-ctx">
            <b>{t('notifs.sounds')}</b>
            <small>{t('notifs.soundsText')}</small>
          </span>
        </div>
      </div>

      <div className="px-nt-grid" ref={grid}>
        {showList && (
          <div className="px-nt-list" role="list">
            <small className="px-nt-group">{t('notifs.groupPilotix')}</small>
            {ORDER.map((k) => {
              const on = k === sel;
              const r = k === 'info' ? null : rules[k];
              return (
                <div key={k} role="listitem" className={`px-nt-row${on && showDetail && !narrow ? ' on' : ''}${r && !r.on ? ' off' : ''}`}>
                  <button type="button" className="px-nt-pick" aria-current={on ? 'true' : undefined} onClick={() => pick(k)}>
                    <span className={`px-bell-ic k-${k}`}>
                      <Icon name={ICON[k]} />
                    </span>
                    <span className="px-nt-rtx">
                      <b>{t(`notifs.kind.${k}`)}</b>
                      <small>{k === 'info' ? t('notifs.infoShort') : summary(k)}</small>
                    </span>
                    {narrow && <Icon name="chevr" className="px-nt-go" />}
                  </button>
                  {k !== 'info' && <Switch on={rules[k].on} label={t('notifs.turnOn', { what: t(`notifs.kind.${k}`) })} onChange={(v) => edit(k, (x) => ({ ...x, on: v }))} />}
                </div>
              );
            })}
          </div>
        )}
        {showDetail &&
          (sel === 'info' ? (
            <InfoDetail onBack={narrow ? () => setOpen(false) : undefined} />
          ) : (
            <Detail
              kind={sel}
              rule={rules[sel]}
              def={data.defaults[sel]}
              can={data.can[sel] as readonly Who[]}
              block={data.block}
              people={data.people}
              names={names}
              changed={changed.includes(sel)}
              onBack={narrow ? () => setOpen(false) : undefined}
              onEdit={(f) => edit(sel, f)}
            />
          ))}
      </div>
      {narrow && changed.length > 0 && (
        <div className="px-nt-savebar">
          <span className="px-nt-unsaved">{t('notifs.unsaved', { count: changed.length })}</span>
          <button type="button" className="btn" disabled={save.isPending} onClick={() => setDraft({})}>
            {t('notifs.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={save.isPending} onClick={doSave}>
            {t('notifs.save')}
          </button>
        </div>
      )}
    </div>
  );
}

/** A switch (a real checkbox). */
function Switch({ on, label, onChange }: { on: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label className="px-nt-sw" title={label}>
      <input type="checkbox" checked={on} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span aria-hidden="true" />
    </label>
  );
}

function Back({ onBack }: { onBack?: () => void }) {
  const { t } = useTranslation();
  if (!onBack) return null;
  return (
    <button type="button" className="px-nt-back" onClick={onBack}>
      <Icon name="chevl" /> {t('notifs.back')}
    </button>
  );
}

function Detail(p: {
  kind: Kind;
  rule: Rule;
  def: Rule;
  can: readonly Who[];
  block: boolean;
  people: Data['people'];
  names: Map<number, string>;
  changed: boolean;
  onBack?: () => void;
  onEdit: (f: (r: Rule) => Rule) => void;
}) {
  const { t } = useTranslation();
  const { kind: k, rule: r } = p;
  const [adding, setAdding] = useState('');
  const flip = (w: Who) => p.onEdit((x) => ({ ...x, who: x.who.includes(w) ? x.who.filter((y) => y !== w) : p.can.filter((y) => y === w || x.who.includes(y)) }));
  const roleDesc = (w: Who) => t(`notifs.roleDesc.${w}_${k}`, { defaultValue: t(`notifs.roleDesc.${w}`) });
  const blocked = k === 'order' && p.block;
  const listen = () => {
    unlockAudio();
    window.setTimeout(() => bellSound(k as BellSound, LOUD.has(k)), 30);
  };
  // the order's own person (their words) and the others (the third person): who sees which line
  const selfRoles: Who[] = k === 'message' ? ['agent', 'suivi'] : k === 'depot' ? [] : [k === 'alert' ? 'suivi' : 'agent'];
  const selfRole: Who = selfRoles.find((w) => r.who.includes(w)) ?? 'agent';
  const selfShown = r.on && r.who.some((w) => selfRoles.includes(w));
  const others = r.on && (r.who.some((w) => !selfRoles.includes(w)) || r.people.length > 0);
  const free = p.people.filter((x) => !r.people.includes(x.id));
  return (
    <div className="px-nt-detail">
      <Back onBack={p.onBack} />
      <div className="px-nt-dhead">
        <span className={`px-bell-ic k-${k} px-nt-big`}>
          <Icon name={ICON[k]} />
        </span>
        <span className="px-nt-rtx">
          <b className="px-nt-h">{t(`notifs.kind.${k}`)}</b>
          <small>{t(`notifs.desc.${k}`)}</small>
        </span>
        <Switch on={r.on} label={t('notifs.turnOn', { what: t(`notifs.kind.${k}`) })} onChange={(v) => p.onEdit((x) => ({ ...x, on: v }))} />
      </div>
      {!r.on && <p className="px-nt-offnote">{t('notifs.offNote')}</p>}

      <section className={r.on ? '' : 'px-nt-dim'}>
        <b className="px-nt-sh">{t('notifs.who')}</b>
        {p.can.map((w) => {
          const on = r.who.includes(w);
          return (
            <div className="px-nt-role" key={w}>
              <label className="px-nt-check">
                <input type="checkbox" checked={on} disabled={!r.on} onChange={() => flip(w)} />
                <span>
                  <b>{t(`notifs.role.${w}`)}</b>
                  <small>{roleDesc(w)}</small>
                </span>
              </label>
              {on ? (
                w === 'agent' && blocked ? (
                  <span className="px-nt-how block" title={t('notifs.blockHint')}>
                    <Icon name="lock" /> {t('notifs.how.block')}
                  </span>
                ) : (
                  <span className="px-nt-how">{t('notifs.how.notif')}</span>
                )
              ) : (
                <span className="px-nt-not">{t('notifs.notGet')}</span>
              )}
            </div>
          );
        })}
        {blocked && r.who.includes('agent') && (
          <p className="px-nt-note">
            <Icon name="lock" /> {t('notifs.blockHint')}{' '}
            <a href="#/confirmation/nouvelles">{t('notifs.blockOpen')}</a>
          </p>
        )}
        {k === 'depot' && <p className="px-nt-note">{t('notifs.depotNote')}</p>}
        <div className="px-nt-people">
          {r.people.map((id) => (
            <button key={id} type="button" className="px-nt-person" disabled={!r.on} onClick={() => p.onEdit((x) => ({ ...x, people: x.people.filter((y) => y !== id) }))} aria-label={t('notifs.removePerson', { who: p.names.get(id) ?? `#${id}` })}>
              {p.names.get(id) ?? `#${id}`} <Icon name="x" />
            </button>
          ))}
          <label className="px-nt-add">
            <Icon name="plus" />
            <select
              value={adding}
              disabled={!r.on || !free.length}
              aria-label={t('notifs.addPerson')}
              onChange={(e) => {
                const id = Number(e.target.value);
                setAdding('');
                if (id) p.onEdit((x) => ({ ...x, people: [...x.people, id] }));
              }}
            >
              <option value="">{t('notifs.addPerson')}</option>
              {free.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <div className={`px-nt-two${r.on ? '' : ' px-nt-dim'}`}>
        <section>
          <b className="px-nt-sh">{t('notifs.sound')}</b>
          <div className="px-nt-soundrow">
            <button type="button" className="px-nt-play" onClick={listen} aria-label={t('notifs.listenTo', { what: t(`notifs.soundName.${k}`) })}>
              <span className="px-nt-pb">
                <Icon name="play" />
              </span>
              {t(`notifs.soundName.${k}`)}
            </button>
            <small className="muted">{k === 'order' ? t('notifs.sameRing') : k === 'callback' ? t('notifs.sameRingCb') : t('notifs.fixed')}</small>
          </div>
        </section>
        <section>
          <b className="px-nt-sh">{t('notifs.phone')}</b>
          <div className="px-nt-seg" role="group" aria-label={t('notifs.phone')}>
            {PHONES.map((ph) => (
              <button key={ph} type="button" aria-pressed={r.phone === ph} disabled={!r.on} onClick={() => p.onEdit((x) => ({ ...x, phone: ph }))}>
                {t(`notifs.phoneMode.${ph}`)}
              </button>
            ))}
          </div>
          <small className="muted">{t(`notifs.phoneHint.${r.phone}`)}</small>
        </section>
      </div>

      {r.on && (selfShown || others) && (
        <section>
          <b className="px-nt-sh">{t('notifs.preview')}</b>
          <div className="px-nt-previews">
            {selfShown &&
              (blocked ? (
                <div className="px-nt-pv">
                  <small className="px-nt-pvw">{t(`notifs.role.${selfRole}`)}</small>
                  <div className="px-nt-blockpv">
                    <span>{t('notifs.how.block')}</span>
                    <b>{t('notifs.blockPvT')}</b>
                    <small>{t('notifs.blockPvB')}</small>
                  </div>
                </div>
              ) : (
                <Pop who={t(`notifs.role.${selfRole}`)} k={k} title={plain(t(`bell.sample.${k}.t`))} body={t(`bell.sample.${k}.b`)} />
              ))}
            {others && <Pop who={t('notifs.pvOthers')} k={k} title={plain(t(`notifs.team.${k}.t`))} body={t(`notifs.team.${k}.b`)} />}
          </div>
        </section>
      )}

      {!same(r, p.def) && (
        <button type="button" className="px-nt-reset" onClick={() => p.onEdit(() => ({ ...p.def, who: [...p.def.who], people: [...p.def.people] }))}>
          {t('notifs.reset')}
        </button>
      )}
      {p.changed && !p.onBack && <p className="px-nt-unsaved">{t('notifs.unsavedHere')}</p>}
    </div>
  );
}

/** What a line looks like (the bell's pop-up). */
function Pop({ who, k, title, body }: { who: string; k: Kind; title: string; body: string }) {
  const { t } = useTranslation();
  return (
    <div className="px-nt-pv">
      <small className="px-nt-pvw">{who}</small>
      <div className={`px-nt-pop k-${k}`}>
        <span className={`px-bell-ic k-${k}`}>
          <Icon name={ICON[k]} />
        </span>
        <span className="px-nt-rtx">
          <small className="px-nt-pk">{t(`bell.kind.${k}`)}</small>
          <b>{title}</b>
          <small>{body}</small>
        </span>
      </div>
    </div>
  );
}

/** « Alertes de l'équipe »: the other pages' own notifications, set in their page. */
function InfoDetail({ onBack }: { onBack?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="px-nt-detail">
      <Back onBack={onBack} />
      <div className="px-nt-dhead">
        <span className="px-bell-ic k-info px-nt-big">
          <Icon name="bell" />
        </span>
        <span className="px-nt-rtx">
          <b className="px-nt-h">{t('notifs.kind.info')}</b>
          <small>{t('notifs.desc.info')}</small>
        </span>
      </div>
      <p>{t('notifs.infoText')}</p>
      <div className="px-nt-links">
        <a className="btn" href="#/notify/auto">
          {t('notifs.infoAuto')}
        </a>
        <a className="btn" href="#/depot/reglages">
          {t('notifs.infoDepot')}
        </a>
      </div>
      <div className="px-nt-soundrow">
        <button
          type="button"
          className="px-nt-play"
          onClick={() => {
            unlockAudio();
            window.setTimeout(() => bellSound('info', false), 30);
          }}
        >
          <span className="px-nt-pb">
            <Icon name="play" />
          </span>
          {t('notifs.soundName.info')}
        </button>
        <small className="muted">{t('notifs.fixed')}</small>
      </div>
    </div>
  );
}
