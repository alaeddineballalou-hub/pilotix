// A confirmation agency's sellers (the picker at the top of its space) and the work they give it.
import type { AgencyTask } from '@pilotix/shared';
import { useRpcFor } from './query';
import { useSeller } from './seller';

/** The person's sellers, the one chosen (null: all of them), and the tasks there (all of them: any seller's). */
export function useSellers(enabled = true) {
  const seller = useSeller();
  const q = useRpcFor(null, 'agency.sellers', {}, { staleTime: 60_000, refetchInterval: 120_000, enabled });
  const list = q.data ?? [];
  const one = seller === 'all' ? null : (list.find((s) => s.id === seller) ?? null);
  const tasks = new Set<AgencyTask>((one ? [one] : list).flatMap((s) => s.tasks));
  return { seller, list, one, tasks, loaded: !!q.data };
}

// ---------------------------------------------------------------- a seller's boutiques together
/** The seller who owns a store (their Pilotix account): a seller with several boutiques has one link per boutique. */
export type Owner = { id: number; name: string };

/** The items of the same seller together, in the order of the list (a group starts where its first item was). */
export function ownerGroups<T>(list: T[], ownerOf: (x: T) => Owner | null | undefined): { owner: Owner | null; items: T[] }[] {
  const groups: { owner: Owner | null; items: T[] }[] = [];
  const at = new Map<number, number>();
  for (const x of list) {
    const o = ownerOf(x) ?? null;
    const i = o ? at.get(o.id) : undefined;
    if (i !== undefined) {
      groups[i].items.push(x);
      continue;
    }
    if (o) at.set(o.id, groups.length);
    groups.push({ owner: o, items: [x] });
  }
  return groups;
}

/** A table's rows with a seller's boutiques together: a head row (their numbers added up), then each boutique (sub). */
export type OwnerRow<T> = { head: true; owner: Owner; items: T[] } | { head: false; item: T; sub: boolean };
export function ownerRows<T>(list: T[], ownerOf: (x: T) => Owner | null | undefined): OwnerRow<T>[] {
  return ownerGroups(list, ownerOf).flatMap((g): OwnerRow<T>[] =>
    g.owner && g.items.length > 1
      ? [{ head: true, owner: g.owner, items: g.items }, ...g.items.map((item) => ({ head: false as const, item, sub: true }))]
      : g.items.map((item) => ({ head: false as const, item, sub: false })),
  );
}
