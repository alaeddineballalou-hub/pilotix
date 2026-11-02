// Messages: a customer's voice note Dellal could not read (it was paused, a person answers, it was not understood, or the
// reading of voice notes was off): « Écrire ce vocal en texte » asks Gemini again, on the server (dellal.voice.read).
import { useTranslation } from 'react-i18next';
import { useAction } from '../../lib/query';
import { Icon } from '../../ui/kit';
import type { Msg } from './chat';

export function VoiceRead({ m }: { m: Msg }) {
  const { t } = useTranslation();
  const read = useAction('dellal.voice.read', { success: t('messages.voice.readDone') });
  const v = m.role === 'customer' ? m.meta?.voice : null;
  if (!v || v.status === 'done') return null;
  return (
    <button type="button" className="lj-open ai-voice-read" disabled={read.isPending} onClick={() => read.mutate({ messageId: m.id })}>
      <Icon name="mic" /> {read.isPending ? t('messages.voice.reading') : t('messages.voice.read')}
    </button>
  );
}
