# Tewip for Claude Code

Two commands, and your sessions can ask Tewip whether work is actually done.

```bash
claude plugin marketplace add hmamut39/tewip-plugin
claude plugin install tewip@tewip
```

This repository holds only the plugin: a manifest, three skills, and a pointer to the published
package. Tewip itself installs from npm (`tewip-ai`) when a session first calls it.

## What it adds

- **The MCP server** — 19 tools, from "why did this test fail" to "what will this migration do to a
  live database".
- **Three skills**, which is the part that matters. They tell Claude Code *when* to reach for Tewip:
  before claiming a change is done, when a test fails, and when a change touches a migration. Until
  one is needed they cost about 410 tokens a session.

## What Tewip is

The layer that proves software work. It triages a failing test to a cause with evidence, says whether
a test could ever fail, breaks your code to find out whether the tests would notice, reads what a
migration does to a live database, and gives one verdict on whether a change is finished — and it
answers "cannot say" rather than guessing.

Source, measurements and documentation: https://www.npmjs.com/package/tewip-ai
