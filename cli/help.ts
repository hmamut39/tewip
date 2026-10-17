// The text `tewip --help` prints. It lives on its own because it is prose, not logic, and it grows
// every time a verb is added - which would otherwise push the command file past the size any of
// these files are allowed to be.
export const HELP = `Tewip - finds why each test failed, for any stack.

Usage:
  tewip                             Look at this project and name the two or three commands that
  tewip start                       will tell you something about it, with your own paths in them,
                                    and say plainly what Tewip cannot answer here. Reads the
                                    directory and stops: nothing is run and nothing is written.
                                    Start here. Everything below is the full list.
  tewip explain <report>            Explain a test report: a JUnit XML or .trx file, a folder of
                                    them, or a Playwright blob-report folder. Keeps history per
                                    project, so later runs are judged against earlier ones.
      --name <project>              Keep this project's history apart from others.
  tewip ci <owner/repo> [--pr N | --branch B]
                                    Show the latest report Tewip's GitHub Action uploaded (uses
                                    your gh login). Without --pr or --branch: the newest run.
  tewip plan "<feature>" | --issue PROJ-123 [--diff main...HEAD] [--url <page> ...] [--out plan.md]
                                    Write a test plan grounded in the project: its existing tests,
                                    the change, the live pages and Tewip's failure history.
  tewip write [--plan plan.json] [--only LS-002,LS-003] [--framework playwright] [--runs 3]
                                    Write tests for the plan's scenarios in the project's own
                                    framework (Playwright, Cypress, WebdriverIO, Jest, Vitest,
                                    pytest, JUnit, .NET, Go). Keeps a test only if it passes every
                                    run and fails when its check is broken on purpose.
      --move-to <folder>            Move kept tests there afterwards, leaving the project as it was.
      --mutate-source               Also change the code under test and check the test notices
                                    (unit tests only; needs the project's own mutation tool).
  tewip jira <plan.json> --project PROJ [--issue PROJ-123] [--create]
                                    File the plan's scenarios as test-case issues, linked to the
                                    story. Shows what it would create; --create actually files
                                    them, and the same scenario is never filed twice.
      --export xray|zephyr          Write the cases as a CSV for Xray or Zephyr Scale instead.
                                    No account needed; importing stays your step.
  tewip bugs <report> --project PROJ [--create] [--max 5]
                                    File a bug ticket for each failure Tewip diagnosed as a real
                                    bug, with its evidence and run link. A flaky test or a broken
                                    environment is deliberately not filed, and the same failure is
                                    never filed twice.
  tewip secure [--url http://localhost:3000] [--secrets-only] [--gate] [--out security.md]
                                    Runs the scanners this project already has (npm audit,
                                    pip-audit, osv-scanner) plus Tewip's own secret scan, then says
                                    which findings need someone now and which are noise or not
                                    reachable. No model, no cost, and it never prints a credential.
      --url <page>                  Also check the running app: security headers, cookie flags, and
                                    files that must never be served (.env, .git). Ordinary requests
                                    only. An address that is not this machine needs
                                    --i-am-authorised.
      --zap-report zap.json         Triage the findings of an OWASP ZAP baseline scan as well.
  tewip spec "<feature>" [--diff main...HEAD] [--url <page> ...] [--project PROJ] [--create]
                                    An epic, its user stories and their acceptance criteria, from
                                    this project's code, tests and failure history. Anything it
                                    says the system already does is quoted from a file it read;
                                    what it cannot quote becomes an open question. With --project it
                                    shows what it would file in Jira; --create files it.
  tewip report <report> [--gate] [--out report.md] [--name <project>] [--no-post]
                                    The CI command for any platform: GitLab CI, Jenkins, CircleCI,
                                    Azure, Bitbucket, Travis, Drone. Diagnoses the run, comments on
                                    the GitLab merge request, tells Slack or Teams only when a
                                    failure needs a person, and with --gate fails the build only on
                                    those failures.
  tewip build "<what it should do>" | --issue PROJ-123 [--dry-run] [--pr] [--out feature.patch]
                                    Writes a feature, test first: the test must fail without the
                                    code and pass with it, and every test that was passing must
                                    still pass - otherwise everything goes back byte for byte.
      --issue PROJ-123              Build from the ticket itself: its description and acceptance
                                    criteria. Works with a public tracker without an account.
      --pr                          Commit the proved work on a branch of its own and open a draft
                                    pull request. Never merges, never commits to your branch.
  tewip review [--diff main...HEAD] [--out review.md]
                                    Before anyone reads the diff: which tests cover this change,
                                    which of them have flaked before, what has gone wrong in these
                                    areas, what nothing tests at all, and the command that runs the
                                    telling tests first. From this project's own history, so it
                                    costs nothing.
  tewip watch [--cmd "npm test"] [--report <path>] [--paths src,tests]
                                    Beside your editor: runs your tests when a file changes (or
                                    watches for new reports) and explains each failure as it
                                    happens, without CI.
  tewip flaky [--days 30] [--apply] [--name <project>] [--out flaky.md]
                                    Which tests are wasting the team's time, how much CI time they
                                    cost, and what to do with each: quarantine, fix, or watch. Read
                                    from runs already diagnosed, so it costs nothing. --apply puts
                                    the quarantine line in the test file with the evidence above it.
  tewip note [--days 7] [--name <project>] [--out note.md] [--post]
                                    The weekly quality note for a lead, written from the runs Tewip
                                    already diagnosed. No model calls, so it costs nothing.
  tewip fix --code <report> [--only "<test title>"] [--max 3] [--apply] [--suite "<command>"]
                                    Opt-in: for failures diagnosed as a real bug, propose the
                                    smallest change to application code, and keep it only if the
                                    failing test then passes AND the whole suite still passes. The
                                    change is written as a patch; nothing is committed or merged.
  tewip design <figma link | frame.json> [--url <page>] [--frame "<name>"] [--out drift.md]
                                    Compare a Figma frame against the running page: the words the
                                    design specifies and the controls its layer names imply. Says
                                    "the design says X, the page says Y". No model, no cost.
  tewip correct <kind> "<what>" <verdict> ["why"] | --list
                                    Tell Tewip it was wrong, about anything it decides: a diagnosis,
                                    a flaky verdict, a security finding, a design difference, a
                                    refused build. It answers with your decision from then on, and
                                    says it was yours. It never acts on a correction by itself.
  tewip learn [--name <project>] [--labels labels.jsonl] [--out learn.md]
                                    What your corrections add up to: where Tewip is wrong in the
                                    same way more than once, which rule decided it, and the failures
                                    it came from. Says "not yet" rather than inventing a pattern
                                    from two cases. No model, no cost.
  tewip pursue "<a goal>" [--act] [--out next.md]
                                    Give Tewip a goal instead of a verb - "keep the checkout flow
                                    green" - and it says what it would do next and why, from what
                                    it can actually see. The order is fixed and written down: a
                                    real bug first, then the environment, then flakiness, then a
                                    test that cannot fail, then a coverage gap. It decides; it does
                                    not act unless you ask. With
                                    --act it carries out the two safe ones - writing a missing test,
                                    or attesting a green goal - by running the command that already
                                    proves them. It will not touch a real bug, and it writes what it
                                    did or refused to .tewip/actions.jsonl.
  tewip done [--diff main...HEAD] [--prove] [--strict] [--out done.md] [--json done.json]
                                    Is this work actually done? One verdict, from the layers that each
                                    have a measured accuracy: is anything failing, is the changed code
                                    tested, can those tests fail, would they catch a bug (--prove), and
                                    is what was asked for covered. Answers ready, not ready, or cannot
                                    say - and cannot say is never rounded up to ready. --json writes a
                                    sealed verdict that can be checked later. No model, no cost.
  tewip perf <k6.json | lighthouse.json | run.jtl> [--against before.jtl] [--record] [--strict]
                                    Is this change slower, and does it matter? Reads a k6 run (what
                                    the server does under load) or a Lighthouse report (what one
                                    page load costs in a browser) or a JMeter .jtl, and answers two
                                    questions apart:
                                    is anything in a bad state now - from the thresholds you wrote,
                                    or from Lighthouse's own scoring, never a budget Tewip invented
                                    - and is this slower than it was. The second only from repeated
                                    baselines: with fewer than three it says cannot say, because one
                                    run against one cannot tell a regression from a busy machine.
                                    --record adds a run to the baseline, and is deliberately not
                                    automatic: a regression recorded by accident becomes next week's
                                    normal. A .jtl is different and better: it carries every request,
                                    so --against before.jtl compares the two distributions with a
                                    real test rather than a range check - and refuses a difference
                                    that is certain but too small to act on. No cost.
  tewip access [<file or directory>] [--report axe.json|lighthouse.json] [--strict]
                                    Can everybody use this? Reads your markup and names the barriers
                                    that reading alone can prove - a picture with no alt text, a field
                                    with no label, a div only a mouse can use - each against its WCAG
                                    2.2 criterion, which is what a regulator asks for. What only a
                                    person can settle is kept apart from what is proved, and every
                                    criterion it cannot reach without rendering the page (contrast,
                                    focus order, whether the alt text is any good) is printed every
                                    time. It never says a page is accessible, only what was checked.
                                    Give it --report with the JSON from an axe run or a Lighthouse
                                    report and it reads that too - Lighthouse runs axe rules, so
                                    either works. Contrast moves out of the unchecked list, rules
                                    that map to no WCAG criterion are reported as advice rather than
                                    barriers (51 of 174 findings on nine real pages run through axe;
                                    a Lighthouse report runs a WCAG-aligned subset and produced 2 of
                                    363 on six real pages, so expect little advice from one), and what the
                                    tool could not determine becomes a question. Lighthouse's ten
                                    manual checks are questions too, never passes. No model, no cost.
  tewip standards [--diff main...HEAD] [--strict] [--out standards.md]
                                    Teach Tewip your house rules. Markdown files in
                                    .tewip/standards/ - a forbid or require line is checked and
                                    enforced on the files a change touches; the prose below it is
                                    guidance Tewip carries into whatever it writes or fixes. It never
                                    reports guidance as verified, because a rule nobody enforces is
                                    worse than no rule. No model, no cost.
  tewip schema [<files>] [--diff main...HEAD] [--strict] [--out schema.md]
                                    What will this migration do to a live database? Names the changes
                                    that break the version still running during a deploy, destroy data,
                                    block writes while they run, or cannot be undone - and searches your
                                    code for what still uses the column it takes away. Reads SQL,
                                    Django, Rails, Alembic, TypeORM, Sequelize, Knex, Laravel, EF Core and
                                    Liquibase - so Prisma, Drizzle, Flyway and golang-migrate too,
                                    since those emit plain SQL - and says so when it cannot read one.
                                    It judges only the forward path, never the rollback. No cost.
  tewip pick [--diff main...HEAD] [--list] [--out picked.md]
                                    Which tests could notice this change? Narrows a test run using
                                    facts rather than a prediction: a test runs when it imports a
                                    changed file or reaches one through another module, when the change
                                    edits the test itself, or when it failed recently - an unknown is
                                    never a skip. It runs the whole suite when the change touches
                                    dependencies, build or test configuration, shared setup or
                                    fixtures, or when a changed file cannot be traced to any test.
                                    --list prints the files for piping. No model, no cost.
  tewip prove <file> [--diff main...HEAD] [--limit 6] [--budget 600] [--strict]
                                    What would your tests NOT catch? Breaks your code in small,
                                    deliberate ways - a boundary moved by one, a condition inverted,
                                    an and that became an or - runs the tests that import that file,
                                    and reports every change nobody noticed. The line was covered; it
                                    was not checked, and no coverage number can tell you that. Every
                                    file is put back exactly as it was. Slow by nature, and it needs
                                    a unit test framework. No model, no cost.
  tewip vouch [<paths>] [--strict] [--out vouch.md] [--json vouch.json]
                                    Could these tests ever fail? Reads tests somebody else wrote -
                                    an agent, a contractor, last year's team - and names the ones
                                    that check nothing, compare a value with itself, leave an
                                    expectation unfinished, swallow their own failure, or never run.
                                    Where the checking is in a helper it cannot follow it says so
                                    instead of accusing. Reads JavaScript, TypeScript, Python, Java,
                                    Kotlin, Scala, Go, C#, Ruby, PHP and Rust. --strict exits
                                    non-zero on a finding, for a gate. No model, no cost.
  tewip trace [--only "<ticket or title>"] [--out trace.md]
                                    Is this requirement covered, and is it passing right now? Joins
                                    the plans Tewip wrote to the tests that cover them and the runs
                                    that attempted them. A scenario counts as covered only when a
                                    real test can be named, and passing only when a real run
                                    attempted it. No model, no cost.
  tewip recall "<an error, or a question>" [--test "<id>"] [--limit 5]
                                    What this project already concluded: earlier failures that look
                                    like this one, what was decided, by which rule or which person,
                                    and the run each came from. Searches the history Tewip keeps -
                                    no model, no network, nothing to set up.
  tewip incident <sentry.json | otel.json | stack.txt> [--framework <id>] [--out incident.md]
                                    Turn a production incident into a test that proves it: reads
                                    Sentry, OpenTelemetry or a pasted stack trace, writes a test
                                    against the code the trace names, runs it, and keeps it ONLY if
                                    it fails for the incident's own reason. A test that passes, or
                                    fails its own way, is reported and thrown away.
  tewip attest [--run <id>] [--out attestation.md] [--json bundle.json]
  tewip attest --verify <bundle.json> [--key <public.pem>]
                                    What Tewip checked for a build, as one artifact: the claims with
                                    their evidence and which layer decided each, what it refused to
                                    decide and why, and what it did not check at all. Nothing enters
                                    it that Tewip did not verify itself. Every bundle carries a
                                    digest; set TEWIP_ATTEST_KEY to an ed25519 private key to sign
                                    it too. --verify says what it checked and what that does not
                                    establish - a digest means undamaged, not unedited. No cost.
  tewip mcp                         Serve Tewip over MCP (stdio) for an editor or AI assistant.
  tewip a2a [--port 41241] [--host 127.0.0.1]
                                    Answer other agents over A2A, so an agent that writes a diff has
                                    a peer it must satisfy. Serves the agent card at
                                    /.well-known/agent-card.json and takes JSON-RPC "SendMessage".
                                    Only the read-only skills are reachable - nothing it exposes
                                    writes a file - it listens on this machine alone unless you pass
                                    --host, and every request is recorded in .tewip/a2a.jsonl. A
                                    message it cannot place comes back as a question, not a guess.
  tewip --version                   Print the version.

Reports it reads: Playwright, pytest/unittest, Jest, Vitest, Mocha, node:test, JUnit/TestNG
(Maven, Gradle), Go (gotestsum), .NET (TRX or JUnit), NUnit 3, RSpec, PHPUnit, Rust (nextest),
Robot Framework (output.xml), JMeter (.jtl) and k6 (--summary-export). Appium, Selenium and
WebdriverIO suites report through one of the above, and their own error messages are understood.
Set OPENAI_API_KEY to let the AI layer decide what the rules leave open.`;
