// « Bloquer l'agent jusqu'à l'appel »: the managers' switch, at the top of Confirmation (owner's ask, 22 Nov 2026: managers
// only turn it on or off). On, a new order given to a plain agent covers his Pilotix and rings until he calls and saves a
// result (NewOrderBlock.tsx). Off in a new shop. Only the shop's managers, the owner and the administrators see it.
import { useTranslation } from 'react-i18next';
import { when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Icon } from '../../ui/kit';
import { Switch } from '../admin/bits';
import './newOrderBlock.css';

export function BlockSwitch() {
  const { t } = useTranslation();
  const q = useRpc('confirmation.blockGet', {}, { staleTime: 60_000 });
  const set = useAction('confirmation.blockSet', { success: (r) => t(r.on ? 'confirmation.nob.sw.savedOn' : 'confirmation.nob.sw.savedOff') });
  const b = q.data;
  if (!b?.canSwitch) return null;
  return (
    <div className={`nob-sw${b.on ? ' on' : ''}`}>
      <span className="nob-sw-ic" aria-hidden="true">
        <Icon name="lock" />
      </span>
      <div className="nob-sw-t">
        <b>
          {t('confirmation.nob.sw.title')}
          <span className={`nob-sw-chip${b.on ? ' on' : ''}`}>{t(b.on ? 'confirmation.nob.sw.on' : 'confirmation.nob.sw.off')}</span>
        </b>
        <small>
          {t('confirmation.nob.sw.help')}
          {b.by && b.at ? ` ${t('confirmation.nob.sw.by', { name: b.by, when: when(b.at) })}` : ''}
        </small>
      </div>
      <Switch checked={b.on} disabled={set.isPending} label={t('confirmation.nob.sw.title')} onChange={(on) => set.mutate({ on })} />
    </div>
  );
}
