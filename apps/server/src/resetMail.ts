// The "mot de passe oublié" e-mail, in the account's language.
import { RESET_MINUTES, RESETS_PER_MONTH } from '@pilotix/core';
import type { PasswordResetLink } from '@pilotix/core';
import { config } from './config';
import { Mail } from './mail';

const T = {
  fr: {
    subject: 'Pilotix : nouveau mot de passe',
    hello: (n: string) => `Bonjour ${n},`,
    why: 'Quelqu’un (vous, sans doute) a demandé à changer le mot de passe de votre compte Pilotix.',
    button: 'Choisir un nouveau mot de passe',
    valid: (m: number) => `Ce lien marche une seule fois, pendant ${m} minutes.`,
    notYou: 'Si ce n’est pas vous, ignorez cet e-mail : votre mot de passe ne change pas.',
    title: 'Nouveau mot de passe',
    account: 'Compte',
    asked: 'Demandé le',
    copy: 'Le bouton ne marche pas ? Copiez ce lien dans votre navigateur :',
    footer: 'Pilotix · gestion des commandes',
    locale: 'fr-FR',
    limitSubject: 'Pilotix : demandez votre nouveau mot de passe à votre responsable',
    limitTitle: 'Limite atteinte ce mois-ci',
    limitWhy: (n: number) => `Vous avez déjà changé votre mot de passe ${n} fois ce mois-ci avec « Mot de passe oublié ».`,
    limitAsk: 'Demandez à votre superviseur ou à l’administrateur : il peut vous donner un nouveau mot de passe tout de suite dans Pilotix (Utilisateurs).',
    limitNext: 'Le mois prochain, « Mot de passe oublié » remarchera.',
  },
  en: {
    subject: 'Pilotix: new password',
    hello: (n: string) => `Hello ${n},`,
    why: 'Someone (probably you) asked to change the password of your Pilotix account.',
    button: 'Choose a new password',
    valid: (m: number) => `This link works once, for ${m} minutes.`,
    notYou: 'If it was not you, ignore this e-mail: your password does not change.',
    title: 'New password',
    account: 'Account',
    asked: 'Asked on',
    copy: 'Button not working? Copy this link into your browser:',
    footer: 'Pilotix · order management',
    locale: 'en-GB',
    limitSubject: 'Pilotix: ask your supervisor for a new password',
    limitTitle: 'Limit reached this month',
    limitWhy: (n: number) => `You already changed your password ${n} times this month with “Forgot password”.`,
    limitAsk: 'Ask your supervisor or the administrator: they can give you a new password right away in Pilotix (Users).',
    limitNext: 'Next month, “Forgot password” will work again.',
  },
  ar: {
    subject: 'Pilotix: كلمة مرور جديدة',
    hello: (n: string) => `مرحبًا ${n}،`,
    why: 'طلب أحدهم (أنت على الأرجح) تغيير كلمة مرور حسابك في Pilotix.',
    button: 'اختر كلمة مرور جديدة',
    valid: (m: number) => `يعمل هذا الرابط مرة واحدة فقط، لمدة ${m} دقيقة.`,
    notYou: 'إن لم تكن أنت، تجاهل هذه الرسالة: كلمة مرورك لن تتغير.',
    title: 'كلمة مرور جديدة',
    account: 'الحساب',
    asked: 'تاريخ الطلب',
    copy: 'الزر لا يعمل؟ انسخ هذا الرابط في متصفحك:',
    footer: 'Pilotix · إدارة الطلبات',
    locale: 'ar-DZ',
    limitSubject: 'Pilotix: اطلب كلمة مرور جديدة من مسؤولك',
    limitTitle: 'تم بلوغ الحد هذا الشهر',
    limitWhy: (n: number) => `لقد غيّرت كلمة مرورك ${n} مرات هذا الشهر عبر «نسيت كلمة المرور».`,
    limitAsk: 'اطلب من مشرفك أو من المسؤول: يمكنه أن يعطيك كلمة مرور جديدة فورًا في Pilotix (المستخدمون).',
    limitNext: 'في الشهر القادم، سيعمل «نسيت كلمة المرور» من جديد.',
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const NAVY = '#1B2A47';
const ORANGE = '#F5A623';

export function resetMail(r: PasswordResetLink, now = new Date()): Mail {
  const t = T[(r.language as keyof typeof T) in T ? (r.language as keyof typeof T) : 'fr'];
  const rtl = r.language === 'ar';
  const align = rtl ? 'right' : 'left';
  const link = `${config.publicUrl}/#/reset/${r.token}`;
  const logo = `${config.publicUrl}/email-logo.png`;
  const when = now.toLocaleString(t.locale, { timeZone: 'Africa/Algiers', dateStyle: 'long', timeStyle: 'short' });
  const text = [t.hello(r.name), '', t.why, '', `${t.button}${r.language === 'fr' ? ' :' : ':'}`, link, '', t.valid(RESET_MINUTES), t.notYou, '', t.footer].join('\n');
  // tables and inline styles: what Outlook, Gmail and phone mail apps all show the same way
  const html = `<!doctype html>
<html lang="${esc(r.language)}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(t.title)}</title></head>
<body style="margin:0;padding:0;background:#EEF1F6;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(t.valid(RESET_MINUTES))}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#EEF1F6;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden;font-family:Segoe UI,Arial,Helvetica,sans-serif;color:${NAVY};">
  <tr><td align="center" style="background:${NAVY};padding:26px 24px 22px;">
    <img src="${esc(logo)}" width="150" alt="pilotix" style="display:block;width:150px;max-width:60%;height:auto;border:0;color:#FFFFFF;font-size:28px;font-weight:bold;">
  </td></tr>
  <tr><td style="height:5px;background:${ORANGE};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:30px 32px 6px;text-align:${align};">
    <div style="font-size:24px;font-weight:bold;margin:0 0 16px;">🔑 ${esc(t.title)}</div>
    <p style="margin:0 0 10px;font-size:16px;line-height:1.5;">${esc(t.hello(r.name))}</p>
    <p style="margin:0 0 22px;font-size:16px;line-height:1.5;color:#3C4A63;">${esc(t.why)}</p>
  </td></tr>
  <tr><td style="padding:0 32px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#F6F8FB;border:1px solid #E3E8F0;border-radius:10px;">
      <tr><td style="padding:12px 16px;font-size:14px;color:#5B6577;text-align:${align};">${esc(t.account)}</td><td dir="ltr" style="padding:12px 16px;font-size:14px;font-weight:bold;text-align:${rtl ? 'left' : 'right'};">${esc(r.email)}</td></tr>
      <tr><td style="padding:0 16px 12px;font-size:14px;color:#5B6577;text-align:${align};">${esc(t.asked)}</td><td style="padding:0 16px 12px;font-size:14px;font-weight:bold;text-align:${rtl ? 'left' : 'right'};">${esc(when)}</td></tr>
    </table>
  </td></tr>
  <tr><td align="center" style="padding:28px 32px 10px;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" bgcolor="${ORANGE}" style="border-radius:10px;">
      <a href="${esc(link)}" style="display:inline-block;padding:15px 30px;font-size:17px;font-weight:bold;color:${NAVY};text-decoration:none;border-radius:10px;">${esc(t.button)}</a>
    </td></tr></table>
  </td></tr>
  <tr><td align="center" style="padding:6px 32px 24px;font-size:14px;color:#5B6577;">⏱️ ${esc(t.valid(RESET_MINUTES))}</td></tr>
  <tr><td style="padding:0 32px;"><div style="border-top:1px solid #E3E8F0;height:1px;line-height:1px;font-size:0;">&nbsp;</div></td></tr>
  <tr><td style="padding:18px 32px 8px;font-size:13px;line-height:1.5;color:#5B6577;text-align:${align};">🛡️ ${esc(t.notYou)}</td></tr>
  <tr><td style="padding:4px 32px 26px;font-size:12px;line-height:1.5;color:#8A93A3;text-align:${align};">${esc(t.copy)}<br><a href="${esc(link)}" dir="ltr" style="color:#3B6FD8;word-break:break-all;">${esc(link)}</a></td></tr>
  <tr><td align="center" style="background:#F6F8FB;padding:16px 24px;font-size:12px;color:#8A93A3;">${esc(t.footer)} · <a href="${esc(config.publicUrl)}" style="color:#8A93A3;">${esc(config.publicUrl.replace(/^https?:\/\//, ''))}</a></td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { to: r.email, subject: t.subject, text, html };
}

/** Sent instead of a link when the person already changed their password twice this month. */
export function limitMail(r: { name: string; email: string; language: string }): Mail {
  const t = T[(r.language as keyof typeof T) in T ? (r.language as keyof typeof T) : 'fr'];
  const rtl = r.language === 'ar';
  const align = rtl ? 'right' : 'left';
  const logo = `${config.publicUrl}/email-logo.png`;
  const text = [t.hello(r.name), '', t.limitWhy(RESETS_PER_MONTH), '', t.limitAsk, '', t.limitNext, t.notYou, '', t.footer].join('\n');
  const html = `<!doctype html>
<html lang="${esc(r.language)}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(t.limitTitle)}</title></head>
<body style="margin:0;padding:0;background:#EEF1F6;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#EEF1F6;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden;font-family:Segoe UI,Arial,Helvetica,sans-serif;color:${NAVY};">
  <tr><td align="center" style="background:${NAVY};padding:26px 24px 22px;"><img src="${esc(logo)}" width="150" alt="pilotix" style="display:block;width:150px;max-width:60%;height:auto;border:0;color:#FFFFFF;font-size:28px;font-weight:bold;"></td></tr>
  <tr><td style="height:5px;background:${ORANGE};font-size:0;line-height:0;">&nbsp;</td></tr>
  <tr><td style="padding:30px 32px 8px;text-align:${align};">
    <div style="font-size:24px;font-weight:bold;margin:0 0 16px;">🔒 ${esc(t.limitTitle)}</div>
    <p style="margin:0 0 10px;font-size:16px;line-height:1.5;">${esc(t.hello(r.name))}</p>
    <p style="margin:0 0 18px;font-size:16px;line-height:1.5;color:#3C4A63;">${esc(t.limitWhy(RESETS_PER_MONTH))}</p>
  </td></tr>
  <tr><td style="padding:0 32px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#FEF3DF;border:1px solid #F5D9A6;border-radius:10px;"><tr><td style="padding:14px 16px;font-size:15px;line-height:1.5;font-weight:bold;text-align:${align};">👤 ${esc(t.limitAsk)}</td></tr></table>
  </td></tr>
  <tr><td style="padding:18px 32px 6px;font-size:14px;color:#5B6577;text-align:${align};">📅 ${esc(t.limitNext)}</td></tr>
  <tr><td style="padding:8px 32px 26px;font-size:13px;line-height:1.5;color:#5B6577;text-align:${align};">🛡️ ${esc(t.notYou)}</td></tr>
  <tr><td align="center" style="background:#F6F8FB;padding:16px 24px;font-size:12px;color:#8A93A3;">${esc(t.footer)} · <a href="${esc(config.publicUrl)}" style="color:#8A93A3;">${esc(config.publicUrl.replace(/^https?:\/\//, ''))}</a></td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { to: r.email, subject: t.limitSubject, text, html };
}
