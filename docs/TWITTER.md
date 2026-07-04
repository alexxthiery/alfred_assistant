# Live X/Twitter reads via `twitter-read`

`bin/twitter-read` is Alfred's read-only adapter for live X/Twitter access.
It is a thin wrapper over [`bird`](https://github.com/steipete/bird), but the
repo-owned wrapper is the stable interface Alfred should call.

## Why a wrapper instead of raw `bird`

- read-only by construction: tweet/reply/unbookmark verbs are blocked
- stable Alfred-facing interface even if the backend changes later
- explicit config/env boundary instead of hidden shell aliases
- no passwords in the repo, vault, or chat transcripts

## Install shape

1. Install `bird` on the machine Alfred runs on:
   ```bash
   brew install steipete/tap/bird
   ```
   or another upstream-supported install path.

2. Install Alfred into the vault as usual:
   ```bash
   ./install.sh /path/to/vault
   ```
   This symlinks `.bin/twitter-read` into the vault.

3. Verify:
   ```bash
   cd /path/to/vault
   wiki preflight
   .bin/twitter-read whoami
   .bin/twitter-read bookmarks -n 5
   ```

## Backend resolution

`twitter-read` resolves the `bird` backend in this order:

1. `ALFRED_BIRD_BIN`
2. `.alfred.yml` → `paths.bird_bin`
3. `bird` on `PATH`

Use `paths.bird_bin` when the executable path is stable for that vault/runtime.
Use `ALFRED_BIRD_BIN` when the runtime injects a machine-specific override.

## Auth modes

`bird` itself supports browser-cookie extraction and its own config file. The
wrapper supports two clean modes:

### 1. Host / desktop mode

Recommended when Alfred runs on your Mac host via Codex or Claude Code.

- log into X in your browser
- let `bird` use browser cookies or `~/.config/bird/config.json5`
- do not put cookie values into `.alfred.yml`

### 2. Container / remote-runtime mode

Recommended when Alfred runs in nanoclaw or another container that cannot read
your browser cookie store reliably.

Set both env vars:

- `ALFRED_BIRD_AUTH_TOKEN`
- `ALFRED_BIRD_CT0`

`twitter-read` converts them to `bird --auth-token ... --ct0 ...` at exec time.
Set both or neither; partial state is rejected loudly.

## Security rules

- Never give Alfred your X password.
- Never paste cookie values into chat.
- Never commit cookie values to the repo or store them in `.alfred.yml`.
- Treat `ALFRED_BIRD_AUTH_TOKEN` and `ALFRED_BIRD_CT0` as session secrets.

## Allowed verbs

The wrapper currently allows these read-only verbs:

`about`, `bookmarks`, `check`, `followers`, `following`, `help`, `likes`,
`list-timeline`, `mentions`, `news`, `read`, `replies`, `search`, `thread`,
`user-tweets`, `whoami`

Examples:

```bash
.bin/twitter-read whoami
.bin/twitter-read user-tweets @handle -n 20
.bin/twitter-read bookmarks -n 20
.bin/twitter-read mentions -n 20
.bin/twitter-read thread https://x.com/user/status/1234567890123456789
```

When Alfred wants structured output, prefer `--json` on verbs that support it.
