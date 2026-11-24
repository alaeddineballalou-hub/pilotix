// Dépôt › Réglages (owner's ask, 24 Nov 2026: each page keeps its own settings; design 1 « Onglet »): the automatic
// dispatch, who gets the red alert when an order still in the depot is changed, and the depot's statuses (ui/PageSettings).
// Its scans are in its stages now (« En dispatch », « Retours »): Scanner left the menu. Administrators: every card here
// is theirs today (the server checks it too).
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Fold, SettingsPage } from '../../ui/PageSettings';
import { DepotAlertsCfg } from '../admin';
import { Statuts } from '../admin/Statuts';
import { activeStatuses } from '../confirmation/Settings';
import { Automations } from '../notify/Automations';

export function DepotSettings() {
  const { t } = useTranslation();
  const admin = !!useSession().session?.isAdmin;
  const auto = useRpc('auto.state', {}, { enabled: admin });
  const alerts = useRpc('depot.alertConfig', {}, { enabled: admin });
  const st = useRpc('admin.statuses.get', {}, { enabled: admin });
  const statuses = st.data ? activeStatuses(st.data, ['depot']) : null;
  const to = alerts.data?.to.length;
  return (
    <SettingsPage title={t('depot.cfg.title')}>
      {admin && (
        <Fold id="dispatch" icon="truck" title={t('notify.auto.dispatch.name')} desc={t('depot.cfg.dispatch')} state={auto.data ? t(auto.data.s.autoDispatch ? 'depot.cfg.on' : 'depot.cfg.off') : null}>
          <Automations view="dispatch" />
        </Fold>
      )}
      {admin && (
        <Fold id="alertes" icon="alert" title={t('admin.dalert.title')} desc={t('depot.cfg.alerts')} state={to === undefined ? null : to ? t('depot.cfg.alertsTo', { count: to }) : t('depot.cfg.alertsAll')}>
          <DepotAlertsCfg embedded />
        </Fold>
      )}
      {admin && (
        <Fold id="statuts" icon="tag" title={t('confirmation.cfg.statuts.t')} desc={t('depot.cfg.statuts')} state={statuses === null ? null : t('confirmation.cfg.statuts.s', { count: statuses })}>
          <Statuts only="depot" embedded calls={false} />
        </Fold>
      )}
    </SettingsPage>
  );
}
