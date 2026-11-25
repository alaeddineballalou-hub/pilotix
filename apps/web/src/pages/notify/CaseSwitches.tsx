// The messages sent to the customer by themselves, where they belong (owner's ask, 24 Nov 2026: each page keeps its own
// settings): Confirmation › Réglages (received, no answer, confirmed), Suivi › Réglages (from shipped to delivered). Each
// case shows its switch and its text together (step 5 of his table, 25 Nov: the texts left Pilot Automations › Cas); how
// they are sent (WhatsApp, SMS, the language, the night) is Suivi › Réglages › « Envoi des messages », for all of them.
import { useTranslation } from 'react-i18next';
import { useRpc } from '../../lib/query';
import { openFold } from '../../ui/PageSettings';
import { Cases } from './index';

export const CONF_KINDS = ['created', 'no_answer', 'confirmed'] as const;
export const SUIVI_KINDS = ['shipped', 'out_for_delivery', 'stopdesk', 'failed', 'returning', 'delivered'] as const;
type Kind = (typeof CONF_KINDS)[number] | (typeof SUIVI_KINDS)[number];

/** How many of these messages are on (null while not known). */
export function useCasesOn(kinds: readonly Kind[], enabled = true): number | null {
  const q = useRpc('notify.settings.get', {}, { enabled });
  const cases = q.data?.settings.cases as Record<string, boolean> | undefined;
  return cases ? kinds.filter((k) => cases[k]).length : null;
}

/** `sendingHere`: the card « Envoi des messages » is on this page (Suivi): « Ouvrir » opens it; elsewhere, a link to it. */
export function CaseSwitches({ kinds, sendingHere = false }: { kinds: readonly Kind[]; sendingHere?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="cfs-sub">
      <h3>{t('confirmation.cfg.msg.auto')}</h3>
      <p className="muted small">
        {t('confirmation.cfg.msg.sendingWhere')}{' '}
        {sendingHere ? (
          <button type="button" className="cfs-lnk" onClick={() => openFold('envoi')}>
            {t('confirmation.cfg.msg.sendingOpen')}
          </button>
        ) : (
          <a className="cfs-lnk" href="#/suivi/reglages">
            {t('confirmation.cfg.msg.sendingLink')}
          </a>
        )}
      </p>
      <Cases admin embedded kinds={kinds} />
    </div>
  );
}
