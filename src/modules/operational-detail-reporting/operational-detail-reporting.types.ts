/**
 * R07 PART 02C — Shared Neutral Detail Adapter + Shared Access
 *
 * Neutral Reporting detail row over already-closed physical adapters:
 *   CHECKLIST_EXECUTION -> checklist-execution-detail
 *   FORM_INSTANCE -> form-execution-detail
 *
 * Physical repositories remain separate, no giant UNION SQL.
 * Shared layer composes existing repositories.
 *
 * Engine discriminator:
 *   CHECKLIST_EXECUTION | FORM_INSTANCE
 *
 * Historical authority:
 *   CHECKLIST_EXECUTION definition -> LIVE (current checklist_items, checklist_item_options LIVE)
 *   FORM_INSTANCE definition -> VERSION_SNAPSHOT (form_template_version_sections/fields frozen at publish)
 *   Measurement (uom/min/max/precision) -> LIVE for both engines (from live master tables)
 *   R09 PART 01C identification context (propagated from physical engines, no new joins):
 *     definitionCode -> ENGINE-SPECIFIC authority, not flattened:
 *       CHECKLIST_EXECUTION = current authoritative item code (NOT a version snapshot)
 *       FORM_INSTANCE       = STABLE VERSION SNAPSHOT (published version field code)
 *     templateCode   -> current template master fact for BOTH engines
 *     templateName   -> CURRENT LIVE FACT for BOTH engines (NOT a historical snapshot)
 *   R09 PART 02A3 UOM presentation (propagated from physical engines, no new joins):
 *     uomName/uomSymbol -> CURRENT LIVE FACT from the client-scoped
 *       units_of_measure master (NOT a historical snapshot; uomSymbol NOT
 *       unique); NULL when the physical uomId is NULL or resolves NULL via the
 *       physical fail-closed structural client-equality join
 *   R09 PART 02D-N attribution presentation (propagated verbatim from physical
 *   engines, no new joins or authority reconstruction):
 *     completedByName, lastRespondedByName, verificationReviewerName,
 *     assignedWorkforceName, assignedTeamName -> CURRENT LIVE FACTS, NOT
 *     historical snapshots. Assignment names mean Assigned Workforce and
 *     Assigned Team; they are not executor or performed-by facts.
 *
 * Nullable semantics:
 *   For checklist: form-specific section/occurrence fields NULL
 *   For form: checklist-specific result/notes/isNa/naNotes/optionCode/optionLabel/isNaAllowed/naRequiresNote NULL
 *   FORM isNa MUST be NULL (concept unsupported), not FALSE
 *
 * Unanswered:
 *   responseId NULL => unanswered for both engines
 *   Form null-value response: responseId != NULL + value NULL => response exists with null value, not unanswered
 *   Checklist explicit N/A: responseId != NULL + isNa TRUE => explicit N/A, value/result NULL
 *
 * No executor, no semantic normalization, no PASS/FAIL, no display-name lookups, no evidence/finding/rework.
 */

export const OPERATIONAL_DETAIL_ENGINES = ['CHECKLIST_EXECUTION', 'FORM_INSTANCE'] as const;
export type OperationalDetailEngine = (typeof OPERATIONAL_DETAIL_ENGINES)[number];

export function isOperationalDetailEngine(value: unknown): value is OperationalDetailEngine {
  return typeof value === 'string' && (OPERATIONAL_DETAIL_ENGINES as readonly string[]).includes(value);
}

export type DefinitionMetadataAuthority = 'LIVE' | 'VERSION_SNAPSHOT';
export type MeasurementMetadataAuthority = 'LIVE';

export type PublicOperationalDetailRow = {
  /* Engine discriminator */
  engine: OperationalDetailEngine;

  /* Common identity/context — from physical adapters */
  executionId: string; // checklist_execution_id or form_instance_id
  definitionItemId: string; // checklist_item_id or version_field_id
  responseId: string | null; // NULL = UNANSWERED for both engines

  clientId: string;
  buildingId: string;
  templateId: string; // owning template id (checklist_templates.id or form_templates.id)
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string; // execution/instance created_at
  updatedAt: string;

  /* Definition & template identification — R09 PART 01C (propagated verbatim from physical engines) */
  definitionCode: string; // CHECKLIST_EXECUTION: current authoritative item code (NOT a version snapshot); FORM_INSTANCE: STABLE VERSION SNAPSHOT (published version field code)
  templateCode: string; // both engines: current template master fact
  templateName: string; // both engines: CURRENT LIVE FACT (mutable; NOT a historical snapshot)

  /* Common definition metadata — provenance differs */
  label: string; // itemLabel for checklist LIVE, fieldLabel for form VERSION_SNAPSHOT
  type: string; // native type preserved: CHECK/BOOLEAN/TEXT/NUMBER/SELECT for checklist, TEXT/TEXTAREA/NUMBER/DATE/DATETIME/BOOLEAN/SELECT for form
  displayOrder: number;
  required: boolean;

  /* Common measurement — LIVE for both */
  uomId: string | null;
  uomName: string | null; // CURRENT LIVE FACT — client-scoped UOM master label (propagated verbatim; NULL when physical uomId is NULL or client-mismatch fail-closed; NOT a historical snapshot)
  uomSymbol: string | null; // CURRENT LIVE FACT — client-scoped UOM master symbol (NOT unique; same fail-closed NULL behavior; NOT a historical snapshot)
  minimumValue: string | null;
  maximumValue: string | null;
  decimalPrecision: number | null;

  /* Common response — native */
  value: unknown | null; // JSONB native
  responseCreatedAt: string | null;
  responseUpdatedAt: string | null;
  lastRespondedByUserId: string | null;
  lastRespondedByName: string | null; // CURRENT LIVE FACT — propagated from the physical response-writer authority; NOT a historical snapshot

  /* Common R06 attribution — STABLE */
  completedByUserId: string | null;
  completedByName: string | null; // CURRENT LIVE FACT — propagated from the physical completion-actor authority; NOT a historical snapshot
  assigneeType: string | null;
  assignedWorkforceProfileId: string | null;
  assignedWorkforceName: string | null; // CURRENT LIVE FACT — propagated from workforce_profiles.full_name; NOT a historical assignment snapshot; NOT an actual executor
  assignedTeamId: string | null;
  assignedTeamName: string | null; // CURRENT LIVE FACT — propagated from teams.name; NOT a historical assignment snapshot; team-only, NOT an actual executor
  assignmentSnapshotAt: string | null;

  /* Common verification — execution-level */
  verificationReviewId: string | null;
  verificationStatus: string | null;
  verificationDecision: string | null;
  verificationReviewerUserId: string | null;
  verificationReviewerName: string | null; // CURRENT LIVE FACT — propagated from the physical latest-COMPLETED reviewer authority; NOT a historical snapshot
  verificationReviewedAt: string | null;

  /* Form-specific nullable — NULL for checklist */
  occurrenceId: string | null;
  occurrenceIndex: number | null;
  sectionId: string | null;
  sectionCode: string | null;
  sectionTitle: string | null;
  sectionDisplayOrder: number | null;
  repeatableGroupId: string | null;
  formTemplateVersionId: string | null; // version id for form, NULL for checklist

  /* Checklist-specific nullable — NULL for form (with semantic note) */
  result: string | null; // checklist only, NULL for form = concept unsupported
  notes: string | null; // checklist only
  isNa: boolean | null; // checklist: true explicit N/A, false not N/A, NULL unanswered? Actually repo uses false for unanswered; neutral preserves boolean for checklist, NULL for form (unsupported)
  naNotes: string | null; // checklist only
  optionCode: string | null; // checklist SELECT canonical code, NULL for form
  optionLabel: string | null; // checklist SELECT current LIVE label, NULL for form
  isNaAllowed: boolean | null; // checklist N/A policy, NULL for form
  naRequiresNote: boolean | null; // checklist N/A policy, NULL for form

  /* Historical provenance */
  definitionMetadataAuthority: DefinitionMetadataAuthority; // LIVE for checklist, VERSION_SNAPSHOT for form
  measurementMetadataAuthority: MeasurementMetadataAuthority; // LIVE for both
};

export type OperationalDetailFilters = {
  engine?: OperationalDetailEngine;
  buildingId?: string;
  executionId?: string; // maps to checklist execution id or form instance id
  templateId?: string; // owning template id for both engines
  status?: string;
  dateFrom?: string;
  dateTo?: string;
};

export type OperationalDetailPagination = {
  limit?: number;
  offset?: number;
};

export type OperationalDetailQuery = OperationalDetailFilters & OperationalDetailPagination;

export type PublicOperationalDetail = {
  buildingId: string | null;
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  asOf: string;
  engine: OperationalDetailEngine | null; // null when combined mode would be used, but PART 02C requires explicit engine
  rows: PublicOperationalDetailRow[];
};
