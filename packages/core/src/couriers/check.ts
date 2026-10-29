// SERVER ONLY. Control room › Sociétés de livraison › « Tester »: one company's API checked with the team's real keys,
// step by step: connection, prices, offices, tracking — and on demand a real test parcel created, its label, its
// status, then cancelled (as a draft: never validated nor sent for pickup). Nothing is saved in any shop.
import type { CourierKind } from '@pilotix/shared';
import { ADAPTERS } from './adapters';
import { KINDS } from './kinds';
import { helpers } from './load';
import type { CourierCompany, Parcel } from './types';
import { setDeadline } from './util';

export interface CheckStep {
  step: string;
  /** null = not available with this company (skipped) */
  ok: boolean | null;
  ms: number;
  detail: string;
}

/** the courier refused, could not be reached, or asked to wait: a real failure (not « this parcel does not exist ») */
const hardFail = (m: string) => /refuse les clés|ne répond pas|trop de demandes|Clés API manquantes|Mettez l’adresse/i.test(m);

/** The parcel of the full test: obviously a test, cheap, to Alger Centre, cancelled right after. */
function testParcel(): Parcel {
  return {
    id: 0,
    ref: `TEST-PILOTIX-${Date.now().toString(36).toUpperCase()}`,
    customer_name: 'TEST PILOTIX NE PAS LIVRER',
    phone: '0550000000',
    phone2: null,
    wilaya_id: 16,
    wilaya: 'Alger',
    wilaya_ar: 'الجزائر',
    commune: 'Alger Centre',
    address: 'Test Pilotix - ne pas livrer',
    is_stopdesk: false,
    stopdesk_ext_id: null,
    stopdesk_name: null,
    stopdesk_commune: null,
    stopdesk_wilaya_id: null,
    total: 1000,
    subtotal: 1000,
    delivery_fee: 0,
    products: '1 × Test Pilotix (ne pas livrer)',
    items: [{ name: 'Test Pilotix (ne pas livrer)', sku: null, price: 1000, qty: 1 }],
    pieces: 1,
    weight: 1,
    delivery_note: 'TEST PILOTIX - NE PAS LIVRER - colis annulé automatiquement',
    is_exchange: false,
    tracking: null,
    ext_id: null,
  };
}

export async function checkCourier(
  kind: CourierKind,
  secret: Record<string, string>,
  settings: Record<string, unknown>,
  opts: { deep?: boolean; name?: string } = {},
): Promise<{ ok: boolean; steps: CheckStep[] }> {
  const info = KINDS[kind];
  const a = ADAPTERS[kind];
  if (!info?.api || !a) throw new Error(`Pas d’API pour ce type de société : ${kind}`);
  const defaults: Record<string, unknown> = {};
  for (const f of info.fields) if (f.type !== 'secret' && f.default !== undefined && f.default !== '') defaults[f.key] = f.default;
  const c: CourierCompany = {
    id: 0,
    name: opts.name || info.label,
    kind,
    secret,
    settings: { ...defaults, ...settings },
    statusMap: {},
    shop: { name: 'Pilotix (test)', fromWilayaId: 16, fromWilaya: 'Alger' },
    cacheKey: `check:${kind}:${String(settings.base_url ?? '')}:${Object.values(secret).join('|').length}`,
  };
  const steps: CheckStep[] = [];
  const run = async (step: string, fn: () => Promise<{ ok: boolean | null; detail: string }>, budget = 45_000) => {
    const t0 = Date.now();
    setDeadline(budget);
    try {
      const r = await fn();
      steps.push({ step, ok: r.ok, ms: Date.now() - t0, detail: r.detail });
    } catch (e: any) {
      steps.push({ step, ok: false, ms: Date.now() - t0, detail: String(e?.message ?? e).slice(0, 400) });
    }
  };
  const skip = (step: string, detail: string) => steps.push({ step, ok: null, ms: 0, detail });

  await run('connection', async () => {
    const r = await a.test(c);
    return { ok: r.ok, detail: r.message };
  });
  const connected = steps[0]?.ok === true;

  if (!a.fees) skip('fees', 'Pas d’API des tarifs chez cette société');
  else if (!connected) skip('fees', 'Pas testé : la connexion a échoué');
  else
    await run(
      'fees',
      async () => {
        const rows = await a.fees!(c);
        const priced = rows.filter((r) => r.home || r.desk).length;
        return { ok: priced > 0, detail: priced ? `${priced} wilayas avec un tarif` : 'Aucun tarif reçu' };
      },
      25_000,
    );

  if (!a.stopdesks) skip('desks', 'Pas de liste des bureaux par API chez cette société');
  else if (!connected) skip('desks', 'Pas testé : la connexion a échoué');
  else
    await run('desks', async () => {
      const list = await a.stopdesks!(c);
      return { ok: list.length > 0, detail: list.length ? `${list.length} bureaux` : 'Aucun bureau reçu' };
    });

  if (!connected) skip('tracking', 'Pas testé : la connexion a échoué');
  else
    await run('tracking', async () => {
      // a number that does not exist: the address answers (« unknown parcel ») without refusing the keys
      try {
        const r = await a.track(c, [{ id: 1, tracking: 'PILOTIX-TEST-0', extId: null }]);
        const one = r[0];
        return { ok: true, detail: one?.error ? `Répond (colis inconnu, normal) : ${one.error}` : 'Répond' };
      } catch (e: any) {
        const m = String(e?.message ?? e);
        if (hardFail(m)) throw e;
        return { ok: true, detail: `Répond (colis inconnu, normal) : ${m.slice(0, 200)}` };
      }
    });

  if (!opts.deep) {
    skip('parcel', 'Test complet non demandé (création + annulation d’un vrai colis)');
  } else if (!connected) {
    skip('parcel', 'Pas testé : la connexion a échoué');
  } else if (!info.cancel || !a.cancel) {
    skip('parcel', 'Pas d’annulation par API chez cette société : pas de colis de test (il resterait chez elle)');
  } else if (kind === 'near') {
    skip('parcel', 'Near livre seulement en point relais : pas de colis de test');
  } else {
    // a draft only: never validated, never asked for pickup, then cancelled
    const draft: CourierCompany = { ...c, settings: { ...c.settings, validate: false, ask_collection: false } };
    let made: { tracking: string; extId: string | null } | null = null;
    await run('parcel', async () => {
      const r = await a.create(draft, testParcel(), helpers);
      made = { tracking: r.tracking, extId: r.extId };
      return { ok: true, detail: `Colis de test créé : ${r.tracking}` };
    });
    const item = made as { tracking: string; extId: string | null } | null;
    if (item) {
      if (a.label)
        await run('label', async () => {
          const l = await a.label!(draft, { id: 0, ...item });
          return { ok: !!(l?.url || l?.pdf), detail: l?.url ? 'Étiquette (lien)' : l?.pdf ? 'Étiquette (PDF)' : 'Pas d’étiquette reçue' };
        });
      else skip('label', 'Pas d’étiquette par API chez cette société');
      await run('status', async () => {
        const r = await a.track(draft, [{ id: 0, ...item }]);
        return { ok: !!r[0]?.status, detail: r[0]?.status ? `Statut chez la société : ${r[0].status}` : r[0]?.error ?? 'Pas encore de statut' };
      });
      await run('cancel', async () => {
        await a.cancel!(draft, { id: 0, ...item });
        return { ok: true, detail: `Colis de test ${item.tracking} annulé` };
      });
      if (steps.at(-1)?.ok === false) steps[steps.length - 1].detail += ` — annulez le colis ${item.tracking} vous-même chez la société`;
    }
  }
  return { ok: steps.every((s) => s.ok !== false), steps };
}
