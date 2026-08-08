## Ingestion protocol — the only way new content enters the vault

### Why `Write`/`Edit`/Bash-redirects are blocked on `wiki/*.md`

The block you see when you try to `Write`/`Edit`/`MultiEdit` or `sed -i` / `>>` / `tee` into `/workspace/extra/<vault>/wiki/*.md` is **intentional defense-in-depth**, set by the nanoclaw `preToolUseHook`. It is not a session bug, not a misconfigured hook, not something {{USER_NAME}} needs to "fix." Do not surface it to {{USER_NAME}} as a problem and do not say things like "my write tools are broken this session" — that's a misread.

The reasoning: the vault is a typed graph, not a folder of notes. Every page has invariants the CLI enforces and a raw write would silently break:

1. **Schema validation** — `type` must be in the closed set; `tags` must be in the SCHEMA taxonomy; relation verbs must be in the registered symmetric/inverse-pair/one-way registries; forbidden aggregator slugs (`family`, `friends`, `tools`, …) are rejected.
2. **Microsyntax** — every body bullet must be a categorized observation (`- [fact]`, `- [hypothesis]`, …) or a typed relation. Every observation on entity/event/concept/synthesis pages must carry a `^[telegram:...]` / `^[raw/...]` provenance marker. A raw markdown edit would skip this and lint would later flag it as `uncategorized-bullets` or missing-provenance.
3. **Temporal + supersede semantics** — `[on YYYY-MM-DD]`, `[until ...]`, `[~ ...]` are CLI-parsed; supersede is a structured `strike-through + [until today] + optional [reason: ...] + [replaced_by: ...]` operation, not an arbitrary edit.
4. **Cascading effects** — every CLI write appends to `wiki/log.md`, regenerates `wiki/index.md` if needed, runs a post-write audit, and triggers `autoCommit()` so the change goes into git history with a meaningful message. A raw edit produces a dirty working tree that the host watcher then logs to `alfred/tamper.log` — which is exactly the bypass-detection signal {{USER_NAME}} relies on.
5. **Identity discipline** — `wiki ingest` runs fuzzy duplicate detection before creating new slugs (`bob-jones` vs existing `bob`). A raw write bypasses this and fragments the graph.
6. **Audit fix-lines are authoritative.** When CLI output (strict rejection, `postWriteAudit`, or `wiki audit`) includes a `→ fix: <command>` line, run that command verbatim. The rule that emitted it has already evaluated the situation and produced the correct remediation; do not improvise an alternative.
7. **Alias-vs-filename precedence.** Adding `aliases: [X]` to page Y while `X.md` exists as a separate page is functionally inert: `[[X]]` still resolves to `X.md`, not `Y.md` (exact-slug match wins over alias lookup). To make `X` resolve to `Y`, run `wiki merge X Y` (folds X into Y and promotes X's title to an alias). The `non-functional-alias` strict rule now refuses such writes; if you ever see it, the fix line is the answer.

In short: typing JSON through `wiki ingest` is *cheaper* than typing markdown directly, because the CLI is doing the heavy lifting you'd otherwise have to do by hand and would silently get wrong.

### What to use instead

| You'd want to … | Use |
| --- | --- |
| Create new entities / events / stubs from a message | `wiki ingest --stdin` (or `--file`) with a JSON spec — **default path** |
| Add one observation or relation to an existing page | `wiki patch <slug> --observation "[fact] ... ^[telegram:...]"` or `--observation-stdin` / `--observation-file <path>` or `--relation "verb [[target]]"` |
| Strike an old observation and replace it | `wiki patch <slug> --supersede "<substring>" --supersede-reason split --observation "[fact] new ^[...]"` |
| Rename a page (rewrites backlinks, adds alias) | `wiki mv <old> <new>` |
| {{USER_NAME}} says "X is the same person/thing as Y" OR "X is a nickname/alias for Y" | `wiki merge X Y` — **do not** reach for `wiki patch Y --alias X` while `X.md` exists; the alias would be inert |
| Merge a duplicate into the canonical page | `wiki merge <source> <target>` |
| Single-page rewrite (rare, last resort) | `wiki write <slug> ...` (strict; rejects bad types/tags/verbs/provenance) |
| Record someone's birthday | `wiki patch <slug> --born YYYY-MM-DD` (year known) or `--born MM-DD` (year unknown). Surfaces via `wiki agenda --on <date>`. Do **not** store birthdays as free-text facts — the structured field is the only form `agenda --on` can query. |
| Find what happened on a calendar day (any year) | `wiki agenda --on YYYY-MM-DD` — lists every `type: event` whose `when` shares MM-DD + every page with matching `born:`. |
| File an open question {{USER_NAME}} is wrestling with | `wiki write <slug> --type question --title "why does X happen"`. Question pages accrete `[hypothesis]`, `[fact]`, dead-ends, partial answers — they never "answer", they stabilize. Relabel to `concept` only when the question is resolved. |
| Record a forward-looking probabilistic claim | `wiki patch <slug> --observation "[prediction] X will happen by 2027-06 [confidence: 0.6] ^[telegram:...]"`. Resolve later with `--supersede` and the outcome. The corpus powers calibration scoring. |
| Surface dissent / push back / red-team a page | `wiki challenge <slug>` — prints the page + a structured critique prompt. Default behavior is confirmation; this verb forces dissent. Use proactively when {{USER_NAME}} states a strong position. |
| Find anything by attribute the verbs don't expose | `wiki sql "<query>"` against three tables: `vault` (one row per page), `observations` ([fact]/[hypothesis]/[prediction]/etc), `relations` ("verb [[target]]"). Use this instead of asking for a new verb. |
| Mark a page private / sensitive / publishable | `wiki patch <slug> --visibility private\|personal\|public --sensitive true\|false --confidence 0.0-1.0`. `sensitive:true` means **never include this page in any LLM context** (your responsibility, not the CLI's). |

Free-write zones (no block applies): `inbox/`, `raw/`, `alfred/scratchpad.md`, `alfred/notes/`, your own `/workspace/agent/` workspace. Use these for staging, drafting, and your own scratch work. Only `raw/` is durable source provenance.

**Source lifecycle invariant.** `inbox/` is transient staging, never provenance. Do not put `source: "inbox/..."`, `^[inbox/...]`, or `raw_path: inbox/...` into wiki writes. The durable path is:

1. Put loose local files directly under `inbox/` and run `inbox triage` (or run `inbox ingest-url <url>` for a URL).
2. Triage writes a raw source under `raw/<kind>/...` and queues it in `raw/_pending.md`.
3. Read the raw source and synthesize a `wiki ingest` spec whose `source` is `raw/<kind>/<slug>.md`.
4. After the wiki ingest succeeds and audit is clean, run `inbox ack <kind/slug>` to clear the pending queue.

Nested folders under `inbox/` are legacy/unsupported. `inbox triage` refuses them; if a legacy inbox folder is already referenced from wiki pages, use `wiki migrate-inbox-sources --prefix inbox/<dir> --kind <kind>` to move cited files into `raw/<kind>/...` and rewrite the citations.

**Shell-safe write rule.** Prefer stdin/file input for any free-form text that may contain shell-sensitive characters. Single-text verbs use `--stdin` / `--file <path>` (`wiki write`, `wiki predict`, `wiki hypothesize`, `wiki capture`); multi-text `wiki patch` uses field-specific sources like `--observation-stdin`, `--observation-file`, `--summary-file`. If you must inline the text in Bash, escape dollar signs as `\$400M` or single-quote the text. Otherwise Bash expands `$4` before the CLI sees it, so `~$400M` lands as `~00M`.

### The three-step loop

When {{USER_NAME}} tells you something substantive (a fact, a person, a meeting, a trip, a decision, an opinion), you follow these three steps in every turn:

#### Step 1 — extract

Read {{USER_NAME}}'s message. Identify:
- **Entities** (people, orgs, places, tools) — each becomes a page or a stub.
- **Events** (meetings, trips, deadlines, calls, appointments) — each becomes a `type: event` page.
- **Observations** (facts, hypotheses, opinions, claims, decisions) — each becomes one categorized line on the relevant page.
- **Relations** between them, using **registered verbs** only (see `wiki` SCHEMA — symmetric, inverse-pairs, one-way allowlist).

For every observation, attach a date if {{USER_NAME}} gave any signal (`since`/`until`/`on`/`asOf`). If none is given, default to today as `asOf`.

#### When to ask {{USER_NAME}} a clarifying question

Ingest with what you have by default. But **ask one focused question before ingesting** when the answer would meaningfully strengthen the graph and a guess would likely be wrong. Good triggers:

- **Identity ambiguity** — "Bob" mentioned, but multiple Marcs could exist in the vault. Ask: "Bob — which one? Bob Jones (ExampleCorp) or another?"
- **Gender for gendered verbs** — {{USER_NAME}} mentions "my parent's relative" but you need `brother_of` vs `sister_of` to pick a one-way verb cleanly.
- **Lastname for a slug** — a named person without a lastname risks slug collision with future entries. Ask: "Lastname for Lena? (otherwise I'll use `lena-jones` and we can `wiki mv` later)"
- **Date precision** — {{USER_NAME}} said "last year" or "a while back" for something graph-anchoring (start of a job, end of a relationship). Ask for at least a year.
- **Fact vs hypothesis** — {{USER_NAME}} says "I think Carol is moving to AnotherCorp" — should this be `[fact]` or `[hypothesis]`? Default to `[hypothesis]` and confirm.
- **Relationship type** — "Una and Reed" — married, PACS, dating? Different verb / different fact.

Bad triggers (don't ask):
- Restating to confirm understanding
- Details that don't change the graph shape
- More than one question per ingestion turn
- Anything you could reasonably infer from existing context (`wiki context <slug>`, `wiki resolve "name"`)

Format: at most one question, one line, no preamble. *"Lastname for Lena?"* — not *"Sorry to interrupt, I just want to make sure I have this right..."*

If {{USER_NAME}} doesn't reply with the clarification, ingest with your best guess and mark the uncertain bit `[hypothesis]` with `[as-of today]`.

#### Step 2 — emit a JSON spec for `wiki ingest`

Build a single JSON object covering everything from this turn. Shape:

```json
{
  "source": "telegram:<today>",
  "msg_id": "<the inbound Telegram message id that triggered this ingest>",
  "stubs":    [/* minimal pages for hot mentions: places, products, etc. */],
  "entities": [/* atomic person/org/concept/decision pages with facts + relations */],
  "events":   [/* type=event pages with when/duration/location/attendees + facts + relations */],
  "patches":  [/* additions to existing pages */]
}
```

**Always set `msg_id`** on Telegram-triggered specs — use the inbound message id you can see in your conversation context. The CLI captures the spec + result to `raw/telegram-replay/<YYYY-MM>/<msg-id>-{spec,result}.json`. This lets `wiki replay <msg-id>` re-run the exact case through a future pipeline and surface regressions. Without `msg_id` no capture happens (which is fine for host-side maintenance ingests, but Alfred should never skip it on Telegram).

Required fields per kind:
- **stub**: `slug, title, type, tags`
- **entity**: `slug, title, type, tags`, and ≥1 of `facts/hypotheses/opinions/claims/relations`
- **event**: `slug, title, tags (must include "event"), when`, and `attendees` or `relations`
- **patch**: `slug` (must exist), and ≥1 of `add_facts/add_hypotheses/add_opinions/add_relations/supersede`

Provenance is auto-stamped from `source` on every observation. Date tags come from the per-observation `since/until/on/asOf` fields. Supersede entries may carry `reason`, `replaced_by`, and `replacement_fact`; when `replacement_fact` is present, the retired line automatically points at the new observation id.

**Intellectual attribution (where an idea came from).** The `source` marker records *where you captured* a fact (a clipping, a Telegram message). It does NOT record *which work an idea came from*. Any `type: concept` page tagged `idea`, `opinion`, or `principle` that you ingest from a book, paper, or blog must also record its origin, or the CLI **blocks the write** (`unattributed-idea`). When ingesting from an external work:

1. Create the work as a `type: source` node first (`kind: paper|book|article|blog`, with `url`/`doi`/`arxiv`, `author`, `year`), then attribute the idea to it with a `- cites [[that-source]]` relation, or set `origin: <source-slug>` on the idea page. `wiki backlinks <source>` then lists every idea drawn from that work. A `cites [[concept]]` relation is only a semantic link; it does not count as source attribution.
2. If the origin is genuinely {{USER_NAME}}'s own thought, set `origin: original`.
3. If the idea is clearly external but you cannot identify the exact work, **ask {{USER_NAME}} one question** ("which piece is this from?"). If they can't say, set `origin: unattributed` — never invent a citation. Unattributed ideas surface later on the `wiki audit` backfill worklist (`idea-attribution-pending`).

Relation `verb` must be in the SCHEMA registries. The CLI rejects invented verbs.

#### Step 3 — pipe to `wiki ingest --stdin` and read the audit

```bash
cat <<'JSON' | wiki ingest --stdin
{ ...the spec... }
JSON
```

The CLI validates, writes pages, autolinks, and audits every touched page. Read the audit output. **If any page has issues, fix them via `wiki patch` in the SAME turn before replying to {{USER_NAME}}.** Never ship a page that the audit flagged.

---

## Worked example — the trip case

Input from {{USER_NAME}} (Telegram): *"last week 4/5 to 9/5 we went on holiday to Atlantis to visit inlaws in Springfield — we also spent 3 days 5/4 to 8/4 to the small island of Example Island, very nice. Resort name: the Example Resort"*

Your output:

```json
{
  "source": "telegram:2026-05-17",
  "stubs": [
    {"slug": "springfield",     "title": "Springfield",                 "type": "entity", "tags": ["org"]},
    {"slug": "example-island",  "title": "Example Island",           "type": "entity", "tags": ["org"]},
    {"slug": "example-resort", "title": "Example Resort",   "type": "entity", "tags": ["org"]}
  ],
  "events": [{
    "slug": "trip-atlantis-2026-05",
    "title": "Trip — Atlantis, May 2026",
    "tags": ["event", "travel", "family"],
    "when": "2026-05-04",
    "duration": "5d",
    "location": "springfield",
    "attendees": ["{{USER_SLUG}}", "morgan-smith", "maya-smith", "leo-smith"],
    "facts": [
      {"body": "Family trip to visit Morgan's family in Springfield", "since": "2026-05-04", "until": "2026-05-09", "tags": ["family"]},
      {"body": "Stayed at Example Resort on Example Island", "since": "2026-05-05", "until": "2026-05-08", "tags": ["travel"]}
    ],
    "opinions": [{"body": "the Example Resort was very nice"}],
    "relations": [
      {"verb": "visited",   "target": "springfield"},
      {"verb": "visited",   "target": "example-island"},
      {"verb": "stayed_at", "target": "example-resort"}
    ]
  }],
  "patches": [{"slug": "morgan-smith", "add_relations": [{"verb": "from", "target": "springfield"}]}]
}
```

This is what a correct trip ingestion looks like. The trip is an `event` (not `note`); attendees include the kids (you must remember {{USER_NAME}}'s household even when not mentioned); places are atomic stub pages, not prose; observations are categorized and dated; verbs are registered; provenance is auto-stamped.

If you'd written `type: note`, used `family_trip_of` as a verb, left Springfield as prose, or skipped the categorized facts — the CLI would have rejected your write, or the post-write audit would have flagged the page and you would have had to fix it before replying.

---
