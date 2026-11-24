// Suivi › Réglages (owner's ask, 24 Nov 2026: each page keeps its own settings; design 1 « Onglet »). Everything Suivi
// needs (ui/PageSettings): who gets the new alerts (the Suivi part of Affectation), the alerts (which statuses send a parcel
// to Alertes, the agent's time, the tries, « Bloqués »: from Préférences), the messages to the customer once the parcel
// has left (on or off, and how they are sent: « Réglages des messages »), the statuses of the parcels and the motifs of
// « Traiter ». Each card keeps who may change it today: an administrator everything, the people allowed to share the
// orders (« Affectation ») their card.
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Fold, SettingsPage } from '../../ui/PageSettings';
import { Affectation } from '../admin/Affectation';
import { Statuts } from '../admin/Statuts';
import { activeStatuses } from '../confirmation/Settings';
import { Preferences } from '../livraison/Preferences';
import { CaseSwitches, SUIVI_KINDS, useCasesOn } from '../notify/CaseSwitches';
import { NotifySettings } from '../notify';

export function SuiviSettings() {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const affect = admin || !!session?.profile.canAffect;
  const assign = useRpc('assign.get', {}, { enabled: affect, staleTime: 30_000 });
  const prefs = useRpc('prefs.get', {}, { enabled: admin });
  const msgs = useCasesOn(SUIVI_KINDS, admin);
  const st = useRpc('admin.statuses.get', {}, { enabled: admin });
  const mode = assign.data?.cfg.follow.mode;
  const p = prefs.data?.prefs;
  const statuses = st.data ? activeStatuses(st.data, ['suivi', 'livraison']) : null;
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
          <CaseSwitches kinds={SUIVI_KINDS} />
          <div className="cfs-sub">
            <h3>{t('suivi.cfg.msg.how')}</h3>
            <NotifySettings />
          </div>
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
