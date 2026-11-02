// One chat of a shop as Pilot AI keeps it (names, numbers and prices hidden), opened from the control room: the chats
// behind a sales lesson (PilotAi.tsx) and behind a Darija word Dellal learned (PilotLab.tsx).
import { useTranslation } from 'react-i18next';
import { ErrorBox, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { usePilotRpc } from './pilotDemo';

export function CaseModal({ shopId, convId, onClose }: { shopId: number; convId: number; onClose: () => void }) {
  const { t } = useTranslation();
  const q = usePilotRpc('p.pilot.case', { shopId, convId });
  return (
    <Modal title={t('platform.pilot.chatTitle')} onClose={onClose} sheet>
      {q.isLoading ? (
        <Loading />
      ) : q.error || !q.data ? (
        <ErrorBox error={q.error} />
      ) : (
        <>
          <p className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className={`chip o-${q.data.outcome}`}>{t(`platform.pilot.outcome.${q.data.outcome}`, { defaultValue: q.data.outcome })}</span>
            {q.data.reason && <span className="chip">{t(`platform.pilot.reason.${q.data.reason}`, { defaultValue: q.data.reason })}</span>}
            {q.data.takeover && <span className="chip pp-chip-ok">{t('platform.pilot.takeover')}</span>}
          </p>
          <pre className="pilot-transcript">{q.data.transcript}</pre>
          <p className="small muted">{t('platform.pilot.legend')}</p>
          <p className="small muted">{t('platform.pilot.anonymous')}</p>
        </>
      )}
    </Modal>
  );
}
