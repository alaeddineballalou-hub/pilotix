// The depot's red alert: an order it still holds was changed (or cancelled) by someone else. It covers the whole app,
// beeps every few seconds and vibrates the phone, until the parcel is fixed — proven by scanning: a cancelled parcel's
// label once; a changed parcel's old label, then (after printing it) its new label. A parcel at a courier: one scan.
// A company with an API (ZR…) always gets its own label here, never a Pilotix one; a parcel that never had a label has
// no « old label » step (22 Nov 2026).
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, rpc } from '../lib/backend';
import { when } from '../lib/format';
import { useAction, useRpc } from '../lib/query';
import { alarm } from '../lib/sound';
import { enablePush } from '../lib/push';
import { Icon } from '../ui/kit';
import { toast } from '../ui/toast';
import { labelHref, printLabelItems } from '../pages/depot/labelPrint';
import { byOf, useCouriers, useSendToCompany } from '../pages/depot/Labels';
import { ring, startCamera } from '../pages/depot/scan';
import './depotAlert.css';

type Alert = NonNullable<ReturnType<typeof useRpc<'depot.alerts'>>['data']>[number];

/** This phone rings for the dépôt alerts even when Pilotix is closed: asked once (a tap is needed), kept after. */
function PushAsk() {
  const { t } = useTranslation();
  const [state, setState] = useState<'on' | 'denied' | 'off' | 'unsupported' | null>(null);
  const me = useRpc('depot.alertMine', {}, { staleTime: 5 * 60_000 }).data?.mine;
  useEffect(() => {
    if (!me) return;
    enablePush(false)
      .then(setState)
      .catch(() => setState('unsupported'));
  }, [me]);
  if (state !== 'off' && state !== 'denied') return null;
  return (
    <div className="pxda-ask" role="status">
      <Icon name="alert" />
      <span>{state === 'denied' ? t('depot.alert.pushDenied') : t('depot.alert.pushAsk')}</span>
      {state === 'off' && (
        <button type="button" onClick={() => enablePush(true).then(setState).catch(() => setState('unsupported'))}>
          {t('depot.alert.pushOn')}
        </button>
      )}
    </div>
  );
}

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
        navigator.vibrate?.([600, 150, 600, 150, 600]);
      } catch {
        /* no vibration */
      }
    };
    ring();
    const id = window.setInterval(ring, 2500);
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

  if (!a) return <PushAsk />;
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
          <span className={`pxda-stage ${a.stage === 'prepared' ? 'p' : ''}`}>{a.stage === 'prepared' ? t('depot.alert.stagePrepared') : t('depot.alert.stageToPrepare')}</span>
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
        <Steps key={a.id} a={a} />
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

/**
 * What closes the alert: the label on the parcel (when it ever had one), then — a changed parcel with a new label — its
 * new label printed, stuck on and scanned. A company with an API (ZR…): always its own label, sent to it first when the
 * parcel has no tracking number yet, never a Pilotix one. A cancelled parcel that never had a label: « Colis retiré ».
 */
function Steps({ a }: { a: Alert }) {
  const { t } = useTranslation();
  const c = useCouriers();
  const [code, setCode] = useState('');
  const [cam, setCam] = useState(false);
  const [printed, setPrinted] = useState(false);
  const [busy, setBusy] = useState(false);
  /** sent to its company from here: the step stays on screen, ticked */
  const [sentHere, setSentHere] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const toCompany = useSendToCompany();
  const scan = useAction('depot.alertScan', {
    silent: true,
    onDone: (r) => {
      ring('ok');
      setErr('');
      setCode('');
      if (r.step === 'done') toast(t('depot.alert.fixedOk'), 'ok');
    },
  });
  const takenOut = useAction('depot.alertNoLabel', {
    onDone: () => {
      ring('ok');
      toast(t('depot.alert.fixedOk'), 'ok');
    },
  });
  const cancel = a.kind === 'cancel';
  const co = a.companyName || t('depot.alert.theCompany');
  /** a new label goes on the parcel (known, or the company's, once it is sent there) */
  const two = !!a.newCode || a.send;
  /** a cancelled parcel that never had a label: nothing to scan */
  const noScan = cancel && a.noOld;
  const step: 'old' | 'send' | 'print' | 'scan' | 'out' = !a.found ? 'old' : noScan ? 'out' : a.send ? 'send' : two && !printed ? 'print' : 'scan';
  // the order, ready before « Imprimer »: a company's label opens in a new tab at the tap itself (not blocked)
  const order = useRpc('orders.get', { id: a.orderId }, { enabled: !!a.newCode, staleTime: 0 });
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
    input.current?.focus({ preventScroll: true });
  }, [a.id, a.found, printed]);
  const print = async () => {
    const o = order.data;
    if (!c || !o || !a.newCode || busy) return;
    setErr('');
    // the company prints its own label (ZR…): that one, asked from it — never a Pilotix label in its name
    const theirs = a.api && byOf(o, c) === 'company';
    if (theirs && backend.kind !== 'demo') {
      const w = window.open('', '_blank');
      setBusy(true);
      try {
        const href = labelHref(await rpc('delivery.label', { orderId: o.id }));
        if (href) {
          if (w) w.location.href = href;
          else window.open(href, '_blank');
        } else {
          w?.close();
          await printLabelItems(t, [{ o, code: a.newCode }], c.shop); // the company gives no label of its own
        }
        setPrinted(true);
      } catch (e: any) {
        w?.close();
        setErr(e.message);
      } finally {
        setBusy(false);
      }
      return;
    }
    // own livreurs, companies without an API or without labels: the Pilotix label (in the preview, the company's is
    // simulated: a stand-in, marked so)
    try {
      await printLabelItems(t, [{ o, code: a.newCode, demo: theirs }], c.shop);
      setPrinted(true);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const rows: { key: string; on: boolean; ok: boolean; title: string; sub?: string | null }[] = [];
  if (!a.noOld) rows.push({ key: 'old', on: step === 'old', ok: a.found, title: cancel ? t('depot.alert.s.findCancel') : two ? t('depot.alert.s.findOld') : t('depot.alert.s.findOne'), sub: a.oldCode });
  if (noScan) rows.push({ key: 'out', on: true, ok: false, title: t('depot.alert.s.takeOut') });
  if (a.send || sentHere) rows.push({ key: 'send', on: step === 'send', ok: !a.send, title: t('depot.alert.s.send', { co }) });
  if (two) {
    rows.push({ key: 'print', on: step === 'print', ok: printed, title: a.api ? t('depot.alert.s.printCo', { co }) : t('depot.alert.s.print'), sub: a.newCode });
    rows.push({ key: 'scan', on: step === 'scan', ok: false, title: a.api ? t('depot.alert.s.scanCo', { co }) : t('depot.alert.s.scanNew'), sub: a.newCode });
  }
  return (
    <div className="pxda-steps">
      <ol>
        {rows.map((r, n) => (
          <li key={r.key} className={`${r.on ? 'on' : ''}${r.ok ? ' ok' : ''}`}>
            <span className="pxda-sn">{r.ok ? <Icon name="check" /> : n + 1}</span>
            <span>
              <b>{r.title}</b>
              {r.sub && <small className="ltr">{r.sub}</small>}
            </span>
          </li>
        ))}
      </ol>
      {step === 'send' && (
        <button
          type="button"
          className="pxda-print on"
          disabled={toCompany.busy}
          onClick={() => {
            setSentHere(true);
            void toCompany.send([a.orderId]);
          }}
        >
          <Icon name="truck" /> {t('depot.alert.sendTo', { co })}
        </button>
      )}
      {(step === 'print' || step === 'scan') && two && (
        <button type="button" className={`pxda-print${step === 'print' ? ' on' : ''}`} disabled={busy || !order.data} onClick={print}>
          <Icon name="printer" /> {printed ? t('depot.alert.reprint') : a.api ? t('depot.alert.printCo', { co }) : t('depot.alert.printNew')}
        </button>
      )}
      {step === 'out' && (
        <button type="button" className="pxda-print on" disabled={takenOut.isPending} onClick={() => takenOut.mutate({ id: a.id })}>
          <Icon name="check" /> {t('depot.alert.takenOut')}
        </button>
      )}
      {err && (
        <p className="pxda-err" role="alert">
          <Icon name="xcircle" /> {err}
        </p>
      )}
      {(step === 'old' || step === 'scan') && (
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
            placeholder={step === 'scan' && two ? (a.api ? t('depot.alert.scanCoPh', { co }) : t('depot.alert.scanNewPh')) : t('depot.alert.scanPh')}
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
      {cam && (step === 'old' || step === 'scan') && <Camera onCode={send} onClose={() => setCam(false)} />}
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
