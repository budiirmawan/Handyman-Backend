/**
 * R07 PART 02B — Form Detail Repository Core
 *
 * READ MODEL ONLY. Form-engine item-level detail.
 * Grain: ONE ROW per (form_instance_id + version_field_id + occurrence identity)
 *   Non-repeatable: occurrenceId = NULL, occurrenceIndex = NULL
 *   Repeatable: occurrenceId = form_instance_occurrences.id, occurrenceIndex = occurrence_index
 *
 * Model:
 *   form_instances (fi_base with R04 building authority, fail-closed)
 *   JOIN form_template_versions + form_templates (owning template)
 *   JOIN form_template_version_sections (STABLE snapshot)
 *   JOIN form_template_version_fields (STABLE snapshot)
 *   LEFT JOIN form_repeatable_groups (authority whether section is repeatable)
 *   For non-repeatable: no occurrence expansion, LEFT JOIN response where occurrence_id IS NULL
 *   For repeatable: JOIN occurrences scoped by instance + repeatable_group, LEFT JOIN response where occurrence_id = occurrence.id
 *   LEFT JOIN live form_fields via version_field.field_id for measurement metadata (LIVE)
 *   LEFT JOIN LATERAL latest COMPLETED review (execution-level)
 *
 * HISTORICAL SAFETY:
 *   STABLE VERSION SNAPSHOT:
 *     sectionId, sectionCode, sectionTitle, sectionDisplayOrder, sectionStatus
 *     versionFieldId, fieldCode, fieldLabel, fieldType, required, displayOrder, fieldStatus
 *   STABLE RESPONSE FACT:
 *     responseId, value, responseCreatedAt, responseUpdatedAt, lastRespondedByUserId
 *   STABLE R06 FACTS:
 *     completedByUserId, assigneeType, assignedWorkforceProfileId, assignedTeamId, assignmentSnapshotAt, verification facts
 *   LIVE:
 *     uomId, minimumValue, maximumValue, decimalPrecision (from live form_fields master)
 *   R09 PART 01B identification context (SELECT-only; no new joins):
 *     definitionCode = form_template_version_fields.code — STABLE VERSION SNAPSHOT
 *       (same persisted authority as fieldCode; frozen with the template version)
 *     templateCode = form_templates.code — CURRENT template master fact
 *       (the version lineage persists no template code/name snapshot)
 *     templateName = form_templates.name — CURRENT LIVE FACT, NOT a historical snapshot
 *   R09 PART 02A2 UOM presentation (CURRENT LIVE FACTS, NOT snapshots):
 *     - uomName (units_of_measure.name — client-scoped master label;
 *       read-time lookup of ff.uom_id; fail-closed NULL when uom_id is NULL
 *       or the UOM belongs to another client; structural client-equality join)
 *     - uomSymbol (units_of_measure.symbol — client-scoped master symbol;
 *       NOT unique; same fail-closed NULL behavior)
 *   R09 PART 02B2 actor presentation (CURRENT LIVE FACTS, NOT snapshots):
 *     - completedByName (users.display_name resolved from completedByUserId;
 *       PK LEFT JOIN on the global users identity master; fail-closed NULL)
 *     - lastRespondedByName (users.display_name resolved from
 *       lastRespondedByUserId; same rule)
 *     - verificationReviewerName (users.display_name resolved from
 *       verificationReviewerUserId; same rule; R06/R07 latest-COMPLETED
 *       verification semantic unchanged)
 *   R09 PART 02C2 assignment-target presentation (CURRENT LIVE FACTS, NOT
 *   historical assignment snapshots and NOT actual-executor facts):
 *     - assignedWorkforceName (workforce_profiles.full_name resolved from the
 *       persisted assignedWorkforceProfileId with structural client lineage)
 *     - assignedTeamName (teams.name resolved from the persisted assignedTeamId
 *       with structural client lineage; team-only, not an individual executor)
 *
 * No executor, no result/notes/isNa/naNotes, no SELECT option table, no evidence/finding/rework, no checklist engine.
 */

export type FormDetailFieldType = 'TEXT' | 'TEXTAREA' | 'NUMBER' | 'DATE' | 'DATETIME' | 'BOOLEAN' | 'SELECT';

export type PublicFormExecutionDetailRow = {
  /* Identity — composite grain */
  formInstanceId: string;
  versionFieldId: string;
  occurrenceId: string | null; // NULL = non-repeatable, non-NULL = repeatable occurrence
  occurrenceIndex: number | null; // NULL for non-repeatable, >=0 for repeatable
  responseId: string | null; // NULL = UNANSWERED (no response row), non-NULL with value NULL = explicit null-value response

  /* Execution context — from fi_base (R04 authority reuse) */
  clientId: string;
  buildingId: string;
  formTemplateId: string; // owning form_templates.id (not version id)
  formTemplateVersionId: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string; // instance created_at for ordering parity
  updatedAt: string;

  /* Definition & template identification — R09 PART 01B (cross-engine identification context) */
  definitionCode: string; // form_template_version_fields.code — STABLE VERSION SNAPSHOT (published field code frozen with the template version; same persisted authority as fieldCode)
  templateCode: string; // form_templates.code — CURRENT template master fact (version lineage persists no template code snapshot; join 1:1 via NOT NULL FKs)
  templateName: string; // form_templates.name — CURRENT LIVE FACT (mutable via template administration; NOT a historical snapshot)

  /* Section snapshot — STABLE */
  sectionId: string; // version_section id (snapshot)
  sectionCode: string;
  sectionTitle: string;
  sectionDisplayOrder: number;
  sectionStatus: string;

  /* Field snapshot — STABLE */
  fieldCode: string;
  fieldLabel: string; // STABLE snapshot, not live form_fields label
  fieldType: FormDetailFieldType; // STABLE snapshot
  required: boolean; // STABLE snapshot
  displayOrder: number; // STABLE snapshot field display_order
  fieldStatus: string; // STABLE snapshot

  /* Live measurement metadata — from live form_fields master via field_id */
  uomId: string | null; // LIVE
  uomName: string | null; // CURRENT LIVE FACT — client-scoped units_of_measure label (read-time lookup of ff.uom_id; structural client-equality join; NULL when uom_id is NULL or UOM is another client's; NOT a historical snapshot)
  uomSymbol: string | null; // CURRENT LIVE FACT — client-scoped units_of_measure symbol (NOT unique; same fail-closed NULL behavior; NOT a historical snapshot)
  minimumValue: string | null; // LIVE — NUMERIC as text
  maximumValue: string | null; // LIVE
  decimalPrecision: number | null; // LIVE

  /* Response — STABLE, native JSONB */
  value: unknown | null; // JSONB native: boolean|number|string|null, NULL when unanswered or explicit null-value response (distinguish via responseId)
  responseCreatedAt: string | null;
  responseUpdatedAt: string | null;
  lastRespondedByUserId: string | null; // NULL historical pre-R06 or unanswered
  lastRespondedByName: string | null; // CURRENT LIVE FACT — users.display_name resolved from lastRespondedByUserId (PK LEFT JOIN, global identity; NULL when the ID is NULL or unresolved; NOT a historical snapshot)

  /* R06 instance attribution — STABLE */
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

  /* Repeatable group authority */
  repeatableGroupId: string | null; // NULL for non-repeatable sections
};

export type FormExecutionDetailFilters = {
  formInstanceId?: string;
  formTemplateId?: string; // owning form_templates.id
  status?: string;
  dateFrom?: string;
  dateTo?: string;
};

export type FormExecutionDetailPagination = {
  limit?: number;
  offset?: number;
};

export type PublicFormExecutionDetail = {
  buildingId: string | null;
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  asOf: string;
  rows: PublicFormExecutionDetailRow[];
};
