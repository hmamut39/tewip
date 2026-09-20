# Publishing Tewip (open-core)

Decision, 2026-09-20: **open-core**. The repository goes public under Apache-2.0, the command line
goes to npm, and the extension goes to the VS Code Marketplace, so anyone can find and install
Tewip by name. A paid team layer comes later, on top of a free core.

This file is the checklist. It says exactly what is done, what needs you, and what it costs.

---

## What it costs you when other people use it: nothing

- Every user brings their **own model key**, or runs a model on their own machine with Ollama.
  There is no Tewip server in between, so no usage passes through your account.
- **npm** and the **VS Code Marketplace** are free to publish on.
- **Public GitHub repositories** are free, and so are their Actions minutes.
- The only way you could be charged is by giving your own API key away. Never put it in the
  repository, the package, or an example. The audit below checks that.

---

## Already done (no action needed)

- [x] **Licence**: Apache-2.0 for the package and the extension (`LICENSE`, both `package.json`).
- [x] **Package is publishable**: `private: true` removed; the packed package is 66 files
      (build output plus documentation), 122 kB.
- [x] **Secret audit**: every commit in the history scanned for API keys and tokens, and for a
      committed `.env`. **Clean** — nothing found, and `.env` was never tracked.
- [x] **Names are free**: `tewip` on npm, `hmamut39.tewip` on the Marketplace.
- [x] **Works without an OpenAI account**: OpenAI, Claude, Gemini, Azure, any OpenAI-compatible
      endpoint, or a local model through Ollama.
- [x] **Documentation for newcomers**: `README.md`, `QUICKSTART.md`, `TEAM-GUIDE.md`.

---

## What needs you (about 20 minutes, both free)

### 1. An npm account — for `npm install -g tewip`

1. Create one at <https://www.npmjs.com/signup> (free).
2. Turn on two-factor authentication when it asks; npm requires it for publishing.
3. On this machine, run `npm login` and follow the browser prompt.

Then tell me, and I run `npm publish` for you. First publish claims the name `tewip`.

### 2. A Marketplace publisher — for the VS Code extension

The Marketplace is run by Microsoft, so this goes through Azure DevOps. It is free.

1. Sign in at <https://dev.azure.com> with a Microsoft account (any personal one works).
2. Create a **Personal Access Token**: click your avatar → *Security* → *New Token*.
   - Organization: **All accessible organizations**
   - Scopes: click *Show all scopes*, then **Marketplace → Manage**
   - Copy the token. It is shown once.
3. Create the publisher at <https://marketplace.visualstudio.com/manage>. Use the publisher id
   **`hmamut39`**, which is the id already in the extension.

Then give me the token (or run the command yourself) and the extension goes live as **Tewip**.

### 3. Make the repository public

GitHub → the `tewip` repository → *Settings* → scroll to *Danger Zone* → **Change visibility** →
*Make public*. Do this after the two steps above, so the links in the published package resolve.

---

## What I do once those exist

1. `npm publish` (the package builds itself through `prepack`).
2. `npx @vscode/vsce publish` for the extension.
3. Tag a release and attach both files, so people who cannot use registries still get them.
4. Update `TEAM-GUIDE.md`: installing becomes `npm install -g tewip` and a Marketplace search,
   instead of files sent by hand.
5. Add the three things a public repository needs and a private one does not: a contributing note,
   a security-reporting address, and issue templates.

---

## After publishing: where the money comes from

The free core is what earns trust and users. The paid layer is what a **team** needs and a single
engineer does not:

| Free, forever (Apache-2.0) | Paid team layer (later) |
|---|---|
| Diagnosis of every failing test, all frameworks | Shared history across repositories, kept longer than a CI cache |
| The rules, the taxonomy, the evidence | A dashboard of flakiness and quarantine across teams |
| CLI, editor extension, MCP server, GitHub Action | Single sign-on, roles, audit of every correction |
| Plans and verified test writing, with your own model key | A hosted runner, so nobody manages keys |
| Your own corrections, stored locally | Support, and an accuracy report for your own repositories |

Pricing is a later decision and should follow evidence: what teams actually ask for after using the
free core. The comparable products charge per committer per month, and the one human service in this
space (QA Wolf) reportedly charges around $90,000 a year for the triage judgement Tewip automates.

---

## Honest risks of going public

- **Published is forever.** A package version can be deprecated but not truly unpublished after
  24 hours, and the Marketplace keeps history. Nothing here is a secret, so the risk is reputational:
  the numbers in the README must stay honest and current.
- **Issues arrive from strangers.** Expect questions and bug reports. That is the point, but it is
  real work.
- **The accuracy claims will be checked.** Everything published states its dataset and its caveats,
  including that today's labels were written by an AI reviewer, not a human expert.
