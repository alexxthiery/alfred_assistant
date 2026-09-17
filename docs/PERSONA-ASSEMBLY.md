# Persona Assembly

The runtime persona for each vault is a generated `AGENTS.md`.

The editable sources are:

- repo-managed fragments: `docs/persona/*.template.md`
- vault identity: `<vault>/.alfred.yml`
- optional vault-local overlays: `<vault>/persona/agents.d/*.md`

`tools/render-persona.sh` is the single renderer. It concatenates the repo
fragments in the manifest order from `bin/lib/persona-template.js`, appends
vault-local overlays sorted by filename, substitutes identity placeholders, and
writes a generated header into `AGENTS.md`.

## Commands

Preview without writing:

```sh
tools/render-persona.sh --vault /path/to/vault --stdout
```

Check whether the generated persona is current:

```sh
tools/render-persona.sh --vault /path/to/vault --check
```

Regenerate an already-generated persona:

```sh
tools/render-persona.sh --vault /path/to/vault --apply
```

Adopt generation for a vault whose `AGENTS.md` was previously hand-authored:

```sh
tools/render-persona.sh --vault /path/to/vault --apply --adopt-generated-persona
```

Without `--adopt-generated-persona`, the renderer refuses to overwrite a
hand-authored `AGENTS.md` and writes `AGENTS.rendered.md` for review.

## Local Overlays

Use `persona/agents.d/*.md` for durable vault-specific policy: voice, age
boundaries, local routines, or assistant-specific constraints. Filenames are
sorted lexicographically, so use numeric prefixes:

```text
persona/agents.d/
  20-routines.md
  50-voice.md
  60-boundaries.md
```

Keep overlays small. Universal operating rules belong in `docs/persona/`;
assistant-specific policy belongs in the vault overlay.

Overlays are appended after the shared persona, so they may deliberately
override shared defaults. If an assistant needs a different relationship style,
say so explicitly in the overlay instead of hoping a general phrase like "warm"
will outweigh earlier terse defaults. For example: "This replaces the base
Voice defaults for direct chat; greetings are allowed."

## Tests

Run these after persona changes:

```sh
tools/assemble-persona-template.js --check
node bin/wiki persona-lint
npm run test:unit
```

`npm test` remains the full release gate.
