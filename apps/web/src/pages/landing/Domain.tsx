// Landing pages › Réglages › « Votre propre domaine »: the shop's landing pages at https://myshop.com/<page> too. The shop
// writes its domain, points it to the server at its registrar (an A record), and Pilotix checks; HTTPS comes by itself.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { domainCheck, domainGet, domainSet, DomainState } from '../../lib/backend';
import { Field, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';

export function OwnDomain() {
  const { t } = useTranslation();
  const [d, setD] = useState<DomainState | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<string[] | null>(null);
  useEffect(() => {
    domainGet()
      .then((r) => (setD(r), setValue(r.domain ?? '')))
      .catch(() => setD(null));
  }, []);
  if (!d) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      toast(e?.message || t('common.error'), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const save = (v: string | null) =>
    run(async () => {
      const r = await domainSet(v);
      setD((x) => ({ ...x!, ...r }));
      setValue(r.domain ?? '');
      setFound(null);
      toast(r.status === 'ok' ? t('landing.domain.ready') : r.domain ? t('landing.domain.saved') : t('landing.domain.removed'), 'ok');
    });
  const check = () =>
    run(async () => {
      const r = await domainCheck();
      setFound(r.found);
      setD((x) => ({ ...x!, status: r.ok ? 'ok' : 'pending' }));
      toast(r.ok ? t('landing.domain.ready') : t('landing.domain.notYet'), r.ok ? 'ok' : 'bad');
    });
  const ips = d.ips?.length ? d.ips : ['—'];
  return (
    <section className="card">
      <h2>
        <Icon name="link" /> {t('landing.domain.title')}
      </h2>
      <p className="pd-note">{t('landing.domain.help')}</p>
      <Field label={t('landing.domain.label')} hint={t('landing.domain.hint')}>
        <div className="lp-copy">
          <input className="ltr" value={value} placeholder="www.ma-boutique.com" maxLength={253} onChange={(e) => setValue(e.target.value.trim().toLowerCase())} />
          <button type="button" className="btn small primary" disabled={busy || !value || value === d.domain} onClick={() => save(value)}>
            {t('common.save')}
          </button>
          {d.domain && (
            <button type="button" className="btn small ghost danger" disabled={busy} onClick={() => window.confirm(t('landing.domain.removeAsk')) && save(null)}>
              {t('landing.domain.remove')}
            </button>
          )}
        </div>
      </Field>
      {d.domain && (
        <>
          <p className="lp-dom-state">
            <span className={`chip ${d.status === 'ok' ? 'lp-on' : 'lp-warn'}`}>{d.status === 'ok' ? t('landing.domain.ok') : t('landing.domain.pending')}</span>{' '}
            {d.status === 'ok' ? (
              <a className="ltr" href={`https://${d.domain}/`} target="_blank" rel="noreferrer">
                https://{d.domain}/
              </a>
            ) : (
              <span>{t('landing.domain.wait')}</span>
            )}
          </p>
          {d.status !== 'ok' && (
            <div className="lp-dom-how">
              <b>{t('landing.domain.how')}</b>
              <table className="lp-dom-table">
                <thead>
                  <tr>
                    <th>{t('landing.domain.type')}</th>
                    <th>{t('landing.domain.name')}</th>
                    <th>{t('landing.domain.value')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ips.map((ip) => (
                    <tr key={ip}>
                      <td className="ltr">A</td>
                      <td className="ltr">{d.domain!.split('.').length > 2 ? d.domain!.split('.')[0] : '@'}</td>
                      <td className="ltr">{ip}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <small>{t('landing.domain.howHelp')}</small>
              {found && <small className="ltr">{t('landing.domain.found', { ips: found.join(', ') || '—' })}</small>}
              <button type="button" className="btn small" disabled={busy} onClick={check}>
                <Icon name="refresh" /> {t('landing.domain.check')}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
