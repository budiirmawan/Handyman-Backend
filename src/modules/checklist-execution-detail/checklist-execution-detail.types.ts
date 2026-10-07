/**
 * R07 PART 01A — Checklist Detail Read Projection Core
 *
 * READ MODEL ONLY. Checklist-engine item-level detail.
 * Grain: ONE ROW per (checklist_execution_id + checklist_item_id)
 * Model: checklist execution JOIN checklist_items LEFT JOIN checklist_item_responses
 *
 * HISTORICAL SAFETY:
 *   STABLE (durable response/assignment/completion/review/option-code facts):
 *     - responseId, value, result, notes, isNa, naNotes, responseCreatedAt,
 *       responseUpdatedAt, lastRespondedByUserId
 *     - optionCode (immutable code)
 *     - completedByUserId, assigneeType, assignedWorkforceProfileId,
 *       assignedTeamId, assignmentSnapshotAt
 *     - verificationReviewId/Status/Decision/ReviewerUserId/ReviewedAt
 *   LIVE (current definition, NOT historically faithful):
 *     - itemLabel, itemType, displayOrder, required, uomId,
 *       minimumValue, maximumValue, decimalPrecision,
 *       isNaAllowed, naRequiresNote, optionLabel, template metadata
 *   R09 PART 01A identification context (current master facts, NOT snapshots):
 *     - definitionCode (checklist_items.code — current authoritative
 *       definition code; write authority has no code update path;
 *       NOT a version snapshot)
 *     - templateCode (checklist_templates.code — current template master
 *       fact; execution FK is NOT NULL, inner join on PK is 1:1)
 *     - templateName (checklist_templates.name — CURRENT LIVE FACT,
 *       mutable via template administration; NOT a historical snapshot)
 *   R09 PART 02A1 UOM presentation (CURRENT LIVE FACTS, NOT snapshots):
 *     - uomName (units_of_measure.name — client-scoped master label;
 *       fail-closed NULL when uom_id is NULL or the UOM belongs to another
 *       client; structural client-equality join)
 *     - uomSymbol (units_of_measure.symbol — client-scoped master symbol;
 *       NOT unique; same fail-closed NULL behavior)
 *   R09 PART 02B1 actor presentation (CURRENT LIVE FACTS, NOT snapshots):
 *     - completedByName (users.display_name resolved from completedByUserId;
 *       PK LEFT JOIN on the global users identity master; fail-closed NULL)
 *     - lastRespondedByName (users.display_name resolved from
 *       lastRespondedByUserId; same rule)
 *     - verificationReviewerName (users.display_name resolved from
 *       verificationReviewerUserId; same rule; R06/R07 verification semantic
 *       unchanged)
 *   R09 PART 02C1 assignment-target presentation (CURRENT LIVE FACTS, NOT
 *   assignment snapshots and NOT actual-executor facts):
 *     - assignedWorkforceName (workforce_profiles.full_name resolved from the
 *       persisted assignedWorkforceProfileId with structural client lineage)
 *     - assignedTeamName (teams.name resolved from the persisted assignedTeamId
 *       with structural client lineage; team-only, not an individual executor)
 *
 * No executor field exists — assignment snapshot is NOT executor.
 * No PASS/FAIL semantic calculation — native values only.
 * No evidence/finding/rework/form joins in this PART.
 */

export type ChecklistDetailItemType = 'CHECK' | 'BOOLEAN' | 'TEXT' | 'NUMBER' | 'SELECT';

export type PublicChecklistExecutionDetailRow = {
  /* Identity — composite grain */
  executionId: string;
  checklistItemId: string;
  responseId: string | null; // NULL = UNANSWERED

  /* Execution context — from ce_base (R04 authority reuse) */
  clientId: string;
  buildingId: string;
  templateId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string; // execution created_at for ordering parity with R04
  updatedAt: string;

  /* Definition & template identification — R09 PART 01A (current master facts, NOT snapshots) */
  definitionCode: string; // checklist_items.code — current authoritative definition code (NOT a version snapshot; write authority has no code update path)
  templateCode: string; // checklist_templates.code — current template master fact (execution FK NOT NULL; inner join on template PK is 1:1)
  templateName: string; // checklist_templates.name — CURRENT LIVE FACT (mutable via template administration; NOT a historical snapshot)

  /* Definition metadata — LIVE, not snapshot */
  itemLabel: string; // LIVE
  itemType: ChecklistDetailItemType; // LIVE
  displayOrder: number; // LIVE
  required: boolean; // LIVE
  uomId: string | null; // LIVE
  uomName: string | null; // CURRENT LIVE FACT — client-scoped units_of_measure label (structural client-equality join; NULL when uom_id is NULL or UOM is another client's; NOT a historical snapshot)
  uomSymbol: string | null; // CURRENT LIVE FACT — client-scoped units_of_measure symbol (NOT unique; same fail-closed NULL behavior; NOT a historical snapshot)
  minimumValue: string | null; // LIVE — NUMERIC as text to preserve precision
  maximumValue: string | null; // LIVE
  decimalPrecision: number | null; // LIVE
  isNaAllowed: boolean; // LIVE
  naRequiresNote: boolean; // LIVE

  /* Response — STABLE, native semantics */
  value: unknown | null; // JSONB native: boolean|number|string code|null
  result: string | null; // verbatim TEXT
  notes: string | null;
  isNa: boolean; // FALSE when unanswered, TRUE only when explicit N/A row
  naNotes: string | null;
  responseCreatedAt: string | null; // NULL when unanswered
  responseUpdatedAt: string | null;
  lastRespondedByUserId: string | null; // NULL historical pre-R06 or unanswered
  lastRespondedByName: string | null; // CURRENT LIVE FACT — users.display_name resolved from lastRespondedByUserId (PK LEFT JOIN, global identity; NULL when the ID is NULL or unresolved; NOT a historical snapshot)

  /* R06 execution attribution — STABLE */
  completedByUserId: string | null;
  completedByName: string | null; // CURRENT LIVE FACT — users.display_name resolved from completedByUserId (PK LEFT JOIN, global identity; NULL when the ID is NULL or unresolved; NOT a historical snapshot)
  assigneeType: string | null; // WORKFORCE | TEAM | NULL
  assignedWorkforceProfileId: string | null;
  assignedWorkforceName: string | null; // CURRENT LIVE FACT — workforce_profiles.full_name; NOT a historical assignment snapshot; NOT an actual executor
  assignedTeamId: string | null;
  assignedTeamName: string | null; // CURRENT LIVE FACT — teams.name; NOT a historical assignment snapshot; team-only, NOT an actual executor
  assignmentSnapshotAt: string | null;

  /* Verification — execution-level, repeats per detail row */
  verificationReviewId: string | null;
  verificationStatus: string | null;
  verificationDecision: string | null;
  verificationReviewerUserId: string | null;
  verificationReviewerName: string | null; // CURRENT LIVE FACT — users.display_name resolved from verificationReviewerUserId (PK LEFT JOIN, global identity; latest-COMPLETED-review semantic unchanged; NULL when the ID is NULL or unresolved; NOT a historical snapshot)
  verificationReviewedAt: string | null;

  /* SELECT — code STABLE, label LIVE */
  optionCode: string | null; // canonical stored code from response value when SELECT
  optionLabel: string | null; // CURRENT label, LIVE, NULL when unanswered or non-SELECT
};

export type ChecklistExecutionDetailFilters = {
  buildingId?: string;
  executionId?: string;
  templateId?: string;
  status?: string;
  // date window applied to execution created_at half-open [start,end) like R04
  dateFrom?: string;
  dateTo?: string;
};

export type ChecklistExecutionDetailPagination = {
  limit?: number;
  offset?: number;
};

export type ChecklistExecutionDetailQuery = ChecklistExecutionDetailFilters & ChecklistExecutionDetailPagination;

export type PublicChecklistExecutionDetail = {
  buildingId: string | null;
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  asOf: string;
  rows: PublicChecklistExecutionDetailRow[];
};
