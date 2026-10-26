// The "mot de passe oublié" e-mail, in the account's language.
import { RESET_MINUTES } from '@pilotix/core';
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
  },
  en: {
    subject: 'Pilotix: new password',
    hello: (n: string) => `Hello ${n},`,
    why: 'Someone (probably you) asked to change the password of your Pilotix account.',
    button: 'Choose a new password',
    valid: (m: number) => `This link works once, for ${m} minutes.`,
    notYou: 'If it was not you, ignore this e-mail: your password does not change.',
  },
  ar: {
    subject: 'Pilotix: كلمة مرور جديدة',
    hello: (n: string) => `مرحبًا ${n}،`,
    why: 'طلب أحدهم (أنت على الأرجح) تغيير كلمة مرور حسابك في Pilotix.',
    button: 'اختر كلمة مرور جديدة',
    valid: (m: number) => `يعمل هذا الرابط مرة واحدة فقط، لمدة ${m} دقيقة.`,
    notYou: 'إن لم تكن أنت، تجاهل هذه الرسالة: كلمة مرورك لن تتغير.',
  },
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function resetMail(r: PasswordResetLink): Mail {
  const t = T[(r.language as keyof typeof T) in T ? (r.language as keyof typeof T) : 'fr'];
  const rtl = r.language === 'ar';
  const link = `${config.publicUrl}/#/reset/${r.token}`;
  const text = [t.hello(r.name), '', t.why, '', `${t.button}${r.language === 'fr' ? ' :' : ':'}`, link, '', t.valid(RESET_MINUTES), t.notYou, '', 'Pilotix'].join('\n');
  const html = `<!doctype html><html dir="${rtl ? 'rtl' : 'ltr'}"><body style="margin:0;padding:24px;background:#f4f6fa;font-family:Arial,Helvetica,sans-serif;color:#1B2A47">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;text-align:${rtl ? 'right' : 'left'}">
<div style="font-size:26px;font-weight:bold;color:#1B2A47;margin-bottom:18px">pilotix<span style="color:#F5A623">.</span></div>
<p style="margin:0 0 12px">${esc(t.hello(r.name))}</p>
<p style="margin:0 0 22px;line-height:1.5">${esc(t.why)}</p>
<p style="margin:0 0 22px;text-align:center"><a href="${esc(link)}" style="display:inline-block;background:#1B2A47;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold">${esc(t.button)}</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#5b6577">${esc(t.valid(RESET_MINUTES))}</p>
<p style="margin:0 0 16px;font-size:13px;color:#5b6577">${esc(t.notYou)}</p>
<p style="margin:0;font-size:12px;color:#8a93a3;word-break:break-all" dir="ltr">${esc(link)}</p>
</div></body></html>`;
  return { to: r.email, subject: t.subject, text, html };
}
