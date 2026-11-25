// `node dist/test/leakreport.js <file.md>`: every Contrôle case as a table (company, family, case, expected, found, PASS).
import { writeFileSync } from 'node:fs';
import { findLeaks } from '../leaks/rules';
import { leakCases } from './leakcases';

const cases = leakCases();
const rows = cases.map((c, i) => {
  const found = findLeaks(c.facts).map((f) => f.kind).sort();
  const want = [...c.expect].sort();
  const ok = JSON.stringify(found) === JSON.stringify(want);
  return { i: i + 1, c, found, want, ok };
});
const pass = rows.filter((r) => r.ok).length;
const flagged = rows.filter((r) => r.want.length).length;
const md = [
  '# Pilotix · Contrôle — leak detection cases',
  '',
  `Cases: ${rows.length}. Passed: ${pass}/${rows.length}. Cases with a problem to find: ${flagged}. Clean cases (nothing to find): ${rows.length - flagged}.`,
  '',
  '| # | Company | Family | Case | Expected | Found | Check |',
  '|---:|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.i} | ${r.c.company} | ${r.c.family} | ${r.c.name.split(' · ').slice(2).join(' · ').replace(/\|/g, '/')} | ${r.want.join(', ') || '—'} | ${r.found.join(', ') || '—'} | ${r.ok ? 'PASS' : 'FAIL'} |`),
  '',
].join('\n');
writeFileSync(process.argv[2] ?? 'leak-cases.md', md);
console.log(`${pass}/${rows.length} PASS`);
