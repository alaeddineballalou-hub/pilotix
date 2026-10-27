import { useEffect, useId, useState, type CSSProperties } from 'react';

/*
 * The Pilotix logo in the sidebar (Oct 2026 brand: "Grand sourire" wordmark + winking app icon).
 * Open: the wordmark. Folded: the icon. The change is the "masked type" motion, done in CSS only
 * (styles: .px-lg in pilotix.css): the letters sink one by one behind a clean line on the baseline,
 * then the tile rises from its own bottom edge, the orange wave fills it and the face appears.
 * Shapes are the brand kit's real outlines (Inter Display ExtraBold turned into paths), so no font is needed.
 */
const GLYPHS = ["M24.6875 120.41015625H41.484375V92.333984375H41.6796875C44.365234375 98.046875 49.443359375 101.123046875 56.23046875 101.123046875C69.755859375 101.123046875 78.49609375 90.4296875 78.49609375 74.12109375C78.49609375 58.349609375 69.4140625 47.314453125 56.376953125 47.314453125C49.6875 47.314453125 44.609375 49.951171875 41.533203125 55.17578125H41.2890625V48.4375H24.6875ZM51.494140625 87.6953125C45.146484375 87.6953125 40.80078125 82.373046875 40.80078125 74.12109375C40.80078125 65.966796875 45.146484375 60.693359375 51.494140625 60.693359375C57.6953125 60.693359375 61.50390625 65.72265625 61.50390625 74.12109375C61.50390625 82.6171875 57.6953125 87.6953125 51.494140625 87.6953125Z", "M83.771484375 100.0H100.568359375V48.4375H83.771484375Z", "M124.740234375 27.24609375H107.943359375V100.0H124.740234375Z", "M157.115234375 101.171875C173.27734375 101.171875 184.21484375 90.576171875 184.21484375 74.21875C184.21484375 57.958984375 173.27734375 47.265625 157.115234375 47.265625C140.953125 47.265625 129.966796875 57.958984375 129.966796875 74.21875C129.966796875 90.576171875 140.953125 101.171875 157.115234375 101.171875ZM157.115234375 87.79296875C151.20703125 87.79296875 147.0078125 82.958984375 147.0078125 74.21875C147.0078125 65.52734375 151.255859375 60.64453125 157.115234375 60.64453125C162.974609375 60.64453125 167.22265625 65.52734375 167.22265625 74.21875C167.22265625 82.958984375 162.974609375 87.79296875 157.115234375 87.79296875Z", "M221.912109375 48.4375H211.31640625V34.375H194.470703125V48.4375H185.681640625V61.42578125H194.470703125V85.498046875C194.470703125 95.5078125 200.037109375 100.0 212.390625 100.0H221.912109375V87.01171875H216.1015625C212.341796875 87.01171875 211.31640625 85.986328125 211.31640625 82.666015625V61.42578125H221.912109375Z", "M226.650390625 100.0H243.447265625V48.4375H226.650390625Z"];
const X_STROKE = "M254.42,55.79 L292.73,92.64";
const X_WIDTH = 14.71;
const SMILE = "M64.50,110.00 C138.50,160.00 226.33,120.00 314.82,34.44 C226.33,104.04 138.50,144.04 64.50,110.00 Z";
const DOTS: [number, number, number][] = [[92.17, 32.3, 10.41], [235.05, 32.3, 10.41]];
const WAVE = "M0,250 C120,200 200,320 300,280 C380,248 440,230 512,250 V512 H0 Z";
const MOUTH = "M146.00,296.00 C217.40,372.00 324.50,364.40 384.00,272.00 C324.50,329.82 217.40,337.42 146.00,296.00 Z";

const v = (i: number) => ({ ['--i' as string]: i }) as CSSProperties;

export function PxLogo() {
  const id = useId().replace(/:/g, '');
  // transitions switch on after the first paint, so a sidebar that was folded last time does not animate on load
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const word = 'translate(2 2) scale(0.3) translate(0 -18)';
  return (
    <span className={`px-lg ${ready ? 'px-lg-ready' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 112 46" width="112" height="46" focusable="false">
        <defs>
          {/* the clean cut line: everything of the wordmark below it is hidden (p's tail included) */}
          <clipPath id={`${id}c`}>
            <rect x="-40" y="-40" width="460" height="166" />
          </clipPath>
          <clipPath id={`${id}t`}>
            <rect width="512" height="512" rx="112" />
          </clipPath>
        </defs>
        <g transform={word} clipPath={`url(#${id}c)`}>
          {GLYPHS.map((d, i) => (
            <path key={i} className="px-lg-gl" style={v(i)} d={d} />
          ))}
          <path className="px-lg-gl px-lg-x" style={v(GLYPHS.length)} d={X_STROKE} strokeWidth={X_WIDTH} />
          {DOTS.map(([cx, cy, r], i) => (
            <circle key={i} className="px-lg-dot" style={v(i)} cx={cx} cy={cy} r={r} />
          ))}
        </g>
        <g transform={word}>
          <path className="px-lg-smile" d={SMILE} />
        </g>
        <g transform="translate(0 5) scale(0.0703125)" clipPath={`url(#${id}t)`}>
          <g className="px-lg-tile">
            <rect className="px-lg-ground" width="512" height="512" />
            <g className="px-lg-wave">
              <path d={WAVE} />
              <rect className="px-lg-mark" x="-10" y="214" width="532" height="14" />
              <rect className="px-lg-mark" x="456" y="200" width="42" height="42" rx="6" />
            </g>
            <g className="px-lg-face">
              <path className="px-lg-mouth" d={MOUTH} />
              <circle className="px-lg-eye" cx="186" cy="186" r="40" />
              <path className="px-lg-wink" d="M290,186 H364" />
            </g>
          </g>
        </g>
      </svg>
    </span>
  );
}
