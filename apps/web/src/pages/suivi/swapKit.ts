// Swap: what the computer dialogs and the phone sheets share — choosing the order that receives a cancelled parcel,
// then copying, field by field, what its courier must change.
import type { Order } from '@pilotix/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { wilayaName } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { copyText } from '../../ui/kit';
import { toast } from '../../ui/toast';

export type Cand = Order & { sameWilaya: boolean; sameVariant: boolean; sameProduct: boolean };
export type SwapResult = { from: Order; to: Order; oldTracking: string | null; oldTotal: number; wasPrepared?: boolean; companyKind: string | null };

/** The suggested orders (same product, not shipped yet), a search for another one, the choice and the swap. */
export function useSwapPick(o: Order, onDone: (r: SwapResult) => void) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [deb, setDeb] = useState('');
  const [pick, setPick] = useState<Cand | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setDeb(q.trim()), 350);
    return () => clearTimeout(h);
  }, [q]);
  const sug = useRpc('suivi.swapCandidates', { fromId: o.id });
  const found = useRpc('suivi.swapCandidates', { fromId: o.id, q: deb }, { enabled: deb.length >= 2 });
  const swap = useAction('suivi.swap', { onDone: (r) => onDone(r as SwapResult) });
  return {
    q,
    setQ,
    deb,
    pick,
    choose: (x: Cand) => (setPick(x), setErr('')),
    err,
    sug,
    sugRows: (sug.data?.rows ?? []) as Cand[],
    found,
    foundRows: (found.data?.rows ?? []) as Cand[],
    swap,
    submit: () => (pick ? swap.mutate({ fromId: o.id, toId: pick.id }) : setErr(t('suivi.swapM.pick'))),
  };
}

/** "Copier pour ZR": every field copied one by one; the window closes once everything required is copied. */
export function useCopyFields({ to, oldTracking, companyKind }: SwapResult, quiet = false) {
  const { t } = useTranslation();
  const own = companyKind === 'own' || !to.companyName;
  const fields: [string, string, boolean][] = (
    [
      ['old', oldTracking || '', true],
      ['name', to.customerName || '', true],
      ['phone', to.phone || '', true],
      ['phone2', to.phone2 || '', false],
      ['wilaya', to.wilayaId ? wilayaName(to.wilayaId) : '', false],
      ['commune', to.commune || '', false],
      ['total', String(Math.round(to.total)), true],
    ] as [string, string, boolean][]
  ).filter(([, v, req]) => req || v);
  const need = fields.filter(([, v, req]) => req && v).length;
  const [done, setDone] = useState<Set<string>>(new Set());
  const refs = useRef<Record<string, HTMLInputElement | null>>({});
  const count = fields.filter(([k, , req]) => req && done.has(k)).length;
  const mark = (k: string) => setDone((s) => new Set(s).add(k));
  const copyOne = async (k: string, v: string) => {
    if (await copyText(v)) {
      mark(k);
      // the phone's button says « Copié » itself
      if (!quiet) toast(t('suivi.sheet.copiedVal', { v }), 'ok');
    } else {
      refs.current[k]?.focus();
      refs.current[k]?.select();
      toast(t('suivi.sheet.selected'), 'info');
    }
  };
  return { own, who: own ? t('suivi.theLivreur') : to.companyName!, fields, need, done, count, all: count >= need, mark, copyOne, refs };
}
