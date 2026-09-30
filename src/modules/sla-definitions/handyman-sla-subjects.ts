/**
 * CR-HM-16 PART 01 — Handyman SLA subject/binding contract over the shared
 * SLA engine (governance `docs/handyman/CR-HM-16_START_GOVERNANCE.md` §4/§5,
 * §7 seam 1, §9 PART 01 row).
 *
 * Frozen vocabulary ONLY. The shared engine's definition selection, applied
 * snapshot, clock, pause, breach and escalation authorities are REUSED as-is;
 * nothing here owns a second engine, scheduler, clock state machine or breach
 * writer (PART 01 forbidden list).
 *
 * Separations preserved:
 *   - SLA Engine != Provider Performance Read Model — nothing in this
 *     contract derives or stores provider performance (roadmap preserve).
 *   - No FM coupling — Handyman subject types are Handyman-Backend entities
 *     (certified CR-HM-02..15 tables), bound polymorphically by `subject_id`
 *     with no FK into FM `work_orders` / `work-order-sla-register` or any
 *     SaaS table.
 */

/**
 * Closed set of Handyman SLA subject types admitted to the shared engine
 * (`sla_definitions.operational_type` / `applied_slas.operational_type`).
 * One applied SLA binds to one subject (`applied_slas.subject_id`), exactly
 * mirroring the Work Order binding law (`UNIQUE(work_order_id)`).
 */
export const HANDYMAN_SLA_SUBJECT_TYPES = [
  'HANDYMAN_SERVICE_REQUEST',
  'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
  'HANDYMAN_EXECUTION_SCOPE',
  'HANDYMAN_DEFECT_RECORD',
  'HANDYMAN_SERVICE_WARRANTY_CLAIM',
] as const;

export type HandymanSlaSubjectType = (typeof HANDYMAN_SLA_SUBJECT_TYPES)[number];

export function isHandymanSlaSubjectType(value: string): value is HandymanSlaSubjectType {
  return (HANDYMAN_SLA_SUBJECT_TYPES as readonly string[]).includes(value);
}

/**
 * Frozen Handyman milestone vocabulary — capability-map row 19 ("SLA /
 * Provider Performance") milestone names: request acknowledgement; quotation
 * turnaround; provider accept/decline; worker assignment; arrival; work
 * completion; defect closure; warranty response; warranty rework.
 *
 * Each milestone binds to exactly ONE clock metric on ONE subject type. The
 * metrics are the engine's existing RESPONSE/RESOLUTION clocks — no new clock
 * type is introduced. A Handyman SLA definition declares targets per subject
 * type; the applied snapshot then materializes the milestone clocks for the
 * bound subject at the subject's authoritative creation instant.
 *
 * Coordinates (frozen):
 *
 *   HANDYMAN_SERVICE_REQUEST          RESPONSE  = REQUEST_ACKNOWLEDGEMENT
 *   HANDYMAN_SERVICE_REQUEST          RESOLUTION = QUOTATION_TURNAROUND
 *   HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT RESPONSE = PROVIDER_ACCEPT_DECLINE
 *   HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT RESOLUTION = WORKER_ASSIGNMENT
 *   HANDYMAN_EXECUTION_SCOPE          RESPONSE  = ARRIVAL
 *   HANDYMAN_EXECUTION_SCOPE          RESOLUTION = WORK_COMPLETION
 *   HANDYMAN_DEFECT_RECORD            RESOLUTION = DEFECT_CLOSURE
 *   HANDYMAN_SERVICE_WARRANTY_CLAIM   RESPONSE  = WARRANTY_RESPONSE
 *   HANDYMAN_SERVICE_WARRANTY_CLAIM   RESOLUTION = WARRANTY_REWORK
 *
 * (`HANDYMAN_DEFECT_RECORD` RESPONSE is intentionally unassigned: defect
 * triage is not a frozen capability-map milestone.)
 */
export const HANDYMAN_SLA_SUBJECT_MILESTONES = [
  { milestone: 'REQUEST_ACKNOWLEDGEMENT', subjectType: 'HANDYMAN_SERVICE_REQUEST', clockType: 'RESPONSE' },
  { milestone: 'QUOTATION_TURNAROUND', subjectType: 'HANDYMAN_SERVICE_REQUEST', clockType: 'RESOLUTION' },
  { milestone: 'PROVIDER_ACCEPT_DECLINE', subjectType: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT', clockType: 'RESPONSE' },
  { milestone: 'WORKER_ASSIGNMENT', subjectType: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT', clockType: 'RESOLUTION' },
  { milestone: 'ARRIVAL', subjectType: 'HANDYMAN_EXECUTION_SCOPE', clockType: 'RESPONSE' },
  { milestone: 'WORK_COMPLETION', subjectType: 'HANDYMAN_EXECUTION_SCOPE', clockType: 'RESOLUTION' },
  { milestone: 'DEFECT_CLOSURE', subjectType: 'HANDYMAN_DEFECT_RECORD', clockType: 'RESOLUTION' },
  { milestone: 'WARRANTY_RESPONSE', subjectType: 'HANDYMAN_SERVICE_WARRANTY_CLAIM', clockType: 'RESPONSE' },
  { milestone: 'WARRANTY_REWORK', subjectType: 'HANDYMAN_SERVICE_WARRANTY_CLAIM', clockType: 'RESOLUTION' },
] as const;

export type HandymanSlaMilestoneName = (typeof HANDYMAN_SLA_SUBJECT_MILESTONES)[number]['milestone'];
