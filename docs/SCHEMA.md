# SCHEMA — the vault contract

The agreed-upon shape of the vault. Both the assistant (Alfred by default) and the CLIs (`wiki`, `inbox`) treat this file as authoritative. Alfred re-reads it on every orientation; the wiki CLI enforces it at write time; lint surfaces drift.

This file co-evolves with use. Edit it freely — every edit becomes a rule the rest of the system enforces. The CLI parses specific sections; do not move them.

> **About the worked examples in this file.** They use a consistent fictional cast — **Alice Smith** as the user, with spouse **Morgan Smith**, children **Maya** and **Leo**, and colleagues **Bob Jones / Carol Lee / Dave Kim / Eve Anderson**, plus an **Example School** / **Example University** as the workplace, situated in **Springfield** / **Atlantis**. Substitute mentally with your own family, colleagues, and locations — or edit this file directly to replace the examples with names from your own vault. The examples are illustrative, not load-bearing; only the *rules* and *closed-set lists* (types, tags, verbs, forbidden slugs, frontmatter fields) are enforced by the CLI.

## The atomicity rule — non-negotiable

**One concept per page. One person per page. One organization per page. One decision per page.**

If a piece of input describes N entities, you produce N pages. Never combine multiple entities under one page. Use typed relations to express how they relate.

Worked example. Input: "My wife Morgan is Atlantean; my daughter Maya is at Example School; my son Leo loves Roblox."

Wrong:
- `family.md` containing Morgan, Maya, Leo together. **Forbidden.**

Right:
- `morgan-smith.md` (`type: entity`, `tags: [person]`) with body containing observations and relations:
  - `- [fact] Atlantean, from Springfield #person`
  - `- spouse_of [[alice]]`
- `maya-smith.md` (`type: entity`, `tags: [person]`):
  - `- [fact] At Example School`
  - `- daughter_of [[alice]]`
  - `- daughter_of [[morgan-smith]]`
- `leo-smith.md` (`type: entity`, `tags: [person]`):
  - `- [fact] Plays Roblox #recurring`
  - `- son_of [[alice]]`
  - `- son_of [[morgan-smith]]`
- `example-school.md` (`type: entity`, `tags: [org]`) — stub, even just title + 1 line
- Provenance marker on each synthesized claim: `^[telegram:2026-05-16]` or `^[raw/notes/...]`

The graph emerges from the **relations**, not from grouping.

## Forbidden aggregator slugs

The CLI refuses to create pages with these slugs because they collapse multiple entities into one. Use atomic pages + relations instead. (Edit this list to remove or add terms.)

```
family friends network colleagues people team members staff
parents kids children siblings relatives cousins
tools papers references bookmarks reading-list books
projects companies orgs places
```

Override discipline: if you genuinely need an overview page (e.g. "my professional network at a glance"), use `type: synthesis` with explicit `derived_from: [slug, slug, ...]` field. Synthesis pages are allowed any title but should not duplicate atomic content — they reference it.

## Three layers

- **`raw/`** — immutable source archive. Files arrive via `inbox triage`. Never edit after they land; re-ingest if needed.
- **`wiki/`** — Alfred-maintained synthesized graph. One concept per page, flat directory, slug-based wikilinks. All writes go through `.bin/wiki`.
- **This file (`SCHEMA.md`)** — the contract.

Sibling folders not governed by this schema:
- `inbox/` — drop-zone; files leave on triage
- `alfred/` — agent state (persona, daily logs, scratch)
- `.bin/` — CLI scripts

## Page types (closed set, CLI-enforced)

The `type:` frontmatter field must be one of these. The CLI refuses unknown types on create/replace.

| type | purpose | required extras | min microsyntax (lint) |
|---|---|---|---|
| `entity` | one person, org, product, place, tool | `tags` must include one of: `person`, `org`, `tool`, `paper`, `media` | ≥1 relation OR ≥2 observations |
| `concept` | one idea, framework, theory, pattern | — | ≥1 relation OR ≥2 observations |
| `decision` | one explicit choice by Alice | `decided_on: YYYY-MM-DD`; optional `supersedes: [slug]` | — |
| `source` | one ingested document | `raw_path`, `sha256`, `ingested_at`, `kind` | — |
| `synthesis` | a cross-cutting analysis stitching multiple pages | `derived_from: [slug, slug, ...]` (≥2 entries) | — |
| `todo` | one task | `status: open\|doing\|done\|abandoned`; optional `due`, `priority` | — |
| `note` | catch-all (use sparingly; lint nags) | — | — |
| `event` | one calendar event (meeting, appointment, deadline, trip) | `when: YYYY-MM-DD` or ISO8601; optional `duration`, `location`, `attendees: [slug, ...]`, `recurrence` | — |
| `question` | one open question that accretes hypotheses, evidence, dead-ends, and partial answers over time. Never "answered" — relabeled as `concept` if it stabilizes. Title in interrogative form (e.g. "why does X happen"). | — | ≥1 observation (typically `[hypothesis]` or `[fact]`) |

The CLI rejects `type: note` for pages whose `tags` include `person`, `org`, or `tool` — use `entity` instead.

## Tag taxonomy (closed set, CLI-enforced)

Every tag on every page must be in this list. The CLI rejects writes with unknown tags. To add a new tag, edit this section first.

```
person  org  tool  paper  media  project  idea  pattern  principle
meta  health  family  work  research  reading  decision  recurring
spouse  child  parent  sibling  friend  colleague  client  household
finance  fitness  travel  food  hobby  event
```

Conventions:
- `person`, `org`, `tool`, `paper`, `media` are entity-kind tags.
- `spouse`, `child`, `parent`, `sibling` are role tags (combine with `person`).
- `meta` is for pages about the vault itself.

## Inline microsyntax (CLI-parseable; lint-checked)

Wiki page bodies use these shapes. Alfred writes them; the CLI extracts them for `wiki relations`, `wiki observations`, and graph rendering.

### Observations

A categorized inline fact, written as a markdown list item:

```
- [fact] Bob moved to ExampleCorp [since 2026-05] #person ^[telegram:2026-05-16]
- [hypothesis] Considering move to AnotherCorp [as-of 2026-04] #work
- [quote] "Trust the process" — Bob [on 2026-05-16]
- [question] Does Bob still work on OpenTelemetry?
- [decision] Switching from VS Code to Cursor #work
- [opinion] CalDAV is the right protocol; Google Calendar's OAuth is overkill for personal use
- [idea] An ingestion pipeline that lints and redacts before writing
- [todo] Email Bob about contract renewal
- [prediction] Bob will leave ExampleCorp by 2027-06 [confidence: 0.6]
```

Categories: `fact`, `hypothesis`, `opinion`, `claim`, `quote`, `question`, `decision`, `todo`, `idea`, `prediction`. The leading `- [category]` makes the line parseable.

- `fact` — verified, attributable to a source
- `hypothesis` — uncertain, unconfirmed (flag for follow-up). Lint warns on hypotheses older than ~90 days.
- `opinion` — Alice's stance, not a verifiable fact
- `claim` — third-party assertion (from a paper, person) without independent verification
- `prediction` — a forward-looking probabilistic claim with `[confidence: 0..1]`, optionally `[by YYYY-MM-DD]` for the resolution date. Resolved later via `--supersede` with the outcome. The corpus of resolved predictions powers calibration scoring.

### Temporal tags (CLI-parseable)

Every observation can carry one or more inline date tags, in any position:

```
- [fact] Joined ExampleCorp [since 2024-08] #work
- [fact] Was Associate Prof at ExampleU [until 2026-05] #work
- [fact] Met at NeurIPS [on 2024-12-10] #colleague
- [fact] Lives in Singapore [as-of 2026-05] #household
```

Variants:
- `[since YYYY-MM-DD]` — start of an ongoing state
- `[until YYYY-MM-DD]` — end of a state (paired with strikethrough on superseded facts)
- `[on YYYY-MM-DD]` — point in time (event-like)
- `[as-of YYYY-MM-DD]` — observation date (when this was true / when learned)

Date precision is flexible: `2024`, `2024-08`, or `2024-08-15` all valid.

### Supersession (retiring an old fact)

When a fact becomes outdated, do not delete the old observation — supersede it. The page tells a story over time.

```
- ~~[fact] Associate Prof at ExampleU~~ [until 2026-05]
- [fact] Joined AnotherCorp as portfolio manager [since 2026-05] #work
```

Use `wiki patch <slug> --supersede "<substring>"` to auto-transform the matching line (adds strikethrough + `[until <today>]`). Optionally combine with `--observation "..."` to append the replacement.

Lint can list pages with superseded facts to confirm the new state was added.

### Relations (typed edges)

Typed edges between wiki pages, also as list items:

```
- works_at [[example-corp]]
- created [[opentelemetry]]
- "advisor to" [[meta-recsys]]
- spouse_of [[alice]]
- daughter_of [[alice]]
- daughter_of [[morgan-smith]]
- supersedes [[old-decision-slug]]
- contradicts [[other-page]]
```

Common verbs (extend as needed):
- Person ↔ person: `spouse_of`, `parent_of`, `child_of`, `sibling_of`, `friend_of`, `colleague_of`, `mentor_of`, `student_of`, `partner_of`
- Person ↔ org: `works_at`, `founded`, `advises`, `client_of`, `member_of`
- Concept/work: `created`, `co-created`, `extends`, `inspired_by`, `cites`, `attended`, `mentions`
- Lifecycle: `supersedes`, `superseded_by`, `contradicts`, `refines`

Multi-word relations use double-quotes. The target is a wikilink to a slug.

### Provenance markers

Every synthesized claim derived from a source ends with a marker pointing back to where it came from:

```
Bob started at ExampleCorp in May 2026. ^[raw/notes/2026-05-16-alice-bob.md]
Maya attends Example School. ^[telegram:2026-05-16]
```

Forms:
- `^[raw/<kind>/<slug>.md]` — for facts from triaged sources
- `^[telegram:YYYY-MM-DD]` — for facts learned directly in conversation
- `^[lab:LAB-2026-02-24]` — for facts from external documents not yet ingested

Lint flags `type: entity`, `type: synthesis`, and `type: concept` pages with observations but zero provenance markers. Run `wiki audit` to surface these.

## Hard rules

- **Atomicity**: one entity per page. Always. Forbidden aggregator slugs are enforced by CLI.
- **Never silently overwrite a fact.** Use `--append` to add new facts with date context; do not `--replace` to make old facts disappear.
- **Never delete a page that has backlinks** without `--force`. The default refusal is a feature.
- **Never write directly to `wiki/*.md`** — always through `.bin/wiki`. The CLI maintains index.md, log.md, and link integrity.
- **Never modify files under `raw/`** after they're written. Re-ingest to correct.
- **Inbox is not safe storage.** Files leave on triage; secrets are redacted on best-effort regex.
- **Wikilink density expected**: every wiki page should contain at least 2 wikilinks unless it's a true leaf (lint warns below this threshold for non-leaf pages).

## Staleness thresholds

`wiki lint --only stale` warns when `updated` is older than threshold. Threshold chosen by tag:

| Tags | Threshold |
|---|---|
| `paper`, `tool`, `research`, `reading` (fast) | 6 months |
| `project`, `recurring`, `meta` | 12 months |
| `person`, `org`, `family`, `health`, `principle`, `decision` | 24 months |
| no matching tag | 12 months |

## Tier escalation

A slug referenced in `[[...]]` wikilinks 3+ times but missing its own page becomes a tier-escalation candidate. `wiki lint --only tiers` lists these; Alfred promotes stubs to full pages once they cross the threshold.

## Filenames and slugs

- Slug pattern: `^[a-z0-9][a-z0-9-]*$` (lowercase, alphanumeric, hyphens).
- **People: prefer `firstname-lastname`** (e.g. `eve-anderson`, `bob-jones`). Use a single-name slug (`bob`) ONLY when no lastname is known. As soon as a lastname surfaces, rename via `wiki mv bob bob-jones` — this preserves the old slug as an alias for autolink robustness.
- Disambiguate when two people share a name: `eve-anderson-corp1` and `eve-anderson-corp2`.
- Orgs: lowercase name with hyphens (e.g. `example-corp`, `example-school`).
- Decisions: prefix `decision-` (e.g. `decision-cursor-vs-vscode-2026-05-16`).
- Todos: prefix `todo-` (e.g. `todo-email-jane-friday`).
- Reserved: `index`, `log` (auto-maintained).
- Forbidden: see "Forbidden aggregator slugs" above.

When mentioning a person in body text, wikilink them (`[[firstname-lastname]]`) **if their page exists or you are about to create one with at least one independent fact**. A page must clear an information floor: ≥1 fact beyond the relation that triggered its creation. If you have no fact about a named person, mention them as plain text on the parent page (no `[[...]]`); when later context arrives, promote to a stub and back-edit the parent mention to a wikilink. This keeps the graph free of zero-content "named-but-empty" nodes that lint would flag as lonely and which restate the parent's relation without adding signal.

Heuristic: before wikilinking a name you're about to introduce, ask *"what one fact would I write on their page that isn't already implied by the relation linking to them?"* If you have nothing, don't wikilink — use plain text.

## Identity resolution — when two pages turn out to be the same

If you discover that two slugs refer to the same entity (e.g., `bob` and `bob-jones` after learning a lastname, or two stubs for the same person), use:

```
wiki merge <source> <target>
```

This:
- Rewrites every `[[source]]` and `verb [[source]]` reference across the vault to point at `target`
- Appends source's body under a `## Merged from <source>` heading in target
- Adds source's slug, title, and aliases as target aliases (so future `wiki resolve` and `wiki autolink` keep finding the merged identity)
- Merges tags as a union
- Deletes the source file

Always run with `--dry-run` first to preview. Never delete a duplicate manually — always merge.

## URL ingestion

To ingest a web page:

```
inbox ingest-url <url>
```

Fetches HTML, converts to markdown, applies secret-redaction, writes to `raw/clippings/<date>-<slug>.md` with provenance frontmatter (`source_url`, `final_url`, `content_type`, `sha256`, `ingested_at`), and queues it for processing. The agent then handles it like any other raw source via the standard ingestion workflow.

## Structured external-link fields for person entities

Person pages (`type: entity` with `tags: person`) may carry these optional frontmatter fields. Alfred populates them during enrichment; they surface in `wiki context` and are used to find re-ingestion targets later.

```yaml
homepage:  https://alice.example/        # personal/professional website
scholar:   https://scholar.google.com/citations?user=...
orcid:     0000-0001-2345-6789
github:    handle                            # GitHub username
linkedin:  https://linkedin.com/in/handle
twitter:   handle                            # without leading @
arxiv:     search-term-or-author-id          # arXiv search query
email:     someone@example.org               # use sparingly; private contact
```

These are stored as plain strings in frontmatter. Alfred should never invent values — only set them from confirmed sources (Alice's statement, a scholar profile we ingested, etc.).

## Auto-enrichment policy

By default, when Alfred creates a new person entity with **research/work tags** (`colleague`, `paper`, OR an explicit `researcher` flag in Alice's description), he should:

1. Run a small (1-2 query) web search for the person's professional profile (Scholar, homepage)
2. Ingest 1-3 highest-relevance URLs via `inbox ingest-url`
3. Extract bio/affiliation/recent papers/interests as observations on the entity page
4. Set the structured external-link fields above
5. Add `^[raw/clippings/<slug>]` provenance markers on each synthesized claim

**Do NOT auto-enrich** for these tags: `family`, `child`, `parent`, `spouse`, `sibling`, `household`, `friend`. These are private relationships; auto-crawling is invasive and likely yields wrong matches.

**Disambiguation gate**: if the web search returns multiple plausible matches (multiple people with the same name), Alfred must tell Alice and ask which one before ingesting.

**Depth limit**: max 3 URLs per person, single-hop only. Do NOT recursively crawl coauthors' pages.

## Events (calendar in the vault)

The vault is Alice's calendar. Each event is a `type: event` page with the following frontmatter:

```yaml
type: event
when: 2026-05-20T14:00          # required; YYYY-MM-DD for all-day, ISO8601 for timed
duration: 1h                    # optional; e.g. "30m", "1h", "2h30m", "all-day"
location: "Zoom"                # optional; free text or wikilink slug
attendees: [morgan-smith, carol-lee] # optional; list of entity slugs
recurrence: weekly              # optional; daily|weekly|monthly|yearly (informal)
tags: [event, work]             # required; combine `event` with context tag (work, family, health, travel, recurring)
```

Body: agenda, notes, decisions made, relations (`- met_with [[carol-lee]]`).

When to create an event page:
- Scheduled meeting, call, or appointment with specific time
- Trip with start/end dates
- Deadline (with `when` = deadline date)
- Recurring routine if vault-significant (weekly 1:1, monthly review)

Skip events for trivial recurring blocks (daily commute, lunch) — those are not graph-significant.

Listing events: `wiki agenda` (today/week/upcoming/past/all).

## Relation inverses (CLI-enforced symmetry)

Some relation verbs imply a reciprocal edge on the target page. `wiki groom` reads the two code blocks below and auto-adds the missing inverse where possible.

### Symmetric (self-inverse)

If `A` has `- verb [[B]]`, then `B` must have `- verb [[A]]`. The verb is the same in both directions.

```
spouse_of
partner_of
sibling_of
cousin_of
colleague_of
friend_of
collaborator_of
classmate_of
cofounder_of
met_with
```

### Inverse pairs (asymmetric)

If `A` has `- left [[B]]`, then `B` must have `- right [[A]]`. One pair per line, two verbs separated by whitespace.

```
parent_of            child_of
grandparent_of       grandchild_of
works_at             employs
employed_by          employs
student_of           advisor_of
postdoc_of           advisor_of
mentor_of            mentee_of
authored_by          author_of
reports_to           manages
co_supervisor_of     co_supervised_by
former_advisor_of    former_student_of
former_postdoc_of    former_advisor_of
teacher_of           taught_by
lives_at             residence_of
heads                headed_by
attends              has_student
adjunct_at           has_adjunct
```

Gendered family verbs (`son_of`, `daughter_of`, `mother_of`, `father_of`, `brother_of`, `sister_of`, `uncle_of`, `aunt_of`, `nephew_of`, `niece_of`, `grandfather_of`, `grandmother_of`, `grandson_of`, `granddaughter_of`) are intentionally **not** in the inverse-pairs table. Their inverse is ambiguous (the reciprocal could be gendered or neutral). `wiki groom` flags missing inverses for these as proposals, not auto-fixes. The neutral equivalents — `sibling_of` (symmetric), `parent_of`↔`child_of`, `grandparent_of`↔`grandchild_of`, `cousin_of` (symmetric) — are preferred when gender is irrelevant.

To add a verb pair, append it here. The CLI re-parses on every groom.

### One-way verbs (allowlist)

Verbs without a clean inverse but legitimate as standalone directional edges. The CLI uses this list to validate relation verbs on write (anything not in symmetric, inverse-pairs, gendered, or one-way is treated as an **invented verb** and rejected).

```
visited           stayed_at         founded           co_founded_by
created           cites             extends           inspired_by
about             attended          attended_by       mentions
supersedes        superseded_by     contradicts       refines
member_of         owns              gave_to           received_from
plays             planned_by        plans             from
born_in           died_in           located_in        part_of
near              instance_of       subclass_of       uses
depends_on        derived_from      authored          edited
reviewed          mentored

son_of            daughter_of       mother_of         father_of
brother_of        sister_of         uncle_of          aunt_of
nephew_of         niece_of          grandfather_of    grandmother_of
grandson_of       granddaughter_of  godparent_of      godchild_of
```

To add a verb, append it here.

## Event-keyword title regex (CLI-enforced)

The CLI rejects writes for pages whose title contains any of these words when `type ≠ event`. Add or remove freely.

```
trip  visit  meeting  call  interview  conference  deadline  holiday
vacation  wedding  funeral  appointment  surgery  exam  review  ceremony
launch  workshop  retreat  birthday  anniversary  celebration  dinner
lunch  party  flight  travel
```

The match is case-insensitive on word boundaries.

## Email digest (weekly routine)

`.bin/email-digest` sends a body (read from stdin) to a recipient via Gmail SMTP. Used by Alfred's weekly routine (see persona § Weekly routine).

Required env vars in the agent's container environment:

| Var | Value | How to obtain |
|---|---|---|
| `EMAIL_FROM` | `alice@example.com` | Alice's Gmail address |
| `GMAIL_APP_PASSWORD` | 16-char string | <https://myaccount.google.com/apppasswords> — requires 2FA enabled on the Gmail account first |

The app password is scoped to **SMTP-SEND only**: it authenticates against `smtp.gmail.com:465` and **cannot read mail**, list messages, or do anything else with the Gmail account. Distinct from full Gmail OAuth.

Usage:
```
echo "body" | .bin/email-digest --subject "Subject" --to "addr@example.com"
```

Exit codes: 0 success, 1 arg error, 2 missing env var, non-zero from `curl` on SMTP failure.

## Analytical view (DuckDB)

For ad-hoc questions that don't fit any CLI verb, `wiki sql "<query>"` exposes the vault as a SQL table. The DB at `.cache/vault.duckdb` (gitignored — derived data) is rebuilt lazily whenever any `wiki/*.md` mtime is newer than the DB. One row per page; the schema is:

| Column | Type | Source |
|---|---|---|
| `slug` | VARCHAR | filename minus `.md` |
| `title`, `type` | VARCHAR | frontmatter |
| `created`, `updated` | TIMESTAMP | frontmatter |
| `tags`, `aliases`, `supersedes`, `derived_from` | VARCHAR[] | frontmatter arrays |
| `n_facts`, `n_hypotheses`, `n_opinions`, `n_claims`, `n_relations` | BIGINT | body observation/relation counts |
| `raw_path`, `decided_on`, `source_file`, `status`, `due`, `when_` | VARCHAR | type-specific frontmatter |
| `mention_count` | BIGINT | inbound `[[slug]]` wikilinks across the vault |

Setup (one-time): `brew install duckdb` (host) or `apt install duckdb` inside the container. The CLI prints a friendly error if the binary isn't on PATH.

Use `wiki sql --schema` to introspect, `wiki sql --explore` for an interactive REPL.

## Measurement series (tabular time-series)

Time-series numerical data — growth curves, blood pressure logs, fitness/weight tracking, lab results — does **not** fit the observation-bullet model and must not live in wiki pages as hand-edited tables. Instead:

- The source of truth is a tab-separated file at `raw/measurements/<series>.tsv`. First row is the header (e.g. `date<TAB>age<TAB>height_m<TAB>weight_kg<TAB>bmi<TAB>source`); each subsequent row is one measurement. `date` (YYYY-MM-DD) is the primary key. `source` carries provenance.
- The matching wiki page (e.g. `wiki/<series>-growth.md`) is **auto-rendered** from the TSV. Its frontmatter declares `source_file: raw/measurements/<series>.tsv`. The body has an intro paragraph (hand-written, preserved on re-render) followed by `<!-- AUTO: regenerated from source_file — do not edit below -->` and the rendered table.
- New rows go in via `wiki measure <series> --date YYYY-MM-DD --field=value [...]`. The CLI appends to the TSV (sorted by date), re-renders the wiki page, and auto-derives `bmi` from `height_m`+`weight_kg`, `age` from a `--birth` flag, and `source` from the current date if omitted.
- `wiki patch` and `wiki write` **refuse** to operate on pages whose frontmatter has `source_file:`. The CLI prints the redirect message and exits non-zero. This is the structural lesson learned from the 2026-05-17 incident where `wiki patch maya-smith-growth --observation "..."` appended a malformed bullet underneath the existing table.

Use this pattern for any new tabular series. Create the TSV header first, then `wiki measure` from then on.

## JSON ingestion spec

The canonical entry point for new vault content is `wiki ingest --stdin` (or `--file <path>`), which takes a structured JSON spec and compiles it into pages. Alfred is expected to write JSON, not markdown directly.

A formal JSON Schema for this spec lives at `.bin/wiki-ingest.schema.json` — useful for IDE autocomplete and ahead-of-time linting. The CLI's imperative validator inside `wiki ingest` is authoritative; the schema file is documentation that must be updated in lockstep with the validator.

### Top-level shape

```json
{
  "source": "telegram:2026-05-17",     // required; stamped on every fact/etc if not overridden
  "msg_id": "<inbound-msg-id>",         // optional; if present, the spec + result are captured to
                                        // raw/telegram-replay/<YYYY-MM>/<msg-id>-{spec,result}.json
                                        // for use by `wiki replay`. Required for Telegram-triggered
                                        // specs so the case can be replayed against future pipeline.
  "stubs":    [/* stub specs */],       // optional; create-if-missing minimal pages
  "entities": [/* entity specs */],
  "events":   [/* event specs */],
  "patches":  [/* patch specs */]
}
```

### Stub spec

Minimal page; created only if slug doesn't exist.

```json
{"slug": "springfield", "title": "Springfield", "type": "entity", "tags": ["org"]}
```

### Entity spec

```json
{
  "slug": "bob-jones",
  "title": "Bob Jones",
  "type": "entity",
  "tags": ["person", "friend"],
  "facts":       [{"body": "...", "since": "2024-08", "tags": ["work"]}],
  "hypotheses":  [{"body": "...", "asOf": "2026-04"}],
  "opinions":    [{"body": "..."}],
  "claims":      [{"body": "...", "source": "raw/clippings/foo.md"}],
  "relations":   [{"verb": "works_at", "target": "example-corp"}]
}
```

Required: `slug`, `title`, `type`, `tags`, and ≥1 of (facts, hypotheses, opinions, claims, relations).
Date fields on observations: `since`, `until`, `on`, `asOf` (any subset). Empty string is treated as absent.

### Event spec

```json
{
  "slug": "trip-vietnam-2026-05",
  "title": "Trip — Atlantis, May 2026",
  "tags": ["event", "travel", "family"],
  "when": "2026-05-04",
  "duration": "5d",
  "location": "springfield",
  "attendees": ["alice", "morgan-smith", "maya-smith", "leo-smith"],
  "recurrence": "weekly",
  "facts":     [{"body": "...", "since": "...", "until": "..."}],
  "relations": [{"verb": "visited", "target": "springfield"}]
}
```

Required: `slug`, `title`, `tags` (must include `event`), `when`. The compiler enforces `type: event` automatically.

### Patch spec

Modifies an existing page.

```json
{
  "slug": "morgan-smith",
  "add_facts":      [{"body": "...", "asOf": "2026-05-17"}],
  "add_hypotheses": [...],
  "add_relations":  [{"verb": "from", "target": "springfield"}],
  "supersede":      [{"match": "<substring of old obs>", "replacement_fact": {"body": "...", "since": "..."}}]
}
```

### Validation + write semantics

The compiler validates the entire spec upfront. Any validation error halts before any page is written — no partial state is created from an invalid spec. Once validation passes, writes proceed best-effort, page by page: a runtime error on page #3 (e.g. disk full) does not roll back pages #1-#2. In practice, the upfront validation gate catches the failure modes that matter; runtime errors during writes are rare. Provenance is auto-stamped from `source` on every observation that doesn't already carry one. After all writes, bidirectional autolink runs on touched slugs; then `wiki audit` runs on each; result is returned.

### Validation edge cases

Three rules are enforced by the validator and easy to trip over the first time:

- **Self-relations are rejected.** An entity or event spec cannot have a relation whose `target` equals its own `slug` (e.g. `{slug: "alice", relations: [{verb: "knows", target: "alice"}]}` is refused). A page never relates to itself — model whatever you meant as an observation (`facts`/`hypotheses`/`opinions`) instead.

- **Fuzzy duplicate detection fires at confidence ≥ 0.7.** For every *new* slug in the spec (no existing file yet), the compiler runs `resolveSlugCandidates` on the spec's `title` against the existing vault. If any candidate scores ≥ 0.7, the write is refused with the suggestion to run `wiki resolve "<title>"` first. The threshold is hardcoded; lower it only by editing `DUP_THRESHOLD` in `bin/wiki`. The check is a duplication prevention guardrail, not a strict identity check — a high score means "you may be creating a near-duplicate," not "this *is* a duplicate."

- **`--allow-duplicates` bypasses the fuzzy check.** Use when the duplication is intentional (e.g. creating a person page whose name happens to overlap an existing slug). The flag turns off the entire fuzzy-duplicate pass for the whole spec; it does not affect any other validation. Slug-uniqueness within the spec (the same slug listed twice across `stubs`/`entities`/`events`) is still enforced.

## Frontmatter ordering

The CLI writes frontmatter in this order: `id, title, type, created, updated, tags`, then extras (`summary`, `aliases`, `status`, `due`, `decided_on`, `derived_from`, `raw_path`, `sha256`, `when`, `duration`, `location`, `attendees`, `recurrence`, etc.). Manual edits should preserve this for diff readability.

## Stable frontmatter contract

This table lists every frontmatter field the CLI actively reads. **`stable`** fields will not change shape or semantics without a `wiki migrate` step in the release that breaks them. **`experimental`** fields may change without notice; rely on them at your own risk. Fields not in this table are stored as-is but never inspected by the CLI — safe to add for your own use, ignored by every verb.

| Field            | Type        | Required for                | Read by                                | Status        | Notes                                                          |
|------------------|-------------|-----------------------------|----------------------------------------|---------------|----------------------------------------------------------------|
| `id`             | slug        | all pages                   | all verbs                              | stable        | Must equal filename basename (sans `.md`); slug regex enforced |
| `title`          | string      | all pages                   | all verbs                              | stable        |                                                                |
| `type`           | enum        | all pages                   | all verbs                              | stable        | Closed set: entity, concept, decision, source, synthesis, todo, note, event |
| `created`        | ISO date    | all pages                   | list, recent, audit                    | stable        | Writer-stamped on first write                                  |
| `updated`        | ISO datetime| all pages                   | list, recent, lint, audit              | stable        | Writer-stamped on every write                                  |
| `tags`           | string list | all pages                   | all verbs                              | stable        | Closed set; see "Tag taxonomy" section                         |
| `schema_version` | integer     | all pages (auto-stamped)    | migrate                                | stable        | Writer-stamps the current schema version; missing = v1 (pre-versioning). `wiki migrate` walks unversioned pages and stamps them. |
| `summary`        | string      | —                           | list, preview, index, context          | stable        | One-line description; falls back to first body line            |
| `aliases`        | string list | —                           | mv, merge, resolve, autolink           | stable        | Auto-populated by mv (old slug) and patch --title (old title)  |
| `source_file`    | string path | measurement-series pages    | patch (blocks), write (blocks), measure| stable        | Pages with this field are auto-rendered; direct write refused  |
| `derived_from`   | slug list   | type=synthesis              | write, audit                           | stable        | ≥2 entries required for synthesis type                         |
| `when`           | ISO date/dt | type=event                  | agenda, audit, event scan              | stable        | YYYY-MM-DD for all-day, ISO 8601 for timed                     |
| `duration`       | string      | —                           | agenda, event                          | stable        | Free-form: "30m", "1h", "2h30m", "all-day"                     |
| `location`       | string      | —                           | agenda, event                          | stable        | Free text or wikilink slug                                     |
| `attendees`      | slug list   | —                           | agenda                                 | stable        | List of entity slugs                                           |
| `recurrence`     | string      | —                           | agenda, event                          | stable        | Informal: daily, weekly, monthly, yearly                       |
| `status`         | enum        | type=todo                   | todo, list, sql                        | stable        | One of: open, doing, done, abandoned                           |
| `due`            | ISO date    | —                           | todo, agenda                           | stable        | YYYY-MM-DD                                                     |
| `priority`       | enum        | —                           | todo                                   | stable        | Free-form; convention: low / medium / high                     |
| `done_at`        | ISO datetime| —                           | todo                                   | stable        | Writer-stamped when status flips to done                       |
| `decided_on`     | ISO date    | type=decision               | write, list                            | stable        | YYYY-MM-DD                                                     |
| `supersedes`     | slug list   | —                           | write, lint                            | stable        | Decision that retires another decision                         |
| `raw_path`       | string path | type=source                 | write, audit                           | stable        | Relative path under `raw/`                                     |
| `sha256`         | hex string  | type=source                 | write                                  | stable        | Content hash of the raw source                                 |
| `ingested_at`    | ISO datetime| type=source                 | write                                  | stable        | When the source was first triaged                              |
| `kind`           | string      | type=source                 | write                                  | stable        | Free-form: clipping, paper, lab, transcript, ...               |
| `birth`          | ISO date    | measurement-series subjects | measure                                | stable        | Used to derive `age` column in growth-curve TSVs               |
| `homepage`/`scholar`/`orcid`/`github`/`linkedin`/`twitter`/`arxiv`/`email` | string | — | context, audit | experimental | Structured external links on person entities; see "Structured external-link fields" section |

Adding a new field that the CLI should read: list it here with `experimental` status, ship one minor version with that label, promote to `stable` next minor if no shape changes needed. Removing a field: deprecate in vX.Y (warn on use), remove in vX.(Y+1) with a `wiki migrate` step.

## Aliases

A page may carry an `aliases: [name1, name2]` frontmatter field. Aliases:
- Used by `wiki autolink` to detect mentions by variant names (e.g. "Mia" alias → resolves to `maya-smith`)
- Used by `wiki resolve <fuzzy>` to map fuzzy queries to slugs
- Auto-populated by `wiki mv <old> <new>` (old slug added as alias) and `wiki patch --title "..."` (old title added as alias)

## Summary field

A page may carry a `summary: "..."` frontmatter field — a single-line description for index/preview output. Set via `wiki patch --summary "..."`. If absent, the CLI falls back to the first non-heading body line.

## Placement-first protocol

Before creating any new page, the agent (and the user) should:
1. `wiki resolve "<title>"` — check if this concept already exists under a slight variation
2. `wiki place "<title>"` — surfaces existing matches, similar topics by tag/title, and suggested type/tags/anchors
3. If `wiki place` returns ≥1 match with confidence ≥ 0.7 → do NOT create new; use `wiki patch <existing-slug>` to add information instead
4. If no match → ok to create with `wiki write`, ideally including at least one relation in the body
5. After `wiki write`, run `wiki autolink <new-slug>` to inject bidirectional links and prevent orphans

The CLI emits an orphan-by-construction warning (does not reject) when a `wiki write` creates a page with no inbound or outbound graph connections.
