import type { SchedulerConfig } from '../../config';
import { logger } from '../../shared/logger';
import { processDueOperationalJobs } from '../due-job-dispatcher';
import type {
  DueJobScheduler,
  DueJobSchedulerOptions,
} from './due-job-scheduler.types';

/**
 * CR-BE-STAB-01 PART 04 — in-process runtime scheduler boot wiring.
 *
 * PURPOSE
 * -------
 * Wires the PART 03 `processDueOperationalJobs()` dispatcher into the backend
 * runtime so due reminders and escalations are processed automatically. It is
 * a plain Node `setInterval` loop — no cron, no queue, no Redis, no external
 * scheduler dependency.
 *
 * LIFECYCLE
 * ---------
 * `createDueJobScheduler` builds a stoppable instance; `startDueJobScheduler`
 * is the idempotent boot entrypoint used by `server.ts` (started once during
 * boot, stopped during graceful shutdown). A module-level singleton guard
 * ensures at most ONE scheduler instance ever runs in a process.
 *
 * CONCURRENCY GUARD
 * -----------------
 * A tick that fires while a previous dispatcher run is still executing is
 * SKIPPED (`inFlight` flag), so overlapping executions are impossible and the
 * next interval may safely be dropped. Dispatcher failures are caught and
 * logged (existing `logger` pattern) — they never terminate the server.
 *
 * CONFIGURATION
 * -------------
 * `SchedulerConfig.enabled` / `.intervalMs` come from the environment
 * (SCHEDULER_ENABLED / SCHEDULER_INTERVAL_MS). `enabled` is forced to false in
 * NODE_ENV=test regardless of explicit config.
 */

type LogTarget = Pick<typeof logger, 'error' | 'info' | 'debug'>;

/** Hard ceiling on how long shutdown waits for an in-flight dispatcher run. */
const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

/** Builds a scheduler instance. `run` defaults to the PART 03 dispatcher. */
export function createDueJobScheduler(
  options: DueJobSchedulerOptions,
): DueJobScheduler {
  const log: LogTarget = logger;
  const run = options.run ?? (() => processDueOperationalJobs());
  const intervalMs = options.intervalMs;

  let timer: NodeJS.Timeout | null = null;
  // Whether the scheduler is active (has a live timer).
  let running = false;
  // Whether a dispatcher run is currently executing.
  let inFlight = false;
  // Promise of the in-flight dispatcher run, so shutdown can await it.
  let currentRun: Promise<unknown> | null = null;
  // Set once stop() begins so no further tick starts a new run.
  let stopping = false;

  // Bounded wait: resolves when `run` settles OR `ms` elapses, whichever
  // first. Never rejects, so a slow or failing dispatcher cannot hang or
  // abort the shutdown path (CR-BE-STAB-03 PART 04).
  async function drainWithTimeout(run: Promise<unknown>, ms: number): Promise<void> {
    let guard!: NodeJS.Timeout;
    const timeout = new Promise<void>((resolve) => {
      guard = setTimeout(resolve, ms);
    });
    try {
      await Promise.race([run, timeout]);
    } catch {
      // A dispatcher failure during drain must not abort shutdown.
    } finally {
      clearTimeout(guard);
      // Detach the underlying run so a late rejection is observed (the tick
      // try/catch already guards it) rather than surfacing as unhandled.
      void run.catch(() => undefined);
    }
  }

  async function tick(): Promise<void> {
    if (inFlight || stopping) {
      // A previous run is still active, or shutdown has begun — skip this
      // tick (allowed to be dropped). Log at debug so it is observable
      // without being noisy.
      log.debug('Due job scheduler skipped a tick; previous run still active or stopping');
      return;
    }

    inFlight = true;
    const runPromise = run();
    currentRun = runPromise;
    try {
      const result = await runPromise;
      log.debug('Due job scheduler completed a run', {
        operation: 'due-job-scheduler.run',
        result: result !== undefined ? JSON.stringify(result) : undefined,
      });
    } catch (error) {
      // A dispatcher failure must not terminate the server.
      log.error('Due job scheduler run failed', {
        operation: 'due-job-scheduler.run',
        errorName: error instanceof Error ? error.name : 'Error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = false;
      currentRun = null;
    }
  }

  return {
    start(): boolean {
      if (!options.enabled) {
        return false;
      }
      if (timer !== null) {
        // Already running — never create a duplicate timer.
        return false;
      }

      // Allow ticks again after a previous stop().
      stopping = false;
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      // Do not keep the process alive purely for the scheduler during
      // shutdown; the explicit stop() clears the timer on SIGTERM/SIGINT.
      timer.unref?.();

      running = true;
      log.info('Due job scheduler started', {
        operation: 'due-job-scheduler.start',
        intervalMs,
      });
      return true;
    },

    stop(drainTimeoutMs?: number): Promise<void> {
      // No new tick may start once stop begins.
      stopping = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (running) {
        running = false;
      }
      // Await the in-flight dispatcher run, bounded by a hard timeout so
      // shutdown can never hang. Resolves (never rejects) when the run
      // settles or the timeout elapses, whichever first.
      const inFlightRun = currentRun;
      const timeoutMs =
        drainTimeoutMs ?? options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
      return (inFlightRun
        ? drainWithTimeout(inFlightRun, timeoutMs)
        : Promise.resolve()
      ).then(() => {
        log.info('Due job scheduler stopped', {
          operation: 'due-job-scheduler.stop',
        });
      });
    },

    isRunning(): boolean {
      return running;
    },
  };
}

let activeScheduler: DueJobScheduler | null = null;

/**
 * Idempotent boot entrypoint. Starts a single scheduler from config and
 * returns it (or null when disabled / test environment). Repeated calls do NOT
 * create a duplicate instance — the existing running scheduler is returned.
 */
export function startDueJobScheduler(
  config: SchedulerConfig,
): DueJobScheduler | null {
  if (!config.enabled) {
    return null;
  }
  if (activeScheduler !== null && activeScheduler.isRunning()) {
    // Prevent duplicate scheduler instances.
    return activeScheduler;
  }

  const scheduler = createDueJobScheduler(config);
  if (scheduler.start()) {
    activeScheduler = scheduler;
    return scheduler;
  }
  return null;
}

/** Stops the active scheduler (if any), draining any in-flight dispatcher
 *  run with a bounded wait, and clears the singleton. */
export async function stopDueJobScheduler(
  drainTimeoutMs?: number,
): Promise<void> {
  if (activeScheduler) {
    const scheduler = activeScheduler;
    activeScheduler = null;
    await scheduler.stop(drainTimeoutMs);
  }
}

/**
 * Test-only reset of the singleton so isolated scheduler tests can start fresh.
 * Drains any in-flight run with a bounded wait.
 */
export async function resetDueJobSchedulerForTests(
  drainTimeoutMs?: number,
): Promise<void> {
  await stopDueJobScheduler(drainTimeoutMs);
}
