// The 20 designs of the sign-in and sign-up pages (the control room turns each one on or off; every visit draws one of
// those turned on, at random). A design is the picture beside the form ("split": a panel on one side) or behind it
// ("overlay": the whole page, the form in a card). The pictures are drawn here in CSS (authThemes.css), no images. A
// split picture is drawn on a fixed stage that is scaled to its panel, so it looks the same on a computer and, smaller,
// above the form on a phone.
import { ReactElement, ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEMO_ONLY, signupInfo } from '../lib/backend';
import './authThemes.css';
import n01 from './login/n01';
import n02 from './login/n02';
import n03 from './login/n03';
import n04 from './login/n04';
import n05 from './login/n05';
import n06 from './login/n06';
import n07 from './login/n07';
import n08 from './login/n08';
import n09 from './login/n09';
import n10 from './login/n10';
import n11 from './login/n11';
import n12 from './login/n12';
import n13 from './login/n13';
import n14 from './login/n14';
import n15 from './login/n15';
import n16 from './login/n16';
import n17 from './login/n17';
import n18 from './login/n18';
import n19 from './login/n19';
import n20 from './login/n20';

export type ThemeLayout = 'split' | 'overlay';
export interface AuthTheme {
  id: number;
  layout: ThemeLayout;
  /** split: the picture's side (start = before the form). overlay: where the card sits */
  side: 'start' | 'end' | 'center';
  /** the form card on a dark ground (overlay) */
  dark?: boolean;
  /** the panel's colour (split) */
  panel?: string;
  /** a light picture on the panel (split): the panel's text is dark */
  light?: boolean;
  Visual: (p: { t: T }) => ReactElement;
  /** overlay: words beside the card on a computer */
  Copy?: (p: { t: T }) => ReactElement;
}
type T = (k: string, o?: Record<string, unknown>) => string;

/** The number of designs. */
export const THEME_COUNT = 20;
const ALL = Array.from({ length: THEME_COUNT }, (_, i) => i + 1);
const LOCAL = 'px-login-designs';

/** The designs turned on: the server's list (the control room), or in the preview the one kept on this computer. */
export function localDesigns(): number[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL) || 'null');
    return Array.isArray(v) && v.length ? v.filter((n) => Number.isInteger(n) && n >= 1 && n <= THEME_COUNT) : null;
  } catch {
    return null;
  }
}
export function saveLocalDesigns(list: number[]) {
  try {
    localStorage.setItem(LOCAL, JSON.stringify(list));
  } catch {
    /* private window: the list lasts until the page closes */
  }
}

// one design per page load (the same one while the person goes between sign-in, sign-up and « mot de passe oublié »)
let drawn: number | null = null;
const draw = (list: number[]) => list[Math.floor(Math.random() * list.length)] ?? 1;

/** The design of this visit: drawn once among those turned on (the last known list first, the server's when it answers). */
export function useAuthTheme(): AuthTheme {
  const [id, setId] = useState<number>(() => {
    if (drawn === null) drawn = draw(localDesigns() ?? ALL);
    return drawn;
  });
  useLayoutEffect(() => {
    if (DEMO_ONLY) return;
    let on = true;
    signupInfo().then((r) => {
      if (!on || !r.designs?.length) return;
      saveLocalDesigns(r.designs);
      if (!r.designs.includes(drawn ?? 0)) {
        drawn = draw(r.designs);
        setId(drawn);
      }
    });
    return () => {
      on = false;
    };
  }, []);
  return THEMES.find((x) => x.id === id) ?? THEMES[0];
}

/** The words of the pictures (a plain function: what the designs need). */
function useT(): T {
  const { t } = useTranslation();
  return (k, o) => String(t(k, o as any));
}

/** A fixed drawing (w × h) scaled to fill its box: the same picture on any screen. */
function Stage({ w, h, children }: { w: number; h: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [s, setS] = useState(0.8);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) setS(Math.min(r.width / w, r.height / h, 1.3));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h]);
  return (
    <div ref={box} className="pxt-stagebox">
      <div className="pxt-stage" style={{ width: w, height: h, transform: `translate(-50%, -50%) scale(${s})` }}>
        {children}
      </div>
    </div>
  );
}

/** The split panel of a design: its colour and its picture. */
export function ThemePanel({ theme }: { theme: AuthTheme }) {
  const t = useT();
  return (
    <aside className={`pxt-vis ${theme.light ? 'pxt-vis-light' : ''}`} style={{ background: theme.panel }} aria-hidden="true">
      <Stage w={560} h={620}>
        <theme.Visual t={t} />
      </Stage>
    </aside>
  );
}

/** The whole-page ground of an overlay design, and its words. */
export function ThemeGround({ theme }: { theme: AuthTheme }) {
  const t = useT();
  return (
    <>
      <div className="pxt-bg" aria-hidden="true">
        <theme.Visual t={t} />
      </div>
      {theme.Copy && (
        <div className="pxt-copy">
          <theme.Copy t={t} />
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- the 20 designs (layout/login/nNN.tsx, one selling idea each)
type Def = Omit<AuthTheme, 'id'>;
/** A design with its own words: its keys live under auth.nNN in the locales. */
const own = (id: number, d: Def): AuthTheme => {
  const pre = `auth.n${String(id).padStart(2, '0')}.`;
  const wrap = (C: Def['Visual']) => ({ t }: { t: T }) => C({ t: (k, o) => t(pre + k, o) });
  return { ...d, id, Visual: wrap(d.Visual), Copy: d.Copy && wrap(d.Copy) };
};
export const THEMES: AuthTheme[] = [n01, n02, n03, n04, n05, n06, n07, n08, n09, n10, n11, n12, n13, n14, n15, n16, n17, n18, n19, n20].map((d, i) => own(i + 1, d as Def));
