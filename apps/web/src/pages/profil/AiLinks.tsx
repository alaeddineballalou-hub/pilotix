// Mon profil › Sécurité: the AI assistants (Claude, ChatGPT) linked to my account in this boutique (they were linked
// from the assistant itself, through the « Autoriser » page: layout/McpAuthorize). « Couper » stops one at once.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { inBrowserDemo, server } from '../../lib/backend';
import { dateOnly } from '../../lib/format';
import { toast } from '../../ui/toast';
import '../../layout/mcp.css';

interface Link {
  id: number;
  client: string;
  host: string;
  scope: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export function AiLinks() {
  const { t } = useTranslation();
  const [links, setLinks] = useState<Link[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  // the demo in the browser has no server: nothing can be linked to it
  const demo = inBrowserDemo();
  useEffect(() => {
    if (demo) return;
    let on = true;
    server
      .request<{ links: Link[] }>('/mcp/links')
      .then((r) => on && setLinks(r.links ?? []))
      .catch(() => on && setLinks([]));
    return () => {
      on = false;
    };
  }, [demo]);
  if (demo) return null;
  const cut = async (l: Link) => {
    setBusy(l.id);
    try {
      await server.request('/mcp/cut', { id: l.id });
      setLinks((list) => (list ?? []).filter((x) => x.id !== l.id));
      toast(t('mcp.cutDone'), 'ok');
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="card px-pf-card">
      <h2>{t('mcp.links')}</h2>
      <p className="muted">{t('mcp.linksText')}</p>
      {links === null ? null : !links.length ? (
        <p className="muted small">{t('mcp.noLinks')}</p>
      ) : (
        <ul className="pxm-links">
          {links.map((l) => (
            <li key={l.id}>
              <div>
                <b>
                  {l.client}
                  {l.host && (
                    <>
                      {' · '}
                      <bdi className="ltr">{l.host}</bdi>
                    </>
                  )}
                </b>
                <span className="muted small">
                  {t('mcp.since', { date: dateOnly(l.createdAt) })} · {l.lastUsedAt ? t('mcp.lastUsed', { date: dateOnly(l.lastUsedAt) }) : t('mcp.neverUsed')}
                </span>
              </div>
              <button type="button" className="btn ghost danger" disabled={busy !== null} aria-label={`${t('mcp.cut')} ${l.client}`} onClick={() => void cut(l)}>
                {t('mcp.cut')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
