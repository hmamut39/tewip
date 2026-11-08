// The four questions a buyer asks, each answered from one check's own output.
//
// Every section here follows the same discipline, and it is the discipline the whole pack is for:
// a check that refused prints the refusal in place of the answer. Not a zero, not an omission - the
// sentence "this was not established, and here is why". `answer()` is the only way a section gets
// its content, so there is no path through this file that turns silence into a clean result.
import { IRREVERSIBLE } from '../agent/tools.ts';
import { NEEDS_A_LOOK } from '../sbom/licences.ts';
import type { Evidence, Part } from './gather.ts';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A section's body, or the reason there is none.
 *
 * The refusal wording is deliberately blunt. An auditor reading "not established" knows where they
 * stand; one reading an empty section concludes there was nothing to find, which is the single
 * failure mode a signed document must not have.
 */
export function answer<T>(part: Part<T>, body: (result: T) => string[]): string[] {
  if (part.refused !== undefined || part.result === undefined) {
    return [
      `**Not established.** ${part.refused ?? 'this check produced no result'}.`,
      '',
      'Nothing here should be read as a clean result for it.',
      '',
    ];
  }
  return body(part.result);
}

export function whatShips(e: Evidence): string[] {
  const lines = ['## 1. What ships', ''];
  lines.push(
    ...answer(e.ships, (inv) => {
      const shipped = inv.components.filter((c) => !c.dev);
      const flagged = inv.components.filter((c) => NEEDS_A_LOOK.includes(c.licence.standing));
      const out = [
        `Read from ${inv.read.join(', ') || 'no manifest at all'}. ` +
          (inv.components.some((c) => !c.devKnown)
            ? // Not "all 2,705 ship with the product", which is what counting an unread field as
              // false came out as on immich. The lockfile does not say, so neither does this.
              'Which of them are needed only to build or test is **not recorded** by that lockfile, so this pack does not divide them.'
            : `${shipped.length} of them ship with the product, and ${inv.components.length - shipped.length} are needed only to build or test it.`),
        '',
      ];
      if (inv.components.length === 0) out.push('An empty bill of materials is not a short one. The gaps listed at the end are the whole answer here.', '');
      if (flagged.length === 0) out.push('No licence needs a decision from a person, among those Tewip could read.', '');
      else {
        out.push(`**${plural(flagged.length, 'package')} need a person to look** — a strong copyleft licence, one that is not open source, or none stated:`, '');
        for (const c of flagged.slice(0, 10)) out.push(`- \`${c.name}@${c.version}\` — ${c.licence.declared}: ${c.licence.means}`);
        if (flagged.length > 10) out.push(`- …and ${flagged.length - 10} more`);
        out.push('', 'Tewip does not say whether these are acceptable. That depends on how you ship, and it is a question for a lawyer.', '');
      }
      return out;
    }),
  );
  lines.push(
    ...answer(e.image, (img) => {
      if (img.dockerfiles === 0) return ['No Dockerfile was found, so nothing is claimed about a container image.', ''];
      return [
        '### What the container adds on top of the code',
        '',
        img.bases.length === 0
          ? `${plural(img.dockerfiles, 'Dockerfile')}, built from a base Tewip could not read.`
          : `${plural(img.dockerfiles, 'Dockerfile')}, built from:`,
        '',
        ...img.bases.map((b) => `- \`${b}\``),
        ...(img.bases.length > 0 ? [''] : []),
        img.packages.length === 0
          ? 'No operating-system or language package is installed by any `RUN` instruction Tewip could read.'
          : `${plural(img.packages.length, 'package')} are installed into the image by \`RUN\` instructions, on top of whatever the base image already contains. **The base image’s own contents are not in this list** — reading them needs the built image, not the Dockerfile.`,
        '',
      ];
    }),
  );
  return lines;
}

export function whatItMayDo(e: Evidence): string[] {
  const lines = ['## 2. What it is allowed to do', ''];
  lines.push(
    ...answer(e.agent, (scan) => {
      if (scan.tools.length === 0 && scan.config.read.length === 0) {
        return [`No agent tool and no coding-agent configuration were found in ${plural(scan.filesRead, 'file')}. On this evidence the project gives no model the ability to act.`, ''];
      }
      const out: string[] = [];
      const reaching = scan.tools.filter((t) => IRREVERSIBLE.includes(t.reach));
      out.push(`${plural(scan.tools.length, 'tool')} are declared for a model to call, read from ${plural(scan.filesRead, 'file')}.`, '');
      if (reaching.length > 0) {
        out.push(`**${plural(reaching.length, 'tool')} can do something that cannot be taken back** — delete, pay, send, or run code:`, '');
        for (const t of reaching.slice(0, 10)) out.push(`- \`${t.name}\` (${t.reach}) — ${t.file}:${t.line}, decided by “${t.why}”`);
        if (reaching.length > 10) out.push(`- …and ${reaching.length - 10} more`);
        out.push('');
      }
      const has = (c: 'untrusted-input' | 'private-data' | 'can-send-out') => scan.tools.some((t) => t.capabilities.includes(c));
      if (has('untrusted-input') && has('private-data') && has('can-send-out')) {
        out.push(
          '**All three legs of the lethal trifecta are present**: a tool that reads text somebody outside can write, a tool that reads private data, and a tool that can send data out. ' +
            'Whether one model holds all three at once is a question about the running graph, which reading files cannot answer.',
          '',
        );
      }
      if (scan.injections.length > 0) {
        out.push(`${plural(scan.injections.length, 'place')} glue text from outside directly into a prompt:`, '');
        for (const f of scan.injections.slice(0, 6)) {
          out.push(`- ${f.file}:${f.line} — ${f.origin}, via ${f.through}${f.withTools ? ', **in a body that also hands the model tools**' : ''}`);
        }
        out.push('');
      }
      const kinds = [...new Set(scan.guards.map((g) => g.kind))];
      out.push(
        kinds.length === 0
          ? // The strongest sentence in the pack, and the only categorical negative in it, so it
            // names the shapes it looked for. A reader can then tell this from the other reason a
            // check falls silent - that it could not read the gate in front of it. Those shapes
            // are measured at 14 of 14 by eval/guard-recall.ts; before that harness existed this
            // sentence was printed on the strength of nothing at all, and the reader had no way
            // to know. Nine of those fourteen were invisible at the time it was written.
            '**Nothing anywhere in this project asks a person anything, declares a step ceiling, or draws its tools from a named list** — ' +
            'on the shapes LangGraph, CrewAI, the OpenAI Agents SDK and the Vercel AI SDK publish, in both the Python and JavaScript form of each. ' +
            'Where a tool can delete or pay, that is not a maybe.'
          : `Guards present somewhere in the project: ${kinds.map((k) => `\`${k}\``).join(', ')}. That a gate exists here is not a claim that it stands in front of any particular tool — that depends on the running graph.`,
        '',
      );
      if (scan.emptyBudget) out.push(`**A step ceiling is written down and set to nothing**: \`${scan.emptyBudget.text}\` in ${scan.emptyBudget.file}. That reads as deliberate.`, '');
      if (scan.config.read.length > 0) {
        out.push(
          `The installed coding agent is configured by ${scan.config.read.join(', ')}: ` +
            `${scan.config.hasAllowList ? 'an allow-list is set' : 'no allow-list is set'}, ` +
            `${scan.config.hasEnforcedHook ? 'and a hook runs on every tool call' : 'and no hook is enforced on tool calls'}. ` +
            `${plural(scan.config.servers.length, 'MCP server')} configured.`,
          '',
        );
      }
      return out;
    }),
  );
  lines.push(
    ...answer(e.infra, (iac) => {
      const read = iac.dockerfiles + iac.composeFiles + iac.terraformFiles + iac.manifests;
      const out = ['### What the infrastructure permits', ''];
      if (read === 0) {
        out.push('No Dockerfile, Compose file, Terraform or Kubernetes manifest was found.', '');
        return out;
      }
      const ships = iac.findings.filter((f) => f.ships);
      out.push(
        `${plural(read, 'infrastructure file')} read. ` +
          (ships.length === 0
            ? 'Nothing in what ships widens what the running system is permitted to do.'
            : `**${plural(ships.length, 'finding')} in files that ship**:`),
        '',
      );
      for (const f of ships.slice(0, 10)) out.push(`- ${f.file}:${f.line} (${f.risk}) — ${f.what}. ${f.because}`);
      if (ships.length > 10) out.push(`- …and ${ships.length - 10} more`);
      if (iac.findings.length > ships.length) {
        out.push('', `${iac.findings.length - ships.length} further finding(s) are in files that do not ship; \`tewip infra\` lists them.`);
      }
      out.push('');
      return out;
    }),
  );
  lines.push(
    ...answer(e.access, (acc) => {
      const barriers = acc.findings.filter((f) => f.confidence === 'barrier');
      return [
        '### Who can use it',
        '',
        barriers.length === 0
          ? `No barrier was found in ${plural(acc.filesRead, 'markup file')}, on what the markup alone can settle. Contrast, focus order and whether alt text is any good need a rendered page and are not claimed here.`
          : `**${plural(barriers.length, 'barrier')}** in ${plural(acc.filesRead, 'markup file')} — somebody using a screen reader or a keyboard cannot complete something here. Rules hit: ${[...new Set(barriers.map((b) => b.rule))].slice(0, 8).join(', ')}.`,
        '',
      ];
    }),
  );
  return lines;
}

export function whatWouldBreak(e: Evidence): string[] {
  const lines = ['## 3. What breaks if this ships', ''];
  lines.push(
    ...answer(e.schema, (migrations) => {
      if (migrations.length === 0) return ['No database migration was found.', ''];
      const serious = migrations.flatMap((m) => m.findings.filter((f) => f.risk !== 'fine' && f.risk !== 'slow').map((f) => ({ m, f })));
      const out = [
        `${plural(migrations.length, 'migration')} read. ` +
          (serious.length === 0
            ? 'None of them breaks the version still running, destroys data, blocks writes, or cannot be undone.'
            : `**${plural(serious.length, 'statement')} will break something**:`),
        '',
      ];
      for (const { m, f } of serious.slice(0, 10)) out.push(`- ${m.file}:${f.line} (${f.risk}) — ${f.what}${f.instead ? ` Instead: ${f.instead}` : ''}`);
      if (serious.length > 10) out.push(`- …and ${serious.length - 10} more`);
      const unread = migrations.filter((m) => m.unread);
      if (unread.length > 0) out.push('', `${plural(unread.length, 'migration')} could not be read: ${unread[0].unread}. A gap, not a clean result.`);
      out.push('');
      return out;
    }),
  );
  lines.push(
    ...answer(e.contracts, (scan) => {
      const out = ['### Published interfaces', ''];
      if (scan.checked === 0 && scan.isNew.length === 0) {
        out.push('No API description was found, so nothing is claimed about a contract with anybody’s client.', '');
        return out;
      }
      const broken = scan.files.filter((f) => f.breaks.length > 0);
      const unreadable = scan.files.filter((f) => f.unreadable);
      out.push(
        `${plural(scan.checked, 'API description')} compared against \`${scan.since}\`. ` +
          (broken.length === 0
            ? 'Nothing somebody else’s client depends on was removed, narrowed or made mandatory.'
            : `**${plural(broken.reduce((n, f) => n + f.breaks.length, 0), 'breaking change')}**:`),
        '',
      );
      for (const f of broken.slice(0, 6)) for (const b of f.breaks.slice(0, 4)) out.push(`- ${f.file} — ${b.what}`);
      if (scan.isNew.length > 0) out.push('', `${plural(scan.isNew.length, 'description')} are new, with no previous version to compare against.`);
      if (unreadable.length > 0) out.push('', `${plural(unreadable.length, 'description')} could not be read: ${unreadable[0].unreadable}. Not a clean comparison.`);
      out.push('');
      return out;
    }),
  );
  lines.push(
    ...answer(e.secrets, (items) => {
      const real = items.filter((i) => i.verdict === 'real-risk');
      const out = ['### Credentials', ''];
      out.push(
        real.length === 0
          ? `No live credential was found.${items.length > 0 ? ` ${plural(items.length, 'candidate')} were examined and set aside as unreachable, noise, or already judged by a person.` : ''}`
          : `**${plural(real.length, 'credential')} ${real.length === 1 ? 'is' : 'are'} committed and reachable**:`,
        '',
      );
      // A secret is located, never quoted: the pack says where it is and what kind, and a reader
      // with access to the repository can look. Printing the value would publish it again, in a
      // document whose whole purpose is to be passed around.
      for (const i of real.slice(0, 10)) out.push(`- ${i.where} (${i.severity}) — ${i.title}. ${i.why}`);
      if (real.length > 10) out.push(`- …and ${real.length - 10} more`);
      out.push('', 'No credential value appears anywhere in this document, by design: a secret is located, never printed.', '');
      return out;
    }),
  );
  return lines;
}

export function whoApproved(e: Evidence): string[] {
  const lines = ['## 4. Who approved it', ''];
  lines.push(
    ...answer(e.approvals, (audit) => {
      if (audit.entries.length === 0) {
        return [
          'No audit log exists here, so **this pack cannot say who ran anything**. Set `TEWIP_AUDIT=1` and every run is recorded, each entry hashed over the one before it.',
          '',
        ];
      }
      const people = [...new Set(audit.entries.map((x) => x.who))];
      const out = [
        `${plural(audit.entries.length, 'run')} recorded, by ${people.slice(0, 6).map((p) => `\`${p}\``).join(', ')}${people.length > 6 ? ` and ${people.length - 6} more` : ''}, ` +
          `between ${audit.entries[0].at} and ${audit.entries[audit.entries.length - 1].at}.`,
        '',
      ];
      const intact = audit.edited.length === 0 && audit.broken.length === 0 && audit.unreadable.length === 0;
      out.push(
        intact
          ? 'Each entry hashes over the one before it and the chain is unbroken: no recorded run was changed or removed after the fact.'
          : `**The chain is broken**, so the log cannot be relied on: ${[
              audit.edited.length > 0 ? `${plural(audit.edited.length, 'entry', 'entries')} no longer match their own hash` : '',
              audit.broken.length > 0 ? `${plural(audit.broken.length, 'entry', 'entries')} follow a gap where something was removed` : '',
              audit.unreadable.length > 0 ? `${plural(audit.unreadable.length, 'entry', 'entries')} could not be read` : '',
            ]
              .filter(Boolean)
              .join('; ')}. Lines ${[...audit.edited, ...audit.broken, ...audit.unreadable].sort((a, b) => a - b).slice(0, 12).join(', ')}.`,
        '',
      );
      return out;
    }),
  );
  lines.push(
    ...answer(e.accepted, (accepted) => [
      accepted.length === 0
        ? 'No finding has been recorded as judged by a person. Tewip can see an approval only where somebody wrote one down, in `.tewip/security-accepted.txt` or the accessibility equivalent; a decision taken in a meeting is invisible here.'
        : `${plural(accepted.length, 'finding')} were recorded as judged by a person, and are excluded from the counts above: ${accepted.slice(0, 8).map((a) => `\`${a}\``).join(', ')}${accepted.length > 8 ? ', …' : ''}.`,
      '',
    ]),
  );
  return lines;
}
