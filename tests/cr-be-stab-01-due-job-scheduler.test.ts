import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { parseConfig } from '../src/config/env';
import {
  createDueJobScheduler,
  resetDueJobSchedulerForTests,
  startDueJobScheduler,
  stopDueJobScheduler,
} from '../src/modules/due-job-scheduler';

/**
 * CR-BE-STAB-01 PART 04 — runtime scheduler boot wiring (focused tests).
 *
 * Proves:
 *   - scheduler starts when enabled
 *   - scheduler does not start when disabled
 *   - scheduler does not run in NODE_ENV=test (config forces disabled)
 *   - the dispatcher (run) is invoked on schedule
 *   - overlapping executions are prevented (in-flight guard skips ticks)
 *   - a dispatcher error does not terminate the scheduler
 *   - stop clears the scheduler
 *   - repeated start does not create a duplicate scheduler
 *
 * The scheduler under test is `createDueJobScheduler` with an injected `run`
 * (so no DB is needed and timing is deterministic). No domain logic is touched.
 */

describe('CR-BE-STAB-01 PART 04 — config gating', () => {
  it('defaults to disabled in development (conservative)', () => {
    const config = parseConfig({ NODE_ENV: 'development' });
    assert.equal(config.scheduler.enabled, false);
    assert.equal(config.scheduler.intervalMs, 60_000);
  });

  it('defaults to enabled in production with a conservative cadence', () => {
    const config = parseConfig({ NODE_ENV: 'production' });
    assert.equal(config.scheduler.enabled, true);
    assert.equal(config.scheduler.intervalMs, 60_000);
  });

  it('is always disabled in NODE_ENV=test even if explicitly enabled', () => {
    const config = parseConfig({
      NODE_ENV: 'test',
      SCHEDULER_ENABLED: 'true',
    });
    assert.equal(config.scheduler.enabled, false);
    // startDueJobScheduler must therefore return null.
    resetDueJobSchedulerForTests();
    assert.equal(
      startDueJobScheduler({ enabled: config.scheduler.enabled, intervalMs: 10_000 }),
      null,
    );
  });

  it('reads explicit SCHEDULER_ENABLED and SCHEDULER_INTERVAL_MS', () => {
    const config = parseConfig({
      NODE_ENV: 'development',
      SCHEDULER_ENABLED: 'true',
      SCHEDULER_INTERVAL_MS: '5000',
    });
    assert.equal(config.scheduler.enabled, true);
    assert.equal(config.scheduler.intervalMs, 5_000);
  });
});

describe('CR-BE-STAB-01 PART 04 — scheduler lifecycle', () => {
  it('starts when enabled and stops when told to', async () => {
    resetDueJobSchedulerForTests();
    let runs = 0;
    const scheduler = createDueJobScheduler({
      enabled: true,
      intervalMs: 20,
      run: async () => {
        runs += 1;
      },
    });

    assert.equal(scheduler.start(), true);
    assert.equal(scheduler.isRunning(), true);
    // Second start must not create a duplicate timer.
    assert.equal(scheduler.start(), false);

    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.ok(runs >= 1, 'run should have been invoked on schedule');

    scheduler.stop();
    assert.equal(scheduler.isRunning(), false);
    const after = runs;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(runs, after, 'no run after stop');
  });

  it('does not start when disabled', () => {
    const scheduler = createDueJobScheduler({ enabled: false, intervalMs: 20 });
    assert.equal(scheduler.start(), false);
    assert.equal(scheduler.isRunning(), false);
    scheduler.stop();
  });

  it('does not run when never started', async () => {
    const scheduler = createDueJobScheduler({ enabled: true, intervalMs: 10 });
    assert.equal(scheduler.isRunning(), false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(scheduler.isRunning(), false);
    scheduler.stop();
  });

  it('prevents overlapping executions (in-flight ticks are skipped)', async () => {
    resetDueJobSchedulerForTests();
    let concurrent = 0;
    let maxConcurrent = 0;

    const scheduler = createDueJobScheduler({
      enabled: true,
      intervalMs: 15,
      run: async () => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        // Slow run so several interval ticks would fire during it.
        await new Promise((resolve) => setTimeout(resolve, 60));
        concurrent -= 1;
      },
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    // The in-flight guard is the guarantee: at most one run ever overlapped.
    assert.ok(maxConcurrent <= 1, `overlap detected: maxConcurrent=${maxConcurrent}`);
    // Allow the final in-flight run (60ms sleep) to drain before asserting 0.
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(concurrent, 0);
  });

  it('does not terminate when the dispatcher throws; keeps running', async () => {
    resetDueJobSchedulerForTests();
    let calls = 0;
    const scheduler = createDueJobScheduler({
      enabled: true,
      intervalMs: 15,
      run: async () => {
        calls += 1;
        throw new Error('boom');
      },
    });

    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 70));
    // Still running after failures.
    assert.equal(scheduler.isRunning(), true);
    assert.ok(calls >= 1, 'dispatcher was invoked');
    scheduler.stop();
    assert.equal(scheduler.isRunning(), false);
  });

  it('stop is idempotent (safe to call repeatedly)', () => {
    const scheduler = createDueJobScheduler({ enabled: true, intervalMs: 20 });
    scheduler.start();
    scheduler.stop();
    scheduler.stop();
    scheduler.stop();
    assert.equal(scheduler.isRunning(), false);
  });
});

describe('CR-BE-STAB-01 PART 04 — singleton boot helpers', () => {
  it('startDueJobScheduler returns null when disabled', () => {
    resetDueJobSchedulerForTests();
    assert.equal(
      startDueJobScheduler({ enabled: false, intervalMs: 10_000 }),
      null,
    );
  });

  it('repeated start does not create a duplicate singleton scheduler', () => {
    resetDueJobSchedulerForTests();
    // High interval so no tick fires against the real (DB-backed) dispatcher
    // during this identity-only test.
    const config = { enabled: true, intervalMs: 10_000 } as const;

    // The singleton uses the real dispatcher by default; here we start the
    // singleton to prove non-duplication, then stop it. Invocation-count checks
    // without DB access live in the lifecycle tests above via
    // createDueJobScheduler; this test focuses on the singleton guard.
    const first = startDueJobScheduler(config);
    assert.ok(first, 'first start returns a scheduler');
    const second = startDueJobScheduler(config);
    assert.equal(second, first, 'second start returns the SAME instance');

    stopDueJobScheduler();
    assert.equal(first.isRunning(), false);
  });

  it('can start again after being stopped', () => {
    resetDueJobSchedulerForTests();
    const config = { enabled: true, intervalMs: 10_000 } as const;
    const first = startDueJobScheduler(config);
    stopDueJobScheduler();
    assert.equal(first!.isRunning(), false);
    const second = startDueJobScheduler(config);
    assert.ok(second);
    assert.notEqual(second, first, 'a fresh instance is created after stop');
    stopDueJobScheduler();
  });
});

describe('CR-BE-STAB-03 PART 04 — bounded in-flight scheduler drain', () => {
  it('awaits the in-flight dispatcher run and prevents new runs after stop', async () => {
    resetDueJobSchedulerForTests();
    let concurrent = 0;
    let maxConcurrent = 0;
    let runs = 0;
    const scheduler = createDueJobScheduler({
      enabled: true,
      intervalMs: 10,
      drainTimeoutMs: 2_000,
      run: async () => {
        runs += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 50));
        concurrent -= 1;
      },
    });
    scheduler.start();
    // Let a run begin.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopStart = Date.now();
    await scheduler.stop(2_000);
    const elapsed = Date.now() - stopStart;
    assert.equal(scheduler.isRunning(), false);
    // The in-flight run was drained to completion.
    assert.equal(concurrent, 0);
    assert.ok(maxConcurrent <= 1, `overlap detected: ${maxConcurrent}`);
    // Bounded: nowhere near an indefinite hang.
    assert.ok(elapsed < 5_000, `drain should be bounded, took ${elapsed}ms`);
    // No new run started after stop.
    const afterStop = runs;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(runs, afterStop, 'no run should start after stop');
  });

  it('does not hang when the in-flight run exceeds the drain timeout', async () => {
    resetDueJobSchedulerForTests();
    const scheduler = createDueJobScheduler({
      enabled: true,
      intervalMs: 10,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      },
    });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopStart = Date.now();
    // Drain timeout far shorter than the run; stop must still resolve.
    await scheduler.stop(100);
    const elapsed = Date.now() - stopStart;
    assert.equal(scheduler.isRunning(), false);
    assert.ok(elapsed < 1_000, `drain must not hang; took ${elapsed}ms`);
  });
});

after(() => {
  resetDueJobSchedulerForTests();
});
