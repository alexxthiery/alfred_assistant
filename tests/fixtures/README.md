# Fixture suite

Integration tests for `bin/wiki`. Each fixture spawns the real CLI against a fresh copy of `tests/vault/` and asserts on stdout, exit code, and (optionally) the resulting page files.

Run the whole suite:

```sh
bin/wiki-test            # direct invocation
npm run test:fixtures    # via package.json (same thing)
npm test                 # unit tests + fixture suite
```

## Fixture format

Two shapes. Both live as `<name>.json` paired with `<name>.expected.json`.

### CLI shape (cmd-based)

For verbs other than `ingest`. The fixture lists the arg vector; the runner invokes `node bin/wiki <args>` in a fresh temp vault.

```json
// resolve-fuzzy.json
{ "cmd": ["resolve", "Markov chain Monte Carlo"] }
```

```json
// resolve-fuzzy.expected.json
{
  "exitCode": 0,
  "stdoutContains": ["mcmc"]
}
```

Optional `setup` array runs `wiki <args>` steps before the main `cmd` — useful for arranging vault state.

### Ingest shape (source-based)

For `wiki ingest` specs. The fixture is a literal ingest spec; the runner pipes it to `wiki ingest --file <fixture>`.

```json
// new-person-with-stubs.json
{
  "source": "telegram:2026-05-17",
  "stubs": [/* ... */],
  "entities": [/* ... */]
}
```

Distinguished by the presence of a top-level `source` field.

## Expected-output keys

| Key | Type | Behavior |
|---|---|---|
| `exitCode` | number | Required. Asserts the process exit code. |
| `stdoutContains` / `stdoutNotContains` | string[] | Each `stdoutContains` entry must appear in stdout; each `stdoutNotContains` entry must be absent. |
| `stderrContains` | string[] | Each entry must appear in stderr. |
| `created` / `modified` / `skipped` | string[] | (ingest-shape only) Parsed from `wiki ingest`'s "created: …" lines; sorted set-equal check. |
| `wikiAssertions` | object | Per-slug assertions on the resulting page file. See below. |

### `wikiAssertions`

```json
{
  "wikiAssertions": {
    "alice": {
      "bodyContains": ["schema_version: 1"],
      "bodyMissing": ["DRAFT"]
    },
    "bob": { "fileExists": false }
  }
}
```

`fileExists: false` asserts the slug's `.md` was NOT created. Default is `fileExists: true` (and missing-file fails).

## Hidden coupling with `tests/vault/`

The template at `tests/vault/` is **copied fresh into a temp directory per fixture**. Every fixture starts from exactly that state. Implication:

- **Adding a slug to `tests/vault/wiki/` is a global change.** A fuzzy-duplicate test that relied on "alice doesn't exist" will start failing if you add `alice.md` to the template.
- **The `SCHEMA.md` at `tests/vault/SCHEMA.md` is the contract every fixture validates against.** If you change `docs/SCHEMA.md` (the canonical copy), mirror to `tests/vault/SCHEMA.md` or the fixture suite will silently test against stale rules.
- **The growth-curve TSV at `tests/vault/raw/measurements/test-growth.tsv` exists because `test-growth.md` references it via `source_file`.** Deleting one breaks the other.

When a fixture fails, first ask: *did I change vault state that another fixture depends on?* Re-running the suite locally surfaces unintended ripple effects fast.

## Adding a new fixture

1. Create `tests/fixtures/<name>.json` (cmd-shape or ingest-shape).
2. Create `tests/fixtures/<name>.expected.json` with at minimum `exitCode`.
3. Run `bin/wiki-test` — your fixture appears in the output. If it fails, iterate on the expected file or the vault template.
4. If your fixture requires a new page in the template vault, add it under `tests/vault/wiki/` and re-run the *full* suite to check for breakage.

The suite is intentionally allergic to mocks — every test exercises the real CLI against a real vault. Slow per-test (≈ 100ms each), but every regression that lands here is a regression a user would actually hit.
