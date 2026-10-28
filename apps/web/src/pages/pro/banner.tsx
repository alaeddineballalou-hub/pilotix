// In a store, its own marketer (not a partner's person): « Passer Pro » opens a marketer space of their own (one per
// account), which can then ask Pilotix to be Pro (#/comptepro there).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AddStoreModal } from '../../layout/Accounts';
import { useSession } from '../../lib/session';
import { Icon } from '../../ui/kit';
import './pro.css';

// ---------------------------------------------------------------- in a store: its own marketer can go Pro
export function ProBanner() {
  const { t } = useTranslation();
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const s = session!;
  if (!s.shop || s.shop.kind !== 'store' || s.shop.demo || !s.roles.includes('marketer') || s.isAdmin || s.profile.agencyId || !s.shop.canAddMarketer) return null;
  return (
    <>
      <section className="prx-banner">
        <span className="prx-medal">
          <Icon name="medal" />
        </span>
        <div className="grow">
          <b>{t('pro.banner.title')}</b>
          <p>{t('pro.banner.text')}</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setOpen(true)}>
          {t('pro.banner.go')}
        </button>
      </section>
      {open && <AddStoreModal kind="marketer" onClose={() => setOpen(false)} />}
    </>
  );
}
