// « Changer le propriétaire » (Boutiques › a shop, Agences, Marketers): the shop moves to another e-mail. The owner
// before loses every access at once (core platform/owner.ts); nothing is sent: the new owner enters with Google.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePAction } from '../../lib/platform';
import { useIsPhone } from '../../lib/useMedia';
import { Field, Icon } from '../../ui/kit';
import { Modal } from '../../ui/modal';

export interface OwnerTarget {
  id: number;
  name: string;
  kind: 'store' | 'agency' | 'marketer';
  owner: { name: string | null; email: string | null; phone: string | null };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The small « Changer » button next to an owner (a manager of Pilotix's team only). */
export function OwnerButton({ onClick, long }: { onClick: () => void; long?: boolean }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="btn small pp-owner-btn" onClick={onClick}>
      <Icon name="swap" /> {t(long ? 'platform.newOwner.go' : 'platform.newOwner.open')}
    </button>
  );
}

export function OwnerModal({ s, onClose }: { s: OwnerTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const phoneScreen = useIsPhone();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const go = usePAction('p.shops.setOwner', { success: (r) => t('platform.newOwner.done', { name: s.name, email: r.to }), onDone: onClose });
  const clean = email.trim().toLowerCase();
  const same = !!clean && clean === (s.owner.email ?? '').trim().toLowerCase();
  const ok = EMAIL.test(clean) && !same;
  const who = s.owner.name || s.owner.email;
  const send = () => ok && !go.isPending && go.mutate({ id: s.id, email: clean, name: name.trim() || null, phone: phone.trim() || null });
  return (
    <Modal
      sheet
      title={t('platform.newOwner.title', { name: s.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn danger" disabled={!ok || go.isPending} onClick={send}>
            <Icon name="swap" /> {t(phoneScreen ? 'platform.newOwner.open' : 'platform.newOwner.go')}
          </button>
        </>
      }
    >
      <dl className="pp-creds">
        <dt>{t('platform.newOwner.now')}</dt>
        <dd>
          {who ? (
            <>
              {s.owner.name && <b>{s.owner.name}</b>}
              {s.owner.email && <span className="ltr pp-owner-now">{s.owner.email}</span>}
              {s.owner.phone && <span className="ltr pp-owner-now">{s.owner.phone}</span>}
            </>
          ) : (
            <span className="muted">{t('platform.newOwner.nobody')}</span>
          )}
        </dd>
      </dl>
      <form
        className="pp-form"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="grid2">
          <Field label={t('platform.newOwner.email')} hint={same ? <span className="pp-bad">{t('platform.newOwner.same')}</span> : undefined} wide>
            <input type="email" dir="ltr" required autoComplete="off" maxLength={200} value={email} placeholder="nom@gmail.com" onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t('platform.newOwner.name')} hint={t('platform.newOwner.nameHint')}>
            <input maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t('platform.newOwner.phone')}>
            <input type="tel" dir="ltr" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        {/* Enter in a field sends it too */}
        <button type="submit" hidden />
      </form>
      {who && (
        <p className="pp-loss">
          <Icon name="alert" />
          <span>{t(s.kind === 'store' ? 'platform.newOwner.lossStore' : 'platform.newOwner.lossPartner', { who, shop: s.name })}</span>
        </p>
      )}
      <p className="pp-owner-google small">
        <Icon name="key" />
        <span>{t('platform.newOwner.google', { email: ok ? clean : t('platform.newOwner.theEmail') })}</span>
      </p>
    </Modal>
  );
}
