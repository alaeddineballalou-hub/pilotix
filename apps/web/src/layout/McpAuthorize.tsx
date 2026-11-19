// « Autoriser »: an AI assistant (Claude, ChatGPT) asks to be linked to the person's Pilotix (lib/mcpAsk: the address
// carries its question). The page says who asks and where the answer goes, in whose name and in which boutique it will
// read, what it will read, and that it changes nothing: changing is never given from here, only afterwards by the person
// in Mon profil › Assistants IA (« Peut modifier »). « Autoriser » / « Refuser » send the browser back to the
// assistant's site with the answer. The link is cut later in Mon profil › Assistants IA.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, server, StoreChoice } from '../lib/backend';
import { dropMcpTicket } from '../lib/mcpAsk';
import { useSession } from '../lib/session';
import { AssistantLogo } from '../ui/AssistantLogo';
import { Icon } from '../ui/kit';
import { toast } from '../ui/toast';
import { AuthShell, AuthTitle } from './AuthShell';
import './mcp.css';

interface Ask {
  client: string;
  host: string;
  site: 'known' | 'local';
  scope: string[];
  expiresIn: number;
  cannot: 'partner' | 'demo' | 'locked' | null;
}
type State = { at: 'loading' } | { at: 'ok'; ask: Ask } | { at: 'gone'; text: string };

/** The sign-in page, when an assistant sent the person here: why they are asked to sign in (the question comes after). */
export function McpLoginNote() {
  const { t } = useTranslation();
  return (
    <p className="pxm-first" role="status">
      <Icon name="link" />
      <span>{t('mcp.loginFirst')}</span>
    </p>
  );
}

export function McpAuthorize({ ticket }: { ticket: string }) {
  const { t } = useTranslation();
  const { session, switchStore } = useSession();
  const shopId = session?.shop?.id;
  const [state, setState] = useState<State>({ at: 'loading' });
  const [stores, setStores] = useState<StoreChoice[]>([]);
  const [busy, setBusy] = useState<'yes' | 'no' | 'shop' | null>(null);

  // the question, read again when the boutique changes (what can be linked depends on it)
  useEffect(() => {
    let on = true;
    setState({ at: 'loading' });
    server
      .request<Ask>('/mcp/ask', { ticket })
      .then((ask) => on && setState({ at: 'ok', ask }))
      .catch((e) => on && setState({ at: 'gone', text: e instanceof ApiError && e.status === 400 ? '' : (e?.message ?? '') }));
    return () => {
      on = false;
    };
  }, [ticket, shopId]);
  // the person's other boutiques (an assistant is linked to one of them)
  useEffect(() => {
    let on = true;
    server
      .stores()
      .then((list) => on && setStores(list.filter((s) => (s.kind ?? 'store') === 'store' && !s.locked)))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, []);

  const answer = async (allow: boolean) => {
    if (busy) return;
    setBusy(allow ? 'yes' : 'no');
    try {
      const r = await server.request<{ redirect: string }>('/mcp/answer', { ticket, allow });
      const to = new URL(r.redirect);
      if (to.protocol !== 'https:' && to.protocol !== 'http:') throw new Error(t('common.error'));
      // this page leaves the history: « back » from the assistant's site does not ask again
      dropMcpTicket(true);
      window.location.assign(to.toString());
    } catch (e: any) {
      setBusy(null);
      if (e instanceof ApiError && e.status === 400) setState({ at: 'gone', text: '' });
      else toast(e?.message ?? t('common.error'), 'bad');
    }
  };
  const change = async (id: number) => {
    if (busy || id === shopId) return;
    setBusy('shop');
    try {
      await switchStore(id);
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
    } finally {
      setBusy(null);
    }
  };

  if (state.at === 'gone')
    return (
      <AuthShell plain>
        <AuthTitle a={t('mcp.gone')} sub={state.text || t('mcp.goneText')} />
        <button type="button" className="btn big primary" onClick={() => dropMcpTicket()}>
          {t('mcp.back')}
        </button>
      </AuthShell>
    );

  const ask = state.at === 'ok' ? state.ask : null;
  const me = session!.profile;
  const roles = session!.isAdmin ? ['admin'] : session!.profile.roles;
  const shopName = session!.shop?.name ?? '';
  const others = stores.filter((s) => s.id !== shopId);
  return (
    <AuthShell plain>
      <AuthTitle a={t('mcp.title')} b={ask?.client} sub={ask ? t('mcp.sub', { client: ask.client }) : t('mcp.loading')} />
      <dl className="pxm-who" aria-busy={!ask}>
        <div>
          <dt>{t('mcp.who')}</dt>
          <dd>
            {ask ? (
              <span className="pxm-asst">
                <AssistantLogo host={ask.host} />
                <span className="pxm-asst-t">
                  <b>{ask.client}</b>
                  <span className={`pxm-site${ask.site === 'local' ? ' warn' : ''}`}>
                    <Icon name={ask.site === 'known' ? 'checkcircle' : 'alert'} />
                    <span>
                      {ask.site === 'known' ? t('mcp.siteKnown') : t('mcp.siteLocal')} <bdi className="ltr">{ask.host}</bdi>
                    </span>
                  </span>
                </span>
              </span>
            ) : (
              <span className="pxm-skel" />
            )}
          </dd>
        </div>
        <div>
          <dt>{t('mcp.me')}</dt>
          <dd>
            <b>{me.name}</b>
            <span className="pxm-roles">
              {roles.map((r) => (
                <span key={r} className="chip">
                  {t(`roles.${r}`)}
                </span>
              ))}
            </span>
          </dd>
        </div>
        <div>
          <dt>{t('mcp.shop')}</dt>
          <dd>
            {others.length ? (
              <select className="pxm-shop" value={shopId} disabled={!!busy} aria-label={t('mcp.shop')} onChange={(e) => void change(Number(e.target.value))}>
                {!stores.some((s) => s.id === shopId) && <option value={shopId}>{shopName}</option>}
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            ) : (
              <b>{shopName}</b>
            )}
          </dd>
        </div>
      </dl>
      {ask?.cannot ? (
        <p className="pxm-cannot" role="alert">
          <Icon name="alert" />
          <span>{t(ask.cannot === 'demo' ? 'mcp.cannotDemo' : ask.cannot === 'locked' ? 'mcp.cannotLocked' : 'mcp.cannotPartner')}</span>
        </p>
      ) : (
        <section className="pxm-can" aria-labelledby="pxm-can-t">
          <h2 id="pxm-can-t">{t('mcp.canTitle')}</h2>
          <ul>
            {(['can1', 'can2', 'can3', 'can4'] as const).map((k) => (
              <li key={k}>
                <Icon name="check" />
                <span>{t(`mcp.${k}`)}</span>
              </li>
            ))}
          </ul>
          <p className="pxm-lock">
            <Icon name="lock" />
            <span>
              <b>{t('mcp.readOnly')}</b> {t('mcp.asYou')}
            </span>
          </p>
          {/* changing is never given here: only by the person, afterwards, in Mon profil › Assistants IA */}
          <p className="pxm-later">
            <Icon name="pencil" />
            <span>
              <b>{t('mcp.laterTitle')}</b> {t('mcp.laterText', { client: ask?.client || t('mcp.who') })}
            </span>
          </p>
        </section>
      )}
      {ask?.site === 'local' && !ask.cannot && (
        <p className="pxm-cannot" role="note">
          <Icon name="alert" />
          <span>{t('mcp.localWarn')}</span>
        </p>
      )}
      <div className="pxm-acts">
        <button type="button" className="btn big" disabled={!ask || !!busy} onClick={() => void answer(false)}>
          {t('mcp.deny')}
        </button>
        <button type="button" className="btn big primary" disabled={!ask || !!ask.cannot || !!busy} aria-busy={busy === 'yes'} onClick={() => void answer(true)}>
          {busy === 'yes' ? t('mcp.allowing') : t('mcp.allow')}
        </button>
      </div>
      {/* nothing to accept: no advice. A tool on this computer: its warning above already says when to accept */}
      {!ask?.cannot && <p className="pxa-note pxm-care">{ask?.site === 'local' ? t('mcp.cutLater') : `${t('mcp.careful')} ${t('mcp.cutLater')}`}</p>}
    </AuthShell>
  );
}
