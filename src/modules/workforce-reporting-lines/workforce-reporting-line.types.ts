/**
 * BE-03F — Workforce Reporting Line domain types.
 *
 * Records who a Workforce Profile reports to:
 *
 *   Workforce Profile → Reporting Line → Supervisor Workforce Profile
 *
 * The Supervisor is always another Workforce Profile (BE-03C). The relationship
 * is authoritative persisted data — it is never inferred from Role, Position,
 * Team, or a Department's name.
 *
 * Reporting lines change over time, so a superseded line is deactivated and
 * kept rather than deleted. `effectiveFrom` / `effectiveUntil` are both
 * optional: an undated line simply stands until it is deactivated.
 *
 * A Reporting Line grants nothing. It never implies or changes a Role,
 * Permission, Position, Team, Shift, Skill, or Building Assignment, and there
 * is no approval workflow or task verification attached to it.
 */
export const WORKFORCE_REPORTING_LINE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type WorkforceReportingLineStatus =
  (typeof WORKFORCE_REPORTING_LINE_STATUSES)[number];

export function isWorkforceReportingLineStatus(
  value: unknown,
): value is WorkforceReportingLineStatus {
  return (
    typeof value === 'string' &&
    (WORKFORCE_REPORTING_LINE_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type WorkforceReportingLineRecord = {
  id: string;
  workforceProfileId: string;
  supervisorWorkforceProfileId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: WorkforceReportingLineStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicWorkforceReportingLine = {
  id: string;
  workforceProfileId: string;
  supervisorWorkforceProfileId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: WorkforceReportingLineStatus;
};

/** Input supplied by the API consumer when assigning a Supervisor. */
export type AssignSupervisorInput = {
  workforceProfileId: string;
  supervisorWorkforceProfileId: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: WorkforceReportingLineStatus;
};

/** Fully-resolved data ready for persistence. */
export type NewWorkforceReportingLine = {
  workforceProfileId: string;
  supervisorWorkforceProfileId: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  status: WorkforceReportingLineStatus;
};

/**
 * Partial update input. Deactivation is `status: 'INACTIVE'`.
 *
 * `supervisorWorkforceProfileId` may be changed here: re-pointing the current
 * reporting line is the normal way a reporting line changes over time.
 */
export type UpdateWorkforceReportingLineInput = {
  supervisorWorkforceProfileId?: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: WorkforceReportingLineStatus;
};

/**
 * The Supervisor genuinely in force for a Workforce Profile right now, as
 * returned by `resolveCurrentSupervisor`. The supervisor's identifying profile
 * fields are denormalised in so callers get a usable answer from one call.
 */
export type CurrentSupervisor = {
  reportingLineId: string;
  workforceProfileId: string;
  supervisorWorkforceProfileId: string;
  employeeCode: string;
  fullName: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
};

/**
 * One direct report of a Supervisor, as returned by `listDirectReports`. The
 * profile fields are denormalised into the result so callers do not have to
 * re-fetch each subordinate profile just to display the list.
 */
export type DirectReport = {
  reportingLineId: string;
  workforceProfileId: string;
  employeeCode: string;
  fullName: string;
  status: WorkforceReportingLineStatus;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
};
