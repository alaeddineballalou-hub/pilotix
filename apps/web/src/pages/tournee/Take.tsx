// « Ma tournée », the livreur's own hands: « Je travaille aujourd'hui » each morning, and « Prendre un colis » — he scans
// each parcel he takes from the shelf (« Dispatchées »): it goes « En livraison », its cash is his, and only then does he
// see its customer. A parcel of another livreur becomes his (the managers are told).
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { wilayaName } from '../../lib/format';
import { Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { cleanCode, ring, startCamera, unlockAudio } from '../depot/scan';

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Africa/Algiers' });

/** « Je travaille aujourd'hui »: a big button until he says it, then one green line. */
export function CheckIn({ at }: { at: string | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (at)
    return (
      <p className="tk-in">
        <Icon name="checkcircle" /> {t('tournee.tk.inAt', { time: hhmm(at) })}
      </p>
    );
  return (
    <section className="tk-check">
      <div>
        <b>{t('tournee.tk.morning')}</b>
        <small>{t('tournee.tk.morningHint')}</small>
      </div>
      <button
        type="button"
        className="tk-big"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await rpc('tournee.checkIn', {});
            qc.invalidateQueries();
          } catch (e: any) {
            toast(e.message, 'bad');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Icon name="checkcircle" /> {t('tournee.tk.iWork')}
      </button>
    </section>
  );
}

/** « Prendre un colis »: the scanner gun (or typing) in the box, or the phone's camera. */
export function TakeBox() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [cam, setCam] = useState(false);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ ok: boolean; text: string } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const seen = useRef<{ code: string; at: number }>({ code: '', at: 0 });

  const take = async (raw: string) => {
    const c = cleanCode(raw);
    if (!c) return;
    // the camera reads the same label many times a second
    if (seen.current.code === c && Date.now() - seen.current.at < 4000) return;
    seen.current = { code: c, at: Date.now() };
    setBusy(true);
    try {
      const r = await rpc('tournee.take', { code: c });
      const o = r.order;
      const where = [o.commune, wilayaName(o.wilayaId)].filter(Boolean).join(' · ');
      const text = r.already ? t('tournee.tk.already', { ref: o.ref }) : r.from ? t('tournee.tk.tookFrom', { ref: o.ref, name: o.customerName, where, from: r.from }) : t('tournee.tk.took', { ref: o.ref, name: o.customerName, where });
      setLast({ ok: true, text });
      ring(r.already ? 'warn' : 'ok');
      setCode('');
      qc.invalidateQueries();
    } catch (e: any) {
      setLast({ ok: false, text: e.message });
      ring('bad');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!cam || !video.current) return;
    let stop: (() => void) | null = null;
    let off = false;
    startCamera(video.current, (c) => void take(c))
      .then((s) => (off ? s() : (stop = s)))
      .catch(() => {
        setCam(false);
        toast(t('scanner.camDenied'), 'bad');
      });
    return () => {
      off = true;
      stop?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam]);

  return (
    <section className="tk-take">
      <div className="tk-h">
        <Icon name="package" />
        <b>{t('tournee.tk.take')}</b>
      </div>
      <p className="tk-hint">{t('tournee.tk.takeHint')}</p>
      <form
        className="tk-row"
        onSubmit={(e) => {
          e.preventDefault();
          unlockAudio();
          void take(code);
        }}
      >
        <input
          className="ltr"
          value={code}
          autoComplete="off"
          enterKeyHint="go"
          placeholder={t('tournee.tk.codePh')}
          aria-label={t('tournee.tk.codePh')}
          onChange={(e) => setCode(e.target.value)}
        />
        <button type="submit" className="btn" disabled={busy || !code.trim()}>
          {t('tournee.tk.ok')}
        </button>
        <button
          type="button"
          className={`btn tk-cam${cam ? ' on' : ''}`}
          aria-pressed={cam}
          onClick={() => {
            unlockAudio();
            setCam(!cam);
          }}
        >
          <Icon name="image" /> {cam ? t('tournee.tk.camOff') : t('tournee.tk.cam')}
        </button>
      </form>
      {cam && <video ref={video} className="tk-video" muted playsInline />}
      {last && (
        <p className={`tk-last ${last.ok ? 'ok' : 'bad'}`} role="status">
          <Icon name={last.ok ? 'checkcircle' : 'alert'} /> {last.text}
        </p>
      )}
    </section>
  );
}
