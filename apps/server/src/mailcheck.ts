// The deploy's e-mail check (deploy/install.sh, inside the server's container): can this server log in to its SMTP
// server? Nothing is sent. The control room's login code, « Mot de passe oublié », invitations and sign-ups need it.
//   node apps/server/dist/mailcheck.js   → one line « E-mail: OK … », « E-mail: NOT SET UP … » or « E-mail: FAILED … »
import { config } from './config';
import { checkSmtp, mailConfigured } from './mail';

async function main() {
  if (!config.smtp.host) return console.log('E-mail: NOT SET UP (SMTP_HOST is empty in deploy/.env): no login codes, no reset links, no sign-ups. Set it: sudo bash /opt/pilotix/deploy/set-email.sh');
  if (!mailConfigured()) return console.log('E-mail: NOT SET UP (MAIL_FROM or PUBLIC_URL is empty in deploy/.env)');
  try {
    await checkSmtp();
    console.log(`E-mail: OK (${config.smtp.host}:${config.smtp.port}${config.smtp.user ? `, ${config.smtp.user}` : ''})`);
  } catch (e) {
    console.log(`E-mail: FAILED (${config.smtp.host}:${config.smtp.port}) — ${(e as Error).message}`);
    console.log('        The control room asks a code sent by e-mail: fix it with « sudo bash /opt/pilotix/deploy/set-email.sh » on the server.');
  }
}

main().then(
  () => process.exit(0),
  () => process.exit(0),
);
