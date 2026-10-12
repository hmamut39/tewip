// Reading somebody else's file, the same way on every machine.
//
// Found by the corpus harness on its first run in CI, Phase 44: the same pinned commit of Keycloak
// produced 0 swallows-failure findings on Windows and 3 on Linux, and OpenMRS differed by seven
// crash-only tests. Git for Windows checks source out with CRLF, so the text Tewip judged was not
// the text the project wrote, and a scanner whose answer depends on which machine ran it is not
// giving an answer at all - it is giving an opinion with a hostname attached.
//
// The carriage returns go at the boundary rather than in each rule, because the alternative is
// remembering `\r?` in every pattern anybody writes afterwards, and one forgotten `\r?` is this bug
// again. Line numbers are unaffected: a CRLF file has exactly as many newlines as an LF one.
//
// A BOM goes too. It is invisible, it sits before the first character of the file, and it stops a
// pattern anchored at the start of the text from matching the first line.
import { readFileSync } from 'node:fs';

/** The file's text with line endings normalised, or '' when it cannot be read. */
export function sourceText(file: string): string {
  try {
    return normalise(readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
}

/** Normalised, for text that has already been read. */
export function normalise(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.includes(String.fromCharCode(13)) ? withoutBom.split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10)) : withoutBom;
}
