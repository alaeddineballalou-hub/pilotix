// A phone being typed (sign-up, « Votre numéro », a team member): its problem shown under the field at once — not a
// mobile (as soon as it is long enough), already another account's, already someone of the team — or nothing.
import { normalizeAccountPhone } from '@pilotix/shared';
import { useEffect, useState } from 'react';

export type PhoneProblem = 'invalid' | 'taken' | 'team' | null;

export function usePhoneProblem(phone: string, remote?: (normalized: string) => Promise<{ problem: PhoneProblem }>): { problem: PhoneProblem; checking: boolean } {
  const [problem, setProblem] = useState<PhoneProblem>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const raw = phone.trim();
    const digits = raw.replace(/\D/g, '').length;
    const p = normalizeAccountPhone(raw);
    // still typing: nothing to say yet
    if (!p) {
      setChecking(false);
      setProblem(digits >= 10 || (digits >= 9 && !raw.startsWith('0') && !raw.startsWith('+')) ? 'invalid' : null);
      return;
    }
    setProblem(null);
    if (!remote) return;
    let live = true;
    setChecking(true);
    const id = window.setTimeout(() => {
      remote(p)
        .then((r) => live && setProblem(r.problem))
        .catch(() => live && setProblem(null))
        .finally(() => live && setChecking(false));
    }, 400);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
    // the check function changes on every render: only the number matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone]);
  return { problem, checking };
}
