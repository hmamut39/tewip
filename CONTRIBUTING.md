# Contributing to Tewip

Thanks for looking. Tewip has one rule above all others: **a claim needs evidence**.

## The bar for a change

- **Rules and readers** must be checked against real failure messages, not invented ones. There are
  several thousand collected from public issues; add yours with its source URL.
- **A change that affects diagnosis must be measured.** Run the evaluations (`npm run eval`,
  `eval:holdout`, `eval:fresh`) and put the before and after numbers in the pull request. Model
  sampling moves the score by about one case per 150; smaller differences are noise.
- **No guessing.** A rule that cannot tell returns nothing and says why, rather than picking a
  category. "UNKNOWN with a reason" beats a confident wrong answer.
- **Keep every file under 300 lines**, and write comments that explain *why*, not *what*.

## Getting started

```bash
npm install
npm run typecheck
npm run test:engine      # unit tests, no network
```

Real evaluation data is not in the repository (it is other projects' CI output); the harvester in
`eval/harvest/` collects it from public runs.

## Where things live

| Folder | What it is |
|---|---|
| `engine/` | The rules, the readers for each tool's error wording, the model layer |
| `engine/quality/` | `tewip plan` and `tewip write` |
| `ci/` | The GitHub Action: comments, issues, the merge gate, corrections |
| `outlets/` | The views each role sees |
| `mcp/`, `cli/`, `extensions/vscode/` | The surfaces people use it through |
| `eval/` | Datasets, labels and the accuracy report |

`ROADMAP.md` says what is built, what is measured, and what is deliberately not done yet.
