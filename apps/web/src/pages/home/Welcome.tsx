// Accueil › « Venez avec vos données » (20 Nov 2026): a shop coming from its old app brings everything in 4 steps —
// its products (Excel), its clients with their history (the clients file or the orders file of the old app), its
// delivery company, its team. Each step opens its import here or goes to its page; a step done shows what is in.
// The owner's only (admin); gone once the 4 are done, or when he hides it (saved with his account).
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { n } from '../../lib/format';
import { useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { useUiPrefs } from '../../lib/ui';
import { Icon, Loading } from '../../ui/kit';
import './welcome.css';

// the two imports open right here (their own code and styles load only when asked)
const ImportProducts = lazy(() => Promise.all([import('../depot/ImportDialog'), import('../depot/produits.css')]).then(([m]) => ({ default: m.ImportDialog })));
const ImportClients = lazy(() =>
  import('../clients/ImportClients').then((m) => ({
    default: m.ImportClients,
  })),
);

const HIDE = 'home.welcome.hidden';
type StepKey = 'products' | 'clients' | 'delivery' | 'team';
type Step = {
  key: StepKey;
  icon: string;
  done: boolean;
  count: number;
  open?: 'products' | 'clients';
  href?: string;
};

export function Welcome() {
  const { t } = useTranslation();
  const { session } = useSession();
  const ui = useUiPrefs();
  const owner = !!session?.isAdmin && !session.profile.agencyId;
  const hidden = ui.get<boolean>(HIDE) === true;
  const q = useRpc('welcome.status', {}, { enabled: owner && !hidden, retry: false });
  const [open, setOpen] = useState<'products' | 'clients' | null>(null);
  const d = q.data;
  // an import opened here stays open until it is closed, even when it finishes the last step (its result shows)
  const dialog = open && (
    <Suspense fallback={<Loading />}>
      {open === 'products' ? <ImportProducts onClose={() => setOpen(null)} /> : <ImportClients onClose={() => setOpen(null)} />}
    </Suspense>
  );
  // the card and the dialog keep their places side by side: the card going away never closes (or resets) the dialog
  if (!owner) return null;
  if (hidden || !d)
    return (
      <>
        {null}
        {dialog}
      </>
    );

  const steps: Step[] = [
    {
      key: 'products',
      icon: 'package',
      done: d.products > 0,
      count: d.products,
      open: 'products',
    },
    {
      key: 'clients',
      icon: 'users',
      done: d.importedClients > 0,
      count: d.importedClients,
      open: 'clients',
    },
    {
      key: 'delivery',
      icon: 'truck',
      done: d.couriers > 0,
      count: d.couriers,
      href: '#/livraison/societes',
    },
    {
      key: 'team',
      icon: 'userplus',
      done: d.team > 1,
      count: d.team,
      href: '#/utilisateurs',
    },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length)
    return (
      <>
        {null}
        {dialog}
      </>
    );
  const next = steps.find((s) => !s.done)?.key;

  return (
    <>
      <section className="card wl" aria-labelledby="wl-title">
        <header className="wl-head">
          <span className="wl-badge" aria-hidden="true">
            <Icon name="sparkles" />
          </span>
          <div className="wl-ht">
            <h2 id="wl-title">{t('home.welcome.title')}</h2>
            <p>{t('home.welcome.lead')}</p>
          </div>
          <button type="button" className="btn small ghost wl-hide" onClick={() => ui.set(HIDE, true)}>
            <Icon name="x" />
            {t('home.welcome.hide')}
          </button>
        </header>
        <div className="wl-progress">
          <span className="wl-bar" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done} aria-label={t('home.welcome.title')}>
            <i style={{ width: `${(done / steps.length) * 100}%` }} />
          </span>
          <b className="ltr">{t('home.welcome.progress', { done, total: steps.length })}</b>
        </div>
        <ol className="wl-steps">
          {steps.map((s, k) => {
            const label = (
              <>
                <Icon name={s.done ? 'checkcircle' : s.icon} />
                {t(`home.welcome.${s.key}.go`)}
              </>
            );
            return (
              <li key={s.key} className={`wl-step${s.done ? ' done' : ''}${s.key === next ? ' next' : ''}`}>
                <span className="wl-num ltr" aria-hidden="true">
                  {s.done ? <Icon name="check" /> : k + 1}
                </span>
                <div className="wl-txt">
                  <b>{t(`home.welcome.${s.key}.title`)}</b>
                  <small>
                    {s.done
                      ? t(`home.welcome.${s.key}.done`, {
                          count: s.count,
                          n: n(s.count),
                        })
                      : t(`home.welcome.${s.key}.text`)}
                  </small>
                </div>
                {s.open ? (
                  <button type="button" className={`btn small${s.key === next ? ' primary' : ''}`} onClick={() => setOpen(s.open!)}>
                    {label}
                  </button>
                ) : (
                  <a className={`btn small${s.key === next ? ' primary' : ''}`} href={s.href}>
                    {label}
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      </section>
      {dialog}
    </>
  );
}
