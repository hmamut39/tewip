// Everything this project ships, read off disk, with what could not be read said out loud.
//
// An SBOM is a list of what is in your software, and procurement asks for one before anything
// else. The tempting way to build it is to resolve the dependency tree yourself and fill the gaps
// from a registry; the honest way is to read what the project has already written down and report
// the gaps as gaps. A bill of materials that quietly omits the half it could not resolve is worse
// than no bill of materials, because somebody signs it.
//
// So: no network, no guessing, and every ecosystem found but unreadable is named in the output.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify, type Classified } from './licences.ts';

export interface Component {
  name: string;
  version: string;
  /** npm, pypi, ... - the ecosystem, for the purl. */
  ecosystem: string;
  licence: Classified;
  /** True when the project needs it only to build or test, not to run. */
  dev: boolean;
  /**
   * Whether `dev` was read or merely defaulted.
   *
   * A pnpm lockfile is parsed here for names and versions only, and every component came back
   * `dev: false`. The evidence pack then told a reader that all 2,705 of immich's packages "ship
   * with the product", which is a claim about the product that nothing in the file supports. An
   * unread field defaulting to a confident answer is the same defect as an empty section reading
   * as a clean one, so the readers that cannot tell say they cannot tell.
   */
  devKnown: boolean;
  /** Where the version came from, so a reader can check it. */
  from: string;
}

export interface Inventory {
  components: Component[];
  /** Ecosystems present in the project that Tewip could not read, and why. */
  notRead: string[];
  /** What it did read, for the report's own honesty line. */
  read: string[];
}

/** package-lock.json v2 and v3: npm records the resolved version and licence of every package. */
function fromNpm(root: string): { components: Component[]; note: string | null } {
  const lock = join(root, 'package-lock.json');
  if (!existsSync(lock)) {
    return existsSync(join(root, 'package.json'))
      ? { components: [], note: 'npm: package.json is here but package-lock.json is not, and without a lockfile the exact versions shipped are not written down anywhere Tewip can read' }
      : { components: [], note: null };
  }
  let parsed: { packages?: Record<string, { version?: string; license?: unknown; dev?: boolean; optional?: boolean }> };
  try {
    parsed = JSON.parse(readFileSync(lock, 'utf8')) as typeof parsed;
  } catch {
    return { components: [], note: 'npm: package-lock.json could not be parsed, so nothing was read from it' };
  }
  const packages = parsed.packages;
  if (!packages) return { components: [], note: 'npm: this lockfile predates v2 and does not record licences; run `npm install` once with npm 7 or later to upgrade it' };

  const components: Component[] = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '') continue; // the project itself, not a component of its own bill
    const name = path.replace(/^(?:.*node_modules\/)/, '');
    if (!name || !entry.version) continue;
    // npm does not always write a licence, even in lockfile v3. govuk-frontend's lockfile omits
    // one for 1,088 of its 2,632 packages, among them @babel/plugin-syntax-bigint, which is MIT
    // and has been for years. Reading that absence as "this package declares no licence" turned
    // a gap in the file into 1,088 dependencies needing a lawyer - the same mistake pnpm forced
    // me to see, hiding in the format I had assumed was complete because Tewip's own lockfile
    // happens to be. `node_modules` settles it when it is there; nothing else can.
    const licence = entry.license
      ? classify(entry.license)
      : { declared: '(none)', standing: 'not-recorded' as const, means: 'this lockfile does not record a licence for it, which is not the same as the package not having one' };
    components.push({ name, version: entry.version, ecosystem: 'npm', licence, dev: Boolean(entry.dev), devKnown: true, from: 'package-lock.json' });
  }
  return { components, note: null };
}

/**
 * Python, Ruby, Go, Java, .NET and the rest.
 *
 * Deliberately not implemented by reading a requirements.txt and calling it a bill of materials.
 * `requirements.txt` holds what was asked for, not what is installed - ranges, extras, and
 * nothing transitive - and a bill of materials built from it is a list of intentions. The
 * installed metadata is the truth, and it is not in the repository. Saying so is the useful
 * answer; inventing the rest is not.
 */
const OTHER_ECOSYSTEMS: Array<[file: string, says: string]> = [
  ['requirements.txt', 'Python: requirements.txt lists what was asked for, not the versions installed or anything transitive, and the installed metadata is not in the repository'],
  ['pyproject.toml', 'Python: pyproject.toml declares ranges, not the versions that would ship'],
  ['go.mod', 'Go: go.mod is readable but Tewip does not read it yet'],
  ['Gemfile.lock', 'Ruby: Gemfile.lock is readable but Tewip does not read it yet'],
  ['pom.xml', 'Java: Maven resolution needs the build, which Tewip does not run'],
  ['build.gradle', 'Java: Gradle resolution needs the build, which Tewip does not run'],
  ['Cargo.lock', 'Rust: Cargo.lock is readable but Tewip does not read it yet'],
  ['composer.lock', 'PHP: composer.lock is readable but Tewip does not read it yet'],
];

/**
 * pnpm-lock.yaml, which is what five of the six JavaScript projects in the corpus actually use.
 *
 * Found before shipping by running this on them: the first version read only package-lock.json
 * and would have answered "no lockfile here" on n8n, nocodb, immich, angular-components and
 * discourse. A bill-of-materials tool that covers one package manager covers almost nothing.
 *
 * pnpm records no licence at all - not an omission in this reader, a fact about the format - so
 * these components arrive with their licence not stated, and the report says why rather than
 * letting 2,705 packages read as unlicensed. `node_modules` fills them in when it is there.
 *
 * Parsed by hand because the shape needed is one line deep: under `packages:`, each key is
 * `'name@version':`. Adding a YAML dependency to read two tokens would be the wrong trade.
 */
function fromPnpm(root: string): { components: Component[]; note: string | null } {
  const lock = join(root, 'pnpm-lock.yaml');
  if (!existsSync(lock)) return { components: [], note: null };
  let text: string;
  try {
    text = readFileSync(lock, 'utf8');
  } catch {
    return { components: [], note: 'pnpm: pnpm-lock.yaml could not be read' };
  }
  const components: Component[] = [];
  const seen = new Set<string>();
  let inPackages = false;
  for (const line of text.split(String.fromCharCode(10))) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    // The next top-level key ends the section, but not the file: n8n's lockfile carries two
    // documents, with a second `lockfileVersion` and a second `packages:` 150 lines down. Breaking
    // out here read 15 of its packages and called that the bill of materials.
    if (inPackages && /^[a-zA-Z]/.test(line)) {
      inPackages = false;
      continue;
    }
    if (!inPackages) continue;
    const key = /^ {2}'?((?:@[^/'@]+\/)?[^'@\s]+)@([^':\s(]+)[^:]*'?:\s*$/.exec(line);
    if (!key) continue;
    const id = `${key[1]}@${key[2]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    components.push({ name: key[1], version: key[2], ecosystem: 'npm', licence: { ...classify(undefined), standing: 'not-recorded', means: 'a pnpm lockfile does not record licences, so this one has not been read - which is not the same as the package not having one' }, dev: false, devKnown: false, from: 'pnpm-lock.yaml' });
  }
  return {
    components,
    note: components.length > 0 ? 'pnpm: a pnpm lockfile records no licences at all, so every package above is listed without one. Run `pnpm install` and scan again, or read them from a registry - Tewip will not guess.' : null,
  };
}

/** Licences from installed packages, which is the only place a pnpm or yarn project keeps them. */
function fillFromNodeModules(root: string, components: Component[]): number {
  let filled = 0;
  for (const c of components) {
    if (c.licence.standing !== 'not-stated') continue;
    for (const where of [join(root, 'node_modules', c.name, 'package.json'), join(root, 'node_modules', '.pnpm', `${c.name.replace('/', '+')}@${c.version}`, 'node_modules', c.name, 'package.json')]) {
      if (!existsSync(where)) continue;
      try {
        const declared = (JSON.parse(readFileSync(where, 'utf8')) as { license?: unknown }).license;
        const found = classify(declared);
        if (found.standing === 'not-stated') break;
        c.licence = found;
        c.from = `${c.from} + node_modules`;
        filled += 1;
      } catch {
        // an unreadable package.json tells us nothing, which is what it already said
      }
      break;
    }
  }
  return filled;
}

export function inventory(root: string): Inventory {
  const notRead: string[] = [];
  const read: string[] = [];
  const npm = fromNpm(root);
  const pnpm = fromPnpm(root);
  if (npm.components.length > 0) read.push(`npm, from package-lock.json (${npm.components.length} package(s))`);
  if (pnpm.components.length > 0) read.push(`pnpm, from pnpm-lock.yaml (${pnpm.components.length} package(s))`);
  // A pnpm project also has a package.json, and complaining that its npm lockfile is missing
  // would be noise about a package manager it does not use.
  if (npm.note && pnpm.components.length === 0) notRead.push(npm.note);
  const components = [...npm.components, ...pnpm.components];
  const filled = fillFromNodeModules(root, components);
  if (filled > 0) read.push(`${filled} licence(s) read from node_modules`);
  if (pnpm.note && components.some((c) => c.licence.standing === 'not-recorded')) notRead.push(pnpm.note);
  const unrecordedNpm = components.filter((c) => c.licence.standing === 'not-recorded' && c.from.startsWith('package-lock')).length;
  if (unrecordedNpm > 0) {
    notRead.push(
      `npm: ${unrecordedNpm} package(s) have no licence in package-lock.json. npm omits the field for some packages that do have one, so this is a gap in the lockfile rather than a finding about them. Run \`npm install\` and scan again to read them from node_modules.`,
    );
  }
  for (const [file, says] of OTHER_ECOSYSTEMS) if (existsSync(join(root, file))) notRead.push(says);
  return { components: components.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)), notRead, read };
}
