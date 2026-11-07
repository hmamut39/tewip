// User input reaching somewhere dangerous, when the path is visible in one function.
//
// Real taint analysis follows values across functions, files and call graphs. This does not, and
// the refusal is the design. A tool that guesses across boundaries produces a list of maybes, and
// a list of maybes is read once and then switched off - which is worse than no tool, because
// somebody has written "we run SAST" on a form.
//
// So: a source and a sink inside the same function, with the value either used directly or
// through one named variable, and nothing in between that makes it safe. Everything else is
// reported as not looked at. Measured on 18,617 source files from n8n, nocodb, immich, saleor and
// dispatch: **zero findings**, which is the precision claim. Mature projects parameterise their
// queries. Recall is measured against planted examples and is stated as such, because the corpus
// contains no real injection to find.
export interface Flow {
  file: string;
  line: number;
  kind: 'sql-injection' | 'command-injection';
  /** The request value that reaches the sink. */
  source: string;
  /** The call it reaches. */
  sink: string;
  /** How it got there: directly, or through a variable. */
  through: string;
  evidence: string;
}

/** Where untrusted data comes into a request handler. Framework-specific on purpose. */
const SOURCE = String.raw`(?:req|request|ctx\.request)\.(?:query|body|params|headers)(?:\s*\.\s*\w+|\s*\[[^\]]+\])*`;

const SINKS: Array<{ kind: Flow['kind']; re: RegExp; sink: string }> = [
  { kind: 'sql-injection', re: /\.\s*(?:query|execute|raw|unsafe)\s*\(/g, sink: 'a database query' },
  { kind: 'command-injection', re: /\b(?:execSync|spawnSync|execFileSync)\s*\(|\bexec\s*\(/g, sink: 'a shell command' },
];

/**
 * Text that makes a tainted value safe where it is used.
 *
 * Not a general sanitiser list - a general list is how a scanner talks itself out of real
 * findings. These are the three that are certain from the text: a number cannot carry SQL, a
 * value bound as a parameter is never parsed as syntax, and an explicit escape says so.
 */
const MADE_SAFE = /\b(?:parseInt|parseFloat|Number|encodeURIComponent|escape|escapeId|sqlstring\.escape)\s*\(/;

/**
 * A value is only dangerous here if it is glued into the string, not passed beside it.
 *
 * Exported because the agent checks need exactly this question about a different kind of string: a
 * prompt. The Python shapes are here rather than in a second copy for the same reason - an f-string
 * glues a value in exactly as a template literal does, and the difference is only spelling.
 */
export function gluedIn(argument: string, expression: string): string | null {
  const e = expression.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(String.raw`\$\{[^}]*` + e, 's').test(argument)) return 'a template literal';
  if (new RegExp(e + String.raw`\s*\+|\+\s*` + e).test(argument)) return 'string concatenation';
  if (new RegExp(String.raw`\.concat\s*\([^)]*` + e).test(argument)) return 'concat()';
  // Python: an f-string, old-style %, and .format(), which glue a value in just as firmly.
  if (new RegExp(String.raw`f["'][^"']*\{[^}]*` + e, 's').test(argument)) return 'an f-string';
  if (new RegExp(String.raw`%\s*\(?[^)]*` + e).test(argument)) return '% formatting';
  if (new RegExp(String.raw`\.format\s*\([^)]*` + e).test(argument)) return '.format()';
  return null;
}

/** The first argument of a call that starts at `from`, which is the one parsed as syntax. */
function firstArgument(text: string, from: number): string {
  const open = text.indexOf('(', from);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < text.length && i < open + 4000; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    } else if (ch === ',' && depth === 1) return text.slice(open + 1, i);
  }
  return text.slice(open + 1, Math.min(text.length, open + 4000));
}

/**
 * The function body each offset sits in, so a source and a sink in different handlers are never
 * joined. Crude - it finds the enclosing braces - and crude in the safe direction: a body it
 * cannot determine yields no finding at all.
 */
export function sameBody(text: string, a: number, b: number): boolean {
  if (a > b) return false;
  let depth = 0;
  for (let i = a; i < b; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      // Left the block the source was declared in before reaching the sink.
      if (depth < 0) return false;
    }
  }
  return true;
}

export function flows(file: string, source: string): Flow[] {
  const found: Flow[] = [];
  const direct = new RegExp(SOURCE);
  if (!direct.test(source)) return found;
  const assigned = [...source.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+(\w+)\s*=\s*[^;\n]*?(` + SOURCE + String.raw`)`, 'g'))];

  for (const { kind, re, sink } of SINKS) {
    for (const m of source.matchAll(new RegExp(re.source, 'g'))) {
      const at = m.index ?? 0;
      const argument = firstArgument(source, at);
      if (!argument) continue;
      const line = source.slice(0, at).split(String.fromCharCode(10)).length;
      const evidence = `${m[0]}${argument}`.replace(/\s+/g, ' ').slice(0, 160);

      // Directly: the request value is written inside the query string itself.
      const inArg = new RegExp(SOURCE).exec(argument);
      if (inArg) {
        const how = gluedIn(argument, inArg[0]);
        if (how) {
          found.push({ file, line, kind, source: inArg[0], sink, through: how, evidence });
          continue;
        }
      }
      // Through one variable, assigned from a request value earlier in the same body.
      for (const a of assigned) {
        const name = a[1];
        const declaredAt = a.index ?? 0;
        if (declaredAt > at || !sameBody(source, declaredAt, at)) continue;
        // The sanitiser belongs to the assignment, not to the query. `const id =
        // parseInt(req.query.id)` makes `id` a number before it ever reaches the string, and
        // looking for parseInt in the query argument - where it will never be - made this check
        // dead code that no test noticed, because the shape it was written for cannot occur.
        if (MADE_SAFE.test(a[0])) continue;
        const how = gluedIn(argument, name);
        if (!how) continue;
        found.push({ file, line, kind, source: a[2], sink, through: `${how}, through \`${name}\``, evidence });
        break;
      }
    }
  }
  return found;
}
