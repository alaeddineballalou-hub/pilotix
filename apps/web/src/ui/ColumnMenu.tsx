import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../lib/backend';
import { useRpc } from '../lib/query';
import { useSession } from '../lib/session';
import { Icon } from './kit';
import { toast } from './toast';

/**
 * Column picker with the shared, locked presets. The same presets show in Confirmation and Suivi:
 * a preset keeps the columns a table has and ignores the others.
 */
export function ColumnMenu<K extends string>({ cols, visible, onChange, onReset, open, onToggle }: {
  cols: { k: K; label: string }[];
  visible: Set<K>;
  onChange: (s: Set<K>) => void;
  onReset: () => void;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const { session } = useSession();
  const presets = useRpc('confirmation.colPresets', {}, { staleTime: 60_000 });
  const [pName, setPName] = useState('');
  const has = (k: string): k is K => cols.some((c) => c.k === k);
  const add = async () => {
    const name = pName.trim();
    if (!name) return;
    try {
      await rpc('confirmation.addColPreset', { name, cols: cols.filter((c) => visible.has(c.k)).map((c) => c.k) });
      setPName('');
      toast(t('confirmation.presets.saved', { name }), 'ok');
      presets.refetch();
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };
  const del = async (id: string) => {
    try {
      await rpc('confirmation.deleteColPreset', { id });
      toast(t('confirmation.presets.deleted'), 'ok');
      presets.refetch();
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };
  return (
    <span className="px-qpop-wrap">
      <button type="button" className={`px-qb ${open ? 'on' : ''}`} aria-expanded={open} title={`${t('common.columns')} (${visible.size}/${cols.length})`} aria-label={t('common.columns')} onClick={onToggle}>
        <Icon name="columns" />
      </button>
      {open && (
        <div className="px-qpop" role="dialog" aria-label={t('common.columns')}>
          <div className="px-pre">
            <div className="px-pre-h">{t('confirmation.presets.title')}</div>
            {(presets.data ?? []).length === 0 && <div className="px-pre-none">{t('confirmation.presets.none')}</div>}
            {(presets.data ?? []).map((p) => {
              const keep = p.cols.filter(has);
              const on = keep.length > 0 && keep.length === visible.size && keep.every((k) => visible.has(k));
              return (
                <div key={p.id} className={`px-pre-it ${on ? 'on' : ''}`}>
                  <button type="button" className="px-pre-go" title={t('confirmation.presets.locked')} aria-label={t('confirmation.presets.apply', { name: p.name })} disabled={!keep.length} onClick={() => onChange(new Set(keep))}>
                    <Icon name="lock" />
                    <span>{p.name}</span>
                    <small>{keep.length}</small>
                  </button>
                  {session?.isAdmin && (
                    <button type="button" className="px-pre-del" title={t('confirmation.presets.del', { name: p.name })} aria-label={t('confirmation.presets.del', { name: p.name })} onClick={() => del(p.id)}>
                      <Icon name="trash" />
                    </button>
                  )}
                </div>
              );
            })}
            {session?.isAdmin && (
              <form
                className="px-pre-new"
                onSubmit={(e) => {
                  e.preventDefault();
                  add();
                }}
              >
                <input value={pName} maxLength={40} placeholder={t('confirmation.presets.name')} aria-label={t('confirmation.presets.saveAs')} title={t('confirmation.presets.saveAs')} onChange={(e) => setPName(e.target.value)} />
                <button type="submit" className="btn small primary" disabled={!pName.trim() || !visible.size}>
                  {t('confirmation.presets.save')}
                </button>
              </form>
            )}
          </div>
          <div className="px-pre-h">{t('confirmation.presets.cols')}</div>
          {cols.map((c) => (
            <label key={c.k} className="px-qpop-it">
              <span>{c.label}</span>
              <input
                type="checkbox"
                checked={visible.has(c.k)}
                onChange={(e) => {
                  const s2 = new Set(visible);
                  if (e.target.checked) s2.add(c.k);
                  else s2.delete(c.k);
                  onChange(s2);
                }}
              />
            </label>
          ))}
          <button type="button" className="btn small ghost" onClick={onReset}>
            {t('common.showAll')}
          </button>
        </div>
      )}
    </span>
  );
}
