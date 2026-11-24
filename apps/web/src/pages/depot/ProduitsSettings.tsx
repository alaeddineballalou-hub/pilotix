// Produits & stock › Réglages (owner's ask, 24 Nov 2026: each page keeps its own settings; design 1 « Onglet »): what
// Pilotix does when a product runs out or comes back (the stock's automations), when an order waiting for stock rings an
// alert (Préférences), and the lots and manufacturing switches (Management › Stock) (ui/PageSettings). Administrators.
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Fold, SettingsPage } from '../../ui/PageSettings';
import { StockCfg } from '../admin';
import { Preferences } from '../livraison/Preferences';
import { Automations } from '../notify/Automations';

export function ProduitsSettings() {
  const { t } = useTranslation();
  const admin = !!useSession().session?.isAdmin;
  const auto = useRpc('auto.state', {}, { enabled: admin });
  const prefs = useRpc('prefs.get', {}, { enabled: admin });
  const lots = useRpc('stock.batchConfig', {}, { enabled: admin });
  const making = useRpc('stock.makingConfig', {}, { enabled: admin });
  const s = auto.data?.s;
  const rules = s ? [s.noStock.on && t('notify.auto.nostock.name'), s.stockBack && t('notify.auto.stockback.name')].filter(Boolean).join(' · ') || t('depot.cfg.off') : null;
  const extras = lots.data && making.data ? [lots.data.on && t('produits.tabs.lots'), making.data.on && t('produits.tabs.fabrication')].filter(Boolean).join(' · ') || t('depot.cfg.off') : null;
  return (
    <SettingsPage title={t('produits.cfg.title')}>
      {admin && (
        <Fold id="rules" icon="layers" title={t('produits.cfg.rulesT')} desc={t('produits.cfg.rules')} state={rules}>
          <Automations view="stock" />
        </Fold>
      )}
      {admin && (
        <Fold id="wait" icon="alert" title={t('livraison.prefs.noStock')} desc={t('livraison.prefs.noStockHint')} state={prefs.data ? t('livraison.prefs.sum.noStock', { count: prefs.data.prefs.noStockDays }).replace(/[.。]$/, '') : null}>
          <Preferences parts={['stock']} embedded />
        </Fold>
      )}
      {admin && (
        <Fold id="lots" icon="calendar" title={t('produits.cfg.lotsT')} desc={t('produits.cfg.lots')} state={extras}>
          <StockCfg embedded />
        </Fold>
      )}
    </SettingsPage>
  );
}
