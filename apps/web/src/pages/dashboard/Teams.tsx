// Dashboard · Confirmation › Réglages des équipes: which manager each confirmation agent works with.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { useAction } from '../../lib/query';

type Meta = Out<'stats.dashMeta'>;

export function TeamEditor({ meta }: { meta: Meta }) {
  const { t } = useTranslation();
  const init = () => Object.fromEntries(meta.agents.map((a) => [a.id, a.managerId])) as Record<number, number | null>;
  const [map, setMap] = useState(init);
  useEffect(() => setMap(init()), [meta]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useAction('stats.saveTeams', { success: t('dashboard.editor.saved') });
  if (!meta.agents.length) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2>{t('dashboard.editor.title')}</h2>
        <span className="muted small">{t('dashboard.editor.sub')}</span>
      </div>
      {!meta.managers.length ? (
        <p className="muted">{t('dashboard.editor.noManagers')}</p>
      ) : (
        <>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('dashboard.editor.agent')}</th>
                  <th>{t('dashboard.editor.manager')}</th>
                </tr>
              </thead>
              <tbody>
                {meta.agents.map((a) => (
                  <tr key={a.id}>
                    <td className="wide px-cw" data-l={t('dashboard.editor.agent')}>
                      <div className="px-clamp">
                        <b>{a.name}</b>
                      </div>
                    </td>
                    <td className="wide px-cw" data-l={t('dashboard.editor.manager')}>
                      <select aria-label={t('dashboard.editor.managerOf', { name: a.name })} value={map[a.id] ?? ''} onChange={(e) => setMap({ ...map, [a.id]: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">{t('dashboard.editor.none')}</option>
                        {meta.managers.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row end">
            <button type="button" className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ assignments: meta.agents.map((a) => ({ agentId: a.id, managerId: map[a.id] ?? null })) })}>
              {t('dashboard.editor.save')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
