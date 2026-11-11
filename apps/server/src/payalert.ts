// « J'ai payé »: Pilotix's own WhatsApp Business number (the one of the sign-up code, otp.ts) tells Pilotix's team that a
// store sent a payment to check. The control room › Réglages › Paiement holds the numbers, the template and its language.
// The template (Utility, approved by Meta) has an IMAGE header (the receipt) and 5 body variables: the store, the plan,
// the period, the amount, who sent it. The receipt is uploaded first (POST /{phoneId}/media), then the template is sent
// to each number. Never throws: answers 'sent', 'off' (not set up) or the error, kept on the claim (core: billing.ts).
// Without a server able to reach Meta (development), the message is written in the server's log instead.
import { Logger } from '@nestjs/common';
import { phoneWa } from '@pilotix/shared';
import * as core from '@pilotix/core';
import type { CoreService } from './core.service';
import { readOtp } from './otp';

const log = new Logger('PayAlert');
const GRAPH = 'https://graph.facebook.com/v21.0';

/** A template variable as Meta takes it: one line, no tab, never more than 4 spaces in a row, not empty. */
const param = (s: string) => ({ type: 'text', text: s.replace(/[\n\r\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 200) || '-' });

const metaError = (data: any, res: Response) => {
  const e = data?.error;
  if (e?.code === 190) return 'jeton WhatsApp expiré';
  if (e?.code === 132001) return 'modèle introuvable ou pas approuvé';
  return String(e?.error_user_msg ?? e?.message ?? res.statusText ?? 'refusé').slice(0, 140);
};

/** Uploads the receipt (a JPEG data URL): its media id at Meta. */
async function upload(phoneId: string, token: string, dataUrl: string): Promise<string> {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', 'image/jpeg');
  form.append('file', new Blob([Buffer.from(b64, 'base64')], { type: 'image/jpeg' }), 'recu.jpg');
  let res: Response;
  try {
    res = await fetch(`${GRAPH}/${encodeURIComponent(phoneId)}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error('WhatsApp injoignable (photo)');
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data?.error || !data?.id) throw new Error(`photo : ${metaError(data, res)}`);
  return String(data.id);
}

export async function payAlert(svc: CoreService, claimId: number): Promise<string> {
  try {
    const c = (
      await svc.t.platform.query(
        `SELECT c.*, s.name AS shop_name, pl.name AS plan_name FROM platform.payment_claims c JOIN platform.shops s ON s.id = c.shop_id
           LEFT JOIN platform.plans pl ON pl.id = c.plan_id WHERE c.id = $1`,
        [claimId],
      )
    )[0];
    if (!c) return 'off';
    const alert = (await core.platformSettings(svc.t)).payment.alert;
    if (!alert.numbers.length || !alert.template) return 'off';
    const otp = await readOtp(svc);
    const months = Number(c.months);
    const credits = c.credits == null ? 0 : Number(c.credits);
    // a pack of AI credits: no plan, no period (the template's 2nd and 3rd words say what was bought)
    const vars = [c.shop_name, credits ? 'Crédits IA' : c.plan_name ?? '-', credits ? `${credits} crédits` : months === 12 ? '1 an' : '1 mois', Number(c.amount).toLocaleString('fr-FR').replace(/\s/g, ' '), c.sent_by ?? '-'].map((x) => param(String(x)));
    if (!otp.phoneId || !otp.token) {
      // no sender (development, or WhatsApp not set up in Réglages): written in the log
      if (process.env.NODE_ENV !== 'production') log.warn(`(development) payment ${claimId} for ${alert.numbers.join(', ')}: ${vars.map((v) => v.text).join(' | ')}`);
      return 'off';
    }
    if (!c.photo) return 'erreur : pas de photo du reçu';
    const media = await upload(otp.phoneId, otp.token, String(c.photo));
    const errors: string[] = [];
    for (const n of alert.numbers) {
      try {
        const res = await fetch(`${GRAPH}/${encodeURIComponent(otp.phoneId)}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${otp.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phoneWa(n),
            type: 'template',
            template: {
              name: alert.template,
              language: { code: alert.lang || 'fr' },
              components: [
                { type: 'header', parameters: [{ type: 'image', image: { id: media } }] },
                { type: 'body', parameters: vars },
              ],
            },
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const data: any = await res.json().catch(() => ({}));
        if (!res.ok || data?.error) errors.push(`${n} : ${metaError(data, res)}`);
      } catch {
        errors.push(`${n} : WhatsApp injoignable`);
      }
    }
    if (!errors.length) return 'sent';
    log.warn(`payment ${claimId}: ${errors.join(' · ')}`);
    const ok = alert.numbers.length - errors.length;
    return `erreur : ${ok ? `${ok}/${alert.numbers.length} envoyés · ` : ''}${errors.join(' · ')}`.slice(0, 200);
  } catch (e) {
    log.warn(`payment ${claimId}: ${(e as Error).message}`);
    return `erreur : ${(e as Error).message}`.slice(0, 200);
  }
}
