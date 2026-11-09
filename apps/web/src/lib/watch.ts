/**
 * The browser watcher (Control room › Doctor): what goes wrong on people's screens, told to the server so the owner
 * sees it before anyone complains.
 * - an error on a page (uncaught, a promise nobody waited for, a page that crashed),
 * - a loop: the same action asked again and again (the Accueil bug of Nov. 2026 asked stats.overview ~60 times a
 *   second without end),
 * - a slow action (over 8 s).
 * The same problem is told once per 10 minutes per screen; at most 10 a send, every 20 s; nothing in the demo.
 */
type Kind = 'error' | 'loop' | 'slow';
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

/** Tests only. */
export const _watch = { queue, told, calls, flush, reset: () => (queue.splice(0), told.clear(), calls.clear()) };
