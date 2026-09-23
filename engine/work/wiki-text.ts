// Jira Cloud stores a description as a tree (Atlassian Document Format). Jira Server and Data
// Center - which is what most companies still run, and what the public Apache and Jenkins trackers
// use - store it as one string of wiki markup. Tewip has to read both, or half the tickets in the
// world come out full of `h2.`, `{code}` and `[~someone]`.
//
// Measured on 150 real tickets from those two trackers: before this, 75 of 150 descriptions came
// out as readable text.

/** A character no ticket contains, holding a heading's place while lists are converted. */
const MARK = String.fromCharCode(1);

/** A heading, so the section it starts can be found afterwards: kept as "## Words". */
const HEADING = /^\s*h([1-6])\.\s*(.+)$/gm;

/** Decorations around words: *bold*, _italic_, +inserted+, -struck-, ??cited??, ^sup^, ~sub~. */
const stripDecorations = (text: string): string =>
  text
    .replace(/\{\{([^}]*)\}\}/g, '$1')
    .replace(/(^|[\s(])([*_+])(?=\S)([^\n]*?\S)\2(?=[\s.,;:)!?]|$)/g, '$1$3')
    .replace(/(^|[\s(])-(?=\S)([^\n]*?\S)-(?=[\s.,;:)!?]|$)/g, '$1$2')
    .replace(/\?\?([^?]+)\?\?/g, '$1');

export function wikiToText(markup: string): string {
  let text = markup.replace(/\r\n?/g, '\n');

  // Blocks first: their contents are kept, their fences are not.
  text = text
    .replace(/\{code(?::[^}]*)?\}\n?([\s\S]*?)\{code\}/g, (_m, body: string) => `\n${body.trim()}\n`)
    .replace(/\{noformat\}\n?([\s\S]*?)\{noformat\}/g, (_m, body: string) => `\n${body.trim()}\n`)
    .replace(/\{quote\}\n?([\s\S]*?)\{quote\}/g, (_m, body: string) => `\n${body.trim()}\n`)
    .replace(/\{panel(?::[^}]*)?\}\n?([\s\S]*?)\{panel\}/g, (_m, body: string) => `\n${body.trim()}\n`)
    .replace(/\{color(?::[^}]*)?\}/g, '')
    .replace(/\{anchor:[^}]*\}/g, '')
    .replace(/\{[a-z-]+(?::[^}]*)?\}/g, ''); // any other macro fence

  // Headings become "## Words", which is how the rest of Tewip recognises a section. They are
  // marked first and written out last: in wiki markup a numbered list item also starts with "#",
  // and converting headings straight to "##" turned every heading into a bullet.
  text = text.replace(HEADING, (_m, level: string, words: string) => `\n${MARK}${level} ${stripDecorations(words).trim().replace(/[:\s]+$/, '')}`);

  text = text
    .replace(/\[([^\]|]+)\|([^\]]+)\]/g, '$1 ($2)') // [text|https://...]
    .replace(/\[~([\w.@-]+)\]/g, '@$1') // a person
    .replace(/\[([^\]|]{1,80})\]/g, '$1') // [SOME-123]
    .replace(/^\s*\|\|(.+)\|\|\s*$/gm, (_m, row: string) => row.split('||').map((c) => c.trim()).filter(Boolean).join(' | '))
    .replace(/^\s*\|(.+)\|\s*$/gm, (_m, row: string) => row.split('|').map((c) => c.trim()).filter(Boolean).join(' | '))
    .replace(/^\s*[*#]{1,4}\s+/gm, '- ') // bullet and numbered lists
    .replace(/\\\\\s*$/gm, '') // a forced line break
    .replace(/^\s*----+\s*$/gm, '');

  // The headings, written out now that nothing else can be mistaken for them.
  text = text.replace(new RegExp(`${MARK}([1-6]) `, 'g'), (_m, level: string) => `${'#'.repeat(Number(level))} `);

  return stripDecorations(text)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The heading that starts the acceptance criteria. Real tickets write it as "h2. Acceptance
 * Criteria", "h1. +*Acceptance criteria*+", "*Acceptance criteria (Given / When / Then):*",
 * "Suggested acceptance criteria" and "Definition of Done" - all of these are from the corpus.
 */
const CRITERIA_LINE = /^\s*(?:#{1,6}\s*)?(?:suggested|proposed|draft)?\s*(?:acceptance\s+criteria|acceptance|definition\s+of\s+done|dod)\b[^\n]*$/i;
/** A line that starts a different section, which ends the criteria. */
const OTHER_HEADING = /^#{1,6}\s+\S/;

/** The acceptance criteria written in a description, or '' when the author wrote none. */
export function criteriaSection(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => CRITERIA_LINE.test(line) && /acceptance|definition\s+of\s+done|dod/i.test(line));
  if (start < 0) return '';
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (OTHER_HEADING.test(lines[i])) break;
    body.push(lines[i]);
  }
  const section = body.join('\n').trim();
  // A heading with nothing under it is not criteria; nor is one whose "criteria" is a single word.
  return section.length > 10 ? section : '';
}
