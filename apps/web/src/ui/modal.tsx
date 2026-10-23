import { ReactNode, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useIsPhone } from '../lib/useMedia';
import { Icon } from './kit';
import { Sheet } from './Sheet';

type ModalProps = { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; className?: string };

/**
 * A dialog in the style of the original app (.modal). Closes with Escape, the × or a click outside.
 * `wide` for big forms (order card 960px). `sheet`: on a phone it rises from the bottom instead (ui/Sheet), its
 * buttons at the thumb.
 */
export function Modal({ sheet, ...p }: ModalProps & { sheet?: boolean }) {
  const phone = useIsPhone();
  if (sheet && phone)
    return (
      <Sheet title={p.title} onClose={p.onClose} foot={p.footer} className={`pxk-modal ${p.className ?? ''}`}>
        {p.children}
      </Sheet>
    );
  return <ModalBox {...p} />;
}

function ModalBox({ title, onClose, children, footer, wide, className = '' }: ModalProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', k);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()} style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgb(15 26 46 / .45)', display: 'grid', placeItems: 'center', padding: 'max(12px, env(safe-area-inset-top, 0px)) max(12px, env(safe-area-inset-right, 0px)) max(12px, env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px))' }}>
      <div ref={ref} className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" style={{ maxHeight: '100%', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body" style={{ overflowY: 'auto' }}>
          {children}
        </div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
