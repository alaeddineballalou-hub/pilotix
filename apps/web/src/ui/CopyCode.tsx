import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { copyText } from './kit';

/** A tracking number you can press: it is copied and a small "Copié" bubble shows for a moment. */
export function CopyCode({ code, small }: { code: string; small?: boolean }) {
  const { t } = useTranslation();
  // the bubble is drawn above the page (never cut by a narrow column)
  const [done, setDone] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<number>();
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!code) return <>—</>;
  const Tag = small ? 'small' : 'span';
  return (
    <Tag className="px-copy-wrap">
      <button
        type="button"
        className="px-copy ltr"
        title={t('common.copyCode', { v: code })}
        aria-label={t('common.copyCode', { v: code })}
        onClick={async (e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          if (await copyText(code)) {
            setDone({ x: r.left + r.width / 2, y: r.top });
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setDone(null), 1300);
          }
        }}
      >
        {code}
      </button>
      {done &&
        createPortal(
          <span className="px-copied px-copied-fixed" role="status" style={{ left: done.x, top: done.y }}>
            {t('common.copied')}
          </span>,
          document.body,
        )}
    </Tag>
  );
}
