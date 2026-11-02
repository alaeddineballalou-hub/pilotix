// The few projection helpers the live bench needs, from the Anatomy kit (github.com/wheresryan22/anatomy, kit/iso-kit.ts,
// MIT, see apps/web/explainers/kit/LICENSE): the same camera as the picture made by explainers/dellal-learns/build.mjs.
export type Projection = { origin: number[]; scale: number; azimuth: number; elevation: number };
export type Pt = [number, number];
export type P3 = [number, number, number];

const UNIT = Math.sqrt(1.6);
const RAD = Math.PI / 180;

function camera(p: Projection) {
  const a = p.azimuth * RAD;
  const e = p.elevation * RAD;
  return { sinA: Math.sin(a), cosA: Math.cos(a), sinE: Math.sin(e), cosE: Math.cos(e), k: p.scale * UNIT };
}

export function iso([x, y, z]: P3, p: Projection): Pt {
  const { sinA, cosA, sinE, cosE, k } = camera(p);
  return [p.origin[0] + (x * sinA - y * cosA) * k, p.origin[1] + ((x * cosA + y * sinA) * sinE - z * cosE) * k];
}

const tenth = (v: number) => {
  const s = (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return s === '-0' ? '0' : s;
};
export const pathOf = (points: Pt[]) => points.map(([x, y], i) => `${i ? 'L' : 'M'}${tenth(x)} ${tenth(y)}`).join('');
export const lineOnTop = (from: Pt, to: Pt, z: number, p: Projection) => pathOf([iso([from[0], from[1], z], p), iso([to[0], to[1], z], p)]);
export const segment = (a: P3, b: P3, p: Projection) => pathOf([iso(a, p), iso(b, p)]);

/** The screen move of a world move (a part built once at rest, then slid). */
export function translateAlong(p: Projection, by: P3): string {
  const o = iso([0, 0, 0], p);
  const m = iso(by, p);
  const f = (v: number) => Math.round(v * 100) / 100;
  return `translate(${f(m[0] - o[0])} ${f(m[1] - o[1])})`;
}
