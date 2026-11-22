// « Bloquer l'agent jusqu'à l'appel »: the managers' switch, at the top of Confirmation (owner's ask, 22 Nov 2026: managers
// only turn it on or off). On, a new order given to a plain agent rings his phone and covers Pilotix there until he calls
// and saves a result (NewOrderBlock.tsx); his computer only shows a line. In his work time nothing works until his phone
// is ready (notifications, the test ring of the shift, « Je l'ai entendu »). Off in a new shop. Only the shop's managers,
// the owner and the administrators see it — with each agent's shift (they type it here: the test ring is asked at its
// start) and whether his phone is ready.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { Icon } from '../../ui/kit';
import { Switch } from '../admin/bits';
import './newOrderBlock.css';

type Agent = { id: number; name: string; shift: { from: number; to: number } | null; work: boolean; phone: 'ok' | 'none' | 'test' | 'heard' | 'silent' };
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function BlockSwitch() {
  const { t } = useTranslation();
  const q = useRpc('confirmation.blockGet', {}, { staleTime: 30_000, refetchInterval: 30_000 });
  const set = useAction('confirmation.blockSet', { success: (r) => t(r.on ? 'confirmation.nob.sw.savedOn' : 'confirmation.nob.sw.savedOff') });
  const [open, setOpen] = useState(false);
  const b = q.data;
  if (!b?.canSwitch) return null;
  const agents = b.agents ?? [];
  const inWork = agents.filter((a) => a.work);
  const ready = inWork.filter((a) => a.phone === 'ok').length;
  return (
    <div className={`nob-sw${b.on ? ' on' : ''}`}>
      <div className="nob-sw-top">
        <span className="nob-sw-ic" aria-hidden="true">
          <Icon name="lock" />
        </span>
        <div className="nob-sw-t">
          <b>
            {t('confirmation.nob.sw.title')}
            <span className={`nob-sw-chip${b.on ? ' on' : ''}`}>{t(b.on ? 'confirmation.nob.sw.on' : 'confirmation.nob.sw.off')}</span>
          </b>
          <small>
            {t('confirmation.nob.sw.help')}
            {b.by && b.at ? ` ${t('confirmation.nob.sw.by', { name: b.by, when: when(b.at) })}` : ''}
          </small>
        </div>
        <Switch checked={b.on} disabled={set.isPending} label={t('confirmation.nob.sw.title')} onChange={(on) => set.mutate({ on })} />
      </div>
      {agents.length > 0 && (
        <>
          <button type="button" className={`nob-sw-more${open ? ' open' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="chevron" />
            <span>{t('confirmation.nob.ag.title')}</span>
            <span className={`nob-ag-sum${inWork.length && ready < inWork.length ? ' bad' : ''}`}>{t('confirmation.nob.ag.sum', { n: ready, of: inWork.length })}</span>
          </button>
          {open && (
            <div className="nob-ag" role="table" aria-label={t('confirmation.nob.ag.title')}>
              <div className="nob-ag-h" role="row">
                <span role="columnheader">{t('confirmation.nob.ag.agent')}</span>
                <span role="columnheader">{t('confirmation.nob.ag.shift')}</span>
                <span role="columnheader">{t('confirmation.nob.ag.phone')}</span>
              </div>
              {agents.map((a) => (
                <AgentRow key={`${a.id}-${a.shift?.from ?? ''}-${a.shift?.to ?? ''}`} a={a} />
              ))}
              <p className="nob-ag-note">{t('confirmation.nob.ag.note')}</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One agent: his shift (two times, saved with « Enregistrer »; « Effacer »: the calling hours) and his phone now. */
function AgentRow({ a }: { a: Agent }) {
  const { t } = useTranslation();
  const k = 'confirmation.nob.ag';
  const [from, setFrom] = useState(a.shift ? hhmm(a.shift.from) : '');
  const [to, setTo] = useState(a.shift ? hhmm(a.shift.to) : '');
  const save = useAction('confirmation.shiftSet', { success: t(`${k}.saved`, { name: a.name }) });
  const dirty = from !== (a.shift ? hhmm(a.shift.from) : '') || to !== (a.shift ? hhmm(a.shift.to) : '');
  const status = !a.work ? 'off' : a.phone;
  return (
    <div className="nob-ag-r" role="row">
      <b role="cell">{a.name}</b>
      <span role="cell" className="nob-ag-shift">
        <input type="time" step={900} value={from} aria-label={t(`${k}.from`, { name: a.name })} onChange={(e) => setFrom(e.target.value)} />
        <span aria-hidden="true">–</span>
        <input type="time" step={900} value={to} aria-label={t(`${k}.to`, { name: a.name })} onChange={(e) => setTo(e.target.value)} />
        {dirty ? (
          <button type="button" className="nob-ag-save" disabled={save.isPending || !from || !to} onClick={() => save.mutate({ agentId: a.id, from, to })}>
            {t('common.save')}
          </button>
        ) : a.shift ? (
          <button type="button" className="nob-ag-clear" disabled={save.isPending} title={t(`${k}.clear`)} aria-label={t(`${k}.clear`)} onClick={() => save.mutate({ agentId: a.id, from: null, to: null })}>
            <Icon name="x" />
          </button>
        ) : (
          <small>{t(`${k}.calls`)}</small>
        )}
      </span>
      <span role="cell">
        <span className={`nob-ag-st ${status}`}>{t(`${k}.st.${status}`)}</span>
      </span>
    </div>
  );
}
