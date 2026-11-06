// Pilot Content › Réglages (administrator): the fixed posting times (« Fill my week » and « Next free time » use
// them), the administrator's yes before a marketer's post goes out, and the first comment a feed post gets.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out, rpc } from '../../lib/backend';
import { useRpc } from '../../lib/query';
import { Card, ErrorBox, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { SaveBar } from '../ai/agent';

type S = Out<'cm.plan.settings'>;
/** Saturday first (Algeria's week): 6, 0, 1 … 5 */
const WEEK = [6, 0, 1, 2, 3, 4, 5];
/** every half hour, in 24 hours whatever the browser's language (a time box would show « 08:00 PM » in English) */
const TIMES = Array.from({ length: 48 }, (_, k) => `${String(Math.floor(k / 2)).padStart(2, '0')}:${k % 2 ? '30' : '00'}`);

export function Settings() {
  const { t, i18n } = useTranslation();
  const q = useRpc('cm.plan.settings', {});
  const [f, setF] = useState<S | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (q.data && !f) setF(q.data);
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.isLoading || (!f && !q.error)) return <Loading />;
  if (q.error || !f) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const dirty = JSON.stringify(f) !== JSON.stringify(q.data);
  const day = (k: number) => new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar-DZ' : i18n.language === 'en' ? 'en-GB' : 'fr-FR', { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2026, 0, 4 + k));
  const setSlot = (k: number, patch: Partial<S['slots'][number]>) => setF({ ...f, slots: f.slots.map((x, j) => (j === k ? { ...x, ...patch } : x)) });
  const save = async () => {
    setBusy(true);
    try {
      const r = await rpc('cm.plan.saveSettings', { ...f, slots: f.slots.filter((x) => x.days.length && /^\d{1,2}:\d{2}$/.test(x.time)) });
      setF(r);
      await q.refetch();
      toast(t('social.set.saved'), 'ok');
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sr ss">
      <Card title={t('social.set.slots')} help={t('social.set.slotsHelp')}>
        <p className="muted small">{t('social.set.slotsSub')}</p>
        <div className="ss-slots">
          {f.slots.map((x, k) => (
            <div key={k} className="ss-slot">
              <select className="ltr ss-time" value={x.time} aria-label={t('social.set.time')} onChange={(e) => setSlot(k, { time: e.target.value })}>
                {[...new Set([...TIMES, x.time])].sort().map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <div className="ss-days" role="group" aria-label={t('social.set.days')}>
                {WEEK.map((d) => (
                  <button key={d} type="button" aria-pressed={x.days.includes(d)} onClick={() => setSlot(k, { days: x.days.includes(d) ? x.days.filter((y) => y !== d) : [...x.days, d] })}>
                    {day(d)}
                  </button>
                ))}
              </div>
              <button type="button" className="btn ghost pl-ico" aria-label={t('social.set.remove')} onClick={() => setF({ ...f, slots: f.slots.filter((_, j) => j !== k) })}>
                <Icon name="trash" />
              </button>
            </div>
          ))}
          {!f.slots.length && <p className="muted small">{t('social.set.noSlots')}</p>}
        </div>
        <div className="ss-add">
          <button type="button" className="btn small" disabled={f.slots.length >= 21} onClick={() => setF({ ...f, slots: [...f.slots, { days: [0, 1, 2, 3, 4, 5, 6], time: '20:00' }] })}>
            <Icon name="plus" />
            {t('social.set.add')}
          </button>
          <button type="button" className="btn small ghost" disabled={f.slots.length >= 21} onClick={() => setF({ ...f, slots: [...f.slots, { days: [5, 6], time: '13:00' }] })}>
            {t('social.set.weekend')}
          </button>
        </div>
      </Card>
      <Card title={t('social.set.team')}>
        <label className="dl-switch">
          <input type="checkbox" checked={f.approval} onChange={(e) => setF({ ...f, approval: e.target.checked })} />
          <span>
            <b>{t('social.set.approval')}</b>
            <small>{t('social.set.approvalHint')}</small>
          </span>
        </label>
        <label className="dl-switch">
          <input type="checkbox" checked={f.firstComment.on} onChange={(e) => setF({ ...f, firstComment: { ...f.firstComment, on: e.target.checked } })} />
          <span>
            <b>{t('social.set.fc')}</b>
            <small>{t('social.set.fcHint')}</small>
          </span>
        </label>
        {f.firstComment.on && (
          <input type="text" className="ss-fc" dir="auto" value={f.firstComment.text} maxLength={500} aria-label={t('social.set.fc')} onChange={(e) => setF({ ...f, firstComment: { ...f.firstComment, text: e.target.value } })} />
        )}
      </Card>
      <SaveBar dirty={dirty} busy={busy} onSave={() => void save()} label={t('social.set.save')} />
    </div>
  );
}
