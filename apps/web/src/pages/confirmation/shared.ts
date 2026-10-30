import { CONF_TONE, ConfStatus, phoneIntl, Tone } from '@pilotix/shared';
import type { TFunction } from 'i18next';
import { store } from '../../lib/store';
import { toLocalInput } from '../../lib/format';

export type Sub = 'nouvelles' | 'attente' | 'confirmees' | 'livrees' | 'terminees';
/** no Livrées tab in Confirmation (removed on request) */
export const SUBS: Sub[] = ['nouvelles', 'attente', 'confirmees', 'terminees'];
export const SUB_STATUSES: Record<Sub, ConfStatus[]> = {
  nouvelles: ['new'],
  attente: ['to_check', 'no_answer', 'busy', 'callback', 'postponed'],
  confirmees: ['confirmed', 'no_stock'],
  terminees: ['duplicate', 'wrong_number', 'fake'],
  livrees: ['confirmed'],
};
export const SUB_TONE: Record<Sub, Tone> = { nouvelles: 'info', attente: 'mid', confirmees: 'ok', livrees: 'ok', terminees: 'off' };

/** Values of the status pickers: real statuses plus "try1..3" (= no answer, attempt N). */
export type StatusChoice = ConfStatus | `try${number}`;
/** Row pill options, in the original order (try1 = the order's next attempt, « Tentative 0N »). */
export const ROW_CHOICES: StatusChoice[] = ['new', 'to_check', 'try1', 'callback', 'postponed', 'no_stock', 'confirmed', 'cancelled', 'duplicate', 'wrong_number', 'fake'];
/** Toolbar "Statut de confirmation" options. */
/** « Pas de réponse » here: one more call for each order (its own count goes on: never reset to 01). */
export const BULK_CHOICES: StatusChoice[] = ['to_check', 'no_answer', 'callback', 'postponed', 'cancelled', 'duplicate', 'wrong_number', 'fake'];

/** Label of a choice; `pill` adds "…" for choices that ask something and ✓ for confirmed. */
export function choiceLabel(t: TFunction, c: StatusChoice, pill = false): string {
  if (c.startsWith('try')) return t('confirmation.try', { n: c.slice(3).padStart(2, '0') });
  const base = t(`status.conf.${c}`);
  if (!pill) return base;
  return (c === 'confirmed' ? '✓ ' : '') + base + (['callback', 'postponed', 'cancelled', 'confirmed', 'no_stock'].includes(c) ? '…' : '');
}
/** The current status as shown in its pill ("Tentative 02" for no answer). */
export function currentLabel(t: TFunction, s: ConfStatus, attempts: number): string {
  if (s === 'no_answer') return t('confirmation.try', { n: String(Math.max(1, attempts)).padStart(2, '0') });
  return t(`status.conf.${s}`);
}
export const toneOf = (c: StatusChoice): Tone => (c.startsWith('try') ? 'mid' : CONF_TONE[c as ConfStatus] ?? 'off');

/** Default date of a callback (+2 h) or a postponed call (tomorrow 10:00, Algiers). */
export function defaultNext(kind: 'callback' | 'postponed'): string {
  const now = Date.now();
  if (kind === 'callback') return toLocalInput(now + 2 * 3_600_000);
  const tomorrow = toLocalInput(now + 86_400_000).slice(0, 10);
  return `${tomorrow}T10:00`;
}

export const telHref = (p: string) => `tel:${p}`;
export function waHref(phone: string, template: string, vars: { nom: string; boutique: string; ref: string }) {
  const text = template.replace(/\{(nom|boutique|ref)\}/g, (_, k: 'nom' | 'boutique' | 'ref') => vars[k]);
  return `https://wa.me/${phoneIntl(phone)}?text=${encodeURIComponent(text)}`;
}

// ---------------------------------------------------------------- stats filter (shared by the three pages)
export interface Kf {
  per: 'today' | 'yesterday' | '7' | '30' | 'month' | 'custom';
  basis: 'created' | 'updated';
  from: string;
  to: string;
  view: 'conf' | 'deliv';
}
const today = () => toLocalInput(Date.now()).slice(0, 10);
export const loadKf = (): Kf => ({ per: 'today', basis: 'created', from: today(), to: today(), view: 'conf', ...store.json<Partial<Kf>>('conf-kf', {}) });
export const saveKf = (k: Kf) => store.set('conf-kf', JSON.stringify(k));
export const kfInput = (k: Kf) => ({ per: k.per, basis: k.basis, ...(k.per === 'custom' ? { from: k.from, to: k.to } : {}) });
