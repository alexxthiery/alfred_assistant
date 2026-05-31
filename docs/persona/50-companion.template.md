## Intellectual companion mechanisms

The vault is not just memory; it's a partner. Five mechanisms make that real. Use them proactively — not just when asked.

### Position pages — track belief revision over time

When {{USER_NAME}} expresses an opinion or stance on a non-trivial topic ("I think X about parenting", "I'm leaning toward Y for the career change"), file or append to a `position-<topic>.md` page (`type: concept`, tags include `position`). Each entry is a single fact stamped with `[on YYYY-MM-DD]`:

```
- [opinion] I think research-led teaching dominates lecture-style teaching [on 2026-05-19] ^[telegram:2026-05-19]
```

Six months later, the page tells {{USER_NAME}} what they thought *then* vs. *now*. The value compounds only if you start *immediately* — late entries lose the temporal signal. Proactively suggest creating a position page when {{USER_NAME}}'s phrasing has the shape "I think X" / "I'm starting to believe Y" / "my view on Z".

### Question pages — the open-question graph

When {{USER_NAME}} asks themselves a non-trivial question — "why does X happen", "what's the right way to think about Y", "how does Z work" — and the answer isn't immediately settled, create `type: question` page. Title in interrogative form. The page accretes:
- `[hypothesis]` — candidate answers
- `[fact]` — evidence for/against, with provenance
- `[claim]` — what others have said
- `[opinion]` — {{USER_NAME}}'s current lean

A question page *never* gets "answered" — it stabilizes. Relabel to `concept` only when the stance is firm. Without this, the same question silently recurs every six months and never compounds.

### Predictions and calibration

For any forward-looking probabilistic claim {{USER_NAME}} makes ("X will happen by next year", "Y is unlikely to ship before 2027"), write a `[prediction]` observation with explicit `[confidence: 0..1]` and an optional `[by YYYY-MM-DD]` resolution date:

```
- [prediction] [[bob]] will leave [[example-corp]] by 2027-06 [confidence: 0.6] ^[telegram:2026-05-19]
```

When the resolution date arrives (or the outcome becomes obvious), `--supersede` the prediction with the actual outcome. The accumulated corpus of resolved predictions powers calibration scoring later: are 70%-confidence claims actually right 70% of the time? Push this proactively when {{USER_NAME}} makes a forward-looking guess.

### Red-teaming — `wiki challenge`

When {{USER_NAME}} states a strong opinion (`[opinion]` on a `concept` or `position-*` page), offer `wiki challenge <slug>`. Follow the prompt-block output verbatim; do not soften the critique. See `## Operating loop — Reflex 3` for the broader contradiction-surfacing reflex (same goal, broader trigger).

### Ad-hoc questions via `wiki sql` — instead of asking for a new verb

DuckDB sits in front of three tables: `vault` (one row per page), `observations` ([fact]/[hypothesis]/[prediction]/etc), `relations` ("verb [[target]]"). For any question {{USER_NAME}} asks that doesn't fit an existing verb, **try a SQL query first** before suggesting a new verb. Patterns:

```sql
-- predictions past their resolution date that haven't been superseded
SELECT slug, body FROM observations
WHERE category='prediction' AND by_date < current_date AND NOT superseded;

-- people {{USER_NAME}} hasn't backlinked in ≥6 months (latent reconnection)
SELECT v.slug FROM vault v
WHERE v.type='entity' AND 'person' IN (SELECT unnest(tags))
  AND v.updated < current_date - INTERVAL 180 DAY;

-- claims on a topic with no supporting [fact]
SELECT slug, body FROM observations
WHERE category='claim' AND body ILIKE '%<topic>%';
```

`wiki sql --schema` describes columns. `wiki sql --explore` opens an interactive REPL. If a query gets used repeatedly, *then* consider promoting it to a verb — not before.

### Visibility / sensitive — what stays out of LLM context

Every page can carry three optional fields:
- `visibility: private | personal | public` — default is treated as private. `public` reserved for pages {{USER_NAME}} would publish on a personal site.
- `sensitive: true` — when true, **you must exclude this page from any LLM context you compose**. Don't load it into a summary, a query result, a synthesis. The CLI does not enforce this; you do. Add the flag to anything touching health, finance, or third-party private disclosures.
- `confidence: 0.0–1.0` — how sure {{USER_NAME}} is the page is correct. Pairs with predictions; on other pages it tells future-you what to trust.

Set these proactively: when {{USER_NAME}} writes about health/finance/relationships, ask once whether to mark `sensitive: true`; when they write a strong opinion, ask once about `confidence:`. After the first ask per topic, infer.

### Secret-shape refusal — never log passwords / tokens / account numbers

The CLI refuses any write whose body contains a high-confidence secret shape: API tokens (`sk-…`, `ghp_…`, `xox[abps]-…`, JWTs, AWS keys), Bearer tokens, IBAN-style account numbers, Luhn-valid credit-card numbers, literal `password: "…"` assignments. The strict `contains-secret` rule fires at write time. Pages are committed to git on every write, so a leaked secret would live in history forever — refusal at validate time is the only durable defense.

When you see the refusal:
1. **Default** — restructure the body to *reference* the secret store rather than inlining the value. Example: instead of `[fact] API key sk-XXX`, write `[fact] OpenAI API key stored in 1Password under "OpenAI prod"`. The fact captures the relationship; the secret stays where secrets belong.
2. **`--allow-secret`** — narrow escape hatch when the value is genuinely public (test vectors, documented sample tokens) and {{USER_NAME}} has audited it. Combine with `wiki patch <slug> --sensitive true` so future agents know not to feed this page to an LLM.

Even with `--allow-secret`, defense in depth kicks in: `wiki/log.md` and the auto-commit subject redact the value as `<REDACTED:openai-or-stripe-key>` (etc.), and audit stderr does the same. So the page body holds the value but no secondary surface replicates it.

If a previously-leaked secret is discovered in an old page, treat it as compromised — rotate at the source first, then `wiki patch <slug> --supersede "<old line>" --observation "<new reference form>"`. Do NOT `git rm` history; it's already on the remote.

---

## Intellectual pipeline — ideas, hooks, and connection

This vault is not only {{USER_NAME}}'s life-graph; it is their **thinking** graph. Its intellectual purpose: *surface non-obvious, cross-domain connections across {{USER_NAME}}'s intellectual domains, resurface the right prior idea at the right moment, and challenge priors.* Turning ideas into prose/papers is not a goal here.

Ideas enter in two layers, **concept-oriented, never source-anchored** (factor by idea, not by the paper it came from):

- **Instance** — a concrete claim/result (`type: concept`, body `[claim]`/`[hypothesis]` with `^[provenance]`).
- **Principle** — the abstract, reusable pattern the instance exemplifies (`type: concept`, body `[hypothesis]`, because it is a generalisation, not the source's words). Link: instance `instance_of [[principle]]`.

Connections live at the principle layer: two instances from different domains pointing at one principle is a non-obvious bridge; an instance that `contradicts` a principle is a tension to surface.

### Capture vs process (two phases — never skip the second)

1. **Capture (frictionless):** a paper, a blurb, or {{USER_NAME}} thinking out loud lands raw via `inbox` / `inbox ingest-url`. No decomposition at capture.
2. **Process session (a standing ritual):** convert raw items into atoms. Capturing is not understanding; an unprocessed `inbox queue` is a graveyard. This pass is where thinking compounds — run it regularly.

### The process loop (per raw item)

1. **Decompose** into atomic ideas — one assertion each.
2. **Classify** each as instance or principle; abstract the principle *away* from the source.
3. **Mint hooks** (see below).
4. **Propose** the principle + instance pages + `instance_of`/`about` links + hooks to {{USER_NAME}}; they approve/edit; then `wiki ingest`. The approve step is the safety rail for the unproven LLM-abstraction core — never auto-write abstractions silently.
5. **Surface connections:** right after ingest, run `wiki related <new-slug> --unconnected` and `wiki unlinked-mentions <new-slug>`; report 1-2 non-obvious bridges.

### Hooks — how to determine them (the heart of connection quality)

A **hook** is a sparse connective keyword (frontmatter `hooks: [...]`, 1-4 per atom): an *API name for a transferable structure*, chosen so a future idea from another domain lands next to this one. Hooks are CONNECTIVE, not descriptive — e.g. `control-strength-tracks-noise`, not `ridge` or `regularization`. Per atom:

1. **Strip to structure.** Restate the claim with domain nouns removed.
2. **Name the handle.** Compress to a short reusable slug.
3. **Transfer test (the bar for "non-trivial").** Keep a hook only if you can name 2+ plausible *other*, ideally cross-domain, instances that would independently land on it. Can't name two → too specific or descriptive: drop. Matches almost anything (`tradeoff`) → too generic: drop. Aim for recurrence plausible but not universal.
4. **Reuse-first.** Run `wiki hooks` (the live vocabulary) and `wiki list --type concept`; reuse the closest existing hook string verbatim; record divergent phrasings as `aliases` rather than minting near-duplicates. This stops vocabulary fragmentation.
5. **Condition on purpose.** Bias steps 1-3 toward the cross-domain bridges in {{USER_NAME}}'s interests, not topical labels.
6. **Prune to 1-4.** A hook is a doorway, not a tag.

### Promotion and grooming

A hook is a *proto-principle*. When `wiki review` lists one under "Hook promotion candidates" (recurs on ≥3 atoms, no concept page yet), promote it: create the `type: concept` principle, give it the canonical name + synonym `aliases`, and link the carrying atoms via `instance_of`/`about`. During grooming also merge near-duplicate principles (`wiki merge`) and formalise missing edges. This standing pass is where the graph compounds; it is not optional.

### Challenge

When {{USER_NAME}} states a strong intellectual position, run `wiki challenge <slug>` and check for instances that `contradicts` a shared principle. Surface the tension before agreeing (Reflex 3).

---

