// Phase 28: accessibility. What is being tested here is mostly restraint.
//
// Finding a picture with no alt attribute is the easy half and every linter does it. The half that
// decides whether a team keeps the check switched on is the other one: an alt written as an
// expression is not a missing alt, a button whose text comes from a child component cannot be
// called empty, fifty icons in one file do not share a document, and a backdrop div in a dialog
// that closes on Escape is not a keyboard trap. Each of those was a false positive this scanner
// produced against excalidraw before it was fixed, and each has a test here so it cannot come back.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { JS_LIKE, MARKUP, tags } from '../access/markup.ts';
import { checkFile } from '../access/checks.ts';
import { findBarriers, keyOf, readAccepted, renderAccess, runAccess } from '../access/access-command.ts';
import { NOT_CHECKED, RULES } from '../access/wcag.ts';

const NL = String.fromCharCode(10);

/** Findings for one piece of markup, as the command would read it. */
function check(source: string, file = 'page.tsx') {
  return checkFile(source, tags(source, JS_LIKE.test(file)), file, /\.html?$/.test(file));
}

const rules = (source: string, file?: string) => check(source, file).map((f) => f.rule).sort();
const confidenceOf = (source: string, rule: string, file?: string) =>
  check(source, file).find((f) => f.rule === rule)?.confidence;

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tewip-a11y-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
  }
  return root;
}

describe('what the markup can prove', () => {
  it('an image with no alt attribute at all is a barrier', () => {
    assert.equal(confidenceOf('<img src="cat.png">', 'image-alt'), 'barrier');
  });

  it('alt="" is a decision, not an omission', () => {
    assert.deepEqual(rules('<img src="line.png" alt="">'), []);
  });

  it('a field with no label anywhere is a barrier, and a placeholder is not a label', () => {
    assert.equal(confidenceOf('<input type="text" placeholder="Search">', 'input-label'), 'barrier');
  });

  it('a label wrapping the field is enough', () => {
    assert.deepEqual(rules('<label>Name <input type="text"></label>'), []);
  });

  it('a label pointing at the field by id is enough', () => {
    assert.deepEqual(rules('<label for="n">Name</label><input id="n" type="text">'), []);
  });

  it('a div that only answers to a mouse is a barrier', () => {
    assert.equal(confidenceOf('<div onClick={go}>Go</div>', 'click-without-keyboard'), 'barrier');
  });

  it('positive tabindex, blocked zoom, autoplaying sound and a misspelled aria attribute are all named', () => {
    assert.deepEqual(rules('<div tabindex="3">x</div>'), ['positive-tabindex']);
    assert.deepEqual(rules('<meta name="viewport" content="width=device-width, user-scalable=no">'), ['zoom-blocked']);
    assert.deepEqual(rules('<video autoplay src="a.mp4"></video>'), ['autoplay-sound']);
    assert.deepEqual(rules('<div aria-lable="Close">x</div>'), ['aria-unknown']);
  });

  it('something hidden from screen readers but still in the tab order is a barrier', () => {
    assert.deepEqual(rules('<a href="/x" aria-hidden="true">Hidden</a>').includes('aria-hidden-focusable'), true);
  });

  it('every rule it reports carries a WCAG criterion and says who it stops', () => {
    for (const [name, rule] of Object.entries(RULES)) {
      assert.match(rule.criterion, /^\d\.\d/, `${name} has no criterion number`);
      assert.ok(rule.stops.length > 10, `${name} does not say who it stops`);
    }
  });
});

describe('what it refuses to decide', () => {
  it('an alt written as an expression is not a missing alt', () => {
    assert.deepEqual(rules('<img src={src} alt={caption} />'), []);
  });

  it('an element carrying a spread is asked about, never accused', () => {
    assert.equal(confidenceOf('<img src="a.png" {...props} />', 'image-alt'), 'ask-a-person');
  });

  it('a button whose text comes from a component cannot be called empty', () => {
    assert.equal(confidenceOf('<button onClick={f}><Icon /></button>', 'button-name'), 'ask-a-person');
  });

  it('a button whose text is an expression cannot be called empty', () => {
    assert.equal(confidenceOf('<button>{label}</button>', 'button-name'), 'ask-a-person');
  });

  it('a button with real text inside it is not reported at all', () => {
    assert.deepEqual(rules('<button onClick={f}>Save</button>'), []);
  });

  it('an icon button with an aria-label is not reported', () => {
    assert.deepEqual(rules('<button aria-label="Close" onClick={f}><Icon /></button>'), []);
  });

  it('a link holding an image with alt text is named by it', () => {
    assert.deepEqual(rules('<a href="/home"><img src="logo.png" alt="Home"></a>'), []);
  });
});

describe('the false positives real projects produced', () => {
  // excalidraw AI.tsx: an entire HTML error page inside a template literal, reported as a page
  // with no lang attribute. Markup inside a JS string is not this component's markup.
  it('ignores markup inside a template literal in a .tsx file', () => {
    const source = ['const page = `<html>', '  <body><img src="x.png"></body>', '</html>`;'].join(NL);
    assert.deepEqual(rules(source, 'AI.tsx'), []);
  });

  // excalidraw App.tsx: /<!doctype html|<html[\s>]/i read as an <html> element.
  it('does not read a regex literal as a tag', () => {
    assert.deepEqual(rules('const re = /<!doctype html|<html[\\s>]/i;', 'App.tsx'), []);
  });

  // excalidraw icons.tsx: fifty SVG icons, each with its own clipPath id="a".
  it('repeated ids are a defect in one document and not across components in one file', () => {
    const source = '<svg><clipPath id="a" /></svg><svg><clipPath id="a" /></svg>';
    assert.deepEqual(rules(source, 'icons.tsx'), [], 'component file');
    assert.deepEqual(rules(source, 'page.html'), ['duplicate-id'], 'one document');
  });

  // excalidraw ViewportStatusFrame.tsx: greedy attribute matching ate the slash of `<button />`,
  // so the element stayed open and its sibling looked nested inside it.
  it('a self-closing JSX element is closed, so the next control is a sibling', () => {
    const source = '<div><button onClick={a} aria-label="One" /><button onClick={b} aria-label="Two" /></div>';
    assert.deepEqual(rules(source), []);
  });

  // vitepress VPFlyout.vue and VPLocalSearchBox.vue: eight buttons labelled with Vue's `:aria-label`
  // and `:title` bindings, every one of them reported as having no accessible name.
  it('a bound attribute is the same attribute, in every dialect', () => {
    for (const written of [':aria-label="label"', 'v-bind:aria-label="label"', '[attr.aria-label]="label"']) {
      assert.equal(confidenceOf(`<button ${written} @click="go"><span/></button>`, 'button-name'), 'ask-a-person', written);
    }
  });

  it('a bound title names a button too, rather than leaving it accused', () => {
    assert.equal(confidenceOf('<button :title="t(\'close\')" type="reset"></button>', 'button-name'), 'ask-a-person');
  });

  // vitepress VPSwitch.vue: a button whose content is a <slot />, filled by whoever uses it.
  it('a slot is content this file cannot see, so the control is asked about', () => {
    assert.equal(confidenceOf('<button role="switch"><span><slot /></span></button>', 'button-name'), 'ask-a-person');
  });

  // vitepress VPNavBarAskAiButton.vue: an icon-only button whose only child is aria-hidden. This
  // one is a real barrier and must stay one - a screen reader announces "button" and stops.
  it('an icon-only button with its icon hidden and no label is still a barrier', () => {
    assert.equal(
      confidenceOf('<button type="button"><span class="icon" aria-hidden="true"></span></button>', 'button-name'),
      'barrier',
    );
  });

  // excalidraw Modal.tsx: a backdrop div closing on click, inside a dialog that handles Escape.
  it('a click target inside something that handles keys is not a keyboard barrier', () => {
    const source = '<div role="dialog" onKeyDown={esc}><div className="backdrop" onClick={close} /></div>';
    assert.deepEqual(rules(source), []);
  });

  it('but the same div with no key handler anywhere above it still is one', () => {
    const source = '<div role="dialog"><div className="backdrop" onClick={close} /></div>';
    assert.deepEqual(rules(source), ['click-without-keyboard']);
  });
});

describe('the report', () => {
  it('always says what it did not check, even when it found nothing', () => {
    const report = renderAccess({ barriers: [], questions: [], accepted: [], filesRead: 3 }, '/p');
    assert.match(report, /What was not checked/);
    for (const n of NOT_CHECKED) assert.ok(report.includes(n.criterion), `${n.criterion} missing`);
  });

  it('never claims a page is accessible', () => {
    const report = renderAccess({ barriers: [], questions: [], accepted: [], filesRead: 3 }, '/p');
    assert.ok(!/\bis accessible\b/.test(report.replace(/not that the product is accessible/, '')));
    assert.match(report, /means these checks found nothing, not that the product is accessible/);
  });

  it('reads a project, and honours a finding a person already accepted', () => {
    const root = project({ 'index.html': '<html lang="en"><body><img src="a.png"></body></html>' });
    const first = findBarriers(root);
    assert.equal(first.findings.length, 1);
    assert.equal(first.findings[0].rule, 'image-alt');

    mkdirSync(join(root, '.tewip'), { recursive: true });
    writeFileSync(join(root, '.tewip', 'access-accepted.txt'), `${keyOf(first.findings[0])} - decorative, confirmed with the designer`, 'utf8');
    assert.ok(readAccepted(root).has(keyOf(first.findings[0])));

    const result = runAccess({ root });
    assert.equal(result.barriers.length, 0);
    assert.equal(result.accepted.length, 1);
  });

  it('markup written for a test is not a barrier to anybody', () => {
    const root = project({ 'src/__tests__/a.test.tsx': '<img src="a.png">', 'src/App.tsx': '<img src="b.png">' });
    const { findings } = findBarriers(root);
    assert.deepEqual(findings.map((f) => f.file), ['src/App.tsx']);
  });
});

// Phase 37: the server-rendered templates. Laravel's Blade, Symfony's Twig, Django and Flask's
// Jinja, .NET's Razor, Angular, Handlebars and the rest - which between them are most of the web's
// actual HTML, and none of which `access` would even open.
//
// The shapes below come from laravel/laravel's welcome.blade.php, symfony/demo's blog index and
// Django's own technical_404.html. The happy discovery was that the reader already handled
// `{{ ... }}` correctly - a brace expression is a value it cannot read, exactly like JSX's - so
// most of this phase was recognising the file at all. These tests pin that it stays true.
describe('server-rendered templates', () => {
  const rules = (source: string, file: string) => check(source, file).map((f) => f.rule).sort();

  it('opens the template languages at all', () => {
    for (const file of ['welcome.blade.php', 'index.html.twig', 'page.jinja2', 'page.j2', 'View.cshtml', 'Page.razor', 'card.hbs', 'list.njk', 'row.liquid', 'item.ejs']) {
      assert.equal(MARKUP.test(file), true, file);
    }
  });

  it('a value the template fills in is a value, not a missing one', () => {
    // alt="{{ $alt }}" is an alt attribute. Reporting it as missing would condemn every
    // well-written template in Laravel, Django and Symfony.
    assert.deepEqual(rules('<img src="/a.png" alt="{{ $caption }}">', 'a.blade.php'), []);
    assert.deepEqual(rules('<img src="/a.png" alt="{{ caption }}">', 'a.html.twig'), []);
    assert.deepEqual(rules('<input type="text" aria-label="{{ form.label }}">', 'a.jinja2'), []);
  });

  it('a button whose text the template fills in is asked about, not accused', () => {
    assert.equal(confidenceOf('<button>{{ $label }}</button>', 'button-name', 'a.blade.php'), 'ask-a-person');
    assert.equal(confidenceOf('<button>{% trans "Save" %}</button>', 'button-name', 'a.html.twig'), 'ask-a-person');
  });

  it('but a template that really leaves it out is still caught', () => {
    assert.equal(confidenceOf('<img src="{{ $photo }}">', 'image-alt', 'a.blade.php'), 'barrier');
    assert.equal(confidenceOf('<input type="text" placeholder="{{ hint }}">', 'input-label', 'a.html.twig'), 'barrier');
  });

  it('reads a real Laravel and a real Django page without inventing anything', () => {
    const blade = '<html lang="{{ str_replace(\'_\', \'-\', app()->getLocale()) }}">\n<body>\n@if (Route::has(\'login\'))\n<a href="{{ url(\'/dashboard\') }}">Dashboard</a>\n@endif\n</body>\n</html>';
    assert.deepEqual(rules(blade, 'welcome.blade.php'), []);
    const django = '<html lang="en">\n<body>\n{% if reason %}<pre>{{ reason }}</pre>{% endif %}\n<table><tr><td>{{ request.path }}</td></tr></table>\n</body>\n</html>';
    assert.deepEqual(rules(django, 'technical_404.html'), []);
  });
});
