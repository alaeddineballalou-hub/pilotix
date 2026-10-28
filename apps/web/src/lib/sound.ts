// A short chime for news that matter now (a new order from a landing page). Browsers play sound only after the user
// touched the page once: unlockAudio() runs on the first pointer press.
let audio: AudioContext | null = null;

export function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (audio.state === 'suspended') void audio.resume();
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
