// Management › Statuts › Suivi: the motifs of « Traiter » — why an alert ends « Résolu » (relancé) or « Perdu ».
// Renamed (fr / ar), switched on or off, added; on the « Perdu » side, « le client l'a dit » lets the agent close it
// before his calls (Préférences › Alertes du Suivi).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { Card, Icon, Loading } from '../../ui/kit';
import { IconBtn, Switch } from './bits';

type Motifs = Out<'suivi.motifs'>;
type Motif = Motifs['resolved'][number];
type Side = 'resolved' | 'lost';

export function SuiviMotifsCard() {
  const { t } = useTranslation();
  const q = useRpc('suivi.motifs', {});
  const [v, setV] = useState<Motifs | null>(null);
  const save = useAction('suivi.motifsSet', { success: t('admin.motifs.saved'), onDone: () => setV(null) });
  useEffect(() => setV(null), [q.data]);
  if (!q.data) return <Loading />;
  const cur = v ?? q.data;
  const dirty = !!v && JSON.stringify(v) !== JSON.stringify(q.data);
  const put = (side: Side, i: number, p: Partial<Motif>) => setV({ ...cur, [side]: cur[side].map((m, k) => (k === i ? { ...m, ...p } : m)) });
  const add = (side: Side) => setV({ ...cur, [side]: [...cur[side], { key: `m${Date.now().toString(36)}`, fr: '', ar: '', on: true, ...(side === 'lost' ? { client: false } : {}) }] });
  const drop = (side: Side, i: number) => setV({ ...cur, [side]: cur[side].filter((_, k) => k !== i) });
  const bad = (['resolved', 'lost'] as Side[]).some((s) => !cur[s].some((m) => m.on) || cur[s].some((m) => !m.fr.trim()));
  return (
    <Card title={t('admin.motifs.title')}>
      <p className="muted small">{t('admin.motifs.help')}</p>
      <div className="mo-cols">
        {(['resolved', 'lost'] as Side[]).map((side) => (
          <section key={side} className={`mo-side ${side}`}>
            <h4>
              <Icon name={side === 'resolved' ? 'checkcircle' : 'undo'} /> {t(`admin.motifs.${side}`)}
            </h4>
            <small className="muted">{t(`admin.motifs.${side}Hint`)}</small>
            <ul>
              {cur[side].map((m, i) => (
                <li key={m.key} className={m.on ? '' : 'dim'}>
                  <input value={m.fr} maxLength={80} placeholder={t('admin.motifs.fr')} aria-label={t('admin.motifs.fr')} onChange={(e) => put(side, i, { fr: e.target.value })} />
                  <input value={m.ar} maxLength={80} dir="rtl" placeholder={t('admin.motifs.ar')} aria-label={t('admin.motifs.ar')} onChange={(e) => put(side, i, { ar: e.target.value })} />
                  <span className="mo-tools">
                    {side === 'lost' && (
                      <label className="mo-client" title={t('admin.motifs.clientTip')}>
                        <input type="checkbox" checked={!!m.client} onChange={(e) => put(side, i, { client: e.target.checked })} />
                        {t('admin.motifs.client')}
                      </label>
                    )}
                    <Switch checked={m.on} label={t('admin.motifs.on', { name: m.fr })} onChange={(on) => put(side, i, { on })} />
                    <IconBtn kind="d" title={t('admin.motifs.remove')} onClick={() => drop(side, i)} />
                  </span>
                </li>
              ))}
            </ul>
            <button type="button" className="btn small ghost" onClick={() => add(side)}>
              <Icon name="plus" /> {t('admin.motifs.add')}
            </button>
          </section>
        ))}
      </div>
      {dirty && (
        <div className="row mo-foot">
          <button type="button" className="btn" onClick={() => setV(null)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={bad || save.isPending} onClick={() => save.mutate({ resolved: cur.resolved, lost: cur.lost })}>
            {t('common.save')}
          </button>
          {bad && <small className="muted">{t('admin.motifs.needOne')}</small>}
        </div>
      )}
    </Card>
  );
}
