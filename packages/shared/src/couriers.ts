// Which delivery company a shop's company is (its logo, its card in « API Livraison »): the card it was made from,
// otherwise its kind and the host of its API address. Hosts are compared whole: « rex.ecotrack.dz » is not
// « chronorex.ecotrack.dz ». Used by the server (the control room's counts) and by the app (logos, « connecté »).

/** The host of an API address (« https://api.guepex.app/v1/ » → « api.guepex.app »), '' when there is none. */
export function urlHost(url: unknown): string {
  const s = String(url ?? '')
    .trim()
    .toLowerCase();
  if (!s) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`).hostname;
  } catch {
    return '';
  }
}

/** A host rule: « a,b » = the host is a or b (or one of their sub-domains); « !a,b » = none of these; empty = any. */
export function hostMatches(rule: string | null | undefined, url: unknown): boolean {
  if (!rule) return true;
  const h = urlHost(url);
  const hit = (e: string) => !!h && !!e && (h === e || h.endsWith(`.${e}`));
  const list = (rule.startsWith('!') ? rule.slice(1) : rule).split(',').map((e) => e.trim().toLowerCase());
  return rule.startsWith('!') ? !list.some(hit) : list.some(hit);
}

export interface CourierCardRule {
  id: string;
  kind: string;
  host?: string;
  byCard?: boolean;
}

/** The card of a shop's company: the one it was made from (settings.card), else the first whose kind and host fit. */
export function courierCardOf<C extends CourierCardRule>(cards: readonly C[], co: { kind: string; settings?: unknown }): C | null {
  const st = (co.settings && typeof co.settings === 'object' ? co.settings : {}) as Record<string, unknown>;
  const id = String(st.card ?? '');
  if (id) {
    const c = cards.find((x) => x.id === id && x.kind === co.kind);
    if (c) return c;
  }
  return cards.find((c) => c.kind === co.kind && !c.byCard && hostMatches(c.host, st.base_url)) ?? null;
}
