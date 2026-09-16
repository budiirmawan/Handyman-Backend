import type { VendorWorkPermitReadiness } from '../work-permit-readiness';

/**
 * CR-HM-BE-05 RUN 2 — Handyman service visit + versioned schedule types.
 *
 * A visit is an occurrence identity with minimal state: no arrival/check-in,
 * no GPS/QR/device data, no actual labor timestamps, and no visit status —
 * a cancelled visit is exactly a visit whose schedule history closed with
 * CANCELLED and has no ACTIVE successor. Provider/crew are never copied
 * onto visits or schedules: the authoritative composition resolves from the
 * job's ACTIVE handyman_job_assignments row.
 */

/** Planned-window lifecycle: versioned rows; history is append-only. */
export const HANDYMAN_SERVICE_VISIT_SCHEDULE_STATUSES = [
  'ACTIVE',
  'SUPERSEDED',
  'CANCELLED',
] as const;

export type HandymanServiceVisitScheduleStatus =
  (typeof HANDYMAN_SERVICE_VISIT_SCHEDULE_STATUSES)[number];

export function isHandymanServiceVisitScheduleStatus(
  value: unknown,
): value is HandymanServiceVisitScheduleStatus {
  return (
    typeof value === 'string' &&
    (HANDYMAN_SERVICE_VISIT_SCHEDULE_STATUSES as readonly string[]).includes(
      value,
    )
  );
}

/** Full database record of one visit occurrence. */
export type HandymanServiceVisitRecord = {
  id: string;
  clientId: string;
  handymanJobId: string;
  visitSequence: number;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Full database record of one versioned planned window. */
export type HandymanServiceVisitScheduleRecord = {
  id: string;
  clientId: string;
  handymanServiceVisitId: string;
  plannedStartAt: Date;
  plannedEndAt: Date;
  status: HandymanServiceVisitScheduleStatus;
  createdByUserId: string;
  supersededAt: Date | null;
  supersededByUserId: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representations (IDs, sequence, windows, status only). */
export type PublicHandymanServiceVisit = {
  id: string;
  clientId: string;
  handymanJobId: string;
  visitSequence: number;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicHandymanServiceVisitSchedule = {
  id: string;
  clientId: string;
  handymanServiceVisitId: string;
  plannedStartAt: string;
  plannedEndAt: string;
  status: HandymanServiceVisitScheduleStatus;
  createdByUserId: string;
  supersededAt: string | null;
  supersededByUserId: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Input for the governed create command — BUSINESS FACTS ONLY. Client,
 * provider/vendor, crew, work order, statuses, permit state, and actor
 * identity are all resolved server-side (job → request/WO context, job's
 * ACTIVE composition → provider/crew/vendor work, authenticated actor).
 */
export type CreateHandymanServiceVisitInput = {
  handymanJobId: string;
  plannedStartAt: Date;
  plannedEndAt: Date;
};

/** Input for the governed reschedule command (business facts only). */
export type RescheduleHandymanServiceVisitInput = {
  plannedStartAt: Date;
  plannedEndAt: Date;
};

/** Result of the create command (visit + first ACTIVE window, atomic). */
export type HandymanServiceVisitCreationResult = {
  visit: PublicHandymanServiceVisit;
  schedule: PublicHandymanServiceVisitSchedule;
};

/** Result of the reschedule command (old window SUPERSEDED, new ACTIVE). */
export type HandymanServiceVisitRescheduleResult = {
  visit: PublicHandymanServiceVisit;
  schedule: PublicHandymanServiceVisitSchedule;
  supersededScheduleId: string;
};

/** Result of the cancel command (guarded; replay reports alreadyCancelled). */
export type HandymanServiceVisitCancellationResult = {
  visit: PublicHandymanServiceVisit;
  cancelledScheduleId: string;
  /** true when this call replayed onto an already-CANCELLED schedule. */
  alreadyCancelled: boolean;
};

/** A visit with its current ACTIVE window (null when none is active). */
export type HandymanServiceVisitView = {
  visit: PublicHandymanServiceVisit;
  activeSchedule: PublicHandymanServiceVisitSchedule | null;
};

/**
 * Execution-readiness assessment (a READ — it never transitions the work
 * order, never starts the vendor work, and creates no check-in). Permit
 * readiness is the EXISTING BE-15D aggregate passed through unchanged:
 * zero readiness rows keep the BE-15D NOT_REQUIRED semantics.
 */
export type HandymanServiceVisitExecutionReadiness = {
  handymanServiceVisitId: string;
  handymanJobId: string;
  workOrderId: string;
  vendorWorkId: string;
  ready: boolean;
  checks: {
    hasActiveSchedule: boolean;
    workOrderPreExecution: boolean;
    hasActiveJobAssignment: boolean;
    providerChainValid: boolean;
    crewChainValid: boolean;
    noScheduleConflict: boolean;
    permitsReady: boolean;
  };
  activeSchedule: PublicHandymanServiceVisitSchedule | null;
  permitReadiness: VendorWorkPermitReadiness;
};

/** Internal persistence-ready shapes. */
export type NewHandymanServiceVisit = {
  clientId: string;
  handymanJobId: string;
  visitSequence: number;
  createdByUserId: string;
};

export type NewHandymanServiceVisitSchedule = {
  clientId: string;
  handymanServiceVisitId: string;
  plannedStartAt: Date;
  plannedEndAt: Date;
  createdByUserId: string;
};
