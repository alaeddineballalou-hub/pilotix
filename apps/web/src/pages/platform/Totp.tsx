// « Application d'authentification » (the control room's account menu): add it (its QR code, then its first code) or
// remove it (with a code it shows). On, the login asks its code instead of the e-mailed one (packages/core/src/platform/totp.ts).
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePAction, usePRpc } from '../../lib/platform';
import { Field, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';

/** The secret as a QR code (ZXing, loaded on first use; the label printer's encoder), black squares on white. */
function QrCode({ text }: { text: string }) {
  const [d, setD] = useState<{ path: string; size: number } | null>(null);
  useEffect(() => {
    let live = true;
    void import('@zxing/library').then((z) => {
      const m = z.QRCodeEncoder.encode(text, z.QRCodeDecoderErrorCorrectionLevel.M).getMatrix();
      const n = m.getWidth();
      const q = 4;
      let path = '';
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m.get(x, y) === 1) path += `M${x + q} ${y + q}h1v1h-1z`;
      if (live) setD({ path, size: n + 2 * q });
    });
    return () => {
      live = false;
    };
  }, [text]);
  if (!d) return <Loading />;
  return (
    <svg viewBox={`0 0 ${d.size} ${d.size}`} width={200} height={200} shapeRendering="crispEdges" role="img" aria-label="QR" style={{ background: '#fff', borderRadius: 8, display: 'block', margin: '0 auto' }}>
      <path d={d.path} fill="#000" />
    </svg>
  );
}

export function TotpModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const K = 'platform.totp.';
  const state = usePRpc('p.me.totp', {});
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const start = usePAction('p.me.totp.start', { onDone: (r) => (setSetup(r), setCode('')) });
  const confirm = usePAction('p.me.totp.confirm', { success: t(K + 'added'), onDone: onClose });
  const off = usePAction('p.me.totp.off', { success: t(K + 'removed'), onDone: onClose });
  const on = !!state.data?.on;
  const busy = start.isPending || confirm.isPending || off.isPending;
  const codeField = (
    <Field label={t(K + 'code')}>
      <input autoFocus inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="pp-code" />
    </Field>
  );
  let body;
  let action = null;
  if (state.isLoading) body = <Loading />;
  else if (on) {
    body = (
      <>
        <p>{t(K + 'onText')}</p>
        {codeField}
      </>
    );
    action = (
      <button className="btn danger" disabled={code.length !== 6 || busy} onClick={() => off.mutate({ code })}>
        {t(K + 'remove')}
      </button>
    );
  } else if (setup) {
    body = (
      <>
        <p>{t(K + 'scan')}</p>
        <QrCode text={setup.uri} />
        <details>
          <summary>{t(K + 'manual')}</summary>
          <code dir="ltr" style={{ display: 'block', wordBreak: 'break-all', userSelect: 'all', padding: '8px 0' }}>
            {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
          </code>
        </details>
        {codeField}
      </>
    );
    action = (
      <button className="btn primary" disabled={code.length !== 6 || busy} onClick={() => confirm.mutate({ code })}>
        {t(K + 'confirm')}
      </button>
    );
  } else {
    body = <p>{t(K + 'offText')}</p>;
    action = (
      <button className="btn primary" disabled={busy} onClick={() => start.mutate({})}>
        {t(K + 'add')}
      </button>
    );
  }
  return (
    <Modal
      title={t(K + 'title')}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          {action}
        </>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>{body}</div>
    </Modal>
  );
}
