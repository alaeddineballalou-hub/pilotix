// Management › Statuts › « Messages client »: the shop writes the two messages its agents send a customer who does not
// answer (the owner's rule, 24 Nov 2026): at the try chosen in « Appels de confirmation » (3 at the start), and before
// the order is cancelled after the shop's number of unanswered calls, with the reactivation link. The buttons put the
// order's values in the box being written ({الاسم}…); « Aperçu client » shows both on a pretend order, as the customer
// reads them on WhatsApp or in an SMS.
import {
  CUSTOMER_MESSAGE_MAX, CUSTOMER_MESSAGE_SAMPLE, type CustomerMessageVar, customerMessageValues, fillCustomerMessage, REACTIVATION_VAR,
} from '@pilotix/shared';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAction, useRpc } from '../../lib/query';
import { Card, ErrorBox, Loading } from '../../ui/kit';
import './customer-messages.css';

type Box = 'attempt' | 'cancel';
/** the buttons, in the order of the owner's design (the link last) */
const CHIPS: { v: CustomerMessageVar; key: string }[] = [
  { v: 'الاسم', key: 'name' },
  { v: 'المتجر', key: 'shop' },
  { v: 'رقم_الطلب', key: 'ref' },
  { v: 'المنتجات', key: 'products' },
  { v: 'الكميات', key: 'qty' },
  { v: 'التوصيل', key: 'delivery' },
  { v: 'الإجمالي', key: 'total' },
  { v: REACTIVATION_VAR, key: 'link' },
];
const LINK_TAG = `{${REACTIVATION_VAR}}`;

export function CustomerMessagesCard() {
  const { t } = useTranslation();
  const q = useRpc('confirmation.messages.get', {});
  const save = useAction('confirmation.messages.save', { success: t('admin.cmsg.saved') });
  const [v, setV] = useState<Record<Box, string> | null>(null);
  const [focus, setFocus] = useState<Box>('attempt');
  const boxes = { attempt: useRef<HTMLTextAreaElement>(null), cancel: useRef<HTMLTextAreaElement>(null) };
  /** a box written in: a button puts its value at the cursor there (else at the end) */
  const touched = useRef<Record<Box, boolean>>({ attempt: false, cancel: false });
  useEffect(() => {
    if (q.data && !v) setV({ attempt: q.data.attempt, cancel: q.data.cancel });
  }, [q.data, v]);
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data || !v) return <Loading />;
  const d = q.data;
  const n = d.messageAtTry;

  /** puts {…} where the cursor is, in the box last written in (the link always goes in the cancel message) */
  const insert = (tag: CustomerMessageVar) => {
    const box: Box = tag === REACTIVATION_VAR ? 'cancel' : focus;
    const el = boxes[box].current;
    const text = v[box];
    const atCursor = !!el && touched.current[box];
    const s = atCursor ? el.selectionStart : text.length;
    const e = atCursor ? el.selectionEnd : s;
    const piece = `{${tag}}`;
    setV({ ...v, [box]: `${text.slice(0, s)}${piece}${text.slice(e)}` });
    setFocus(box);
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(s + piece.length, s + piece.length);
    });
  };
  const changed = v.attempt.trim() !== d.attempt || v.cancel.trim() !== d.cancel;
  const empty = !v.attempt.trim() || !v.cancel.trim();

  const box = (k: Box, label: string) => (
    <label className="cmx-field">
      <span className="cmx-lab">{label}</span>
      <textarea
        ref={boxes[k]}
        dir="rtl"
        lang="ar"
        rows={6}
        maxLength={CUSTOMER_MESSAGE_MAX}
        value={v[k]}
        onFocus={() => {
          setFocus(k);
          touched.current[k] = true;
        }}
        onChange={(e) => setV({ ...v, [k]: e.target.value })}
      />
      <span className="cmx-under">
        <small className="muted">{t('admin.cmsg.chars', { n: v[k].length, max: CUSTOMER_MESSAGE_MAX })}</small>
        {v[k].trim() !== d.defaults[k] && (
          <button type="button" className="linkish" onClick={() => setV({ ...v, [k]: d.defaults[k] })}>
            {t('admin.cmsg.default')}
          </button>
        )}
      </span>
    </label>
  );

  return (
    <>
      <Card title={t('admin.cmsg.title')} help={t('admin.cmsg.help', { n })} className="cmx">
        <div className="cmx-chips" role="group" aria-label={t('admin.cmsg.vars')}>
          {CHIPS.map((c) => (
            <button key={c.key} type="button" className="cmx-chip" title={`{${c.v}}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(c.v)}>
              {t(`admin.cmsg.var.${c.key}`)}
            </button>
          ))}
        </div>
        <div className="cmx-cols">
          {box('attempt', t('admin.cmsg.attempt', { n }))}
          {box('cancel', t('admin.cmsg.cancel'))}
        </div>
        <p className="muted small cmx-note">{d.cancelAfterNoAnswer > 0 ? t('admin.cmsg.when', { n, x: d.cancelAfterNoAnswer }) : t('admin.cmsg.whenOff', { n })}</p>
        <div className="row end">
          <button type="button" className="btn primary" disabled={save.isPending || !changed || empty} onClick={() => save.mutate({ attempt: v.attempt.trim(), cancel: v.cancel.trim() })}>
            {t('admin.cmsg.save')}
          </button>
        </div>
      </Card>
      <Card title={t('admin.cmsg.preview')} className="cmx">
        <div className="cmx-cols">
          <Preview title={t('admin.cmsg.attempt', { n })} text={v.attempt} shop={d.shopName} />
          <Preview title={t('admin.cmsg.cancel')} text={v.cancel} shop={d.shopName} link={t('admin.cmsg.linkText')} />
        </div>
      </Card>
    </>
  );
}

/** One message on the pretend order; the link is shown as the words the customer taps. */
function Preview({ title, text, shop, link }: { title: string; text: string; shop: string; link?: string }) {
  const values = customerMessageValues({ ...CUSTOMER_MESSAGE_SAMPLE, shop });
  // the first message has no link: a {رابط_إعادة_التفعيل} written there is left out, as the agent's screen does
  const filled = fillCustomerMessage(text, link ? values : { ...values, [REACTIVATION_VAR]: '' });
  const withLink = link && !filled.includes(LINK_TAG) ? `${filled}\n${LINK_TAG}` : filled;
  const parts = withLink.split(LINK_TAG);
  return (
    <div className="cmx-pv">
      <h3>{title}</h3>
      <p dir="rtl" lang="ar" className="cmx-msg">
        {parts.map((p, i) => (
          <Fragment key={i}>
            {p}
            {i < parts.length - 1 && <u className="cmx-link">{link}</u>}
          </Fragment>
        ))}
      </p>
    </div>
  );
}
