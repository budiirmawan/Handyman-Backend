import { requirePermission } from '../auth/rbac.middleware';
import type { RequestHandler } from 'express';

/**
 * CR-BE-SAAS-01 PART 01 — Platform-plane authority guard.
 *
 * The SaaS Control Plane lives under `/api/v1/platform/*` and is governed
 * EXCLUSIVELY by the explicit `platform.*` permission namespace (frozen
 * contract §3/§8). Two invariants are enforced here:
 *
 *   1. Default deny — the guard delegates to the repository-standard
 *      `requirePermission` (default-deny RBAC over the caller's effective
 *      active permissions). A tenant/business user without the exact
 *      `platform.*` code is denied, exactly like any other RBAC denial.
 *   2. Namespace assertion — a platform route may only be gated on a
 *      `platform.*` permission. A route that tries to gate itself on a
 *      tenant permission (or any bare code) fails fast at REGISTRATION time
 *      with a programming error rather than silently opening a platform
 *      surface.
 *
 * Tenant role names (`BUILDING_MANAGER`, `SUPERVISOR`, `PLATFORM_ADMIN`, …)
 * grant NO platform authority: authority comes only from explicitly assigned
 * `platform.*` permission grants (D2 — the foundation seed withholds every
 * `platform.*` code by default, so even `PLATFORM_ADMIN` does not bypass).
 *
 * The reverse direction is enforced by the business plane itself: a platform
 * permission is just another permission code and never appears in any
 * business-plane route's `requirePermission` list.
 */
const PLATFORM_PERMISSION_PREFIX = 'platform.';

export function isPlatformPermissionCode(code: string): boolean {
  return code.startsWith(PLATFORM_PERMISSION_PREFIX);
}

/**
 * Returns an RBAC middleware requiring the given platform permission.
 *
 * `code` MUST be a `platform.*` permission code; anything else is a contract
 * violation and raises immediately (fail loud, never open the route).
 */
export function requirePlatformPermission(code: string): RequestHandler {
  if (!isPlatformPermissionCode(code)) {
    throw new TypeError(
      `Platform routes may only require platform.* permissions, got: ${code}`,
    );
  }

  return requirePermission(code);
}

export const platformIam = {
  isPlatformPermissionCode,
  requirePlatformPermission,
};
