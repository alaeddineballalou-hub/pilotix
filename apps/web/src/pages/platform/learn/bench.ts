// The learning bench, live: the book's carriage goes round the four stations (the day, the night at 02:30, the morning,
// the test) and each station plays its part. Every number it shows is the engine's own (pilotlearn.ts: the score of a
// chat, the test's verdict), picked in explainers/dellal-learns/build.mjs. Calm, time-based motion: a spring follows the
// carriage, an idle tour loops while nobody touches it, it stops when the bench is off screen and goes still for readers
// who ask for less motion. It writes attributes on the parts, never re-renders.
import { iso, lineOnTop, segment, translateAlong, type Projection, type P3, type Pt } from './iso';

export type BenchArt = {
  dir: 'ltr' | 'rtl';
  width: number;
  height: number;
  P: Projection;
  a0: number;
  stations: number[];
  book: { top: number };
  night: { dial: number[]; top: number; score: number; delivered: number; refused: number; cancelled: number };
  press: { x: number; rest: number; drop: number; hub: number[]; lever: number; up: number; down: number };
  test: { a: { c: number[]; top: number }; b: { c: number[]; top: number }; wheel: number[]; values: { a: number; kept: number; stopped: number }; flag: { low: number; high: number } };
  tokens: { day: number; won: number; lost: number };
  svg: string;
};
/** What the readout says: the step, the lap, the book's version now, a count (chats today, or the test's day) and the verdict. */
export type BenchRead = { step: number; lap: number; v: number; n: number; verdict: 'kept' | 'stopped' | null; a: number; b: number };
export type BenchOpts = { onStep?: (step: number, lap: number) => void; readout?: (r: BenchRead) => string; chats?: number; days?: number };
export type BenchCtl = { go: (step: number) => void; destroy: () => void };

// one lap of the loop, in seconds: a stay at each station, then the ride to the next
const STAY = [3.6, 3.8, 3.6, 4.6];
const RIDE = [1.0, 1.0, 1.0, 1.8];
const START: number[] = [];
let lapLen = 0;
for (let i = 0; i < 4; i++) {
  START.push(lapLen);
  lapLen += STAY[i] + RIDE[i];
}
const LAP = lapLen;
const IDLE = 6; // seconds after a click (or a key) before the tour goes on

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ease = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
/** 0 → 1 between two moments of the lap */
const ramp = (t: number, from: number, to: number) => ease((t - from) / (to - from));

export function mountBench(root: HTMLElement, art: BenchArt, opts: BenchOpts = {}): BenchCtl {
  const P = art.P;
  const svg = root.querySelector('svg') as SVGSVGElement;
  const stage = (root.querySelector('.iso-stage') as HTMLElement | null) ?? root;
  const q = <T extends Element = SVGElement>(sel: string) => svg.querySelector(sel) as T | null;
  const qa = (sel: string) => [...svg.querySelectorAll<SVGElement>(sel)];
  const carriage = q('[data-part="carriage"]');
  const version = q<SVGTextElement>('[data-part="version"]');
  const dayTok = qa('[data-tok]').sort((a, b) => Number(a.dataset.tok) - Number(b.dataset.tok));
  const bubbles = qa('[data-bub]').sort((a, b) => Number(a.dataset.bub) - Number(b.dataset.bub));
  const mast = q('.pl-mast');
  const won = qa('[data-won]').sort((a, b) => Number(a.dataset.won) - Number(b.dataset.won));
  const lost = qa('[data-lost]').sort((a, b) => Number(a.dataset.lost) - Number(b.dataset.lost));
  const glow = q('[data-part="glow"]');
  const bulb = q('[data-part="bulb"]');
  const scoreNeedle = q('[data-part="score-needle"]');
  const stamp = q('[data-part="stamp"]');
  const leverPath = q('[data-part="lever"]');
  const knob = q('[data-part="knob"]');
  const topCard = q('[data-card="3"]');
  const needleA = q('[data-part="needle-a"]');
  const needleB = q('[data-part="needle-b"]');
  const daysHand = q('[data-part="days"]');
  const flag = q('[data-part="flag"]');
  const readout = root.querySelector<HTMLElement>('[data-readout]');
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  // on a phone the whole bench is too small to read: the picture comes closer and follows the book along the rail
  const narrow = window.matchMedia?.('(max-width: 560px)');
  const ZOOM = 1.75;
  const fullBox = `0 0 ${art.width} ${art.height}`;

  // a frame only touches what changed
  const set = (el: Element | null, name: string, value: string) => {
    if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
  };
  const flagOn = (el: Element | null, name: string, on: boolean) => {
    if (!el) return;
    if (on !== el.hasAttribute(name)) el.toggleAttribute(name, on);
  };

  const needleAt = (c: number[], top: number, r: number, v: number, max: number, fromStart: boolean) => {
    const span = (270 * Math.PI) / 180;
    const a = fromStart ? art.a0 - span / 2 + (v / max) * span : art.a0 + (v / max) * (span / 2);
    return lineOnTop([c[0] - Math.sin(a) * 2.6, c[1] + Math.cos(a) * 2.6] as Pt, [c[0] + Math.sin(a) * (r - 3.6), c[1] - Math.cos(a) * (r - 3.6)] as Pt, top + 0.2, P);
  };
  const leverEnd = (deg: number): P3 => {
    const a = (deg * Math.PI) / 180;
    const [hx, hy, hz] = art.press.hub;
    return [art.press.x + hx + 0.6, hy + Math.cos(a) * art.press.lever, hz + Math.sin(a) * art.press.lever];
  };
  const restEnd = leverEnd(art.press.up);

  // ---- the state of the lap at time t (seconds into lap `lap`)
  const keptLap = (lap: number) => lap % 2 === 0; // one lap the new book is kept, the next it is stopped
  const baseV = (lap: number) => 2 + Math.ceil(lap / 2);
  const [d0, n0, m0, t0] = START;
  const STAMP = m0 + 1.0; // the stamp touches the book: the approved lesson is in, the version goes up
  const VERDICT = t0 + 3.0;
  const back = START[3] + STAY[3]; // the ride home: the trays empty, the dials go back to zero
  function stepAt(t: number) {
    for (let i = 3; i >= 0; i--) if (t >= START[i] + STAY[i]) return (i + 1) % 4;
    for (let i = 3; i >= 0; i--) if (t >= START[i]) return i;
    return 0;
  }
  function targetX(t: number) {
    const xs = art.stations;
    for (let i = 0; i < 4; i++) {
      const s = START[i];
      if (t < s + STAY[i]) return xs[i];
      if (t < s + STAY[i] + RIDE[i]) return xs[i] + (xs[(i + 1) % 4] - xs[i]) * ease((t - s - STAY[i]) / RIDE[i]);
    }
    return xs[0];
  }

  // ---- time, the carriage's spring, the tour
  let lap = 0;
  let t = 0;
  let x = art.stations[0];
  let vx = 0;
  let hold: number | null = null; // a step the reader picked: the lap stops at the end of its stay
  let idleAt = 0;
  let frame = 0;
  let prev = 0;
  let visible = false;
  let clock = 0;
  let shownStep = -1;
  let shownLap = -1;
  let said = '';

  function draw() {
    const kept = keptLap(lap);
    const fade = 1 - ramp(t, back, back + RIDE[3] * 0.7); // the ride home clears the stations
    // the carriage and its book (on a phone, the window on the bench follows it)
    set(carriage, 'transform', translateAlong(P, [x, 0, 0]));
    if (narrow?.matches) {
      // a window on the bench, centred between the book and its station; the bench slopes, so it keeps most of the height
      const w = art.width / ZOOM;
      const h = art.height * 0.8;
      const cx = iso([x, -18, 30], P)[0];
      const cy = (iso([x - 14, -52, 106], P)[1] + iso([x, 60, -17], P)[1]) / 2;
      const left = Math.round(Math.min(art.width - w, Math.max(0, cx - w / 2)) * 10) / 10;
      const top = Math.round(Math.min(art.height - h, Math.max(0, cy - h / 2)) * 10) / 10;
      set(svg, 'viewBox', `${left} ${top} ${Math.round(w * 10) / 10} ${Math.round(h * 10) / 10}`);
    } else set(svg, 'viewBox', fullBox);
    let v = baseV(lap);
    if (t >= STAMP) v += 1;
    if (!kept && t >= VERDICT + 0.2) v -= 1;
    if (version && version.textContent !== 'v' + v) version.textContent = 'v' + v;
    // the day: the chat on the screen, the mast, the tray of today's chats
    const dayP = clamp((t - d0 - 0.3) / 2.8);
    const shown = t < back ? dayP * dayTok.length : dayTok.length;
    dayTok.forEach((el, i) => set(el, 'opacity', String(Math.round(clamp(shown - i) * fade * 100) / 100)));
    const lit = t < d0 + STAY[0] ? Math.floor(clamp((t - d0 - 0.2) / 3.0) * (bubbles.length + 0.999)) : -1;
    bubbles.forEach((el, i) => set(el, 'data-tone', lit < 0 ? (t >= back || t < d0 + 0.2 ? 'faint' : 'lo') : i === lit - 1 ? 'hi' : i < lit - 1 ? 'lo' : 'faint'));
    flagOn(mast, 'data-on', t < d0 + STAY[0] && t > d0 + 0.2 && (t - d0) % 0.8 < 0.3);
    // the night: the lamp, the sorted chats, the score
    const lamp = ramp(t, n0, n0 + 0.4) * (1 - ramp(t, n0 + STAY[1], n0 + STAY[1] + 0.5));
    set(glow, 'opacity', String(Math.round(lamp * 100) / 100));
    flagOn(bulb, 'data-on', lamp > 0.5);
    const sort = clamp((t - n0 - 0.5) / 1.9);
    won.forEach((el, i) => set(el, 'opacity', String(Math.round(clamp(sort * won.length - i) * fade * 100) / 100)));
    lost.forEach((el, i) => set(el, 'opacity', String(Math.round(clamp(sort * lost.length - i) * fade * 100) / 100)));
    const score = art.night.score * ramp(t, n0 + 0.6, n0 + 2.8) * fade;
    set(scoreNeedle, 'd', needleAt(art.night.dial, art.night.top, 13, score, 60, false));
    // the morning: the lever comes down, the stamp touches the book, a lesson card leaves the tray
    const press = ramp(t, m0 + 0.4, STAMP) * (1 - ramp(t, STAMP + 0.4, STAMP + 1.2));
    set(stamp, 'transform', translateAlong(P, [0, 0, -art.press.drop * press]));
    const deg = art.press.up + (art.press.down - art.press.up) * press;
    set(leverPath, 'd', segment([art.press.x + art.press.hub[0] + 0.6, art.press.hub[1], art.press.hub[2]], leverEnd(deg), P));
    const end = leverEnd(deg);
    set(knob, 'transform', translateAlong(P, [0, end[1] - restEnd[1], end[2] - restEnd[2]]));
    set(topCard, 'opacity', String(t < STAMP ? 1 : Math.round((t >= back ? ramp(t, back, back + RIDE[3]) : 1 - ramp(t, STAMP, STAMP + 0.35)) * 100) / 100));
    // the test: ten days on the wheel, the two dials, the flag
    const days = 10 * clamp((t - t0 - 0.2) / 2.6) * fade;
    const w = art.test.wheel;
    const wa = art.a0 + (days / 10) * Math.PI * 2;
    set(daysHand, 'd', lineOnTop([w[0], w[1]], [w[0] + Math.sin(wa) * 4, w[1] - Math.cos(wa) * 4], 9.4, P));
    const read = ramp(t, t0 + 0.3, t0 + 2.8) * fade;
    const vals = art.test.values;
    const b = kept ? vals.kept : vals.stopped;
    set(needleA, 'd', needleAt(art.test.a.c, art.test.a.top, 13, vals.a * read, 30, true));
    set(needleB, 'd', needleAt(art.test.b.c, art.test.b.top, 13, b * read, 30, true));
    const up = kept ? ramp(t, VERDICT, VERDICT + 0.8) * fade : 0;
    set(flag, 'transform', translateAlong(P, [0, 0, (art.test.flag.high - art.test.flag.low) * up]));
    // the step, the readout
    const step = stepAt(t);
    if (step !== shownStep || lap !== shownLap) {
      shownStep = step;
      shownLap = lap;
      opts.onStep?.(step, lap);
    }
    if (readout && opts.readout) {
      const n = step === 0 ? Math.round(dayP * (opts.chats ?? 84)) : step === 3 ? Math.round(days) : 0;
      const verdict = step === 3 && t >= VERDICT ? (kept ? 'kept' : 'stopped') : null;
      const text = opts.readout({ step, lap, v, n, verdict, a: vals.a, b });
      if (text !== said) readout.textContent = said = text;
    }
  }

  function tick(now: number) {
    const dt = prev ? Math.min((now - prev) / 1000, 1 / 30) : 1 / 60;
    prev = now;
    clock += dt;
    const calm = !!still?.matches;
    if (calm) {
      frame = 0;
      draw();
      return;
    }
    if (hold !== null) {
      const end = START[hold] + STAY[hold] - 0.001;
      t = Math.min(t + dt, end);
      if (t >= end && clock >= idleAt) hold = null; // the reader stopped touching: the tour goes on
    } else {
      t += dt;
      if (t >= LAP) {
        t -= LAP;
        lap += 1;
      }
    }
    // the carriage follows its place on the lap with a critically damped spring (a click glides, it never jumps)
    const want = targetX(t);
    const w = 9;
    for (let i = 0; i < 4; i++) {
      vx += (w * w * (want - x) - 2 * w * vx) * (dt / 4);
      x += vx * (dt / 4);
    }
    if (Math.abs(want - x) < 0.01 && Math.abs(vx) < 0.01) {
      x = want;
      vx = 0;
    }
    draw();
    frame = visible ? requestAnimationFrame(tick) : 0;
  }
  const run = () => {
    if (!frame && visible) {
      prev = 0;
      frame = requestAnimationFrame(tick);
    }
  };
  /** Go to a step: its station plays from the start, then the bench waits; the tour goes on after a quiet moment. */
  function go(step: number) {
    const s = ((step % 4) + 4) % 4;
    hold = s;
    idleAt = clock + STAY[s] + IDLE;
    if (still?.matches) {
      t = START[s] + STAY[s] - 0.001; // less motion: show the station's result at once, nothing moves
      x = art.stations[s];
      vx = 0;
      draw();
      return;
    }
    t = START[s];
    run();
  }

  const io = new IntersectionObserver((entries) => {
    visible = entries[entries.length - 1].isIntersecting;
    if (visible) run();
    else if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }, { rootMargin: '80px 0px' });
  io.observe(root);
  const onKey = (e: KeyboardEvent) => {
    const fwd = art.dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const bwd = art.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    const cur = hold ?? stepAt(t);
    let to: number | null = null;
    if (e.key === fwd) to = (cur + 1) % 4;
    if (e.key === bwd) to = (cur + 3) % 4;
    if (e.key === 'Home') to = 0;
    if (e.key === 'End') to = 3;
    if (to === null) return;
    e.preventDefault();
    go(to);
  };
  stage.addEventListener('keydown', onKey);
  const onMotion = () => {
    if (still?.matches) go(hold ?? stepAt(t));
    else {
      hold = null;
      run();
    }
  };
  still?.addEventListener?.('change', onMotion);
  const onNarrow = () => draw();
  narrow?.addEventListener?.('change', onNarrow);
  if (still?.matches) {
    t = START[0] + STAY[0] - 0.001; // less motion: the day's result, still
    hold = 0;
  }
  draw();
  return {
    go,
    destroy() {
      io.disconnect();
      stage.removeEventListener('keydown', onKey);
      still?.removeEventListener?.('change', onMotion);
      narrow?.removeEventListener?.('change', onNarrow);
      svg.setAttribute('viewBox', fullBox);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
