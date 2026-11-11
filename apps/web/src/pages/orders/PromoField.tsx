// Referral › Code promo on an order (the order screen, Confirmation): the welcome code the customer gives by phone. The
// badge says at once whether it works for these products: ✅ valid (and what it takes off) / ❌ used / ❌ expired /
// ❌ order too small. The server checks it again when the order is saved.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { da } from '../../lib/format';
import { useRpc } from '../../lib/query';
import './promo.css';

export function usePromoCheck(code: string, subtotal: number, orderId?: number) {
  const [typed, setTyped] = useState(code.trim().toUpperCase());
  // checked when the agent stops typing
  useEffect(() => {
    const id = window.setTimeout(() => setTyped(code.trim().toUpperCase()), 350);
    return () => window.clearTimeout(id);
  }, [code]);
  const q = useRpc('promo.check', { code: typed, subtotal: Math.max(0, Math.round(subtotal)), ...(orderId ? { orderId } : {}) }, { enabled: typed.length >= 4 });
  const r = typed.length >= 4 && typed === code.trim().toUpperCase() ? (q.data ?? null) : null;
  return { result: r, discount: r && r.ok ? r.discount : 0, checking: q.isFetching };
}

export function PromoBadge({ result, checking }: { result: ReturnType<typeof usePromoCheck>['result']; checking: boolean }) {
  const { t } = useTranslation();
  if (checking && !result) return <span className="badge t-off">…</span>;
  if (!result) return null;
  if (result.ok) return <span className="badge t-ok">✅ {t('orders.promo.valid', { v: da(result.discount) })}</span>;
  const why = result.reason === 'small' ? t('orders.promo.small', { v: da(result.minOrder ?? 0) }) : t(`orders.promo.${result.reason}`);
  return <span className="badge t-bad">❌ {why}</span>;
}

/** The field and its badge (`check`: usePromoCheck of the same code, kept by the form for its totals). */
export function PromoField({ value, onChange, check, disabled, className = '' }: { value: string; onChange: (v: string) => void; check: ReturnType<typeof usePromoCheck>; disabled?: boolean; className?: string }) {
  const { t } = useTranslation();
  return (
    <span className={`px-promo ${className}`}>
      <input
        className="ltr px-promo-in"
        value={value}
        maxLength={20}
        placeholder="BJ-7K3P"
        aria-label={t('orders.promo.label')}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.toUpperCase().replace(/\s+/g, ''))}
      />
      <PromoBadge result={check.result} checking={check.checking} />
    </span>
  );
}
