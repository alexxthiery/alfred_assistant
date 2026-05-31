# Alfred — design philosophy

The *why* behind the rules. `AGENTS.md` tells you the operational dos and don'ts; this file is the reasoning they flow from. When a new feature or refactor makes you choose, choose the way that keeps these principles true. When two principles pull against each other, the earlier one usually wins.

## 1. The CLI is the only writer

`wiki/*.md` is never created or edited except through `bin/wiki`. The CLI enforces schema validation, autolink, the post-write audit, and the auto-commit. A direct edit (an `Edit`, a shell redirect, a hand-tweak) bypasses every one of those and leaves the vault inconsistent in ways nothing will catch until much later.

Enforced by: `AGENTS.md` hard rule 1; `tamperCheck` flags out-of-band edits on the next write.

## 2. Zero runtime dependencies

Node stdlib only. No `npm install` of anything that lands in production code. Every dependency is another thing that can break the tool, and another party whose interests can diverge from yours. The few external executables we shell out to (`git`, `duckdb`, `curl`) are optional or host-level, never bundled libraries.

Enforced by: `AGENTS.md` hard rule 2; review.

## 3. The vault outlives the tool

Pages are plain markdown in a git repo. They are readable and editable by a human with no special software. If `bin/wiki` disappeared tomorrow, the data is fully intact and usable. Never move the source of truth into a cache, an index, or a binary format. Derived artifacts (the DuckDB snapshot, the index) are always rebuildable from the markdown, never the other way around.

Ask of any new storage decision: *if the CLI vanished, is the data still there in plain form?*

## 4. Small blast radius

One write, one commit, scoped to `wiki/` and `raw/`. Any single mistake is one `wiki revert` away. The failures you cause yourself (a bad ingest, a wrong edit) are both the most common and the most controllable, so the design bounds them: no batch writes, no sweeping `git add -A`, reversible moves preferred over irreversible ones.

Enforced by: per-write auto-commit; `wiki revert`.

## 5. Fail to a safe state

A write lands on disk *before* the best-effort commit runs. If git is missing or the commit fails, the verb prints a loud stderr block but never crashes and never loses the write. Survival never depends on the recovery machinery working at the worst possible moment. The same instinct shows up in staged-write atomicity: a crash mid-ingest leaves the vault untouched, not half-written.

Enforced by: `autoCommit` in `bin/lib/page-io.js` (write-then-commit, caught failure); `flushStaged` in `bin/lib/staged-writes.js`.

## 6. The schema is the contract

Tags, page types, and relation verbs are a closed set, parsed from `SCHEMA.md` at runtime. There is one source of truth and one parser. Adding a tag is a one-line edit to `SCHEMA.md`; the CLI picks it up with no code change. Hardcoding a closed-set value at a call site is the anti-pattern.

Enforced by: `loadSchema()` in `bin/lib/schema.js`; `wiki persona-lint` cross-checks docs against it.

## 7. Thin entrypoint, pure core

`bin/wiki` only parses argv and dispatches. Verb logic lives in `bin/commands/<group>.js`; pure, reusable logic lives in `bin/lib/*.js` and is unit-tested. This keeps coupling low (a broken command module can't sink an unrelated verb), keeps the token cost of any one task small (open the verb's module, not a 5,000-line file), and makes the shared logic testable in isolation.

Enforced by: the module layout; `tests/unit/dispatch-parity.test.js`.

## 8. Drift guards over good intentions

An unexercised safeguard quietly rots; a rule that lives only in a human's head is already half-broken. So invariants become automated checks that fail loudly when violated: `persona-lint` (doc-vs-dispatch verb drift), `dispatch-parity` and `verb-metadata` tests (handler/help/write-class drift), `persona-template` tests (fragment/aggregate drift), `preflight` (environment and dependencies), `jobs --check` (schedule drift). If a rule matters, write the check that catches its violation.

Rule of thumb: *a capability you don't exercise is a claim, not a fact.*

## 9. Determinism where you can, agents where you must

The daily brief is a pure function of vault state: byte-identical output for identical input, no LLM in the loop. Only genuinely synthesis-shaped work (the weekly review) puts an agent in the path. Fewer moving parts mean fewer surprises and easier debugging, so reach for an agent only when the task actually needs judgment.

Enforced by: `bin/daily-brief` (deterministic) vs the agent-driven weekly routine.

## 10. Provider-agnostic

`AGENTS.md` is the conventional, tool-neutral orientation any coding agent reads first; `CLAUDE.md` is a one-line import so Claude Code resolves to the same place. The runtime persona is likewise a generic template, maintained as provider-neutral fragments and rendered into the vault's `AGENTS.md`. Nothing in the core assumes a specific model or vendor.

Enforced by: `AGENTS.md` + the `CLAUDE.md` import stub; `docs/persona/*.template.md`; `docs/PERSONA.template.md`.

## 11. Surgical changes

Touch only what the task needs. No speculative abstractions, no flexibility nobody asked for, no drive-by refactors of code that already works. Three similar lines beat a premature abstraction. Every changed line should trace to the task at hand. The codebase stays small because each change earns its place.

---

These are not aspirations bolted on after the fact; they are why the code looks the way it does. A change that quietly violates one of them is a regression even if every test passes.
