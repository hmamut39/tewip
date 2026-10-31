// `tewip audit`: what has this thing done here, and has the record been edited.
import { verify, type AuditEntry } from './audit.ts';

export interface AuditCommand {
  root: string;
  /** Show every entry rather than the last twenty. */
  all?: boolean;
  /** Exit non-zero when the chain does not hold, for a nightly check. */
  gate?: boolean;
}

const when = (e: AuditEntry) => e.at.replace('T', ' ').slice(0, 19);

export function renderAudit(check: ReturnType<typeof verify>, all: boolean): string {
  const { entries, edited, broken, unreadable } = check;
  const lines = ['# What Tewip has done here', ''];
  if (entries.length === 0) {
    return [
      '# What Tewip has done here',
      '',
      'Nothing is recorded yet. The log is written as commands run, in `.tewip/audit.jsonl`.',
      '',
      'An empty log is not evidence that nothing ran: it is evidence that nothing was recorded,',
      'and those are different. A log that started today says nothing about yesterday.',
    ].join('\n');
  }

  const intact = edited.length === 0 && broken.length === 0 && unreadable.length === 0;
  lines.push(
    intact
      ? `${entries.length} entry(ies), and the chain holds: no entry has been changed and none has been removed from the middle.`
      : `${entries.length} entry(ies), and **the chain does not hold**.`,
    '',
  );
  if (!intact) {
    if (edited.length > 0) lines.push(`- Changed since it was written: line(s) ${edited.join(', ')}`);
    if (broken.length > 0) lines.push(`- Does not follow the line before it, so something was removed: line(s) ${broken.join(', ')}`);
    if (unreadable.length > 0) lines.push(`- Not readable as an entry at all: line(s) ${unreadable.join(', ')}`);
    lines.push('');
  }

  const shown = all ? entries : entries.slice(-20);
  lines.push(`## ${all ? 'Every run' : `The last ${shown.length} run(s)`}`, '');
  lines.push('| when | who | command | outcome | seconds |', '| --- | --- | --- | --- | --- |');
  for (const e of shown) {
    const command = [e.command, ...e.arguments].join(' ').slice(0, 60);
    lines.push(`| ${when(e)} | ${e.who} | \`${command}\` | ${e.outcome} | ${e.seconds} |`);
  }
  lines.push('');

  const byWho = new Map<string, number>();
  for (const e of entries) byWho.set(e.who, (byWho.get(e.who) ?? 0) + 1);
  lines.push('## Who has run it', '', ...[...byWho].sort((a, b) => b[1] - a[1]).map(([w, n]) => `- ${w}: ${n} run(s)`), '');

  lines.push(
    '## What this log does not prove',
    '',
    '- It does not survive being deleted. Each line carries the hash of the line before it, so an',
    '  entry that was changed or removed from the middle is caught - but if the whole file goes, or',
    '  lines are cut from the end, nothing here can tell. Copy the last hash somewhere else if that',
    '  matters to you.',
    '- It records what was run, not what was true. A command that reported nothing is one line here',
    '  whether it looked carefully or not.',
    '- It is written by whoever runs the command, on their machine, with their write access.',
    '',
    'Saying that plainly is the point. A tamper-evident log that oversells itself is worse than a',
    'plain one, because somebody relies on it.',
  );
  return lines.join('\n');
}

export function runAudit(cmd: AuditCommand): { report: string; intact: boolean } {
  const check = verify(cmd.root);
  const report = renderAudit(check, Boolean(cmd.all));
  console.log(report);
  const intact = check.edited.length === 0 && check.broken.length === 0 && check.unreadable.length === 0;
  if (cmd.gate && !intact) process.exitCode = 1;
  return { report, intact };
}
