// Google Sheets channel: say which sheet column is what (Nom du client → the customer's name…), then sync: the new
// lines become orders in Confirmation › Nouvelles. The server also syncs by itself every 2 minutes.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, useRpc } from '../../lib/query';
import { ErrorBox, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';

type Result = { created: number; already: number; errors: { line: number; error: string }[]; errorCount: number; lines: number };

export function SheetSync({ channel, onClose }: { channel: { id: number; name: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useRpc('channels.sheet.read', { id: channel.id });
  const [map, setMap] = useState<Record<string, string>>({});
  const [onlyNew, setOnlyNew] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    if (q.data) setMap(q.data.mapping);
  }, [q.data]);
  const sync = useAction('channels.sheet.sync', { onDone: (r) => setResult(r as Result) });
  const saveMap = useAction('channels.sheet.saveMapping', { success: t('admin.channels.sheet.saved') });
  const busy = sync.isPending || saveMap.isPending;
  const used = Object.values(map).filter((f) => f !== 'ignore');
  const dup = new Set(used.filter((f, k) => used.indexOf(f) !== k));

  const save = async (andSync: boolean) => {
    setResult(null);
    await saveMap.mutateAsync({ id: channel.id, mapping: map as any, skipExisting: onlyNew });
    if (andSync) sync.mutate({ id: channel.id });
  };

  return (
    <Modal
      wide
      title={t('admin.channels.sheet.title', { name: channel.name })}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.close')}
          </button>
          <button className="btn" disabled={busy || !q.data || dup.size > 0} onClick={() => save(false)}>
            {t('admin.channels.sheet.saveOnly')}
          </button>
          <button className="btn primary" disabled={busy || !q.data || dup.size > 0} onClick={() => save(true)}>
            {busy ? '…' : t('admin.channels.sheet.saveSync')}
          </button>
        </>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : q.data ? (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            {t('admin.channels.sheet.help', { lines: q.data.lines })} <b>{t('admin.channels.sheet.nothingYet')}</b>
          </p>
          <div className="tbl-wrap">
            <table className="tbl px-sheetmap">
              <thead>
                <tr>
                  <th>{t('admin.channels.sheet.colSheet')}</th>
                  <th className="wide">{t('admin.channels.sheet.colExample')}</th>
                  <th>{t('admin.channels.sheet.colPilotix')}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.headers.map((h, i) => (
                  <tr key={h} className={map[h] === 'ignore' ? 'dim' : ''}>
                    <td data-l={t('admin.channels.sheet.colSheet')}>
                      <b>{h}</b>
                    </td>
                    <td data-l={t('admin.channels.sheet.colExample')} className="wide">
                      <small>
                        {q.data!.sample
                          .slice(0, 3)
                          .map((r) => r[i])
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </small>
                    </td>
                    <td data-l={t('admin.channels.sheet.colPilotix')}>
                      <select
                        value={map[h] ?? 'ignore'}
                        aria-invalid={dup.has(map[h]) || undefined}
                        style={dup.has(map[h]) ? { borderColor: 'var(--coral)' } : undefined}
                        onChange={(e) => setMap({ ...map, [h]: e.target.value })}
                      >
                        {q.data!.fields.map((f) => (
                          <option key={f} value={f}>
                            {t(`admin.channels.sheet.fields.${f}`)}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {dup.size > 0 && <p className="form-err">{t('admin.channels.sheet.dup')}</p>}
          {!q.data.saved && q.data.done === 0 && q.data.lines > 0 && (
            <label className="row nowrap" style={{ gap: 8, margin: '10px 0 0' }}>
              <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
              {t('admin.channels.sheet.onlyNew', { lines: q.data.lines })}
            </label>
          )}
          <p className="muted small">{t('admin.channels.sheet.auto')}</p>
          {result && (
            <div className={result.errorCount ? 'warnbox' : 'okbox'} style={{ marginTop: 10 }}>
              <b>{t('admin.channels.sheet.result', { created: result.created, already: result.already, errors: result.errorCount })}</b>
              {result.errors.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
                  {result.errors.map((e) => (
                    <li key={e.line}>{t('admin.channels.sheet.lineError', { line: e.line, error: e.error })}</li>
                  ))}
                </ul>
              )}
              {result.created > 0 && (
                <p style={{ margin: '8px 0 0' }}>
                  <a className="btn small" href="#/confirmation/nouvelles" onClick={onClose}>
                    {t('admin.channels.sheet.seeOrders')}
                  </a>
                </p>
              )}
            </div>
          )}
        </>
      ) : null}
    </Modal>
  );
}
