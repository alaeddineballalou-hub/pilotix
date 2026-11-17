// Landing page editor › Description: pictures inside the text. « Ajouter une image » makes the picture light like the
// page's photos (webp.ts; a long poster keeps more weight, so its text stays sharp), stores it, and the editor writes
// its line « [image:12] » where the cursor is. That line IS the picture: moved or erased like any text. Under the text,
// each picture of the description with « Retirer » (a line whose picture is not the shop's shows nothing on the page).
import { LANDING_DESC_IMAGES_MAX, landingDescriptionImageIds, landingDescriptionImageLine } from '@pilotix/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { rpc } from '../../lib/backend';
import { Icon } from '../../ui/kit';
import { toast } from '../../ui/toast';
import { presetOf } from './Photos';
import { optimize, TALL_MAX, TooTall } from './webp';

/** a description's picture as the editor knows it (small copies, as data) */
export type DescImg = { id: number; w: number; h: number; thumb: string; src: string };

export function DescImages({
  text,
  known,
  onAdd,
  onRemove,
  onBusy,
}: {
  text: string;
  /** the pictures the editor has seen (the saved page's, and the ones added in this visit) */
  known: Record<number, DescImg>;
  onAdd: (img: DescImg) => void;
  onRemove: (id: number) => void;
  onBusy: (n: number) => void;
}) {
  const { t } = useTranslation();
  const [work, setWork] = useState<{ i: number; n: number } | null>(null);
  const ids = landingDescriptionImageIds(text);
  const left = LANDING_DESC_IMAGES_MAX - ids.length;

  const add = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    if (list.length > left) toast(t('landing.ed.di.max', { n: LANDING_DESC_IMAGES_MAX }), 'bad');
    const todo = list.slice(0, Math.max(0, left));
    if (!todo.length) return;
    onBusy(1);
    try {
      for (let k = 0; k < todo.length; k++) {
        setWork({ i: k + 1, n: todo.length });
        try {
          const e = await optimize(todo[k], presetOf(), undefined, { tall: true });
          URL.revokeObjectURL(e.compare.orig);
          URL.revokeObjectURL(e.compare.opt);
          const row = await rpc('landing.addImage', { w: e.w, h: e.h, t160: e.t160, w320: e.w320, w480: e.w480, w720: e.w720, w960: e.w960, lqip: e.lqip, info: e.info });
          if (row.id) onAdd({ id: row.id, w: row.w, h: row.h, thumb: row.thumb, src: row.src });
        } catch (err) {
          toast(err instanceof TooTall ? t('landing.ed.di.tooTall', { n: TALL_MAX }) : (err as Error).message || t('landing.ed.di.fail'), 'bad');
        }
      }
    } finally {
      setWork(null);
      onBusy(-1);
    }
  };

  return (
    <div className="lp-di">
      <div className="lp-di-top">
        <label className={`btn small lp-di-add ${work || left <= 0 ? 'off' : ''}`}>
          <input type="file" accept="image/*" multiple disabled={!!work || left <= 0} onChange={(e) => add(e.target.files).then(() => (e.target.value = ''))} />
          <Icon name={work ? 'hourglass' : 'image'} />
          {work ? t('landing.ed.di.working', { i: work.i, n: work.n }) : t('landing.ed.di.add')}
        </label>
        <span className="hint">{left <= 0 ? t('landing.ed.di.max', { n: LANDING_DESC_IMAGES_MAX }) : t('landing.ed.di.hint')}</span>
      </div>
      {ids.length > 0 && (
        <ul className="lp-di-list">
          {ids.map((id) => {
            const im = known[id];
            return (
              <li key={id} className={im ? '' : 'miss'}>
                {im ? (
                  <img src={im.thumb} alt="" />
                ) : (
                  <span className="lp-di-no">
                    <Icon name="alert" />
                  </span>
                )}
                <span className="lp-di-n">
                  <b>{im ? t('landing.ed.di.name', { n: id }) : t('landing.ed.di.missing')}</b>
                  <code className="ltr">{landingDescriptionImageLine(id)}</code>
                </span>
                <button type="button" className="btn small ghost" onClick={() => onRemove(id)}>
                  <Icon name="x" /> {t('landing.ed.di.remove')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
