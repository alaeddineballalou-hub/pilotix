// Courier integration framework — SERVER ONLY entry point.
// The server routes ctx.server.courier(action, args, ctx) here (apps/server/src/core.service.ts → runCourier).
// Core procedures (modules/delivery.ts) never call couriers directly: in the browser preview they simulate instead (./demo.ts).
import type { Ctx } from '../rpc';
import { ADAPTERS } from './adapters';
import { helpers, loadCompany, loadParcels } from './load';
import type { ChangeInput, ClaimInput, CourierApi, CourierCompany, TrackItem } from './types';
import { CourierError, setDeadline } from './util';

export * from './types';
export { ADAPTERS } from './adapters';
export { KINDS, CARDS } from './kinds';
export { checkCourier } from './check';
export { checkChanges, emptyWatchMemory, fieldChanges, watchCouriers, watchMemoryOf, WATCH_ADDRESSES, WATCH_DOCS, WATCH_REPOS } from './watch';
export type { WatchMemory } from './watch';

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

type Args = {
  companyId: number;
  date?: string;
  ids?: number[];
  items?: TrackItem[];
  item?: TrackItem;
  orderId?: number;
  claim?: ClaimInput;
  extIds?: string[];
  extId?: string;
  text?: string;
  /** a pickup bag: its courier id (add, remove, drop) or its number (label) */
  bag?: string;
  change?: ChangeInput;
  /** webhook: the address the courier calls, and the key it sends back */
  url?: string;
  key?: string;
};

/**
 * Entry point used by the server for ctx.server.courier(action, args, ctx).
 * Actions: send {companyId, ids} · track {companyId, items} · label {companyId, item} · cancel {companyId, item} ·
 * fees {companyId} · stopdesks {companyId} · test {companyId} · preview {companyId, orderId} ·
 * claim {companyId, claim} · claimCategories {companyId} · claimStates {companyId, extIds} · claimComment {companyId, extId, text} ·
 * payBalance / payRequests / payments {companyId} · payRequest {companyId, date} · payLines / payAccept {companyId, extId} ·
 * payRequestDate {companyId, extId, date} · payRequestCancel {companyId, extId} ·
 * labels {companyId, items} (one file) · exchange {companyId, orderId, item: the original parcel} ·
 * bagCreate {companyId, items} · bagAdd {companyId, bag, items} · bagRemove {companyId, bag, item} · bags {companyId} ·
 * bagLabel {companyId, bag: its number} · bagDrop {companyId, bag} · parcel {companyId, item} ·
 * change {companyId, orderId, change} · changeStates {companyId, extIds} · changeCancel {companyId, extId} · states / services {companyId} ·
 * webhookOn {companyId, url, key} · webhookOff / webhookGet {companyId, extId} ·
 * askReturn / retry / note {companyId, item, text}.
 */
export async function runCourier(action: string, args: unknown, ctx: Ctx): Promise<unknown> {
  const a = args as Args;
  const c = await loadCompany(ctx.db, a.companyId);
  if (action === 'askReturn' || action === 'retry' || action === 'note') {
    const ad = ADAPTERS[c.kind];
    const f = ad[action];
    if (!f) throw new CourierError(`${c.name} : pas disponible par API avec cette société`);
    setDeadline(60_000);
    await f.call(ad, c, a.item!, a.text ?? '');
    return { ok: true };
  }
  const api = courierApi(c);
  setDeadline(action === 'track' || action === 'fees' ? 240_000 : 120_000);
  switch (action) {
    case 'send':
      return api.send(await loadParcels(ctx.db, a.ids ?? []));
    case 'track':
      return api.track(a.items ?? []);
    case 'label':
      return api.label(a.item!);
    case 'labels': {
      const ad = ADAPTERS[c.kind];
      if (!ad.labels) throw new CourierError(`${c.name} : pas d’étiquettes groupées par API`);
      return ad.labels(c, a.items ?? []);
    }
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
    case 'payRequestDate':
    case 'payRequestCancel':
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
      if (action === 'payRequestDate') {
        if (!pay.requestDate) throw new CourierError(`${c.name} : pas disponible avec cette société`);
        await pay.requestDate(c, a.extId!, a.date!);
        return { ok: true };
      }
      if (action === 'payRequestCancel') {
        if (!pay.requestCancel) throw new CourierError(`${c.name} : pas disponible avec cette société`);
        await pay.requestCancel(c, a.extId!);
        return { ok: true };
      }
      await pay.accept(c, a.extId!);
      return { ok: true };
    }
    case 'exchange': {
      const ad = ADAPTERS[c.kind];
      if (!ad.exchange) throw new CourierError(`${c.name} : pas d’échange par API`);
      const p = (await loadParcels(ctx.db, [a.orderId!]))[0];
      if (!p) throw new CourierError('Commande introuvable');
      return ad.exchange(c, p, a.item!, helpers);
    }
    case 'bagCreate':
    case 'bagAdd':
    case 'bagRemove':
    case 'bags':
    case 'bagLabel':
    case 'bagDrop': {
      const b = ADAPTERS[c.kind].bags;
      if (!b) throw new CourierError(`${c.name} : pas de sacs de ramassage par API`);
      if (action === 'bagCreate') return b.create(c, a.items ?? []);
      if (action === 'bagAdd') return b.add(c, a.bag!, a.items ?? []);
      if (action === 'bags') return b.list(c);
      if (action === 'bagLabel') return b.label(c, a.bag!);
      if (action === 'bagRemove') await b.remove(c, a.bag!, a.item!);
      else await b.drop(c, a.bag!);
      return { ok: true };
    }
    case 'parcel': {
      const ad = ADAPTERS[c.kind];
      if (!ad.parcel) throw new CourierError(`${c.name} : pas de détail du colis par API`);
      return ad.parcel(c, a.item!);
    }
    case 'change': {
      const ad = ADAPTERS[c.kind];
      if (!ad.change) throw new CourierError(`${c.name} : pas de demande de modification par API`);
      const p = a.orderId ? ((await loadParcels(ctx.db, [a.orderId]))[0] ?? null) : null;
      return ad.change(c, a.change!, helpers, p);
    }
    case 'changeStates': {
      const ad = ADAPTERS[c.kind];
      return ad.changeStates ? ad.changeStates(c, a.extIds ?? []) : [];
    }
    case 'changeCancel': {
      const ad = ADAPTERS[c.kind];
      if (!ad.changeCancel) throw new CourierError(`${c.name} : pas disponible avec cette société`);
      await ad.changeCancel(c, a.extId!);
      return { ok: true };
    }
    case 'states': {
      const ad = ADAPTERS[c.kind];
      return ad.states ? ad.states(c) : [];
    }
    case 'services': {
      const ad = ADAPTERS[c.kind];
      return ad.services ? ad.services(c) : [];
    }
    case 'webhookOn':
    case 'webhookOff':
    case 'webhookGet': {
      const w = ADAPTERS[c.kind].webhook;
      if (!w) throw new CourierError(`${c.name} : pas de mises à jour en direct par API`);
      if (action === 'webhookOn') return w.on(c, a.url!, a.key!);
      if (action === 'webhookGet') return w.get(c, a.extId!);
      await w.off(c, a.extId!);
      return { ok: true };
    }
    default:
      throw new CourierError(`Action inconnue : ${action}`);
  }
}

/**
 * Control room: is each courier's API alive? Calls its « test » with made-up keys from this server: an answer that
 * refuses the keys proves the API is up and reached; no answer means the address is wrong or the API is down.
 * No shop data is used and nothing is created at the courier.
 */
export async function probeCouriers(): Promise<{ kind: string; ok: boolean; reached: boolean; message: string; ms: number }[]> {
  const { KINDS: K } = await import('./kinds');
  const out: { kind: string; ok: boolean; reached: boolean; message: string; ms: number }[] = [];
  const kinds = Object.values(K).filter((k) => k.api && k.kind !== 'custom');
  await Promise.all(
    kinds.map(async (k) => {
      const secret: Record<string, string> = {};
      const settings: Record<string, any> = {};
      for (const f of k.fields) {
        if (f.type === 'secret') secret[f.key] = 'pilotix-probe-0000';
        else if (f.default !== undefined) settings[f.key] = f.default;
      }
      const c: CourierCompany = { id: 0, name: k.label, kind: k.kind, secret, settings, statusMap: {}, shop: { name: 'Pilotix', fromWilayaId: 16, fromWilaya: 'Alger' }, cacheKey: `probe-${k.kind}` };
      const t0 = Date.now();
      try {
        const r = await ADAPTERS[k.kind].test(c);
        out.push({ kind: k.kind, ok: true, reached: true, message: r.ok ? 'L’API répond (elle a même accepté de fausses clés : à vérifier avec de vraies clés)' : `L’API répond et refuse les fausses clés, comme prévu (${r.message.slice(0, 160)})`, ms: Date.now() - t0 });
      } catch (e: any) {
        const m = String(e?.message ?? 'Erreur');
        const down = /ne répond pas/.test(m) || e?.status === 502;
        const refused = !down && /refuse|refusé|invalid|unauthori|non autoris|autorisation|pas valide|token|clé/i.test(m);
        out.push({ kind: k.kind, ok: refused, reached: !down, message: down ? m : refused ? `L’API répond et refuse les fausses clés, comme prévu (${m.slice(0, 160)})` : `L’API répond mais pas comme prévu : ${m.slice(0, 200)}`, ms: Date.now() - t0 });
      }
    }),
  );
  return out.sort((x, y) => x.kind.localeCompare(y.kind));
}
