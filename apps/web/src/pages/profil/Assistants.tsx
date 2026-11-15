// Mon profil › Assistants IA: Claude and ChatGPT, each on its card — connected or not, how to connect it, « Couper ».
// An assistant is linked from the assistant itself: the person gives it Pilotix's link there, it sends them back to the
// « Autoriser » page (layout/McpAuthorize), and it then reads as that person in this boutique (nothing is changed).
// « Connecter » shows the link and the steps on the assistant's side, and opens the right page of the assistant.
// Tools on the person's own computer that were linked are listed under the cards.
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { server } from '../../lib/backend';
import { dateOnly } from '../../lib/format';
import { AssistantLogo } from '../../ui/AssistantLogo';
import { copyText, Icon } from '../../ui/kit';
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
interface Data {
  links: Link[];
  /** the address to give an assistant (https://<site>/mcp) */
  link: string;
}

/**
 * The two assistants: the sites their answers come back from (how a link is known to be theirs), the page of theirs
 * that « Ouvrir » opens, and how many steps their guide has (their words are in the locales: mcp.<key>1…n).
 * Claude's page is its own « Add custom connector » window with Pilotix's name and link already filled in (the install
 * link Claude documents); ChatGPT's is its Plugins page, where a custom MCP server is added.
 */
const ASSISTANTS = [
  { key: 'claude', name: 'Claude', site: 'claude.ai', hosts: ['claude.ai', 'claude.com'], steps: 3, open: (link: string) => `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Pilotix&connectorUrl=${encodeURIComponent(link)}` },
  { key: 'chatgpt', name: 'ChatGPT', site: 'chatgpt.com', hosts: ['chatgpt.com'], steps: 4, open: () => 'https://chatgpt.com/plugins' },
] as const;
type Assistant = (typeof ASSISTANTS)[number];
const THEIRS: string[] = ASSISTANTS.flatMap((a) => [...a.hosts]);

export function Assistants() {
  const { t } = useTranslation();
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(() => {
    setFailed(false);
    server
      .request<Data>('/mcp/links')
      .then((r) => setData({ links: r.links ?? [], link: r.link ?? '' }))
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  // back from the assistant's site (another tab): what was just connected shows
  useEffect(() => {
    const on = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [load]);

  const cut = async (l: Link) => {
    setBusy(l.id);
    try {
      await server.request('/mcp/cut', { id: l.id });
      setData((d) => (d ? { ...d, links: d.links.filter((x) => x.id !== l.id) } : d));
      toast(t('mcp.cutDone'), 'ok');
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy(null);
    }
  };
  const others = data?.links.filter((l) => !THEIRS.includes(l.host)) ?? [];
  return (
    <div className="pxm-aip">
      <p className="muted pxm-ai-intro">{t('mcp.aiIntro')}</p>
      {failed && (
        <p className="pxm-cannot" role="alert">
          <Icon name="alert" />
          <span>{t('mcp.loadFail')}</span>
          <button type="button" className="btn small" onClick={load}>
            {t('common.retry')}
          </button>
        </p>
      )}
      <div className="pxm-ai">
        {ASSISTANTS.map((a) => (
          <Card key={a.key} a={a} data={data} failed={failed} busy={busy} onCut={cut} />
        ))}
      </div>
      {others.length > 0 && (
        <section className="card px-pf-card">
          <h2>{t('mcp.others')}</h2>
          <p className="muted">{t('mcp.othersText')}</p>
          <ul className="pxm-links">
            {others.map((l) => (
              <LinkRow key={l.id} l={l} named busy={busy} onCut={cut} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** One link: since when, last used, « Couper ». `named`: with the tool's name and where it answers (the cards name theirs). */
function LinkRow({ l, named, busy, onCut }: { l: Link; named?: boolean; busy: number | null; onCut: (l: Link) => void }) {
  const { t } = useTranslation();
  return (
    <li>
      <div>
        {named && (
          <b>
            {l.client}
            {l.host && (
              <>
                {' · '}
                <bdi className="ltr">{l.host}</bdi>
              </>
            )}
          </b>
        )}
        <span className="muted small">
          {t('mcp.since', { date: dateOnly(l.createdAt) })} · {l.lastUsedAt ? t('mcp.lastUsed', { date: dateOnly(l.lastUsedAt) }) : t('mcp.neverUsed')}
        </span>
      </div>
      <button type="button" className="btn ghost danger" disabled={busy !== null} aria-label={`${t('mcp.cut')} ${l.client}`} onClick={() => onCut(l)}>
        <Icon name="unlink" />
        {t('mcp.cut')}
      </button>
    </li>
  );
}

function Card({ a, data, failed, busy, onCut }: { a: Assistant; data: Data | null; failed: boolean; busy: number | null; onCut: (l: Link) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const guide = useId();
  const mine = data?.links.filter((l) => (a.hosts as readonly string[]).includes(l.host)) ?? [];
  const on = mine.length > 0;
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <section className="card pxm-ai-card" aria-labelledby={`${guide}-t`}>
      <AssistantLogo host={a.site} size="big" />
      <h2 id={`${guide}-t`}>{a.name}</h2>
      <p className="muted">{t('mcp.aiDesc', { name: a.name })}</p>
      {/* its links could not be read: the message above the cards says so, nothing to show here */}
      {(data || !failed) && (
      <div className="pxm-ai-foot" aria-busy={!data}>
        {!data ? (
          <span className="pxm-skel" />
        ) : (
          <>
            <div className="pxm-ai-row">
              <span className={`pxm-st${on ? ' on' : ''}`}>
                {on && <Icon name="checkcircle" />}
                {on ? `${t('mcp.stOn')} · ${t('mcp.stRead')}` : t('mcp.stOff')}
              </span>
              {/* not connected yet: the card's one action; its guide open: « Ouvrir … » below is */}
              {!on && (
                <button type="button" className={`btn${open ? '' : ' primary'}`} aria-expanded={open} aria-controls={guide} onClick={() => setOpen((v) => !v)}>
                  {open ? t('common.close') : t('mcp.connect')}
                </button>
              )}
            </div>
            {on && (
              <ul className="pxm-links">
                {mine.map((l) => (
                  <LinkRow key={l.id} l={l} busy={busy} onCut={onCut} />
                ))}
              </ul>
            )}
            {on && (
              <button type="button" className="btn ghost pxm-more" aria-expanded={open} aria-controls={guide} onClick={() => setOpen((v) => !v)}>
                <Icon name={open ? 'x' : 'plus'} />
                {open ? t('common.close') : t('mcp.connectMore')}
              </button>
            )}
            {open && (
              <div className="pxm-guide" id={guide}>
                <label className="pxm-link">
                  <span>{t('mcp.linkLabel', { name: a.name })}</span>
                  <span className="pxm-link-in">
                    <input type="text" readOnly dir="ltr" value={data.link} onFocus={(e) => e.currentTarget.select()} />
                    <button type="button" className="btn" onClick={async () => (await copyText(data.link)) && setCopied(true)}>
                      <Icon name={copied ? 'check' : 'copy'} />
                      <span role="status">{copied ? t('common.copied') : t('common.copy')}</span>
                    </button>
                  </span>
                </label>
                <ol className="pxm-steps">
                  {Array.from({ length: a.steps }, (_, i) => (
                    <li key={i}>{t(`mcp.${a.key}${i + 1}`)}</li>
                  ))}
                </ol>
                <p className="muted small">{t(`mcp.${a.key}Note`)}</p>
                <a className="btn primary pxm-open" href={a.open(data.link)} target="_blank" rel="noopener noreferrer">
                  {t('mcp.openIn', { name: a.name })}
                  <Icon name="external" />
                </a>
              </div>
            )}
          </>
        )}
      </div>
      )}
    </section>
  );
}
