# Email Review

`bin/email-review` is Alfred's bounded Gmail triage workflow. It answers:

> What arrived in the last D days that may deserve action, a background todo, or a sourced vault update?

It is not an inbox mirror, not a replacement for reading email, and not an automatic vault-ingestion engine.

## Contract

- Gmail is an external evidence stream. The vault remains canonical memory.
- The CLI is read-only against Gmail and never marks messages read, labels them, deletes them, or downloads attachments.
- The CLI emits a report; it never writes vault pages or todos.
- Any eventual vault write must go through `wiki` and must carry compact Gmail provenance.
- Alfred should use best judgment and ask few questions. A quiet run is a good run.
- This file is the durable behavior contract. When the user gives stable feedback about email review behavior, Alfred may edit this document through the normal repo workflow.

## Command

```sh
bin/email-review --days 1
bin/email-review --days 7 --format json
bin/email-review --days 1 --record-ledger
bin/email-review --query "newer_than:7d has:attachment" --limit 100
```

Flags:

| Flag | Meaning |
|---|---|
| `--days N` | Look back N days, 1-90. Default: 1. |
| `--query "..."` | Raw Gmail search syntax; overrides the default `newer_than:Nd` query. |
| `--limit N` | Maximum matching messages to inspect, 1-500. Default: 100. |
| `--body-limit N` | Maximum newest message bodies to fetch, 0-100. Default: 30. |
| `--max-questions N` | Maximum clarification questions in the report, 0-20. Default: 5. |
| `--format markdown\|json` | Report format. Default: markdown. |
| `--ledger PATH` | Override the metadata-only review ledger path. |
| `--include-reviewed` | Show messages even if the ledger says they were already reviewed. |
| `--record-ledger` | Append surfaced messages to the ledger with `status=reported`. |

Default ledger path when deployed in a vault:

```txt
cache/email-review/ledger.jsonl
```

The ledger is operational state, not durable knowledge.

## Daily 10:00 Review

The intended daily routine is agentic, not purely deterministic. In an
interactive session Alfred can run the CLI directly:

1. Run `/workspace/extra/vault/.bin/email-review --days 1 --max-questions 7 --record-ledger`.
2. Read the short report.
3. If there are no concrete questions, say so briefly or stay silent depending on the scheduler wrapper.
4. If there are questions, ask only the few listed questions that still need human judgment.
5. After the user answers, write confirmed todos/facts/events/entities through `wiki`.
6. Append stronger ledger statuses when useful: `todo-created`, `vaulted`, `not-actionable`, `deferred`.

Do not schedule this as a fully deterministic host-only job like `daily-brief`: the analysis needs agent judgment. The supported scheduler path is `integrations/scheduling/run-email-review.sh`, normally installed as `com.<assistant-label>.email-review` at 10:00 local after the user asks for it.

For scheduled runs, the wrapper runs `.bin/email-review` itself and then passes
the metadata-only report to the headless agent. The agent should not run Gmail
commands again in that path; this avoids coupling daily email review to a
non-interactive shell-command permission gate.

The scheduled wrapper requires the assistant env file to be vault-bound before
it reads Gmail:

```sh
ALFRED_EXPECTED_VAULT=/absolute/path/to/that/assistant-vault
ALFRED_EXPECTED_LABEL=<assistant-label>
EMAIL_FROM=...
GMAIL_IMAP_APP_PASSWORD=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

The env file must live under the owning vault's `.alfred/private/` directory and
must not be a symlink. `ALFRED_EXPECTED_VAULT` is also checked by
`.bin/email-review` itself, so a manual run with the wrong credential env file
fails before opening IMAP.

## Question Discipline

Alfred should assume the user already reads ordinary email. Do not ask about every message.

Ask only when there is a concrete hypothesis:

- "This looks like a background todo due 2026-09-18. Should I create/update it?"
- "This appears to confirm an event. Should I log it in the vault?"
- "This looks related to existing todo X. Should I patch that todo rather than create a new one?"
- "This sender/category seems consistently irrelevant. Should I ignore similar messages in future?"

Avoid vague questions:

- "What should I do with this email?"
- "Is this important?"
- "Do you want me to process this?"

## Triage Heuristics

Surface as likely action:

- explicit action language: action required, please submit, sign, approve, confirm, reply, review;
- deadline/date language;
- admin/work words: visa, passport, permit, tenancy, contract, form, invoice, payment, grant, paper;
- attachments combined with request or deadline language.

Surface as possible vault context:

- confirmed registrations, accepted papers, scheduled meetings, travel bookings;
- new collaborator, institution, project, conference, or administrative state that Alfred should know later;
- completion confirmations that should close or patch existing todos.

Usually ignore without asking:

- newsletters, marketing, promotions, webinar blasts, unsubscribe-heavy mail;
- automated notifications with no action or durable context;
- ordinary back-and-forth where the user is only cc'd and no explicit request appears.

These are heuristics, not authority. Alfred should use judgment and cite the source.

## Provenance

Every report item includes compact source metadata:

```txt
gmail:uid=123456; date=2026-09-09; from=sender@example.org; subject="Subject"
```

Every email-derived vault write must include Gmail provenance. Prefer compact source markers:

```md
- [fact] Registration for the workshop was confirmed. ^[gmail:uid=123456; date=2026-09-09; from=sender@example.org; subject="Registration confirmed"] <!--obs:...-->
```

For todos, include source context in the body or provenance-bearing observation. Do not store raw email bodies in the vault unless the user explicitly asks and the content is genuinely durable.

## Ledger

The ledger prevents repeated questions about the same message on different days.

Each JSONL row stores message identity, metadata, status, and a short reason. It must not store raw body text.

Example:

```json
{"key":"message-id:<abc@example.org>","uid":"123456","date":"2026-09-09","from":"sender@example.org","subject_hash":"sha256-prefix","category":"action_needed","status":"reported","reviewed_at":"2026-09-09T10:00:00+08:00","reason":"deadline-language, request-language"}
```

Deduplication:

- Prefer `Message-ID`.
- Fall back to UID/date/sender-hash/subject-hash when `Message-ID` is missing.
- Suppress `reported`, `asked`, `ignored`, `todo-created`, `vaulted`, `done`, and `not-actionable`.
- `deferred` is suppressed only until its `revisit_after` date.

## Write Phase

The report is not the write phase.

After review:

- create/update todos with `wiki todo add` or `wiki todo update`;
- add facts/events/entities with `wiki write`, `wiki patch`, or `wiki ingest`;
- link to existing pages whenever possible;
- keep background tasks tagged and dated enough to be discoverable without cluttering urgent agenda views;
- record in the ledger that the email became `todo-created`, `vaulted`, `not-actionable`, or `deferred`.

If in doubt, ask the user a concrete question before writing. If the email is obvious and low-risk, Alfred may create a background todo or sourced vault fact without asking, but the provenance rule still applies.

## Failure Modes

| Failure | Required behavior |
|---|---|
| Missing `EMAIL_FROM` or `GMAIL_IMAP_APP_PASSWORD` | Report the missing variable and stop. Do not suggest OAuth. |
| Gmail/network unavailable | Report the failure. Do not infer from stale reports. |
| Huge mailbox window | Respect `--limit`; ask before raising caps materially. |
| Ambiguous action | Ask one concrete question. |
| Same email already reviewed | Suppress unless `--include-reviewed` is passed or a deferred revisit date has arrived. |
| Sensitive content | Cite UID/date/sender/subject; avoid copying body text into the ledger or docs. |

## Feedback Loop

When the user says an email-review behavior was wrong, update this document if the lesson is stable:

- too noisy or too quiet;
- category that should usually be ignored;
- class of email that should become a background todo automatically;
- source/provenance wording adjustment;
- daily cadence or question cap adjustment.

Do not encode one-off preferences as permanent policy.
