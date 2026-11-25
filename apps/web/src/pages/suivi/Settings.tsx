// Suivi › Réglages (owner's ask, 24 Nov 2026: each page keeps its own settings; design 1 « Onglet »). Everything Suivi
// needs (ui/PageSettings): who gets the new alerts (the Suivi part of Affectation), the alerts (which statuses send a parcel
// to Alertes, the agent's time, the tries, « Bloqués »: from Préférences), the messages to the customer once the parcel
// has left — each one with its switch and its text —, how every message to the customer is sent (WhatsApp, SMS, the
// language, the night), the tester and the results of the messages (step 5 of his table, 25 Nov: « une carte par chose »,
// from Pilot Automations › Messages), its notifications (Livrée, En retour, Alerte colis), the statuses of the parcels and
// the motifs of « Traiter ». Each card keeps who may change it today: an administrator everything, the people allowed to
// share the orders (« Affectation ») their card. The journal of the messages is Suivi's « Messages » tab.
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Fold, SettingsPage } from '../../ui/PageSettings';
import { Affectation } from '../admin/Affectation';
import { NotificationsCfg } from '../admin/Notifications';
import { Statuts } from '../admin/Statuts';
import { activeStatuses } from '../confirmation/Settings';
import { Preferences } from '../livraison/Preferences';
import { CaseSwitches, SUIVI_KINDS, useCasesOn } from '../notify/CaseSwitches';
import { NotifySettings, Results, Tester } from '../notify';

const SUIVI_NOTIFS = ['delivered', 'returned', 'alert'] as const;

export function SuiviSettings() {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const affect = admin || !!session?.profile.canAffect;
  const assign = useRpc('assign.get', {}, { enabled: affect, staleTime: 30_000 });
  const prefs = useRpc('prefs.get', {}, { enabled: admin });
  const msgs = useCasesOn(SUIVI_KINDS, admin);
  const sending = useRpc('notify.settings.get', {}, { enabled: admin }).data?.settings;
  const stats = useRpc('notify.stats', { days: 7 }, { enabled: admin }).data;
  const nt = useRpc('notify.get', {}, { enabled: admin });
  const st = useRpc('admin.statuses.get', {}, { enabled: admin });
  const mode = assign.data?.cfg.follow.mode;
  const p = prefs.data?.prefs;
  const statuses = st.data ? activeStatuses(st.data, ['suivi', 'livraison']) : null;
  const notifsOn = nt.data ? SUIVI_NOTIFS.filter((k) => nt.data!.rules[k].on).length : null;
  // how the messages leave: WhatsApp first (or not), then an SMS, by hand or nothing
  const how = !sending ? null : !sending.enabled ? 'off' : sending.whatsapp ? `wa_${sending.sms}` : sending.sms === 'off' ? 'none' : sending.sms;
  return (
    <SettingsPage title={t('suivi.cfg.title')}>
      {affect && (
        <Fold id="qui" icon="users" title={t('suivi.cfg.qui.t')} desc={t('suivi.cfg.qui.d')} state={mode ? t(`admin.aa.mode.${mode}`) : null}>
          <Affectation areas={['follow']} embedded />
        </Fold>
      )}
      {admin && (
        <Fold id="alertes" icon="alert" title={t('suivi.cfg.alertes.t')} desc={t('suivi.cfg.alertes.d')} state={p ? t('livraison.prefs.alerts.clockSum', { first: p.suiviClock.firstHours, solve: p.suiviClock.solveHours }) : null}>
          <Preferences parts={['alerts']} embedded />
        </Fold>
      )}
      {admin && (
        <Fold id="msg" icon="message" title={t('suivi.cfg.msg.t')} desc={t('suivi.cfg.msg.d')} state={msgs === null ? null : msgs ? t('confirmation.cfg.msg.s', { count: msgs }) : t('confirmation.cfg.msg.s0')}>
          <CaseSwitches kinds={SUIVI_KINDS} sendingHere />
        </Fold>
      )}
      {admin && (
        <Fold id="envoi" icon="send" title={t('suivi.cfg.envoi.t')} desc={t('suivi.cfg.envoi.d')} state={how ? t(`suivi.cfg.envoi.s.${how}`) : null}>
          <NotifySettings embedded />
        </Fold>
      )}
      {admin && (
        <Fold id="tester" icon="play" title={t('suivi.cfg.tester.t')} desc={t('suivi.cfg.tester.d')}>
          <Tester admin embedded />
        </Fold>
      )}
      {admin && (
        <Fold id="resultats" icon="chart" title={t('suivi.cfg.res.t')} desc={t('suivi.cfg.res.d')} state={stats ? t('suivi.cfg.res.s', { n: stats.sent }) : null}>
          <Results embedded />
        </Fold>
      )}
      {admin && (
        <Fold id="notifs" icon="bell" title={t('notifs.title')} desc={t('suivi.cfg.notifs.d')} state={notifsOn === null ? null : t('confirmation.cfg.notifs.s', { on: notifsOn, all: SUIVI_NOTIFS.length })}>
          <NotificationsCfg kinds={SUIVI_NOTIFS} embedded />
        </Fold>
      )}
      {admin && (
        <Fold id="statuts" icon="tag" title={t('suivi.cfg.statuts.t')} desc={t('suivi.cfg.statuts.d')} state={statuses === null ? null : t('confirmation.cfg.statuts.s', { count: statuses })}>
          <Statuts only={['suivi', 'livraison']} embedded calls={false} />
        </Fold>
      )}
    </SettingsPage>
  );
}
