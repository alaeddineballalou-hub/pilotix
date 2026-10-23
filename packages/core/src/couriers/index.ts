// Courier integration framework — SERVER ONLY entry point.
// The server routes ctx.server.courier(action, args, ctx) here (apps/server/src/core.service.ts → runCourier).
// Core procedures (modules/delivery.ts) never call couriers directly: in the browser preview they simulate instead (./demo.ts).
import type { Ctx } from '../rpc';
import { ADAPTERS } from './adapters';
import { helpers, loadCompany, loadParcels } from './load';
import type { ClaimInput, CourierApi, CourierCompany, TrackItem } from './types';
import { CourierError, setDeadline } from './util';

export * from './types';
export { ADAPTERS } from './adapters';
export { KINDS, CARDS } from './kinds';

/** The common API of one connected company (spec: send, track, label, cancel, fees, stopdesks, test). */
export function courierApi(c: CourierCompany): CourierApi {
  const a = ADAPTERS[c.kind];
  if (!a) throw new CourierError(`Type de société inconnu : ${c.kind}`);
  const need = <K extends keyof typeof a>(k: K) => {
    const f = a[k];
    if (!f) throw new CourierError(`${c.name} : pas disponible avec cette société`);
    return f as NonNullable<(typeof a)[K]>;
  };
  return {
    async send(orders) {
      const out = [];
      for (const p of orders) {
        try {
          out.push({ id: p.id, ok: true as const, ...(await a.create(c, p, helpers)) });
        } catch (e: any) {
          out.push({ id: p.id, ok: false as const, error: e?.message ?? 'Erreur' });
          if (e?.status === 429 || String(e?.message).includes('refuse les clés')) {
            // keys refused or rate limited: no use trying the others now
            for (const q of orders.slice(orders.indexOf(p) + 1)) out.push({ id: q.id, ok: false as const, error: e.message });
            break;
          }
        }
      }
      return out;
    },
    track: (items) => a.track(c, items),
    label: (it) => need('label').call(a, c, it),
    cancel: (it) => need('cancel').call(a, c, it),
    fees: () => need('fees').call(a, c),
    stopdesks: () => need('stopdesks').call(a, c),
    test: () => a.test(c),
  };
}

type Args = { companyId: number; date?: string; ids?: number[]; items?: TrackItem[]; item?: TrackItem; orderId?: number; claim?: ClaimInput; extIds?: string[]; extId?: string; text?: string };

/**
 * Entry point used by the server for ctx.server.courier(action, args, ctx).
 * Actions: send {companyId, ids} · track {companyId, items} · label {companyId, item} · cancel {companyId, item} ·
 * fees {companyId} · stopdesks {companyId} · test {companyId} · preview {companyId, orderId} ·
 * claim {companyId, claim} · claimCategories {companyId} · claimStates {companyId, extIds} · claimComment {companyId, extId, text} ·
 * payBalance / payRequests / payments {companyId} · payRequest {companyId, date} · payLines / payAccept {companyId, extId}.
 */
export async function runCourier(action: string, args: unknown, ctx: Ctx): Promise<unknown> {
  const a = args as Args;
  const c = await loadCompany(ctx.db, a.companyId);
  const api = courierApi(c);
  setDeadline(action === 'track' || action === 'fees' ? 240_000 : 120_000);
  switch (action) {
    case 'send':
      return api.send(await loadParcels(ctx.db, a.ids ?? []));
    case 'track':
      return api.track(a.items ?? []);
    case 'label':
      return api.label(a.item!);
    case 'cancel':
      await api.cancel(a.item!);
      return { ok: true };
    case 'fees':
      return api.fees();
    case 'stopdesks':
      return api.stopdesks();
    case 'test':
      return api.test();
    case 'claim': {
      const ad = ADAPTERS[c.kind];
      if (!ad.claim) throw new CourierError(`${c.name} : pas de réclamation par API`);
      return ad.claim(c, a.claim!);
    }
    case 'claimCategories': {
      const ad = ADAPTERS[c.kind];
      return ad.claimCategories ? ad.claimCategories(c) : [];
    }
    case 'claimComment': {
      const ad = ADAPTERS[c.kind];
      if (!ad.claimComment) throw new CourierError(`${c.name} : pas de relance par API`);
      await ad.claimComment(c, a.extId!, a.text ?? '');
      return { ok: true };
    }
    case 'claimStates': {
      const ad = ADAPTERS[c.kind];
      return ad.claimStates ? ad.claimStates(c, a.extIds ?? []) : [];
    }
    case 'preview': {
      const p = (await loadParcels(ctx.db, [a.orderId!]))[0];
      const ad = ADAPTERS[c.kind];
      return ad.preview ? ad.preview(c, p) : null;
    }
    case 'payBalance':
    case 'payRequests':
    case 'payRequest':
    case 'payments':
    case 'payLines':
    case 'payAccept': {
      const pay = ADAPTERS[c.kind].payments;
      if (!pay) throw new CourierError(`${c.name} : pas de paiements par API`);
      if (action === 'payBalance') return pay.balance(c);
      if (action === 'payRequests') return pay.requests(c);
      if (action === 'payRequest') return pay.request(c, a.date!);
      if (action === 'payments') return pay.list(c);
      if (action === 'payLines') return pay.lines(c, a.extId!);
      await pay.accept(c, a.extId!);
      return { ok: true };
    }
    default:
      throw new CourierError(`Action inconnue : ${action}`);
  }
}
