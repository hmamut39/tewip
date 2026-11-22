// Phase 133: the bill of materials procurement asks for, and the gaps most tools fill in.
//
// An SBOM is the first thing an enterprise buyer asks for and the easiest thing to fake: resolve
// what you can, label the rest NOASSERTION, and the spreadsheet looks complete. The whole value
// of this one is that it will not do that - a licence it could not read is counted, named, and
// kept out of the permissive total.
//
// Two things were found by running it on the corpus before shipping it, and both are in here:
// five of the six JavaScript projects use pnpm rather than npm, and a pnpm lockfile records no
// licences at all.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { classify, NEEDS_A_LOOK } from '../sbom/licences.ts';
import { inventory } from '../sbom/inventory.ts';
import { cycloneDx, imageContents, renderSbom } from '../sbom/sbom-command.ts';

const NL = String.fromCharCode(10);
const project = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'tewip-sbom-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
  return root;
};
const npmLock = (packages: Record<string, unknown>) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' }, ...packages } }, null, 2);

describe('what a licence means', () => {
  it('sorts the families a company has to decide about', () => {
    assert.equal(classify('MIT').standing, 'permissive');
    assert.equal(classify('Apache-2.0').standing, 'permissive');
    assert.equal(classify('LGPL-3.0').standing, 'weak-copyleft');
    assert.equal(classify('GPL-3.0-only').standing, 'strong-copyleft');
    assert.equal(classify('AGPL-3.0').standing, 'strong-copyleft');
    assert.equal(classify('BUSL-1.1').standing, 'source-available');
  });

  it('takes the freest option of a choice and the strictest of a conjunction', () => {
    // `(MIT OR GPL-3.0)` is a choice, so you may take MIT. `MIT AND GPL-3.0` binds you to both.
    // Reading only the first id in the string gets one of these backwards, and it is the one
    // that matters.
    assert.equal(classify('(MIT OR GPL-3.0)').standing, 'permissive');
    assert.equal(classify('MIT AND GPL-3.0').standing, 'strong-copyleft');
    assert.equal(classify('(GPL-3.0 OR MIT)').standing, 'permissive', 'order in the expression must not decide it');
  });

  it('refuses to pick a licence for a package that did not state one', () => {
    for (const nothing of [undefined, '', 'UNLICENSED', 'NOASSERTION', 'SEE LICENSE IN COPYING']) {
      assert.equal(classify(nothing).standing, 'not-stated', String(nothing));
    }
    assert.equal(classify('Weird-Vendor-Licence-4.1').standing, 'not-stated', 'an unrecognised id is not quietly permissive');
  });

  it('does not ask a person to look at a licence nobody has read yet', () => {
    // immich's pnpm lockfile yields 2,705 packages with no licence recorded anywhere in the file.
    // Folding that into "needs a lawyer" is an alarm that gets switched off.
    assert.ok(!NEEDS_A_LOOK.includes('not-recorded'));
    assert.ok(NEEDS_A_LOOK.includes('not-stated'), 'a package that really did not say still counts');
  });
});

describe('reading what the project wrote down', () => {
  it('reads an npm lockfile, licences and all', () => {
    const root = project({
      'package.json': '{"name":"app"}',
      'package-lock.json': npmLock({
        'node_modules/a': { version: '1.0.0', license: 'MIT' },
        'node_modules/b': { version: '2.0.0', license: 'AGPL-3.0', dev: true },
      }),
    });
    const inv = inventory(root);
    assert.deepEqual(inv.components.map((c) => `${c.name}@${c.version}:${c.licence.standing}`), ['a@1.0.0:permissive', 'b@2.0.0:strong-copyleft']);
    assert.equal(inv.components[1].dev, true);
  });

  it('does not read a missing licence in an npm lockfile as a package that has none', () => {
    // npm omits the field for packages that do have a licence: govuk-frontend's lockfile leaves
    // it off 1,088 of 2,632, among them @babel/plugin-syntax-bigint, which is MIT. Reading that
    // absence as a finding asked for a lawyer on 1,088 dependencies. Tewip's own lockfile happens
    // to be complete, which is why the assumption survived until a second project was measured.
    const root = project({ 'package.json': '{"name":"app"}', 'package-lock.json': npmLock({ 'node_modules/quiet': { version: '1.0.0' } }) });
    const [c] = inventory(root).components;
    assert.equal(c.licence.standing, 'not-recorded', 'a gap in the lockfile, not a finding about the package');
    assert.ok(!NEEDS_A_LOOK.includes(c.licence.standing), 'and so it does not ask for a person');
  });

  it('reads a pnpm lockfile, and says the licences are not in it', () => {
    const root = project({
      'package.json': '{"name":"app"}',
      'pnpm-lock.yaml': ["lockfileVersion: '9.0'", '', 'packages:', '', "  '@scope/thing@1.2.3':", '    resolution: {integrity: sha512-x}', '', '  plain-pkg@4.5.6:', '    resolution: {integrity: sha512-y}', '', 'snapshots:', '  nothing: here'].join(NL),
    });
    const inv = inventory(root);
    assert.deepEqual(inv.components.map((c) => `${c.name}@${c.version}`), ['@scope/thing@1.2.3', 'plain-pkg@4.5.6']);
    assert.ok(inv.components.every((c) => c.licence.standing === 'not-recorded'));
    assert.ok(inv.notRead.some((n) => /pnpm lockfile records no licences/.test(n)));
  });

  it('keeps reading after a second packages section', () => {
    // n8n's lockfile holds two documents. Stopping at the first `snapshots:` read 15 of its
    // 3,768 packages and called that the bill of materials.
    const root = project({
      'package.json': '{"name":"app"}',
      'pnpm-lock.yaml': ["lockfileVersion: '9.0'", 'packages:', '  first@1.0.0:', '    resolution: {integrity: sha512-a}', 'snapshots:', '  first@1.0.0: {}', "lockfileVersion: '9.0'", 'packages:', '  second@2.0.0:', '    resolution: {integrity: sha512-b}'].join(NL),
    });
    assert.deepEqual(inventory(root).components.map((c) => c.name), ['first', 'second']);
  });

  it('names an ecosystem it cannot read instead of leaving it out of the total', () => {
    const root = project({ 'pom.xml': '<project/>', 'requirements.txt': 'django==5.0' });
    const inv = inventory(root);
    assert.equal(inv.components.length, 0);
    assert.ok(inv.notRead.some((n) => /^Java/.test(n)));
    assert.ok(inv.notRead.some((n) => /^Python/.test(n)));
  });

  it('does not complain about a missing npm lockfile in a pnpm project', () => {
    const root = project({ 'package.json': '{"name":"app"}', 'pnpm-lock.yaml': ['packages:', '  a@1.0.0:', '    resolution: {integrity: sha512-a}'].join(NL) });
    assert.ok(!inventory(root).notRead.some((n) => /package-lock\.json is not/.test(n)));
  });
});

describe('the documents it hands over', () => {
  const inv = () =>
    inventory(
      project({
        'package.json': '{"name":"app"}',
        // `silent` declares a licence nobody recognises, which is a finding about the package.
        // A package with no `license` key at all is a gap in the lockfile and is covered above.
        'package-lock.json': npmLock({ 'node_modules/good': { version: '1.0.0', license: 'MIT' }, 'node_modules/silent': { version: '2.0.0', license: 'Weird-Vendor-Licence-4.1' } }),
      }),
    );

  it('writes CycloneDX without inventing a licence for the package that has none', () => {
    const doc = cycloneDx(inv(), 'app') as { components: Array<{ name: string; purl: string; licenses?: unknown }> };
    const silent = doc.components.find((c) => c.name === 'silent');
    const good = doc.components.find((c) => c.name === 'good');
    assert.equal(silent?.licenses, undefined, 'no licenses field at all beats a NOASSERTION nobody reads');
    assert.equal(doc.components.length, 2);
    assert.deepEqual(good?.licenses, [{ expression: 'MIT' }]);
    assert.equal(good?.purl, 'pkg:npm/good@1.0.0');
  });

  it('writes no licence for a package whose lockfile format does not record one', () => {
    // Found by running it on immich rather than by thinking about it: 2,705 pnpm components each
    // carried `licenses: [{expression: "(none)"}]`, which is the meaningless-value-in-a-document
    // failure this whole command exists to avoid, committed by the command itself.
    const root = project({ 'package.json': '{"name":"app"}', 'pnpm-lock.yaml': ['packages:', '  a@1.0.0:', '    resolution: {integrity: sha512-a}'].join(NL) });
    const doc = cycloneDx(inventory(root), 'app') as { components: Array<{ name: string; licenses?: unknown }> };
    assert.equal(doc.components.length, 1);
    assert.equal(doc.components[0].licenses, undefined);
  });

  it('carries what it could not read into the document, not only the page', () => {
    const doc = cycloneDx(inventory(project({ 'pom.xml': '<project/>' })), 'app') as { metadata: { properties: Array<{ name: string }> } };
    assert.ok(doc.metadata.properties.some((p) => p.name === 'tewip:not-read'));
  });

  it('tells a reader which packages need a decision, and which were merely not read', () => {
    const page = renderSbom(inv(), null);
    assert.match(page, /No licence stated/);
    assert.match(page, /1 package\(s\) need a person to look/);
    assert.match(page, /does not say whether they are acceptable/, 'it classifies; it does not give legal advice');
  });
});

// Phase 157: an ecosystem it cannot read, in a repository that is not laid out like an example.
//
// Found by pinning `sbom` on bitwarden-server. It reported "0 package(s)" over "Nothing found that
// Tewip could not read" - a complete, confident, empty bill of materials, explicitly denying any
// gaps, for a large C# server with a .csproj in every project and packages.lock.json beside some of
// them. An auditor reading it would conclude the project has no dependencies. It is the failure
// this file's own opening comment says the command exists not to commit.
describe('an ecosystem Tewip cannot read', () => {
  const project = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-eco-'));
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), body, 'utf8');
    }
    return root;
  };

  it('names .NET, which the comment above the list has always claimed', () => {
    const root = project({ 'src/Admin/Admin.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>' });
    const gaps = inventory(root).notRead.join(' ');
    assert.match(gaps, /\.NET/, 'a C# project came back with no readable packages and no stated gap');
  });

  it('finds a manifest that is not at the repository root', () => {
    // `existsSync(join(root, file))` was the whole of the check, which is right for a repository
    // with one manifest at its root and wrong for every monorepo.
    const root = project({ 'perf/MicroBenchmarks/packages.lock.json': '{"version":1,"dependencies":{}}' });
    assert.match(inventory(root).notRead.join(' '), /\.NET/);
  });

  it('never reports nothing readable and no gap at the same time', () => {
    // The invariant, stated as one assertion: if this command read nothing, it has to say why.
    // Every ecosystem it knows about, one at a time, each below the root.
    const manifests: Record<string, string> = {
      'api/requirements.txt': 'flask==3.0.0',
      'svc/pyproject.toml': '[project]\nname = "x"',
      'cmd/go.mod': 'module example.com/x',
      'web/Gemfile.lock': 'GEM\n  specs:\n',
      'mod/pom.xml': '<project></project>',
      'app/build.gradle': 'dependencies {}',
      'native/Cargo.lock': 'version = 3',
      'site/composer.lock': '{"packages":[]}',
      'src/App/App.csproj': '<Project></Project>',
    };
    for (const [path, body] of Object.entries(manifests)) {
      const root = project({ [path]: body });
      const inv = inventory(root);
      assert.equal(inv.components.length, 0, `${path} should not be readable as components`);
      assert.ok(
        inv.notRead.length > 0,
        `${path} is in the project and nothing was read from it, and the report claims no gaps. That is an empty bill of materials denying it is empty.`,
      );
    }
  });

  it('does not go looking inside somebody else dependencies', () => {
    // A manifest under node_modules belongs to a package, not to this project, and counting it
    // would report a gap in every JavaScript repository on earth.
    const root = project({ 'node_modules/left-pad/Cargo.lock': 'version = 3', 'package.json': '{"name":"x","version":"1.0.0"}' });
    assert.equal(inventory(root).notRead.join(' ').includes('Rust'), false);
  });
});

// Phase 187. On a clone of the Flutter SDK - 141 `pubspec.yaml` files - `sbom` said:
//
//   0 package(s). Nothing was read. The section below says why, and that is the whole answer
//   ## What is not in this list
//   - Java: Gradle resolution needs the build, which Tewip does not run
//
// A complete, confident, empty bill of materials for a repository full of Dart dependencies, whose
// gap list claimed to be the whole answer and omitted the project's primary ecosystem. The comment
// in `inventory.ts` already records this happening once before, for .NET on bitwarden-server. The
// list is hand-maintained, so adding Dart fixes Dart and waits for the next one.
describe('a manifest nobody on the list recognised', () => {
  it('names Dart rather than passing over it', () => {
    const root = project({ 'pubspec.yaml': 'name: app\ndependencies:\n  http: ^1.0.0\n' });
    const { notRead, components } = inventory(root);
    assert.equal(components.length, 0, 'it still cannot read pub, and does not pretend to');
    assert.ok(
      notRead.some((n) => /Dart or Flutter/.test(n)),
      `the gap list has to name Dart: ${JSON.stringify(notRead)}`,
    );
  });

  it('reports a manifest it recognises by name but handles nowhere', () => {
    // Found on the same repository: Flutter's iOS build uses CocoaPods, which neither the gap list
    // nor the readers knew. It fell out of the report entirely.
    const root = project({ 'Podfile': "platform :ios, '12.0'\n" });
    assert.ok(
      inventory(root).notRead.some((n) => /Podfile.*does not recognise/.test(n)),
      'an unrecognised manifest must be named, not dropped',
    );
  });

  it('says nothing about a project with no manifests at all', () => {
    const root = project({ 'README.md': '# nothing here' });
    assert.deepEqual(inventory(root).notRead, [], 'a report that invents gaps is as bad as one that hides them');
  });

  it('never reports one manifest twice', () => {
    // A name in both the recognised-gap list and the unrecognised set would print two lines about
    // the same file, which reads as two separate problems.
    const root = project({ 'pubspec.yaml': 'name: app\n', 'go.mod': 'module x\n' });
    const { notRead } = inventory(root);
    const dart = notRead.filter((n) => /pubspec|Dart/.test(n));
    assert.equal(dart.length, 1, `pubspec is reported ${dart.length} times: ${JSON.stringify(dart)}`);
    assert.ok(!notRead.some((n) => /go\.mod.*does not recognise/.test(n)), 'go.mod is handled, so it is not unrecognised');
  });
});

// Phase 213. The title of this report is "What this project ships", and it was counting a
// devcontainer's apt packages. immich's `server/Dockerfile.dev` contributed vim, nano,
// inetutils-ping and openjdk-21-jre-headless to the bill of materials for what it ships.
describe('the bill of materials covers what ships', () => {
  const NL = String.fromCharCode(10);

  it('leaves out a Dockerfile that exists to develop the project', () => {
    const root = mkdtempSync(join(tmpdir(), 'tewip-sbom-ships-'));
    writeFileSync(join(root, 'Dockerfile'), ['FROM node:22', 'RUN apt-get install -y curl'].join(NL), 'utf8');
    writeFileSync(join(root, 'Dockerfile.dev'), ['FROM node:22', 'RUN apt-get install -y vim nano'].join(NL), 'utf8');
    const image = imageContents(root);
    assert.equal(image.dockerfiles, 1, 'only the shipping Dockerfile is counted');
    assert.deepEqual(image.packages.map((p) => p.name).sort(), ['curl'], 'vim and nano are developer tools and do not ship');
  });

  it('still counts a base image the shipping file also builds from', () => {
    // immich's `server/Dockerfile` uses base-server-dev as its *builder* stage, so that base does
    // ship even though the devcontainer uses it too. Its bases count was right and had to stay.
    const root = mkdtempSync(join(tmpdir(), 'tewip-sbom-base-'));
    writeFileSync(join(root, 'Dockerfile'), ['FROM ghcr.io/acme/base-dev:1 AS builder', 'FROM node:22 AS prod'].join(NL), 'utf8');
    writeFileSync(join(root, 'Dockerfile.dev'), ['FROM ghcr.io/acme/base-dev:1 AS dev'].join(NL), 'utf8');
    assert.ok(imageContents(root).bases.some((b) => b.includes('base-dev')), 'a builder stage of a shipping image is still a base it ships from');
  });
});
