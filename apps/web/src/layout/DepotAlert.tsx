// The depot's red alert: an order it still holds was changed (or cancelled) by someone else. It covers the whole app,
// beeps every few seconds and vibrates the phone, until the parcel is fixed — proven by scanning: a cancelled parcel's
// label once; a changed parcel's old label, then (after printing it) its new label. A parcel at a courier: one scan.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../lib/backend';
import { when } from '../lib/format';
import { useAction, useRpc } from '../lib/query';
import { alarm } from '../lib/sound';
import { Icon } from '../ui/kit';
import { toast } from '../ui/toast';
import { printLabelItems } from '../pages/depot/labelPrint';
import { useCouriers } from '../pages/depot/Labels';
import { ring, startCamera } from '../pages/depot/scan';
import './depotAlert.css';

type Alert = NonNullable<ReturnType<typeof useRpc<'depot.alerts'>>['data']>[number];

export function DepotAlert() {
  const { t } = useTranslation();
  const q = useRpc('depot.alerts', {}, { refetchInterval: 15_000 });
  const list = q.data ?? [];
  const [k, setK] = useState(0);
  const a = list[Math.min(k, list.length - 1)];
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
        <Steps a={a} />
      </div>
      {list.length > 1 && (
        <div className="pxda-bar">
          <button type="button" className="pxda-next" onClick={() => setK((x) => (x + 1) % list.length)}>
            {t('depot.alert.next')}
          </button>
        </div>
      )}
    </div>
  );
}

/** The scans that close the alert: the label on the parcel, then — a changed parcel with a new code — print and scan the new one. */
function Steps({ a }: { a: Alert }) {
  const { t } = useTranslation();
  const c = useCouriers();
  const [code, setCode] = useState('');
  const [cam, setCam] = useState(false);
  const [printed, setPrinted] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const scan = useAction('depot.alertScan', {
    silent: true,
    onDone: (r) => {
      ring('ok');
      setErr('');
      setCode('');
      if (r.step === 'done') toast(t('depot.alert.fixedOk'), 'ok');
    },
  });
  const two = !!a.newCode;
  const step = !a.found ? 1 : printed ? 3 : 2;
  const send = (v: string) => {
    const x = v.trim();
    if (!x || scan.isPending) return;
    scan.mutate(
      { id: a.id, code: x },
      {
        onError: (e) => {
          ring('bad');
          setErr(e.message);
          setCode('');
        },
      },
    );
  };
  useEffect(() => {
    input.current?.focus();
  }, [a.id, a.found, printed]);
  const print = async () => {
    try {
      const o = await rpc('orders.get', { id: a.orderId });
      await printLabelItems(t, [{ o, code: a.newCode! }], c?.shop ?? { name: '', sav: '' });
      setPrinted(true);
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };
  const row = (n: number, on: boolean, ok: boolean, title: string, sub?: string | null) => (
    <li className={`${on ? 'on' : ''}${ok ? ' ok' : ''}`}>
      <span className="pxda-sn">{ok ? <Icon name="check" /> : n}</span>
      <span>
        <b>{title}</b>
        {sub && <small className="ltr">{sub}</small>}
      </span>
    </li>
  );
  return (
    <div className="pxda-steps">
      <ol>
        {row(1, step === 1, a.found, a.kind === 'cancel' ? t('depot.alert.s.findCancel') : two ? t('depot.alert.s.findOld') : t('depot.alert.s.findOne'), a.oldCode)}
        {two && row(2, step === 2, printed || false, t('depot.alert.s.print'), a.newCode)}
        {two && row(3, step === 3, false, t('depot.alert.s.scanNew'), a.newCode)}
      </ol>
      {two && step >= 2 && (
        <button type="button" className={`pxda-print${step === 2 ? ' on' : ''}`} onClick={print}>
          <Icon name="printer" /> {printed ? t('depot.alert.reprint') : t('depot.alert.printNew')}
        </button>
      )}
      {err && (
        <p className="pxda-err" role="alert">
          <Icon name="xcircle" /> {err}
        </p>
      )}
      {(step !== 2 || !two) && (
        <form
          className="pxda-scan"
          onSubmit={(e) => {
            e.preventDefault();
            send(code);
          }}
        >
          <input
            ref={input}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={step === 3 ? t('depot.alert.scanNewPh') : t('depot.alert.scanPh')}
            aria-label={t('depot.alert.scanPh')}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
          <button type="button" className="pxda-cam" aria-label={t('depot.alert.camera')} onClick={() => setCam((v) => !v)}>
            <Icon name="camera" />
          </button>
        </form>
      )}
      {cam && (step !== 2 || !two) && <Camera onCode={send} onClose={() => setCam(false)} />}
    </div>
  );
}

function Camera({ onCode, onClose }: { onCode: (c: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let stop: (() => void) | null = null;
    let dead = false;
    const seen = { code: '', at: 0 };
    if (!navigator.mediaDevices?.getUserMedia) {
      setErr(true);
      return;
    }
    startCamera(video.current!, (c) => {
      const now = Date.now();
      if (c === seen.code && now - seen.at < 3000) return;
      seen.code = c;
      seen.at = now;
      onCode(c);
    })
      .then((s) => (dead ? s() : (stop = s)))
      .catch(() => setErr(true));
    return () => {
      dead = true;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="pxda-video">
      {err ? <p>{t('scanner.camDenied')}</p> : <video ref={video} muted playsInline />}
      <button type="button" onClick={onClose}>
        {t('common.close')}
      </button>
    </div>
  );
}
