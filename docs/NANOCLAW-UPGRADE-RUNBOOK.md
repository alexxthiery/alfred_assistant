# NanoClaw upgrade runbook

This runbook exists to keep Alfred close to upstream NanoClaw without turning a
runtime upgrade into a live experiment. The default posture is conservative:
stage first, test the integration contract, then cut over with rollback ready.

## Rule zero

Do not run a raw `git pull` in the production NanoClaw checkout. NanoClaw has
its own supported upgrade flows and an upgrade-state tripwire; Alfred also
carries runtime safety requirements. Treat every upgrade as a reviewed
integration change.

## Current production and staging

Set these paths in your shell for the machine you are operating on:

```sh
export ALFRED_REPO=/path/to/alfred_assistant
export NANOCLAW_PROD=/path/to/production/nanoclaw
export NANOCLAW_STAGING=/path/to/staging/nanoclaw
export PRIMARY_VAULT=/path/to/primary-vault
export SECONDARY_VAULT=/path/to/secondary-vault
```

Staging is a separate worktree at upstream tag `v2.3.0`. Production remains
untouched until staging passes.

## Current staging evidence

As of the 2026-09-14 convergence pass, the v2.3 staging worktree has only the
first Alfred runtime safety layer ported:

- raw mounted-vault `wiki/*.md` writes are blocked at Claude `PreToolUse`;
- vault-relevant deliverable replies are gated until the runtime observes vault
  knowledge access;
- the vault guard is extracted in
  `container/agent-runner/src/providers/claude-vault-guard.ts`, not embedded in
  the provider adapter;
- production NanoClaw remains untouched.

Checks run in staging:

```sh
cd "$NANOCLAW_STAGING/container/agent-runner"
bun test src/providers/claude-vault-write-guard.test.ts src/providers/claude-vault-use-gate.test.ts src/providers/claude.tool-collisions.test.ts
bun run typecheck
bun test
```

Observed result: focused provider tests passed (`21 pass`), TypeScript
typecheck passed, and the full agent-runner suite passed (`350 pass`, `1
skip`, `0 fail`). The Alfred-side full upgrade gate also passed on
2026-09-14:

```sh
npm run nanoclaw:gate -- --nanoclaw "$NANOCLAW_STAGING" --prod "$NANOCLAW_PROD" --mode full
```

This is not a live deployment certificate; the runtime/container sibling-vault
isolation check and live canary below are still required before production
cutover.

Additional staging canary evidence from the same pass:

- the staging host refused to start until `data/upgrade-state.json` was stamped;
  after the full gate, staging was stamped with `via: alfred-gate`;
- the staging install needed its own base image
  (`nanoclaw-agent-v2-87203435:latest`), separate from production's
  `nanoclaw-agent-v2-7fb2a15c:latest`;
- a disposable CLI canary container mounted only the disposable alpha vault at
  `/workspace/extra/vault`; live vault paths and the disposable beta vault were
  not visible inside the container;
- the canary caught a NanoClaw v2.3 mount-config bug: `ncl groups config
  add-mount` documented read-write by default but failed to persist
  `readonly: false`, so mounts became read-only. Staging now carries a focused
  regression test for that behavior.

Additional secondary-assistant migration evidence from the 2026-09-18 pass:

- v2.3 staging now carries `container/agent-runner/src/runtime-mounts.ts`,
  which discovers `/workspace/extra/*`, prepends mounted vault `.bin`
  directories to `PATH`, and adds mounted Git repos to Git's
  `safe.directory` list before agent tool calls;
- focused runner tests cover mount discovery, `.bin` PATH construction,
  one-time `safe.directory` configuration, and the combined startup helper;
- the v2.3 cutover used a new runtime directory rather than overwriting
  the old one, leaving the old runtime folder and plist available for rollback;
- the copied secondary-assistant mount allowlist had the obsolete `nonMainReadOnly` key
  removed before launch;
- the old secondary-assistant per-group package list included `duckdb`, which no longer
  installs via apt in the v2.3 per-group image path. Remove that package before
  rebuilding; Alfred's deployed `wiki` falls back to lexical search when the
  DuckDB CLI is unavailable.

## Phase 1 - inventory

1. Record production state:

   ```sh
   git -C "$NANOCLAW_PROD" status --short --branch
   git -C "$NANOCLAW_PROD" describe --tags --always --dirty
   git -C "$NANOCLAW_PROD" log --oneline origin/main..HEAD
   ```

2. Record staging state:

   ```sh
   git -C "$NANOCLAW_STAGING" status --short --branch
   git -C "$NANOCLAW_STAGING" describe --tags --always
   ```

3. Classify every local patch from `docs/NANOCLAW-PATCHES.md` using the
   manifest format in `docs/NANOCLAW-INTEGRATION.md`.

4. Prefer deletion over porting. If upstream now has Telegram support, provider
   seams, template/plugin support, memory support, or better runtime guards, use
   that instead of carrying Alfred's old patch.

## Phase 2 - build the staging integration

For each carried behavior:

1. Try to express it as a NanoClaw template/plugin/config.
2. If it is vault-specific, keep it in `alfred_assistant` and deploy it into
   the vault `.bin/` surface.
3. Patch NanoClaw staging only if the behavior must run inside the provider,
   channel, mount, or delivery boundary.
4. Add or port tests next to the code that enforces the behavior.

Do not combine unrelated patch ports. The staging history should make it easy
to drop one carried behavior later.

## Phase 3 - gate checks

The normal entry point is the upgrade gate:

```sh
cd "$ALFRED_REPO"
npm run nanoclaw:gate -- --nanoclaw "$NANOCLAW_STAGING" --prod "$NANOCLAW_PROD" --mode fast
```

Use `--mode fast` while porting patches. It runs cheap Alfred checks, records
the staging git state, and runs the disposable contract smoke with focused
NanoClaw provider guard tests.

Before any live canary, run the full gate:

```sh
cd "$ALFRED_REPO"
npm run nanoclaw:gate -- --nanoclaw "$NANOCLAW_STAGING" --prod "$NANOCLAW_PROD" --mode full
```

The full gate runs the Alfred full suite, NanoClaw build/root/typecheck suites,
agent-runner tests, and the disposable contract smoke. It refuses if staging and
production resolve to the same checkout.

Each gate run writes one log file per subcommand under
`audit/nanoclaw-gates/<timestamp>-<mode>/` by default. The console output is a
compact checklist; the logs are the durable evidence packet. Pass
`--log-dir <dir>` only when you need to store the evidence elsewhere.

If the staging checkout is a separate install, the first host start may trip
NanoClaw's upgrade marker. Do not clear it before validation. After the full
gate has passed, stamp staging explicitly:

```sh
cd "$NANOCLAW_STAGING"
pnpm exec tsx scripts/upgrade-state.ts set 2.3.0 alfred-gate
```

If staging has never spawned a container, build its install-specific base image
before runtime canaries:

```sh
cd "$NANOCLAW_STAGING"
bash container/build.sh build
```

The image tag is derived from the staging checkout path and must be different
from production's tag. That is intentional; do not reuse the production image
as a shortcut.

Equivalent upstream checks in staging:

```sh
cd "$NANOCLAW_STAGING"
pnpm run build
pnpm test
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test
```

If dependencies are missing, install them in staging only. Do not modify the
production checkout to make staging tests pass.

Equivalent Alfred-side checks:

```sh
cd "$ALFRED_REPO"
npm test
node bin/wiki persona-lint
```

## Phase 4 - contract smoke tests

Use disposable staging vaults first. Do not point a staging runtime at live
vaults until the disposable checks pass.

Start with the repo-owned disposable smoke harness:

```sh
cd "$ALFRED_REPO"
npm run nanoclaw:smoke -- --nanoclaw "$NANOCLAW_STAGING"
```

This creates two throwaway vaults under `/tmp`, deploys Alfred into both, checks
per-vault env binding and label scoping, runs a single CLI write in one vault,
verifies the sibling vault stayed clean, checks private conversation logs are
gitignored, and checks that an assistant without Gmail credentials fails before
any Gmail access. It also runs the focused NanoClaw provider guard tests when
`--nanoclaw` is supplied.

The harness includes a deliberate host-side negative control:
`check-assistant-isolation --other-vault <sibling>` must fail on the host because
the sibling disposable vault is visible. That proves the checker catches sibling
visibility. The positive "sibling vault is not readable/writable" check must be
run from inside the actual runtime/container, where only the intended vault
should be mounted.

Required smoke tests:

| Risk | Check | Strong oracle |
|---|---|---|
| Wrong-vault write | Run the disposable smoke harness, then send a test message to staging assistant A and ask it to create a tiny todo | Only vault A changes; vault B git status remains clean |
| Wrong-vault read | Run the isolation check inside the runtime with sibling vaults passed as `--other-vault` | The check fails if sibling vaults are readable or writable |
| Vault mount mode | Inspect the actual runtime container and write a probe under the mounted vault private dir | `/workspace/extra/vault` is mounted read-write for Alfred; sibling vault paths remain absent |
| Raw page write | Attempt a direct runtime write to `<vault>/wiki/*.md` | Provider hook blocks it, or the CLI tamper check catches it before next write |
| CLI write path | Create and close a test todo through `wiki` | Audit remains clean and git history records the write |
| Vault-first behavior | Ask a personal recall question in a fresh runtime session | Delivery is blocked/nudged until a vault read occurs |
| Telegram separation | Send messages to both staging bots | Each message reaches only its intended staging vault |
| Email isolation | Run email review for one email-enabled staging assistant and one assistant without email configured | The email-enabled assistant can use email env; the other fails closed before Gmail access |
| Replay provenance | Replay or ingest one Telegram-derived fact | Raw replay spec/result and observation provenance are written |
| Private logs | Import a test conversation mirror | Files land under `.alfred/private/conversations/` and are gitignored |
| Host jobs | Run `wiki jobs --check --label <label>` in each staging vault | Labels and env paths match that assistant only |

## Phase 5 - live canary

Only after disposable staging passes:

1. Back up production NanoClaw state:

   ```sh
   git -C "$NANOCLAW_PROD" status --short --branch
   git -C "$NANOCLAW_PROD" describe --tags --always --dirty
   ```

2. Back up live vaults:

   ```sh
   git -C "$PRIMARY_VAULT" status --short --branch
   git -C "$SECONDARY_VAULT" status --short --branch
   ```

3. Canary one assistant first. Prefer a temporary runtime group and a temporary
   Telegram bot, not both live assistants at once. Do not use the production bot
   token in staging: Telegram long-polling permits only one active consumer per
   bot token, and a staging poller using the production token can steal updates
   from production.

4. Prepare the staging env split:

   ```sh
   # The staging env file should contain only the temporary canary bot token.
   printf 'TELEGRAM_BOT_TOKEN=<temporary-canary-bot-token>\n' > "$NANOCLAW_STAGING/.env"
   chmod 600 "$NANOCLAW_STAGING/.env"

   cd "$ALFRED_REPO"
   npm run nanoclaw:canary-env -- \
     --staging-env "$NANOCLAW_STAGING/.env" \
     --prod-env "$NANOCLAW_PROD/.env" \
     --print-shell
   ```

   The helper must pass before staging starts. It verifies:

   - staging has a Telegram token and it differs from production;
   - production supplies `ONECLI_URL`, so staging can wake containers;
   - Gmail credentials and `TELEGRAM_CHAT_ID` are not loaded into the staging
     canary runtime.

   Start staging with exactly the printed env shape: canary bot token from
   staging; `ONECLI_URL` and `TZ` from production; `EMAIL_FROM`,
   `GMAIL_APP_PASSWORD`, `GMAIL_IMAP_APP_PASSWORD`, and `TELEGRAM_CHAT_ID`
   unset. This deliberately avoids sourcing the whole production `.env`.

5. Pair and wire the temporary Telegram bot to the temporary staging agent
   group. Record the wiring id and messaging-group id before sending test
   messages so cleanup is deterministic.

6. Confirm the temporary staging agent group mounts only the intended vault:

   ```sh
   "$NANOCLAW_STAGING/bin/ncl" groups config get --id <agent-group-id>
   ```

   The config must list only the target vault as an additional mount, normally
   at container path `vault` with `readonly: false`. Do not proceed if any
   sibling vault is mounted.

7. Send three messages to the temporary staging bot:

   - harmless greeting/status, with an explicit "do not read or write" clause;
   - vault recall through `wiki`, with an explicit "do not write" clause;
   - direct-write guard probe: ask it to use the direct file write tool on
     `/workspace/extra/vault/wiki/nanoclaw-direct-write-should-be-blocked.md`
     and not to try a fallback.

   The expected result is: the first two messages deliver, the vault recall
   uses a read-only wiki command, and the direct write is denied by the provider
   hook. Verify the forbidden file is absent on the host.

8. Run the in-container mount isolation probe while the canary container exists:

   ```sh
   # Set these to sibling-vault paths that must NOT be visible in the container.
   CANARY_CONTAINER=<container-name>
   SIBLING_HOST_PATH=/path/to/sibling-vault
   SIBLING_CONTAINER_PATH=/workspace/extra/sibling-vault

   docker exec \
     -e SIBLING_HOST_PATH="$SIBLING_HOST_PATH" \
     -e SIBLING_CONTAINER_PATH="$SIBLING_CONTAINER_PATH" \
     "$CANARY_CONTAINER" bash -lc '
     set -e
     test -d /workspace/extra/vault/wiki
     test ! -e "$SIBLING_HOST_PATH"
     test ! -e "$SIBLING_CONTAINER_PATH"
     touch /workspace/extra/vault/.alfred/private/staging-telegram-canary-write-probe
     rm /workspace/extra/vault/.alfred/private/staging-telegram-canary-write-probe
     echo isolation_rw_ok
   '
   ```

   Replace the sibling paths when testing another machine or assistant. The
   invariant is not the literal path; it is that only the intended vault is
   mounted and the private-dir write probe succeeds.

9. Cleanup immediately:

   ```sh
   "$NANOCLAW_STAGING/bin/ncl" wirings delete <temporary-wiring-id>
   "$NANOCLAW_STAGING/bin/ncl" messaging-groups update <temporary-messaging-group-id> \
     --denied-at "$(date -Iseconds)"
   rm -f "$NANOCLAW_STAGING/.env"
   ```

   Stop the staging host and canary container. Re-check that only production
   hosts remain, the live vault git status is clean except for expected CLI
   writes, and the temporary direct-write probe file is absent.

10. Triage canary logs before declaring the canary passed. These are hard
    failures unless explicitly explained in the evidence packet:

    - `Conflict: terminated by other getUpdates request` — staging is using a
      bot token already consumed elsewhere, usually production.
    - `OneCLI returned 401 Unauthorized` — staging did not get a valid
      `ONECLI_URL` gateway credential.
    - `Mount allowlist has unsupported top-level "nonMainReadOnly" key` —
      host mount config is stale; remove that obsolete key and rely on
      per-root `allowReadWrite`.
    - `attempt to write a readonly database` — if it repeats or suppresses
      delivery, stop and inspect the session mailbox before cutover. A single
      recovered occurrence after a staging restart is not a vault-safety
      failure, but it must be recorded.

11. Re-run audit/lint/isolation for that vault.

## Rollback

Rollback must be possible without reasoning under pressure:

1. Stop the staging/live runtime.
2. Restore the previous production NanoClaw checkout.
3. Rebuild/restart the previous runtime if required.
4. Verify Telegram answers again.
5. Verify both live vaults still have clean git status or only expected CLI
   writes.

No live cutover is acceptable unless this rollback path has been written down
for the concrete release being deployed.

## Done criteria

An upgrade is done only when:

- staging NanoClaw is on the chosen upstream release tag;
- carried Alfred patches are documented and minimized;
- NanoClaw checks pass or failures are explicitly understood and irrelevant;
- Alfred checks pass;
- contract smoke tests pass;
- live canary passes;
- rollback notes exist;
- production checkout is clean after deployment.
