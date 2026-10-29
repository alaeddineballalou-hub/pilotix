// Variant colours by name: shops type « Vert », « Bleu ciel », « أحمر », « Black »… The picking cards paint the
// variant's colour big, so the picker takes the right one at a glance.

const NAMED: [RegExp, string][] = [
  [/^(noir|black|اسود)/, '#1F1F1F'],
  [/^(blanc|white|ابيض)/, '#FFFFFF'],
  [/^(bleu ciel|ciel|sky|bleu clair|light blue|سماوي)/, '#64B5F6'],
  [/^(bleu marine|marine|navy|كحلي)/, '#1B2A4A'],
  [/^(bleu|blue|ازرق)/, '#1E63D6'],
  [/^(rouge|red|احمر)/, '#E53935'],
  [/^(rose|pink|وردي|زهري)/, '#F06292'],
  [/^(fuchsia|fushia|fuschia)/, '#E91E8C'],
  [/^(vert olive|olive|زيتي)/, '#7A7F3A'],
  [/^(vert|green|اخضر)/, '#2E9D4F'],
  [/^(gris|grey|gray|رمادي)/, '#9E9E9E'],
  [/^(beige|بيج)/, '#E3CBA8'],
  [/^(creme|ivoire|ivory|cream|كريمي)/, '#F5EBD7'],
  [/^(camel|caramel)/, '#C19A6B'],
  [/^(marron|brown|chocolat|بني)/, '#8D5A3B'],
  [/^(mauve|lilas|lavande|lavender|موف)/, '#B39DDB'],
  [/^(violet|purple|بنفسجي)/, '#8E44AD'],
  [/^(jaune|yellow|اصفر)/, '#FDD835'],
  [/^(orange|برتقالي)/, '#FB8C00'],
  [/^(bordeaux|burgundy|عنابي)/, '#7B1E2B'],
  [/^(kaki|khaki|كاكي)/, '#8A8B5C'],
  [/^(turquoise|فيروزي)/, '#26C6DA'],
  [/^(corail|coral)/, '#FF7F50'],
  [/^(saumon|salmon)/, '#FA8072'],
  [/^(or|dore|gold|ذهبي)(\s|$)/, '#D4AF37'],
  [/^(argent|argente|silver|فضي)/, '#C0C0C0'],
];

/** « Bleu ciel » → '#64B5F6'; a name that is not a colour → null. Accents, case and Arabic hamza do not matter. */
export function colorHex(name: string): string | null {
  const s = String(name ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .toLowerCase()
    .trim();
  if (!s) return null;
  for (const [re, hex] of NAMED) if (re.test(s)) return hex;
  return null;
}

export interface VariantLook {
  /** the variant's colour (its name as typed, and the colour to paint; hex null: a name we do not know) */
  color: { name: string; hex: string | null } | null;
  /** its size (Taille, Pointure, Âge…) */
  size: string | null;
  /** the other values (Modèle…) */
  other: string[];
}

/**
 * What a variant looks like, from its name (« Vert / 12 pouces ») and the product's options (Couleur, Taille…, in the
 * same order). Without options, a value that is a known colour is the colour.
 */
export function variantLook(title: string, options: { name: string }[] = []): VariantLook {
  const parts = String(title ?? '')
    .split(' / ')
    .map((s) => s.trim())
    .filter(Boolean);
  const colorAt = options.findIndex((o) => /couleur|color|colour|لون/i.test(o.name));
  const sizeAt = options.findIndex((o) => /taille|size|pointure|age|âge|مقاس|قياس|العمر/i.test(o.name));
  let color: VariantLook['color'] = null;
  let size: string | null = null;
  const other: string[] = [];
  parts.forEach((p, i) => {
    if (!color && (i === colorAt || (colorAt < 0 && colorHex(p)))) color = { name: p, hex: colorHex(p) };
    else if (!size && i === sizeAt) size = p;
    else other.push(p);
  });
  return { color, size, other };
}
