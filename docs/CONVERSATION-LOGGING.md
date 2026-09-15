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

For Claude JSONL sources, add `--extract claude-jsonl`. The raw JSONL is still
mirrored for debug, but the command also writes compact, append-only deltas:

```text
<vault>/.alfred/private/conversations/<provider>/<source>/deltas/YYYY-MM-DD.jsonl
<vault>/.alfred/private/conversations/<provider>/<source>/cursor/claude-jsonl.json
```

The delta files contain only extracted `user` / `assistant` text blocks with
source line metadata. Tool results, tool calls, attachment payloads, and
assistant thinking blocks are intentionally skipped. The cursor records how far
each source file has been processed, so later imports process only newly
appended transcript lines.

Each delta file is JSONL: one compact message object per line. The schema is
kept deliberately flat and stream-friendly:

```json
{
  "schema_version": 1,
  "kind": "conversation_message",
  "provider": "nanoclaw",
  "source_name": "dm-with-user",
  "source_rel": "session.jsonl",
  "source_line": 42,
  "source_byte_start": 12345,
  "source_byte_end": 12890,
  "source_line_sha256": "...",
  "timestamp": "2026-09-15T12:04:21.000Z",
  "local_date": "2026-09-15",
  "role": "user",
  "text": "The extracted text block.",
  "redactions": 0
}
```

The file name is based on `local_date`, computed in the configured timezone
from the source timestamp when present. If a source line has no usable
timestamp, the import time's local date is used.

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

For Claude-backed nanoclaw agents, `groups/<group>/conversations/` is an
archive directory written on compaction or session rotation. A recent active
conversation may instead still live under the agent's live Claude transcript
store:

```text
<nanoclaw-install>/data/v2-sessions/<agent-group-id>/.claude-shared/projects/<project>/*.jsonl
```

That directory is also a valid source. In scheduled jobs, set
`ALFRED_CONVERSATION_SOURCE` to the live transcript directory and
`ALFRED_CONVERSATION_SOURCE_EXTENSIONS=jsonl` when you want the daily mirror to
catch active-session conversations before nanoclaw creates markdown archives.
Also set `ALFRED_CONVERSATION_EXTRACT=claude-jsonl` so the ingestion job reads
compact deltas instead of the full Claude Code execution transcript.

```sh
cd /path/to/vault
.bin/wiki conversation-log import \
  --source /path/to/nanoclaw/data/v2-sessions/<agent-group-id>/.claude-shared/projects/-workspace-agent \
  --provider nanoclaw \
  --source-name <group> \
  --extensions jsonl \
  --exclude-dir subagents \
  --extract claude-jsonl
```

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
- Extracted deltas are derived from the local raw mirror/source and remain
  under `.alfred/private/`; they are not committed and are not searched as graph
  knowledge.
- Delta files are analysis input, not a durable ingestion ledger. The extractor
  cursor prevents repeated extraction; the scheduled ingestion wrapper records
  its own run ledger under `cache/conversation-ingest/`.

## What This Is Not

This is not a durable encrypted backup. If the Mac dies, these plaintext logs
die with it unless a separate encrypted archive is implemented later. The
current purpose is local debugging and auditability without uploading full
private discussions to GitHub.
