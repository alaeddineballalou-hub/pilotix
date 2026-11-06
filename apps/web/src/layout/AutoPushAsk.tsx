// Pilot Automations: a supervisor or a manager the evening report or the slow call queue alerts go to (the admins set it
// in « Automatisations ») is asked once to turn on notifications on this phone; « Plus tard » hides it a week here.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { enablePush } from '../lib/push';
import { useRpc } from '../lib/query';
import { Icon } from '../ui/kit';
import './autoPushAsk.css';

const LATER = 'px-autopush-later';
type PushState = Awaited<ReturnType<typeof enablePush>>;

export function AutoPushAsk() {
  const { t } = useTranslation();
  const k = 'notify.auto.phone';
  const mine = useRpc('auto.alertMine', {}, { staleTime: 10 * 60_000, retry: false }).data?.mine;
  const [later, setLater] = useState(() => {
    try {
      return Number(localStorage.getItem(LATER) ?? 0) > Date.now();
    } catch {
      return false;
    }
  });
  const [state, setState] = useState<PushState | null>(null);
  useEffect(() => {
    if (!mine || later) return;
    enablePush(false)
      .then(setState)
      .catch(() => setState('unsupported'));
  }, [mine, later]);
  if (!mine || later || (state !== 'off' && state !== 'denied')) return null;
  const hide = () => {
    try {
      localStorage.setItem(LATER, String(Date.now() + 7 * 24 * 3_600_000));
    } catch {
      // private mode: hidden until the page is opened again
    }
    setLater(true);
  };
  return (
    <div className="pxap-ask" role="status">
      <Icon name="bell" />
      <span>{t(state === 'denied' ? `${k}.denied` : `${k}.ask`)}</span>
      {state === 'off' && (
        <button type="button" className="pxap-on" onClick={() => enablePush(true).then(setState).catch(() => setState('unsupported'))}>
          {t(`${k}.on`)}
        </button>
      )}
      <button type="button" className="pxap-later" onClick={hide}>
        {t(`${k}.later`)}
      </button>
    </div>
  );
}
