# NanoClaw carried patch inventory

Alfred runs inside a [nanoclaw](https://github.com/your-fork/nanoclaw) Docker container.
Historically, five host-side edits to NanoClaw enabled Alfred's full flow.
This file is now a carried-patch inventory, not the preferred long-term
architecture.

Read these first:

- `docs/NANOCLAW-INTEGRATION.md` - the stable Alfred/NanoClaw boundary.
- `docs/NANOCLAW-UPGRADE-RUNBOOK.md` - the staging-first upgrade process.

The strategic goal is to keep Alfred close to upstream NanoClaw. During each
upgrade, classify every patch below as one of:

```text
keep | port-to-plugin | replace-upstream | drop | upstream-candidate
```

Prefer replacing these patches with upstream features, NanoClaw
templates/plugins, or Alfred-side wrappers. Keep a NanoClaw patch only when the
behavior must happen inside the runtime boundary.

## Patch 1 — Block `Write`/`Edit`/Bash-redirects on `wiki/*.md`

**Current status.** Keep unless upstream exposes an equivalent provider/tool
policy hook. This is a hard vault-integrity boundary. NanoClaw `v2.3.0`
still has a Claude `PreToolUse` hook seam, so this should be ported as a small
hook extension if no provider-neutral policy layer exists.

**v2.3 staging state.** Ported in the checkout identified by
`$NANOCLAW_STAGING` as
`container/agent-runner/src/providers/claude-vault-guard.ts`, wired from
`container/agent-runner/src/providers/claude.ts`, with focused coverage in
`claude-vault-write-guard.test.ts`.

**Why.** The vault is a typed graph, not a folder of notes. Every page has invariants the CLI enforces (schema, microsyntax, provenance, autolink, audit, auto-commit). A raw write would silently break them.
The hook makes the constraint physical: trying to bypass `bin/wiki` returns an error message to Alfred explaining the rationale and pointing him at the right verb.

**Where.** `container/agent-runner/src/providers/claude-vault-guard.ts` plus
the provider hook wiring in `container/agent-runner/src/providers/claude.ts`
(or your provider's equivalent hook plumbing).

**Patch.** Strengthen the `PreToolUseHook` to (a) match writes targeting any `/workspace/extra/<vault>/wiki/**` path, including indirect forms (`Bash` with `>`, `>>`, `tee`, `sed -i`, `awk -i`, `cp`, `mv`, `rm`, `dd of=`), and (b) return a `stopReason` that explicitly says the block is intentional:

```ts
return {
  decision: "block",
  stopReason: [
    "This block is INTENTIONAL — not a bug, not a misconfigured hook, not a session issue.",
    "The vault is a typed graph. Use `wiki ingest --stdin` (default) or `wiki patch` instead.",
    "Free-write zones (no block): inbox/, raw/, alfred/scratchpad.md, alfred/notes/, /workspace/agent/.",
  ].join("\n"),
};
```

## Patch 2 — Prepend extra-vault `.bin/` directories to the container's PATH

**Current status.** Candidate to replace with template/plugin or runtime config
if upstream `v2.3.x` can mount/expose agent tools cleanly. Keep only if bare
`wiki` access would otherwise be brittle. NanoClaw `v2.3.0` has host-only
`ncl groups config add-mount` plus additional mounts under `/workspace/extra/`;
test whether a per-vault mount plus persona PATH guidance removes this patch.

**Why.** The vault's CLI lives at `/workspace/extra/<vault>/bin/wiki`. Without this patch, Alfred has to use absolute paths everywhere. The patch makes bare verbs (`wiki list`, `inbox queue`) work.

**Where.** `container/agent-runner/src/index.ts`.

**Patch.** After `additionalDirectories` is built, prepend each `<d>/bin` (if it exists) to `PATH` before constructing the provider:

```ts
const extraBins = additionalDirectories
  .map((d) => path.join(d, 'bin'))
  .filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
const augmentedPath = [...extraBins, process.env.PATH || ''].filter(Boolean).join(':');
const provider = createProvider(providerName, {
  ...,
  env: { ...process.env, PATH: augmentedPath },
});
```

Container restart picks it up (no rebuild needed if source is bind-mounted).

## Patch 3 — Pass through Alfred's mail and optional X/Twitter env vars to the container

**Current status.** Candidate to move out of NanoClaw core. Alfred-specific
credentials should ideally be passed by per-assistant template/config or handled
by Alfred-side host jobs. Keep only the minimum in-container allowlist needed
for features that genuinely run inside the agent container. NanoClaw `v2.3.0`
already has provider container contributions; avoid adding vault-specific
secrets to the global project `.env` unless an in-container feature truly needs
them.

**Why.** Alfred uses these env vars for two distinct mail flows:
- `EMAIL_FROM` + `GMAIL_APP_PASSWORD` — `bin/email-digest` SMTP-send (weekly digest + daily morning brief).
- `EMAIL_FROM` + `GMAIL_IMAP_APP_PASSWORD` — `bin/gmail` IMAP-read (Reflex 4 fallback for email-shaped recall questions).
- `ALFRED_BIRD_AUTH_TOKEN` + `ALFRED_BIRD_CT0` — `bin/twitter-read` live X/Twitter reads via the optional `bird` backend, for container runtimes that cannot read browser cookies directly.

nanoclaw doesn't pass arbitrary env vars by default — only ones explicit providers contribute.

**Where.** `src/providers/claude.ts` (host side, not container side).

**Patch.** Extend the provider container-config function to read the five keys from `.env` and inject them:

```ts
registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile([
    'ANTHROPIC_BASE_URL',
    'EMAIL_FROM',
    'GMAIL_APP_PASSWORD',
    'GMAIL_IMAP_APP_PASSWORD',
    'ALFRED_BIRD_AUTH_TOKEN',
    'ALFRED_BIRD_CT0',
  ]);
  const env: Record<string, string> = {};
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }
  if (dotenv.EMAIL_FROM) env.EMAIL_FROM = dotenv.EMAIL_FROM;
  if (dotenv.GMAIL_APP_PASSWORD) env.GMAIL_APP_PASSWORD = dotenv.GMAIL_APP_PASSWORD;
  if (dotenv.GMAIL_IMAP_APP_PASSWORD) env.GMAIL_IMAP_APP_PASSWORD = dotenv.GMAIL_IMAP_APP_PASSWORD;
  if (dotenv.ALFRED_BIRD_AUTH_TOKEN) env.ALFRED_BIRD_AUTH_TOKEN = dotenv.ALFRED_BIRD_AUTH_TOKEN;
  if (dotenv.ALFRED_BIRD_CT0) env.ALFRED_BIRD_CT0 = dotenv.ALFRED_BIRD_CT0;
  return { env };
});
```

If you add more Alfred-side secret env vars in the future, extend the allowlist and the pass-through block in lockstep.

## Patch 4 — Register the claude provider in `providers/index.ts`

**Current status.** Drop if Patch 3 is removed or upstream provider registration
now has the necessary extension point. In NanoClaw `v2.3.0`, `src/providers/claude.ts`
exists but is intentionally not imported by default; importing it is only
needed when a Claude host-side container contribution is required.

**Why.** Patch 3 only takes effect if `claude.ts` is imported by the provider barrel.
Default nanoclaw doesn't register it (the comment in `providers/index.ts` explains: "providers with no host needs (claude, mock) don't appear here"). Once you start contributing env vars from `claude.ts`, you need to register it.

**Where.** `src/providers/index.ts`.

**Patch.** Add one import line:

```ts
import './claude.js';
```

## Patch 5 — Gate vault-relevant replies until Alfred reads the vault

**Current status.** Keep unless upstream exposes a provider-neutral way to gate
delivery on a runtime-specific evidence signal. This is a user-facing
correctness boundary, not just a convenience. NanoClaw `v2.3.0` has stronger
delivery and provider-event machinery, but this Alfred-specific evidence gate
still needs an Alfred-specific policy layer.

**v2.3 staging state.** Ported in the checkout identified by
`$NANOCLAW_STAGING` as an extracted
`claude-vault-guard.ts` state machine. The v2.3 port is stricter than the old
production patch: it suppresses both streamed `<message to="...">` provider
text and final result text until vault knowledge access is observed. Focused
coverage lives in `claude-vault-use-gate.test.ts`.

**Why.** The persona tells Alfred to search the vault before topical answers, but prompt rules are not a hard invariant.
For Alfred this matters: an answer to a personal recall, planning, todo, meeting, email, or daily-brief question should not be delivered if Alfred has not touched the mounted vault at all.
This patch makes the constraint physical at the message-delivery boundary.

**Where.** `container/agent-runner/src/providers/claude-vault-guard.ts`,
`container/agent-runner/src/providers/claude.ts`, and the poll-loop
user-facing-error path in `container/agent-runner/src/poll-loop.ts`.

**Patch.** Keep a small per-user-batch gate in the Claude provider:

- classify only clearly vault-relevant prompts as requiring vault access;
- mark the gate satisfied only by meaningful vault knowledge access (`wiki`, `inbox`, `daily-brief`, `email-digest`, `reminder-dispatch`, or reads/greps/globs under `/workspace/extra/<vault>/wiki`);
- do not count `/workspace/extra/<vault>/AGENTS.md` as knowledge access, because it only proves persona loading;
- block `send_message`, streamed `<message to="...">` output, and final `<message to="...">` output until a vault read happens;
- after two corrective nudges, fail visibly instead of looping forever.

The existing `NANOCLAW_DISABLE_VAULT_TELEMETRY=1` escape hatch disables this gate too.

## Applying

Each patch is small and idempotent.
After Patches 3 and 4, rebuild nanoclaw's host (`npm run build`) and restart its launchd / systemd job (`launchctl kickstart -k …`).
For Patches 1 and 2, restart the container itself (or let it respawn on the next message).
Verify with:

```bash
docker exec <agent-container> bash -c 'which wiki && echo $EMAIL_FROM'
```

Should print the path to `wiki` and the configured email address.
