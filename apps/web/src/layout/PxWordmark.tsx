import type { CSSProperties } from 'react';
import { DOTS, GLYPHS, SMILE, X_STROKE, X_WIDTH } from './PxLogo';

/*
 * The big Pilotix wordmark of the login, lock, reset-password, accounts and platform pages.
 * It enters "eyes first" every time the page loads: the two orange i-dots pop in and blink,
 * the smile draws under them (a face), then the letters fill in. Styles: .px-wm in pilotix.css.
 */
const v = (i: number) => ({ ['--i' as string]: i }) as CSSProperties;

export function BrandBig({ className = '' }: { className?: string }) {
  return (
    <span className={`brand-big px-bb ${className}`} role="img" aria-label="Pilotix">
      <svg className="px-wm" viewBox="0 18 339 140" aria-hidden="true" focusable="false">
        {GLYPHS.map((g, i) => (
          <path key={i} className="px-wm-gl" style={v(i)} d={g.d} />
        ))}
        <path className="px-wm-gl px-wm-x" style={v(GLYPHS.length)} d={X_STROKE} strokeWidth={X_WIDTH} />
        <path className="px-wm-smile" d={SMILE} />
        {DOTS.map(([cx, cy, r], i) => (
          <circle key={i} className="px-wm-dot" style={v(i)} cx={cx} cy={cy} r={r} />
        ))}
      </svg>
    </span>
  );
}
