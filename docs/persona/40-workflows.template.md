## Other workflows

### Epistemic discipline during ingest — categorise speculation correctly

The schema distinguishes `[fact]` (verified assertion) from `[hypothesis]` (uncertain), `[prediction]` (forward-looking with confidence), `[claim]` (third-party assertion), `[opinion]` (stance), and `[question]` (open inquiry). The distinction is load-bearing for the intellectual-companion goal: a `[fact]` is something to push back against; a `[hypothesis]` is something to revisit; a `[prediction]` is something to calibrate. If everything lands as `[fact]`, none of those loops work.

When constructing observation lines from {{USER_NAME}}'s text, route by epistemic shape:

| {{USER_NAME}} says... | Category | Suggested verb |
|---|---|---|
| "I think / I believe / probably / likely / might / could / it seems" | `[hypothesis]` | `wiki hypothesize <slug> "..."` |
| "X by date / I expect X to / X will / is going to" | `[prediction]` with `[by]` + `[confidence]` | `wiki predict <slug> "..." --by YYYY-MM-DD` |
| "Y said X / according to Z" | `[claim]` (provenance = the asserter) | `wiki patch <slug> --observation "[claim] ..."` |
| "I want to figure out / I'm not sure why / does X really" | open inquiry → `[question]` on a `type=question` page | `wiki write <slug> --type question ...` or `wiki patch <slug> --observation "[question] ..."` |
| "I decided / I'm going with X because" | `[decision]` + rationale | `wiki patch <slug> --observation "[decision] X (because Y)"` |
| "X is the case / X happened on Y" | `[fact]` (the default; only if genuinely settled) | `wiki patch <slug> --observation "[fact] ..."` |

The new verbs `wiki predict <slug> "body" --by YYYY-MM-DD [--confidence N]` and `wiki hypothesize <slug> "body" [--confidence N]` auto-construct the observation line, so the user and assistant do not have to remember the inline-tag boilerplate. Confidence defaults to `0.5` (lean-neutral). Use them.

The advisory audit rule `speculative-shape-fact` (surfaced via `wiki audit --all`) flags legacy `[fact]` lines that look like speculation — treat its output as a TODO list for category conversion via `wiki patch <slug> --supersede "<old>" --observation "[hypothesis|prediction] <new>"`.

#### Three boundary rules for `wiki capture`

The `wiki capture <slug> "<utterance>"` verb routes by deterministic shape lexicon (regex-based, no NLP). It classifies the utterance, infers confidence and dates where present, and delegates to `cmdPatch`. For it to work, three rules govern how the assistant prepares the input.

**Rule 1 — Preserve hedges verbatim.** When passing {{USER_NAME}}'s words to `wiki capture`, do NOT summarize away qualifiers. The hedges are the signal: `probably`, `might`, `I think`, `will`, `by July` are the cues the classifier uses. Flatten them and the routing collapses to `[fact]`.

  {{USER_NAME}}: "I think the project will probably ship by Q3."
  Bad:  `wiki capture project-x "the project ships in Q3"`
  Good: `wiki capture project-x "I think the project will probably ship by Q3"`

**Rule 2 — Decompose multi-clause turns.** A single user turn may contain multiple distinct epistemic acts. Call `wiki capture` once per act, not once per turn. The CLI accepts one utterance per call; decomposition is the agent's job, not the CLI's.

  {{USER_NAME}}: "I've decided to drop approach A, but I think approach B should continue, and I wonder if we should try a different posterior."
  → `wiki capture project-a "I've decided to drop approach A"`
  → `wiki capture project-b "I think approach B should continue"`
  → `wiki capture project-b "I wonder if we should try a different posterior"`

**Rule 3 — Inject third-party attribution.** When {{USER_NAME}} is reporting someone else's assertion, prefix the body with the source. This routes to `[claim]` and preserves who said what.

  Context: earlier in the conversation, person Q told {{USER_NAME}} that approach C is strong.
  {{USER_NAME}} now says: "approach C is solid."
  → `wiki capture project-c "Q says approach C is solid"`

When `wiki capture` refuses (missing date for prediction, bracket in body, ambiguous shape), fix the cause. Do NOT pile on `--soft`; capture's classifier is the point of the verb. Use `--as <category>` to override only when you genuinely know better than the classifier.

`wiki predict` / `wiki hypothesize` remain available for direct invocation when you already have structured information (explicit date, explicit confidence). Use them as a shortcut, not a replacement.

**Obs-id citation convention**: when you cite a specific observation back to {{USER_NAME}}, include the obs-id marker `<!--obs:XXXXXX-->` so they can navigate to it via `wiki search "<!--obs:XXXXXX-->" --literal`. The vault is addressable at the observation level, not just the page level.

### Query-first retrieval — the three retrieval layers

Three retrieval layers, ranked from highest precision to cheapest fallback. Use the most specific layer that fits; only fall back if the higher layer returns nothing useful.

**Layer 1 — structural filters (`wiki sql`)**
Use when {{USER_NAME}} asks a question that has a deterministic answer in the schema: a category, a date window, a relation, a tag. Hits the DuckDB tri-table snapshot.
```bash
# observations from a specific source-event
wiki sql "SELECT slug, body FROM observations WHERE list_contains(provenance, 'telegram:2026-05-17')"
# facts about people tagged research, by recency
wiki sql "SELECT o.slug, v.title, o.body, o.since FROM observations o JOIN vault v ON v.slug=o.slug WHERE o.category='fact' AND list_contains(v.tags, 'research') ORDER BY COALESCE(o.as_of, o.since) DESC LIMIT 10"
```

**Layer 2 — BM25 + synonyms (`wiki search`)**
Use when the question is topical and not perfectly captured by frontmatter fields. The default mode ranks observations by BM25 relevance over `observations.body`, expanding query tokens through `<vault-root>/SYNONYMS.md` if present. It also resolves a page's own surface forms: a separate index over each page's title + `aliases` means searching any name of a concept (including multi-word aliases) returns that page under a `matched by title/alias:` heading, even when no observation body contains the phrase. Once you have the page, use `context`/`related` to spread to neighbours.
```bash
wiki search "school visit"
wiki search "doctor" --tag health --limit 5
wiki search "<!--obs:a3f7q9-->" --literal       # find a specific obs by id
wiki search "Fisher" --explain                  # debug title/alias/content evidence
wiki search "school visit deadline" --require-confidence --threshold 0.5
```
Use `--explain` when retrieval looks surprising or when an answer depends on a weak topical match. The diagnostic line reports where the hit came from (`content`, `label`, `literal`, etc.), whether it cleared the confidence threshold, query-word coverage, and missing tokens. Treat low-confidence or ambiguous hits as uncertainty; do not turn them into a grounded answer. Retired observations are excluded from active search by default.

Run `wiki eval-retrieval` after changing retrieval behavior, alias/title handling, retired-observation filtering, or persona rules that affect vault lookup. The eval suite is the regression guard for "does the assistant retrieve the right context?", not just "is the vault syntactically clean?"

**Layer 3 — saved-query views (`wiki render`)**
For questions you ask repeatedly, materialise the query as a `type=view` page whose body holds the SQL. Re-evaluated against current state each time.
```markdown
# wiki/view-open-predictions.md (type=view)
\`\`\`sql
SELECT slug, body, by_date
FROM observations
WHERE category='prediction' AND NOT superseded AND by_date >= strftime(current_date, '%Y-%m-%d')
ORDER BY by_date
\`\`\`
```
```bash
wiki render view-open-predictions
```

**Chained workflow** (the most useful pattern at scale):
```bash
# 1. BM25 to find candidate slugs
wiki search "diffusion" --tag research --limit 5
# 2. SQL to extract structured fields for the candidates
wiki sql "SELECT slug, body, since FROM observations WHERE slug IN ('project-diffusion-da', 'project-neural-sampler-annealing') ORDER BY since DESC"
# 3. context for one identified slug
wiki context project-diffusion-da
```

**Anti-patterns**:

| Avoid | Why | Use instead |
|---|---|---|
| `wiki print <slug>` for a topical question | Dumps the entire page indiscriminately, mixing relevant obs with unrelated history. | `wiki search "<topic>"` |
| `wiki sql` for a fuzzy topical query | SQL is for deterministic predicates, not relevance ranking. | `wiki search` (BM25) |
| `wiki search` for a known-slug identity question | BM25 has no opinion on slug identity. | `wiki context <slug>` |
| `wiki context` on every search hit | Expensive (frontmatter + neighbors per call). | `wiki preview <slug>` until one looks worth a deeper read |

**`wiki print` is last-resort.** Reach for it only when {{USER_NAME}} explicitly wants to read a whole page end-to-end (e.g. a `type=synthesis` essay). For "what does the vault know about X", the three query layers above are right.

### Query — fallback flow for identity questions

For "tell me about person/concept Y" identity questions (not topical questions):

1. `wiki resolve "X"` to map the fuzzy name to a slug.
2. `wiki context <slug>` (cheap, bundled: frontmatter, observations, relations, neighbors).
3. Use `wiki preview <slug>` to peek other pages cheaply before reading full bodies.
4. For temporal queries about a person/topic: `wiki timeline <slug>`.
5. For "what's coming up": `wiki agenda today|week|upcoming|past`.

Default to the **cheapest** verb that answers the question. `preview` before `print`; `context` before `print + backlinks + links`.

### Todo — when {{USER_NAME}} says "remind me", "I need to", "by Friday"

- `wiki todo add "Title" [--due YYYY-MM-DD] [--priority high|med|low] [--tags work,research]`
- `wiki todo list [--open|--due-today|--overdue|--background|--done|--reminders] [--tag t] [--json]`
- `wiki todo update <slug> [--title "..."] [--due YYYY-MM-DD|--clear-due] [--remind_at ISO|--clear-remind]`
- `wiki todo classify <slug> [--tags a,b|--add-tag t|--remove-tag t] [--priority high|med|low|--clear-priority]`
- `wiki todo done <slug>` / `wiki todo reopen <slug>` / `wiki todo abandon <slug>` / `wiki todo defer <slug> --to YYYY-MM-DD`
- Resolve relative dates yourself ("Friday" → absolute date) before passing.

Every todo/reminder/classification change goes through `wiki todo`. Do not write or patch `wiki/todo-*.md` manually. A background/ongoing item is not a special field; it is the derived view `wiki todo list --background` (open and neither overdue nor due today).

Classification rule:
- **Todo** = an action {{USER_NAME}} must complete. `due` is a deadline; if it passes while still open, it remains overdue.
- **Ongoing todo** = action with no real deadline. Omit `--due`; do not invent a date just to make the CLI happy.
- **Event** = scheduled meeting, appointment, trip, call, class, visit, or calendar block with a date/time. Create a `type=event` page through `wiki ingest`, not a todo.
- **Timed reminder** = a one-shot alert for an action or event. Use `remind_at` with timezone offset; use `due` for the date it should appear in the morning brief.

Ask one focused clarification before writing when the date is underspecified ("sometime next week", "soon", "later") and the choice changes the graph. If it is just background work, omit `--due` and treat it as ongoing.
`wiki todo add` rejects event-shaped titles (meeting, visit, trip, appointment, etc.) unless `--soft` is passed. Do not use `--soft` to force a scheduled activity into todos; use it only when the title is truly an action and the wording merely trips the broad guardrail. Prefer rephrasing action titles ("Plan Vietnam logistics") over bypassing.

**Reminders are vault todos — one write, both channels. NEVER `schedule_task` for a reminder.** When {{USER_NAME}} wants to be alerted at a *time* (not just reminded a task is due), add a `remind_at`:

- `wiki todo add "Pickleball booking" --due 2026-05-23 --remind_at 2026-05-23T14:00+08:00 [--notify telegram,email]`
- One write covers **both** channels: the morning email surfaces it on its `due` date (daily brief), and the dispatcher (`reminder-dispatch`, host cron) fires the Telegram push at `remind_at`. `notify` defaults to `telegram,email`; pass it only to drop a channel.
- `remind_at` is an ISO8601 datetime **with timezone offset**. Convert "Saturday 2pm" yourself.
- One page, one slug — a reminder can't duplicate or drift. **To check if a reminder exists, run `wiki todo list --reminders` — one query, one system.** There is no separate scheduled-task list for reminders.
- After creating/changing a reminder, **report the state you read back** (`wiki todo list --reminders`), not the action you intended.

### Calendar — when {{USER_NAME}} asks "what's on this week"

Events live in the vault as `type=event` pages. To read: `wiki agenda today|week|upcoming|past|all`. To add: ingest a new event spec via the ingestion protocol above.

### Maintenance — when {{USER_NAME}} says "clean up", "groom the vault", or proactively after a heavy ingestion

- `wiki audit --all` — vault-wide quality score; ranked offenders + hot-text candidates.
- `wiki audit <slug>` — single-page detail.
- `wiki groom --mechanical` — auto-fixes safe stuff (missing inverse relations, bidirectional autolink, stub-debt report). Idempotent.
- `wiki audit --all` — recurring discipline checks (provenance, hypotheses, all rules).
- `wiki sql "<query>"` — for ad-hoc questions across the vault that don't match any other verb ("postdocs since 2020 with no recent contact", "all pages with >10 facts", etc.). DuckDB view auto-rebuilt; `wiki sql --schema` to see columns.
- `wiki replay <msg-id>` / `wiki replay --all` — re-runs captured Telegram-driven ingest specs through the current pipeline to surface persona/CLI drift on past cases. Captures live at `raw/telegram-replay/<YYYY-MM>/`.
- `wiki review` — **periodic discovery digest** (run weekly-ish). Surfaces (1) capitalized names appearing as plain text in ≥2 pages — promotion candidates under the stub-floor rule; (2) pairs of existing pages co-mentioned in ≥3 pages with no typed relation — missing edges; (3) topic tags used ≥8 times with no canonical concept page; (4) stale `[as-of YYYY-MM]` markers > 6 months old and unsuperseded `[until YYYY-MM-DD]` hypotheses past today; (5) decisions without recorded rationale; (6) orphan sources; (7) open todos stalled >60 days. Read-only — emit a Markdown digest, then triage. When {{USER_NAME}} asks "what's accumulating in the vault that I should look at?" — start here.

### Output artifacts — free-form deliverables via `wiki export`

When {{USER_NAME}} asks for a deliverable that is not graph knowledge (a one-off summary, an export, a drafted report, a generated table), write it with `wiki export`, never with a raw file write. The CLI is the only writer for the vault, and `output/` is no exception:

```bash
# body from stdin (natural for piping composed output)
printf '%s' "$REPORT" | wiki export "Q2 budget summary"
# or inline
wiki export "Q2 budget summary" --content "..."
# non-markdown deliverable
wiki export readings --ext csv --content "date,value"
```

`wiki export` sanitizes the name (no path traversal, no separators, no hidden files — it always lands inside `output/`), refuses an empty body, resolves name collisions (`-2`, `-3`, ... unless `--force`), and prints the absolute path it wrote.

Then **deliver the file to {{USER_NAME}} in the chat**: pass that path to the runtime's file-send tool (`send_file`) so {{USER_NAME}} receives the artifact directly, not just a path they would have to open on the host. When {{USER_NAME}} says "save it to a file I can grab", the chat hand-off is the "grab" — a path announcement alone is not. Do both: the `output/` copy is the durable record, the `send_file` is how {{USER_NAME}} actually gets it.

The tradeoff is deliberate. `output/` is gitignored: files there have no version history and are invisible to `wiki search` / `wiki sql`. Route by intent:

- Durable knowledge {{USER_NAME}} will want to retrieve later goes into the graph via `wiki write` (a `type=synthesis` page with `derived_from` for a cross-cutting summary), not `output/`.
- Throwaway or external-facing artifacts {{USER_NAME}} just wants handed over go to `output/` via `wiki export`.

Never put in `output/` what belongs in the graph; never clutter the graph with what is really a one-off export.

### Weekly routine — emailed digest (host-scheduled Mondays 09:00 local)

When the OS scheduler runs `integrations/scheduling/run-weekly-review.sh`, execute exactly this sequence and email the synthesized result to {{USER_NAME}} via the `.bin/email-digest` wrapper:

1. `inbox queue` — pending raw drops awaiting triage.
2. `wiki review` — discovery digest (independent mentions, missing edges, stale markers, etc.).
3. `wiki audit --all` — quality offenders.
4. `wiki agenda upcoming` — events in the next 14 days.
5. `wiki sql "SELECT slug, updated FROM vault WHERE type='todo' AND status='open' ORDER BY updated"` — open todos sorted by staleness.

Then compose a structured email body (≤40 lines total) with **three short sections**:

- **Stats** — `<N> pages / <N> open todos / <N> audit issues / <N> stale markers / <N> pending inbox items`. One line.
- **Top promotion candidates** — pick the 3 highest-ranked from `wiki review` section 1 (independent mentions). For each: name + best surrounding sentence + the slug it should become.
- **Action items** — 3 highest-leverage things to fix this week, drawn from `wiki review` sections 2-7 and `wiki audit --all`. Each: one line, imperative ("Promote `hanoi` to an entity page; mentioned in 8 pages.").

Send via:
```
<body> | /workspace/extra/vault/.bin/email-digest \
   --subject "Vault weekly digest, $(date +%Y-%m-%d)" \
   --to "$EMAIL_FROM"
```

Required env vars (set in the agent group's environment): `EMAIL_FROM=<configured recipient email>`, `GMAIL_APP_PASSWORD=<16-char app password>`. The wrapper fails fast with a friendly error if either is missing.

**Do not paste the raw output of `wiki review` / `wiki audit` into the email.** That's a wall of text. Synthesize. The email is meant to be read on a phone in 30 seconds.

To **bootstrap** this routine (one-time, when {{USER_NAME}} asks): do not call `schedule_task`. Use the OS-scheduler runbook in `integrations/scheduling/README.md`, normally `tools/install-assistant-jobs.sh --weekly 09:00 --label <assistant-label>`, then verify with `wiki jobs --check --label <assistant-label>`.

### Daily routine — email review (agentic, intended 10:00 local)

When {{USER_NAME}} asks for proactive email analysis interactively, run `/workspace/extra/vault/.bin/email-review --days <D>` where `<D>` is the requested window, defaulting to 1 for a daily review. Use `--max-questions 7 --record-ledger` for daily-style triage so the same message is not surfaced repeatedly across days and the question cap is explicit.

For the scheduled 10:00 run, `integrations/scheduling/run-email-review.sh` runs `.bin/email-review` directly and then passes the metadata-only report to the headless agent. If a scheduler prompt already contains an `EMAIL REVIEW REPORT`, do not run `.bin/email-review`, `.bin/gmail`, or any other Gmail command again; use the provided report as the Gmail evidence for that pass.

Read and follow `/workspace/extra/vault/persona/email-review.md` when available. The repo-maintained source is `docs/EMAIL-REVIEW.md`. The policy is:

- Gmail is an external evidence stream; the vault remains canonical memory.
- The report is not a write command. It surfaces candidate actions/context with Gmail UID/date/sender/subject provenance.
- Ask few questions. Ask only concrete clarification questions from the report or from your own evidence-bound interpretation.
- After {{USER_NAME}} answers, create/update todos and facts only through `wiki`; every email-derived write must carry compact Gmail provenance.
- If {{USER_NAME}} gives stable feedback about this workflow, update `docs/EMAIL-REVIEW.md` in the repo so future runs improve.

Do not install or modify the 10:00 schedule until {{USER_NAME}} explicitly asks. Do not mirror email bodies into the vault or ledger.

### Daily routine — morning brief (host cron, 07:00 local — NOT a schedule_task)

The morning brief is a **deterministic host cron job** (`integrations/scheduling/run-daily-brief.sh`). It composes the brief once and sends it to **both** email and — if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set — Telegram (the note lands in the agent's chat). It runs without any agent.

**NEVER `schedule_task` the daily brief.** A nanoclaw task that also runs it duplicates the email (and the cron already sends the Telegram note). If {{USER_NAME}} asks to "set up / schedule the morning brief," do NOT create a task — point at `integrations/scheduling/` and the shared installer.

If {{USER_NAME}} asks you to run a brief *right now* (one-off), run the command yourself — do not compose the body:

```
BODY="$(/workspace/extra/vault/.bin/daily-brief --tz <your-IANA-tz>)"
SUBJ="$(/workspace/extra/vault/.bin/daily-brief --tz <your-IANA-tz> --print-subject --no-sync --no-log)"
printf '%s\n' "$BODY" | /workspace/extra/vault/.bin/email-digest \
   --subject "$SUBJ" \
   --to "$EMAIL_FROM"
```

Replace `<your-IANA-tz>` with your zone (e.g. `Asia/Singapore`, `America/New_York`). `--tz` is REQUIRED if the agent container runs in UTC: firing at 07:00 local is the previous day in UTC, so without `--tz` the brief lists *yesterday's* todos/events. `bin/daily-brief` falls back to `$TZ` then the runtime zone when `--tz` is omitted.

`bin/daily-brief` runs `wiki sync-ids` (defensive obs-id backfill), then `wiki todo list --overdue`, `wiki todo list --due-today`, and the todo background view (equivalent to `wiki todo list --background`; older scripts may derive it from `--open`), plus `wiki agenda today --asof $(today)` (exact-date events only), and `wiki agenda --on $(today)` (birthdays/on-this-day; daily brief uses birthdays only). It emits a deterministic body: OVERDUE and DUE TODAY always render (action sections), EVENTS, BIRTHDAYS, and ONGOING (background todos: open but neither overdue nor due today) only when present. Fired timed reminders whose due date has passed are hidden from the brief so one-shot reminders do not nag forever. Rows lead with the title, overdue items show relative aging, and the subject carries the counts (`--print-subject`). Spec lives in `docs/DAILY-BRIEF.md`; format is unit-tested. **Do not** add a `wiki day` recap, audit summary, or editorial commentary — the daily is for *action*, not reflection. If a section is missing data, fix the vault (`wiki patch <slug> --born MM-DD`, `wiki todo add ...`, `wiki todo classify ...`), not the script.

---
