// One page for many repositories, which is what an IT department actually has.
//
// Every command in Tewip answers about one checkout. A head of engineering has forty, and the
// question is not "what is wrong in this repo" but "which of these forty should somebody look at
// first". That usually means buying a server, a dashboard and an agent on every machine. It does
// not have to: the checks are already local, already rules-only, and already free.
//
// The rule that keeps this honest is the same one as everywhere else, and it matters more here
// because a table invites skimming: a check that could not run on a repository is printed as
// "could not run", never as zero. A row of zeroes that means "nothing installed" looks exactly
// like a row of zeroes that means "nothing wrong", and at forty rows nobody checks which.
export interface RepoRow {
  name: string;
  path: string;
  /** Per check: a number, or why it could not run. */
  cells: Record<string, Cell>;
  seconds: number;
}

export type Cell = { ran: true; count: number; detail: string } | { ran: false; why: string };

export const CHECKS = ['secrets', 'injection', 'containers', 'licences', 'access', 'migrations', 'hollow tests'] as const;
export type Check = (typeof CHECKS)[number];

/** What each column counts, so the header is not seven words a reader has to guess at. */
export const COUNTS: Record<Check, string> = {
  secrets: 'credentials that need somebody to act now',
  injection: 'request values reaching a query or a shell',
  containers: 'high-risk container settings in what ships',
  licences: 'dependencies whose licence needs a decision',
  access: 'accessibility barriers, not warnings',
  migrations: 'migrations that destroy data or break the running version',
  'hollow tests': 'tests that cannot fail',
};

export function worstFirst(rows: RepoRow[]): RepoRow[] {
  const score = (r: RepoRow) => CHECKS.reduce((n, c) => n + (r.cells[c]?.ran ? (r.cells[c] as { count: number }).count : 0), 0);
  return [...rows].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));

export function renderPortfolio(rows: RepoRow[], notChecked: string[]): string {
  const ordered = worstFirst(rows);
  const width = Math.max(10, ...ordered.map((r) => r.name.length));
  const lines = [
    '# Across every repository here',
    '',
    `${rows.length} repository(ies), read locally. No model was called and nothing was sent anywhere.`,
    '',
    '| ' + pad('repository', width) + ' | ' + CHECKS.map((c) => pad(c, 12)).join(' | ') + ' |',
    '| ' + '-'.repeat(width) + ' | ' + CHECKS.map(() => '-'.repeat(12)).join(' | ') + ' |',
  ];
  for (const r of ordered) {
    const cells = CHECKS.map((c) => {
      const cell = r.cells[c];
      if (!cell) return pad('—', 12);
      return pad(cell.ran ? (cell.count === 0 ? '0' : `**${cell.count}**`) : '—', 12);
    });
    lines.push('| ' + pad(r.name, width) + ' | ' + cells.join(' | ') + ' |');
  }
  lines.push('', 'A dash is not a zero. It means the check could not run here, and the reason is below.', '');

  // What each column counts, because seven one-word headings are seven guesses otherwise.
  lines.push('## What the columns count', '');
  for (const c of CHECKS) lines.push(`- **${c}** — ${COUNTS[c]}`);
  lines.push('');

  const blocked = ordered.flatMap((r) =>
    CHECKS.filter((c) => r.cells[c] && !r.cells[c].ran).map((c) => `- \`${r.name}\` / ${c}: ${(r.cells[c] as { why: string }).why}`),
  );
  if (blocked.length > 0) {
    lines.push('## Checks that could not run', '', ...blocked.slice(0, 40), '');
    if (blocked.length > 40) lines.push(`…and ${blocked.length - 40} more`, '');
  }

  lines.push('## What this page is not', '');
  for (const n of notChecked) lines.push(`- ${n}`);
  lines.push('', 'Every number here is re-derivable: run the named command in that repository and you get it back.', '');
  return lines.join('\n');
}
