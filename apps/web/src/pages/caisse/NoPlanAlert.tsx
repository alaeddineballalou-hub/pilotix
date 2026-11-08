// The red alert of the home page: people working here without a pay plan for one of their jobs. The admins see all of
// them; someone else who adds people (« peut gérer les comptes ») sees those he added. A notification also goes out
// once a day (the morning job).
import { useTranslation } from 'react-i18next';
import { payOn } from '../../lib/features';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Icon } from '../../ui/kit';
import './paie.css';

export function NoPlanAlert({ admins = true }: { admins?: boolean }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const can = !!session && (session.isAdmin ? admins : !!session.canManageUsers);
  const q = useRpc('pay.noPlan', {}, { enabled: can && payOn(), staleTime: 60_000 });
  const people = q.data?.people ?? [];
  if (!can || !people.length) return null;
  return (
    <a className="pp-alert pp-noplan-alert" href={q.data!.url} role="alert">
      <Icon name="alert" />
      <span className="pp-grow">
        <b>{t('paie.noPlanAlert.title', { count: people.length })}</b>
        <small>
          {people
            .slice(0, 4)
            .map((p) => `${p.name} (${p.missing.map((k) => t(`paie.tasks.${k}`)).join(', ')})`)
            .join(' · ')}
          {people.length > 4 ? ` · +${people.length - 4}` : ''}
        </small>
      </span>
      <span className="pp-alert-go">{t('paie.noPlanAlert.go')}</span>
    </a>
  );
}
