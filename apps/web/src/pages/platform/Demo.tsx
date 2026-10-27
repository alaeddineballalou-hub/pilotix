// The demo shop: a shop full of fake orders that visitors can try from the login page ("Essayer la démo"), started
// again from zero every night (or now). Nothing leaves the server from it: couriers, messages and AI are simulated.
import { useTranslation } from 'react-i18next';
import { dateTime, n, when } from '../../lib/format';
import { Staff, usePAction, usePRpc } from '../../lib/platform';
import { Card, ErrorBox, Icon, Loading } from '../../ui/kit';
import { can } from './bits';

/** the accounts the login page offers (layout/Login.tsx) */
const ON_LOGIN = ['admin', 'conf1', 'depot', 'livreur', 'marketer'];

export function Demo({ staff }: { staff: Staff }) {
  const { t } = useTranslation();
  const q = usePRpc('p.demo.get', {});
  const create = usePAction('p.demo.create', { success: t('platform.demo.created') });
  const reset = usePAction('p.demo.reset', { success: t('platform.demo.resetDone') });
  const pub = usePAction('p.settings.save', { success: t('platform.saved') });
  const manager = can(staff, 'manager');
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.demo')}</h1>
          <p className="muted">{t('platform.demoSub')}</p>
        </div>
      </div>
      {!d.shop ? (
        <Card title={t('platform.demo.none')}>
          <p>{t('platform.demo.noneText')}</p>
          {manager && (
            <button type="button" className="btn primary" disabled={create.isPending} onClick={() => create.mutate({})}>
              {create.isPending ? t('platform.demo.creating') : t('platform.demo.create')}
            </button>
          )}
        </Card>
      ) : (
        <div className="pp-grid">
          <Card title={d.shop.name}>
            <div className="pp-use">
              <div>
                <b className="ltr">{n(d.shop.usage.ordersTotal)}</b>
                <span>{t('platform.use.ordersTotal')}</span>
              </div>
              <div className="txt">
                <b>{d.shop.resetAt ? when(d.shop.resetAt) : '—'}</b>
                <span>{t('platform.demo.lastReset')}</span>
              </div>
              <div className="txt">
                <b>{d.shop.lastActiveAt ? when(d.shop.lastActiveAt) : '—'}</b>
                <span>{t('platform.use.lastActive')}</span>
              </div>
            </div>
            <p className="small muted">{t('platform.demo.nightly')}</p>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {manager && (
                <button type="button" className="btn" disabled={reset.isPending} onClick={() => reset.mutate({})}>
                  <Icon name="refresh" /> {reset.isPending ? t('platform.demo.resetting') : t('platform.demo.reset')}
                </button>
              )}
            </div>
            {d.shop.resetAt && <p className="small muted">{t('platform.demo.resetAt', { date: dateTime(d.shop.resetAt) })}</p>}
          </Card>
          <Card title={t('platform.demo.publicTitle')}>
            <label className="check">
              <input type="checkbox" disabled={staff.role !== 'owner' || pub.isPending} checked={d.public} onChange={(e) => pub.mutate({ demo: { public: e.target.checked } })} /> {t('platform.set.demoPublic')}
            </label>
            <p className="small muted">{d.public ? t('platform.demo.publicOn') : t('platform.demo.publicOff')}</p>
            <ul className="pp-mini">
              {d.accounts.filter((a) => ON_LOGIN.includes(a.key)).map((a) => (
                <li key={a.key}>
                  <span className="pp-two">
                    <b>{t(`roles.${a.role}`)}</b>
                    <small className="muted ltr">{a.email}</small>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </div>
  );
}
