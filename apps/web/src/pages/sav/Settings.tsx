// SAV › Réglages (owner's ask, 24 Nov 2026: each page keeps its own settings; design 1 « Onglet »): the SAV phone number
// (it was in Réglages › Boutique), the price of an exchange (it was in Management › Prix de livraison › Tickets SAV; step 6
// of his table, 25 Nov) and the SAV statuses (ui/PageSettings). Administrators (the server checks it too).
import { WILAYAS } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Fold, SettingsPage } from '../../ui/PageSettings';
import { SavFees } from '../admin/Prix';
import { Statuts } from '../admin/Statuts';
import { activeStatuses } from '../confirmation/Settings';

export function SavSettings() {
  const { t } = useTranslation();
  const admin = !!useSession().session?.isAdmin;
  const shop = useRpc('admin.settings.get', {}, { enabled: admin });
  const st = useRpc('admin.statuses.get', {}, { enabled: admin });
  const statuses = st.data ? activeStatuses(st.data, ['sav']) : null;
  const phone = shop.data?.shop.savPhone;
  const fees = useRpc('admin.fees.get', {}, { enabled: admin }).data;
  // the wilayas that have an exchange price
  const priced = fees ? Object.values(fees.savFees ?? {}).filter((r) => r.home || r.desk).length : null;
  return (
    <SettingsPage title={t('sav.cfg.title')}>
      {admin && (
        <Fold id="phone" icon="phone" title={t('admin.settings.savPhone')} desc={t('sav.cfg.phone')} state={shop.data ? phone || t('sav.cfg.none') : null}>
          <SavPhone />
        </Fold>
      )}
      {admin && (
        <Fold id="prix" icon="truck" title={t('sav.cfg.prix.t')} desc={t('sav.cfg.prix.d')} state={priced === null ? null : priced ? t('sav.cfg.prix.s', { n: priced, all: WILAYAS.length }) : t('sav.cfg.prix.none')}>
          <SavFees />
        </Fold>
      )}
      {admin && (
        <Fold id="statuts" icon="tag" title={t('confirmation.cfg.statuts.t')} desc={t('sav.cfg.statuts')} state={statuses === null ? null : t('confirmation.cfg.statuts.s', { count: statuses })}>
          <Statuts only="sav" embedded calls={false} />
        </Fold>
      )}
    </SettingsPage>
  );
}

function SavPhone() {
  const { t } = useTranslation();
  const shop = useRpc('admin.settings.get', {});
  const [v, setV] = useState<string | null>(null);
  const save = useAction('admin.shop.patch', { success: t('admin.settings.saved'), onDone: () => setV(null) });
  const cur = v ?? shop.data?.shop.savPhone ?? '';
  return (
    <div className="cfs-sub">
      <p className="muted small">{t('admin.settings.savPhoneHelp')}</p>
      <div className="cfs-inline">
        <input type="tel" inputMode="tel" autoComplete="off" maxLength={40} placeholder="0550 12 34 56" aria-label={t('admin.settings.savPhone')} value={cur} onChange={(e) => setV(e.target.value)} />
        <button type="button" className="btn primary" disabled={save.isPending || v === null} onClick={() => save.mutate({ savPhone: cur.trim() })}>
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}
