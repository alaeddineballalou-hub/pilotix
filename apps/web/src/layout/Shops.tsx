// One person, several shops: the store picker after login, and « Mes boutiques » (switch shop, add a shop) from the
// account menu. A shop that did not open at login asks its own password (each shop keeps its accounts).
import { FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addShop, myShops, serverUrl, ShopChoice, slugCheck } from '../lib/backend';
import { useSession } from '../lib/session';
import { Icon } from '../ui/kit';
import { Modal } from '../ui/modal';

/** The shops as cards: name, its address on the platform, my role, its state. */
export function ShopList({ shops, busy, onPick }: { shops: ShopChoice[]; busy: number | null; onPick: (s: ShopChoice) => void }) {
  const { t } = useTranslation();
  return (
    <div className="px-shops" role="list">
      {shops.map((s) => (
        <button key={s.id} type="button" role="listitem" className={`px-shop ${s.current ? 'on' : ''}`} disabled={busy !== null || s.current} onClick={() => onPick(s)}>
          <span className="px-shop-ic" aria-hidden="true">
            {s.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="px-shop-t">
            <b>{s.name}</b>
            <small>
              <span className="ltr">/{s.slug}</span> · {s.roles.map((r) => t(`roles.${r}`, { defaultValue: r })).join(', ')}
            </small>
          </span>
          {s.current ? (
            <span className="chip">{t('shop.picker.current')}</span>
          ) : s.locked ? (
            <span className="chip px-shop-lock">{t('shop.picker.locked')}</span>
          ) : s.open === false ? (
            <Icon name="lock" />
          ) : (
            <Icon name="chevron" className="px-shop-go" />
          )}
          {busy === s.id && <span className="px-shop-busy">…</span>}
        </button>
      ))}
    </div>
  );
}

/** After login, when the password opens several shops. */
export function StorePicker({ shops, onBack }: { shops: ShopChoice[]; onBack: () => void }) {
  const { t } = useTranslation();
  const { enter } = useSession();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');
  const pick = async (s: ShopChoice) => {
    setBusy(s.id);
    setError('');
    try {
      await enter(s.id);
    } catch (e: any) {
      setError(e?.message || t('common.error'));
      setBusy(null);
    }
  };
  return (
    <div className="login">
      <div className="card login-card">
        <span className="brand-big" role="img" aria-label="Pilotix">
          Pilotix
        </span>
        <h2 className="login-title">{t('shop.picker.title')}</h2>
        <p className="login-note">{t('shop.picker.text', { count: shops.length })}</p>
        <ShopList shops={shops} busy={busy} onPick={pick} />
        {error && <p className="form-err">{error}</p>}
        <button type="button" className="login-link" onClick={onBack}>
          {t('login.backToLogin')}
        </button>
      </div>
    </div>
  );
}

/** « Mes boutiques »: my shops (switch), and « Ajouter une boutique ». */
export function MyShops({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { session, enter, adopt } = useSession();
  const [shops, setShops] = useState<ShopChoice[] | null>(null);
  const [canAdd, setCanAdd] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [ask, setAsk] = useState<ShopChoice | null>(null);
  const [password, setPassword] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    myShops()
      .then((r) => (setShops(r.shops), setCanAdd(!!r.canAdd)))
      .catch((e) => setError(e?.message || t('common.error')));
  }, [t]);
  const go = async (s: ShopChoice, pw?: string) => {
    setBusy(s.id);
    setError('');
    try {
      await enter(s.id, pw ? { email: session!.profile.email, password: pw } : undefined);
      onClose();
    } catch (e: any) {
      // the login's proof expired, or this shop has its own password: ask it
      if (!pw) setAsk(s);
      else setError(e?.message || t('common.error'));
      setBusy(null);
    }
  };
  const pick = (s: ShopChoice) => (s.open === false ? (setAsk(s), setPassword(''), setError('')) : go(s));
  return (
    <Modal title={adding ? t('shop.add.title') : t('shop.picker.mine')} onClose={onClose}>
      {adding ? (
        <AddShop
          onDone={(s) => {
            adopt(s);
            onClose();
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className="px-form">
          {!shops && !error && <p className="muted">…</p>}
          {shops && <ShopList shops={shops} busy={busy} onPick={pick} />}
          {ask && (
            <form
              className="px-shop-ask"
              onSubmit={(e) => {
                e.preventDefault();
                void go(ask, password);
              }}
            >
              <label className="field">
                <span className="lab">{t('shop.picker.password', { shop: ask.name })}</span>
                <input type="password" dir="ltr" autoComplete="current-password" required autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
                <span className="hint">{t('shop.picker.passwordHint')}</span>
              </label>
              <button className="btn primary" disabled={busy !== null || !password}>
                {t('shop.picker.open')}
              </button>
            </form>
          )}
          {error && <p className="form-err">{error}</p>}
          {canAdd && !session?.shop?.demo && (
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              <Icon name="plus" />
              {t('shop.add.button')}
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

/** The store's part of the links, checked as it is typed (free? valid?). */
export function useSlug(name: string) {
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const [check, setCheck] = useState<{ slug: string; valid: boolean; available: boolean; suggestion: string } | null>(null);
  useEffect(() => {
    const want = touched ? { slug } : { name };
    if (!(touched ? slug : name).trim()) return setCheck(null);
    const id = window.setTimeout(() => {
      slugCheck(want)
        .then((r) => {
          setCheck(r);
          if (!touched) setSlug(r.available ? r.slug : r.suggestion);
        })
        .catch(() => setCheck(null));
    }, 350);
    return () => window.clearTimeout(id);
  }, [name, slug, touched]);
  const edit = (v: string) => {
    setTouched(true);
    setSlug(v.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40));
  };
  const ok = !!check && check.slug === slug && check.available;
  return { slug, edit, check, ok };
}

/** The address field of a new shop: site/<store>/… with « libre » / « déjà pris ». */
export function SlugField({ s, base }: { s: ReturnType<typeof useSlug>; base: string }) {
  const { t } = useTranslation();
  const c = s.check;
  return (
    <label className="field">
      <span className="lab">{t('shop.signup.slug')}</span>
      <div className="px-slug">
        <span className="ltr">{base.replace(/^https?:\/\//, '')}/</span>
        <input dir="ltr" value={s.slug} maxLength={40} onChange={(e) => s.edit(e.target.value)} required />
      </div>
      <span className={`hint ${c && c.slug === s.slug ? (c.available ? 'px-ok' : 'px-bad') : ''}`}>
        {!c || c.slug !== s.slug
          ? t('shop.signup.slugHint')
          : c.available
            ? t('shop.signup.slugFree')
            : !c.valid
              ? t('shop.signup.slugInvalid')
              : t('shop.signup.slugTaken', { suggestion: c.suggestion })}
      </span>
    </label>
  );
}

/** « Ajouter une boutique »: a new shop for me, on a free trial (my password asked again). */
function AddShop({ onDone, onCancel }: { onDone: (s: import('@pilotix/shared').Session) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const s = useSlug(name);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await addShop({ shopName: name.trim(), slug: s.slug, password });
      onDone(r.session);
    } catch (err: any) {
      setError(err?.message || t('common.error'));
      setBusy(false);
    }
  };
  return (
    <form className="px-form" onSubmit={submit}>
      <p className="login-note">{t('shop.add.text')}</p>
      <label className="field">
        <span className="lab">{t('shop.signup.shopName')}</span>
        <input value={name} maxLength={80} required autoFocus onChange={(e) => setName(e.target.value)} />
      </label>
      <SlugField s={s} base={serverUrl() || location.origin} />
      <label className="field">
        <span className="lab">{t('shop.add.password')}</span>
        <input type="password" dir="ltr" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <span className="hint">{t('shop.add.passwordHint')}</span>
      </label>
      {error && <p className="form-err">{error}</p>}
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button className="btn primary" disabled={busy || !name.trim() || !s.ok || !password}>
          {busy ? '…' : t('shop.add.create')}
        </button>
      </div>
    </form>
  );
}
