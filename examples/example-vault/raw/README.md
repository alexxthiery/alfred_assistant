# raw/ — vault-local provenance archive

This folder is intentionally empty in the shipped example vault.

In a live vault, `raw/` holds the original artifacts (PDFs, web clippings, transcripts) that `wiki` pages link to via the `raw_path` frontmatter field. Their byte hash (`sha256` field) anchors the page back to the exact source bytes — so a future agent can verify the page still matches what was originally read.

These files are vault-specific (your private knowledge graph's sources). The example vault ships without any to avoid:

- Bundling third-party copyrighted content.
- Bloating the published repo with binary artifacts.
- Pretending the example author actually read what the `paper-llm-wiki-2024` page cites.

The example vault's `paper-llm-wiki-2024` page declares a `raw_path: raw/paper-llm-wiki-2024.pdf` reference that points into this empty folder. That is deliberate: it demonstrates the *contract* (every source-type page has provenance pointing here) without shipping the artifact itself.

To populate this in your own vault:

- `bin/inbox triage` — drops content from `inbox/` into `raw/` after PII scrubbing.
- `bin/inbox ingest-url <url>` — fetches a URL, redacts, and stores under `raw/clippings/`.

See `docs/SCHEMA.md` for the `raw_path` + `sha256` field contract.
