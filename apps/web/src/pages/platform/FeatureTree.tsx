// The menus and sub-menus of Pilotix, ticked or not: what a plan includes, or what one shop has on top of its plan.
import { FEATURES } from '@pilotix/shared';
import { useTranslation } from 'react-i18next';

/** The app's own name of each sub-menu (the same words as in its pages). */
const SUB_LABEL: Record<string, string> = {
  'dashboard/overview': 'dashboard.areas.overview',
  'dashboard/doctor': 'dashboard.areas.doctor',
  'dashboard/confirmation': 'dashboard.areas.confirmation',
  'dashboard/depot': 'dashboard.areas.depot',
  'dashboard/suivi': 'dashboard.areas.suivi',
  'dashboard/livreurs': 'dashboard.areas.livreurs',
  'dashboard/sav': 'dashboard.areas.sav',
  'commandes/confirmation': 'nav.sub.confirmation',
  'commandes/depot': 'nav.sub.depot',
  'commandes/suivi': 'nav.sub.suivi',
  'produits/stock': 'produits.tabs.stock',
  'produits/inventaire': 'produits.tabs.inventaire',
  'produits/produits': 'produits.tabs.produits',
  'produits/mouvements': 'produits.tabs.mouvements',
  'produits/alertes': 'produits.tabs.alertes',
  'produits/achats': 'produits.tabs.achats',
  'produits/depots': 'produits.tabs.depots',
  'pilotai/messages': 'nav.sub.messages',
  'pilotai/cm': 'nav.sub.cm',
  'pilotai/notify': 'nav.sub.notify',
  'marketing/publicite': 'nav.publicite',
  'marketing/marketer': 'nav.marketer',
  'marketing/spy': 'nav.spy',
  'caisse/overview': 'caisse.dk.tabs.overview',
  'caisse/due': 'caisse.tabs.due',
  'caisse/done': 'caisse.tabs.done',
  'caisse/livreurs': 'caisse.tabs.livreurs',
  'caisse/journal': 'caisse.ph.journal',
  'livraison/societes': 'livraison.tabs.societes',
  'livraison/api': 'livraison.tabs.api',
  'livraison/livreurs': 'livraison.tabs.livreurs',
  'management/statuts': 'admin.subs.statuts',
  'management/paie': 'admin.subs.paie',
  'management/prix': 'admin.subs.prix',
  'management/canaux': 'admin.subs.canaux',
};

export const featureLabel = (t: (k: string) => string, key: string) => (key.includes('/') ? t(SUB_LABEL[key] ?? key) : t(`nav.${key}`));

/** `changed`: the keys this shop has on or off on its own (marked, so the plan's own choice stays visible). */
export function FeatureTree({ isOn, changed = () => false, onToggle, disabled }: { isOn: (key: string) => boolean; changed?: (key: string) => boolean; onToggle: (key: string, on: boolean) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="pp-ft">
      {FEATURES.map((f) => {
        const on = f.always || isOn(f.key);
        return (
          <div key={f.key} className={`pp-ft-item ${on ? 'on' : ''}`}>
            <label className={`pp-ft-top ${changed(f.key) ? 'changed' : ''}`}>
              <input type="checkbox" checked={on} disabled={disabled || f.always} onChange={(e) => onToggle(f.key, e.target.checked)} />
              <b>{featureLabel(t, f.key)}</b>
              {f.always && <small className="muted">{t('platform.ft.always')}</small>}
              {changed(f.key) && <small className="pp-ft-dot">{t('platform.ft.changed')}</small>}
            </label>
            {!!f.subs?.length && (
              <div className="pp-ft-subs">
                {f.subs.map((s) => {
                  const k = `${f.key}/${s}`;
                  return (
                    <label key={k} className={`pp-ft-sub ${changed(k) ? 'changed' : ''}`}>
                      <input type="checkbox" checked={on && isOn(k)} disabled={disabled || !on} onChange={(e) => onToggle(k, e.target.checked)} />
                      <span>{featureLabel(t, k)}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
