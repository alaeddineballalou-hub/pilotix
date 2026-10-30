// Every e-mail of accounts and of the platform, in the person's language (fr, en, ar), with the same look as the
// "mot de passe oublié" one: sign-up confirmation, invitation (choose your password), « a store was added to your
// account », e-mail check, reminders before the end of a trial or a paid period, payment receipts, answers from
// Pilotix, referral rewards and the control room's login code.
import type { DueReminder, OwnerMail, QualityAlert, ReferralReward } from '@pilotix/core';
import { config } from './config';
import { Mail } from './mail';

type Lang = 'fr' | 'en' | 'ar';
const lang = (l: string | null | undefined): Lang => (l === 'en' || l === 'ar' ? l : 'fr');
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const NAVY = '#1B2A47';
const ORANGE = '#F5A623';
const LOCALE: Record<Lang, string> = { fr: 'fr-FR', en: 'en-GB', ar: 'ar-DZ' };
const FOOTER: Record<Lang, string> = { fr: 'Pilotix · gestion des commandes', en: 'Pilotix · order management', ar: 'Pilotix · إدارة الطلبات' };
const COPY: Record<Lang, string> = {
  fr: 'Le bouton ne marche pas ? Copiez ce lien dans votre navigateur :',
  en: 'Button not working? Copy this link into your browser:',
  ar: 'الزر لا يعمل؟ انسخ هذا الرابط في متصفحك:',
};
const NOT_YOU: Record<Lang, string> = {
  fr: 'Si ce n’est pas vous, ignorez cet e-mail.',
  en: 'If it was not you, ignore this e-mail.',
  ar: 'إن لم تكن أنت، تجاهل هذه الرسالة.',
};

export const day = (iso: string | null | undefined, l: string) =>
  iso ? new Date(iso).toLocaleDateString(LOCALE[lang(l)], { timeZone: 'Africa/Algiers', day: 'numeric', month: 'long', year: 'numeric' }) : '—';
export const da = (n: number | null | undefined) => `${Math.round(Number(n ?? 0)).toLocaleString('fr-FR').replace(/ | /g, ' ')} DA`;

interface Layout {
  l: Lang;
  title: string;
  icon: string;
  hello: string;
  lines: string[];
  /** label → value rows in a grey box */
  box?: [string, string][];
  button?: { label: string; link: string };
  /** under the button (validity, …) */
  after?: string[];
  /** small print at the bottom */
  note?: string;
  /** free HTML block (the login code's box) */
  html?: string;
  /** the same block for the plain-text version of the e-mail */
  htmlText?: string[];
}

/** Tables and inline styles: what Outlook, Gmail and phone mail apps all show the same way. */
function layout(o: Layout): { html: string; text: string } {
  const rtl = o.l === 'ar';
  const align = rtl ? 'right' : 'left';
  const logo = `${config.publicUrl}/email-logo.png`;
  // a line can hold several (payment details, a message): its line breaks are kept
  const p = (s: string) => `<p style="margin:0 0 12px;font-size:16px;line-height:1.5;color:#3C4A63;">${esc(s).replace(/\r?\n/g, '<br>')}</p>`;
  const box = o.box?.length
    ? `<tr><td style="padding:4px 32px 8px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F6F8FB;border:1px solid #E3E8F0;border-radius:10px;">${o.box
        .map(
          ([k, v]) =>
            `<tr><td style="padding:10px 16px;font-size:14px;color:#5B6577;text-align:${align};">${esc(k)}</td><td style="padding:10px 16px;font-size:14px;font-weight:bold;text-align:${rtl ? 'left' : 'right'};">${esc(v)}</td></tr>`,
        )
        .join('')}</table></td></tr>`
    : '';
  const button = o.button
    ? `<tr><td align="center" style="padding:22px 32px 10px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="${ORANGE}" style="border-radius:10px;"><a href="${esc(o.button.link)}" style="display:inline-block;padding:15px 30px;font-size:17px;font-weight:bold;color:${NAVY};text-decoration:none;border-radius:10px;">${esc(o.button.label)}</a></td></tr></table></td></tr>`
    : '';
  const after = (o.after ?? []).map((s) => `<tr><td align="center" style="padding:6px 32px 6px;font-size:14px;color:#5B6577;">${esc(s)}</td></tr>`).join('');
  const copy = o.button
    ? `<tr><td style="padding:14px 32px 22px;font-size:12px;line-height:1.5;color:#8A93A3;text-align:${align};">${esc(COPY[o.l])}<br><a href="${esc(o.button.link)}" dir="ltr" style="color:#3B6FD8;word-break:break-all;">${esc(o.button.link)}</a></td></tr>`
    : '';
  const note = o.note ? `<tr><td style="padding:10px 32px 18px;font-size:13px;line-height:1.5;color:#5B6577;text-align:${align};">🛡️ ${esc(o.note)}</td></tr>` : '';
  const html = `<!doctype html>
<html lang="${o.l}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(o.title)}</title></head>
<body style="margin:0;padding:0;background:#EEF1F6;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#EEF1F6;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;font-family:Segoe UI,Arial,Helvetica,sans-serif;color:${NAVY};">
  <tr><td align="center" style="background:${NAVY};padding:26px 24px 22px;"><img src="${esc(logo)}" width="150" alt="pilotix" style="display:block;width:150px;max-width:60%;height:auto;border:0;color:#FFFFFF;font-size:28px;font-weight:bold;"></td></tr>
  <tr><td style="height:5px;background:${ORANGE};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:30px 32px 6px;text-align:${align};">
    <div style="font-size:23px;font-weight:bold;margin:0 0 16px;">${o.icon} ${esc(o.title)}</div>
    <p style="margin:0 0 12px;font-size:16px;line-height:1.5;">${esc(o.hello)}</p>
    ${o.lines.map(p).join('')}
  </td></tr>
  ${box}${o.html ?? ''}${button}${after}${copy}${note}
  <tr><td align="center" style="background:#F6F8FB;padding:16px 24px;font-size:12px;color:#8A93A3;">${esc(FOOTER[o.l])} · <a href="${esc(config.publicUrl)}" style="color:#8A93A3;">${esc(config.publicUrl.replace(/^https?:\/\//, ''))}</a></td></tr>
</table>
</td></tr></table>
</body></html>`;
  const text = [
    o.hello,
    '',
    ...o.lines,
    ...(o.htmlText ?? []),
    ...(o.box ?? []).map(([k, v]) => `${k} : ${v}`),
    ...(o.button ? ['', `${o.button.label}:`, o.button.link] : []),
    ...(o.after ?? []),
    ...(o.note ? ['', o.note] : []),
    '',
    FOOTER[o.l],
  ].join('\n');
  return { html, text };
}

const hello = (l: Lang, name: string) => (l === 'en' ? `Hello ${name || ''},` : l === 'ar' ? `مرحبًا ${name || ''}،` : `Bonjour ${name || ''},`).replace(/ ,/, ',').replace(/ ،/, '،');
const site = () => config.publicUrl || '';
const mail = (to: string, subject: string, o: Layout): Mail => ({ to, subject, ...layout(o) });

// ---------------------------------------------------------------- sign-up
export function signupConfirmMail(m: { token: string; email: string; name: string; language: string; store: string; agency?: boolean; marketer?: boolean }): Mail {
  const l = lang(m.language);
  const link = `${site()}/#/signup/${m.token}`;
  const A = {
    fr: { s: 'Pilotix : confirmez votre inscription', t: 'Confirmez votre e-mail', a: `Merci ! Votre agence de confirmation « ${m.store} » est presque prête.`, b: 'Cliquez sur le bouton : votre agence est créée tout de suite. Pilotix la vérifie ensuite, avant qu’elle travaille avec des boutiques.', btn: 'Créer mon agence', v: 'Ce lien marche une fois, pendant 48 heures.' },
    en: { s: 'Pilotix: confirm your sign-up', t: 'Confirm your e-mail', a: `Thank you! Your confirmation agency “${m.store}” is almost ready.`, b: 'Click the button: your agency is created right away. Pilotix then checks it before it works with stores.', btn: 'Create my agency', v: 'This link works once, for 48 hours.' },
    ar: { s: 'Pilotix: أكّد تسجيلك', t: 'أكّد بريدك الإلكتروني', a: `شكرًا! وكالة التأكيد «${m.store}» جاهزة تقريبًا.`, b: 'اضغط على الزر: تُنشأ وكالتك فورًا، ثم يتحقق منها Pilotix قبل أن تعمل مع المتاجر.', btn: 'إنشاء وكالتي', v: 'يعمل هذا الرابط مرة واحدة، لمدة 48 ساعة.' },
  }[l];
  const S = {
    fr: { s: 'Pilotix : confirmez votre inscription', t: 'Confirmez votre e-mail', a: `Merci ! Votre boutique « ${m.store} » est presque prête.`, b: 'Cliquez sur le bouton : votre boutique est créée tout de suite, avec son essai gratuit.', btn: 'Créer ma boutique', v: 'Ce lien marche une fois, pendant 48 heures.' },
    en: { s: 'Pilotix: confirm your sign-up', t: 'Confirm your e-mail', a: `Thank you! Your store “${m.store}” is almost ready.`, b: 'Click the button: your store is created right away, with its free trial.', btn: 'Create my store', v: 'This link works once, for 48 hours.' },
    ar: { s: 'Pilotix: أكّد تسجيلك', t: 'أكّد بريدك الإلكتروني', a: `شكرًا! متجرك «${m.store}» جاهز تقريبًا.`, b: 'اضغط على الزر: يُنشأ متجرك فورًا مع فترته التجريبية المجانية.', btn: 'إنشاء متجري', v: 'يعمل هذا الرابط مرة واحدة، لمدة 48 ساعة.' },
  }[l];
  const M = {
    fr: { s: 'Pilotix : confirmez votre inscription', t: 'Confirmez votre e-mail', a: `Merci ! Votre espace marketer « ${m.store} » est presque prêt.`, b: 'Cliquez sur le bouton : votre espace est créé tout de suite. Pilotix le vérifie ensuite, avant qu’il travaille avec des boutiques.', btn: 'Créer mon espace marketer', v: 'Ce lien marche une fois, pendant 48 heures.' },
    en: { s: 'Pilotix: confirm your sign-up', t: 'Confirm your e-mail', a: `Thank you! Your marketer space “${m.store}” is almost ready.`, b: 'Click the button: your space is created right away. Pilotix then checks it before it works with stores.', btn: 'Create my marketer space', v: 'This link works once, for 48 hours.' },
    ar: { s: 'Pilotix: أكّد تسجيلك', t: 'أكّد بريدك الإلكتروني', a: `شكرًا! مساحة المسوّق «${m.store}» جاهزة تقريبًا.`, b: 'اضغط على الزر: تُنشأ مساحتك فورًا، ثم يتحقق منها Pilotix قبل أن تعمل مع المتاجر.', btn: 'إنشاء مساحة المسوّق', v: 'يعمل هذا الرابط مرة واحدة، لمدة 48 ساعة.' },
  }[l];
  const O = {
    fr: { s: 'Pilotix : confirmez votre inscription', t: 'Confirmez votre e-mail', a: 'Merci ! Votre compte Pilotix est presque prêt.', b: 'Cliquez sur le bouton : votre compte s’ouvre tout de suite, puis vous créez votre première boutique, avec son essai gratuit.', btn: 'Ouvrir mon compte', v: 'Ce lien marche une fois, pendant 48 heures.' },
    en: { s: 'Pilotix: confirm your sign-up', t: 'Confirm your e-mail', a: 'Thank you! Your Pilotix account is almost ready.', b: 'Click the button: your account opens right away, then you create your first store, with its free trial.', btn: 'Open my account', v: 'This link works once, for 48 hours.' },
    ar: { s: 'Pilotix: أكّد تسجيلك', t: 'أكّد بريدك الإلكتروني', a: 'شكرًا! حسابك في Pilotix جاهز تقريبًا.', b: 'اضغط على الزر: يُفتح حسابك فورًا، ثم تنشئ متجرك الأول مع فترته التجريبية المجانية.', btn: 'فتح حسابي', v: 'يعمل هذا الرابط مرة واحدة، لمدة 48 ساعة.' },
  }[l];
  const T = m.marketer ? M : m.agency ? A : m.store.trim() ? S : O;
  return mail(m.email, T.s, { l, title: T.t, icon: '✉️', hello: hello(l, m.name), lines: [T.a, T.b], button: { label: T.btn, link }, after: [`⏱️ ${T.v}`], note: NOT_YOU[l] });
}

export function signupExistsMail(m: { email: string; name: string; language: string }): Mail {
  const l = lang(m.language);
  const T = {
    fr: { s: 'Pilotix : vous avez déjà un compte', t: 'Vous avez déjà un compte', a: 'Quelqu’un (vous, sans doute) a voulu créer une boutique avec cet e-mail, qui a déjà un compte Pilotix.', b: 'Connectez-vous, puis ouvrez le menu de votre compte › « Ajouter une boutique ». Mot de passe oublié ? Le lien est sur la page de connexion.', btn: 'Se connecter' },
    en: { s: 'Pilotix: you already have an account', t: 'You already have an account', a: 'Someone (probably you) tried to create a store with this e-mail, which already has a Pilotix account.', b: 'Log in, then open your account menu › “Add a store”. Forgot your password? The link is on the login page.', btn: 'Log in' },
    ar: { s: 'Pilotix: لديك حساب بالفعل', t: 'لديك حساب بالفعل', a: 'حاول أحدهم (أنت على الأرجح) إنشاء متجر بهذا البريد، وهو مرتبط بحساب Pilotix.', b: 'سجّل الدخول، ثم افتح قائمة حسابك › «إضافة متجر». نسيت كلمة المرور؟ الرابط في صفحة الدخول.', btn: 'تسجيل الدخول' },
  }[l];
  return mail(m.email, T.s, { l, title: T.t, icon: '👋', hello: hello(l, m.name), lines: [T.a, T.b], button: { label: T.btn, link: `${site()}/` }, note: NOT_YOU[l] });
}

export function verifyMail(m: { token: string; email: string; name: string; language: string }): Mail {
  const l = lang(m.language);
  const T = {
    fr: { s: 'Pilotix : confirmez votre e-mail', t: 'Confirmez votre e-mail', a: 'Pour ajouter une boutique à votre compte, confirmez d’abord que cet e-mail est bien le vôtre.', btn: 'Confirmer mon e-mail', v: 'Ce lien marche une fois, pendant 3 jours.' },
    en: { s: 'Pilotix: confirm your e-mail', t: 'Confirm your e-mail', a: 'To add a store to your account, first confirm this e-mail is yours.', btn: 'Confirm my e-mail', v: 'This link works once, for 3 days.' },
    ar: { s: 'Pilotix: أكّد بريدك الإلكتروني', t: 'أكّد بريدك الإلكتروني', a: 'لإضافة متجر إلى حسابك، أكّد أولًا أن هذا البريد لك.', btn: 'تأكيد بريدي', v: 'يعمل هذا الرابط مرة واحدة، لمدة 3 أيام.' },
  }[l];
  return mail(m.email, T.s, { l, title: T.t, icon: '✅', hello: hello(l, m.name), lines: [T.a], button: { label: T.btn, link: `${site()}/#/verify/${m.token}` }, after: [`⏱️ ${T.v}`], note: NOT_YOU[l] });
}

// ---------------------------------------------------------------- stores made from the control room
function inviteMail(m: Extract<OwnerMail, { kind: 'invite' }>): Mail {
  const l = lang(m.language);
  const T = {
    fr: { s: `Pilotix : votre boutique « ${m.store} » est prête`, t: 'Votre boutique est prête', a: `Pilotix a créé votre boutique « ${m.store} ».`, b: 'Choisissez votre mot de passe : vous seul le connaissez, même Pilotix ne le voit pas.', btn: 'Choisir mon mot de passe', v: 'Ce lien marche une fois, pendant 7 jours.', acc: 'Votre compte' },
    en: { s: `Pilotix: your store “${m.store}” is ready`, t: 'Your store is ready', a: `Pilotix created your store “${m.store}”.`, b: 'Choose your password: only you know it, not even Pilotix sees it.', btn: 'Choose my password', v: 'This link works once, for 7 days.', acc: 'Your account' },
    ar: { s: `Pilotix: متجرك «${m.store}» جاهز`, t: 'متجرك جاهز', a: `أنشأ Pilotix متجرك «${m.store}».`, b: 'اختر كلمة المرور: أنت وحدك تعرفها، حتى Pilotix لا يراها.', btn: 'اختيار كلمة المرور', v: 'يعمل هذا الرابط مرة واحدة، لمدة 7 أيام.', acc: 'حسابك' },
  }[l];
  return mail(m.to, T.s, { l, title: T.t, icon: '🎉', hello: hello(l, m.name), lines: [T.a, T.b], box: [[T.acc, m.to]], button: { label: T.btn, link: `${site()}/#/invite/${m.token}` }, after: [`⏱️ ${T.v}`], note: NOT_YOU[l] });
}

function addedMail(m: Extract<OwnerMail, { kind: 'added' }>): Mail {
  const l = lang(m.language);
  const T = {
    fr: { s: `Pilotix : « ${m.store} » a été ajoutée à votre compte`, t: 'Une nouvelle boutique', a: `La boutique « ${m.store} » a été ajoutée à votre compte Pilotix.`, b: 'Connectez-vous avec votre mot de passe habituel, puis choisissez-la.', btn: 'Se connecter' },
    en: { s: `Pilotix: “${m.store}” was added to your account`, t: 'A new store', a: `The store “${m.store}” was added to your Pilotix account.`, b: 'Log in with your usual password, then choose it.', btn: 'Log in' },
    ar: { s: `Pilotix: أُضيف «${m.store}» إلى حسابك`, t: 'متجر جديد', a: `أُضيف المتجر «${m.store}» إلى حسابك في Pilotix.`, b: 'سجّل الدخول بكلمة مرورك المعتادة، ثم اختره.', btn: 'تسجيل الدخول' },
  }[l];
  return mail(m.to, T.s, { l, title: T.t, icon: '🏪', hello: hello(l, m.name), lines: [T.a, T.b], button: { label: T.btn, link: `${site()}/` }, note: NOT_YOU[l] });
}

// ---------------------------------------------------------------- reminders
export function reminderMail(r: DueReminder, pay: { text: string; phone: string; whatsapp: string }): Mail {
  const l = lang(r.language);
  const end = day(r.endsAt, l);
  const T = {
    fr: {
      trial_end: { s: `Pilotix : votre essai se termine le ${end}`, t: 'Votre essai se termine bientôt', a: `L’essai gratuit de « ${r.shop} » se termine le ${end}.`, b: 'Pour continuer sans coupure, réglez votre abonnement avant cette date.' },
      paid_end: { s: `Pilotix : votre abonnement se termine le ${end}`, t: 'Votre abonnement se termine bientôt', a: `L’abonnement de « ${r.shop} » se termine le ${end}.`, b: 'Renouvelez-le avant cette date pour continuer sans coupure.' },
      grace: { s: 'Pilotix : votre abonnement est terminé', t: 'Abonnement terminé', a: `L’abonnement de « ${r.shop} » s’est terminé le ${end}.`, b: 'Votre boutique marche encore quelques jours : réglez maintenant pour éviter le blocage.' },
      locked: { s: 'Pilotix : votre boutique est en pause', t: 'Boutique en pause', a: `« ${r.shop} » est en pause depuis la fin de son abonnement (${end}).`, b: 'Vos commandes continuent d’arriver et rien n’est perdu : tout revient dès votre paiement.' },
      grace_trial: { s: 'Pilotix : votre essai gratuit est terminé', t: 'Essai gratuit terminé', a: `L’essai gratuit de « ${r.shop} » s’est terminé le ${end}.`, b: 'Votre boutique marche encore quelques jours : réglez votre abonnement maintenant pour éviter le blocage.' },
      locked_trial: { s: 'Pilotix : votre boutique est en pause', t: 'Boutique en pause', a: `« ${r.shop} » est en pause depuis la fin de son essai gratuit (${end}).`, b: 'Vos commandes continuent d’arriver et rien n’est perdu : tout revient dès votre paiement.' },
      plan: 'Formule',
      price: 'Prix par mois',
      how: 'Comment payer',
      btn: 'Ouvrir Pilotix',
    },
    en: {
      trial_end: { s: `Pilotix: your trial ends on ${end}`, t: 'Your trial ends soon', a: `The free trial of “${r.shop}” ends on ${end}.`, b: 'To go on without a break, pay your subscription before that date.' },
      paid_end: { s: `Pilotix: your subscription ends on ${end}`, t: 'Your subscription ends soon', a: `The subscription of “${r.shop}” ends on ${end}.`, b: 'Renew it before that date to go on without a break.' },
      grace: { s: 'Pilotix: your subscription has ended', t: 'Subscription ended', a: `The subscription of “${r.shop}” ended on ${end}.`, b: 'Your store still works for a few days: pay now to avoid the lock.' },
      locked: { s: 'Pilotix: your store is paused', t: 'Store paused', a: `“${r.shop}” is paused since its subscription ended (${end}).`, b: 'Your orders keep coming in and nothing is lost: everything comes back as soon as you pay.' },
      grace_trial: { s: 'Pilotix: your free trial has ended', t: 'Free trial ended', a: `The free trial of “${r.shop}” ended on ${end}.`, b: 'Your store still works for a few days: pay your subscription now to avoid the lock.' },
      locked_trial: { s: 'Pilotix: your store is paused', t: 'Store paused', a: `“${r.shop}” is paused since its free trial ended (${end}).`, b: 'Your orders keep coming in and nothing is lost: everything comes back as soon as you pay.' },
      plan: 'Plan',
      price: 'Price per month',
      how: 'How to pay',
      btn: 'Open Pilotix',
    },
    ar: {
      trial_end: { s: `Pilotix: تنتهي فترتك التجريبية يوم ${end}`, t: 'تنتهي فترتك التجريبية قريبًا', a: `تنتهي الفترة التجريبية المجانية لـ «${r.shop}» يوم ${end}.`, b: 'لتواصل دون انقطاع، ادفع اشتراكك قبل هذا التاريخ.' },
      paid_end: { s: `Pilotix: ينتهي اشتراكك يوم ${end}`, t: 'ينتهي اشتراكك قريبًا', a: `ينتهي اشتراك «${r.shop}» يوم ${end}.`, b: 'جدّده قبل هذا التاريخ لتواصل دون انقطاع.' },
      grace: { s: 'Pilotix: انتهى اشتراكك', t: 'انتهى الاشتراك', a: `انتهى اشتراك «${r.shop}» يوم ${end}.`, b: 'متجرك يعمل بعد لبضعة أيام: ادفع الآن لتفادي التوقف.' },
      locked: { s: 'Pilotix: متجرك متوقف مؤقتًا', t: 'المتجر متوقف مؤقتًا', a: `«${r.shop}» متوقف منذ نهاية اشتراكه (${end}).`, b: 'طلباتك تواصل الوصول ولا شيء يضيع: كل شيء يعود فور الدفع.' },
      grace_trial: { s: 'Pilotix: انتهت فترتك التجريبية', t: 'انتهت الفترة التجريبية', a: `انتهت الفترة التجريبية المجانية لـ «${r.shop}» يوم ${end}.`, b: 'متجرك يعمل بعد لبضعة أيام: ادفع اشتراكك الآن لتفادي التوقف.' },
      locked_trial: { s: 'Pilotix: متجرك متوقف مؤقتًا', t: 'المتجر متوقف مؤقتًا', a: `«${r.shop}» متوقف منذ نهاية فترته التجريبية (${end}).`, b: 'طلباتك تواصل الوصول ولا شيء يضيع: كل شيء يعود فور الدفع.' },
      plan: 'الباقة',
      price: 'السعر الشهري',
      how: 'طريقة الدفع',
      btn: 'فتح Pilotix',
    },
  }[l];
  const k = r.trial && r.kind === 'grace' ? T.grace_trial : r.trial && r.kind === 'locked' ? T.locked_trial : T[r.kind];
  const box: [string, string][] = [];
  if (r.plan) box.push([T.plan, r.plan]);
  if (r.price) box.push([T.price, da(r.price)]);
  const payLines = [pay.text, pay.phone && `☎ ${pay.phone}`, pay.whatsapp && `WhatsApp ${pay.whatsapp}`].filter(Boolean) as string[];
  return mail(r.to, k.s, { l, title: k.t, icon: r.kind === 'locked' ? '⏸️' : '⏰', hello: hello(l, r.name), lines: [k.a, k.b, ...(payLines.length ? [`${T.how}${l === 'fr' ? ' :' : ':'}`, ...payLines] : [])], box, button: { label: T.btn, link: `${site()}/` } });
}

// ---------------------------------------------------------------- payment receipts
export interface ReceiptData {
  id: number;
  receiptNo: string | null;
  amount: number;
  method: string;
  reference: string | null;
  months: number;
  periodFrom: string | null;
  periodTo: string | null;
  paidAt: string | null;
  voidAt: string | null;
  plan: string | null;
  language: string;
  shop: { name: string; ownerName: string | null; ownerEmail: string | null };
  company: { name: string; address: string; phone: string; email: string; taxId: string };
}
const METHOD: Record<Lang, Record<string, string>> = {
  fr: { baridimob: 'BaridiMob', ccp: 'CCP', cash: 'Espèces', virement: 'Virement', autre: 'Autre' },
  en: { baridimob: 'BaridiMob', ccp: 'CCP', cash: 'Cash', virement: 'Bank transfer', autre: 'Other' },
  ar: { baridimob: 'بريدي موب', ccp: 'CCP', cash: 'نقدًا', virement: 'تحويل بنكي', autre: 'أخرى' },
};
export function receiptMail(r: ReceiptData, to: string): Mail {
  const l = lang(r.language);
  const T = {
    fr: { s: `Pilotix : reçu de paiement ${r.receiptNo ?? ''}`, t: 'Reçu de paiement', a: `Merci ! Nous avons bien reçu votre paiement pour « ${r.shop.name} ».`, no: 'Reçu n°', date: 'Payé le', amount: 'Montant', method: 'Moyen', ref: 'Référence', plan: 'Formule', period: 'Période', void: 'Ce paiement a été annulé.' },
    en: { s: `Pilotix: payment receipt ${r.receiptNo ?? ''}`, t: 'Payment receipt', a: `Thank you! We received your payment for “${r.shop.name}”.`, no: 'Receipt no.', date: 'Paid on', amount: 'Amount', method: 'Method', ref: 'Reference', plan: 'Plan', period: 'Period', void: 'This payment was cancelled.' },
    ar: { s: `Pilotix: وصل دفع ${r.receiptNo ?? ''}`, t: 'وصل دفع', a: `شكرًا! استلمنا دفعتك لـ «${r.shop.name}».`, no: 'رقم الوصل', date: 'تاريخ الدفع', amount: 'المبلغ', method: 'طريقة الدفع', ref: 'المرجع', plan: 'الباقة', period: 'الفترة', void: 'أُلغيت هذه الدفعة.' },
  }[l];
  const box: [string, string][] = [
    [T.no, r.receiptNo ?? `#${r.id}`],
    [T.date, day(r.paidAt, l)],
    [T.amount, da(r.amount)],
    [T.method, METHOD[l][r.method] ?? r.method],
  ];
  if (r.reference) box.push([T.ref, r.reference]);
  if (r.plan) box.push([T.plan, r.plan]);
  box.push([T.period, `${day(r.periodFrom, l)} → ${day(r.periodTo, l)}`]);
  const c = r.company;
  const issuer = [c.name, c.address, c.phone, c.email, c.taxId && `NIF ${c.taxId}`].filter(Boolean).join(' · ');
  return mail(to, T.s, { l, title: T.t, icon: '🧾', hello: hello(l, r.shop.ownerName ?? ''), lines: [r.voidAt ? T.void : T.a], box, note: issuer || undefined });
}

// ---------------------------------------------------------------- answers, rewards, codes
function answerMail(m: Extract<OwnerMail, { kind: 'answer' }>): Mail {
  const l = lang(m.language);
  const T = {
    fr: { s: `Pilotix vous a répondu : ${m.subject}`, t: 'Pilotix vous a répondu', a: `Au sujet de « ${m.subject} » (${m.shop}) :`, btn: 'Voir la conversation' },
    en: { s: `Pilotix answered: ${m.subject}`, t: 'Pilotix answered you', a: `About “${m.subject}” (${m.shop}):`, btn: 'See the conversation' },
    ar: { s: `ردّ عليك Pilotix: ${m.subject}`, t: 'ردّ عليك Pilotix', a: `بخصوص «${m.subject}» (${m.shop}):`, btn: 'عرض المحادثة' },
  }[l];
  return mail(m.to, T.s, { l, title: T.t, icon: '💬', hello: hello(l, m.name), lines: [T.a, m.body], button: { label: T.btn, link: `${site()}/#/aide` } });
}

function rewardMail(m: { to: string; name: string; language: string; reward: ReferralReward }): Mail {
  const l = lang(m.language);
  const r = m.reward;
  const T = {
    fr: { s: `Pilotix : ${r.months} mois offert${r.months > 1 ? 's' : ''} 🎁`, t: 'Merci pour votre parrainage', a: `« ${r.referred} », la boutique que vous avez amenée, vient de payer son premier abonnement.`, b: `« ${r.shop} » gagne ${r.months} mois gratuit${r.months > 1 ? 's' : ''}.`, until: 'Payé jusqu’au' },
    en: { s: `Pilotix: ${r.months} free month${r.months > 1 ? 's' : ''} 🎁`, t: 'Thank you for your referral', a: `“${r.referred}”, the store you brought, just paid its first subscription.`, b: `“${r.shop}” gets ${r.months} free month${r.months > 1 ? 's' : ''}.`, until: 'Paid until' },
    ar: { s: `Pilotix: ${r.months} شهر مجاني 🎁`, t: 'شكرًا على دعوتك', a: `«${r.referred}»، المتجر الذي جلبته، دفع أول اشتراك له.`, b: `يحصل «${r.shop}» على ${r.months} شهر مجاني.`, until: 'مدفوع حتى' },
  }[l];
  return mail(m.to, T.s, { l, title: T.t, icon: '🎁', hello: hello(l, m.name), lines: [T.a, T.b], box: r.paidUntil ? [[T.until, day(r.paidUntil, l)]] : undefined });
}

export function staffCodeMail(m: { to: string; name: string; code: string }): Mail {
  return mail(m.to, `Pilotix : votre code ${m.code}`, {
    l: 'fr',
    title: 'Code de connexion',
    icon: '🔐',
    hello: hello('fr', m.name),
    lines: ['Votre code pour entrer dans le centre de contrôle Pilotix :'],
    html: `<tr><td align="center" style="padding:10px 32px 4px;"><div dir="ltr" style="display:inline-block;font-size:34px;letter-spacing:10px;font-weight:bold;padding:14px 22px;border-radius:12px;background:#F6F8FB;border:1px solid #E3E8F0;">${esc(m.code)}</div></td></tr>`,
    htmlText: ['', `    ${m.code}`, ''],
    after: ['⏱️ Ce code marche 10 minutes, une seule fois.'],
    note: 'Si ce n’est pas vous, changez tout de suite votre mot de passe du centre de contrôle.',
  });
}

/** Control room › « Changements API »: the new lines found by the daily look, to the owner and the managers. */
export function courierWatchMail(m: { to: string; name: string; items: { company: string; title: string }[] }): Mail {
  const n = m.items.length;
  const one = n === 1;
  return mail(m.to, `Pilotix : ${one ? 'un changement' : `${n} changements`} d’API à vérifier`, {
    l: 'fr',
    title: 'Changements d’API',
    icon: '🔔',
    hello: hello('fr', m.name),
    lines: [
      `Pilotix a trouvé ${one ? 'un changement' : `${n} changements`} chez des sociétés de livraison.`,
      `${one ? 'Il est' : 'Ils sont'} dans Sociétés de livraison › « Changements API » : regardez, puis marquez « Résolu ».`,
    ],
    box: m.items.slice(0, 12).map((i) => [i.company, i.title] as [string, string]),
    button: { label: 'Ouvrir la liste', link: `${site()}/#/platform/couriers` },
    after: n > 12 ? [`… et ${n - 12} de plus dans la liste.`] : [],
    note: 'Cet e-mail part au plus une fois par jour, seulement quand quelque chose a changé.',
  });
}

// ---------------------------------------------------------------- Pilot AI (to the control room's staff, in French)
const usd = (v: number) => `${v.toFixed(2).replace('.', ',')} $`;
const PILOT_TOPIC: Record<string, string> = {
  price: 'Prix',
  trust: 'Confiance',
  fee: 'Livraison (frais)',
  delay: 'Délai',
  product: 'Produit',
  address: 'Adresse',
  closing: 'Conclure',
  anger: 'Client fâché',
  big: 'Grosse commande',
  followup: 'Relance',
  language: 'Langue',
  handoff: 'Passer à l’équipe',
  fake: 'Fausses commandes',
  other: 'Autre',
};

/** Pilot AI › the daily limit of the live answers is reached (once a day): to the owner and the managers. */
export function pilotRestMail(m: { to: string; name: string; usd: number; dayUsd: number }): Mail {
  return mail(m.to, `Pilotix : l’IA a atteint sa limite du jour (${usd(m.dayUsd)})`, {
    l: 'fr',
    title: 'Limite du jour atteinte',
    icon: '⏸️',
    hello: hello('fr', m.name),
    lines: [
      `Aujourd’hui, l’IA de vos boutiques a dépensé ${usd(m.usd)} avec la clé de Pilotix : la limite de ${usd(m.dayUsd)} par jour est atteinte.`,
      'Jusqu’à minuit (heure d’Algérie), Dellal répond avec ses règles simples, le CM AI agent aussi, et AI Spy attend. Demain matin, tout repart seul.',
      'Pour continuer tout de suite, augmentez la limite dans Pilot AI › Réglages.',
    ],
    button: { label: 'Ouvrir Pilot AI', link: `${site()}/#/platform/pilot` },
    note: 'Cet e-mail part au plus une fois par jour, seulement quand la limite est atteinte.',
  });
}

/** Pilot AI › after the night: lessons wait for the coach (approve, correct or reject). */
export function pilotCoachMail(m: { to: string; name: string; waiting: number; fresh: number; lessons: { topic: string; text: string }[] }): Mail {
  const one = m.waiting === 1;
  return mail(m.to, `Pilotix : ${one ? 'une leçon' : `${m.waiting} leçons`} de Dellal à valider`, {
    l: 'fr',
    title: 'Leçons à valider',
    icon: '🌙',
    hello: hello('fr', m.name),
    lines: [
      m.fresh ? `Cette nuit, Dellal a appris ${m.fresh === 1 ? 'une nouvelle leçon' : `${m.fresh} nouvelles leçons`} des vraies conversations.` : 'Des leçons de Dellal attendent toujours votre réponse.',
      `${one ? 'Elle attend' : `${m.waiting} leçons attendent`} votre accord dans Pilot AI › À valider : approuvez, corrigez ou rejetez. Rien n’entre dans Dellal sans vous.`,
    ],
    box: m.lessons.slice(0, 5).map((l) => [PILOT_TOPIC[l.topic] ?? l.topic, l.text.length > 160 ? `${l.text.slice(0, 157)}…` : l.text] as [string, string]),
    button: { label: 'Valider les leçons', link: `${site()}/#/platform/pilot` },
    after: m.waiting > 5 ? [`… et ${m.waiting - 5} de plus dans Pilot AI.`] : [],
    note: 'Cet e-mail part après l’apprentissage de la nuit, seulement quand des leçons attendent.',
  });
}

/** Control room › Pilotix Protection System: the buyers' quality fell by 5 points or more this week (once a week). */
export function qualityAlertMail(m: { to: string; name: string; alert: QualityAlert }): Mail {
  const a = m.alert;
  const p = (v: number) => `${(v * 100).toFixed(1).replace('.', ',')} %`;
  const pts = (w: { now: number; prev: number }) => `−${((w.prev - w.now) * 100).toFixed(1).replace('.', ',')} pts`;
  const lines: string[] = [];
  if (a.network) lines.push(`Toutes boutiques confondues : ${p(a.network.now)} de vrais acheteurs cette semaine, contre ${p(a.network.prev)} la semaine d’avant (${pts(a.network)}).`);
  if (a.stores.length) lines.push(a.stores.length === 1 ? 'Une boutique a baissé de 5 points ou plus :' : `${a.stores.length} boutiques ont baissé de 5 points ou plus :`);
  return mail(m.to, `Pilotix : la qualité des acheteurs baisse${a.network ? ` (${pts(a.network)})` : ''}`, {
    l: 'fr',
    title: 'Qualité des acheteurs en baisse',
    icon: '📉',
    hello: hello('fr', m.name),
    lines: [`Semaine du ${day(a.week.from, 'fr')} au ${day(a.week.to, 'fr')} (les 3 derniers jours ne comptent pas : les agents confirment encore).`, ...lines],
    box: a.stores.slice(0, 12).map((s) => [s.name, `${p(s.now)} (${pts(s)}, ${s.buyers} acheteurs)`] as [string, string]),
    button: { label: 'Ouvrir Pilotix Protection System', link: `${site()}/#/platform/protection` },
    after: a.stores.length > 12 ? [`… et ${a.stores.length - 12} de plus sur la page.`] : [],
    note: 'Vrais acheteurs : commandes confirmées par un agent ou livrées, sur 100 commandes reçues. Cet e-mail part au plus une fois par semaine.',
  });
}

/** The e-mail of a control-room action (never shown to the staff: the server sends it). Receipts are made apart. */
export function ownerMail(m: OwnerMail): Mail | null {
  if (m.kind === 'invite') return inviteMail(m);
  if (m.kind === 'added') return addedMail(m);
  if (m.kind === 'answer') return answerMail(m);
  if (m.kind === 'reward') return rewardMail(m);
  return null;
}
