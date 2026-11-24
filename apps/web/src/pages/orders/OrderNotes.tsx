import type { Order } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { useScope } from '../../lib/seller';
import { Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';

const NOTES = [
  { tab: 'origin', icon: 'message', field: 'customer', key: 'customerNote' },
  { tab: 'livreur', icon: 'truck', field: 'delivery', key: 'deliveryNote' },
  { tab: 'team', icon: 'users', field: 'internal', key: 'internalNote' },
] as const;
type Note = (typeof NOTES)[number];
type Draft = { previous: string | null; text: string };

export function OrderNotes({ order, ticketId, header }: {
  order: Pick<Order, 'id' | 'customerNote' | 'deliveryNote' | 'internalNote'>;
  ticketId?: number;
  header?: ReactNode;
}) {
  const { t } = useTranslation();
  const scope = useScope();
  const qc = useQueryClient();
  const uid = useId();
  const [active, setActive] = useState<Note>(NOTES[0]);
  const [drafts, setDrafts] = useState<Partial<Record<Note['field'], Draft>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const draft = drafts[active.field];
  const value = draft?.text ?? order[active.key] ?? '';
  const changed = !!draft && value.trim() !== (order[active.key] ?? '').trim();
  const clear = (field: Note['field']) => setDrafts((current) => ({ ...current, [field]: undefined }));
  const save = async () => {
    if (!draft || saving || !changed) return;
    const { field } = active;
    setSaving(true);
    setError('');
    try {
      const input = { field, note: draft.text.trim() || null, previous: draft.previous };
      if (ticketId) await rpc('sav.orderNote', { id: ticketId, orderId: order.id, ...input }, scope);
      else await rpc('orders.note', { id: order.id, ...input }, scope);
      await qc.invalidateQueries();
      clear(field);
      toast(t('orders.card.noteSaved'), 'ok');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common.error'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="qd6-card qd6-notes" aria-label={t('confirmation.d6.notes')}>
      <div className="qd6-nrow">
        <div className="qd6-ntabs" role="tablist">
          {NOTES.map((note) => (
            <button key={note.tab} id={uid + note.tab} type="button" role="tab" disabled={saving} aria-selected={note === active} className={note === active ? 'on' : ''} onClick={() => { setActive(note); setError(''); }}>
              <Icon name={note.icon} /> <span>{t(`confirmation.d6.note.${note.tab}`)}</span>
              {(drafts[note.field]?.text ?? order[note.key])?.trim() && <span className="qd6-ndot" aria-label="•" />}
            </button>
          ))}
        </div>
        {header}
      </div>
      <textarea
        className="qd6-ntext"
        aria-labelledby={uid + active.tab}
        rows={3}
        value={value}
        maxLength={1000}
        disabled={saving}
        placeholder={t(`confirmation.d6.notePh.${active.tab}`)}
        onChange={(e) => {
          const text = e.target.value;
          setDrafts((current) => ({ ...current, [active.field]: { previous: draft ? draft.previous : order[active.key], text } }));
          setError('');
        }}
        onKeyDown={(e) => {
          // Ctrl + Entrée (⌘ + Entrée on a Mac) saves, like the button
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); }
        }}
      />
      {/* « Enregistrer » is always in the card, on every screen: grey until the note changes, then orange */}
      <div className="qd6-nfoot">
        {changed && <span className="qd6-nstate">{t('confirmation.d6.noteUnsaved')}</span>}
        <div className="qd6-nact">
          {changed && <button className="btn small" type="button" disabled={saving} onClick={() => { clear(active.field); setError(''); if (error) void qc.invalidateQueries(); }}>{t('common.cancel')}</button>}
          <button className="btn primary small" type="button" disabled={saving || !changed} onClick={() => void save()}>{t('common.save')}</button>
        </div>
      </div>
      {error && <p className="form-err" role="alert">{error}</p>}
    </section>
  );
}
