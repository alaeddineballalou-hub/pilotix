// The sign-in page's designs (#/platform/designs): the 20 designs, each with a small live picture and a switch. Every
// visit of the sign-in page shows one of those turned on, at random (the same computer can get another one next time).
// In the preview (no server) the choice is kept on this computer.
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEMO_ONLY } from '../../lib/backend';
import { Staff, usePAction, usePRpc } from '../../lib/platform';
import { toast } from '../../ui/toast';
import { localDesigns, saveLocalDesigns, THEME_COUNT, ThemeGround, ThemePanel, THEMES } from '../../layout/authThemes';
import '../../layout/auth.css';

const ALL = Array.from({ length: THEME_COUNT }, (_, i) => i + 1);

export function LoginDesigns({ staff, demo }: { staff: Staff; demo?: boolean }) {
  const { t } = useTranslation();
  const q = usePRpc('p.settings.get', {}, { enabled: !demo });
  const save = usePAction('p.settings.save', { success: t('platform.saved') });
  const owner = demo || staff.role === 'owner';
  const saved = demo ? (localDesigns() ?? ALL) : (q.data?.login?.designs ?? ALL);
  const [on, setOn] = useState<number[]>(saved);
  useEffect(() => {
    if (!demo && q.data) setOn(q.data.login?.designs ?? ALL);
  }, [q.data, demo]);
  const dirty = [...on].sort((a, b) => a - b).join() !== [...saved].sort((a, b) => a - b).join();
  const flip = (id: number) => {
    if (on.includes(id)) {
      if (on.length === 1) return toast(t('platform.designs.keepOne'), 'bad');
      setOn(on.filter((x) => x !== id));
    } else setOn([...on, id].sort((a, b) => a - b));
  };
  const store = () => {
    if (demo || DEMO_ONLY) {
      saveLocalDesigns(on);
      toast(t('platform.saved'), 'ok');
      setOn([...on]);
    } else save.mutate({ login: { designs: on } });
  };
  return (
    <div className="pp-stack">
      <div className="pp-head">
        <div>
          <h1>{t('platform.nav.designs')}</h1>
          <p className="muted">{t('platform.designs.sub', { n: on.length, total: THEME_COUNT })}</p>
        </div>
        {owner && (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={() => setOn(ALL)} disabled={on.length === THEME_COUNT}>
              {t('platform.designs.all')}
            </button>
            <a className="btn" href="#/" target="_blank" rel="noreferrer">
              {t('platform.designs.open')}
            </a>
            <button type="button" className="btn primary" disabled={!dirty || save.isPending} onClick={store}>
              {t('common.save')}
            </button>
          </div>
        )}
      </div>
      <div className="pp-designs">
        {THEMES.map((th) => {
          const active = on.includes(th.id);
          return (
            <label key={th.id} className={`pp-design ${active ? 'on' : ''}`}>
              <div className={`pp-design-pic pxt pxt-${th.layout} pxt-id${th.id}${th.dark ? ' pxt-dark' : ''}`}>
                {th.layout === 'split' ? <ThemePanel theme={th} /> : <ThemeGround theme={th} />}
              </div>
              <span className="pp-design-foot">
                <span className="pp-design-n ltr">{th.id}</span>
                <span className="pp-design-t">{t(`platform.designs.n${th.id}`)}</span>
                <span className="pp-switch">
                  <input type="checkbox" checked={active} disabled={!owner} onChange={() => flip(th.id)} aria-label={t(`platform.designs.n${th.id}`)} />
                  <i aria-hidden="true" />
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
