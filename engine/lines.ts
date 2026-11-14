// Splitting a file into lines, without reading the line ending as content.
//
// One function, in its own file, because getting this wrong is silent. A CRLF file split on `\n`
// alone leaves a carriage return at the end of every line, and in JavaScript `.` does not match
// `\r` and `$` without the `m` flag matches only the very end of the string. So a pattern like
// `/^\s*cap_add\s*:(.*)$/` matches a Unix line and not the identical Windows one - and the rule it
// belongs to does not report an error, it reports nothing.
//
// That is the worst way for this product to fail. Its whole argument is that absence is not
// approval: a check that could not run says so, in words. A rule that finds zero on every Windows
// checkout says "nothing here" instead, to the people most likely to be running Windows - and it
// shipped that way until a three-platform CI matrix was added in Phase 168 and failed on its first
// run. `eval/crlf-parity.ts` measures it, and `node eval/crlf-parity.ts` re-derives the figure.
//
// Some patterns survive CRLF by luck: `\s` does match `\r`, so a rule ending in `\s*$` is fine
// until somebody writes the next one. Luck is not a property worth depending on, so the splitting
// happens here instead of being handled pattern by pattern.

/** Every `\r` that a CRLF or a lone-CR file would leave behind. */
const ENDING = /\r\n|\n|\r/;

/**
 * The lines of a file, with the ending removed, for LF, CRLF and classic Mac CR files alike.
 *
 * A trailing newline yields a final empty string, exactly as `split('\n')` does, because callers
 * number lines from the index and dropping it would move every line number after it.
 */
export const lines = (source: string): string[] => source.split(new RegExp(ENDING.source, 'g'));

/** One line with any trailing carriage return removed, for code that splits elsewhere. */
export const unterminated = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

/**
 * The same text with every line ending turned into a single `\n`.
 *
 * For code that matches patterns against whole-file text rather than line by line. A rule written
 * `/^\s*privileged\s*:\s*true/gm` is wrong on a CRLF file in two separate ways - `^` matches
 * between the `\r` and the `\n` because `m` treats a lone `\r` as a terminator, and `\s` then runs
 * forward across the break - so the match lands on the next line and reports the index of the
 * previous one. Normalising once at the point the file is read is cheaper and safer than being
 * right about `\s` versus `[ \t]` in every pattern written from now on.
 */
export const lf = (source: string): string => source.replace(/\r\n|\r/g, String.fromCharCode(10));
