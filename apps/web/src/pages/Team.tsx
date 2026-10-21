import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ErrorBox, Loading } from '../components/ui';
import { api, demoPresence, isDemo } from '../lib/api';
import { onPresence, Presence } from '../lib/live';

export function Team() {
  const { t } = useTranslation();
  const users = useQuery({ queryKey: ['users'], queryFn: api.users });
  const [presence, setPresence] = useState<Presence>(() => (isDemo() ? demoPresence() : {}));
  useEffect(() => {
    if (isDemo()) return;
    const off = onPresence(setPresence);
    return () => {
      off();
    };
  }, []);

  if (users.isLoading) return <Loading />;
  if (users.isError) return <ErrorBox onRetry={() => users.refetch()} />;
  const state = (id: number) => presence[id] ?? 'offline';
  const sorted = [...(users.data ?? [])].sort((a, b) => ['online', 'idle', 'offline'].indexOf(state(a.id)) - ['online', 'idle', 'offline'].indexOf(state(b.id)));

  return (
    <div className="card" style={{ overflowX: 'auto' }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>{t('team.title')}</th>
            <th>{t('team.roles')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sorted.map((u) => (
            <tr key={u.id} style={{ opacity: u.active ? 1 : 0.5 }}>
              <td>
                <b>{u.name}</b>
                <div className="small muted ltr">{u.email}</div>
              </td>
              <td>{u.roles.map((r) => t(`roles.${r}`)).join(' · ')}</td>
              <td>
                <span className={`dot ${state(u.id)}`} />
                {t(`team.${state(u.id)}`)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
