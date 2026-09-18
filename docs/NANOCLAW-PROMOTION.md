# NanoClaw Assistant Promotion

This is the production-side companion to `docs/NANOCLAW-UPGRADE-RUNBOOK.md`.
The upgrade gate proves a staging NanoClaw checkout. Promotion proves that one
live assistant runtime still represents exactly one assistant after the vetted
bytes are copied into place.

The core rule: promote one assistant at a time. Do not update every assistant
runtime in one unobserved step.

## Read-only Runtime Check

Before and after a promotion, run:

```sh
npm run nanoclaw:runtime-check -- \
  --runtime <assistant-runtime> \
  --vault <assistant-vault> \
  --group-id <agent-group-id> \
  --assistant-name <assistant-name> \
  --launchd-label <launchd-label> \
  --destination <telegram-destination-name> \
  --other-vault <sibling-vault> \
  --require-duckdb \
  --require-telegram-destination \
  --expected-upgrade-commit <vetted-staging-commit>
```

The checker is read-only. It validates the specific failure modes that have
caused surprises during live assistant migrations:

- the runtime has its own state surface: `data/`, `home/`, `groups/`, `.env`,
  and `bin/ncl`;
- the NanoClaw mount allowlist contains exactly the active vault, not a sibling
  vault;
- the upgrade marker points at the vetted staging commit when one is supplied;
- NanoClaw group name and container `assistant_name` match the intended
  assistant identity;
- the group config mounts only the active vault, read-write, at container path
  `vault`;
- `duckdb` remains in the per-group package list when Alfred search quality
  depends on the DuckDB CLI;
- the companion `agent_destinations` row exists, so generated replies are not
  dropped as unknown destinations;
- an active session exists and the launchd label is loaded.

For a dry run that does not depend on launchd, add `--skip-launchd`.

## Promotion Skeleton

Manual promotion should follow this order until it is wrapped by a single
script:

1. Run the full staging gate:

   ```sh
   npm run nanoclaw:gate -- --nanoclaw <staging> --prod <current-runtime> --mode full
   ```

2. Run the read-only runtime check against the current runtime.

3. Stop only that assistant's launchd label.

4. Preserve runtime state:

   - `.env`
   - `data/`
   - `home/`
   - `groups/`

5. Copy vetted NanoClaw code from staging into a new runtime directory or an
   explicitly prepared runtime copy. Do not overwrite state directories with
   staging state.

6. Restore the preserved state into the new runtime copy.

7. Build the host runtime and base image as needed.

8. Restart launchd for that assistant.

9. Rebuild the per-group image when base image or packages changed.

10. Run the read-only runtime check again.

11. Run a disposable container smoke:

    - `duckdb -version`;
    - `command -v wiki`;
    - `wiki search <known-term> --limit 1` without the lexical-fallback warning;
    - prove sibling vault paths are not visible.

12. Ask for one live Telegram ping and inspect logs for a delivered message,
    not just a generated `<message>` block.

13. Push any vault auto-commit produced by the live smoke.

## Rollback Surface

Never delete the old runtime during the same promotion session. A rollback needs
the old runtime directory and old launchd plist/label to still exist.

Minimum rollback record:

```text
old runtime:
old launchd label:
new runtime:
new launchd label:
vetted staging commit:
group id:
destination name:
```

If a post-promotion check fails, prefer stopping the new launchd label and
bootstrapping the old label over attempting live surgery while the assistant is
receiving messages.
