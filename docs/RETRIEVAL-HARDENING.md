# Retrieval hardening

Alfred's vault is useful only when capture and retrieval stay coupled. A clean
schema is not enough: the agent must retrieve the right page and the right
active observations for real questions, and must know when the vault does not
contain a confident match.

## Contract

For an agent-facing vault query, retrieval should:

- prefer exact title/alias/slug identity matches over pages that merely mention
  the term
- ignore superseded `~~...~~` observations by default
- expose confidence signals for weak lexical matches instead of treating every
  BM25 hit as answer-grade context
- surface ambiguous identity matches instead of silently choosing one
- preserve provenance markers in selected observation text
- remain deterministic, Markdown-first, dependency-light, and fast

## Commands

`wiki search <query> --explain`

Prints the normal search rows plus one diagnostic line per row:

```text
explain: via=content confident=yes reason=body-coverage coverage=0.67 threshold=0.50 matched=fisher missing=ronald
```

Use this when search results look surprising or when an answer depends on weak
topical retrieval. Normal search output is unchanged unless `--explain` is
present.

`wiki search <query> --require-confidence [--threshold 0.5]`

Filters out rows whose title/alias evidence is weak and whose query-word
coverage is below the threshold. This is intentionally opt-in until retrieval
evals calibrate thresholds on real vault questions.

`wiki eval-retrieval [--file path.json | --case JSON]`

Runs deterministic retrieval-quality checks against the real vault state. With
no arguments it reads `<vault>/alfred/retrieval-evals.json` if present.

Case shape:

```json
{
  "name": "identity-first",
  "question": "Ronald Fisher",
  "expectFirstSlug": "ronald-fisher",
  "expectSlugs": ["ronald-fisher"],
  "expectNotSlugs": ["wrong-page"],
  "expectContains": ["Statistician"],
  "expectNotContains": ["retired retrieval sentinel"],
  "expectConfident": true,
  "expectAmbiguous": false
}
```

Assertions are semantic rather than snapshots: they check selected slugs,
selected context text, confidence, and ambiguity. This keeps the eval stable
while allowing harmless formatting changes.

## Adding Good Eval Cases

Add cases for real retrieval failures, not theoretical coverage. The best cases
are:

- identity questions where title/alias should dominate mention frequency
- ambiguous one-word terms such as names, mathematical distributions, and short
  acronyms
- queries that must exclude retired observations
- off-domain questions that should produce no confident vault match
- recurring workflows such as open todos, upcoming events, predictions, and
  relationship/context questions

Avoid cases that assert a complete ranking unless ranking itself is the behavior
under test. Prefer `expectFirstSlug` plus a few inclusion/exclusion assertions.

## Design Boundary

This hardening layer deliberately does not add embeddings, a graph database, or
an OKF-style frontmatter triple model. Those would add operational complexity
before the lexical/title/alias/context pipeline has measurable failures. If a
future vector layer is added, it should be optional and should have eval cases
showing failures that lexical retrieval could not solve.
