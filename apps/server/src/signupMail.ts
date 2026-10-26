// The e-mail a shop owner receives after signing up (or adding a shop): welcome, the shop's addresses, and the button
// that confirms the e-mail. Same look as the password e-mails (tables and inline styles, read the same everywhere).
import { config } from './config';
import type { Mail } from './mail';

const T = {
  fr: {
    subject: (shop: string) => `Bienvenue sur Pilotix — confirmez votre e-mail (${shop})`,
    title: 'Votre boutique est prête',
    hello: (n: string) => `Bonjour ${n},`,
    why: (shop: string, days: number) => `La boutique « ${shop} » est créée, avec ${days} jours d’essai gratuit. Confirmez votre e-mail : c’est lui qui vous permet de récupérer votre mot de passe.`,
    button: 'Confirmer mon e-mail',
    pages: 'Vos landing pages',
    valid: 'Ce lien est valable 7 jours.',
    notYou: 'Vous n’avez rien demandé ? Ignorez cet e-mail.',
    copy: 'Le bouton ne marche pas ? Copiez ce lien dans votre navigateur :',
    footer: 'Pilotix — gestion des commandes COD',
  },
  en: {
    subject: (shop: string) => `Welcome to Pilotix — confirm your e-mail (${shop})`,
    title: 'Your shop is ready',
    hello: (n: string) => `Hello ${n},`,
    why: (shop: string, days: number) => `The shop « ${shop} » is created, with a ${days}-day free trial. Confirm your e-mail: it is what lets you recover your password.`,
    button: 'Confirm my e-mail',
    pages: 'Your landing pages',
    valid: 'This link works for 7 days.',
    notYou: 'You did not ask for anything? Ignore this e-mail.',
    copy: 'The button does not work? Copy this link into your browser:',
    footer: 'Pilotix — COD order management',
  },
  ar: {
    subject: (shop: string) => `مرحبًا بك في Pilotix — أكّد بريدك الإلكتروني (${shop})`,
    title: 'متجرك جاهز',
    hello: (n: string) => `مرحبًا ${n}،`,
    why: (shop: string, days: number) => `تم إنشاء المتجر « ${shop} » مع تجربة مجانية لمدة ${days} يومًا. أكّد بريدك الإلكتروني: هو الذي يسمح لك باسترجاع كلمة المرور.`,
    button: 'تأكيد بريدي الإلكتروني',
    pages: 'صفحات الهبوط الخاصة بك',
    valid: 'هذا الرابط صالح لمدة 7 أيام.',
    notYou: 'لم تطلب شيئًا؟ تجاهل هذا البريد.',
    copy: 'الزر لا يعمل؟ انسخ هذا الرابط في متصفحك:',
    footer: 'Pilotix — إدارة طلبيات الدفع عند الاستلام',
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const NAVY = '#1B2A47';
const ORANGE = '#F5A623';

export function signupMail(r: { name: string; email: string; language: string; shop: string; slug: string; token: string; trialDays: number }): Mail {
  const lang = (r.language in T ? r.language : 'fr') as keyof typeof T;
  const t = T[lang];
  const rtl = lang === 'ar';
  const align = rtl ? 'right' : 'left';
  const link = `${config.publicUrl}/#/confirmer/${r.token}`;
  const pages = `${config.publicUrl}/${r.slug}/…`;
  const logo = `${config.publicUrl}/email-logo.png`;
  const text = [t.hello(r.name), '', t.why(r.shop, r.trialDays), '', `${t.button}:`, link, '', `${t.pages}: ${pages}`, '', t.valid, t.notYou, '', t.footer].join('\n');
  const html = `<!doctype html>
<html lang="${lang}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(t.title)}</title></head>
<body style="margin:0;padding:0;background:#EEF1F6;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#EEF1F6;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden;font-family:Segoe UI,Arial,Helvetica,sans-serif;color:${NAVY};">
  <tr><td align="center" style="background:${NAVY};padding:26px 24px 22px;"><img src="${esc(logo)}" width="150" alt="pilotix" style="display:block;width:150px;max-width:60%;height:auto;border:0;color:#FFFFFF;font-size:28px;font-weight:bold;"></td></tr>
  <tr><td style="height:5px;background:${ORANGE};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:30px 32px 6px;text-align:${align};">
    <div style="font-size:24px;font-weight:bold;margin:0 0 16px;">🎉 ${esc(t.title)}</div>
    <p style="margin:0 0 10px;font-size:16px;line-height:1.5;">${esc(t.hello(r.name))}</p>
    <p style="margin:0 0 18px;font-size:16px;line-height:1.5;color:#3C4A63;">${esc(t.why(r.shop, r.trialDays))}</p>
  </td></tr>
  <tr><td align="center" style="padding:10px 32px 10px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="${ORANGE}" style="border-radius:10px;">
      <a href="${esc(link)}" style="display:inline-block;padding:15px 30px;font-size:17px;font-weight:bold;color:${NAVY};text-decoration:none;border-radius:10px;">${esc(t.button)}</a>
    </td></tr></table>
  </td></tr>
  <tr><td align="center" style="padding:6px 32px 18px;font-size:14px;color:#5B6577;">⏱️ ${esc(t.valid)}</td></tr>
  <tr><td style="padding:0 32px 18px;text-align:${align};font-size:14px;color:#3C4A63;">🔗 ${esc(t.pages)} : <span dir="ltr" style="font-weight:bold;">${esc(pages)}</span></td></tr>
  <tr><td style="padding:0 32px;"><div style="border-top:1px solid #E3E8F0;height:1px;line-height:1px;font-size:0;">&nbsp;</div></td></tr>
  <tr><td style="padding:18px 32px 8px;font-size:13px;line-height:1.5;color:#5B6577;text-align:${align};">🛡️ ${esc(t.notYou)}</td></tr>
  <tr><td style="padding:4px 32px 26px;font-size:12px;line-height:1.5;color:#8A93A3;text-align:${align};">${esc(t.copy)}<br><a href="${esc(link)}" dir="ltr" style="color:#3B6FD8;word-break:break-all;">${esc(link)}</a></td></tr>
  <tr><td align="center" style="background:#F6F8FB;padding:16px 24px;font-size:12px;color:#8A93A3;">${esc(t.footer)} · <a href="${esc(config.publicUrl)}" style="color:#8A93A3;">${esc(config.publicUrl.replace(/^https?:\/\//, ''))}</a></td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { to: r.email, subject: t.subject(r.shop), text, html };
}
