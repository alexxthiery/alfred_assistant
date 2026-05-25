<!-- TODO before public release:
  1. Replace <your-username> placeholders below with your actual GitHub handle.
  2. Fill in <nanoclaw-maintainer> with the upstream attribution.
  (Author email already scrubbed from history; commits use a GitHub noreply address.)
-->


# Alfred Assistant

A typed-graph personal-knowledge CLI, plus an agent persona that drives it.

The foundation is **`bin/wiki`** — a standalone, zero-dependency CLI that turns a folder of markdown into a versioned, schema-enforced graph. Drive it by hand, or point an **LLM agent ("Alfred")** at it. Alfred runs on whatever agent runtime you like — a terminal session (Claude Code or Codex) or an always-on Telegram bot (nanoclaw) — all reading one shared persona and the same vault. Verbs (`wiki ingest`, `wiki patch`, `wiki review`, …) do the writing; never markdown by hand.

> This repository contains the CLI, schema, persona, runtime adapters, and tests.
> The CLI works standalone; an agent is optional. To run the agent, pick a runtime in [`integrations/`](integrations/) — Claude Code or Codex (a terminal, the lightest setup) or [nanoclaw](https://github.com/<your-username>/nanoclaw) (an always-on Telegram bot).
> The vault content (your `wiki/*.md`, `raw/*`) lives outside this repo, on your machine.

## Philosophy

Three commitments separate this from a note-taking app.

**A typed graph, not a folder of notes.** Every page is one atomic thing: a concept, a person, an event, a claim. Knowledge lives in *typed relations between atomic pages* (`parent_of`, `colleague_of`, `works_at`, `advisor_of`, ...), not in prose that groups things together. The graph is queryable (a DuckDB view), navigable (`wiki path`, `wiki related`), and self-maintaining (inverse and symmetric relations auto-close on write, so adding `A parent_of B` lands `B child_of A` automatically).

**Epistemic discipline.** A claim is not a fact. Observations are tagged by epistemic status: `[fact]`, `[opinion]`, `[hypothesis]`, `[prediction]` (with `[by <date>]` and `[confidence: N]`), `[decision]`, `[question]`. Every observation carries provenance (`^[telegram:...]`, `^[web:...]`) and a stable id, so months later you can ask "what did I predict, and was I right?" or "which of my beliefs rest on weak evidence?" The vault is a calibration instrument, not just storage.

**An intellectual companion, not a stenographer.** The default failure mode of an LLM is confirmation-reinforcement: read your opinion, mirror it back, deepen the prior. Alfred is built to resist that. He searches the vault before answering, surfaces the strongest objection (`wiki challenge`), finds connections you cannot see (`wiki related --unconnected`, `wiki unlinked-mentions`), and flags when a new proposal contradicts a principle you recorded earlier. The point is a partner that pushes back, not a mirror that agrees.

The engineering value enforced throughout: simple and robust beats clever, and best is the enemy of good. The CLI owns the invariants; the agent owns the judgment; neither is trusted to do the other's job.

## Status

Early. The author runs Alfred daily; the design is stable; the published code is what's actually used in production with PII redacted.
Open issues welcome. Breaking changes will be noted in `CHANGELOG.md`.

## Architecture (one paragraph)

`raw/` (immutable source archive) → `wiki/` (assistant-maintained typed graph, one concept per page) → `SCHEMA.md` (the contract).
The CLI is runtime-agnostic: drive it from a terminal, or let an agent runtime drive it (nanoclaw / Claude Code / Codex — see [`integrations/`](integrations/)), all reading one shared persona (`AGENTS.md` in the vault).
All writes go through `bin/wiki`, which enforces schema, microsyntax, provenance, autolink, and audit invariants. That "go through the CLI" rule is enforced at the git layer by `wiki`'s tamper-check — it refuses to operate while the vault has out-of-band edits — so it holds on every runtime regardless of hook support (runtimes with hooks, like nanoclaw and Claude Code, add a friendlier early block).
Auto-commit on every write turns the vault into a git-versioned, revertable knowledge base.

## What it does (feature map)

The capability surface, with a pointer to the detailed doc for each. This is the index, not the manual.

- **Typed-graph CLI (`wiki`):** create, read, link, and query atomic pages. Verbs include `ingest`, `patch`, `write`, `merge`, `search` (DuckDB BM25 + synonym expansion), `related`, `path`, `context`, `timeline`, `sql`. The contract (page types, tags, microsyntax, the SQL view) lives in [`docs/SCHEMA.md`](docs/SCHEMA.md).
- **Capture pipeline (`wiki capture`):** turn a one-line utterance into a classified, provenance-stamped observation on the right page. `--today` / `--on YYYY-MM-DD` stamp activity dates; `wiki day [YYYY-MM-DD]` lists what you did on a day.
- **Reminders and calendar:** `wiki todo` (dated with `--due`, or undated backlog), `type=event` pages surfaced by `wiki agenda`, and birthdays via a `born:` field. A **timed reminder** is a todo with `--remind_at <ISO>` (and `--notify`): the vault is the single source of truth, so one write covers both channels — the morning brief surfaces it on its due date, and a deterministic dispatcher (`bin/reminder-dispatch`, run by a host cron) pushes it to Telegram at the set time and stamps it (idempotent, no duplicates). See [`docs/REMINDERS.md`](docs/REMINDERS.md) and [`docs/TELEGRAM.md`](docs/TELEGRAM.md).
- **Daily morning brief (`bin/daily-brief`):** a deterministic 07:00 email listing overdue todos, due-today todos, today's events, and today's birthdays. Composed by a script, not the agent, so it cannot drift or hallucinate. See [`docs/DAILY-BRIEF.md`](docs/DAILY-BRIEF.md).
- **Weekly digest:** a Monday discovery-and-quality email (promotion candidates, missing edges, audit offenders, stale markers). See [`docs/WEEKLY-DIGEST.md`](docs/WEEKLY-DIGEST.md).
- **Gmail recall (`bin/gmail`):** a stateless IMAP read CLI (`search` / `show` / `count`) so the agent can answer "what did X send me last week?" or "what's the deadline in that email?" without mirroring your inbox to disk. See [`docs/GMAIL.md`](docs/GMAIL.md).
- **Maintenance:** `wiki groom --mechanical` (close missing relations, run autolink, report stub debt), `wiki audit --all` (quality score), `wiki review` (discovery digest), `wiki sync-ids` (backfill observation ids).
- **The agent (Alfred):** the optional conversational layer over the CLI. One persona (`AGENTS.md` in the vault) is shared by every runtime — nanoclaw, Claude Code, Codex — so Alfred behaves identically wherever you reach him. The published template (with the operating-loop reflexes: search-before-answer, volunteer-captures, surface-contradictions, Gmail-fallback) is [`docs/PERSONA.template.md`](docs/PERSONA.template.md); runtime wiring is in [`integrations/`](integrations/).
- **Credential handling:** the rules for app passwords and secrets are in [`docs/SECURITY.md`](docs/SECURITY.md).

## Repository layout

```
alfred_assistant/
  bin/
    wiki                  # CLI entrypoint: argv parse + VERBS help table + cmds dispatch + tamper/auto-commit gating (zero deps, Node stdlib only)
    inbox                 # raw-content triage CLI
    wiki-test             # fixture runner (supports a `bin` field to test downstream consumers)
    email-digest          # Gmail SMTP wrapper (bash) for the weekly digest + daily brief
    daily-brief           # deterministic daily-brief composer (Node)
    gmail                 # stateless Gmail IMAP read CLI (Python, stdlib only)
    lib/                  # pure helper modules (require()-able, unit-tested)
      audit.js            #   AUDIT_RULES table + auditPage + auditVault
      autolink.js         #   buildTitleEntries + autolinkBody (fence-aware)
      capture-classifier.js #  classifyUtterance: utterance -> observation category
      config.js           #   .alfred.yml loader
      daily-brief.js      #   parsers + formatBrief (pure; consumed by bin/daily-brief)
      date.js             #   isISODate / ISO_RE (single source for date-shape validation)
      duckdb.js           #   vault snapshot + DuckDB view (BM25, sql, day)
      epistemic-verbs.js  #   buildPredictionLine / buildHypothesisLine / stampOnDate
      flag-aliases.js     #   --old/--new flag-rename hook with deprecation warning
      frontmatter.js      #   parseFrontmatter / serializeFrontmatter / migratePage
      gmail.py            #   IMAP-criteria builder + MIME decoders (pure; consumed by bin/gmail)
      graph.js            #   firstBodyLine, extractWikilinks, parseObservations/Relations, scoreSlugCandidates
      ingest.js           #   validateIngestSpec + validateBody (closed-set checks)
      inverse-closure.js  #   computeMissingInverses (symmetric + inverse relations)
      maintenance.js      #   formatIndex / formatLogLine / applyExtraFrontmatter / validateAliasArg
      obsid.js            #   mintIdsForBody: stable per-observation ids
      schema.js           #   loadSchema (mtime-memoized) + KNOWN_TYPES + ENTITY_KIND_TAGS
      secrets.js          #   detectSecrets / redactSecrets (commit-time guard)
      staged-writes.js    #   flushStaged (atomic-per-file multi-write flush; used by ingest/merge/mv)
      synonyms.js         #   parseSynonymsFile + expandQuery (BM25 synonym expansion)
      tag-filter.js       #   boolean tag-expression grammar -> SQL
      vault-root.js       #   detectVaultRoot (shared by wiki + inbox)
      vault.js            #   forEachPage, listWikiPages, wikiPath, readPage, vault paths
    verbs/
      read.js             # read-only verbs split out of bin/wiki (list, search, recent, preview, print, sources, related, unlinked-mentions, agenda, day, context, challenge, render)
    commands/             # verb handlers (cmdXxx) split out of bin/wiki, one file per group; migration in progress
  schemas/
    wiki-ingest.schema.json   # JSON Schema for the ingest spec
  docs/
    SCHEMA.md             # the vault contract — page types, tags, microsyntax
    CONVENTIONS.md        # error-format genres, exit codes, error-prefix vocabulary
    PERSONA.template.md   # Alfred's instructions, with {{USER_NAME}} placeholders
    NANOCLAW-PATCHES.md   # the host-side patches you apply to your nanoclaw fork
    WEEKLY-DIGEST.md      # how the weekly cron + SMTP wrapper fit together
    DAILY-BRIEF.md        # the deterministic 07:00 morning brief
    GMAIL.md              # the Gmail IMAP read CLI (setup, verbs, troubleshooting)
    SECURITY.md           # credential-handling rules (app passwords, secrets, rotation)
  integrations/           # per-runtime adapters (config + launch wrappers; NOT persona variants)
    README.md             #   the adapter contract + "pick your runtime"
    claude-code/          #   PreToolUse write-guard hook + settings snippet + alfred-cc wrapper
    codex/                #   alfred-codex wrapper (+ tamper-check backstop note)
    nanoclaw/             #   pointer to docs/NANOCLAW-PATCHES.md + AGENTS.md loader note
    scheduling/           #   OS cron/launchd recipes for the daily brief + weekly review
  examples/
    .alfred.yml.example   # config file template, copy to <vault>/.alfred.yml
    example-vault/        # 13-page demo vault you can experiment against (alice, bob-jones, paper-llm-wiki-2024, …)
  tests/
    vault/                # template vault used by wiki-test (fresh copy per fixture)
    fixtures/             # JSON specs + expected outputs (cmd-shape and ingest-shape; see tests/fixtures/README.md)
    unit/                 # node:test suites for each bin/lib/ module (see npm run test:unit)
  tools/
    scan-pii.sh           # pre-commit PII scanner (used in development)
    pre-commit            # symlinked into .git/hooks/; runs scan-pii.sh + npm test on relevant changes
  AGENTS.md               # orientation for LLM agents working on this repo (Codex/Claude Code/etc.)
  CLAUDE.md               # one-line @AGENTS.md import so Claude Code loads the same orientation
  CHANGELOG.md            # human-readable history per audit / refactor batch
  CONTRIBUTING.md         # how to propose changes (single-user project; mostly historical)
  install.sh              # symlinks bin/ into a target vault's .bin/
```

## Quickstart

```bash
# 1. Clone
git clone https://github.com/<your-username>/alfred_assistant.git
cd alfred_assistant

# 2. Create a vault directory and configure it
mkdir -p ~/my-vault/wiki
cp examples/.alfred.yml.example ~/my-vault/.alfred.yml
$EDITOR ~/my-vault/.alfred.yml           # set user.slug, user.name, email.from

# 3. Install the CLI into the vault
./install.sh ~/my-vault

# 4. Sanity-check
cd ~/my-vault
wiki preflight            # one-shot env + dependency check; should report OK
wiki list                 # should print "no pages yet" or similar
```

To run Alfred himself (the conversational agent), follow `docs/NANOCLAW-PATCHES.md` — you'll fork nanoclaw, apply four host-side patches, mount your vault, and bootstrap a Telegram bot.

## Configuration

`.alfred.yml` at the vault root.
See `examples/.alfred.yml.example` for the full schema.
Secrets (`GMAIL_APP_PASSWORD`, OneCLI tokens, Telegram bot token) stay in `.env` — never in the YAML.

## Weekly digest

A cron-scheduled task fires every Monday at 09:00 in your configured timezone.
Alfred runs `wiki review`, `wiki audit --all`, `wiki agenda upcoming`, and a few SQL queries; synthesises the output into a three-section email (Stats / Top promotion candidates / Action items); pipes it to `bin/email-digest` for delivery via Gmail SMTP.
The Gmail app-password is **SMTP-send-only** — Alfred cannot read your mail.
Setup is in `docs/WEEKLY-DIGEST.md`.

## Tests

```bash
./bin/wiki-test
```

Should print `N/N passed` (count grows over time as new fixtures land).
Each fixture either runs `wiki ingest` against a fresh copy of `tests/vault/` (ingest-shape) or invokes the CLI directly (cmd-shape), then diffs against `<fixture>.expected.json`. See `tests/fixtures/README.md` for the two shapes and the assertion vocabulary.

Unit tests for the pure helpers in `bin/lib/` live under `tests/unit/`:

```bash
npm test          # unit tests + fixture suite
npm run test:unit
npm run test:fixtures
```

## PII discipline

This repo was extracted from the author's personal vault.
A PII scanner (`tools/scan-pii.sh`) runs as a pre-commit hook to prevent the author's own data from leaking into commits — and to give other forkers a starting point for the same.
Maintain `tools/pii-list.local.txt` (gitignored) with names, emails, and secrets specific to you; the hook will block commits that match.

## License

MIT — see `LICENSE`.

## Acknowledgments

Inspired by [Andrej Karpathy's tweet](https://twitter.com/karpathy) about LLMs as wiki-maintainers,
and built on [nanoclaw](https://github.com/<your-username>/nanoclaw) by <nanoclaw-maintainer>.
