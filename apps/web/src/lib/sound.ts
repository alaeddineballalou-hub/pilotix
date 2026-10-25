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
