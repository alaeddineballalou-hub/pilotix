// "Mon profil" (#/profil/infos | parametres | parrainage | securite): my name, phone and picture, my app settings,
// inviting friends to Pilotix (referral), and my password / deleting my account.
import { LANGUAGES, Language, Profile } from '@pilotix/shared';
import { FormEvent, ReactNode, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { da, n } from '../../lib/format';
import { applyLanguage } from '../../lib/i18n';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { store } from '../../lib/store';
import { applyTheme } from '../../layout/Shell';
import { Icon, Loading } from '../../ui/kit';
import { Modal } from '../../ui/modal';
import { toast } from '../../ui/toast';
import type { PageProps } from '../registry';
import { Avatar } from './Avatar';

const TABS = [
  ['infos', 'tInfos', 'usercog'],
  ['parametres', 'tSettings', 'settings'],
  ['parrainage', 'tRef', 'gift'],
  ['securite', 'tSec', 'lock'],
] as const;
type Tab = (typeof TABS)[number][0];

/** Crops the picked image to a 256 px square (JPEG), small enough to keep on the profile. */
function squareImage(file: File): Promise<string> {
  return new Promise((ok, ko) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => {
      const S = 256;
      const c = document.createElement('canvas');
      c.width = S;
      c.height = S;
      const m = Math.min(im.width, im.height);
      c.getContext('2d')!.drawImage(im, (im.width - m) / 2, (im.height - m) / 2, m, m, 0, 0, S, S);
      URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', 0.86));
    };
    im.onerror = () => {
      URL.revokeObjectURL(url);
      ko(new Error('img'));
    };
    im.src = url;
  });
}

function Field({ label, hint, lock, children }: { label: string; hint?: string; lock?: boolean; children: ReactNode }) {
  return (
    <label className="field px-pf-f">
      <span className="lab">
        {label}
        {lock && <Icon name="lock" className="px-pf-lk" />}
      </span>
      {children}
      {hint && <span className="muted small">{hint}</span>}
    </label>
  );
}

export function Profil({ sub }: PageProps) {
  const { t } = useTranslation();
  const { session } = useSession();
  const p = session!.profile;
  // a confirmation agency's people (its own space, or working in a store for it) have no referral programme
  const agencyPerson = (!!session!.shop?.kind && session!.shop.kind !== 'store') || !!p.agencyId;
  const tabs = TABS.filter(([k]) => k !== 'parrainage' || !agencyPerson);
  const tab: Tab = tabs.some((x) => x[0] === sub) ? (sub as Tab) : 'infos';
  return (
    <div className="px-pf">
      <section className="card px-pf-hero">
        <Avatar p={p} size="xl" />
        <div className="px-pf-hi">
          <h1>{p.name}</h1>
          <span className="muted">{p.email}</span>
          <div className="px-pf-roles">
            {session!.roles.map((r) => (
              <span key={r} className="chip">
                {t(`roles.${r}`)}
              </span>
            ))}
          </div>
        </div>
      </section>
      <nav className="px-pf-tabs" aria-label={t('profil.title')}>
        {tabs.map(([k, l, ic]) => (
          <a key={k} href={`#/profil/${k}`} className={`px-pf-tab${tab === k ? ' on' : ''}`} aria-current={tab === k ? 'page' : undefined}>
            <Icon name={ic} />
            {t(`profil.${l}`)}
          </a>
        ))}
      </nav>
      {tab === 'infos' ? <Infos p={p} /> : tab === 'parametres' ? <Settings /> : tab === 'parrainage' ? <Referral /> : <Security p={p} />}
    </div>
  );
}

function Infos({ p }: { p: Profile }) {
  const { t } = useTranslation();
  const { refresh } = useSession();
  const [name, setName] = useState(p.name || '');
  const [phone, setPhone] = useState(p.phone || '');
  const [av, setAv] = useState<string | null | undefined>(undefined);
  const [err, setErr] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const save = useAction('me.update', { success: t('profil.saved'), onDone: () => (setAv(undefined), refresh()) });
  const shown = av !== undefined ? { ...p, avatar: av } : p;
  const dirty = name.trim() !== (p.name || '') || phone.trim() !== (p.phone || '') || av !== undefined;
  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      setAv(await squareImage(f));
    } catch {
      toast(t('profil.imgErr'), 'bad');
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (name.trim().length < 2) return setErr(t('profil.nameErr'));
    save.mutate({ name: name.trim(), phone: phone.trim() || null, ...(av !== undefined ? { avatar: av } : {}) });
  };
  return (
    <form className="card px-pf-card" onSubmit={submit}>
      <div className="px-pf-photo">
        <Avatar p={shown} size="xxl" />
        <div className="px-pf-pt">
          <b>{t('profil.photo')}</b>
          <span className="muted small">{t('profil.photoHelp')}</span>
          <div className="row">
            <button type="button" className="btn small" onClick={() => file.current?.click()}>
              <Icon name="camera" />
              {t('profil.change')}
            </button>
            {shown.avatar && (
              <button type="button" className="btn small ghost danger" onClick={() => setAv(null)}>
                {t('profil.remove')}
              </button>
            )}
          </div>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={pick} />
        </div>
      </div>
      <div className="grid2">
        <Field label={t('profil.name')}>
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} required />
        </Field>
        <Field label={t('profil.phone')}>
          <input type="tel" className="ltr" value={phone} placeholder={t('profil.phonePh')} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" maxLength={30} />
        </Field>
      </div>
      <Field label={t('profil.email')} hint={t('profil.emailLock')} lock>
        <input value={p.email || ''} readOnly disabled className="ltr px-pf-ro" aria-readonly="true" />
      </Field>
      {err && <p className="form-err">{err}</p>}
      <div className="row end">
        <button type="submit" className="btn primary" disabled={!dirty || save.isPending}>
          {t('profil.save')}
        </button>
      </div>
    </form>
  );
}

function Settings() {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useState(() => store.get('theme') || '');
  const [fold, setFold] = useState(() => store.get('sidebar') === 'folded');
  const seg = <V,>(opts: [V, string][], cur: V, on: (v: V) => void) => (
    <div className="seg px-pf-seg" role="group">
      {opts.map(([v, l]) => (
        <button key={String(v)} type="button" aria-pressed={cur === v} onClick={() => on(v)}>
          {l}
        </button>
      ))}
    </div>
  );
  const row = (label: string, hint: string | null, ctl: ReactNode) => (
    <div className="px-pf-set">
      <div>
        <b>{label}</b>
        {hint && <span className="muted small">{hint}</span>}
      </div>
      {ctl}
    </div>
  );
  return (
    <section className="card px-pf-card">
      {row(
        t('profil.lang'),
        t('profil.langHelp'),
        seg(
          LANGUAGES.map((l) => [l, { fr: 'Français', en: 'English', ar: 'العربية' }[l]] as [Language, string]),
          i18n.language as Language,
          (l) => {
            applyLanguage(l);
            rpc('me.language', { language: l }).catch(() => {});
          },
        ),
      )}
      {row(
        t('profil.theme'),
        t('profil.themeHelp'),
        seg(
          [
            ['light', t('profil.tLight')],
            ['dark', t('profil.tDark')],
            ['', t('profil.tAuto')],
          ],
          theme,
          (v) => {
            setTheme(v);
            applyTheme((v || null) as 'light' | 'dark' | null);
          },
        ),
      )}
      {row(
        t('profil.sidebar'),
        null,
        seg(
          [
            [false, t('profil.sOpen')],
            [true, t('profil.sFold')],
          ],
          fold,
          (v) => {
            setFold(v);
            store.set('sidebar', v ? 'folded' : null);
            document.querySelector('.shell')?.classList.toggle('px-folded', v);
          },
        ),
      )}
    </section>
  );
}

function Security({ p }: { p: Profile }) {
  const { t } = useTranslation();
  const { logout } = useSession();
  const [cur, setCur] = useState('');
  const [nw, setNw] = useState('');
  const [cf, setCf] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [em, setEm] = useState('');
  const [dp, setDp] = useState('');
  const pw = useAction('me.password', { success: t('profil.pwdOk'), onDone: () => (setCur(''), setNw(''), setCf('')) });
  const del = useAction('me.delete', { success: t('profil.delDone'), onDone: () => (setOpen(false), logout()) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (nw !== cf) return setErr(t('profil.pwdMis'));
    pw.mutate({ current: cur, next: nw });
  };
  return (
    <>
      <form className="card px-pf-card" onSubmit={submit}>
        <h2>{t('profil.pwd')}</h2>
        <Field label={t('profil.pwdCur')}>
          <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
        </Field>
        <div className="grid2">
          <Field label={t('profil.pwdNew')} hint={t('profil.pwdHint')}>
            <input type="password" value={nw} minLength={8} onChange={(e) => setNw(e.target.value)} autoComplete="new-password" required />
          </Field>
          <Field label={t('profil.pwdConf')}>
            <input type="password" value={cf} minLength={8} onChange={(e) => setCf(e.target.value)} autoComplete="new-password" required />
          </Field>
        </div>
        {err && <p className="form-err">{err}</p>}
        <div className="row end">
          <button type="submit" className="btn primary" disabled={pw.isPending || nw.length < 8 || !cur}>
            {t('profil.pwdBtn')}
          </button>
        </div>
      </form>
      <section className="card px-pf-card px-pf-danger">
        <h2>{t('profil.del')}</h2>
        <p className="muted">{t('profil.delTxt')}</p>
        <div className="row">
          <button type="button" className="btn danger" onClick={() => (setEm(''), setDp(''), setOpen(true))}>
            <Icon name="trash" />
            {t('profil.delBtn')}
          </button>
        </div>
      </section>
      {open && (
        <Modal
          title={t('profil.del')}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>
                {t('profil.cancel')}
              </button>
              <button className="btn danger" disabled={del.isPending || em.trim().toLowerCase() !== (p.email || '').toLowerCase() || !dp} onClick={() => del.mutate({ password: dp })}>
                {t('profil.delConfirm')}
              </button>
            </>
          }
        >
          <p>{t('profil.delTxt')}</p>
          <Field label={t('profil.delType')}>
            <input value={em} onChange={(e) => setEm(e.target.value)} placeholder={p.email} className="ltr" autoComplete="off" />
          </Field>
          <Field label={t('profil.delPwd')}>
            <input type="password" value={dp} onChange={(e) => setDp(e.target.value)} autoComplete="current-password" />
          </Field>
        </Modal>
      )}
    </>
  );
}

function Referral() {
  const { t, i18n } = useTranslation();
  const { session } = useSession();
  const q = useRpc('me.referrals', {});
  const [nm, setNm] = useState('');
  const [em, setEm] = useState('');
  const [copied, setCopied] = useState('');
  const [rc, setRc] = useState<{ cash: number | string; months: number | string } | null>(null);
  const invite = useAction('me.invite', { success: t('profil.invOk'), onDone: () => (setNm(''), setEm('')) });
  const rules = useAction('referral.rules', { success: t('profil.rulesOk') });
  if (q.isLoading || !q.data) return <Loading />;
  const d = q.data;
  const cash = da(d.rules.cash);
  const months = String(d.rules.months);
  // on the Pilotix server: the store's own sign-up link, and Pilotix's programme (free months, no cash)
  const plat = d.platform;
  const off = plat && !d.rules.months;
  const link = d.link ?? (plat ? `${location.origin}${location.pathname}#/inscription/${d.code}` : `${location.origin}${location.pathname}?ref=${d.code}`);
  const msg = t('profil.refMsg', { code: d.code, link });
  const copy = (v: string, k: string) =>
    navigator.clipboard
      ?.writeText(v)
      .then(() => {
        setCopied(k);
        setTimeout(() => setCopied(''), 1600);
      })
      .catch(() => {});
  const kpi = (l: string, v: string, tone?: string) => (
    <div className={`kpi${tone ? ` t-${tone}` : ''}`}>
      <span className="l">{l}</span>
      <span className="v ltr">{v}</span>
    </div>
  );
  const st = { invited: ['sInvited', 'off'], signed_up: ['sSigned', 'info'], subscribed: ['sSub', 'ok'] } as const;
  const date = (x: string) => new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar-DZ' : i18n.language, { day: 'numeric', month: 'short', year: 'numeric', numberingSystem: 'latn' }).format(new Date(x));
  const R = rc ?? { cash: d.rules.cash, months: d.rules.months };
  return (
    <>
      <section className="card px-ref-hero">
        <div className="px-ref-ht">
          <h2>{t(plat ? 'profil.refTitlePlat' : 'profil.refTitle')}</h2>
          <p>{off ? t('profil.refOff') : plat ? t('profil.refRulePlat', { months }) : t('profil.refRule', { cash, months })}</p>
        </div>
        <div className="px-ref-share">
          <div className="px-ref-code">
            <span className="lab">{t('profil.refCode')}</span>
            <div className="px-ref-box">
              <b className="ltr">{d.code}</b>
              <button type="button" className="btn small" onClick={() => copy(d.code ?? '', 'code')}>
                <Icon name="copy" />
                {copied === 'code' ? t('profil.copied') : t('profil.copy')}
              </button>
            </div>
          </div>
          <div className="px-ref-code grow">
            <span className="lab">{t('profil.refLink')}</span>
            <div className="px-ref-box">
              <span className="ltr px-ref-url">{link}</span>
              <button type="button" className="btn small" onClick={() => copy(link, 'link')}>
                <Icon name="copy" />
                {copied === 'link' ? t('profil.copied') : t('profil.copy')}
              </button>
              <a className="btn small px-ref-wa" href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noopener">
                <Icon name="whatsapp" />
                {t('profil.share')}
              </a>
            </div>
          </div>
        </div>
      </section>
      {plat ? (
        <div className="kpis px-ref-k">
          {kpi(t('profil.kStores'), n(d.totals.signedUp))}
          {kpi(t('profil.kPaying'), n(d.totals.subscribed), 'ok')}
          {kpi(t('profil.kMonths'), n(d.totals.months), d.totals.months ? 'ok' : undefined)}
        </div>
      ) : (
        <div className="kpis px-ref-k">
          {kpi(t('profil.kInv'), n(d.totals.invited))}
          {kpi(t('profil.kSign'), n(d.totals.signedUp))}
          {kpi(t('profil.kSub'), n(d.totals.subscribed), 'ok')}
          {kpi(t('profil.kEarn'), da(d.totals.cashEarned), 'ok')}
          {kpi(t('profil.kPend'), da(d.totals.cashPending), d.totals.cashPending ? 'warn' : undefined)}
          {kpi(t('profil.kMonths'), n(d.totals.months))}
        </div>
      )}
      <div className={plat ? undefined : 'px-ref-grid'}>
        <section className="card px-pf-card">
          <h2>{t('profil.how')}</h2>
          {plat ? (
            <ol className="px-ref-steps">
              <li>{t('profil.p1')}</li>
              <li>{t('profil.p2')}</li>
              <li>{t('profil.p3', { months })}</li>
            </ol>
          ) : (
            <ol className="px-ref-steps">
              <li>{t('profil.h1')}</li>
              <li>{t('profil.h2')}</li>
              <li>{t('profil.h3', { cash, months })}</li>
            </ol>
          )}
        </section>
        {!plat && (
        <form
          className="card px-pf-card"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate({ name: nm.trim(), email: em.trim() });
          }}
        >
          <h2>{t('profil.invite')}</h2>
          <Field label={t('profil.invName')}>
            <input value={nm} onChange={(e) => setNm(e.target.value)} required minLength={2} />
          </Field>
          <Field label={t('profil.invEmail')}>
            <input type="email" className="ltr" value={em} onChange={(e) => setEm(e.target.value)} required />
          </Field>
          <div className="row end">
            <button type="submit" className="btn primary" disabled={invite.isPending}>
              {t('profil.invBtn')}
            </button>
          </div>
        </form>
        )}
      </div>
      <section className="card px-pf-card">
        <h2>{t(plat ? 'profil.friendsPlat' : 'profil.friends')}</h2>
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
                      <span className={`badge t-${st[f.status][1]}`}>{t(`profil.${st[f.status][0]}`)}</span>
                    </td>
                    <td data-l={t('profil.cDate')}>{date(f.createdAt)}</td>
                    <td className="num" data-l={t('profil.cReward')}>
                      {f.status === 'subscribed' && plat ? (
                        <b className="ltr">+{t('profil.nMonths', { n: f.months })}</b>
                      ) : f.status === 'subscribed' ? (
                        <>
                          <b className="ltr">
                            {da(f.cash)} + {f.months} m
                          </b>
                          <small>
                            <span className={`badge t-${f.paid ? 'ok' : 'warn'}`}>{f.paid ? t('profil.paid') : t('profil.unpaid')}</span>
                          </small>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{t(plat ? 'profil.noFriendsPlat' : 'profil.noFriends')}</p>
        )}
        {!plat && <p className="muted small">{t('profil.demo')}</p>}
      </section>
      {session?.isAdmin && !plat && (
        <form
          className="card px-pf-card"
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
    </>
  );
}
