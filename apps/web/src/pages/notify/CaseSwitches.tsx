// The messages sent to the customer by themselves, switched on or off where they belong (owner's ask, 24 Nov 2026: each
// page keeps its own settings): Confirmation › Réglages (received, no answer, confirmed), Suivi › Réglages (from shipped
// to delivered). Their texts stay with all the messages (Pilot Automations › Messages › Cas) for now.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { useRpc } from '../../lib/query';
import { Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { Switch } from '../admin/bits';

export const CONF_KINDS = ['created', 'no_answer', 'confirmed'] as const;
export const SUIVI_KINDS = ['shipped', 'out_for_delivery', 'stopdesk', 'failed', 'returning', 'delivered'] as const;
type Kind = (typeof CONF_KINDS)[number] | (typeof SUIVI_KINDS)[number];

/** How many of these messages are on (null while not known). */
export function useCasesOn(kinds: readonly Kind[], enabled = true): number | null {
  const q = useRpc('notify.settings.get', {}, { enabled });
  const cases = q.data?.settings.cases as Record<string, boolean> | undefined;
  return cases ? kinds.filter((k) => cases[k]).length : null;
}

export function CaseSwitches({ kinds }: { kinds: readonly Kind[] }) {
  const { t } = useTranslation();
  const full = useRpc('notify.settings.get', {});
  const [busy, setBusy] = useState(false);
  const settings = full.data?.settings;
  const cases = settings?.cases as Record<string, boolean> | undefined;
  const flip = async (k: Kind, on: boolean) => {
    if (!settings) return;
    setBusy(true);
    try {
      await rpc('notify.settings.save', { ...settings, cases: { ...settings.cases, [k]: on } });
      await full.refetch();
      toast(t(on ? 'confirmation.cfg.msg.on' : 'confirmation.cfg.msg.off', { name: t(`notify.kind.${k}`) }), 'ok');
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cfs-sub">
      <h3>{t('confirmation.cfg.msg.auto')}</h3>
      <p className="muted small">{t('confirmation.cfg.msg.autoHint')}</p>
      {!cases ? (
        <Loading />
      ) : (
        <ul className="cfs-list">
          {kinds.map((k) => (
            <li key={k}>
              <span>
                <b>{t(`notify.kind.${k}`)}</b>
                <small>{t(`notify.cfgWhen.${k}`)}</small>
              </span>
              <Switch checked={!!cases[k]} disabled={busy} label={t(`notify.kind.${k}`)} onChange={(v) => flip(k, v)} />
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">{t('confirmation.cfg.msg.textsWhere')}</p>
      <a className="btn small cfs-link" href="#/notify/cas">
        {t('confirmation.cfg.msg.texts')}
      </a>
    </div>
  );
}
