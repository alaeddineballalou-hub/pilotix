// The receipt's photo of a pack bought (made smaller in the browser, as for « J'ai payé »).
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { smallJpeg } from '../../layout/PayClaim';
import { Field } from '../../ui/kit';

const MAX_BYTES = 900 * 1024;

export function PayClaimPhoto({ photo, onPhoto }: { photo: string | null; onPhoto: (p: string | null) => void }) {
  const { t } = useTranslation();
  const [err, setErr] = useState<string | null>(null);
  const pick = async (f: File | undefined) => {
    setErr(null);
    onPhoto(null);
    if (!f) return;
    if (!f.type.startsWith('image/')) return setErr(t('shop.claim.notImage'));
    const r = await smallJpeg(f);
    if (!r) return setErr(t('shop.claim.notImage'));
    if (r.bytes > MAX_BYTES) return setErr(t('shop.claim.tooBig'));
    onPhoto(r.url);
  };
  return (
    <>
      <Field label={t('shop.claim.photo')} hint={t('shop.claim.photoHint')}>
        <input type="file" accept="image/*" onChange={(e) => void pick(e.target.files?.[0])} />
      </Field>
      {err && <p className="form-err">{err}</p>}
      {photo && <img src={photo} alt={t('shop.claim.photo')} style={{ maxWidth: 160, maxHeight: 160, borderRadius: 8 }} />}
    </>
  );
}
