# Nanoclaw host-side patches

Alfred runs inside a [nanoclaw](https://github.com/your-fork/nanoclaw) Docker container.
Four host-side edits to nanoclaw enable Alfred's full flow.
Apply each to your local fork; they are unintrusive and additive.
None of these belong in `alfred_assistant`'s code — they live in nanoclaw — so this file documents them as patches.

If a future nanoclaw release upstreams these capabilities, this file can shrink.

## Patch 1 — Block `Write`/`Edit`/Bash-redirects on `wiki/*.md`

**Why.** The vault is a typed graph, not a folder of notes. Every page has invariants the CLI enforces (schema, microsyntax, provenance, autolink, audit, auto-commit). A raw write would silently break them.
The hook makes the constraint physical: trying to bypass `bin/wiki` returns an error message to Alfred explaining the rationale and pointing him at the right verb.

**Where.** `container/agent-runner/src/providers/claude.ts` (or your provider's hook plumbing).

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

## Patch 3 — Pass through `EMAIL_FROM` and `GMAIL_APP_PASSWORD` to the container

**Why.** Alfred's weekly digest reads these env vars to send mail via Gmail SMTP.
nanoclaw doesn't pass arbitrary env vars by default — only ones explicit providers contribute.

**Where.** `src/providers/claude.ts` (host side, not container side).

**Patch.** Extend the provider container-config function to read the two keys from `.env` and inject them:

```ts
registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile(['ANTHROPIC_BASE_URL', 'EMAIL_FROM', 'GMAIL_APP_PASSWORD']);
  const env: Record<string, string> = {};
  if (dotenv.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
    env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  }
  if (dotenv.EMAIL_FROM) env.EMAIL_FROM = dotenv.EMAIL_FROM;
  if (dotenv.GMAIL_APP_PASSWORD) env.GMAIL_APP_PASSWORD = dotenv.GMAIL_APP_PASSWORD;
  return { env };
});
```

## Patch 4 — Register the claude provider in `providers/index.ts`

**Why.** Patch 3 only takes effect if `claude.ts` is imported by the provider barrel.
Default nanoclaw doesn't register it (the comment in `providers/index.ts` explains: "providers with no host needs (claude, mock) don't appear here"). Once you start contributing env vars from `claude.ts`, you need to register it.

**Where.** `src/providers/index.ts`.

**Patch.** Add one import line:

```ts
import './claude.js';
```

## Applying

Each patch is small and idempotent.
After Patches 3 and 4, rebuild nanoclaw's host (`npm run build`) and restart its launchd / systemd job (`launchctl kickstart -k …`).
For Patches 1 and 2, restart the container itself (or let it respawn on the next message).
Verify with:

```bash
docker exec <agent-container> bash -c 'which wiki && echo $EMAIL_FROM'
```

Should print the path to `wiki` and the configured email address.
