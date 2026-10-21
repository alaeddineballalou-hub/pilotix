import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { Card, copyText, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import type { PageProps } from '../registry';
import { ScanCard } from './ScanCard';
import { isPhone, unlockAudio } from './scan';

type Mode = 'dispatch' | 'back';

export function Scanner(_: PageProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode | null>(null);
  const start = (m: Mode) => {
    unlockAudio();
    setMode(m);
  };
  return (
    <>
      {mode ? (
        <ScanCard key={mode} mode={mode} onBack={() => setMode(null)} autoCamera={isPhone()} />
      ) : (
        <section className="card bjsc-pick">
          <h2>{t('scanner.what')}</h2>
          <div className="bjsc-chs two">
            <button type="button" className="bjsc-ch big" onClick={() => start('dispatch')}>
              <b>{t('scanner.ship')}</b>
              <small>{t('scanner.shipSub')}</small>
            </button>
            <button type="button" className="bjsc-ch big" onClick={() => start('back')}>
              <b>{t('scanner.back')}</b>
              <small>{t('scanner.backSub')}</small>
            </button>
          </div>
          <p className="muted small">{isPhone() ? t('scanner.thenPhone') : t('scanner.then')}</p>
        </section>
      )}
      {backend.kind === 'demo' && <TestParcels />}
    </>
  );
}

/** Demo only: parcels to try every rule of the scanner. */
function TestParcels() {
  const { t } = useTranslation();
  const q = useRpc('depot.testParcels', {});
  const reset = useAction('depot.resetTestParcels', { success: t('scanner.test.resetDone') });
  if (!q.data?.length) return null;
  const groups: Mode[] = ['dispatch', 'back'];
  return (
    <Card
      className="bjst"
      title={t('scanner.test.title')}
      help={t('scanner.test.help')}
      actions={
        <button type="button" className="btn" disabled={reset.isPending} onClick={() => reset.mutate({})}>
          {t('scanner.test.reset')}
        </button>
      }
    >
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('scanner.test.code')}</th>
              <th />
              <th>{t('scanner.test.choose')}</th>
              <th>{t('scanner.test.expected')}</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => [
              <tr key={g} className="bjst-g">
                <td colSpan={4}>{g === 'dispatch' ? t('scanner.ship') : t('scanner.back')}</td>
              </tr>,
              ...q.data
                .filter((p) => p.mode === g)
                .map((p) => (
                  <tr key={p.code}>
                    <td data-l={t('scanner.test.code')}>
                      <code className="bjst-code ltr">{p.code}</code>
                    </td>
                    <td data-l="">
                      <button type="button" className="btn small" onClick={async () => toast((await copyText(p.code)) ? `${t('common.copied')} : ${p.code}` : p.code, 'ok')}>
                        {t('common.copy')}
                      </button>
                    </td>
                    <td data-l={t('scanner.test.choose')}>
                      <span className="badge t-info">{g === 'dispatch' ? t('scanner.ship') : t('scanner.back')}</span>
                    </td>
                    <td data-l={t('scanner.test.expected')} className="wide px-cw">
                      <div className="px-clamp">
                        {p.ok ? <Icon name="check" /> : p.expect.startsWith('!') ? null : '✕ '}
                        {p.ok ? ' ' : ''}
                        {p.expect}
                      </div>
                    </td>
                  </tr>
                )),
            ])}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
