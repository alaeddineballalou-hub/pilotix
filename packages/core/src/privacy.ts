// Personal details kept out of what is written down for the team (the server's log, the Doctor): a customer's phone, an
// account's e-mail. Enough is kept to tell two lines apart, never enough to call or write to the person.

/** An Algerian mobile number, written any way (0661 23 45 67, +213 661234567, 213-661-234-567). */
const PHONE_RE = /(?<![\w+])(?:\+?213[\s.-]?|0)[5-7](?:[\s.-]?\d){8}(?!\d)/g;
const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

/** A phone keeps its operator and its last two digits (0661••••67), an e-mail its first letter and its domain (a***@gmail.com). */
export function maskPersonal(text: string): string {
  return text
    .replace(PHONE_RE, (m) => {
      const d = m.replace(/\D/g, '');
      const n = d.startsWith('213') ? `0${d.slice(3)}` : d;
      return `${n.slice(0, 4)}••••${n.slice(-2)}`;
    })
    .replace(EMAIL_RE, '$1***@$2');
}
