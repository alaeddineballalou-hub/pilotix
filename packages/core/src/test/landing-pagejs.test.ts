// The landing page's own script, run in a small fake browser (21 Nov 2026): when Meta's pixel loads — once the main
// photo is there (or failed), at the first touch, or 4 s at most, never waiting for every photo of the page — and the
// visit said to the server once, only when the page is in front of the person (not hidden, not drawn in advance).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { renderGroup, renderLanding } from '@pilotix/shared';

type Fn = (...a: unknown[]) => void;

/** the page in a fake browser: its main photo still loading, already there, or none; the page shown or hidden */
function open(html: string, o: { photo: 'loading' | 'done' | 'none'; hidden?: boolean }) {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).pop()!;
  const cfg = /window\.(__L[PG])=([\s\S]*?)<\/script>/.exec(html)!;
  const on = (bag: Record<string, Fn[]>) => (n: string, f: Fn) => (bag[n] ??= []).push(f);
  const fire = (bag: Record<string, Fn[]>, n: string) => (bag[n] ?? []).slice().forEach((f) => f());
  const docOn: Record<string, Fn[]> = {};
  const winOn: Record<string, Fn[]> = {};
  const photoOn: Record<string, Fn[]> = {};
  const timers: { ms: number; fn: Fn }[] = [];
  const added: string[] = [];
  const beacons: { url: string; body: any }[] = [];
  const photo = o.photo === 'none' ? null : { tagName: 'IMG', complete: o.photo === 'done', addEventListener: on(photoOn) };
  const doc = {
    visibilityState: o.hidden ? 'hidden' : 'visible',
    prerendering: false,
    cookie: '_fbp=fb.1.1700000000000.42',
    getElementById: (id: string) => (id === 'mi' ? photo : null),
    querySelector: (sel: string) => (sel === 'img.im' ? photo : null),
    querySelectorAll: () => [],
    addEventListener: on(docOn),
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    head: { appendChild: (el: { src?: string }) => added.push(String(el.src ?? '')) },
    documentElement: { scrollHeight: 100, clientHeight: 100 },
  };
  const store = { getItem: () => null, setItem() {} };
  const ctx: any = {
    document: doc,
    navigator: { sendBeacon: (url: string, body: string) => (beacons.push({ url, body: JSON.parse(body) }), true), userAgent: 'test' },
    location: { href: 'https://babyjoy.test/p?fbclid=IwAR0x', search: '?fbclid=IwAR0x' },
    sessionStorage: store,
    localStorage: store,
    screen: {},
    Intl,
    XMLHttpRequest: class {},
    setTimeout: (fn: Fn, ms: number) => timers.push({ ms, fn }),
  };
  ctx[cfg[1]] = JSON.parse(cfg[2]);
  vm.createContext(ctx);
  ctx.window = vm.runInContext('this', ctx);
  ctx.addEventListener = on(winOn);
  vm.runInContext(script, ctx);
  return {
    /** how many times Meta's pixel library was asked for */
    pixel: () => added.filter((s) => s.includes('connect.facebook.net/en_US/fbevents.js')).length,
    beacons,
    photoLoads: () => fire(photoOn, 'load'),
    photoFails: () => fire(photoOn, 'error'),
    windowLoads: () => fire(winOn, 'load'),
    touch: () => fire(winOn, 'touchstart'),
    /** the timers of that length go off */
    after: (ms: number) => timers.filter((t) => t.ms === ms).forEach((t) => t.fn()),
    timer: (ms: number) => timers.some((t) => t.ms === ms),
    show: () => {
      doc.visibilityState = 'visible';
      fire(docOn, 'visibilitychange');
    },
  };
}

const VIEW: any = {
  slug: 'bureaux-pliable', title: 'مكتب', color: '#0f766e', price: 4950, oldPrice: null, description: '', descImages: {}, variantLabel: 'اللون',
  variants: [{ id: 1, title: 'Gris', price: null, available: 5 }], soldOut: false, images: [], fees: {}, shopName: 'Baby Joy', pixelId: '123456789012',
  tiktokId: '', whatsapp: null, productId: 26,
};
const page = (seen = '/api/lp/bureaux-pliable/seen') =>
  renderLanding(VIEW, { mode: 'live', post: '/api/lp/bureaux-pliable/order', geo: '/api/lp/geo/', lead: '/api/lp/bureaux-pliable/lead', seen, viewId: 'abc123def456gh', challenge: 'k1.r2.0123456789abcdef0123456789abcdef', bits: 10 });

test('pixel: it loads once the main photo is there — not before, and never waiting for every photo of the page', () => {
  const b = open(page(), { photo: 'loading' });
  assert.equal(b.pixel(), 0, 'not while the main photo loads (on 3G they would share the line)');
  b.windowLoads();
  assert.equal(b.pixel(), 0, 'the window’s « load » is not what it waits for');
  b.photoLoads();
  assert.equal(b.pixel(), 1);
  b.touch();
  b.after(4000);
  assert.equal(b.pixel(), 1, 'asked for once');
  // a photo that fails does not hold it
  const f = open(page(), { photo: 'loading' });
  f.photoFails();
  assert.equal(f.pixel(), 1);
});

test('pixel: at once when the photo is already there or there is none; at the first touch; 4 s at most when the photo hangs', () => {
  assert.equal(open(page(), { photo: 'done' }).pixel(), 1);
  assert.equal(open(page(), { photo: 'none' }).pixel(), 1);
  const t = open(page(), { photo: 'loading' });
  t.touch();
  assert.equal(t.pixel(), 1, 'a person touching the page is there: no more waiting');
  const h = open(page(), { photo: 'loading' });
  assert.ok(h.timer(4000) && !h.timer(2500));
  h.after(4000);
  assert.equal(h.pixel(), 1);
});

test('pixel: the same rule on a group page (its first product photo)', () => {
  const html = renderGroup(
    { slug: 'mes-produits', title: 'G', subtitle: '', color: '#0f766e', theme: 'grid', items: [], shopName: 'B', pixelId: '123456789012' } as any,
    { mode: 'live', viewId: 'grpview0000001', seen: '/api/lp/mes-produits/seen' },
  );
  const g = open(html, { photo: 'loading' });
  assert.equal(g.pixel(), 0);
  g.photoLoads();
  assert.equal(g.pixel(), 1);
  const h = open(html, { photo: 'loading' });
  h.after(4000);
  assert.equal(h.pixel(), 1);
});

test('visit: said once, when the page is in front of the person, with its view id, challenge and Meta cookie', () => {
  const b = open(page(), { photo: 'done' });
  assert.equal(b.beacons.length, 1);
  assert.equal(b.beacons[0].url, '/api/lp/bureaux-pliable/seen');
  assert.deepEqual(b.beacons[0].body, { vid: 'abc123def456gh', ch: 'k1.r2.0123456789abcdef0123456789abcdef', url: 'https://babyjoy.test/p?fbclid=IwAR0x', fbp: 'fb.1.1700000000000.42', fbc: '' });
  b.show();
  assert.equal(b.beacons.length, 1, 'shown again: still one visit');
  // hidden (loaded in advance, or in a background tab): nothing until it shows
  const h = open(page(), { photo: 'done', hidden: true });
  assert.equal(h.beacons.length, 0);
  h.show();
  assert.equal(h.beacons.length, 1);
  // no address to say it (Pilotix's preview, a team browser): never
  assert.equal(open(page(''), { photo: 'done' }).beacons.length, 0);
});
