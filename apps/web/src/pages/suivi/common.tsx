import type { Order } from '@pilotix/shared';
import { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { da, wilaya } from '../../lib/format';
import { Modal } from '../../ui/modal';

export const productsText = (o: Pick<Order, 'items'>) => o.items.map((i) => `${i.qty} × ${i.name}${i.variantTitle ? ` ${i.variantTitle}` : ''}`).join(' + ') || '—';

/** Whole days since a date (null when unknown). */
export const daysSince = (iso: string | null | undefined) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)) : null);

/** 0661… / +213661… / 00213661… → 213661… */
export const intl = (p: string | null | undefined) => {
  const d = String(p || '').replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d.slice(1);
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return `213${d.slice(1)}`;
  return d;
};
export const waLink = (phone: string | null | undefined, text: string) => `https://wa.me/${intl(phone)}?text=${encodeURIComponent(text)}`;

export interface ClaimCompany {
  id: number;
  name: string;
  kind: string;
  wa: string | null;
  email: string | null;
  phone: string | null;
  portal: string | null;
}

/** The message sent to a courier or a livreur (same lines as the original app). */
export function claimText(t: (k: string, o?: Record<string, unknown>) => string, x: { ref: string; reason: string; details?: string | null }, o: Order | null, to: string, shop: string, again = false) {
  const st = o?.followStatus ? t(`status.follow.${o.followStatus}`) : '';
  const wl = o ? [wilaya(o.wilayaId), o.commune].filter(Boolean).join(' / ') : '';
  return [
    (again ? t('suivi.rec.text.again') : '') + t('suivi.rec.text.hello', { name: to }),
    t('suivi.rec.text.title', { ref: x.ref, shop }),
    '',
    t('suivi.rec.text.tracking', { v: o?.tracking || '—' }),
    t('suivi.rec.text.ref', { v: o?.ref || '—' }),
    t('suivi.rec.text.client', { name: o?.customerName || '—', phone: o?.phone || '—' }),
    wl ? t('suivi.rec.text.wilaya', { v: wl }) : null,
    st ? t('suivi.rec.text.status', { v: st }) : null,
    '',
    t('suivi.rec.text.problem', { v: t(`suivi.rec.reasons.${x.reason}`) }),
    x.details ? x.details : null,
    '',
    again ? t('suivi.rec.text.thanksAgain') : t('suivi.rec.text.thanks'),
    shop,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** Text for ZR / the livreur after a swap (all in one, for WhatsApp). */
export function swapText(t: (k: string, o?: Record<string, unknown>) => string, from: Order, to: Order, oldTracking: string | null, oldTotal: number) {
  const addr = [to.address, to.commune, wilaya(to.wilayaId)].filter(Boolean).join(', ');
  return [
    t('suivi.sheet.text.head', { tracking: oldTracking || '—' }),
    t('suivi.sheet.text.client', { v: to.customerName }),
    t('suivi.sheet.text.phone', { v: to.phone + (to.phone2 ? ` / ${to.phone2}` : '') }),
    t('suivi.sheet.text.address', { v: addr }) + (to.isStopdesk ? t('suivi.sheet.text.desk') : ''),
    t('suivi.sheet.text.amount', { v: da(to.total) }) + (to.total !== oldTotal ? t('suivi.sheet.text.instead', { v: da(oldTotal) }) : ''),
    t('suivi.sheet.text.order', { ref: to.ref, old: from.ref }),
  ].join('\n');
}

/** Small yes / no step inside a modal (no window.confirm). */
export function ConfirmModal({ title, text, ok, danger, onOk, onClose, busy }: { title: ReactNode; text: ReactNode; ok: string; danger?: boolean; onOk: () => void; onClose: () => void; busy?: boolean }) {
  const { t } = useTranslation();
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={onOk}>
            {ok}
          </button>
        </>
      }
    >
      <p>{text}</p>
    </Modal>
  );
}
