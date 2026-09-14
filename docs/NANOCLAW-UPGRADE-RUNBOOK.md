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

3. Canary one assistant first. Prefer the less critical assistant or a
   temporary runtime group, not both live assistants at once.

4. Send three messages:
   - harmless greeting/status;
   - vault recall;
   - tiny write through the CLI.

5. Re-run audit/lint/isolation for that vault.

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
