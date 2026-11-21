// The backup door in the top bar (lib/door; the owner left the look to Claude, 21 Nov 2026: the chip of design 2 and the
// 5-second message of design 5).
// - On the backup door: a small chip, always there; a click opens what it means, whether the usual address answers
//   again, and the way back. Just arrived: a message for 5 seconds under the top bar, then only the chip.
// - On the usual address, when its road is cut while the backup door answers: the move, by itself after 5 seconds
//   (« Rester ici » stops it), or with a button when something is being typed (nothing typed is ever lost by itself).
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { doorView, goBack, mainOrigin, moveToBackupDoor, onDoorView, stayHere } from '../lib/door';
import { Icon } from './kit';
import './door.css';

/** pilotix.online (the usual address, as people know it) */
const siteName = () => mainOrigin().replace(/^https?:\/\//, '') || 'pilotix.online';

export function DoorChip() {
  const { t } = useTranslation();
  const v = useSyncExternalStore(onDoorView, doorView);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const site = siteName();

  // just arrived: the message for 5 seconds, then the chip alone
  useEffect(() => {
    if (!v.arrived) return;
    setMsg(true);
    const id = setTimeout(() => setMsg(false), 5000);
    return () => clearTimeout(id);
  }, [v.arrived]);

  // a click outside or Escape closes the details
  useEffect(() => {
    if (!open) return;
    const out = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', out, true);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', out, true);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  return (
    <>
      {v.here && (
        <span className="px-door" ref={box}>
          <button
            type="button"
            className={`px-door-chip${v.mainBack ? ' back' : ''}${msg ? ' fresh' : ''}`}
            aria-expanded={open}
            aria-haspopup="dialog"
            title={t('shell.door.chipTitle')}
            onClick={() => setOpen(!open)}
          >
            <Icon name="door" />
            <span className="px-door-l">{t('shell.door.chip')}</span>
            <span className="px-door-dot" aria-hidden="true" />
          </button>
          {open && (
            <div className="px-door-pop" role="dialog" aria-label={t('shell.door.title')}>
              <div className="px-door-pop-h">
                <span className="px-door-ic">
                  <Icon name="door" />
                </span>
                <b>{t('shell.door.title')}</b>
              </div>
              <p>{t('shell.door.text', { site })}</p>
              <p className={`px-door-state ${v.mainBack ? 'ok' : 'cut'}`}>
                <span className="px-door-led" aria-hidden="true" />
                {v.mainBack ? t('shell.door.stateBack', { site }) : t('shell.door.stateCut', { site })}
              </p>
              <button type="button" className="btn px-door-back" disabled={v.demo} onClick={() => void goBack()}>
                {t('shell.door.back', { site })}
              </button>
              <p className="px-door-note">{t('shell.door.note')}</p>
            </div>
          )}
        </span>
      )}
      {msg && v.here && (
        <div className="px-door-msg" role="status" aria-live="polite">
          <span className="px-door-ic">
            <Icon name="door" />
          </span>
          <span className="px-door-msg-t">
            <b>{t('shell.door.msgTitle')}</b>
            <small>{t(v.arrived === 'app' ? 'shell.door.msgApp' : 'shell.door.msgSw', { site })}</small>
          </span>
        </div>
      )}
      {v.offer && !v.here && <DoorOffer auto={v.offer === 'auto'} site={site} />}
    </>
  );
}

/** The usual address is cut, the backup door answers: go there (by itself after 5 s), or stay. */
function DoorOffer({ auto, site }: { auto: boolean; site: string }) {
  const { t } = useTranslation();
  const [left, setLeft] = useState(5);
  const [going, setGoing] = useState(false);
  const go = () => {
    setGoing(true);
    void moveToBackupDoor();
  };
  useEffect(() => {
    if (!auto || going) return;
    if (left <= 0) {
      setGoing(true);
      void moveToBackupDoor();
      return;
    }
    const id = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(id);
  }, [auto, left, going]);
  return (
    <div className="px-door-msg px-door-offer" role="alert">
      <span className="px-door-ic">
        <Icon name="door" />
      </span>
      <span className="px-door-msg-t">
        <b>{t('shell.door.offerTitle', { site })}</b>
        <small>{going ? t('shell.door.offerGoing') : auto ? t('shell.door.offerAuto', { n: left }) : t('shell.door.offerAsk')}</small>
      </span>
      {!going && (
        <span className="px-door-offer-b">
          <button type="button" className="btn primary" onClick={go}>
            {t('shell.door.offerGo')}
          </button>
          <button type="button" className="btn" onClick={stayHere}>
            {t('shell.door.offerStay')}
          </button>
        </span>
      )}
    </div>
  );
}
