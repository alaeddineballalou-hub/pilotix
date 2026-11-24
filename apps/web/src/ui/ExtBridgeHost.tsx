import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, rpc, type ProcName } from '../lib/backend';
import { getSpyScreen, startExtBridge } from '../lib/extBridge';
import { da } from '../lib/format';
import { toast } from './toast';

/** Answers the Pilotix Chrome extension on every page (lib/extBridge): it has no session, this page has. */
export function ExtBridgeHost() {
  const qc = useQueryClient();
  const { t } = useTranslation();
  const tr = useRef(t);
  tr.current = t;
  useEffect(() => {
    const plain = (e: unknown): never => {
      if (e instanceof ApiError && e.status === 401) throw new Error(tr.current('spy.site.loginFirst'));
      throw e;
    };
    return startExtBridge({
      async sitePrice(p) {
        const r = await rpc('spy.sitePrice', { via: 'chrome', url: p.url, price: p.price, oldPrice: p.oldPrice, page: p.text ? { text: p.text } : undefined, ...(getSpyScreen() ?? {}) }).catch(plain);
        void qc.invalidateQueries();
        const t = tr.current;
        const msg =
          p.price !== null
            ? r.saved
              ? t('spy.site.chromeOk', { price: da(p.price), count: r.saved })
              : t('spy.site.chromeNone', { price: da(p.price) })
            : r.saved
              ? t('spy.site.readOk', { count: r.saved })
              : t('spy.site.readNone');
        toast(msg, r.saved ? 'ok' : 'info');
        return r;
      },
      rpc: (name, input) => rpc(name as ProcName, input as never).catch(plain),
    });
  }, [qc]);
  return null;
}
