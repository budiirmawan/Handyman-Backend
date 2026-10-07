import { getAppConfig } from '../../config';

/**
 * Lightweight in-memory login throttle. Keyed by IP address (the socket
 * remote address, not a forwarded header). This is temporary request
 * throttling only — it never permanently locks an account.
 */
type AttemptEntry = {
  count: number;
  windowStartedAt: number;
};

const attemptsByKey = new Map<string, AttemptEntry>();

function limitConfig(): { windowMs: number; maxAttempts: number } {
  const security = getAppConfig().security;
  return {
    windowMs: security.loginRateLimitWindowMinutes * 60_000,
    maxAttempts: security.loginRateLimitMaxAttempts,
  };
}

export function isLoginRateLimited(key: string): boolean {
  const { windowMs, maxAttempts } = limitConfig();
  const entry = attemptsByKey.get(key);

  if (!entry) {
    return false;
  }

  if (Date.now() - entry.windowStartedAt >= windowMs) {
    attemptsByKey.delete(key);
    return false;
  }

  return entry.count >= maxAttempts;
}

export function recordLoginFailure(key: string): void {
  const { windowMs } = limitConfig();
  const now = Date.now();
  const entry = attemptsByKey.get(key);

  if (!entry || now - entry.windowStartedAt >= windowMs) {
    attemptsByKey.set(key, { count: 1, windowStartedAt: now });
    return;
  }

  entry.count += 1;
}

export function recordLoginSuccess(key: string): void {
  attemptsByKey.delete(key);
}

/** Test/operational helper to clear all throttle state. */
export function clearLoginRateLimits(): void {
  attemptsByKey.clear();
}
