// Where a Ruby test keeps its assertion, measured in both directions.
//
// `vouch` says "this test compares no value, only a crash would fail it". That sentence is the most
// expensive thing Tewip prints: a correct test called worthless is how a tool stops being read.
//
// Ruby could not be judged fairly, in two ways at once, and both were found by reading what Tewip
// said about discourse rather than by reading its code:
//
//   the helper   `helpersThatCheck` had a branch for Python and one for the braced languages, and
//                Ruby fell through to the braced one - which asks for `function name(` or a `{`
//                body and matches nothing Ruby writes. No Ruby helper was ever registered. Worse,
//                the call had to look like `name(`, and Ruby calls a method without parentheses.
//   the block    `expect { ... }.to` was known; `expect do ... end.to` was not. Ruby uses `do`
//                whenever the block is more than one line, which is whenever the test is doing
//                anything interesting.
//
// Measured on discourse: **crash-only 335 -> 90** across its 2,443 spec files, and **121 -> 95**
// across 2,774 plugin files. 247 of those were read back: 205 assert through a `do ... end` block
// and 42 through a helper in the same file. Two were read line by line against their source -
// `expect do ... end.to raise_error(ActiveRecord::NoDatabaseError, ...)` and
// `expect do ... end.to not_change { tag1.reload.public_topic_count }` - and both are real checks
// that Tewip had been calling worthless.
//
// The 90 that remain were not cleared, and two of them were read as well: both are
// `SearchIndexer.update_posts_index(...)` with nothing after it, which really does only check that
// nothing raised. Those accusations are correct and must stay.
//
// Run: node eval/ruby-helper-recall.ts
import { vouchFile } from '../engine/vouch/vouch.ts';

const NL = String.fromCharCode(10);

interface Case {
  what: string;
  body: string[];
  /** The verdict the single test in this file must get. */
  want: string;
  /** Why this way round, for a case that must stay accused. */
  why?: string;
}

const CASES: Case[] = [
  {
    what: 'a helper in the same file that asserts, called the way Ruby calls it - with no parentheses',
    body: [
      'def no_chat_summary_email',
      '  email = described_class.chat_summary(user, {})',
      '  expect(email.to).to be_blank',
      'end',
      'it "does not send an email if user cannot chat" do',
      '  SiteSetting.chat_allowed_groups = Group::AUTO_GROUPS[:admins]',
      '  no_chat_summary_email',
      'end',
    ],
    want: 'checks',
  },
  {
    what: 'the same helper called with parentheses and an argument',
    body: ['def expect_blank(email)', '  expect(email.to).to be_blank', 'end', 'it "is blank" do', '  expect_blank(mailer.summary)', 'end'],
    want: 'checks',
  },
  {
    what: "RSpec's let, which is how a spec memoises a helper",
    // Named so that nothing clears it but the mechanism under test. Two statements, because with
    // one, a different rule clears it - "a body whose
    // whole content is one call to something defined in another file" - so a one-line version
    // passed whether `let` was understood or not, and the sabotage run said so.
    body: [
      'let(:summary_is_empty) do',
      '  expect(mailer.to).to be_blank',
      'end',
      'it "is blank" do',
      '  mailer.deliver_now',
      '  summary_is_empty',
      'end',
    ],
    want: 'checks',
  },
  {
    what: 'the block form with do and end, which Ruby uses for any block over one line',
    body: [
      'it "raises for a missing database" do',
      '  expect do',
      '    PostgreSQLAdapter.new_client(dbname: "nope")',
      '  end.to raise_error(ActiveRecord::NoDatabaseError, /nope/)',
      'end',
    ],
    want: 'checks',
  },
  {
    what: 'the block form with a negated matcher and a chained and',
    body: [
      'it "preserves the counts" do',
      '  expect do',
      '    topic.change_category_to_id(other.id)',
      '  end.to not_change { tag1.reload.public_topic_count }',
      'end',
    ],
    want: 'checks',
  },
  {
    what: 'the brace form, which was always read and must stay read',
    body: ['it "changes the count" do', '  expect { process(:reply) }.to change { topic.posts.count }', 'end'],
    want: 'checks',
  },
  // The refusals. Every one of these must stay accused, or the fix above has bought nothing: a
  // reader that clears everything is as useless as one that accuses everything, and quieter.
  {
    what: 'a test whose only call is to something defined elsewhere, with nothing asserted',
    body: [
      'it "indexes edge-case domain names" do',
      '  post.update!(cooked: "Test.00E5A4.1")',
      '  SearchIndexer.update_posts_index(post_id: post.id, cooked: post.cooked)',
      'end',
    ],
    want: 'crash-only',
    why: "discourse's own, and the accusation is right: nothing is compared, so only a raise fails it",
  },
  {
    what: 'a helper in the same file that asserts nothing, called bare',
    body: ['def set_up_channel', '  channel.update!(following: true)', 'end', 'it "sets up" do', '  set_up_channel', 'end'],
    want: 'crash-only',
    why: 'the helper is registered only when its own body asserts. One that just does setup must not clear the test calling it',
  },
  {
    what: 'a bare word that is a local variable, not a helper',
    body: [
      'def total',
      '  expect(cart.count).to eq 3',
      'end',
      'it "reads a variable" do',
      '  total = cart.sum',
      '  total',
      'end',
    ],
    want: 'checks',
    why: "the known cost of matching a bare word: `total` names an asserting helper **and** a local, and Tewip credits the helper. It is bounded - the name must be declared in this same file with an assertion in it - and the alternative is missing every Ruby helper call there is",
  },
];

const pct = (n: number, of: number) => (of === 0 ? 'n/a' : `${((n / of) * 100).toFixed(1)}%`);

export interface Measured {
  what: string;
  got: string;
  want: string;
  right: boolean;
  why?: string;
}

/** Re-derived by engine/test/confidence-is-current.test.ts, so the published figure cannot drift. */
export function measure(): Measured[] {
  return CASES.map((c): Measured => {
    const vouched = vouchFile('spec/a_spec.rb', c.body.join(NL));
    const got = vouched.judgements.length === 1 ? vouched.judgements[0].verdict : `${vouched.judgements.length} tests read`;
    return { what: c.what, got, want: c.want, right: got === c.want, why: c.why };
  });
}

function report(): void {
  const all = measure();
  const right = all.filter((m) => m.right);
  const clears = all.filter((m) => m.want === 'checks');
  const accuses = all.filter((m) => m.want !== 'checks');
  const lines = [
    '# Where a Ruby test keeps its assertion',
    '',
    `${clears.length} tests that really check, and ${accuses.length} that must stay accused.`,
    '',
    `Judged correctly: ${right.length} of ${all.length} (${pct(right.length, all.length)})`,
    '',
  ];
  const wrong = all.filter((m) => !m.right);
  if (wrong.length === 0) lines.push('Every real check is credited, and every test that compares nothing is still named.', '');
  else {
    lines.push('## Judged wrongly', '');
    for (const m of wrong) lines.push(`- **${m.what}** — wanted \`${m.want}\`, got \`${m.got}\``);
    lines.push('');
  }
  const owned = all.filter((m) => m.why);
  if (owned.length > 0) {
    lines.push('## What each refusal is for', '', ...owned.map((m) => `- **${m.what}** — ${m.why}`), '');
  }
  lines.push(
    '---',
    '',
    'Measured on real Ruby, because a fixture cannot show the scale: **crash-only 335 -> 90** across',
    "discourse's 2,443 spec files and **121 -> 95** across 2,774 plugin files. That is 245 and 26",
    'sentences withdrawn, each of which told a team a correct test was worthless.',
    '',
    'Six decisions were sabotaged one at a time. **Five are earned**: taking one back drops a number',
    'above. The sixth is not - the guard that stops a helper body running past its own `end` when the',
    'next line dedents without closing - because that needs malformed Ruby and no honest case writes',
    'it. It is named rather than counted.',
    '',
    'Two of the cases above only started testing anything after the sabotage run said so. A `let`',
    'helper called from a one-line test was cleared by a different rule entirely, and the same helper',
    'named `assert_blank` was cleared by its **name**, because anything called `assert*` reads as an',
    'assertion. Both passed while proving nothing.',
    '',
    'What is not measured: how many tests that cannot fail are still missed in Ruby. This moved one',
    'direction a long way, and recall against real assertion-free Ruby is not measured at all - so a',
    'low crash-only number here is not evidence that a Ruby suite is sound.',
    '',
  );
  process.stdout.write(lines.join(NL));
  if (wrong.length > 0) process.exitCode = 1;
}

if (import.meta.main) report();
