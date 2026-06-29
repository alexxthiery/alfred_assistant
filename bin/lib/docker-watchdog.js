// docker-watchdog.js — pure decision logic for the Docker/OneCLI watchdog.
//
// No fs, no exec, no globals; re-entrant. The runner
// (integrations/scheduling/docker-onecli-watchdog.js) does the I/O — probing the
// OneCLI gateway, the Docker daemon, and the restart state file — then asks this
// function what to do. Keeping the decision pure makes it unit-testable and keeps
// the one piece of branching logic out of the imperative shell.
//
// Background: nanoclaw spawns every agent container through the OneCLI gateway at
// http://127.0.0.1:10254 (a docker-compose stack). If Docker's engine crashes
// (observed 2026-06-27: backend "monitor exited: status 2"), the engine dies while
// Docker Desktop's UI lingers — a half-zombie state that does not self-heal — and
// the gateway becomes unreachable until a manual restart. This decides how to
// recover, given three observations and a restart rate-limit.

'use strict';

// Default cadence for the launchd job (seconds). Mirrored by the plist's
// StartInterval and the jobs.js manifest entry; kept here so the runner and the
// manifest can import one constant.
const DEFAULT_INTERVAL_S = 120;

// Never restart Docker Desktop more than once per this window — a wedged engine
// can take ~60s to come back, and a restart storm would make things worse.
const DEFAULT_MIN_RESTART_INTERVAL_MS = 10 * 60 * 1000;

// decideWatchdogAction — given the current state, return the action to take.
//
//   gatewayReachable     boolean — the OneCLI gateway answered on :10254 (any HTTP
//                        status counts; only a failed connection is "unreachable").
//   daemonResponding     boolean — `docker ps` succeeded (engine is up).
//   msSinceLastRestart   number  — ms since this watchdog last restarted Docker
//                        Desktop (Infinity if never). Rate-limits restarts.
//   minRestartIntervalMs number  — optional override of the rate-limit window.
//
// Returns { action, reason } where action is one of:
//   'ok'             gateway is serving — nothing to do.
//   'nudge-compose'  daemon up but gateway down — `docker compose up -d` the stack.
//   'restart-docker' daemon down and outside the rate-limit — restart Docker Desktop.
//   'defer-restart'  daemon down but a restart happened too recently — wait.
function decideWatchdogAction({
  gatewayReachable,
  daemonResponding,
  msSinceLastRestart = Infinity,
  minRestartIntervalMs = DEFAULT_MIN_RESTART_INTERVAL_MS,
} = {}) {
  if (gatewayReachable) {
    return { action: 'ok', reason: 'gateway reachable' };
  }
  if (daemonResponding) {
    return { action: 'nudge-compose', reason: 'gateway down, docker daemon up' };
  }
  if (msSinceLastRestart < minRestartIntervalMs) {
    return {
      action: 'defer-restart',
      reason: `docker daemon down but last restart was ${Math.round(msSinceLastRestart / 1000)}s ago (< ${Math.round(minRestartIntervalMs / 1000)}s)`,
    };
  }
  return { action: 'restart-docker', reason: 'docker daemon down' };
}

module.exports = {
  DEFAULT_INTERVAL_S,
  DEFAULT_MIN_RESTART_INTERVAL_MS,
  decideWatchdogAction,
};
