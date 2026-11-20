// « Bientôt »: the menu items and sub-menus Pilotix is still finishing. Every boutique sees them greyed with « Bientôt »
// in its menu and nobody can open them; taken off the list, one opens again (as each boutique's plan says). Saved with
// the page's « Enregistrer » (the platform's settings, `soon`).
import { FEATURES } from '@pilotix/shared';
import { useTranslation } from 'react-i18next';
import { Card, Field } from '../../ui/kit';
import { featureLabel } from './FeatureTree';

/** what can be put « Bientôt »: a menu item (all of it) or one of its sub-menus; never one a shop cannot work without */
const GROUPS = FEATURES.filter((f) => !f.always).map((f) => ({ key: f.key, keys: [f.key, ...(f.subs ?? []).map((s) => `${f.key}/${s}`)] }));

export function SoonBox({ owner, list, onChange }: { owner: boolean; list: string[]; onChange: (list: string[]) => void }) {
  const { t } = useTranslation();
  const name = (k: string) => (k.includes('/') ? `${featureLabel(t, k.split('/')[0])} › ${featureLabel(t, k)}` : featureLabel(t, k));
  return (
    <Card title={t('platform.set.soonTitle')} help={t('platform.set.soonHelp')}>
      {list.length ? (
        <ul className="pp-soon-list">
          {list.map((k) => (
            <li key={k}>
              <span className="pp-ft-soon">{t('platform.ft.soon')}</span>
              <b>{name(k)}</b>
              {owner && (
                <button type="button" className="btn small" onClick={() => onChange(list.filter((x) => x !== k))}>
                  {t('platform.set.soonOpen')}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">{t('platform.set.soonNone')}</p>
      )}
      {owner && (
        <>
          <Field label={t('platform.set.soonAdd')}>
            <select value="" onChange={(e) => e.target.value && !list.includes(e.target.value) && onChange([...list, e.target.value])}>
              <option value="">{t('platform.set.soonPick')}</option>
              {GROUPS.map((g) => (
                <optgroup key={g.key} label={featureLabel(t, g.key)}>
                  {g.keys
                    .filter((k) => !list.includes(k))
                    .map((k) => (
                      <option key={k} value={k}>
                        {k === g.key ? t('platform.set.soonWhole', { name: featureLabel(t, k) }) : featureLabel(t, k)}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <p className="small muted">{t('platform.set.soonSave')}</p>
        </>
      )}
    </Card>
  );
}
