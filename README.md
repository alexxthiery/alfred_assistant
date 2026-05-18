<!-- TODO before public release: replace <your-username> placeholders below with your actual GitHub handle, and fill in <nanoclaw-maintainer> with the upstream attribution. -->

# Alfred Assistant

A self-hosted personal-knowledge agent backed by a Karpathy-style LLM wiki.

Alfred is the assistant; the wiki is the memory.
You message Alfred on Telegram; he extracts structured facts into a versioned, schema-enforced graph at `wiki/`.
Verbs (`wiki ingest`, `wiki patch`, `wiki review`, …) do the writing — never markdown by hand.

> This repository contains the CLIs, schema, persona template, and tests.
> It assumes you run Alfred inside a [nanoclaw](https://github.com/<your-username>/nanoclaw) container connected to a Telegram bot.
> The vault content (your actual `wiki/*.md`, `raw/*`) lives outside this repo, on your machine.

## Status

Early. The author runs Alfred daily; the design is stable; the published code is what's actually used in production with PII redacted.
Open issues welcome. Breaking changes will be noted in `CHANGELOG.md`.

## Architecture (one paragraph)

`raw/` (immutable source archive) → `wiki/` (assistant-maintained typed graph, one concept per page) → `SCHEMA.md` (the contract).
Alfred runs inside a nanoclaw Docker container with the vault directory bind-mounted at `/workspace/extra/vault/`.
A `PreToolUseHook` blocks direct `Write`/`Edit`/Bash-redirects to `wiki/*.md` — all writes go through `bin/wiki` so the CLI can enforce schema, microsyntax, provenance, autolink, and audit invariants.
Auto-commit on every write turns the vault into a git-versioned, revertable knowledge base.

## Repository layout

```
alfred_assistant/
  bin/
    wiki                  # main CLI (~4k LOC, zero deps, Node stdlib only)
    inbox                 # raw-content triage CLI
    wiki-test             # fixture runner
    email-digest          # Gmail SMTP wrapper for the weekly digest
    lib/
      config.js           # .alfred.yml loader
  schemas/
    wiki-ingest.schema.json   # JSON Schema for the ingest spec
  docs/
    SCHEMA.md             # the vault contract — page types, tags, microsyntax
    PERSONA.template.md   # Alfred's instructions, with {{USER_NAME}} placeholders
    NANOCLAW-PATCHES.md   # the four host-side patches you apply to your nanoclaw fork
    WEEKLY-DIGEST.md      # how the cron + SMTP wrapper fit together
  examples/
    .alfred.yml.example   # config file template, copy to <vault>/.alfred.yml
    example-vault/        # 5-page demo vault you can experiment against
  tests/
    vault/                # template vault used by wiki-test (fresh copy per fixture)
    fixtures/             # 16 canonical JSON specs + expected outputs
  tools/
    scan-pii.sh           # pre-commit PII scanner (used in development)
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

Should print `16/16 passed`.
Each fixture runs `wiki ingest` against a fresh copy of `tests/vault/` and diffs the output against `<fixture>.expected.json`.

## PII discipline

This repo was extracted from the author's personal vault.
A PII scanner (`tools/scan-pii.sh`) runs as a pre-commit hook to prevent the author's own data from leaking into commits — and to give other forkers a starting point for the same.
Maintain `tools/pii-list.local.txt` (gitignored) with names, emails, and secrets specific to you; the hook will block commits that match.

## License

MIT — see `LICENSE`.

## Acknowledgments

Inspired by [Andrej Karpathy's tweet](https://twitter.com/karpathy) about LLMs as wiki-maintainers,
and built on [nanoclaw](https://github.com/<your-username>/nanoclaw) by <nanoclaw-maintainer>.
