// Management › Archives: accounts, products and depots the shop does not need any more. Archived = closed and out of
// every list, kept in the history (orders, stock, caisse…). Only what is archived AND was never used can be deleted
// for good — by the store's owner (or its administrators when no owner is known).
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateOnly, n, wilayaName } from '../../lib/format';
import type { Out } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Card, Empty, ErrorBox, Icon, Loading } from '../../ui/kit';
import { ConfirmButton } from './bits';

type Kind = 'users' | 'products' | 'warehouses';
type Row = Out<'archive.list'>[number];
const KINDS: Kind[] = ['users', 'products', 'warehouses'];

export function Archive({ initial }: { initial?: Kind }) {
  const { t, i18n } = useTranslation();
  const sep = i18n.language === 'ar' ? '، ' : ', ';
  const { session } = useSession();
  const [kind, setKind] = useState<Kind>(initial ?? 'users');
  const [archived, setArchived] = useState(false);
  const [field, setField] = useState<'activity' | 'created'>('activity');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const list = useRpc('archive.list', { kind, archived, field, from: from || undefined, to: to || undefined, q: q.trim() || undefined });
  const clear = () => setSel(new Set());
  const set = useAction('archive.set', { success: (r) => resultText(r.done, r.skipped), onDone: clear });
  const del = useAction('archive.delete', { success: (r) => resultText(r.deleted, r.kept, true), onDone: clear });
  // the owner deletes for good (a store with no known owner, or Pilotix on one shop: its administrators)
  const canDelete = !session?.shop || session.shop.owner || session.shop.ownerProfileId === null;

  function resultText(done: number, skipped: { reason: string }[], deleting = false) {
    const head = t(deleting ? 'admin.archive.deletedN' : archived ? 'admin.archive.restoredN' : 'admin.archive.archivedN', { count: done });
    return skipped.length ? `${head} · ${t('admin.archive.skippedN', { count: skipped.length })}` : head;
  }

  const rows = list.data ?? [];
  const selectable = (r: Row) => archived || !r.blocked;
  const pick = rows.filter((r) => sel.has(r.id));
  const free = pick.filter((r) => !r.uses.length);
  const allOn = rows.some(selectable) && rows.filter(selectable).every((r) => sel.has(r.id));
  const toggle = (id: number) => setSel((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id])));
  const filtered = !!(from || to || q.trim());
  const switchTo = (k: Kind, a: boolean) => {
    setKind(k);
    setArchived(a);
    clear();
  };
  const blockText = (r: Row) => (r.blocked === 'stock' ? t('admin.archive.block.stock', { count: r.stock }) : r.blocked ? t(`admin.archive.block.${r.blocked}`) : '');
  const usesText = useMemo(() => (r: Row) => r.uses.map((u) => t(`admin.archive.use.${u}`)).join(sep), [t, sep]);

  return (
    <div className="px-arch">
      <Card title={t('admin.archive.title')} help={t('admin.archive.help')}>
        <p className="muted small px-arch-intro">{t('admin.archive.intro')}</p>
        <div className="tabs px-arch-kinds" role="tablist">
          {KINDS.map((k) => (
            <button key={k} type="button" role="tab" className={`tab ${k === kind ? 'on' : ''}`} aria-selected={k === kind} onClick={() => switchTo(k, archived)}>
              <Icon name={k === 'users' ? 'users' : k === 'products' ? 'package' : 'building'} /> {t(`admin.archive.kind.${k}`)}
            </button>
          ))}
        </div>
        <div className="px-arch-bar">
          <div className="seg px-arch-view" role="group" aria-label={t('admin.archive.viewLabel')}>
            <button type="button" className={!archived ? 'on' : ''} aria-pressed={!archived} onClick={() => switchTo(kind, false)}>
              {t('admin.archive.inUse')}
            </button>
            <button type="button" className={archived ? 'on' : ''} aria-pressed={archived} onClick={() => switchTo(kind, true)}>
              <Icon name="archive" /> {t('admin.archive.archived')}
            </button>
          </div>
          <div className="px-arch-f">
            <select value={field} aria-label={t('admin.archive.dateOf')} onChange={(e) => setField(e.target.value as 'activity' | 'created')}>
              <option value="activity">{t('admin.archive.byActivity')}</option>
              <option value="created">{t('admin.archive.byCreated')}</option>
            </select>
            <label className="px-arch-d">
              <span>{t('admin.archive.from')}</span>
              <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="px-arch-d">
              <span>{t('admin.archive.to')}</span>
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
            </label>
            <input className="px-arch-q" type="search" value={q} aria-label={t('admin.archive.search')} placeholder={t('admin.archive.search')} onChange={(e) => setQ(e.target.value)} />
            {filtered && (
              <button type="button" className="btn small ghost" onClick={() => (setFrom(''), setTo(''), setQ(''))}>
                {t('admin.archive.clear')}
              </button>
            )}
          </div>
        </div>

        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} onRetry={() => list.refetch()} />
        ) : !rows.length ? (
          <Empty>{t(archived ? 'admin.archive.emptyArchived' : filtered ? 'admin.archive.emptyFiltered' : 'admin.archive.empty')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl px-arch-tbl">
              <thead>
                <tr>
                  <th className="px-arch-ck">
                    <input type="checkbox" aria-label={t('admin.archive.all')} checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(rows.filter(selectable).map((r) => r.id)))} />
                  </th>
                  <th>{t(`admin.archive.col.${kind}`)}</th>
                  <th>{kind === 'users' ? t('admin.archive.col.roles') : t('admin.archive.col.stock')}</th>
                  <th>{t('admin.archive.col.created')}</th>
                  <th>{t(archived ? 'admin.archive.col.archivedAt' : 'admin.archive.col.last')}</th>
                  <th>{t('admin.archive.col.state')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={sel.has(r.id) ? 'px-arch-on' : ''}>
                    <td className="ck px-arch-ck">
                      <input type="checkbox" aria-label={r.name} disabled={!selectable(r)} checked={sel.has(r.id)} onChange={() => toggle(r.id)} />
                    </td>
                    <td className="wide" data-l={t(`admin.archive.col.${kind}`)}>
                      <span className="px-arch-name">
                        <b>{r.name || '—'}</b>
                        <small className="muted">{kind === 'warehouses' ? [r.detail, wilayaName(r.wilayaId)].filter(Boolean).join(', ') : <span className="ltr">{r.detail || '—'}</span>}</small>
                      </span>
                    </td>
                    <td data-l={kind === 'users' ? t('admin.archive.col.roles') : t('admin.archive.col.stock')}>
                      {kind === 'users' ? <small>{r.roles.map((x) => t(`roles.${x}`)).join(sep) || '—'}</small> : <span className="ltr">{n(r.stock)}</span>}
                    </td>
                    <td data-l={t('admin.archive.col.created')}>{dateOnly(r.createdAt)}</td>
                    <td data-l={t(archived ? 'admin.archive.col.archivedAt' : 'admin.archive.col.last')}>{archived ? dateOnly(r.archivedAt) : r.lastAt ? dateOnly(r.lastAt) : <span className="muted">{t('admin.archive.never')}</span>}</td>
                    <td className="wide" data-l={t('admin.archive.col.state')}>
                      <span className="px-arch-state">
                        {r.uses.length ? (
                          <span className="chip px-arch-used" title={t('admin.archive.usedHint')}>
                            {t('admin.archive.usedList', { list: usesText(r) })}
                          </span>
                        ) : (
                          <span className="chip px-arch-free">{t('admin.archive.neverUsed')}</span>
                        )}
                        {!archived && r.blocked && <small className="px-arch-block">🔒 {blockText(r)}</small>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.length >= 300 && <p className="muted small">{t('admin.archive.max')}</p>}
      </Card>

      {!!pick.length && (
        <div className="px-arch-act" role="region" aria-label={t('admin.archive.selection')}>
          <b>{t('admin.archive.selected', { count: pick.length })}</b>
          <span className="grow" />
          <button type="button" className="btn small ghost" onClick={clear}>
            {t('admin.archive.untick')}
          </button>
          {!archived ? (
            <ConfirmButton className="btn small primary" disabled={set.isPending} question={t('admin.archive.archiveAsk', { count: pick.length })} onConfirm={() => set.mutate({ kind, ids: pick.map((r) => r.id), archived: true })}>
              <Icon name="archive" /> {t('admin.archive.archiveN', { count: pick.length })}
            </ConfirmButton>
          ) : (
            <>
              <button type="button" className="btn small" disabled={set.isPending} onClick={() => set.mutate({ kind, ids: pick.map((r) => r.id), archived: false })}>
                <Icon name="refresh" /> {t('admin.archive.restoreN', { count: pick.length })}
              </button>
              {canDelete && (
                <ConfirmButton
                  className="btn small danger"
                  disabled={!free.length || del.isPending}
                  question={t('admin.archive.deleteAsk', { count: free.length })}
                  onConfirm={() => del.mutate({ kind, ids: free.map((r) => r.id) })}
                >
                  <Icon name="trash" /> {t('admin.archive.deleteN', { count: free.length })}
                </ConfirmButton>
              )}
            </>
          )}
          {archived && (!canDelete || free.length < pick.length) && (
            <small className="px-arch-why">{!canDelete ? t('admin.archive.ownerOnly') : t('admin.archive.usedStay', { count: pick.length - free.length })}</small>
          )}
        </div>
      )}
    </div>
  );
}
