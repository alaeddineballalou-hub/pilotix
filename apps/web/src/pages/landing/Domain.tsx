// Landing pages › Réglages › « Liens des pages » (design 5 « Une seule carte », chosen 20 Nov 2026): one card for where the
// pages live — the shop's own domain (it writes it, points it to the server at its registrar, Pilotix checks; HTTPS comes
// by itself), the address its links use (its own domain by default once it is ready, or Pilotix's: core
// modules/pagelinks.ts) and the store's part of Pilotix's address.
import { isCloudflareIp } from '@pilotix/shared';
import { useQueryClient } from '@tanstack/react-query';
import { KeyboardEvent, ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { backend, domainCheck, domainGet, domainSet, DomainState, rpc, serverUrl } from '../../lib/backend';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Field, Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';

type Use = 'own' | 'pilotix';

/** `store`: the store-name field of the settings form, given the label to show (it saves with the form). */
export function PageLinks({ store }: { store: (label: string) => ReactNode }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const qc = useQueryClient();
  const admin = !!session?.isAdmin;
  // the domain itself: a shop of the platform, its administrator (the demo shows a sample, kept in the browser)
  const canDomain = admin && (backend.kind === 'demo' || (backend.kind === 'remote' && !!session?.shop && !session.shop.demo));
  const links = useRpc('landing.store', {}, { staleTime: 60_000 });
  const [d, setD] = useState<DomainState | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<string[] | null>(null);
  const [proofSeen, setProofSeen] = useState<boolean | null>(null);
  /** the HTTPS test of « Vérifier » (through the domain, Cloudflare or not): why it failed, to say what to fix */
  const [reach, setReach] = useState<{ ok: boolean; why?: string } | null>(null);
  // the choice just clicked, shown at once while it saves
  const [picked, setPicked] = useState<Use | null>(null);
  useEffect(() => {
    if (!canDomain) return;
    domainGet()
      .then((r) => (setD(r), setValue(r.domain ?? '')))
      .catch(() => setD(null));
  }, [canDomain]);

  const l = links.data;
  const domain = canDomain ? d?.domain ?? null : l?.own?.domain ?? null;
  const status = canDomain ? d?.status ?? 'none' : l?.own?.status ?? 'none';
  const live = l?.own?.live ?? true;
  const choice: Use = picked ?? l?.choice ?? 'own';
  const usesOwn = !!domain && status === 'ok' && live && choice === 'own';
  // Pilotix's pages address (go.<domain>); the demo shows the real one
  const pxBase = (l?.pagesUrl || serverUrl() || (backend.kind === 'demo' ? 'https://go.pilotix.online' : location.origin)).replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const page = l?.sample || t('landing.links.page');
  const ownExample = `${domain}/${page}`;
  const pxExample = `${pxBase}/${l?.store ?? '…'}/${page}`;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      toast(e?.message || t('common.error'), 'bad');
    } finally {
      setBusy(false);
    }
  };
  /** every screen's links follow at once (the pages' list, the editors…) */
  const refreshLinks = () => qc.invalidateQueries({ queryKey: ['landing.store'] });
  const save = (v: string | null) =>
    run(async () => {
      const r = await domainSet(v);
      setD((x) => ({ ...x!, ...r }));
      setValue(r.domain ?? '');
      setFound(null);
      setProofSeen(null);
      setReach(null);
      await refreshLinks();
      toast(r.status === 'ok' ? t('landing.domain.ready') : r.domain ? t('landing.domain.saved') : t('landing.domain.removed'), 'ok');
    });
  const check = () =>
    run(async () => {
      const r = await domainCheck();
      setFound(r.found);
      setProofSeen(r.proof ?? null);
      setReach(r.https === undefined ? null : { ok: r.https, why: r.why });
      setD((x) => ({ ...x!, status: r.ok ? 'ok' : 'pending' }));
      await refreshLinks();
      toast(r.ok ? t('landing.domain.ready') : t('landing.domain.notYet'), r.ok ? 'ok' : 'bad');
    });
  const pick = (u: Use) => {
    if (!admin || busy || u === choice) return;
    setPicked(u);
    void run(async () => {
      try {
        await rpc('landing.links.set', { use: u });
        await refreshLinks();
        toast(t('landing.links.saved', { address: u === 'own' && domain ? domain : pxBase }), 'ok');
      } finally {
        setPicked(null);
      }
    });
  };

  // the card's state, on its title
  const chip = !l ? null : usesOwn ? { cls: 'lp-on', text: domain! } : { cls: domain && choice === 'own' ? 'lp-warn' : '', text: pxBase };
  const state: { cls: string; icon: string; text: string } = usesOwn
    ? { cls: 'ok', icon: 'check', text: t('landing.links.nowOwn', { domain }) }
    : choice === 'pilotix'
      ? { cls: '', icon: 'globe', text: t('landing.links.nowPilotix', { pilotix: pxBase }) }
      : status !== 'ok'
        ? { cls: 'warn', icon: 'alert', text: t('landing.links.waiting', { domain, pilotix: pxBase }) }
        : { cls: 'warn', icon: 'alert', text: t('landing.links.down', { domain, pilotix: pxBase }) };
  const ips = d?.ips?.length ? d.ips : ['—'];
  /** behind Cloudflare's orange cloud the domain shows Cloudflare's addresses: normal (in Cloudflare, the A line keeps the table's) */
  const viaCloudflare = !!found?.length && found.every(isCloudflareIp);
  const enter = (e: KeyboardEvent<HTMLInputElement>) => {
    // inside the settings form: Enter saves the domain, never the whole form
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (d && value && value !== d.domain && !busy) save(value);
  };

  return (
    <section className="card lp-links">
      <h2 className="lp-links-h">
        <Icon name="link" /> {t('landing.set.link')}
        {chip && <span className={`chip ltr ${chip.cls}`}>{chip.text}</span>}
      </h2>
      <p className="pd-note">{canDomain || domain ? t('landing.links.help') : t('landing.set.linkHelp')}</p>

      {canDomain && d && (
        <>
          <Field label={t('landing.links.domain')} hint={d.domain ? undefined : t('landing.domain.hint')}>
            <div className="lp-dom-row">
              <div className="lp-dom-box">
                <input className="ltr" value={value} placeholder="www.ma-boutique.com" maxLength={253} onKeyDown={enter} onChange={(e) => setValue(e.target.value.trim().toLowerCase())} />
                {d.domain && value === d.domain && <span className={`chip ${d.status === 'ok' ? 'lp-on' : 'lp-warn'}`}>{d.status === 'ok' ? t('landing.domain.ok') : t('landing.domain.pending')}</span>}
              </div>
              {value !== (d.domain ?? '') && (
                <button type="button" className="btn small primary" disabled={busy || !value} onClick={() => save(value)}>
                  {t('common.save')}
                </button>
              )}
              {d.domain && (
                <button type="button" className="btn small ghost danger" disabled={busy} onClick={() => window.confirm(t('landing.domain.removeAsk')) && save(null)}>
                  {t('landing.domain.remove')}
                </button>
              )}
            </div>
          </Field>
          {!d.domain && <p className="pd-note">{t('landing.domain.help')}</p>}
          {d.domain && d.status !== 'ok' && (
            <div className="lp-dom-how">
              <b>{t('landing.domain.how')}</b>
              <table className="lp-dom-table">
                <thead>
                  <tr>
                    <th>{t('landing.domain.type')}</th>
                    <th>{t('landing.domain.name')}</th>
                    <th>{t('landing.domain.value')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ips.map((ip) => (
                    <tr key={ip}>
                      <td className="ltr">A</td>
                      <td className="ltr">{d.domain!.split('.').length > 2 ? d.domain!.split('.')[0] : '@'}</td>
                      <td className="ltr">{ip}</td>
                    </tr>
                  ))}
                  {/* the proof that this domain is the shop's (every shop's domain points to the same server) */}
                  {d.proof && (
                    <tr>
                      <td className="ltr">TXT</td>
                      <td className="ltr">{d.proof.name.slice(0, d.proof.name.length - d.domain!.length - 1) || '@'}</td>
                      <td className="ltr" style={{ wordBreak: 'break-all' }}>
                        {d.proof.value}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              <small>{t('landing.domain.howHelp')}</small>
              {d.proof && <small>{t('landing.domain.proofHelp')}</small>}
              {found && <small className="ltr">{t('landing.domain.found', { ips: found.join(', ') || '—' })}</small>}
              {viaCloudflare && <small>{t('landing.domain.proxied')}</small>}
              {proofSeen === false && <small>{t('landing.domain.proofMissing')}</small>}
              {reach && !reach.ok && reach.why && <small>{t(`landing.domain.https.${reach.why}`, { domain: d.domain })}</small>}
              <button type="button" className="btn small" disabled={busy} onClick={check}>
                <Icon name="refresh" /> {t('landing.domain.check')}
              </button>
            </div>
          )}
        </>
      )}

      {domain && (
        <div className="lp-addr">
          <span className="lp-addr-h" id="lp-addr-h">
            {t('landing.links.address')}
          </span>
          <div className="lp-addr-list" role="radiogroup" aria-labelledby="lp-addr-h">
            {(['own', 'pilotix'] as Use[]).map((k) => (
              <label key={k} className={`lp-level lp-addr-opt ${choice === k ? 'on' : ''} ${admin ? '' : 'ro'}`}>
                <input type="radio" name="lp-addr" checked={choice === k} disabled={!admin || busy} onChange={() => pick(k)} />
                <span className="lp-radio" aria-hidden="true" />
                <span className="lp-addr-txt">
                  <b>
                    {k === 'own' ? t('landing.links.own') : t('landing.links.pilotix')}
                    {k === 'own' && <span className="chip lp-reco">{t('landing.set.recommended')}</span>}
                  </b>
                  <small className="ltr">{k === 'own' ? ownExample : pxExample}</small>
                </span>
              </label>
            ))}
          </div>
          <p className={`lp-addr-state ${state.cls}`} role="status">
            <Icon name={state.icon} /> <span>{state.text}</span>
          </p>
          <p className="lp-addr-note">
            <Icon name="refresh" /> <span>{t('landing.links.fallback', { domain, pilotix: pxBase })}</span>
          </p>
        </div>
      )}

      {store(domain ? t('landing.links.storeOnly', { pilotix: pxBase }) : t('landing.set.storeSlug'))}
    </section>
  );
}
