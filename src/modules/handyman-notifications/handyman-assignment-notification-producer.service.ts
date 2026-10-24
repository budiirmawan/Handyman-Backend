import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { PublicNotificationNavigationTarget } from '../notifications/notification.types';
import type {
  NotificationDeliveryExecutor,
  OutboundDeliveryIntentResult,
} from '../notification-delivery';
import {
  handymanAssignmentNotificationContractFor,
  type HandymanAssignmentNotificationEventType,
  type HandymanAssignmentNotificationTargetType,
} from './handyman-assignment-notification.contract';
import { emitHandymanNotificationIntent } from './handyman-notification-intent.service';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 01 — Handyman ASSIGNMENT
 * notification producer.
 *
 * WHAT THIS OWNS
 * --------------
 * The ONE producer that turns a real Handyman assignment event into durable
 * notification records:
 *
 *   - the IN_APP record of the assignment (BE-26A `notifications`), written
 *     on the caller's transaction and deduplicated on the assignment dedup
 *     index, and
 *   - the OUTBOUND delivery INTENTS of the same event (the existing
 *     `notification_outbound_deliveries` ledger), produced through the reused
 *     BE-26 / CR-BE-NOTIFY-PROV-01 chain — subscription → template →
 *     recipients → idempotent ledger row.
 *
 * WHY THE PRODUCER EXISTS
 * ------------------------
 * Before this PART, the assignment authorities wrote the IN_APP record
 * themselves and NOTHING reached the durable outbound pipeline: an
 * assignment event could never produce an EMAIL/WHATSAPP delivery intent,
 * and the Handyman notification intent seam had no caller at all. The
 * producer is the seam's first real caller and the single place where an
 * assignment event becomes a notification intent.
 *
 * GUARANTEES
 * ----------
 *   - FAIL-CLOSED ADMISSION: an event type outside the frozen assignment
 *     contract is rejected and NOTHING is written.
 *   - ATOMICITY: every record is written on the caller's executor, so the
 *     notification commits or rolls back with the assignment fact. No
 *     phantom notification can survive a rolled-back assignment.
 *   - NO DUPLICATES: the IN_APP record is deduplicated on
 *     `(recipient, assignment scope, assignment id, event type)` and the
 *     outbound intent on the delivery idempotency key, so a retried or
 *     repeated command produces no second intent.
 *   - SCOPE: the tenant (client) and building are the ASSIGNMENT's own
 *     context (never caller-asserted), the building must belong to the
 *     client, and a recipient that is provably scoped to a DIFFERENT tenant
 *     is rejected. An invalid recipient is never notified.
 *   - CLIENT-NEUTRAL SEMANTICS: every emitted record carries the event
 *     identity, the recipient, the work order reference, the assignment
 *     reference and the backend-owned navigation target. Nothing in the
 *     payload names a transport, a provider or a client platform.
 *
 * WHAT THIS NEVER OWNS
 * --------------------
 * No channel selection, no provider, no transport, no scheduler, no second
 * outbox, no second notification stack. The ledger, the template store, the
 * subscription authority and the recipient resolution stay the reused BE-26
 * capability.
 */

/** Any executor: the pool, or the caller's open transaction client. */
type Q = Pick<Pool | PoolClient, 'query'>;

/** The content of the assignment notification (a domain fact, not a template). */
export type HandymanAssignmentNotificationContent = {
  /** The notification type recorded on the in-app record. */
  type: string;
  title: string;
  body: string;
  /** The client-neutral payload: work order, assignment, building, response. */
  metadata: Record<string, unknown>;
  /** The backend-owned navigation target of the notification. */
  navigationTarget?: PublicNotificationNavigationTarget | null;
};

/** The producer input — one occurred assignment event and its audience. */
export type HandymanAssignmentNotificationIntentInput = {
  /** The occurred assignment event (must be admitted by the contract). */
  eventType: HandymanAssignmentNotificationEventType;
  /** The tenant of the assignment (authoritative, never caller-asserted). */
  clientId: string;
  /** The building of the assignment, when the assignment has one. */
  buildingId: string | null;
  /** The assignment scope of the event. */
  assignmentTargetType: HandymanAssignmentNotificationTargetType;
  /** The assignment the event is about. */
  assignmentId: string;
  /** The Work Order the assignment belongs to, when it has one. */
  workOrderId?: string | null;
  /** The audience of the event, resolved by the assignment authority. */
  recipientUserIds: string[];
  /** The notification content of the event. */
  content: HandymanAssignmentNotificationContent;
  /** Template variables for the outbound intent render. */
  variables?: Record<string, string | number>;
  /**
   * The executor the notification records are written on. Pass the
   * assignment transaction client so the notification is atomic with the
   * assignment fact.
   */
  executor?: Q;
};

/** The producer result (observability; the records are the durable fact). */
export type HandymanAssignmentNotificationIntentResult = {
  eventType: string;
  assignmentId: string;
  /** The recipients the event was actually delivered to. */
  recipientsResolved: number;
  /** The requested recipients that were rejected as invalid or out of scope. */
  recipientsRejected: number;
  /** IN_APP records created by this run. */
  inAppCreated: number;
  /** IN_APP records suppressed by the assignment dedup guard. */
  inAppSuppressed: number;
  /** The outbound intent summary of the reused delivery chain. */
  outbound: OutboundDeliveryIntentResult;
  /**
   * The notification CONFIGURATION failure that stopped the outbound intent
   * chain, when one happened. The domain command is never failed by it — the
   * in-app record is the assignment's guarantee.
   */
  outboundError: string | null;
};

/**
 * The IN_APP input of one assignment notification. Kept structurally equal
 * to the pre-existing `AssignmentNotificationInput` so the seam can be
 * re-exported without breaking any caller.
 */
export type AssignmentNotificationInput = {
  clientId: string;
  recipientUserId: string;
  type: string;
  title: string;
  body: string;
  sourceEntityType: HandymanAssignmentNotificationTargetType;
  sourceEntityId: string;
  sourceEventType: string;
  metadata: Record<string, unknown>;
  navigationTarget?: PublicNotificationNavigationTarget | null;
};

/**
 * Inserts an `IN_APP` notification on the caller's transactional executor,
 * deduplicated on `(recipient_user_id, source_entity_type, source_entity_id, source_event_type)`
 * via `notifications_assignment_response_dedup_idx` (migration 0472).
 *
 * Because this runs inside the same database transaction as the assignment or
 * response mutation, any transaction rollback automatically rolls back the
 * notification row — eliminating phantom notifications.
 *
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 01 — the seam MOVED here from
 * `assignment-responses/assignment-response.notifications.ts` so that the ONE
 * Handyman notification producer owns both the in-app record and the outbound
 * intent of an assignment event. The behaviour, the SQL and the dedup guard
 * are unchanged; `assignment-responses` re-exports it.
 */
export async function recordDeduplicatedAssignmentNotification(
  input: AssignmentNotificationInput,
  executor: Q,
): Promise<string | null> {
  const result = await executor.query<{ id: string }>(
    `INSERT INTO notifications (
       id, client_id, recipient_user_id, type, channel, status, title, body,
       source_entity_type, source_entity_id, source_event_type, template_key,
       metadata, navigation_target_type, navigation_target_id
     )
     VALUES ($1, $2, $3, $4, 'IN_APP', 'UNREAD', $5, $6, $7, $8, $9, NULL, $10, $11, $12)
     ON CONFLICT (recipient_user_id, source_entity_type, source_entity_id, source_event_type)
       WHERE source_entity_type IN (
         'WORK_ORDER_ASSIGNMENT',
         'EXECUTION_SCOPE_ASSIGNMENT',
         'INSPECTOR_VISIT_ASSIGNMENT'
       )
       AND source_event_type IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      input.clientId,
      input.recipientUserId,
      input.type,
      input.title,
      input.body,
      input.sourceEntityType,
      input.sourceEntityId,
      input.sourceEventType,
      input.metadata,
      input.navigationTarget?.type ?? null,
      input.navigationTarget?.id ?? null,
    ],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Produces the notification records of one occurred Handyman assignment
 * event. Fails closed on an unadmitted event type, an inconsistent tenant
 * context or a malformed recipient — in every one of those cases NOTHING is
 * written.
 */
export async function emitHandymanAssignmentNotificationIntent(
  input: HandymanAssignmentNotificationIntentInput,
): Promise<HandymanAssignmentNotificationIntentResult> {
  const executor: Q = input.executor ?? getPool();

  // ---- 1. FAIL-CLOSED ADMISSION ---------------------------------------
  const contract = handymanAssignmentNotificationContractFor(input.eventType);
  if (!contract) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'eventType',
        message:
          'eventType must be an admitted Handyman assignment notification event type.',
      },
    ]);
  }
  if (contract.assignmentTargetType !== input.assignmentTargetType) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'assignmentTargetType',
        message: `assignmentTargetType must be ${contract.assignmentTargetType} for event ${contract.eventType}.`,
      },
    ]);
  }

  // ---- 2. TENANT + ASSIGNMENT SCOPE -----------------------------------
  if (!isValidUuid(input.clientId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'clientId must be a valid UUID.' },
    ]);
  }
  if (input.buildingId !== null && !isValidUuid(input.buildingId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'buildingId must be a valid UUID.' },
    ]);
  }
  if (!isValidUuid(input.assignmentId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'assignmentId', message: 'assignmentId must be a valid UUID.' },
    ]);
  }
  if (input.buildingId !== null) {
    const buildingClientId = await resolveBuildingClientId(input.buildingId, executor);
    if (buildingClientId !== input.clientId) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'buildingId',
          message: 'buildingId does not belong to the given Client.',
        },
      ]);
    }
  }

  // ---- 3. RECIPIENT SCOPE ---------------------------------------------
  const requested = Array.from(new Set(input.recipientUserIds));
  for (const recipient of requested) {
    if (!isValidUuid(recipient)) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'recipientUserIds',
          message: 'Every recipient must be a valid User UUID.',
        },
      ]);
    }
  }
  const activeRecipients = await resolveActiveUserIds(requested, executor);
  const recipients = await filterRecipientsByTenant(
    activeRecipients,
    input.clientId,
    executor,
  );
  const recipientsRejected = requested.length - recipients.length;

  const emptyOutbound: OutboundDeliveryIntentResult = {
    eventType: contract.eventType,
    channels: [],
    subscriptionsMatched: 0,
    templatesSkipped: 0,
    recipientsResolved: 0,
    recipientsSkipped: 0,
    deliveriesCreated: 0,
    duplicatesSuppressed: 0,
  };

  if (recipients.length === 0) {
    return {
      eventType: contract.eventType,
      assignmentId: input.assignmentId,
      recipientsResolved: 0,
      recipientsRejected,
      inAppCreated: 0,
      inAppSuppressed: 0,
      outbound: emptyOutbound,
      outboundError: null,
    };
  }

  // ---- 4. THE IN_APP RECORD (transactional, deduplicated) --------------
  let inAppCreated = 0;
  let inAppSuppressed = 0;
  for (const recipientUserId of recipients) {
    const created = await recordDeduplicatedAssignmentNotification(
      {
        clientId: input.clientId,
        recipientUserId,
        type: input.content.type,
        title: input.content.title,
        body: input.content.body,
        sourceEntityType: input.assignmentTargetType,
        sourceEntityId: input.assignmentId,
        sourceEventType: contract.eventType,
        metadata: input.content.metadata,
        navigationTarget: input.content.navigationTarget ?? null,
      },
      executor,
    );
    if (created) {
      inAppCreated += 1;
    } else {
      inAppSuppressed += 1;
    }
  }

  // ---- 5. THE OUTBOUND INTENTS (the reused durable delivery ledger) ---
  // The subscription authority owns WHICH channel and WHICH template apply;
  // the assignment authority owns WHO the event is about. The seam is the
  // ONE Handyman producer, so the assignment event reaches the durable
  // outbound pipeline through it.
  //
  // FAIL-SAFE: a notification CONFIGURATION failure (a template whose
  // variables the event cannot satisfy, an invalid template reference) must
  // never break a domain command — the assignment is the authority and the
  // notification only REACTS to it. The failure is recorded on the result. A
  // DATABASE failure is fatal: the transaction must roll back rather than
  // commit a half-written fact.
  let outbound: OutboundDeliveryIntentResult = emptyOutbound;
  let outboundError: string | null = null;
  try {
    const intent = await emitHandymanNotificationIntent(
      {
        eventType: contract.eventType,
        clientId: input.clientId,
        entityType: input.assignmentTargetType,
        entityId: input.assignmentId,
        buildingId: input.buildingId,
        recipients,
        variables: input.variables ?? scalarVariables(input.content.metadata),
      },
      {
        executor,
        // The in-app record of an assignment event is written above: its copy
        // and its navigation target are assignment facts, not template output.
        deliverInApp: false,
      },
    );
    outbound = intent.outbound;
  } catch (error) {
    if (!(error instanceof AppError)) {
      throw error;
    }
    outboundError = error.message;
  }

  return {
    eventType: contract.eventType,
    assignmentId: input.assignmentId,
    recipientsResolved: recipients.length,
    recipientsRejected,
    inAppCreated,
    inAppSuppressed,
    outbound,
    outboundError,
  };
}

/**
 * Resolves the Client that owns a Building (Building → Property → Client).
 * The tenant of a notification is derived authoritatively, never asserted by
 * the caller.
 */
async function resolveBuildingClientId(
  buildingId: string,
  executor: Q,
): Promise<string | null> {
  const result = await executor.query<{ clientId: string }>(
    `SELECT p.client_id AS "clientId"
       FROM buildings b
       JOIN properties p ON p.id = b.property_id
      WHERE b.id = $1`,
    [buildingId],
  );
  return result.rows[0]?.clientId ?? null;
}

/** Keeps only the recipients that are ACTIVE users. */
async function resolveActiveUserIds(
  candidateIds: string[],
  executor: Q,
): Promise<string[]> {
  if (candidateIds.length === 0) return [];
  const result = await executor.query<{ id: string }>(
    `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND status = 'ACTIVE'`,
    [candidateIds],
  );
  return result.rows.map((row) => row.id);
}

/**
 * The TENANT guard on the audience.
 *
 * A recipient is rejected when its own tenant context (its Building contexts
 * and its Workforce/Organization contexts) is provably scoped to a DIFFERENT
 * client. A recipient without any tenant context is NOT rejected: the
 * assignment authority is the one that authorised it, and the backend has no
 * evidence that it belongs to another tenant.
 */
async function filterRecipientsByTenant(
  candidateIds: string[],
  clientId: string,
  executor: Q,
): Promise<string[]> {
  if (candidateIds.length === 0) return [];

  const tenantRows = await executor.query<{ userId: string; clientId: string }>(
    `SELECT DISTINCT uba.user_id AS "userId", p.client_id AS "clientId"
       FROM user_building_assignments uba
       JOIN buildings b ON b.id = uba.building_id AND b.status = 'ACTIVE'
       JOIN properties p ON p.id = b.property_id
      WHERE uba.user_id = ANY($1::uuid[])
        AND uba.status = 'ACTIVE'
     UNION
     SELECT DISTINCT wp.user_id AS "userId", o.client_id AS "clientId"
       FROM workforce_profiles wp
       JOIN organizations o ON o.id = wp.organization_id
      WHERE wp.user_id = ANY($1::uuid[])
        AND wp.status = 'ACTIVE'`,
    [candidateIds],
  );

  const tenantByUser = new Map<string, Set<string>>();
  for (const row of tenantRows.rows) {
    const set = tenantByUser.get(row.userId) ?? new Set<string>();
    set.add(row.clientId);
    tenantByUser.set(row.userId, set);
  }

  return candidateIds.filter((userId) => {
    const tenants = tenantByUser.get(userId);
    if (!tenants || tenants.size === 0) return true;
    return tenants.has(clientId);
  });
}

/**
 * The template variables of the outbound render, derived from the
 * client-neutral payload (scalar values only).
 */
function scalarVariables(
  metadata: Record<string, unknown>,
): Record<string, string | number> {
  const variables: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' || typeof value === 'number') {
      variables[key] = value;
    }
  }
  return variables;
}

export const handymanAssignmentNotificationProducerService = {
  emitHandymanAssignmentNotificationIntent,
  recordDeduplicatedAssignmentNotification,
};
