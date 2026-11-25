// The pieces of the problems report shared by its places (Annulé, Dépôt › Erreurs de livraison, Mes erreurs, SAV):
// the team's chip, « Pas moi » (the person says it is not him), and the admins' decision on a « Pas moi ».
import { FAULT_TEAMS, type FaultTeam } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction } from '../../lib/query';
import { Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import './faults.css';

export const TEAM_ICON: Record<FaultTeam, string> = {
  confirmation: 'phone',
  depot: 'package',
  suivi: 'navigation',
  pub: 'megaphone',
  livreur: 'truck',
  societe: 'building',
  produit: 'tag',
  pilotix: 'settings',
  client: 'user',
  unknown: 'help',
};
export const GROUP_ICON: Record<string, string> = { client: 'user', address: 'home', article: 'package', price: 'wallet', delivery: 'truck', product: 'tag' };

/** « Confirmation · Samira », « Dépôt » (a name hidden: not the viewer's team), « Moi » (the viewer's own). */
export function TeamChip({ team, who, mine }: { team: string; who?: string | null; mine?: boolean }) {
  const { t } = useTranslation();
  const k = team as FaultTeam;
  return (
    <span className={`pxf-chip ${k === 'client' ? 'client' : k === 'unknown' ? 'unknown' : ''} ${mine ? 'me' : ''}`}>
      <Icon name={TEAM_ICON[k] ?? 'help'} />
      {t(`faults.team.${k}`)}
      {mine ? ` · ${t('faults.me')}` : who ? ` · ${who}` : ''}
    </span>
  );
}

/** « Pas moi »: why it is not him (the admins or the seller decide). */
export function ContestSheet({ id, onClose }: { id: number; onClose: () => void }) {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const send = useAction('faults.contest', { success: t('faults.contest.done'), onDone: onClose });
  const ok = note.trim().length >= 3;
  return (
    <Modal
      sheet
      title={t('faults.contest.title')}
      onClose={onClose}
      footer={
        <button type="button" className="pxf-go" disabled={!ok || send.isPending} onClick={() => send.mutate({ id, note: note.trim() })}>
          <Icon name="send" /> {t('faults.contest.send')}
        </button>
      }
    >
      <div className="pxf-sheet">
        <p className="pxf-q">{t('faults.contest.why')}</p>
        <textarea className="pxf-in" value={note} maxLength={500} placeholder={t('faults.contest.placeholder')} onChange={(e) => setNote(e.target.value)} />
        <p className="pxf-note">
          <Icon name="lock" /> {t('faults.contest.who')}
        </p>
      </div>
    </Modal>
  );
}

/** The « Pas moi » button of a line (or « envoyé » once sent). */
export function ContestButton({ id, sent }: { id: number; sent: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (sent)
    return (
      <span className="pxf-mini sent">
        <Icon name="flag" /> {t('faults.contest.sent')}
      </span>
    );
  return (
    <>
      <button
        type="button"
        className="pxf-mini"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Icon name="flag" /> {t('faults.contest.button')}
      </button>
      {open && <ContestSheet id={id} onClose={() => setOpen(false)} />}
    </>
  );
}

export interface Waiting {
  id: number;
  team: string;
  who: string | null;
  reason: string;
  by: string | null;
  note: string | null;
  order: { ref: string; customer: string } | null;
}

/** The « Pas moi » waiting: the admins and the seller keep the line, give it to another team, or say nobody's fault. */
export function DecideSheet({ list, canDecide, onClose }: { list: Waiting[]; canDecide: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const decide = useAction('faults.decide', { success: t('faults.decide.done') });
  const [moving, setMoving] = useState<number | null>(null);
  return (
    <Modal sheet title={t('faults.decide.title')} onClose={onClose}>
      <div className="pxf-sheet">
        {!list.length && <p className="pxf-note">{t('faults.decide.empty')}</p>}
        {list.map((w) => (
          <div key={w.id} className="pxf-w">
            <b>
              <Icon name="flag" />
              {w.order?.ref ?? ''} · {t(`faults.team.${w.team}`)}
              {w.who ? ` · ${w.who}` : ''}
            </b>
            <p>
              <b>{t(`faults.reason.${w.reason}`)}</b>
              {w.order?.customer ? ` · ${w.order.customer}` : ''}
            </p>
            {w.note && (
              <q>
                {w.by ? t('faults.decide.says', { who: w.by }) : ''} « {w.note} »
              </q>
            )}
            {canDecide && (
              <div className="pxf-acts">
                <button type="button" className="pxf-mini k" disabled={decide.isPending} onClick={() => decide.mutate({ id: w.id, action: 'keep' })}>
                  {t('faults.decide.keep', { team: t(`faults.team.${w.team}`) })}
                </button>
                <button type="button" className="pxf-mini" onClick={() => setMoving(moving === w.id ? null : w.id)}>
                  {t('faults.decide.change')}
                </button>
                <button type="button" className="pxf-mini" disabled={decide.isPending} onClick={() => decide.mutate({ id: w.id, action: 'none' })}>
                  {t('faults.decide.none')}
                </button>
              </div>
            )}
            {canDecide && moving === w.id && (
              <div className="pxf-chips">
                {FAULT_TEAMS.filter((k) => k !== w.team && k !== 'client' && k !== 'unknown').map((k) => (
                  <button key={k} type="button" className="pxf-c" onClick={() => decide.mutate({ id: w.id, action: 'team', team: k }, { onSuccess: () => setMoving(null) })}>
                    <Icon name={TEAM_ICON[k]} /> {t(`faults.team.${k}`)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {!canDecide && list.length > 0 && <p className="pxf-note">{t('faults.decide.seller')}</p>}
      </div>
    </Modal>
  );
}
