import { useId } from 'react';
import { MOUTH, WAVE } from './PxLogo';

/*
 * Phone top bar: the winking icon is the menu button. Touched, hovered (mouse) or while the menu is open,
 * the face turns into the grey ☰ button ("morph"): the eye stretches into the top line, the wink into the
 * middle line, the smile flattens into the bottom line, the wave sinks and the tile turns grey.
 * Every bar is two round caps + a middle rectangle moved only with transforms, so it is smooth in every browser.
 * Styles: .px-mf in pilotix.css.
 */
const BARS = ['eye', 'wink', 'low'] as const;

export function PxMenuFace() {
  const id = useId().replace(/:/g, '');
  return (
    <svg className="px-mf" viewBox="0 0 512 512" width="36" height="36" aria-hidden="true" focusable="false">
      <defs>
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
          <rect width="512" height="512" rx="112" fill="#fff" />
        </mask>
      </defs>
      <g mask={`url(#${id}m)`}>
        <rect className="px-mf-bg" width="512" height="512" />
        <path className="px-mf-wave" d={WAVE} />
      </g>
      <path className="px-mf-mouth" d={MOUTH} />
      {BARS.map((b) => (
        <g key={b} className={`px-mf-bar px-mf-${b}`}>
          <rect className="px-mf-r" x="0" y="-0.5" width="1" height="1" />
          <circle className="px-mf-c px-mf-l" r="1" />
          <circle className="px-mf-c px-mf-e" r="1" />
        </g>
      ))}
    </svg>
  );
}
