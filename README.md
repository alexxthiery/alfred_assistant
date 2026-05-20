<!-- TODO before public release: replace <your-username> placeholders below with your actual GitHub handle, and fill in <nanoclaw-maintainer> with the upstream attribution. -->

# Alfred Assistant

A self-hosted personal-knowledge agent backed by a Karpathy-style LLM wiki.

Alfred is the assistant; the wiki is the memory.
You message Alfred on Telegram; he extracts structured facts into a versioned, schema-enforced graph at `wiki/`.
Verbs (`wiki ingest`, `wiki patch`, `wiki review`, …) do the writing — never markdown by hand.

> This repository contains the CLIs, schema, persona template, and tests.
> It assumes you run Alfred inside a [nanoclaw](https://github.com/<your-username>/nanoclaw) container connected to a Telegram bot.
> The vault content (your actual `wiki/*.md`, `raw/*`) lives outside this repo, on your machine.

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
Alfred runs inside a nanoclaw Docker container with the vault directory bind-mounted at `/workspace/extra/vault/`.
A `PreToolUseHook` blocks direct `Write`/`Edit`/Bash-redirects to `wiki/*.md` — all writes go through `bin/wiki` so the CLI can enforce schema, microsyntax, provenance, autolink, and audit invariants.
Auto-commit on every write turns the vault into a git-versioned, revertable knowledge base.

## What it does (feature map)

The capability surface, with a pointer to the detailed doc for each. This is the index, not the manual.

- **Typed-graph CLI (`wiki`):** create, read, link, and query atomic pages. Verbs include `ingest`, `patch`, `write`, `merge`, `search` (DuckDB BM25 + synonym expansion), `related`, `path`, `context`, `timeline`, `sql`. The contract (page types, tags, microsyntax, the SQL view) lives in [`docs/SCHEMA.md`](docs/SCHEMA.md).
- **Capture pipeline (`wiki capture`):** turn a one-line utterance into a classified, provenance-stamped observation on the right page. `--today` / `--on YYYY-MM-DD` stamp activity dates; `wiki day [YYYY-MM-DD]` lists what you did on a day.
- **Reminders and calendar:** `wiki todo` (dated with `--due`, or undated backlog), `type=event` pages surfaced by `wiki agenda`, and birthdays via a `born:` field.
- **Daily morning brief (`bin/daily-brief`):** a deterministic 07:00 email listing overdue todos, due-today todos, today's events, and today's birthdays. Composed by a script, not the agent, so it cannot drift or hallucinate. See [`docs/DAILY-BRIEF.md`](docs/DAILY-BRIEF.md).
- **Weekly digest:** a Monday discovery-and-quality email (promotion candidates, missing edges, audit offenders, stale markers). See [`docs/WEEKLY-DIGEST.md`](docs/WEEKLY-DIGEST.md).
- **Gmail recall (`bin/gmail`):** a stateless IMAP read CLI (`search` / `show` / `count`) so the agent can answer "what did X send me last week?" or "what's the deadline in that email?" without mirroring your inbox to disk. See [`docs/GMAIL.md`](docs/GMAIL.md).
- **Maintenance:** `wiki groom --mechanical` (close missing relations, run autolink, report stub debt), `wiki audit --all` (quality score), `wiki review` (discovery digest), `wiki sync-ids` (backfill observation ids).
- **The agent (Alfred):** the conversational layer over the CLI. His instructions, including the operating-loop reflexes (search-before-answer, volunteer-captures, surface-contradictions, Gmail-fallback), are in [`docs/PERSONA.template.md`](docs/PERSONA.template.md).
- **Credential handling:** the rules for app passwords and secrets are in [`docs/SECURITY.md`](docs/SECURITY.md).

## Repository layout

```
alfred_assistant/
  bin/
    wiki                  # main CLI (~4k LOC, zero deps, Node stdlib only)
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
  CLAUDE.md               # orientation for LLM agents working on this repo
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
