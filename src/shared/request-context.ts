import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/** The execution sources allowed by the audit correlation model. */
export const REQUEST_CONTEXT_SOURCE = 'HTTP' as const;
export const SCHEDULER_CONTEXT_SOURCE = 'SCHEDULER' as const;
export const SYSTEM_CONTEXT_SOURCE = 'SYSTEM' as const;

export type RequestContextSource =
  | typeof REQUEST_CONTEXT_SOURCE
  | typeof SCHEDULER_CONTEXT_SOURCE
  | typeof SYSTEM_CONTEXT_SOURCE;

/**
 * PART 01/03 — execution-local context available to code below the HTTP entry
 * middleware or inside a governed non-HTTP execution helper.
 */
export type RequestContext = Readonly<{
  requestId: string;
  source: RequestContextSource;
}>;

type HttpRequestContext = Readonly<{
  requestId: string;
  source: typeof REQUEST_CONTEXT_SOURCE;
}>;

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

function runContext<T>(context: RequestContext, callback: () => T): T {
  return requestContextStorage.run(Object.freeze({ ...context }), callback);
}

/**
 * Runs a callback with the HTTP request context established by PART 01. This
 * remains the HTTP entry helper; non-HTTP callers use the governed helpers
 * below rather than supplying a source directly.
 */
export function runWithRequestContext<T>(
  context: HttpRequestContext,
  callback: () => T,
): T {
  return runContext(context, callback);
}

/**
 * Runs one scheduler execution under one generated UUID. An existing HTTP
 * context always wins; an existing scheduler context is reused so nested
 * dispatcher calls remain part of the same run. A SYSTEM wrapper is replaced
 * when work explicitly enters the scheduler boundary.
 */
export function runWithSchedulerContext<T>(callback: () => T): T {
  const current = requestContextStorage.getStore();
  if (
    current?.source === REQUEST_CONTEXT_SOURCE ||
    current?.source === SCHEDULER_CONTEXT_SOURCE
  ) {
    return callback();
  }

  return runContext(
    { requestId: randomUUID(), source: SCHEDULER_CONTEXT_SOURCE },
    callback,
  );
}

/**
 * Runs standalone trusted system work under one generated UUID. Existing
 * execution context is preserved (in particular HTTP and SCHEDULER), so a
 * system helper cannot overwrite an active request or scheduler run.
 */
export function runWithSystemContext<T>(callback: () => T): T {
  const current = requestContextStorage.getStore();
  if (current) {
    return callback();
  }

  return runContext(
    { requestId: randomUUID(), source: SYSTEM_CONTEXT_SOURCE },
    callback,
  );
}

/** Returns the current execution context, or undefined outside a run. */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/** Returns the current request/correlation id without requiring a store. */
export function getRequestId(): string | undefined {
  return getRequestContext()?.requestId;
}
