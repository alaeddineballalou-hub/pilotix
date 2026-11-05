// A new password is refused when it is too short or one that is guessed first (the most used passwords, a row of the
// keyboard, the same character, a run of digits): such a password falls in a few tries, whatever the login limits.

const COMMON = new Set(
  `password password1 password12 password123 passw0rd p@ssw0rd p@ssword motdepasse motdepasse1 motdepasse123 azerty azertyuiop azerty123
  azerty1234 qwerty qwertyuiop qwerty123 qwerty1234 qwertyui 1q2w3e4r 1q2w3e4r5t 1qaz2wsx qazwsxedc zaq12wsx iloveyou iloveyou1 jetaime
  jetaime1 bonjour bonjour1 bonjour123 welcome welcome1 welcome123 admin admin123 admin1234 administrator administrateur letmein trustno1
  sunshine princess football baseball dragon monkey master shadow superman batman michael jennifer abc12345 abcd1234 abcdef123 a1b2c3d4
  azerty12 changeme changeme1 secret secret123 test1234 testtest user1234 utilisateur algerie algerie213 algeria algeria213 dz213 bismillah
  allahakbar mohamed mohammed mohamed123 amine123 karim123 yacine123 sofiane123 samira123 pilotix pilotix123 pilotix2026 boutique boutique123
  commande livraison confirmation 01234567 012345678 0123456789`.split(/\s+/).filter(Boolean),
);

const ROWS = ['azertyuiop', 'qsdfghjklm', 'wxcvbn', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '0123456789', 'abcdefghijklmnopqrstuvwxyz'];

/** Why this new password is refused (a sentence to show), or null when it is fine. */
export function passwordProblem(pw: string, min = 8): string | null {
  if (typeof pw !== 'string' || pw.length < min) return `Le mot de passe doit contenir au moins ${min} caractères`;
  const p = pw.toLowerCase();
  const plain = p.replace(/[\s._-]+/g, '');
  const tooEasy = 'Ce mot de passe est trop facile à deviner : choisissez-en un autre (une phrase, ou des mots, des chiffres et des signes mêlés)';
  if (COMMON.has(p) || COMMON.has(plain)) return tooEasy;
  // the same character, or the same 1-3 characters again and again (aaaaaaaa, abababab, 123123123)
  if (/^(.{1,3})\1+$/.test(plain)) return tooEasy;
  // a row of the keyboard, the alphabet or the digits, forwards or backwards (12345678, 87654321, azertyui)
  for (const row of ROWS) {
    const back = [...row].reverse().join('');
    if (plain.length >= 6 && (row.includes(plain) || back.includes(plain))) return tooEasy;
  }
  // a common password with a year or a few digits after it (password2026, azerty12345)
  const word = plain.replace(/\d+$/, '');
  if (word.length >= 4 && word.length < plain.length && COMMON.has(word)) return tooEasy;
  return null;
}
