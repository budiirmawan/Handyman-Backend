/**
 * CR-HM-BE-06 RUN 2 — Handyman work session types.
 *
 * A work session is a VISIT-SCOPED EXECUTION WINDOW FACT: OPEN → CLOSED is
 * the only lifecycle, start facts are frozen at INSERT, and the session
 * never owns the vendor_work / work_order lifecycle (those transition
 * exclusively through their owning BE-15B / BE-08C authorities in the
 * post-commit seam). No DELETED and no PAUSED state; no billing, payroll,
 * or duration-as-money fields exist anywhere in this module.
 */

export const HANDYMAN_WORK_SESSION_STATUSES = ['OPEN', 'CLOSED'] as const;
export type HandymanWorkSessionStatus =
  (typeof HANDYMAN_WORK_SESSION_STATUSES)[number];

export function isHandymanWorkSessionStatus(
  value: string,
): value is HandymanWorkSessionStatus {
  return (HANDYMAN_WORK_SESSION_STATUSES as readonly string[]).includes(value);
}

export type HandymanWorkSessionRecord = {
  id: string;
  clientId: string;
  visitId: string;
  /** Frozen at START: the vendor work in force when the session opened. */
  vendorWorkId: string;
  /** Frozen at START: the ACTIVE composition in force at session start. */
  handymanJobAssignmentId: string;
  status: HandymanWorkSessionStatus;
  /** Server-authoritative start time (database clock). */
  startedAt: Date;
  startedByUserId: string;
  /** Server-authoritative end time; NULL while OPEN. */
  endedAt: Date | null;
  /** Actual closing actor (IDs only — auditable closure attribution). */
  endedByUserId: string | null;
  /**
   * Nullable client-claimed evidence timestamp carried by the established
   * offline convention (Run-1 arrivals). NEVER lifecycle authority: every
   * legal decision uses the server-stamped started_at/ended_at.
   */
  occurredAt: Date | null;
  idempotencyKey: string;
  idempotencyFingerprint: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Read model (Run 3 HTTP surface): identity + execution-window facts +
 * actor IDs only. Deliberately NO worker PII, NO GPS/device data, NO
 * billing or payroll fields — none of them exist on the row.
 */
export type PublicHandymanWorkSession = {
  id: string;
  clientId: string;
  visitId: string;
  vendorWorkId: string;
  handymanJobAssignmentId: string;
  status: HandymanWorkSessionStatus;
  startedAt: string;
  startedByUserId: string;
  endedAt: string | null;
  endedByUserId: string | null;
  occurredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Start command input (§2 — business/replay facts ONLY). Everything
 * authoritative (client, job, work order, vendor work, composition, actor,
 * started_at, status) is resolved server-side from the visit and the
 * authenticated actor; the command never accepts ids or lifecycle states.
 */
export type StartHandymanWorkSessionInput = {
  /** Optional client-claimed evidence timestamp (offline convention). */
  occurredAt?: string | null;
  idempotencyKey: string;
};

/** Execution-lifecycle state as converged by the guarded start seam. */
export type HandymanExecutionStartState = {
  vendorWorkStatus: string;
  workOrderStatus: string;
};

export type HandymanWorkSessionStartResult = {
  session: PublicHandymanWorkSession;
  /** True when the command converged onto an existing session fact. */
  converged: boolean;
  execution: HandymanExecutionStartState;
};

export type HandymanWorkSessionEndResult = {
  session: PublicHandymanWorkSession;
  /** True when the session was already CLOSED (replay-safe end). */
  converged: boolean;
};
