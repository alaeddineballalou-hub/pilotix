// Management › Modules (administrators): the parts of Pilotix a boutique turns on when it needs them (Point de vente…).
// Off at first; while one is off nobody sees its page and its actions refuse (@pilotix/core modules/shopmodules.ts).
import { SHOP_MODULES, type ShopModule } from '@pilotix/shared';
import { useTranslation } from 'react-i18next';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { Switch } from './bits';
import './modules.css';

const ICON: Record<ShopModule, string> = { pos: 'store' };
const PAGE: Record<ShopModule, string> = { pos: '#/pos' };

export function Modules() {
  const { t } = useTranslation();
  const q = useRpc('modules.get', {});
  const set = useAction('modules.set');
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Loading />;
  const mods = q.data;
  const flip = (m: ShopModule, on: boolean) => set.mutate({ module: m, on }, { onSuccess: () => toast(t(on ? 'admin.mod.onOk' : 'admin.mod.offOk', { name: t(`admin.mod.${m}.name`) }), 'ok') });
  return (
    <div className="card px-mods">
      <h2>{t('admin.mod.title')}</h2>
      <p className="muted">{t('admin.mod.help')}</p>
      <ul className="px-mods-list">
        {SHOP_MODULES.map((m) => (
          <li key={m} className={`px-mod ${mods[m] ? 'on' : ''}`}>
            <span className="px-mod-ic" aria-hidden="true">
              <Icon name={ICON[m]} />
            </span>
            <span className="px-mod-t">
              <b>{t(`admin.mod.${m}.name`)}</b>
              <small className="muted">{t(`admin.mod.${m}.text`)}</small>
              {mods[m] && (
                <a href={PAGE[m]} className="px-mod-go">
                  {t('admin.mod.open')}
                  <Icon name="chevr" className="px-mod-flip" />
                </a>
              )}
            </span>
            <span className={`px-mod-state ${mods[m] ? 'on' : ''}`}>{mods[m] ? t('admin.mod.on') : t('admin.mod.off')}</span>
            <Switch checked={mods[m]} disabled={set.isPending} label={t('admin.mod.switch', { name: t(`admin.mod.${m}.name`) })} onChange={(on) => flip(m, on)} />
          </li>
        ))}
      </ul>
    </div>
  );
}
