// Co-Pilot's icon: a shield with the Pilotix face that lives. Again and again: 3 s checking (orange, eyes left then
// right, three little dots), then 4 s the shop's mood — green with the Pilotix wink and smile (all is well), yellow -_-
// (something to watch), red and angry (something urgent). With "reduce motion", it only changes colour.
import type { DoctorItem } from '@pilotix/shared';
import { useEffect, useState } from 'react';

export type CopilotMood = 'ok' | 'warn' | 'bad';

/** The mood of a Co-Pilot report: any urgent item → bad, else any item to watch → warn, else ok. */
export const copilotMood = (items: readonly DoctorItem[]): CopilotMood => (items.some((i) => i.level === 'bad') ? 'bad' : items.some((i) => i.level === 'warn') ? 'warn' : 'ok');

const CHECK_MS = 3000;
const SHOW_MS = 4000;

/** The Pilotix logo's smile: a crescent, its right end a little higher (upside down = a frown). */
function smile(cx: number, cy: number, w: number, frown = false) {
  const x1 = cx - w / 2;
  const y1 = cy;
  const x2 = cx + w / 2;
  const y2 = cy - w * 0.1;
  const s = frown ? -1 : 1;
  const d1 = w * 0.34 * s;
  const d2 = w * 0.14 * s;
  const f = (v: number) => v.toFixed(2);
  return `M${f(x1)},${f(y1)} C${f(x1 + w * 0.3)},${f(y1 + d1)} ${f(x2 - w * 0.25)},${f(y2 + d1 * 0.95)} ${f(x2)},${f(y2)} C${f(x2 - w * 0.25)},${f(y2 + d2 * 1.1)} ${f(x1 + w * 0.3)},${f(y1 + d2 * 0.75)} ${f(x1)},${f(y1)} Z`;
}
const SMILE = smile(12, 13.9, 7.8);
const FROWN = smile(12, 16.1, 6.4, true);

/**
 * `mood`: the shop's mood (null while the first check is still running: it only checks).
 * `size`: in pixels. `label`: what a screen reader says.
 */
export function CopilotIcon({ mood, size = 34, label = 'Co-Pilot' }: { mood: CopilotMood | null; size?: number; label?: string }) {
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    if (!mood) {
      setChecking(true);
      return;
    }
    let t: ReturnType<typeof setTimeout>;
    const loop = (check: boolean) => {
      setChecking(check);
      t = setTimeout(() => loop(!check), check ? CHECK_MS : SHOW_MS);
    };
    loop(true);
    return () => clearTimeout(t);
  }, [mood]);
  const shown = checking || !mood ? 'scan' : mood;
  return (
    <span className="cp-ic" data-mood={shown} style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path className="cp-shield" d="M12 2.5l8 3v6c0 5-3.5 8.6-8 10-4.5-1.4-8-5-8-10v-6z" />
        <g className="cp-think">
          <circle cx="17.6" cy="1.2" r=".75" />
          <circle cx="19.6" cy=".2" r=".9" />
          <circle cx="21.9" cy="-.9" r="1.05" />
        </g>
        <g className="cp-f cp-f-scan">
          <g className="cp-eyes">
            <circle cx="9.3" cy="10.3" r="1.45" />
            <circle cx="14.7" cy="10.3" r="1.45" />
          </g>
          <path className="cp-line" d="M10 14.6h4" strokeWidth="1.8" />
        </g>
        <g className="cp-f cp-f-ok">
          <circle className="cp-blink" cx="9.3" cy="10.3" r="1.45" />
          <path className="cp-line" d="M13.2 10.9q1.4-1.7 2.8 0" strokeWidth="1.8" />
          <path d={SMILE} />
        </g>
        <g className="cp-f cp-f-warn">
          <path className="cp-line" d="M8 10.4h2.7M13.3 10.4H16" strokeWidth="2" />
          <path className="cp-line" d="M10.2 15h3.6" strokeWidth="1.8" />
        </g>
        <g className="cp-f cp-f-bad">
          <path className="cp-line" d="M7.6 8.2l3 1.4M16.4 8.2l-3 1.4" strokeWidth="1.7" />
          <circle cx="9.4" cy="11.2" r="1.25" />
          <circle cx="14.6" cy="11.2" r="1.25" />
          <path d={FROWN} />
        </g>
      </svg>
    </span>
  );
}
