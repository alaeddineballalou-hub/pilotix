import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { copyText } from './kit';

/** A tracking number you can press: it is copied and a small "Copié" bubble shows for a moment. */
export function CopyCode({ code, small }: { code: string; small?: boolean }) {
  const { t } = useTranslation();
  const [done, setDone] = useState(false);
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
          if (await copyText(code)) {
            setDone(true);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setDone(false), 1300);
          }
        }}
      >
        {code}
      </button>
      {done && (
        <span className="px-copied" role="status">
          {t('common.copied')}
        </span>
      )}
    </Tag>
  );
}
