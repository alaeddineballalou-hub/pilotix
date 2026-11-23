import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { rpc, type Out } from '../lib/backend';
import { enablePushSubscription, myEndpoint, phoneDevice, pushSupported, testDevicePush } from '../lib/push';
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

export function NotificationDevices({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'checking' | 'inactive' | 'ready'>('checking');
  const [devices, setDevices] = useState<Devices>([]);
  const [here, setHere] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState<Kind>(phoneDevice() ? 'phone' : 'pc');
  const [name, setName] = useState('');
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const initialized = useRef(false);
  const activating = useRef(false);
  const pendingCheck = useRef<Promise<void> | null>(null);
  const check = useRef(0);

  const refresh = useCallback(async (activation?: { name: string; kind: Kind; endpoint: string }) => {
    const request = ++check.current;
    const id = deviceId();
    const endpoint = activation?.endpoint ?? (pushSupported() && Notification.permission === 'granted' ? await myEndpoint() : null);
    const setup = activation && { name: activation.name, kind: activation.kind };
    const result = await rpc('push.device.checkIn', { id, endpoint, setup }, null);
    const ready = result.registered && result.enabled;
    if (request === check.current) {
      setHere(id);
      setState(ready ? 'ready' : 'inactive');
    }
    // Device-list availability is independent of notification activation.
    void rpc('push.devices', {}, null).then((list) => {
      if (request !== check.current) return;
      setDevices(list);
      if (!initialized.current) {
        const current = list.find((device) => device.id === id);
        if (current) {
          initialized.current = true;
          setName(current.name);
          setKind(current.kind === 'phone' ? 'phone' : 'pc');
        }
      }
    }).catch(() => {});
    return ready;
  }, []);

  useEffect(() => {
    const checkDevice = () => {
      if (document.visibilityState !== 'visible' || activating.current || pendingCheck.current) return;
      pendingCheck.current = refresh().then(() => {}, () => {
        if (!activating.current) setState((previous) => previous === 'ready' ? previous : 'inactive');
      }).finally(() => { pendingCheck.current = null; });
    };
    checkDevice();
    const timer = window.setInterval(checkDevice, 30_000);
    document.addEventListener('visibilitychange', checkDevice);
    window.addEventListener('focus', checkDevice);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', checkDevice);
      window.removeEventListener('focus', checkDevice);
    };
  }, [refresh]);
  useEffect(() => {
    setActions(document.getElementById('notification-device-actions'));
  }, []);
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
    const deviceName = name.trim();
    if (activating.current || !deviceName) return;
    activating.current = true;
    ++check.current;
    setBusy(true);
    setMessage('');
    try {
      const connection = await enablePushSubscription(true);
      if (connection.state !== 'on') {
        setMessage(t(connection.state === 'unsupported' ? 'devices.unsupported' : 'devices.permission'));
        return;
      }
      // Finish any check started before Chrome opened the permission prompt.
      await pendingCheck.current;
      initialized.current = true;
      const ready = await refresh({ name: deviceName, kind, endpoint: connection.endpoint });
      if (!ready) setMessage(t('devices.registrationFailed'));
    } catch {
      setMessage(t('devices.registrationFailed'));
    } finally {
      activating.current = false;
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
    <button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="bell" /> {t('devices.title')}
    </button>
    {open && <Card title={t('devices.title')}>
      {state === 'checking' ? <p role="status">{t('devices.checking')}</p> : <>
        {state === 'inactive' && <p>{t('devices.setupHint')}</p>}
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label>{t('devices.name')} <input className="in" maxLength={80} required autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>{t('devices.kind')} <select className="in" value={kind} onChange={(event) => setKind(event.target.value === 'phone' ? 'phone' : 'pc')}>
            <option value="phone">{t('devices.phone')}</option><option value="pc">{t('devices.pc')}</option>
          </select></label>
          <button type="button" className="btn primary" disabled={busy || !name.trim()} onClick={() => void activate()}>{t('devices.activate')}</button>
          {state === 'ready' && <button type="button" className="btn" onClick={() => {
            void testDevicePush().then((sent) => setMessage(t(sent ? 'agency.alerts.testSent' : 'agency.alerts.deviceFailed')))
              .catch(() => setMessage(t('agency.alerts.deviceFailed')));
          }}>{t('devices.sendTest')}</button>}
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
  return <>{children}{actions && createPortal(controls, actions)}</>;
}
