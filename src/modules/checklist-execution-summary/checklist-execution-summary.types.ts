/**
 * CR-BE-REPORT-READ-04 PART 01 — Checklist Execution Summary read contract types.
 *
 * READ MODEL ONLY. One flat row per authoritative execution row, unifying
 * BE-07's two execution engines (`checklist_executions` and `form_instances`)
 * at the conservative summary grain. Both engines share lifecycle shape and
 * shared evidence / finding / review attachments, but have distinct template
 * identity, item schema, and binding paths. This contract exposes an explicit
 * `engine` discriminator and never merges two executions into one row.
 *
 * WHAT THIS CONTRACT IS NOT
 *   - It creates no business entity, lifecycle status, or persistence.
 *   - It performs no result-vocabulary normalization (OK/Not-OK, Pass/Fail,
 *     Normal/Abnormal, B/K/R, etc.); `result` TEXT is never inspected and
 *     JSONB response values are never interpreted.
 *   - It infers no executor attribution — neither engine stores an
 *     authoritative executor column; reconstructing from evidence uploader,
 *     reviews, generated tasks, or event history is forbidden.
 *   - It exposes no rework / history / measurement aggregates / SLA /
 *     overdue / risk (rework is finding-scoped; operational_events has no
 *     entity_type for executions; measurement interpretation belongs to a
 *     later detail read contract).
 *   - It does not hard-code Engineering / Housekeeping / Security report
 *     families; no domain metadata field exists on either engine.
 *
 * Grain: exactly one row per execution with an authoritative resolvable
 * Building. Executions whose Building cannot be resolved through an
 * established binding path are excluded (fail-closed), never guessed.
 */

export type ChecklistExecutionEngine = 'CHECKLIST_EXECUTION' | 'FORM_INSTANCE';

export const CHECKLIST_EXECUTION_ENGINES: readonly ChecklistExecutionEngine[] = [
  'CHECKLIST_EXECUTION',
  'FORM_INSTANCE',
];

export function isChecklistExecutionEngine(
  value: unknown,
): value is ChecklistExecutionEngine {
  return (
    typeof value === 'string' &&
    (CHECKLIST_EXECUTION_ENGINES as readonly string[]).includes(value)
  );
}

/**
 * V1 filters. Conservative and strictly derived from the authoritative
 * columns. templateId refers to the parent/business template (checklist_templates
 * for CE, form_templates for FI), not the version.
 */
export type ChecklistExecutionSummaryFilters = {
  buildingId?: string;
  engine?: ChecklistExecutionEngine;
  status?: string;
  templateId?: string;
  assetId?: string;
  functionalLocationId?: string;
  vendorId?: string;
  verificationDecision?: string;
  dateFrom?: string;
  dateTo?: string;
};

/** One flat execution summary row. */
export type PublicChecklistExecutionSummaryRow = {
  /* Identity */
  engine: ChecklistExecutionEngine;
  executionId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;

  /* Template / form identity */
  templateId: string | null;
  templateCode: string | null;
  templateName: string | null;
  templateVersionId: string | null;
  templateVersionNumber: number | null;

  /* Resolved context */
  clientId: string;
  buildingId: string;
  assetId: string | null;
  functionalLocationId: string | null;
  vendorId: string | null;

  /* Authoritative counts */
  itemCount: number;
  evidenceCount: number;
  findingCount: number;

  /* Verification — latest COMPLETED review */
  verificationReviewId: string | null;
  verificationReviewStatus: string | null;
  verificationDecision: string | null;
  verificationReviewerUserId: string | null;
  verificationReviewedAt: string | null;
};

export type PublicChecklistExecutionSummary = {
  buildingId: string | null;
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  asOf: string;
  rows: PublicChecklistExecutionSummaryRow[];
};
