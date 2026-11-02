// "How Dellal learns" as a real object: a learning bench. The lesson book rides a carriage along a rail and visits four
// stations, the four moments of Pilot AI's loop: the day (a chat terminal: Dellal sells, the chats pile up as tokens), the
// night at 02:30 (a reading lamp over the book, the finished chats sorted into won and lost, a dial that adds the score),
// the morning (the coach's stamp press: an approved lesson goes into the book, its version goes up) and the test (two dials,
// the current book A and the new book B, in parcels delivered per 100 chats; the flag rises only if B is not worse).
//
// Drawn with the Anatomy kit (../kit/iso-kit.mjs, MIT). This script writes the static picture once per reading direction
// (left to right, and right to left for Arabic, where the bench runs the other way) as TypeScript modules the dashboard
// loads, and, with --page, standalone pages for the Anatomy checks (capture.mjs, lines.mjs).
//
//   node apps/web/explainers/dellal-learns/build.mjs          → src/pages/platform/learn/art-ltr.ts, art-rtl.ts
//   node apps/web/explainers/dellal-learns/build.mjs --page   → + explainers/dellal-learns/out/*.html (not committed)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as k from '../kit/iso-kit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..');
const OUT_TS = join(WEB, 'src', 'pages', 'platform', 'learn');

// ------------------------------------------------------------------ the world (1 unit ≈ 1 px of the real bench)
const WIDTH = 760;
const AZIMUTH = 64;

const PLATE = { x: -240, y: -78, w: 480, d: 138, r: 10 };
const PLATE_H = 12;
const FOOT_H = 5;
const RULER = { x: -222, y: 46, w: 444, d: 7, r: 1 };
const RAIL = { x: -216, y: 24, w: 432, d: 8, r: 1.5 };
const RAIL_H = 4;

const CARRIAGE = { x: -28, y: 16, w: 56, d: 26, r: 3 };
const CAR_Z = RAIL_H;
const CAR_TOP = 10;
const BOOK = { x: -20, y: 19, w: 40, d: 20, r: 1.4 };
const BOOK_Z = CAR_TOP;
const COVER = 1.4;
const PAGES_H = 4.2;
const BOOK_TOP = BOOK_Z + COVER + PAGES_H + COVER; // 17
const BOOK_C = [0, BOOK.y + BOOK.d / 2]; // the book's centre on the carriage

// the four stations behind the rail, in the loop's order; Arabic reads right to left, so its bench runs that way
const STEPS = ['day', 'night', 'morning', 'test'];
const XS = { ltr: [-165, -55, 55, 165], rtl: [165, 55, -55, -165] };

// the score of a finished chat (packages/core/src/modules/pilotlearn.ts › SCORE) and a night's example: 51 delivered,
// 15 refused, 18 cancelled → 51 − 7.5 − 2.7 = +40.8
const SCORE = { delivered: 1, refused: -0.5, cancelled: -0.15 };
const NIGHT = { delivered: 51, refused: 15, cancelled: 18 };
const NIGHT_SCORE = Math.round((NIGHT.delivered * SCORE.delivered + NIGHT.refused * SCORE.refused + NIGHT.cancelled * SCORE.cancelled) * 10) / 10;
// the test (pilotlearn.ts › verdictOf): A = the book in service, B = the new book on 20 % of the chats, chats 10 days old.
// Lap "kept": A 1600 chats, 280 delivered (17.5); B 400 chats, 74 delivered (18.5): not worse → the coach may keep it.
// Lap "stopped": B 400 chats, 48 delivered (12.0): clearly worse (z ≈ −2.7) → stopped on its own.
const TEST = { a: 17.5, kept: 18.5, stopped: 12.0 };

// the camera: fit the plate and the tallest real parts of both benches (left to right and right to left), then crop the
// height to what the drawing really uses
const TALL = Object.values(XS).flatMap(([day, night, morning, test]) => [
  [day + 4, -50, 83],
  [night - 14, -52, 101],
  [night - 14, 23, 81],
  [morning + 12, 8, 110],
  [morning - 10, -58, 90],
  [test + 38, -58, 68],
]);
const FIT = [...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0), ...TALL];
const PAD = 14;
const HEIGHT = (() => {
  const wide = k.fitProjection(FIT, WIDTH, 4000, { pad: PAD, azimuth: AZIMUTH });
  const ys = FIT.map((pt) => k.iso(pt, wide)[1]);
  return Math.ceil(Math.max(...ys) - Math.min(...ys) + PAD * 2 + 6);
})();
const P = k.fitProjection(FIT, WIDTH, HEIGHT, { pad: PAD, azimuth: AZIMUTH });

const at = (point) => k.iso(point, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const plan = (x, y, w, d, r = 1) => ({ x, y, w, d, r });
const depth = ([x, y, z = 0]) => k.depthOf([x, y, z], P);
const byDepth = (items, key = (item) => item) => [...items].sort((a, b) => depth(key(a)) - depth(key(b)));
const halo = (p, z, blur = 6) => `<path class="iso-halo" d="${k.haloOf(p, z, 0.1, P)}" style="filter:blur(${blur}px)"/>`;
const face = (points) => k.pathOf(points.map(at), true); // a closed outline on a face, from world points

// a token (one chat): a small disc
const TOKEN_R = 4.2;
const TOKEN_H = 1.6;
const token = (x, y, z, cls) => S(k.cylinder(x, y, TOKEN_R, z, TOKEN_H, P, 26, 0.3), { tone: 'mid', crease: 'faint', className: cls });

/** A dial gauge seen from above: base disc, post, body with a knurled rim, ticks, a centre cap; the needle is live. */
function dialGauge(x, y, z0, post, r) {
  const out = [];
  const top = z0 + post + 7;
  out.push(S(k.cylinder(x, y, r * 0.62, z0, 2.4, P, 28, 0.4), { tone: 'mid' }));
  out.push(L(k.ring(x, y, r * 0.62 - 2, z0 + 2.4, P, 28), { tone: 'faint' }));
  out.push(S(k.cylinder(x, y, 2.3, z0 + 2.4, post - 2.4, P, 18), { tone: 'mid', crease: 'none' }));
  out.push(L(k.sideArc(x, y, 2.3, z0 + post * 0.55, P, 10), { tone: 'lo' }));
  out.push(S(k.cylinder(x, y, 3.4, z0 + post - 2, 2, P, 20), { tone: 'mid' }));
  out.push(S(k.cylinder(x, y, r, z0 + post, 7, P, 56, 0.7), { tone: 'hi', crease: 'lo' }));
  out.push(L(k.knurl(x, y, r, top - 2.6, top, 72, P, 0.3), { tone: 'lo' }));
  out.push(L(k.sideArc(x, y, r, top - 2.6, P, 36), { tone: 'faint' }));
  out.push(L(k.ring(x, y, r - 1.8, top, P, 56), { tone: 'lo' }));
  return { svg: out.join(''), top };
}
/** The angle on a top dial whose 12 o'clock points straight away from the reader. */
const A0 = Math.atan2(-Math.cos((AZIMUTH * Math.PI) / 180), Math.sin((AZIMUTH * Math.PI) / 180));
function dialTicks(x, y, top, r, count, every, span) {
  const t = k.radialTicks(x, y, r - 2.4, count, every, top, [1.1, 2.4], P, A0 - span / 2, span);
  return L(t.minor, { tone: 'lo' }) + L(t.major, { tone: 'mid' });
}

// ------------------------------------------------------------------ the bench
function base() {
  const out = [`<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`];
  for (const [x, y] of byDepth(k.corners(PLATE, 24))) {
    out.push(S(k.cylinder(x, y, 8, -PLATE_H - FOOT_H, 1.6, P, 28), { tone: 'lo' }));
    out.push(S(k.cylinder(x, y, 6.4, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: 'mid' }));
  }
  out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.6), { tone: 'mid', inner: L(k.sideSeam(PLATE, -PLATE_H + 4, P), { tone: 'faint' }) }));
  out.push(L(k.planOutline(k.insetPlan(PLATE, 5), 0, P), { tone: 'lo' }));
  const screws = k.corners(PLATE, 11);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 2.4, 0, P, 16)).join(''), { tone: 'lo' }));
  out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.55 }));
  // the ruler along the front: the book's travel
  out.push(S(k.slabOf(RULER, 0, 0.6, P, 3), { tone: 'lo', crease: 'none' }));
  const ticks = k.topTicks(RULER.x + 4, RULER.x + RULER.w - 4, 4, 5, RULER.y + 0.8, 0.6, [2.4, 4.4], P);
  out.push(L(ticks.minor, { tone: 'lo' }), L(ticks.major, { tone: 'mid' }));
  out.push(D([at([RULER.x + 2, RULER.y + RULER.d / 2, 0.6]), at([RULER.x + RULER.w - 2, RULER.y + RULER.d / 2, 0.6])], { size: 0.45 }));
  // the maker's plate at the right end, three rule lines for its printed words
  const tag = plan(223, -34, 12, 40, 1.2);
  out.push(S(k.slabOf(tag, 0, 0.7, P, 3), { tone: 'lo', crease: 'none' }));
  out.push(L([0, 1, 2].map((i) => k.lineOnTop([tag.x + 3.2 + i * 3.2, tag.y + 5], [tag.x + 3.2 + i * 3.2, tag.y + (i === 2 ? 26 : 38)], 0.7, P)).join(''), { tone: 'faint', free: true }));
  out.push(D([at([tag.x + tag.w / 2, tag.y + 2, 0.7]), at([tag.x + tag.w / 2, tag.y + tag.d - 2, 0.7])], { size: 0.4 }));
  return out.join('');
}

function rail() {
  const out = [];
  out.push(S(k.slabOf(RAIL, 0, RAIL_H, P, 3, 0.5), { tone: 'mid', inner: L(k.sideSeam(RAIL, 1.4, P, 3), { tone: 'faint' }) }));
  out.push(L(k.lineOnTop([RAIL.x + 3, RAIL.y + RAIL.d / 2], [RAIL.x + RAIL.w - 3, RAIL.y + RAIL.d / 2], RAIL_H, P), { tone: 'faint' }));
  out.push(D([-200, -110, 0, 110, 200].map((x) => at([x, RAIL.y + RAIL.d / 2, RAIL_H])), { size: 0.45, tone: 'lo' }));
  for (const x of [RAIL.x - 6, RAIL.x + RAIL.w]) {
    const stop = plan(x, RAIL.y - 4, 6, RAIL.d + 8, 1.2);
    out.push(S(k.slabOf(stop, 0, 10, P, 3, 0.5), { tone: 'mid' }));
    out.push(D([at([x + 3, stop.y + 3, 10]), at([x + 3, stop.y + stop.d - 3, 10])], { size: 0.45 }));
  }
  return out.join('');
}

/** The carriage and the lesson book (the one lit part), built at x = 0 and slid along the rail. */
function carriage() {
  const out = [halo(k.insetPlan(CARRIAGE, 3), CAR_Z, 4)];
  out.push(S(k.slabOf(CARRIAGE, CAR_Z, CAR_TOP - CAR_Z, P, 5, 0.6), { tone: 'mid', inner: L(k.sideSeam(CARRIAGE, CAR_Z + 2, P, 5), { tone: 'faint' }) }));
  out.push(D(k.corners(CARRIAGE, 3.2).map(([x, y]) => at([x, y, CAR_TOP])), { size: 0.45, tone: 'lo' }));
  // the index that reads the ruler: a tab down the front, a thin pointer over the ticks
  const front = CARRIAGE.y + CARRIAGE.d;
  out.push(S(k.slabOf(plan(-1.6, front - 0.2, 3.2, 1.4, 0.4), 1.2, CAR_Z - 1.2 + 0.2, P, 2), { tone: 'mid', crease: 'none' }));
  out.push(S(k.slabOf(plan(-0.9, front + 0.8, 1.8, RULER.y - front + 2.4, 0.5), 1.2, 0.6, P, 2), { tone: 'hi', crease: 'none' }));
  // the push knob
  const knob = [16, CARRIAGE.y + CARRIAGE.d + 3.4];
  out.push(S(k.slabOf(plan(knob[0] - 1.6, CARRIAGE.y + CARRIAGE.d - 1, 3.2, 2.6, 0.8), CAR_Z + 2, 3, P, 2), { tone: 'mid', crease: 'none' }));
  out.push(S(k.cylinder(knob[0], knob[1], 3.2, CAR_Z, 6, P, 22), { tone: 'mid' }));
  out.push(L(k.knurl(knob[0], knob[1], 3.2, CAR_Z, CAR_Z + 6, 22, P), { tone: 'lo' }));
  // the book: back cover, the block of pages (their edges show), front cover with the version, a ribbon
  const pages = plan(BOOK.x + 0.6, BOOK.y + 0.9, BOOK.w - 1.5, BOOK.d - 1.8, 0.6);
  out.push(halo(k.insetPlan(BOOK, 2), BOOK_Z, 3));
  out.push(S(k.slabOf(BOOK, BOOK_Z, COVER, P, 4, 0.3), { tone: 'hi', lit: true }));
  const leaves = [1, 2, 3, 4].map((i) => k.sideSeam(pages, BOOK_Z + COVER + (PAGES_H * i) / 5, P, 3)).join('');
  out.push(S(k.slabOf(pages, BOOK_Z + COVER, PAGES_H, P, 3), { tone: 'hi', crease: 'none', inner: L(leaves, { tone: 'faint' }) }));
  out.push(S(k.slabOf(BOOK, BOOK_Z + COVER + PAGES_H, COVER, P, 4, 0.4), { tone: 'hi', lit: true }));
  const spine = plan(BOOK.x, BOOK.y, 3.4, BOOK.d, 1.2);
  out.push(L(k.lineOnTop([spine.x + spine.w, BOOK.y + 0.6], [spine.x + spine.w, BOOK.y + BOOK.d - 0.6], BOOK_TOP, P), { tone: 'lit' }));
  out.push(L(k.planOutline(plan(BOOK.x + 7, BOOK.y + 3, BOOK.w - 10, BOOK.d - 6, 1), BOOK_TOP, P, 3), { tone: 'lit' }));
  const ribbon = plan(BOOK.x + BOOK.w - 9, BOOK.y + BOOK.d - 0.2, 2.2, 0.5, 0.2);
  out.push(S(k.slabOf(ribbon, BOOK_Z + 1.5, BOOK_TOP - BOOK_Z - 1.5, P, 1), { tone: 'hi', lit: true, crease: 'none' }));
  out.push(
    k.faceTextSvg(k.topMatrix([BOOK.x + 7 + (BOOK.w - 10) / 2, BOOK.y + BOOK.d / 2 + 2.6], BOOK_TOP, P, 'x'), 'v2', { size: 7.4, tone: 'hi', anchor: 'middle' }).replace(
      '<text ',
      '<text data-part="version" ',
    ),
  );
  return out.join('');
}

// ------------------------------------------------------------------ the four stations (x = their stop on the rail)
/** The day: a chat terminal. Its screen shows the conversation, the mast blinks, the tray fills with today's chats. */
function day(sx) {
  const back = [];
  const tower = plan(sx - 26, -58, 36, 30, 4);
  back.push(halo(plan(sx - 30, -62, 44, 40, 3), 0, 6));
  back.push(S(k.slabOf(plan(sx - 30, -62, 44, 40, 3), 0, 4, P, 4, 0.5), { tone: 'mid' }));
  back.push(D([at([sx - 27, -59, 4]), at([sx + 11, -59, 4]), at([sx - 27, -25, 4]), at([sx + 11, -25, 4])], { size: 0.45, tone: 'lo' }));
  const yF = tower.y + tower.d; // the front face
  const screen = [
    [sx - 21, yF, 56],
    [sx + 5, yF, 56],
    [sx + 5, yF, 18],
    [sx - 21, yF, 18],
  ];
  const seams = L(k.sideSeam(tower, 10, P, 4), { tone: 'faint' });
  back.push(S(k.slabOf(tower, 4, 58, P, 4, 0.8), { tone: 'mid', inner: seams }));
  back.push(`<path class="iso-shade" data-shade="0" d="${face(screen)}"/>`);
  back.push(L(face(screen), { tone: 'lo' }));
  // the chat: three customer lines (left) and Dellal's three answers (right), lit in turn
  const bubbles = [];
  [
    [-19, -5, 51],
    [-11, 3, 45],
    [-19, -7, 39],
    [-11, 3, 33],
    [-19, -3, 27],
    [-11, 3, 21],
  ].forEach(([a, b, z], i) => {
    const pts = [
      [sx + a, yF, z + 1.3],
      [sx + b, yF, z + 1.3],
      [sx + b, yF, z - 1.3],
      [sx + a, yF, z - 1.3],
    ];
    bubbles.push(`<path class="iso-line pl-bub" data-tone="faint" data-bub="${i}" d="${face(pts)}"/>`);
  });
  back.push(bubbles.join(''));
  // the speaker slots under the screen and the cap
  back.push(L([0, 1, 2].map((i) => k.segment([sx - 13 + i * 4, yF, 14], [sx - 13 + i * 4, yF, 10.5], P)).join(''), { tone: 'lo' }));
  back.push(D([[sx - 13, yF, 14], [sx - 9, yF, 14], [sx - 5, yF, 14], [sx - 13, yF, 10.5], [sx - 9, yF, 10.5], [sx - 5, yF, 10.5]].map(at), { size: 0.35, tone: 'lo' }));
  back.push(S(k.slabOf(k.insetPlan(tower, -1.2), 62, 3, P, 4, 0.6), { tone: 'mid' }));
  back.push(L(k.planOutline(k.insetPlan(tower, 3), 65, P, 4), { tone: 'faint' }));
  // the mast and its light
  const mast = [sx + 4, -50];
  back.push(S(k.cylinder(mast[0], mast[1], 2.6, 65, 2, P, 18), { tone: 'mid' }));
  back.push(S(k.cylinder(mast[0], mast[1], 1.1, 67, 13, P, 12), { tone: 'mid', crease: 'none' }));
  back.push(S(k.cylinder(mast[0], mast[1], 2.1, 80, 2.6, P, 18), { tone: 'hi', className: 'pl-mast' }));
  // the tray of today's chats
  const tray = plan(sx - 24, -20, 40, 30, 2.5);
  back.push(S(k.slabOf(tray, 0, 3, P, 4, 0.5), { tone: 'mid' }));
  back.push(`<path class="iso-shade" data-shade="1" d="${k.planOutline(k.insetPlan(tray, 2.4), 3, P, 3)}"/>`);
  back.push(L(k.planOutline(k.insetPlan(tray, 2.4), 3, P, 3), { tone: 'lo' }));
  const stacks = byDepth([
    [sx - 14, -6],
    [sx - 3, -1],
    [sx + 8, 3],
  ]);
  const order = [];
  stacks.forEach(([x, y], s) => {
    for (let level = 0; level < 5; level++) order.push({ x, y, level, n: level * 3 + s });
  });
  for (const t of order) back.push(`<g data-tok="${t.n}" opacity="0">${token(t.x, t.y, 3 + t.level * TOKEN_H, '')}</g>`);
  return back.join('');
}

/** The night at 02:30: a reading lamp over the book, the finished chats sorted into won and lost, the score dial. */
function nightBack(sx) {
  const out = [];
  const post = [sx - 14, -52];
  out.push(halo(plan(post[0] - 10, post[1] - 10, 20, 20, 10), 0, 5));
  out.push(S(k.cylinder(post[0], post[1], 10, 0, 3, P, 36, 0.6), { tone: 'mid' }));
  out.push(L(k.ring(post[0], post[1], 7.4, 3, P, 36), { tone: 'faint' }));
  out.push(D([0, 1, 2].map((i) => at([post[0] + 8.6 * Math.cos(0.5 + i * 2.09), post[1] + 8.6 * Math.sin(0.5 + i * 2.09), 3])), { size: 0.4, tone: 'lo' }));
  out.push(S(k.cylinder(post[0], post[1], 2.4, 3, 57, P, 18), { tone: 'mid', crease: 'none' }));
  out.push(S(k.cylinder(post[0], post[1], 3.4, 60, 4, P, 20, 0.4), { tone: 'mid' }));
  out.push(L(k.knurl(post[0], post[1], 3.4, 60, 64, 20, P), { tone: 'lo' }));
  out.push(S(k.cylinder(post[0], post[1], 2.4, 64, 32, P, 18), { tone: 'mid', crease: 'none' }));
  // the score dial
  const dial = [sx + 32, -40];
  const g = dialGauge(dial[0], dial[1], 0, 22, 13);
  out.push(halo(plan(dial[0] - 8, dial[1] - 8, 16, 16, 8), 0, 4));
  out.push(g.svg, dialTicks(dial[0], dial[1], g.top, 13, 24, 4, (270 * Math.PI) / 180));
  out.push(L(k.lineOnTop([dial[0] + Math.sin(A0) * 8.6, dial[1] - Math.cos(A0) * 8.6], [dial[0] + Math.sin(A0) * 10.6, dial[1] - Math.cos(A0) * 10.6], g.top, P), { tone: 'hi' }));
  out.push(`<path class="iso-line" data-tone="hi" data-part="score-needle" data-free="start" d="${needle(dial, g.top, 13, 0, 60)}" style="stroke-width:1.1"/>`);
  out.push(D([at([dial[0], dial[1], g.top])], { size: 1.2, tone: 'hi' }));
  // the two trays: won (delivered) and lost (refused or cancelled)
  const won = plan(sx - 30, -30, 26, 22, 2);
  const lost = plan(sx - 1, -30, 24, 22, 2);
  for (const tray of [won, lost]) {
    out.push(S(k.slabOf(tray, 0, 3, P, 4, 0.5), { tone: 'mid' }));
    out.push(`<path class="iso-shade" data-shade="1" d="${k.planOutline(k.insetPlan(tray, 2.2), 3, P, 3)}"/>`);
    out.push(L(k.planOutline(k.insetPlan(tray, 2.2), 3, P, 3), { tone: 'lo' }));
  }
  const stacks = [
    { x: sx - 23, y: -19, n: 4, cls: 'pl-tok-won', key: 'w' },
    { x: sx - 11, y: -19, n: 4, cls: 'pl-tok-won', key: 'w' },
    { x: sx + 5.5, y: -19, n: 3, cls: 'pl-tok-lost', key: 'l' },
    { x: sx + 16, y: -19, n: 2, cls: 'pl-tok-lost', key: 'l' },
  ];
  const count = { w: 0, l: 0 };
  for (const st of byDepth(stacks, (s) => [s.x, s.y])) {
    for (let level = 0; level < st.n; level++) {
      const n = count[st.key]++;
      out.push(`<g data-${st.key === 'w' ? 'won' : 'lost'}="${n}" opacity="0">${token(st.x, st.y, 3 + level * TOKEN_H, st.cls)}</g>`);
    }
  }
  return { svg: out.join(''), dial, dialTop: g.top, post };
}
/** The lamp's arm and head, over the rail: drawn after the carriage. */
function nightOver(sx) {
  const out = [];
  const post = [sx - 14, -52];
  const head = [post[0], BOOK_C[1] - 6];
  out.push(S(k.cylinder(post[0], post[1], 3.8, 96, 5, P, 22, 0.5), { tone: 'mid' }));
  out.push(L(k.knurl(post[0], post[1], 3.8, 96, 101, 22, P), { tone: 'lo' }));
  out.push(S(k.slabOf(plan(post[0] - 2.4, post[1] - 3, 4.8, head[1] - post[1] + 6, 1.4), 97, 3, P, 3, 0.4), { tone: 'mid' }));
  out.push(D([at([post[0], post[1], 101]), at([head[0], head[1], 100])], { size: 0.45, tone: 'hi' }));
  out.push(S(k.cylinder(head[0], head[1], 1.5, 90, 7, P, 12), { tone: 'mid', crease: 'none' }));
  out.push(`<path class="pl-glow" data-part="glow" opacity="0" d="${k.ring(head[0] + 6, BOOK_C[1] - 2, 30, BOOK_TOP, P, 48)}"/>`);
  out.push(S(k.cylinder(head[0], head[1], 10, 81, 9, P, 44, 0.7), { tone: 'mid', inner: L(k.sideArc(head[0], head[1], 10, 84, P, 26), { tone: 'faint' }) }));
  out.push(L(k.ring(head[0], head[1], 6.5, 90, P, 32), { tone: 'faint' }));
  out.push(`<path class="iso-line pl-bulb" data-part="bulb" data-tone="lo" d="${k.sideArc(head[0], head[1], 10, 81, P, 26)}" style="stroke-width:1.3"/>`);
  return out.join('');
}

/** The morning: the coach's stamp press (behind) and the cards of the night's lessons. */
const PRESS = { head: 80, headH: 10, rest: 38, hub: [10.4, -4, 85], lever: 24, up: 62, down: -22 };
function morningBack(sx) {
  const out = [];
  const foot = plan(sx - 16, -62, 32, 30, 3);
  out.push(halo(foot, 0, 6));
  out.push(S(k.slabOf(foot, 0, 8, P, 4, 0.6), { tone: 'mid' }));
  out.push(D([at([sx - 12, -58, 8]), at([sx + 12, -58, 8]), at([sx - 12, -36, 8]), at([sx + 12, -36, 8])], { size: 0.45 }));
  out.push(L([-58, -36].map((y) => k.ring(y === -58 ? sx - 12 : sx + 12, y, 2, 8, P, 12)).join(''), { tone: 'lo' }));
  const column = plan(sx - 10, -56, 20, 16, 2);
  out.push(S(k.slabOf(column, 8, PRESS.head - 8, P, 3, 0.5), { tone: 'mid', inner: L(k.sideSeam(column, 24, P, 3) + k.sideSeam(column, 64, P, 3), { tone: 'faint' }) }));
  // the night's lesson cards waiting in their tray
  const tray = plan(sx + 16, -46, 26, 30, 2);
  out.push(S(k.slabOf(tray, 0, 3, P, 4, 0.5), { tone: 'mid' }));
  out.push(L(k.planOutline(k.insetPlan(tray, 2.2), 3, P, 3), { tone: 'lo' }));
  for (let i = 0; i < 4; i++) {
    const card = plan(sx + 19 - i * 0.5, -43 + i * 0.6, 20, 24, 1);
    const z = 3 + i * 1.1;
    const lines = i === 3 ? L([0, 1, 2].map((j) => k.lineOnTop([card.x + 3, card.y + 5 + j * 5], [card.x + (j === 2 ? 11 : 16), card.y + 5 + j * 5], z + 0.8, P)).join(''), { tone: 'lo', free: true }) : '';
    out.push(`<g data-card="${i}">${S(k.slabOf(card, z, 0.8, P, 2), { tone: 'hi', crease: 'none' })}${lines}</g>`);
  }
  return out.join('');
}
function morningOver(sx) {
  const out = [];
  // painted bottom to top: the stamp (it comes down onto the book) and its inner rod, then the tube and the sleeve the rod
  // slides in, then the head that holds them, the hub and the lever (its rod and knob are drawn live)
  const stamp = plan(sx - 8, BOOK_C[1] - 8, 16, 16, 2);
  const rodTop = PRESS.rest + 8 + 30;
  out.push(
    `<g data-part="stamp">${S(k.slabOf(k.insetPlan(stamp, 1), PRESS.rest, 2, P, 3), { tone: 'lo', crease: 'none' })}${S(k.slabOf(stamp, PRESS.rest + 2, 6, P, 3, 0.5), {
      tone: 'mid',
      inner: L(k.sideSeam(stamp, PRESS.rest + 4.4, P, 3), { tone: 'faint' }),
    })}${S(k.cylinder(sx, BOOK_C[1], 1.7, PRESS.rest + 8, rodTop - PRESS.rest - 8, P, 16), { tone: 'hi', crease: 'none' })}</g>`,
  );
  out.push(S(k.cylinder(sx, BOOK_C[1], 2.7, 52, 20, P, 20, 0.3), { tone: 'mid', inner: L(k.sideArc(sx, BOOK_C[1], 2.7, 62, P, 12), { tone: 'faint' }) }));
  out.push(S(k.cylinder(sx, BOOK_C[1], 5.2, 72, 8, P, 28, 0.5), { tone: 'mid' }));
  const head = plan(sx - 10, -58, 20, BOOK_C[1] - -58 + 7, 3);
  out.push(S(k.slabOf(head, PRESS.head, PRESS.headH, P, 4, 0.7), { tone: 'mid', inner: L(k.sideSeam(head, PRESS.head + 3, P, 4), { tone: 'faint' }) }));
  out.push(D([at([sx - 6, -54, 90]), at([sx + 6, -54, 90]), at([sx - 6, BOOK_C[1] - 1, 90]), at([sx + 6, BOOK_C[1] - 1, 90])], { size: 0.45 }));
  const [hx, hy, hz] = PRESS.hub;
  out.push(`<path class="iso-fill" d="${k.sideRing([sx + hx, hy, hz], 4.4, 'x', P, 24)}"/>`);
  out.push(L(k.sideRing([sx + hx, hy, hz], 4.4, 'x', P, 24), { tone: 'mid' }));
  out.push(L(k.sideRing([sx + hx, hy, hz], 2.2, 'x', P, 16), { tone: 'lo' }));
  out.push(`<path class="iso-line" data-tone="mid" data-part="lever" d="${lever(sx, PRESS.up)}" style="stroke-width:2.4"/>`);
  const end = leverEnd(sx, PRESS.up);
  out.push(`<g data-part="knob">${S(k.cylinder(end[0] + 1.6, end[1], 3.2, end[2] - 3, 6, P, 22), { tone: 'mid' })}${L(k.knurl(end[0] + 1.6, end[1], 3.2, end[2] - 3, end[2] + 3, 22, P), { tone: 'lo' })}</g>`);
  out.push(D([at([sx + hx, hy, hz])], { size: 0.9, tone: 'hi' }));
  return out.join('');
}
const leverEnd = (sx, deg) => {
  const a = (deg * Math.PI) / 180;
  const [hx, hy, hz] = PRESS.hub;
  return [sx + hx + 0.6, hy + Math.cos(a) * PRESS.lever, hz + Math.sin(a) * PRESS.lever];
};
const lever = (sx, deg) => {
  const [hx, hy, hz] = PRESS.hub;
  return k.segment([sx + hx + 0.6, hy, hz], leverEnd(sx, deg), P);
};

/** The test: dial A (the book in service) and dial B (the new book), the day wheel, the flag that rises if B is kept. */
const FLAG = { pole: [38, -58], top: 66, h: 12, w: 17, low: 8 };
function testBack(sx) {
  const out = [];
  const bar = plan(sx - 40, -64, 84, 30, 3);
  out.push(halo(bar, 0, 6));
  out.push(S(k.slabOf(bar, 0, 6, P, 4, 0.6), { tone: 'mid', inner: L(k.sideSeam(bar, 2.4, P, 4), { tone: 'faint' }) }));
  out.push(D(k.corners(bar, 4).map(([x, y]) => at([x, y, 6])), { size: 0.45 }));
  // the flag (back right): pole, base, the cloth that slides
  const [px, py] = [sx + FLAG.pole[0], FLAG.pole[1]];
  out.push(S(k.cylinder(px, py, 3.6, 6, 2.4, P, 20, 0.4), { tone: 'mid' }));
  out.push(S(k.cylinder(px, py, 1.1, 8.4, FLAG.top - 8.4, P, 12), { tone: 'mid', crease: 'none' }));
  out.push(S(k.cylinder(px, py, 1.9, FLAG.top, 1.6, P, 14), { tone: 'mid' }));
  const cloth = plan(px + 1.2, py - 0.5, FLAG.w, 1, 0.3);
  out.push(`<g data-part="flag">${S(k.slabOf(cloth, FLAG.low, FLAG.h, P, 1), { tone: 'mid', className: 'pl-flag' })}${S(k.slabOf(plan(px - 1.7, py - 1.7, 3.4, 3.4, 1.2), FLAG.low + FLAG.h - 3, 3, P, 2), { tone: 'mid' })}</g>`);
  // the two dials
  const dials = {};
  for (const [name, dx] of byDepth([
    ['a', -22],
    ['b', 10],
  ], ([, dx]) => [sx + dx, -50])) {
    const c = [sx + dx, -50];
    const g = dialGauge(c[0], c[1], 6, 22, 13);
    out.push(g.svg, dialTicks(c[0], c[1], g.top, 13, 30, 5, (270 * Math.PI) / 180));
    out.push(`<path class="iso-line" data-tone="hi" data-part="needle-${name}" data-free="start" d="${needle(c, g.top, 13, 0, 30, true)}" style="stroke-width:1.1"/>`);
    out.push(D([at([c[0], c[1], g.top])], { size: 1.2, tone: 'hi' }));
    dials[name] = { c, top: g.top };
  }
  // the day wheel: ten days before a chat counts
  const w = [sx + 32, -42];
  out.push(S(k.cylinder(w[0], w[1], 6.4, 6, 3.4, P, 32, 0.4), { tone: 'hi', crease: 'lo' }));
  const wt = k.radialTicks(w[0], w[1], 5.6, 10, 5, 9.4, [1, 1.8], P, A0, Math.PI * 2);
  out.push(L(wt.minor, { tone: 'lo' }), L(wt.major, { tone: 'mid' }));
  out.push(`<path class="iso-line" data-tone="hi" data-part="days" data-free="start" d="${k.lineOnTop([w[0], w[1]], [w[0] + Math.sin(A0) * 4, w[1] - Math.cos(A0) * 4], 9.4, P)}" style="stroke-width:1"/>`);
  out.push(D([at([w[0], w[1], 9.4])], { size: 0.8, tone: 'hi' }));
  return { svg: out.join(''), dials, wheel: w };
}

/** A needle on a top dial: value v of max, the 270° scale centred on 12 o'clock (or starting at its left end). */
function needle(c, top, r, v, max, fromStart = false) {
  const span = (270 * Math.PI) / 180;
  const a = fromStart ? A0 - span / 2 + (v / max) * span : A0 + (v / max) * (span / 2);
  return k.lineOnTop([c[0] - Math.sin(a) * 2.6, c[1] + Math.cos(a) * 2.6], [c[0] + Math.sin(a) * (r - 3.6), c[1] - Math.cos(a) * (r - 3.6)], top + 0.2, P);
}

// ------------------------------------------------------------------ assemble one reading direction
function build(dir) {
  const xs = XS[dir];
  const st = Object.fromEntries(STEPS.map((s, i) => [s, xs[i]]));
  const night = nightBack(st.night);
  const test = testBack(st.test);
  const back = {
    day: day(st.day),
    night: night.svg,
    morning: morningBack(st.morning),
    test: test.svg,
  };
  const over = { night: nightOver(st.night), morning: morningOver(st.morning) };
  // stations back to front (left to right on this camera), then the rail, the carriage, the parts above the rail
  const stations = [...STEPS].sort((a, b) => st[a] - st[b]);
  const body = [
    base(),
    ...stations.map((s) => `<g data-station="${s}">${back[s]}</g>`),
    rail(),
    `<g data-part="carriage" transform="${k.translateAlong(P, [st.day, 0, 0])}">${carriage()}</g>`,
    ...stations.filter((s) => over[s]).map((s) => `<g data-over="${s}">${over[s]}</g>`),
  ];
  // the words are the page's (the stage carries the label, the steps and the caption say what happens): the picture is hidden from screen readers
  const svg = k.figureSvg({ width: WIDTH, height: HEIGHT, label: '', body, className: 'pl-bench-svg' }).replace(' role="img" aria-label=""', ' aria-hidden="true" focusable="false"');
  const art = {
    dir,
    width: WIDTH,
    height: HEIGHT,
    P,
    a0: A0,
    stations: xs,
    book: { top: BOOK_TOP },
    night: { dial: night.dial, top: night.dialTop, score: NIGHT_SCORE, ...NIGHT },
    press: { x: st.morning, rest: PRESS.rest, drop: PRESS.rest - BOOK_TOP, hub: PRESS.hub, lever: PRESS.lever, up: PRESS.up, down: PRESS.down },
    test: { a: test.dials.a, b: test.dials.b, wheel: test.wheel, values: TEST, flag: { low: FLAG.low, high: FLAG.top - FLAG.h - 1.6 } },
    tokens: { day: 15, won: 8, lost: 5 },
    svg,
  };
  return art;
}

const banner = `// Generated by apps/web/explainers/dellal-learns/build.mjs from the Anatomy kit (MIT): do not edit, run the script.\n`;
mkdirSync(OUT_TS, { recursive: true });
const arts = {};
for (const dir of ['ltr', 'rtl']) {
  const art = build(dir);
  arts[dir] = art;
  const { svg, ...rest } = art;
  const text = `${banner}import type { BenchArt } from './bench';\n\nconst art: BenchArt = { ...${JSON.stringify(rest)}, svg: ${JSON.stringify(svg)} };\nexport default art;\n`;
  writeFileSync(join(OUT_TS, `art-${dir}.ts`), text);
  console.log(`wrote art-${dir}.ts`, (text.length / 1024).toFixed(0), 'KB');
}

// ------------------------------------------------------------------ standalone check pages (Anatomy's capture / lines)
if (process.argv.includes('--page')) {
  const { buildSync } = await import('esbuild');
  const live = buildSync({ entryPoints: [join(OUT_TS, 'bench.ts')], bundle: true, format: 'esm', write: false, target: 'es2022' }).outputFiles[0].text.replace(/^export\s*\{[^}]*\};?\s*$/m, '');
  const css = readFileSync(join(OUT_TS, 'iso.css'), 'utf8') + readFileSync(join(OUT_TS, 'bench.css'), 'utf8');
  const out = join(HERE, 'out');
  mkdirSync(out, { recursive: true });
  const themes = {
    light: '--surface:#FFFFFF;--ink:#1F2633;--muted:#7A808C;--line:#F0E7DC;--ok:#2E7A55;--coral:#C9534B;--bg:#FBF6F0',
    dark: '--surface:#16233A;--ink:#E8EDF5;--muted:#9AA6BC;--line:#2A3A57;--ok:#82D2A9;--coral:#F09C95;--bg:#0F1A2E',
  };
  for (const dir of ['ltr', 'rtl']) {
    for (const theme of ['light', 'dark']) {
      const art = arts[dir];
      const steps = ['THE DAY · Dellal sells', 'THE NIGHT · 02:30 · Pilot AI reads', 'THE MORNING · The coach decides', 'THE TEST · The parcels judge'];
      const html = `<!doctype html><html lang="${dir === 'rtl' ? 'ar' : 'en'}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>How Dellal learns</title><style>
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 system-ui,sans-serif;${themes[theme]}}
main{width:min(820px,100% - 24px);margin:32px auto}${css}</style></head><body><main>
<figure class="iso-figure pl-iso iso" data-theme="${theme}"><div class="iso-plate"><div class="iso-plate-corners" aria-hidden="true"><span class="iso-plate-corner" data-corner="fig">Fig. 1</span><span class="iso-plate-corner" data-corner="title">How Dellal learns</span><span class="iso-plate-corner" data-corner="hint">Click a step · ← →</span><span class="iso-plate-corner" data-corner="readout" data-readout></span></div>
<div class="iso-stage pl-stage-iso" tabindex="0">${art.svg}</div></div>
<div class="pl-bsteps">${steps.map((s, i) => `<button type="button" class="pl-bstep" data-go="${i}">${i + 1} ${s}</button>`).join('')}</div></figure></main>
<script type="module">${live}
const art = ${JSON.stringify({ ...art, svg: undefined })};
const root = document.querySelector('.pl-iso');
const ctl = mountBench(root, art, { onStep: (s) => document.querySelectorAll('[data-go]').forEach((b, i) => b.toggleAttribute('data-on', i === s)), readout: (r) => r.step + ' · lap ' + r.lap + ' · v' + r.v + ' · ' + r.n });
document.querySelectorAll('[data-go]').forEach((b, i) => b.addEventListener('click', () => ctl.go(i)));
window.__bench = ctl;
</script></body></html>`;
      writeFileSync(join(out, `${dir}-${theme}.html`), html);
    }
  }
  console.log('wrote check pages in', out);
}
