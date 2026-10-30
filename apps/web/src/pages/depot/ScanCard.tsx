import type { Order } from '@pilotix/shared';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { openOrder } from '../../lib/modals';
import { useQueryClient } from '@tanstack/react-query';
import { Help, Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { itemsLine } from './OrderList';
import { cleanCode, decodePhoto, isPhone, ring, startCamera, unlockAudio } from './scan';
import { trackOf } from '../../lib/items';
import { useIsPhone } from '../../lib/useMedia';
import './stages.css';

/** The scanner answers in the worker's language. */
const scanLang = (l: string | undefined): 'fr' | 'en' | 'ar' => (l?.startsWith('ar') ? 'ar' : l?.startsWith('en') ? 'en' : 'fr');

type Kind = 'ok' | 'bad' | 'warn';
interface Shown {
  kind: Kind | 'pick' | 'busy' | 'idle';
  code: string;
  why?: string;
  fix?: string;
  order?: Order | null;
  list?: Order[];
  at?: number;
}
type Mode = 'dispatch' | 'back';

// Same code twice within 2.5 s = one scan (douchettes often send twice).
const last = { code: '', at: 0 };

/** The scan card: douchette input, camera, photo, result, history ("Ce poste").
 *  On a phone the camera is the only way to scan: one big button, no douchette box; the camera stays open and shows
 *  the result of each parcel it reads. */
export function ScanCard({ mode, onBack, autoCamera }: { mode: Mode; onBack?: () => void; autoCamera?: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const phone = useIsPhone();
  const inp = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState<Shown>({ kind: 'idle', code: '' });
  const [log, setLog] = useState<Shown[]>([]);
  const [n, setN] = useState({ ok: 0, bad: 0 });
  const [cam, setCam] = useState(false);
  const queue = useRef<{ code: string; orderId?: number }[]>([]);
  const busy = useRef(false);

  const focus = () => {
    if (matchMedia('(pointer:fine)').matches && document.activeElement !== inp.current && !document.querySelector('.modal-wrap')) inp.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    const id = setTimeout(focus, 80);
    if (autoCamera) setCam(true);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const show = (v: Shown, silent = false) => {
    setShown(v);
    if (!silent && v.kind !== 'idle' && v.kind !== 'busy') ring(v.kind === 'pick' ? 'warn' : v.kind);
  };

  async function pump() {
    if (busy.current) return;
    busy.current = true;
    while (queue.current.length) {
      const j = queue.current.shift()!;
      setShown({ kind: 'busy', code: j.code });
      let v: Shown;
      try {
        const r = await rpc('depot.scan', { code: j.code, orderId: j.orderId, mode, lang: scanLang(i18n.language) });
        v = { kind: r.kind as Shown['kind'], code: r.code || j.code, why: r.why, fix: r.fix, order: r.order ?? null, list: r.list };
      } catch (e: any) {
        v = { kind: 'bad', code: j.code, why: t('scanner.refused', { msg: e?.message ?? '' }), fix: t('scanner.refusedFix') };
      }
      if (v.kind === 'pick') {
        show(v);
        continue;
      }
      v.at = Date.now();
      setLog((l) => [v, ...l].slice(0, 40));
      setN((c) => ({ ok: c.ok + (v.kind === 'ok' ? 1 : 0), bad: c.bad + (v.kind === 'ok' ? 0 : 1) }));
      show(v);
      if (v.kind === 'ok') qc.invalidateQueries();
    }
    busy.current = false;
    focus();
  }

  const add = (raw: string, orderId?: number) => {
    const code = cleanCode(raw);
    if (!code && !orderId) return;
    const now = Date.now();
    if (!orderId && code === last.code && now - last.at < 2500) return;
    last.code = code;
    last.at = now;
    queue.current.push({ code, orderId });
    pump();
  };

  const onPhoto = async () => {
    const f = file.current?.files?.[0];
    if (file.current) file.current.value = '';
    if (!f) return;
    setShown({ kind: 'busy', code: '', why: t('scanner.reading') });
    let code: string | null = null;
    try {
      code = await decodePhoto(f);
    } catch {
      code = null;
    }
    if (code) add(code);
    else show({ kind: 'bad', code: '—', why: t('scanner.noBarcode'), fix: t('scanner.noBarcodeFix') });
  };

  const M = (k: string) => t(`scanner.modes.${mode}.${k}`);
  const badgeOf = (k: Kind) => (k === 'ok' ? t('scanner.good') : k === 'bad' ? t('scanner.stop') : t('scanner.check'));
  const result = <Result v={shown} badgeOf={badgeOf} onPick={(o) => add(trackOf(o) || o.ref, o.id)} onCancel={() => setShown({ kind: 'idle', code: '' })} />;

  return (
    <section className="card bjf bjsc" onClick={(e) => !(e.target as HTMLElement).closest('input,button,a,select,textarea,summary,li') && focus()}>
      <div className="card-head">
        <h2 className="bjsc-title">
          <Icon name="scanbar" className="bjsc-ti" />
          {M('title')}
          <Help text={M('help')} label={M('title')} />
        </h2>
        <div className="row">
          <div className="bjsc-cnt">
            <span className="badge t-ok">{`✓ ${n.ok} ${M('ok')}`}</span>
            <span className="badge t-bad">✕ {t('scanner.errors', { count: n.bad })}</span>
          </div>
          {onBack && (
            <button type="button" className="btn small" onClick={onBack}>
              {t('scanner.change')}
            </button>
          )}
        </div>
      </div>
      <div className="bjf-row row">
        {phone ? (
          <button
            type="button"
            className="btn primary big bjsc-cam"
            onClick={() => {
              unlockAudio();
              setCam(true);
            }}
          >
            <Icon name="camera" /> {t('scanner.camTitle')}
          </button>
        ) : (
          <>
            <input
              ref={inp}
              id={`bjsc-in-${mode}`}
              type="text"
              className="bjf-in grow"
              placeholder={t('scanner.inputPh')}
              aria-label={t('scanner.inputLabel')}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="characters"
              onKeyDown={(e) => {
                unlockAudio();
                const el = e.currentTarget;
                if ((e.key === 'Enter' || e.key === 'Tab') && el.value.trim()) {
                  e.preventDefault();
                  const v = el.value;
                  el.value = '';
                  add(v);
                }
              }}
            />
            <button
              type="button"
              className="btn primary big"
              onClick={() => {
                unlockAudio();
                setCam(true);
              }}
            >
              <Icon name="camera" /> {t('scanner.camera')}
            </button>
            <button
              type="button"
              className="btn big"
              onClick={() => {
                unlockAudio();
                file.current?.click();
              }}
            >
              {t('scanner.photo')}
            </button>
          </>
        )}
        <input ref={file} type="file" accept="image/*" capture="environment" hidden onChange={onPhoto} />
      </div>
      {!(phone && shown.kind === 'idle') && (
        <div className="bjsc-res" aria-live="assertive">
          {result}
        </div>
      )}
      {shown.kind === 'idle' && <p className="muted small">{phone || isPhone() ? t('scanner.idlePhone') : t('scanner.idlePc')}</p>}
      {!(phone && !log.length) && (
        <>
          <h3>{t('scanner.post')}</h3>
          <ul className="bjsc-log">
            {!log.length && <li className="muted small">{t('scanner.postEmpty')}</li>}
            {log.map((v, i) => (
              <li key={i} className="bjsc-li" tabIndex={0} onClick={() => show(v, true)} onKeyDown={(e) => e.key === 'Enter' && show(v, true)}>
                <i className={`bjsc-dot ${v.kind}`} />
                <div className="grow">
                  <b className="ltr">{v.code}</b>
                  <small>{v.why}</small>
                </div>
                <time className="ltr">{new Date(v.at!).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</time>
              </li>
            ))}
          </ul>
        </>
      )}
      {cam && (
        <CameraModal
          result={shown.kind === 'idle' ? null : result}
          onClose={() => {
            setCam(false);
            setTimeout(focus, 50);
          }}
          onCode={(c) => add(c)}
          onPhoto={() => {
            setCam(false);
            file.current?.click();
          }}
        />
      )}
    </section>
  );
}

function Result({ v, badgeOf, onPick, onCancel }: { v: Shown; badgeOf: (k: Kind) => string; onPick: (o: Order) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  if (v.kind === 'idle') return <div className="bjsc-v" />;
  if (v.kind === 'busy')
    return (
      <div className="bjsc-v">
        <div className="bjsc-h">
          <span className="bjsc-spin" />
          <b className="bjsc-b">{v.why ?? t('scanner.checking')}</b>
          <span className="bjsc-code ltr">{v.code}</span>
        </div>
      </div>
    );
  if (v.kind === 'pick')
    return (
      <div className="bjsc-v warn">
        <div className="bjsc-h">
          <b className="bjsc-b">{t('scanner.several')}</b>
          <span className="bjsc-code ltr">{v.code}</span>
        </div>
        <p className="bjsc-why">{t('scanner.chooseOne')}</p>
        <div className="bjs-res">
          {v.list?.map((o) => (
            <button key={o.id} type="button" className="bjs-opt" onClick={() => onPick(o)}>
              <b className="ltr">{o.ref}</b>
              <span>
                {o.customerName} · {itemsLine(o)}
              </span>
              <span className="badge t-info">{o.followStatus ? t(`status.follow.${o.followStatus}`) : t(`status.conf.${o.confStatus}`)}</span>
            </button>
          ))}
        </div>
        <button type="button" className="linkish" onClick={onCancel}>
          {t('scanner.cancelScan')}
        </button>
      </div>
    );
  return (
    <div className={`bjsc-v ${v.kind}`}>
      <div className="bjsc-h">
        {v.kind !== 'warn' && <Icon name={v.kind === 'ok' ? 'checkcircle' : 'xcircle'} className="bjsc-vi" />}
        <b className="bjsc-b">{badgeOf(v.kind)}</b>
        <span className="bjsc-code ltr">{v.code}</span>
        {v.order && (
          <button type="button" className="linkish ltr" onClick={() => openOrder(v.order!.id)}>
            {v.order.ref}
          </button>
        )}
      </div>
      <p className="bjsc-why">{v.why}</p>
      {v.fix && <p className="bjsc-fix">{v.fix}</p>}
    </div>
  );
}

/** The live camera. `result`: what the last code read gave (good, stop, check, choose), shown above the picture so the
 *  camera can stay open from one parcel to the next. */
function CameraModal({ onClose, onCode, onPhoto, result }: { onClose: () => void; onCode: (c: string) => void; onPhoto: () => void; result?: ReactNode }) {
  const { t } = useTranslation();
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let stop: (() => void) | null = null;
    let dead = false;
    const seen = { code: '', at: 0 };
    if (!navigator.mediaDevices?.getUserMedia) {
      setErr(t('scanner.camDenied'));
      return;
    }
    startCamera(video.current!, (c) => {
      const now = Date.now();
      if (c === seen.code && now - seen.at < 3000) return;
      seen.code = c;
      seen.at = now;
      onCode(c);
    })
      .then((s) => {
        if (dead) s();
        else {
          stop = s;
          setReady(true);
        }
      })
      .catch(() => setErr(t('scanner.camDenied')));
    return () => {
      dead = true;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Modal
      title={t('scanner.camTitle')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onPhoto}>
            {t('scanner.takePhoto')}
          </button>
          <button className="btn primary" onClick={onClose}>
            {t('common.close')}
          </button>
        </>
      }
    >
      {err ? (
        <p className="badbox">{err}</p>
      ) : (
        <>
          {result ? (
            <div className="bjsc-camres" aria-live="assertive">
              {result}
            </div>
          ) : (
            <p className="muted small">{ready ? t('scanner.camHelp') : t('scanner.camStarting')}</p>
          )}
          <video ref={video} muted playsInline style={{ width: '100%', maxHeight: '60vh', borderRadius: 12, background: '#000' }} />
        </>
      )}
    </Modal>
  );
}
