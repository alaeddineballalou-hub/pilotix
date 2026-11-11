// Menu « Referral »: › Referral (#/parrainage: other shops invited to Pilotix — the store's code and link, the stores it
// brought, the free months; the store's administrators only) and › Code promo (#/parrainage/codes: the welcome codes
// sent by a fixed rule to the people who come from an « Awareness 🎁 » post or ad).
import { FormEvent, ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Out } from '../../lib/backend';
import { da, n, when } from '../../lib/format';
import { useAction, useRpc } from '../../lib/query';
import { PATHS } from '../../lib/route';
import { useSession } from '../../lib/session';
import { Card, Empty, ErrorBox, Field, Icon, Kpi, Kpis, Loading, Tabs } from '../../ui/kit';
import type { PageProps } from '../registry';
import './referral.css';

export function Parrainage({ sub }: PageProps) {
  const { session } = useSession();
  const { t } = useTranslation();
  if (sub === 'codes') return <PromoPage />;
  // Referral › Referral: the owner's
  if (!session?.isAdmin) return <Empty>{t('referral.adminOnly')}</Empty>;
  return <ReferralPanel />;
}

// ================================================================ Referral › Referral
const shareText = (t: (k: string, o?: any) => string, code: string, link: string) => t('profil.refMsg', { code, link });

function ReferralPanel() {
  const { t, i18n } = useTranslation();
  const { session } = useSession();
  const q = useRpc('me.referrals', {});
  const [nm, setNm] = useState('');
  const [em, setEm] = useState('');
  const [copied, setCopied] = useState('');
  const [rc, setRc] = useState<{ cash: number | string; months: number | string } | null>(null);
  const invite = useAction('me.invite', { success: t('profil.invOk'), onDone: () => (setNm(''), setEm('')) });
  const rules = useAction('referral.rules', { success: t('profil.rulesOk') });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const months = String(d.rules.months);
  const plat = d.platform;
  const off = plat && !d.rules.months;
  // the sign-up link: pilotix.online/signup?ref=CODE (the server gives it; the preview: its own page)
  const site = `${location.origin}${PATHS ? '' : location.pathname}`;
  const link = d.link ?? (PATHS ? `${site}/signup?ref=${d.code}` : `${site}#/inscription/${d.code}`);
  const msg = shareText(t, d.code ?? '', link);
  const copy = (v: string, k: string) =>
    navigator.clipboard
      ?.writeText(v)
      .then(() => {
        setCopied(k);
        setTimeout(() => setCopied(''), 1600);
      })
      .catch(() => {});
  const st = { invited: ['sStarted', 'off'], signed_up: ['sSigned', 'info'], subscribed: ['sPaying', 'ok'] } as const;
  const date = (x: string) => new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar-DZ' : i18n.language, { day: 'numeric', month: 'short', year: 'numeric', numberingSystem: 'latn' }).format(new Date(x));
  const R = rc ?? { cash: d.rules.cash, months: d.rules.months };
  const tot = d.totals as typeof d.totals & { monthsUsed?: number; monthsLeft?: number };
  return (
    <div className="rf-page">
      <section className="card rf-hero">
        <div className="rf-ht">
          <span className="rf-ico">
            <Icon name="gift" />
          </span>
          <div>
            <h1>{t('referral.title')}</h1>
            <p>{off ? t('referral.paused') : plat ? t('profil.refRulePlat', { months }) : t('profil.refRule', { cash: da(d.rules.cash), months })}</p>
          </div>
        </div>
        <div className="rf-share">
          <div className="rf-box">
            <span className="lab">{t('profil.refCode')}</span>
            <b className="ltr rf-code">{d.code}</b>
            <button type="button" className="btn small" onClick={() => copy(d.code ?? '', 'code')}>
              <Icon name="copy" />
              {copied === 'code' ? t('profil.copied') : t('profil.copy')}
            </button>
          </div>
          <div className="rf-box grow">
            <span className="lab">{t('profil.refLink')}</span>
            <span className="ltr rf-url">{link}</span>
          </div>
          <div className="rf-btns">
            <a className="btn rf-wa" href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noopener">
              <Icon name="whatsapp" />
              WhatsApp
            </a>
            <a className="btn rf-fb" href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(link)}`} target="_blank" rel="noopener">
              <Icon name="facebook" />
              Facebook
            </a>
            <button type="button" className="btn" onClick={() => copy(msg, 'link')}>
              <Icon name="copy" />
              {copied === 'link' ? t('profil.copied') : t('referral.copyLink')}
            </button>
          </div>
        </div>
      </section>
      <Kpis>
        <Kpi label={t('referral.kStarted')} value={n(tot.invited)} icon="users" />
        <Kpi label={t('referral.kSigned')} value={n(tot.signedUp)} icon="store" />
        <Kpi label={t('referral.kPaying')} value={n(tot.subscribed)} tone="ok" icon="checkcircle" />
        <Kpi label={t('referral.kEarned')} value={t('profil.nMonths', { n: tot.months })} tone={tot.months ? 'ok' : undefined} icon="gift" />
        <Kpi label={t('referral.kUsed')} value={t('profil.nMonths', { n: tot.monthsUsed ?? 0 })} icon="clock" />
        <Kpi label={t('referral.kLeft')} value={t('profil.nMonths', { n: tot.monthsLeft ?? 0 })} icon="calendar" />
      </Kpis>
      <Card title={t('profil.how')}>
        <ol className="rf-steps">
          <li>{t('referral.h1')}</li>
          <li>{t('referral.h2')}</li>
          <li>{t('referral.h3', { months })}</li>
          <li>{t('referral.h4')}</li>
        </ol>
      </Card>
      <Card title={t('referral.friends')}>
        {d.friends.length ? (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('profil.cFriend')}</th>
                  <th>{t('profil.cStatus')}</th>
                  <th>{t('profil.cDate')}</th>
                  <th className="num">{t('profil.cReward')}</th>
                </tr>
              </thead>
              <tbody>
                {d.friends.map((f) => (
                  <tr key={f.id}>
                    <td data-l={t('profil.cFriend')}>
                      <b>{f.name}</b>
                      <small className="ltr">{[f.shop, f.email].filter(Boolean).join(' · ')}</small>
                    </td>
                    <td data-l={t('profil.cStatus')}>
                      <span className={`badge t-${st[f.status][1]}`}>{t(`referral.${st[f.status][0]}`)}</span>
                    </td>
                    <td data-l={t('profil.cDate')}>{date(f.createdAt)}</td>
                    <td className="num" data-l={t('profil.cReward')}>
                      {f.status === 'subscribed' && f.months ? <b className="ltr">+{t('profil.nMonths', { n: f.months })}</b> : f.status === 'subscribed' && !plat ? <b className="ltr">{da(f.cash)}</b> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{t('profil.noFriendsPlat')}</p>
        )}
        {!plat && <p className="muted small">{t('profil.demo')}</p>}
      </Card>
      {!plat && (
        <form
          className="card rf-card"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate({ name: nm.trim(), email: em.trim() });
          }}
        >
          <h2>{t('profil.invite')}</h2>
          <div className="grid2">
            <Field label={t('profil.invName')}>
              <input value={nm} onChange={(e) => setNm(e.target.value)} required minLength={2} />
            </Field>
            <Field label={t('profil.invEmail')}>
              <input type="email" className="ltr" value={em} onChange={(e) => setEm(e.target.value)} required />
            </Field>
          </div>
          <div className="row end">
            <button type="submit" className="btn primary" disabled={invite.isPending}>
              {t('profil.invBtn')}
            </button>
          </div>
        </form>
      )}
      {session?.isAdmin && !plat && (
        <form
          className="card rf-card"
          onSubmit={(e) => {
            e.preventDefault();
            rules.mutate({ cash: Number(R.cash) || 0, months: Number(R.months) || 0 });
          }}
        >
          <h2>{t('profil.rules')}</h2>
          <div className="grid2">
            <Field label={t('profil.rulesCash')}>
              <input type="number" min={0} step={100} className="ltr" value={R.cash} onChange={(e) => setRc({ ...R, cash: e.target.value })} />
            </Field>
            <Field label={t('profil.rulesMonths')}>
              <input type="number" min={0} max={24} className="ltr" value={R.months} onChange={(e) => setRc({ ...R, months: e.target.value })} />
            </Field>
          </div>
          <div className="row end">
            <button type="submit" className="btn primary" disabled={rules.isPending}>
              {t('profil.rulesSave')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ================================================================ Referral › Code promo
type PTab = 'reglages' | 'sources' | 'liste' | 'stats';
function PromoPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PTab>('liste');
  const s = useRpc('promo.settings.get', {});
  return (
    <div className="rf-page">
      <section className="card rf-hero rf-hero-promo">
        <div className="rf-ht">
          <span className="rf-ico">🎁</span>
          <div>
            <h1>{t('referral.promo.title')}</h1>
            <p>{t('referral.promo.intro')}</p>
          </div>
          {s.data && <span className={`badge ${s.data.enabled ? 't-ok' : 't-off'} rf-state`}>{s.data.enabled ? t('referral.promo.on') : t('referral.promo.off')}</span>}
        </div>
      </section>
      <Tabs<PTab>
        value={tab}
        onChange={setTab}
        items={[
          { value: 'liste', label: t('referral.promo.tList') },
          { value: 'stats', label: t('referral.promo.tStats') },
          { value: 'sources', label: t('referral.promo.tSources') },
          { value: 'reglages', label: t('referral.promo.tSettings') },
        ]}
      />
      {tab === 'reglages' ? <PromoSettings /> : tab === 'sources' ? <PromoSources /> : tab === 'stats' ? <PromoStats /> : <PromoList />}
    </div>
  );
}

type PS = Out<'promo.settings.get'>;
const LANGS = ['darija', 'fr', 'ar'] as const;
const sample = (text: string, s: PS) => {
  const until = new Date(Date.now() + s.days * 86_400_000);
  const d = `${String(until.getDate()).padStart(2, '0')}/${String(until.getMonth() + 1).padStart(2, '0')}/${until.getFullYear()}`;
  return text
    .replace(/\{code\}/g, `${s.prefixShown}-7K3P`)
    .replace(/\{remise\}/g, s.kind === 'pct' ? `-${s.value}%` : `-${s.value} DA`)
    .replace(/\{min\}/g, s.minOrder ? ` (min ${s.minOrder} DA)` : '')
    .replace(/\{date\}/g, d)
    .replace(/\{mot\}/g, s.word);
};

function PromoSettings() {
  const { t } = useTranslation();
  const q = useRpc('promo.settings.get', {});
  const [f, setF] = useState<PS | null>(null);
  const save = useAction('promo.settings.save', { success: t('referral.promo.saved') });
  useEffect(() => {
    if (q.data && !f) setF(q.data);
  }, [q.data, f]);
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!f) return <Loading />;
  const set = (p: Partial<PS>) => setF({ ...f, ...p });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { prefixShown: _p, ...rest } = f;
    save.mutate(rest);
  };
  const row = (label: string, child: ReactNode, hint?: string) => (
    <Field label={label} hint={hint}>
      {child}
    </Field>
  );
  return (
    <form className="rf-grid" onSubmit={submit}>
      <Card title={t('referral.promo.sRules')}>
        <label className={`rf-switch${f.enabled ? ' on' : ''}`}>
          <input type="checkbox" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <span>{f.enabled ? t('referral.promo.on') : t('referral.promo.off')}</span>
        </label>
        <div className="grid2">
          {row(
            t('referral.promo.kind'),
            <select value={f.kind} onChange={(e) => set({ kind: e.target.value as PS['kind'] })}>
              <option value="pct">{t('referral.promo.pct')}</option>
              <option value="da">{t('referral.promo.da')}</option>
            </select>,
          )}
          {row(t('referral.promo.value'), <input type="number" className="ltr" min={1} max={f.kind === 'pct' ? 90 : 1_000_000} value={f.value} onChange={(e) => set({ value: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />, f.kind === 'pct' ? '%' : 'DA')}
          {row(t('referral.promo.min'), <input type="number" className="ltr" min={0} step={100} value={f.minOrder} onChange={(e) => set({ minOrder: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />, t('referral.promo.minHint'))}
          {row(t('referral.promo.days'), <input type="number" className="ltr" min={1} max={365} value={f.days} onChange={(e) => set({ days: Math.max(1, Math.round(Number(e.target.value) || 90)) })} />, t('referral.promo.daysHint'))}
          {row(t('referral.promo.prefix'), <input className="ltr" maxLength={4} value={f.prefix} placeholder={f.prefixShown} onChange={(e) => set({ prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />, t('referral.promo.prefixHint', { ex: `${f.prefix || f.prefixShown}-7K3P` }))}
          {row(t('referral.promo.word'), <input className="ltr" maxLength={12} value={f.word} onChange={(e) => set({ word: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />, t('referral.promo.wordHint'))}
        </div>
        <p className="muted small">{t('referral.promo.rulesNote')}</p>
      </Card>
      <Card title={t('referral.promo.sTexts')} help={t('referral.promo.textsHelp')}>
        {row(
          t('referral.promo.lang'),
          <select value={f.lang} onChange={(e) => set({ lang: e.target.value as PS['lang'] })}>
            {LANGS.map((l) => (
              <option key={l} value={l}>
                {t(`referral.promo.l.${l}`)}
              </option>
            ))}
          </select>,
        )}
        {LANGS.map((l) => (
          <div key={l} className={`rf-text${f.lang === l ? ' used' : ''}`}>
            <Field label={`${t('referral.promo.msg')} · ${t(`referral.promo.l.${l}`)}`}>
              <textarea dir="auto" rows={4} value={f.message[l]} onChange={(e) => set({ message: { ...f.message, [l]: e.target.value } })} />
            </Field>
            <Field label={`${t('referral.promo.follow')} · ${t(`referral.promo.l.${l}`)}`}>
              <textarea dir="auto" rows={3} value={f.follow[l]} onChange={(e) => set({ follow: { ...f.follow, [l]: e.target.value } })} />
            </Field>
          </div>
        ))}
        <div className="rf-preview">
          <span className="lab">{t('referral.promo.preview')}</span>
          <p dir="auto" className="rf-bubble">{sample(f.message[f.lang], f)}</p>
          <p dir="auto" className="rf-bubble ig">
            <small>Instagram</small> {sample(f.follow[f.lang], f)}
          </p>
        </div>
      </Card>
      <div className="row end rf-save">
        <button type="submit" className="btn primary" disabled={save.isPending}>
          {t('referral.promo.save')}
        </button>
      </div>
    </form>
  );
}

function PromoSources() {
  const { t } = useTranslation();
  const q = useRpc('promo.marks', {});
  const mark = useAction('promo.mark', { success: t('referral.promo.saved') });
  const [adId, setAdId] = useState('');
  const [ref, setRef] = useState('');
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const refs = d.marks.filter((m) => m.kind === 'ref');
  const known = new Set(d.ads.map((a) => a.id));
  const other = d.marks.filter((m) => m.kind === 'ad' && !known.has(m.id));
  return (
    <div className="rf-grid">
      <Card title={t('referral.promo.posts')}>
        <p>{t('referral.promo.postsN', { count: d.posts })}</p>
        <a className="btn" href="#/cm/publications">
          <Icon name="comments" />
          {t('referral.promo.postsGo')}
        </a>
      </Card>
      <Card title={t('referral.promo.ads')} help={t('referral.promo.adsHelp')}>
        {d.ads.length || other.length ? (
          <ul className="rf-ads">
            {[...d.ads.map((a) => ({ id: a.id, label: a.name, on: a.awareness })), ...other.map((m) => ({ id: m.id, label: m.label ?? m.id, on: true }))].map((a) => (
              <li key={a.id}>
                <label className={`rf-aware${a.on ? ' on' : ''}`}>
                  <input type="checkbox" checked={a.on} disabled={mark.isPending} onChange={(e) => mark.mutate({ kind: 'ad', id: a.id, on: e.target.checked, label: a.label })} />
                  <span>{a.label}</span>
                  <small className="ltr muted">{a.id}</small>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('referral.promo.noAds')}</p>
        )}
        <form
          className="rf-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (adId.trim()) mark.mutate({ kind: 'ad', id: adId.trim(), on: true }, { onSuccess: () => setAdId('') });
          }}
        >
          <input className="ltr" inputMode="numeric" placeholder={t('referral.promo.adId')} value={adId} onChange={(e) => setAdId(e.target.value.replace(/\D/g, ''))} />
          <button type="submit" className="btn" disabled={!adId || mark.isPending}>
            {t('referral.promo.add')}
          </button>
        </form>
      </Card>
      <Card title={t('referral.promo.refs')} help={t('referral.promo.refsHelp')}>
        {refs.length ? (
          <ul className="rf-ads">
            {refs.map((m) => (
              <li key={m.id}>
                <label className="rf-aware on">
                  <input type="checkbox" checked onChange={() => mark.mutate({ kind: 'ref', id: m.id, on: false })} />
                  <span className="ltr">m.me/…?ref={m.id}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t('referral.promo.noRefs')}</p>
        )}
        <form
          className="rf-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (ref.trim()) mark.mutate({ kind: 'ref', id: ref.trim(), on: true }, { onSuccess: () => setRef('') });
          }}
        >
          <input className="ltr" placeholder="babyjoy-promo" value={ref} onChange={(e) => setRef(e.target.value.replace(/[^\w.-]/g, ''))} />
          <button type="submit" className="btn" disabled={!ref || mark.isPending}>
            {t('referral.promo.add')}
          </button>
        </form>
      </Card>
    </div>
  );
}

const STATUS_TONE: Record<string, string> = { waiting_follow: 'warn', sent: 'info', used: 'ok', expired: 'off' };
const CH: Record<string, string> = { messenger: 'Facebook', instagram: 'Instagram' };

function PromoList() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'' | 'waiting_follow' | 'sent' | 'used' | 'expired'>('');
  const [q0, setQ0] = useState('');
  const q = useRpc('promo.codes', { ...(status ? { status } : {}), ...(q0.trim() ? { q: q0.trim() } : {}) });
  return (
    <Card
      title={t('referral.promo.tList')}
      actions={
        <span className="rf-filters">
          <input className="ltr" placeholder={t('referral.promo.search')} value={q0} onChange={(e) => setQ0(e.target.value)} />
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="">{t('referral.promo.all')}</option>
            {(['sent', 'used', 'waiting_follow', 'expired'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`referral.promo.st.${s}`)}
              </option>
            ))}
          </select>
        </span>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error || !q.data ? (
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.rows.length ? (
        <Empty>{t('referral.promo.empty')}</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t('referral.promo.cCode')}</th>
                <th>{t('referral.promo.cWho')}</th>
                <th>{t('referral.promo.cFrom')}</th>
                <th>{t('referral.promo.cSent')}</th>
                <th>{t('referral.promo.cStatus')}</th>
                <th>{t('referral.promo.cOrder')}</th>
                <th>{t('referral.promo.cExp')}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.rows.map((r) => (
                <tr key={r.id}>
                  <td data-l={t('referral.promo.cCode')}>
                    <b className="ltr rf-c">{r.code}</b>
                    <small className="ltr">{r.pct ? `-${r.pct}%` : `-${da(r.amount)}`}</small>
                  </td>
                  <td data-l={t('referral.promo.cWho')}>
                    {r.name ?? '—'}
                    <small>
                      {CH[r.channel] ?? r.channel}
                      {r.conversationId ? (
                        <>
                          {' · '}
                          <a href={`#/messages/${r.conversationId}`}>{t('referral.promo.chat')}</a>
                        </>
                      ) : null}
                    </small>
                  </td>
                  <td data-l={t('referral.promo.cFrom')}>
                    <span className="chip">{t(`referral.promo.src.${r.sourceKind}`)}</span> <small dir="auto">{r.sourceLabel ?? r.sourceId}</small>
                  </td>
                  <td data-l={t('referral.promo.cSent')}>{r.sentAt ? when(r.sentAt) : '—'}</td>
                  <td data-l={t('referral.promo.cStatus')}>
                    <span className={`badge t-${STATUS_TONE[r.status] ?? 'off'}`}>{t(`referral.promo.st.${r.status}`)}</span>
                  </td>
                  <td data-l={t('referral.promo.cOrder')}>
                    {r.orderRef ? (
                      <a className="ltr" href={`#/commandes?q=${encodeURIComponent(r.orderRef)}`}>
                        {r.orderRef}
                      </a>
                    ) : (
                      '—'
                    )}
                    {r.discount ? <small className="ltr">−{da(r.discount)}</small> : null}
                  </td>
                  <td data-l={t('referral.promo.cExp')}>{r.expiresAt ? when(r.expiresAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function PromoStats() {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const q = useRpc('promo.stats', { days });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  return (
    <>
      <div className="row rf-days">
        {[7, 30, 90].map((d) => (
          <button key={d} type="button" className={`btn small${days === d ? ' primary' : ''}`} onClick={() => setDays(d)}>
            {t('referral.promo.days_n', { n: d })}
          </button>
        ))}
      </div>
      <Kpis>
        <Kpi label={t('referral.promo.kSent')} value={n(s.sent)} icon="send" />
        <Kpi label={t('referral.promo.kUsed')} value={n(s.used)} tone="ok" icon="checkcircle" rate={s.sent ? s.used / s.sent : null} />
        <Kpi label={t('referral.promo.kWaiting')} value={n(s.waiting)} tone={s.waiting ? 'warn' : undefined} icon="clock" />
        <Kpi label={t('referral.promo.kOrders')} value={n(s.orders)} icon="list" sub={t('referral.promo.kConfirmed', { n: s.confirmed })} />
        <Kpi label={t('referral.promo.kMoney')} value={da(s.money)} tone="ok" icon="coins" />
        <Kpi label={t('referral.promo.kGiven')} value={da(s.given)} icon="tag" />
      </Kpis>
      <Card title={t('referral.promo.bySource')}>
        {!s.bySource.length ? (
          <Empty>{t('referral.promo.empty')}</Empty>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t('referral.promo.cFrom')}</th>
                  <th className="num">{t('referral.promo.kSent')}</th>
                  <th className="num">{t('referral.promo.kUsed')}</th>
                  <th className="num">{t('referral.promo.kMoney')}</th>
                </tr>
              </thead>
              <tbody>
                {s.bySource.map((b) => (
                  <tr key={`${b.kind}:${b.id}`}>
                    <td>
                      <span className="chip">{t(`referral.promo.src.${b.kind}`)}</span> <span dir="auto">{b.label ?? b.id}</span>
                    </td>
                    <td className="num">{n(b.sent)}</td>
                    <td className="num">{n(b.used)}</td>
                    <td className="num">{da(b.money)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
