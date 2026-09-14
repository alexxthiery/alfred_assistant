# Conversation Logging

Alfred can mirror full runtime discussions into the owning vault for debugging,
but these logs are **local-only** by default. They are not graph knowledge, not
searched by `wiki search`, and not committed.

## Storage Model

`wiki conversation-log import` copies transcript-like runtime files into:

```text
<vault>/.alfred/private/conversations/<provider>/<source>/
```

It also writes a structured manifest:

```text
<vault>/.alfred/private/conversations/<provider>/<source>/manifest.jsonl
```

Each manifest row records the provider, source name, source-relative path,
vault-relative copied path, source/stored hashes, byte counts, source mtime,
import timestamp, and redaction count.

The destination is under `.alfred/private/`, so the deploy script's vault
`.gitignore` keeps it out of git. The command refuses to import in a git
worktree if `.alfred/private/conversations/` would be trackable.

## Import Nanoclaw Telegram Transcripts

Run from the host Mac, against the intended vault:

```sh
cd /path/to/vault
.bin/wiki conversation-log import \
  --source ~/nanoclaw/groups/<group>/conversations \
  --provider nanoclaw \
  --source-name <group>
```

Use `--dry-run` first when checking a new source.

## Safety Contract

- The command writes only under `<vault>/.alfred/private/conversations/`.
- If the vault is a git worktree, that path must be ignored or the command
  aborts.
- Common secret shapes are redacted before writing: Telegram bot tokens,
  common API keys, authorization bearer tokens, and known Alfred secret env
  variable assignments.
- Symlinked private directories and destination files are refused.
- Each vault imports only its own runtime source. Do not mirror one assistant's
  group into another assistant's vault.

## What This Is Not

This is not a durable encrypted backup. If the Mac dies, these plaintext logs
die with it unless a separate encrypted archive is implemented later. The
current purpose is local debugging and auditability without uploading full
private discussions to GitHub.
