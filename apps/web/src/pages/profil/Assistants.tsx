// Mon profil › Assistants IA: Claude and ChatGPT, each on its card — connected or not, how to connect it, « Couper ».
// An assistant is linked from the assistant itself: the person gives it Pilotix's link there, it sends them back to the
// « Autoriser » page (layout/McpAuthorize), and it then reads as that person in this boutique. « Autoriser » only ever
// gives reading: what a link may change is turned on here, by its person, part by part (« Peut modifier ») — never
// from the assistant's side. « Connecter » shows the link and the steps on the assistant's side, and opens the right
// page of the assistant. Tools on the person's own computer that were linked are listed under the cards.
// Under them, the log (« Journal »): what the assistants did, newest first — the person's own, or, for the boutique's
// administrators, the whole team's.
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { server } from '../../lib/backend';
import { clock, dateOnly, dayLabel, sameDay } from '../../lib/format';
import { useSession } from '../../lib/session';
import { AssistantLogo } from '../../ui/AssistantLogo';
import { copyText, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import '../../layout/mcp.css';

/** The parts of Pilotix a link may change (core mcp-server.ts › MCP_PARTS), in this order. */
const PARTS = ['orders', 'products', 'pages', 'marketing'] as const;
type Part = (typeof PARTS)[number];
/**
 * The parts an assistant can really change today (core mcp-tools.ts has their tools). None yet: the switch is kept, but
 * the card keeps saying « Lecture seule » and the box says the tools come later. Add a part here with its tools.
 */
const READY: readonly Part[] = [];

interface Link {
  id: number;
  client: string;
  host: string;
  scope: string[];
  createdAt: string;
  lastUsedAt: string | null;
  /** the parts it may change; empty: it only reads */
  write: Part[];
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
  const { session } = useSession();
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  // a change made here (a link cut, « Peut modifier »): the log shows it at once
  const [logTick, setLogTick] = useState(0);
  const load = useCallback(() => {
    setFailed(false);
    server
      .request<Data>('/mcp/links')
      .then((r) => setData({ links: (r.links ?? []).map((l) => ({ ...l, write: l.write ?? [] })), link: r.link ?? '' }))
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
  const setWrite = async (l: Link, parts: Part[]) => {
    setBusy(l.id);
    try {
      const r = await server.request<{ write: Part[] }>('/mcp/write', { id: l.id, parts: PARTS.filter((p) => parts.includes(p)) });
      setData((d) => (d ? { ...d, links: d.links.map((x) => (x.id === l.id ? { ...x, write: r.write ?? [] } : x)) } : d));
      setLogTick((n) => n + 1);
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
          <Card key={a.key} a={a} data={data} failed={failed} busy={busy} onCut={cut} onWrite={setWrite} />
        ))}
      </div>
      {others.length > 0 && (
        <section className="card px-pf-card">
          <h2>{t('mcp.others')}</h2>
          <p className="muted">{t('mcp.othersText')}</p>
          <ul className="pxm-links">
            {others.map((l) => (
              <LinkRow key={l.id} l={l} named busy={busy} onCut={cut} onWrite={setWrite} />
            ))}
          </ul>
        </section>
      )}
      <Journal admin={!!session?.isAdmin} tick={logTick} />
    </div>
  );
}

/** One link: since when, last used, « Couper », and what it may change. `named`: with the tool's name and site (the cards name theirs). */
function LinkRow({ l, named, busy, onCut, onWrite }: { l: Link; named?: boolean; busy: number | null; onCut: (l: Link) => void; onWrite: (l: Link, parts: Part[]) => void }) {
  const { t } = useTranslation();
  return (
    <li>
      <div className="pxm-lrow">
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
      </div>
      <WriteBox l={l} busy={busy !== null} onWrite={onWrite} />
    </li>
  );
}

/**
 * « Peut modifier »: off, the link only reads. On, every part is ticked; the person unticks those it must not change
 * (unticking the last one turns it off again). Saved at once.
 */
function WriteBox({ l, busy, onWrite }: { l: Link; busy: boolean; onWrite: (l: Link, parts: Part[]) => void }) {
  const { t } = useTranslation();
  const id = useId();
  const on = l.write.length > 0;
  return (
    <div className={`pxm-write${on ? ' on' : ''}`}>
      <label className="pxm-write-row" htmlFor={id}>
        <span className="pxm-write-t">
          <b>{t('mcp.write')}</b>
          <span className="muted small">{t('mcp.writeHint')}</span>
        </span>
        <input id={id} type="checkbox" role="switch" className="pxm-sw" checked={on} disabled={busy} aria-label={`${t('mcp.write')} · ${l.client}`} onChange={(e) => onWrite(l, e.target.checked ? [...PARTS] : [])} />
      </label>
      {on && (
        <>
          <div className="pxm-parts" role="group" aria-label={`${t('mcp.write')} · ${l.client}`}>
            {PARTS.map((p) => (
              <label key={p} className={l.write.includes(p) ? 'on' : ''}>
                <input type="checkbox" checked={l.write.includes(p)} disabled={busy} onChange={(e) => onWrite(l, e.target.checked ? [...l.write, p] : l.write.filter((x) => x !== p))} />
                <span>{t(`mcp.part.${p}`)}</span>
              </label>
            ))}
          </div>
          {!l.write.some((p) => READY.includes(p)) && <p className="pxm-soon">{t('mcp.writeSoon')}</p>}
        </>
      )}
    </div>
  );
}

function Card({ a, data, failed, busy, onCut, onWrite }: { a: Assistant; data: Data | null; failed: boolean; busy: number | null; onCut: (l: Link) => void; onWrite: (l: Link, parts: Part[]) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const guide = useId();
  const mine = data?.links.filter((l) => (a.hosts as readonly string[]).includes(l.host)) ?? [];
  const on = mine.length > 0;
  const writes = mine.some((l) => l.write.some((p) => READY.includes(p)));
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
                {on ? `${t('mcp.stOn')} · ${writes ? t('mcp.stWrite') : t('mcp.stRead')}` : t('mcp.stOff')}
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
                  <LinkRow key={l.id} l={l} busy={busy} onCut={onCut} onWrite={onWrite} />
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

// ---------------------------------------------------------------- « Journal »: what the assistants did
type Kind = 'read' | 'change' | 'refused' | 'error' | 'setting';
interface LogLine {
  id: number;
  at: string;
  profileId: number;
  /** the person's name (the whole team's log), and whether it is me */
  person: string;
  mine: boolean;
  client: string;
  host: string;
  kind: Kind;
  tool: string;
  detail: { q?: string; ref?: string; phone?: string; from?: string; to?: string; count?: number; parts?: string[]; why?: string };
}
type Filter = 'all' | 'change' | 'refused';
const FILTERS: Filter[] = ['all', 'change', 'refused'];
/** the colour of a line's word: read, changed (or « Peut modifier »), refused, error */
const TONE: Record<Kind, string> = { read: 'r', change: 'c', setting: 'c', refused: 'no', error: 'er' };

/** The lines, one group per day (Algiers' day), newest first as they come. */
function byDay(lines: LogLine[]): LogLine[][] {
  const days: LogLine[][] = [];
  for (const l of lines) {
    const last = days[days.length - 1];
    if (last && sameDay(last[0].at, l.at)) last.push(l);
    else days.push([l]);
  }
  return days;
}

/** A line in plain words: what it did, then what it searched, the period, how many came back. */
function useSentence() {
  const { t, i18n } = useTranslation();
  return (l: LogLine): string => {
    const d = l.detail ?? {};
    if (l.tool === 'write') return d.parts?.length ? t('mcp.log.write', { parts: d.parts.map((p) => t(`mcp.part.${p}`)).join(', ') }) : t('mcp.log.writeOff');
    const key = `mcp.log.${l.tool}`;
    const bits = [i18n.exists(key) ? t(key, { ref: d.ref ?? '', phone: d.phone ?? '' }) : t('mcp.log.other', { tool: l.tool })];
    if (d.q) bits.push(t('mcp.log.q', { q: d.q }));
    if (d.from || d.to) bits.push(d.from && d.to && d.from !== d.to ? `${dateOnly(d.from)} – ${dateOnly(d.to)}` : dateOnly(d.from ?? d.to));
    if (typeof d.count === 'number') bits.push(t('mcp.log.found', { count: d.count }));
    return bits.join(' · ');
  };
}

function Journal({ admin, tick }: { admin: boolean; tick: number }) {
  const { t } = useTranslation();
  const title = useId();
  const sentence = useSentence();
  // the boutique's administrators start with the whole team; everyone else sees their own
  const [team, setTeam] = useState(admin);
  const [filter, setFilter] = useState<Filter>('all');
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [more, setMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const whole = admin && team;
  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      setFailed(false);
      try {
        const r = await server.request<{ lines: LogLine[]; more: boolean }>('/mcp/log', { team: whole, filter, ...(before ? { before } : {}) });
        setLines((cur) => (before && cur ? [...cur, ...(r.lines ?? [])] : (r.lines ?? [])));
        setMore(!!r.more);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    },
    [whole, filter],
  );
  useEffect(() => {
    setLines(null);
    void load();
  }, [load, tick]);
  // back on this tab (after asking the assistant something): what it just did shows
  useEffect(() => {
    const on = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, [load]);

  return (
    <section className="card pxm-log" aria-labelledby={title} aria-busy={loading}>
      <div className="pxm-log-h">
        <div className="pxm-log-t">
          <h2 id={title}>{t('mcp.logTitle')}</h2>
          <p className="muted small">{t('mcp.logText')}</p>
        </div>
        <div className="pxm-log-tools">
          {admin && (
            <div className="pxm-seg" role="group" aria-label={t('mcp.logWho')}>
              <button type="button" className={team ? 'on' : ''} aria-pressed={team} onClick={() => setTeam(true)}>
                {t('mcp.logTeam')}
              </button>
              <button type="button" className={team ? '' : 'on'} aria-pressed={!team} onClick={() => setTeam(false)}>
                {t('mcp.logMe')}
              </button>
            </div>
          )}
          <div className="pxm-fil" role="group" aria-label={t('mcp.logShow')}>
            {FILTERS.map((f) => (
              <button key={f} type="button" className={filter === f ? 'on' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {t(`mcp.logF.${f}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
      {failed && (
        <p className="pxm-cannot" role="alert">
          <Icon name="alert" />
          <span>{t('mcp.logFail')}</span>
          <button type="button" className="btn small" onClick={() => void load()}>
            {t('common.retry')}
          </button>
        </p>
      )}
      {lines === null ? (
        !failed && <span className="pxm-skel" />
      ) : !lines.length ? (
        <p className="muted pxm-log-empty">{t(filter === 'all' ? 'mcp.logEmpty' : 'mcp.logNone')}</p>
      ) : (
        byDay(lines).map((day) => (
          <div key={day[0].id} className="pxm-day-g">
            <h3 className="pxm-day">{dayLabel(day[0].at)}</h3>
            <ul className="pxm-lg">
              {day.map((l) => (
                <li key={l.id} className={`k-${l.kind}`}>
                  <span className="pxm-lg-time">{clock(l.at)}</span>
                  <span className="pxm-lg-who">
                    <AssistantLogo host={l.host} />
                    <span className="pxm-lg-c">{l.client}</span>
                    {whole && <span className="pxm-lg-p">{l.mine ? t('mcp.you') : l.person || '—'}</span>}
                  </span>
                  <span className="pxm-lg-w">
                    {sentence(l)}
                    {l.kind === 'refused' && l.detail?.why && <small>{l.detail.why}</small>}
                  </span>
                  <span className={`pxm-tag ${TONE[l.kind] ?? 'r'}`}>{t(`mcp.tag.${l.kind}`)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {more && lines && (
        <button type="button" className="btn ghost pxm-log-more" disabled={loading} onClick={() => void load(lines[lines.length - 1].id)}>
          {t('mcp.logMore')}
        </button>
      )}
    </section>
  );
}
