# Using Tewip in your team

**Tewip reads your failing tests and tells you why each one failed** — a real bug, a flaky test, a
broken environment, bad test data, or a renamed element on the page — with the evidence for each
answer and one next step. It also writes test plans and new tests, and checks them by running them.

It works with any language and any test framework, because it reads the test report your CI already
produces (JUnit XML, which almost every runner can write) — Java, .NET, Python, JavaScript and
TypeScript, Go, Ruby, PHP, Rust, and the browser and mobile tools on top of them.

---

## 1. How to get it

Tewip is published on the npm registry, free and open source (Apache-2.0):

```bash
npm install -g tewip-ai
tewip --help
```

The package is called `tewip-ai`; the command you type is `tewip`.

Nothing else is needed: no account with anyone, no licence key, and nothing of yours is sent to the
author. The source is at <https://github.com/hmamut39/tewip>, so a company that needs to own the
tool can keep its own copy instead.

---

## 2. What you need on your machine

- **Node.js 22.18 or newer** (`node --version`). This is the only hard requirement.
- **A model** — *optional, and it does not have to be OpenAI*. Without any model, Tewip still works:
  its built-in rules answer most failures on their own. With one, the harder failures get an answer
  too, and `plan` and `write` become available. Pick whichever your company already allows:

  | You have | Set this |
  |---|---|
  | OpenAI | `TEWIP_API_KEY=sk-...` |
  | Claude (Anthropic) | `TEWIP_PROVIDER=anthropic` and `TEWIP_API_KEY=...` |
  | Gemini (Google) | `TEWIP_PROVIDER=google` and `TEWIP_API_KEY=...` |
  | Azure OpenAI | `TEWIP_PROVIDER=azure`, `TEWIP_BASE_URL=<your deployment URL>`, `TEWIP_API_KEY=...` |
  | **Nothing, and no account** | `TEWIP_PROVIDER=ollama` — install [Ollama](https://ollama.com), run `ollama pull qwen3:8b`. The model runs on your own machine and no data leaves it |
  | OpenRouter, Groq, Together, vLLM, LM Studio | `TEWIP_PROVIDER=custom`, `TEWIP_BASE_URL=...`, `TEWIP_API_KEY=...` |

  Each person (or CI job) pays for their own model usage. There is no Tewip service in between and
  no account with anyone to create.
- **The GitHub CLI (`gh`), logged in** — only for `tewip ci`, which fetches a report from GitHub.

### Privacy, in plain words

This matters for a company laptop, so it is stated exactly:

- Without a model, **Tewip sends nothing anywhere**. It runs entirely on your machine. The same is
  true with `TEWIP_PROVIDER=ollama`, which runs the model locally.
- With a hosted model (OpenAI, Claude, Gemini, Azure), it sends only the **failure text** (the error
  message and the test name) of the failures its rules could not settle, to that provider and
  nowhere else. It never sends your source code.
- `tewip plan` and `tewip write` do send more: the feature description you type, the names of your
  tests, and the related test and source files, because they cannot write a useful test without
  them. Use these two only where your company allows an AI service to read source code.
- Tewip stores its history in a `.tewip` folder inside your project. Add `.tewip/` to `.gitignore`.

---

## 3. Install

### The command line (works everywhere: any OS, any CI, any company)

```bash
npm install -g tewip-ai
tewip --help          # check it worked
```

### VS Code, Cursor, Windsurf or VSCodium

1. Open the Extensions panel.
2. Search for **Tewip** and install it.
   (Until the Marketplace listing is live, use the `.vsix` file instead: `…` menu → **Install from VSIX…**)

You now have two commands (press `Ctrl+Shift+P` and type "Tewip"):

- **Tewip: Explain a test report…** — pick a test report file, get the diagnosis.
- **Tewip: Why did CI fail on this branch?** — reads the report from your GitHub CI run.

The extension also connects Tewip to your editor's AI assistant, so you can just ask it questions
in plain language ("why did the checkout test fail?").

### JetBrains (IntelliJ, WebStorm, PyCharm, Rider), Claude, or any other AI assistant

Add one MCP server entry. The command is `tewip mcp`. Example for Claude Code:

```bash
claude mcp add tewip -- tewip mcp
```

### GitHub CI

```yaml
      - name: Tewip
        if: always()
        uses: hmamut39/tewip@main       # option C: point this at your own copy
        with:
          junit-report: report.xml      # a file, or a folder of them
          openai-api-key: ${{ secrets.OPENAI_API_KEY }}   # optional
```

On every failing run it comments on the pull request, writes the triage board into the run summary,
collects environment failures in one issue, and (optionally) opens a fix pull request.

---

## 4. What you can actually do with it

| Command | What it does | When you use it |
|---|---|---|
| `tewip explain report.xml` | Explains every failing test in a report: cause, confidence, evidence, next step | Right after a test run fails, local or CI |
| `tewip explain job.log` | Reads a CI job log when the job died before any test ran, and names the cause (image pull, disk, container, runner) | "CI is red but there are no test results" |
| `tewip ci owner/repo --pr 12` | The same, for a GitHub pull request, without leaving the terminal | "Why is CI red on my PR?" |
| `tewip plan "<feature>"` | Writes a test plan: risks, scenarios by priority, what is already covered, what to automate next | Before building or testing a feature |
| `tewip write` | Turns the plan's scenarios into real tests in your own framework, and keeps only the ones that pass repeatedly **and** fail when their check is broken on purpose | When you know what to test but not how to write it |
| `tewip plan --issue PROJ-123` | Plans from the Jira ticket itself: its description and acceptance criteria | "Here's the story, what should we test?" |
| `tewip jira plan.json --project PROJ` | Files the plan's scenarios as test-case tickets, linked to the story | Handing work to the team |
| `tewip fix --code report.xml` | Opt-in: proposes the smallest change to application code for a real bug, and keeps it only if the failing test passes and the whole suite still passes | "It is a real bug and I want a starting patch" |
| `tewip design <figma link> --url <page>` | Compares a Figma frame against the running page: the words the design specifies and the controls its layer names imply | "Did we build what was designed?" |
| `tewip mcp` | Serves all of the above to your editor's AI assistant | Set up once |

Notes that save you time:

- `explain` needs a report file. Any runner can write one: `pytest --junitxml=report.xml`,
  `jest --reporters=jest-junit`, `mvn test` (Surefire writes them by itself), `dotnet test --logger trx`.
- `write` never touches your application code. It only adds new test files, and you review and
  commit them yourself.
- Everything it writes locally goes to the `.tewip` folder in your project.
- `tewip jira` shows what it *would* file and creates nothing until you add `--create`. It never
  files the same scenario twice, and never moves, assigns or closes a ticket.
- `tewip design` needs a Figma read token (`TEWIP_FIGMA_TOKEN`), or a frame saved as JSON if you
  would rather not create one. It compares words, controls and page regions - never pixels, colours
  or spacing, because a design tool and a browser do not measure those the same way.

---

## 5. Which role uses which part

**Developer** — "is this failure my fault?"
- `tewip ci your-org/repo --pr 12`, or the editor command *Why did CI fail on this branch?*
- In CI, the pull request comment tells you which failures your change likely caused and which it
  did not, with the reason.

**QA engineer / SDET** — the daily driver
- `tewip explain` for the triage board: every failing test grouped by what to do next (fix the
  locator, stabilise the test, fix the data, file a bug, re-run the environment).
- `tewip plan` before writing tests for a feature, then `tewip write` to draft them.
- Correct it when it is wrong: reply to its pull-request comment with `/triage TIMING #2 flaky on CI`.
  It remembers that and answers with your decision next time, naming you.

**DevOps / SRE** — "is the pipeline broken, or the code?"
- Environment failures (a service that was down, a refused connection, a container that never
  started, a missing emulator) are collected in **one** issue instead of paging you per test.
- The merge gate (`gate: real-failures`) blocks a merge only for real failures, and lets known
  noise through — so a broken test environment does not stop the team.

**Engineering manager / team lead**
- The release readiness view, in plain words: READY, WAIT or NOT READY, and which product areas are
  broken.
- The risk digest: which areas got worse between the first and second half of the period.

**Software architect / principal engineer**
- The architecture view: fragile areas, single commits that broke many suites, failing service
  dependencies.
- The quality view: flakiness hotspots and test-design debt, ranked by the CI time they waste.

**Designer, and the developer building from a design**
- `tewip design <figma link> --url http://localhost:3000` after building a screen: it lists what the
  design says and what the page says, side by side, so a renamed button or a dropped sentence is
  found before review.

**Security** — planned, not built yet (`tewip secure`, Phase 9 in ROADMAP.md).

Managers, architects and leads do not need to install anything: those views are produced by the CI
job and kept in a GitHub issue, or can be asked for through an AI assistant.

---

## 6. What Tewip will never do

These are enforced in the code, not promises in a document:

- It **never edits your application code** unless you run `tewip fix --code` yourself. Even then it
  changes nothing it cannot prove: the failing test must pass and the whole suite must still pass,
  or your file goes back exactly as it was. It will not edit tests, configuration, CI files,
  lockfiles or migrations at all.
- It **never merges anything**. Fixes are opened as a pull request for a person to review.
- It **never keeps a test it has not proved**: a written test is kept only if it passed every run
  and failed when its main check was deliberately broken.
- It **never reports a bug it cannot show you**: a "possible bug" must quote the real output of the
  run.
- It **never silently accepts a report it cannot read**. It says so, instead of reporting "no
  failures" for a run that failed.

---

## 7. What it costs

The built-in rules are free and answer most failures. Only what they cannot settle goes to the AI
model, and every answer is cached, so asking twice costs nothing. Every run prints its own cost.

Measured examples: a run of 41 real failures cost about 30 seconds of model time; writing 10 tests
for a feature costs roughly $0.50 to $1.50 in OpenAI usage.

---

## 8. How good is it, honestly

On six sets of real failures from public projects (WordPress Gutenberg, Supabase, JupyterLab and
others), Tewip's answers were right **86% to 99.7%** of the time, depending on the project.

Two caveats the project states openly:

- Those labels were written by an AI reviewer, not by a human expert, so treat them as provisional.
- When Tewip says it is 70% sure, it is right about 90% of the time — it is *under*-confident, which
  is the safer direction, but it means it sometimes asks for a human where it did not need to.

The full numbers, including what is **not** measured yet, are in `eval/README.md` and `ROADMAP.md`.

---

## 9. If something goes wrong

| What you see | What it means |
|---|---|
| `tewip: command not found` | The npm install did not finish, or your PATH does not include npm's global folder |
| `no test report Tewip can read` | The file is not JUnit XML, NUnit or TRX. Make your runner write JUnit XML |
| `writing a plan needs a model` | `plan` and `write` need a model: the message lists every way to set one up |
| `Playwright is not installed in this project` | Only affects reading live pages for `plan`/`write`; everything else still works |
| Tewip says a failure is UNKNOWN | It refuses to guess. With an API key set, fewer failures end up here |

Questions, or you think a diagnosis is wrong: tell Hasan — a wrong answer with its evidence is the
most useful thing you can send, because corrections are how it gets better.
