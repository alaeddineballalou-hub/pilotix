// Landing pages › Réglages › Pixels: the shop's Meta and TikTok pixels, by name (each with its own token if wanted),
// and the two menus a landing page or a group page uses to pick its Meta pixel and its TikTok pixel.
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Out } from '../../lib/backend';
import { useAction, useRpc } from '../../lib/query';
import { useSession } from '../../lib/session';
import { Field, Icon, Loading } from '../../ui/kit';
import { toast } from '../../ui/toast';

type Pixel = Out<'landing.pixels'>[number];
type Platform = 'meta' | 'tiktok';
const PLATFORMS: Platform[] = ['meta', 'tiktok'];

/** The pixels of the shop (Réglages). */
export function PixelsCard() {
  const { t } = useTranslation();
  const q = useRpc('landing.pixels', {});
  const [edit, setEdit] = useState<{ platform: Platform; p: Pixel | null } | null>(null);
  return (
    <section className="card">
      <h2>
        <Icon name="megaphone" /> {t('landing.px.title')}
      </h2>
      <p className="pd-note">{t('landing.px.help')}</p>
      {q.isLoading && <Loading />}
      <div className="lp-px-cols">
        {PLATFORMS.map((pf) => {
          const list = (q.data ?? []).filter((p) => p.platform === pf);
          return (
            <div key={pf} className="lp-px-col">
              <h3>
                <span className={`lp-px-logo ${pf}`} aria-hidden="true">
                  {pf === 'meta' ? 'f' : '♪'}
                </span>
                {t(`landing.px.${pf}`)}
              </h3>
              {!list.length && <p className="muted small">{t('landing.px.none')}</p>}
              <ul className="lp-px-list">
                {list.map((p) => (
                  <li key={p.id}>
                    <span className="lp-px-b">
                      <b dir="auto">
                        {p.name} {p.isDefault && <span className="chip lp-on">{t('landing.px.default')}</span>}
                      </b>
                      <small>
                        <code className="ltr">{p.pixelId}</code>
                        <span className={`chip ${p.hasToken ? 'lp-on' : pf === 'tiktok' ? 'lp-warn' : ''}`}>{p.hasToken ? t('landing.px.tokenOk') : pf === 'tiktok' ? t('landing.px.tokenNeeded') : t('landing.px.tokenShop')}</span>
                        <span className="muted">{t('landing.px.used', { count: p.pages })}</span>
                      </small>
                    </span>
                    <button type="button" className="btn small" onClick={() => setEdit({ platform: pf, p })}>
                      <Icon name="pencil" /> {t('landing.list.edit')}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn small" onClick={() => setEdit({ platform: pf, p: null })}>
                <Icon name="plus" /> {t(`landing.px.add.${pf}`)}
              </button>
            </div>
          );
        })}
      </div>
      {edit && <PixelForm key={`${edit.platform}-${edit.p?.id ?? 'new'}`} platform={edit.platform} p={edit.p} onClose={() => setEdit(null)} />}
    </section>
  );
}

function PixelForm({ platform, p, onClose }: { platform: Platform; p: Pixel | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { session } = useSession();
  const admin = !!session?.isAdmin;
  const [f, setF] = useState({ name: p?.name ?? '', pixelId: p?.pixelId ?? '', testCode: p?.testCode ?? '', isDefault: p?.isDefault ?? false, token: '' });
  const save = useAction('landing.pixelSave', { success: t('landing.px.saved'), onDone: onClose });
  const remove = useAction('landing.pixelRemove', { success: t('landing.px.removed'), onDone: onClose });
  const submit = (token: string | null = f.token.trim()) =>
    save.mutate({ id: p?.id, platform, name: f.name.trim(), pixelId: f.pixelId.trim(), testCode: f.testCode.trim(), isDefault: f.isDefault, token: admin ? token : '' });
  return (
    <div className="lp-px-form">
      <h3>{p ? t('landing.px.editTitle', { name: p.name }) : t(`landing.px.add.${platform}`)}</h3>
      <div className="grid2">
        <Field label={t('landing.px.name')}>
          <input dir="auto" value={f.name} maxLength={80} placeholder={t('landing.px.namePh')} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={t(`landing.px.id.${platform}`)} hint={t(`landing.px.idHint.${platform}`)}>
          <input
            className="ltr"
            value={f.pixelId}
            placeholder={platform === 'meta' ? '123456789012345' : 'CQ1AB2C3D4E5F6G7H8I9'}
            inputMode={platform === 'meta' ? 'numeric' : undefined}
            onChange={(e) => setF({ ...f, pixelId: platform === 'meta' ? e.target.value.replace(/\D/g, '') : e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })}
          />
        </Field>
      </div>
      <Field label={t(`landing.px.token.${platform}`)} hint={admin ? t(`landing.px.tokenHint.${platform}`) : t('landing.px.tokenAdmin')}>
        <div className="lp-copy">
          <input className="ltr" type="password" autoComplete="off" disabled={!admin} value={f.token} placeholder={p?.hasToken ? '••••••••' : ''} onChange={(e) => setF({ ...f, token: e.target.value })} />
          {admin && p?.hasToken && (
            <button type="button" className="btn small ghost danger" disabled={save.isPending} onClick={() => window.confirm(t('landing.px.removeTokenAsk')) && submit(null)}>
              {t('landing.set.removeToken')}
            </button>
          )}
        </div>
      </Field>
      {platform === 'tiktok' && (
        <Field label={t('landing.px.testCode')} hint={t('landing.px.testCodeHint')}>
          <input className="ltr" value={f.testCode} placeholder="TEST12345" onChange={(e) => setF({ ...f, testCode: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })} />
        </Field>
      )}
      <label className="check">
        <input type="checkbox" checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} />
        {t('landing.px.makeDefault')}
      </label>
      <div className="lp-px-a">
        {p && (
          <button type="button" className="btn ghost danger" disabled={remove.isPending} onClick={() => window.confirm(t('landing.px.removeAsk', { name: p.name })) && remove.mutate({ id: p.id })}>
            <Icon name="trash" /> {t('landing.px.remove')}
          </button>
        )}
        <span className="grow" />
        <button type="button" className="btn ghost" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn primary" disabled={save.isPending || !f.name.trim() || !f.pixelId.trim()} onClick={() => submit()}>
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}

/** A landing page's or group's pixels: null = the default pixel, [] = none, else the ticked ones (several allowed). */
export function PixelSelects({
  meta,
  tiktok,
  onChange,
}: {
  meta: number[] | null;
  tiktok: number[] | null;
  onChange: (k: 'metaPixels' | 'tiktokPixels', v: number[] | null) => void;
}) {
  const { t } = useTranslation();
  const q = useRpc('landing.pixels', {});
  const list = q.data ?? [];
  const pick = (pf: Platform, v: number[] | null) => {
    const mine = list.filter((p) => p.platform === pf);
    const def = mine.find((p) => p.isDefault);
    const key = pf === 'meta' ? 'metaPixels' : 'tiktokPixels';
    const mode = v === null ? 'd' : v.length ? 'c' : 'n';
    return (
      <Field label={t(`landing.px.pick.${pf}`)} hint={!mine.length ? t('landing.px.noneYet') : undefined}>
        <select
          value={mode}
          onChange={(e) => onChange(key, e.target.value === 'd' ? null : e.target.value === 'n' ? [] : def ? [def.id] : mine[0] ? [mine[0].id] : [])}
        >
          <option value="d">{def ? t('landing.px.useDefault', { name: def.name }) : pf === 'meta' ? t('landing.px.useSettings') : t('landing.px.noDefault')}</option>
          {!!mine.length && <option value="c">{t('landing.px.choose')}</option>}
          <option value="n">{t('landing.px.off')}</option>
        </select>
        {mode === 'c' && (
          <div className="lp-px-ticks">
            {mine.map((p) => (
              <label key={p.id} className="check">
                <input
                  type="checkbox"
                  checked={!!v?.includes(p.id)}
                  onChange={(e) => {
                    const next = e.target.checked ? [...(v ?? []), p.id] : (v ?? []).filter((x) => x !== p.id);
                    onChange(key, next.length ? next : null);
                  }}
                />
                <span dir="auto">
                  {p.name} <code className="ltr">{p.pixelId}</code>
                </span>
              </label>
            ))}
          </div>
        )}
      </Field>
    );
  };
  return (
    <div className="grid2">
      {pick('meta', meta)}
      {pick('tiktok', tiktok)}
    </div>
  );
}
