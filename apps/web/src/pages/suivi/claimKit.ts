// Réclamations: what the computer dialogs and the phone sheets share — who receives the claim, the new-claim form,
// the message to send (WhatsApp / e-mail / copy) and the claim rows.
import type { Order } from '@pilotix/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trackOf } from '../../lib/items';
import { useAction, useRpc } from '../../lib/query';
import { copyText } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { claimText, ClaimCompany } from './common';

export const CLAIM_REASONS = ['relivrer', 'late', 'nocall', 'fakedeliv', 'fakeret', 'address', 'damaged', 'money', 'noreturn', 'other'] as const;
export type Reason = (typeof CLAIM_REASONS)[number];
export type Via = 'whatsapp' | 'email' | 'copy' | 'phone';
export const STATUS_TONE: Record<string, string> = { waiting: 't-warn', still_waiting: 't-bad', resolved: 't-ok' };
export const REASON_ICON: Record<Reason, string> = { relivrer: 'refresh', late: 'clock', nocall: 'phoneoff', fakedeliv: 'package', fakeret: 'undo', address: 'navigation', damaged: 'boxminus', money: 'coins', noreturn: 'truck', other: 'chat' };

export interface Target {
  name: string;
  wa: string | null;
  email: string | null;
  phone: string | null;
}

export interface SentClaim {
  id: number;
  ref: string;
  reason: string;
  details: string;
  viaApi?: boolean;
  extId?: string | null;
  extRef?: string | null;
  extError?: string | null;
  companyName?: string | null;
}

export interface ClaimRow {
  id: number;
  ref: string;
  orderId: number | null;
  orderRef: string | null;
  tracking: string | null;
  companyName: string | null;
  livreurName: string | null;
  livreurPhone: string | null;
  companyId: number | null;
  reason: string;
  details: string;
  status: 'waiting' | 'still_waiting' | 'resolved';
  notes: { at: string; text: string; status?: string | null }[];
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  viaApi: boolean;
  extId: string | null;
  extRef: string | null;
  extStatus: string | null;
  extAnswer: string | null;
  extError: string | null;
}

/** Who receives the claim of an order: its courier's claim desk, or our own livreur. */
export function useTarget(o: Order | null, toLivreur: boolean) {
  const c = useRpc('suivi.contacts', {}).data;
  if (!o || !c) return { target: null as Target | null, shop: c?.shopName ?? '', own: false, api: false, ready: !!c };
  const comp = c.companies.find((x: ClaimCompany) => x.id === o.companyId);
  const own = toLivreur || comp?.kind === 'own';
  if (own) {
    const lv = c.livreurs.find((l: { id: number }) => l.id === o.livreurId);
    return { target: { name: lv?.name ?? o.livreurName ?? '—', wa: lv?.phone ?? null, email: null, phone: lv?.phone ?? null }, shop: c.shopName, own, api: false, ready: true };
  }
  return { target: comp ? { name: comp.name, wa: comp.wa, email: comp.email, phone: comp.phone } : null, shop: c.shopName, own, api: !!comp?.api && !!trackOf(o), ready: true };
}

export interface ClaimFormProps {
  pre?: Order | null;
  toLivreur?: boolean;
  reason?: Reason;
  details?: string;
  onClose: () => void;
}

/** Step 1: the order and the problem → the claim is saved (and created at ZR through its API), or step 2: send it. */
export function useClaimForm({ pre, toLivreur = false, reason = 'late', details = '', onClose }: ClaimFormProps) {
  const { t } = useTranslation();
  const [o, setO] = useState<Order | null>(pre ?? null);
  const [q, setQ] = useState(pre ? trackOf(pre) || pre.ref : '');
  const [deb, setDeb] = useState('');
  const [mot, setMot] = useState<Reason>(reason);
  const [det, setDet] = useState(details);
  const [err, setErr] = useState('');
  const [made, setMade] = useState<SentClaim | null>(null);
  const [cat, setCat] = useState('');
  const { target, shop, own, api, ready } = useTarget(o, toLivreur);
  const cats = useRpc('suivi.claimCategories', { companyId: o?.companyId ?? 0 }, { enabled: api && !!o?.companyId, staleTime: 600_000 });
  useEffect(() => {
    const h = setTimeout(() => setDeb(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);
  const res = useRpc('suivi.findOrders', { q: deb }, { enabled: deb.length >= 2 && !o });
  const create = useAction('suivi.claimCreate', {
    onDone: (c) => {
      if (c.extId) {
        toast(t('suivi.rec.apiSent', { ref: c.ref, name: c.companyName ?? '', n: c.extRef ?? '' }), 'ok');
        onClose();
      } else setMade(c);
    },
  });
  // opened from an alert: the tracking is copied for a courier's desk that asks for it first (not for one taking the
  // claim through its API)
  useEffect(() => {
    if (!ready || !pre || api || toLivreur) return;
    const v = trackOf(pre);
    if (v) copyText(v).then((ok) => ok && toast(t('suivi.rec.copiedTracking', { v }), 'ok'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  const prepare = () => {
    setErr('');
    if (!o) return setErr(t('suivi.rec.chooseOrder'));
    const message = claimText(t, { ref: '…', reason: mot, details: det.trim() }, o, target?.name ?? '', shop);
    create.mutate({ orderId: o.id, reason: mot, details: det.trim(), message, channel: 'whatsapp', toLivreur: own, viaApi: api, categoryId: api && cat ? cat : null });
  };
  return {
    o,
    q,
    deb,
    search: (v: string) => (setQ(v), setO(null)),
    choose: (x: Order) => (setO(x), setQ(x.ref)),
    found: (res.data ?? []) as Order[],
    searching: res.isFetching && !res.data,
    mot,
    setMot,
    det,
    setDet,
    cat,
    setCat,
    cats: (cats.data ?? []) as { id: string; name: string }[],
    catsLoading: cats.isLoading,
    err,
    made,
    target,
    shop,
    own,
    api,
    create,
    prepare,
  };
}

/** Step 2: the message, editable, sent by WhatsApp / e-mail / copy; each way is written in the claim history. */
export function useSendClaim({ claim, order, target, shop, again, onClose }: { claim: SentClaim; order: Order | null; target: Target; shop: string; again: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const push = useAction('suivi.claimPush', {
    onDone: (c) => {
      if (c.extId) {
        toast(t('suivi.rec.apiSent', { ref: c.ref, name: c.companyName ?? '', n: c.extRef ?? '' }), 'ok');
        onClose();
      } else toast(c.extError ?? t('suivi.rec.apiFailed', { name: target.name }), 'bad');
    },
  });
  const [text, setText] = useState(() => claimText(t, claim, order, target.name, shop, again));
  const [done, setDone] = useState(false);
  const upd = useAction('suivi.claimUpdate', { silent: true });
  const mark = (via: Via) => {
    if (done) return;
    setDone(true);
    upd.mutate({ id: claim.id, sentVia: via, message: text }, { onSuccess: () => toast(again ? t('suivi.rec.reminded', { ref: claim.ref }) : t('suivi.rec.sent', { ref: claim.ref, name: target.name }), 'ok') });
  };
  const lines = text.split('\n');
  const mail = target.email ? `mailto:${encodeURIComponent(target.email)}?subject=${encodeURIComponent(lines[1] || 'Réclamation')}&body=${encodeURIComponent(text)}` : null;
  const copy = async () => {
    await copyText(text);
    toast(t('common.copied'), 'ok');
    mark('copy');
  };
  return { push, text, setText, done, mark, mail, copy };
}
