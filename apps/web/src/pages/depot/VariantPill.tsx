// The variant of a pick card in a pill of its colour (PhonePrep, and « Toutes les boutiques » › Dépôt): the picker takes
// by colour.
import type { VariantLook } from '@pilotix/shared';
import type { CSSProperties } from 'react';

type Look = { look: VariantLook; variant: string };

/** What the picker reads first: the colour (and size), or the size, or the other values; '' = a product without variants. */
export function bigOf(r: Look): string {
  const l = r.look;
  return [l.color?.name, l.size, ...l.other].filter(Boolean).join(' · ') || r.variant;
}
/** How light a colour is (0 black … 1 white, WCAG relative luminance). */
function lum(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
/** Black or white words on a colour: the one that reads best (WCAG contrast with white vs our ink). */
const inkOn = (hex: string): 'dark' | 'light' => (1.05 / (lum(hex) + 0.05) >= (lum(hex) + 0.05) / 0.074 ? 'light' : 'dark');
/** The variant in a pill of its colour (a size, or a colour we do not know: a plain pill). */
export function VariantPill({ r }: { r: Look }) {
  const hex = r.look.color?.hex ?? null;
  return (
    <span className={`pk-var${hex ? ` has ${inkOn(hex)}` : ''}${hex && lum(hex) > 0.75 ? ' edge' : ''}`} style={hex ? ({ '--sw': hex } as CSSProperties) : undefined}>
      {bigOf(r)}
    </span>
  );
}
