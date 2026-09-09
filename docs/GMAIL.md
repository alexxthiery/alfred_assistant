# Gmail (IMAP read)

`bin/gmail` is a stateless read-only CLI over your Gmail inbox via IMAP. Three subverbs — `search`, `show`, `count` — let Alfred answer questions like "what did Alice send last week" or "what's the deadline in the lease-renewal email" without a local mirror of your mailbox.

It is the read counterpart to [`bin/email-digest`](../bin/email-digest), which is send-only.

For proactive triage over a recent window, use [`bin/email-review`](../bin/email-review) instead. `gmail` is the low-level recall primitive; `email-review` is the bounded "last D days, what deserves action or vault logging?" workflow.

## Setup

### 1. Enable IMAP in Gmail

Google enables IMAP by default on personal Gmail accounts (the explicit toggle was removed in late 2024). To confirm: ⚙️ Settings → **See all settings** → **Forwarding and POP/IMAP**. The IMAP-access sub-options (Auto-Expunge, folder size, deletion behavior) are visible only when IMAP is on. If you see them, you're good.

### 2. Mint a dedicated app password

App passwords require 2FA enabled on the Google account.

1. Open <https://myaccount.google.com/apppasswords>.
2. App name: `alfred-imap-read` (kept distinct from `alfred-digest`, the existing SMTP-send password, so revocations are surgical).
3. Copy the 16-character string. It is shown once.

The two app passwords look identical to Gmail — the "purpose" string in step 2 is purely for your revocation visibility in the Google account console.

### 3. Stash the credential

In the same environment file that holds `EMAIL_FROM` and `GMAIL_APP_PASSWORD`:

```sh
EMAIL_FROM=you@example.com           # same as the SMTP-send config
GMAIL_IMAP_APP_PASSWORD=xxxxxxxxxxxxxxxx
```

`bin/gmail` reads both at startup. Missing either → exit 2 with a one-line hint.

### 4. Verify

```sh
.bin/gmail count --since $(date -v-30d +%F)   # macOS BSD date
# or on Linux: --since $(date -d '30 days ago' +%F)
```

Expect a single integer. If you see a Python traceback or `gmail: IMAP login failed`, see the troubleshooting matrix below.

## Subverbs

### `gmail search [flags]`

Lists matching messages, newest first, one tab-separated row per match.

```
--from <addr>          sender substring match (e.g. "alice" matches any alice@*)
--to <addr>            recipient substring match
--subject <text>       subject contains
--body <text>          body contains (server-side TEXT search)
--since YYYY-MM-DD     on or after
--before YYYY-MM-DD    strictly before
--has-attachment       only messages with attachments
--label <label>        Gmail label (X-GM-LABELS)
--query "<raw>"        raw Gmail search syntax; overrides other flags
--limit N              max results (default 50, newest first)
--full                 include first ~10 lines of decoded body per match
--ids-only             print only UIDs, one per line (pipe target)
```

Multiple convenience flags combine with **AND**. `--query` is the escape hatch — passes Gmail's native syntax to the `X-GM-RAW` IMAP extension, supporting everything the Gmail web UI supports (`newer_than:7d`, `has:attachment`, `from:foo OR from:bar`, `filename:pdf`, etc.).

**Output (default):**

```
<uid>\t<YYYY-MM-DD>\t<from>\t<subject>
```

Tabs in subjects are replaced with spaces so the format stays parseable by `cut`, `awk`, `wiki sql`.

**Output (`--full`):** above, then an indented body excerpt (≤10 lines), then a blank line, per message.

**Output (`--ids-only`):** one UID per line. Designed for piping:

```sh
.bin/gmail search --from alice --ids-only | head -1 | xargs .bin/gmail show
```

### `gmail show <uid>`

Print headers + decoded plain-text body of one message.

```
From: ...
To: ...
Date: ...
Subject: ...
---
<body, MIME-decoded; multipart prefers text/plain, falls back to text/html with tag stripping>
```

UID is what `gmail search` returned in column 1. UIDs are stable in Gmail (don't change across sessions), so the value you grab now will still resolve a week later.

### `gmail count [flags]`

Same flags as `search`. Prints a single integer to stdout. Useful for:

```sh
.bin/gmail count --from alice --since 2026-05-01      # how many from him this month
.bin/gmail count --query "subject:invoice newer_than:90d"
```

## Sample commands

```sh
# All emails from Alice this month
.bin/gmail search --from alice --since 2026-05-01

# Recent unread with attachments
.bin/gmail search --query "is:unread has:attachment newer_than:7d" --full

# What's the deadline in the lease renewal?
.bin/gmail search --query "lease renewal" --limit 5
.bin/gmail show <uid-from-prev>

# Pipe one through to show
.bin/gmail search --from bob --ids-only --limit 1 | xargs .bin/gmail show
```

## Why stateless

No local cache, no sync state machine. Every invocation opens IMAPS, runs the query, closes. Reasoning:

- The use cases are **ad-hoc** ("what did X send", "find a deadline"). Latency is invisible at that cadence.
- A local cache adds a class of bugs we don't need: stale-vs-reality, last-UID-seen, deletion-sync. Better is the enemy of good.
- Zero secrets-on-disk surface beyond the env-var credential. The vault doesn't accumulate copies of your inbox in `cache/gmail/` that would need their own threat model.

Latency on a typical residential connection: ~1-2 sec for 100-message header fetch; ~5 sec for 100 full bodies. If you ever need iterative refinement faster than 2 sec per query, the upgrade path is a per-session cache (one connection chained across subverbs in one process) — not a persistent mirror.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `gmail: EMAIL_FROM env var not set` | env not exported | `export EMAIL_FROM=you@example.com` (or set in the container's env file) |
| `gmail: GMAIL_IMAP_APP_PASSWORD env var not set` | same | `export GMAIL_IMAP_APP_PASSWORD=<16-char>` |
| `gmail: IMAP login failed` | wrong password, or 2FA disabled (app passwords vanish), or password revoked | Mint fresh at <https://myaccount.google.com/apppasswords> |
| `gmail: Gmail unreachable: ...` | no network, or imap.gmail.com blocked | Check connection; check firewall/VPN |
| `gmail: at least one filter required` | called `search` / `count` with no flags | Add `--from`, `--since`, or `--query` |
| Mangled subjects with weird gaps or duplicated fragments | RFC 2047 encoded-word edge case OR stdlib imaplib parser quirk on certain forwarded/proxied messages | Known minor issue; affects some corporate Outlook FW: chains and messages routed through third-party security proxies. The headers still surface a useful approximation |
| `gmail show <uid>` prints `(body unavailable: Gmail returned an unparseable IMAP response ...)` and possibly empty headers above it | Python stdlib `imaplib` cannot parse Gmail's FETCH response for that specific UID; both `BODY.PEEK[]` and `RFC822` return `[None]`, and the salvage header fetch usually fails too because the same parser quirk affects every fetch shape for that UID | Open the message in Gmail's web UI for that one. The UID is named in the diagnostic line for orientation. Affects a small fraction of messages (typically forwards through third-party security proxies). If it bites frequently, the path forward is the `imaplib2` third-party library — not done because it would break the zero-dep invariant. Tracking this as a known limitation, not a bug |
| Pagination beyond `--limit` | no cursor | Re-run with `--before <date-of-oldest-result-you-saw>` |
| Search across Sent / Archive | v1 reads INBOX only | Not supported. If needed, add `--folder` flag |

## Security notes

App passwords are **broad** — there's no actual per-purpose scoping despite the name field. Anyone with the `alfred-imap-read` password can read your entire inbox. Mitigations:

- **Revoke specifically**: if you suspect a leak, revoke just that named password at <https://myaccount.google.com/apppasswords>. Your SMTP-send password (`alfred-digest`) keeps working — the morning brief survives.
- **Rotate**: minting a fresh password takes 30 seconds.
- **Audit access**: Google Account → Security → Recent security activity shows IMAP sessions with timestamps and source IPs.
- **No on-disk credential cache**: this CLI never writes the password to disk. It reads from env at invocation and discards on exit.

If you ever expose the password (commit it, paste it into chat, screenshot it), revoke immediately, mint a new one, and update the env file.

## Persona integration

`docs/PERSONA.template.md` § Reflex 4 ("Gmail fallback") instructs Alfred to run `bin/gmail search` when:
- the user asks a recall-shaped question ("what did X send", "what was the deadline in Y"),
- AND the vault (via Reflex 1) has no answer,
- AND the topic sounds email-shaped (attachments, dates, sender names, "the email about Z").

The reflex is *fallback*, not first-resort — the vault is canonical for what the user already captured. Gmail is for what wasn't.

## Limitations

- **INBOX only.** Sent mail, archive, and labels-not-tied-to-INBOX aren't searched. `--query` with raw Gmail syntax can sometimes work around this (`in:sent` etc.) but the connection is still selected against INBOX.
- **No write operations.** No mark-read, no label, no delete. Read-only by design.
- **No attachments download.** `show` prints text; attachments are mentioned in headers but not extracted.
- **MIME edge cases.** Some uncommon header encodings can produce mangled subjects. The body decoder is more robust than the header decoder.

If any of these become friction in practice, file the use case and we'll address — don't pre-build.
