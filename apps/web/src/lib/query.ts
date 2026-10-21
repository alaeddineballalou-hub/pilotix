import { keepPreviousData, useMutation, useQuery, useQueryClient, UseQueryOptions } from '@tanstack/react-query';
import { In, Out, ProcName, rpc } from './backend';
import { toast } from '../ui/toast';

/** Reads data with an action, cached and refreshed (and refreshed on live updates). */
export function useRpc<N extends ProcName>(name: N, input: In<N>, opts: Partial<UseQueryOptions<Out<N>, Error>> = {}) {
  return useQuery<Out<N>, Error>({
    queryKey: [name, input],
    queryFn: () => rpc(name, input),
    placeholderData: keepPreviousData,
    ...opts,
  });
}

/**
 * Runs a changing action, then refreshes everything on screen.
 * Shows `success` as a toast when given; errors are shown as a toast too.
 */
export function useAction<N extends ProcName>(name: N, opts: { success?: string | ((r: Out<N>) => string); silent?: boolean; onDone?: (r: Out<N>) => void } = {}) {
  const qc = useQueryClient();
  return useMutation<Out<N>, Error, In<N>>({
    mutationFn: (input) => rpc(name, input),
    onSuccess: (r) => {
      qc.invalidateQueries();
      if (opts.success) toast(typeof opts.success === 'function' ? opts.success(r) : opts.success, 'ok');
      opts.onDone?.(r);
    },
    onError: (e) => {
      if (!opts.silent) toast(e.message, 'bad');
    },
  });
}
