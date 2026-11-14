/**
 * The browser watcher (Control room › Doctor): what goes wrong on people's screens, told to the server so the owner
 * sees it before anyone complains.
 * - an error on a page (uncaught, a promise nobody waited for, a page that crashed),
 * - a loop: the same action asked again and again (the Accueil bug of Nov. 2026 asked stats.overview ~60 times a
 *   second without end),
 * - a slow action (over 8 s),
 * - a cut (« coupure »): the server could not be reached from this screen for 10 s or more — when it started and
 *   ended, and whether the device itself had lost internet or had internet but could not reach Pilotix (owner's ask,
 *   14 Nov 2026: cuts seen in Algeria while the server and Cloudflare were fine).
 * The same problem is told once per 10 minutes per screen; at most 10 a send, every 20 s; nothing in the demo.
 */
type Kind = 'error' | 'loop' | 'slow' | 'cut';
export interface ClientReport {
  kind: Kind;
  page: string;
  message: string;
  device: 'phone' | 'computer';
}

const QUIET_MS = 10 * 60_000;
const LOOP_WINDOW_MS = 10_000;
/** The same action this many times in 10 s from one screen: a loop (normal pages ask each thing a few times). */
export const LOOP_AT = 40;
export const SLOW_MS = 8_000;

const queue: ClientReport[] = [];
const told = new Map<string, number>();
const calls = new Map<string, number[]>();
let sender: ((items: ClientReport[]) => Promise<unknown>) | null = null;

const page = () => (location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'accueil').slice(0, 40);
const device = (): 'phone' | 'computer' => (typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches ? 'phone' : 'computer');

/** Noise that is not Pilotix's: browser extensions, the resize-observer warning, a phone without network. */
function noise(message: string, stack = ''): boolean {
  return (
    /extension:\/\//.test(stack) ||
    /ResizeObserver loop/.test(message) ||
    /^(Script error\.?|Load failed|Failed to fetch|NetworkError when attempting to fetch resource\.?)$/.test(message.trim())
  );
}

export function report(kind: Kind, message: string) {
  message = message.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!message) return;
  const p = page();
  const key = `${kind}|${p}|${message.replace(/\d+/g, '#')}`;
  const now = Date.now();
  if (now - (told.get(key) ?? 0) < QUIET_MS) return;
  told.set(key, now);
  if (told.size > 300) for (const [k, t] of told) if (now - t > QUIET_MS) told.delete(k);
  if (queue.length < 30) queue.push({ kind, page: p, message, device: device() });
}

/** Every action asked (lib/backend's rpc): counts it for the loop check, and reports a slow one. */
export function noteCall(name: string, ms: number) {
  const now = Date.now();
  const t = (calls.get(name) ?? []).filter((x) => now - x < LOOP_WINDOW_MS);
  t.push(now);
  calls.set(name, t);
  if (t.length >= LOOP_AT) {
    report('loop', `${name} demandé ${t.length} fois en 10 s`);
    calls.set(name, []);
  }
  if (ms >= SLOW_MS) report('slow', `${name} a pris ${Math.round(ms / 1000)} s`);
}

/** A page's own error (the error box of a page that crashed). */
export function reportCrash(e: unknown) {
  const err = e as { message?: string; stack?: string };
  const msg = String(err?.message ?? e ?? '');
  if (!noise(msg, String(err?.stack ?? ''))) report('error', firstLine(msg, err?.stack));
}

function firstLine(msg: string, stack?: string): string {
  // the message and where it happened (the first line of the stack that is ours), without the address
  const at = (stack ?? '').split('\n').find((l) => /\/assets\/|\/src\//.test(l));
  const where = at ? at.replace(/^\s*at\s+/, '').replace(/https?:\/\/[^/\s)]+/g, '').trim() : '';
  return where ? `${msg} — ${where}` : msg;
}

/** Starts listening (once). `send`: the server's door; without it (the demo) nothing leaves the page. */
export function startWatch(send: (items: ClientReport[]) => Promise<unknown>) {
  if (sender) return;
  sender = send;
  window.addEventListener('error', (e) => {
    const err = e.error as { stack?: string } | undefined;
    if (!e.message || noise(e.message, String(err?.stack ?? e.filename ?? ''))) return;
    report('error', firstLine(e.message, err?.stack));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string; status?: number } | undefined;
    // a refused or failed request is already shown to the person and logged by the server: not a page bug
    if (r && typeof r === 'object' && 'status' in r) return;
    const msg = String(r?.message ?? r ?? '');
    if (!noise(msg, String(r?.stack ?? ''))) report('error', firstLine(msg, r?.stack));
  });
  setInterval(() => void flush(), 20_000);
}

async function flush() {
  if (!sender || !queue.length) return;
  const items = queue.splice(0, 10);
  try {
    await sender(items);
  } catch {
    /* the watcher never bothers anyone: what could not be sent is dropped */
  }
}

// ---------------------------------------------------------------- coupures (cuts)
/** A cut shorter than this is not told (one lost request on a moving phone is not a cut). */
export const CUT_MIN_MS = 10_000;
const PROBE_MS = 15_000;
let cut: { start: number; why: string; offline: boolean; probe: string; timer: ReturnType<typeof setInterval> | null } | null = null;

const hms = (t: number) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function lasted(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}
function connection(): string {
  const c = (navigator as unknown as { connection?: { type?: string; effectiveType?: string } }).connection;
  return [c?.type, c?.effectiveType].filter(Boolean).join(' ') || 'réseau inconnu';
}

/**
 * A request to the server failed (nothing answered, or Cloudflare could not reach the server: `why`).
 * `probe`: an address of the server to test every 15 s until it answers again.
 */
export function noteNetFail(why: string, probe: string) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false && cut) cut.offline = true;
  if (cut) return;
  cut = { start: Date.now(), why, offline: typeof navigator !== 'undefined' && navigator.onLine === false, probe, timer: null };
  cut.timer = setInterval(() => {
    if (!cut) return;
    if (navigator.onLine === false) cut.offline = true;
    fetch(`${cut.probe}${cut.probe.includes('?') ? '&' : '?'}cut=${Date.now()}`, { cache: 'no-store' })
      .then((r) => {
        if (r.status < 500) noteNetOk();
      })
      .catch(() => {});
  }, PROBE_MS);
}

/** The server answered: a cut in progress is over (told when it lasted 10 s or more). */
export function noteNetOk() {
  if (!cut) return;
  const c = cut;
  cut = null;
  if (c.timer) clearInterval(c.timer);
  const end = Date.now();
  if (end - c.start < CUT_MIN_MS) return;
  const where = c.offline ? "l'appareil n'avait plus internet" : 'internet marchait, Pilotix ne répondait pas';
  const message = `Coupure de ${lasted(end - c.start)} (${hms(c.start)} → ${hms(end)}) · ${where} · ${c.why} · ${connection()}`;
  // every cut is told (no 10-minute quiet: each one is a fact with its own time), at most 30 waiting
  if (queue.length < 30) queue.push({ kind: 'cut', page: page(), message: message.slice(0, 300), device: device() });
}

/** Tests only. */
export const _watch = { queue, told, calls, flush, reset: () => (queue.splice(0), told.clear(), calls.clear(), cut?.timer && clearInterval(cut.timer), (cut = null)) };
