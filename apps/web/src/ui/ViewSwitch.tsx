// « Cartes » / « Tableau » on a computer: the screens drawn like the phone (cards, the numbers you tap) keep the big
// table one click away (bulk actions, every column). The choice is remembered per screen on this computer.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { store } from '../lib/store';
import { Icon } from './kit';

export type ViewMode = 'cards' | 'table';

export function useViewMode(key: string): [ViewMode, (m: ViewMode) => void] {
  const [m, setM] = useState<ViewMode>(() => (store.get(`view-${key}`) === 'table' ? 'table' : 'cards'));
  return [
    m,
    (v) => {
      setM(v);
      store.set(`view-${key}`, v === 'cards' ? null : v);
    },
  ];
}

export function ViewSwitch({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  const { t } = useTranslation();
  return (
    <div className="px-vsw" role="radiogroup" aria-label={t('common.view')}>
      {(['cards', 'table'] as ViewMode[]).map((k) => (
        <button key={k} type="button" role="radio" aria-checked={mode === k} className={mode === k ? 'on' : ''} onClick={() => onChange(k)}>
          <Icon name={k === 'cards' ? 'layers' : 'list'} /> {t(k === 'cards' ? 'common.viewCards' : 'common.viewTable')}
        </button>
      ))}
    </div>
  );
}
