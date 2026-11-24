// Confirmation › Réglages (owner's ask, 24 Nov 2026: each page keeps its own settings; design 1 « Onglet », the last tab
// of the bar with a gear). Everything Confirmation needs: who gets the new orders (the Confirmation part of Affectation),
// the calls (first call, call-backs, tries, call slots, auto-cancel, « Bloquer jusqu'à l'appel »), the messages to the
// customer (the automatic ones, the two the agents send a customer who does not answer, the agents' WhatsApp text), the
// slow queue alert and the statuses (ui/PageSettings).
// Each card keeps who may change it today (the server checks it too): an administrator everything, the agent managers and
// the owners the « Bloquer » switch, the people allowed to share the orders (« Affectation ») their card.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Loading } from '../../ui/kit';
import { Fold, SettingsPage } from '../../ui/PageSettings';
import { Affectation } from '../admin/Affectation';
import { CallsForm, Statuts } from '../admin/Statuts';
import { CustomerMessagesCard } from '../admin/CustomerMessages';
import { NotificationsCfg } from '../admin/Notifications';
import { CaseSwitches, CONF_KINDS, useCasesOn } from '../notify/CaseSwitches';
import { Automations } from '../notify/Automations';
import { BlockSwitch } from './BlockSwitch';

/** Confirmation's notifications in the bell: a new order, a call-back, an order taken away, an order cancelled. */
const CONF_NOTIFS = ['order', 'callback', 'taken', 'cancelled'] as const;

export function ConfSettings() {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const affect = admin || !!session?.profile.canAffect;
  // what each folded card says (the same answers the cards use inside: nothing is asked twice)
  const block = useRpc('confirmation.blockGet', {}, { staleTime: 30_000 });
  const assign = useRpc('assign.get', {}, { enabled: affect, staleTime: 30_000 });
  const pay = useRpc('admin.pay.get', {}, { enabled: admin });
  const msgs = useCasesOn(CONF_KINDS, admin);
  const auto = useRpc('auto.state', {}, { enabled: admin });
  const st = useRpc('admin.statuses.get', {}, { enabled: admin });
  // its four notifications in the bell (they were only in Management › Notifications)
  const nt = useRpc('notify.get', {}, { enabled: admin });
  const canBlock = !!block.data?.canSwitch;
  if (!admin && block.isLoading) return <Loading />;

  const mode = assign.data?.cfg.conf.mode;
  const calls = pay.data?.calls;
  const callsState = [
    calls ? t(calls.cancelAfterNoAnswer ? 'confirmation.cfg.appels.s' : 'confirmation.cfg.appels.s0', { first: calls.firstMinutes, n: calls.cancelAfterNoAnswer }) : '',
    block.data?.on ? t('confirmation.cfg.appels.block') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const queue = auto.data?.s.queue;
  const statuses = st.data ? activeStatuses(st.data, ['confirmation']) : null;
  const notifsOn = nt.data ? CONF_NOTIFS.filter((k) => nt.data!.rules[k].on).length : null;

  return (
    <SettingsPage title={t('confirmation.cfg.title')}>
      {affect && (
        <Fold id="qui" icon="users" title={t('confirmation.cfg.qui.t')} desc={t('confirmation.cfg.qui.d')} state={mode ? t(`admin.aa.mode.${mode}`) : null}>
          <Affectation areas={['conf']} embedded />
        </Fold>
      )}
      {(admin || canBlock) && (
        <Fold id="appels" icon="phone" title={t('confirmation.cfg.appels.t')} desc={t('confirmation.cfg.appels.d')} state={callsState || null}>
          {admin && <CallsForm />}
          <BlockSwitch />
        </Fold>
      )}
      {admin && (
        <Fold id="msg" icon="message" title={t('confirmation.cfg.msg.t')} desc={t('confirmation.cfg.msg.d')} state={msgs === null ? null : msgs ? t('confirmation.cfg.msg.s', { count: msgs }) : t('confirmation.cfg.msg.s0')}>
          <CaseSwitches kinds={CONF_KINDS} />
          {/* the customer who does not answer: the agent's two messages (at the try chosen in « Appels », and before the cancel) */}
          <CustomerMessagesCard embedded />
          <WaTemplate />
        </Fold>
      )}
      {admin && (
        <Fold id="notifs" icon="bell" title={t('notifs.title')} desc={t('confirmation.cfg.notifs.d')} state={notifsOn === null ? null : t('confirmation.cfg.notifs.s', { on: notifsOn, all: CONF_NOTIFS.length })}>
          <NotificationsCfg kinds={CONF_NOTIFS} embedded folds={['appels']} />
        </Fold>
      )}
      {admin && (
        <Fold id="lente" icon="timer" title={t('confirmation.cfg.lente.t')} desc={t('confirmation.cfg.lente.d')} state={queue ? (queue.on ? t('confirmation.cfg.lente.on', { h: queue.waitHours }) : t('confirmation.cfg.lente.off')) : null}>
          <Automations view="queue" />
        </Fold>
      )}
      {admin && (
        <Fold id="statuts" icon="tag" title={t('confirmation.cfg.statuts.t')} desc={t('confirmation.cfg.statuts.d')} state={statuses === null ? null : t('confirmation.cfg.statuts.s', { count: statuses })}>
          <Statuts only="confirmation" embedded calls={false} />
        </Fold>
      )}
    </SettingsPage>
  );
}

/** The statuses of these groups that are on: the base ones not hidden, and the boutique's own ones that behave like them. */
export function activeStatuses(d: { groups: Record<string, { base: string[]; track: string }>; labels: unknown; custom: { key: string; track: string; behavesLike: string }[] }, groups: readonly string[]): number {
  const L = (d.labels ?? {}) as Record<string, { hidden?: boolean }>;
  let n = 0;
  for (const name of groups) {
    const g = d.groups[name];
    if (!g) continue;
    n += g.base.filter((k) => !L[k]?.hidden).length;
    n += d.custom.filter((c) => c.track === g.track && g.base.includes(c.behavesLike) && !L[c.key]?.hidden).length;
  }
  return n;
}

/** The WhatsApp text the agents send from an order (« Bonjour {nom}… »). */
function WaTemplate() {
  const { t } = useTranslation();
  const shop = useRpc('admin.settings.get', {});
  const [tpl, setTpl] = useState<string | null>(null);
  const save = useAction('admin.shop.patch', { success: t('confirmation.cfg.msg.saved'), onDone: () => setTpl(null) });
  const cur = tpl ?? shop.data?.shop.whatsappTemplate ?? '';
  return (
    <div className="cfs-sub">
      <h3>{t('admin.settings.whatsapp')}</h3>
      <p className="muted small">{t('admin.settings.whatsappHelp')}</p>
      <textarea rows={2} maxLength={500} value={cur} aria-label={t('admin.settings.whatsapp')} onChange={(e) => setTpl(e.target.value)} />
      <div className="row end">
        <button type="button" className="btn primary" disabled={save.isPending || tpl === null} onClick={() => save.mutate({ whatsappTemplate: cur.trim() })}>
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}
