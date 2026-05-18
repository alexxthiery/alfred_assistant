# example-vault — a 13-page demo

A self-contained vault you can run `wiki` commands against without standing up your own. Useful for kicking the tires before forking, or as a worked-example reference when reading `docs/SCHEMA.md`.

## What's inside

The 13 pages exercise every page type the schema supports (entity, source, concept, decision, event, synthesis, note, todo), plus the four cross-cutting features that distinguish this from a flat note pile: typed relations, microsyntax observations, source provenance, and stub-driven graph navigation.

| Slug | Type | What it demonstrates |
|---|---|---|
| `alice` | entity | A person page with observations (`[fact]` lines) and outbound relations (`spouse_of`, `mentored_by`). Most-linked node. |
| `morgan-smith` | entity | Alice's spouse. Mirrors the symmetric `spouse_of` relation. |
| `bob-jones` | entity | Person with an `alias` (`Bob`), referenced from the lunch event. Test bed for `wiki resolve` fuzzy matching. |
| `maya-smith` / `leo-smith` | entity | Children. Family-tree demo for `wiki path` and `wiki hubs`. |
| `example-school` | entity | An org node — `member_of` target for the family entities. |
| `lunch-2026-05-20` | event | An event page with `when:` ISO datetime and `attendees:` list. Demo for `wiki agenda`. |
| `spaced-repetition` | concept | A concept that other pages cite (`cites [[spaced-repetition]]`). |
| `paper-llm-wiki-2024` | source | A source-type page with `raw_path:` + `sha256:` provenance fields. The pointer is intentional even though `raw/` is empty — see `raw/README.md`. |
| `decision-vault-as-graph` | decision | A `[decision]` page with `decided_on:` and `derived_from:` fields. |
| `family-overview` | synthesis | A `type=synthesis` page that pulls in multiple atomic entity pages via `derived_from`. |
| `note-monthly-recap` | note | A long-form note. Tests the prose-vs-microsyntax distinction in autolink. |
| `todo-export-vault` | todo | An open todo with `due:` and `priority:`. Demo for `wiki todo list` and `wiki agenda`. |

## Try it

From the repo root, point `wiki` at this vault and run:

```sh
export WIKI_ROOT="$(pwd)/examples/example-vault"

bin/wiki list                            # every page, grouped by type
bin/wiki context alice                   # what links to / from alice
bin/wiki backlinks bob-jones             # inbound mentions
bin/wiki path alice leo-smith            # shortest path through the graph
bin/wiki audit --all                     # whole-vault quality report
bin/wiki agenda                          # upcoming events + open todos
bin/wiki resolve "Bob"                   # fuzzy match (finds bob-jones via alias)
bin/wiki preview paper-llm-wiki-2024     # show metadata + body summary
```

Mutating commands work too but will rewrite this vault — use a fresh copy first if you want to keep this one pristine:

```sh
cp -R examples/example-vault /tmp/playground
export WIKI_ROOT=/tmp/playground
bin/wiki write hello --title "Hello" --type entity --tags person --content "[fact] first page in /tmp/playground"
```

## What's NOT here

- `raw/` is empty — see `raw/README.md` for why and how to populate it in your own vault.
- `.git/` is absent; the example is a static snapshot. `bin/wiki` auto-commit (when enabled) is a no-op without a repo.
- The `inbox/` half of the pipeline is not exercised. The 13 pages are what `bin/wiki` produces *after* ingest; `bin/inbox` lives upstream of that.

## Files

```
.alfred.yml                  vault config (USER_NAME, paths, etc.)
SCHEMA.md                    the closed-set vocabulary this vault enforces
raw/README.md                why raw/ is empty
wiki/                        the 13 markdown pages
  alice.md
  bob-jones.md
  decision-vault-as-graph.md
  example-school.md
  family-overview.md
  leo-smith.md
  lunch-2026-05-20.md
  maya-smith.md
  morgan-smith.md
  note-monthly-recap.md
  paper-llm-wiki-2024.md
  spaced-repetition.md
  todo-export-vault.md
```
