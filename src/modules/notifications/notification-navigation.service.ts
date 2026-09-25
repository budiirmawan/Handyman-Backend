import { findMobileWorkOrderAssignmentsByWorkOrderId } from '../mobile-assignments';
import type { MobileAssignmentFeedItem } from '../mobile-assignments';
import { notificationNavigationTargetAmbiguousError } from './notification.errors';
import { notificationService } from './notification.service';
import type { PublicNotification } from './notification.types';

/**
 * CR-BE-RN21-NOTIFICATION-NAV-01 — backend-owned navigation target resolution.
 *
 * WHAT THIS OWNS
 * --------------
 * Turning a notification's EXPLICIT persisted navigation target into the
 * canonical object the mobile app must open — `destination` + the real
 * `MobileAssignment` — for the CURRENT authenticated recipient. Nothing else:
 * no read-state change, no push, no second assignment DTO, no frontend route
 * string persisted anywhere.
 *
 * THE TARGET IS READ, NEVER GUESSED
 * ---------------------------------
 * `sourceEntityType`, `sourceEntityId` and `metadata` are NON-NAVIGATION fields
 * and are not read here at all. A notification whose producer declared no
 * target resolves to `{ target: null }` — the client falls back to the inbox,
 * and no client-side interpretation of the source entity is ever needed or
 * permitted.
 *
 * OWNERSHIP IS NOT AUTHORITY
 * --------------------------
 * The notification being the caller's own proves only that they may READ it. It
 * grants no work authority: the assignment is independently resolved through the
 * existing mobile-assignment visibility/authority rules (ACTIVE assignment,
 * caller's own Workforce Profile or Team, Building access, permission-based
 * `availableActions`) — the exact semantics of `GET /mobile/assignments`. A
 * notification can therefore resolve to `null` for a recipient who can read it
 * but cannot see the work.
 *
 * CARDINALITY: 0 → null, 1 → the assignment, >1 → 409
 * ---------------------------------------------------
 * The resolver never selects a winner. `rows[0]`, `LIMIT 1`, ordering and
 * feed-scanning are all explicitly rejected: choosing one of several visible
 * assignments would be the backend making a decision it cannot justify from the
 * data, and the client would act on it.
 *
 * READ STATE IS UNTOUCHED
 * -----------------------
 * Resolving a destination is a READ. The notification stays UNREAD until the
 * client explicitly calls `PATCH /notifications/{id}/read` — so opening the
 * inbox, previewing, or probing a destination can never silently consume the
 * unread state.
 */

/** The only destination type this CR can emit. */
export const NOTIFICATION_NAVIGATION_DESTINATIONS = ['FIELD_WORK'] as const;

export type NotificationNavigationDestination =
  (typeof NOTIFICATION_NAVIGATION_DESTINATIONS)[number];

/**
 * The resolved target, or `null` when nothing safe is navigable (no explicit
 * target, or no visible matching assignment for THIS recipient).
 */
export type NotificationNavigationResolution = {
  destination: NotificationNavigationDestination;
  /** The canonical mobile assignment, identical in shape to the feed item. */
  assignment: MobileAssignmentFeedItem;
};

export type NotificationNavigationTargetResult = {
  target: NotificationNavigationResolution | null;
};

/**
 * Resolves the notification's explicit navigation target for the recipient.
 *
 * Throws `notificationNotFoundError` when the notification is not the
 * recipient's own (missing OR foreign — indistinguishable, never a leak) and
 * `notificationNavigationTargetAmbiguousError` when the target matches more
 * than one visible assignment.
 */
export async function resolveNotificationNavigationTarget(
  recipientUserId: string,
  notificationId: string,
): Promise<NotificationNavigationTargetResult> {
  // Reuses the detail read: recipient-scoped in SQL, 404 for a foreign or
  // missing notification. Ownership is asserted BEFORE any target work, and
  // `sourceEntityType` / `metadata` are never consulted.
  const notification: PublicNotification =
    await notificationService.getNotification(recipientUserId, notificationId);

  const target = notification.navigationTarget;
  if (!target) {
    // No explicit target → no navigation. Never inferred from the source
    // entity fields or the metadata bag.
    return { target: null };
  }

  if (target.type !== 'WORK_ORDER_FIELD_WORK') {
    // A closed vocabulary today; an unrecognised type resolves to no target
    // rather than being interpreted.
    return { target: null };
  }

  // target.id is the canonical `work_orders.id` — asserted by the producer and
  // by the migration 0358 CHECK, which forbids an id without its type.
  const assignments = await findMobileWorkOrderAssignmentsByWorkOrderId(
    recipientUserId,
    target.id,
  );

  if (assignments.length === 0) {
    // Nothing visible to this recipient — no target, never a fallback.
    return { target: null };
  }
  if (assignments.length > 1) {
    // Ambiguous: refuse instead of choosing a winner.
    throw notificationNavigationTargetAmbiguousError(
      notificationId,
      assignments.length,
    );
  }

  return {
    target: {
      destination: 'FIELD_WORK',
      assignment: assignments[0],
    },
  };
}

export const notificationNavigationService = {
  resolveNotificationNavigationTarget,
};
