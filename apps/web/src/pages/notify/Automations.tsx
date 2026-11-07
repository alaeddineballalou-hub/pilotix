// Pilot Automations › Automatisations (admins): what Pilotix does by itself, in three groups, one row each — the rule
// in one sentence (« Quand … → Pilotix … »), its switch, its few numbers (saved on change), where things stand now and
// the last thing it did; then everything it did lately. Two tabs of their own: « Auto Pilot Assign » (view 'assign'):
// each order's delivery — its delivery company (Pilot Auto Assign), its dispatch (Dispatch automatique), its livreur
// (Livreur automatique); « Auto Pilot Affectation » (view 'affectation'): its agents (Affectation automatique:
// confirmation and suivi).
import { ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inBrowserDemo, type In, type Out } from '../../lib/backend';
import { da, n, when } from '../../lib/format';
import { enablePush } from '../../lib/push';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading, RemovableChip } from '../../ui/kit';
import { toast } from '../../ui/toast';
import './auto.css';

type S = Out<'auto.state'>;
type Line = S['log'][number];
type Patch = In<'auto.save'>;
const HOURS = [17, 18, 19, 20, 21, 22, 23];
const WAIT = [1, 2, 3, 4, 6, 8, 12, 24];
const IDLE = [15, 20, 30, 45, 60, 90, 120];
const DAYS = [7, 14, 21, 30, 45, 60, 90];
/** « Maximum en main par livreur » (0: no limit) */
const MAX_HANDS = [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100];

export type AutoView = 'auto' | 'assign' | 'affectation';
export function Automations({ view = 'auto' }: { view?: AutoView }) {
  const q = useRpc('auto.state', {}, { refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  // a new answer from the server starts the screen again from it (the switches show what is saved)
  return <Board key={JSON.stringify([q.data.s, q.data.assign, q.data.delivery, q.data.pilot.on])} d={q.data} view={view} />;
}

function Board({ d, view }: { d: S; view: AutoView }) {
  const { t } = useTranslation();
  const [s, setS] = useState(d.s);
  const [assign, setAssign] = useState(d.assign);
  const [delivery, setDelivery] = useState(d.delivery);
  const [pilotOn, setPilotOn] = useState(d.pilot.on);
  const save = useAction('auto.save');
  const release = useAction('auto.release', { success: (r) => t('notify.auto.stockback.released', { count: r.sent }) });
  const back = () => {
    setS(d.s);
    setAssign(d.assign);
    setDelivery(d.delivery);
    setPilotOn(d.pilot.on);
  };
  /** saved at once; a switch says so in a toast, a number quietly */
  const put = (patch: Patch, said?: { name: string; on: boolean }) =>
    save.mutate(patch, { onSuccess: () => said && toast(t(said.on ? 'notify.auto.on' : 'notify.auto.off', { name: said.name }), 'ok'), onError: back });
  const name = (k: string) => t(`notify.auto.${k}.name`);
  const lastOf = (...kinds: string[]) => d.log.find((l) => kinds.includes(l.kind));
  /** « Livreur automatique »: at his maximum in hand (0: no limit); the next parcel goes to the first under it (fewest parcels today) */
  const full = (l: S['livreurs']['today'][number]) => s.livreurMax > 0 && l.hands >= s.livreurMax;
  const next = d.livreurs.today.find((l) => !full(l));
  const assignOn = (area: 'conf' | 'follow') => assign[area] !== 'manual';
  const flipAssign = (area: 'conf' | 'follow', on: boolean) => {
    setAssign({ ...assign, [area]: on ? (s.assignPrev[area] ?? 'turn') : 'manual' });
    put(area === 'conf' ? { assignConf: on } : { assignFollow: on }, { name: `${name('assign')} · ${t(`notify.auto.assign.${area}`)}`, on });
  };
  const sendable = d.campaigns.filter((c) => c.status !== 'paused');
  const chosen = d.campaigns.find((c) => c.id === s.comeBack.campaignId) ?? null;

  // their own tabs: the agents (« Auto Pilot Affectation »), the delivery company and the livreur (« Auto Pilot Assign »)
  const assignRow = (
    <Rule icon="usercog" name={name('assign')} when={t('notify.auto.assign.when')} then={t('notify.auto.assign.then')} on={assignOn('conf') || assignOn('follow')}>
      <div className="au-pair">
        {(['conf', 'follow'] as const).map((area) => (
          <label key={area} className={`au-mini ${assignOn(area) ? 'is-on' : ''}`}>
            <span>
              <b>{t(`notify.auto.assign.${area}`)}</b>
              <small>{t(`notify.auto.assign.mode.${assign[area]}`)}</small>
            </span>
            <span className="nt-toggle">
              <input type="checkbox" role="switch" checked={assignOn(area)} disabled={save.isPending} aria-label={`${name('assign')} · ${t(`notify.auto.assign.${area}`)}`} onChange={(e) => flipAssign(area, e.target.checked)} />
            </span>
          </label>
        ))}
      </div>
      <Links items={[['#/management/affectation', t('notify.auto.assign.link')]]} />
    </Rule>
  );
  const pilotRow = (
    <Rule
      icon="navigation"
      name={name('pilot')}
      when={t('notify.auto.pilot.when')}
      then={t('notify.auto.pilot.then')}
      on={pilotOn}
      busy={save.isPending}
      onToggle={(on) => {
        setPilotOn(on);
        put({ pilotAuto: on }, { name: name('pilot'), on });
      }}
    >
      <Now>
        {d.pilot.rules ? t('notify.auto.pilot.rules', { count: d.pilot.rules }) : t('notify.auto.pilot.noRules')}
        {d.pilot.defaultCompany && <> · {t('notify.auto.pilot.default', { name: d.pilot.defaultCompany })}</>}
      </Now>
      <Links items={[['#/livraison/pilot', t('notify.auto.pilot.link')]]} />
    </Rule>
  );
  const livreurRow = (
    <Rule
      icon="bike"
      name={name('livreur')}
      when={t('notify.auto.livreur.when')}
      then={t('notify.auto.livreur.then')}
      on={s.livreurAuto}
      busy={save.isPending}
      disabled={!d.livreurs.own}
      onToggle={(on) => {
        setS({ ...s, livreurAuto: on });
        put({ livreurAuto: on }, { name: name('livreur'), on });
      }}
      last={lastOf('livreur')}
    >
      {!d.livreurs.own ? (
        <p className="au-note">{t('notify.auto.livreur.noOwn')}</p>
      ) : (
        <>
          {s.livreurAuto && !s.autoDispatch && <Now tone="warn">{t('notify.auto.livreur.needsDispatch')}</Now>}
          {d.livreurs.today.length ? (
            <div className="au-today">
              <span className="au-today-t">{t('notify.auto.livreur.today')}</span>
              <ul className="au-out">
                {d.livreurs.today.map((l) => (
                  <li key={l.id}>
                    <b>{l.name}</b>
                    <span className="muted">
                      {t('notify.auto.livreur.parcels', { count: l.n })} · {t('notify.auto.livreur.hands', { count: l.hands })}
                    </span>
                    {full(l) ? (
                      <span className="au-full">{t('notify.auto.livreur.full')}</span>
                    ) : (
                      l.id === next?.id && s.livreurAuto && s.autoDispatch && <span className="au-next">{t('notify.auto.livreur.next')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Now tone={d.livreurs.waiting ? 'warn' : undefined}>{t('notify.auto.livreur.nobody')}</Now>
          )}
          {d.livreurs.waiting > 0 && (
            <Now tone="warn">
              {t('notify.auto.livreur.waiting', { count: d.livreurs.waiting })}
              {d.livreurs.today.length > 0 && !next && <> · {t('notify.auto.livreur.allFull')}</>}
            </Now>
          )}
          {s.livreurAuto && (
            <div className="au-fields">
              <Pick
                label={t('notify.auto.livreur.max')}
                value={s.livreurMax}
                options={MAX_HANDS}
                show={(v) => (v ? t('notify.auto.livreur.parcels', { count: v }) : t('notify.auto.livreur.noLimit'))}
                onChange={(v) => {
                  setS({ ...s, livreurMax: v });
                  put({ livreurMax: v });
                }}
              />
            </div>
          )}
        </>
      )}
      <Links items={[['#/livraison/livreurs', t('notify.auto.livreur.link')]]} />
    </Rule>
  );
  const dispatchRow = (
    <Rule
      icon="truck"
      name={name('dispatch')}
      when={t('notify.auto.dispatch.when')}
      then={t('notify.auto.dispatch.then')}
      on={s.autoDispatch}
      busy={save.isPending}
      onToggle={(on) => {
        setS({ ...s, autoDispatch: on });
        put({ autoDispatch: on }, { name: name('dispatch'), on });
      }}
    >
      {!s.autoDispatch && <Now tone="warn">{d.noStock.toAssign ? t('notify.auto.dispatch.offNote', { count: d.noStock.toAssign }) : t('notify.auto.dispatch.offEmpty')}</Now>}
      <Links items={[['#/depot/preparer', t('notify.auto.dispatch.link')]]} />
    </Rule>
  );
  if (view === 'assign')
    return (
      <div className="au">
        <p className="au-lead">{t('notify.auto.assignLead')}</p>
        <Group title={t('notify.auto.groups.delivery')}>
          {pilotRow}
          {dispatchRow}
          {livreurRow}
        </Group>
        {d.log.some((l) => l.kind === 'livreur') && <Log lines={d.log.filter((l) => l.kind === 'livreur')} />}
      </div>
    );
  if (view === 'affectation')
    return (
      <div className="au">
        <p className="au-lead">{t('notify.auto.affectationLead')}</p>
        <Group title={t('notify.auto.groups.agents')}>{assignRow}</Group>
      </div>
    );

  return (
    <div className="au">
      <p className="au-lead">{t('notify.auto.lead')}</p>
      <Links
        items={[
          ['#/notify/assign', t('notify.auto.toAssign')],
          ['#/notify/affectation', t('notify.auto.toAffectation')],
        ]}
      />
      <ThisPhone />

      <Group title={t('notify.auto.groups.orders')}>
        <Rule
          icon="timer"
          name={name('queue')}
          when={t('notify.auto.queue.when')}
          then={t('notify.auto.queue.then')}
          on={s.queue.on}
          busy={save.isPending}
          onToggle={(on) => {
            const queue = { ...s.queue, on };
            setS({ ...s, queue });
            put({ queue }, { name: name('queue'), on });
          }}
          last={lastOf('queue')}
        >
          <Now tone={d.queueNow.open && d.queueNow.n ? 'warn' : undefined}>
            {!d.queueNow.open ? t('notify.auto.queue.closed') : d.queueNow.n ? t('notify.auto.queue.now', { count: d.queueNow.n, h: s.queue.waitHours }) : t('notify.auto.queue.nowNone')}
          </Now>
          {s.queue.on && (
            <div className="au-fields">
              <Pick label={t('notify.auto.queue.wait')} value={s.queue.waitHours} options={WAIT} show={(v) => t('notify.auto.hoursN', { count: v })} onChange={(v) => { const queue = { ...s.queue, waitHours: v }; setS({ ...s, queue }); put({ queue }); }} />
              <Pick label={t('notify.auto.queue.idle')} value={s.queue.idleMin} options={IDLE} show={(v) => t('notify.auto.minN', { count: v })} onChange={(v) => { const queue = { ...s.queue, idleMin: v }; setS({ ...s, queue }); put({ queue }); }} />
              <People ids={s.queue.to} all={d.people} fallback={t('notify.auto.peopleManagers')} onChange={(to) => { const queue = { ...s.queue, to }; setS({ ...s, queue }); put({ queue }); }} />
            </div>
          )}
        </Rule>

        <Rule
          icon="moon"
          name={name('evening')}
          when={t('notify.auto.evening.when', { hour: s.evening.hour })}
          then={t('notify.auto.evening.then')}
          on={s.evening.on}
          busy={save.isPending}
          onToggle={(on) => {
            const evening = { ...s.evening, on };
            setS({ ...s, evening });
            put({ evening }, { name: name('evening'), on });
          }}
          last={lastOf('evening')}
        >
          <Today r={d.today} />
          {s.evening.on && (
            <div className="au-fields">
              <Pick label={t('notify.auto.evening.hour')} value={s.evening.hour} options={HOURS} show={(v) => `${String(v).padStart(2, '0')}:00`} onChange={(v) => { const evening = { ...s.evening, hour: v }; setS({ ...s, evening }); put({ evening }); }} />
              <People ids={s.evening.to} all={d.people} fallback={t('notify.auto.peopleAdmins')} onChange={(to) => { const evening = { ...s.evening, to }; setS({ ...s, evening }); put({ evening }); }} />
            </div>
          )}
        </Rule>
      </Group>

      <Group title={t('notify.auto.groups.stock')}>
        <Rule
          icon="pause"
          name={name('nostock')}
          when={t('notify.auto.nostock.when')}
          then={t('notify.auto.nostock.then')}
          on={s.noStock.on}
          busy={save.isPending}
          onToggle={(on) => {
            setS({ ...s, noStock: { on } });
            put({ noStock: { on } }, { name: name('nostock'), on });
          }}
          last={lastOf('nostock', 'stockback')}
        >
          {!d.has.ads && <p className="au-note">{t('notify.auto.nostock.noAds')}</p>}
          <SoldOut list={d.soldOut} on={s.noStock.on} />
        </Rule>

        <Rule
          icon="package"
          name={name('stockback')}
          when={t('notify.auto.stockback.when')}
          then={t('notify.auto.stockback.then')}
          on={s.stockBack}
          busy={save.isPending}
          onToggle={(on) => {
            setS({ ...s, stockBack: on });
            put({ stockBack: on }, { name: name('stockback'), on });
          }}
          last={lastOf('release')}
        >
          {d.noStock.waiting > 0 && (
            <Now tone={!s.stockBack && d.noStock.ready ? 'warn' : undefined}>
              {t('notify.auto.stockback.waiting', { count: d.noStock.waiting })}
              {d.noStock.ready > 0 && <> · <b>{t('notify.auto.stockback.ready', { count: d.noStock.ready })}</b></>}
              {!s.stockBack && d.noStock.ready > 0 && (
                <button type="button" className="btn small primary au-act" disabled={release.isPending} onClick={() => release.mutate({})}>
                  <Icon name="send" /> {t('notify.auto.stockback.release')}
                </button>
              )}
            </Now>
          )}
          <Links items={[['#/depot/preparer', t('notify.auto.stockback.link')]]} />
        </Rule>
      </Group>

      <Group title={t('notify.auto.groups.clients')}>
        <Rule
          icon="send"
          name={name('delivery')}
          when={t('notify.auto.delivery.when')}
          then={t('notify.auto.delivery.then')}
          on={delivery}
          busy={save.isPending}
          onToggle={(on) => {
            setDelivery(on);
            put({ delivery: on }, { name: name('delivery'), on });
          }}
        >
          <Links items={[['#/notify/messages', t('notify.auto.delivery.link')], ['#/notify/reglages', t('notify.tabs.reglages')]]} />
        </Rule>

        <Rule
          icon="gift"
          name={name('comeback')}
          when={t('notify.auto.comeback.when', { days: t('notify.auto.daysN', { count: s.comeBack.days }) })}
          then={t('notify.auto.comeback.then')}
          on={s.comeBack.on}
          busy={save.isPending}
          disabled={!d.has.campaigns || (!s.comeBack.on && !sendable.length)}
          onToggle={(on) => {
            const comeBack = { ...s.comeBack, on, campaignId: s.comeBack.campaignId ?? sendable[0]?.id ?? null };
            setS({ ...s, comeBack });
            put({ comeBack }, { name: name('comeback'), on });
          }}
          last={lastOf('comeback')}
        >
          {!d.has.campaigns ? (
            <p className="au-note">{t('notify.auto.comeback.noFeature')}</p>
          ) : !d.campaigns.length ? (
            <p className="au-note">
              {t('notify.auto.comeback.none')} <a href="#/marketing/campagnes">{t('notify.auto.comeback.link')}</a>
            </p>
          ) : (
            <>
              {chosen?.status === 'paused' && <Now tone="warn">{t('notify.auto.comeback.paused')}</Now>}
              {s.comeBack.on && d.comeBackSent > 0 && <Now>{t('notify.auto.comeback.sent', { count: d.comeBackSent })}</Now>}
              <div className="au-fields">
                <Pick label={t('notify.auto.comeback.days')} value={s.comeBack.days} options={DAYS} show={(v) => t('notify.auto.daysN', { count: v })} onChange={(v) => { const comeBack = { ...s.comeBack, days: v }; setS({ ...s, comeBack }); put({ comeBack }); }} />
                <label className="au-field au-wide">
                  <span>{t('notify.auto.comeback.campaign')}</span>
                  <select
                    dir="auto"
                    value={s.comeBack.campaignId ?? ''}
                    onChange={(e) => {
                      const comeBack = { ...s.comeBack, campaignId: e.target.value ? Number(e.target.value) : null, on: e.target.value ? s.comeBack.on : false };
                      setS({ ...s, comeBack });
                      put({ comeBack });
                    }}
                  >
                    <option value="">{t('notify.auto.comeback.pick')}</option>
                    {d.campaigns.map((c) => (
                      <option key={c.id} value={c.id} disabled={c.status === 'paused' && c.id !== s.comeBack.campaignId}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Links items={[['#/marketing/campagnes', t('notify.auto.comeback.link')]]} />
            </>
          )}
        </Rule>
      </Group>

      <Log lines={d.log} />
    </div>
  );
}

/** Everything Pilotix did lately (the last 20). */
function Log({ lines }: { lines: Line[] }) {
  const { t } = useTranslation();
  return (
    <section className="card au-log">
      <div className="card-head">
        <h2>{t('notify.auto.log.title')}</h2>
      </div>
      {lines.length ? (
        <ol className="au-lines">
          {lines.slice(0, 20).map((l) => (
            <li key={l.id}>
              <span className={`au-dot k-${l.kind}`} aria-hidden="true">
                <Icon name={KIND_ICON[l.kind] ?? 'zap'} />
              </span>
              <span className="au-line-t">{lineText(t, l)}</span>
              <time dateTime={l.at}>{when(l.at)}</time>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted small">{t('notify.auto.log.empty')}</p>
      )}
    </section>
  );
}

const KIND_ICON: Record<string, string> = { evening: 'moon', nostock: 'pause', stockback: 'play', queue: 'timer', comeback: 'gift', release: 'package', livreur: 'bike' };

/** A name typed by the shop (a product, an ad set, a campaign, a person) kept whole inside a sentence of the other
 *  direction: « Offre de retour −10 % » stays itself in an Arabic line. */
const own = (v: unknown) => `\u2068${String(v ?? '')}\u2069`;

/** One line of what Pilotix did, in the reader's language. */
function lineText(t: (k: string, o?: any) => string, l: Line): string {
  const x = l.data as Record<string, any>;
  const k = 'notify.auto.lines';
  const ads = (list: unknown) => ((list ?? []) as unknown[]).map(own).join(', ');
  switch (l.kind) {
    case 'evening':
      return t(`${k}.evening`, { orders: n(x.orders), delivered: n(x.delivered), profit: da(x.profit) });
    case 'nostock':
      return x.paused?.length ? t(`${k}.nostockPaused`, { product: own(x.product), ads: ads(x.paused) }) : x.pages ? t(`${k}.nostockPages`, { product: own(x.product), count: x.pages }) : t(`${k}.nostock`, { product: own(x.product) });
    case 'stockback':
      if (x.off) return t(`${k}.stockbackOff`, { ads: ads(x.resumed) });
      return x.resumed?.length ? t(`${k}.stockbackResumed`, { product: own(x.product), ads: ads(x.resumed) }) : t(`${k}.stockback`, { product: own(x.product) });
    case 'queue':
      return x.what === 'idle' ? t(`${k}.idle`, { agent: own(x.agent), minutes: x.minutes, count: x.n }) : t(`${k}.wait`, { count: x.n, hours: x.hours });
    case 'comeback':
      return x.problem ? t(`${k}.comebackProblem`, { campaign: own(x.campaign) }) : t(`${k}.comeback`, { count: l.n, campaign: own(x.campaign) });
    case 'release':
      return t(`${k}.release`, { count: l.n });
    case 'livreur':
      return t(`${k}.livreur`, { count: l.n, who: ((x.livreurs ?? []) as { name: string; n: number }[]).map((p) => `${own(p.name)} ${p.n}`).join(', ') });
    default:
      return l.kind;
  }
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card au-group">
      <div className="card-head">
        <h2>{title}</h2>
      </div>
      <ul className="au-list">{children}</ul>
    </section>
  );
}

/** One automation: its rule, its switch (none when its parts have their own), then what it needs and shows. */
function Rule({ icon, name, when: w, then, on, onToggle, busy, disabled, last, children }: {
  icon: string;
  name: string;
  when: string;
  then: string;
  on: boolean;
  onToggle?: (on: boolean) => void;
  busy?: boolean;
  disabled?: boolean;
  last?: Line;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <li className={`au-rule ${on ? 'is-on' : ''}`}>
      <span className="au-ic" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <div className="au-main">
        <div className="au-top">
          <h3>{name}</h3>
          {onToggle && (
            <span className="nt-toggle">
              <input type="checkbox" role="switch" aria-label={name} checked={on} disabled={busy || disabled} onChange={(e) => onToggle(e.target.checked)} />
            </span>
          )}
        </div>
        <p className="au-rule-t">
          <span className="au-k">{t('notify.auto.when')}</span> {w}
          <span className="au-arrow" aria-hidden="true">
            →
          </span>
          <span className="au-k">{t('notify.auto.then')}</span> {then}
        </p>
        {children}
        {last && (
          <p className="au-last">
            <Icon name="history" />
            <span>{lineText(t, last)}</span>
            <time dateTime={last.at}>{when(last.at)}</time>
          </p>
        )}
      </div>
    </li>
  );
}

function Now({ tone, children }: { tone?: 'warn'; children: ReactNode }) {
  return <p className={`au-now ${tone ? `au-${tone}` : ''}`}>{children}</p>;
}

function Links({ items }: { items: [string, string][] }) {
  return (
    <p className="au-links">
      {items.map(([href, label]) => (
        <a key={href + label} href={href}>
          {label}
          <Icon name="chevr" />
        </a>
      ))}
    </p>
  );
}

function Pick({ label, value, options, show, onChange }: { label: string; value: number; options: number[]; show: (v: number) => string; onChange: (v: number) => void }) {
  const all = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <label className="au-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {all.map((v) => (
          <option key={v} value={v}>
            {show(v)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Who hears it: the people chosen, or (none chosen) the default group. */
function People({ ids, all, fallback, onChange }: { ids: number[]; all: S['people']; fallback: string; onChange: (ids: number[]) => void }) {
  const { t } = useTranslation();
  const chosen = all.filter((p) => ids.includes(p.id));
  const rest = all.filter((p) => !ids.includes(p.id));
  return (
    <div className="au-field au-people">
      <span>{t('notify.auto.people')}</span>
      <div className="au-chips">
        {chosen.length ? chosen.map((p) => <RemovableChip key={p.id} name={p.name} removeLabel={t('notify.auto.remove', { name: p.name })} onRemove={() => onChange(ids.filter((x) => x !== p.id))} />) : <span className="au-default">{fallback}</span>}
        {rest.length > 0 && (
          <select className="au-add" value="" aria-label={t('notify.auto.add')} onChange={(e) => e.target.value && onChange([...ids, Number(e.target.value)])}>
            <option value="">{t('notify.auto.add')}</option>
            {rest.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

type PushState = Awaited<ReturnType<typeof enablePush>>;

/** This phone: the evening report and the alerts ring only where someone tapped « Activer les notifications »; then
 *  « Envoyer un essai » rings it once, to be sure. */
function ThisPhone() {
  const { t } = useTranslation();
  const k = 'notify.auto.phone';
  const demo = inBrowserDemo();
  const [found, setState] = useState<PushState | null>(null);
  const test = useAction('auto.pushTest', { onDone: (r) => toast(t(r.sent ? `${k}.testSent` : `${k}.testNone`), r.sent ? 'ok' : 'bad') });
  useEffect(() => {
    if (demo) return;
    enablePush(false)
      .then(setState)
      .catch(() => setState('unsupported'));
  }, [demo]);
  // the preview: shown as on a phone that has not said yes yet (its button does nothing here)
  const state: PushState | null = demo ? 'off' : found;
  if (!state) return null;
  return (
    <section className={`card au-phone is-${state}`}>
      <span className="au-ic" aria-hidden="true">
        <Icon name="bell" />
      </span>
      <div className="au-main">
        <h3>{t(`${k}.title`)}</h3>
        <p className="au-rule-t">{t(state === 'denied' ? `${k}.denied` : state === 'unsupported' ? `${k}.unsupported` : `${k}.why`)}</p>
        {demo && <p className="au-note">{t(`${k}.demo`)}</p>}
      </div>
      <div className="au-phone-act">
        {state === 'off' && (
          <button type="button" className="btn primary" disabled={demo} onClick={() => enablePush(true).then(setState).catch(() => setState('unsupported'))}>
            <Icon name="bell" /> {t(`${k}.on`)}
          </button>
        )}
        {state === 'on' && (
          <>
            <span className="au-phone-ok">
              <Icon name="checkcircle" /> {t(`${k}.isOn`)}
            </span>
            <button type="button" className="btn ghost small" disabled={test.isPending} onClick={() => test.mutate({})}>
              {t(`${k}.test`)}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/** Today so far, as the evening report will say it. */
function Today({ r }: { r: S['today'] }) {
  const { t } = useTranslation();
  const k = 'notify.auto.evening';
  const cells: [string, string, string?][] = [
    [t(`${k}.orders`), n(r.orders)],
    [t(`${k}.confirmed`), n(r.confirmed)],
    [t(`${k}.delivered`), n(r.delivered)],
    [t(`${k}.returned`), n(r.returned)],
    [t(`${k}.cash`), da(r.cash)],
    [t(`${k}.pub`), r.pubMissing ? '—' : da(r.pub)],
    [t(`${k}.profit`), da(r.profit), r.profit < 0 ? 'neg' : 'pos'],
  ];
  return (
    <div className="au-today">
      <span className="au-today-t">{t(`${k}.today`)}</span>
      <dl>
        {cells.map(([label, value, tone]) => (
          <div key={label} className={tone ? `is-${tone}` : undefined}>
            <dt>{label}</dt>
            <dd className="ltr">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The products advertised or on a page with nothing left now. */
function SoldOut({ list, on }: { list: S['soldOut']; on: boolean }) {
  const { t } = useTranslation();
  const k = 'notify.auto.nostock';
  if (!list.length) return <Now>{t(`${k}.nowNone`)}</Now>;
  const shown = list.slice(0, 4);
  return (
    <ul className="au-out">
      {shown.map((p) => (
        <li key={p.id}>
          <b>{p.name}</b>
          <span className="muted">
            {[
              on && p.pages ? t(`${k}.pages`, { count: p.pages }) : '',
              p.paused ? t(`${k}.paused`, { count: p.paused }) : '',
              p.ads ? t(`${k}.ads`, { count: p.ads }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </li>
      ))}
      {list.length > shown.length && <li className="muted">{t(`${k}.more`, { count: list.length - shown.length })}</li>}
    </ul>
  );
}
