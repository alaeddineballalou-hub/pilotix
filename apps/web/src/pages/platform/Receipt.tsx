// A payment's receipt alone on its page (#/platform/receipt/<id>): printed, or saved as PDF from the browser's print
// window (« Enregistrer au format PDF »). Numbered per year (PX-2026-0001); a cancelled payment says so.
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { da, dateOnly } from '../../lib/format';
import { usePRpc } from '../../lib/platform';
import { ErrorBox, Icon, Loading } from '../../ui/kit';
import { MailReceipt } from './ShopDetail';

export function Receipt({ id }: { id: number }) {
  const { t } = useTranslation();
  const q = usePRpc('p.payments.receipt', { id });
  useEffect(() => {
    document.body.classList.add('pp-print-page');
    return () => document.body.classList.remove('pp-print-page');
  }, []);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data!;
  const c = r.company;
  return (
    <div className="pp-receipt-page">
      <div className="pp-receipt-bar no-print">
        <a className="btn" href={`#/platform/shops/${r.shop.id}`}>
          ← {r.shop.name}
        </a>
        <span className="grow" />
        {!r.voidAt && <MailReceipt id={r.id} />}
        <button type="button" className="btn primary" onClick={() => window.print()}>
          <Icon name="printer" /> {t('platform.rc.print')}
        </button>
      </div>
      <article className="pp-receipt">
        <header>
          <span className="px-logo-full pp-receipt-logo" aria-label="Pilotix" />
          <div className="pp-receipt-co">
            <b>{c.name || 'Pilotix'}</b>
            {c.address && <span>{c.address}</span>}
            {(c.phone || c.email) && <span className="ltr">{[c.phone, c.email].filter(Boolean).join(' · ')}</span>}
            {c.taxId && <span>NIF {c.taxId}</span>}
          </div>
        </header>
        <h1>
          {t('platform.rc.title')} <span className="ltr">{r.receiptNo ?? `#${r.id}`}</span>
        </h1>
        {r.voidAt && <p className="pp-receipt-void">{t('platform.rc.void', { reason: r.voidReason ?? '' })}</p>}
        <dl>
          <dt>{t('platform.rc.client')}</dt>
          <dd>
            <b>{r.shop.name}</b>
            {r.shop.ownerName && <span>{r.shop.ownerName}</span>}
            {r.shop.ownerEmail && <span className="ltr">{r.shop.ownerEmail}</span>}
            {r.shop.ownerPhone && <span className="ltr">{r.shop.ownerPhone}</span>}
          </dd>
          <dt>{t('platform.rc.date')}</dt>
          <dd>{dateOnly(r.paidAt)}</dd>
          <dt>{t('platform.rc.what')}</dt>
          <dd>
            {t('platform.rc.subscription', { plan: r.plan ?? 'Pilotix' })} — {t('platform.p.monthsN', { count: r.months })}
            <span>
              {dateOnly(r.periodFrom)} → {dateOnly(r.periodTo)}
            </span>
          </dd>
          <dt>{t('platform.p.method')}</dt>
          <dd>
            {t(`platform.method.${r.method}`)}
            {r.reference ? <span className="ltr">{r.reference}</span> : null}
          </dd>
        </dl>
        <p className="pp-receipt-total">
          {t('platform.rc.total')} <b className="ltr">{da(r.amount)}</b>
        </p>
        <footer>{t('platform.rc.thanks')}</footer>
      </article>
    </div>
  );
}
