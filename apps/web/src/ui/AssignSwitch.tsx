// « Toutes / Non affectées / Affectées » (the owner's ask, 25 Nov 2026, design 2 « Interrupteur »): the managers' switch
// on the work lists — Confirmation › Nouvelles and En cours, Suivi › the alerts. The owner, the agent managers and a
// confirmation agency's chiefs see it; a plain agent never does (he only has the orders given to him).
// Same look as Confirmées' « Liste / Statistiques » (.px-vsw): next to the list's title when the card has room, on its
// own line under it when not (styles/pilotix.css › .px-assign).
import { useTranslation } from 'react-i18next';
import { n } from '../lib/format';

export type Assign = 'all' | 'free' | 'given';
const KEYS: Assign[] = ['all', 'free', 'given'];

/** What the list asks the server: nothing for « Toutes ». */
export const assignedInput = (a: Assign): 'free' | 'given' | undefined => (a === 'all' ? undefined : a);

export function AssignSwitch({ value, onChange, counts }: { value: Assign; onChange: (v: Assign) => void; counts?: { free: number; given: number } | null }) {
  const { t } = useTranslation();
  return (
    <div className="px-assign">
      <div className="px-vsw" role="radiogroup" aria-label={t('common.assign.label')}>
        {KEYS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={value === k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>
            {t(`common.assign.${k}`)}
            {k !== 'all' && counts && <span className="px-assign-n ltr">{n(counts[k])}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
