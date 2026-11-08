// What the image installs that no lockfile records.
//
// A bill of materials built from package-lock.json is a list of what your *application* depends
// on. It says nothing about the operating system underneath it, and that is where most of the
// published vulnerabilities in a container actually live - curl, openssl, git, the base image's
// own libraries. A team that produces a CycloneDX file from their lockfile and files it as "our
// SBOM" has a document that is accurate and answers a different question than the one asked.
//
// Reading the image itself needs a registry, a pull and a layer walker, which this will not do.
// But a Dockerfile *states* what it installs: `RUN apt-get install -y curl git` is a declaration,
// in the file, of packages that ship. That is readable offline and it is the part a lockfile can
// never cover.
//
// What it cannot see is what the base image already contained, and that is said plainly rather
// than left as an impression - `FROM node:20` brings a whole Debian with it and nothing here knows
// what is in it.
import { instructionsOf } from '../iac/dockerfile.ts';

export interface ImagePackage {
  name: string;
  /** The version as written, or null when the line pins nothing. */
  version: string | null;
  /** apt, apk, yum, pip, npm-global, gem - how it gets installed. */
  installer: string;
  file: string;
  line: number;
}

interface Installer {
  name: string;
  /** Matches the install command and captures everything after it. */
  re: RegExp;
  /** How this installer spells `name=version`. */
  pinned: RegExp;
}

const INSTALLERS: Installer[] = [
  { name: 'apt', re: /\bapt(?:-get)?\s+(?:-[^\s]+\s+)*install\s+([^&|;]+)/g, pinned: /^([\w.+-]+)=(.+)$/ },
  { name: 'apk', re: /\bapk\s+(?:--[^\s]+\s+)*add\s+([^&|;]+)/g, pinned: /^([\w.+-]+)=(.+)$/ },
  { name: 'yum', re: /\b(?:yum|dnf|microdnf)\s+(?:-[^\s]+\s+)*install\s+([^&|;]+)/g, pinned: /^([\w.+-]+)-(\d[\w.+-]*)$/ },
  { name: 'pip', re: /\bpip3?\s+install\s+([^&|;]+)/g, pinned: /^([\w.[\]-]+)==(.+)$/ },
  { name: 'npm-global', re: /\bnpm\s+(?:i|install|add)\s+(?:[^&|;]*?-g|[^&|;]*?--global)\s+([^&|;]+)/g, pinned: /^(@?[\w./-]+)@(.+)$/ },
  { name: 'gem', re: /\bgem\s+install\s+([^&|;]+)/g, pinned: /^([\w.-]+):(.+)$/ },
];

/** Flags and shell noise that are not package names. */
const NOT_A_PACKAGE = /^(?:-|&&|\|\||;|\\|\$|")/;

/**
 * A package name that is really a file or a URL.
 *
 * `pip install -r requirements.txt` and `pip install ./dist/thing.whl` install from somewhere
 * else, and listing `requirements.txt` as a shipped package would be nonsense. The requirements
 * file itself is a lockfile question, which `inventory` already answers.
 */
const NOT_A_NAME = /^(?:https?:|git\+|\.{0,2}\/|[\w./-]+\.(?:txt|whl|tar\.gz|tgz|deb|rpm|json)$)/i;

export function imagePackages(file: string, source: string): ImagePackage[] {
  const out: ImagePackage[] = [];
  const seen = new Set<string>();
  for (const instruction of instructionsOf(source)) {
    if (instruction.keyword !== 'RUN') continue;
    for (const { name: installer, re, pinned } of INSTALLERS) {
      for (const m of instruction.rest.matchAll(new RegExp(re.source, 'g'))) {
        for (const raw of m[1].split(/\s+/)) {
          const word = raw.trim().replace(/\\$/, '');
          if (word === '' || NOT_A_PACKAGE.test(word) || NOT_A_NAME.test(word)) continue;
          const pin = pinned.exec(word);
          const name = pin ? pin[1] : word;
          // A bare word that is still a flag's value - `-t`, `--no-cache` already filtered - or a
          // shell builtin creeping in from a compound command.
          if (!/^@?[\w.+/[\]-]+$/.test(name) || name.length > 80) continue;
          const key = `${installer}:${name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ name, version: pin ? pin[2] : null, installer, file, line: instruction.line });
        }
      }
    }
  }
  return out;
}

/** The base images a Dockerfile builds on, which is the part none of this can see inside. */
export function baseImages(source: string): string[] {
  // `FROM x AS builder` names a stage, and a later `FROM builder` refers to that stage rather than
  // to any image. The comment saying so was here from the start; the code was not, and so immich's
  // evidence pack said it was built from `builder`, `builder-${DEVICE}`, `prod-cpu`, `sdk`, `dev`,
  // `plugin-sdk` and `dev-container-server` - seven of its eighteen "base images" were its own
  // build stages. The stage names are collected first, because a stage can be referred to before
  // the line that defines it only in the sense that a reader scanning once would not know yet.
  const stages = new Set(
    [...source.matchAll(/^\s*FROM\s+\S+\s+AS\s+(\S+)/gim)].map((m) => m[1].toLowerCase()),
  );
  const out: string[] = [];
  for (const instruction of instructionsOf(source)) {
    if (instruction.keyword !== 'FROM') continue;
    const image = instruction.rest.trim().split(/\s+/)[0];
    if (!image || out.includes(image)) continue;
    // A name built out of a build argument cannot be resolved by reading the file, and `${DEVICE}`
    // in the middle of a stage name is the commonest way a stage is selected at build time.
    if (/\$/.test(image) || stages.has(image.toLowerCase())) continue;
    out.push(image);
  }
  return out;
}

export function renderImagePackages(packages: ImagePackage[], bases: string[], dockerfiles: number): string[] {
  const NL = String.fromCharCode(10);
  if (dockerfiles === 0) return [];
  const lines = ['## What the image installs, which no lockfile records', ''];
  if (packages.length === 0) {
    lines.push(`${dockerfiles} Dockerfile(s) read. None of them installs a package with apt, apk, yum, pip, a global npm or gem.`, '');
  } else {
    const unpinned = packages.filter((p) => p.version === null);
    lines.push(
      `${packages.length} package(s) installed by ${dockerfiles} Dockerfile(s), and **${unpinned.length} of them pin no version**.`,
      '',
      'A bill of materials built from a lockfile covers the application and not the operating system',
      'under it, which is where most published container vulnerabilities actually are.',
      '',
      '| package | version | installed by | where |',
      '| --- | --- | --- | --- |',
    );
    for (const p of packages.slice(0, 40)) {
      lines.push(`| \`${p.name}\` | ${p.version ?? '**not pinned**'} | ${p.installer} | ${p.file}:${p.line} |`);
    }
    if (packages.length > 40) lines.push(`| …and ${packages.length - 40} more | | | |`);
    lines.push('');
    if (unpinned.length > 0) {
      lines.push(
        'A package with no version is whatever the registry served the day the image was built, so',
        'two builds of the same commit are two different images and neither can be reproduced.',
        '',
      );
    }
  }
  if (bases.length > 0) {
    lines.push(
      '### What is already inside the base image',
      '',
      `Not read: ${bases.slice(0, 8).map((b) => `\`${b}\``).join(', ')}${bases.length > 8 ? `, and ${bases.length - 8} more` : ''}.`,
      '',
      'Whatever these already contain is not in the list above and is not in any lockfile either.',
      'Reading it needs a registry and a layer walk, which this does not do - so the list above is',
      'what the Dockerfile adds, not what the image holds.',
      '',
    );
  }
  return lines.map((l) => l).join(NL).split(NL);
}
