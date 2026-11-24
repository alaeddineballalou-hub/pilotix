// Confirmation › Réglages (owner's ask, 24 Nov 2026: each page keeps its own settings, no more one place for all of them;
// he picked design 1 « Onglet »: the last tab of the bar, with a gear, set apart). Everything Confirmation needs, each part
// a card folded on its state (« Résumé », his rule of 20 Nov 2026 for settings pages): who gets the new orders (the
// Confirmation part of Affectation), the calls (first call, call-backs, tries, call slots, auto-cancel, « Bloquer jusqu'à
// l'appel »), the messages to the customer before the parcel ships (and the agents' WhatsApp text), the slow queue alert
// and the statuses. Nothing is copied: each card is the same form as before, saved where the server keeps it. Each card
// keeps who may change it today (the server checks it too): an administrator everything, the agent managers and the
// owners the « Bloquer » switch, the people allowed to share the orders (« Affectation ») their card.
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Empty, Icon, type IconName, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { Affectation } from '../admin/Affectation';
import { Switch } from '../admin/bits';
import { CallsForm, Statuts } from '../admin/Statuts';
import { Automations } from '../notify/Automations';
import { BlockSwitch } from './BlockSwitch';
import './settings.css';

/** the messages sent to the customer while the order is still in Confirmation (the others are Suivi's) */
const CONF_KINDS = ['created', 'no_answer', 'confirmed'] as const;

/** One part of the settings: folded on its state, opened from its title row. */
function Fold({ id, icon, title, desc, state, children }: { id: string; icon: IconName; title: string; desc: string; state?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const body = `cfs-${id}`;
  return (
    <section className={`card cfs-fold${open ? ' open' : ''}`}>
      <button type="button" className="cfs-head" aria-expanded={open} aria-controls={body} onClick={() => setOpen(!open)}>
        <span className="cfs-ic">
          <Icon name={icon} />
        </span>
        <span className="cfs-t">
          <b>{title}</b>
          <small>{desc}</small>
        </span>
        {state ? <span className="cfs-state">{state}</span> : null}
        <Icon name="chevron" className="cfs-chev" />
      </button>
      {open && (
        <div id={body} className="cfs-body">
          {children}
        </div>
      )}
    </section>
  );
}

export function ConfSettings() {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const affect = admin || !!session?.profile.canAffect;
  // what each folded card says (the same answers the cards use inside: nothing is asked twice)
  const block = useRpc('confirmation.blockGet', {}, { staleTime: 30_000 });
  const assign = useRpc('assign.get', {}, { enabled: affect, staleTime: 30_000 });
  const pay = useRpc('admin.pay.get', {}, { enabled: admin });
  const notify = useRpc('notify.settings.get', {}, { enabled: admin });
  const auto = useRpc('auto.state', {}, { enabled: admin });
  const st = useRpc('admin.statuses.get', {}, { enabled: admin });
  const canBlock = !!block.data?.canSwitch;
  if (!admin && block.isLoading) return <Loading />;
  const parts = { qui: affect, appels: admin || canBlock, msg: admin, lente: admin, statuts: admin };
  if (!Object.values(parts).some(Boolean)) return <Empty>{t('confirmation.cfg.nothing')}</Empty>;

  const mode = assign.data?.cfg.conf.mode;
  const calls = pay.data?.calls;
  const callsState = [
    calls ? t(calls.cancelAfterNoAnswer ? 'confirmation.cfg.appels.s' : 'confirmation.cfg.appels.s0', { first: calls.firstMinutes, n: calls.cancelAfterNoAnswer }) : '',
    block.data?.on ? t('confirmation.cfg.appels.block') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const cases = notify.data?.settings.cases as Record<string, boolean> | undefined;
  const msgs = cases ? CONF_KINDS.filter((k) => cases[k]).length : null;
  const queue = auto.data?.s.queue;
  const statuses = st.data ? activeStatuses(st.data) : null;

  return (
    <div className="cfs">
      <div className="cfs-top">
        <h2>{t('confirmation.cfg.title')}</h2>
        <span className="cfs-who">
          <Icon name="lock" />
          {t('confirmation.cfg.who')}
        </span>
      </div>
      <div className="cfs-grid">
        {parts.qui && (
          <Fold id="qui" icon="users" title={t('confirmation.cfg.qui.t')} desc={t('confirmation.cfg.qui.d')} state={mode ? t(`admin.aa.mode.${mode}`) : null}>
            <Affectation areas={['conf']} embedded />
          </Fold>
        )}
        {parts.appels && (
          <Fold id="appels" icon="phone" title={t('confirmation.cfg.appels.t')} desc={t('confirmation.cfg.appels.d')} state={callsState || null}>
            {admin && <CallsForm />}
            <BlockSwitch />
          </Fold>
        )}
        {parts.msg && (
          <Fold id="msg" icon="message" title={t('confirmation.cfg.msg.t')} desc={t('confirmation.cfg.msg.d')} state={msgs === null ? null : msgs ? t('confirmation.cfg.msg.s', { count: msgs }) : t('confirmation.cfg.msg.s0')}>
            <Messages />
          </Fold>
        )}
        {parts.lente && (
          <Fold id="lente" icon="timer" title={t('confirmation.cfg.lente.t')} desc={t('confirmation.cfg.lente.d')} state={queue ? (queue.on ? t('confirmation.cfg.lente.on', { h: queue.waitHours }) : t('confirmation.cfg.lente.off')) : null}>
            <Automations view="queue" />
          </Fold>
        )}
        {parts.statuts && (
          <Fold id="statuts" icon="tag" title={t('confirmation.cfg.statuts.t')} desc={t('confirmation.cfg.statuts.d')} state={statuses === null ? null : t('confirmation.cfg.statuts.s', { count: statuses })}>
            <Statuts only="confirmation" embedded calls={false} />
          </Fold>
        )}
      </div>
    </div>
  );
}

/** Confirmation's statuses that are on: the base ones not hidden, and the boutique's own ones that behave like them. */
function activeStatuses(d: { groups: Record<string, { base: string[]; track: string }>; labels: unknown; custom: { key: string; track: string; behavesLike: string }[] }): number {
  const g = d.groups.confirmation;
  if (!g) return 0;
  const L = (d.labels ?? {}) as Record<string, { hidden?: boolean }>;
  const base = g.base.filter((k) => !L[k]?.hidden).length;
  const own = d.custom.filter((c) => c.track === g.track && g.base.includes(c.behavesLike) && !L[c.key]?.hidden).length;
  return base + own;
}

/** The messages sent to the customer before the parcel ships (on or off; their texts stay with all the messages for now),
 *  and the WhatsApp text the agents send from an order. */
function Messages() {
  const { t } = useTranslation();
  const full = useRpc('notify.settings.get', {});
  const shop = useRpc('admin.settings.get', {});
  const [busy, setBusy] = useState(false);
  const [tpl, setTpl] = useState<string | null>(null);
  const saveTpl = useAction('admin.shop.waTemplate', { success: t('confirmation.cfg.msg.saved'), onDone: () => setTpl(null) });
  const settings = full.data?.settings;
  const cases = settings?.cases as Record<string, boolean> | undefined;
  const flip = async (k: (typeof CONF_KINDS)[number], on: boolean) => {
    if (!settings) return;
    setBusy(true);
    try {
      await rpc('notify.settings.save', { ...settings, cases: { ...settings.cases, [k]: on } });
      await full.refetch();
      toast(t(on ? 'confirmation.cfg.msg.on' : 'confirmation.cfg.msg.off', { name: t(`notify.kind.${k}`) }), 'ok');
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const cur = tpl ?? shop.data?.shop.whatsappTemplate ?? '';
  return (
    <>
      <div className="cfs-sub">
        <h3>{t('confirmation.cfg.msg.auto')}</h3>
        <p className="muted small">{t('confirmation.cfg.msg.autoHint')}</p>
        {!cases ? (
          <Loading />
        ) : (
          <ul className="cfs-list">
            {CONF_KINDS.map((k) => (
              <li key={k}>
                <span>
                  <b>{t(`notify.kind.${k}`)}</b>
                  <small>{t(`confirmation.cfg.msg.when.${k}`)}</small>
                </span>
                <Switch checked={!!cases[k]} disabled={busy} label={t(`notify.kind.${k}`)} onChange={(v) => flip(k, v)} />
              </li>
            ))}
          </ul>
        )}
        <a className="btn small cfs-link" href="#/notify/cas">
          {t('confirmation.cfg.msg.texts')}
        </a>
      </div>
      <div className="cfs-sub">
        <h3>{t('admin.settings.whatsapp')}</h3>
        <p className="muted small">{t('admin.settings.whatsappHelp')}</p>
        <textarea rows={2} maxLength={500} value={cur} aria-label={t('admin.settings.whatsapp')} onChange={(e) => setTpl(e.target.value)} />
        <div className="row end">
          <button type="button" className="btn primary" disabled={saveTpl.isPending || tpl === null} onClick={() => saveTpl.mutate({ whatsappTemplate: cur.trim() })}>
            {t('common.save')}
          </button>
        </div>
      </div>
    </>
  );
}
