# The film's sound, made in code (no music file): a soft bed of chords, a chime on each new step, a tick on each click,
# key presses, and a small success sound when something is done. 48 kHz stereo WAV, as long as the film.
import sys, wave
import numpy as np
from scipy.signal import butter, lfilter

SR = 48000
DUR = 62.5
N = int(SR * DUR)
out = np.zeros((N, 2))
rng = np.random.default_rng(20261109)

def note(f):  # midi number to Hz
    return 440.0 * 2 ** ((f - 69) / 12)

def env(n, a, r):
    e = np.ones(n)
    na, nr = min(int(a * SR), n // 2), min(int(r * SR), n // 2)
    if na: e[:na] = np.linspace(0, 1, na)
    if nr: e[-nr:] *= np.linspace(1, 0, nr)
    return e

def add(t, sig, gain=1.0, pan=0.0):
    i = int(t * SR)
    if i >= N: return
    sig = sig[: N - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    out[i : i + len(sig), 0] += sig * gain * l * 1.414
    out[i : i + len(sig), 1] += sig * gain * r * 1.414

def lp(x, fc, order=2):
    b, a = butter(order, fc / (SR / 2), 'low')
    return lfilter(b, a, x)

def hp(x, fc, order=2):
    b, a = butter(order, fc / (SR / 2), 'high')
    return lfilter(b, a, x)

# --- the bed: four soft chords that come back (C, Am, F, G), each ~7.8 s, warm and low
chords = [[48, 55, 64, 67], [45, 52, 60, 64], [41, 48, 57, 64], [43, 50, 59, 62]]
seg = 7.8
t0 = 0.0
k = 0
while t0 < DUR:
    n = int(min(seg + 1.6, DUR - t0) * SR)
    tt = np.arange(n) / SR
    s = np.zeros(n)
    for m in chords[k % 4]:
        f = note(m)
        for det in (-0.12, 0.12):
            s += np.sin(2 * np.pi * f * (1 + det / 100) * tt + rng.uniform(0, 6.28)) * 0.5
            s += 0.18 * np.sin(2 * np.pi * 2 * f * (1 + det / 100) * tt)
    s = lp(s, 1400) * env(n, 1.4, 1.6)
    add(t0, s, gain=0.010)
    t0 += seg
    k += 1
# a slow fade in and out for the whole bed
fade = np.ones(N)
fade[: int(1.5 * SR)] = np.linspace(0, 1, int(1.5 * SR))
fade[-int(2.5 * SR):] = np.linspace(1, 0, int(2.5 * SR))
out *= fade[:, None]

# --- small sounds
def bell(f, d=1.2, bright=0.35):
    n = int(d * SR); tt = np.arange(n) / SR
    s = np.sin(2 * np.pi * f * tt) + bright * np.sin(2 * np.pi * 2.01 * f * tt) * np.exp(-tt * 9) + 0.12 * np.sin(2 * np.pi * 3.0 * f * tt) * np.exp(-tt * 14)
    return s * np.exp(-tt * 4.2) * env(n, 0.004, 0.05)

def chime(t, a, b, gain=0.10, pan=0.0):
    add(t, bell(note(a)), gain, pan)
    add(t + 0.11, bell(note(b)), gain * 0.9, pan)

def tick(t, gain=0.08, pan=0.0, f=2400):
    n = int(0.035 * SR); tt = np.arange(n) / SR
    noise = hp(rng.standard_normal(n), 1800) * np.exp(-tt * 260)
    s = 0.6 * noise + np.sin(2 * np.pi * f * tt) * np.exp(-tt * 180)
    add(t, s, gain, pan)

def thock(t, gain=0.12):
    n = int(0.09 * SR); tt = np.arange(n) / SR
    s = np.sin(2 * np.pi * 180 * tt * (1 - tt * 2)) * np.exp(-tt * 55) + 0.4 * lp(rng.standard_normal(n), 2500) * np.exp(-tt * 120)
    add(t, s, gain)

def pop(t, gain=0.12, f0=520, f1=980):
    n = int(0.16 * SR); tt = np.arange(n) / SR
    f = f0 + (f1 - f0) * (tt / tt[-1])
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt * 22)
    add(t, s, gain)

def whoosh(t, d=0.8, gain=0.05, up=True):
    n = int(d * SR); tt = np.arange(n) / SR
    x = rng.standard_normal(n)
    # a band that moves: two low-passes, cross-faded
    a, b = lp(x, 600), lp(x, 3500)
    m = tt / d if up else 1 - tt / d
    s = (a * (1 - m) + b * m) * np.sin(np.pi * tt / d) ** 2
    add(t, s, gain)

# title: a rise, the logo
whoosh(0.05, 0.9, 0.05)
pop(0.38, 0.10, 400, 800)
for k in range(7):
    tick(1.2 + k * 0.12, 0.035, -0.6 + k * 0.2, 1800 + k * 120)
# each new step: a soft two-note chime
for t in [4.0, 11.5, 16.5, 26.0, 32.0, 41.5, 48.6]:
    chime(t, 76, 81, 0.07)
# clicks (from the film: index.html CLICKS)
for t in [6.1, 8.35, 12.85, 18.25, 19.45, 20.95, 29.65, 33.15, 35.0, 35.22, 38.65, 50.9, 52.35]:
    tick(t, 0.10)
# typing chrome://extensions
for k in range(19):
    tick(26.6 + k * (1.2 / 19), 0.045, 0.1, 3000 + (k % 3) * 200)
# keys: Entrée, F5, Entrée
for t in [27.95, 49.25, 55.45]:
    thock(t, 0.16)
# done: the download, the folder put away, the add-on loaded, the phone linked, the message sent
chime(13.8, 79, 84, 0.06)
pop(23.5, 0.08, 700, 500)
chime(39.3, 72, 79, 0.09)
chime(45.65, 72, 79, 0.09)
whoosh(55.55, 0.45, 0.05)
pop(55.95, 0.12, 600, 1200)
# the end: a small rising arpeggio
for k, m in enumerate([72, 76, 79, 84]):
    add(59.0 + k * 0.13, bell(note(m), 1.6, 0.3), 0.08, -0.3 + k * 0.2)

peak = np.max(np.abs(out))
out = out / peak * 0.70  # about -3 dBFS
pcm = (np.clip(out, -1, 1) * 32767).astype('<i2')
with wave.open(sys.argv[1] if len(sys.argv) > 1 else 'score.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('ok', DUR, 's, peak', round(float(peak), 3))
