// Reading the command line. Shared by every verb, wherever it lives.

/** A `--name value` flag. */
export const flag = (args: string[], name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * The folder a verb was pointed at, which is **not** simply the first argument without dashes.
 *
 * Every repository-wide verb used to find its folder with `args.find((a) => !a.startsWith('--'))`,
 * and in `--name value` form the value does not start with dashes either. So `tewip sbom --out
 * sbom.md` read a folder called `sbom.md`, found nothing in it, and printed "0 packages" over
 * "Nothing found that Tewip could not read" - a confident, complete, empty bill of materials for a
 * path that was never a repository. The same line broke `infra`, `agent`, `contract --since
 * HEAD~1`, `portfolio` and `evidence`: six verbs, each quietly reporting on the wrong thing the
 * moment anybody passed the flag the help text tells them to pass.
 *
 * It is the failure this project exists to refuse - a wrong answer shaped exactly like a right one -
 * so the fix lives here rather than six times over, and `takesValue` is given explicitly. A caller
 * that forgets a flag gets a wrong folder, which is why the test beside this asserts every verb's
 * list against the flags that verb actually reads.
 */
export function folderArg(args: string[], takesValue: string[] = []): string | undefined {
  const consumed = new Set<number>();
  for (const name of takesValue) {
    const i = args.indexOf(`--${name}`);
    // `--out=file` consumes nothing after it, so only the two-token form skips the next argument.
    if (i >= 0 && i + 1 < args.length) consumed.add(i + 1);
  }
  for (const [i, a] of args.entries()) {
    if (a.startsWith('-') || consumed.has(i)) continue;
    return a;
  }
  return undefined;
}
