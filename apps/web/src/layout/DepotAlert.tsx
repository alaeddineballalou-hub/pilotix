// The depot's red alert: an order it still holds was changed (or cancelled) by someone else. It covers the whole app,
// beeps every few seconds and vibrates the phone, until a depot agent fixes the parcel and taps « C'est corrigé ».
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { when } from '../lib/format';
import { useAction, useRpc } from '../lib/query';
import { alarm } from '../lib/sound';
import { Icon } from '../ui/kit';
import './depotAlert.css';

export function DepotAlert() {
  const { t } = useTranslation();
  const q = useRpc('depot.alerts', {}, { refetchInterval: 15_000 });
  const list = q.data ?? [];
  const [k, setK] = useState(0);
  const a = list[Math.min(k, list.length - 1)];
  const done = useAction('depot.alertDone', { success: t('depot.alert.fixedOk'), onDone: () => setK(0) });
  const open = list.length > 0;

  // the sound and the vibration, again and again, while an alert is open
  useEffect(() => {
    if (!open) return;
    const ring = () => {
      alarm();
      try {
        navigator.vibrate?.([300, 120, 300]);
      } catch {
        /* no vibration */
      }
    };
    ring();
    const id = window.setInterval(ring, 4000);
    return () => window.clearInterval(id);
  }, [open, list.length]);

  // nothing behind it can be reached: no scrolling, no keyboard
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!a) return null;
  const cancel = a.kind === 'cancel';
  return (
    <div className="pxda" role="alertdialog" aria-modal="true" aria-labelledby="pxda-t">
      <div className="pxda-top">
        <span className="pxda-ic">
          <Icon name="alert" />
        </span>
        <div>
          <b id="pxda-t">{cancel ? t('depot.alert.cancelTitle') : t('depot.alert.editTitle')}</b>
          <small>{cancel ? t('depot.alert.cancelSub') : t('depot.alert.editSub')}</small>
        </div>
        {list.length > 1 && (
          <span className="pxda-n">
            {Math.min(k, list.length - 1) + 1}/{list.length}
          </span>
        )}
      </div>
      <div className="pxda-card">
        <div className="pxda-ref">
          <b className="ltr">{a.ref}</b>
          <span className={`pxda-stage ${a.status === 'prepared' ? 'p' : ''}`}>{a.status === 'prepared' ? t('depot.alert.stagePrepared') : t('depot.alert.stageToPrepare')}</span>
        </div>
        <div className="pxda-who">
          {a.customer} · <span className="ltr">{a.phone}</span>
          {a.tracking && (
            <>
              {' '}
              · <span className="ltr">{a.tracking}</span>
            </>
          )}
        </div>
        <div className="pxda-by">{t('depot.alert.by', { name: a.byName ?? '—', when: when(a.at) })}</div>

        {cancel ? (
          <div className="pxda-cancel">
            <Icon name="xcircle" />
            <div>
              <b>{t('depot.alert.dontSend')}</b>
              <small>{t('depot.alert.dontSendSub')}</small>
            </div>
          </div>
        ) : (
          <ul className="pxda-ch">
            {a.changes.map((c) => (
              <li key={c.field}>
                <small>{t(`depot.alert.f.${c.field}`)}</small>
                <s>{c.from}</s>
                <b>
                  <Icon name="chevr" /> {c.to}
                </b>
              </li>
            ))}
          </ul>
        )}
        {!cancel && (
          <div className="pxda-now">
            <small>{t('depot.alert.mustContain')}</small>
            <b>{a.items}</b>
            <span className="ltr">{t('depot.alert.toCollect', { v: a.total.toLocaleString('fr-DZ') })}</span>
          </div>
        )}
        {!cancel && <p className="pxda-todo">{a.status === 'prepared' ? t('depot.alert.todoPrepared') : t('depot.alert.todoToPrepare')}</p>}
      </div>
      <div className="pxda-bar">
        {list.length > 1 && (
          <button type="button" className="pxda-next" onClick={() => setK((x) => (x + 1) % list.length)}>
            {t('depot.alert.next')}
          </button>
        )}
        <button type="button" className="pxda-ok" disabled={done.isPending} onClick={() => done.mutate({ id: a.id })}>
          <Icon name="check" /> {cancel ? t('depot.alert.removed') : t('depot.alert.fixed')}
        </button>
      </div>
    </div>
  );
}
