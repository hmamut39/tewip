# Security

## Reporting a problem

Please report security problems privately through GitHub's
[security advisories](https://github.com/hmamut39/tewip/security/advisories/new) rather than in a
public issue. You will get an answer within a few days.

## What Tewip does with your data

- **Without a model configured, nothing leaves your machine.** The deterministic rules run locally.
- **With a hosted model** (OpenAI, Anthropic, Google, Azure), Tewip sends the failure text — the
  error message and the test name — of failures its rules could not settle, to that provider only.
- **`tewip plan` and `tewip write` send more**: the feature description, your test names, and the
  test and source files most related to the feature. Use them where your company allows an AI
  service to read source code.
- **With `TEWIP_PROVIDER=ollama`**, the model runs on your own machine and nothing leaves it.
- Tewip keeps its history and its model-answer cache in a `.tewip` folder inside your project.
  Add `.tewip/` to `.gitignore`.

## What Tewip will not do

- It never edits application code: only test files, and only inside the directory you allow.
- It never merges anything. Fixes are opened as a pull request.
- It never sends your API key anywhere except to the provider you configured.
- Its shadow-run reports (Tewip reading another project's public CI) refuse to publish to a public
  repository.

## Running it on someone else's code

Tewip runs test commands from your project (`npx playwright test`, `pytest`, `ng test`, …) to verify
what it writes. Run it only on repositories you trust, as you would any test suite.
