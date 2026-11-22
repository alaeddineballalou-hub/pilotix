// A short chime for news that matter now (a new order from a landing page). Browsers play sound only after the user
// touched the page once: unlockAudio() runs on the first pointer press.
let audio: AudioContext | null = null;

export function unlockAudio() {
  try {
    // an iPhone (Safari 17+): « playback » plays even with the silent switch on (older ones ignore it — not checked on a
    // real iPhone yet)
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session && session.type !== 'playback') session.type = 'playback';
  } catch {
    /* an older browser */
  }
  try {
    audio ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (audio.state === 'suspended') void audio.resume();
    // the bell's recordings, ready before the first one is needed
    preloadBellSounds();
  } catch {
    /* no sound on this browser */
  }
}

/** two soft notes, rising */
export function chime() {
  if (!audio || audio.state !== 'running') return;
  const t = audio.currentTime;
  for (const [i, f] of [660, 880].entries()) {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + i * 0.16);
    g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.16 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.28);
    o.connect(g).connect(audio.destination);
    o.start(t + i * 0.16);
    o.stop(t + i * 0.16 + 0.3);
  }
}

/** an alarm the depot cannot miss: a loud two-tone siren (call it again every few seconds while the alert is open) */
export function alarm() {
  if (!audio || audio.state !== 'running') return;
  const t = audio.currentTime;
  const master = audio.createGain();
  master.gain.value = 0.55;
  master.connect(audio.destination);
  // a harsh siren: two sawtooth voices sweeping up and down, three times
  for (let i = 0; i < 3; i++) {
    const s = t + i * 0.5;
    for (const [type, detune] of [['sawtooth', 0], ['square', 7]] as const) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = type;
      o.detune.value = detune;
      o.frequency.setValueAtTime(650, s);
      o.frequency.linearRampToValueAtTime(1450, s + 0.24);
      o.frequency.linearRampToValueAtTime(650, s + 0.48);
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.5, s + 0.02);
      g.gain.setValueAtTime(0.5, s + 0.44);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.49);
      o.connect(g).connect(master);
      o.start(s);
      o.stop(s + 0.5);
    }
  }
}

/** Can the page make a sound now? (false until the person touched the page once: the browser's rule) */
export const audioReady = () => !!audio && audio.state === 'running';

/**
 * Pilotix's one phone ring, « drrr-drrr »: two trills. The same everywhere, as the owner asked: « Bloquer jusqu'à
 * l'appel » (ring()) and the bell's new order and callback. `soft`, `bright`: the two voices' loudness.
 */
function phoneRing(a: BaseAudioContext, dst: AudioNode, t: number, soft: number, bright: number) {
  for (const start of [0, 0.5]) {
    const s = t + start;
    // a bell's trill: the tone jumps between two notes 25 times a second, a soft voice and a bright one
    for (const [type, level] of [['triangle', soft], ['square', bright]] as const) {
      const o = a.createOscillator();
      const g = a.createGain();
      o.type = type;
      for (let i = 0; i < 10; i++) o.frequency.setValueAtTime(i % 2 ? 1480 : 1180, s + i * 0.04);
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(level, s + 0.015);
      g.gain.setValueAtTime(level, s + 0.36);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.4);
      o.connect(g).connect(dst);
      o.start(s);
      o.stop(s + 0.42);
    }
  }
}

/**
 * A phone ringing, loud (« Bloquer jusqu'à l'appel »: a new order to call): two trills, « drrr-drrr ». Call it again every
 * few seconds while it should ring.
 */
export function ring() {
  if (!audio || audio.state !== 'running') return;
  const master = audio.createGain();
  master.gain.value = 0.7;
  master.connect(audio.destination);
  phoneRing(audio, master, audio.currentTime, 0.7, 0.22);
}

// ---------------------------------------------------------------- the bell (layout/Bell): one sound for each kind
export type BellSound = 'order' | 'callback' | 'delivered' | 'returned' | 'cancelled' | 'taken' | 'alert' | 'depot' | 'message' | 'info';

let bus: DynamicsCompressorNode | null = null;
/** Everything goes through a compressor: loud, never clipping. */
function out(a: AudioContext, gain: number): GainNode {
  if (!bus) {
    bus = a.createDynamicsCompressor();
    bus.threshold.value = -12;
    bus.knee.value = 8;
    bus.ratio.value = 4;
    bus.attack.value = 0.003;
    bus.release.value = 0.2;
    bus.connect(a.destination);
  }
  const g = a.createGain();
  g.gain.value = gain;
  g.connect(bus);
  return g;
}
function note(a: AudioContext, dst: AudioNode, f: number, at: number, dur: number, type: OscillatorType = 'sine', vol = 0.5, glide?: number) {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, at);
  if (glide) o.frequency.exponentialRampToValueAtTime(glide, at + dur);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(dst);
  o.start(at);
  o.stop(at + dur + 0.03);
}
function hiss(a: AudioContext, dst: AudioNode, at: number, dur: number, freq: number, vol: number, to?: number) {
  const len = Math.max(1, Math.ceil(a.sampleRate * dur));
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.setValueAtTime(freq, at);
  if (to) f.frequency.exponentialRampToValueAtTime(to, at + dur);
  f.Q.value = 1.2;
  const g = a.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(dst);
  src.start(at);
}

const SOUNDS: Record<BellSound, (a: AudioContext, o: GainNode, t: number) => void> = {
  // a new order and time to call back: the same phone ring (the owner's rule), the one « Bloquer jusqu'à l'appel » rings
  // — a little louder here
  order: (a, o, t) => phoneRing(a, o, t, 0.8, 0.3),
  callback: (a, o, t) => phoneRing(a, o, t, 0.8, 0.3),
  // delivered: the owner's cash register recording (lib/bellFiles.ts); this drawn one only when it cannot load
  delivered: (a, o, t) => {
    hiss(a, o, t, 0.07, 2600, 0.9);
    note(a, o, 1760, t + 0.03, 0.22, 'triangle', 0.35);
    note(a, o, 2637, t + 0.09, 1.1, 'sine', 0.55);
    note(a, o, 3520, t + 0.09, 0.9, 'sine', 0.35);
    note(a, o, 5274, t + 0.09, 0.5, 'sine', 0.12);
    [0.22, 0.3, 0.37, 0.46].forEach((k, i) => note(a, o, 4200 + i * 420, t + k, 0.09, 'sine', 0.14));
  },
  // back to the depot: three notes going down (« a fault »)
  returned: (a, o, t) => {
    note(a, o, 523, t, 0.2, 'sawtooth', 0.5);
    note(a, o, 440, t + 0.2, 0.2, 'sawtooth', 0.5);
    note(a, o, 349, t + 0.4, 0.55, 'sawtooth', 0.55, 300);
  },
  // cancelled: a low error buzz, twice
  cancelled: (a, o, t) => {
    for (const k of [0, 0.24]) {
      note(a, o, 155, t + k, 0.18, 'square', 0.4);
      note(a, o, 163, t + k, 0.18, 'square', 0.3);
    }
  },
  // taken from me: a « whoosh » going down
  taken: (a, o, t) => {
    note(a, o, 1100, t, 0.42, 'sine', 0.7, 260);
    hiss(a, o, t, 0.42, 3000, 0.45, 400);
  },
  // an alert on a parcel: an urgent two-tone, loud
  alert: (a, o, t) => {
    for (let i = 0; i < 6; i++) note(a, o, i % 2 ? 740 : 988, t + i * 0.14, 0.13, 'triangle', 0.75);
  },
  // the depot: knock, knock, ding
  depot: (a, o, t) => {
    for (const k of [0, 0.16]) {
      note(a, o, 210, t + k, 0.09, 'sine', 0.8);
      hiss(a, o, t + k, 0.03, 1800, 0.5);
    }
    note(a, o, 1047, t + 0.36, 0.45, 'triangle', 0.5);
  },
  // a customer's message: two bubbles
  message: (a, o, t) => {
    note(a, o, 380, t, 0.08, 'sine', 0.55, 1150);
    note(a, o, 520, t + 0.14, 0.08, 'sine', 0.55, 1500);
  },
  // the rest: a soft chime
  info: (a, o, t) => {
    note(a, o, 660, t, 0.3, 'sine', 0.6);
    note(a, o, 880, t + 0.16, 0.36, 'sine', 0.6);
  },
};

// the recorded ones (lib/bellFiles.ts): decoded once, the first time
type Recorded = keyof typeof import('./bellFiles').BELL_FILES;
const RECORDED = new Set<BellSound>(['delivered']);
const decoded = new Map<BellSound, Promise<AudioBuffer | null>>();
function recorded(a: AudioContext, kind: BellSound): Promise<AudioBuffer | null> {
  let p = decoded.get(kind);
  if (!p) {
    p = import('./bellFiles')
      .then((m) => fetch(m.BELL_FILES[kind as Recorded]))
      .then((r) => r.arrayBuffer())
      .then((b) => a.decodeAudioData(b))
      .catch(() => null);
    decoded.set(kind, p);
  }
  return p;
}
/** Loads the recorded sounds ahead (once the page was touched): the first « Livrée » plays at once. */
export function preloadBellSounds() {
  if (audio) for (const k of RECORDED) void recorded(audio, k);
}

let lastSound = 0;
/**
 * The bell's sound for a kind (`loud`: the important ones). Several lines at once play one sound. With `vibrate`, the
 * phone vibrates too (Android).
 */
export function bellSound(kind: BellSound, loud = false, vibrate = false) {
  const now = Date.now();
  if (now - lastSound < (loud ? 400 : 800)) return false;
  if (vibrate) navigator.vibrate?.(loud ? [300, 120, 300, 120, 500] : [160]);
  const a = audio;
  if (!a || a.state !== 'running') return false;
  lastSound = now;
  try {
    if (RECORDED.has(kind)) {
      // a recording: played as it is (the drawn sound if it could not be loaded)
      void recorded(a, kind).then((buf) => {
        if (!buf) return SOUNDS[kind](a, out(a, loud ? 1 : 0.7), a.currentTime + 0.02);
        const src = a.createBufferSource();
        src.buffer = buf;
        src.connect(out(a, 0.9));
        src.start(a.currentTime + 0.01);
      });
      return true;
    }
    SOUNDS[kind](a, out(a, loud ? 1 : 0.7), a.currentTime + 0.02);
    return true;
  } catch {
    return false;
  }
}
