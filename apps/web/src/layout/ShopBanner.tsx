// What a shop sees of its Pilotix subscription (a multi-shop server): Pilotix's message, the trial days left, the
// renewal reminder, the grace period, the plan's orders per month — and how to pay. Nothing on a single-shop server.
import type { Session, ShopInfo } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dateOnly } from '../lib/format';
import { store } from '../lib/store';
import { Icon } from '../ui/kit';
import { Modal } from '../ui/modal';

const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
};

/** WhatsApp link to Pilotix with a ready message (wa.me wants digits only, with the country code). */
export function waLink(phone: string, text: string): string {
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = `213${d.slice(1)}`;
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

/** How to pay Pilotix: the details written in the control room, WhatsApp and call buttons. */
export function PayInfo({ shop }: { shop: ShopInfo }) {
  const { t } = useTranslation();
  const p = shop.payment;
  if (!p) return <p className="muted">{t('shop.noPay')}</p>;
  const wa = p.whatsapp || p.phone;
  return (
    <div className="px-pay">
      {shop.plan && shop.planPrice !== null && <p className="px-pay-plan">{t('shop.payPlan', { plan: shop.plan, price: shop.planPrice.toLocaleString('fr-DZ') })}</p>}
      {shop.plan && shop.planPriceYear ? <p className="px-pay-plan">{t('shop.payPlanYear', { price: shop.planPriceYear.toLocaleString('fr-DZ') })}</p> : null}
      {p.text.trim() && (
        <>
          <h4>{t('shop.payHow')}</h4>
          <pre className="px-pay-text">{p.text.trim()}</pre>
        </>
      )}
      <p className="small muted">{t('shop.payThen')}</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {wa && (
          <a className="btn primary" href={waLink(wa, t('shop.payWaText', { shop: shop.name, slug: shop.slug }))} target="_blank" rel="noreferrer">
            <Icon name="chat" /> {t('shop.payWa')}
          </a>
        )}
        {p.phone && (
          <a className="btn" href={`tel:${p.phone.replace(/[^\d+]/g, '')}`}>
            <Icon name="phone" /> {t('shop.payCall')} <span className="ltr">{p.phone}</span>
          </a>
        )}
      </div>
    </div>
  );
}

export function PayModal({ shop, onClose }: { shop: ShopInfo; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal title={t('shop.payTitle')} onClose={onClose}>
      <PayInfo shop={shop} />
    </Modal>
  );
}

export function ShopBanner({ session }: { session: Session }) {
  const { t } = useTranslation();
  const shop = session.shop;
  const [pay, setPay] = useState(false);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  if (!shop) return null;
  const today = new Date().toISOString().slice(0, 10);
  const closed = (k: string) => hidden[k] || store.get(`banner-${k}`) === today;
  const close = (k: string) => {
    store.set(`banner-${k}`, today);
    setHidden((h) => ({ ...h, [k]: true }));
  };
  const admin = session.isAdmin;
  const n = shop.daysLeft ?? 0;
  const end = shop.state === 'trial' ? shop.trialEndsAt : shop.paidUntil;
  const out: JSX.Element[] = [];

  if (shop.demo)
    out.push(
      <div key="demo" className="px-ban px-ban-info" role="status">
        <Icon name="sparkles" />
        <span className="grow">{t('shop.demo')}</span>
      </div>,
    );
  if (shop.notice && !closed(`n${hash(shop.notice.text)}`)) {
    const k = `n${hash(shop.notice.text)}`;
    out.push(
      <div key="notice" className={`px-ban ${shop.notice.tone === 'warn' ? 'px-ban-warn' : 'px-ban-info'}`} role="status">
        <Icon name="megaphone" />
        <span className="grow">{shop.notice.text}</span>
        <button type="button" className="px-ban-x" aria-label={t('shop.hide')} title={t('shop.hide')} onClick={() => close(k)}>
          ×
        </button>
      </div>,
    );
  }
  if (admin && !shop.demo) {
    // the plan's orders per month: still taken (no customer lost), the owner sees it's time for a bigger plan
    const max = shop.maxOrdersMonth;
    const done = shop.ordersMonth ?? 0;
    if (max && done >= Math.ceil(max * 0.8) && !closed(`orders${done >= max ? 'x' : ''}`))
      out.push(
        <div key="orders" className={`px-ban ${done >= max ? 'px-ban-bad' : 'px-ban-warn'}`} role="status">
          <Icon name="alert" />
          <span className="grow">
            <b>{done >= max ? t('shop.ordersOver', { done, max }) : t('shop.ordersNear', { done, max })}</b> · {t('shop.ordersKeep')}
          </span>
          {shop.payment && (
            <button type="button" className="btn small primary" onClick={() => setPay(true)}>
              {t('shop.upgrade')}
            </button>
          )}
          <button type="button" className="px-ban-x" aria-label={t('shop.hide')} title={t('shop.hide')} onClick={() => close(`orders${done >= max ? 'x' : ''}`)}>
            ×
          </button>
        </div>,
      );
    if (shop.state === 'trial' && !closed('trial'))
      out.push(
        <div key="trial" className={`px-ban ${n <= 3 ? 'px-ban-warn' : 'px-ban-info'}`} role="status">
          <Icon name="clock" />
          <span className="grow">
            <b>{t('shop.trial', { count: n })}</b>
            {shop.plan ? ` · ${t('shop.trialPlan', { plan: shop.plan })}` : ''}
            {end ? ` · ${t('shop.until', { date: dateOnly(end) })}` : ''}
          </span>
          {shop.payment && (
            <button type="button" className="btn small primary" onClick={() => setPay(true)}>
              {t('shop.activate')}
            </button>
          )}
          {n > 3 && (
            <button type="button" className="px-ban-x" aria-label={t('shop.hide')} title={t('shop.hide')} onClick={() => close('trial')}>
              ×
            </button>
          )}
        </div>,
      );
    if (shop.state === 'active' && shop.daysLeft !== null && n <= 7)
      out.push(
        <div key="renew" className="px-ban px-ban-warn" role="status">
          <Icon name="clock" />
          <span className="grow">
            <b>{t('shop.renew', { count: n })}</b>
            {end ? ` · ${t('shop.until', { date: dateOnly(end) })}` : ''}
          </span>
          {shop.payment && (
            <button type="button" className="btn small primary" onClick={() => setPay(true)}>
              {t('shop.renewBtn')}
            </button>
          )}
        </div>,
      );
    if (shop.state === 'grace')
      out.push(
        <div key="grace" className="px-ban px-ban-bad" role="alert">
          <Icon name="alert" />
          <span className="grow">
            <b>{t('shop.grace', { count: n })}</b>
          </span>
          <button type="button" className="btn small primary" onClick={() => setPay(true)}>
            {t('shop.pay')}
          </button>
        </div>,
      );
  }
  if (!out.length && !pay) return null;
  return (
    <>
      {out.length > 0 && <div className="px-bans">{out}</div>}
      {pay && <PayModal shop={shop} onClose={() => setPay(false)} />}
    </>
  );
}
