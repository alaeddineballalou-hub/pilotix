// My screen choices (columns, the column preset in use…), saved with my account so they stay after a reload
// and on every device. A copy in this browser shows them at once while the account copy loads.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useReducer } from 'react';
import { rpc } from './backend';
import { useRpc } from './query';
import { useSession } from './session';
import { store } from './store';
import { toast } from '../ui/toast';

type Ui = Record<string, unknown>;
const QKEY = ['me.ui', {}];

export function useUiPrefs() {
  const qc = useQueryClient();
  const { session } = useSession();
  const local = `ui-${session?.profile.id ?? 0}`;
  const q = useRpc('me.ui', {}, { staleTime: Infinity, enabled: !!session });
  // redraw at once after a change (the cache tells the other screens a moment later)
  const [, redraw] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (q.data) store.set(local, JSON.stringify(q.data));
  }, [q.data, local]);
  const data: Ui = (q.data as Ui | undefined) ?? store.json<Ui>(local, {});
  const set = (key: string, value: unknown) => {
    const next: Ui = { ...((qc.getQueryData(QKEY) as Ui | undefined) ?? store.json<Ui>(local, {})) };
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
    qc.setQueryData(QKEY, next);
    store.set(local, JSON.stringify(next));
    redraw();
    rpc('me.setUi', { key, value: value ?? null }).catch((e) => toast(e.message, 'bad'));
  };
  return { get: <T,>(key: string): T | undefined => data[key] as T | undefined, set, ready: !!q.data };
}
