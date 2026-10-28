// The screens of an account on a multi-shop server: the store picker (after the password, or from the account menu),
// « Ajouter une boutique » (or « Créer mon agence », « Créer mon espace marketer »), « Créer un compte » (a store, a
// confirmation agency or a marketer: confirmed by e-mail before anything is made), the sign-up e-mail's link, the
// e-mail check link, and the terms of use and privacy page.
import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, DEMO_ONLY, isPhone, legalText, phoneCheck, PhoneSent, server, signup, signupCode, SignupInfo, signupInfo, StoreChoice, storeNameCheck, verifyEmail } from '../lib/backend';
import { usePhoneProblem } from '../lib/phoneCheck';
import { useSession } from '../lib/session';
import { Icon } from '../ui/kit';
import { Modal } from '../ui/modal';
import { toast } from '../ui/toast';
import { AuthShell, AuthTabs, AuthTitle, PasswordInput } from './AuthShell';
import { SOCIAL_KIND, SocialButtons } from './SocialButtons';
import { BrandBig } from './PxWordmark';

/** Leaves a page opened from an e-mail (its secret leaves the address bar and the history). */
function home(to = '') {
  history.replaceState(null, '', `${location.pathname}${location.search}${to}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** What an account can be: a store (a seller), a confirmation agency, a marketer. */
type Kind = 'store' | 'agency' | 'marketer';
const KINDS: Kind[] = ['store', 'agency', 'marketer'];
const KIND_ICON: Record<Kind, string> = { store: 'store', agency: 'headset', marketer: 'megaphone' };
/** The words of a partner's account (agency.*, a marketer's own agency.mk.* first). */
function useKindT(kind: Kind) {
  const { t } = useTranslation();
  return (key: string, o?: Record<string, unknown>) => (kind === 'marketer' ? t(`agency.mk.${key}`, { ...o, defaultValue: t(`agency.${key}`, o) }) : t(`agency.${key}`, o));
}

/** The account pages (sign-up, store picker, e-mail links): the sign-in frame and its design, a title with an optional marked word. */
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
            <span className={`px-stores-ic ${s.kind === 'agency' ? 'agx-ic' : s.kind === 'marketer' ? 'mkx-ic' : ''}`}>
              <Icon name={KIND_ICON[s.kind ?? 'store']} />
            </span>
            <span className="px-stores-t">
              <b>{s.name}</b>
              <small className="ltr">{s.slug}</small>
            </span>
            {s.kind === 'agency' && <span className="chip agx-chip">{t('agency.badge')}</span>}
            {s.kind === 'marketer' && <span className="chip mkx-chip">{t('agency.mk.badge')}</span>}
            {s.owner && <span className="chip">{t('shop.acc.owner')}</span>}
            {s.locked && <span className="chip px-chip-bad">{t('shop.acc.locked')}</span>}
            <span className="px-stores-go">{busy === s.id ? '…' : <Icon name="chevr" />}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- « Vérifiez votre numéro »
/**
 * After the password (or Google / Facebook, or the sign-up link): every account has its own number. Code off: the
 * person types it and goes on. Code on: a 6-digit code leaves by WhatsApp, the person types it, the number is proven.
 */
export function PhoneStep() {
  const { t } = useTranslation();
  const { phoneStep: info, afterLogin, cancelPick } = useSession();
  const [phone, setPhone] = useState(info?.current ?? '');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<PhoneSent | null>(null);
  const [wait, setWait] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  // wrong or already used: said under the field while it is typed
  const check = usePhoneProblem(phone, DEMO_ONLY || !info ? undefined : (p) => phoneCheck(p, info.ticket));
  // the seconds before another code can be asked
  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(id);
  }, [wait]);
  if (!info) return null;
  const go = async (withCode: boolean) => {
    setError('');
    setBusy(true);
    try {
      const r = await server.phone({ ticket: info.ticket, phone: sent && withCode ? sent.phone : phone, code: withCode ? code : undefined, shop: info.shop });
      if ('sent' in r) {
        setSent(r);
        setCode('');
        setWait(r.wait);
        window.setTimeout(() => codeRef.current?.focus(), 50);
      } else afterLogin(r);
    } catch (e: any) {
      setError(e?.message || t('common.error'));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void go(!!sent);
  };
  const first = (info.account.name || '').split(' ')[0] || info.account.email;
  return (
    <Page title={t('auth.phone1')} mark={t('auth.phone2')} sub={info.otp ? t('auth.phoneOtpText', { name: first }) : t('auth.phoneText', { name: first })}>
      <form className="px-acc-form" onSubmit={submit}>
        {!sent ? (
          <label className="field">
            <span className="lab">{t('auth.phone')}</span>
            <input dir="ltr" inputMode="tel" required minLength={9} maxLength={30} autoComplete="tel" autoFocus aria-invalid={!!check.problem} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0555 12 34 56" />
            {check.problem ? <span className="form-err">{t(`auth.phoneErr.${check.problem}`)}</span> : <span className="hint">{info.otp ? t('auth.phoneOtpHint') : t('auth.phoneUnique')}</span>}
          </label>
        ) : (
          <>
            <p className="pxa-note">
              <Icon name="phone" /> {t('auth.codeSent', { phone: sent.masked })}
            </p>
            <label className="field">
              <span className="lab">{t('auth.code')}</span>
              <input
                ref={codeRef}
                dir="ltr"
                className="px-otp"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••••"
              />
              <span className="hint">{t('auth.codeHint', { min: Math.round(sent.ttl / 60) })}</span>
            </label>
          </>
        )}
        {error && <p className="form-err">{error}</p>}
        <button className="pxa-submit" disabled={busy || (!!sent && code.length !== 6) || (!sent && !!check.problem)}>
          {busy ? '…' : sent ? t('auth.codeCheck') : info.otp ? t('auth.codeSend') : t('auth.phoneSave')}
        </button>
        {sent && (
          <p className="pxa-alt">
            <button type="button" className="login-link" disabled={busy || wait > 0} onClick={() => void go(false)}>
              {wait > 0 ? t('auth.codeAgainIn', { s: wait }) : t('auth.codeAgain')}
            </button>{' '}
            ·{' '}
            <button
              type="button"
              className="login-link"
              disabled={busy}
              onClick={() => {
                setSent(null);
                setCode('');
                setError('');
              }}
            >
              {t('auth.phoneChange')}
            </button>
          </p>
        )}
      </form>
      <button type="button" className="pxa-back" onClick={cancelPick}>
        {t('login.backToLogin')}
      </button>
    </Page>
  );
}

/** After the password: the person's stores (or « create your first store » when none is left). */
export function StorePicker() {
  const { t } = useTranslation();
  const { picker, pick, cancelPick, enter } = useSession();
  const [busy, setBusy] = useState<number | null>(null);
  // a new account (no store yet): the first store's form straight away
  const first = !!picker && !picker.stores.length && picker.canAddStore;
  // after Google/Facebook on the sign-up page: the account type chosen there
  const [adding, setAdding] = useState<Kind | null>(() => {
    if (!first) return null;
    let k: string | null = null;
    try {
      k = sessionStorage.getItem(SOCIAL_KIND);
      sessionStorage.removeItem(SOCIAL_KIND);
    } catch {}
    if (k === 'agency' && picker?.canAddAgency) return 'agency';
    if (k === 'marketer' && picker?.canAddMarketer) return 'marketer';
    return 'store';
  });
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
        <AddStoreForm ticket={picker.ticket} kind={adding} onDone={enter} onCancel={first && adding === 'store' ? undefined : () => setAdding(null)} />
      ) : (
        <>
          {picker.canAddStore && (
            <button type="button" className="btn big" onClick={() => setAdding('store')}>
              + {t('shop.acc.addStore')}
            </button>
          )}
          {picker.canAddAgency && (
            <button type="button" className="login-link" onClick={() => setAdding('agency')}>
              <Icon name="headset" /> {t('agency.create')}
            </button>
          )}
          {picker.canAddMarketer && (
            <button type="button" className="login-link" onClick={() => setAdding('marketer')}>
              <Icon name="megaphone" /> {t('agency.mk.create')}
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

/**
 * « Ajouter une boutique » (its name and link), « Créer mon agence » or « Créer mon espace marketer » (its name): the
 * person owns it and enters it.
 */
export function AddStoreForm({ ticket, onDone, onCancel, kind = 'store' }: { ticket?: string; onDone: (s: import('@pilotix/shared').Session) => void; onCancel?: () => void; kind?: Kind }) {
  const { t } = useTranslation();
  const tk = useKindT(kind);
  const partner = kind !== 'store';
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
      onDone(await server.addStore(partner ? { name: name.trim(), kind } : { name: name.trim(), ...(touched && slug ? { slug } : {}) }, ticket));
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
      {partner ? (
        <label className="field">
          <span className="lab">{tk('name')}</span>
          <input required minLength={2} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={tk('namePh')} />
        </label>
      ) : (
        <StoreNameFields name={name} setName={setName} slug={slug} setSlug={setSlug} touched={touched} setTouched={setTouched} />
      )}
      <p className="small muted">{partner ? tk('addText') : t('shop.acc.addText')}</p>
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

export function AddStoreModal({ onClose, kind = 'store' }: { onClose: () => void; kind?: Kind }) {
  const { t } = useTranslation();
  const tk = useKindT(kind);
  const { enter } = useSession();
  return (
    <Modal title={kind !== 'store' ? tk('create') : t('shop.acc.addStore')} onClose={onClose}>
      <AddStoreForm kind={kind} onDone={(s) => (enter(s), onClose())} onCancel={onClose} />
    </Modal>
  );
}

// ---------------------------------------------------------------- « Créer un compte »
/**
 * The sign-up page: the account to make first (a store, a confirmation agency, a marketer: each one its own space),
 * then its name and the person. `kind`: chosen already (#/inscription-agence, #/inscription-marketer).
 */
export function Signup({ referral, kind: chosen }: { referral?: string; kind?: 'agency' | 'marketer' }) {
  const { t, i18n } = useTranslation();
  const [kind, setKind] = useState<Kind>(chosen ?? 'store');
  const tk = useKindT(kind);
  const partner = kind !== 'store';
  const [info, setInfo] = useState<SignupInfo | null>(null);
  // the phone's WhatsApp code (when the server asks it): sent to which number, typed, seconds before another
  const [codeSent, setCodeSent] = useState<PhoneSent | null>(null);
  const [code, setCode] = useState('');
  const [wait, setWait] = useState(0);
  const [codeBusy, setCodeBusy] = useState(false);
  useEffect(() => {
    if (wait <= 0) return;
    const id = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(id);
  }, [wait]);
  const askCode = async () => {
    setError('');
    setCodeBusy(true);
    try {
      const r = await signupCode(f.phone.trim());
      setCodeSent(r);
      setCode('');
      setWait(r.wait);
    } catch (err: any) {
      setError(err?.message || t('common.error'));
    } finally {
      setCodeBusy(false);
    }
  };
  // the referral code comes from the link (#/inscription/CODE): kept, not shown
  const [f, setF] = useState({ name: '', email: '', password: '', phone: '', referral: (referral ?? '').toUpperCase() });
  const [storeName, setStoreName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  // wrong or already used: said under the field while it is typed
  const check = usePhoneProblem(f.phone, DEMO_ONLY ? undefined : (p) => phoneCheck(p));
  useEffect(() => {
    // the preview (no server): the form is shown, nothing can be created
    if (DEMO_ONLY) setInfo({ open: true, trialDays: 14, site: '' });
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
        phone: f.phone.trim(),
        ...(info?.phoneCode ? { phoneCode: code } : {}),
        // a store sign-up opens the account only: the first store is created right after, inside
        storeName: partner ? storeName.trim() : '',
        language: (['fr', 'en', 'ar'].includes(i18n.language) ? i18n.language : 'fr') as 'fr' | 'en' | 'ar',
        ...(!partner && f.referral.trim() ? { referral: f.referral.trim() } : {}),
        terms: true,
        ...(partner ? { kind } : {}),
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
    <Page title={t('auth.signup1')} mark={t('auth.signup2')} sub={partner ? tk('signupText') : t('auth.signupSub')}>
      <AuthTabs on="signup" />
      {!partner && (
        <p className="pxa-badge">
          <Icon name="gift" /> {t('auth.trialBadge', { days: info?.trialDays ?? 14 })}
        </p>
      )}
      <form className="px-acc-form" onSubmit={submit}>
        <label className="field pxa-kind">
          <span className="lab">{t('auth.kind')}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`agency.acct.${k}.t`)}
              </option>
            ))}
          </select>
          <span className="hint">{t(`agency.acct.${kind}.d`)}</span>
        </label>
        <SocialButtons mode="signup" kind={kind} onError={setError} />
        {partner && (
          <label className="field">
            <span className="lab">{tk('name')}</span>
            <input required minLength={2} maxLength={80} value={storeName} onChange={(e) => setStoreName(e.target.value)} placeholder={tk('namePh')} />
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
          <input
            dir="ltr"
            inputMode="tel"
            required
            minLength={9}
            maxLength={30}
            autoComplete="tel"
            value={f.phone}
            onChange={(e) => {
              setF({ ...f, phone: e.target.value });
              // another number: its own code
              if (codeSent) setCodeSent(null);
            }}
            placeholder="0555 12 34 56"
            aria-invalid={!!check.problem}
          />
          {check.problem ? <span className="form-err">{t(`auth.phoneErr.${check.problem}`)}</span> : <span className="hint">{info?.phoneCode ? t('auth.phoneOtpHint') : t('auth.phoneHint')}</span>}
        </label>
        {info?.phoneCode && (
          <div className="px-signup-otp">
            <button type="button" className="btn" disabled={codeBusy || wait > 0 || f.phone.trim().length < 9 || !!check.problem || check.checking} onClick={() => void askCode()}>
              <Icon name="phone" /> {codeBusy ? '…' : wait > 0 ? t('auth.codeAgainIn', { s: wait }) : codeSent ? t('auth.codeAgain') : t('auth.codeSend')}
            </button>
            {codeSent && (
              <label className="field">
                <span className="lab">{t('auth.codeSent', { phone: codeSent.masked })}</span>
                <input
                  dir="ltr"
                  className="px-otp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="••••••"
                />
                <span className="hint">{t('auth.codeHint', { min: Math.round(codeSent.ttl / 60) })}</span>
              </label>
            )}
          </div>
        )}
        <label className="field">
          <span className="lab">{t('login.password')}</span>
          <PasswordInput required minLength={8} maxLength={200} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <span className={`pxa-hint${f.password.length >= 8 ? ' ok' : ''}`}>
            <i /> {t('auth.pwMin')}
          </span>
        </label>
        {error && <p className="form-err">{error}</p>}
        <button className="pxa-submit" disabled={busy || !!check.problem || (!!info?.phoneCode && (!codeSent || code.length !== 6))}>
          {busy ? '…' : partner ? tk('signupSubmit') : t('auth.createAccount')}
        </button>
        <p className="pxa-legalnote">
          {t('auth.accept1')}{' '}
          <a href="#/conditions" target="_blank" rel="noreferrer">
            {t('auth.terms')}
          </a>{' '}
          {t('auth.accept2')}{' '}
          <a href="#/conditions" target="_blank" rel="noreferrer">
            {t('auth.privacyFull')}
          </a>
          .
        </p>
      </form>
      <p className="pxa-alt">
        {t('auth.haveAccountQ')} <a href="#/">{t('auth.signIn')}</a>
      </p>
    </Page>
  );
}

/** The sign-up e-mail's link: the store is made and the person enters it. */
export function SignupConfirm({ token }: { token: string }) {
  const { t } = useTranslation();
  const { enter, afterLogin } = useSession();
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
        // the number's WhatsApp code first (when Pilotix asks it), or (account-only sign-up) the picker, where the
        // first store is created
        if (isPhone(r) || 'pick' in r) {
          afterLogin(r);
          return home('#/');
        }
        enter(r);
        home('#/accueil');
      })
      .catch((e) => {
        setMsg(e?.message ?? t('common.error'));
        setState('error');
      });
  }, [token, enter, afterLogin, t]);
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
