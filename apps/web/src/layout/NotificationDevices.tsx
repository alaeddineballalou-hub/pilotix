import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { rpc, type Out } from '../lib/backend';
import { myEndpoint, phoneDevice, pushSupported, pushTurnOn, testDevicePush } from '../lib/push';
import { Card, Icon } from '../ui/kit';

const DEVICE_KEY = 'pilotix-notification-device';
export const SHOW_NOTIFICATION_DEVICES = 'pilotix:show-notification-devices';
export function isNativePilotix() {
  const mobileBridge = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return mobileBridge?.isNativePlatform?.() === true;
}
type Devices = Out<'push.devices'>;
type Kind = 'phone' | 'pc';

function deviceId() {
  const stored = localStorage.getItem(DEVICE_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  localStorage.setItem(DEVICE_KEY, id);
  return id;
}

export function NotificationDevices({ children, logout }: { children: ReactNode; logout: () => void }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'checking' | 'blocked' | 'ready'>('checking');
  const [devices, setDevices] = useState<Devices>([]);
  const [here, setHere] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState<Kind>(phoneDevice() ? 'phone' : 'pc');
  const [name, setName] = useState('');
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const initialized = useRef(false);
  const check = useRef(0);
  const refresh = useCallback(async (setup?: { name: string; kind: Kind }) => {
    const request = ++check.current;
    try {
      const id = deviceId();
      const endpoint = pushSupported() && Notification.permission === 'granted' ? await myEndpoint() : null;
      const result = await rpc('push.device.checkIn', { id, endpoint, setup }, null);
      const list = await rpc('push.devices', {}, null);
      if (request !== check.current) return;
      setHere(id);
      setDevices(list);
      if (!initialized.current) {
        initialized.current = true;
        const current = list.find((device) => device.id === id);
        if (current) {
          setName(current.name);
          setKind(current.kind === 'phone' ? 'phone' : 'pc');
        }
      }
      if (setup) setMessage('');
      setState(result.registered && result.enabled ? 'ready' : 'blocked');
    } catch {
      if (request === check.current) setState('blocked');
    }
  }, []);

  useEffect(() => {
    const check = () => { if (document.visibilityState === 'visible') void refresh(); };
    check();
    const timer = window.setInterval(check, 30_000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [refresh]);
  useEffect(() => {
    setActions(state === 'ready' ? document.getElementById('notification-device-actions') : null);
  }, [state]);
  useEffect(() => {
    if (!actions) return;
    const show = () => {
      setOpen(true);
      actions.scrollIntoView({ block: 'nearest' });
    };
    window.addEventListener(SHOW_NOTIFICATION_DEVICES, show);
    return () => window.removeEventListener(SHOW_NOTIFICATION_DEVICES, show);
  }, [actions]);

  const activate = async () => {
    setBusy(true);
    setMessage('');
    try {
      const permission = await pushTurnOn();
      await refresh({ name: name.trim() || t(`devices.${kind}`), kind });
      if (permission !== 'on') setMessage(t('devices.permission'));
    } catch {
      setMessage(t('devices.permission'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await rpc('push.device.remove', { id }, null);
      await refresh();
    } catch {
      setMessage(t('agency.alerts.deviceFailed'));
    } finally {
      setBusy(false);
    }
  };

  const controls = <>
    {state === 'ready' && <button type="button" className="btn" onClick={() => setOpen(!open)}>
      <Icon name="bell" /> {t('devices.title')}
    </button>}
    {(open || state !== 'ready') && <Card title={t('devices.title')}>
      {state === 'checking' ? <p role="status">{t('devices.checking')}</p> : <>
        {state === 'blocked' && <p>{t('devices.required')}</p>}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label>{t('devices.name')} <input className="in" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>{t('devices.kind')} <select className="in" value={kind} onChange={(event) => setKind(event.target.value === 'phone' ? 'phone' : 'pc')}>
            <option value="phone">{t('devices.phone')}</option><option value="pc">{t('devices.pc')}</option>
          </select></label>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void activate()}>{t('devices.activate')}</button>
          {state === 'blocked' && <button type="button" className="btn" onClick={logout}>{t('shell.logout')}</button>}
          {state === 'ready' && <button type="button" className="btn" onClick={() => {
            void testDevicePush().then((sent) => setMessage(t(sent ? 'agency.alerts.testSent' : 'agency.alerts.deviceFailed')))
              .catch(() => setMessage(t('agency.alerts.deviceFailed')));
          }}>{t('agency.alerts.testDevice')}</button>}
        </div>
        {message && <p role="status">{message}</p>}
        <ul>
          {devices.map((device) => <li key={device.id}>
            <strong>{device.name}</strong> · {t(`devices.${device.kind}`)}
            {device.id === here && <> · {t('devices.current')}</>}
            {' · '}{t(Date.now() - Date.parse(device.lastSeenAt) <= 90_000 ? 'devices.live' : 'devices.offline')}
            {' · '}{t(device.enabled ? 'devices.enabled' : 'devices.disabled')}
            {' · '}<time dateTime={device.lastSeenAt}>{new Date(device.lastSeenAt).toLocaleString()}</time>
            {' '}<button type="button" className="btn" disabled={busy} onClick={() => void remove(device.id)}>
              {t('devices.remove')}
            </button>
          </li>)}
        </ul>
      </>}
    </Card>}
  </>;
  if (state !== 'ready') return <main className="page" style={{ maxWidth: 680, marginInline: 'auto' }}>{controls}</main>;
  return <>{children}{actions && createPortal(controls, actions)}</>;
}
