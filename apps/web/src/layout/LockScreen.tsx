// The shop's Pilotix subscription stopped (unpaid after the grace days, or suspended by Pilotix): this screen instead
// of the app. The administrator sees how to pay; the team, whom to ask. Orders keep coming in meanwhile.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../lib/session';
import { Icon } from '../ui/kit';
import { PayInfo } from './ShopBanner';
import { BrandBig } from './PxWordmark';

export function LockScreen() {
  const { t } = useTranslation();
  const { session, refresh, logout } = useSession();
  const [busy, setBusy] = useState(false);
  const [still, setStill] = useState(false);
  const shop = session?.shop;
  if (!session || !shop) return null;
  const suspended = shop.state === 'suspended';
  const check = async () => {
    setBusy(true);
    setStill(false);
    try {
      await refresh();
      setStill(true); // still here: not active yet (an active shop leaves this screen)
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login px-lock">
      <div className="card login-card">
        <BrandBig />
        <div className="px-lock-ic" aria-hidden="true">
          <Icon name="lock" />
        </div>
        <h2 className="login-title">{suspended ? t('shop.suspendedTitle') : t('shop.lockTitle')}</h2>
        <p className="login-note">
          <b>{shop.name}</b>
        </p>
        <p className="login-note">{suspended ? t('shop.suspendedText') : session.isAdmin ? t('shop.lockText') : t('shop.lockStaff')}</p>
        {session.isAdmin && <PayInfo shop={shop} />}
        {still && <p className="form-err">{t('shop.stillLocked')}</p>}
        <div className="row" style={{ gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          {!suspended && session.isAdmin && (
            <button type="button" className="btn" disabled={busy} onClick={check}>
              {busy ? t('shop.checking') : t('shop.check')}
            </button>
          )}
          <button type="button" className="btn" onClick={logout}>
            <Icon name="logout" /> {t('shop.logout')}
          </button>
        </div>
      </div>
    </div>
  );
}
