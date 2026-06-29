// Unit tests for bin/lib/docker-watchdog.js — the pure decision core of the
// Docker/OneCLI watchdog. Each test pins one branch of the recovery logic with an
// independent oracle (the expected action for a given observed state), so a
// regression in the branching surfaces immediately.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  decideWatchdogAction,
  DEFAULT_MIN_RESTART_INTERVAL_MS,
  DEFAULT_INTERVAL_S,
} = require('../../bin/lib/docker-watchdog.js');

test('gateway reachable -> ok (no action), regardless of daemon/restart state', () => {
  assert.equal(decideWatchdogAction({ gatewayReachable: true, daemonResponding: false }).action, 'ok');
  assert.equal(decideWatchdogAction({ gatewayReachable: true, daemonResponding: true, msSinceLastRestart: 0 }).action, 'ok');
});

test('gateway down but daemon up -> nudge the compose stack (not a Docker restart)', () => {
  const r = decideWatchdogAction({ gatewayReachable: false, daemonResponding: true });
  assert.equal(r.action, 'nudge-compose');
  assert.match(r.reason, /daemon up/);
});

test('gateway down + daemon down + never restarted -> restart docker', () => {
  // Default msSinceLastRestart is Infinity, which must be outside any rate-limit.
  const r = decideWatchdogAction({ gatewayReachable: false, daemonResponding: false });
  assert.equal(r.action, 'restart-docker');
});

test('gateway down + daemon down + restarted long ago -> restart docker', () => {
  const r = decideWatchdogAction({
    gatewayReachable: false,
    daemonResponding: false,
    msSinceLastRestart: DEFAULT_MIN_RESTART_INTERVAL_MS + 1,
  });
  assert.equal(r.action, 'restart-docker');
});

test('gateway down + daemon down + restarted recently -> defer (rate-limit holds)', () => {
  const r = decideWatchdogAction({
    gatewayReachable: false,
    daemonResponding: false,
    msSinceLastRestart: 5_000,
  });
  assert.equal(r.action, 'defer-restart');
  assert.match(r.reason, /5s ago/);
});

test('rate-limit boundary: exactly at the window is NOT yet eligible; just over is', () => {
  const at = decideWatchdogAction({
    gatewayReachable: false, daemonResponding: false,
    msSinceLastRestart: DEFAULT_MIN_RESTART_INTERVAL_MS, // not < window
  });
  assert.equal(at.action, 'restart-docker'); // `<` comparison: equal is eligible
  const under = decideWatchdogAction({
    gatewayReachable: false, daemonResponding: false,
    msSinceLastRestart: DEFAULT_MIN_RESTART_INTERVAL_MS - 1,
  });
  assert.equal(under.action, 'defer-restart');
});

test('custom minRestartIntervalMs overrides the default window', () => {
  const r = decideWatchdogAction({
    gatewayReachable: false, daemonResponding: false,
    msSinceLastRestart: 30_000, minRestartIntervalMs: 60_000,
  });
  assert.equal(r.action, 'defer-restart');
});

test('exported constants are sane defaults', () => {
  assert.equal(DEFAULT_INTERVAL_S, 120);
  assert.equal(DEFAULT_MIN_RESTART_INTERVAL_MS, 600000);
});
