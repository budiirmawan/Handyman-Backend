import cors from 'cors';

/**
 * CR-HM-BE-CORS-PRODUCTION-01 — production browser CORS policy for the
 * Vercel frontend ↔ Railway API edge.
 *
 * Frozen contract for the production release:
 *
 *  - EXACT-origin allowlist. `CORS_ORIGINS` carries the literal production
 *    origin (for example `https://handyman-frontend-alpha.vercel.app`).
 *    Wildcards are impossible: an entry that is not an exact
 *    `scheme://host[:port]` origin is dropped before the allowlist is built,
 *    and the middleware never emits `Access-Control-Allow-Origin: *`.
 *  - `credentials` stays **false**. The platform authenticates with an opaque
 *    bearer session token in `Authorization`, never with a cookie, so no
 *    browser credential is ever attached to a cross-origin request.
 *  - Allowed request headers: `Content-Type`, `Authorization`, `X-Request-ID`
 *    and `Idempotency-Key`. `Idempotency-Key` is the verified backend
 *    idempotency contract used by the duplicate-risky command endpoints, so a
 *    browser preflight must be able to carry it.
 *  - `If-Match` is deliberately NOT allowed: no registered backend route reads
 *    an `If-Match` precondition, so permitting it would widen the browser
 *    surface without a verified contract behind it.
 *  - An unknown or disallowed origin is answered WITHOUT any
 *    `Access-Control-Allow-Origin` header, so the browser blocks the
 *    response. CORS is a browser policy, never an authentication or
 *    authorization mechanism.
 *  - Only `X-Request-ID` is exposed to the browser. No database value,
 *    credential or secret is ever written to a CORS response header.
 */

/** Request headers a browser client may send to this API. */
export const CORS_ALLOWED_REQUEST_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Request-ID',
  'Idempotency-Key',
] as const;

/** Response headers a browser client may read. */
export const CORS_EXPOSED_RESPONSE_HEADERS = ['X-Request-ID'] as const;

/** Methods a browser client may call. */
export const CORS_ALLOWED_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
] as const;

/**
 * Normalizes one configured origin to its exact `scheme://host[:port]` form.
 *
 * Returns `null` for anything that is not an exact HTTP(S) origin, so a
 * wildcard, a path, a query string, a fragment or embedded credentials can
 * never enter the allowlist.
 */
export function toExactCorsOrigin(value: string): string | null {
  const candidate = value.trim();

  if (candidate.length === 0 || candidate.includes('*')) {
    return null;
  }

  try {
    const url = new URL(candidate);

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    if (url.username !== '' || url.password !== '') {
      return null;
    }

    if (candidate !== url.origin && candidate !== `${url.origin}/`) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

export function createCorsMiddleware(origins: readonly string[]) {
  const allowed = new Set<string>();

  for (const origin of origins) {
    const exact = toExactCorsOrigin(origin);
    if (exact !== null) {
      allowed.add(exact);
    }
  }

  return cors({
    origin(origin, callback) {
      if (!origin) {
        // Non-browser callers (mobile, server-to-server, curl) send no Origin
        // header. The CORS decision is simply not applicable to them; it
        // never grants access to an origin that was not requested.
        callback(null, true);
        return;
      }

      callback(null, allowed.has(origin));
    },
    credentials: false,
    methods: [...CORS_ALLOWED_METHODS],
    allowedHeaders: [...CORS_ALLOWED_REQUEST_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_RESPONSE_HEADERS],
    maxAge: 600,
    optionsSuccessStatus: 204,
  });
}
