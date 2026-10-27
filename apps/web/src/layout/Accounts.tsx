// The screens of an account on a multi-shop server: the store picker (after the password, or from the account menu),
// « Ajouter une boutique », « Créer ma boutique » (confirmed by e-mail before anything is made), the sign-up e-mail's
// link, the e-mail check link, and the terms of use and privacy page.
import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, DEMO_ONLY, legalText, server, signup, signupInfo, StoreChoice, storeNameCheck, verifyEmail } from '../lib/backend';
import { useSession } from '../lib/session';
import { Icon } from '../ui/kit';
import { Modal } from '../ui/modal';
import { toast } from '../ui/toast';
import { BrandBig } from './PxWordmark';
import { AuthShell, AuthTitle, PasswordInput } from './AuthShell';

/** Leaves a page opened from an e-mail (its secret leaves the address bar and the history). */
function home(to = '') {
  history.replaceState(null, '', `${location.pathname}${location.search}${to}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** The account pages (sign-up, store picker, e-mail links): the split sign-in layout, a title with an optional marked word. */
function Page({ title, mark, sub, children, wide }: { title: string; mark?: string; sub?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <AuthShell wide={wide}>
      <AuthTitle a={title} b={mark} sub={sub} />
      {children}
    </AuthShell>
  );
}

// ---------------------------------------------------------------- the store picker
function StoreList({ stores, onPick, busy }: { stores: StoreChoice[]; onPick: (id: number) => void; busy: number | null }) {
  const { t } = useTranslation();
  return (
    <ul className="px-stores">
      {stores.map((s) => (
        <li key={s.id}>
          <button type="button" disabled={busy !== null} onClick={() => onPick(s.id)}>
            <span className={`px-stores-ic ${s.kind === 'agency' ? 'agx-ic' : ''}`}>
              <Icon name={s.kind === 'agency' ? 'headset' : 'store'} />
            </span>
            <span className="px-stores-t">
              <b>{s.name}</b>
              <small className="ltr">{s.slug}</small>
            </span>
            {s.kind === 'agency' && <span className="chip agx-chip">{t('agency.badge')}</span>}
            {s.owner && <span className="chip">{t('shop.acc.owner')}</span>}
            {s.locked && <span className="chip px-chip-bad">{t('shop.acc.locked')}</span>}
            <span className="px-stores-go">{busy === s.id ? '…' : <Icon name="chevr" />}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** After the password: the person's stores (or « create your first store » when none is left). */
export function StorePicker() {
  const { t } = useTranslation();
  const { picker, pick, cancelPick, enter } = useSession();
  const [busy, setBusy] = useState<number | null>(null);
  const first = !!picker && !picker.stores.length && picker.canAddStore;
  // a new account (no store yet): the first store's form straight away
  const [adding, setAdding] = useState<'store' | 'agency' | null>(first ? 'store' : null);
  if (!picker) return null;
  const go = async (id: number) => {
    setBusy(id);
    try {
      await pick(id);
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
      setBusy(null);
    }
  };
  return (
    <Page
      title={first ? t('auth.firstStore1') : t('shop.acc.pickTitle')}
      mark={first ? t('auth.firstStore2') : undefined}
      sub={first ? t('auth.firstStoreText', { name: (picker.account.name || '').split(' ')[0] || picker.account.email }) : undefined}
    >
      {!first && <p className="pxa-note">{picker.stores.length ? t('shop.acc.pickText', { name: picker.account.name || picker.account.email }) : t('shop.acc.noStore')}</p>}
      <StoreList stores={picker.stores} onPick={go} busy={busy} />
      {adding ? (
        <AddStoreForm ticket={picker.ticket} agency={adding === 'agency'} onDone={enter} onCancel={first && adding === 'store' ? undefined : () => setAdding(null)} />
      ) : (
        <>
          {picker.canAddStore && (
            <button type="button" className="btn big" onClick={() => setAdding('store')}>
              + {t('shop.acc.addStore')}
            </button>
          )}
          {picker.canAddAgency && (
            <button type="button" className="pxa-back" onClick={() => setAdding('agency')}>
              <Icon name="headset" /> {t('agency.create')}
            </button>
          )}
        </>
      )}
      <button type="button" className="pxa-back" onClick={cancelPick}>
        {t('login.backToLogin')}
      </button>
    </Page>
  );
}

/** « Changer de boutique » from the account menu. */
export function SwitchStoreModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { switchStore, session } = useSession();
  const [stores, setStores] = useState<StoreChoice[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    server
      .stores()
      .then(setStores)
      .catch((e) => toast(e?.message ?? t('common.error'), 'bad'));
  }, [t]);
  const go = async (id: number) => {
    if (id === session?.shop?.id) return onClose();
    setBusy(id);
    try {
      await switchStore(id);
      location.hash = '#/accueil';
      onClose();
    } catch (e: any) {
      toast(e?.message ?? t('common.error'), 'bad');
      setBusy(null);
    }
  };
  return (
    <Modal title={t('shop.acc.switch')} onClose={onClose}>
      {stores ? <StoreList stores={stores} onPick={go} busy={busy} /> : <p className="muted">…</p>}
    </Modal>
  );
}

// ---------------------------------------------------------------- the name of a new store (checked while typed)
function useStoreName(name: string, slug: string, slugTouched: boolean) {
  const [check, setCheck] = useState<{ slug: string; free: boolean; reason: string | null } | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (name.trim().length < 2 && !slugTouched) return setCheck(null);
    const n = ++seq.current;
    const id = setTimeout(() => {
      storeNameCheck(name.trim(), slugTouched ? slug.trim() : undefined)
        .then((r) => n === seq.current && setCheck(r))
        .catch(() => n === seq.current && setCheck(null));
    }, 350);
    return () => clearTimeout(id);
  }, [name, slug, slugTouched]);
  return check;
}

function StoreNameFields({ name, setName, slug, setSlug, touched, setTouched }: { name: string; setName: (v: string) => void; slug: string; setSlug: (v: string) => void; touched: boolean; setTouched: (v: boolean) => void }) {
  const { t } = useTranslation();
  const check = useStoreName(name, slug, touched);
  const site = (location.host || 'pilotix.online').replace(/^www\./, '');
  const shown = touched ? slug : check?.slug ?? '';
  return (
    <>
      <label className="field">
        <span className="lab">{t('shop.acc.storeName')}</span>
        <input required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('shop.acc.storeNamePh')} />
      </label>
      <label className="field">
        <span className="lab">{t('shop.acc.storeLink')}</span>
        <div className="px-slug" dir="ltr">
          <span className="ltr">{site}/</span>
          <input className="ltr" maxLength={40} value={shown} onChange={(e) => (setTouched(true), setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-')))} />
        </div>
        <span className={`hint ${check && !check.free ? 'px-bad' : ''}`}>{check ? (check.free ? t('shop.acc.linkFree') : check.reason) : t('shop.acc.linkHint')}</span>
      </label>
    </>
  );
}

/** « Ajouter une boutique » (its name and link) or « Créer mon agence » (its name): the person owns it and enters it. */
export function AddStoreForm({ ticket, onDone, onCancel, agency }: { ticket?: string; onDone: (s: import('@pilotix/shared').Session) => void; onCancel?: () => void; agency?: boolean }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');
  const [verify, setVerify] = useState<'need' | 'sent' | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      onDone(await server.addStore(agency ? { name: name.trim(), kind: 'agency' } : { name: name.trim(), ...(touched && slug ? { slug } : {}) }, ticket));
      location.hash = '#/accueil';
    } catch (err: any) {
      if (err instanceof ApiError && err.message === 'VERIFY_EMAIL') setVerify('need');
      else setError(err?.message || t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  if (verify)
    return (
      <div className="px-acc-box">
        <p>{verify === 'sent' ? t('shop.acc.verifySent') : t('shop.acc.verifyNeed')}</p>
        {verify === 'need' && (
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              try {
                await server.verifySend(ticket);
                setVerify('sent');
              } catch (e: any) {
                toast(e?.message ?? t('common.error'), 'bad');
              }
            }}
          >
            <Icon name="mail" /> {t('shop.acc.verifySend')}
          </button>
        )}
      </div>
    );
  return (
    <form className="px-acc-form" onSubmit={submit}>
      {agency ? (
        <label className="field">
          <span className="lab">{t('agency.name')}</span>
          <input required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('agency.namePh')} />
        </label>
      ) : (
        <StoreNameFields name={name} setName={setName} slug={slug} setSlug={setSlug} touched={touched} setTouched={setTouched} />
      )}
      <p className="small muted">{agency ? t('agency.addText') : t('shop.acc.addText')}</p>
      {error && <p className="form-err">{error}</p>}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
        )}
        <button className="btn primary" disabled={busy || name.trim().length < 2}>
          {busy ? '…' : t('shop.acc.create')}
        </button>
      </div>
    </form>
  );
}

export function AddStoreModal({ onClose, agency }: { onClose: () => void; agency?: boolean }) {
  const { t } = useTranslation();
  const { enter } = useSession();
  return (
    <Modal title={agency ? t('agency.create') : t('shop.acc.addStore')} onClose={onClose}>
      <AddStoreForm agency={agency} onDone={(s) => (enter(s), onClose())} onCancel={onClose} />
    </Modal>
  );
}

// ---------------------------------------------------------------- « Créer ma boutique »
export function Signup({ referral, agency }: { referral?: string; agency?: boolean }) {
  const { t, i18n } = useTranslation();
  const [info, setInfo] = useState<{ open: boolean; trialDays: number } | null>(null);
  const [f, setF] = useState({ name: '', email: '', password: '', phone: '', referral: (referral ?? '').toUpperCase() });
  const [storeName, setStoreName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    // the demo (no server): the form is shown, but nothing can be created
    if (DEMO_ONLY) setInfo({ open: true, trialDays: 14 });
    else signupInfo().then(setInfo);
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (DEMO_ONLY) return setError(t('auth.demoNoSignup'));
    setBusy(true);
    try {
      await signup({
        name: f.name.trim(),
        email: f.email.trim(),
        password: f.password,
        phone: f.phone.trim() || null,
        // a store sign-up opens the account only; the first store is created right after
        storeName: agency ? storeName.trim() : '',
        language: (['fr', 'en', 'ar'].includes(i18n.language) ? i18n.language : 'fr') as 'fr' | 'en' | 'ar',
        ...(!agency && f.referral.trim() ? { referral: f.referral.trim() } : {}),
        terms: true,
        ...(agency ? { kind: 'agency' as const } : {}),
      });
      setSent(true);
    } catch (err: any) {
      setError(err?.message || t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  if (info && !info.open)
    return (
      <Page title={t('shop.acc.signupTitle')}>
        <p className="pxa-note">{t('shop.acc.signupClosed')}</p>
        <a className="pxa-back" href="#/">
          {t('login.backToLogin')}
        </a>
      </Page>
    );
  if (sent)
    return (
      <Page title={t('shop.acc.checkMail')}>
        <p className="pxa-note">{t('shop.acc.checkMailText', { email: f.email.trim() })}</p>
        <p className="small muted">{t('shop.acc.checkMailSpam')}</p>
        <a className="pxa-back" href="#/">
          {t('login.backToLogin')}
        </a>
      </Page>
    );
  return (
    <Page
      title={agency ? t('auth.signupAgency1') : t('auth.signup1')}
      mark={agency ? t('auth.signupAgency2') : t('auth.signup2')}
      sub={agency ? t('agency.signupText') : t('auth.signupSub')}
    >
      {!agency && (
        <p className="pxa-badge">
          <Icon name="gift" /> {t('auth.trialBadge', { days: info?.trialDays ?? 14 })}
        </p>
      )}
      <form className="px-acc-form" onSubmit={submit}>
        {agency && (
          <label className="field">
            <span className="lab">{t('agency.name')}</span>
            <input required minLength={2} maxLength={80} value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder={t('agency.namePh')} />
          </label>
        )}
        <label className="field">
          <span className="lab">{t('auth.fullName')}</span>
          <input required minLength={2} maxLength={80} autoComplete="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t('auth.fullNamePh')} />
        </label>
        <label className="field">
          <span className="lab">{t('login.email')}</span>
          <input type="email" dir="ltr" required maxLength={200} autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="vous@exemple.com" />
        </label>
        <label className="field">
          <span className="lab">{t('auth.phone')}</span>
          <input dir="ltr" inputMode="tel" required minLength={9} maxLength={30} autoComplete="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="0555 12 34 56" />
        </label>
        <label className="field">
          <span className="lab">{t('login.password')}</span>
          <PasswordInput required minLength={8} maxLength={200} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <span className={`pxa-hint${f.password.length >= 8 ? ' ok' : ''}`}>
            <i /> {t('auth.pwMin')}
          </span>
        </label>
        {error && <p className="form-err">{error}</p>}
        <button className="pxa-submit" disabled={busy}>
          {busy ? '…' : t('auth.createAccount')}
        </button>
        <p className="pxa-legalnote">
          {t('auth.accept1')} <a href="#/conditions" target="_blank" rel="noreferrer">{t('auth.terms')}</a> {t('auth.accept2')}{' '}
          <a href="#/conditions" target="_blank" rel="noreferrer">
            {t('auth.privacyFull')}
          </a>
          .
        </p>
      </form>
      <p className="pxa-alt">
        {t('auth.haveAccountQ')} <a href="#/">{t('auth.signIn')}</a>
      </p>
      {agency ? (
        <p className="pxa-alt2">
          <Icon name="store" /> <a href="#/inscription">{t('agency.isStore')}</a>
        </p>
      ) : (
        <p className="pxa-alt2">
          <Icon name="headset" />
          <span>{t('agency.areYou')}</span> <a href="#/inscription-agence">{t('agency.create')}</a>
        </p>
      )}
    </Page>
  );
}

/** The sign-up e-mail's link: the store is made and the person enters it. */
export function SignupConfirm({ token }: { token: string }) {
  const { t } = useTranslation();
  const { enter, showPicker } = useSession();
  const [state, setState] = useState<'busy' | 'exists' | 'error'>('busy');
  const [msg, setMsg] = useState('');
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    server
      .confirmSignup(token)
      .then((r) => {
        if ('exists' in r) return setState('exists');
        // account-only sign-up: the picker, where the first store is created
        if ('pick' in r) {
          showPicker(r);
          return home('#/');
        }
        enter(r);
        home('#/accueil');
      })
      .catch((e) => {
        setMsg(e?.message ?? t('common.error'));
        setState('error');
      });
  }, [token, enter, showPicker, t]);
  return (
    <Page title={state === 'busy' ? t('shop.acc.making') : state === 'exists' ? t('shop.acc.haveAccountTitle') : t('shop.acc.linkBad')}>
      <p className="pxa-note">{state === 'busy' ? t('shop.acc.makingText') : state === 'exists' ? t('shop.acc.haveAccountText') : msg}</p>
      {state !== 'busy' && (
        <button type="button" className="pxa-submit" onClick={() => home()}>
          {t('login.submit')}
        </button>
      )}
    </Page>
  );
}

/** The e-mail check link. */
export function VerifyEmail({ token }: { token: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<'busy' | 'ok' | 'error'>('busy');
  const [msg, setMsg] = useState('');
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    verifyEmail(token)
      .then(() => setState('ok'))
      .catch((e) => {
        setMsg(e?.message ?? t('common.error'));
        setState('error');
      });
  }, [token, t]);
  return (
    <Page title={state === 'ok' ? t('shop.acc.verified') : state === 'busy' ? '…' : t('shop.acc.linkBad')}>
      <p className="pxa-note">{state === 'ok' ? t('shop.acc.verifiedText') : state === 'error' ? msg : ''}</p>
      {state !== 'busy' && (
        <button type="button" className="pxa-submit" onClick={() => home('#/accueil')}>
          {t('shop.acc.continue')}
        </button>
      )}
    </Page>
  );
}

// ---------------------------------------------------------------- terms of use and privacy
export function Legal() {
  const { t } = useTranslation();
  const [d, setD] = useState<{ text: string; company: string; email: string } | null>(null);
  useEffect(() => {
    legalText().then(setD);
  }, []);
  const sections = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] as const;
  return (
    <div className="px-legal">
      <article className="card">
        <BrandBig />
        <h1>{t('legal.title')}</h1>
        {d?.text.trim() ? (
          <div className="px-legal-own">{d.text}</div>
        ) : (
          <>
            <p className="muted">{t('legal.intro', { company: d?.company || 'Pilotix' })}</p>
            {sections.map((k) => (
              <section key={k}>
                <h2>{t(`legal.${k}.t`)}</h2>
                <p>{t(`legal.${k}.p`, { email: d?.email || 'contact@pilotix.online' })}</p>
              </section>
            ))}
          </>
        )}
        <p>
          <a className="btn" href="#/" onClick={(e) => (history.length > 1 ? (e.preventDefault(), history.back()) : undefined)}>
            ← {t('legal.back')}
          </a>
        </p>
      </article>
    </div>
  );
}
