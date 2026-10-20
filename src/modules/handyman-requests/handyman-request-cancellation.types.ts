/**
 * CR-HM-18 REQUEST-CANCEL-01 — Handyman request cancellation types.
 *
 * The cancellation fact is derived on the server: previous status comes
 * from the locked request row, client/building/attribution provenance
 * comes from the request itself, the actor comes from `req.auth`. A caller
 * supplies exactly two things: a bounded `reason` and an `idempotencyKey`.
 */

/**
 * States from which cancellation is permitted (pre-commitment only).
 * `REFERRED` and `CANCELLED` are terminal and deliberately absent.
 */
export const HANDYMAN_REQUEST_CANCELLABLE_STATUSES = [
  'INTAKE',
  'TRIAGE',
  'INSPECTION_REQUIRED',
  'DIAGNOSIS',
  'READY_FOR_NEXT_STEP',
] as const;

export type HandymanRequestCancellableStatus =
  (typeof HANDYMAN_REQUEST_CANCELLABLE_STATUSES)[number];

export function isHandymanRequestCancellableStatus(
  value: unknown,
): value is HandymanRequestCancellableStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_REQUEST_CANCELLABLE_STATUSES as readonly string[]).includes(
      value,
    )
  );
}

/** Persisted append-only cancellation record. */
export type HandymanRequestCancellationRecord = {
  id: string;
  clientId: string;
  handymanRequestId: string;
  channelAttributionId: string;
  buildingId: string;
  /** Request status observed under the row lock at cancellation time. */
  previousStatus: HandymanRequestCancellableStatus;
  reason: string;
  cancelledByUserId: string;
  idempotencyKey: string;
  occurredAt: Date;
};

export type NewHandymanRequestCancellationRecord = Omit<
  HandymanRequestCancellationRecord,
  'id' | 'occurredAt'
>;

/** Safe public representation (`occurredAt` ISO). */
export type PublicHandymanRequestCancellation = Omit<
  HandymanRequestCancellationRecord,
  'occurredAt'
> & {
  occurredAt: string;
};

/** Caller input — actor/provenance/status are never input. */
export type CancelHandymanRequestInput = {
  handymanRequestId: string;
  reason: string;
  idempotencyKey: string;
};

/** Result of the cancellation command (replay-safe). */
export type HandymanRequestCancellationResult =
  PublicHandymanRequestCancellation & {
    /** Request status after the command (`CANCELLED`). */
    requestStatus: 'CANCELLED';
    replayed: boolean;
  };
