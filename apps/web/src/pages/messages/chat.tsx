// The chat pieces every conversation screen shares: the messages grouped by author with the day between them, « Dellal
// écrit… » while an answer is on its way, and the message box. Messages (the inbox, the tester) and the control room
// (Pilot AI › Test & lessons) draw their chats with them.
import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { clock, dayLabel, sameDay } from '../../lib/format';
import { Icon } from '../../ui/kit';
import '../ai/ai.css';
import './messages.css';

export type Msg = { id: number; role: string; body: string; userName: string | null; sendError: string | null; at: string; meta: any };

/** 0:07 */
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
/** « Message vocal · 0:07 · écrit par l’IA » above a voice note's text (or: reading, not understood, reading off) */
function VoiceLine({ v }: { v: { status?: string; seconds?: number | null } }) {
  const { t } = useTranslation();
  const st = ['done', 'pending', 'failed', 'off'].includes(String(v.status)) ? String(v.status) : 'pending';
  return (
    <span className={`ai-voice ai-voice-${st}`}>
      <Icon name="mic" /> {t('messages.voice.label')}
      {v.seconds ? <bdi className="ltr"> · {mmss(v.seconds)}</bdi> : null} · {t(`messages.voice.${st}`)}
    </span>
  );
}

/** « Photo · lue par l’IA » above a customer's photo (or: reading, not read, reading off), with its small copy */
function PhotoLine({ p }: { p: { status?: string; thumb?: string | null; productName?: string | null; sure?: boolean; model?: string | null } }) {
  const { t } = useTranslation();
  const st = ['done', 'pending', 'failed', 'off'].includes(String(p.status)) ? String(p.status) : 'pending';
  // the preview (no AI): only the catalogue's own photos are recognised
  const said = st === 'done' && !p.model ? 'preview' : st;
  return (
    <>
      {p.thumb && <img className="ai-photo" src={p.thumb} alt={t('messages.photo.label')} loading="lazy" />}
      <span className={`ai-voice ai-voice-${st}`}>
        <Icon name="image" />
        <span>
          {t('messages.photo.label')} · {t(`messages.photo.${said}`)}
          {st === 'done' && p.productName ? <> · <bdi>{p.productName}</bdi></> : null}
        </span>
      </span>
    </>
  );
}

/** The product photos Dellal sent: their small copies in a row (the words with them come in the next message). */
function SentPhotos({ photos }: { photos: { thumb?: string | null; label?: string }[] }) {
  const { t } = useTranslation();
  const shown = photos.filter((p) => p.thumb);
  return (
    <>
      {shown.length > 0 && (
        <span className="ai-photos">
          {shown.map((p, i) => (
            <img key={i} className="ai-photo" src={p.thumb!} alt={p.label ?? t('messages.photo.sent')} loading="lazy" />
          ))}
        </span>
      )}
      <span className="ai-voice ai-voice-done">
        <Icon name="image" /> {t('messages.photo.sentN', { count: photos.length })}
      </span>
    </>
  );
}

/** The messages of a conversation, grouped by author, with the day between them; `foot`: a quiet line under a message. */
export function Bubbles({
  messages,
  name,
  pending,
  foot,
  empty,
}: {
  messages: Msg[];
  name: string;
  pending?: string | null;
  foot?: (m: Msg) => ReactNode;
  /** what an empty conversation says (default: « no message yet ») */
  empty?: ReactNode;
}) {
  const { t } = useTranslation();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [messages.length, pending]);
  const author = (m: Msg) => (m.role === 'customer' ? t('messages.thread.customer') : m.role === 'agent' ? (m.meta?.cm ? t('nav.cm') : m.meta?.notify ? t('nav.notify') : name) : m.userName ?? t('messages.thread.team'));
  const rows: ReactNode[] = [];
  let prev: Msg | null = null;
  for (const m of messages) {
    if (!prev || !sameDay(prev.at, m.at)) {
      rows.push(
        <span key={`d${m.id}`} className="ai-day">
          {dayLabel(m.at)}
        </span>,
      );
      prev = null;
    }
    if (m.role === 'tool') {
      rows.push(
        <span key={m.id} className="dl-tool ltr">
          {m.body}
        </span>,
      );
      prev = m;
      continue;
    }
    const first = !prev || prev.role === 'tool' || author(prev) !== author(m) || !!m.meta?.notify || !!m.meta?.comment;
    const kind = m.role === 'customer' ? 'in' : m.role === 'agent' ? 'out bot' : 'out team';
    rows.push(
      <div key={m.id} className={`ai-msg ${kind} ${first ? 'first' : ''}`}>
        {first && (
          <span className="ai-who">
            {m.role === 'agent' && <Icon name="sparkles" />}
            {author(m)}
            {/* a delivery message (Pilot Automations) the customer answered */}
            {m.meta?.notify && <span className="ai-tag">{t(`notify.kind.${m.meta.notify}`, { defaultValue: '' })}</span>}
            {/* a conversation opened from a comment: the public comment, then Pilot Comments's private message */}
            {m.meta?.comment && <span className="ai-tag">{t('messages.thread.comment')}</span>}
            {m.role === 'agent' && m.meta?.demo && <span className="ai-tag">{t('messages.thread.demo')}</span>}
          </span>
        )}
        <div className="ai-bub">
          {/* a voice note: Gemini wrote it as text (or could not) before Dellal read it */}
          {m.role === 'customer' && m.meta?.voice && <VoiceLine v={m.meta.voice} />}
          {/* a photo: Pilot AI looked at it (what it shows, the product) before Dellal read it */}
          {m.role === 'customer' && m.meta?.photo && <PhotoLine p={m.meta.photo} />}
          {m.role === 'agent' && Array.isArray(m.meta?.photos) && <SentPhotos photos={m.meta.photos} />}
          <span className="ai-txt" dir="auto">
            {m.role === 'customer' && m.meta?.photo ? String(m.body).replace(/^\[photo(?: envoyée)?\]\s*/, '') : m.role === 'agent' && Array.isArray(m.meta?.photos) ? String(m.body).replace(/^📷\s*/, '').replace(/\s*\(\d+\)$/, '') : m.body}
          </span>
          {/* the customer changed this message (Messenger): the first text stays readable for the team */}
          {m.meta?.edited && (
            <span className="ai-edited">
              <Icon name="pencil" /> {t('messages.thread.edited')}
            </span>
          )}
          <time dateTime={m.at}>{clock(m.at)}</time>
          {/* the customer's reaction to this message (❤️ 👍…) */}
          {m.meta?.reaction?.emoji && (
            <span className="ai-react" role="img" aria-label={t('messages.thread.reaction', { emoji: m.meta.reaction.emoji })} title={t('messages.thread.reaction', { emoji: m.meta.reaction.emoji })}>
              {m.meta.reaction.emoji}
            </span>
          )}
        </div>
        {m.meta?.edited?.before && (
          <small className="ai-before" dir="auto">
            {t('messages.thread.editedBefore', { text: '' })}
            <s>{String(m.meta.edited.before)}</s>
          </small>
        )}
        {m.sendError && <small className="ai-err">⚠ {m.sendError}</small>}
        {foot?.(m)}
      </div>,
    );
    prev = m;
  }
  const lastIsCustomer = prev?.role === 'customer';
  return (
    <div className="ai-msgs" ref={box} aria-live="polite">
      {!messages.length && !pending && <span className="ai-note-m">{empty ?? t('messages.thread.empty')}</span>}
      {rows}
      {pending && (
        <>
          <div className={`ai-msg in ${lastIsCustomer ? '' : 'first'}`}>
            {!lastIsCustomer && <span className="ai-who">{t('messages.thread.customer')}</span>}
            <div className="ai-bub">
              <span className="ai-txt" dir="auto">
                {pending}
              </span>
            </div>
          </div>
          <Typing name={name} />
        </>
      )}
    </div>
  );
}

/** "Dellal écrit… 12 s" while the answer is on its way. */
export function Typing({ name }: { name: string }) {
  const { t } = useTranslation();
  const [s, setS] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = window.setInterval(() => setS(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="ai-msg out bot first wait">
      <span className="ai-who">
        <Icon name="sparkles" />
        {name}
      </span>
      <div className="ai-bub">
        <span className="ai-txt">{t('messages.tester.typing', { name, s })}</span>
      </div>
    </div>
  );
}

/** The message box: grows with the text; Enter sends, Shift + Enter goes to the line; `onPhoto`: a photo button too. */
export function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  busy,
  disabled,
  children,
  onPhoto,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder: string;
  busy: boolean;
  disabled?: boolean;
  children?: ReactNode;
  /** a photo picked (as the customer): its words are what the box holds */
  onPhoto?: (file: File) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLTextAreaElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(140, Math.max(44, el.scrollHeight + 3))}px`;
  }, [value]);
  return (
    <div className="ai-cmp">
      {children}
      <div className="ai-cmp-r">
        {onPhoto && (
          <>
            <input
              ref={pick}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) onPhoto(f);
              }}
            />
            <button type="button" className="btn ghost ai-pic" title={t('messages.photo.send')} aria-label={t('messages.photo.send')} disabled={busy || disabled} onClick={() => pick.current?.click()}>
              <Icon name="image" />
            </button>
          </>
        )}
        <textarea
          ref={ref}
          rows={1}
          dir="auto"
          aria-label={placeholder}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button type="button" className="btn primary ai-send" title={t('messages.thread.send')} aria-label={t('messages.thread.send')} disabled={!value.trim() || busy || disabled} onClick={onSend}>
          <Icon name="send" />
        </button>
      </div>
    </div>
  );
}
