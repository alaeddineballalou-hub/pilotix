// Management › Livreur: the messages a livreur sends a customer in one tap from « Ma tournée » (« Message », then
// WhatsApp or SMS). Each has a short name and its words; {nom} {ref} {montant} {commune} {livreur} {boutique} are
// filled with the order's details. Shown filled with an example under each one.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import './livreurcfg.css';

type Msg = Out<'livreur.messages'>['messages'][number];
const VARS = ['nom', 'ref', 'montant', 'commune', 'livreur', 'boutique'] as const;
const SAMPLE: Record<(typeof VARS)[number], string> = { nom: 'Amina', ref: 'PX2213', montant: '13 350', commune: 'Kouba', livreur: 'Lamine', boutique: 'Pilotix Démo' };
const sample = (text: string) => VARS.reduce((s, v) => s.replace(new RegExp(`\\{${v}\\}`, 'g'), SAMPLE[v]), text);
const same = (a: Msg[], b: Msg[]) => JSON.stringify(a) === JSON.stringify(b);

export function LivreurCfg() {
  const { t } = useTranslation();
  const q = useRpc('livreur.messages', {});
  const [draft, setDraft] = useState<Msg[] | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const save = useAction('livreur.messagesSet', { success: t('admin.lv.saved'), onDone: () => setDraft(null) });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const saved = q.data.messages;
  const list = draft ?? saved;
  const dirty = !same(list, saved);
  const set = (i: number, p: Partial<Msg>) => setDraft(list.map((m, k) => (k === i ? { ...m, ...p } : m)));
  const bad = list.some((m) => !m.label.trim() || !m.text.trim());
  const insertVar = (i: number, v: string) => set(i, { text: `${list[i].text}${list[i].text.endsWith(' ') || !list[i].text ? '' : ' '}{${v}}` });
  return (
    <div className="card lv">
      <div className="lv-head">
        <div>
          <h2>{t('admin.lv.title')}</h2>
          <p className="muted">{t('admin.lv.help')}</p>
        </div>
      </div>
      <ol className="lv-list">
        {list.map((m, i) => (
          <li key={m.id} className={`lv-item${focus === i ? ' on' : ''}`}>
            <div className="lv-top">
              <span className="lv-n">{i + 1}</span>
              <input
                className="lv-name"
                value={m.label}
                maxLength={40}
                aria-label={t('admin.lv.name')}
                placeholder={t('admin.lv.namePh')}
                onFocus={() => setFocus(i)}
                onChange={(e) => set(i, { label: e.target.value })}
              />
              <button type="button" className="btn ghost small" aria-label={t('admin.lv.remove')} title={t('admin.lv.remove')} onClick={() => setDraft(list.filter((_, k) => k !== i))}>
                <Icon name="trash" />
              </button>
            </div>
            <textarea
              rows={3}
              maxLength={700}
              value={m.text}
              aria-label={t('admin.lv.text')}
              onFocus={() => setFocus(i)}
              onChange={(e) => set(i, { text: e.target.value })}
            />
            <div className="lv-vars" aria-label={t('admin.lv.vars')}>
              {VARS.map((v) => (
                <button key={v} type="button" className="lv-var" title={t(`admin.lv.var.${v}`)} onClick={() => insertVar(i, v)}>
                  {`{${v}}`}
                </button>
              ))}
            </div>
            <p className="lv-prev">
              <Icon name="eye" /> {sample(m.text) || '…'}
            </p>
          </li>
        ))}
      </ol>
      <div className="lv-add">
        {list.length < 20 && (
          <button type="button" className="btn" onClick={() => setDraft([...list, { id: `m${Date.now().toString(36)}`, label: '', text: '' }])}>
            <Icon name="plus" /> {t('admin.lv.add')}
          </button>
        )}
        {!same(list, q.data.defaults) && (
          <button type="button" className="btn ghost" onClick={() => setDraft(q.data!.defaults.map((m) => ({ ...m })))}>
            <Icon name="history" /> {t('admin.lv.reset')}
          </button>
        )}
      </div>
      {dirty && (
        <div className="lv-foot" role="region" aria-label={t('admin.lv.unsaved')}>
          <span className="lv-state">{bad ? t('admin.lv.fill') : t('admin.lv.unsaved')}</span>
          <button type="button" className="btn" onClick={() => setDraft(null)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn primary" disabled={bad || save.isPending} onClick={() => save.mutate({ messages: list.map((m) => ({ ...m, label: m.label.trim(), text: m.text.trim() })) })}>
            {save.isPending ? '…' : t('admin.lv.save')}
          </button>
        </div>
      )}
    </div>
  );
}
