// Making two checks agree before a person has to notice they do not.
//
// Running the web check against a real Express server that served its own directory, Tewip said two
// things in the same report. The web check: "the .env file is served, so its settings and keys are
// public" - critical. The secret scan, about a credential inside that same file: "git does not
// track .env, so this never left the machine" - low, and filed under *real, but not reachable*.
//
// Each is right from where it stands, and together they are misleading. Whether a secret is exposed
// depends on what else is true, and here something else was true: the file is being served to
// anyone who asks. A credential in it has left the machine by the most direct route there is.
import type { SecurityItem } from './triage.ts';

/** The path a web finding says is being served, e.g. "/.env" from "GET http://host/.env answered". */
function servedPath(item: SecurityItem): string | null {
  if (item.kind !== 'web') return null;
  // Take the whole address and ask the URL parser for the path. Pulling the path out with a regular
  // expression captured "//127.0.0.1:3211/.env", host and all, and then matched nothing.
  const found = /GET\s+(\S+)\s+answered/.exec(item.why);
  if (!found) return null;
  try {
    return new URL(found[1]).pathname;
  } catch {
    return found[1].startsWith('/') ? found[1] : null;
  }
}

/** The file a secret finding is in, from "a database URL with a password in it in .env:1". */
const fileOf = (item: SecurityItem): string => (item.kind === 'secret' ? (item.where.split(':')[0] ?? '') : '');

/**
 * Where one check changes what another means. Today that is one case, and it is the one that
 * matters most: a secret sitting in a file the application serves.
 */
export function reconcile(items: SecurityItem[]): SecurityItem[] {
  const served = new Set(
    items
      .map(servedPath)
      .filter((p): p is string => Boolean(p))
      .map((p) => p.replace(/^\//, '').toLowerCase()),
  );
  if (served.size === 0) return items;

  return items.map((item) => {
    const file = fileOf(item).replace(/\\/g, '/').toLowerCase();
    if (!file || !served.has(file) || item.verdict === 'accepted') return item;
    return {
      ...item,
      verdict: 'real-risk',
      severity: 'critical',
      why: `${item.why} - but the running application serves /${file} to anyone who asks, so this credential is public`,
      next: `treat this credential as leaked and rotate it now, then stop serving /${file}`,
    };
  });
}
