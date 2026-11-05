// The address the landing pages live at, for the links the app shows and copies.
import { serverUrl } from './backend';
import { useRpc } from './query';

/** their own address (https://go.<domain>) once the server reaches it there, else the app's (as before; the demo too) */
export const usePagesBase = () => useRpc('landing.store', {}, { staleTime: 60_000 }).data?.pagesUrl || serverUrl();
