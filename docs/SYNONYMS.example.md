# Synonyms for BM25 query expansion

`wiki search` reads `<vault-root>/SYNONYMS.md` (if present) at query time and expands each query token by its synonyms before passing the result to DuckDB's FTS BM25 ranker. Closes the paraphrase gap without an embedding model.

Copy this file to `<vault-root>/SYNONYMS.md` and edit. Both `wiki search` and any verb downstream that calls `expandQuery` will pick it up automatically.

**Scope (what belongs here vs. not).** This file is for *generic single-word paraphrases* where there is no concept page to anchor the term (`doctor = physician`, `teacher = instructor`). You do **not** need to add synonyms for concept pages: `wiki search` already indexes every page's title + `aliases` and resolves any of those surface forms (including multi-word aliases like "Markov chain Monte Carlo") to the page automatically, so your concept vocabulary grows with the vault, hands-off. Reach for `SYNONYMS.md` only to bridge query terms that no page's aliases cover.

## Format

Line-oriented, intentionally minimal:

```
# comments start with #
key = syn1, syn2, syn3
```

- One key per line. Keys are lowercased on parse; lookup is case-insensitive.
- Synonyms are comma-separated, trimmed, lowercased.
- Blank lines and comment lines are ignored.
- Lines without an `=` are silently skipped (better to drop a typo than refuse the whole file at startup).

## How expansion works

`expandQuery("school visit", { school: ["class", "classroom"], visit: ["trip"] })` produces the flat string `school class classroom visit trip`. DuckDB's `match_bm25` tokenises this as a bag-of-tokens and ranks docs by aggregate relevance to any of the terms.

There is no boolean syntax — BM25 isn't a boolean retrieval primitive. Order within the expansion doesn't matter.

## Example entries

Replace these with synonyms relevant to your own vocabulary. Five seed entries to start:

```
# personal-vault paraphrase pairs

school = class, classroom, kindergarten, daycare
doctor = physician, GP, paediatrician, dentist
trip = travel, journey, vacation, visit
research = study, investigation, analysis, paper, finding
deadline = due, due-date, target, by-date, cutoff
```

## Maintenance

The synonyms file is a personal vocabulary cheat-sheet, not a thesaurus. Add an entry when you notice a search miss caused by terminology drift (you searched "physician", but the page says "doctor"). Remove entries that bias retrieval the wrong way.

A future audit rule could surface "common words appearing in many observations with no synonym entry" as suggestions — deferred work, not load-bearing.
