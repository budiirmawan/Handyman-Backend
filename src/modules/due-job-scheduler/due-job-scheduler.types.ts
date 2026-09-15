/**
 * CR-BE-STAB-01 PART 04 — in-process due job scheduler types.
 */

/** Options for a lightweight scheduler instance. */
export type DueJobSchedulerOptions = {
  /** Whether the scheduler is allowed to run. */
  enabled: boolean;
  /** Polling cadence between dispatcher runs, in milliseconds. */
  intervalMs: number;
  /**
   * The work to execute on each tick. Defaults to the PART 03
   * `processDueOperationalJobs()`. Injecting it makes the scheduler unit-
   * testable without touching the real dispatcher/domain.
   */
  run?: () => Promise<unknown>;
  /**
   * Hard ceiling (ms) for shutdown to wait on an already-running dispatcher
   * tick. Defaults to DEFAULT_DRAIN_TIMEOUT_MS. Bounded so shutdown can never
   * hang indefinitely (CR-BE-STAB-03 PART 04).
   */
  drainTimeoutMs?: number;
};

/** A running (or stoppable) scheduler instance. */
export type DueJobScheduler = {
  /**
   * Starts the scheduler. Returns true if it started; false if it is disabled
   * or already running (so a repeated start never creates a duplicate timer).
   */
  start: () => boolean;
  /**
   * Stops the scheduler and clears its timer, then awaits any in-flight
   * dispatcher run with a bounded timeout (CR-BE-STAB-03 PART 04). Safe to
   * call repeatedly.
   */
  stop: (drainTimeoutMs?: number) => Promise<void>;
  /** Whether the scheduler currently has an active timer. */
  isRunning: () => boolean;
};
