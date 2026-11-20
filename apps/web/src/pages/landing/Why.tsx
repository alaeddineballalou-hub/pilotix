// « Pourquoi nous »: one picture for the whole shop (why buy here: delivery, payment on delivery, the phone numbers…),
// shown on every landing page, before or after the product's description. Uploaded once; a new one replaces it on all
// the pages at once.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { presetOf } from './Photos';
import { optimize, TALL_MAX, TooTall } from './webp';

export function Why() {
  const { t } = useTranslation();
  const q = useRpc('landing.why.get', {}, { refetchOnWindowFocus: false });
  const save = useAction('landing.why.save', { success: t('landing.why.saved'), onDone: () => q.refetch() });
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const pick = async (file: File | undefined) => {
    if (!file || !d) return;
    setBusy(true);
    try {
      const o = await optimize(file, presetOf(), undefined, { tall: true });
      URL.revokeObjectURL(o.compare.orig);
      URL.revokeObjectURL(o.compare.opt);
      const r = await rpc('landing.addImage', { w: o.w, h: o.h, t160: o.t160, w320: o.w320, w480: o.w480, w720: o.w720, w960: o.w960, lqip: o.lqip, info: o.info });
      if (r.id) save.mutate({ imageId: r.id, first: d.first });
    } catch (e) {
      toast(e instanceof TooTall ? t('landing.ed.di.tooTall', { n: TALL_MAX }) : (e as Error).message || t('landing.ed.di.fail'), 'bad');
    } finally {
      setBusy(false);
    }
  };
  if (!d) return null;
  const working = busy || save.isPending;
  return (
    <section className="card lp-why">
      <h2>
        <Icon name="image" /> {t('landing.why.title')}
        <span className={`chip fold-sum ${d.image ? 'lp-on' : ''}`}>{d.image ? t('landing.fold.whyOn') : t('landing.fold.whyOff')}</span>
      </h2>
      <p className="muted">{t('landing.why.sub', { count: d.pages })}</p>
      <div className="lp-why-row">
        {d.image ? <img className="lp-why-img" src={d.image.thumb} width={96} height={Math.round((96 * d.image.h) / d.image.w)} alt="" /> : <div className="lp-why-none">{t('landing.why.none')}</div>}
        <div className="lp-why-acts">
          <label className={`btn ${d.image ? '' : 'primary'}`}>
            <Icon name="upload" /> {working ? t('landing.ed.di.working') : d.image ? t('landing.why.change') : t('landing.why.add')}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={working} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {d.image && (
            <button type="button" className="btn ghost" disabled={working} onClick={() => save.mutate({ imageId: null, first: d.first })}>
              {t('landing.why.remove')}
            </button>
          )}
        </div>
      </div>
      <fieldset className="lp-why-order" disabled={working}>
        <legend>{t('landing.why.order')}</legend>
        <div className="px-seg" role="radiogroup" aria-label={t('landing.why.order')}>
          <button type="button" role="radio" aria-checked={!d.first} className={d.first ? '' : 'on'} onClick={() => d.first && save.mutate({ imageId: d.imageId, first: false })}>
            {t('landing.why.after')}
          </button>
          <button type="button" role="radio" aria-checked={d.first} className={d.first ? 'on' : ''} onClick={() => !d.first && save.mutate({ imageId: d.imageId, first: true })}>
            {t('landing.why.before')}
          </button>
        </div>
      </fieldset>
    </section>
  );
}
