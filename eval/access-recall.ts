// How much `tewip access` finds, measured against WCAG's own documented failures.
//
// The corpus pins what `access` reports on real projects and the mobile phase measured it against
// two shipped apps, which together say a great deal about precision - Google's Compose samples
// come back with zero barriers - and nothing about what it walks past.
//
// The ground truth here is the W3C's own list of **failures**: the numbered techniques WCAG
// publishes describing markup that fails a success criterion, and nothing else. Each case below is
// one of those, written as a page a team would actually commit, and labelled with the criterion
// the W3C says it fails rather than with the name of any rule in `checks.ts`. Where they agree
// that is the check being right; where they disagree the miss is real and is named.
//
// The safe half matters as much. Every barrier here is planted twice - once broken, once in the
// form the same W3C page gives as the sufficient technique - because a check that cannot tell the
// documented fix from the documented failure teaches people to switch it off.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBarriers } from '../engine/access/access-command.ts';

const NL = String.fromCharCode(10);

interface Case {
  name: string;
  /** The W3C failure or technique number, and the criterion it belongs to. */
  documented: string;
  /** Markup the W3C describes as failing. */
  broken: string;
  /** The same thing written the way the sufficient technique says. */
  fixed: string;
}

const page = (body: string) => ['<!doctype html>', '<html lang="en">', '<head><title>Orders</title></head>', `<body>${body}</body>`, '</html>'].join(NL);

const CASES: Case[] = [
  {
    name: 'image-without-alt',
    documented: 'F65, 1.1.1 Non-text Content: omitting the alt attribute on img',
    broken: '<img src="/logo.png">',
    fixed: '<img src="/logo.png" alt="Acme, back to the home page">',
  },
  {
    name: 'input-without-label',
    documented: 'F68, 1.3.1 and 4.1.2: a form control with no associated label',
    broken: '<input type="text" name="email">',
    fixed: '<label for="email">Email</label><input type="text" id="email" name="email">',
  },
  {
    name: 'select-without-label',
    documented: 'F68, 4.1.2: a select with no name a screen reader can read',
    broken: '<select name="country"><option>UK</option></select>',
    fixed: '<label for="country">Country</label><select id="country" name="country"><option>UK</option></select>',
  },
  {
    name: 'button-without-name',
    documented: 'H91, 4.1.2 Name, Role, Value: a control with no accessible name',
    broken: '<button class="icon-close"></button>',
    fixed: '<button class="icon-close" aria-label="Close this dialog"></button>',
  },
  {
    name: 'link-without-text',
    documented: 'F89, 2.4.4 Link Purpose: a link whose only content is a non-text element with no name',
    broken: '<a href="/cart"><img src="/cart.png"></a>',
    fixed: '<a href="/cart"><img src="/cart.png" alt="Your basket"></a>',
  },
  {
    name: 'click-without-keyboard',
    documented: 'F54, 2.1.1 Keyboard: a handler that responds only to a pointer',
    broken: '<div onclick="openMenu()">Menu</div>',
    fixed: '<button type="button" onclick="openMenu()">Menu</button>',
  },
  {
    name: 'positive-tabindex',
    documented: 'F44, 2.4.3 Focus Order: tabindex used to set an order',
    broken: '<input type="text" tabindex="3" aria-label="Town">',
    fixed: '<input type="text" aria-label="Town">',
  },
  {
    name: 'iframe-without-title',
    documented: 'H64, 4.1.2: an iframe with no title attribute',
    broken: '<iframe src="/help"></iframe>',
    fixed: '<iframe src="/help" title="Help and frequently asked questions"></iframe>',
  },
  {
    name: 'zoom-blocked',
    documented: '1.4.4 Resize Text: a viewport that forbids scaling',
    broken: '<meta name="viewport" content="width=device-width, user-scalable=no">',
    fixed: '<meta name="viewport" content="width=device-width, initial-scale=1">',
  },
  {
    name: 'aria-hidden-focusable',
    documented: '4.1.2: an element hidden from assistive technology that still takes focus',
    broken: '<button aria-hidden="true">Save</button>',
    fixed: '<button aria-hidden="true" tabindex="-1">Save</button>',
  },
];

/** The language of the page, which is a property of the document rather than of an element. */
const DOCUMENT_CASES: Case[] = [
  {
    name: 'no-page-language',
    documented: 'H57, 3.1.1 Language of Page: the html element has no lang',
    broken: ['<!doctype html>', '<html>', '<head><title>Orders</title></head>', '<body><p>Hello</p></body>', '</html>'].join(NL),
    fixed: page('<p>Hello</p>'),
  },
];

export interface Measured {
  name: string;
  documented: string;
  /** Rules Tewip named for the broken form. */
  onBroken: string[];
  /** Rules Tewip named for the form the W3C gives as sufficient. */
  onFixed: string[];
  noticed: boolean;
  accused: boolean;
}

function scan(body: string, whole: boolean): string[] {
  const root = mkdtempSync(join(tmpdir(), 'tewip-access-recall-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.html'), whole ? body : page(body), 'utf8');
    return findBarriers(root).findings.map((f) => f.rule);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function measure(): Measured[] {
  const judge = (c: Case, whole: boolean): Measured => {
    const onBroken = [...new Set(scan(c.broken, whole))];
    const onFixed = [...new Set(scan(c.fixed, whole))];
    return { name: c.name, documented: c.documented, onBroken, onFixed, noticed: onBroken.length > 0, accused: onFixed.length > 0 };
  };
  return [...CASES.map((c) => judge(c, false)), ...DOCUMENT_CASES.map((c) => judge(c, true))];
}

function report(): void {
  const all = measure();
  const noticed = all.filter((m) => m.noticed);
  const accused = all.filter((m) => m.accused);
  const pct = (n: number) => `${((n / all.length) * 100).toFixed(1)}%`;

  process.stdout.write(
    [
      "# access, measured against the W3C's own documented failures",
      '',
      `${all.length} failures, each one a numbered WCAG technique describing markup that fails a success`,
      'criterion, labelled with what the W3C says rather than with the name of any rule in checks.ts.',
      'Each is planted twice: once broken, once written the way the same page gives as sufficient.',
      '',
      `Noticed the documented failure:        ${noticed.length} of ${all.length} (${pct(noticed.length)})`,
      `Also accused the documented fix:       ${accused.length}`,
      '',
      '## The failures it did not notice',
      '',
      ...(all.filter((m) => !m.noticed).length === 0 ? ['None.'] : all.filter((m) => !m.noticed).map((m) => `- **${m.name}** — ${m.documented}`)),
      '',
      '## The fixes it wrongly accused',
      '',
      'This is the half that decides whether anybody keeps the check switched on. Each of these is the',
      'markup the W3C gives as the way to do it correctly.',
      '',
      ...(accused.length === 0
        ? ['None. Every documented fix came back clean.']
        : accused.map((m) => `- **${m.name}** — the sufficient technique was reported as ${m.onFixed.map((r) => `\`${r}\``).join(', ')}`)),
      '',
      '---',
      '',
      'What this does not measure: whether alt text describes the picture, whether a label says',
      'anything useful, contrast, focus order on a rendered page, or anything else that needs a',
      'browser. Those are listed in the report as not checked and no planting can settle them.',
      '',
    ].join(NL),
  );
}

if (process.argv[1]?.includes('access-recall')) report();
