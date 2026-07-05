# `wiki ingest` JSON spec reference

`wiki ingest --stdin` (or `--file <path.json>`) is the structured write path: one
JSON object describes the pages to create/modify, and the CLI validates the whole
batch atomically before writing anything. This document is the field reference so
you can build a valid spec without reading `bin/wiki` source.

Validate without writing first: `wiki ingest --file spec.json --dry-run` runs the
full validation + a simulated audit + dangling-target check and prints the
create/modify/skip plan, touching nothing.

## Top-level object

```json
{
  "source": "telegram:2026-05-21",
  "msg_id": "<inbound message id, optional>",
  "stubs":    [ /* minimal pages */ ],
  "entities": [ /* atomic person/org/concept/decision pages */ ],
  "events":   [ /* type=event pages */ ],
  "patches":  [ /* edits to existing pages */ ]
}
```

- `source` (**required**) — provenance stamped on every observation that doesn't
  carry its own `source`. Schemes: `telegram:<date>`, `arxiv:<id>`, `https://…`,
  `gmail:<addr>:<date>`, `raw/clippings/<file>.md`, `raw/notes/<file>.md`.
  Do not use `inbox/...` here: `inbox/` is transient staging. Move or triage
  the file into `raw/<kind>/...` first, then cite the raw path.
- `msg_id` (optional for host-side maintenance, required by policy for
  Telegram-triggered Alfred ingests) — captures the spec+result for
  `wiki replay`. Set `WIKI_REQUIRE_REPLAY_MSG_ID=1` in environments where missing
  replay provenance should fail before any write.
- At least one of `stubs` / `entities` / `events` / `patches` must be non-empty.
- After the JSON shape passes, ingest renders every staged page and runs the
  same strict page validator used by `wiki write`/`wiki patch` before flushing.
  If rendered content is empty or invalid, no files are written.

## Observation arrays

Entities and events carry observations under these keys, each an array:
`facts`, `hypotheses`, `opinions`, `claims`, `quotes`, `questions`, `decisions`,
`ideas`. Each element is **either**:

- an object `{ "body": "…", "since"?: "YYYY-MM-DD", "until"?: "…", "on"?: "…", "asOf"?: "…", "tags"?: ["…"], "source"?: "…" }`, **or**
- a **bare string** (shorthand for `{ "body": "<string>" }`).

`body` is required and non-empty. Provenance is auto-stamped from the top-level
`source` unless the element sets its own `source`. Dates become inline tags
(`[since …]`, `[until …]`, `[on …]`, `[as-of …]`).

## `entities[]`

```json
{
  "slug": "policy-improvement-lower-bound",
  "title": "A surrogate objective lower-bounds policy improvement",
  "type": "concept",
  "tags": ["research"],
  "claims": [{ "body": "…statement that defines its own terms… ^[arxiv:…]" }],
  "hooks": ["advantage-baseline", "trust-region"],
  "relations": [{ "verb": "instance_of", "target": "control-variate" }],
  "allow_duplicate": false
}
```

- `slug`, `title`, `type`, `tags` (**required**) — `type` ∈
  `entity` / `concept` / `decision` / `question` / `synthesis` / `note`
  (the idea-card types; use the `events[]` array for events, `wiki todo` for
  todos, and the source/measurement flows for those). `tags` ⊆ the SCHEMA taxonomy.
- Plus **≥1** of the observation arrays above, or `relations`.
- `hooks` — string array of short connective concept names (1-3). See the
  intellectual-pipeline persona docs for what makes a good hook.
- `relations` — `[{ "verb", "target" }]`. `verb` must be in a SCHEMA registry
  (symmetric / inverse-pair / one-way). `target` must resolve to an existing page
  or another slug created in this same spec — **dangling targets are rejected**.
- `allow_duplicate` (optional) — `true` waves this one item past fuzzy
  duplicate-detection (instead of `--allow-duplicates` for the whole batch; you
  can also pass `--allow-duplicate-slug <slug>`).

## `events[]`

Like entities, but:

- `tags` **must include `"event"`**, and `when` (YYYY-MM-DD) is **required**.
- Optional: `duration`, `location` (a slug that must exist, or free text),
  `attendees` (array of slugs — each must exist or be a stub), `recurrence`.

## `stubs[]`

Minimal placeholder pages: `{ "slug", "title", "type", "tags" }` only. Use for a
hot mention that has no independent facts yet (a place, product, or a person you
only know by name). Don't create fact-less stubs just to host a relation.

## `patches[]`

Edits to an **existing** page:

```json
{ "slug": "existing-page",
  "add_facts": [{ "body": "… ^[…]" }],
  "add_hypotheses": [ … ], "add_opinions": [ … ], "add_claims": [ … ],
  "add_relations": [{ "verb", "target" }],
  "add_hooks": ["…"],
  "supersede": [{ "match": "<substring>", "with": { "body": "… ^[…]" } }] }
```

- `slug` must exist; provide **≥1** of `add_facts` / `add_hypotheses` /
  `add_opinions` / `add_claims` / `add_relations` / `add_hooks` / `supersede`.

## Validation & exit codes

- Validation is **atomic**: all errors are collected and the whole batch is
  rejected (exit 3) if any fail — nothing is written.
- After writing, the touched pages are audited: **medium/high** issues block
  (exit 2); **low**-severity issues are advisory and do not block.
- `--dry-run` runs validation + simulated audit and writes nothing (exit 0/3).

## See also

- `docs/SCHEMA.md` — page types, tags, microsyntax, the relation-verb registries.
- `AGENTS.md` (vault) — the ingestion protocol and the atomicity rules.
