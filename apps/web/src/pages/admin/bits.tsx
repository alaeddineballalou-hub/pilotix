// Small pieces shared by the admin pages (same markup as the original: .bjp-switch, .bjp-pill, .bjp-ib).
import { WILAYAS } from '@pilotix/shared';
import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { wilaya } from '../../lib/format';
import { Icon } from '../../ui/kit';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="bjp-switch" onClick={(e) => e.stopPropagation()}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

/** A button that asks "are you sure?" in place (no window.confirm). */
export function ConfirmButton({ children, question, onConfirm, className = 'btn small', disabled }: { children: ReactNode; question: string; onConfirm: () => void; className?: string; disabled?: boolean }) {
  const { t } = useTranslation();
  const [ask, setAsk] = useState(false);
  if (!ask)
    return (
      <button type="button" className={className} disabled={disabled} onClick={() => setAsk(true)}>
        {children}
      </button>
    );
  return (
    <span className="row" role="group" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      <span className="small">{question}</span>
      <button
        type="button"
        className="btn small danger"
        onClick={() => {
          setAsk(false);
          onConfirm();
        }}
      >
        {t('admin.confirmYes')}
      </button>
      <button type="button" className="btn small ghost" onClick={() => setAsk(false)}>
        {t('admin.cancel')}
      </button>
    </span>
  );
}

export const IconBtn = ({ kind, title, onClick, disabled }: { kind: 'e' | 'd' | 's'; title: string; onClick: () => void; disabled?: boolean }) => (
  <button type="button" className={`bjp-ib bjp-ib-${kind}`} title={title} aria-label={title} disabled={disabled} onClick={(e) => (e.stopPropagation(), onClick())}>
    {kind === 'd' ? (
      <span className="bji" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
        </svg>
      </span>
    ) : (
      <Icon name={kind === 'e' ? 'pencil' : 'refresh'} />
    )}
  </button>
);

export function WilayaOptions() {
  return (
    <>
      {WILAYAS.map((_, i) => (
        <option key={i + 1} value={i + 1}>
          {wilaya(i + 1)}
        </option>
      ))}
    </>
  );
}

/** Current month as YYYY-MM (Algiers). */
export const thisMonth = () => new Date(Date.now() + 3_600_000).toISOString().slice(0, 7);

/** Whole number from an input (empty → 0). */
export const intOf = (v: string) => Math.max(0, Math.round(Number(v) || 0));
